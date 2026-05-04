const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

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
        u.name AS user_name
      FROM booths b
      LEFT JOIN booth_slots s ON b.id = s.booth_id
      -- Use a lateral join to find the user from the most recent completed deposit in each slot.
      LEFT JOIN LATERAL (
        SELECT d.user_id
        FROM deposits d
        WHERE d.slot_id = s.id AND d.session_type = 'deposit' AND d.status = 'completed'
        ORDER BY d.completed_at DESC
        LIMIT 1
      ) last_deposit ON true
      LEFT JOIN users u ON last_deposit.user_id = u.user_id
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
                chargeLevel: telemetry.soc || slotData.soc || 0,
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
    events: {},
    final_soc: 22,
    final_voltage: 0,
    initial_soc: 0,
    initial_voltage: 0,
    pendingCmd: false,
    rejection: {},
    relay: "OFF",
    relayOn: false,
    safetyReason: "",
    shouldCharge: true,
    soc: 0,
    status: "booting", // Or 'available'
    telemetry: {
      batteryInserted: false,
      doorClosed: true,
      doorLocked: true,
      plugConnected: false,
      qr: "",
      relayOn: false,
      restVoltage: 0,
      soc: 0,
      status: "booting",
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
        u.name AS user_name
      FROM booth_slots s
      LEFT JOIN batteries bat ON s.current_battery_id = bat.id
      LEFT JOIN LATERAL (
        SELECT d.user_id
        FROM deposits d
        WHERE d.slot_id = s.id AND d.session_type = 'deposit' AND d.status = 'completed'
        ORDER BY d.completed_at DESC
        LIMIT 1
      ) last_deposit ON true
      LEFT JOIN users u ON last_deposit.user_id = u.user_id
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

module.exports = router;
