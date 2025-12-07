const { Router } = require('express');
const logger = require('../utils/logger');
const poolPromise = require('../db');
const { verifyFirebaseToken } = require('../middleware/auth');
const verifyApiKey = require('../middleware/verifyApiKey');
const mpesaApi = require('../utils/mpesa'); // Import your M-Pesa utility

const router = Router();

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

    // 1. Find the booth's internal ID from its public UID
    const boothRes = await client.query('SELECT id FROM booths WHERE booth_uid = $1 AND status = \'online\'', [boothUid]);
    if (boothRes.rows.length === 0) {
      throw new Error(`Booth ${boothUid} is not online or does not exist.`);
    }
    const boothId = boothRes.rows[0].id;

    // 2. Find an available, empty slot in that booth
    const slotRes = await client.query(
      "SELECT id, slot_identifier FROM booth_slots WHERE booth_id = $1 AND status = 'available' LIMIT 1",
      [boothId]
    );
    if (slotRes.rows.length === 0) {
      throw new Error('No available slots for deposit at this booth.');
    }
    const { id: slotId, slot_identifier: slotIdentifier } = slotRes.rows[0];

    // 3. Create a 'deposits' record to track this session
    await client.query(
      "INSERT INTO deposits (user_id, booth_id, slot_id, session_type, status) VALUES ($1, $2, $3, 'deposit', 'pending')",
      [firebaseUid, boothId, slotId]
    );

    // 4. Mark the slot as 'opening' to reserve it
    await client.query("UPDATE booth_slots SET status = 'opening' WHERE id = $1", [slotId]);

    await client.query('COMMIT');

    logger.info(`(Hardware Simulation) Unlocking slot '${slotIdentifier}' at booth '${boothUid}' for user '${firebaseUid}'.`);
    logger.info(`Deposit session initiated for user '${firebaseUid}' at booth '${boothUid}', slot '${slotIdentifier}'.`);

    res.status(200).json({
      message: 'Slot allocated. Please deposit your battery.',
      boothUid: boothUid,
      slotIdentifier: slotIdentifier,
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
 * POST /api/booths/confirm-deposit
 * Called by the BOOTH HARDWARE after a battery is deposited and the door closes.
 * This finalizes the deposit, linking the battery to the user and slot.
 */
router.post('/confirm-deposit', verifyApiKey, async (req, res) => {
  const { boothUid, slotIdentifier, batteryUid, chargeLevel } = req.body;

  if (!boothUid || !slotIdentifier || !batteryUid || chargeLevel === undefined) {
    return res.status(400).json({ error: 'boothUid, slotIdentifier, batteryUid, and chargeLevel are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the pending deposit session for this user and slot
    const depositRes = await client.query(
      `SELECT d.id, d.user_id FROM deposits d
       JOIN booths b ON d.booth_id = b.id
       JOIN booth_slots s ON d.slot_id = s.id
       WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.status = 'pending'
       ORDER BY d.created_at DESC LIMIT 1`,
      [boothUid, slotIdentifier]
    );

    if (depositRes.rows.length === 0) {
      throw new Error(`No pending deposit found for booth '${boothUid}', slot '${slotIdentifier}'.`);
    }
    const { id: depositId, user_id: firebaseUid } = depositRes.rows[0];

    // 2. Find the battery's internal ID
    const batteryRes = await client.query('SELECT id FROM batteries WHERE battery_uid = $1', [batteryUid]);
    if (batteryRes.rows.length === 0) {
      throw new Error(`Battery with UID ${batteryUid} not found in the system.`);
    }
    const batteryId = batteryRes.rows[0].id;

    // 3. Update the battery to link it to the user
    await client.query('UPDATE batteries SET user_id = $1 WHERE id = $2', [firebaseUid, batteryId]);

    // 4. Update the slot to show it's occupied by this battery
    await client.query(
      "UPDATE booth_slots SET status = 'occupied', current_battery_id = $1 WHERE slot_identifier = $2 AND booth_id = (SELECT id FROM booths WHERE booth_uid = $3)",
      [batteryId, slotIdentifier, boothUid]
    );

    // 5. Mark the deposit session as completed
    await client.query(
      "UPDATE deposits SET status = 'completed', battery_id = $1, initial_charge_level = $2, completed_at = NOW() WHERE id = $3",
      [batteryId, chargeLevel, depositId]
    );

    await client.query('COMMIT');
    logger.info(`Deposit confirmed for user '${firebaseUid}' with battery '${batteryUid}' in slot '${slotIdentifier}' at booth '${boothUid}'.`);
    res.status(200).json({ success: true, message: 'Deposit confirmed.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to confirm deposit for slot '${slotIdentifier}' at booth '${boothUid}':`, error);
    res.status(500).json({ error: 'Failed to confirm deposit.', details: error.message });
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
    const query = `
      SELECT
        b.battery_uid AS "batteryUid",
        b.charge_level_percent AS "chargeLevel",
        bo.booth_uid AS "boothUid",
        s.slot_identifier AS "slotIdentifier"
      FROM batteries b
      JOIN booth_slots s ON b.id = s.current_battery_id
      JOIN booths bo ON s.booth_id = bo.id
      WHERE b.user_id = $1 AND s.status = 'occupied'
    `;
    const result = await client.query(query, [firebaseUid]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No battery currently deposited.' });
    }

    res.status(200).json(result.rows[0]);
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
  const MIN_CHARGE_LEVEL = 95;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the user's battery and its location
    const batteryQuery = `
      SELECT
        b.id AS "batteryId",
        b.charge_level_percent AS "chargeLevel",
        d.initial_charge_level AS "initialCharge",
        s.id AS "slotId",
        s.slot_identifier AS "slotIdentifier",
        bo.id AS "boothId",
        bo.booth_uid AS "boothUid"
      FROM batteries b
      JOIN booth_slots s ON b.id = s.current_battery_id
      JOIN booths bo ON s.booth_id = bo.id
      JOIN deposits d ON b.id = d.battery_id AND d.session_type = 'deposit' AND d.status = 'completed'
      WHERE b.user_id = $1 AND s.status = 'occupied'
      ORDER BY d.completed_at DESC LIMIT 1
    `;
    const batteryRes = await client.query(batteryQuery, [firebaseUid]);

    if (batteryRes.rows.length === 0) {
      throw new Error('You do not have a battery currently deposited.');
    }
    const { batteryId, chargeLevel, initialCharge, slotId, slotIdentifier, boothId, boothUid } = batteryRes.rows[0];

    // 2. Check if the battery is sufficiently charged
    if (chargeLevel < MIN_CHARGE_LEVEL) {
      throw new Error(`Your battery is still charging. Current level: ${chargeLevel}%. Please wait until it is at least ${MIN_CHARGE_LEVEL}%.`);
    }

    // 3. Calculate the cost
    const settingsRes = await client.query("SELECT value FROM app_settings WHERE key = 'pricing'");
    if (settingsRes.rows.length === 0) {
      throw new Error('Pricing settings are not configured in the database.');
    }
    const pricing = settingsRes.rows[0].value;
    const { base_swap_fee, cost_per_charge_percent } = pricing;

    if (base_swap_fee === undefined || cost_per_charge_percent === undefined) {
      throw new Error('Incomplete pricing settings. `base_swap_fee` and `cost_per_charge_percent` are required.');
    }

    const chargeAdded = Math.max(0, chargeLevel - initialCharge);
    const totalCost = parseFloat(base_swap_fee) + (chargeAdded * parseFloat(cost_per_charge_percent));

    // 4. Create a withdrawal session record first to get a unique session ID
    const sessionRes = await client.query(
      "INSERT INTO deposits (user_id, booth_id, slot_id, battery_id, session_type, status) VALUES ($1, $2, $3, $4, 'withdrawal', 'pending') RETURNING id",
      [firebaseUid, boothId, slotId, batteryId]
    );
    const sessionId = sessionRes.rows[0].id;

    // 5. Initiate the actual M-Pesa STK Push
    const mpesaResponse = await mpesaApi.initiateStkPush({
      userPhone,
      amount: totalCost,
      accountReference: `session_${sessionId}`, // A reference for the transaction
      transactionDesc: `Payment for battery charging session ${sessionId}`
    });

    const checkoutRequestId = mpesaResponse.CheckoutRequestID;

    // 6. Update the session record with the CheckoutRequestID from M-Pesa
    await client.query("UPDATE deposits SET mpesa_checkout_id = $1 WHERE id = $2", [checkoutRequestId, sessionId]);

    await client.query('COMMIT');

    res.status(200).json({
      message: 'Please complete the payment on your phone to proceed.',
      checkoutRequestId: checkoutRequestId,
      amount: totalCost,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to initiate withdrawal for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to initiate withdrawal.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/withdrawal-status/:checkoutRequestId
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
    const result = await client.query(
      "SELECT status FROM deposits WHERE mpesa_checkout_id = $1 AND user_id = $2 AND session_type = 'withdrawal'",
      [checkoutRequestId, firebaseUid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal session not found.' });
    }

    const status = result.rows[0].status;
    if (status === 'in_progress') { // 'in_progress' means paid, ready to open
      res.status(200).json({ paymentStatus: 'paid' });
    } else {
      res.status(200).json({ paymentStatus: 'pending' });
    }
  } catch (error) {
    logger.error(`Failed to get withdrawal status for checkoutId ${checkoutRequestId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve withdrawal status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/open-for-collection
 * Called by the frontend AFTER payment is confirmed. This is the final step
 * that tells the hardware to open the slot.
 */
router.post('/open-for-collection', verifyFirebaseToken, async (req, res) => {
  const { checkoutRequestId } = req.body;
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the paid, but not yet opened, session
    const sessionRes = await client.query(
      `SELECT d.id, d.slot_id, s.slot_identifier, b.booth_uid FROM deposits d
       JOIN booth_slots s ON d.slot_id = s.id
       JOIN booths b ON d.booth_id = b.id
       WHERE d.mpesa_checkout_id = $1 AND d.user_id = $2 AND d.status = 'in_progress'`,
      [checkoutRequestId, firebaseUid]
    );

    if (sessionRes.rows.length === 0) {
      throw new Error('Withdrawal session not found or payment not confirmed.');
    }
    const { slot_id: slotId, slot_identifier: slotIdentifier, booth_uid: boothUid } = sessionRes.rows[0];

    // 2. Mark the slot as 'opening'
    await client.query("UPDATE booth_slots SET status = 'opening' WHERE id = $1", [slotId]);

    await client.query('COMMIT');

    logger.info(`(Hardware Simulation) Unlocking slot '${slotIdentifier}' at booth '${boothUid}' for user '${firebaseUid}' to collect their battery.`);
    res.status(200).json({ message: 'Your battery is ready for collection. The slot will now open.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to open slot for collection for checkoutId ${checkoutRequestId}:`, error);
    res.status(500).json({ error: 'Failed to open slot.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/confirm-withdrawal
 * Called by the BOOTH HARDWARE after a battery is collected and the door closes.
 */
router.post('/confirm-withdrawal', verifyApiKey, async (req, res) => {
  const { boothUid, slotIdentifier } = req.body;

  if (!boothUid || !slotIdentifier) {
    return res.status(400).json({ error: 'boothUid and slotIdentifier are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the pending withdrawal session
    const sessionRes = await client.query(
      `SELECT d.id, d.slot_id FROM deposits d
       JOIN booths b ON d.booth_id = b.id
       JOIN booth_slots s ON d.slot_id = s.id
       WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.session_type = 'withdrawal' AND d.status = 'pending'
       ORDER BY d.created_at DESC LIMIT 1`,
      [boothUid, slotIdentifier]
    );

    if (sessionRes.rows.length === 0) {
      throw new Error(`No pending withdrawal found for booth '${boothUid}', slot '${slotIdentifier}'.`);
    }
    const { id: sessionId, slot_id: slotId } = sessionRes.rows[0];

    // 2. Mark the session as completed
    await client.query("UPDATE deposits SET status = 'completed', completed_at = NOW() WHERE id = $1", [sessionId]);

    // 3. Free up the slot
    await client.query("UPDATE booth_slots SET status = 'available', current_battery_id = NULL WHERE id = $1", [slotId]);

    await client.query('COMMIT');
    logger.info(`Withdrawal confirmed for slot '${slotIdentifier}' at booth '${boothUid}'. Slot is now available.`);
    res.status(200).json({ success: true, message: 'Withdrawal confirmed.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to confirm withdrawal for slot '${slotIdentifier}' at booth '${boothUid}':`, error);
    res.status(500).json({ error: 'Failed to confirm withdrawal.', details: error.message });
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