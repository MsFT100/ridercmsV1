const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const poolPromise = require('../../db');
const { verifyFirebaseToken } = require('../../middleware/auth');
const { extractValidSoc, isDevBooth } = require('./shared');

const router = Router();

/**
 * POST /api/booths/initiate-deposit
 * Called by a user's app to start a deposit. Finds an available slot
 * and creates a pending session record.
 */
router.post('/initiate-deposit', verifyFirebaseToken, async (/** @type {any} */ req, res) => {
  const { boothUid } = req.body;
  const { uid: firebaseUid } = req.user;

  if (!boothUid) {
    return res.status(400).json({ error: 'boothUid is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);

  try {
    await client.query('BEGIN');

    // 🔧 FIX 1: Serialize per-user requests
    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    // 🔧 FIX 2: Include 'opening' as an active state
    // Join with booth_slots to get the slot_identifier for the idempotency check.
    const existingSessionQuery = `
      SELECT
        d.id, d.status, d.slot_id, d.session_type,
        s.slot_identifier
      FROM deposits d
      LEFT JOIN booth_slots s ON d.slot_id = s.id
      WHERE d.user_id = $1
        AND d.status IN ('pending', 'opening', 'in_progress')
      ORDER BY d.created_at DESC -- Process the most recent session first
    `;
    const existingSessionRes = await client.query(existingSessionQuery, [firebaseUid]);

    for (const session of existingSessionRes.rows) {
      // A rider who still has a rental battery out (issued or awaiting
      // collection/return) cannot start another deposit. This holds across
      // every browser or device because it is enforced server-side.
      if (
        session.session_type === 'rental' &&
        (session.status === 'pending' || session.status === 'in_progress')
      ) {
        throw new Error('ACTIVE_RENTAL_EXISTS');
      }

      // --- Robust Idempotency for Double-Clicks ---
      // If an 'opening' deposit session exists from a previous tap, we don't just re-use it.
      // We cancel it and proceed with the current request to find a fresh, verified slot.
      // This prevents re-assigning a slot that may have become invalid.
      if (session.status === 'opening' && session.session_type === 'deposit') {
        logger.warn(`Cancelling stale 'opening' session ${session.id} for user ${firebaseUid} on slot ${session.slot_identifier} due to new deposit request.`);
        await client.query("UPDATE deposits SET status = 'cancelled' WHERE id = $1", [session.id]);
        if (session.slot_id) {
          await client.query("UPDATE booth_slots SET status = 'available' WHERE id = $1", [session.slot_id]);
        }
        // Clean up complete. Continue to find a fresh slot.
        continue; 
      } else if (session.status === 'in_progress') {
        continue;
      }

      if (session.status === 'pending' && session.session_type === 'deposit') {
        logger.warn(
          `Cleaning up stale pending deposit session ${session.id} for user ${firebaseUid}.`
        );

        await client.query(
          "UPDATE deposits SET status = 'cancelled' WHERE id = $1",
          [session.id]
        );

        if (session.slot_id) {
          await client.query(
            "UPDATE booth_slots SET status = 'available' WHERE id = $1",
            [session.slot_id]
          );
        }
        // Instead of throwing, we continue the loop to find a fresh slot for the user immediately.
        continue; 
      }

      if (
        session.status === 'pending' &&
        session.session_type === 'withdrawal'
      ) {
        continue;
      }
    }

    // 1. Resolve booth
    const boothRes = await client.query(
      "SELECT id FROM booths WHERE booth_uid = $1 AND status = 'online'",
      [boothUid]
    );

    if (boothRes.rows.length === 0) {
      throw new Error('BOOTH_NOT_AVAILABLE');
    }

    const boothId = boothRes.rows[0].id;

    // 2. Find potential slots
    const potentialSlotsRes = await client.query(
      `
      SELECT id, slot_identifier
      FROM booth_slots
      WHERE booth_id = $1
        AND status = 'available'
      ORDER BY slot_identifier ASC
      `,
      [boothId]
    );

    if (potentialSlotsRes.rows.length === 0) {
      throw new Error('NO_AVAILABLE_SLOTS');
    }

    const db = getDatabase();
    let assignedSlot = null;

    // 3. Verify + atomically reserve slot
    for (const potentialSlot of potentialSlotsRes.rows) {
      const slotRef = db.ref(
        `booths/${boothUid}/slots/${potentialSlot.slot_identifier}`
      );
      const snapshot = await slotRef.get();

      if (snapshot.exists()) {
        const telemetry = snapshot.val()?.telemetry || {};
        if (telemetry.plugConnected && telemetry.batteryInserted) {
          continue;
        }
      }

      const slotReserveRes = await client.query(
        `
        UPDATE booth_slots
        SET status = 'opening'
        WHERE id = $1
          AND status = 'available'
        RETURNING id, slot_identifier
        `,
        [potentialSlot.id]
      );

      if (slotReserveRes.rowCount > 0) {
        // Safety net: Clean up any stale unredeemed deposit credits on this slot.
        // This prevents double-allocation when the previous user's withdrawal failed
        // but their deposit credit was not cleaned up by the Firebase sync.
        await client.query(
          `UPDATE deposits
           SET status = 'failed',
               notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: slot reassigned to new user.'
           WHERE slot_id = $1
             AND session_type = 'deposit'
             AND status = 'completed'
             AND NOT EXISTS (
               SELECT 1 FROM booth_slots bs WHERE bs.id = deposits.slot_id AND bs.status = 'occupied'
             )
             AND NOT EXISTS (
               SELECT 1 FROM deposits w
               WHERE w.consumed_deposit_id = deposits.id
                 AND w.session_type = 'withdrawal'
                 AND w.status NOT IN ('cancelled', 'failed')
             )`,
          [potentialSlot.id]
        );

        assignedSlot = slotReserveRes.rows[0];
        break;
      }
    }

    if (!assignedSlot) {
      throw new Error('NO_AVAILABLE_SLOTS');
    }

    const { id: slotId, slot_identifier: slotIdentifier } = assignedSlot;

    // 4. Issue hardware command (skip for dev booths — no real hardware)
    if (isDevBooth(boothUid)) {
      logger.info(`Dev booth: skipping Firebase hardware command for deposit at ${boothUid}/${slotIdentifier}.`);
    } else {
      await db
        .ref(`booths/${boothUid}/slots/${slotIdentifier}/command`)
        .update({
          openForDeposit: true,
          openForCollection: false,
        });
    }

    // 5. Create deposit session
    const depositInsert = await client.query(
      `INSERT INTO deposits (user_id, booth_id, slot_id, session_type, status)
      VALUES ($1, $2, $3, 'deposit', 'opening')
      RETURNING id`,
      [firebaseUid, boothId, slotId]
    );
    const depositId = depositInsert.rows[0].id;

    // 6. For dev booths: simulate hardware response — auto-complete the deposit
    if (isDevBooth(boothUid)) {
      // Assign an available battery from the dev pool
      const batteryRes = await client.query(
        `SELECT id, battery_uid, charge_level_percent
         FROM batteries b
         WHERE NOT EXISTS (
           SELECT 1 FROM booth_slots bs WHERE bs.current_battery_id = b.id
         )
         LIMIT 1`
      );
      if (batteryRes.rows.length > 0) {
        const battery = batteryRes.rows[0];
        await client.query(
          `UPDATE booth_slots SET status = 'occupied', current_battery_id = $1,
           charge_level_percent = $2, is_charging = true, door_status = 'closed'
           WHERE id = $3`,
          [battery.id, battery.charge_level_percent, slotId]
        );
        await client.query(
          `UPDATE deposits SET status = 'completed', completed_at = NOW(),
           battery_id = $1, initial_charge_level = $2
           WHERE id = $3`,
          [battery.id, battery.charge_level_percent, depositId]
        );
        logger.info(`Dev booth: simulated deposit completion — battery ${battery.battery_uid} assigned to slot ${slotIdentifier}.`);
      } else {
        logger.warn('Dev booth: no unassigned batteries available for simulation.');
      }
    }

    await client.query('COMMIT');

    logger.info(`New deposit session initiated for user ${firebaseUid} at booth ${boothUid}, slot ${slotIdentifier}.`);
    return res.status(200).json({
      slot: {
        identifier: slotIdentifier,
        status: isDevBooth(boothUid) ? 'completed' : 'opening',
      },
      // Return the session id so the client can track this exact deposit while
      // polling (the client matches on sessionId, falling back to slot).
      sessionId: depositId,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'NO_AVAILABLE_SLOTS' || error.message === 'BOOTH_NOT_AVAILABLE') {
      const userMessage = error.message === 'NO_AVAILABLE_SLOTS'
        ? 'All slots at this booth are currently occupied. Please try again later.'
        : 'This booth is currently offline or does not exist.';
      logger.warn(`Deposit initiation failed for user ${firebaseUid} at booth ${boothUid}: ${userMessage}`);
      return res.status(409).json({ error: 'Booth not available', message: userMessage });
    }

    if (error.message === 'ACTIVE_RENTAL_EXISTS') {
      const userMessage = 'Return your rental battery before depositing another one.';
      logger.warn(`Deposit initiation blocked for user ${firebaseUid} at booth ${boothUid}: active rental session.`);
      return res.status(409).json({ error: 'ACTIVE_RENTAL_EXISTS', message: userMessage });
    }

    logger.error(
      `Failed to initiate deposit for user ${firebaseUid} at booth ${boothUid}:`,
      error
    );

    return res.status(500).json({
      error: 'Failed to initiate deposit process',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/my-battery-status
 * Allows a logged-in user to check the status and location of their deposited battery.
 */
router.get('/my-battery-status', verifyFirebaseToken, async (/** @type {any} */ req, res) => {
  const { uid: firebaseUid } = req.user;
  const isPoll = req.headers['x-purpose'] === 'poll';

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    // 1. Find where the user's battery is located from our database.
    // STRICT: a rider only sees a battery when their completed deposit still
    // OWNS a physically occupied slot (real-time device truth via
    // `status = 'occupied'`). A rider's own deposited battery has no battery
    // identity — battery IDs are reserved for company rental batteries — so
    // ownership is the "latest unconsumed deposit with no newer deposit by
    // another user" rule. The newer-owner guard (and the battery-identity
    // removal) is what keeps stale/ghost deposits from resurfacing.
    const locationQuery = `
      SELECT
        d.id AS "sessionId",
        bo.booth_uid AS "boothUid",
        s.id AS "slotId",
        s.slot_identifier AS "slotIdentifier",
        s.charge_level_percent AS "lastKnownChargeLevel",
        d.status AS "sessionStatus",
        GREATEST(d.updated_at, s.updated_at) AS "lastModified"
      FROM deposits d
      JOIN booth_slots s ON d.slot_id = s.id
      JOIN booths bo ON s.booth_id = bo.id
      WHERE d.user_id = $1
        AND d.session_type = 'deposit'
        AND d.status = 'completed'
        AND s.status = 'occupied'
        AND NOT EXISTS (
          SELECT 1 FROM deposits w
          WHERE w.consumed_deposit_id = d.id
            AND w.session_type IN ('withdrawal', 'rental')
            AND w.status NOT IN ('cancelled', 'failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM deposits newer
          WHERE newer.slot_id = d.slot_id
            AND newer.session_type = 'deposit'
            AND newer.id > d.id
            AND newer.user_id <> d.user_id
            AND newer.status IN ('opening', 'in_progress', 'completed')
            AND NOT EXISTS (
              SELECT 1 FROM deposits w2
              WHERE w2.consumed_deposit_id = newer.id
                AND w2.session_type IN ('withdrawal', 'rental')
                AND w2.status NOT IN ('cancelled', 'failed')
            )
        );
    `;
    const locationResult = await client.query(locationQuery, [firebaseUid]);

    if (locationResult.rows.length === 0) {
      return res.status(200).json(null);
    }

    // Compute a cheap ETag from the latest timestamp across all deposits/slots.
    const maxModified = locationResult.rows.reduce(
      (max, r) => Math.max(max, new Date(r.lastModified).getTime()), 0
    );
    const timestampTag = `"${maxModified}"`;

    // If the client sent the timestamp ETag back, nothing changed — skip Firebase entirely.
    if (req.headers['if-none-match'] === timestampTag) {
      return res.status(304).end();
    }

    const db = getDatabase();

    const statuses = await Promise.all(locationResult.rows.map(async (row) => {
      const { sessionId, boothUid, slotId, slotIdentifier, lastKnownChargeLevel, sessionStatus } = row;

      const slotRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}`);
      const snapshot = await slotRef.get();

      if (!snapshot.exists()) {
        logger.warn(`Data inconsistency: Battery for user ${firebaseUid} is in PG for slot ${boothUid}/${slotIdentifier}, but slot does not exist in Firebase.`);
        return { sessionId, boothUid, slotIdentifier, chargeLevel: lastKnownChargeLevel, sessionStatus, telemetry: null };
      }

      const firebaseData = snapshot.val();
      const realTimeCharge = extractValidSoc(firebaseData, lastKnownChargeLevel) ?? 0;

      // On poll requests skip the background DB sync (non-essential).
      if (!isPoll) {
        client.query(
          'UPDATE booth_slots SET charge_level_percent = $1, telemetry = $2, updated_at = NOW() WHERE id = $3',
          [realTimeCharge, firebaseData.telemetry || null, slotId]
        ).catch(err => logger.error(`Failed to background-update slot ${slotId} with Firebase data:`, err));
      }

      return {
        sessionId,
        boothUid,
        slotIdentifier,
        chargeLevel: realTimeCharge,
        lastChargeLevel: lastKnownChargeLevel,
        sessionStatus,
        telemetry: firebaseData.telemetry || null,
      };
    }));

    // Compute an exact ETag from the full response body.
    const body = JSON.stringify(statuses);
    const responseTag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;

    // Double-check: if the client already has this exact payload, avoid sending it again.
    if (req.headers['if-none-match'] === responseTag) {
      return res.status(304).end();
    }

    res.set('ETag', responseTag);
    res.status(200).json(statuses);
  } catch (error) {
    logger.error(`Failed to get battery status for user ${firebaseUid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve battery status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/deposit-sessions/:sessionId/status
 * Lets the depositing rider poll the lifecycle status of their own deposit
 * session — including the terminal states (`cancelled`, `failed`) that
 * `my-battery-status` intentionally hides because it only surfaces COMPLETED
 * deposits. Without this, a booth that auto-cancels a deposit (e.g. a
 * `deposit_timeout` hardware ACK, or an operator cancelling it) leaves the app
 * stuck forever on "Waiting for Confirmation".
 *
 * Scoped to the authenticated user; returns 404 when the session does not exist
 * or belongs to someone else.
 */
router.get('/deposit-sessions/:sessionId/status', verifyFirebaseToken, async (/** @type {any} */ req, res) => {
  const { uid: firebaseUid } = req.user;
  const sessionId = Number(req.params.sessionId);

  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: 'Invalid session id.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    const result = await client.query(
      `SELECT
         d.id AS "sessionId",
         d.session_type AS "sessionType",
         d.status AS "sessionStatus",
         s.slot_identifier AS "slotIdentifier",
         bo.booth_uid AS "boothUid"
       FROM deposits d
       LEFT JOIN booth_slots s ON d.slot_id = s.id
       LEFT JOIN booths bo ON d.booth_id = bo.id
       WHERE d.id = $1 AND d.user_id = $2`,
      [sessionId, firebaseUid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error(`Failed to get deposit session ${sessionId} for user ${firebaseUid}:`, error);
    return res.status(500).json({ error: 'Failed to retrieve session status.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
