// @ts-check
// d:\node\ridercmsV1\utils\cron-functions\hardware-cron.js
const cron = require('node-cron');
const { getDatabase } = require('firebase-admin/database');
const poolPromise = require('../../db');
const logger = require('../logger');
const { querySTKStatus } = require('../mpesa');
const { completePaidWithdrawal, completePaidRental } = require('../sessionUtils');
const { runMpesaReconciliation } = require('../reconciliationWorker');

/**
 * Checks for slots that meet all safety conditions for charging but are not currently charging.
 * If found, it sends a 'startCharging' command to the hardware.
 */
async function checkChargingConditions() {
  let client;

  try {
    const pool = await poolPromise;
    client = await pool.connect();
    // Query for slots where:
    // 1. Telemetry indicates a safe, ready state (Battery in, Door closed & locked, Plug connected).
    // 2. The slot is not in a maintenance or faulty state.
    // We verify the actual relay state against Firebase real-time data.
    const query = `
      SELECT
        s.id,
        s.slot_identifier,
        b.booth_uid
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE
        (s.telemetry->>'batteryInserted')::boolean = true
        AND (s.telemetry->>'doorClosed')::boolean = true
        AND (s.telemetry->>'doorLocked')::boolean = true
        AND (s.telemetry->>'plugConnected')::boolean = true
        AND s.status NOT IN ('maintenance', 'faulty', 'disabled')
    `;

    const { rows } = await client.query(query);

    if (rows.length > 0) {
      // logger.info(`[HardwareCron] Found ${rows.length} candidate slots. Verifying against Firebase...`);
      
      const db = getDatabase();

      for (const row of rows) {
        const { id, slot_identifier, booth_uid } = row;
        
        try {
          // Fetch real-time data from Firebase to confirm status
          const snapshot = await db.ref(`booths/${booth_uid}/slots/${slot_identifier}`).get();
          if (!snapshot.exists()) continue;

          const slotData = snapshot.val();
          const telemetry = slotData.telemetry || {};

          // Check conditions using real-time data
          const isSafe = 
            telemetry.batteryInserted === true &&
            telemetry.doorClosed === true &&
            telemetry.doorLocked === true &&
            telemetry.plugConnected === true;

          const isRelayOff = !telemetry.relayOn;

          if (isSafe && isRelayOff) {
            logger.info(`[HardwareCron] Slot ${booth_uid}/${slot_identifier} is safe but relay is OFF (Real-time). Sending 'startCharging'...`);

            // 1. Send command to Firebase to trigger the hardware
            await db.ref(`booths/${booth_uid}/slots/${slot_identifier}/command`).update({
              startCharging: true,
              
            });

            // 2. Optimistically update DB
            await client.query("UPDATE booth_slots SET is_charging = true WHERE id = $1", [id]);
          }
        } catch (err) {
          logger.error(`[HardwareCron] Failed to process ${booth_uid}/${slot_identifier}:`, err);
        }
      }
    }
  } catch (error) {
    logger.error('[HardwareCron] Error checking charging conditions:', error);
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Queries M-Pesa for withdrawal sessions stuck in 'pending' with an mpesa_checkout_id.
 * If M-Pesa confirms payment, completes the session so the user can proceed.
 * Runs frequently to recover from missed callbacks (network blips, service restarts).
 */
async function resolvePendingPayments() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();

    // Find payments older than 45 seconds that have not been confirmed:
    // - withdrawals stuck in 'pending' awaiting their M-Pesa callback
    // - rentals that initiated their consolidated-bill payment (still 'in_progress'
    //   because a returned rental only flips to 'completed' once paid)
    // M-Pesa STK push timeout is ~60s; by 45s the user has likely entered their PIN.
    const pendingQuery = `
      SELECT id, session_type, mpesa_checkout_id
      FROM deposits
      WHERE (
        (session_type = 'withdrawal' AND status = 'pending')
        OR
        (session_type = 'rental' AND status = 'in_progress'
           AND return_slot_id IS NOT NULL AND mpesa_checkout_id IS NOT NULL)
      )
        AND mpesa_checkout_id IS NOT NULL
        AND mpesa_checkout_id NOT LIKE 'DEV_%'
        AND started_at < NOW() - INTERVAL '45 seconds'
      ORDER BY started_at ASC
    `;
    const { rows } = await client.query(pendingQuery);

    if (rows.length === 0) return;

    logger.info(`[MpesaCron] Found ${rows.length} pending payment(s) to verify.`);

    for (const session of rows) {
      const { id: sessionId, session_type: sessionType, mpesa_checkout_id: checkoutId } = session;
      try {
        const response = await querySTKStatus(checkoutId);
        const { ResultCode, ResultDesc } = response.data;

        if (ResultCode === '0') {
          logger.info(`[MpesaCron] M-Pesa confirmed payment for session ${sessionId} (${checkoutId}). Completing...`);
          await client.query('BEGIN');
          // Whichever matching completion applies (withdrawal vs rental) will handle it.
          const completed = await completePaidWithdrawal(client, checkoutId) || await completePaidRental(client, checkoutId);
          await client.query('COMMIT');
          if (completed) {
            logger.info(`[MpesaCron] Session ${sessionId} completed via proactive check.`);
          }
        } else {
          // Non-zero result code: payment failed or cancelled.
          // Only mark withdrawals as failed if older than 75s (well past M-Pesa timeout)
          // to avoid premature failure before the callback arrives. Rentals keep their
          // 'in_progress' status so the user can simply retry payment.
          const ageRes = await client.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds
             FROM deposits WHERE id = $1`,
            [sessionId]
          );
          const ageSeconds = ageRes.rows[0]?.age_seconds || 0;

          if (sessionType === 'withdrawal' && ageSeconds > 75) {
            logger.warn(`[MpesaCron] Marking session ${sessionId} as failed. M-Pesa code: ${ResultCode} (${ResultDesc})`);
            await client.query(
              `UPDATE deposits SET status = 'failed',
               notes = COALESCE(notes, '') || '\n[' || NOW() || '] Proactive check failed: ' || $1
               WHERE id = $2 AND status = 'pending'`,
              [`${ResultCode} - ${ResultDesc}`, sessionId]
            );
          } else {
            logger.debug(`[MpesaCron] Session ${sessionId} still pending (M-Pesa: ${ResultCode}). Skipping.`);
          }
        }
      } catch (apiError) {
        logger.warn(`[MpesaCron] M-Pesa query failed for session ${sessionId}: ${apiError.message}`);
      }
    }
  } catch (error) {
    logger.error('[MpesaCron] Error resolving pending payments:', error);
  } finally {
    if (client) client.release();
  }
}

/**
 * Resolves withdrawal sessions stuck in 'in_progress' for more than 5 minutes.
 * Runs frequently to prevent users from being blocked.
 *
 * A stuck withdrawal is only auto-completed when LIVE telemetry confirms the
 * battery has physically left the slot (battery absent and door not locked).
 * Auto-completing on elapsed time alone is unsafe: it redeems the user's deposit
 * and frees the slot even though the battery may still be physically present
 * (e.g. during a power outage where no telemetry arrives). When telemetry is
 * absent, or still reports the battery present, the session is left untouched so
 * an admin can resolve the physical state manually.
 */
async function resolveStuckWithdrawals() {
  let lookupClient;
  let stuckRows = [];
  try {
    const pool = await poolPromise;
    lookupClient = await pool.connect();

    const stuckWithdrawalsQuery = `
      SELECT d.id, d.slot_id, d.user_id, s.slot_identifier, b.booth_uid
      FROM deposits d
      JOIN booth_slots s ON d.slot_id = s.id
      JOIN booths b ON s.booth_id = b.id
      WHERE d.session_type = 'withdrawal'
        AND d.status = 'in_progress'
        AND d.updated_at < NOW() - INTERVAL '5 minutes'
    `;
    const stuckRes = await lookupClient.query(stuckWithdrawalsQuery);
    stuckRows = stuckRes.rows;
  } catch (error) {
    logger.error('[CleanupCron] Error querying stuck withdrawals:', error);
    return;
  } finally {
    if (lookupClient) lookupClient.release();
  }

  if (stuckRows.length === 0) return;

  const pool = await poolPromise;
  const { handleWithdrawalCompletion } = require('../firebaseSync');
  const db = getDatabase();
  let resolved = 0;

  for (const session of stuckRows) {
    let txClient;
    try {
      const snapshot = await db.ref(`booths/${session.booth_uid}/slots/${session.slot_identifier}`).get();
      const slotData = snapshot.exists() ? snapshot.val() : null;
      const telemetry = slotData?.telemetry || {};
      const batteryInserted = telemetry.batteryInserted === true;
      const doorLocked = telemetry.doorLocked === true;
      const batteryLeft = snapshot.exists() && !batteryInserted && !doorLocked;

      if (!batteryLeft) {
        logger.info(
          `[CleanupCron] Withdrawal ${session.id} on ${session.booth_uid}/${session.slot_identifier} is still 'in_progress' but telemetry does not confirm the battery has left (or no telemetry). Leaving for admin resolution.`
        );
        continue;
      }

      logger.info(`[CleanupCron] Auto-completing stuck withdrawal ${session.id} for user ${session.user_id} (telemetry confirms battery removed).`);

      // Each session gets its own transaction so one failure cannot abort the batch.
      txClient = await pool.connect();
      await txClient.query('BEGIN');
      await handleWithdrawalCompletion(txClient, session.slot_identifier, session.slot_id);
      await txClient.query('COMMIT');
      resolved += 1;
    } catch (sessionError) {
      if (txClient) {
        try {
          await txClient.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error(`[CleanupCron] Rollback failed for withdrawal ${session.id}:`, rollbackError);
        }
      }
      logger.error(`[CleanupCron] Failed to resolve stuck withdrawal ${session.id}:`, sessionError);
    } finally {
      if (txClient) txClient.release();
    }
  }

  if (resolved > 0) {
    logger.info(`[CleanupCron] Resolved ${resolved} stuck withdrawal session(s).`);
  }
}

/**
 * Resolves withdrawal sessions stuck in 'pending' that were never confirmed by
 * M-Pesa (missed/lost callbacks, abandoned initiate-withdrawal flows, admin
 * retries where the rider never paid, etc.). Without this sweep such rows stay
 * 'pending' forever: the slot's "rented by" name is hidden (the deposit credit
 * stays consumed), the user is blocked from starting a new withdrawal/rental,
 * and the admin manual-withdraw guard keeps rejecting the slot.
 *
 * Rules (time is measured from `started_at`, falling back to `created_at`):
 *  - payment NEVER initiated (no `mpesa_checkout_id`) -> fail after 10 min
 *  - payment pushed but never confirmed (has checkout id) -> fail after 30 min
 *
 * Dev checkout ids (`DEV_%`) are skipped: they are auto-approved and should not
 * linger, but we never want the sweep racing the synthetic approval path.
 */
async function resolveStuckPendingWithdrawals() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();
    await client.query('BEGIN');

    const stuckQuery = `
      SELECT id, slot_id, user_id
      FROM deposits
      WHERE session_type = 'withdrawal'
        AND status = 'pending'
        AND (mpesa_checkout_id IS NULL OR mpesa_checkout_id NOT LIKE 'DEV_%')
        AND EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) >
          CASE WHEN mpesa_checkout_id IS NULL THEN 600 ELSE 1800 END
      FOR UPDATE
    `;
    const stuckRes = await client.query(stuckQuery);

    if (stuckRes.rowCount > 0) {
      const ids = stuckRes.rows.map((r) => r.id);
      const updateRes = await client.query(
        `UPDATE deposits
         SET status = 'failed',
             updated_at = NOW(),
             notes = COALESCE(notes, '') || '\n[' || NOW() || '] Auto-failed by cleanup sweep: payment was never confirmed.'
         WHERE id = ANY($1::int[]) AND status = 'pending'
         RETURNING id`,
        [ids]
      );
      await client.query('COMMIT');
      logger.info(`[CleanupCron] Auto-failed ${updateRes.rowCount} stale pending withdrawal session(s).`);
    } else {
      await client.query('COMMIT');
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    logger.error('[CleanupCron] Error resolving stuck pending withdrawals:', error);
  } finally {
    if (client) client.release();
  }
}

/**
 * Resolves admin rental-stock placements stuck in 'opening' longer than the
 * placement timeout (default 2 minutes): the battery was never inserted, so the
 * slot is reverted to 'available', the pre-assigned battery is unpaired, and the
 * 'openForDeposit' hardware command is cleared.
 */
async function resolveStuckRentalPlacements() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();

    const stuckQuery = `
      SELECT s.id AS "slotId", s.slot_identifier AS "slotIdentifier", b.booth_uid AS "boothUid"
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE s.status = 'opening'
        AND s.current_battery_id IS NOT NULL
        AND s.updated_at < NOW() - INTERVAL '2 minutes'
      ORDER BY s.updated_at ASC
    `;
    const stuckRes = await client.query(stuckQuery);

    if (stuckRes.rowCount > 0) {
      const { revertAdminRentalPlacement } = require('../sessionUtils');
      const db = getDatabase();
      for (const slot of stuckRes.rows) {
        await client.query('BEGIN');
        try {
          const reverted = await revertAdminRentalPlacement(client, slot.slotId, slot.slotIdentifier);
          if (reverted) {
            // Best-effort: clear the pending open command so the hardware stops
            // waiting for a deposit.
            await db.ref(`booths/${slot.boothUid}/slots/${slot.slotIdentifier}/command`).update({
              openForDeposit: false,
            });
            logger.info(`[PlacementCron] Reverted stale admin rental-stock placement on ${slot.boothUid}/${slot.slotIdentifier}.`);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error(`[PlacementCron] Failed to revert stale placement on ${slot.boothUid}/${slot.slotIdentifier}:`, err);
        }
      }
      logger.info(`[PlacementCron] Reverted ${stuckRes.rowCount} stale admin rental-stock placement(s).`);
    }
  } catch (error) {
    logger.error('[PlacementCron] Error resolving stuck admin rental-stock placements:', error);
  } finally {
    if (client) client.release();
  }
}

// Minutes without telemetry after which a non-available slot is considered stale
// and is force re-checked against live Firebase. Configurable via SLOT_STALE_MINUTES.
const SLOT_STALE_MINUTES = Number(process.env.SLOT_STALE_MINUTES || 10);

/**
 * Safety-net reconciliation for slots whose last telemetry is stale. The Firebase
 * listener only processes slots whose snapshot changed; after an outage a booth
 * can come back reporting the same snapshot and never trigger a re-sync. This
 * sweep re-reads live Firebase for non-available slots that have not reported in
 * a while and routes them through syncSlotState (which releases a slot when the
 * battery is confirmed gone, or re-confirms it when the battery is confirmed
 * present).
 *
 * It ONLY acts when live Firebase data is available. When a slot is unreachable
 * (no power, no telemetry), nothing is changed — the state is left for an admin
 * to resolve, avoiding a release that could double-allocate a battery still in
 * the slot.
 */
async function reconcileStaleSlots() {
  let staleRows = [];
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();
    const staleRes = await client.query(
      `
      SELECT s.slot_identifier, b.booth_uid
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE s.status IN ('occupied', 'opening')
        AND (s.last_seen_at IS NULL OR s.last_seen_at < NOW() - make_interval(mins => $1::int))
      LIMIT 200
      `,
      [SLOT_STALE_MINUTES]
    );
    staleRows = staleRes.rows;
  } catch (error) {
    logger.error('[StaleSlotCron] Error querying stale slots:', error);
    return;
  } finally {
    if (client) client.release();
  }

  if (staleRows.length === 0) return;

  const { syncSlotState } = require('../firebaseSync');
  const db = getDatabase();
  let rechecked = 0;

  for (const slot of staleRows) {
    try {
      const snapshot = await db.ref(`booths/${slot.booth_uid}/slots/${slot.slot_identifier}`).get();
      if (!snapshot.exists()) {
        logger.info(`[StaleSlotCron] No live data for ${slot.booth_uid}/${slot.slot_identifier}; leaving slot unchanged for admin resolution.`);
        continue;
      }

      // slotBefore = null forces syncSlotState to process the live snapshot even
      // when the cached value is identical (see hasSlotChanged in firebaseSync).
      await syncSlotState(slot.booth_uid, slot.slot_identifier, snapshot.val(), null);
      rechecked += 1;
    } catch (slotError) {
      logger.error(`[StaleSlotCron] Failed to reconcile ${slot.booth_uid}/${slot.slot_identifier}:`, slotError);
    }
  }

  if (rechecked > 0) {
    logger.info(`[StaleSlotCron] Re-checked ${rechecked} stale slot(s) against live telemetry.`);
  }
}

/**
 * Weekly maintenance: purges cancelled sessions older than 30 days.
 */
async function runWeeklyMaintenance() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();
    await client.query('BEGIN');

    const purgeResult = await client.query(
      "DELETE FROM deposits WHERE status = 'cancelled' AND updated_at < NOW() - INTERVAL '30 days'"
    );

    await client.query('COMMIT');

    if (purgeResult.rowCount > 0) {
      logger.info(`[CleanupCron] Weekly maintenance purged ${purgeResult.rowCount} cancelled sessions.`);
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    logger.error('[CleanupCron] Error running weekly maintenance:', error);
  } finally {
    if (client) client.release();
  }
}

/**
 * Purges failed sessions. Scheduled every 30 minutes.
 *
 * Guards (added after the unconditional delete was found to be unsafe):
 *  - `mpesa_checkout_id IS NULL`: rows that went through M-Pesa are retained.
 *    A withdrawal auto-failed by the stale-pending sweep can still be confirmed
 *    by a late M-Pesa callback; deleting it would orphan the payment because
 *    completePaidWithdrawal matches on mpesa_checkout_id.
 *  - age guard: only rows whose last update is older than the retention window
 *    are removed, preserving recent forensic history.
 */
async function purgeFailedSessions() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `DELETE FROM deposits
       WHERE status = 'failed'
         AND mpesa_checkout_id IS NULL
         AND updated_at < NOW() - INTERVAL '48 hours'`
    );

    await client.query('COMMIT');
    if (result.rowCount > 0) {
      logger.info(`[CleanupCron] Purged ${result.rowCount} failed session(s).`);
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    logger.error('[CleanupCron] Error purging failed sessions:', error);
  } finally {
    if (client) client.release();
  }
}

/**
 * Starts the cron job interval.
 */
function startCronJob() {
  logger.info('[HardwareCron] Starting charging condition check cron (Interval: 5 seconds).');

  // Run immediately on server start
  checkChargingConditions().catch((err) => {
    logger.error('[HardwareCron] Initial run failed:', err);
  });

  // Resolve stuck withdrawals immediately on startup
  resolveStuckWithdrawals().catch((err) => {
    logger.error('[CleanupCron] Initial stuck resolution failed:', err);
  });

  // Fail stale pending withdrawals immediately on startup
  resolveStuckPendingWithdrawals().catch((err) => {
    logger.error('[CleanupCron] Initial stale pending withdrawal resolution failed:', err);
  });

  // Revert stale admin rental-stock placements immediately on startup
  resolveStuckRentalPlacements().catch((err) => {
    logger.error('[PlacementCron] Initial stale placement resolution failed:', err);
  });

  // Re-check slots with stale telemetry immediately on startup
  reconcileStaleSlots().catch((err) => {
    logger.error('[StaleSlotCron] Initial stale slot reconciliation failed:', err);
  });

  // Check for pending payments that may have missed callbacks
  resolvePendingPayments().catch((err) => {
    logger.error('[MpesaCron] Initial pending payment check failed:', err);
  });

  // Run weekly maintenance once on startup
  runWeeklyMaintenance().catch((err) => {
    logger.error('[CleanupCron] Initial maintenance failed:', err);
  });

  // Schedule M-Pesa reconciliation at 2 AM daily
  cron.schedule('0 2 * * *', async () => {
    logger.info('[HardwareCron] Starting daily M-Pesa reconciliation task...');
    await runMpesaReconciliation();
  });

  // Schedule weekly data purge at 3 AM every Sunday
  cron.schedule('0 3 * * 0', async () => {
    logger.info('[HardwareCron] Starting scheduled weekly data purge...');
    await runWeeklyMaintenance();
  });

  // Purge failed sessions every 30 minutes.
  cron.schedule('*/30 * * * *', async () => {
    logger.info('[HardwareCron] Starting scheduled failed-session purge...');
    await purgeFailedSessions();
  });

  // Re-check slots with stale telemetry every 5 minutes.
  setInterval(() => {
    reconcileStaleSlots().catch((err) => {
      logger.error('[StaleSlotCron] Scheduled stale slot reconciliation failed:', err);
    });
  }, 5 * 60 * 1000);

  // Check charging conditions every 5 seconds
  setInterval(() => {
    checkChargingConditions().catch((err) => {
      logger.error('[HardwareCron] Scheduled run failed:', err);
    });
  }, 5 * 1000);

  // Resolve stuck withdrawals every 90 seconds
  // This ensures sessions are auto-completed ~6.5 minutes after getting stuck
  // (5 min threshold + 90s check window)
  setInterval(() => {
    resolveStuckWithdrawals().catch((err) => {
      logger.error('[CleanupCron] Scheduled stuck resolution failed:', err);
    });
  }, 90 * 1000);

  // Revert stale admin rental-stock placements every 60 seconds
  // (2 min threshold + 60s check window -> ~3 minutes max)
  setInterval(() => {
    resolveStuckRentalPlacements().catch((err) => {
      logger.error('[PlacementCron] Scheduled stale placement resolution failed:', err);
    });
  }, 60 * 1000);

  // Fail stale pending withdrawals every 60 seconds
  // (10/30 min thresholds caught within ~1 minute)
  setInterval(() => {
    resolveStuckPendingWithdrawals().catch((err) => {
      logger.error('[CleanupCron] Scheduled stale pending withdrawal resolution failed:', err);
    });
  }, 60 * 1000);

  // Check M-Pesa for stuck pending payments every 30 seconds
  // This recovers from missed callbacks within ~75 seconds of the STK push
  // (45s threshold + 30s check window)
  setInterval(() => {
    resolvePendingPayments().catch((err) => {
      logger.error('[MpesaCron] Scheduled pending payment check failed:', err);
    });
  }, 30 * 1000);
}

module.exports = {
  startCronJob,
  checkChargingConditions,
  resolvePendingPayments,
  resolveStuckWithdrawals,
  resolveStuckPendingWithdrawals,
  resolveStuckRentalPlacements,
  runWeeklyMaintenance,
  purgeFailedSessions,
  reconcileStaleSlots,
};
