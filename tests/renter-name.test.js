const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the admin booths controller source so we can assert on the actual SQL
 * embedded in the route handlers. This guards against the query silently
 * regressing to a battery_id match or losing the owner/withdrawal guards.
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
 * deposit that is NOT consumed by a non-failed/non-cancelled withdrawal/rental,
 * and only when the slot is PHYSICALLY occupied (`status = 'occupied'`).
 *
 * The "owner" rule replaces the old battery_uid/id identity match: a rider's
 * own deposited battery has no battery identity (battery IDs are reserved for
 * the company's rental batteries), so a deposit owns the slot when no NEWER
 * deposit by a DIFFERENT user is itself still active and un-consumed.
 * @param {Array<{id:number, userId:number, completedAt:number, status?:string}>} deposits - All deposits on the slot.
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals - All withdrawals/rentals on the slot.
 * @param {boolean} [slotOccupied] - Whether the slot is physically occupied. Defaults to true.
 * @returns {number|null} The userId of the current renter, or null if none.
 */
function selectRenter(deposits, withdrawals, slotOccupied = true) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  const eligible = deposits
    .filter((d) => d.status === 'completed' || d.status === undefined)
    .filter((d) => !consumedIds.has(d.id))
    // Empty (non-occupied) slots never show a name.
    .filter(() => slotOccupied)
    // No NEWER deposit by another user may still own the slot first.
    .filter((d) => !deposits.some((newer) =>
      newer.id > d.id &&
      newer.userId !== d.userId &&
      (newer.status === 'completed' || newer.status === 'opening' || newer.status === 'in_progress') &&
      !consumedIds.has(newer.id)
    ))
    .sort((a, b) => b.completedAt - a.completedAt);

  return eligible.length > 0 ? eligible[0].userId : null;
}

// ─── SQL surface tests ────────────────────────────────────────────────────────

describe('Renter ("Rented By") name resolution', () => {
  test('all booth queries keep the owner guards and require the slot physically occupied', () => {
    const src = readControllerSource();

    // Each admin booth query must contain the withdrawal/rental consumption guard.
    const guard = src.match(/NOT EXISTS \([\s\S]*?consumed_deposit_id = d\.id[\s\S]*?session_type IN \('withdrawal', 'rental'\)/g);
    assert.ok(
      guard && guard.length >= 5,
      `Expected >=5 owner-consumption guards in booth queries, found ${guard?.length ?? 0}`
    );

    // A name must only show when the slot is PHYSICALLY occupied: this guard must be
    // present in every renter LATERAL (3), the ownerQuery (1), the manual_unlock
    // lateral (1), the withdrawal-info query (1) and the manual-withdrawal creation
    // query (1) => exactly 7 with this assertion.
    const occupiedRequired = src.match(/AND s\.status = 'occupied'/g);
    assert.ok(
      occupiedRequired && occupiedRequired.length >= 7,
      `Expected >=7 "slot must be occupied" guards, found ${occupiedRequired?.length ?? 0}`
    );

    // No owner may be chosen if a NEWER deposit by another user owns the slot first
    // (the owner rule that replaced battery-id matching).
    const newerOwnerGuard = src.match(/newer\.user_id <> d\.user_id/g);
    assert.ok(
      newerOwnerGuard && newerOwnerGuard.length >= 6,
      `Expected >=6 newer-owner guards, found ${newerOwnerGuard?.length ?? 0}`
    );
  });

  test('no booth query matches the deposit to a battery identity anymore', () => {
    // Battery IDs are reserved for company rental batteries; a rider's own battery
    // has no identity. The renter/withdrawal queries must never require a
    // battery_id match to pick an owner.
    const src = readControllerSource();

    assert.ok(
      !src.includes('d.battery_id = s.current_battery_id'),
      'booth queries must not match deposits to a battery identity'
    );
    // The only place battery-linkage may remain is the is_rental_pool flag,
    // which must keep a battery identity to detect company rental stock. No
    // renter/withdrawal/owner query may gate presence on a battery link.
    const batteryLinkLines = src
      .split('\n')
      .map((l, i) => ({ n: i + 1, l }))
      .filter(({ l }) => l.includes('s.current_battery_id IS NOT NULL'));
    assert.ok(
      batteryLinkLines.length > 0 && batteryLinkLines.every(({ l }) => l.includes('is_rental_pool')),
      `battery-link occupancy signal must only remain for is_rental_pool, found at lines: ${batteryLinkLines.map((x) => x.n).join(', ')}`
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
    // Regression for slot008: battery removed (status = 'available') but the
    // deposit was never consumed -> the stale rider name must NOT resurface.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100 }],
      [],
      false // slot not occupied
    );

    assert.equal(renter, null, 'Empty slot must show no renter');
  });

  test('an occupied slot shows the renter (no battery identity needed)', () => {
    // A rider's own deposited battery has NO battery_id: ownership is proven by
    // the deposit being the slot's latest un-consumed deposit.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100 }],
      [],
      true
    );

    assert.equal(renter, 10, 'Renter whose deposit owns the occupied slot must show');
  });

  test('a deposit is hidden once a newer deposit by another user owns the slot', () => {
    // Old renter's deposit is still active/un-consumed, but User B deposited
    // later into the same (now occupied) slot: the old rider must not claim the
    // name via a stale credit.
    const renter = selectRenter(
      [
        { id: 1, userId: 10, completedAt: 100 }, // old renter, battery never removed
        { id: 2, userId: 20, completedAt: 200 }, // newer deposit by another user
      ],
      []
    );

    assert.equal(renter, 20, 'Newest deposit owner wins; old active deposit is not the renter');
  });

  test('a consumed deposit with an otherwise occupied slot still yields no name', () => {
    // The withdrawal guard and the occupied guard compose: even if the slot is
    // occupied, a consumed deposit must not win.
    const renter = selectRenter(
      [{ id: 1, userId: 10, completedAt: 100 }],
      [{ consumedDepositId: 1, status: 'completed' }]
    );

    assert.equal(renter, null, 'Consumed deposit must not show even if the slot is occupied');
  });

  test('withdrawal-info and manual-withdrawal queries require the slot occupied and the owner rule', () => {
    // The two money-operational endpoints (withdrawal-info and manual-withdrawal
    // creation) must not resolve against a deposit on an EMPTY slot nor against a
    // stale deposit overtaken by a newer user. This is what stops stale/orphaned
    // deposits from being withdrawn into.
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
        q.includes('AND s.status = \'occupied\''),
        `${label} query must require the slot physically occupied`
      );
      assert.ok(
        q.includes('newer.user_id <> d.user_id'),
        `${label} query must use the owner rule (no newer deposit by another user)`
      );
    }
  });
});