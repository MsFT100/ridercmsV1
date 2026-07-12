// @ts-check
// d:\node\ridercmsV1\utils\cron-functions\hardware-cron.js
const cron = require('node-cron');
const { getDatabase } = require('firebase-admin/database');
const poolPromise = require('../../db');
const logger = require('../logger');
const { querySTKStatus } = require('../mpesa');
const { completePaidWithdrawal } = require('../sessionUtils');
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

    // Find pending withdrawals with an mpesa_checkout_id older than 45 seconds.
    // M-Pesa STK push timeout is ~60s; by 45s the user has likely entered their PIN.
    const pendingQuery = `
      SELECT id, mpesa_checkout_id
      FROM deposits
      WHERE session_type = 'withdrawal'
        AND status = 'pending'
        AND mpesa_checkout_id IS NOT NULL
        AND started_at < NOW() - INTERVAL '45 seconds'
      ORDER BY started_at ASC
    `;
    const { rows } = await client.query(pendingQuery);

    if (rows.length === 0) return;

    logger.info(`[MpesaCron] Found ${rows.length} pending payment(s) to verify.`);

    for (const session of rows) {
      const { id: sessionId, mpesa_checkout_id: checkoutId } = session;
      try {
        const response = await querySTKStatus(checkoutId);
        const { ResultCode, ResultDesc } = response.data;

        if (ResultCode === '0') {
          logger.info(`[MpesaCron] M-Pesa confirmed payment for session ${sessionId} (${checkoutId}). Completing...`);
          await client.query('BEGIN');
          const completed = await completePaidWithdrawal(client, checkoutId);
          await client.query('COMMIT');
          if (completed) {
            logger.info(`[MpesaCron] Session ${sessionId} moved to in_progress via proactive check.`);
          }
        } else {
          // Non-zero result code: payment failed or cancelled.
          // Only mark as failed if the session is older than 75s (well past M-Pesa timeout)
          // to avoid premature failure before the callback arrives.
          const ageRes = await client.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - started_at))::int AS age_seconds
             FROM deposits WHERE id = $1`,
            [sessionId]
          );
          const ageSeconds = ageRes.rows[0]?.age_seconds || 0;

          if (ageSeconds > 75) {
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
 */
async function resolveStuckWithdrawals() {
  let client;
  try {
    const pool = await poolPromise;
    client = await pool.connect();
    await client.query('BEGIN');

    const stuckWithdrawalsQuery = `
      SELECT id, slot_id, user_id
      FROM deposits
      WHERE session_type = 'withdrawal'
        AND status = 'in_progress'
        AND updated_at < NOW() - INTERVAL '5 minutes'
    `;
    const stuckRes = await client.query(stuckWithdrawalsQuery);

    if (stuckRes.rowCount > 0) {
      const { handleWithdrawalCompletion } = require('../firebaseSync');
      for (const session of stuckRes.rows) {
        logger.info(`[CleanupCron] Auto-completing stuck withdrawal ${session.id} for user ${session.user_id}`);
        await handleWithdrawalCompletion(client, `slot_id_${session.slot_id}`, session.slot_id);
      }
    }

    await client.query('COMMIT');

    if (stuckRes.rowCount > 0) {
      logger.info(`[CleanupCron] Resolved ${stuckRes.rowCount} stuck withdrawal sessions.`);
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    logger.error('[CleanupCron] Error resolving stuck withdrawals:', error);
  } finally {
    if (client) client.release();
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
  runWeeklyMaintenance,
};
