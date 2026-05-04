const { Router } = require('express');
const logger = require('../../utils/logger');
const poolPromise = require('../../db');
const { verifyFirebaseToken } = require('../../middleware/auth');

const router = Router();

/**
 * GET /api/booths
 * @summary Get a list of all public booths
 * @description Retrieves a list of all 'online' booths with their location and available slot count.
 * This is a public endpoint for users to find nearby stations.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: A list of available booths.
 *   500:
 *     description: Internal server error.
 */
router.get('/', verifyFirebaseToken, async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // This query fetches all online booths and counts their available slots.
    // It assumes you have 'latitude' and 'longitude' columns in your 'booths' table.
    const query = `
      SELECT
        b.booth_uid,
        b.name,
        b.location_address,
        b.latitude,
        b.longitude,
        (
          SELECT COUNT(*)
          FROM booth_slots bs
          WHERE bs.booth_id = b.id AND bs.status = 'available'
        ) AS "availableSlots"
      FROM booths b
      WHERE b.status = 'online';
    `;

    const { rows } = await client.query(query);

    res.status(200).json(rows);
  } catch (error) {
    logger.error('Failed to get public list of booths:', error);
    res.status(500).json({ error: 'Failed to retrieve booth list.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/:boothUid/slots/:slotIdentifier
 * @summary Get specific details of a booth slot
 * @description Retrieves charging status, SOC, and the user currently associated with a specific slot.
 * @tags [Booths]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *   - in: path
 *     name: slotIdentifier
 *     required: true
 *     schema:
 *       type: string
 * @responses
 *   200:
 *     description: Slot details retrieved successfully.
 *   404:
 *     description: Booth or slot not found.
 */
router.get('/:boothUid/slots/:slotIdentifier', verifyFirebaseToken, async (req, res) => {
  const { boothUid, slotIdentifier } = req.params;
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    const query = `
      SELECT
        s.slot_identifier AS "slotIdentifier",
        s.is_charging AS "isCharging",
        s.charge_level_percent AS "chargeLevel",
        s.status,
        u.name AS "userName",
        (
          SELECT COALESCE(json_agg(history), '[]'::json)
          FROM (
            SELECT
              usr.name AS "userName",
              dep.completed_at AS "completedAt"
            FROM deposits dep
            JOIN users usr ON dep.user_id = usr.user_id
            WHERE dep.slot_id = s.id
              AND dep.session_type = 'deposit'
              AND dep.status = 'completed'
              AND dep.completed_at >= NOW() - INTERVAL '30 days'
            ORDER BY dep.completed_at DESC
          ) history
        ) AS "usageHistory"
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      LEFT JOIN LATERAL (
        SELECT d.user_id
        FROM deposits d
        WHERE d.slot_id = s.id
          AND d.session_type = 'deposit'
          AND d.status = 'completed'
        ORDER BY d.completed_at DESC
        LIMIT 1
      ) last_dep ON true
      LEFT JOIN users u ON last_dep.user_id = u.user_id
      WHERE b.booth_uid = $1 AND s.slot_identifier = $2;
    `;

    const { rows } = await client.query(query, [boothUid, slotIdentifier]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booth or slot not found.' });
    }

    res.status(200).json(rows[0]);
  } catch (error) {
    logger.error(`Failed to get slot details for ${boothUid}/${slotIdentifier}:`, error);
    res.status(500).json({ error: 'Failed to retrieve slot details.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
