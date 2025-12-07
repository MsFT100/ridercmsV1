const { Router } = require('express');
const logger = require('../utils/logger');
const pool = require('../db');

const router = Router();

/**
 * POST /api/mpesa/callback
 * This is the callback URL that M-Pesa will post to after an STK push transaction.
 * It's an asynchronous webhook.
 */
router.post('/callback', async (req, res) => {
  const callbackData = req.body;
  logger.info('M-Pesa Callback Received:', JSON.stringify(callbackData, null, 2));

  // Immediately respond to M-Pesa to acknowledge receipt and avoid timeouts.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const client = await pool.connect();
  try {
    // 1. Log the entire callback payload for auditing and debugging.
    await client.query(
      'INSERT INTO mpesa_callbacks (callback_type, payload) VALUES ($1, $2)',
      ['stk_push', callbackData]
    );

    const { Body: { stkCallback } } = callbackData;

    // 2. Check if the transaction was successful.
    if (stkCallback.ResultCode === 0) {
      // Payment was successful.
      const checkoutRequestId = stkCallback.CheckoutRequestID;
      const amountItem = stkCallback.CallbackMetadata.Item.find(item => item.Name === 'Amount');
      const amount = amountItem ? amountItem.Value : null;

      // 3. Update the corresponding deposit session status to 'in_progress'.
      // This signals to the polling endpoint that payment is complete.
      const updateResult = await client.query(
        "UPDATE deposits SET status = 'in_progress' WHERE mpesa_checkout_id = $1 AND status = 'pending'",
        [checkoutRequestId]
      );

      if (updateResult.rowCount > 0) {
        logger.info(`Payment successful for CheckoutRequestID: ${checkoutRequestId}. Amount: ${amount}. Session status updated to 'in_progress'.`);
      } else {
        logger.warn(`Received a successful M-Pesa callback for an unknown or already processed CheckoutRequestID: ${checkoutRequestId}`);
      }
    } else {
      // Payment failed or was cancelled by the user.
      logger.warn(`M-Pesa STK push failed for CheckoutRequestID: ${stkCallback.CheckoutRequestID}. Reason: ${stkCallback.ResultDesc}`);
      // Optionally, update the status to 'failed'
      await client.query("UPDATE deposits SET status = 'failed' WHERE mpesa_checkout_id = $1", [stkCallback.CheckoutRequestID]);
    }
  } catch (error) {
    logger.error('Error processing M-Pesa callback:', error);
  } finally {
    client.release();
  }
});

module.exports = router;
