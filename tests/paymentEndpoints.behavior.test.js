/**
 * Behavioural tests for POST /cancel-session, the withdrawal and rental pay
 * endpoints, and the M-Pesa callback's handling of failed payments.
 *
 * The real routers run against an in-memory Postgres (pg-mem) through supertest.
 * M-Pesa and Firebase are mocked. `completePaidWithdrawal` is mocked;
 * `completePaidRental` is the real implementation (wrapped in a spy) because the
 * retry tests depend on its status gate.
 *
 * Known pg-mem limits, which shape what is asserted here:
 *  - `FOR UPDATE [OF x]` is not supported, so a shim strips it. Row locking is
 *    therefore NOT exercised.
 *  - `timestamptz || text` and `timestamptz::text` are not supported, so the
 *    shim swaps `NOW()` for a literal inside the `notes = ... || NOW() || ...`
 *    expressions. The timestamp in those audit notes is not asserted anywhere.
 *  - ROLLBACK is not honoured. Only paths that return before writing anything
 *    (the 4xx/409 ones) assert "nothing changed".
 */
const request = require('supertest');
const express = require('express');

const mockFirebaseUpdates = [];

jest.mock('../db', () => {
  const { newDb } = require('pg-mem');
  const memdb = newDb();
  const { Pool } = memdb.adapters.createPg();
  const pool = new Pool();
  const adaptForPgMem = (sql) =>
    typeof sql === 'string'
      ? sql
          .replace(/\s+FOR UPDATE(\s+OF\s+\w+)?\s*;?\s*$/i, '')
          .replace(/\|\| NOW\(\) \|\|/g, "|| 'NOW' ||")
      : sql;
  return Promise.resolve({
    connect: async () => {
      const client = await pool.connect();
      const original = client.query.bind(client);
      client.query = (sql, params) => original(adaptForPgMem(sql), params);
      return client;
    },
  });
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  stream: { write: jest.fn() },
}));

jest.mock('firebase-admin/database', () => ({
  getDatabase: () => ({
    ref: (path) => ({
      update: async (value) => {
        mockFirebaseUpdates.push({ path, value });
      },
    }),
  }),
}));

jest.mock('../middleware/auth', () => ({
  verifyFirebaseToken: (req, res, next) => {
    req.user = JSON.parse(req.get('x-test-user'));
    req.schema = 'public';
    next();
  },
  isAdmin: (req, res, next) => next(),
}));

jest.mock('../utils/mpesa', () => ({
  initiateSTKPush: jest.fn(),
  querySTKStatus: jest.fn(),
  getMpesaIpWhitelist: () => [],
  parseMetadata: () => ({}),
  MPESA_CONFIG: {},
}));

jest.mock('../utils/firebase', () => ({
  admin: { messaging: () => ({ send: jest.fn().mockResolvedValue('ok') }) },
}));

jest.mock('../utils/sessionUtils', () => {
  const actual = jest.requireActual('../utils/sessionUtils');
  return {
    completePaidWithdrawal: jest.fn().mockResolvedValue(true),
    finalizeWithdrawalSession: jest.fn().mockResolvedValue(true),
    // Real implementation, wrapped so calls can still be asserted.
    completePaidRental: jest.fn(actual.completePaidRental),
  };
});

const poolPromise = require('../db');
const { initiateSTKPush, querySTKStatus } = require('../utils/mpesa');
const { completePaidWithdrawal, completePaidRental } = require('../utils/sessionUtils');
const supportRouter = require('../controllers/booths/support.controller');
const withdrawalRouter = require('../controllers/booths/withdrawal.controller');
const rentalRouter = require('../controllers/booths/rental.controller');
const mpesaRouter = require('../routes/mpesa');

const app = express();
app.use(express.json());
app.use('/api/booths', supportRouter);
app.use('/api/booths', withdrawalRouter);
app.use('/api/booths', rentalRouter);
app.use('/api/mpesa', mpesaRouter);

const RIDER = { uid: 'rider-1', phone_number: '+254712345678' };
const OTHER = { uid: 'rider-2', phone_number: '+254722222222' };

const as = (user) => ({ 'x-test-user': JSON.stringify(user) });

let db;
const sql = async (text, params) => {
  const client = await db.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

const rowOf = async (id) => (await sql('SELECT * FROM deposits WHERE id = $1', [id])).rows[0];
const slotStatus = async (id) => (await sql('SELECT status FROM booth_slots WHERE id = $1', [id])).rows[0].status;

/** Inserts a deposit row and returns its id. */
const addSession = async ({
  userId = RIDER.uid,
  slotId = 1,
  type,
  status,
  createdAt = new Date(),
  checkoutId = null,
  startedAt = new Date(),
  amount = 100,
  returnSlotId = null,
}) => {
  const res = await sql(
    `INSERT INTO deposits (user_id, booth_id, slot_id, session_type, status, amount, mpesa_checkout_id, started_at, created_at, return_slot_id)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [userId, slotId, type, status, amount, checkoutId, startedAt, createdAt, returnSlotId]
  );
  return res.rows[0].id;
};

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

beforeAll(async () => {
  db = await poolPromise;
  await sql(`CREATE TABLE users (user_id VARCHAR(255) PRIMARY KEY, phone VARCHAR(50), fcm_token VARCHAR(255))`);
  await sql(`CREATE TABLE mpesa_callbacks (
    id SERIAL PRIMARY KEY, callback_type VARCHAR(50), payload TEXT, processing_notes TEXT
  )`);
  await sql(`CREATE TABLE booths (id SERIAL PRIMARY KEY, booth_uid VARCHAR(50))`);
  await sql(`CREATE TABLE booth_slots (
    id SERIAL PRIMARY KEY, booth_id INT, slot_identifier VARCHAR(20), status VARCHAR(20),
    charge_level_percent DOUBLE PRECISION
  )`);
  await sql(`CREATE TABLE deposits (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    booth_id INT NOT NULL,
    slot_id INT NOT NULL,
    session_type VARCHAR(20) NOT NULL,
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    mpesa_checkout_id VARCHAR(255) UNIQUE,
    status VARCHAR(50) NOT NULL,
    initial_charge_level INT,
    consumed_deposit_id INT,
    return_slot_id INT,
    notes TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await sql(`CREATE TABLE app_settings (key VARCHAR(50) PRIMARY KEY, value JSONB)`);
});

beforeEach(async () => {
  mockFirebaseUpdates.length = 0;
  jest.clearAllMocks();
  initiateSTKPush.mockResolvedValue({ data: { CheckoutRequestID: 'ws_CO_NEW' } });
  querySTKStatus.mockResolvedValue({ data: { ResultCode: '1032' } });

  await sql('DELETE FROM deposits');
  await sql('DELETE FROM booth_slots');
  await sql('DELETE FROM booths');
  await sql('DELETE FROM users');
  await sql('DELETE FROM app_settings');
  await sql('DELETE FROM mpesa_callbacks');
  // Flat 50 KES: no per-percent or per-minute rates, so the bill is predictable.
  await sql(`INSERT INTO app_settings (key, value) VALUES ('pricing', '{"base_swap_fee": 50}'::jsonb)`);
  await sql(`INSERT INTO booths (id, booth_uid) VALUES (1, 'booth-A')`);
  await sql(`INSERT INTO users (user_id, phone) VALUES ('rider-1', '0733333333'), ('rider-2', NULL)`);
  // 1 reserved for a new deposit, 2 holds a charging battery, 3 holds the
  // withdrawal battery, 4 is the rental pool slot.
  await sql(`INSERT INTO booth_slots (id, booth_id, slot_identifier, status) VALUES
    (1, 1, 'slot-001', 'reserved'),
    (2, 1, 'slot-002', 'occupied'),
    (3, 1, 'slot-003', 'occupied'),
    (4, 1, 'slot-004', 'occupied')`);
});

describe('POST /cancel-session', () => {
  const cancel = (body, user = RIDER) =>
    request(app).post('/api/booths/cancel-session').set(as(user)).send(body);

  test('without an id it cancels the pending deposit, not the rental or the withdrawal', async () => {
    const charging = await addSession({ type: 'deposit', status: 'completed', slotId: 2, createdAt: minutesAgo(60) });
    const rental = await addSession({ type: 'rental', status: 'in_progress', slotId: 4, createdAt: minutesAgo(30) });
    const withdrawal = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3, createdAt: minutesAgo(20) });
    const pendingDeposit = await addSession({ type: 'deposit', status: 'pending', slotId: 1, createdAt: minutesAgo(1) });

    const res = await cancel({});

    expect(res.status).toBe(200);
    expect((await rowOf(pendingDeposit)).status).toBe('cancelled');
    expect((await rowOf(rental)).status).toBe('in_progress');
    expect((await rowOf(withdrawal)).status).toBe('pending');
    expect((await rowOf(charging)).status).toBe('completed');
    expect(await slotStatus(1)).toBe('available');
    expect(mockFirebaseUpdates).toEqual([
      { path: 'booths/booth-A/slots/slot-001/command', value: { openForDeposit: false, openForCollection: false } },
    ]);
  });

  test('the newest pending deposit wins when there are two', async () => {
    const older = await addSession({ type: 'deposit', status: 'pending', slotId: 2, createdAt: minutesAgo(10) });
    const newer = await addSession({ type: 'deposit', status: 'opening', slotId: 1, createdAt: minutesAgo(1) });

    const res = await cancel({});

    expect(res.status).toBe(200);
    expect((await rowOf(newer)).status).toBe('cancelled');
    expect((await rowOf(older)).status).toBe('pending');
  });

  test('with no deposit waiting it cancels an unpaid withdrawal and leaves its slot occupied', async () => {
    const rental = await addSession({ type: 'rental', status: 'in_progress', slotId: 4 });
    const withdrawal = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3 });

    const res = await cancel({});

    expect(res.status).toBe(200);
    expect((await rowOf(withdrawal)).status).toBe('cancelled');
    expect((await rowOf(rental)).status).toBe('in_progress');
    // The rider's battery is still inside: the slot must not be released.
    expect(await slotStatus(3)).toBe('occupied');
  });

  test('without an id it never touches a rental that is in use', async () => {
    const rental = await addSession({ type: 'rental', status: 'in_progress', slotId: 4 });

    const res = await cancel({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/No active session/);
    expect((await rowOf(rental)).status).toBe('in_progress');
    expect(await slotStatus(4)).toBe('occupied');
  });

  test('an explicit id for a rental in use is refused', async () => {
    const rental = await addSession({ type: 'rental', status: 'in_progress', slotId: 4 });

    const res = await cancel({ sessionId: rental });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot cancel an active rental.');
    expect((await rowOf(rental)).status).toBe('in_progress');
    expect(await slotStatus(4)).toBe('occupied');
  });

  test('an explicit id cancels exactly that session even when a newer one exists', async () => {
    const older = await addSession({ type: 'deposit', status: 'pending', slotId: 2, createdAt: minutesAgo(10) });
    const newer = await addSession({ type: 'deposit', status: 'pending', slotId: 1, createdAt: minutesAgo(1) });

    const res = await cancel({ sessionId: older });

    expect(res.status).toBe(200);
    expect((await rowOf(older)).status).toBe('cancelled');
    expect((await rowOf(newer)).status).toBe('pending');
  });

  test('an explicit id that has already completed is a 409, not a false success', async () => {
    const done = await addSession({ type: 'deposit', status: 'completed', slotId: 2 });

    const res = await cancel({ sessionId: done });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already completed/);
    expect((await rowOf(done)).status).toBe('completed');
  });

  test('an explicit id that is already cancelled is reported as such', async () => {
    const gone = await addSession({ type: 'deposit', status: 'cancelled', slotId: 1 });

    const res = await cancel({ sessionId: gone });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already cancelled/);
  });

  test("another rider's session id is a 404 and is left alone", async () => {
    const theirs = await addSession({ userId: OTHER.uid, type: 'deposit', status: 'pending', slotId: 1 });

    const res = await cancel({ sessionId: theirs });

    expect(res.status).toBe(404);
    expect((await rowOf(theirs)).status).toBe('pending');
  });

  test.each(['abc', 0, -3, 1.5])('rejects an invalid sessionId (%s)', async (bad) => {
    const res = await cancel({ sessionId: bad });
    expect(res.status).toBe(400);
  });

  test('a paid withdrawal cannot be cancelled', async () => {
    const paid = await addSession({ type: 'withdrawal', status: 'in_progress', slotId: 3 });

    const res = await cancel({ sessionId: paid });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot cancel a paid session.');
    expect((await rowOf(paid)).status).toBe('in_progress');
  });
});

describe('POST /sessions/:id/pay (withdrawal)', () => {
  const pay = (id, user = RIDER) =>
    request(app).post(`/api/booths/sessions/${id}/pay`).set(as(user)).send();

  test('sends one STK push to the normalised token phone and records the checkout id', async () => {
    const id = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3, amount: 150, startedAt: minutesAgo(30) });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body.checkoutRequestId).toBe('ws_CO_NEW');
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
    expect(initiateSTKPush.mock.calls[0][0]).toMatchObject({ phone: '254712345678' });
    expect((await rowOf(id)).mpesa_checkout_id).toBe('ws_CO_NEW');
  });

  test('a second request while the prompt is out gets 409 with the same checkout id and no new push', async () => {
    const id = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3, startedAt: minutesAgo(30) });

    const first = await pay(id);
    expect(first.status).toBe(200);

    const second = await pay(id);

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'Payment already in progress',
      paymentStatus: 'pending',
      checkoutRequestId: 'ws_CO_NEW',
    });
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
  });

  test('a stale push that M-Pesa says was paid is completed, not charged again', async () => {
    const id = await addSession({
      type: 'withdrawal', status: 'pending', slotId: 3,
      checkoutId: 'ws_CO_OLD', startedAt: minutesAgo(10),
    });
    querySTKStatus.mockResolvedValue({ data: { ResultCode: '0' } });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paymentStatus: 'paid', checkoutRequestId: 'ws_CO_OLD' });
    expect(querySTKStatus).toHaveBeenCalledWith('ws_CO_OLD');
    expect(completePaidWithdrawal).toHaveBeenCalledWith(expect.anything(), 'ws_CO_OLD');
    expect(initiateSTKPush).not.toHaveBeenCalled();
  });

  test('a stale push that was not paid allows a fresh prompt', async () => {
    const id = await addSession({
      type: 'withdrawal', status: 'pending', slotId: 3,
      checkoutId: 'ws_CO_OLD', startedAt: minutesAgo(10),
    });
    querySTKStatus.mockResolvedValue({ data: { ResultCode: '1032' } });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body.checkoutRequestId).toBe('ws_CO_NEW');
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
    expect(completePaidWithdrawal).not.toHaveBeenCalled();
  });

  test('a failed attempt can be retried without asking M-Pesa', async () => {
    const id = await addSession({
      type: 'withdrawal', status: 'failed', slotId: 3,
      checkoutId: 'ws_CO_FAILED', startedAt: minutesAgo(1),
    });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(querySTKStatus).not.toHaveBeenCalled();
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
  });

  test('a rider without a phone claim is charged on the stored profile phone', async () => {
    const id = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3, startedAt: minutesAgo(30) });

    const res = await pay(id, { uid: RIDER.uid });

    expect(res.status).toBe(200);
    expect(initiateSTKPush.mock.calls[0][0]).toMatchObject({ phone: '254733333333' });
  });

  test('with no usable phone anywhere it answers 400 and sends nothing', async () => {
    const id = await addSession({ userId: OTHER.uid, type: 'withdrawal', status: 'pending', slotId: 3, startedAt: minutesAgo(30) });

    const res = await pay(id, { uid: OTHER.uid });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Phone number required');
    expect(initiateSTKPush).not.toHaveBeenCalled();
    expect((await rowOf(id)).mpesa_checkout_id).toBeNull();
  });

  test("cannot pay for another rider's session", async () => {
    const id = await addSession({ userId: OTHER.uid, type: 'withdrawal', status: 'pending', slotId: 3 });

    const res = await pay(id);

    expect(res.status).toBe(404);
    expect(initiateSTKPush).not.toHaveBeenCalled();
  });
});

describe('POST /rentals/:id/pay', () => {
  const pay = (id, user = RIDER) =>
    request(app).post(`/api/booths/rentals/${id}/pay`).set(as(user)).send();

  /** A returned rental awaiting its consolidated bill. */
  const returnedRental = (overrides = {}) =>
    addSession({
      type: 'rental',
      status: 'in_progress',
      slotId: 4,
      returnSlotId: 4,
      startedAt: minutesAgo(30),
      createdAt: new Date(),
      ...overrides,
    });

  test('sends one STK push for the computed bill', async () => {
    const id = await returnedRental();

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body.checkoutRequestId).toBe('ws_CO_NEW');
    expect(res.body.amount).toBe(50);
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
    expect(initiateSTKPush.mock.calls[0][0]).toMatchObject({ phone: '254712345678', amount: 50 });
  });

  test('a second request while the prompt is out gets 409 with the checkout id and the bill', async () => {
    const id = await returnedRental();

    expect((await pay(id)).status).toBe(200);
    const second = await pay(id);

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'Payment already in progress',
      paymentStatus: 'pending',
      checkoutRequestId: 'ws_CO_NEW',
      amount: 50,
    });
    expect(initiateSTKPush).toHaveBeenCalledTimes(1);
  });

  test('a stale push that M-Pesa says was paid is completed, not charged again', async () => {
    const id = await returnedRental({ checkoutId: 'ws_CO_OLD', startedAt: minutesAgo(10) });
    querySTKStatus.mockResolvedValue({ data: { ResultCode: '0' } });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paymentStatus: 'paid', checkoutRequestId: 'ws_CO_OLD' });
    expect(completePaidRental).toHaveBeenCalledWith(expect.anything(), 'ws_CO_OLD');
    expect(initiateSTKPush).not.toHaveBeenCalled();
  });

  test('a stale push that was not paid allows a fresh prompt', async () => {
    const id = await returnedRental({ checkoutId: 'ws_CO_OLD', startedAt: minutesAgo(10) });

    const res = await pay(id);

    expect(res.status).toBe(200);
    expect(res.body.checkoutRequestId).toBe('ws_CO_NEW');
    expect(completePaidRental).not.toHaveBeenCalled();
  });

  test('uses the stored profile phone when the token has none, and 400s when there is none', async () => {
    const mine = await returnedRental();
    expect((await pay(mine, { uid: RIDER.uid })).status).toBe(200);
    expect(initiateSTKPush.mock.calls[0][0]).toMatchObject({ phone: '254733333333' });

    initiateSTKPush.mockClear();
    const theirs = await returnedRental({ userId: OTHER.uid });
    const res = await pay(theirs, { uid: OTHER.uid });
    expect(res.status).toBe(400);
    expect(initiateSTKPush).not.toHaveBeenCalled();
  });

  test('a rental that has not been returned cannot be billed', async () => {
    const id = await returnedRental({ returnSlotId: null });

    const res = await pay(id);

    expect(res.status).toBe(404);
    expect(initiateSTKPush).not.toHaveBeenCalled();
  });
});

describe('POST /mpesa/callback - failed payments', () => {
  const callback = (checkoutId, resultCode, resultDesc = 'Request cancelled by user') =>
    request(app)
      .post('/api/mpesa/callback')
      .send({ Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: resultCode, ResultDesc: resultDesc } } });

  const failure = (checkoutId) => callback(checkoutId, 1032);
  const success = (checkoutId) => callback(checkoutId, 0, 'The service request is processed successfully.');

  const rentalStatus = (checkoutId, user = RIDER) =>
    request(app).get(`/api/booths/rentals/status/${checkoutId}`).set(as(user));

  test('a failed rental payment marks the rental failed and records why', async () => {
    const id = await addSession({
      type: 'rental', status: 'in_progress', slotId: 4, returnSlotId: 4, checkoutId: 'ws_CO_A',
    });

    const res = await failure('ws_CO_A');

    expect(res.status).toBe(200);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.notes).toMatch(/M-Pesa Error: 1032 - Request cancelled by user/);
  });

  test('the rider sees "failed" straight away instead of "pending"', async () => {
    await addSession({
      type: 'rental', status: 'in_progress', slotId: 4, returnSlotId: 4,
      checkoutId: 'ws_CO_A', startedAt: minutesAgo(5),
    });
    // Before the callback the status endpoint can only say "pending".
    expect((await rentalStatus('ws_CO_A')).body.paymentStatus).toBe('pending');

    await failure('ws_CO_A');

    expect((await rentalStatus('ws_CO_A')).body.paymentStatus).toBe('failed');
  });

  test('a withdrawal still fails the same way as before', async () => {
    const id = await addSession({ type: 'withdrawal', status: 'pending', slotId: 3, checkoutId: 'ws_CO_W' });

    await failure('ws_CO_W');

    expect((await rowOf(id)).status).toBe('failed');
  });

  test('a rental that is already completed is not reopened by a late failure', async () => {
    const id = await addSession({
      type: 'rental', status: 'completed', slotId: 4, returnSlotId: 4, checkoutId: 'ws_CO_A',
    });

    await failure('ws_CO_A');

    expect((await rowOf(id)).status).toBe('completed');
  });

  test('a late failure for an older push cannot touch a rental that has a newer push', async () => {
    const id = await addSession({
      type: 'rental', status: 'in_progress', slotId: 4, returnSlotId: 4, checkoutId: 'ws_CO_B',
    });

    await failure('ws_CO_A');

    const row = await rowOf(id);
    expect(row.status).toBe('in_progress');
    expect(row.mpesa_checkout_id).toBe('ws_CO_B');
  });

  test('a deposit session is never matched by a rental failure rule', async () => {
    const id = await addSession({
      type: 'deposit', status: 'in_progress', slotId: 2, checkoutId: 'ws_CO_D',
    });

    await failure('ws_CO_D');

    expect((await rowOf(id)).status).toBe('in_progress');
  });

  test('fail -> retry -> pay: the retry is live, the old callback is ignored, and the payment completes', async () => {
    const id = await addSession({
      type: 'rental', status: 'in_progress', slotId: 4, returnSlotId: 4, createdAt: new Date(),
    });

    // 1. First prompt goes out, then the rider cancels it on the phone.
    initiateSTKPush.mockResolvedValueOnce({ data: { CheckoutRequestID: 'ws_CO_A' } });
    expect((await request(app).post(`/api/booths/rentals/${id}/pay`).set(as(RIDER)).send()).status).toBe(200);
    await failure('ws_CO_A');
    expect((await rowOf(id)).status).toBe('failed');

    // 2. Retry is allowed immediately and puts the rental back in 'in_progress'.
    initiateSTKPush.mockResolvedValueOnce({ data: { CheckoutRequestID: 'ws_CO_B' } });
    const retry = await request(app).post(`/api/booths/rentals/${id}/pay`).set(as(RIDER)).send();
    expect(retry.status).toBe(200);
    expect(retry.body.checkoutRequestId).toBe('ws_CO_B');
    expect(querySTKStatus).not.toHaveBeenCalled();
    let row = await rowOf(id);
    expect(row.status).toBe('in_progress');
    expect(row.mpesa_checkout_id).toBe('ws_CO_B');

    // 3. The new prompt is reported as pending, not failed.
    expect((await rentalStatus('ws_CO_B')).body.paymentStatus).toBe('pending');

    // 4. A duplicate/late failure for the first prompt changes nothing.
    await failure('ws_CO_A');
    expect((await rowOf(id)).status).toBe('in_progress');

    // 5. The rider pays the second prompt: the real completion accepts it.
    completePaidWithdrawal.mockResolvedValueOnce(false);
    const paid = await success('ws_CO_B');
    expect(paid.status).toBe(200);
    expect(completePaidRental).toHaveBeenCalledWith(expect.anything(), 'ws_CO_B');
    row = await rowOf(id);
    expect(row.status).toBe('completed');
    expect((await rentalStatus('ws_CO_B')).body.paymentStatus).toBe('paid');
  });
});
