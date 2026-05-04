const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

/**
 * GET /api/admin/settings
 * @summary Retrieve all application settings
 * @description Retrieves all key-value application settings from the database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: An object containing all application settings.
 */
router.get('/settings', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT key, value FROM app_settings');

    // Convert the array of key-value pairs into a single settings object
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    res.status(200).json(settings);
  } catch (error) {
    logger.error('Failed to get app settings for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve application settings.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/settings
 * @summary Update application settings
 * @description Updates one or more application settings. The request body should be an object where keys are the setting keys and values are the new setting values. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   description: An object containing the settings to update.
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         example:
 *           pricing: { "base_swap_fee": 6.50, "cost_per_charge_percent": 12.00 }
 * @responses
 *   200:
 *     description: Settings updated successfully.
 */
router.post('/settings', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const newSettings = req.body; // e.g., { "pricing": { "base_swap_fee": 6 }, "withdrawal_rules": { "min_charge_level": 90 } }

  if (Object.keys(newSettings).length === 0) {
    return res.status(400).json({ error: 'No settings provided to update.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upsertQuery = `
      INSERT INTO app_settings (key, value)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = $2::jsonb;
    `;

    for (const [key, value] of Object.entries(newSettings)) {
      await client.query(upsertQuery, [key, JSON.stringify(value)]);
    }

    await client.query('COMMIT');
    logger.info(`Admin (UID: ${req.user.uid}) updated application settings: ${Object.keys(newSettings).join(', ')}`);
    res.status(200).json({ message: 'Application settings updated successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to update app settings:', error);
    res.status(500).json({ error: 'Failed to update application settings.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
