/**
 * One-off repair: re-links batteries for occupied slots whose
 * current_battery_id was lost to a telemetry flicker, causing
 * "Rented By: None" in the admin UI despite a valid completed deposit.
 *
 * Safe to re-run: ensureSlotBatteryLinked is a no-op when already linked.
 *
 * Usage: node scripts/relink-slot-batteries.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const poolPromise = require('../db');
const { ensureSlotBatteryLinked } = require('../utils/depositReconcile');

/**
 * Re-links batteries for all occupied slots that lost their link.
 * @returns {Promise<void>}
 */
async function relink() {
  const pool = await poolPromise;
  const client = await pool.connect();
  let totalRelinked = 0;

  try {
    const query = `
      SELECT
        b.booth_uid,
        s.id AS slot_id,
        s.slot_identifier,
        s.charge_level_percent,
        s.telemetry,
        s.current_battery_id,
        -- Only when a completed deposit actually exists (worth repairing)
        EXISTS (
          SELECT 1 FROM deposits d
          WHERE d.slot_id = s.id
            AND d.session_type = 'deposit'
            AND d.status = 'completed'
        ) AS has_completed_deposit
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE s.status = 'occupied'
        AND s.current_battery_id IS NULL
        AND (
          s.telemetry ->> 'batteryInserted' = 'true'
          OR (s.telemetry ->> 'batteryInserted' IS NULL AND s.charge_level_percent IS NOT NULL)
        )
      ORDER BY b.booth_uid, s.slot_identifier;
    `;

    const { rows } = await client.query(query);

    if (rows.length === 0) {
      console.log('All occupied slots already have a linked battery. Nothing to repair.');
      return;
    }

    console.log(`Found ${rows.length} occupied slot(s) with no linked battery:\n`);

    for (const row of rows) {
      console.log(`  ${row.booth_uid}/${row.slot_identifier}  soc=${row.charge_level_percent ?? '?'}  has_deposit=${row.has_completed_deposit}`);
    }

    console.log(`\n--- Relinking ---\n`);

    for (const row of rows) {
      if (!row.has_completed_deposit) {
        console.log(`  ${row.booth_uid}/${row.slot_identifier}: SKIPPED (no completed deposit)`);
        continue;
      }

      await client.query('BEGIN');
      try {
        const soc = row.charge_level_percent ?? null;
        const result = await ensureSlotBatteryLinked(client, row.slot_id, row.slot_identifier, soc);
        await client.query('COMMIT');

        if (result.relinked) {
          console.log(`  ${row.booth_uid}/${row.slot_identifier}: RELINKED -> ${result.batteryUid} (id=${result.batteryId})`);
          totalRelinked++;
        } else {
          console.log(`  ${row.booth_uid}/${row.slot_identifier}: ${result.reason.toUpperCase()}`);
        }
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ${row.booth_uid}/${row.slot_identifier}: ERROR - ${err.message}`);
      }
    }

    console.log(`\n--- Summary ---`);
    console.log(`  Processed: ${rows.length}`);
    console.log(`  Relinked:  ${totalRelinked}`);

  } catch (error) {
    console.error('Re-link script failed:', error);
  } finally {
    client.release();
  }
}

relink()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });