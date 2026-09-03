const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { reconcileSlotDeposit } = require('../utils/depositReconcile');

/**
 * Builds a fake pg client whose responses are keyed off the SQL we expect.
 * @param {object} opts - Configuration controlling what each query returns.
 * @param {object|null} opts.slot - Row returned for the booth_slots lookup (null -> empty).
 * @param {object|null} opts.deposit - Row returned for the failed-deposit lookup (null -> empty).
 * @param {number} opts.updateRowCount - rowCount returned for the UPDATE ... RETURNING.
 * @returns {{query: (text: string) => Promise<{rowCount: number, rows: Array<object>}>}} A fake pg client.
 */
function makeClient({ slot, deposit, updateRowCount }) {
  return {
    query: async (text) => {
      if (text.includes('FROM booth_slots')) {
        return { rowCount: slot ? 1 : 0, rows: slot ? [slot] : [] };
      }
      if (text.includes("status = 'failed'") && text.includes('SELECT')) {
        return { rowCount: deposit ? 1 : 0, rows: deposit ? [deposit] : [] };
      }
      if (text.includes('SET status = \'completed\'')) {
        return { rowCount: updateRowCount, rows: updateRowCount ? [{ id: deposit.id }] : [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

describe('reconcileSlotDeposit', () => {
  it('re-completes a failed deposit when the slot is occupied', async () => {
    const client = makeClient({
      slot: { status: 'occupied' },
      deposit: { id: 77, status: 'failed' },
      updateRowCount: 1,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.deepStrictEqual(result, {
      reconciled: true,
      depositId: 77,
      previousStatus: 'failed',
      newStatus: 'completed',
      reason: 'battery_present',
    });
  });

  it('re-completes a failed deposit when the slot is occupied (battery present, e.g. charging)', async () => {
    const client = makeClient({
      slot: { status: 'occupied' },
      deposit: { id: 78, status: 'failed' },
      updateRowCount: 1,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.equal(result.reconciled, true);
    assert.equal(result.newStatus, 'completed');
  });

  it('does nothing when the slot is empty/available', async () => {
    const client = makeClient({
      slot: { status: 'available' },
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
    });
  });

  it('does nothing when there is no failed deposit on the slot', async () => {
    const client = makeClient({
      slot: { status: 'occupied' },
      deposit: null,
      updateRowCount: 0,
    });

    const result = await reconcileSlotDeposit(client, 5, 'slot-001');

    assert.equal(result.reason, 'no_failed_deposit');
    assert.equal(result.reconciled, false);
  });
});
