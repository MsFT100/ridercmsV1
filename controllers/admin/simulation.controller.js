const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Simulation
 *   description: Endpoints for simulating hardware and external service events (for development/testing).
 */

/**
 * POST /api/admin/simulate/confirm-deposit
 * @summary (Dev Tool) Simulate a hardware confirmation of a battery deposit.
 * @description Manually triggers the logic that would normally be called by the booth hardware after a user deposits a battery. This is for testing and development.
 * @tags [Admin, Simulation]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [boothUid, slotIdentifier, batteryUid, chargeLevel]
 *         properties:
 *           boothUid:
 *             type: string
 *           slotIdentifier:
 *             type: string
 *           batteryUid:
 *             type: string
 *           chargeLevel:
 *             type: integer
 * @responses
 *   200:
 *     description: Deposit successfully simulated.
 *   400:
 *     description: Bad request.
 *   404:
 *     description: Pending deposit session not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/simulate/confirm-deposit', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid, slotIdentifier, chargeLevel } = req.body;

  if (!boothUid || !slotIdentifier || chargeLevel === undefined) {
    return res.status(400).json({ error: 'boothUid, slotIdentifier, and chargeLevel are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // This logic is copied from /api/booths/confirm-deposit
    const depositRes = await client.query(
      `SELECT d.id, d.user_id FROM deposits d
       JOIN booths b ON d.booth_id = b.id
       JOIN booth_slots s ON d.slot_id = s.id
       WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.status = 'pending' AND d.session_type = 'deposit'
       ORDER BY d.created_at DESC LIMIT 1`,
      [boothUid, slotIdentifier]
    );

    if (depositRes.rows.length === 0) {
      throw new Error(`No pending deposit session found for booth '${boothUid}', slot '${slotIdentifier}'.`);
    }
    const { id: depositId, user_id: firebaseUid } = depositRes.rows[0];

    // For simulation, we generate a random battery UID, mimicking a new user battery.
    const simulatedBatteryUid = `sim-${uuidv4()}`;

    // Upsert the simulated battery (create it if it doesn't exist) and link to user.
    const upsertBatteryQuery = `
      INSERT INTO batteries (battery_uid, user_id, charge_level_percent)
      VALUES ($1, $2, $3)
      ON CONFLICT (battery_uid) DO UPDATE SET user_id = $2, charge_level_percent = $3
      RETURNING id;
    `;
    const batteryRes = await client.query(upsertBatteryQuery, [simulatedBatteryUid, firebaseUid, chargeLevel]);
    const batteryId = batteryRes.rows[0].id;

    await client.query(
      "UPDATE booth_slots SET status = 'occupied', current_battery_id = $1 WHERE slot_identifier = $2 AND booth_id = (SELECT id FROM booths WHERE booth_uid = $3)",
      [batteryId, slotIdentifier, boothUid]
    );
    await client.query(
      "UPDATE deposits SET status = 'completed', battery_id = $1, initial_charge_level = $2, completed_at = NOW() WHERE id = $3",
      [batteryId, chargeLevel, depositId]
    );

    await client.query('COMMIT');
    logger.info(`(SIMULATION) Admin ${req.user.uid} confirmed deposit for user '${firebaseUid}' with new battery '${simulatedBatteryUid}' in slot '${slotIdentifier}'.`);
    res.status(200).json({ success: true, message: 'Deposit confirmed via simulation.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`(SIMULATION) Failed to confirm deposit for slot '${slotIdentifier}' at booth '${boothUid}':`, error);
    res.status(500).json({ error: 'Failed to simulate deposit confirmation.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/simulate/confirm-payment
 * @summary (Dev Tool) Simulate a successful M-Pesa payment for a withdrawal.
 * @description Manually updates a withdrawal session's status to 'in_progress', mimicking a successful payment callback from M-Pesa.
 * @tags [Admin, Simulation]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [checkoutRequestId]
 *         properties:
 *           checkoutRequestId:
 *             type: string
 * @responses
 *   200:
 *     description: Payment successfully simulated.
 */
router.post('/simulate/confirm-payment', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { checkoutRequestId } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ error: 'checkoutRequestId is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const updateResult = await client.query(
      "UPDATE deposits SET status = 'in_progress' WHERE mpesa_checkout_id = $1 AND status = 'pending'",
      [checkoutRequestId]
    );

    if (updateResult.rowCount > 0) {
      logger.info(`(SIMULATION) Admin ${req.user.uid} confirmed payment for CheckoutRequestID: ${checkoutRequestId}.`);
      res.status(200).json({ message: 'Payment status updated to in_progress via simulation.' });
    } else {
      logger.warn(`(SIMULATION) Could not find a pending session for CheckoutRequestID: ${checkoutRequestId}`);
      res.status(404).json({ error: 'No pending withdrawal session found for that CheckoutRequestID.' });
    }
  } catch (error) {
    logger.error(`(SIMULATION) Failed to confirm payment for ${checkoutRequestId}:`, error);
    res.status(500).json({ error: 'Failed to simulate payment confirmation.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
