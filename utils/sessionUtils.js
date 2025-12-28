const { getDatabase } = require('firebase-admin/database');
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
      `SELECT d.id, d.status, b.booth_uid, s.slot_identifier
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

    const { id: sessionId, booth_uid: boothUid, slot_identifier: slotIdentifier } = sessionRes.rows[0];

    // 2. Atomically update the status from 'pending' to 'in_progress'.
    await client.query("UPDATE deposits SET status = 'in_progress' WHERE id = $1", [sessionId]);

    // 3. The session was successfully updated. Now send the hardware command.
    const db = getDatabase();
    const commandRef = db.ref(`booths/${boothUid}/slots/${slotIdentifier}/command`);
    await commandRef.update({
      stopCharging: true,
      startCharging: false,
      openForCollection: true,
      openForDeposit: false,
    });

    logger.info(`Sent 'openForCollection' command to ${slotIdentifier} at booth ${boothUid} for checkout ID ${checkoutRequestId}.`);
    return true;
  } catch (error) {
    logger.error(`Error in completePaidWithdrawal for checkout ID ${checkoutRequestId}:`, error);
    // Re-throw the error so the calling transaction can be rolled back.
    throw error;
  }
}

module.exports = { completePaidWithdrawal };
