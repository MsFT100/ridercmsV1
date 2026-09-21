const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reconcileSlotDeposit, ensureSlotBatteryLinked } = require('../utils/depositReconcile');

/**
 * Models the resurrection-candidate selection semantics of reconcileSlotDeposit
 * exactly as the SQL does. A failed deposit may only be restored to 'completed'
 * when it is still the slot's owner: its battery matches the battery physically
 * in the slot (or is a legacy NULL link), it is NOT consumed by a withdrawal,
 * and NO newer completed deposit already owns that battery.
 * @param {Array<{id:number, status:string, batteryId:number|null}>} deposits
 * @param {Array<{consumedDepositId:number, status:string}>} withdrawals
 * @param {number|null} slotBatteryId
 * @returns {number|null} The deposit id that would be resurrected, or null.
 */
function selectResurrectCandidate(deposits, withdrawals, slotBatteryId) {
  const consumed = (d) =>
    withdrawals.some((w) =>
      w.consumedDepositId === d.id &&
      w.status !== 'failed' &&
      w.status !== 'cancelled'
    );

  const candidates = deposits
    .filter((d) => d.status === 'failed')
    .filter((d) => !consumed(d))
    .filter((d) => d.batteryId == null || d.batteryId === slotBatteryId)
    .filter((d) => !deposits.some((newer) =>
      newer.id > d.id &&
      newer.status === 'completed' &&
      !consumed(newer)
    ));

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.id - a.id)[0].id;
}

/**
 * Builds a fake pg client whose responses are keyed off the SQL we expect.
 * @param {object} opts - Configuration controlling what each query returns.
 * @param {object|null} opts.slot - Row returned for the booth_slots lookup (null -> empty).
 * @param {object|null} opts.deposit - Row returned for the failed-deposit lookup (null -> empty).
 * @param {number} opts.updateRowCount - rowCount returned for the deposit-complete UPDATE.
 * @param {number|null} opts.linkedBatteryId - id returned by the batteries INSERT (null -> skip relink mock).
 * @param {object|null} opts.ownerDeposit - Row returned for the current-owner deposit lookup ({id, battery_id} | null).
 * @returns {{query: (text: string, params?: Array) => Promise<{rowCount: number, rows: Array<object>}>}} A fake pg client.
 */
function makeClient({ slot, deposit, updateRowCount, linkedBatteryId = 44, ownerDeposit = { id: 77, battery_id: null } }) {
  return {
    query: async (text) => {
      if (text.includes('SELECT current_battery_id\n') && text.includes('FROM booth_slots') && text.includes('WHERE id = $1')) {
        return { rowCount: slot ? 1 : 0, rows: slot ? [slot] : [] };
      }
      if (text.includes('SELECT current_battery_id, charge_level_percent')) {
        return { rowCount: slot ? 1 : 0, rows: slot ? [slot] : [] };
      }
      if (text.includes('SELECT status, charge_level_percent')) {
        return { rowCount: slot ? 1 : 0, rows: slot ? [slot] : [] };
      }
      if (text.includes("status = 'failed'") && text.includes('SELECT')) {
        return { rowCount: deposit ? 1 : 0, rows: deposit ? [deposit] : [] };
      }
      // Current-owner deposit lookup inside ensureSlotBatteryLinked. Distinct from the
      // failed-deposit lookup: it selects d.id, d.battery_id and filters on active states.
      if (text.includes('d.id, d.battery_id') && text.includes("d.status IN ('opening', 'in_progress', 'completed')")) {
        return { rowCount: ownerDeposit ? 1 : 0, rows: ownerDeposit ? [ownerDeposit] : [] };
      }
      if (text.includes('SET status = \'completed\'')) {
        return { rowCount: updateRowCount, rows: updateRowCount ? [{ id: deposit.id }] : [] };
      }
      if (text.includes('INSERT INTO batteries')) {
        return { rowCount: 1, rows: [{ id: linkedBatteryId }] };
      }
      if (text.includes('UPDATE booth_slots SET current_battery_id')) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('SET battery_id = COALESCE') || (text.includes('UPDATE deposits') && text.includes('SET battery_id = $1'))) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

describe('reconcileSlotDeposit', () => {
  it('re-completes a failed deposit on an occupied slot and does NOT fabricate a battery', async () => {
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: null, charge_level_percent: 71 },
      deposit: { id: 77, status: 'failed' },
      ownerDeposit: { id: 77, battery_id: null },
      updateRowCount: 1,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.deepStrictEqual(result, {
      reconciled: true,
      depositId: 77,
      previousStatus: 'failed',
      newStatus: 'completed',
      reason: 'battery_present',
      relinked: false,
      batteryId: null,
    });
  });

  it('re-completes a failed deposit when the slot already has a battery linked', async () => {
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: 9, charge_level_percent: 50 },
      deposit: { id: 78, status: 'failed' },
      updateRowCount: 1,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.equal(result.reconciled, true);
    assert.equal(result.newStatus, 'completed');
    assert.equal(result.relinked, false);
    assert.equal(result.reason, 'battery_present');
  });

  it('does nothing when the slot is empty/available', async () => {
    const client = makeClient({
      slot: { status: 'available', current_battery_id: null, charge_level_percent: null },
      deposit: { id: 79, status: 'failed' },
      updateRowCount: 0,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.deepStrictEqual(result, {
      reconciled: false,
      depositId: null,
      previousStatus: null,
      newStatus: null,
      reason: 'slot_empty',
      relinked: false,
      batteryId: null,
    });
  });

  it('reports applied (with no battery fabrication) even when no failed deposit exists', async () => {
    // Covers self-healing of the "completed deposit + missing battery link" case:
    // the deposit reconcile finds nothing to restore, and a rider's own battery
    // (battery_id = NULL) must NOT get a synthetic battery fabricated.
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: null, charge_level_percent: 100 },
      deposit: null,
      ownerDeposit: { id: 55, battery_id: null },
      updateRowCount: 0,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.equal(result.reason, 'no_failed_deposit');
    assert.equal(result.reconciled, false);
    assert.equal(result.relinked, false);
    assert.equal(result.batteryId, null);
  });

  it('does not relink when the battery is already linked', async () => {
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: 12, charge_level_percent: 88 },
      deposit: null,
      updateRowCount: 0,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.equal(result.relinked, false);
    assert.equal(result.batteryId, 12);
  });
});

describe('ensureSlotBatteryLinked', () => {
  it('is a no-op when a battery is already linked', async () => {
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: 3, charge_level_percent: 60 },
    });

    const result = await ensureSlotBatteryLinked(client, 5, 'slot-001', 61);

    assert.deepStrictEqual(result, { relinked: false, batteryId: 3, batteryUid: null, reason: 'already_linked' });
  });

  it('does NOT fabricate a battery for a rider-owned deposit (battery_id = NULL)', async () => {
    // A rider's own deposited battery has no battery identity — battery IDs are
    // reserved for company rental batteries. Slot occupancy is tracked by
    // `status = 'occupied'`, so we never create a synthetic battery here.
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: null, charge_level_percent: 60 },
      ownerDeposit: { id: 60, battery_id: null },
    });

    const result = await ensureSlotBatteryLinked(client, 5, 'slot-001', 72);

    assert.deepStrictEqual(result, { relinked: false, batteryId: null, batteryUid: null, reason: 'no_battery_for_personal_deposit' });
  });

  it('does NOT fabricate a battery when the slot has no owner deposit (ghost-battery guard)', async () => {
    // A slot that is occupied but whose deposit was consumed (or never existed)
    // must NOT get a synthetic bat-<slotId>-<epoch> battery. This is the root-cause
    // fix for ghost "Rental Pool" batteries appearing in the fleet.
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: null, charge_level_percent: 60 },
      ownerDeposit: null,
    });

    const result = await ensureSlotBatteryLinked(client, 5, 'slot-001', 72);

    assert.deepStrictEqual(result, { relinked: false, batteryId: null, batteryUid: null, reason: 'no_owner_deposit' });
  });

  it('re-links the owner deposit existing battery instead of fabricating a new one', async () => {
    // When the current owner deposit already carries a battery_id, a telemetry
    // flicker that cleared current_battery_id should re-link THAT battery, not
    // fabricate a synthetic placeholder.
    const client = makeClient({
      slot: { status: 'occupied', current_battery_id: null, charge_level_percent: 60 },
      ownerDeposit: { id: 60, battery_id: 44 },
    });

    const result = await ensureSlotBatteryLinked(client, 5, 'slot-001', 72);

    assert.deepStrictEqual(result, { relinked: true, batteryId: 44, batteryUid: null, reason: 'relinked_existing' });
  });
});

describe('reconcileSlotDeposit: ghost-battery resurrection guard', () => {
  /**
   * Models the strict battery-uid/id match used by my-battery-status: a rider
   * sees a loaded battery only when their completed, un-consumed deposit's
   * battery_id equals the battery physically in the slot.
   * @param {Array} deposits - The slot's deposit rows after reconciliation.
   * @param {Array} withdrawals - The slot's withdrawal rows.
   * @param {number|null} slotBatteryId
   * @returns {number[]} Deposit ids that would surface to their owner.
   */
  function selectLoadedBatteries(deposits, withdrawals, slotBatteryId) {
    const consumed = (d) =>
      withdrawals.some((w) =>
        w.consumedDepositId === d.id &&
        w.status !== 'failed' &&
        w.status !== 'cancelled'
      );
    return deposits
      .filter((d) => d.status === 'completed')
      .filter((d) => !consumed(d))
      .filter((d) => slotBatteryId !== null && d.batteryId === slotBatteryId)
      .map((d) => d.id);
  }

  test('a failed deposit is NOT resurrected when a newer completed deposit already owns the slot battery', () => {
    // geokagew's old failed deposit (legacy NULL battery link) + User B's
    // completed deposit whose battery is physically in the slot (uid match).
    const deposits = [
      { id: 1, status: 'failed', batteryId: null },   // geokagew, stale
      { id: 2, status: 'completed', batteryId: 50 },  // new owner, battery 50 in slot
    ];
    const withdrawals = [];

    const resurrect = selectResurrectCandidate(deposits, withdrawals, 50);
    assert.equal(resurrect, null, 'Old failed deposit must NOT be resurrected');

    // If reconcile had resurrected id=1 it would surface as a ghost battery.
    const loaded = selectLoadedBatteries(
      [...deposits, { id: 1, status: 'completed', batteryId: null }],
      withdrawals,
      50
    );
    assert.deepStrictEqual(loaded, [2], 'Only the real owner battery surfaces');
  });

  test('a failed deposit whose battery does not match the slot battery is NOT resurrected', () => {
    const deposits = [
      { id: 5, status: 'failed', batteryId: 30 }, // battery 30 no longer in slot
    ];
    const resurrect = selectResurrectCandidate(deposits, [], 50);
    assert.equal(resurrect, null, 'Deposit tied to a different battery must not reappear');
  });

  test('a failed deposit IS still resurrected when it is the sole owner of the slot battery', () => {
    // Legit self-healing case: the battery never left the slot, only its status
    // flickered to failed. No newer completed deposit claims the battery.
    const deposits = [
      { id: 8, status: 'failed', batteryId: 50 }, // its battery is in the slot
    ];
    const resurrect = selectResurrectCandidate(deposits, [], 50);
    assert.equal(resurrect, 8, 'Sole owner is restored so the withdrawal path recovers');
  });

  test('a legacy NULL-battery failed deposit is resurrected only when no newer completed owner exists', () => {
    const deposits = [
      { id: 10, status: 'failed', batteryId: null },
    ];
    assert.equal(selectResurrectCandidate(deposits, [], 60), 10, 'Trusted on occupied slot when no conflict');

    const contested = [
      { id: 10, status: 'failed', batteryId: null },
      { id: 11, status: 'completed', batteryId: 60 },
    ];
    assert.equal(selectResurrectCandidate(contested, [], 60), null, 'Never resurrect when a newer owner exists');
  });

  test('a consumed (withdrawn) completed deposit does not block resurrection and never surfaces', () => {
    // A completed deposit consumed by an active withdrawal is excluded both from
    // the resurrection guard's "newer owner" check and from my-battery-status.
    const deposits = [
      { id: 20, status: 'failed', batteryId: 70 },   // candidate
      { id: 21, status: 'completed', batteryId: 70 }, // consumed -> ignored as owner
    ];
    const withdrawals = [{ consumedDepositId: 21, status: 'completed' }];

    assert.equal(
      selectResurrectCandidate(deposits, withdrawals, 70),
      20,
      'Consumed deposit is not a competing owner'
    );
    assert.deepStrictEqual(
      selectLoadedBatteries(deposits, withdrawals, 70),
      [],
      'Consumed battery never surfaces in my-battery-status'
    );
  });

  test('reconcile SQL embeds the newer-owner guard', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../utils/depositReconcile.js'),
      'utf8'
    );
    assert.match(
      src,
      /d\.battery_id IS NULL[\s\S]*?d\.battery_id = \(SELECT bs\.current_battery_id/
    );
    assert.match(
      src,
      /AND NOT EXISTS \([\s\S]*?newer\.slot_id = d\.slot_id[\s\S]*?newer\.status = 'completed'/
    );
  });

  test('ensureSlotBatteryLinked never fabricates a battery', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../utils/depositReconcile.js'),
      'utf8'
    );
    // The owner-deposit lookup still gates the re-link of an EXISTING real battery.
    assert.match(
      src,
      /SELECT d\.id, d\.battery_id[\s\S]*?d\.status IN \('opening', 'in_progress', 'completed'\)/,
      'owner deposit lookup must exist'
    );
    assert.match(
      src,
      /no_owner_deposit/,
      'must short-circuit with no_owner_deposit when the slot has no owner'
    );
    // No synthetic battery may ever be fabricated for a rider-owned deposit.
    assert.match(
      src,
      /no_battery_for_personal_deposit/,
      'must report no_battery_for_personal_deposit for identity-less rider deposits'
    );
    assert.ok(
      !src.includes('INSERT INTO batteries'),
      'ensureSlotBatteryLinked must never fabricate a batteries row'
    );
  });
});