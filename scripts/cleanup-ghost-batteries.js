/* eslint-disable no-console */
/**
 * Cleanup: withdraw synthetic "ghost" batteries fabricated by
 * ensureSlotBatteryLinked (UID pattern `bat-<slotId>-<epochMs>`).
 *
 * A ghost is a batteries row whose UID was fabricated when an occupied slot had
 * no deposit owner (the deposit was already consumed by a withdrawal, or the
 * battery was never owned). Such rows have no real hardware serial and polluted
 * the rental-pool fleet as "Available Rental Battery" / "Rental Pool" entries.
 *
 * Safety:
 *  - Only UIDs matching the synthetic `bat-<slotId>-<epoch>` pattern are touched.
 *  - A battery is skipped when it still has an ACTIVE deposit/rental/withdrawal
 *    referencing it or a slot physically linked to it (occupied / opening).
 *  - The linked slot is only reset when the ghost was the sole occupant.
 *
 * Usage: node scripts/cleanup-ghost-batteries.js
 * Safe to re-run.
 */
require('dotenv').config();
const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');

async function main() {
  let connector;
  let pool;
  try {
    connector = new Connector();
    const o = await connector.getOptions({
      instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
      ipType: process.env.DB_IP_TYPE || 'PUBLIC',
    });
    pool = new Pool({ ...o, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 2, connectionTimeoutMillis: 30000 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Synthetic batteries in the fleet: any batteries row with the fabricated
      // UID pattern. These should never survive once their owning deposit is
      // consumed and the owning slot no longer links them physically.
      const ghosts = await client.query(`
        SELECT b.id AS battery_id, b.battery_uid, b.created_at, b.withdrawn_at,
               s.id AS slot_id, s.slot_identifier, s.status AS slot_status,
               bo.booth_uid
        FROM public.batteries b
        LEFT JOIN public.booth_slots s ON s.current_battery_id = b.id
        LEFT JOIN public.booths bo ON s.booth_id = bo.id
        WHERE b.battery_uid ~ '^bat-[0-9]+-[0-9]+$'
        ORDER BY b.updated_at DESC
      `);

      console.log(`\n=== Synthetic (bat-*) batteries: ${ghosts.rowCount} ===\n`);

      let withdrawn = 0;
      let skipped = 0;

      for (const row of ghosts.rows) {
        // Skip if the battery is still physically claimed by the system:
        // an active/opening slot or an unconsumed deposit / active rental.
        const active = await client.query(
          `SELECT
             (SELECT count(*) FROM public.booth_slots s2
              WHERE s2.current_battery_id = $1 AND s2.status IN ('occupied', 'opening')) AS claimed_slots,
             (SELECT count(*) FROM public.deposits d
              WHERE d.battery_id = $1
                AND d.session_type = 'deposit'
                AND d.status IN ('opening', 'in_progress', 'completed')
                AND NOT EXISTS (
                  SELECT 1 FROM public.deposits w
                  WHERE w.consumed_deposit_id = d.id
                    AND w.session_type IN ('withdrawal', 'rental')
                    AND w.status NOT IN ('cancelled', 'failed')
                )) AS active_deposits,
             (SELECT count(*) FROM public.deposits r
              WHERE r.battery_id = $1
                AND r.session_type IN ('withdrawal', 'rental')
                AND r.status IN ('pending', 'in_progress')) AS active_rentals`,
          [row.battery_id]
        );

        const { claimed_slots: claimedSlots, active_deposits: activeDeposits, active_rentals: activeRentals } = active.rows[0];

        if (row.withdrawn_at) {
          console.log(`  [skip] #${row.battery_id} ${row.battery_uid}: already withdrawn`);
          skipped++;
          continue;
        }

        if (Number(claimedSlots) > 0 || Number(activeDeposits) > 0 || Number(activeRentals) > 0) {
          console.log(`  [skip] #${row.battery_id} ${row.battery_uid}: still active (slots=${claimedSlots} deposits=${activeDeposits} rentals=${activeRentals})`);
          skipped++;
          continue;
        }

        // Withdraw the ghost battery.
        await client.query(
          `UPDATE public.batteries
           SET withdrawn_at = NOW(),
               withdrawal_reason = 'System placeholder',
               withdrawal_notes = 'Synthetic UID fabricated by ensureSlotBatteryLinked; no real hardware serial. Withdrawn by cleanup script.',
               updated_at = NOW()
           WHERE id = $1`,
          [row.battery_id]
        );

        // If the ghost was the battery physically linked to a slot, unlink it.
        // Only reset the slot when it is idle (available) — never an occupied slot
        // that is the only holder of a REAL battery.
        if (row.slot_id != null) {
          await client.query(
            `UPDATE public.booth_slots
             SET current_battery_id = NULL,
                 charge_level_percent = NULL,
                 is_charging = FALSE,
                 updated_at = NOW()
             WHERE id = $1 AND current_battery_id = $2`,
            [row.slot_id, row.battery_id]
          );
        }

        console.log(`  [withdrew] #${row.battery_id} ${row.battery_uid}${row.slot_identifier ? ` (was linked to ${row.booth_uid ?? '?'}/${row.slot_identifier})` : ''}`);
        withdrawn++;
      }

      await client.query('COMMIT');
      console.log(`\nDone: ${withdrawn} withdrawn, ${skipped} skipped.\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('cleanup failed:', e.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}

main();