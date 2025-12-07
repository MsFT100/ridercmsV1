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
        last_seen_at
      )
      SELECT id, $2, $3, $4, $5, NOW()
      FROM booths
      WHERE booth_uid = $1
      ON CONFLICT (booth_id, slot_identifier)
      DO UPDATE SET
        status = EXCLUDED.status,
        door_status = EXCLUDED.door_status,
        charge_level_percent = EXCLUDED.charge_level_percent,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING id;
    `;

    const status = mapSlotStatus(slotData.status, slotData.devicePresent);
    const doorStatus = mapDoorStatus(slotData.doorClosed, slotData.doorLocked);
    const chargeLevel = slotData.soc || null;

    const result = await pgClient.query(upsertQuery, [
      boothUid,
      slotIdentifier,
      status,
      doorStatus,
      chargeLevel,
    ]);

    if (result.rowCount > 0) {
      logger.debug(`Successfully synced slot ${slotIdentifier} for booth ${boothUid}.`);
    } else {
      // This can happen if the booth_uid doesn't exist in the `booths` table yet.
      logger.warn(`Could not sync slot ${slotIdentifier}. Booth with UID ${boothUid} not found in the database.`);
    }
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