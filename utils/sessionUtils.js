const { getDatabase } = require('firebase-admin/database');
const { admin } = require('./firebase');
const logger = require('./logger');

/**
 * A reusable function to complete a paid withdrawal session.
 * It updates the database and sends the command to Firebase to open the slot.
 * This prevents code duplication between the M-Pesa callback and self-healing logic.
 * @param {object} client - The PostgreSQL client, assumed to be within an active transaction.
 * @param {string} checkoutRequestId - The M-Pesa checkout request ID.
 * @returns {Promise<boolean>} - True if the session was successfully updated, false otherwise.
 */
async function completePaidWithdrawal(client, checkoutRequestId) {
  // Note: This function is designed to be called from within an existing transaction.
  // It does not handle BEGIN/COMMIT/ROLLBACK itself.
  try {
    // 1. Find and lock the specific session row to prevent race conditions.
    const sessionRes = await client.query(
      `SELECT d.id, d.status, d.user_id, d.amount, b.booth_uid, s.slot_identifier
       FROM deposits d
       JOIN booth_slots s ON d.slot_id = s.id
       JOIN booths b ON s.booth_id = b.id
       WHERE d.mpesa_checkout_id = $1 AND d.session_type = 'withdrawal'
       FOR UPDATE;`,
      [checkoutRequestId]
    );

    if (sessionRes.rowCount === 0 || sessionRes.rows[0].status !== 'pending') {
      // If no session is found, or if it's not pending, it means it was already processed.
      // This is the core of our idempotency check.
      return false;
    }

    const {
      id: sessionId,
      user_id: userId,
      amount,
      booth_uid: boothUid,
      slot_identifier: slotIdentifier,
    } = sessionRes.rows[0];

    // 2. Atomically update the status from 'pending' to 'in_progress'.
    await client.query("UPDATE deposits SET status = 'in_progress' WHERE id = $1", [sessionId]);

    // 3. Command is no longer sent here. User must scan the booth to trigger release.

    // 4. Best-effort user push notification for successful payment.
    // Notification failures should not block payment completion.
    try {
      const userRes = await client.query(
        'SELECT fcm_token FROM users WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      const fcmToken = userRes.rows[0]?.fcm_token;

      if (fcmToken) {
        const formattedAmount = Number(amount || 0).toFixed(2);
        await admin.messaging().send({
          token: fcmToken,
          notification: {
            title: 'Payment successful',
            body: `KES ${formattedAmount} received. Please scan the QR code on the booth to collect your battery.`,
          },
          data: {
            type: 'payment_success',
            checkoutRequestId: String(checkoutRequestId),
            sessionId: String(sessionId),
            amount: String(formattedAmount),
          },
          android: {
            priority: 'high',
          },
        });
        logger.info(`Sent payment success push notification for session ${sessionId} (user ${userId}).`);
      } else {
        logger.info(`No FCM token on file for user ${userId}; skipping payment success push.`);
      }
    } catch (pushError) {
      logger.warn(
        `Payment success push failed for checkout ${checkoutRequestId}: ${pushError?.message || pushError}`
      );
    }

    logger.info(`Payment confirmed for session ${sessionId}. Waiting for user to scan and release battery.`);
    return true;
  } catch (error) {
    logger.error(`Error in completePaidWithdrawal for checkout ID ${checkoutRequestId}:`, error);
    // Re-throw the error so the calling transaction can be rolled back.
    throw error;
  }
}

module.exports = { completePaidWithdrawal };
