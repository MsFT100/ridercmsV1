const { Router } = require('express');
const poolPromise = require('../db');
const logger = require('../utils/logger');
const { getMpesaIpWhitelist, parseMetadata } = require('../utils/mpesa');
const { completePaidWithdrawal } = require('../utils/sessionUtils');

const router = Router();

const normalizeIp = (rawIp) => {
  if (!rawIp || typeof rawIp !== 'string') return '';
  let ip = rawIp.trim();

  // `X-Forwarded-For` can contain a chain: "client, proxy1, proxy2"
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }

  // Normalize IPv4-mapped IPv6 values like "::ffff:196.201.212.69"
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  return ip;
};

const getCallbackRequesterIp = (req) => {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    return normalizeIp(xForwardedFor);
  }

  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
};

/**
 * POST /api/mpesa/callback
 * @summary (Webhook) Handle M-Pesa STK Push results
 * @description Receives asynchronous payment confirmations or failures from Safaricom.
 * @tags [M-Pesa]
 */
router.post('/callback', async (req, res) => {
  const requesterIp = getCallbackRequesterIp(req);
  const whitelist = getMpesaIpWhitelist().map(normalizeIp).filter(Boolean);

  if (process.env.NODE_ENV === 'production' && whitelist.length === 0) {
    logger.warn('[MpesaCallback] SECURITY WARNING: No IP whitelist configured in production. Endpoint is public.');
  }

  // Enforce whitelist only if it is explicitly configured.
  // This avoids accidental "block-all" behavior when env vars are missing.
  if (
    process.env.NODE_ENV === 'production' &&
    whitelist.length > 0 &&
    !whitelist.includes(requesterIp)
  ) {
    logger.warn(`[MpesaCallback] Blocked callback from non-whitelisted IP: ${requesterIp}`);
    return res.status(403).json({ ResultCode: 'C2B00017', ResultDesc: 'Forbidden' });
  }

  /** @type {import('../utils/mpesa').MpesaCallbackPayload} */
  const mpesaResponse = req.body;

  // 1. Structural Validation
  const stkCallback = mpesaResponse?.Body?.stkCallback;
  if (!stkCallback) {
    logger.error('Received malformed M-Pesa callback:', JSON.stringify(mpesaResponse));
    // Acknowledge receipt anyway to prevent Safaricom retries
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

  logger.info(`[MpesaCallback] Processing Result for CheckoutID: ${CheckoutRequestID} | Code: ${ResultCode} (${ResultDesc})`);

  const pool = await poolPromise;
  const client = await pool.connect();

  // Flatten the metadata for easier access (e.g., Receipt Number, Amount)
  const metadata = parseMetadata(stkCallback.CallbackMetadata);
  const receiptNumber = metadata.MpesaReceiptNumber || 'N/A';
  const transactionAmount = metadata.Amount || 0;

  try {
    await client.query('BEGIN');

    // 2. Audit Trail: Persist the raw payload for troubleshooting
    await client.query(
      `INSERT INTO mpesa_callbacks (callback_type, payload, processing_notes) 
       VALUES ($1, $2, $3)`,
      ['stk_push', JSON.stringify(mpesaResponse), `Result: ${ResultCode} - ${ResultDesc}. Receipt: ${receiptNumber}, Paid: ${transactionAmount}`]
    );

    // 3. Update Session State
    if (Number(ResultCode) === 0) {
      // Success: move the withdrawal session to 'in_progress' and notify the user via FCM.
      const processed = await completePaidWithdrawal(client, CheckoutRequestID);
      
      if (processed) {
        logger.info(`[MpesaCallback] Successfully confirmed payment ${receiptNumber} for ${CheckoutRequestID}. Amount: ${transactionAmount}`);
      } else {
        logger.warn(`[MpesaCallback] Success ACK received for ${CheckoutRequestID} but session was already handled or not found.`);
      }
    } else {
      // Failure or Cancellation: Update the session status so the user can attempt to pay again.
      const failUpdate = await client.query(
        `UPDATE deposits 
         SET status = 'failed', 
             notes = COALESCE(notes, '') || '\n[' || NOW() || '] M-Pesa Error: ' || $1 
         WHERE mpesa_checkout_id = $2 AND status = 'pending' 
         RETURNING id`,
        [`${ResultCode} - ${ResultDesc}`, CheckoutRequestID]
      );

      if (failUpdate.rowCount > 0) {
        logger.warn(`[MpesaCallback] Payment failed for CheckoutID: ${CheckoutRequestID}. Session ${failUpdate.rows[0].id} marked as 'failed'.`);
      }
    }

    await client.query('COMMIT');

    // 4. Acknowledge receipt to Safaricom. 
    // Safaricom will keep retrying the webhook if you return anything other than a 200.
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`[MpesaCallback] Error processing webhook for ${CheckoutRequestID}:`, error);
    
    // Still acknowledge receipt to stop retries unless you want Safaricom to try again later.
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } finally {
    client.release();
  }
});

module.exports = router;
