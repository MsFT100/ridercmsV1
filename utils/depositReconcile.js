const logger = require('./logger');

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
 * @param {object} pgClient - A connected pg client (schema already resolved).
 * @param {number} slotId - The primary key of `booth_slots`.
 * @param {string} slotIdentifier - The slot identifier, for logging.
 * @returns {Promise<{reconciled: boolean, depositId: number|null, previousStatus: string|null, newStatus: string|null, reason: string}>} The reconciliation outcome.
 */
async function reconcileSlotDeposit(pgClient, slotId, slotIdentifier) {
  const slotRes = await pgClient.query(
    `SELECT status
     FROM booth_slots
     WHERE id = $1`,
    [slotId]
  );

  if (slotRes.rows.length === 0) {
    return { reconciled: false, depositId: null, previousStatus: null, newStatus: null, reason: 'slot_not_found' };
  }

  const { status: slotStatus } = slotRes.rows[0];

  // Only reconcile when telemetry shows a battery physically present in the slot.
  // A battery in the slot reports `status = 'occupied'` in the DB (a live "charging"
  // label is driven by telemetry `is_charging`, not the status enum). If the slot is
  // empty/available, there is nothing attached to that failed deposit to recover.
  if (slotStatus !== 'occupied') {
    return { reconciled: false, depositId: null, previousStatus: null, newStatus: null, reason: 'slot_empty' };
  }

  // Find the most recent failed deposit on this slot that no active/non-failed
  // withdrawal already consumed (mirrors the orphan-cleanup guard).
  const depositRes = await pgClient.query(
    `SELECT d.id, d.status
     FROM deposits d
     WHERE d.slot_id = $1
       AND d.session_type = 'deposit'
       AND d.status = 'failed'
       AND NOT EXISTS (
         SELECT 1 FROM deposits w
         WHERE w.consumed_deposit_id = d.id
           AND w.session_type = 'withdrawal'
           AND w.status NOT IN ('cancelled', 'failed')
       )
     ORDER BY d.id DESC
     LIMIT 1`,
    [slotId]
  );

  if (depositRes.rows.length === 0) {
    return { reconciled: false, depositId: null, previousStatus: null, newStatus: null, reason: 'no_failed_deposit' };
  }

  const { id: depositId } = depositRes.rows[0];

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

  if (updateRes.rowCount === 0) {
    return { reconciled: false, depositId, previousStatus: 'failed', newStatus: 'failed', reason: 'already_resolved' };
  }

  logger.info(`Reconciled deposit ${depositId} on slot ${slotIdentifier}: 'failed' -> 'completed' (battery present in occupied slot).`);
  return { reconciled: true, depositId, previousStatus: 'failed', newStatus: 'completed', reason: 'battery_present' };
}

module.exports = { reconcileSlotDeposit };
