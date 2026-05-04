const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

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

module.exports = router;