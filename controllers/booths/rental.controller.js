const { Router } = require('express');
const { getDatabase } = require('firebase-admin/database');
const logger = require('../../utils/logger');
const poolPromise = require('../../db');
const { verifyFirebaseToken } = require('../../middleware/auth');
const { initiateSTKPush, querySTKStatus } = require('../../utils/mpesa');
const {
  completePaidRental,
  getRentalOwnSlot,
  finalizeRentalSession,
  finalizeRentalCollection,
  handleRentalReturnCompletion,
} = require('../../utils/sessionUtils');
const {
  isDevBooth,
} = require('./shared');

const router = Router();

// Sub-expression reused to decide whether a battery in a slot has "no deposit owner"
// (i.e. it is rental-pool stock, not someone's battery currently charging).
const noDepositOwnerExpr = (batteryAlias = 'batteries') => `
  NOT EXISTS (
    SELECT 1 FROM deposits d
    WHERE d.battery_id = ${batteryAlias}.id
      AND d.session_type = 'deposit'
      AND d.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM deposits w
        WHERE w.consumed_deposit_id = d.id
          AND w.session_type IN ('withdrawal', 'rental')
          AND w.status NOT IN ('cancelled', 'failed')
      )
  )
`;

/**
 * GET /api/booths/rentals/available
 * @summary List borrowable (unowned) batteries at a booth
 * @description Returns occupied slots whose battery has no completed deposit credit
 * awaiting withdrawal, i.e. it belongs to the rental pool.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.get('/rentals/available', verifyFirebaseToken, async (req, res) => {
  const { boothUid } = req.query;
  const { uid: firebaseUid } = req.user;

  if (!boothUid) {
    return res.status(400).json({ error: 'boothUid query parameter is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    // Fetch rental allocation settings (fall back to sensible defaults).
    const settingsRes = await client.query("SELECT value FROM app_settings WHERE key = 'rental'");
    const rent = settingsRes.rows[0]?.value || {};
    const minSocPercent = Number(rent.minimum_soc_percent ?? 50);
    const allocateHighestSocFirst = rent.allocate_highest_soc_first !== false;
    const maxRentalsPerUser = Number(rent.max_rental_batteries_per_user ?? 1);

    const activeRental = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM deposits
       WHERE user_id = $1 AND session_type = 'rental' AND status IN ('pending', 'in_progress')`,
      [firebaseUid]
    );
    const activeRentalCount = activeRental.rows[0].cnt;

    const availableRes = await client.query(
      `SELECT
         s.id AS "slotId",
         s.slot_identifier AS "slotIdentifier",
         b.id AS "batteryId",
         b.battery_uid AS "batteryUid",
         s.charge_level_percent AS "chargeLevel"
       FROM booth_slots s
       JOIN booths bo ON s.booth_id = bo.id
       JOIN batteries b ON s.current_battery_id = b.id
       WHERE bo.booth_uid = $1
         AND bo.status = 'online'
         AND s.status = 'occupied'
         AND b.withdrawn_at IS NULL
         AND ${noDepositOwnerExpr('b')}
         AND NOT EXISTS (
           SELECT 1 FROM deposits r
           WHERE r.battery_id = b.id
             AND r.session_type = 'rental'
             AND r.status IN ('pending', 'in_progress')
         )
       ${minSocPercent > 0 ? `AND s.charge_level_percent >= ${minSocPercent}` : ''}
       ORDER BY ${allocateHighestSocFirst ? 's.charge_level_percent DESC' : 's.slot_identifier ASC'}`,
      [boothUid]
    );

    return res.status(200).json({
      boothUid,
      rentals: availableRes.rows,
      hasPendingRental: activeRentalCount > 0,
      rentalLimit: maxRentalsPerUser,
      activeRentalCount,
    });
  } catch (error) {
    logger.error(`Failed to list available rentals for booth ${boothUid}:`, error);
    return res.status(500).json({ error: 'Failed to list available rentals.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/rentals/issue
 * @summary Start a battery rental
 * @description Users must currently have their own battery deposited and charging
 * (an unredeemed completed deposit credit). Creates the rental session that consumes
 * that credit, then opens the pool slot for collection.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.post('/rentals/issue', verifyFirebaseToken, async (req, res) => {
  const { boothUid, slotIdentifier } = req.body;
  const { uid: firebaseUid } = req.user;

  if (!boothUid || !slotIdentifier) {
    return res.status(400).json({ error: 'boothUid and slotIdentifier are required.' });
  }

  let maxRentalsPerUser = 1;
  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    const existingRes = await client.query(
      `SELECT 1 FROM deposits
       WHERE user_id = $1
         AND session_type = 'withdrawal'
         AND status IN ('pending', 'in_progress')
       LIMIT 1`,
      [firebaseUid]
    );
    if (existingRes.rows.length > 0) {
      throw new Error('ACTIVE_WITHDRAWAL_EXISTS');
    }

    // Enforce max active rentals from settings.
    const rentalSettingsRes = await client.query("SELECT value FROM app_settings WHERE key = 'rental'");
    const rent = rentalSettingsRes.rows[0]?.value || {};
    maxRentalsPerUser = Number(rent.max_rental_batteries_per_user ?? 1);

    const activeRentalCountRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM deposits
       WHERE user_id = $1 AND session_type = 'rental' AND status IN ('pending', 'in_progress')`,
      [firebaseUid]
    );
    const activeRentalCount = activeRentalCountRes.rows[0].cnt;
    if (activeRentalCount >= maxRentalsPerUser) {
      throw new Error('RENTAL_LIMIT_REACHED');
    }

    // 1. The user must own a deposit credit (their battery charging right now).
    const creditRes = await client.query(
      `SELECT d.id AS "depositCreditId", s.id AS "ownSlotId",
              s.slot_identifier AS "ownSlotIdentifier", bo.booth_uid AS "ownBoothUid"
       FROM deposits d
       JOIN booth_slots s ON d.slot_id = s.id
       JOIN booths bo ON s.booth_id = bo.id
       WHERE d.user_id = $1
         AND d.session_type = 'deposit'
         AND d.status = 'completed'
         AND s.current_battery_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM deposits w
           WHERE w.consumed_deposit_id = d.id
             AND w.session_type IN ('withdrawal', 'rental')
             AND w.status NOT IN ('cancelled', 'failed')
         )
       ORDER BY d.completed_at DESC
       LIMIT 1`,
      [firebaseUid]
    );
    if (creditRes.rows.length === 0) {
      throw new Error('NO_DEPOSITED_BATTERY');
    }
    const { depositCreditId, ownSlotId, ownSlotIdentifier, ownBoothUid } = creditRes.rows[0];

    // 2. Locate the requested pool slot + battery.
    const slotRes = await client.query(
      `SELECT s.id AS "slotId", s.status AS "slotStatus",
              b.id AS "batteryId", b.battery_uid AS "batteryUid",
              b.charge_level_percent AS "chargeLevel", bo.id AS "boothId"
       FROM booth_slots s
       JOIN booths bo ON s.booth_id = bo.id
       JOIN batteries b ON s.current_battery_id = b.id
       WHERE bo.booth_uid = $1 AND s.slot_identifier = $2
       LIMIT 1`,
      [boothUid, slotIdentifier]
    );
    if (slotRes.rows.length === 0) {
      throw new Error('SLOT_NOT_FOUND');
    }

    const {
      slotId,
      slotStatus,
      batteryId,
      batteryUid,
      chargeLevel,
      boothId,
    } = slotRes.rows[0];

    if (slotStatus !== 'occupied') {
      throw new Error('POOL_SLOT_NOT_OCCUPIED');
    }

    // 3. Confirm the battery really is unowned pool stock.
    const poolCheck = await client.query(
      `SELECT 1
       FROM batteries b
       WHERE b.id = $1
         AND b.withdrawn_at IS NULL
         AND ${noDepositOwnerExpr('b')}
         AND NOT EXISTS (
           SELECT 1 FROM deposits r
           WHERE r.battery_id = b.id
             AND r.session_type = 'rental'
             AND r.status IN ('pending', 'in_progress')
         )`,
      [batteryId]
    );
    if (poolCheck.rows.length === 0) {
      throw new Error('BATTERY_NOT_AVAILABLE');
    }

    // 4. Create the rental session. pending = issued, awaiting collection.
    const rentalInsert = await client.query(
      `INSERT INTO deposits
        (user_id, booth_id, slot_id, battery_id, consumed_deposit_id, session_type, status, initial_charge_level)
       VALUES ($1, $2, $3, $4, $5, 'rental', 'pending', $6)
       RETURNING id`,
      [firebaseUid, boothId, slotId, batteryId, depositCreditId, chargeLevel]
    );
    const rentalId = rentalInsert.rows[0].id;

    if (isDevBooth(boothUid)) {
      logger.info(`Dev booth: simulated rental collection at ${boothUid}/${slotIdentifier}.`);
      await finalizeRentalCollection(client, slotId, slotIdentifier);
    } else {
      await getDatabase()
        .ref(`booths/${boothUid}/slots/${slotIdentifier}/command`)
        .update({
          openForCollection: true,
          openForDeposit: false,
        });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Rental issued.',
      sessionId: rentalId,
      batteryUid,
      chargeLevel: Number(chargeLevel),
      status: isDevBooth(boothUid) ? 'in_progress' : 'pending',
      ownDeposit: {
        depositId: depositCreditId,
        boothUid: ownBoothUid,
        slotIdentifier: ownSlotIdentifier,
        ownSlotId,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'ACTIVE_WITHDRAWAL_EXISTS') {
      return res.status(409).json({ error: 'Active withdrawal', message: 'You have an active withdrawal in progress. Complete it first.' });
    }
    if (error.message === 'RENTAL_LIMIT_REACHED') {
      return res.status(409).json({ error: 'Rental limit reached', message: `You have reached the maximum number of concurrent rentals (${maxRentalsPerUser}).` });
    }
    if (error.message === 'NO_DEPOSITED_BATTERY') {
      return res.status(404).json({ error: 'No deposited battery', message: 'Deposit your own battery first so it can charge while you rent.' });
    }
    if (error.message === 'SLOT_NOT_FOUND') {
      return res.status(404).json({ error: 'Slot not found', message: 'That slot does not exist at this booth.' });
    }
    if (error.message === 'POOL_SLOT_NOT_OCCUPIED') {
      return res.status(409).json({ error: 'Slot not occupied', message: 'That slot does not currently hold a borrowable battery.' });
    }
    if (error.message === 'BATTERY_NOT_AVAILABLE') {
      return res.status(409).json({ error: 'Battery unavailable', message: 'That battery is currently in use. Please pick another.' });
    }

    logger.error(`Failed to issue rental for user ${firebaseUid}:`, error);
    return res.status(500).json({ error: 'Failed to issue rental.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/rentals/active
 * @summary Get the current user's active rental
 * @description Returns the latest pending/in_progress rental together with details
 * of the user's own deposit battery so the app can show billing context.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.get('/rentals/active', verifyFirebaseToken, async (req, res) => {
  const { uid: firebaseUid } = req.user;
  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    const resQuery = await client.query(
      `SELECT
         r.id AS "sessionId",
         r.status,
         r.initial_charge_level AS "issueSoc",
         r.amount,
         r.mpesa_checkout_id AS "checkoutRequestId",
         r.created_at AS "issuedAt",
         r.started_at AS "startedAt",
         r.return_slot_id,
         srcB.booth_uid AS "sourceBoothUid",
         srcS.slot_identifier AS "sourceSlotIdentifier",
         bat.battery_uid AS "batteryUid",
         retB.booth_uid AS "returnBoothUid",
         retS.slot_identifier AS "returnSlotIdentifier",
         dep.id AS "ownDepositId",
         dep.initial_charge_level AS "ownInitialSoc",
         ownB.booth_uid AS "ownBoothUid",
         ownS.slot_identifier AS "ownSlotIdentifier",
         ownS.charge_level_percent AS "ownCurrentSoc"
       FROM deposits r
       JOIN booth_slots srcS ON r.slot_id = srcS.id
       JOIN booths srcB ON srcS.booth_id = srcB.id
       LEFT JOIN batteries bat ON r.battery_id = bat.id
       LEFT JOIN booth_slots retS ON r.return_slot_id = retS.id
       LEFT JOIN booths retB ON retS.booth_id = retB.id
       JOIN deposits dep ON dep.id = r.consumed_deposit_id
       LEFT JOIN booth_slots ownS ON dep.slot_id = ownS.id
       LEFT JOIN booths ownB ON ownS.booth_id = ownB.id
       WHERE r.user_id = $1 AND r.session_type = 'rental' AND r.status IN ('pending', 'in_progress')
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [firebaseUid]
    );

    if (resQuery.rowCount === 0) {
      return res.status(204).send();
    }

    const row = resQuery.rows[0];
    return res.status(200).json({
      sessionId: row.sessionId,
      status: row.status,
      issuedAt: row.issuedAt,
      startedAt: row.startedAt,
      issueSoc: row.issueSoc !== null ? Number(row.issueSoc) : null,
      amount: row.amount !== null ? Number(row.amount) : null,
      checkoutRequestId: row.checkoutRequestId || null,
      rentalBattery: {
        batteryUid: row.batteryUid,
      },
      sourceSlot: {
        boothUid: row.sourceBoothUid,
        slotIdentifier: row.sourceSlotIdentifier,
      },
      returned: !!row.return_slot_id,
      returnSlot: row.return_slot_id
        ? { boothUid: row.returnBoothUid, slotIdentifier: row.returnSlotIdentifier }
        : null,
      ownDeposit: {
        depositId: row.ownDepositId,
        boothUid: row.ownBoothUid,
        slotIdentifier: row.ownSlotIdentifier,
        initialSoc: row.ownInitialSoc !== null ? Number(row.ownInitialSoc) : null,
        currentSoc: row.ownCurrentSoc !== null ? Number(row.ownCurrentSoc) : null,
      },
    });
  } catch (error) {
    logger.error(`Failed to get active rental for user ${firebaseUid}:`, error);
    return res.status(500).json({ error: 'Failed to retrieve active rental.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/rentals/:sessionId/return
 * @summary Return a rented battery to a booth's empty slot
 * @description Finds an available slot at the given booth, reserves it, records it
 * as the rental's return slot and opens it for deposit. The rental stays
 * 'in_progress' until the consolidated bill is paid.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.post('/rentals/:sessionId/return', verifyFirebaseToken, async (req, res) => {
  const { sessionId } = req.params;
  const { boothUid } = req.body;
  const { uid: firebaseUid } = req.user;

  if (!boothUid) {
    return res.status(400).json({ error: 'boothUid is required.' });
  }

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    const rentalRes = await client.query(
      `SELECT r.id, r.battery_id, b.battery_uid AS "batteryUid",
              bs.slot_identifier AS "sourceSlotIdentifier",
              bo.booth_uid AS "sourceBoothUid"
       FROM deposits r
       JOIN booth_slots bs ON r.slot_id = bs.id
       JOIN booths bo ON bs.booth_id = bo.id
       JOIN batteries b ON r.battery_id = b.id
       WHERE r.id = $1 AND r.user_id = $2
         AND r.session_type = 'rental' AND r.status = 'in_progress'
         AND r.return_slot_id IS NULL
       FOR UPDATE`,
      [sessionId, firebaseUid]
    );
    if (rentalRes.rowCount === 0) {
      throw new Error('RENTAL_NOT_ACTIVE');
    }
    const rental = rentalRes.rows[0];

    const boothRes = await client.query(
      "SELECT id FROM booths WHERE booth_uid = $1 AND status = 'online'",
      [boothUid]
    );
    if (boothRes.rowCount === 0) {
      throw new Error('BOOTH_NOT_AVAILABLE');
    }
    const boothId = boothRes.rows[0].id;

    // Find a free slot, skipping any whose telemetry reports a plugged battery.
    const potentialSlotsRes = await client.query(
      `SELECT id, slot_identifier
       FROM booth_slots
       WHERE booth_id = $1 AND status = 'available'
       ORDER BY slot_identifier ASC`,
      [boothId]
    );

    let assignedSlot = null;
    if (!isDevBooth(boothUid)) {
      const db = getDatabase();
      for (const potentialSlot of potentialSlotsRes.rows) {
        const snapshot = await db.ref(`booths/${boothUid}/slots/${potentialSlot.slot_identifier}`).get();
        if (snapshot.exists()) {
          const telemetry = snapshot.val()?.telemetry || {};
          if (telemetry.plugConnected && telemetry.batteryInserted) {
            continue;
          }
        }
        const reserveRes = await client.query(
          `UPDATE booth_slots SET status = 'opening'
           WHERE id = $1 AND status = 'available'
           RETURNING id, slot_identifier`,
          [potentialSlot.id]
        );
        if (reserveRes.rowCount > 0) {
          assignedSlot = reserveRes.rows[0];
          break;
        }
      }
    } else if (potentialSlotsRes.rows.length > 0) {
      assignedSlot = potentialSlotsRes.rows[0];
    }

    if (!assignedSlot) {
      throw new Error('NO_AVAILABLE_SLOTS');
    }

    await client.query(
      `UPDATE deposits SET return_slot_id = $1,
       notes = COALESCE(notes, '') || '\n[' || NOW() || '] Rental return initiated at booth ' || $2 || '.'
       WHERE id = $3`,
      [assignedSlot.id, boothUid, sessionId]
    );

    if (isDevBooth(boothUid)) {
      // Simulate the rented battery being physically inserted into the return slot.
      const batterySoc = await client.query(
        'SELECT charge_level_percent FROM batteries WHERE id = $1',
        [rental.battery_id]
      );
      const returnSoc = batterySoc.rows[0]?.charge_level_percent ?? null;
      await handleRentalReturnCompletion(client, assignedSlot.id, assignedSlot.slot_identifier, returnSoc);
    } else {
      await getDatabase()
        .ref(`booths/${boothUid}/slots/${assignedSlot.slot_identifier}/command`)
        .update({
          openForDeposit: true,
          openForCollection: false,
        });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      message: `Return slot ${assignedSlot.slot_identifier} opened at ${boothUid}. Place the rented battery inside.`,
      returnSlot: {
        boothUid,
        slotIdentifier: assignedSlot.slot_identifier,
      },
      batteryUid: rental.batteryUid,
      sourceBoothUid: rental.sourceBoothUid,
      sourceSlotIdentifier: rental.sourceSlotIdentifier,
      simulated: isDevBooth(boothUid),
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'RENTAL_NOT_ACTIVE') {
      return res.status(404).json({ error: 'Rental not active', message: 'No active rental found to return.' });
    }
    if (error.message === 'BOOTH_NOT_AVAILABLE') {
      return res.status(409).json({ error: 'Booth not available', message: 'This booth is currently offline or does not exist.' });
    }
    if (error.message === 'NO_AVAILABLE_SLOTS') {
      return res.status(409).json({ error: 'No available slots', message: 'All slots at this booth are occupied. Try another booth.' });
    }

    logger.error(`Failed to return rental ${sessionId} for user ${firebaseUid}:`, error);
    return res.status(500).json({ error: 'Failed to return rental.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * Computes the consolidated rental bill for a returned rental.
 * Mirrors the computation used by the payment endpoint.
 * @param {object} client - The PostgreSQL client (within a transaction).
 * @param {object} rental - The rental row.
 * @returns {Promise<{amount: number, consolidation: object}>} The bill details.
 */
async function computeRentalBill(client, rental) {
  const ownContext = await client.query(
    `SELECT dep.initial_charge_level AS "ownInitialSoc",
            ownS.charge_level_percent AS "ownCurrentSoc"
     FROM deposits r
     JOIN deposits dep ON dep.id = r.consumed_deposit_id
     JOIN booth_slots ownS ON dep.slot_id = ownS.id
     WHERE r.id = $1`,
    [rental.id]
  );
  const ownInitialSoc = Number(ownContext.rows[0]?.ownInitialSoc ?? 0);
  const ownCurrentSoc = Number(ownContext.rows[0]?.ownCurrentSoc ?? 0);
  const ownGained = Math.max(0, ownCurrentSoc - ownInitialSoc);

  const returnContext = await client.query(
    `SELECT retS.charge_level_percent AS "returnSoc"
     FROM deposits r
     JOIN booth_slots retS ON r.return_slot_id = retS.id
     WHERE r.id = $1`,
    [rental.id]
  );
  const returnSoc = Number(returnContext.rows[0]?.returnSoc ?? 0);
  const issueSoc = Number(rental.initial_charge_level ?? returnSoc);
  const energyGone = Math.max(0, issueSoc - returnSoc);

  const durationMs = new Date() - new Date(rental.created_at);
  const durationMinutes = Math.max(0, Math.round(durationMs / 60000));

  // --- Pricing: prefer new `rental` settings; fall back to legacy `pricing` keys ---
  const [rentalSettingsRes, pricingRes] = await Promise.all([
    client.query("SELECT value FROM app_settings WHERE key = 'rental'"),
    client.query("SELECT value FROM app_settings WHERE key = 'pricing'"),
  ]);
  const rent = rentalSettingsRes.rows[0]?.value || null;
  const p = pricingRes.rows[0]?.value || {};
  const baseSwapFee = Number(p.base_swap_fee || 0);
  const costPerChargePercent = Number(p.cost_per_charge_percent || 0);

  // Time rate: new `rental` key first, then legacy pricing key.
  const rentalTimeFeePerMinute = rent != null
    ? Number(rent.rental_time_rate_per_minute ?? 0)
    : Number(p.rental_time_fee_per_minute || 0);

  // Energy rate: new key is per full battery (KES/kWh → per 100%-points = rate/100).
  // Legacy key is already per %-point so no division needed.
  const energyRatePerPoint = rent != null
    ? Number(rent.rental_energy_rate_per_kwh ?? 0) / 100
    : Number(p.rental_energy_rate_per_percent || 0);

  const ownChargingCost = Math.max(baseSwapFee, ownGained * costPerChargePercent);
  const rentalEnergyCost = energyGone * energyRatePerPoint;
  const rentalTimeCost = durationMinutes * rentalTimeFeePerMinute;
  const amount = Number((ownChargingCost + rentalEnergyCost + rentalTimeCost).toFixed(2));

  return {
    amount,
    consolidation: {
      ownCharging: Number(ownChargingCost.toFixed(2)),
      rentalEnergy: Number(rentalEnergyCost.toFixed(2)),
      rentalTime: Number(rentalTimeCost.toFixed(2)),
      durationMinutes,
      energyGone: Number(energyGone.toFixed(1)),
      ownGained: Number(ownGained.toFixed(1)),
    },
  };
}

/**
 * GET /api/booths/rentals/:sessionId/bill
 * @summary Preview the consolidated rental bill after a return
 * @description Read-only: returns the own-charging + rental energy + rental time
 * breakdown without initiating any payment.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.get('/rentals/:sessionId/bill', verifyFirebaseToken, async (req, res) => {
  const { sessionId } = req.params;
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    const rentalRes = await client.query(
      `SELECT id, status, initial_charge_level, created_at
       FROM deposits
       WHERE id = $1 AND user_id = $2
         AND session_type = 'rental'
         AND status IN ('in_progress', 'failed')
         AND return_slot_id IS NOT NULL`,
      [sessionId, firebaseUid]
    );
    if (rentalRes.rowCount === 0) {
      return res.status(404).json({ error: 'Rental not returned', message: 'No returned rental found to bill.' });
    }

    const { amount, consolidation } = await computeRentalBill(client, rentalRes.rows[0]);
    return res.status(200).json({ sessionId: Number(sessionId), amount, consolidation });
  } catch (error) {
    logger.error(`Failed to compute bill for rental ${sessionId}:`, error);
    return res.status(500).json({ error: 'Failed to compute bill.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/rentals/:sessionId/pay
 * @summary Pay the consolidated rental bill
 * @description Computes own-charging + rental energy + rental time from the pricing
 * rules, then initiates an M-Pesa STK push. In dev mode the payment is auto-approved.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.post('/rentals/:sessionId/pay', verifyFirebaseToken, async (req, res) => {
  const { sessionId } = req.params;
  const { uid: firebaseUid, phone_number: userPhone } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    await client.query('BEGIN');

    const rentalRes = await client.query(
      `SELECT r.id, r.status, r.initial_charge_level,
              r.created_at, r.mpesa_checkout_id, r.amount
       FROM deposits r
       WHERE r.id = $1 AND r.user_id = $2
         AND r.session_type = 'rental'
         AND r.status IN ('in_progress', 'failed')
         AND r.return_slot_id IS NOT NULL
       FOR UPDATE`,
      [sessionId, firebaseUid]
    );
    if (rentalRes.rowCount === 0) {
      throw new Error('RENTAL_NOT_RETURNED');
    }
    const rental = rentalRes.rows[0];

    const { amount: totalCost, consolidation } = await computeRentalBill(client, rental);

    await client.query('UPDATE deposits SET amount = $1 WHERE id = $2', [totalCost, sessionId]);

    // 4. Dev mode: skip M-Pesa, auto-approve the consolidated bill.
    if (req.user.role === 'developer') {
      const devCheckoutId = `DEV_${sessionId}_${Date.now()}`;
      await client.query(
        "UPDATE deposits SET mpesa_checkout_id = $1, started_at = NOW() WHERE id = $2",
        [devCheckoutId, sessionId]
      );
      await completePaidRental(client, devCheckoutId);
      await client.query('COMMIT');
      return res.status(200).json({
        message: 'Payment auto-approved (dev mode).',
        amount: totalCost,
        consolidation,
        paymentStatus: 'paid',
        checkoutRequestId: devCheckoutId,
      });
    }

    // 5. Real M-Pesa STK push.
    const mpesaResponse = await initiateSTKPush({
      phone: userPhone,
      amount: totalCost,
      accountReference: `rental_${sessionId}`,
      transactionDesc: `Consolidated battery rental payment ${sessionId}`,
    });
    const checkoutRequestId = mpesaResponse.data.CheckoutRequestID;

    await client.query(
      "UPDATE deposits SET mpesa_checkout_id = $1, started_at = NOW() WHERE id = $2",
      [checkoutRequestId, sessionId]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'STK push sent. Please complete the payment on your phone.',
      amount: totalCost,
      consolidation,
      checkoutRequestId,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'RENTAL_NOT_RETURNED') {
      return res.status(404).json({ error: 'Rental not returned', message: 'Return the rented battery before paying.' });
    }
    if (error.message === 'PRICING_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Pricing not configured', message: 'Pricing settings are not configured in the database.' });
    }

    if (error.isAxiosError) {
      logger.error(`M-Pesa API error details for rental ${sessionId}:`, { request: error.config, response: error.response?.data });
    } else {
      logger.error(`Failed to trigger payment for rental ${sessionId}:`, error);
    }
    return res.status(500).json({ error: 'Failed to trigger payment.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/booths/rentals/status/:checkoutRequestId
 * @summary Poll the rental payment status
 * @description Mirrors the withdrawal status endpoint: handles dev auto-approval,
 * already-processed callbacks, and self-healing by querying M-Pesa when a payment
 * has been stuck pending past the timeout.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.get('/rentals/status/:checkoutRequestId', verifyFirebaseToken, async (req, res) => {
  const { checkoutRequestId } = req.params;
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    const sessionQuery = await client.query(
      "SELECT id, status, started_at FROM deposits WHERE mpesa_checkout_id = $1 AND user_id = $2 AND session_type = 'rental'",
      [checkoutRequestId, firebaseUid]
    );
    if (sessionQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Rental session not found.' });
    }

    const { id: sessionId, status, started_at: startedAt } = sessionQuery.rows[0];

    if (checkoutRequestId.startsWith('DEV_')) {
      return res.status(200).json({ paymentStatus: 'paid' });
    }

    if (status === 'completed') {
      return res.status(200).json({ paymentStatus: 'paid' });
    }
    if (status !== 'in_progress') {
      return res.status(200).json({ paymentStatus: status });
    }

    const PENDING_TIMEOUT_SECONDS = parseInt(process.env.MPESA_PENDING_TIMEOUT_SECONDS, 10) || 60;
    const secondsSinceStart = (new Date() - new Date(startedAt)) / 1000;
    if (secondsSinceStart < PENDING_TIMEOUT_SECONDS) {
      return res.status(200).json({ paymentStatus: 'pending' });
    }

    try {
      logger.info(`Rental ${sessionId} is stuck in payment. Proactively querying M-Pesa status for ${checkoutRequestId}...`);
      const mpesaStatusResponse = await querySTKStatus(checkoutRequestId);
      const { ResultCode, ResultDesc } = mpesaStatusResponse.data;

      if (ResultCode === '0') {
        logger.info(`M-Pesa query confirmed rental payment for ${checkoutRequestId}. Manually completing session.`);
        await completePaidRental(client, checkoutRequestId);
        return res.status(200).json({ paymentStatus: 'paid' });
      }

      logger.warn(`M-Pesa query for ${checkoutRequestId} returned non-success code: ${ResultCode} (${ResultDesc}). Keeping status as pending.`);
      return res.status(200).json({ paymentStatus: 'pending', reason: ResultDesc });
    } catch (mpesaError) {
      const errorData = mpesaError.response?.data;
      const errorDetail = errorData ? (errorData.errorMessage || JSON.stringify(errorData)) : mpesaError.message;
      logger.error(`Self-healing failed to query M-Pesa for ${checkoutRequestId}: ${errorDetail}`);
      return res.status(200).json({ paymentStatus: 'pending' });
    }
  } catch (error) {
    logger.error(`Failed to get rental status for checkoutId ${checkoutRequestId}:`, error);
    return res.status(500).json({ error: 'Failed to retrieve rental status.', details: error.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/booths/rentals/:sessionId/unlock-own
 * @summary Unlock and collect the user's own newly-charged battery
 * @description Only allowed once the consolidated rental bill is fully paid
 * (rental status 'completed'). Opens the booth slot holding the user's own battery.
 * @tags [Booths]
 * @security - bearerAuth: []
 */
router.post('/rentals/:sessionId/unlock-own', verifyFirebaseToken, async (req, res) => {
  const { sessionId } = req.params;
  const { uid: firebaseUid } = req.user;

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);
  try {
    await client.query('BEGIN');

    await client.query(
      'SELECT id FROM users WHERE user_id = $1 FOR UPDATE',
      [firebaseUid]
    );

    const rentalRes = await client.query(
      `SELECT id FROM deposits
       WHERE id = $1 AND user_id = $2
         AND session_type = 'rental' AND status = 'completed'
       FOR UPDATE`,
      [sessionId, firebaseUid]
    );
    if (rentalRes.rowCount === 0) {
      throw new Error('RENTAL_NOT_PAID');
    }

    const ownSlot = await getRentalOwnSlot(client, Number(sessionId));
    if (!ownSlot) {
      throw new Error('OWN_BATTERY_NOT_FOUND');
    }

    // The own slot must still physically contain the user's battery.
    const ownSlotState = await client.query(
      `SELECT status FROM booth_slots
       WHERE id = $1 AND status = 'occupied' AND current_battery_id IS NOT NULL`,
      [ownSlot.slotId]
    );
    if (ownSlotState.rowCount === 0) {
      throw new Error('OWN_BATTERY_NOT_FOUND');
    }

    const { boothUid, slotIdentifier, slotId } = ownSlot;

    if (isDevBooth(boothUid)) {
      await finalizeRentalSession(client, slotId, slotIdentifier, Number(sessionId));
      logger.info(`Dev booth: simulated own-battery collection for rental ${sessionId}.`);
    } else {
      await getDatabase()
        .ref(`booths/${boothUid}/slots/${slotIdentifier}/command`)
        .update({
          openForCollection: true,
          openForDeposit: false,
        });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      message: isDevBooth(boothUid)
        ? 'Your own battery is released. Please collect it.'
        : `Your own battery slot ${slotIdentifier} is opening. Please collect your battery.`,
      ownSlot: {
        boothUid,
        slotIdentifier,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.message === 'RENTAL_NOT_PAID') {
      return res.status(409).json({ error: 'Rental not paid', message: 'Settle the consolidated bill before collecting your own battery.' });
    }
    if (error.message === 'OWN_BATTERY_NOT_FOUND') {
      return res.status(404).json({ error: 'Own battery not found', message: 'Your deposited battery could not be located.' });
    }

    logger.error(`Failed to unlock own battery for rental ${sessionId} (user ${firebaseUid}):`, error);
    return res.status(500).json({ error: 'Failed to unlock own battery.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;