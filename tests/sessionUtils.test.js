const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { finalizeWithdrawalSession } = require('../utils/sessionUtils');

describe('finalizeWithdrawalSession', () => {
  it('marks the withdrawal complete, redeems the deposit credit, and frees the slot', async () => {
    const queries = [];
    const client = {
      query: async (text, params) => {
        queries.push({ text, params });

        if (text.includes('SELECT id, user_id, consumed_deposit_id')) {
          return {
            rowCount: 1,
            rows: [{ id: 55, user_id: 'user-1', consumed_deposit_id: 10 }],
          };
        }

        if (text.includes("status = 'completed'")) {
          return { rowCount: 1, rows: [{ id: 55 }] };
        }

        if (text.includes("status = 'redeemed'")) {
          return { rowCount: 1, rows: [{ id: 10 }] };
        }

        if (text.includes('UPDATE booth_slots')) {
          return { rowCount: 1, rows: [{ id: 4 }] };
        }

        return { rowCount: 0, rows: [] };
      },
    };

    const result = await finalizeWithdrawalSession(client, 4, 'slot-001');

    assert.deepStrictEqual(result, { sessionId: 55, consumedDepositId: 10 });
    assert.match(queries[0].text, /SELECT id, user_id, consumed_deposit_id/);
    assert.match(queries[1].text, /status = 'completed'/);
    assert.match(queries[2].text, /status = 'redeemed'/);
    assert.match(queries[3].text, /UPDATE booth_slots/);
  });
});
