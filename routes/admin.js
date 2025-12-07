const { Router } = require('express');
const { admin } = require('../utils/firebase');
const logger = require('../utils/logger');
const { verifyFirebaseToken, isAdmin } = require('../middleware/auth');
const pool = require('../db');

const router = Router();

/**
 * POST /api/admin/users/set-role
 * Sets a custom role for a specified user.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.post('/users/set-role', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid, newRole } = req.body;
  const validRoles = ['admin', 'customer', 'driver']; // Define your application's roles

  if (!uid || !newRole) {
    return res.status(400).json({ error: 'Both uid and newRole are required.' });
  }

  if (!validRoles.includes(newRole)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
  }

  try {
    // Set the custom claim on the target user.
    await admin.auth().setCustomUserClaims(uid, { role: newRole });

    logger.info(`Admin (UID: ${req.user.uid}) changed role for user (UID: ${uid}) to '${newRole}'.`);
    res.status(200).json({ message: `Successfully set role for user ${uid} to ${newRole}.` });
  } catch (error) {
    logger.error(`Failed to set role for user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to set user role.', details: error.message });
  }
});

/**
 * GET /api/admin/users
 * Retrieves a paginated list of all users.
 * Protected route: Only accessible by users with the 'admin' role.
 * @query {number} [pageSize=100] - The number of users to fetch per page (max 1000).
 * @query {string} [pageToken] - The token for fetching the next page of results.
 */
router.get('/users', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 100, 1000);
  const pageToken = req.query.pageToken || undefined;

  try {
    const listUsersResult = await admin.auth().listUsers(pageSize, pageToken);

    // Map the full user records to a more concise format for the response.
    const users = listUsersResult.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName,
      role: userRecord.customClaims?.role || 'customer', // Default to 'customer' if no role is set
      disabled: userRecord.disabled,
      creationTime: userRecord.metadata.creationTime,
      lastSignInTime: userRecord.metadata.lastSignInTime,
    }));

    res.status(200).json({
      users,
      nextPageToken: listUsersResult.pageToken, // Send this token back to the client for the next request
    });
  } catch (error) {
    logger.error('Failed to list users:', error);
    res.status(500).json({ error: 'Failed to retrieve user list.', details: error.message });
  }
});

/**
 * POST /api/admin/users/set-status
 * Activates or deactivates a user, blocking them from logging in.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.post('/users/set-status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid, status } = req.body;
  const validStatuses = ['active', 'inactive', 'suspended'];

  if (!uid || !status) {
    return res.status(400).json({ error: 'Both uid and status are required.' });
  }

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  // 'inactive' or 'suspended' in our DB means 'disabled' in Firebase Auth.
  const isDisabled = status !== 'active';

  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // 1. Update Firebase Auth user state
    await admin.auth().updateUser(uid, { disabled: isDisabled });

    // 2. Update PostgreSQL user status
    const result = await pgClient.query("UPDATE users SET status = $1 WHERE user_id = $2", [status, uid]);

    if (result.rowCount === 0) {
      throw new Error(`User with UID ${uid} not found in the database.`);
    }

    await pgClient.query('COMMIT');
    logger.info(`Admin (UID: ${req.user.uid}) updated status for user (UID: ${uid}) to '${status}'. Firebase disabled: ${isDisabled}.`);
    res.status(200).json({ message: `Successfully set status for user ${uid} to '${status}'.` });
  } catch (error) {
    await pgClient.query('ROLLBACK');
    logger.error(`Failed to update status for user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to update user status.', details: error.message });
  } finally {
    pgClient.release();
  }
});

/**
 * GET /api/admin/booths/status
 * Retrieves a comprehensive status of all booths, their slots, and the batteries within them.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.get('/booths/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        bo.booth_uid,
        bo.location_address,
        bo.status as booth_status,
        bs.slot_identifier,
        bs.status as slot_status,
        bat.battery_uid,
        bat.charge_level_percent,
        u.email as battery_owner_email
      FROM booths bo
      LEFT JOIN booth_slots bs ON bo.id = bs.booth_id
      LEFT JOIN batteries bat ON bs.current_battery_id = bat.id
      LEFT JOIN users u ON bat.user_id = u.user_id
      ORDER BY bo.booth_uid, bs.slot_identifier;
    `;

    const { rows } = await client.query(query);

    // Process the flat list of rows into a structured, nested object for a cleaner API response.
    const boothsStatus = rows.reduce((acc, row) => {
      // Find or create the booth entry in the accumulator
      let booth = acc.find(b => b.boothUid === row.booth_uid);
      if (!booth) {
        booth = {
          boothUid: row.booth_uid,
          location: row.location_address,
          status: row.booth_status,
          slots: []
        };
        acc.push(booth);
      }

      // Add the slot information to the current booth
      booth.slots.push({
        slotIdentifier: row.slot_identifier,
        status: row.slot_status,
        battery: row.battery_uid ? {
          batteryUid: row.battery_uid,
          chargeLevel: row.charge_level_percent,
          ownerEmail: row.battery_owner_email
        } : null
      });

      return acc;
    }, []);

    res.status(200).json(boothsStatus);
  } catch (error) {
    logger.error('Failed to get booths status for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve booths status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/problem-reports
 * Retrieves a list of problem reports submitted by users.
 * Protected route: Only accessible by users with the 'admin' role.
 * @query {string} [status] - Filter reports by status (e.g., 'open', 'investigating', 'resolved').
 * @query {number} [limit=50] - Number of reports to return.
 * @query {number} [offset=0] - Number of reports to skip for pagination.
 */
router.get('/problem-reports', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const status = req.query.status;
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;

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
 * Updates the status of a specific problem report.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.post('/problem-reports/:reportId/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { reportId } = req.params;
  const { status } = req.body;
  const validStatuses = ['open', 'investigating', 'resolved', 'wont_fix'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

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

/**
 * GET /api/admin/transactions
 * Retrieves a paginated list of all transactions (deposits and withdrawals).
 * Protected route: Only accessible by users with the 'admin' role.
 * @query {number} [limit=50] - Number of transactions to return.
 * @query {number} [offset=0] - Number of transactions to skip for pagination.
 */
router.get('/transactions', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;

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

/**
 * GET /api/admin/settings
 * Retrieves all application settings.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.get('/settings', [verifyFirebaseToken, isAdmin], async (req, res) => {
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
 * Updates one or more application settings.
 * Protected route: Only accessible by users with the 'admin' role.
 */
router.post('/settings', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const newSettings = req.body; // e.g., { "pricing": { "base_swap_fee": 6 }, "withdrawal_rules": { "min_charge_level": 90 } }

  if (Object.keys(newSettings).length === 0) {
    return res.status(400).json({ error: 'No settings provided to update.' });
  }

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