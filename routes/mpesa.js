const { Router } = require('express');
const logger = require('../utils/logger');
const { getMpesaIpWhitelist } = require('../utils/mpesa');
const { getDatabase } = require('firebase-admin/database');
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
  // Security: Basic IP whitelisting to ensure the request is from a trusted source.
  const requestIp = req.ip;
  const whitelist = getMpesaIpWhitelist();
  if (process.env.NODE_ENV === 'production' && !whitelist.includes(requestIp)) {
    logger.warn(`M-Pesa callback from untrusted IP blocked: ${requestIp}`);
    return res.status(403).json({ ResultCode: 'C2B00017', ResultDesc: 'Forbidden' });
  }

  const callbackData = req.body;
  console.log("Mpesa Callback Data:", JSON.stringify(callbackData, null, 2));
  logger.info('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

  // Immediately respond to M-Pesa to acknowledge receipt and avoid timeouts.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    // 1. Log the entire callback payload for auditing and debugging.
    await client.query(
      'INSERT INTO mpesa_callbacks (callback_type, payload) VALUES ($1, $2)',
      ['stk_push', callbackData]
    );

    const { Body: { stkCallback } } = callbackData;

    // Robustness: Check if stkCallback exists before proceeding.
    if (!stkCallback) {
      throw new Error('Invalid M-Pesa callback format: stkCallback is missing.');
    }

    // 2. Check if the transaction was successful.
    if (stkCallback.ResultCode === 0) {
      // Payment was successful.
      const checkoutRequestId = stkCallback.CheckoutRequestID;
      const amountItem = stkCallback.CallbackMetadata.Item.find(item => item.Name === 'Amount');
      const amount = amountItem ? amountItem.Value : null;

      // Robustness: Ensure we have the necessary metadata.
      if (!checkoutRequestId || !amount) {
        throw new Error(`Invalid successful callback data: Missing CheckoutRequestID or Amount for payload: ${JSON.stringify(stkCallback)}`);
      }

      // 3. Update the corresponding deposit session status to 'in_progress'.
      // This signals to the polling endpoint that payment is complete.
      // Lazily require the function to avoid circular dependency at startup.
      if (!completePaidWithdrawalFn) {
        completePaidWithdrawalFn = require('./booths.js').completePaidWithdrawal;
      }
      const wasUpdated = await completePaidWithdrawalFn(client, checkoutRequestId);

      if (wasUpdated) {
        logger.info(`Payment successful for CheckoutRequestID: ${checkoutRequestId}. Amount: ${amount}. Session status updated to 'in_progress'.`);
      } else {
        logger.warn(`Received a successful M-Pesa callback for an unknown or already processed CheckoutRequestID: ${checkoutRequestId}`);
      }
    } else {
      // Payment failed or was cancelled by the user.
      logger.warn(`M-Pesa STK push failed for CheckoutRequestID: ${stkCallback.CheckoutRequestID}. Reason: ${stkCallback.ResultDesc}`);
      // Update the status to 'failed' only if it's currently 'pending'.
      // This prevents overwriting a 'completed' status from a self-healing query.
      await client.query(
        "UPDATE deposits SET status = 'failed' WHERE mpesa_checkout_id = $1 AND status = 'pending'",
        [stkCallback.CheckoutRequestID]
      );
    }
  } catch (error) {
    logger.error('Error processing M-Pesa callback:', error);
  } finally {
    client.release();
  }
});

module.exports = router;
