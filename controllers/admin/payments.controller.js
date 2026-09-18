const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');
const { initiateSTKPush, querySTKStatus } = require('../../utils/mpesa');
const { completePaidWithdrawal } = require('../../utils/sessionUtils');

const router = Router();

/**
 * GET /api/admin/payments
 * @summary Get M-Pesa payment logs
 * @description Retrieves a paginated list of M-Pesa callback records joined with session and user data to track actual payments made.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: limit
 *     type: integer
 *     description: Max records to return.
 *   - in: query
 *     name: offset
 *     type: integer
 *     description: Records to skip.
 *   - in: query
 *     name: searchTerm
 *     type: string
 *     description: Search by user name, email, or receipt number.
 *   - in: query
 *     name: startDate
 *     type: string
 *     description: Filter by start date (ISO).
 *   - in: query
 *     name: endDate
 *     type: string
 *     description: Filter by end date (ISO).
 *   - in: query
 *     name: status
 *     type: string
 *     enum: [success, failure]
 *     description: Filter by payment status.
 *   - in: query
 *     name: boothUid
 *     type: string
 *     description: Filter by specific booth UID.
 *   - in: query
 *     name: sortBy
 *     type: string
 *     enum: [amount, date]
 *     description: Field to sort by.
 *   - in: query
 *     name: sortOrder
 *     type: string
 *     enum: [ASC, DESC]
 *     default: DESC
 *     description: Order of sorting.
 * @responses
 *   200:
 *     description: A list of payment records.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             payments:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: integer, description: "The ID of the M-Pesa callback record." }
 *                   callbackType: { type: string, description: "Type of M-Pesa callback (e.g., 'stk_push')." }
 *                   payload: { type: object, description: "The raw JSON payload from M-Pesa." }
 *                   notes: { type: string, description: "Processing notes from the callback." }
 *                   createdAt: { type: string, format: "date-time", description: "Timestamp when the callback was received." }
 *                   amount: { type: number, format: "float", description: "The amount of the associated deposit/withdrawal." }
 *                   userName: { type: string, description: "Name of the user associated with the payment." }
 *                   userEmail: { type: string, description: "Email of the user associated with the payment." }
 *             total:
 *               type: integer
 *               description: Total number of payment records matching the filters.
 *             totalSuccessfulAmount:
 *               type: number
 *               format: float
 *               description: Sum of amounts for successful payments matching the filters.
 *   500:
 *     description: Internal server error.
 */
router.get('/payments', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const { searchTerm, startDate, endDate, sortBy, sortOrder, status, boothUid } = req.query;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;

    // Sorting Logic
    const sortFields = {
      amount: 'd.amount',
      date: 'cb.created_at'
    };
    const orderByField = sortFields[sortBy] || 'cb.created_at';
    const orderDirection = sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Separate parameters for the total successful amount query to ensure correct indexing
    let sumQueryParams = [];
    let sumParamIndex = 1;

    if (searchTerm) {
      whereClauses.push(`(cb.processing_notes ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex++})`);
      queryParams.push(`%${searchTerm}%`);
    }
    if (startDate) {
      whereClauses.push(`cb.created_at >= $${paramIndex++}`);
      queryParams.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`cb.created_at <= $${paramIndex++}`);
      queryParams.push(endDate);
    }
    if (status) {
      if (status === 'success') {
        whereClauses.push(`cb.processing_notes ILIKE $${paramIndex++}`);
        queryParams.push('%Result: 0%');
      } else if (status === 'failure') {
        whereClauses.push(`cb.processing_notes NOT ILIKE $${paramIndex++}`);
        queryParams.push('%Result: 0%');
      }
    }
    if (boothUid) {
      whereClauses.push(`b.booth_uid = $${paramIndex++}`);
      queryParams.push(boothUid);
    }

    // Build parameters for the sum query, always including the success condition
    let sumWhereClauses = [`cb.processing_notes ILIKE $${sumParamIndex++}`];
    sumQueryParams.push(`%Result: 0%`);
    if (searchTerm) {
      sumWhereClauses.push(`(cb.processing_notes ILIKE $${sumParamIndex} OR u.email ILIKE $${sumParamIndex} OR u.name ILIKE $${sumParamIndex++})`);
      sumQueryParams.push(`%${searchTerm}%`);
    }
    if (startDate) {
      sumWhereClauses.push(`cb.created_at >= $${sumParamIndex++}`);
      sumQueryParams.push(startDate);
    }
    if (status) {
      if (status === 'success') {
        // Already covered by the default success condition, but keeping for logic clarity
      } else if (status === 'failure') {
        sumWhereClauses.push(`cb.processing_notes NOT ILIKE $${sumParamIndex++}`);
        sumQueryParams.push('%Result: 0%');
      }
    }
    if (boothUid) {
      sumWhereClauses.push(`b.booth_uid = $${sumParamIndex++}`);
      sumQueryParams.push(boothUid);
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const dataQuery = `
      SELECT 
        cb.id, 
        cb.callback_type AS "callbackType", 
        cb.payload, 
        cb.processing_notes AS "notes", 
        cb.created_at AS "createdAt",
        d.amount,
        u.name AS "userName",
        u.email AS "userEmail"
      FROM mpesa_callbacks cb
      LEFT JOIN deposits d ON cb.payload->'Body'->'stkCallback'->>'CheckoutRequestID' = d.mpesa_checkout_id
      LEFT JOIN users u ON d.user_id = u.user_id
      LEFT JOIN booths b ON d.booth_id = b.id
      ${whereString}
      ORDER BY ${orderByField} ${orderDirection}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++};
    `;

    const countQuery = `SELECT COUNT(*) FROM mpesa_callbacks cb LEFT JOIN deposits d ON cb.payload->'Body'->'stkCallback'->>'CheckoutRequestID' = d.mpesa_checkout_id LEFT JOIN users u ON d.user_id = u.user_id LEFT JOIN booths b ON d.booth_id = b.id ${whereString}`;

    const sumWhereString = sumWhereClauses.length > 0 ? `WHERE ${sumWhereClauses.join(' AND ')}` : '';
    const totalSuccessfulAmountQuery = `
      SELECT COALESCE(SUM(d.amount), 0) AS "totalSuccessfulAmount"
      FROM mpesa_callbacks cb
      LEFT JOIN deposits d ON cb.payload->'Body'->'stkCallback'->>'CheckoutRequestID' = d.mpesa_checkout_id
      LEFT JOIN users u ON d.user_id = u.user_id
      LEFT JOIN booths b ON d.booth_id = b.id
      ${sumWhereString};
    `;

    const [dataRes, countRes, sumRes] = await Promise.all([
      client.query(dataQuery, [...queryParams, limit, offset]),
      client.query(countQuery, queryParams),
      client.query(totalSuccessfulAmountQuery, sumQueryParams)
    ]);

    res.status(200).json({
      payments: dataRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
      totalSuccessfulAmount: parseFloat(sumRes.rows[0].totalSuccessfulAmount || 0)
    });
  } catch (error) {
    logger.error('Failed to get payments for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve payments.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/payments/manual-withdraw
 * @summary Admin manually triggers an M-Pesa STK push withdrawal for a user
 * @description Creates a manual withdrawal session for the specified user and sends an STK push to their phone number.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [userId, phoneNumber, amount]
 *         properties:
 *           userId:
 *             type: string
 *             description: Firebase UID of the target user.
 *           phoneNumber:
 *             type: string
 *             description: Phone number to send the STK push to (E.164 or local format).
 *           amount:
 *             type: number
 *             description: Amount in KES to charge.
 * @responses
 *   200:
 *     description: STK push sent successfully.
 *   400:
 *     description: Missing required fields.
 *   500:
 *     description: Internal server error.
 */
router.post('/payments/manual-withdraw', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { userId, phoneNumber, amount, boothUid, slotIdentifier } = req.body;

  if (!userId || !phoneNumber || !amount) {
    return res.status(400).json({ error: 'userId, phoneNumber, and amount are required.' });
  }

  if (isNaN(amount) || amount < 1) {
    return res.status(400).json({ error: 'Amount must be a number greater than or equal to 1.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // 1. Verify the user exists in our database
    const userRes = await client.query('SELECT user_id, name, email, phone FROM users WHERE user_id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: `User with ID ${userId} not found.` });
    }

    // 2. Resolve booth and slot if provided
    let boothId = null;
    let slotId = null;
    if (boothUid && slotIdentifier) {
      const slotRes = await client.query(`
        SELECT s.id AS "slotId", b.id AS "boothId"
        FROM booth_slots s
        JOIN booths b ON s.booth_id = b.id
        WHERE b.booth_uid = $1 AND s.slot_identifier = $2
      `, [boothUid, slotIdentifier]);
      if (slotRes.rows.length > 0) {
        boothId = slotRes.rows[0].boothId;
        slotId = slotRes.rows[0].slotId;
      }
    }

    // 3. Resolve the original deposit credit to link as consumed_deposit_id
    let consumedDepositId = null;
    if (slotId) {
      const depositCreditRes = await client.query(`
        SELECT d.id FROM deposits d
        WHERE d.slot_id = $1 AND d.session_type = 'deposit' AND d.status = 'completed'
        ORDER BY d.completed_at DESC
        LIMIT 1
      `, [slotId]);
      if (depositCreditRes.rows.length > 0) {
        consumedDepositId = depositCreditRes.rows[0].id;
      }
    }

    // 4. A withdrawal session must be tied to a specific booth slot.
    //    (deposits.booth_id and deposits.slot_id are NOT NULL.)
    if (!boothId || !slotId) {
      return res.status(400).json({ error: 'boothUid and slotIdentifier are required for a manual withdrawal.' });
    }

    // 5. Create a manual withdrawal session
    const sessionRes = await client.query(
      `INSERT INTO deposits (user_id, booth_id, slot_id, session_type, status, amount, consumed_deposit_id, notes)
       VALUES ($1, $2, $3, 'withdrawal', 'pending', $4, $5, 'manual_withdrawal')
       RETURNING id`,
      [userId, boothId, slotId, amount, consumedDepositId]
    );
    const sessionId = sessionRes.rows[0].id;

    // 6. Dev mode: skip M-Pesa, auto-approve
    if (req.user.role === 'developer') {
      const devCheckoutId = `DEV_MANUAL_${sessionId}_${Date.now()}`;
      await client.query(
        "UPDATE deposits SET mpesa_checkout_id = $1, started_at = NOW(), status = 'in_progress', notes = 'manual_withdrawal' WHERE id = $2",
        [devCheckoutId, sessionId]
      );
      // Insert a synthetic callback record so it shows in the Payments page
      await client.query(
        `INSERT INTO mpesa_callbacks (callback_type, payload, processing_notes)
         VALUES ($1, $2, $3)`,
        [
          'stk_push',
          JSON.stringify({
            Body: {
              stkCallback: {
                MerchantRequestID: `MANUAL_${sessionId}`,
                CheckoutRequestID: devCheckoutId,
                ResultCode: 0,
                ResultDesc: 'The service request is processed successfully.',
                CallbackMetadata: {
                  Item: [
                    { Name: 'Amount', Value: amount },
                    { Name: 'MpesaReceiptNumber', Value: devCheckoutId },
                    { Name: 'PhoneNumber', Value: parseInt(phoneNumber.replace(/[^0-9]/g, '')) },
                  ]
                }
              }
            }
          }),
          `Result: 0 - Success. Receipt: ${devCheckoutId}. Paid: KES ${amount}. Manual withdrawal (dev).`
        ]
      );
      logger.info(`[Admin Manual Withdraw] Dev mode: auto-approved session ${sessionId} for user ${userId}.`);
      return res.status(200).json({
        success: true,
        message: 'Manual withdrawal auto-approved (dev mode).',
        sessionId,
        transactionId: devCheckoutId,
      });
    }

    // 7. Production: trigger M-Pesa STK push
    const safePhone = phoneNumber.replace(/[^0-9]/g, '');
    const mpesaResponse = await initiateSTKPush({
      phone: safePhone,
      amount: amount,
      accountReference: `ADMIN_WD_${sessionId}`,
      transactionDesc: `Manual WD #${sessionId}`,
    });

    const checkoutRequestId = mpesaResponse.data.CheckoutRequestID;
    await client.query(
      "UPDATE deposits SET mpesa_checkout_id = $1, started_at = NOW() WHERE id = $2",
      [checkoutRequestId, sessionId]
    );

    logger.info(`[Admin Manual Withdraw] STK push sent for session ${sessionId} to ${safePhone}. CheckoutRequestID: ${checkoutRequestId}`);

    return res.status(200).json({
      success: true,
      message: 'STK push sent to user. Waiting for PIN confirmation.',
      sessionId,
      transactionId: checkoutRequestId,
    });
  } catch (error) {
    logger.error('[Admin Manual Withdraw] Failed:', error);
    return res.status(500).json({ error: 'Failed to initiate manual withdrawal.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/payments/status/:sessionId
 * @summary Check payment status of a manual withdrawal session
 * @description Returns the current status of a withdrawal session by its ID.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: sessionId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The deposit session ID.
 * @responses
 *   200:
 *     description: Payment status.
 */
router.get('/payments/status/:sessionId', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { sessionId } = req.params;
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const sessionRes = await client.query(
      'SELECT id, status, mpesa_checkout_id, amount, started_at, completed_at FROM deposits WHERE id = $1 AND session_type = $2',
      [sessionId, 'withdrawal']
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const session = sessionRes.rows[0];

    // Dev checkout IDs are always complete
    if (session.mpesa_checkout_id && session.mpesa_checkout_id.startsWith('DEV_')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).json({ success: true, status: session.status, sessionId: session.id });
    }

    // If already completed or in_progress, payment was received
    if (session.status === 'in_progress' || session.status === 'completed') {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).json({ success: true, status: session.status, sessionId: session.id });
    }

    // If failed
    if (session.status === 'failed' || session.status === 'cancelled') {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.status(200).json({ success: false, status: session.status, sessionId: session.id });
    }

    // Still pending — optionally self-heal by querying M-Pesa
    if (session.mpesa_checkout_id && session.started_at) {
      const secondsSinceStart = (Date.now() - new Date(session.started_at)) / 1000;
      if (secondsSinceStart > 60) {
        try {
          const mpesaResponse = await querySTKStatus(session.mpesa_checkout_id);
          const { ResultCode } = mpesaResponse.data;
          // Safaricom returns ResultCode as a number (0); the callback handler
          // also treats it as such. Use a numeric compare to be safe.
          if (Number(ResultCode) === 0) {
            await completePaidWithdrawal(client, session.mpesa_checkout_id);
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            return res.status(200).json({ success: true, status: 'in_progress', sessionId: session.id });
          }
        } catch (e) {
          logger.warn(`[Admin Payment Status] M-Pesa query failed for session ${sessionId}: ${e.message}`);
        }
      }
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json({ success: false, status: session.status, sessionId: session.id });
  } catch (error) {
    logger.error('[Admin Payment Status] Failed:', error);
    return res.status(500).json({ error: 'Failed to check payment status.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;