// @ts-check
const poolPromise = require('../db');
const logger = require('./logger');
const { querySTKStatus, parseMetadata } = require('./mpesa');

/**
 * Identifies M-Pesa callbacks from the last 24 hours that are missing 
 * Receipt Numbers or Amounts and attempts to recover them via the Query API.
 */
async function runMpesaReconciliation() {
  logger.info('[Reconciliation] Starting daily M-Pesa data check...');
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    // Find successful callbacks with "N/A" in processing_notes from the last 48 hours
    const incompleteRecords = await client.query(`
      SELECT id, payload, processing_notes 
      FROM mpesa_callbacks 
      WHERE callback_type = 'stk_push'
        AND (processing_notes LIKE '%Receipt: N/A%' OR processing_notes LIKE '%Paid: N/A%')
        AND created_at > NOW() - INTERVAL '48 hours'
    `);

    logger.info(`[Reconciliation] Found ${incompleteRecords.rowCount} records requiring verification.`);

    for (const record of incompleteRecords.rows) {
      const payload = JSON.parse(record.payload);
      const checkoutRequestId = payload?.Body?.stkCallback?.CheckoutRequestID;

      if (!checkoutRequestId) continue;

      try {
        logger.debug(`[Reconciliation] Querying M-Pesa for CheckoutID: ${checkoutRequestId}`);
        const mpesaResponse = await querySTKStatus(checkoutRequestId);
        
        // The query API returns ResultCode '0' for a successful transaction
        if (mpesaResponse.data.ResultCode === '0') {
          const metadata = parseMetadata(mpesaResponse.data.CallbackMetadata);
          const actualReceipt = metadata.MpesaReceiptNumber;
          const actualAmount = metadata.Amount;

          if (actualReceipt && actualAmount) {
            const updatedNotes = record.processing_notes
              .replace('Receipt: N/A', `Receipt: ${actualReceipt} (Recovered)`)
              .replace('Paid: N/A', `Paid: ${actualAmount} (Recovered)`);

            // Update the audit log
            await client.query(
              'UPDATE mpesa_callbacks SET processing_notes = $1, updated_at = NOW() WHERE id = $2',
              [updatedNotes, record.id]
            );

            // Also update the session notes in the deposits table if applicable
            await client.query(
              `UPDATE deposits 
               SET notes = COALESCE(notes, '') || '\n[' || NOW() || '] Reconciliation: Recovered Receipt ${actualReceipt}, Amount ${actualAmount}'
               WHERE mpesa_checkout_id = $1`,
              [checkoutRequestId]
            );

            logger.info(`[Reconciliation] Successfully recovered data for ${checkoutRequestId}: ${actualReceipt}`);
          }
        } else {
          logger.warn(`[Reconciliation] Query for ${checkoutRequestId} returned ResultCode ${mpesaResponse.data.ResultCode}: ${mpesaResponse.data.ResultDesc}`);
        }
      } catch (apiError) {
        logger.error(`[Reconciliation] API Error for ${checkoutRequestId}:`, apiError.message);
      }
    }

    logger.info('[Reconciliation] Daily M-Pesa data check completed.');
  } catch (error) {
    logger.error('[Reconciliation] Critical failure during reconciliation:', error);
  } finally {
    client.release();
  }
}

module.exports = { runMpesaReconciliation };