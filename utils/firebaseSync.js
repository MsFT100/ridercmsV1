const { getDatabase } = require('firebase-admin/database');
const pool = require('../db');
const logger = require('./logger');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Checks if an error is a PostgreSQL pool connection timeout.
 * @param {any} error - The error object to check.
 * @returns {boolean} True if it is a connection timeout error.
 */
function isPoolConnectTimeoutError(error) {
  return String(error?.message || '').includes('timeout exceeded when trying to connect');
}

/**
 * Acquires a PostgreSQL client from the pool with retry logic for timeouts.
 * @param {object} dbPool - The PostgreSQL pool instance.
 * @param {string} boothUid - The booth UID for logging.
 * @param {string} slotIdentifier - The slot identifier for logging.
 * @param {number} [maxAttempts] - Maximum number of connection attempts.
 * @returns {Promise<object>} A connected PostgreSQL client.
 */
async function acquirePgClientWithRetry(dbPool, boothUid, slotIdentifier, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await dbPool.connect();
    } catch (error) {
      const isTimeout = isPoolConnectTimeoutError(error);
      if (!isTimeout || attempt === maxAttempts) {
        throw error;
      }

      const backoffMs = attempt * 250;
      logger.warn(
        `Pool connect timeout for ${boothUid}/${slotIdentifier} (attempt ${attempt}/${maxAttempts}). Retrying in ${backoffMs}ms.`
      );
      await sleep(backoffMs);
    }
  }

  throw new Error('Failed to acquire database client after retries.');
}

/**
 * Checks if any property in the slot data has changed.
 * @param {object|null} slotBefore - Previous slot state.
 * @param {object} slotAfter - Current slot state.
 * @returns {boolean} True if data has changed.
 */
function hasSlotChanged(slotBefore, slotAfter) {
  if (!slotBefore) return true;
  try {
    return JSON.stringify(slotBefore) !== JSON.stringify(slotAfter);
  } catch {
    // If serialization fails for any reason, fail safe and process the update.
    return true;
  }
}

// Serialize sync work per booth to avoid pool storms during bursty hardware updates.
const boothSyncQueues = new Map();

/**
 * Enqueues a sync task for a specific booth to ensure sequential processing.
 * @param {string} boothUid - The unique identifier for the booth.
 * @param {Function} task - An async function representing the sync work.
 * @returns {void}
 */
function enqueueBoothSync(boothUid, task) {
  const previousTask = boothSyncQueues.get(boothUid) || Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(task)
    .catch((error) => {
      logger.error(`[FirebaseSync] Booth queue task failed for ${boothUid}:`, error);
    })
    .finally(() => {
      if (boothSyncQueues.get(boothUid) === nextTask) {
        boothSyncQueues.delete(boothUid);
      }
    });

  boothSyncQueues.set(boothUid, nextTask);
}

/**
 * Maps the status from Firebase to the corresponding status in the PostgreSQL enum.
 * @param {string} firebaseStatus - The overall status from the Firebase slot data (e.g., 'booting', 'available').
 * @param {string} currentDbStatus - The current status of the slot in the database.
 * @param {boolean} batteryInserted - From telemetry, indicates if a battery is physically present.
 * @returns {string} The corresponding PostgreSQL status.
 */
function mapSlotStatus(firebaseStatus, currentDbStatus, batteryInserted) {
  // This mapping can be expanded as more states are defined in the IoT device firmware.
  if (firebaseStatus === 'fault') return 'faulty';
  if (firebaseStatus === 'maintenance') return 'maintenance';
  if (currentDbStatus === 'disabled') return 'disabled';

  // Protect the 'opening' state: If the DB says we are waiting for a deposit,
  // do not revert to 'available' just because the battery isn't in yet.
  if (currentDbStatus === 'opening' && !batteryInserted) {
    return 'opening';
  }

  // If a battery is physically present, the slot should be considered 'occupied'
  // unless it's in a transient 'opening' state for a deposit.
  if (batteryInserted) {
    return currentDbStatus === 'opening' ? 'opening' : 'occupied';
  }

  // If no battery is present, it's available.
  return 'available';
}

/**
 * Maps the door status from Firebase to the PostgreSQL enum.
 * @param {boolean} doorClosed - From Firebase slot data.
 * @param {boolean} doorLocked - From Firebase slot data.
 * @returns {string} 'locked', 'closed', or 'open'.
 */
function mapDoorStatus(doorClosed, doorLocked) {
  if (doorLocked) return 'locked';
  if (doorClosed) return 'closed';
  return 'open';
}

/**
 * Normalizes a raw SOC value to an integer between 1 and 100.
 * @param {any} rawSoc - The raw SOC value from telemetry.
 * @returns {number|null} The normalized SOC or null if invalid.
 */
function normalizeSoc(rawSoc) {
  const parsed = Number(rawSoc);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return null;
  }
  return parsed;
}

/**
 * Extracts the SOC value from a telemetry object.
 * @param {object} telemetry - The telemetry data object.
 * @returns {number|null} The SOC or null if not found.
 */
function getChargeSocFromTelemetry(telemetry) {
  const soc = normalizeSoc(telemetry?.soc);
  if (soc !== null) {
    return soc;
  }

  return null;
}

/**
 * A robust function to find and complete a deposit session.
 * This can be triggered by telemetry changes or an explicit ACK from the hardware.
 * @param {object} pgClient - The active PostgreSQL client.
 * @param {string} boothUid - The UID of the booth.
 * @param {string} slotIdentifier - The identifier of the slot.
 * @param {number} slotId - The primary key of the slot in the database.
 * @param {object} telemetry - The latest telemetry data for the slot.
 * @returns {Promise<boolean>} True if a session was completed.
 */
async function handleDepositCompletion(pgClient, boothUid, slotIdentifier, slotId, telemetry) {
  const chargeLevel = getChargeSocFromTelemetry(telemetry);
  const findAndUpdateDepositQuery = `
    UPDATE deposits
    SET
      status = 'completed',
      initial_charge_level = $1,
      completed_at = NOW()
    WHERE
      slot_id = $2
      AND status IN ('opening', 'occupied') -- The session must have been in an 'opening' or 'occupied' state.
      AND session_type = 'deposit'
    RETURNING id;
  `;
  const depositUpdateResult = await pgClient.query(findAndUpdateDepositQuery, [chargeLevel, slotId]);

  if (depositUpdateResult.rowCount > 0) {
    const depositId = depositUpdateResult.rows[0].id;
    logger.info(`Deposit session ${depositId} for slot ${slotIdentifier} completed with initial charge ${chargeLevel}%.`);

    // Automatically send command to start charging the newly deposited battery.
    const db = getDatabase();
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update({
      startCharging: true,
      stopCharging: false // Ensure mutual exclusivity
    });
    logger.info(`Sent 'startCharging' command to ${slotIdentifier} at booth ${boothUid} after deposit completion.`);
    return true; // Indicate that a session was completed.
  }
  return false; // No session was completed.
}

/**
 * A robust function to find and complete a withdrawal session.
 * This can be triggered by telemetry changes or an explicit ACK from the hardware.
 * @param {object} pgClient - The active PostgreSQL client.
 * @param {string} slotIdentifier - The identifier of the slot.
 * @param {number} slotId - The primary key of the slot in the database.
 * @returns {Promise<boolean>} True if a session was completed.
 */
async function handleWithdrawalCompletion(pgClient, slotIdentifier, slotId) {
  const findAndUpdateWithdrawalQuery = `
    WITH updated_deposit AS (
      UPDATE deposits
      SET
        status = 'completed',
        completed_at = NOW()
      WHERE
        slot_id = $1
        AND status = 'in_progress'
        AND session_type = 'withdrawal'
      RETURNING id, user_id
    )
    -- Mark the original deposit as 'redeemed' so it can't be used for more withdrawals.
    UPDATE deposits
    SET status = 'redeemed'
    WHERE user_id = (SELECT user_id FROM updated_deposit)
      AND session_type = 'deposit'
      AND status = 'completed'
    RETURNING (SELECT id FROM updated_deposit) AS session_id;
  `;
  const withdrawalUpdateResult = await pgClient.query(findAndUpdateWithdrawalQuery, [slotId]);

  if (withdrawalUpdateResult.rowCount > 0) {
    logger.info(`Withdrawal session ${withdrawalUpdateResult.rows[0].session_id} for slot ${slotIdentifier} finalized.`);
    return true;
  }
  return false;
}

/**
 * Syncs a single slot's state from Firebase to PostgreSQL.
 * @param {string} boothUid - The unique identifier for the booth.
 * @param {string} slotIdentifier - The identifier for the slot (e.g., 'slot001').
 * @param {object} slotData - The latest slot data from Firebase.
 * @param {object|null} slotBefore - The previous state of the slot (for change detection).
 * @returns {Promise<void>}
 */
async function syncSlotState(boothUid, slotIdentifier, slotData, slotBefore) {
  if (!slotData) return;

  // Use the refined change detection logic.
  if (!hasSlotChanged(slotBefore, slotData)) {
    return;
  }

  const dbPool = await pool;
  const pgClient = await acquirePgClientWithRetry(dbPool, boothUid, slotIdentifier);

  try {
    const telemetry = slotData.telemetry || {};
    const batteryInserted = !!telemetry.batteryInserted;
    const soc = getChargeSocFromTelemetry(telemetry);

    // 1. Fetch current database state for this slot.
    const currentSlotRes = await pgClient.query(
      `SELECT bs.id, bs.status, b.id as booth_id 
       FROM booth_slots bs
       JOIN booths b ON bs.booth_id = b.id
       WHERE b.booth_uid = $1 AND bs.slot_identifier = $2`,
      [boothUid, slotIdentifier]
    );

    let slotId;
    let boothId;
    let dbStatus;

    if (currentSlotRes.rowCount === 0) {
      // 2. If the slot doesn't exist, create it (Auto-provisioning).
      logger.info(`Slot ${slotIdentifier} not found for booth ${boothUid}. Auto-provisioning...`);
      const boothLookup = await pgClient.query("SELECT id FROM booths WHERE booth_uid = $1", [boothUid]);
      if (boothLookup.rowCount === 0) {
        throw new Error(`Booth ${boothUid} not found.`);
      }
      boothId = boothLookup.rows[0].id;
      const insertRes = await pgClient.query(
        `INSERT INTO booth_slots (booth_id, slot_identifier, status, door_status) 
         VALUES ($1, $2, 'available', 'closed') RETURNING id`,
        [boothId, slotIdentifier]
      );
      slotId = insertRes.rows[0].id;
      dbStatus = 'available';
    } else {
      slotId = currentSlotRes.rows[0].id;
      dbStatus = currentSlotRes.rows[0].status;
    }

    // 3. Map Firebase data to PostgreSQL enums.
    const newStatus = mapSlotStatus(slotData.status, dbStatus, batteryInserted);
    const doorStatus = mapDoorStatus(!!telemetry.doorClosed, !!telemetry.doorLocked);
    const isCharging = !!telemetry.isCharging;

    // 4. Update the database.
    const result = await pgClient.query(
      `UPDATE booth_slots 
       SET 
         status = $1, 
         door_status = $2, 
         charge_level_percent = $3, 
         is_charging = $4,
         telemetry = $5,
         updated_at = NOW()
       WHERE id = $6`,
      [newStatus, doorStatus, soc, isCharging, telemetry, slotId]
    );

    if (result.rowCount === 0) {
      // This can happen if the booth_uid doesn't exist in the `booths` table yet.
      logger.warn(`Could not sync slot ${slotIdentifier}. Booth with UID ${boothUid} not found in the database.`);
      return; // Exit if we can't find the slot
    }

    if (!slotId) {
      slotId = result.rows[0].id; // Get the newly created slot ID.
    }
    logger.debug(`Successfully synced slot ${slotIdentifier} for booth ${boothUid}.`);

    // --- Event-driven logic based on hardware ACK messages ---
    const ackMessage = slotData.command?.ack;

    if (ackMessage) {
      const db = getDatabase();
      const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);

      // Use a switch to handle different ACK messages from the hardware.
      switch (ackMessage) {
        case 'openForCollection_pulsed': {
          // The hardware has successfully energized the solenoid.
          logger.info(`Received 'openForCollection_pulsed' for slot ${slotIdentifier}. Recording attempt.`);
          try {
            // Update the session notes so the user/admin can see that an attempt occurred.
            await pgClient.query(
              `UPDATE deposits 
               SET notes = COALESCE(notes, '') || '\n[' || NOW() || '] Hardware pulsed solenoid for collection.'
               WHERE slot_id = $1 AND status = 'in_progress' AND session_type = 'withdrawal'`,
              [slotId]
            );
            // IMPORTANT: Clear the command and ACK. By setting openForCollection back to false,
            // we allow the app to re-issue the command, which the hardware will see as a fresh trigger.
            await commandRef.update({ openForCollection: false, ack: "" });
          } catch (dbError) {
            logger.error(`Failed to log hardware pulse for ${slotIdentifier}:`, dbError);
          }
          break;
        }

        case 'collection_complete': {
          // This is the definitive signal that a user has taken their battery.
          logger.info(`Received 'collection_complete' ACK for slot ${slotIdentifier}. Finalizing withdrawal session.`);
          try {
            // Use the centralized handler
            if (!await handleWithdrawalCompletion(pgClient, slotIdentifier, slotId)) {
              logger.warn(`'collection_complete' ACK for ${slotIdentifier} received, but no 'in_progress' session was found to complete.`);
            }
            // Clear command and ACK to stop hardware reporting
            await commandRef.update({ openForCollection: false, ack: "" });
          } catch (dbError) {
            logger.error(`Failed to finalize withdrawal session in DB for slot ${slotIdentifier} after 'collection_complete' ACK:`, dbError);
          }
          break;
        }

        case 'deposit_accepted': {
          // This is the definitive signal that a user has successfully deposited a battery.
          logger.info(`Received 'deposit_accepted' ACK for slot ${slotIdentifier}. Finalizing deposit session.`);
          try {
            if (!await handleDepositCompletion(pgClient, boothUid, slotIdentifier, slotId, telemetry)) {
              logger.warn(`'deposit_accepted' ACK for ${slotIdentifier} received, but no 'opening' session was found to complete.`);
            }
            // Clear command and ACK
            await commandRef.update({ openForDeposit: false, ack: "" });
          } catch (dbError) {
            logger.error(`Failed to finalize deposit session in DB for slot ${slotIdentifier} after 'deposit_accepted' ACK:`, dbError);
          }
          break;
        }

        case 'collection_timeout':
        case 'openForCollection_rejected_no_battery': {
          logger.warn(`Received '${ackMessage}' ACK for slot ${slotIdentifier}. Failing the in-progress withdrawal session.`);
          // The user paid but failed to collect the battery in time, or the slot was unexpectedly empty.
          // Mark the session as 'failed' to un-stick the user.
          const failQueryResult = await pgClient.query(
            "UPDATE deposits SET status = 'failed' WHERE slot_id = $1 AND status = 'in_progress' AND session_type = 'withdrawal' RETURNING id",
            [slotId]
          );
          if (failQueryResult.rowCount > 0) {
            logger.info(`Session ${failQueryResult.rows[0].id} marked as 'failed' due to collection issue.`);
          }
          // Reset command state
          await commandRef.update({ openForCollection: false, ack: "" });
          break;
        }

        case 'deposit_timeout':
        case 'openForDeposit_rejected_battery_present':
        case 'rejected_no_plug': // Deposit failed: plug not connected
        case 'rejected_voltage': // Deposit failed: bad voltage
        case 'rejected_temperature': // Deposit failed: bad temp
        case 'rejected_door_open': { // Deposit failed: door not closed
          logger.warn(`Received deposit failure ACK '${ackMessage}' for slot ${slotIdentifier}. Cancelling pending deposit session.`);
          // The deposit failed. Cancel the session and free up the slot.
          const cancelQueryResult = await pgClient.query(
            "UPDATE deposits SET status = 'cancelled' WHERE slot_id = $1 AND status = 'opening' AND session_type = 'deposit' RETURNING id",
            [slotId]
          );
          if (cancelQueryResult.rowCount > 0) {
            logger.info(`Session ${cancelQueryResult.rows[0].id} marked as 'cancelled' due to deposit failure.`);
          }
          // Explicitly ensure the slot is marked available if the deposit failed
          await pgClient.query("UPDATE booth_slots SET status = 'available' WHERE id = $1", [slotId]);
          // Reset command state
          await commandRef.update({ openForDeposit: false, ack: "" });
          break;
        }

        case 'charging_resumed': {
          logger.info(`Received 'charging_resumed' for slot ${slotIdentifier}. Updating DB: is_charging = true.`);
          await pgClient.query("UPDATE booth_slots SET is_charging = true WHERE id = $1", [slotId]);
          await commandRef.update({ ack: "" });
          break;
        }

        case 'startCharging_accepted': {
          logger.info(`Received 'startCharging_accepted' for slot ${slotIdentifier}. Updating DB: is_charging = true.`);
          await pgClient.query("UPDATE booth_slots SET is_charging = true WHERE id = $1", [slotId]);
          await commandRef.update({ startCharging: false, ack: "" });
          break;
        }

        case 'stopCharging_done': {
          logger.info(`Received 'stopCharging_done' for slot ${slotIdentifier}. Updating DB: is_charging = false.`);
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);
          await commandRef.update({ stopCharging: false, ack: "" });
          break;
        }

        case 'resume_blocked_safety':
        case 'startCharging_rejected_safety': {
          logger.error(`CRITICAL: Received '${ackMessage}' for slot ${slotIdentifier}. Updating DB to reflect charging is OFF.`);
          // The hardware refused to charge. This is important to reflect in our database.
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);

          // Update any active session on this slot with a note about the safety block.
          await pgClient.query(
            `UPDATE deposits 
             SET notes = COALESCE(notes, '') || '\n[' || NOW() || '] Hardware Safety Block: ' || $1
             WHERE slot_id = $2 AND status NOT IN ('completed', 'failed', 'cancelled', 'redeemed')`,
            [ackMessage, slotId]
          );

          await commandRef.update({ startCharging: false, ack: "" });
          break;
        }

        case 'battery_full': {
          logger.info(`Received 'battery_full' ACK for slot ${slotIdentifier}. Updating DB: is_charging = false.`);
          // The battery is full, so we should stop charging it.
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);
          await commandRef.update({ ack: "" });
          break;
        }

        // Log informational ACKs for debugging and visibility.
        case 'openForCollection_sent':
        case 'openForDeposit_sent':
        case 'startCharging_pulsed':
        case 'forceUnlock_pulsed':
        case 'forceUnlock_done':
        case 'forceLock_done':
          logger.debug(`Hardware signal: ${ackMessage} for slot ${slotIdentifier}.`);
          break;

        default:
          logger.debug(`Received unhandled ACK '${ackMessage}' for slot ${slotIdentifier}. No action taken.`);
          break;
      }
    }
    // --- End of ACK-based logic ---

  } catch (error) {
    logger.error(`Error syncing slot ${boothUid}/${slotIdentifier}:`, error);
  } finally {
    pgClient.release();
  }
}

// In-memory cache to hold the last known state of each booth.
const boothStateCache = {};

/**
 * Initializes the Firebase listener for the 'booths' path.
 * @returns {void}
 */
function initializeFirebaseSync() {
  const db = getDatabase();
  const boothsRef = db.ref('booths');

  logger.info('Initializing Firebase Realtime Database sync for /booths...');

  // 1. Initial data load to populate the cache.
  boothsRef.once('value', (snapshot) => {
    Object.assign(boothStateCache, snapshot.val());
    logger.info('Firebase listener cache populated with initial booth states.');
  });

  // Listen for changes to any child under the 'booths' path.
  boothsRef.on('child_changed', (boothSnapshot) => {
    const boothUid = boothSnapshot.key;
    const boothAfter = boothSnapshot.val();

    enqueueBoothSync(boothUid, async () => {
      const boothBefore = boothStateCache[boothUid] || {};
      const beforeSlots = boothBefore.slots || {};
      const afterSlots = boothAfter?.slots || {};

      // Identify which slots have changed and need syncing.
      const slotIdentifiers = new Set([
        ...Object.keys(beforeSlots),
        ...Object.keys(afterSlots),
      ]);

      const syncPromises = [];
      for (const slotIdentifier of slotIdentifiers) {
        const slotBefore = beforeSlots[slotIdentifier];
        const slotAfter = afterSlots[slotIdentifier];

        // Process only if the slot exists in the latest snapshot.
        if (slotAfter) {
          syncPromises.push(syncSlotState(boothUid, slotIdentifier, slotAfter, slotBefore));
        }
      }

      await Promise.all(syncPromises);
      // Update the cache with the latest state for this booth.
      boothStateCache[boothUid] = boothAfter;
    });
  });
}

module.exports = { 
  initializeFirebaseSync, 
  handleWithdrawalCompletion, 
  handleDepositCompletion 
};
