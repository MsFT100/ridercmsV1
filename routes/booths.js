const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const logger = require('../utils/logger');
const poolPromise = require('../db');
const { verifyFirebaseToken } = require('../middleware/auth');
const verifyApiKey = require('../middleware/verifyApiKey');
const { initiateSTKPush, querySTKStatus } = require('../utils/mpesa'); // Import the specific function

const router = Router();

/**
 * GET /api/booths
 * @summary Get a list of all public booths
 * @description Retrieves a list of all 'online' booths with their location and available slot count.
 * This is a public endpoint for users to find nearby stations.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: A list of available booths.
 *   500:
 *     description: Internal server error.
 */
router.get('/', verifyFirebaseToken, async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // This query fetches all online booths and counts their available slots.
    // It assumes you have 'latitude' and 'longitude' columns in your 'booths' table.
    const query = `
      SELECT
        b.booth_uid,
        b.name,
        b.location_address,
        b.latitude,
        b.longitude,
        (
          SELECT COUNT(*)
          FROM booth_slots bs
          WHERE bs.booth_id = b.id AND bs.status = 'available'
        ) AS "availableSlots"
      FROM booths b
      WHERE b.status = 'online';
    `;

    const { rows } = await client.query(query);

    res.status(200).json(rows);
  } catch (error) {
    logger.error('Failed to get public list of booths:', error);
    res.status(500).json({ error: 'Failed to retrieve booth list.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/initiate-deposit
 * Called by a user's app to start a deposit. Finds an available slot
 * and creates a pending session record.
 */
router.post('/initiate-deposit', verifyFirebaseToken, async (req, res) => {
  const { boothUid } = req.body;
  const { uid: firebaseUid } = req.user; // Get user's UID from the verified session

  if (!boothUid) {
    return res.status(400).json({ error: 'boothUid is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Self-Healing & Pre-check for existing sessions ---
    // Find any active sessions. If a 'pending' deposit exists, we'll clean it up.
    // If an 'in_progress' session exists (deposit or withdrawal), we must block.
    const existingSessionQuery = `
      SELECT id, status, slot_id FROM deposits
      WHERE user_id = $1 AND status IN ('pending', 'in_progress')
    `;
    const existingSessionRes = await client.query(existingSessionQuery, [firebaseUid]);

    for (const session of existingSessionRes.rows) {
      if (session.status === 'in_progress') {
        // An 'in_progress' session is a hard stop. The user must wait for it to complete or timeout.
        return res.status(409).json({
          error: 'Active session in progress.',
          message: 'You have a session that is currently in progress. Please complete or cancel it before starting a new one.'
        });
      }
      if (session.status === 'pending' && session.slot_id) {
        // This is a stale, pending deposit. Clean it up.
        logger.warn(`Cleaning up stale pending deposit session ${session.id} for user ${firebaseUid}.`);
        await client.query("UPDATE deposits SET status = 'cancelled' WHERE id = $1", [session.id]);
        await client.query("UPDATE booth_slots SET status = 'available' WHERE id = $1", [session.slot_id]);
      }
    }

    // After cleanup, re-check for any non-deposit pending sessions (like a pending withdrawal)
    const postCleanupCheck = await client.query(
      `SELECT 1 FROM deposits WHERE user_id = $1 AND status = 'pending' AND session_type = 'withdrawal'`,
      [firebaseUid]
    );
    if (postCleanupCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'Active session exists.',
        message: 'You have a pending withdrawal. Please complete or cancel it before starting a new deposit.'
      });
    }

    // 1. Find the booth's internal ID from its public UID
    const boothRes = await client.query('SELECT id FROM booths WHERE booth_uid = $1 AND status = \'online\'', [boothUid]);
    if (boothRes.rows.length === 0) {
      throw new Error(`Booth ${boothUid} is not online or does not exist.`);
    }
    const boothId = boothRes.rows[0].id;

    // 2. Find an available, empty slot in that booth, with a real-time check against Firebase.
    const availableSlotsRes = await client.query(
      "SELECT id, slot_identifier FROM booth_slots WHERE booth_id = $1 AND status = 'available' ORDER BY slot_identifier",
      [boothId]
    );

    if (availableSlotsRes.rows.length === 0) {
      throw new Error('No slots are marked as available for deposit at this booth.');
    }

    const db = getDatabase();
    let assignedSlot = null;

    // Iterate through DB-available slots and perform a real-time check against Firebase.
    for (const potentialSlot of availableSlotsRes.rows) {
      const slotRef = db.ref(`booths/${boothUid}/slots/${potentialSlot.slot_identifier}`);
      const snapshot = await slotRef.get();

      if (snapshot.exists()) {
        const slotData = snapshot.val();
        const telemetry = slotData.telemetry || {};

        // A battery is present if both are true. This slot is not truly available.
        if (telemetry.plugConnected === true && telemetry.batteryInserted === true) {
          logger.warn(`Slot ${potentialSlot.slot_identifier} at booth ${boothUid} is marked 'available' in DB but has a battery according to Firebase. Skipping.`);
          continue; // Skip to the next available slot.
        }
      }
      // This slot is available in the DB and confirmed empty in Firebase. Assign it.
      assignedSlot = potentialSlot;
      break;
    }

    if (!assignedSlot) {
      throw new Error('All available slots are currently occupied. Please try again later.');
    }
    const { id: slotId, slot_identifier: slotIdentifier } = assignedSlot;

    // 3. Create a 'deposits' record to track this session
    await client.query(
      "INSERT INTO deposits (user_id, booth_id, slot_id, session_type, status) VALUES ($1, $2, $3, 'deposit', 'pending')",
      [firebaseUid, boothId, slotId]
    );

    // 4. Mark the slot as 'opening' to reserve it
    await client.query("UPDATE booth_slots SET status = 'opening' WHERE id = $1", [slotId]);

    // 5. Send the command to Firebase to open the door for deposit.
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update({
      openForDeposit: true,
      openForCollection: false // Ensure mutual exclusivity
      // forceUnlock: true, // New command to simply unlock the door
      // forceLock: false // Ensure mutual exclusivity
    });

    await client.query('COMMIT');

    logger.info(`Deposit session initiated for user '${firebaseUid}' at booth '${boothUid}', slot '${slotIdentifier}'.`);

    // Return the slot information in the format the frontend expects.
    res.status(200).json({
      slot: {
        identifier: slotIdentifier,
        // Add other default/known properties of the slot if available
        status: 'opening',
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to initiate deposit for user ${firebaseUid} at booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to initiate deposit process.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/my-battery-status
 * Allows a logged-in user to check the status and location of their deposited battery.
 */
router.get('/my-battery-status', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // 1. Find where the user's battery is located from our database.
    // This query now correctly finds the last successful deposit session for the user
    // that has not yet been part of a completed withdrawal. This ignores any cancelled or failed sessions.
    const locationQuery = `
      SELECT
        bo.booth_uid AS "boothUid",
        s.id AS "slotId",
        s.slot_identifier AS "slotIdentifier",
        s.charge_level_percent AS "lastKnownChargeLevel",
        'deposited' AS "sessionStatus" -- The status is implicitly 'deposited' if found
      FROM batteries bat
      JOIN booth_slots s ON bat.id = s.current_battery_id
      JOIN booths bo ON s.booth_id = bo.id
      WHERE bat.user_id = $1
        AND s.status = 'occupied'
      LIMIT 1;
    `;
    const locationResult = await client.query(locationQuery, [firebaseUid]);

    if (locationResult.rows.length === 0) {
      // Instead of a 404, return a 200 with a null body.
      // This indicates a successful lookup with no result, which is not an error.
      return res.status(200).json(null);
    }

    const { boothUid, slotId, slotIdentifier, lastKnownChargeLevel, sessionStatus } = locationResult.rows[0];

    // 2. Fetch the latest, real-time data from Firebase.
    const db = getDatabase();
    const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
    const snapshot = await slotRef.get();

    if (!snapshot.exists()) {
      logger.warn(`Data inconsistency: Battery for user ${firebaseUid} is in PG for slot ${boothUid}/${slotIdentifier}, but slot does not exist in Firebase.`);
      // Return last known data from DB in this edge case.
      return res.status(200).json({ boothUid, slotIdentifier, chargeLevel: lastKnownChargeLevel, sessionStatus, telemetry: null });
    }

    const firebaseData = snapshot.val();
    const realTimeCharge = firebaseData.soc || 0;
    const realTimeTelemetry = firebaseData.telemetry || null;

    // 3. (Fire-and-forget) Update our database with the fresh data. No need to wait for this.
    client.query(
      'UPDATE booth_slots SET charge_level_percent = $1, telemetry = $2, updated_at = NOW() WHERE id = $3',
      [realTimeCharge, realTimeTelemetry, slotId]
    ).catch(err => logger.error(`Failed to background-update slot ${slotId} with Firebase data:`, err));

    // 4. Return the fresh, real-time data to the user.
    res.status(200).json({
      boothUid, slotIdentifier, chargeLevel: realTimeCharge, sessionStatus, telemetry: realTimeTelemetry
    });
  } catch (error) {
    logger.error(`Failed to get battery status for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve battery status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/initiate-withdrawal
 * Called by a user's app to start the collection of their charged battery.
 */
router.post('/initiate-withdrawal', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid, phone_number: userPhone } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Pre-check for existing sessions ---
    // Check if the user already has a pending deposit or withdrawal.
    const existingSessionRes = await client.query(
      `SELECT 1 FROM deposits WHERE user_id = $1 AND status IN ('pending', 'in_progress')`,
      [firebaseUid]
    );
    if (existingSessionRes.rows.length > 0) {
      await client.query('ROLLBACK'); // End the transaction before releasing
      return res.status(409).json({
        error: 'Active session exists.',
        message: 'You already have an active session. Please complete or cancel it before starting a new withdrawal.'
      });
    }
    // --- End of Pre-check ---

    // 1. Find the user's battery and its location
    const batteryQuery = `
      SELECT
        -- Use the real-time charge level from the slot, not the stale one from the batteries table.
        s.charge_level_percent AS "chargeLevel",
        last_deposit.completed_at AS "depositCompletedAt",
        bat.id AS "batteryId", -- Get the battery ID
        last_deposit.initial_charge_level AS "initialCharge",
        s.id AS "slotId",
        s.slot_identifier AS "slotIdentifier",
        bo.id AS "boothId",
        bo.booth_uid AS "boothUid"
      FROM deposits d
      JOIN booth_slots s ON d.slot_id = s.id
      JOIN batteries bat ON s.current_battery_id = bat.id
      JOIN booths bo ON s.booth_id = bo.id
      -- Use a LATERAL JOIN to reliably find the single, most recent completed deposit for this user.
      CROSS JOIN LATERAL (
        SELECT dep.completed_at, dep.initial_charge_level
        FROM deposits AS dep
        WHERE dep.user_id = d.user_id AND dep.session_type = 'deposit' AND dep.status = 'completed'
        ORDER BY dep.completed_at DESC LIMIT 1
      ) AS last_deposit
      WHERE bat.user_id = $1 AND s.status = 'occupied'
    `;
    const batteryRes = await client.query(batteryQuery, [firebaseUid]);
    

    if (batteryRes.rows.length === 0) {
      throw new Error('You do not have a battery currently deposited.');
    }
    const { chargeLevel: dbChargeLevel, initialCharge, batteryId, depositCompletedAt, slotId, slotIdentifier, boothId, boothUid } = batteryRes.rows[0];

    // --- Real-time Data Fetch ---
    // Fetch the most current SOC directly from Firebase to ensure accurate pricing.
    const db = getDatabase();
    const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
    const snapshot = await slotRef.get();

    let chargeLevel = dbChargeLevel; // Fallback to DB value
    if (snapshot.exists() && snapshot.val().telemetry) {
      chargeLevel = snapshot.val().telemetry.soc || chargeLevel;
    }
    // --- End of Real-time Fetch ---

    // 2. Calculate the cost
    const settingsRes = await client.query("SELECT value FROM app_settings WHERE key = 'pricing'");
    if (settingsRes.rows.length === 0) {
      throw new Error('Pricing settings are not configured in the database.');
    }
    const pricingRules = settingsRes.rows[0].value;
    const baseSwapFee = pricingRules.base_swap_fee;
    const costPerChargePercent = pricingRules.cost_per_charge_percent;
    const overtimePenaltyPerMin = pricingRules.overtime_penalty_per_minute;
    const gracePeriodMinutes = pricingRules.grace_period_minutes || 0; // Default to 0 if not set

    if (baseSwapFee === undefined || costPerChargePercent === undefined) {
      throw new Error('Incomplete pricing settings. `base_swap_fee` and `cost_per_charge_percent` are required.');
    }

    // 3. Calculate duration and energy delivered
    const chargeDurationMs = new Date() - new Date(depositCompletedAt);
    const chargeDurationMinutes = Math.round(chargeDurationMs / 60000);
    const chargeAdded = Math.max(0, parseFloat(chargeLevel) - parseFloat(initialCharge));
    
    // 4. Calculate the cost based on the minimum fee logic.
    const chargeComponent = chargeAdded * parseFloat(costPerChargePercent || 0);
    // The cost is the greater of the base fee or the calculated charging cost.
    const totalCost = parseFloat(Math.max(baseSwapFee, chargeComponent).toFixed(2));

    // 5. Create a withdrawal session record with the calculated cost.
    const sessionRes = await client.query(
      "INSERT INTO deposits (user_id, booth_id, slot_id, battery_id, session_type, status, amount, initial_charge_level) VALUES ($1, $2, $3, $4, 'withdrawal', 'pending', $5, $6) RETURNING id",
      [firebaseUid, boothId, slotId, batteryId, totalCost, chargeLevel]
    );
    const sessionId = sessionRes.rows[0].id;

    // 5. Send command to Firebase to stop charging immediately.
    // This freezes the charge level at the point of cost calculation.
    // The door will only be unlocked after payment is confirmed.
    // const db = getDatabase(); // db is already defined above
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update({ stopCharging: true, startCharging: false });


    logger.info(`Sent 'stopCharging' command to ${slotIdentifier} at booth ${boothUid} upon withdrawal initiation for session ${sessionId}.`);

    await client.query('COMMIT');

    // 7. Return the session ID and the calculated amount to the frontend.
    // The STK push is NOT initiated here; it happens when the user confirms payment.
    res.status(200).json({
      message: 'Withdrawal session created. Please confirm cost before payment.',
      sessionId: sessionId,
      amount: totalCost,
      durationMinutes: chargeDurationMinutes,
      costPerChargePercent: parseFloat(costPerChargePercent),
      soc: parseFloat(chargeAdded),
      initialCharge: parseFloat(initialCharge),
      depositCompletedAt: depositCompletedAt
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('Error initiating withdrawal:', error);
    logger.error(`Failed to initiate withdrawal for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to initiate withdrawal.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/sessions/:sessionId/pay
 * @summary Trigger payment for a withdrawal session
 * @description Finds a pending withdrawal session and initiates an M-Pesa STK push for the pre-calculated amount.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: sessionId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The ID of the pending withdrawal session.
 * @responses
 *   200:
 *     description: STK push initiated successfully.
 *   404:
 *     description: Pending session not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/sessions/:sessionId/pay', verifyFirebaseToken, async (req, res) => {
  const { sessionId } = req.params;
  const { uid: firebaseUid, phone_number: userPhone } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the pending withdrawal session for this user.
    // Allow retrying payment if the previous attempt failed.
    const sessionRes = await client.query(
      "SELECT amount FROM deposits WHERE id = $1 AND user_id = $2 AND session_type = 'withdrawal' AND status IN ('pending', 'failed')",
      [sessionId, firebaseUid]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'No active withdrawal session found to pay for.' });
    }
    const amount = sessionRes.rows[0].amount;

    // 2. Initiate the M-Pesa STK Push.
    const mpesaResponse = await initiateSTKPush({
      phone: userPhone,
      amount: amount,
      accountReference: `session_${sessionId}`, // A reference for the transaction
      transactionDesc: `Payment for battery charging session ${sessionId}`
    });

    const checkoutRequestId = mpesaResponse.data.CheckoutRequestID;

    // 3. Update the session record with the new CheckoutRequestID from M-Pesa.
    // Reset the status to 'pending' in case it was 'failed'.
    // Also, reset the started_at timestamp to restart the self-healing timer.
    await client.query(
      "UPDATE deposits SET mpesa_checkout_id = $1, status = 'pending', started_at = NOW() WHERE id = $2",
      [checkoutRequestId, sessionId]);

    await client.query('COMMIT');

    res.status(200).json({
      message: 'STK push sent. Please complete the payment on your phone.',
      checkoutRequestId: checkoutRequestId,
    });
    console.log(`STK push initiated for session ${sessionId}, CheckoutRequestID: ${checkoutRequestId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    // Improved error logging for external API calls
    if (error.isAxiosError) {
      // Log more detailed info if it's an Axios error (from M-Pesa call)
      const errorDetails = { request: error.config, response: error.response?.data };
      console.log('M-Pesa API error details:', errorDetails);
      logger.error(`Failed to trigger payment for session ${sessionId} due to an M-Pesa API error:`, errorDetails);
    } else {
      logger.error(`Failed to trigger payment for session ${sessionId}:`, error);
    }
    res.status(500).json({ error: 'Failed to trigger payment.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/sessions/pending-withdrawal
 * @summary Get details of a user's pending withdrawal session
 * @description Checks if the logged-in user has a withdrawal session in 'pending' state and returns its details.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: Details of the pending withdrawal session.
 *   204:
 *     description: No pending withdrawal session found.
 *   500:
 *     description: Internal server error.
 */
router.get('/sessions/pending-withdrawal', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
        SELECT
            d.id AS "sessionId",
            s.charge_level_percent AS "chargeLevel",
            b.booth_uid AS "boothUid",
            s.slot_identifier AS "slotIdentifier", dep.initial_charge_level AS "initialCharge",
            dep.completed_at AS "depositCompletedAt"
        FROM deposits d
        JOIN booth_slots s ON d.slot_id = s.id
        JOIN booths b ON s.booth_id = b.id
        -- Find the user's most recent completed deposit that happened *before* this withdrawal was created.
        CROSS JOIN LATERAL (
            SELECT initial_charge_level, completed_at
            FROM deposits
            WHERE user_id = d.user_id AND session_type = 'deposit' AND status = 'completed' AND completed_at < d.created_at
            ORDER BY completed_at DESC
            LIMIT 1
        ) AS dep
        WHERE d.user_id = $1 AND d.session_type = 'withdrawal' AND d.status = 'pending'
        ORDER BY d.created_at DESC
        LIMIT 1;
    `;
    const { rows } = await client.query(query, [firebaseUid]);

    if (rows.length === 0) {
      return res.status(204).send();
    }

    const session = rows[0];

    // --- Real-time Data Fetch ---
    // Fetch the most current SOC directly from Firebase to ensure accurate pricing.
    const db = getDatabase();
    const slotRef = db.ref(`booths/${session.boothUid}/slots/${session.slotIdentifier}`);
    const snapshot = await slotRef.get();

    let realTimeSoc = session.chargeLevel; // Fallback to DB value
    if (snapshot.exists() && snapshot.val().telemetry) {
      realTimeSoc = snapshot.val().telemetry.soc || realTimeSoc;
    }
    // --- End of Real-time Fetch ---

    // Re-calculate the cost on the fly, just like in initiate-withdrawal
    const settingsRes = await client.query("SELECT value FROM app_settings WHERE key = 'pricing'");
    if (settingsRes.rows.length === 0) {
      throw new Error('Pricing settings are not configured in the database.');
    }
    const pricingRules = settingsRes.rows[0].value;
    console.log('Pricing rules fetched for pending withdrawal cost recalculation:', pricingRules);
    const baseSwapFee = pricingRules.base_swap_fee || 0;
    console.log('Base swap fee:', baseSwapFee);
    const costPerChargePercent = pricingRules.cost_per_charge_percent || 0;
    console.log('Cost per charge percent:', costPerChargePercent);

    // Calculate duration and energy delivered

    const chargeDurationMs = new Date() - new Date(session.depositCompletedAt);
    const chargeDurationMinutes = Math.round(chargeDurationMs / 60000);
    const chargeAdded = Math.max(0, parseFloat(realTimeSoc) - parseFloat(session.initialCharge));

    const chargingCost = chargeAdded * parseFloat(costPerChargePercent || 0);
    const totalCost = parseFloat(Math.max(baseSwapFee, chargingCost).toFixed(2));

    // Update the amount in the database for the eventual payment.
    // This is a "fire-and-forget" update; we don't need to wait for it.
    client.query("UPDATE deposits SET amount = $1 WHERE id = $2", [totalCost, session.sessionId])
      .catch(err => logger.error(`Failed to background-update amount for session ${session.sessionId}:`, err));

    res.status(200).json({
      sessionId: session.sessionId,
      amount: totalCost,
      durationMinutes: chargeDurationMinutes,
      pricingRules: pricingRules,
      baseSwapFee: parseFloat(baseSwapFee),
      costPerChargePercent: parseFloat(costPerChargePercent),
      soc: parseFloat(chargeAdded),
      initialCharge: parseFloat(session.initialCharge),
      depositCompletedAt: session.depositCompletedAt
    });
  } catch (error) {
    logger.error(`Failed to get pending withdrawal session for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve pending session.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * A reusable function to complete a paid withdrawal session.
 * It updates the database and sends the command to Firebase to open the slot.
 * This prevents code duplication between the M-Pesa callback and self-healing logic.
 * @param {object} client - The PostgreSQL client.
 * @param {string} checkoutRequestId - The M-Pesa checkout request ID.
 * @returns {Promise<boolean>} - True if the session was successfully updated, false otherwise.
 */
async function completePaidWithdrawal(client, checkoutRequestId) {
  // Atomically update the status from 'pending' to 'in_progress'.
  // This prevents race conditions with the M-Pesa callback.
  const updateResult = await client.query(
    `UPDATE deposits d
     SET status = 'in_progress'
     FROM booth_slots s, booths b -- Joins to get the UIDs for the Firebase command
     WHERE d.mpesa_checkout_id = $1
       AND d.status = 'pending' -- This is the crucial part for idempotency
       AND d.slot_id = s.id
       AND s.booth_id = b.id
     RETURNING b.booth_uid, s.slot_identifier;`,
    [checkoutRequestId]
  );

  if (updateResult.rowCount > 0) {
    // The session was successfully moved from 'pending' to 'in_progress'. Now send the command.
    const { booth_uid: boothUid, slot_identifier: slotIdentifier } = updateResult.rows[0];
    const db = getDatabase();
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    // Per IoT spec, stop charging before opening the door for collection.
    await commandRef.update({
      stopCharging: true,
      startCharging: false, // Ensure mutual exclusivity
      openForCollection: true,
      openForDeposit: false, // Ensure mutual exclusivity
      // forceUnlock: false,
      // forceLock: false
    });

    logger.info(`Sent 'stopCharging' and 'openForCollection' commands to ${slotIdentifier} at booth ${boothUid} for checkout ID ${checkoutRequestId}.`);
    return true;
  }
  // If rowCount is 0, it means the session was NOT in 'pending' status.
  // This could be because it was already processed, or it was cancelled/failed due to a hardware ACK.
  return false;
}

/**
 * GET /api/booths/withdrawal-status/:checkoutRequestId
 * @summary Poll for withdrawal payment status
 * Called by the frontend to poll for the status of a withdrawal payment.
 */
router.get('/withdrawal-status/:checkoutRequestId', verifyFirebaseToken, async (req, res) => {
  const { checkoutRequestId } = req.params;
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // Find the session and check its status.
    // The M-Pesa callback would have updated the status to 'in_progress' upon successful payment.
    const sessionQuery = await client.query(
      "SELECT id, status, started_at FROM deposits WHERE mpesa_checkout_id = $1 AND user_id = $2 AND session_type = 'withdrawal'",
      [checkoutRequestId, firebaseUid]
    );

    if (sessionQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal session not found.' });
    }

    const { id: sessionId, status, started_at: startedAt } = sessionQuery.rows[0];

    // If status is not pending, the callback has already been processed. Return immediately.
    if (status !== 'pending') {
      const paymentStatus = (status === 'in_progress' || status === 'completed') ? 'paid' : status;
      return res.status(200).json({ paymentStatus });
    }

    // --- Self-Healing Logic for Stuck Pending Transactions ---
    const PENDING_TIMEOUT_SECONDS = parseInt(process.env.MPESA_PENDING_TIMEOUT_SECONDS, 10) || 45;
    const secondsSinceStart = (new Date() - new Date(startedAt)) / 1000;

    // If it has been pending for less than the timeout, just tell the client to keep polling.
    if (secondsSinceStart < PENDING_TIMEOUT_SECONDS) {
      return res.status(200).json({ paymentStatus: 'pending' });
    }

    try {
      // If the timeout is reached, proactively query M-Pesa for the transaction status.
      logger.info(`Session ${sessionId} is stuck in pending. Proactively querying M-Pesa status for ${checkoutRequestId}...`);
      const mpesaStatusResponse = await querySTKStatus(checkoutRequestId);
      const { ResultCode, ResultDesc } = mpesaStatusResponse.data;

      if (ResultCode === '0') {
        // The payment was successful. Manually trigger the same logic as the callback.
        logger.info(`M-Pesa query confirmed payment for ${checkoutRequestId}. Manually completing session.`);
        await completePaidWithdrawal(client, checkoutRequestId);
        return res.status(200).json({ paymentStatus: 'paid' });
      } else {
        // The payment failed or is still processing according to M-Pesa. Mark it as failed to stop polling.
        logger.warn(`M-Pesa query for ${checkoutRequestId} indicates failure: ${ResultDesc}. Marking session as failed.`);
        await client.query("UPDATE deposits SET status = 'failed' WHERE id = $1 AND status = 'pending'", [sessionId]);
        return res.status(200).json({ paymentStatus: 'failed', reason: ResultDesc });
      }
    } catch (mpesaError) {
      logger.error(`Self-healing failed to query M-Pesa for ${checkoutRequestId}:`, mpesaError.response?.data || mpesaError.message);
      // Don't fail the session; just tell the client to keep trying.
      return res.status(200).json({ paymentStatus: 'pending' });
    }

  } catch (error) {
    logger.error(`Failed to get withdrawal status for checkoutId ${checkoutRequestId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve withdrawal status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/cancel-session
 * @summary Cancel any active user session
 * @description Allows a user to cancel their own active session (e.g., 'pending', 'in_progress', 'opening'). This will free up the reserved slot and reset its state, making it available for another user.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: Session cancelled successfully.
 *   404:
 *     description: No active session found to cancel.
 *   500:
 *     description: Internal server error.
 */
router.post('/cancel-session', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the user's active (non-terminal) session.
    const sessionQuery = `
      SELECT
        d.id,
        d.session_type,
        d.status,
        d.slot_id,
        s.slot_identifier,
        b.booth_uid
      FROM deposits d
      JOIN booth_slots s ON d.slot_id = s.id
      JOIN booths b ON d.booth_id = b.id
      WHERE d.user_id = $1 AND d.status IN ('pending', 'in_progress', 'opening')
      LIMIT 1;
    `;
    const sessionRes = await client.query(sessionQuery, [firebaseUid]);

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'No active session found to cancel.' });
    }

    const { id: sessionId, session_type: sessionType, status: sessionStatus, slot_id: slotId, slot_identifier: slotIdentifier, booth_uid: boothUid } = sessionRes.rows[0];

    // 2. Add specific logic to prevent cancelling a paid withdrawal.
    if (sessionType === 'withdrawal' && sessionStatus === 'in_progress') {
      await client.query('ROLLBACK'); // No changes needed, so end the transaction.
      return res.status(409).json({
        error: 'Cannot cancel a paid session.',
        message: 'This withdrawal has already been paid for. Please collect your battery from the slot.'
      });
    }

    // 3. Mark the session as 'cancelled' in the database.
    await client.query("UPDATE deposits SET status = 'cancelled' WHERE id = $1", [sessionId]);

    // 3. The slot was reserved for the session. We need to free it and reset its state.
    // This applies to both deposits and withdrawals that have reserved a slot.
    await client.query("UPDATE booth_slots SET status = 'available' WHERE id = $1", [slotId]);

    // 4. Send a command to Firebase to ensure any door opening commands are cancelled.
    // This resets the command state for the slot.
    const db = getDatabase();
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update({
      openForDeposit: false,
      openForCollection: false
    });

    logger.info(`User ${firebaseUid} cancelled session ${sessionId} (type: ${sessionType}). Slot ${slotIdentifier} at booth ${boothUid} is now available.`);

    await client.query('COMMIT');
    res.status(200).json({ message: 'Your session has been successfully cancelled.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to cancel session for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to cancel session.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/history
 * Retrieves the deposit and withdrawal history for the logged-in user.
 */
router.get('/history', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        d.session_type AS "sessionType",
        d.status,
        d.started_at AS "startedAt",
        d.completed_at AS "completedAt",
        bo.booth_uid AS "boothUid",
        s.slot_identifier AS "slotIdentifier",
        bat.battery_uid AS "batteryUid"
      FROM deposits d
      LEFT JOIN booths bo ON d.booth_id = bo.id
      LEFT JOIN booth_slots s ON d.slot_id = s.id
      LEFT JOIN batteries bat ON d.battery_id = bat.id
      WHERE d.user_id = $1
      ORDER BY d.started_at DESC
      LIMIT 50;
    `;
    const result = await client.query(query, [firebaseUid]);

    res.status(200).json(result.rows);
  } catch (error) {
    logger.error(`Failed to get history for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve transaction history.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/report-problem
 * Allows a logged-in user to report an issue with a battery or a booth slot.
 */
router.post('/report-problem', verifyFirebaseToken, async (req, res) => {
  const FAULT_REPORT_THRESHOLD = 3; // Number of reports to trigger a 'faulty' status
  const FAULT_REPORT_WINDOW_DAYS = 30; // Time window in days to consider reports

  const { uid: firebaseUid } = req.user;
  const { batteryUid, boothUid, slotIdentifier, description } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'A description of the problem is required.' });
  }

  if (!batteryUid && !boothUid) {
    return res.status(400).json({ error: 'Either batteryUid or boothUid must be provided.' });
  }

  if (boothUid && !slotIdentifier) {
    return res.status(400).json({ error: 'If reporting a booth issue, slotIdentifier is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let batteryId = null;
    let boothId = null;
    let slotId = null;
    let reportType = 'general_feedback';

    if (batteryUid) {
      const batteryRes = await client.query('SELECT id FROM batteries WHERE battery_uid = $1', [batteryUid]);
      if (batteryRes.rows.length > 0) {
        batteryId = batteryRes.rows[0].id;
        reportType = 'battery_issue';
      } else {
        logger.warn(`User ${firebaseUid} tried to report a problem for a non-existent battery: ${batteryUid}`);
      }
    }

    if (boothUid && slotIdentifier) {
      const slotRes = await client.query(
        `SELECT s.id as "slotId", s.booth_id as "boothId" FROM booth_slots s
         JOIN booths b ON s.booth_id = b.id
         WHERE b.booth_uid = $1 AND s.slot_identifier = $2`,
        [boothUid, slotIdentifier]
      );
      if (slotRes.rows.length > 0) {
        slotId = slotRes.rows[0].slotId;
        boothId = slotRes.rows[0].boothId;
        reportType = 'slot_issue';
      } else {
        logger.warn(`User ${firebaseUid} tried to report a problem for a non-existent slot: ${boothUid}/${slotIdentifier}`);
      }
    }

    const insertQuery = `
      INSERT INTO problem_reports (user_id, battery_id, booth_id, slot_id, report_type, description)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await client.query(insertQuery, [firebaseUid, batteryId, boothId, slotId, reportType, description]);

    // --- Automatic Fault Detection Logic ---
    const checkAndFlagQuery = `
      SELECT COUNT(*) FROM problem_reports
      WHERE status = 'open'
      AND created_at >= NOW() - INTERVAL '${FAULT_REPORT_WINDOW_DAYS} days'
      AND (battery_id = $1 OR slot_id = $2)
    `;

    if (reportType === 'battery_issue' && batteryId) {
      const { rows } = await client.query(checkAndFlagQuery, [batteryId, null]);
      const reportCount = parseInt(rows[0].count, 10);

      if (reportCount >= FAULT_REPORT_THRESHOLD) {
        await client.query("UPDATE batteries SET health_status = 'faulty' WHERE id = $1", [batteryId]);
        logger.warn(`Battery ID ${batteryId} (UID: ${batteryUid}) automatically flagged as 'faulty' due to ${reportCount} reports.`);
      }
    } else if (reportType === 'slot_issue' && slotId) {
      const { rows } = await client.query(checkAndFlagQuery, [null, slotId]);
      const reportCount = parseInt(rows[0].count, 10);

      if (reportCount >= FAULT_REPORT_THRESHOLD) {
        await client.query("UPDATE booth_slots SET status = 'faulty' WHERE id = $1", [slotId]);
        logger.warn(`Slot ID ${slotId} (${boothUid}/${slotIdentifier}) automatically flagged as 'faulty' due to ${reportCount} reports.`);
      }
    }

    await client.query('COMMIT');

    logger.info(`New problem report submitted by user ${firebaseUid}.`);
    res.status(201).json({ message: 'Your problem report has been submitted successfully. Thank you!' });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to create problem report for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to submit problem report.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;