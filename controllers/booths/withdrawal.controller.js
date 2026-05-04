const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const logger = require('../../utils/logger');
const poolPromise = require('../../db');
const { verifyFirebaseToken } = require('../../middleware/auth');
const { initiateSTKPush, querySTKStatus } = require('../../utils/mpesa');
const { completePaidWithdrawal } = require('../../utils/sessionUtils');
const {
  getEnvInt,
  extractValidSoc,
  isRelayOff,
  getWithdrawalBatteryContext,
} = require('./shared');

const router = Router();

/**
 * POST /api/booths/stop-charging
 * Allows the app to stop charging first, then wait before creating a withdrawal session.
 */
router.post('/stop-charging', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Serialize per-user actions to avoid racing with initiate-withdrawal.
    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    const existingSessionRes = await client.query(
      `
      SELECT 1
      FROM deposits
      WHERE user_id = $1
        AND status IN ('pending', 'opening', 'in_progress')
      LIMIT 1
      `,
      [firebaseUid]
    );

    if (existingSessionRes.rows.length > 0) {
      throw new Error('ACTIVE_SESSION_EXISTS');
    }

    const batteryContext = await getWithdrawalBatteryContext(client, firebaseUid);
    const {
      chargeLevel: dbChargeLevel,
      slotIdentifier,
      boothUid,
    } = batteryContext;

    const db = getDatabase();
    const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
    const snapshot = await slotRef.get();
    const slotData = snapshot.exists() && snapshot.val() ? snapshot.val() : null;

    const socAtStopRequest = extractValidSoc(slotData, dbChargeLevel);
    const relayAlreadyOff = isRelayOff(slotData);

    await slotRef.child('command').update({
      stopCharging: true,
      startCharging: false,
    });

    await client.query('COMMIT');

    const recommendedWaitSeconds = getEnvInt('WITHDRAWAL_STOP_WAIT_SECONDS', 25);
    return res.status(200).json({
      message: relayAlreadyOff
        ? 'Charging is already off. You can continue to withdrawal.'
        : 'Stop charging command sent. Wait before initiating withdrawal.',
      boothUid,
      slotIdentifier,
      socAtStopRequest: socAtStopRequest !== null ? Number(socAtStopRequest.toFixed(1)) : null,
      relayAlreadyOff,
      recommendedWaitSeconds,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'ACTIVE_SESSION_EXISTS') {
      return res.status(409).json({
        error: 'Active session exists',
        message: 'You already have an active session. Complete it before stopping charge.',
      });
    }

    if (error.message === 'NO_DEPOSITED_BATTERY') {
      return res.status(404).json({
        error: 'No deposited battery',
        message: 'You do not have a battery currently deposited.',
      });
    }

    logger.error(
      `Failed to stop charging for user ${firebaseUid}:`,
      error
    );
    return res.status(500).json({
      error: 'Failed to stop charging.',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/initiate-withdrawal
 * Called by a user's app to start the collection of their charged battery.
 */
router.post('/initiate-withdrawal', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 🔧 FIX 1: Serialize per-user requests
    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    const existingSessionRes = await client.query(
      `
      SELECT 1
      FROM deposits
      WHERE user_id = $1
        AND status IN ('pending', 'opening', 'in_progress')
      `,
      [firebaseUid]
    );

    if (existingSessionRes.rows.length > 0) {
      throw new Error('ACTIVE_SESSION_EXISTS');
    }

    /* -------------------------------------------------------
     * 1. Find user's battery & slot
     * ----------------------------------------------------- */
    const batteryContext = await getWithdrawalBatteryContext(client, firebaseUid);
    const {
      chargeLevel: dbChargeLevel,
      depositCreditId,
      depositCompletedAt,
      slotId,
      slotIdentifier,
      boothId,
      boothUid,
      initialCharge: userOriginalSoc, // This is the user's original drop-off SOC
    } = batteryContext;

    // For pricing, we need the initial charge of the battery the user is about to take, not the one they deposited.
    // We'll fetch this from the slot they are withdrawing from.
    const initialChargeRes = await client.query('SELECT initial_charge_level FROM deposits WHERE slot_id = $1 AND session_type = \'deposit\' AND status = \'completed\' ORDER BY completed_at DESC LIMIT 1', [slotId]);
    const slotInitialSoc = initialChargeRes.rows.length > 0 ? initialChargeRes.rows[0].initial_charge_level : 0;

    /* -------------------------------------------------------
     * 2. Capture final SOC after stop-charging phase
     * ----------------------------------------------------- */
    const db = getDatabase();
    const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
    const snapshot = await slotRef.get();
    const slotData = snapshot.exists() && snapshot.val() ? snapshot.val() : null;

    if (slotData && !isRelayOff(slotData)) {
      throw new Error('CHARGING_STILL_ACTIVE');
    }

    const chargeLevel = extractValidSoc(slotData, dbChargeLevel) ?? 0;

    /* -------------------------------------------------------
     * 3. Pricing
     * ----------------------------------------------------- */
    const settingsRes = await client.query(
      "SELECT value FROM app_settings WHERE key = 'pricing'"
    );

    if (settingsRes.rows.length === 0) {
      throw new Error('Pricing settings are not configured in the database.');
    }

    const pricingRules = settingsRes.rows[0].value;
    const baseSwapFee = pricingRules.base_swap_fee;
    const costPerChargePercent = pricingRules.cost_per_charge_percent;

    const chargeAddedToBattery = Math.max(
      0,
      parseFloat(chargeLevel) - parseFloat(slotInitialSoc)
    );

    const chargeComponent = chargeAddedToBattery * parseFloat(costPerChargePercent || 0);
    const totalCost = parseFloat(
      Math.max(baseSwapFee, chargeComponent).toFixed(2)
    );

    /* -------------------------------------------------------
     * 4. Create withdrawal session
     * ----------------------------------------------------- */
    const sessionRes = await client.query(
      `
      INSERT INTO deposits
        (user_id, booth_id, slot_id, session_type, status, amount, initial_charge_level, consumed_deposit_id)
      VALUES
        ($1, $2, $3, 'withdrawal', 'pending', $4, $5, $6)
      RETURNING id
      `,
      [firebaseUid, boothId, slotId, totalCost, chargeLevel, depositCreditId]
    );

    const sessionId = sessionRes.rows[0].id;

    await client.query('COMMIT');

      
    const chargeDurationMs = new Date() - new Date(depositCompletedAt);
    const chargeDurationMinutes = Math.round(chargeDurationMs / 60000);


    return res.status(200).json({
      message: 'Withdrawal session created. Please confirm cost before payment.',
      sessionId: sessionId,
      amount: totalCost,
      soc: parseFloat(chargeAddedToBattery.toFixed(1)),
      socAtWithdrawal: parseFloat(chargeLevel.toFixed(1)),
      initialCharge: parseFloat(userOriginalSoc),
      depositCompletedAt,
      durationMinutes: chargeDurationMinutes,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'ACTIVE_SESSION_EXISTS') {
      return res.status(409).json({
        error: 'Active session exists',
        message:
          'You already have an active session. Complete it before withdrawing.',
      });
    }

    if (error.message === 'NO_DEPOSITED_BATTERY') {
      return res.status(404).json({
        error: 'No deposited battery',
        message: 'You do not have a battery currently deposited.',
      });
    }

    if (error.message === 'CHARGING_STILL_ACTIVE') {
      return res.status(409).json({
        error: 'Charging still active',
        message: 'Charging is still active for this slot. Call /api/booths/stop-charging and wait before initiating withdrawal.',
      });
    }

    logger.error(
      `Failed to initiate withdrawal for user ${firebaseUid}:`,
      error
    );

    return res.status(500).json({
      error: 'Failed to initiate withdrawal.',
      details: error.message,
    });
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
/**
 * GET /api/booths/sessions/pending-withdrawal
 * @summary Get details of a user's pending withdrawal session
 * @description Returns the session details using the LOCKED amount and SOC from the database.
 */router.get('/sessions/pending-withdrawal', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    const query = `
        SELECT
            d.id AS "sessionId",
            d.amount AS "lockedAmount",
            d.initial_charge_level AS "finalSocAtWithdrawal", -- SOC when they hit withdraw
            d.created_at AS "sessionCreatedAt",
            s.charge_level_percent AS "currentLiveSoc",
            b.booth_uid AS "boothUid",
            s.slot_identifier AS "slotIdentifier",
            dep.completed_at AS "depositCompletedAt",
            dep.initial_charge_level AS "startingSocAtDeposit" -- ADDED THIS
        FROM deposits d
        JOIN booth_slots s ON d.slot_id = s.id
        JOIN booths b ON d.booth_id = b.id
        CROSS JOIN LATERAL (
            SELECT completed_at, initial_charge_level -- ADDED initial_charge_level here
            FROM deposits
            WHERE id = d.consumed_deposit_id
            LIMIT 1
        ) AS dep
        WHERE d.user_id = $1 
          AND d.session_type = 'withdrawal' 
          AND d.status = 'pending'
        ORDER BY d.created_at DESC
        LIMIT 1;
    `;
    
    const { rows } = await client.query(query, [firebaseUid]);

    if (rows.length === 0) {
      return res.status(204).send();
    }

    const session = rows[0];

    const chargeDurationMs = new Date() - new Date(session.depositCompletedAt);
    const chargeDurationMinutes = Math.round(chargeDurationMs / 60000);

    // Now startingSocAtDeposit exists, so the math won't return NaN/null
    const socGained = Math.max(0, 
      parseFloat(session.finalSocAtWithdrawal || 0) - parseFloat(session.startingSocAtDeposit || 0)
    ).toFixed(1);

    res.status(200).json({
      sessionId: session.sessionId,
      amount: parseFloat(session.lockedAmount || 0),
      durationMinutes: chargeDurationMinutes,
      soc: parseFloat(socGained),
      socAtInitiation: parseFloat(session.startingSocAtDeposit),
      socAtWithdrawal: parseFloat(session.finalSocAtWithdrawal),
      currentBoothSoc: parseFloat(session.currentLiveSoc),
      boothUid: session.boothUid,
      slotIdentifier: session.slotIdentifier,
      depositCompletedAt: session.depositCompletedAt
    });

  } catch (error) {
    logger.error(`Failed to get pending withdrawal for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve pending session.', details: error.message });
  } finally {
    client.release();
  }
});

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
    // M-Pesa STK push timeout is typically 60 seconds. We wait slightly longer to allow for callback latency.
    const PENDING_TIMEOUT_SECONDS = parseInt(process.env.MPESA_PENDING_TIMEOUT_SECONDS, 10) || 80;
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
        // IMPORTANT: We do NOT mark the session as failed in the DB based on a query result.
        // M-Pesa queries often return non-zero codes while the transaction is still technically 
        // waiting for user input or Safaricom's internal sync is lagging. 
        // We rely on the definitive Callback (webhook) to handle actual failures.
        logger.warn(`M-Pesa query for ${checkoutRequestId} returned non-success code: ${ResultCode} (${ResultDesc}). Keeping status as pending.`);
        return res.status(200).json({ paymentStatus: 'pending', reason: ResultDesc });
      }
    } catch (mpesaError) {
      const errorData = mpesaError.response?.data;
      const errorDetail = errorData ? (errorData.errorMessage || JSON.stringify(errorData)) : mpesaError.message;
      logger.error(`Self-healing failed to query M-Pesa for ${checkoutRequestId}: ${errorDetail}`);
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
 * POST /api/booths/release-battery
 * @summary Release a paid battery after physical verification (scanning QR)
 * @description Triggered when a user scans a booth QR code after having paid for a withdrawal.
 * Verifies that the user has a paid session for this specific booth and then opens the slot.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [boothUid]
 *         properties:
 *           boothUid:
 *             type: string
 * @responses
 *   200:
 *     description: Battery released successfully.
 *   404:
 *     description: No paid session found for this booth.
 *   500:
 *     description: Internal server error.
 */
router.post('/release-battery', verifyFirebaseToken, async (req, res) => {
  const { boothUid } = req.body;
  const { uid: firebaseUid } = req.user;

  if (!boothUid) {
    return res.status(400).json({ error: 'boothUid is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // Find the paid withdrawal session that matches this user and this booth.
    const sessionRes = await client.query(
      `SELECT d.id, s.slot_identifier
       FROM deposits d
       JOIN booths b ON d.booth_id = b.id
       JOIN booth_slots s ON d.slot_id = s.id
       WHERE d.user_id = $1 AND b.booth_uid = $2 AND d.session_type = 'withdrawal' AND d.status = 'in_progress'
       LIMIT 1`,
      [firebaseUid, boothUid]
    );

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'No paid withdrawal session found for this booth. Please ensure you have paid.' });
    }

    const { slot_identifier: slotIdentifier } = sessionRes.rows[0];
    const db = getDatabase();
    await db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`).update({
      openForCollection: true,
      openForDeposit: false,
    });

    logger.info(`User ${firebaseUid} verified at booth ${boothUid}. Battery released from slot ${slotIdentifier}.`);
    res.status(200).json({ message: `Battery released. Please collect it from slot ${slotIdentifier}.`, slotIdentifier });
  } catch (error) {
    logger.error(`Failed to release battery for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to release battery.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
