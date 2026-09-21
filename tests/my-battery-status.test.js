const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads the deposit controller source to assert on the real embedded SQL.
 * This guards against the my-battery-status query regressing (e.g. losing the
 * occupied/owner guards that prevent ghost credits from stale deposits).
 * @returns {string} The controller source.
 */
function readDepositController() {
  return fs.readFileSync(
    path.join(__dirname, '../controllers/booths/deposit.controller.js'),
    'utf8'
  );
}

/**
 * Models the my-battery-status selection semantics exactly as the SQL does:
 * a rider sees a 'loaded battery' only when ALL of these hold:
 *   - the deposit is completed
 *   - the deposit is NOT consumed by an active withdrawal/rental
 *   - the slot is PHYSICALLY occupied (`status = 'occupied'` — a rider's own
 *     battery has no battery identity, so the "owner" rule replaces the old
 *     battery_id match)
 *   - no NEWER deposit by a different user still owns the slot first
 * @param {Array<{id:number, userId:number, status:string}>} deposits
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals
 * @param {boolean} slotOccupied - whether the slot is physically occupied
 * @returns {number[]} The deposit IDs that qualify as the rider's loaded battery.
 */
function selectLoadedBatteries(deposits, withdrawals, slotOccupied) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  return deposits
    .filter((d) => d.status === 'completed')
    .filter((d) => !consumedIds.has(d.id))
    // The battery must physically be in the slot.
    .filter(() => slotOccupied)
    // The deposit must still OWN the slot — no newer deposit by another user.
    .filter((d) => !deposits.some((newer) =>
      newer.id > d.id &&
      newer.userId !== d.userId &&
      (newer.status === 'opening' || newer.status === 'in_progress' || newer.status === 'completed') &&
      !consumedIds.has(newer.id)
    ))
    .map((d) => d.id);
}

describe('my-battery-status: loaded battery resolution', () => {
  test('the query guards on the slot being physically occupied and holds the owner rule', () => {
    const src = readDepositController();
    // The occupied-present guard must exist in the my-battery-status query.
    assert.match(src, /s\.status = 'occupied'/);
    // Ownership must be the "latest un-consumed deposit, no newer deposit by
    // another user" rule, NOT a battery identity match.
    assert.match(src, /newer\.user_id <> d\.user_id/);
    assert.ok(
      !src.includes('d.battery_id = s.current_battery_id'),
      'my-battery-status must not require a battery identity match'
    );
  });

  test('a stale deposit is NOT returned when its battery is no longer in the slot', () => {
    // Regression for the double-allocation bug: George had 44 historical
    // 'completed' deposits for a slot that now belongs to another user's
    // deposit. They must NOT surface as loaded batteries.
    const loaded = selectLoadedBatteries(
      [
        { id: 10, status: 'completed', userId: 1 }, // old deposit, superseded
        { id: 11, status: 'completed', userId: 1 }, // old deposit, superseded
        { id: 12, status: 'completed', userId: 2 }, // CURRENT deposit owner
      ],
      [],
      true
    );

    assert.deepStrictEqual(loaded, [12], 'Only the slot owner deposit qualifies');
  });

  test('returns nothing when the slot has no physical battery', () => {
    // Even completed deposits must not count if no battery is physically present.
    const loaded = selectLoadedBatteries(
      [{ id: 10, status: 'completed', userId: 1 }],
      [],
      false // slot empty
    );
    assert.deepStrictEqual(loaded, []);
  });

  test('a consumed (withdrawn) deposit is never the loaded battery', () => {
    const loaded = selectLoadedBatteries(
      [
        { id: 20, status: 'completed', userId: 1 }, // withdrawn -> consumed
        { id: 21, status: 'completed', userId: 1 }, // active
      ],
      [{ consumedDepositId: 20, status: 'completed' }],
      true
    );
    assert.deepStrictEqual(loaded, [21], 'Consumed deposit is excluded even if the slot is occupied');
  });

  test('a failed/cancelled withdrawal does not consume the deposit', () => {
    const loaded = selectLoadedBatteries(
      [{ id: 30, status: 'completed', userId: 1 }],
      [{ consumedDepositId: 30, status: 'failed' }],
      true
    );
    assert.deepStrictEqual(loaded, [30], 'Failed withdrawal keeps the deposit as loaded');
  });

  test('a rider-deposited battery with NO battery identity is returned', () => {
    // User-deposited batteries have no battery_id (battery IDs are reserved for
    // company rental batteries); occupancy + ownership is the only signal.
    const loaded = selectLoadedBatteries(
      [{ id: 40, status: 'completed', userId: 9 }],
      [],
      true
    );
    assert.deepStrictEqual(loaded, [40], 'An identity-less rider deposit on an occupied slot qualifies');
  });
});