const { getDatabase } = require('firebase-admin/database');
const pool = require('../db');
const logger = require('./logger');

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
 * A robust function to find and complete a deposit session.
 * This can be triggered by telemetry changes or an explicit ACK from the hardware.
 * @param {object} pgClient - The active PostgreSQL client.
 * @param {string} boothUid - The UID of the booth.
 * @param {string} slotIdentifier - The identifier of the slot.
 * @param {number} slotId - The primary key of the slot in the database.
 * @param {object} telemetry - The latest telemetry data for the slot.
 */
async function handleDepositCompletion(pgClient, boothUid, slotIdentifier, slotId, telemetry) {
  const chargeLevel = telemetry.soc || null;
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
 */
async function handleWithdrawalCompletion(pgClient, slotIdentifier, slotId) {
  const findAndUpdateWithdrawalQuery = `
    WITH updated_deposit AS (
      UPDATE deposits
      SET
        status = 'completed',
        completed_at = NOW()
      WHERE slot_id = $1 AND status IN ('in_progress', 'pending') -- The session must have been paid for or is about to be confirmed as paid.
        AND session_type = 'withdrawal'
      RETURNING id, user_id, consumed_deposit_id
    )
    -- Mark the original deposit as 'redeemed' so it can't be used again.
    UPDATE deposits
    SET status = 'redeemed'
    WHERE id = (SELECT consumed_deposit_id FROM updated_deposit)
    RETURNING (SELECT id FROM updated_deposit) as id, (SELECT user_id FROM updated_deposit) as user_id;
  `;
  const withdrawalUpdateResult = await pgClient.query(findAndUpdateWithdrawalQuery, [slotId]);

  if (withdrawalUpdateResult.rowCount > 0) {
    const { id: sessionId, user_id: userId } = withdrawalUpdateResult.rows[0];
    logger.info(`Withdrawal session ${sessionId} for user ${userId} successfully completed for slot ${slotIdentifier}.`);
    return true; // Indicate that a session was completed.
  }
  return false; // No session was completed.
}

/**
 * Processes a single slot's data from a Firebase snapshot and updates the PostgreSQL database.
 * @param {string} boothUid - The UID of the booth (e.g., 'booth001').
 * @param {string} slotIdentifier - The identifier for the slot (e.g., 'slot001').
 * @param {object} slotData - The data object for the slot from Firebase.
 */
async function processSlotUpdate(boothUid, slotIdentifier, slotData) {
  // Get the state of the slot *before* this change from our cache.
  const slotBefore = boothStateCache[boothUid]?.slots?.[slotIdentifier];

  const dbPool = await pool;
  const pgClient = await dbPool.connect();
  let slotId = null;
  try {
    // First, get the current status of the slot from our database.
    // This is essential for state-based logic.
    // This is crucial for the mapSlotStatus function to make an intelligent decision.
    const currentSlotStateQuery = `
      SELECT s.id, s.status
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE b.booth_uid = $1 AND s.slot_identifier = $2;
    `;
    const currentSlotStateRes = await pgClient.query(currentSlotStateQuery, [boothUid, slotIdentifier]);

    // Determine the current DB status. Default to 'unknown' if the slot is new.
    // This prevents the logic from breaking on the very first sync of a new slot.
    // This value comes directly from PostgreSQL and represents the last known state.
    const currentDbStatus = currentSlotStateRes.rowCount > 0 ? currentSlotStateRes.rows[0].status : 'unknown';
    slotId = currentSlotStateRes.rowCount > 0 ? currentSlotStateRes.rows[0].id : null;

    // Correctly read telemetry data, providing default values if telemetry is missing.
    const telemetry = slotData.telemetry || {};
    const wasBatteryInserted = slotBefore?.telemetry?.batteryInserted === true;

    // --- Telemetry-based Deposit Completion ---
    // This is our most reliable fallback. It triggers if a battery *was not* present before,
    // but *is* present now, and the door is secure. This detects the transition.
    console.log("Current DB status for slot", slotIdentifier, ":", currentDbStatus);
    if (currentDbStatus === 'opening') {
      logger.debug(`[Deposit Check] slot: ${slotIdentifier}, currentDbStatus: ${currentDbStatus}, wasBatteryInserted: ${wasBatteryInserted}, batteryInserted: ${telemetry.batteryInserted}, doorClosed: ${telemetry.doorClosed}, doorLocked: ${telemetry.doorLocked}`);
    }

    // --- Telemetry-based Deposit Completion ---
    // This triggers if a battery *was not* present before, but *is* present now,
    // and the door is secure. It then attempts to complete any 'opening' deposit session.
    if (
      !wasBatteryInserted &&
      telemetry.batteryInserted === true &&
      telemetry.doorClosed === true &&
      telemetry.doorLocked === true
    ) {
      logger.info(`Telemetry transition indicates successful deposit for slot ${slotIdentifier}. Finalizing session.`);
      if (!await handleDepositCompletion(pgClient, boothUid, slotIdentifier, slotId, telemetry)) {
        logger.debug(`Telemetry transition for deposit detected for ${slotIdentifier}, but no 'opening' or 'occupied' session found to complete.`);
      }
    }
    // --- Telemetry-based Withdrawal Completion ---
    // This is a fallback for a missed 'collection_complete' ACK. It triggers if a battery
    // *was* present before, but *is not* present now, and the door is secure (closed again).
    if (currentDbStatus === 'occupied') {
      logger.debug(`[Withdrawal Check] slot: ${slotIdentifier}, currentDbStatus: ${currentDbStatus}, wasBatteryInserted: ${wasBatteryInserted}, batteryInserted: ${telemetry.batteryInserted}, doorClosed: ${telemetry.doorClosed}, doorLocked: ${telemetry.doorLocked}`);
    }

   if (
      telemetry.batteryInserted === false &&
      telemetry.doorClosed === true &&
      telemetry.doorLocked === true
    ) {
      const hasActiveWithdrawal = await pgClient.query(
        `
        SELECT 1
        FROM deposits
        WHERE slot_id = $1
          AND session_type = 'withdrawal'
          AND status IN ('pending','in_progress')
        LIMIT 1
        `,
        [slotId]
      );

      if (hasActiveWithdrawal.rowCount > 0) {
        const completed = await handleWithdrawalCompletion(
          pgClient,
          slotIdentifier,
          slotId
        );

        if (completed) {
          logger.info(
            `Withdrawal auto-completed via invariant check for slot ${slotIdentifier}`
          );
        }
      }
    }

    // --- End of telemetry-based deposit completion logic ---

    // The main query to insert or update a booth_slot.
    // It uses a subquery to get the booth's primary key (id) from its UID.
    const upsertQuery = `
      INSERT INTO booth_slots (
        booth_id,
        slot_identifier,
        status,
        door_status,
        charge_level_percent,
        telemetry,
        last_seen_at
      )
      SELECT id, $2, $3, $4, $5, $6, NOW()
      FROM booths
      WHERE booth_uid = $1
      ON CONFLICT (booth_id, slot_identifier)
      DO UPDATE SET
        status = EXCLUDED.status,
        door_status = EXCLUDED.door_status,
        charge_level_percent = EXCLUDED.charge_level_percent,
        telemetry = EXCLUDED.telemetry,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING id;
    `;

    //console.log("Telemetry data for slot", slotIdentifier, ":", telemetry);
    // If a slot is administratively disabled, its status should not be changed by telemetry updates.
    const status = currentDbStatus== 'disabled' ? 'disabled' : mapSlotStatus(slotData.status, currentDbStatus, telemetry.batteryInserted);
    const doorStatus = mapDoorStatus(telemetry.doorClosed, telemetry.doorLocked);
    const chargeLevel = telemetry.soc || null;

    const result = await pgClient.query(upsertQuery, [
      boothUid,
      slotIdentifier,
      status,
      doorStatus,
      chargeLevel,
      telemetry,
    ]);

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
      // Use a switch to handle different ACK messages from the hardware.
      switch (ackMessage) {
        case 'collection_complete': {
          // This is the definitive signal that a user has taken their battery.
          logger.info(`Received 'collection_complete' ACK for slot ${slotIdentifier}. Finalizing withdrawal session.`);
          try {
            // Use the centralized handler
            if (!await handleWithdrawalCompletion(pgClient, slotIdentifier, slotId)) {
              logger.warn(`'collection_complete' ACK for ${slotIdentifier} received, but no 'in_progress' session was found to complete.`);
            }
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
          break;
        }

        case 'startCharging_accepted': {
          logger.info(`Received 'startCharging_accepted' for slot ${slotIdentifier}. Updating DB: is_charging = true.`);
          await pgClient.query("UPDATE booth_slots SET is_charging = true WHERE id = $1", [slotId]);
          break;
        }

        case 'stopCharging_done': {
          logger.info(`Received 'stopCharging_done' for slot ${slotIdentifier}. Updating DB: is_charging = false.`);
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);
          break;
        }

        case 'startCharging_rejected_safety': {
          logger.error(`CRITICAL: Received 'startCharging_rejected_safety' for slot ${slotIdentifier}. Updating DB to reflect charging is OFF.`);
          // The hardware refused to charge. This is important to reflect in our database.
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);
          break;
        }

        // Log informational ACKs for debugging and visibility.
        case 'openForCollection_sent':
        case 'openForDeposit_sent':
        case 'forceUnlock_done':
        case 'forceLock_done':
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

    if (boothAfter && boothAfter.slots) {
      // Iterate over each slot within the changed booth and process its update.
      Object.entries(boothAfter.slots).forEach(([slotIdentifier, slotData]) => {
        processSlotUpdate(boothUid, slotIdentifier, slotData);
      });
    }

    // CRITICAL: Update the cache with the new state *after* processing all slots.
    boothStateCache[boothUid] = boothAfter;
  });
}

module.exports = { initializeFirebaseSync };
