const request = require('supertest');
const express = require('express');

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../utils/cron-functions/hardware-cron', () => ({
  checkChargingConditions: jest.fn().mockResolvedValue(undefined),
  resolveStuckWithdrawals: jest.fn().mockResolvedValue(undefined),
  resolveStuckPendingWithdrawals: jest.fn().mockResolvedValue(undefined),
  resolvePendingPayments: jest.fn().mockResolvedValue(undefined),
  runWeeklyMaintenance: jest.fn().mockResolvedValue(undefined),
  purgeFailedSessions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/reconciliationWorker', () => ({
  runMpesaReconciliation: jest.fn().mockResolvedValue(undefined),
}));

const cronRouter = require('../routes/cron');
const cronFunctions = require('../utils/cron-functions/hardware-cron');
const { runMpesaReconciliation } = require('../utils/reconciliationWorker');

const app = express();
app.use(express.json());
app.use('/api/cron', cronRouter);

const scheduledJobs = [
  ['/check-charging', cronFunctions.checkChargingConditions],
  ['/resolve-stuck-withdrawals', cronFunctions.resolveStuckWithdrawals],
  ['/resolve-pending-payments', cronFunctions.resolvePendingPayments],
  ['/resolve-stuck-pending-withdrawals', cronFunctions.resolveStuckPendingWithdrawals],
  ['/weekly-maintenance', cronFunctions.runWeeklyMaintenance],
  ['/purge-failed-sessions', cronFunctions.purgeFailedSessions],
  ['/reconcile-mpesa', runMpesaReconciliation],
];

describe('Cron routes', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeAll(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterAll(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const [, job] of scheduledJobs) {
      job.mockResolvedValue(undefined);
    }
  });

  test.each(scheduledJobs)('POST %s invokes its cron job', async (path, job) => {
    const response = await request(app)
      .post(`/api/cron${path}`)
      .set('x-cron-secret', 'test-cron-secret');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(job).toHaveBeenCalledTimes(1);
  });

  test.each(scheduledJobs)('POST %s returns 500 when its job fails', async (path, job) => {
    job.mockRejectedValueOnce(new Error('cron job failed'));

    const response = await request(app)
      .post(`/api/cron${path}`)
      .set('x-cron-secret', 'test-cron-secret');

    expect(response.status).toBe(500);
    expect(response.body).toHaveProperty('error');
  });

  test('rejects requests without a valid cron secret', async () => {
    const response = await request(app).post('/api/cron/purge-failed-sessions');

    expect(response.status).toBe(403);
    expect(cronFunctions.purgeFailedSessions).not.toHaveBeenCalled();
  });
});
