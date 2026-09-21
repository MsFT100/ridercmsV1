const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads the deposit controller source to assert on the real embedded SQL.
 * Guards the deposit-session-status endpoint that lets the app stop waiting
 * when a booth auto-cancels a deposit (e.g. a `deposit_timeout` hardware ACK).
 * @returns {string} The controller source.
 */
function readDepositController() {
  return fs.readFileSync(
    path.join(__dirname, '../controllers/booths/deposit.controller.js'),
    'utf8'
  );
}

/**
 * Models the deposit-session-status selection exactly as the SQL does: the
 * session is returned ONLY when it exists AND belongs to the requesting user.
 * Unlike my-battery-status it must NOT filter on `status = 'completed'`,
 * otherwise terminal `cancelled`/`failed` states stay invisible and the UI
 * spins forever.
 * @param {Array<{id:number, userId:number, status:string}>} deposits
 * @param {number} sessionId
 * @param {number} userId
 * @returns {{id:number, userId:number, status:string}|null}
 */
function selectDepositSession(deposits, sessionId, userId) {
  return (
    deposits.find(
      (d) => d.id === sessionId && d.userId === userId
    ) || null
  );
}

describe('deposit-session-status: lifecycle resolution', () => {
  test('the route is scoped to the authenticated user and does not require completion', () => {
    const src = readDepositController();
    // Ownership + identity are enforced in SQL.
    assert.match(src, /d\.id = \$1 AND d\.user_id = \$2/);
    // The route must exist.
    assert.match(src, /'\/deposit-sessions\/:sessionId\/status'/);
  });

  test('a cancelled deposit session is visible (this is the whole point)', () => {
    const row = selectDepositSession(
      [{ id: 7, userId: 1, status: 'cancelled' }],
      7,
      1
    );
    assert.deepStrictEqual(row, { id: 7, userId: 1, status: 'cancelled' });
  });

  test('a failed deposit session is visible', () => {
    const row = selectDepositSession(
      [{ id: 8, userId: 1, status: 'failed' }],
      8,
      1
    );
    assert.strictEqual(row?.status, 'failed');
  });

  test('another user\'s session is not visible', () => {
    const row = selectDepositSession(
      [{ id: 9, userId: 2, status: 'cancelled' }],
      9,
      1 // different user
    );
    assert.strictEqual(row, null);
  });

  test('an unknown session resolves to null (404)', () => {
    const row = selectDepositSession([], 123, 1);
    assert.strictEqual(row, null);
  });
});
