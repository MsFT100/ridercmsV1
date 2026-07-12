const { admin } = require('./firebase');
const logger = require('./logger');

/**
 * Finalizes a withdrawal session by completing the withdrawal row, redeeming the
 * original deposit credit, and resetting the slot back to available.
 * This is shared by paid withdrawals and manual/admin withdrawals so they cannot
 * diverge in the slot-release behavior.
 * @param {object} client - The PostgreSQL client, assumed to be within an active transaction.
 * @param {number} slotId - The booth slot ID.
 * @param {string} [slotIdentifier] - Optional slot identifier for logging.
 * @param {number|null} [sessionId] - Optional exact withdrawal session ID to finalize.
 * @returns {Promise<{sessionId: number, consumedDepositId: number|null}>} - The finalized session details.
 */
async function finalizeWithdrawalSession(client, slotId, slotIdentifier = null, sessionId = null) {
  const finalizationQuery = `
    WITH selected AS (
      SELECT id, user_id, consumed_deposit_id
      FROM deposits
      WHERE slot_id = $1
        AND session_type = 'withdrawal'
        AND (
          ($2::int IS NULL AND status = 'in_progress')
          OR ($2::int IS NOT NULL AND id = $2 AND status IN ('in_progress', 'completed'))
        )
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 1
      FOR UPDATE
    ), updated_deposit AS (
      UPDATE deposits
      SET
        status = CASE
          WHEN deposits.status = 'in_progress' THEN 'completed'
          ELSE deposits.status
        END,
        completed_at = COALESCE(deposits.completed_at, NOW())
      FROM selected
      WHERE deposits.id = selected.id
      RETURNING deposits.id, deposits.user_id
    ), redeem_credit AS (
      UPDATE deposits
      SET status = 'redeemed'
      WHERE id = (SELECT consumed_deposit_id FROM selected)
      RETURNING id
    )
    UPDATE booth_slots
    SET status = 'available', current_battery_id = NULL, updated_at = NOW()
    WHERE id = $1
    RETURNING (SELECT id FROM updated_deposit) AS session_id,
              (SELECT consumed_deposit_id FROM selected) AS consumed_deposit_id;
  `;

  const updateResult = await client.query(finalizationQuery, [slotId, sessionId]);

  if (updateResult.rowCount === 0) {
    return null;
  }

  const { session_id: finalizedSessionId, consumed_deposit_id: consumedDepositId } = updateResult.rows[0];
  logger.info(`Withdrawal session ${finalizedSessionId} finalized${slotIdentifier ? ` for slot ${slotIdentifier}` : ''}.`);
  return {
    sessionId: finalizedSessionId,
    consumedDepositId,
  };
}

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
      `SELECT d.id, d.status, d.user_id, d.amount
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

module.exports = { completePaidWithdrawal, finalizeWithdrawalSession };
