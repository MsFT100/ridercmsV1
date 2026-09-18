/**
 * Diagnoses occupied slots whose battery is physically present but whose renter
 * name does not resolve ("Rented By: None" in the admin UI) and categorizes the
 * root cause per slot:
 *
 *    OK                 — renter resolves normally
 *    EMPTY_SLOT         — no battery detected
 *    MISSING_BATTERY_LINK — battery present + completed deposit, but
 *                           booth_slots.current_battery_id IS NULL
 *    DEPOSIT_FAILED     — battery present, only 'failed' deposits (re-syncable)
 *    CONSUMED           — battery present, all completed deposits consumed
 *    BATTERY_MISMATCH   — completed deposit battery doesn't match slot's battery
 *    NO_DEPOSIT_RECORD  — battery present, zero deposits at all
 *    USER_MISSING       — deposit's user row is gone
 *
 * Read-only: runs only SELECT queries. Usage: node scripts/diagnose-slot-batteries.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const poolPromise = require('../db');

const ALLOWED_EMPTY_STATUSES = ['available'];

/**
 * Mirrors the LATERAL renter-selection used by the admin booth queries:
 * most recent completed deposit NOT consumed by a non-failed/non-cancelled
 * withdrawal, with legacy NULL-battery deposits trusted on occupied slots.
 * @param {Array<{id:number,userId:string|null,batteryId:number|null,completedAt:Date|null,status:string}>} deposits - All deposits on the slot.
 * @param {Array<{consumedDepositId:number,status:string}>} withdrawals - All withdrawals on the slot.
 * @param {number|null} slotBatteryId - The slot's current battery id.
 * @returns {object|null} The winning deposit, or null.
 */
function selectRenter(deposits, withdrawals, slotBatteryId) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  const eligible = deposits
    .filter((d) => !consumedIds.has(d.id))
    // Legacy NULL-battery deposits are trusted on occupied slots.
    .filter((d) => d.batteryId == null || d.batteryId === slotBatteryId)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  return eligible.length > 0 ? eligible[0] : null;
}

/**
 * @param {object} slot - A row from the slots query.
 * @param {Array} slotDeposits - All deposits on this slot.
 * @param {Array} slotWithdrawals - All withdrawals on this slot.
 * @returns {object} The categorization result.
 */
function categorizeSlot(slot, slotDeposits, slotWithdrawals) {
  const telemetry = slot.telemetry || {};
  const batteryPresent =
    slot.slot_status === 'occupied' ||
    slot.current_battery_id != null ||
    telemetry.batteryInserted === true;

  if (!batteryPresent) {
    if (ALLOWED_EMPTY_STATUSES.includes(slot.slot_status) || slot.slot_status == null) {
      return { issue: 'EMPTY_SLOT', detail: `DB status=${slot.slot_status}` };
    }
    return { issue: 'EMPTY_SLOT', detail: `DB status=${slot.slot_status} (no battery detected)` };
  }

  const completed = slotDeposits.filter((d) => d.status === 'completed');
  const failed = slotDeposits.filter((d) => d.status === 'failed');
  const winner = selectRenter(completed, slotWithdrawals, slot.current_battery_id);

  if (!winner) {
    if (completed.length > 0 && slot.current_battery_id != null) {
      // Some completed deposit exists but none matched the slot's battery —
      // either consumed (check) or a real battery mismatch.
      const allConsumed = completed.every((d) =>
        slotWithdrawals.some(
          (w) =>
            w.consumedDepositId === d.id &&
            w.status !== 'failed' &&
            w.status !== 'cancelled'
        )
      );
      if (allConsumed) {
        return { issue: 'CONSUMED', detail: `${completed.length} completed deposit(s) all withdrawn` };
      }
      return {
        issue: 'BATTERY_MISMATCH',
        detail: `slot battery_id=${slot.current_battery_id}; deposits=${JSON.stringify(
          completed.map((d) => ({ id: d.id, batteryId: d.batteryId, userId: d.userId }))
        )}`,
      };
    }
    if (completed.length === 0 && failed.length > 0) {
      return { issue: 'DEPOSIT_FAILED', detail: `${failed.length} failed deposit(s), no completed` };
    }
    return { issue: 'NO_DEPOSIT_RECORD', detail: `${slotDeposits.length} deposit(s), none completed` };
  }

  if (slot.current_battery_id == null) {
    return {
      issue: 'MISSING_BATTERY_LINK',
      detail: `deposit id=${winner.id}, completed_at=${winner.completedAt}, battery_id=${winner.batteryId}`,
      winner,
    };
  }

  if (!winner.userId) {
    return { issue: 'USER_MISSING', detail: `deposit id=${winner.id}, user_id=${winner.userId}`, winner };
  }

  return { issue: 'OK', detail: `deposit id=${winner.id}, user_id=${winner.userId}`, winner };
}

/**
 * Runs the diagnostic: lists every slot with its categorization.
 * @returns {Promise<void>}
 */
async function diagnose() {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    const slotsQuery = `
      SELECT
        b.booth_uid,
        b.name AS booth_name,
        s.id AS slot_id,
        s.slot_identifier,
        s.status AS slot_status,
        s.current_battery_id,
        s.charge_level_percent,
        s.telemetry,
        bat.battery_uid
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      LEFT JOIN batteries bat ON s.current_battery_id = bat.id
      ORDER BY b.booth_uid, s.slot_identifier;
    `;
    const { rows: slots } = await client.query(slotsQuery);

    if (slots.length === 0) {
      console.log('No slots found.');
      return;
    }

    const slotIds = slots.map((s) => s.slot_id);

    const depositsQuery = `
      SELECT
        d.id, d.slot_id, d.user_id, d.session_type, d.status,
        d.battery_id, d.consumed_deposit_id, d.completed_at, d.initial_charge_level
      FROM deposits d
      WHERE d.slot_id = ANY($1::int[])
      ORDER BY d.slot_id, d.completed_at DESC NULLS LAST, d.id DESC;
    `;
    const { rows: depositRows } = await client.query(depositsQuery, [slotIds]);

    const usersQuery = `
      SELECT user_id, name, phone
      FROM users
      WHERE user_id = ANY($1::text[]);
    `;
    const userIds = [...new Set(depositRows.map((d) => d.userId ?? d.user_id).filter(Boolean))];
    const { rows: userRows } = await client.query(usersQuery, [userIds]);
    const userMap = new Map(userRows.map((u) => [u.user_id, u]));

    const bySlot = new Map();
    for (const slot of slots) bySlot.set(slot.slot_id, { deposits: [], withdrawals: [] });

    if (slotIds.length > 0) {
      for (const d of depositRows) {
        const bucket = bySlot.get(d.slot_id);
        if (!bucket) continue;
        if (d.session_type === 'deposit') {
          bucket.deposits.push({
            id: d.id,
            userId: d.user_id,
            batteryId: d.battery_id,
            completedAt: d.completed_at ? new Date(d.completed_at).getTime() : 0,
            status: d.status,
          });
        } else {
          bucket.withdrawals.push({ consumedDepositId: d.consumed_deposit_id, status: d.status });
        }
      }
    }

    const summary = { OK: 0, EMPTY_SLOT: 0, MISSING_BATTERY_LINK: 0, DEPOSIT_FAILED: 0, CONSUMED: 0, BATTERY_MISMATCH: 0, NO_DEPOSIT_RECORD: 0, USER_MISSING: 0 };

    for (const slot of slots) {
      const bucket = bySlot.get(slot.slot_id);
      const result = categorizeSlot(slot, bucket?.deposits ?? [], bucket?.withdrawals ?? []);
      summary[result.issue] = (summary[result.issue] || 0) + 1;

      const user = result.winner?.userId ? userMap.get(result.winner.userId) : null;
      const userName = user ? `${user.name} (${user.phone || 'no phone'})` : '-';

      console.log(
        [
          `${slot.booth_uid}/${slot.slot_identifier}`,
          `DB=${slot.slot_status}`,
          `battery=${slot.battery_uid || 'NULL'}`,
          `soc=${slot.charge_level_percent ?? '-'}`,
          slot.telemetry?.batteryInserted === true ? 'fbBattery=true' : 'fbBattery=false',
          `=> ${result.issue}`,
          result.detail,
          `renter: ${userName}`,
        ].join('  ')
      );
    }

    console.log('\n--- Summary ---');
    for (const [issue, count] of Object.entries(summary)) {
      if (count > 0) console.log(`  ${issue}: ${count}`);
    }
    console.log(`\nTotal slots: ${slots.length}`);
  } catch (error) {
    console.error('Diagnostic failed:', error);
  } finally {
    client.release();
  }
}

diagnose()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });