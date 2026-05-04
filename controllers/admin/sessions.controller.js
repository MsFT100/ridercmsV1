const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

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
 *     description: Search by user email or name.
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
      whereClauses.push(`(u.email ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex++})`);
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
        u.email AS "userEmail", b.booth_uid AS "boothUid", s.slot_identifier AS "slotIdentifier",
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

module.exports = router;
