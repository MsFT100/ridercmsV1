const { Router } = require('express');
const logger = require('../utils/logger');
const { getMpesaIpWhitelist } = require('../utils/mpesa');
const poolPromise = require('../db');

// This function is defined in booths.js but we need its signature here for clarity.
// We can't import it directly due to circular dependency issues.
/**
 * @typedef {import('./booths.js').completePaidWithdrawal} completePaidWithdrawal
 * async function completePaidWithdrawal(client, checkoutRequestId) { ... }
 */

// A bit of a workaround to avoid circular dependencies. We will require it inside the function.
// A better long-term solution might be to move shared functions to a separate module.
let completePaidWithdrawalFn;

const router = Router();

/**
 * POST /api/mpesa/callback
 * This is the callback URL that M-Pesa will post to after an STK push transaction.
 * It's an asynchronous webhook.
 */
router.post('/callback', async (req, res) => {
  const requestIp = req.ip;
  const whitelist = getMpesaIpWhitelist();

  if (process.env.NODE_ENV === 'production' && !whitelist.includes(requestIp)) {
    logger.warn(`M-Pesa callback from untrusted IP blocked: ${requestIp}`);
    return res.status(403).json({ ResultCode: 'C2B00017', ResultDesc: 'Forbidden' });
  }

  const callbackData = req.body;
  logger.info('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

  // ACK immediately
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1️⃣ Persist raw callback (audit trail)
    await client.query(
      'INSERT INTO mpesa_callbacks (callback_type, payload) VALUES ($1, $2)',
      ['stk_push', callbackData]
    );

    const stkCallback = callbackData?.Body?.stkCallback;
    if (!stkCallback) {
      throw new Error('Invalid callback payload');
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;

    // 2️⃣ Idempotency guard — lock the session row
    const sessionRes = await client.query(
      `
      SELECT id, status
      FROM deposits
      WHERE mpesa_checkout_id = $1
      FOR UPDATE
      `,
      [checkoutRequestId]
    );

    if (sessionRes.rows.length === 0) {
      logger.warn(`Callback for unknown CheckoutRequestID: ${checkoutRequestId}`);
      await client.query('ROLLBACK');
      return;
    }

    const { status } = sessionRes.rows[0];

    // Already processed — exit safely
    if (status !== 'pending') {
      logger.info(`Ignoring duplicate callback for ${checkoutRequestId}, status=${status}`);
      await client.query('ROLLBACK');
      return;
    }

    // 3️⃣ Successful payment
    if (stkCallback.ResultCode === 0) {
      if (!completePaidWithdrawalFn) {
        completePaidWithdrawalFn = require('./booths.js').completePaidWithdrawal;
      }

      await completePaidWithdrawalFn(client, checkoutRequestId);

      logger.info(`Payment confirmed for ${checkoutRequestId}`);
    } else {
      // 4️⃣ Failure — only if still pending
      await client.query(
        `
        UPDATE deposits
        SET status = 'failed'
        WHERE mpesa_checkout_id = $1
          AND status = 'pending'
        `,
        [checkoutRequestId]
      );

      logger.warn(
        `STK failed for ${checkoutRequestId}: ${stkCallback.ResultDesc}`
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Error processing M-Pesa callback:', error);
  } finally {
    client.release();
  }
});


module.exports = router;
