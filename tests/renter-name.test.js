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
 * deposit that has NOT been consumed by a non-failed/non-cancelled withdrawal.
 * @param {Array<{id:number, userId:number, completedAt:number}>} deposits - All deposits on the slot.
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals - All withdrawals on the slot.
 * @returns {number|null} The userId of the current renter, or null if none.
 */
function selectRenter(deposits, withdrawals) {
  const consumedIds = new Set(
    withdrawals
      .filter((w) => w.status !== 'failed' && w.status !== 'cancelled')
      .map((w) => w.consumedDepositId)
  );

  const eligible = deposits
    .filter((d) => !consumedIds.has(d.id))
    .sort((a, b) => b.completedAt - a.completedAt);

  return eligible.length > 0 ? eligible[0].userId : null;
}

// ─── SQL surface tests ────────────────────────────────────────────────────────

describe('Renter ("Rented By") name resolution', () => {
  test('all three booth queries drop the battery_id match and use the withdrawal-consumption guard', () => {
    const src = readControllerSource();

    // Each admin booth query must contain the NOT EXISTS withdrawal guard.
    const guard = src.match(/NOT EXISTS \([\s\S]*?consumed_deposit_id = d\.id[\s\S]*?session_type = 'withdrawal'/g);
    assert.ok(
      guard && guard.length >= 3,
      `Expected >=3 withdrawal-consumption guards in booth queries, found ${guard?.length ?? 0}`
    );

    // The race-prone battery_id match must NOT be present in the renter LATERAL joins.
    // (The string appears elsewhere legitimately, e.g. joins on batteries table,
    // so we assert on the specific condition used inside last_deposit.)
    const batteryIdCondition = src.match(/d\.battery_id = s\.current_battery_id/g);
    assert.equal(batteryIdCondition, null, 'battery_id renter condition should be gone');
  });

  test('the renter query excludes deposits consumed by a completed withdrawal', () => {
    // Regression: removing the battery_id match must not resurrect past renters.
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
});
