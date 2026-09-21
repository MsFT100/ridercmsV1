const logger = require('./logger');

/**
 * Normalizes a raw SOC value to an integer between 1 and 100.
 * @param {any} rawSoc - The raw SOC value.
 * @returns {number|null} The normalized SOC or null if invalid.
 */
function normalizeSoc(rawSoc) {
  const parsed = Number(rawSoc);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return null;
  }
  return Math.round(parsed);
}

/**
 * Re-links a slot to its owner deposit's EXISTING battery row, when one exists.
 *
 * Battery IDs are reserved for the company's rental batteries. A rider's own
 * deposited battery never gets a synthetic `bat-<slotId>-<epoch>` battery
 * fabricated (that is exactly how "ghost" rental-pool batteries were created).
 * The slot's physical presence is tracked by `status = 'occupied'`, so a
 * rider-deposited battery legitimately keeps `current_battery_id` NULL.
 *
 * This helper only re-links a REAL battery the current owner deposit already
 * references (e.g. `firebaseSync.syncSlotState` cleared `current_battery_id` on
 * a telemetry flicker but the deposit still knows its battery) and only when a
 * deposit actually owns the slot — an occupied slot with NO owner deposit gets
 * nothing.
 * @param {object} pgClient - A connected pg client (schema already resolved).
 * @param {number} slotId - The primary key of `booth_slots`.
 * @param {string} slotIdentifier - The slot identifier, for logging.
 * @param {number|null} [chargeLevel] - Kept for call-site compatibility; unused.
 * @returns {Promise<{relinked: boolean, batteryId: number|null, batteryUid: string|null, reason: string}>} The linking outcome.
 */
async function ensureSlotBatteryLinked(pgClient, slotId, slotIdentifier, chargeLevel = null) {
  const slotRes = await pgClient.query(
    `SELECT current_battery_id
     FROM booth_slots
     WHERE id = $1`,
    [slotId]
  );

  if (slotRes.rows.length === 0) {
    return { relinked: false, batteryId: null, batteryUid: null, reason: 'slot_not_found' };
  }

  const { current_battery_id: currentBatteryId } = slotRes.rows[0];

  if (currentBatteryId != null) {
    return { relinked: false, batteryId: currentBatteryId, batteryUid: null, reason: 'already_linked' };
  }

  // Only re-link a battery when a deposit actually owns this slot. An occupied
  // slot with NO owner deposit — e.g. the deposit was consumed by a withdrawal,
  // or the battery is unowned — must NOT get a battery fabricated.
  const ownerRes = await pgClient.query(
    `SELECT d.id, d.battery_id
     FROM deposits d
     WHERE d.slot_id = $1
       AND d.session_type = 'deposit'
       AND d.status IN ('opening', 'in_progress', 'completed')
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
           AND newer.status IN ('opening', 'in_progress', 'completed')
           AND NOT EXISTS (
             SELECT 1 FROM deposits w2
             WHERE w2.consumed_deposit_id = newer.id
               AND w2.session_type IN ('withdrawal', 'rental')
               AND w2.status NOT IN ('cancelled', 'failed')
           )
       )
     ORDER BY d.completed_at DESC, d.id DESC
     LIMIT 1`,
    [slotId]
  );

  const ownerDeposit = ownerRes.rows[0];
  if (!ownerDeposit) {
    return { relinked: false, batteryId: null, batteryUid: null, reason: 'no_owner_deposit' };
  }

  const existingBatteryId = ownerDeposit.battery_id;
  if (existingBatteryId != null) {
    // The owner deposit already links a real battery (a telemetry flicker cleared
    // current_battery_id but the deposit still knows its battery): re-link that
    // SAME battery instead of fabricating a new synthetic one.
    await pgClient.query(
      'UPDATE booth_slots SET current_battery_id = $1, updated_at = NOW() WHERE id = $2',
      [existingBatteryId, slotId]
    );
    logger.info(`Re-linked existing battery id=${existingBatteryId} to slot ${slotIdentifier} (no fabrication).`);
    return { relinked: true, batteryId: existingBatteryId, batteryUid: null, reason: 'relinked_existing' };
  }

  // A user's own deposited battery has no battery identity — battery IDs are
  // reserved for the company's rental batteries. Previously we fabricated a
  // synthetic `bat-<slotId>-<epoch>` battery here; that produced ghastly
  // "ghost" rental-pool batteries and stamped fake IDs onto rider deposits.
  // Slot occupancy is now tracked by `status = 'occupied'`, so a rider-deposited
  // battery legitimately keeps current_battery_id/battery_id NULL.
  return { relinked: false, batteryId: null, batteryUid: null, reason: 'no_battery_for_personal_deposit' };
}

/**
 * Reconciles a slot's deposit status against the physical battery presence.
 * Background: a deposit is free (no M-Pesa payment). Its `status` can be
 * wrongly flipped to `failed` by defensive cleanup in `firebaseSync` when a
 * transient telemetry flicker reports `batteryInserted = false`, even though
 * the battery is still physically (and, a moment later, telemetrically) present
 * in the slot. Because `my-battery-status` only surfaces `completed` deposits,
 * the user's battery effectively disappears and a withdrawal cannot be started.
 * This is the symmetric inverse: if a `failed` deposit still has its battery in
 * the slot (and no active/non-failed withdrawal consumed it), restore it to
 * `completed` so the user's credit and withdrawal path are recovered.
 *
 * The same telemetry flicker also cleared `current_battery_id`, so when a slot
 * is re-confirmed occupied we re-link a battery record (see
 * `ensureSlotBatteryLinked`) — otherwise "Rented By: None" persists in the UI.
 * @param {object} pgClient - A connected pg client (schema already resolved).
 * @param {number} slotId - The primary key of `booth_slots`.
 * @param {string} slotIdentifier - The slot identifier, for logging.
 * @returns {Promise<{reconciled: boolean, depositId: number|null, previousStatus: string|null, newStatus: string|null, reason: string, relinked: boolean, batteryId: number|null}>} The reconciliation outcome.
 */
async function reconcileSlotDeposit(pgClient, slotId, slotIdentifier) {
  const slotRes = await pgClient.query(
    `SELECT status, charge_level_percent
     FROM booth_slots
     WHERE id = $1`,
    [slotId]
  );

  if (slotRes.rows.length === 0) {
    return { reconciled: false, depositId: null, previousStatus: null, newStatus: null, reason: 'slot_not_found', relinked: false, batteryId: null };
  }

  const { status: slotStatus, charge_level_percent: slotCharge } = slotRes.rows[0];

  // Only reconcile when telemetry shows a battery physically present in the slot.
  // A battery in the slot reports `status = 'occupied'` in the DB (a live "charging"
  // label is driven by telemetry `is_charging`, not the status enum). If the slot is
  // empty/available, there is nothing attached to that failed deposit to recover.
  if (slotStatus !== 'occupied') {
    return { reconciled: false, depositId: null, previousStatus: null, newStatus: null, reason: 'slot_empty', relinked: false, batteryId: null };
  }

  // Find the most recent failed deposit on this slot that no active/non-failed
  // withdrawal already consumed (mirrors the orphan-cleanup guard). A failed
  // deposit may ONLY be resurrected if it is still the slot's owner — i.e. its
  // battery matches the battery physically in the slot (or is a legacy NULL
  // link that is trusted on an occupied slot) AND no NEWER completed deposit
  // already owns that battery. Otherwise resurrecting it stamps another user's
  // battery onto this user's deposit, making a past session reappear as a
  // "ghost battery" via my-battery-status.
  const depositRes = await pgClient.query(
    `SELECT d.id, d.status
     FROM deposits d
     WHERE d.slot_id = $1
       AND d.session_type = 'deposit'
       AND d.status = 'failed'
       AND (
         d.battery_id IS NULL
         OR d.battery_id = (SELECT bs.current_battery_id FROM booth_slots bs WHERE bs.id = $1)
       )
       AND NOT EXISTS (
         SELECT 1 FROM deposits w
         WHERE w.consumed_deposit_id = d.id
           AND w.session_type = 'withdrawal'
           AND w.status NOT IN ('cancelled', 'failed')
       )
       AND NOT EXISTS (
         SELECT 1 FROM deposits newer
         WHERE newer.slot_id = d.slot_id
           AND newer.session_type = 'deposit'
           AND newer.id > d.id
           AND newer.status = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM deposits w2
             WHERE w2.consumed_deposit_id = newer.id
               AND w2.session_type = 'withdrawal'
               AND w2.status NOT IN ('cancelled', 'failed')
           )
       )
     ORDER BY d.id DESC
     LIMIT 1`,
    [slotId]
  );

  let reconciled = false;
  let previousStatus = null;
  let newStatus = null;
  let reason = 'no_failed_deposit';
  let depositId = null;

  if (depositRes.rows.length > 0) {
    depositId = depositRes.rows[0].id;
    previousStatus = depositRes.rows[0].status;

    const updateRes = await pgClient.query(
      `UPDATE deposits
       SET status = 'completed',
           completed_at = COALESCE(completed_at, NOW()),
           notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit reconciled: battery confirmed present in slot.'
       WHERE id = $1
         AND status = 'failed'
       RETURNING id`,
      [depositId]
    );

    if (updateRes.rowCount > 0) {
      reconciled = true;
      newStatus = 'completed';
      reason = 'battery_present';
      logger.info(`Reconciled deposit ${depositId} on slot ${slotIdentifier}: 'failed' -> 'completed' (battery present in occupied slot).`);
    } else {
      reason = 'already_resolved';
    }
  }

  // Ensure the occupied slot has a linked battery so renter resolution,
  // withdrawal-info and manual withdrawals work again.
  const link = await ensureSlotBatteryLinked(pgClient, slotId, slotIdentifier, slotCharge);

  return { reconciled, depositId, previousStatus, newStatus, reason, relinked: link.relinked, batteryId: link.batteryId };
}

module.exports = { reconcileSlotDeposit, ensureSlotBatteryLinked, normalizeSoc };