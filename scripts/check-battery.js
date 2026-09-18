/* eslint-disable no-console */
/**
 * Read-only diagnostic: inspect battery + slot link + deposit ownership.
 * Connects via Cloud SQL Connector directly (bypasses pool.connect wrapper).
 * Usage: node scripts/check-battery.js [batteryUidOrId] [slotIdentifier]
 */
require('dotenv').config();
const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');

const batteryArg = process.argv[2] || 'bat-2-1789739562699';
const slotSpec = process.argv[3] || null;

async function main() {
  let pool;
  let connector;
  try {
    connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
      ipType: process.env.DB_IP_TYPE || 'PUBLIC',
    });
    pool = new Pool({
      ...clientOpts,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 3,
      connectionTimeoutMillis: 20000,
    });

    const isNumeric = /^\d+$/.test(batteryArg);
    const uidClause = isNumeric
      ? 'b.id = $1'
      : 'b.battery_uid = $1';
    const params = [isNumeric ? Number(batteryArg) : batteryArg];

    for (const schema of ['public', 'dev']) {
      try {
        const { rows } = await pool.query(
          `SELECT b.id, b.battery_uid, b.charge_level_percent, b.health_status,
                  b.withdrawn_at, b.withdrawal_reason, b.created_at, b.updated_at,
                  sb.booth_uid, s.slot_identifier, s.status AS slot_status,
                  s.charge_level_percent AS slot_soc
           FROM ${schema}.batteries b
           LEFT JOIN ${schema}.booth_slots s ON s.current_battery_id = b.id
           LEFT JOIN ${schema}.booths sb ON sb.id = s.booth_id
           WHERE ${uidClause}
           ORDER BY b.id`,
          params
        );
        if (rows.length === 0) {
          console.log(`\n[${schema}] no battery match for ${batteryArg}`);
          continue;
        }
        for (const b of rows) {
          console.log(`\n=== [${schema}] battery id=${b.id} uid=${b.battery_uid}`);
          console.log(`  soc=${b.charge_level_percent}  health=${b.health_status}`);
          console.log(`  withdrawn_at=${b.withdrawn_at ?? 'NULL (in rental pool)'}  reason=${b.withdrawal_reason ?? '-'}`);
          console.log(`  created=${b.created_at?.toISOString()}  updated=${b.updated_at?.toISOString()}`);
          console.log(`  slot=${b.booth_uid ?? 'NONE'} / ${b.slot_identifier ?? 'NONE'}  slot_status=${b.slot_status ?? 'NONE'}  slot_soc=${b.slot_soc ?? '-'}`);

          const dep = await pool.query(
            `SELECT id, session_type, status, slot_id, battery_id, consumed_deposit_id,
                    created_at, updated_at
             FROM ${schema}.deposits
             WHERE battery_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [b.id]
          );
          console.log(`  deposits referencing this battery (${dep.rows.length}):`);
          for (const d of dep.rows) {
            console.log(`    #${d.id} ${d.session_type} status=${d.status} slot_id=${d.slot_id} consumed=${d.consumed_deposit_id ?? '-'} created=${d.created_at?.toISOString()}`);
          }

          const slots = await pool.query(
            `SELECT s.id AS slot_id, s.slot_identifier, s.status, s.current_battery_id,
                    s.charge_level_percent, s.is_charging
             FROM ${schema}.booth_slots s
             JOIN ${schema}.booths sb ON sb.id = s.booth_id
             WHERE sb.booth_uid = $1 AND s.slot_identifier = $2`,
            [b.booth_uid, b.slot_identifier]
          );
          for (const s of slots.rows) {
            console.log(`  slot row: id=${s.slot_id} identifier=${s.slot_identifier} status=${s.status} current_battery_id=${s.current_battery_id} soc=${s.charge_level_percent} charging=${s.is_charging}`);
          }
        }
      } catch (err) {
        if (String(err.message).includes('does not exist')) {
          console.log(`\n[${schema}] schema not present, skipping`);
        } else {
          console.log(`\n[${schema}] ERROR: ${err.message}`);
        }
      }
    }

    if (slotSpec) {
      for (const schema of ['public', 'dev']) {
        try {
          const s = await pool.query(
            `SELECT sb.booth_uid, s.id AS slot_id, s.slot_identifier, s.status,
                    s.current_battery_id, s.charge_level_percent,
                    b.battery_uid AS linked_uid, b.withdrawn_at
             FROM ${schema}.booth_slots s
             JOIN ${schema}.booths sb ON sb.id = s.booth_id
             LEFT JOIN ${schema}.batteries b ON b.id = s.current_battery_id
             WHERE s.slot_identifier = $1
             ORDER BY sb.booth_uid`,
            [slotSpec]
          );
          if (s.rows.length === 0) continue;
          console.log(`\n=== [${schema}] ALL slots named "${slotSpec}" ===`);
          for (const r of s.rows) {
            console.log(`  ${schema}.${r.booth_uid}/${r.slot_identifier}  id=${r.slot_id}  status=${r.status}  battery_id=${r.current_battery_id}  uid=${r.linked_uid ?? '-'}  withdrawn=${r.withdrawn_at ?? '-'}`);
          }
        } catch (err) {
          if (String(err.message).includes('does not exist')) {
            console.log(`\n[${schema}] schema not present, skipping`);
          } else {
            console.log(`\n[${schema}] slot lookup ERROR: ${err.message}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('Check script failed:', error);
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}

main();