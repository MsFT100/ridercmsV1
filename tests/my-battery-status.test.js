const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads the deposit controller source to assert on the real embedded SQL.
 * This guards against the my-battery-status query regressing (e.g. losing the
 * battery-present guard that prevents ghost credits from stale deposits).
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
 *   - the deposit is NOT consumed by an active withdrawal
 *   - the deposit's battery is the one PHYSICALLY in the slot right now
 * @param {Array<{id:number, status:string, batteryId:number|null}>} deposits
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals
 * @param {number|null} slotBatteryId - the slot's current_battery_id
 * @returns {number[]} The deposit IDs that qualify as the rider's loaded battery.
 */
function selectLoadedBatteries(deposits, withdrawals, slotBatteryId) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  return deposits
    .filter((d) => d.status === 'completed')
    .filter((d) => !consumedIds.has(d.id))
    .filter((d) => slotBatteryId !== null && d.batteryId === slotBatteryId)
    .map((d) => d.id);
}

describe('my-battery-status: loaded battery resolution', () => {
  test('the query guards on battery physically present in the slot', () => {
    const src = readDepositController();
    // The battery-present guard must exist in the my-battery-status query.
    assert.match(
      src,
      /s\.current_battery_id IS NOT NULL[\s\S]*?d\.battery_id = s\.current_battery_id/
    );
  });

  test('a stale deposit is NOT returned when its battery is no longer in the slot', () => {
    // Regression for the double-allocation bug: George had 44 historical
    // 'completed' deposits for a slot whose battery is now gone/another user's.
    // They must NOT surface as loaded batteries.
    const loaded = selectLoadedBatteries(
      [
        { id: 10, status: 'completed', batteryId: null }, // old deposit, no battery link
        { id: 11, status: 'completed', batteryId: 100 },  // old deposit, different battery
        { id: 12, status: 'completed', batteryId: 50 },   // the CURRENT deposit, battery 50 in slot
      ],
      [],
      50 // slot currently holds battery 50
    );

    assert.deepStrictEqual(loaded, [12], 'Only the deposit whose battery is in the slot qualifies');
  });

  test('returns nothing when the slot has no physical battery', () => {
    // Even completed deposits must not count if no battery is physically present.
    const loaded = selectLoadedBatteries(
      [{ id: 10, status: 'completed', batteryId: 100 }],
      [],
      null // slot empty
    );
    assert.deepStrictEqual(loaded, []);
  });

  test('a consumed (withdrawn) deposit is never the loaded battery', () => {
    const loaded = selectLoadedBatteries(
      [
        { id: 20, status: 'completed', batteryId: 200 }, // withdrawn -> consumed, but battery in slot
        { id: 21, status: 'completed', batteryId: 200 }, // active
      ],
      [{ consumedDepositId: 20, status: 'completed' }],
      200
    );
    assert.deepStrictEqual(loaded, [21], 'Consumed deposit is excluded even if battery is present');
  });

  test('a failed/cancelled withdrawal does not consume the deposit', () => {
    const loaded = selectLoadedBatteries(
      [{ id: 30, status: 'completed', batteryId: 300 }],
      [{ consumedDepositId: 30, status: 'failed' }],
      300
    );
    assert.deepStrictEqual(loaded, [30], 'Failed withdrawal keeps the deposit as loaded');
  });

  test('only the deposit whose battery matches the slot battery qualifies', () => {
    // Two deposits on the same slot, but only one references the slot's current battery.
    const loaded = selectLoadedBatteries(
      [
        { id: 40, status: 'completed', batteryId: 401 }, // different battery
        { id: 41, status: 'completed', batteryId: 402 }, // matches slot
      ],
      [],
      402
    );
    assert.deepStrictEqual(loaded, [41], 'Only the deposit matching the slot battery qualifies');
  });
});
