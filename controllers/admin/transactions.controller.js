const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

/**
 * GET /api/admin/transactions
 * @summary Get all transactions
 * @description Retrieves a paginated list of all transactions (deposits and withdrawals) across the entire system. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: limit
 *     schema:
 *       type: integer
 *       default: 50
 *     description: The number of transactions to return.
 *   - in: query
 *     name: offset
 *     schema:
 *       type: integer
 *       default: 0
 *     description: The number of transactions to skip for pagination.
 * @responses
 *   200:
 *     description: A paginated list of transactions.
 */
router.get('/transactions', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        d.id AS "txId",
        d.session_type AS "type",
        d.status,
        d.started_at AS "date",
        d.mpesa_checkout_id AS "paymentId",
        u.name AS "userName",
        u.email AS "userEmail",
        b.booth_uid AS "boothUid",
        s.slot_identifier AS "slotIdentifier",
        bat.battery_uid AS "batteryUid"
      FROM deposits d
      JOIN users u ON d.user_id = u.user_id
      LEFT JOIN booths b ON d.booth_id = b.id
      LEFT JOIN booth_slots s ON d.slot_id = s.id
      LEFT JOIN batteries bat ON d.battery_id = bat.id
      ORDER BY d.started_at DESC
      LIMIT $1 OFFSET $2;
    `;

    const countQuery = 'SELECT COUNT(*) FROM deposits;';

    const [transactionsResult, totalCountResult] = await Promise.all([
      client.query(query, [limit, offset]),
      client.query(countQuery),
    ]);

    res.status(200).json({
      transactions: transactionsResult.rows,
      total: parseInt(totalCountResult.rows[0].count, 10),
    });
  } catch (error) {
    logger.error('Failed to get transactions for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve transactions.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
