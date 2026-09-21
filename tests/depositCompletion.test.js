const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

jest.mock('firebase-admin/database', () => ({
  getDatabase: () => ({
    ref: jest.fn(() => ({
      update: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue({ exists: () => false, val: () => null }),
    })),
  }),
}));

jest.mock('../db', () => Promise.resolve({ connect: jest.fn() }));

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { handleDepositCompletion } = require('../utils/firebaseSync');

/**
 * Builds a fake pg client that records every query and returns controlled
 * rowCounts for the deposit-completion and slot-occupancy updates.
 * @param {{depositMatched?: boolean, slotOpening?: boolean}} [options] - Control flags.
 * @returns {any} A fake pg client.
 */
function createClient({ depositMatched = true, slotOpening = true } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (text, params) => {
      calls.push({ text, params });

      if (text.includes('UPDATE deposits') && text.includes("status = 'completed'")) {
        return depositMatched
          ? { rowCount: 1, rows: [{ id: 77 }] }
          : { rowCount: 0, rows: [] };
      }

      if (text.includes('SET battery_id = COALESCE')) {
        return { rowCount: 1, rows: [] };
      }

      if (text.includes('UPDATE booth_slots') && text.includes("status = 'occupied'")) {
        return slotOpening ? { rowCount: 1, rows: [] } : { rowCount: 0, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    }),
  };
}

const SECURE_TELEMETRY = {
  soc: 55,
  batteryInserted: true,
  doorClosed: true,
  doorLocked: true,
  plugConnected: true,
};

describe('handleDepositCompletion: slot occupancy transition', () => {
  test('marks the slot occupied when a rider deposit is completed', async () => {
    const client = createClient();
    const completed = await handleDepositCompletion(client, 'booth001', 'A01', 4, SECURE_TELEMETRY);

    assert.equal(completed, true, 'deposit should be reported completed');

    const occupiedUpdate = client.calls.find(
      (c) => c.text.includes('UPDATE booth_slots') && c.text.includes("status = 'occupied'")
    );
    assert.ok(occupiedUpdate, 'the slot must be transitioned to occupied');
    assert.deepEqual(occupiedUpdate.params, [4]);
    assert.match(
      occupiedUpdate.text,
      /AND status = 'opening'/,
      'occupancy transition must be guarded to the opening state'
    );
  });

  test('does not touch the slot when no opening deposit matches', async () => {
    const client = createClient({ depositMatched: false });
    const completed = await handleDepositCompletion(client, 'booth001', 'A01', 4, SECURE_TELEMETRY);

    assert.equal(completed, false, 'nothing to complete');
    const occupiedUpdate = client.calls.find(
      (c) => c.text.includes('UPDATE booth_slots') && c.text.includes("status = 'occupied'")
    );
    assert.equal(occupiedUpdate, undefined, 'no slot update when no deposit matched');
  });
});

describe('firebaseSync: telemetry deposit fallback + failure guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../utils/firebaseSync.js'), 'utf8');

  test('finalizes a rider deposit from secure telemetry when the ACK is missed', () => {
    assert.match(source, /Telemetry confirmed own-battery deposit/);
    assert.match(source, /handleDepositCompletion\(pgClient, boothUid, slotIdentifier, slotId, telemetry\)/);
    // The fallback must require the battery be fully secured, not merely present.
    assert.match(source, /telemetry\.plugConnected === true/);
  });

  test('a late deposit-failure ACK cannot clobber an already-occupied slot', () => {
    assert.match(
      source,
      /UPDATE booth_slots SET status = 'available' WHERE id = \$1 AND status = 'opening'/,
      'failure reset must be guarded to opening so it cannot downgrade an occupied slot'
    );
  });
});
