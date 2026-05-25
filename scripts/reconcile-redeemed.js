/**
 * Finds deposits incorrectly marked as 'redeemed' by the old bug
 * where handleWithdrawalCompletion redeemed ALL the user's deposits
 * instead of just the consumed one.
 *
 * Reverts them to 'completed' so the user can withdraw normally.
 *
 * Usage: node scripts/reconcile-redeemed.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const poolPromise = require('../db');
const logger = require('../utils/logger');

async function reconcileRedeemed() {
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    // Find 'redeemed' deposit sessions that have NO matching withdrawal consuming them
    const orphanedQuery = `
      SELECT d.id, d.user_id, d.slot_id, d.created_at, d.completed_at,
             s.slot_identifier, b.booth_uid
      FROM deposits d
      JOIN booth_slots s ON d.slot_id = s.id
      JOIN booths b ON s.booth_id = b.id
      WHERE d.status = 'redeemed'
        AND d.session_type = 'deposit'
        AND NOT EXISTS (
          SELECT 1 FROM deposits w
          WHERE w.consumed_deposit_id = d.id
            AND w.session_type = 'withdrawal'
        )
      ORDER BY d.user_id, d.created_at
    `;

    const { rows } = await client.query(orphanedQuery);

    if (rows.length === 0) {
      console.log('No orphaned redeemed deposits found. Everything is clean.');
      return;
    }

    console.log(`Found ${rows.length} orphaned deposit(s) incorrectly marked as redeemed:\n`);

    for (const row of rows) {
      console.log(`  ID: ${row.id} | User: ${row.user_id} | Booth: ${row.booth_uid} | Slot: ${row.slot_identifier} | Completed: ${row.completed_at}`);
    }

    console.log('\n--- Reverting to completed ---\n');

    await client.query('BEGIN');

    const ids = rows.map(r => r.id);
    const updateResult = await client.query(
      `UPDATE deposits SET status = 'completed', updated_at = NOW()
       WHERE id = ANY($1::int[]) AND status = 'redeemed' AND session_type = 'deposit'
       RETURNING id`,
      [ids]
    );

    await client.query('COMMIT');

    console.log(`Reverted ${updateResult.rowCount} deposit(s) back to 'completed'.`);

    // Check slots
    console.log('\n--- Slot status summary ---\n');
    for (const row of rows) {
      const slotRes = await client.query(
        `SELECT status, telemetry FROM booth_slots WHERE id = $1`,
        [row.slot_id]
      );
      const slot = slotRes.rows[0];
      console.log(`  Slot ${row.booth_uid}/${row.slot_identifier}: DB status=${slot?.status}, batteryInserted=${slot?.telemetry?.batteryInserted || 'N/A'}`);
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during reconciliation:', error);
  } finally {
    client.release();
  }

  process.exit(0);
}

reconcileRedeemed();
