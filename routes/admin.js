const { Router } = require('express');
const { admin } = require('../utils/firebase');
const logger = require('../utils/logger');
const { verifyFirebaseToken, isAdmin } = require('../middleware/auth');
const { getDatabase } = require('firebase-admin/database');
const poolPromise = require('../db');
const { v4: uuidv4 } = require('uuid'); // Import the UUID library

const router = Router();

/**
 * POST /api/admin/users/set-role
 * @summary Set a custom role for a user
 * @description Sets a custom role for a specified user in Firebase Authentication custom claims. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required:
 *           - uid
 *           - newRole
 *         properties:
 *           uid:
 *             type: string
 *             description: The Firebase UID of the target user.
 *           newRole:
 *             type: string
 *             description: The new role to assign.
 *             enum: [admin, customer, driver]
 * @responses
 *   200:
 *     description: Role updated successfully.
 *   400:
 *     description: Bad request (e.g., missing parameters, invalid role).
 *   401:
 *     description: Unauthorized (token missing or invalid).
 *   403:
 *     description: Forbidden (user is not an admin).
 *   500:
 *     description: Internal server error.
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
 * @summary List all users
 * @description Retrieves a paginated list of all users from Firebase Authentication. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: pageSize
 *     schema:
 *       type: integer
 *       default: 100
 *     description: The number of users to fetch per page (max 1000).
 *   - in: query
 *     name: pageToken
 *     schema:
 *       type: string
 *     description: The token for fetching the next page of results, obtained from a previous request.
 * @responses
 *   200:
 *     description: A list of users.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             users:
 *               type: array
 *               items:
 *                 type: object
 *             nextPageToken:
 *               type: string
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
 * @summary Activate, deactivate, or suspend a user
 * @description Activates or deactivates a user in both Firebase Authentication (enabling/disabling their login) and the local PostgreSQL database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required:
 *           - uid
 *           - status
 *         properties:
 *           uid:
 *             type: string
 *             description: The Firebase UID of the target user.
 *           status:
 *             type: string
 *             description: The new status for the user. 'inactive' or 'suspended' will disable the user.
 *             enum: [active, inactive, suspended]
 * @responses
 *   200:
 *     description: User status updated successfully.
 *   400:
 *     description: Bad request (e.g., missing parameters, invalid status).
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

  const pool = await poolPromise;
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
 * GET /api/admin/booths
 * @summary Get a list of all booths
 * @description Retrieves a paginated list of all registered booths in the system. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: limit
 *     schema:
 *       type: integer
 *       default: 25
 *     description: The number of booths to return per page.
 *   - in: query
 *     name: offset
 *     schema:
 *       type: integer
 *       default: 0
 *     description: The number of booths to skip for pagination.
 * @responses
 *   200:
 *     description: A paginated list of booths.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             booths:
 *               type: array
 *               items:
 *                 type: object
 *             total:
 *               type: integer
 *   500:
 *     description: Internal server error.
 */
router.get('/booths', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 25;
  const offset = parseInt(req.query.offset, 10) || 0;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const listQuery = `
      SELECT booth_uid, name, location_address, status, created_at, updated_at
      FROM booths
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `;
    const countQuery = 'SELECT COUNT(*) FROM booths;';

    // Execute both queries in parallel for efficiency
    const [boothsResult, totalCountResult] = await Promise.all([
      client.query(listQuery, [limit, offset]),
      client.query(countQuery),
    ]);

    res.status(200).json({
      booths: boothsResult.rows,
      total: parseInt(totalCountResult.rows[0].count, 10),
    });
  } catch (error) {
    logger.error('Failed to get list of booths for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve booths list.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/booths/status
 * @summary Get status of all booths and slots
 * @description Retrieves a comprehensive, nested status of all booths, their slots, and any batteries currently within those slots. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: A structured list of all booths and their current status.
 *   500:
 *     description: Internal server error.
 */
router.get('/booths/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
      SELECT
        bo.booth_uid,
        bo.name,
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
          name: row.name,
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
 * Generates the initial data structure for 15 slots in a new booth.
 * @returns {object} An object containing 15 slots with default values.
 */
function initializeFirebaseSlots() {
  const slots = {};
  const defaultSlotData = {
    battery: false,
    command: {
      ack: "",
      forceLock: false,
      forceUnlock: false,
      lastScannedSerial: "",
      openDoorId: "",
      openForCollection: false,
      openForDeposit: false,
      startCharging: false,
      stopCharging: false
    },
    devicePresent: false,
    doorClosed: true,
    doorLocked: true,
    events: {},
    initial_soc: 0,
    initial_voltage: 0,
    pendingCmd: false,
    rejection: {},
    relay: "OFF",
    soc: 0,
    status: "booting", // Or 'available'
    telemetry: {
      batteryInserted: false,
      doorClosed: true,
      doorLocked: true,
      plugConnected: false,
      qr: "",
      relayOn: false,
      soc: 0,
      temperature: 0,
      temperatureC: 0,
      timestamp: 0,
      voltage: 0
    }
  };

  for (let i = 1; i <= 15; i++) {
    const slotIdentifier = `slot${String(i).padStart(3, '0')}`; // e.g., slot001
    slots[slotIdentifier] = { ...defaultSlotData };
  }
  return slots;
}

/**
 * POST /api/admin/booths
 * @summary Create a new booth
 * @description Creates a new booth in both PostgreSQL and Firebase Realtime Database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [name, locationAddress]
 *         properties:
 *           name:
 *             type: string
 *             description: A descriptive name for the booth (e.g., "Mall Entrance Booth").
 *           locationAddress:
 *             type: string
 *             description: The physical address or location of the booth.
 * @responses
 *   201:
 *     description: Booth created successfully. Returns the new booth's UID.
 *   400:
 *     description: Bad request (e.g., missing parameters).
 *   500:
 *     description: Internal server error.
 */
router.post('/booths', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { name, locationAddress } = req.body;

  if (!name || !locationAddress) {
    return res.status(400).json({ error: 'Booth name and locationAddress are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // 1. Generate a new UUID for the booth.
    const boothUid = uuidv4();

    // 2. Insert the new booth into PostgreSQL with the generated UID.
    const boothRes = await client.query(
      "INSERT INTO booths (booth_uid, name, location_address, status) VALUES ($1, $2, $3, 'online') RETURNING booth_uid",
      [boothUid, name, locationAddress]
    );

    // 2. Create the corresponding structure in Firebase Realtime Database
    const db = getDatabase();
    const newBoothRef = db.ref(`booths/${boothUid}`);
    await newBoothRef.set({ slots: initializeFirebaseSlots() });

    logger.info(`Admin (UID: ${req.user.uid}) created new booth '${name}' with UID '${boothUid}'.`);
    res.status(201).json({ message: 'Booth created successfully.', boothUid: boothUid });
  } catch (error) {
    logger.error(`Failed to create new booth:`, error);
    res.status(500).json({ error: 'Failed to create booth.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/admin/booths/:boothUid
 * @summary Update a booth's details
 * @description Updates a booth's name and/or location address. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth to update.
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         properties:
 *           name:
 *             type: string
 *             description: The new descriptive name for the booth.
 *           locationAddress:
 *             type: string
 *             description: The new physical address or location of the booth.
 * @responses
 *   200:
 *     description: Booth updated successfully.
 *   400:
 *     description: Bad request (e.g., no fields to update).
 *   404:
 *     description: Booth not found.
 *   500:
 *     description: Internal server error.
 */
router.patch('/booths/:boothUid', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid } = req.params;
  const { name, locationAddress } = req.body;

  if (!name && !locationAddress) {
    return res.status(400).json({ error: 'At least one field (name or locationAddress) must be provided to update.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const setClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (name) {
      setClauses.push(`name = $${paramIndex++}`);
      queryParams.push(name);
    }
    if (locationAddress) {
      setClauses.push(`location_address = $${paramIndex++}`);
      queryParams.push(locationAddress);
    }

    const updateQuery = `UPDATE booths SET ${setClauses.join(', ')}, updated_at = NOW() WHERE booth_uid = $${paramIndex} RETURNING *`;
    queryParams.push(boothUid);

    const result = await client.query(updateQuery, queryParams);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }

    logger.info(`Admin (UID: ${req.user.uid}) updated details for booth '${boothUid}'.`);
    res.status(200).json({ message: 'Booth updated successfully.', booth: result.rows[0] });
  } catch (error) {
    logger.error(`Failed to update booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to update booth.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/booths/:boothUid/status
 * @summary Update a booth's status
 * @description Updates the operational status of a specific booth (e.g., to take it offline for maintenance). This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth to update.
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
 *             description: The new operational status for the booth.
 *             enum: [online, maintenance, offline]
 * @responses
 *   200:
 *     description: Booth status updated successfully.
 *   400:
 *     description: Bad request (e.g., invalid status).
 *   404:
 *     description: Booth not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/booths/:boothUid/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid } = req.params;
  const { status } = req.body;
  const validStatuses = ['online', 'maintenance', 'offline'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const updateQuery = `UPDATE booths SET status = $1, updated_at = NOW() WHERE booth_uid = $2 RETURNING *`;
    const result = await client.query(updateQuery, [status, boothUid]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }

    logger.info(`Admin (UID: ${req.user.uid}) updated status for booth '${boothUid}' to '${status}'.`);
    res.status(200).json({ message: 'Booth status updated successfully.', booth: result.rows[0] });
  } catch (error) {
    logger.error(`Failed to update status for booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to update booth status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/booths/:boothUid
 * @summary Get details of a single booth by UID
 * @description Retrieves details of a specific booth using its UID. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth to retrieve.
 * @responses
 *   200:
 *     description: Details of the booth.
 *   404:
 *     description: Booth not found.
 *   500:
 *     description: Internal server error.
 */
router.get('/booths/:boothUid', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid } = req.params;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const query = `
      SELECT booth_uid, name, location_address, status, created_at, updated_at
      FROM booths
      WHERE booth_uid = $1;
    `;

    const { rows } = await client.query(query, [boothUid]);

    if (rows.length === 0) {
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }

    res.status(200).json(rows[0]);
  } catch (error) {
    logger.error(`Failed to get booth ${boothUid} for admin:`, error);
    res.status(500).json({ error: 'Failed to retrieve booth.', details: error.message });
  } finally {
    client.release();
  }
});




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