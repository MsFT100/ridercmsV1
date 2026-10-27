const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeKenyanPhone,
  pickPayerPhone,
  classifyExistingPayment,
  wasPreviousPaymentPaid,
  getStoredPhone,
} = require('../utils/paymentGuards');

const read = (relative) =>
  fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('normalizeKenyanPhone', () => {
  test.each([
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['712345678', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    [712345678, '254712345678'],
  ])('accepts %s', (input, expected) => {
    assert.equal(normalizeKenyanPhone(input), expected);
  });

  test.each([undefined, null, '', 'abc', '12345', '0212345678', '+1 415 555 0100 99999'])(
    'rejects %s',
    (input) => {
      assert.equal(normalizeKenyanPhone(input), null);
    }
  );
});

describe('pickPayerPhone', () => {
  test('prefers the token phone', () => {
    assert.equal(pickPayerPhone('+254711111111', '0722222222'), '254711111111');
  });

  test('falls back to the stored profile phone when the token has none', () => {
    assert.equal(pickPayerPhone(undefined, '0722222222'), '254722222222');
  });

  test('skips an invalid token phone', () => {
    assert.equal(pickPayerPhone('garbage', '0722222222'), '254722222222');
  });

  test('returns null when nothing is usable', () => {
    assert.equal(pickPayerPhone(undefined, null), null);
  });
});

describe('getStoredPhone', () => {
  test('reads users.phone for the given uid', async () => {
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ phone: '0712345678' }] };
      },
    };
    assert.equal(await getStoredPhone(client, 'uid-1'), '0712345678');
    assert.match(calls[0].sql, /FROM users WHERE user_id = \$1/);
    assert.deepEqual(calls[0].params, ['uid-1']);
  });

  test('returns null when the user has no row', async () => {
    const client = { query: async () => ({ rows: [] }) };
    assert.equal(await getStoredPhone(client, 'missing'), null);
  });
});

describe('classifyExistingPayment', () => {
  const NOW = Date.parse('2026-10-27T10:00:00Z');
  const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();

  test('no earlier push -> none', () => {
    assert.equal(
      classifyExistingPayment({ status: 'pending', mpesa_checkout_id: null }, 'pending', NOW, 90),
      'none'
    );
  });

  test('dev checkout ids are ignored', () => {
    assert.equal(
      classifyExistingPayment(
        { status: 'pending', mpesa_checkout_id: 'DEV_1_2', started_at: secondsAgo(1) },
        'pending',
        NOW,
        90
      ),
      'none'
    );
  });

  test('a failed attempt may be retried', () => {
    assert.equal(
      classifyExistingPayment(
        { status: 'failed', mpesa_checkout_id: 'ws_CO_1', started_at: secondsAgo(5) },
        'pending',
        NOW,
        90
      ),
      'none'
    );
  });

  test('a recent push is still in flight', () => {
    assert.equal(
      classifyExistingPayment(
        { status: 'pending', mpesa_checkout_id: 'ws_CO_1', started_at: secondsAgo(30) },
        'pending',
        NOW,
        90
      ),
      'in_flight'
    );
  });

  test('an old push is stale and must be verified with M-Pesa', () => {
    assert.equal(
      classifyExistingPayment(
        { status: 'pending', mpesa_checkout_id: 'ws_CO_1', started_at: secondsAgo(300) },
        'pending',
        NOW,
        90
      ),
      'stale'
    );
  });

  test('a missing timestamp is treated as stale, not in flight', () => {
    assert.equal(
      classifyExistingPayment({ status: 'pending', mpesa_checkout_id: 'ws_CO_1' }, 'pending', NOW, 90),
      'stale'
    );
  });

  test('rentals wait in in_progress, not pending', () => {
    const row = { status: 'in_progress', mpesa_checkout_id: 'ws_CO_2', started_at: secondsAgo(10) };
    assert.equal(classifyExistingPayment(row, 'in_progress', NOW, 90), 'in_flight');
    assert.equal(classifyExistingPayment(row, 'pending', NOW, 90), 'none');
  });
});

describe('wasPreviousPaymentPaid', () => {
  test('ResultCode "0" means it was paid', async () => {
    assert.equal(await wasPreviousPaymentPaid(async () => ({ data: { ResultCode: '0' } }), 'x'), true);
  });

  test('numeric 0 also counts', async () => {
    assert.equal(await wasPreviousPaymentPaid(async () => ({ data: { ResultCode: 0 } }), 'x'), true);
  });

  test('a non-zero result is not paid', async () => {
    assert.equal(await wasPreviousPaymentPaid(async () => ({ data: { ResultCode: '1032' } }), 'x'), false);
  });

  test('a failed lookup is logged and treated as not paid', async () => {
    const warnings = [];
    const paid = await wasPreviousPaymentPaid(
      async () => {
        throw new Error('timeout');
      },
      'ws_CO_1',
      { warn: (m) => warnings.push(m) }
    );
    assert.equal(paid, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ws_CO_1/);
  });
});

describe('pay endpoints are wired to the guards', () => {
  test.each([
    ['controllers/booths/withdrawal.controller.js'],
    ['controllers/booths/rental.controller.js'],
  ])('%s locks the row, guards double pushes and resolves the phone', (file) => {
    const src = read(file);
    assert.match(src, /classifyExistingPayment\(/);
    assert.match(src, /wasPreviousPaymentPaid\(/);
    assert.match(src, /pickPayerPhone\(tokenPhone, await getStoredPhone/);
    assert.match(src, /status\(409\)[\s\S]{0,200}Payment already in progress/);
    assert.match(src, /FOR UPDATE/);
    assert.doesNotMatch(src, /phone: userPhone/);
  });
});

describe('cancel-session targeting', () => {
  const src = read('controllers/booths/support.controller.js');

  test('accepts an optional sessionId and validates it', () => {
    assert.match(src, /req\.body\?\.sessionId/);
    assert.match(src, /Invalid sessionId/);
    assert.match(src, /\$2::int IS NULL OR d\.id = \$2::int/);
  });

  test('orders candidates deterministically and locks the chosen row', () => {
    assert.match(src, /ORDER BY\s+CASE/);
    assert.match(src, /d\.created_at DESC/);
    assert.match(src, /FOR UPDATE OF d/);
  });

  test('never implicitly cancels a rental that is in use', () => {
    assert.match(src, /NOT \(d\.session_type = 'rental' AND d\.status = 'in_progress'\)/);
    assert.match(src, /Cannot cancel an active rental/);
  });

  test('does not free the slot of an unpaid withdrawal', () => {
    assert.match(src, /if \(sessionType !== 'withdrawal'\) \{\s*await client\.query\("UPDATE booth_slots SET status = 'available'/);
  });
});
