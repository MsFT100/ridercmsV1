const { Router } = require('express');
const logger = require('../utils/logger');
const {
  checkChargingConditions,
  resolveStuckWithdrawals,
  resolvePendingPayments,
  runWeeklyMaintenance,
} = require('../utils/cron-functions/hardware-cron');
const { runMpesaReconciliation } = require('../utils/reconciliationWorker');

const router = Router();

/**
 * Middleware to verify the Cloud Scheduler secret.
 * Cloud Scheduler sends X-Cron-Secret header; we validate it against the env var.
 */
function verifyCronSecret(req, res, next) {
  const secret = req.headers['x-cron-secret'];

  if (!process.env.CRON_SECRET) {
    logger.warn('[Cron] CRON_SECRET env var is not set. Rejecting request.');
    return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  }

  if (secret !== process.env.CRON_SECRET) {
    logger.warn('[Cron] Invalid or missing cron secret.');
    return res.status(403).json({ error: 'Forbidden: invalid cron secret.' });
  }

  next();
}

router.use(verifyCronSecret);

/**
 * POST /api/cron/check-charging
 * Checks for slots that are safe to charge but relay is off, sends startCharging.
 */
router.post('/check-charging', async (req, res) => {
  try {
    logger.info('[Cron] Cloud Scheduler triggered: checkChargingConditions');
    await checkChargingConditions();
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Cron] checkChargingConditions failed:', error);
    res.status(500).json({ error: 'checkChargingConditions failed' });
  }
});

/**
 * POST /api/cron/resolve-stuck-withdrawals
 * Auto-completes withdrawal sessions stuck in 'in_progress' for > 5 minutes.
 */
router.post('/resolve-stuck-withdrawals', async (req, res) => {
  try {
    logger.info('[Cron] Cloud Scheduler triggered: resolveStuckWithdrawals');
    await resolveStuckWithdrawals();
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Cron] resolveStuckWithdrawals failed:', error);
    res.status(500).json({ error: 'resolveStuckWithdrawals failed' });
  }
});

/**
 * POST /api/cron/resolve-pending-payments
 * Queries M-Pesa for withdrawal sessions stuck in 'pending'.
 */
router.post('/resolve-pending-payments', async (req, res) => {
  try {
    logger.info('[Cron] Cloud Scheduler triggered: resolvePendingPayments');
    await resolvePendingPayments();
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Cron] resolvePendingPayments failed:', error);
    res.status(500).json({ error: 'resolvePendingPayments failed' });
  }
});

/**
 * POST /api/cron/weekly-maintenance
 * Purges cancelled sessions older than 30 days.
 */
router.post('/weekly-maintenance', async (req, res) => {
  try {
    logger.info('[Cron] Cloud Scheduler triggered: weeklyMaintenance');
    await runWeeklyMaintenance();
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Cron] weeklyMaintenance failed:', error);
    res.status(500).json({ error: 'weeklyMaintenance failed' });
  }
});

/**
 * POST /api/cron/reconcile-mpesa
 * Daily M-Pesa data reconciliation.
 */
router.post('/reconcile-mpesa', async (req, res) => {
  try {
    logger.info('[Cron] Cloud Scheduler triggered: reconcileMpesa');
    await runMpesaReconciliation();
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('[Cron] reconcileMpesa failed:', error);
    res.status(500).json({ error: 'reconcileMpesa failed' });
  }
});

module.exports = router;
