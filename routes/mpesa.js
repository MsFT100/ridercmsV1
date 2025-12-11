const { Router } = require('express');
const logger = require('../utils/logger');
const { getDatabase } = require('firebase-admin/database');
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
      // We also retrieve the booth and slot identifiers for the Firebase command.
      const updateResult = await client.query(
        `UPDATE deposits d
         SET status = 'in_progress'
         FROM booth_slots s, booths b
         WHERE d.mpesa_checkout_id = $1
           AND d.status = 'pending'
           AND d.slot_id = s.id
           AND s.booth_id = b.id
         RETURNING b.booth_uid, s.slot_identifier;`,
        [checkoutRequestId]
      );

      if (updateResult.rowCount > 0) {
        logger.info(`Payment successful for CheckoutRequestID: ${checkoutRequestId}. Amount: ${amount}. Session status updated to 'in_progress'.`);
        const { booth_uid: boothUid, slot_identifier: slotIdentifier } = updateResult.rows[0];

        // 4. Send the command to Firebase to open the door for collection.
        const db = getDatabase();
        const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
        await commandRef.update({ openForCollection: true, openForDeposit: false });

        logger.info(`Command to open slot ${slotIdentifier} at booth ${boothUid} sent to Firebase.`);
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
