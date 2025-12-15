const { getDatabase } = require('firebase-admin/database');
const { v4: uuidv4 } = require('uuid');
const poolPromise = require('../db');
const logger = require('../utils/logger');

/**
 * Processes a successful battery deposit event.
 * @param {object} client - The PostgreSQL client.
 * @param {string} boothUid - The UID of the booth.
 * @param {string} slotIdentifier - The identifier of the slot.
 * @param {object} telemetry - The telemetry data from Firebase.
 */
async function handleDeposit(client, boothUid, slotIdentifier, telemetry) {
  // Find the pending deposit session for this slot.
  const depositRes = await client.query(
    `SELECT d.id, d.user_id FROM deposits d
     JOIN booths b ON d.booth_id = b.id
     JOIN booth_slots s ON d.slot_id = s.id
     WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.status = 'pending' AND d.session_type = 'deposit'
     ORDER BY d.created_at DESC LIMIT 1`,
    [boothUid, slotIdentifier]
  );

  if (depositRes.rows.length === 0) {
    logger.warn(`[FB Listener] Deposit detected in ${boothUid}/${slotIdentifier}, but no matching pending session found.`);
    return;
  }
  const { id: depositId, user_id: firebaseUid } = depositRes.rows[0];

  // Use the battery UID from telemetry if available, otherwise generate a new one.
  const batteryUid = telemetry.qr || `sim-fb-${uuidv4().slice(0, 8)}`;
  const chargeLevel = telemetry.soc || 0;

  // Upsert the battery (create if new) and link to the user.
  const upsertBatteryQuery = `
    INSERT INTO batteries (battery_uid, user_id, charge_level_percent)
    VALUES ($1, $2, $3)
    ON CONFLICT (battery_uid) DO UPDATE SET user_id = $2, charge_level_percent = $3
    RETURNING id;
  `;
  const batteryRes = await client.query(upsertBatteryQuery, [batteryUid, firebaseUid, chargeLevel]);
  const batteryId = batteryRes.rows[0].id;

  // Update the slot and complete the deposit record.
  await client.query(
    "UPDATE booth_slots SET status = 'occupied', current_battery_id = $1, charge_level_percent = $2 WHERE slot_identifier = $3 AND booth_id = (SELECT id FROM booths WHERE booth_uid = $4)",
    [batteryId, chargeLevel, slotIdentifier, boothUid]
  );
  await client.query(
    "UPDATE deposits SET status = 'completed', battery_id = $1, initial_charge_level = $2, completed_at = NOW() WHERE id = $3",
    [batteryId, chargeLevel, depositId]
  );

  // --- Automatically start charging ---
  const db = getDatabase();
  const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
  await commandRef.update({
    startCharging: true,
    stopCharging: false // Ensure mutual exclusivity
  });
  logger.info(`[FB Listener] Sent 'startCharging' command to ${slotIdentifier} at booth ${boothUid} after deposit.`);
  // --- End of start charging ---


  logger.info(`[FB Listener] Deposit confirmed for user '${firebaseUid}' with battery '${batteryUid}' in slot '${slotIdentifier}'.`);
}

/**
 * Processes a successful battery withdrawal event.
 * @param {object} client - The PostgreSQL client.
 * @param {string} boothUid - The UID of the booth.
 * @param {string} slotIdentifier - The identifier of the slot.
 */
async function handleWithdrawal(client, boothUid, slotIdentifier) {
  // Find the 'in_progress' withdrawal session for this slot.
  const sessionRes = await client.query(
    `SELECT d.id, d.slot_id, d.user_id FROM deposits d
     JOIN booths b ON d.booth_id = b.id
     JOIN booth_slots s ON d.slot_id = s.id
     WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.session_type = 'withdrawal' AND d.status = 'in_progress'
     ORDER BY d.created_at DESC LIMIT 1`,
    [boothUid, slotIdentifier]
  );

  if (sessionRes.rows.length === 0) {
    logger.warn(`[FB Listener] Withdrawal detected in ${boothUid}/${slotIdentifier}, but no matching in_progress session found.`);
    return;
  }
  const { id: sessionId, slot_id: slotId, user_id: firebaseUid } = sessionRes.rows[0];

  // Mark the session as completed.
  await client.query("UPDATE deposits SET status = 'completed', completed_at = NOW() WHERE id = $1", [sessionId]);

  // Free up the slot and unlink the battery from it.
  await client.query("UPDATE booth_slots SET status = 'available', current_battery_id = NULL, charge_level_percent = NULL WHERE id = $1", [slotId]);

  // --- Frontend Notification (Commented Out) ---
  // // A completed withdrawal means the user has no active session.
  // const db = getDatabase();
  // const userStatusRef = db.ref(`users/${firebaseUid}/session_status`);
  // await userStatusRef.set(null);

  logger.info(`[FB Listener] Withdrawal confirmed for slot '${slotIdentifier}' at booth '${boothUid}'. Slot is now available.`);
}

// In-memory cache to hold the last known state of each booth.
const boothStateCache = {};

/**
 * Initializes the Firebase listener for booth slot changes.
 */
function initializeFirebaseListener() {
  const db = getDatabase();
  const boothsRef = db.ref('booths');
  logger.info('Initializing Firebase Realtime Database listener for booth events...');

  // 1. Initial data load to populate the cache.
  boothsRef.once('value', (snapshot) => {
    Object.assign(boothStateCache, snapshot.val());
    logger.info('Firebase listener cache populated with initial booth states.');
  });

  // 2. Listen for when a booth's data changes.
  boothsRef.on('child_changed', async (snapshot) => {
    const boothUid = snapshot.key;
    const afterData = snapshot.val();
    logger.info(`[FB Listener] Change detected for booth: ${boothUid}`);

    // Get the state of the booth *before* this change from our cache.
    const beforeData = boothStateCache[boothUid];

    // If there's no "before" state or no slots, we can't compare. Update cache and exit.
    if (!beforeData || !beforeData.slots || !afterData.slots) {
      boothStateCache[boothUid] = afterData; // Update cache
      return;
    }

    // Compare each slot to find what changed.
    for (const slotIdentifier in afterData.slots) {
      const slotBefore = beforeData.slots[slotIdentifier];
      const slotAfter = afterData.slots[slotIdentifier];

      // If a slot is new or didn't exist before, we can't compare it.
      if (!slotBefore) continue;

      // Skip if telemetry hasn't changed or doesn't exist.
      if (!slotAfter.telemetry || !slotBefore.telemetry || JSON.stringify(slotAfter.telemetry) === JSON.stringify(slotBefore.telemetry)) {
        continue;
      }

      // Now we can reliably compare the before and after states.
      const { batteryInserted, doorClosed } = slotAfter.telemetry;
      const wasBatteryInserted = slotBefore.telemetry.batteryInserted;

      const pool = await poolPromise;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // DEPOSIT: A battery was just inserted and the door is closed.
        if (batteryInserted && !wasBatteryInserted && doorClosed) {
          logger.info(`[FB Listener] Potential deposit detected in ${boothUid}/${slotIdentifier}.`);
          await handleDeposit(client, boothUid, slotIdentifier, slotAfter.telemetry);
        }

        // WITHDRAWAL: A battery was just removed and the door is closed.
        if (!batteryInserted && wasBatteryInserted && doorClosed) {
          logger.info(`[FB Listener] Potential withdrawal detected in ${boothUid}/${slotIdentifier}.`);
          await handleWithdrawal(client, boothUid, slotIdentifier);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`[FB Listener] Error processing event for ${boothUid}/${slotIdentifier}:`, error);
      } finally {
        client.release();
      }
    }

    // CRITICAL: Update the cache with the new state for the next comparison.
    boothStateCache[boothUid] = afterData;
  });

  logger.info('Firebase listener is active.');
}

module.exports = { initializeFirebaseListener };
