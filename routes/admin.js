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
 * DELETE /api/admin/users/:uid
 * @summary Delete a user
 * @description Deletes a user from both Firebase Authentication and the local PostgreSQL database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: uid
 *     required: true
 *     schema:
 *       type: string
 *     description: The Firebase UID of the user to delete.
 * @responses
 *   200:
 *     description: User deleted successfully.
 *   404:
 *     description: User not found.
 *   500:
 *     description: Internal server error.
 */
router.delete('/users/:uid', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid } = req.params;

  const pool = await poolPromise;
  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // 1. Delete the user from Firebase Authentication first.
    // If this fails, the transaction will be rolled back and nothing will happen in the local DB.
    await admin.auth().deleteUser(uid);

    // 2. If Firebase deletion is successful, delete the user from the PostgreSQL database.
    // The ON DELETE CASCADE constraint on the users table should handle related records.
    const deleteResult = await pgClient.query('DELETE FROM users WHERE user_id = $1', [uid]);

    if (deleteResult.rowCount === 0) {
      // If no rows were deleted, the user didn't exist in our DB.
      // This is not a critical error, as the primary record in Firebase Auth was just deleted.
      logger.warn(`User (UID: ${uid}) was deleted from Firebase Auth but was not found in the local PostgreSQL database.`);
    }

    // 3. If both operations succeed, commit the transaction.
    await pgClient.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) successfully deleted user (UID: ${uid}).`);
    res.status(200).json({ message: `User ${uid} deleted successfully.` });
  } catch (error) {
    await pgClient.query('ROLLBACK');
    logger.error(`Failed to delete user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to delete user. The operation was rolled back.', details: error.message });
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
    // This query now joins with booth_slots and batteries to get all necessary info.
    // It uses a window function to get the total count of booths efficiently.
    const listQuery = `
      SELECT
        b.booth_uid, b.name, b.location_address, b.status, b.created_at, b.updated_at, b.latitude, b.longitude,
        s.slot_identifier, s.status as slot_status, s.door_status, s.charge_level_percent as slot_charge_level,
        bat.battery_uid,
        COUNT(*) OVER() as total_booths
      FROM (
        SELECT * FROM booths ORDER BY created_at DESC LIMIT $1 OFFSET $2
      ) b
      LEFT JOIN booth_slots s ON b.id = s.booth_id
      LEFT JOIN batteries bat ON s.current_battery_id = bat.id
      ORDER BY b.created_at DESC, s.slot_identifier;
    `;

    const countQuery = 'SELECT COUNT(*) FROM booths;';

    const [boothsResult, totalCountResult] = await Promise.all([
      client.query(listQuery, [limit, offset]),
      client.query(countQuery)
    ]);

    // Process the flat list of rows into a structured, nested object.
    const booths = boothsResult.rows.reduce((acc, row) => {
      let booth = acc.find(b => b.booth_uid === row.booth_uid);
      if (!booth) {
        booth = {
          booth_uid: row.booth_uid,
          name: row.name,
          location_address: row.location_address,
          status: row.status,
          created_at: row.created_at,
          latitude: row.latitude,
          longitude: row.longitude,
          updated_at: row.updated_at,
          slots: [],
          slotCount: 0
        };
        acc.push(booth);
      }

      if (row.slot_identifier) {
        booth.slots.push({
          identifier: row.slot_identifier,
          status: row.slot_status,
          doorStatus: row.door_status,
          chargeLevel: row.slot_charge_level,
          batteryUid: row.battery_uid
        });
        booth.slotCount++;
      }
      return acc;
    }, []);

    res.status(200).json({
      booths: booths,
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
  const pgClient = await pool.connect();
  try {
    // 1. Get all booths from PostgreSQL to know which UIDs to query in Firebase.
    // Also fetch slot, battery, and user details to get the user's name for each occupied slot.
    const boothsResult = await pgClient.query(`
      SELECT
        b.booth_uid, b.name, b.location_address, b.status, b.updated_at,
        s.slot_identifier,
        u.name as user_name
      FROM booths b
      LEFT JOIN booth_slots s ON b.id = s.booth_id
      LEFT JOIN batteries bat ON s.current_battery_id = bat.id
      LEFT JOIN users u ON bat.user_id = u.user_id
      ORDER BY b.name, s.slot_identifier;
    `);
    const boothsFromDb = boothsResult.rows;

    const db = getDatabase();

    // 2. Fetch real-time data from Firebase for each booth.
    const boothStatusPromises = boothsFromDb.map(async (booth) => {
      const boothRef = db.ref(`booths/${booth.booth_uid}`);
      const snapshot = await boothRef.get();

      const boothData = {
        boothUid: booth.booth_uid,
        name: booth.name,
        location: booth.location_address,
        status: booth.status, // The overall status from our DB
        // Use the live status from Firebase if available, otherwise fallback to DB status.
        status: snapshot.exists() && snapshot.val().status
          ? snapshot.val().status
          : booth.status,
        lastHeartbeatAt: booth.updated_at,
        slots: [],
      };

      if (snapshot.exists()) {
        const firebaseBooth = snapshot.val();
        if (firebaseBooth.slots) {
          // Create a map of slotIdentifier -> userName for this booth for easy lookup.
          const slotUserNameMap = boothsFromDb
            .filter(row => row.booth_uid === booth.booth_uid && row.slot_identifier)
            .reduce((acc, row) => {
              acc[row.slot_identifier] = row.user_name;
              return acc;
            }, {});

          // Map over the slots from Firebase to get the most real-time data.
          boothData.slots = Object.entries(firebaseBooth.slots).map(([slotIdentifier, slotData]) => {
            const telemetry = slotData.telemetry || {};
            const isCharging = telemetry.relayOn === true;
            return {
              slotIdentifier: slotIdentifier,
              // Use live data from Firebase for these critical fields
              status: slotData.status || 'unknown',
              doorStatus: telemetry.doorLocked ? 'locked' : (telemetry.doorClosed ? 'closed' : 'open'),
              relayState: telemetry.relayOn ? 'ON' : 'OFF',
              isCharging: isCharging,
              userName: slotUserNameMap[slotIdentifier] || null, // Add user's name here
              telemetry: telemetry,
              // The battery object contains the most up-to-date info
              battery: {
                isOccupied: slotData.battery === true || slotData.devicePresent === true,
                chargeLevel: telemetry.soc || 0,
                voltage: telemetry.voltage,
                temperature: telemetry.temperatureC,
              }
            };
          });
        }
      } else {
        logger.warn(`Booth ${booth.booth_uid} exists in PostgreSQL but not in Firebase.`);
      }
      // Sort slots for a consistent UI
      boothData.slots.sort((a, b) => a.slotIdentifier.localeCompare(b.slotIdentifier));
      return boothData;
    });

    // Consolidate the results into a unique list of booths, as the initial DB query can have multiple rows per booth.
    const uniqueBooths = (await Promise.all(boothStatusPromises)).filter((booth, index, self) =>
      index === self.findIndex((b) => b.boothUid === booth.boothUid)
    );

    res.status(200).json(uniqueBooths);
  } catch (error) {
    logger.error('Failed to get booths status for admin:', error);
    res.status(500).json({ error: 'Failed to retrieve booths status.', details: error.message });
  } finally {
    pgClient.release();
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
  const { name, locationAddress, latitude, longitude } = req.body;

  if (!name || !locationAddress) {
    return res.status(400).json({ error: 'Booth name and locationAddress are required.' });
  }
  if (latitude && isNaN(parseFloat(latitude))) {
    return res.status(400).json({ error: 'Latitude must be a valid number.' });
  }
  if (longitude && isNaN(parseFloat(longitude))) {
    return res.status(400).json({ error: 'Longitude must be a valid number.' });
  }

  console.log('Creating new booth with data:', { name, locationAddress, latitude, longitude });

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // Start a transaction to ensure both DBs are updated or neither are.
    await client.query('BEGIN');

    // 1. Generate a new UUID for the booth.
    const boothUid = uuidv4();

    // 2. Insert the new booth into PostgreSQL with the generated UID.
    const boothInsertResult = await client.query(
      "INSERT INTO booths (booth_uid, name, location_address, latitude, longitude, status) VALUES ($1, $2, $3, $4, $5,'online') RETURNING id",
      [boothUid, name, locationAddress, latitude, longitude]
    );
    const newBoothId = boothInsertResult.rows[0].id;

    // 3. Create the corresponding slots in the PostgreSQL `booth_slots` table.
    const firebaseSlots = initializeFirebaseSlots();
    const slotInsertQuery = 'INSERT INTO booth_slots (booth_id, slot_identifier, status, door_status) VALUES ($1, $2, $3, $4)';

    // Use Promise.all to run inserts in parallel for efficiency.
    const slotInsertPromises = Object.keys(firebaseSlots).map(slotIdentifier => {
      // The default status in the DB is 'available', and door is 'closed'.
      // This matches the initial state from Firebase.
      return client.query(slotInsertQuery, [newBoothId, slotIdentifier, 'available', 'closed']);
    });
    await Promise.all(slotInsertPromises);

    // 4. Create the corresponding structure in Firebase Realtime Database.
    const db = getDatabase();
    const newBoothRef = db.ref(`booths/${boothUid}`);
    await newBoothRef.set({ slots: firebaseSlots });

    // 5. If all operations succeed, commit the transaction.
    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) created new booth '${name}' with UID '${boothUid}'.`);
    res.status(201).json({ message: 'Booth created successfully.', boothUid: boothUid });
  } catch (error) {
    await client.query('ROLLBACK'); // Rollback the transaction on any error.
    logger.error(`Failed to create new booth:`, error);
    res.status(500).json({ error: 'Failed to create new booth. The operation was rolled back.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/booths/:boothUid
 * @summary Delete a booth
 * @description Deletes a booth from both PostgreSQL and Firebase Realtime Database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth to delete.
 * @responses
 *   200:
 *     description: Booth deleted successfully.
 *   404:
 *     description: Booth not found.
 *   500:
 *     description: Internal server error.
 */
router.delete('/booths/:boothUid', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid } = req.params;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete from PostgreSQL. The ON DELETE CASCADE will handle related booth_slots.
    const deleteResult = await client.query('DELETE FROM booths WHERE booth_uid = $1 RETURNING name', [boothUid]);

    if (deleteResult.rowCount === 0) {
      // If no rows are deleted, the booth doesn't exist. No need to proceed.
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }
    const boothName = deleteResult.rows[0].name;

    // 2. Delete from Firebase Realtime Database.
    const db = getDatabase();
    const boothRef = db.ref(`booths/${boothUid}`);
    await boothRef.remove();

    // 3. If both succeed, commit the transaction.
    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) deleted booth '${boothName}' (UID: ${boothUid}).`);
    res.status(200).json({ message: `Booth ${boothUid} deleted successfully.` });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to delete booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to delete booth. The operation was rolled back.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/booths/:boothUid/slots/:slotIdentifier
 * @summary Delete a specific booth slot
 * @description Deletes a specific slot from a booth in both PostgreSQL and Firebase. This is a destructive action and should be used with caution. It will also attempt to fail any active sessions associated with the slot.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth containing the slot.
 *   - in: path
 *     name: slotIdentifier
 *     required: true
 *     schema:
 *       type: string
 *     description: The identifier of the slot to delete (e.g., slot001).
 * @responses
 *   200:
 *     description: Slot deleted successfully.
 *   404:
 *     description: Booth or slot not found.
 *   500:
 *     description: Internal server error.
 */
router.delete('/booths/:boothUid/slots/:slotIdentifier', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid, slotIdentifier } = req.params;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find the slot to get its ID and ensure it exists.
    const slotRes = await client.query(
      'SELECT s.id FROM booth_slots s JOIN booths b ON s.booth_id = b.id WHERE b.booth_uid = $1 AND s.slot_identifier = $2',
      [boothUid, slotIdentifier]
    );

    if (slotRes.rowCount === 0) {
      return res.status(404).json({ error: `Slot '${slotIdentifier}' in booth '${boothUid}' not found.` });
    }
    const slotId = slotRes.rows[0].id;

    // 2. Delete any associated deposit records to satisfy the foreign key constraint.
    await client.query('DELETE FROM deposits WHERE slot_id = $1', [slotId]);

    // 3. Delete the slot from PostgreSQL.
    await client.query('DELETE FROM booth_slots WHERE id = $1', [slotId]);

    // 4. Delete the slot from Firebase Realtime Database.
    const db = getDatabase();
    const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
    await slotRef.remove();

    await client.query('COMMIT');
    logger.info(`Admin (UID: ${req.user.uid}) deleted slot '${slotIdentifier}' from booth '${boothUid}'.`);
    res.status(200).json({ message: `Slot ${slotIdentifier} from booth ${boothUid} deleted successfully.` });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to delete slot ${slotIdentifier} from booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to delete slot. The operation was rolled back.', details: error.message });
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
    await client.query('BEGIN');

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

    await client.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) updated details for booth '${boothUid}'.`);
    res.status(200).json({ message: 'Booth updated successfully.', booth: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
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

    // If the booth is being taken offline or put into maintenance, update Firebase slots.
    if (status === 'maintenance' || status === 'offline') {
      const db = getDatabase();
      const boothSlotsRef = db.ref(`booths/${boothUid}/slots`);
      const snapshot = await boothSlotsRef.get();

      if (snapshot.exists()) {
        const updates = {};
        // Create a multi-path update to change the status of all slots at once.
        snapshot.forEach((slotSnapshot) => {
          updates[`${slotSnapshot.key}/status`] = status;
        });

        if (Object.keys(updates).length > 0) {
          await boothSlotsRef.update(updates);
          logger.info(`Propagated status '${status}' to all slots in Firebase for booth ${boothUid}.`);
        }
      }
    }
    // Note: We don't automatically change slots back to 'available' when a booth comes 'online'.
    // The hardware's own telemetry should be the source of truth for individual slot availability.
    // The firebaseSync listener will handle updating the DB from that telemetry.

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
 * POST /api/admin/booths/:boothUid/slots/:slotIdentifier/status
 * @summary Update a specific slot's status (e.g., enable/disable)
 * @description Updates the operational status of a specific slot. 'disabled' will prevent it from being used. 'available' will re-enable it (if it's empty). This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth containing the slot.
 *   - in: path
 *     name: slotIdentifier
 *     required: true
 *     schema:
 *       type: string
 *     description: The identifier of the slot to update (e.g., slot001).
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
 *             description: The new status for the slot.
 *             enum: [available, disabled]
 * @responses
 *   200:
 *     description: Slot status updated successfully.
 *   400:
 *     description: Bad request (e.g., invalid status).
 *   404:
 *     description: Booth or slot not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/booths/:boothUid/slots/:slotIdentifier/status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid, slotIdentifier } = req.params;
  const { status } = req.body;
  const validStatuses = ['available', 'disabled'];

  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const updateQuery = `UPDATE booth_slots SET status = $1, updated_at = NOW() WHERE slot_identifier = $2 AND booth_id = (SELECT id FROM booths WHERE booth_uid = $3) RETURNING *`;
    const result = await client.query(updateQuery, [status, slotIdentifier, boothUid]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Slot '${slotIdentifier}' in booth '${boothUid}' not found.` });
    }

    logger.info(`Admin (UID: ${req.user.uid}) updated status for slot '${slotIdentifier}' in booth '${boothUid}' to '${status}'.`);
    res.status(200).json({ message: 'Slot status updated successfully.', slot: result.rows[0] });
  } catch (error) {
    logger.error(`Failed to update status for slot ${slotIdentifier} in booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to update slot status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/booths/:boothUid/slots/:slotIdentifier/command
 * @summary Send a command to a specific booth slot
 * @description Sends a command to a specific slot (e.g., force unlock, start charging) by updating its command object in Firebase. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the target booth.
 *   - in: path
 *     name: slotIdentifier
 *     required: true
 *     schema:
 *       type: string
 *     description: The identifier of the target slot (e.g., slot001).
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         description: An object containing the command(s) to execute. Only valid command keys are accepted.
 *         example:
 *           forceUnlock: true
 * @responses
 *   200:
 *     description: Command sent successfully.
 *   400:
 *     description: Bad request (e.g., invalid command key).
 *   500:
 *     description: Internal server error.
 */
router.post('/booths/:boothUid/slots/:slotIdentifier/command', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid, slotIdentifier } = req.params;
  const commandsToUpdate = req.body;

  // A whitelist of mutable properties within the 'command' object.
  const validCommands = [
    'forceLock',
    'forceUnlock',
    'openForCollection',
    'openForDeposit',
    'startCharging',
    'stopCharging',
    'openDoorId' // Often used to trigger an open action with a unique ID
  ];

  let updates = {};
  for (const [key, value] of Object.entries(commandsToUpdate)) {
    if (!validCommands.includes(key)) {
      return res.status(400).json({ error: `Invalid command key: '${key}'.` });
    }
    updates[key] = value;
  }

  // --- Mutual Exclusivity Logic ---
  // Ensure that lock and unlock commands are not simultaneously true.
  if (updates.forceLock === true) {
    updates.forceUnlock = false;
  }
  if (updates.forceUnlock === true) {
    updates.forceLock = false;
  }

  // Ensure that start and stop charging commands are not simultaneously true.
  if (updates.startCharging === true) {
    updates.stopCharging = false;
  }
  if (updates.stopCharging === true) {
    updates.startCharging = false;
  }
  // --- End of Logic ---

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid commands provided to execute.' });
  }

  try {
    const db = getDatabase();
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update(updates);

    logger.info(`Admin (UID: ${req.user.uid}) sent command(s) to ${boothUid}/${slotIdentifier}: ${JSON.stringify(updates)}`);
    res.status(200).json({ message: 'Command sent successfully.', commands: updates });
  } catch (error) {
    logger.error(`Failed to send command to ${boothUid}/${slotIdentifier}:`, error);
    res.status(500).json({ error: 'Failed to send command to slot.', details: error.message });
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
    // Query 1: Get the main booth details
    const boothQuery = `
      SELECT
        id,
        booth_uid,
        name,
        location_address,
        status,
        created_at,
        updated_at
      FROM booths
      WHERE booth_uid = $1;
    `;
    const boothResult = await client.query(boothQuery, [boothUid]);

    if (boothResult.rows.length === 0) {
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }
    const boothDetails = boothResult.rows[0];

    // Query 2: Get all associated slots and their details
    const slotsQuery = `
      SELECT
        s.slot_identifier,
        s.status,
        s.door_status,
        s.charge_level_percent,
        bat.battery_uid,
        u.name as user_name
      FROM booth_slots s
      LEFT JOIN batteries bat ON s.current_battery_id = bat.id
      LEFT JOIN users u ON bat.user_id = u.user_id
      WHERE s.booth_id = $1
      ORDER BY s.slot_identifier ASC;
    `;
    const slotsResult = await client.query(slotsQuery, [boothDetails.id]);

    // Combine the results into a single response object
    res.status(200).json({
      booth_uid: boothDetails.booth_uid, // Keep snake_case for consistency
      name: boothDetails.name,
      location_address: boothDetails.location_address,
      status: boothDetails.status,
      created_at: boothDetails.created_at,
      updated_at: boothDetails.updated_at,
      slots: slotsResult.rows.map(slot => ({
        identifier: slot.slot_identifier,
        status: slot.status,
        doorStatus: slot.door_status,
        chargeLevel: slot.charge_level_percent,
        batteryUid: slot.battery_uid,
        userName: slot.user_name
      }))
    });
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

/**
 * @swagger
 * tags:
 *   name: Simulation
 *   description: Endpoints for simulating hardware and external service events (for development/testing).
 */

/**
 * POST /api/admin/simulate/confirm-deposit
 * @summary (Dev Tool) Simulate a hardware confirmation of a battery deposit.
 * @description Manually triggers the logic that would normally be called by the booth hardware after a user deposits a battery. This is for testing and development.
 * @tags [Admin, Simulation]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [boothUid, slotIdentifier, batteryUid, chargeLevel]
 *         properties:
 *           boothUid:
 *             type: string
 *           slotIdentifier:
 *             type: string
 *           batteryUid:
 *             type: string
 *           chargeLevel:
 *             type: integer
 * @responses
 *   200:
 *     description: Deposit successfully simulated.
 *   400:
 *     description: Bad request.
 *   404:
 *     description: Pending deposit session not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/simulate/confirm-deposit', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid, slotIdentifier, chargeLevel } = req.body;

  if (!boothUid || !slotIdentifier || chargeLevel === undefined) {
    return res.status(400).json({ error: 'boothUid, slotIdentifier, and chargeLevel are required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // This logic is copied from /api/booths/confirm-deposit
    const depositRes = await client.query(
      `SELECT d.id, d.user_id FROM deposits d
       JOIN booths b ON d.booth_id = b.id
       JOIN booth_slots s ON d.slot_id = s.id
       WHERE b.booth_uid = $1 AND s.slot_identifier = $2 AND d.status = 'pending' AND d.session_type = 'deposit'
       ORDER BY d.created_at DESC LIMIT 1`,
      [boothUid, slotIdentifier]
    );

    if (depositRes.rows.length === 0) {
      throw new Error(`No pending deposit session found for booth '${boothUid}', slot '${slotIdentifier}'.`);
    }
    const { id: depositId, user_id: firebaseUid } = depositRes.rows[0];

    // For simulation, we generate a random battery UID, mimicking a new user battery.
    const simulatedBatteryUid = `sim-${uuidv4()}`;

    // Upsert the simulated battery (create it if it doesn't exist) and link to user.
    const upsertBatteryQuery = `
      INSERT INTO batteries (battery_uid, user_id, charge_level_percent)
      VALUES ($1, $2, $3)
      ON CONFLICT (battery_uid) DO UPDATE SET user_id = $2, charge_level_percent = $3
      RETURNING id;
    `;
    const batteryRes = await client.query(upsertBatteryQuery, [simulatedBatteryUid, firebaseUid, chargeLevel]);
    const batteryId = batteryRes.rows[0].id;

    await client.query(
      "UPDATE booth_slots SET status = 'occupied', current_battery_id = $1 WHERE slot_identifier = $2 AND booth_id = (SELECT id FROM booths WHERE booth_uid = $3)",
      [batteryId, slotIdentifier, boothUid]
    );
    await client.query(
      "UPDATE deposits SET status = 'completed', battery_id = $1, initial_charge_level = $2, completed_at = NOW() WHERE id = $3",
      [batteryId, chargeLevel, depositId]
    );

    await client.query('COMMIT');
    logger.info(`(SIMULATION) Admin ${req.user.uid} confirmed deposit for user '${firebaseUid}' with new battery '${simulatedBatteryUid}' in slot '${slotIdentifier}'.`);
    res.status(200).json({ success: true, message: 'Deposit confirmed via simulation.' });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`(SIMULATION) Failed to confirm deposit for slot '${slotIdentifier}' at booth '${boothUid}':`, error);
    res.status(500).json({ error: 'Failed to simulate deposit confirmation.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/simulate/confirm-payment
 * @summary (Dev Tool) Simulate a successful M-Pesa payment for a withdrawal.
 * @description Manually updates a withdrawal session's status to 'in_progress', mimicking a successful payment callback from M-Pesa.
 * @tags [Admin, Simulation]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required: [checkoutRequestId]
 *         properties:
 *           checkoutRequestId:
 *             type: string
 * @responses
 *   200:
 *     description: Payment successfully simulated.
 */
router.post('/simulate/confirm-payment', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { checkoutRequestId } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ error: 'checkoutRequestId is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const updateResult = await client.query(
      "UPDATE deposits SET status = 'in_progress' WHERE mpesa_checkout_id = $1 AND status = 'pending'",
      [checkoutRequestId]
    );

    if (updateResult.rowCount > 0) {
      logger.info(`(SIMULATION) Admin ${req.user.uid} confirmed payment for CheckoutRequestID: ${checkoutRequestId}.`);
      res.status(200).json({ message: 'Payment status updated to in_progress via simulation.' });
    } else {
      logger.warn(`(SIMULATION) Could not find a pending session for CheckoutRequestID: ${checkoutRequestId}`);
      res.status(404).json({ error: 'No pending withdrawal session found for that CheckoutRequestID.' });
    }
  } catch (error) {
    logger.error(`(SIMULATION) Failed to confirm payment for ${checkoutRequestId}:`, error);
    res.status(500).json({ error: 'Failed to simulate payment confirmation.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/booths/:boothUid/reset-slots
 * @summary Reset one or all slots in a booth to their default state.
 * @description Resets slot data in both PostgreSQL and Firebase to a default, 'available' state. This is a powerful maintenance tool. If `slotIdentifier` is provided in the body, only that slot is reset. Otherwise, all slots in the booth are reset.
 * @tags [Admin, Simulation]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: boothUid
 *     required: true
 *     schema:
 *       type: string
 *     description: The UID of the booth to perform the reset on.
 * @requestBody
 *   required: false
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         properties:
 *           slotIdentifier:
 *             type: string
 *             description: (Optional) The specific slot to reset. If omitted, all slots in the booth will be reset.
 * @responses
 *   200:
 *     description: Slot(s) reset successfully.
 *   404:
 *     description: Booth not found.
 *   500:
 *     description: Internal server error.
 */
router.post('/booths/:boothUid/reset-slots', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { boothUid } = req.params;
  const { slotIdentifier } = req.body; // Optional: to reset a single slot

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get the internal booth ID
    const boothRes = await client.query('SELECT id FROM booths WHERE booth_uid = $1', [boothUid]);
    if (boothRes.rows.length === 0) {
      return res.status(404).json({ error: `Booth with UID ${boothUid} not found.` });
    }
    const boothId = boothRes.rows[0].id;

    // 2. Find and terminate any active user sessions in the slot(s) being reset.
    // An active session is one that is not already in a terminal state (failed, cancelled, or a completed withdrawal).
    const terminateSessionsQuery = `
      UPDATE deposits
      SET status = 'failed'
      WHERE id IN (
        SELECT d.id FROM deposits d
        JOIN booth_slots s ON d.slot_id = s.id
        WHERE s.booth_id = $1
          ${slotIdentifier ? 'AND s.slot_identifier = $2' : ''}
          AND d.status NOT IN ('failed', 'cancelled')
          AND NOT (d.session_type = 'withdrawal' AND d.status = 'completed')
      );
    `;
    const terminateParams = slotIdentifier ? [boothId, slotIdentifier] : [boothId];
    await client.query(terminateSessionsQuery, terminateParams);

    // 2. Reset the slot(s) in PostgreSQL
    const pgResetQuery = `
      UPDATE booth_slots
      SET
        status = 'available',
        current_battery_id = NULL,
        charge_level_percent = NULL,
        door_status = 'closed',
        is_charging = FALSE,
        telemetry = NULL,
        updated_at = NOW()
      WHERE booth_id = $1
    ` + (slotIdentifier ? 'AND slot_identifier = $2' : '');

    const pgQueryParams = slotIdentifier ? [boothId, slotIdentifier] : [boothId];
    await client.query(pgResetQuery, pgQueryParams);

    // 3. Reset the slot(s) in Firebase
    const db = getDatabase();
    const allDefaultSlots = initializeFirebaseSlots();

    if (slotIdentifier) {
      // Reset a single slot in Firebase
      const defaultSlotData = allDefaultSlots[slotIdentifier];
      if (!defaultSlotData) {
        throw new Error(`Invalid slot identifier '${slotIdentifier}' provided.`);
      }
      const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
      await slotRef.set(defaultSlotData);
      logger.info(`Admin ${req.user.uid} reset slot ${boothUid}/${slotIdentifier}.`);
    } else {
      // Reset all slots for the booth in Firebase
      const slotsRef = db.ref(`booths/${boothUid}/slots`);
      await slotsRef.set(allDefaultSlots);
      logger.info(`Admin ${req.user.uid} reset all slots for booth ${boothUid}.`);
    }

    await client.query('COMMIT');

    res.status(200).json({
      message: slotIdentifier
        ? `Slot ${slotIdentifier} in booth ${boothUid} has been reset.`
        : `All slots in booth ${boothUid} have been reset.`
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to reset slots for booth ${boothUid}:`, error);
    res.status(500).json({ error: 'Failed to reset slots.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/dashboard-summary
 * @summary Get aggregated data for the main admin dashboard.
 * @description Retrieves key performance indicators like revenue, station counts, user counts, and data for charts.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @responses
 *   200:
 *     description: An object containing all dashboard metrics.
 *   500:
 *     description: Internal server error.
 */
router.get('/dashboard-summary', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // Define all queries to be run in parallel
    const queries = {
      totalRevenue: `
        SELECT SUM(amount) as "totalRevenue"
        FROM deposits
        WHERE session_type = 'withdrawal' AND status = 'completed' AND completed_at >= date_trunc('month', NOW());
      `,
      activeStations: `SELECT COUNT(*) as "activeStations" FROM booths WHERE status = 'online';`,
      totalSwaps: `SELECT COUNT(*) as "totalSwaps" FROM deposits WHERE session_type = 'withdrawal' AND status = 'completed';`,
      activeSessions: `SELECT COUNT(*) as "activeSessions" FROM deposits WHERE status = 'in_progress';`,
      totalUsers: `SELECT COUNT(*) as "totalUsers" FROM users;`,
      swapVolumeTrend: `
        SELECT
          to_char(day_series, 'Dy') as name,
          COALESCE(swap_count, 0) as val
        FROM
          generate_series(
            date_trunc('day', NOW() - interval '6 days'),
            date_trunc('day', NOW()),
            '1 day'
          ) as day_series
        LEFT JOIN (
          SELECT
            date_trunc('day', completed_at) as swap_day,
            COUNT(*) as swap_count
          FROM deposits
          WHERE session_type = 'withdrawal' AND status = 'completed' AND completed_at >= NOW() - interval '7 days'
          GROUP BY swap_day
        ) as swaps ON day_series = swaps.swap_day
        ORDER BY day_series;
      `
    };

    // Execute all queries in parallel for maximum efficiency
    const [
      revenueRes,
      stationsRes,
      swapsRes,
      sessionsRes,
      usersRes,
      trendRes,
    ] = await Promise.all([
      client.query(queries.totalRevenue),
      client.query(queries.activeStations),
      client.query(queries.totalSwaps),
      client.query(queries.activeSessions),
      client.query(queries.totalUsers),
      client.query(queries.swapVolumeTrend)
    ]);

    // Consolidate results into a single response object
    const summary = {
      totalRevenue: parseFloat(revenueRes.rows[0]?.totalRevenue || 0),
      activeStations: parseInt(stationsRes.rows[0]?.activeStations || 0, 10),
      totalSwaps: parseInt(swapsRes.rows[0]?.totalSwaps || 0, 10),
      activeSessions: parseInt(sessionsRes.rows[0]?.activeSessions || 0, 10),
      totalUsers: parseInt(usersRes.rows[0]?.totalUsers || 0, 10),
      swapVolumeTrend: trendRes.rows,
      batteryUsage: [], // Return an empty array as this chart is disabled
    };

    res.status(200).json(summary);

  } catch (error) {
    logger.error('Failed to get dashboard summary:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard summary.', details: error.message });
  } finally {
    client.release();
  }
});

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
 * @responses
 *   200:
 *     description: A paginated list of all sessions.
 *   500:
 *     description: Internal server error.
 */
router.get('/sessions', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const { searchTerm, status, sessionType } = req.query;

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;

    if (searchTerm) {
      whereClauses.push(`u.email ILIKE $${paramIndex++}`);
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

module.exports = router;
