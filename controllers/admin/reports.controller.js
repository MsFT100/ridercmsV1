const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

/**
 * GET /api/admin/problem-reports
 * @summary Retrieve user-submitted problem reports
 * @description Retrieves a paginated list of problem reports submitted by users. Can be filtered by status. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: status
 *     schema:
 *       type: string
 *       enum: [open, investigating, resolved, wont_fix]
 *     description: Filter reports by a specific status.
 *   - in: query
 *     name: limit
 *     schema:
 *       type: integer
 *       default: 50
 *     description: The number of reports to return.
 *   - in: query
 *     name: offset
 *     schema:
 *       type: integer
 *       default: 0
 *     description: The number of reports to skip for pagination.
 * @responses
 *   200:
 *     description: A list of problem reports.
 */
router.get('/problem-reports', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const status = req.query.status;
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    let query = `
      SELECT
        pr.id,
        pr.report_type AS "reportType",
        pr.description,
        pr.status,
        pr.created_at AS "createdAt",
        pr.resolved_at AS "resolvedAt",
        u.email AS "userEmail",
        b.booth_uid AS "boothUid",
        bs.slot_identifier AS "slotIdentifier",
        bat.battery_uid AS "batteryUid"
      FROM problem_reports pr
      JOIN users u ON pr.user_id = u.user_id
      LEFT JOIN booths b ON pr.booth_id = b.id
      LEFT JOIN booth_slots bs ON pr.slot_id = bs.id
      LEFT JOIN batteries bat ON pr.battery_id = bat.id
    `;
    const queryParams = [limit, offset];

    if (status) {
      query += ` WHERE pr.status = $3`;
      queryParams.splice(2, 0, status); // Insert status at the correct parameter index
    }

    query += ` ORDER BY pr.created_at DESC LIMIT $1 OFFSET $2;`;

    const { rows } = await client.query(query, queryParams);
    res.status(200).json(rows);
  } catch (error) {
    logger.error('Failed to get problem reports for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve problem reports.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/problem-reports/:reportId/status
 * @summary Update a problem report's status
 * @description Updates the status of a specific problem report. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: reportId
 *     required: true
 *     schema:
 *       type: integer
 *     description: The ID of the problem report to update.
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [status]
 *         properties:
 *           status:
 *             type: string
 *             enum: [open, investigating, resolved, wont_fix]
 * @responses
 *   200:
 *     description: Report status updated successfully.
 */
router.post('/problem-reports/:reportId/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { reportId } = req.params;
  const { status } = req.body;
  const validStatuses = ['open', 'investigating', 'resolved', 'wont_fix'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
      UPDATE problem_reports
      SET
        status = $1,
        resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;

    const result = await client.query(query, [status, reportId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Problem report with ID ${reportId} not found.` });
    }

    logger.info(`Admin (UID: ${req.user.uid}) updated problem report ${reportId} to status '${status}'.`);
    res.status(200).json({ message: 'Report status updated successfully.', report: result.rows[0] });
  } catch (error) {
    logger.error(`Failed to update status for problem report ${reportId}:`, error);
    res.status(500).json({ error: 'Failed to update report status.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
