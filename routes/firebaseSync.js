const { getDatabase } = require('firebase-admin/database');
const pool = require('../db');
const logger = require('../utils/logger');

/**
 * Maps the status from Firebase to the corresponding status in the PostgreSQL enum.
 * @param {string} firebaseStatus - The status from the Firebase slot data (e.g., 'booting', 'available').
 * @param {boolean} devicePresent - Whether a device is present in the slot.
 * @returns {string} The corresponding PostgreSQL status.
 */
function mapSlotStatus(firebaseStatus, devicePresent) {
  // This mapping can be expanded as more states are defined in the IoT device firmware.
  if (firebaseStatus === 'fault') return 'faulty';
  if (firebaseStatus === 'maintenance') return 'maintenance';
  if (devicePresent) return 'occupied';
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
 * Processes a single slot's data from a Firebase snapshot and updates the PostgreSQL database.
 * @param {string} boothUid - The UID of the booth (e.g., 'booth001').
 * @param {string} slotIdentifier - The identifier for the slot (e.g., 'slot001').
 * @param {object} slotData - The data object for the slot from Firebase.
 */
async function processSlotUpdate(boothUid, slotIdentifier, slotData) {
  const pgClient = await pool.connect();
  let slotId = null;
  try {
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

    // Correctly read telemetry data, providing default values if telemetry is missing.
    const telemetry = slotData.telemetry || {};
    const status = mapSlotStatus(slotData.status, slotData.devicePresent);
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

    slotId = result.rows[0].id;
    logger.debug(`Successfully synced slot ${slotIdentifier} for booth ${boothUid}.`);

    // --- Logic to complete a pending deposit session ---
    // If a device is now present and the slot status was 'opening', it means a deposit just happened.
    if (slotData.devicePresent && status === 'occupied') {
      const findAndUpdateDepositQuery = `
        UPDATE deposits
        SET
          status = 'completed',
          initial_charge_level = $1,
          completed_at = NOW()
        WHERE
          slot_id = $2
          AND status = 'pending'
          AND session_type = 'deposit'
        RETURNING id;
      `;
      // Use the real-time SOC from the hardware as the initial charge level.
      const depositUpdateResult = await pgClient.query(findAndUpdateDepositQuery, [chargeLevel, slotId]);

      if (depositUpdateResult.rowCount > 0) {
        const depositId = depositUpdateResult.rows[0].id;
        logger.info(`Deposit session ${depositId} completed for slot ${slotIdentifier} at booth ${boothUid} with initial charge ${chargeLevel}%.`);

        // Per IoT spec, explicitly command the slot to start charging after a successful deposit.
        const db = getDatabase();
        const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
        await commandRef.update({ startCharging: true, stopCharging: false });
        logger.info(`Sent 'startCharging' command to ${boothUid}/${slotIdentifier} after successful deposit.`);
      }
    }
    // --- End of deposit completion logic ---

    // --- Event-driven logic based on hardware ACK messages ---
    const ackMessage = slotData.command?.ack;

    if (ackMessage) {
      // Use a switch to handle different ACK messages from the hardware.
      switch (ackMessage) {
        case 'collection_complete': {
          logger.info(`Received 'collection_complete' ACK for slot ${slotIdentifier}. Finalizing withdrawal session.`);
          try {
            const findAndUpdateWithdrawalQuery = `
              WITH updated_deposit AS (
                UPDATE deposits
                SET
                  status = 'completed',
                  completed_at = NOW()
                WHERE
                  slot_id = $1
                  AND status = 'in_progress' -- The session must have been paid for
                  AND session_type = 'withdrawal'
                RETURNING id, battery_id, user_id
              )
              UPDATE batteries
              SET user_id = NULL -- Disassociate the battery from the user
              WHERE id = (SELECT battery_id FROM updated_deposit)
              RETURNING (SELECT id FROM updated_deposit), (SELECT user_id FROM updated_deposit);
            `;
            const withdrawalUpdateResult = await pgClient.query(findAndUpdateWithdrawalQuery, [slotId]);

            if (withdrawalUpdateResult.rowCount > 0) {
              const { id: depositId, user_id: userId } = withdrawalUpdateResult.rows[0];
              logger.info(`Withdrawal session ${depositId} for user ${userId} successfully completed for slot ${slotIdentifier}.`);
            }
          } catch (dbError) {
            logger.error(`Failed to finalize withdrawal session in DB for slot ${slotIdentifier} after 'collection_complete' ACK:`, dbError);
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
        case 'rejected_no_plug':
        case 'rejected_voltage':
        case 'rejected_temperature':
        case 'rejected_door_open': {
          logger.warn(`Received deposit failure ACK '${ackMessage}' for slot ${slotIdentifier}. Cancelling pending deposit session.`);
          // The deposit failed for a variety of reasons. Cancel the pending session so the user can try again.
          const cancelQueryResult = await pgClient.query(
            "UPDATE deposits SET status = 'cancelled' WHERE slot_id = $1 AND status = 'pending' AND session_type = 'deposit' RETURNING id",
            [slotId]
          );
          if (cancelQueryResult.rowCount > 0) {
            logger.info(`Session ${cancelQueryResult.rows[0].id} marked as 'cancelled' due to deposit failure.`);
          }
          break;
        }

        case 'startCharging_rejected_safety': {
          logger.error(`CRITICAL: Received 'startCharging_rejected_safety' for slot ${slotIdentifier}. Updating DB to reflect charging is OFF.`);
          // The hardware refused to charge. This is important to reflect in our database.
          await pgClient.query("UPDATE booth_slots SET is_charging = false WHERE id = $1", [slotId]);
          break;
        }

        default:
          // For other ACKs like 'deposit_accepted', 'startCharging_accepted', etc., we can just log them for now.
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

/**
 * Initializes the Firebase listener for the 'booths' path.
 */
function initializeFirebaseSync() {
  const db = getDatabase();
  const boothsRef = db.ref('booths');

  logger.info('Initializing Firebase Realtime Database sync for /booths...');

  // Listen for changes to any child under the 'booths' path.
  boothsRef.on('child_changed', (boothSnapshot) => {
    const boothUid = boothSnapshot.key;
    const boothData = boothSnapshot.val();

    if (boothData && boothData.slots) {
      // Iterate over each slot within the changed booth and process its update.
      Object.entries(boothData.slots).forEach(([slotIdentifier, slotData]) => {
        processSlotUpdate(boothUid, slotIdentifier, slotData);
      });
    }
  });
}

module.exports = { initializeFirebaseSync };