/* eslint-disable no-console */
/**
 * One-off cleanup for slot002 (booth 672a4e90-...):
 *  - Cancels the stale 'opening' deposit #19691 (matches codebase convention).
 *  - Withdraws synthetic relink ghosts bat-2-1789739562699 (id=3959) and
 *    bat-2-1789740259184 (id=3971) so they leave the rental-pool fleet.
 *  - Resets slot002 -> 'available', unlinked.
 *
 * Mirrors the admin withdraw endpoint (sessions.controller.js:1029-1108) and
 * deposit-cancel patterns (firebaseSync.js:587, deposit.controller.js:57).
 * Safe to re-run: all steps are guarded by current state.
 *
 * Usage: node scripts/cleanup-ghost-batteries.js
 */
require('dotenv').config();
const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');

const BOOTH_UID = '672a4e90-146b-4fbb-a48d-ec768f28dd70';
const SLOT_IDENTIFIER = 'slot002';
const DEPOSIT_ID = 19691;
const GHOST_IDS = [3959, 3971];

async function main() {
  let connector;
  let pool;
  try {
    connector = new Connector();
    const o = await connector.getOptions({
      instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
      ipType: process.env.DB_IP_TYPE || 'PUBLIC',
    });
    pool = new Pool({
      ...o,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 2,
      connectionTimeoutMillis: 30000,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const slot = await client.query(
        `SELECT s.id FROM public.booth_slots s
         JOIN public.booths b ON s.booth_id = b.id
         WHERE b.booth_uid = $1 AND s.slot_identifier = $2`,
        [BOOTH_UID, SLOT_IDENTIFIER]
      );
      if (slot.rowCount === 0) throw new Error(`slot ${BOOTH_UID}/${SLOT_IDENTIFIER} not found`);
      const slotId = slot.rows[0].id;
      console.log(`slot id = ${slotId}`);

      const deposit = await client.query(
        `UPDATE public.deposits
         SET status = 'cancelled', notes = COALESCE(notes, '') || '\n[' || NOW() || '] Auto-cancelled (stale opening, system cleanup).',
             updated_at = NOW()
         WHERE id = $1 AND status = 'opening' AND slot_id = $2
         RETURNING id, status`,
        [DEPOSIT_ID, slotId]
      );
      console.log(deposit.rowCount
        ? `deposit #${DEPOSIT_ID}: ${deposit.rows[0].status} (cancelled)`
        : `deposit #${DEPOSIT_ID}: not cancelled (already in state "${(await client.query('SELECT status FROM public.deposits WHERE id = $1', [DEPOSIT_ID])).rows[0]?.status}")`);

      for (const batteryId of GHOST_IDS) {
        const b = await client.query(
          `SELECT id, battery_uid, withdrawn_at FROM public.batteries WHERE id = $1`,
          [batteryId]
        );
        if (b.rowCount === 0) {
          console.log(`battery #${batteryId}: does not exist, skipping`);
          continue;
        }
        if (b.rows[0].withdrawn_at) {
          console.log(`battery #${batteryId} (${b.rows[0].battery_uid}): already withdrawn, skipping`);
          continue;
        }
        const active = await client.query(
          `SELECT 1 FROM public.deposits
           WHERE battery_id = $1 AND session_type = 'rental' AND status IN ('pending', 'in_progress') LIMIT 1`,
          [batteryId]
        );
        if (active.rowCount > 0) {
          console.log(`battery #${batteryId}: SKIPPED (has active rental)`, );
          continue;
        }
        await client.query(
          `UPDATE public.batteries
           SET withdrawn_at = NOW(), withdrawal_reason = 'System placeholder',
               withdrawal_notes = 'Synthetic UID fabricated by ensureSlotBatteryLinked relink; no real hardware serial.',
               updated_at = NOW()
           WHERE id = $1`,
          [batteryId]
        );
        console.log(`battery #${batteryId} (${b.rows[0].battery_uid}): withdrawn`);
      }

      const cleared = await client.query(
        `UPDATE public.booth_slots
         SET status = 'available', current_battery_id = NULL, charge_level_percent = NULL,
             is_charging = FALSE, door_status = 'closed', updated_at = NOW()
         WHERE id = $1
           AND current_battery_id = ANY($2::int[])
         RETURNING id`,
        [slotId, GHOST_IDS]
      );
      console.log(cleared.rowCount
        ? `slot #${slotId} (${SLOT_IDENTIFIER}): reset to available`
        : `slot #${slotId} (${SLOT_IDENTIFIER}): no-op (current_battery_id not one of the ghosts)`);

      await client.query('COMMIT');
      console.log('\nCOMMIT ok.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('cleanup failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}

main();