const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the admin booths controller source so we can assert on the actual SQL
 * embedded in the route handlers. This guards against the query silently
 * regressing to the battery_id match or losing the withdrawal-consumption guard.
 * @returns {string} The full controller source.
 */
function readControllerSource() {
  return fs.readFileSync(
    path.join(__dirname, '../controllers/admin/booths.controller.js'),
    'utf8'
  );
}

/**
 * Models the renter-selection semantics of the LATERAL join used by every
 * admin booth query. Mirrors the SQL exactly: pick the most recent completed
 * deposit that has NOT been consumed by a non-failed/non-cancelled withdrawal,
 * and only when the battery is physically in the slot. A deposit with a known
 * battery_id must match the slot's current battery; legacy NULL-battery
 * deposits (pre battery-tracking) are trusted on occupied slots.
 * @param {Array<{id:number, userId:number, completedAt:number, batteryId?:number|null}>} deposits - All deposits on the slot.
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals - All withdrawals on the slot.
 * @param {number|null} [slotBatteryId] - The slot's current_battery_id. Defaults to a battery so behaviour is unchanged for callers that don't model battery presence.
 * @returns {number|null} The userId of the current renter, or null if none.
 */
function selectRenter(deposits, withdrawals, slotBatteryId = 1) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  const eligible = deposits
    .filter((d) => !consumedIds.has(d.id))
    // Empty slots never show a name.
    .filter(() => slotBatteryId !== null)
    // A known deposit battery must match the one physically in the slot;
    // legacy deposits without battery tracking are trusted on occupied slots.
    .filter((d) => d.batteryId == null || d.batteryId === slotBatteryId)
    .sort((a, b) => b.completedAt - a.completedAt);

  return eligible.length > 0 ? eligible[0].userId : null;
}

// ─── SQL surface tests ────────────────────────────────────────────────────────

describe('Renter ("Rented By") name resolution', () => {
  test('all booth queries keep the withdrawal guard AND require the battery physically in the slot', () => {
    const src = readControllerSource();

    // Each admin booth query must contain the NOT EXISTS withdrawal guard.
    const guard = src.match(/NOT EXISTS \([\s\S]*?consumed_deposit_id = d\.id[\s\S]*?session_type = 'withdrawal'/g);
    assert.ok(
      guard && guard.length >= 3,
      `Expected >=3 withdrawal-consumption guards in booth queries, found ${guard?.length ?? 0}`
    );

    // A name must only show when the slot actually holds a battery: this guard must be
    // present in every renter LATERAL (3), the ownerQuery (1), the manual_unlock
    // lateral (1), the withdrawal-info query (1) and the manual-withdrawal creation
    // query (1) => exactly 7 with this assertion.
    const batteryRequired = src.match(/AND s\.current_battery_id IS NOT NULL/g);
    assert.ok(
      batteryRequired && batteryRequired.length >= 7,
      `Expected >=7 "slot must hold a battery" guards, found ${batteryRequired?.length ?? 0}`
    );

    // Legacy NULL-battery deposits are trusted on occupied slots, but a deposit with a
    // known battery must match the physical battery. Every renter/withdrawal join must
    // carry this: 3 renter laterals + ownerQuery + withdrawal-info + manual-withdrawal = 6.
    const nullTrusted = src.match(/d\.battery_id = s\.current_battery_id OR d\.battery_id IS NULL/g);
    assert.equal(
      nullTrusted?.length ?? 0,
      6,
      `Expected 6 physical-battery OR-guards, found ${nullTrusted?.length ?? 0}`
    );
  });

  test('the renter query excludes deposits consumed by a completed withdrawal', () => {
    // A deposit is no longer the renter once a withdrawal consumed it.
    const renter = selectRenter(
      [
        { id: 1, userId: 10, completedAt: 100 }, // previous renter
        { id: 2, userId: 20, completedAt: 200 }, // current renter
      ],
      [{ consumedDepositId: 1, status: 'completed' }]
    );

    assert.equal(renter, 20, 'Consumed (withdrawn) deposit must not be the renter');
  });

  test('a failed/cancelled withdrawal keeps the deposit as the renter', () => {
    // Matches reconcileSlotDeposit: failed/cancelled withdrawals do NOT consume.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100 }],
      [{ consumedDepositId: 1, status: 'failed' }]
    );

    assert.equal(renter, 10, 'Failed withdrawal should not release the renter');
  });

  test('a consumed deposit is never shown even if it is the most recent one', () => {
    // The dangerous edge case: an old deposit that was withdrawn is the newest by
    // completed_at, but must still be excluded in favour of a live one.
    const renter = selectRenter(
      [
        { id: 1, userId: 10, completedAt: 300 }, // most recent, but withdrawn
        { id: 2, userId: 20, completedAt: 100 }, // older, but still active
      ],
      [{ consumedDepositId: 1, status: 'completed' }]
    );

    assert.equal(renter, 20, 'Most-recent-but-consumed deposit must not win');
  });

  test('returns null when every deposit has been withdrawn', () => {
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100 }],
      [{ consumedDepositId: 1, status: 'completed' }]
    );

    assert.equal(renter, null, 'Slot with no active deposit should show no renter');
  });

  test('an empty slot never shows a name even if an active deposit exists', () => {
    // Regression for slot008: battery removed (current_battery_id = NULL) but the
    // deposit was never consumed -> the stale rider name must NOT resurface.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100, batteryId: 5 }],
      [],
      null // no battery physically in the slot
    );

    assert.equal(renter, null, 'Empty slot must show no renter');
  });

  test('an occupied slot with a matching battery shows the renter', () => {
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100, batteryId: 5 }],
      [],
      5
    );

    assert.equal(renter, 10, 'Renter whose battery is physically present must show');
  });

  test('a legacy NULL-battery deposit is still trusted on an occupied slot', () => {
    // 81 completed deposits in prod have battery_id = NULL on slots that DO hold a
    // battery; hiding those would wipe legitimate renter names.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100, batteryId: null }],
      [],
      5
    );

    assert.equal(renter, 10, 'NULL-battery deposit on occupied slot must still show');
  });

  test('a deposit whose battery is NOT in the slot is hidden (known mismatch)', () => {
    // Battery was swapped/removed and a different renter now occupies the slot:
    // a deposit linked to a different battery must not claim the name.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100, batteryId: 5 }],
      [],
      9 // slot now holds a different battery
    );

    assert.equal(renter, null, 'Mismatched battery deposit must not show');
  });

  test('a consumed deposit with a matching battery still yields no name', () => {
    // The withdrawal guard and the physical-battery guard compose: even if the
    // battery is present, a consumed deposit must not win.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100, batteryId: 5 }],
      [{ consumedDepositId: 1, status: 'completed' }],
      5
    );

    assert.equal(renter, null, 'Consumed deposit must not show even if battery matches');
  });

  test('withdrawal-info and manual-withdrawal queries require the battery physically present', () => {
    // The two money-operational endpoints (withdrawal-info and manual-withdrawal
    // creation) must not resolve against a deposit whose battery is NOT in the slot.
    // This is what stops stale/orphaned deposits from being withdrawn into.
    const src = readControllerSource();

    const withdrawalInfoQuery = src.match(/SELECT d\.user_id, d\.initial_charge_level[\s\S]*?LIMIT 1/);
    assert.ok(withdrawalInfoQuery, 'withdrawal-info deposit query not found');

    const manualWithdrawalQuery = src.match(/SELECT d\.id, d\.user_id, d\.initial_charge_level[\s\S]*?LIMIT 1/);
    assert.ok(manualWithdrawalQuery, 'manual-withdrawal deposit query not found');

    for (const [label, q] of [['withdrawal-info', withdrawalInfoQuery[0]], ['manual-withdrawal', manualWithdrawalQuery[0]]]) {
      assert.ok(
        q.includes('JOIN booth_slots s ON d.slot_id = s.id'),
        `${label} query must join booth_slots`
      );
      assert.ok(
        q.includes('AND s.current_battery_id IS NOT NULL'),
        `${label} query must require a battery in the slot`
      );
      assert.ok(
        q.includes('d.battery_id = s.current_battery_id OR d.battery_id IS NULL'),
        `${label} query must trust legacy NULL-battery deposits on occupied slots`
      );
    }
  });
});
