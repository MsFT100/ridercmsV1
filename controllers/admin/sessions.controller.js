const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');
const { initiateSTKPush } = require('../../utils/mpesa');

const router = Router();

/**
 * GET /api/admin/sessions
 * @summary Get all sessions from the deposits table
 * @description Retrieves a paginated list of all sessions (deposits and withdrawals) from the deposits table, including detailed information. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: limit
 *     schema:
 *       type: integer
 *       default: 50
 *     description: The number of sessions to return.
 *   - in: query
 *     name: offset
 *     schema:
 *       type: integer
 *       default: 0
 *     description: The number of sessions to skip for pagination.
 *   - in: query
 *     name: searchTerm
 *     schema:
 *       type: string
 *     description: Search by user email, name, or phone number.
 *   - in: query
 *     name: status
 *     schema:
 *       type: string
 *     description: Filter by session status.
 *   - in: query
 *     name: sessionType
 *     schema:
 *       type: string
 *       enum: [deposit, withdrawal]
 *     description: Filter by session type.
 *   - in: query
 *     name: startDate
 *     schema:
 *       type: string
 *       format: date-time
 *     description: Filter sessions created after this date (ISO format).
 *   - in: query
 *     name: endDate
 *     schema:
 *       type: string
 *       format: date-time
 *     description: Filter sessions created before this date (ISO format).
 *   - in: query
 *     name: slotIdentifier
 *     schema:
 *       type: string
 *     description: Filter by slot identifier (e.g., slot001).
 *   - in: query
 *     name: userId
 *     schema:
 *       type: string
 *     description: Filter by specific Firebase User UID.
 *   - in: query
 *     name: sessionId
 *     schema:
 *       type: integer
 *     description: Filter by specific session ID.
 * @responses
 *   200:
 *     description: A paginated list of all sessions.
 *   500:
 *     description: Internal server error.
 */
router.get('/sessions', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const {
    searchTerm,
    status,
    sessionType,
    startDate,
    endDate,
    slotIdentifier,
    userId,
    sessionId
  } = req.query;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;

    if (searchTerm) {
      whereClauses.push(`(u.email ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex} OR u.phone ILIKE $${paramIndex++})`);
      queryParams.push(`%${searchTerm}%`);
    }
    if (status) {
      whereClauses.push(`d.status = $${paramIndex++}`);
      queryParams.push(status);
    }
    if (sessionType) {
      whereClauses.push(`d.session_type = $${paramIndex++}`);
      queryParams.push(sessionType);
    }
    if (startDate) {
      whereClauses.push(`d.created_at >= $${paramIndex++}`);
      queryParams.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`d.created_at <= $${paramIndex++}`);
      queryParams.push(endDate);
    }
    if (slotIdentifier) {
      whereClauses.push(`s.slot_identifier = $${paramIndex++}`);
      queryParams.push(slotIdentifier);
    }
    if (userId) {
      whereClauses.push(`d.user_id = $${paramIndex++}`);
      queryParams.push(userId);
    }
    if (sessionId) {
      const id = parseInt(sessionId, 10);
      if (!isNaN(id)) {
        whereClauses.push(`d.id = $${paramIndex++}`);
        queryParams.push(id);
      }
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const baseQuery = `
      FROM deposits d
      LEFT JOIN users u ON d.user_id = u.user_id
      LEFT JOIN booths b ON d.booth_id = b.id
      LEFT JOIN booth_slots s ON d.slot_id = s.id
      LEFT JOIN batteries bat ON d.battery_id = bat.id
      ${whereString}
    `;

    const dataQuery = `
      SELECT
        d.id, d.session_type AS "sessionType", d.status, d.amount,
        d.mpesa_checkout_id AS "mpesaCheckoutId", d.initial_charge_level AS "initialChargeLevel",
        d.created_at AS "createdAt", d.started_at AS "startedAt", d.completed_at AS "completedAt",
        u.email AS "userEmail", u.phone AS "userPhoneNumber", b.booth_uid AS "boothUid", s.slot_identifier AS "slotIdentifier",
        bat.battery_uid AS "batteryUid"
      ${baseQuery}
      ORDER BY d.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++};
    `;

    // The count query must use the same WHERE clause but without limit/offset params
    const countQuery = `SELECT COUNT(d.id) ${baseQuery}`;
    const countParams = [...queryParams]; // The count query uses only the filter params

    const dataQueryParams = [...queryParams, limit, offset]; // The data query uses filters, limit, and offset

    const [sessionsResult, totalCountResult] = await Promise.all([
      client.query(dataQuery, dataQueryParams),
      client.query(countQuery, countParams),
    ]);

    res.status(200).json({
      sessions: sessionsResult.rows,
      total: parseInt(totalCountResult.rows[0].count, 10),
    });
  } catch (error) {
    logger.error('Failed to get all sessions for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve sessions.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/sessions/:sessionId
 * @summary Delete a session and reset the associated slot
 * @description Deletes a session from the deposits table and resets the linked slot to 'available' state. This is a destructive action for cleaning up problematic or stuck sessions.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: sessionId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The ID of the session (from the deposits table) to delete.
 * @responses
 *   200:
 *     description: Session deleted and slot reset successfully.
 *   404:
 *     description: Session not found.
 *   500:
 *     description: Internal server error.
 */
router.delete('/sessions/:sessionId', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { sessionId } = req.params;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the session details, specifically the slot_id
    const sessionRes = await client.query('SELECT slot_id FROM deposits WHERE id = $1', [sessionId]);

    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    const { slot_id: slotId } = sessionRes.rows[0];

    // 2. If a slot is associated, reset it to a clean state
    if (slotId) {
      await client.query(
        `UPDATE booth_slots SET status = 'available', current_battery_id = NULL, door_status = 'closed', is_charging = FALSE, charge_level_percent = NULL, telemetry = NULL, updated_at = NOW() WHERE id = $1`,
        [slotId]
      );
    }

    // 3. Delete the session from the deposits table
    await client.query('DELETE FROM deposits WHERE id = $1', [sessionId]);

    // 4. Commit the transaction
    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) deleted session ${sessionId} and reset associated slot (ID: ${slotId || 'N/A'}).`);
    res.status(200).json({ message: 'Session deleted and slot reset successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to delete session ${sessionId}:`, error);
    res.status(500).json({ error: 'Failed to delete session. The operation was rolled back.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/sessions/:sessionId/charge
 * @summary Trigger M-Pesa payment for a pending admin withdrawal session
 * @description Initiates an M-Pesa STK push for a pending withdrawal session created by the
 * admin manual-withdraw flow. Optionally allows the admin to override the amount and/or phone number.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: sessionId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The ID of the pending withdrawal session.
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [phone]
 *         properties:
 *           phone:
 *             type: string
 *             description: The phone number to send the STK push to.
 *           amount:
 *             type: number
 *             description: Optional amount override. If omitted, uses the session's calculated amount.
 * @responses
 *   200:
 *     description: STK push initiated.
 *   404:
 *     description: Pending session not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/sessions/:sessionId/charge', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { sessionId } = req.params;
  const { phone, amount: amountOverride } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the pending withdrawal session
    const sessionRes = await client.query(
      "SELECT id, amount, status FROM deposits WHERE id = $1 AND session_type = 'withdrawal' AND status IN ('pending', 'failed')",
      [sessionId]
    );

    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No pending or failed withdrawal session found.' });
    }

    const session = sessionRes.rows[0];
    const finalAmount = amountOverride != null ? Number(amountOverride) : Number(session.amount);

    if (finalAmount < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Amount must be at least KES 1.' });
    }

    // 2. Update amount if overridden
    if (amountOverride != null && Number(amountOverride) !== Number(session.amount)) {
      await client.query('UPDATE deposits SET amount = $1 WHERE id = $2', [finalAmount, sessionId]);
    }

    // 3. Trigger M-Pesa STK Push
    const mpesaResponse = await initiateSTKPush({
      phone,
      amount: finalAmount,
      accountReference: `adm_${sessionId}`,
      transactionDesc: `Admin withdraw ${sessionId}`,
    });

    const checkoutRequestId = mpesaResponse.data.CheckoutRequestID;

    // 4. Store the checkout ID and mark as pending + started
    await client.query(
      "UPDATE deposits SET mpesa_checkout_id = $1, status = 'pending', started_at = NOW() WHERE id = $2",
      [checkoutRequestId, sessionId]
    );

    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) triggered M-Pesa charge for session ${sessionId}. CheckoutRequestID: ${checkoutRequestId}, amount KES ${finalAmount}.`);

    res.status(200).json({
      message: 'STK push sent. Waiting for payment confirmation.',
      checkoutRequestId,
      amount: finalAmount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.isAxiosError) {
      const errorDetails = { request: error.config, response: error.response?.data };
      logger.error(`M-Pesa API error charging session ${sessionId}:`, errorDetails);
    } else {
      logger.error(`Failed to charge session ${sessionId}:`, error);
    }
    res.status(500).json({ error: 'Failed to trigger M-Pesa payment.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/sessions/:sessionId/payment-status
 * @summary Poll payment status for an admin-initiated withdrawal session
 * @description Returns the current status of a withdrawal session so the admin frontend can
 * poll after triggering payment via the /charge endpoint.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: sessionId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The ID of the withdrawal session.
 * @responses
 *   200:
 *     description: Payment status returned.
 *   404:
 *     description: Session not found.
 *   500:
 *     description: Internal server error.
 */
router.get('/sessions/:sessionId/payment-status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { sessionId } = req.params;

  const pool = await poolPromise;
  try {
    const result = await pool.query(
      "SELECT status FROM deposits WHERE id = $1 AND session_type = 'withdrawal'",
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const { status } = result.rows[0];

    // Map internal statuses to a simpler payment status for the frontend
    let paymentStatus;
    if (status === 'completed') {
      paymentStatus = 'paid';
    } else if (status === 'in_progress') {
      paymentStatus = 'paid';
    } else if (status === 'failed') {
      paymentStatus = 'failed';
    } else {
      paymentStatus = 'pending';
    }

    res.status(200).json({ paymentStatus, rawStatus: status });
  } catch (error) {
    logger.error(`Failed to get payment status for session ${sessionId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve payment status.', details: error.message });
  }
});

/**
 * POST /api/admin/sessions/cleanup
 * @summary (System Task) Clean up old, stuck sessions.
 * @description Finds and resolves sessions that have been stuck in a transient state for too long (e.g., 'in_progress' for more than 5 minutes). This is intended to be called by a scheduled task (cron job).
 * @tags [Admin, System]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: Cleanup task completed.
 *   500:
 *     description: Internal server error.
 */
router.post('/sessions/cleanup', [verifyFirebaseToken, isAdmin], async (req, res) => {
  // This logic is designed to be idempotent.
  const STUCK_SESSION_TIMEOUT_MINUTES = 5;
  const STALE_ADMIN_SESSION_TIMEOUT_MINUTES = 10;
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // --- Find stuck 'in_progress' withdrawal sessions ---
    const stuckWithdrawalsQuery = `
      SELECT id, slot_id, user_id
      FROM deposits
      WHERE
        session_type = 'withdrawal'
        AND status = 'in_progress'
        AND updated_at < NOW() - INTERVAL '${STUCK_SESSION_TIMEOUT_MINUTES} minutes'
      FOR UPDATE; -- Lock the rows to prevent race conditions
    `;
    const stuckWithdrawalsRes = await client.query(stuckWithdrawalsQuery);

    if (stuckWithdrawalsRes.rowCount > 0) {
      logger.info(`Found ${stuckWithdrawalsRes.rowCount} stuck 'in_progress' withdrawal session(s) to clean up.`);

      // We need the handleWithdrawalCompletion function from firebaseSync.js
      // This is a bit of a workaround to avoid circular dependencies.
      const { handleWithdrawalCompletion } = require('../../utils/firebaseSync.js');

      for (const session of stuckWithdrawalsRes.rows) {
        logger.info(`Auto-completing stuck withdrawal session ${session.id} for user ${session.user_id}.`);
        await handleWithdrawalCompletion(client, `slot_id_${session.slot_id}`, session.slot_id);
      }
    }

    // --- Purge stale admin-created pending withdrawal sessions ---
    // If the admin created a pending session but never triggered payment (or navigated away),
    // clean it up so the slot is not blocked indefinitely.
    const staleAdminRes = await client.query(
      `DELETE FROM deposits
       WHERE session_type = 'withdrawal'
         AND status = 'pending'
         AND notes LIKE '%Manual admin withdraw%'
         AND created_at < NOW() - INTERVAL '${STALE_ADMIN_SESSION_TIMEOUT_MINUTES} minutes'`
    );

    if (staleAdminRes.rowCount > 0) {
      logger.info(`[SystemCleanup] Purged ${staleAdminRes.rowCount} stale admin pending session(s) older than ${STALE_ADMIN_SESSION_TIMEOUT_MINUTES} minutes.`);
    }

    // --- Purge old cancelled sessions ---
    // This keeps the database size manageable by removing sessions that were never completed.
    const purgeResult = await client.query(
      "DELETE FROM deposits WHERE status = 'cancelled' AND updated_at < NOW() - INTERVAL '30 days'"
    );

    if (purgeResult.rowCount > 0) {
      logger.info(`[SystemCleanup] Purged ${purgeResult.rowCount} cancelled sessions older than 30 days.`);
    }

    await client.query('COMMIT');
    res.status(200).json({ 
      message: 'Cleanup task completed.', 
      stuckResolved: stuckWithdrawalsRes.rowCount,
      staleAdminPurged: staleAdminRes.rowCount,
      cancelledPurged: purgeResult.rowCount 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to run session cleanup task:', error);
    res.status(500).json({ error: 'Failed to run session cleanup task.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/rentals/fleet
 * @summary Inventory of rental-pool batteries and their current location
 * @description Lists every borrowable (rental-pool) battery and where it is right now:
 * either sitting in a booth slot (state 'in_slot') or out with a user (state 'issued' /
 * 'returned'). A battery qualifies as pool stock when it occupies a slot but has no
 * completed-and-unredeemed deposit credit (i.e. it does not belong to someone's active
 * charging session). When a battery is rented it leaves the slot and shows the user who
 * has it until the return is physically completed.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: Array of rental batteries with their current location.
 *   500:
 *     description: Internal server error.
 */
router.get('/rentals/fleet', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // Batteries currently out with a user (rental issued and not yet returned/completed).
    const issuedRes = await client.query(
      `SELECT
         r.id AS "sessionId",
         r.created_at AS "rentedAt",
         r.return_slot_id,
         b.battery_uid AS "batteryUid",
         br.booth_uid AS "sourceBoothUid",
         bl.slot_identifier AS "sourceSlotIdentifier",
         u.name AS "userName",
         u.phone AS "userPhone",
         u.email AS "userEmail"
       FROM deposits r
       JOIN batteries b ON r.battery_id = b.id
       JOIN users u ON r.user_id = u.user_id
       JOIN booth_slots bl ON r.slot_id = bl.id
       JOIN booths br ON bl.booth_id = br.id
       WHERE r.session_type = 'rental'
         AND r.status IN ('pending', 'in_progress')
         AND b.withdrawn_at IS NULL
       ORDER BY r.created_at DESC`
    );

    // Batteries sitting in a booth slot that belong to the rental pool (no deposit owner
    // and no active rental on that battery).
    const inSlotRes = await client.query(
      `SELECT
         s.slot_identifier AS "slotIdentifier",
         bo.booth_uid AS "boothUid",
         b.battery_uid AS "batteryUid",
         s.charge_level_percent AS "chargeLevel",
         s.status AS "slotStatus"
       FROM booth_slots s
       JOIN booths bo ON s.booth_id = bo.id
       JOIN batteries b ON s.current_battery_id = b.id
       WHERE bo.status = 'online'
         AND s.status = 'occupied'
         AND b.withdrawn_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM deposits d
           WHERE d.battery_id = b.id
             AND d.session_type = 'deposit'
             AND d.status = 'completed'
             AND NOT EXISTS (
               SELECT 1 FROM deposits w
               WHERE w.consumed_deposit_id = d.id
                 AND w.session_type IN ('withdrawal', 'rental')
                 AND w.status NOT IN ('cancelled', 'failed')
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM deposits r
           WHERE r.battery_id = b.id
             AND r.session_type = 'rental'
             AND r.status IN ('pending', 'in_progress')
         )
       ORDER BY bo.booth_uid ASC, s.slot_identifier ASC`
    );

    const issued = issuedRes.rows.map((row) => ({
      batteryUid: row.batteryUid,
      state: row.return_slot_id ? 'RETURNED' : 'ISSUED',
      sessionId: row.sessionId,
      rentedAt: row.rentedAt,
      sourceBoothUid: row.sourceBoothUid,
      sourceSlotIdentifier: row.sourceSlotIdentifier,
      user: {
        name: row.userName,
        phone: row.userPhone,
        email: row.userEmail,
      },
    }));

    const inSlots = inSlotRes.rows.map((row) => ({
      batteryUid: row.batteryUid,
      state: 'IN_SLOT',
      boothUid: row.boothUid,
      slotIdentifier: row.slotIdentifier,
      chargeLevel: row.chargeLevel !== null ? Number(row.chargeLevel) : null,
      slotStatus: row.slotStatus,
    }));

    res.status(200).json({
      total: issued.length + inSlots.length,
      issued,
      inSlots,
    });
  } catch (error) {
    logger.error('Failed to get rental fleet inventory:', error);
    res.status(500).json({ error: 'Failed to retrieve rental fleet.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/rentals
 * @summary Add a battery to the rental pool
 * @description Registers (or re-registers) a battery as borrowable pool stock by
 * placing it into a booth slot. If the battery_uid already exists it is re-activated
 * (any prior withdrawal is lifted) and moved to the supplied location.
 * @tags [Admin]
 * @security - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [batteryUid, boothUid, slotIdentifier]
 *         properties:
 *           batteryUid:
 *             type: string
 *           chargeLevel:
 *             type: integer
 *             description: Optional override. When omitted, the slot's current live SOC (hardware telemetry) is used.
 *           boothUid:
 *             type: string
 *           slotIdentifier:
 *             type: string
 *           batteryType:
 *             type: string
 *             description: Optional label such as E-Bike/Scooter/Car Module (informational).
 *           notes:
 *             type: string
 * @responses
 *   201:
 *     description: Rental battery created.
 *   409:
 *     description: Battery is currently rented out.
 *   404:
 *     description: Booth or slot not found.
 */
router.post('/rentals', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { batteryUid, chargeLevel, boothUid, slotIdentifier, notes } = req.body;

  if (!batteryUid || !batteryUid.trim()) {
    return res.status(400).json({ error: 'batteryUid is required.' });
  }
  if (!boothUid || !slotIdentifier) {
    return res.status(400).json({ error: 'boothUid and slotIdentifier are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT s.id AS "slotId", s.booth_id AS "boothId", s.status AS "slotStatus", s.charge_level_percent AS "slotChargeLevel"
       FROM booth_slots s
       JOIN booths b ON s.booth_id = b.id
       WHERE b.booth_uid = $1 AND s.slot_identifier = $2
       LIMIT 1`,
      [boothUid, slotIdentifier]
    );
    if (slotRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booth or slot not found.' });
    }
    const { slotId, slotStatus, slotChargeLevel } = slotRes.rows[0];

    // Rental batteries may only be placed into empty slots.
    if (slotStatus !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is not available. Only empty slots can receive a rental battery.' });
    }

    // Resolve the battery's charge level. The battery is already sitting in
    // the slot, so prefer the live SOC from the booth hardware telemetry;
    // fall back to the slot value stored in the database.
    let level;
    if (chargeLevel === undefined || chargeLevel === null || chargeLevel === '') {
      try {
        const db = getDatabase();
        const snapshot = await db.ref(`booths/${boothUid}/slots/${slotIdentifier}`).get();
        if (snapshot.exists()) {
          const slotData = snapshot.val();
          const telemetry = slotData.telemetry || {};
          level = telemetry.soc ?? slotData.soc ?? slotData.final_soc ?? null;
        }
      } catch (fbErr) {
        logger.warn(`Failed to read slot telemetry for ${boothUid}/${slotIdentifier}:`, fbErr.message);
      }
      if (level === null || level === undefined) {
        level = slotChargeLevel;
      }
    } else {
      level = chargeLevel;
    }

    level = Number(level);
    if (Number.isNaN(level) || level < 0 || level > 100) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'chargeLevel must be between 0 and 100.' });
    }

    // 1. Find or create the battery.
    const batteryRes = await client.query(
      `SELECT id, battery_uid AS "batteryUid", withdrawn_at AS "withdrawnAt"
       FROM batteries WHERE battery_uid = $1 LIMIT 1`,
      [batteryUid.trim()]
    );

    let batteryId;
    if (batteryRes.rowCount > 0) {
      batteryId = batteryRes.rows[0].id;

      // A battery that is currently rented out cannot be reassigned.
      const activeRentalRes = await client.query(
        `SELECT 1 FROM deposits
         WHERE battery_id = $1 AND session_type = 'rental' AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [batteryId]
      );
      if (activeRentalRes.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Battery is currently rented out.' });
      }

      await client.query(
        `UPDATE batteries
         SET charge_level_percent = $1, withdrawn_at = NULL, withdrawal_reason = NULL, withdrawal_notes = NULL, updated_at = NOW()
         WHERE id = $2`,
        [level, batteryId]
      );
    } else {
      const insertRes = await client.query(
        `INSERT INTO batteries (battery_uid, charge_level_percent, health_status)
         VALUES ($1, $2, 'good') RETURNING id`,
        [batteryUid.trim(), level]
      );
      batteryId = insertRes.rows[0].id;
    }

    // 2. Place the battery into the requested booth slot as unowned pool stock.
    await client.query(
      `UPDATE booth_slots
       SET status = 'occupied', current_battery_id = $1, charge_level_percent = $2,
           is_charging = FALSE, door_status = 'closed', updated_at = NOW()
       WHERE id = $3`,
      [batteryId, level, slotId]
    );

    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) added rental battery ${batteryUid.trim()} to ${boothUid}/${slotIdentifier} at SOC ${level}%.`);
    return res.status(201).json({
      batteryUid: batteryUid.trim(),
      chargeLevel: level,
      boothUid,
      slotIdentifier,
      notes: notes || null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to add rental battery:', error);
    return res.status(500).json({ error: 'Failed to add rental battery.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/rentals/:batteryUid/withdraw
 * @summary Withdraw a battery from the rental pool
 * @description Marks a battery as withdrawn (e.g. damaged or lost) so it is no longer
 * offered for rental, and clears the booth slot it currently occupies. A battery that is
 * currently rented out to a rider cannot be withdrawn.
 * @tags [Admin]
 * @security - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [reason]
 *         properties:
 *           reason:
 *             type: string
 *             description: e.g. Damaged, Faulty, Lost, Battery degradation, End of life, Other.
 *           notes:
 *             type: string
 * @responses
 *   200:
 *     description: Battery withdrawn.
 *   404:
 *     description: Battery not found.
 *   409:
 *     description: Battery is currently rented out.
 */
router.post('/rentals/:batteryUid/withdraw', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { batteryUid } = req.params;
  const { reason, notes } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'A withdrawal reason is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batteryRes = await client.query(
      `SELECT id, battery_uid AS "batteryUid", withdrawn_at AS "withdrawnAt"
       FROM batteries WHERE battery_uid = $1 LIMIT 1`,
      [batteryUid]
    );
    if (batteryRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Battery not found.' });
    }
    const battery = batteryRes.rows[0];

    if (battery.withdrawnAt) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Battery is already withdrawn.' });
    }

    // A battery that is currently rented out cannot be withdrawn.
    const activeRentalRes = await client.query(
      `SELECT 1 FROM deposits
       WHERE battery_id = $1 AND session_type = 'rental' AND status IN ('pending', 'in_progress')
       LIMIT 1`,
      [battery.id]
    );
    if (activeRentalRes.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Battery cannot be withdrawn while it is rented out.' });
    }

    await client.query(
      `UPDATE batteries
       SET withdrawn_at = NOW(), withdrawal_reason = $1, withdrawal_notes = $2, updated_at = NOW()
       WHERE id = $3`,
      [reason.trim(), notes || null, battery.id]
    );

    // Clear the booth slot this battery currently occupies (it has been physically removed).
    const slotRes = await client.query(
      `SELECT id FROM booth_slots WHERE current_battery_id = $1 LIMIT 1`,
      [battery.id]
    );
    if (slotRes.rowCount > 0) {
      await client.query(
        `UPDATE booth_slots
         SET status = 'available', current_battery_id = NULL, charge_level_percent = NULL,
             is_charging = FALSE, door_status = 'closed', updated_at = NOW()
         WHERE id = $1`,
        [slotRes.rows[0].id]
      );
    }

    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) withdrew rental battery ${batteryUid} (${reason.trim()}).`);
    return res.status(200).json({
      batteryUid,
      withdrawn: true,
      reason: reason.trim(),
      notes: notes || null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to withdraw rental battery:', error);
    return res.status(500).json({ error: 'Failed to withdraw rental battery.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/rentals/sessions
 * @summary List battery rental sessions
 * @description Returns the rental session history (rentals from the deposits table)
 * with the rider, the rented battery, the rider's own charging battery, duration,
 * amount and a UI-friendly status.
 * @tags [Admin]
 * @security - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: limit
 *     schema:
 *       type: integer
 *       default: 100
 *   - in: query
 *     name: offset
 *     schema:
 *       type: integer
 *       default: 0
 * @responses
 *   200:
 *     description: Rental sessions returned.
 */
router.get('/rentals/sessions', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT
         r.id,
         r.status,
         r.amount,
         r.created_at AS "startTime",
         r.completed_at AS "completedAt",
         r.return_slot_id,
         u.name AS "riderName",
         u.phone AS "phone",
         bat.battery_uid AS "rentalBatteryId",
         depBat.battery_uid AS "ownBatteryId"
       FROM deposits r
       JOIN users u ON r.user_id = u.user_id
       LEFT JOIN batteries bat ON r.battery_id = bat.id
       LEFT JOIN deposits dep ON dep.id = r.consumed_deposit_id
       LEFT JOIN batteries depBat ON dep.battery_id = depBat.id
       WHERE r.session_type = 'rental'
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const sessions = result.rows.map((row) => {
      const endTime = row.completedAt || new Date().toISOString();
      const startMs = new Date(row.startTime).getTime();
      const endMs = new Date(endTime).getTime();
      const durationMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));

      let status;
      if (row.status === 'pending') status = 'issued';
      else if (row.status === 'in_progress' && row.return_slot_id) status = 'returned';
      else if (row.status === 'in_progress') status = 'active';
      else status = row.status;

      const amount = Number(row.amount) || 0;

      return {
        id: String(row.id),
        riderName: row.riderName || 'Unknown Rider',
        phone: row.phone || undefined,
        rentalBatteryId: row.rentalBatteryId || 'N/A',
        ownBatteryId: row.ownBatteryId || undefined,
        durationMinutes,
        amount,
        totalAmount: amount,
        status,
        startTime: row.startTime,
      };
    });

    return res.status(200).json({ sessions, total: sessions.length });
  } catch (error) {
    logger.error('Failed to get rental sessions:', error);
    return res.status(500).json({ error: 'Failed to retrieve rental sessions.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
