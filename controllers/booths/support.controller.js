const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const logger = require('../../utils/logger');
const poolPromise = require('../../db');
const { verifyFirebaseToken } = require('../../middleware/auth');

const router = Router();

/**
 * POST /api/booths/cancel-session
 * @summary Cancel an active user session
 * @description Allows a user to cancel their own active session (e.g., 'pending', 'in_progress', 'opening'). A deposit's reserved slot is freed and made available for another user; an unpaid withdrawal leaves its slot untouched because the rider's battery is still inside.
 * Pass `sessionId` in the body to cancel exactly that session. Without it the newest deposit awaiting the booth is cancelled, then an unpaid withdrawal, then an uncollected rental. A rental that is out with the rider is never cancelled here.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         properties:
 *           sessionId:
 *             type: integer
 *             description: Optional. The session to cancel.
 * @responses
 *   200:
 *     description: Session cancelled (or nothing to cancel / already cancelled).
 *   400:
 *     description: Invalid sessionId.
 *   404:
 *     description: The given sessionId does not belong to the user.
 *   409:
 *     description: The session is paid, completed, or an active rental and cannot be cancelled.
 *   500:
 *     description: Internal server error.
 */
router.post('/cancel-session', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;

  // Optional: cancel exactly this session. Without it the endpoint falls back to
  // the rider's most recent cancellable session (see the ordering below).
  const rawSessionId = req.body?.sessionId;
  const requestedId = rawSessionId === undefined || rawSessionId === null ? null : Number(rawSessionId);
  if (requestedId !== null && (!Number.isInteger(requestedId) || requestedId <= 0)) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    await client.query('BEGIN');

    // 1. Find the session to cancel. Several can be active at once (a charging
    // rider may also hold a rental or an unpaid withdrawal), so the choice must
    // be deterministic: the newest deposit still waiting on the booth comes
    // first, then an unpaid withdrawal, then a not-yet-collected rental. An
    // in-use rental is never picked implicitly. The row is locked so a booth ACK
    // cannot complete it mid-cancel.
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
      WHERE d.user_id = $1
        AND d.status IN ('pending', 'in_progress', 'opening')
        AND ($2::int IS NULL OR d.id = $2::int)
        AND ($2::int IS NOT NULL OR NOT (d.session_type = 'rental' AND d.status = 'in_progress'))
      ORDER BY
        CASE
          WHEN d.session_type = 'deposit' AND d.status IN ('pending', 'opening') THEN 0
          WHEN d.session_type = 'withdrawal' AND d.status = 'pending' THEN 1
          WHEN d.session_type = 'rental' AND d.status = 'pending' THEN 2
          ELSE 3
        END,
        d.created_at DESC,
        d.id DESC
      LIMIT 1
      FOR UPDATE OF d;
    `;
    const sessionRes = await client.query(sessionQuery, [firebaseUid, requestedId]);

    if (sessionRes.rows.length === 0) {
      if (requestedId !== null) {
        // Explain why that specific session could not be cancelled instead of
        // reporting success for a session that may have completed.
        const known = await client.query(
          'SELECT status FROM deposits WHERE id = $1 AND user_id = $2',
          [requestedId, firebaseUid]
        );
        await client.query('ROLLBACK');
        if (known.rows.length === 0) {
          return res.status(404).json({ error: 'Session not found.' });
        }
        const knownStatus = known.rows[0].status;
        if (knownStatus === 'cancelled' || knownStatus === 'failed') {
          return res.status(200).json({ message: 'This session was already cancelled.' });
        }
        return res.status(409).json({
          error: 'Session cannot be cancelled.',
          message: `This session is already ${knownStatus} and can no longer be cancelled.`,
        });
      }
      await client.query('ROLLBACK');
      return res.status(200).json({ message: 'No active session to cancel. You are all clear.' });
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

    // A rental that is out with the rider is billed, not cancelled.
    if (sessionType === 'rental' && sessionStatus === 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Cannot cancel an active rental.',
        message: 'Return the rental battery and pay the bill to finish this rental.'
      });
    }

    // 3. Mark the session as 'cancelled' in the database.
    await client.query("UPDATE deposits SET status = 'cancelled' WHERE id = $1", [sessionId]);

    // 4. Free the slot that was reserved for the session. A withdrawal never
    // reserves a slot: the rider's own battery is still inside it, so marking it
    // 'available' would let the booth assign it to someone else.
    if (sessionType !== 'withdrawal') {
      await client.query("UPDATE booth_slots SET status = 'available' WHERE id = $1", [slotId]);
    }

    // 5. Send a command to Firebase to ensure any door opening commands are cancelled.
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
  const client = await pool.connect(req.schema);
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
  const client = await pool.connect(req.schema);
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
