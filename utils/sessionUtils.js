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
 * Returns the owned deposit consumed by a rental session.
 * @param {object} client - The PostgreSQL client.
 * @param {number} rentalSessionId - The rental session id.
 * @returns {Promise<{id: number, slotId: number, slotIdentifier: string, boothUid: string} | null>} The consumed deposit slot details.
 */
async function getRentalOwnSlot(client, rentalSessionId) {
  const res = await client.query(
    `SELECT d.consumed_deposit_id AS "depositId",
            s.id AS "slotId",
            s.slot_identifier AS "slotIdentifier",
            b.booth_uid AS "boothUid"
     FROM deposits d
     JOIN deposits own ON own.id = d.consumed_deposit_id
     JOIN booth_slots s ON own.slot_id = s.id
     JOIN booths b ON s.booth_id = b.id
     WHERE d.id = $1 AND d.session_type = 'rental'`,
    [rentalSessionId]
  );
  return res.rowCount > 0 ? res.rows[0] : null;
}

/**
 * Finalizes a rental session after the user has collected their own charged battery.
 * Redeems the own deposit consumed by the rental and resets the own slot back to available.
 * @param {object} client - The PostgreSQL client, assumed to be within an active transaction.
 * @param {number} ownSlotId - The booth slot id currently holding the user's own battery.
 * @param {string} [slotIdentifier] - Optional slot identifier for logging.
 * @param {number} rentalSessionId - The rental session id that consumed the deposit.
 * @returns {Promise<boolean>} True if the rental was finalized.
 */
async function finalizeRentalSession(client, ownSlotId, slotIdentifier = null, rentalSessionId) {
  const finalizeQuery = `
    WITH selected AS (
      SELECT r.id, r.consumed_deposit_id
      FROM deposits r
      WHERE r.id = $2 AND r.session_type = 'rental' AND r.status = 'completed'
      FOR UPDATE
    ), updated_rental AS (
      UPDATE deposits
      SET completed_at = COALESCE(deposits.completed_at, NOW()),
          notes = COALESCE(deposits.notes, '') || '\n[' || NOW() || '] Rental settled, own battery collected.'
      FROM selected
      WHERE deposits.id = selected.id
      RETURNING deposits.id
    ), redeem_own AS (
      UPDATE deposits
      SET status = 'redeemed'
      WHERE id = (SELECT consumed_deposit_id FROM selected)
      RETURNING id
    )
    UPDATE booth_slots
    SET status = 'available', current_battery_id = NULL, updated_at = NOW()
    WHERE id = $1
    RETURNING (SELECT id FROM updated_rental) AS rental_id,
              (SELECT id FROM redeem_own) AS own_deposit_id;
  `;

  const updateResult = await client.query(finalizeQuery, [ownSlotId, rentalSessionId]);

  if (updateResult.rowCount === 0) {
    return false;
  }

  const { rental_id: rentalId, own_deposit_id: ownDepositId } = updateResult.rows[0];
  logger.info(`Rental session ${rentalId} finalized. Own deposit ${ownDepositId} redeemed${slotIdentifier ? ` for own slot ${slotIdentifier}` : ''}.`);
  return true;
}

/**
 * Marks a rental session as collected: flips 'pending' -> 'in_progress' and
 * resets the source slot back to available (the rented battery has left it).
 * Shared by the hardware 'collection_complete' ACK and dev-booth simulation.
 * @param {object} pgClient - The PostgreSQL client, assumed to be within an active transaction.
 * @param {number} slotId - The source booth slot id the rented battery was taken from.
 * @param {string} [slotIdentifier] - Optional slot identifier for logging.
 * @returns {Promise<boolean>} True if a pending rental was collected.
 */
async function finalizeRentalCollection(pgClient, slotId, slotIdentifier = null) {
  const result = await pgClient.query(
    `WITH updated_rental AS (
       UPDATE deposits
       SET status = 'in_progress',
           started_at = NOW(),
           notes = COALESCE(notes, '') || '\n[' || NOW() || '] Rental battery collected.'
       WHERE slot_id = $1
         AND session_type = 'rental'
         AND status = 'pending'
       RETURNING id
     )
     UPDATE booth_slots
     SET status = 'available', current_battery_id = NULL,
         charge_level_percent = NULL, is_charging = false, updated_at = NOW()
     WHERE id = $1
     RETURNING (SELECT id FROM updated_rental) AS rental_id`,
    [slotId]
  );

  if (result.rowCount === 0) {
    return false;
  }

  logger.info(`Rental ${result.rows[0].rental_id} marked as collected${slotIdentifier ? ` from slot ${slotIdentifier}` : ''}.`);
  return true;
}

/**
 * Completes a rental return: marks the return slot as occupied by the rented
 * battery once it is physically inserted. The rental stays 'in_progress'
 * (awaiting its consolidated bill payment). Idempotent in practice because the
 * dependency on 'return_slot_id' can only match the reserved return slot once.
 * @param {object} pgClient - The PostgreSQL client, assumed to be within an active transaction.
 * @param {number} returnSlotId - The booth slot id the rented battery was inserted into.
 * @param {string} [returnSlotIdentifier] - Optional slot identifier for logging.
 * @param {number|null} [returnSoc] - The returned battery's SOC at insertion.
 * @returns {Promise<boolean>} True if a rental return was recorded.
 */
async function handleRentalReturnCompletion(pgClient, returnSlotId, returnSlotIdentifier = null, returnSoc = null) {
  const result = await pgClient.query(
    `WITH selected AS (
       SELECT r.id, r.battery_id
       FROM deposits r
       WHERE r.return_slot_id = $1
         AND r.session_type = 'rental'
         AND r.status = 'in_progress'
       LIMIT 1
       FOR UPDATE
     ), update_slot AS (
       UPDATE booth_slots
       SET status = 'occupied',
           current_battery_id = (SELECT battery_id FROM selected),
           charge_level_percent = $2,
           is_charging = false,
           door_status = 'closed',
           updated_at = NOW()
       WHERE id = $1 AND (SELECT id FROM selected) IS NOT NULL
       RETURNING id
     )
     UPDATE deposits
     SET notes = COALESCE(notes, '') || '\n[' || NOW() || '] Rental battery returned to slot ' || COALESCE($3, '') || ' at ' || COALESCE($2::text, '?') || '%SOC.'
     WHERE id = (SELECT id FROM selected)
     RETURNING (SELECT id FROM update_slot) AS slot_id`,
    [returnSlotId, returnSoc, returnSlotIdentifier || '']
  );

  if (result.rowCount === 0) {
    return false;
  }

  logger.info(`Rental marked as returned${returnSlotIdentifier ? ` to slot ${returnSlotIdentifier}` : ''}.`);
  return true;
}

/**
 * Finalizes the "collect your own charged battery" step of a rental.
 * Called after the consolidated bill has been paid and the user takes their own
 * battery from the booth slot that held their deposit.
 * @param {object} pgClient - The PostgreSQL client, assumed to be within an active transaction.
 * @param {number} ownSlotId - The booth slot id holding the user's own battery.
 * @param {string} [slotIdentifier] - Optional slot identifier for logging.
 * @returns {Promise<boolean>} True if a completed rental's own battery was collected.
 */
async function finalizeRentalOwnCollection(pgClient, ownSlotId, slotIdentifier = null) {
  const rentalRes = await pgClient.query(
    `SELECT r.id AS rental_id
     FROM deposits r
     JOIN deposits own ON own.id = r.consumed_deposit_id
     WHERE own.slot_id = $1
       AND r.session_type = 'rental'
       AND r.status = 'completed'
       AND own.status = 'completed'
     ORDER BY r.completed_at DESC
     LIMIT 1`,
    [ownSlotId]
  );

  if (rentalRes.rowCount === 0) {
    return false;
  }

  return finalizeRentalSession(pgClient, ownSlotId, slotIdentifier, rentalRes.rows[0].rental_id);
}

/**
 * A reusable function to complete a paid rental session.
 * Moves a returned (unpaid) rental from 'in_progress' to 'completed' once the
 * consolidated bill payment is confirmed, and notifies the user to collect their
 * own charged battery.
 * @param {object} client - The PostgreSQL client, assumed to be within an active transaction.
 * @param {string} checkoutRequestId - The M-Pesa checkout request ID.
 * @returns {Promise<boolean>} - True if the session was successfully updated, false otherwise.
 */
async function completePaidRental(client, checkoutRequestId) {
  try {
    const sessionRes = await client.query(
      `SELECT d.id, d.status, d.user_id, d.amount
       FROM deposits d
       WHERE d.mpesa_checkout_id = $1 AND d.session_type = 'rental'
       FOR UPDATE;`,
      [checkoutRequestId]
    );

    if (sessionRes.rowCount === 0 || sessionRes.rows[0].status !== 'in_progress') {
      return false;
    }

    const {
      id: sessionId,
      user_id: userId,
      amount,
    } = sessionRes.rows[0];

    await client.query(
      `UPDATE deposits
       SET status = 'completed', completed_at = NOW(),
           notes = COALESCE(notes, '') || '\n[' || NOW() || '] Consolidated rental bill paid.'
       WHERE id = $1`,
      [sessionId]
    );

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
            body: `KES ${formattedAmount} received. Scan the QR on your booth to collect your own charged battery.`,
          },
          data: {
            type: 'rental_payment_success',
            checkoutRequestId: String(checkoutRequestId),
            sessionId: String(sessionId),
            amount: String(formattedAmount),
          },
          android: {
            priority: 'high',
          },
        });
        logger.info(`Sent rental payment success push notification for session ${sessionId} (user ${userId}).`);
      } else {
        logger.info(`No FCM token on file for user ${userId}; skipping rental payment success push.`);
      }
    } catch (pushError) {
      logger.warn(
        `Rental payment success push failed for checkout ${checkoutRequestId}: ${pushError?.message || pushError}`
      );
    }

    logger.info(`Rental payment confirmed for session ${sessionId}. Waiting for user to collect own battery.`);
    return true;
  } catch (error) {
    logger.error(`Error in completePaidRental for checkout ID ${checkoutRequestId}:`, error);
    throw error;
  }
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
    // 1. Find and lock the specific session row (mpesa_checkout_id is UNIQUE),
    //    preventing race conditions without needing booth/slot joins.
    const sessionRes = await client.query(
      `SELECT id, status, user_id, amount
       FROM deposits
       WHERE mpesa_checkout_id = $1 AND session_type = 'withdrawal'
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

module.exports = {
  completePaidWithdrawal,
  finalizeWithdrawalSession,
  getRentalOwnSlot,
  completePaidRental,
  finalizeRentalSession,
  finalizeRentalCollection,
  handleRentalReturnCompletion,
  finalizeRentalOwnCollection,
};
