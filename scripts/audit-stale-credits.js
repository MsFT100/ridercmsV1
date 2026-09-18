/* eslint-disable no-console */
/**
 * Audit: find unconsumed 'completed' deposit credits whose battery no longer
 * matches the battery physically in their slot (the shared.js vulnerability).
 * Read-only.
 * Usage: node scripts/audit-stale-credits.js
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
    pool = new Pool({ ...o, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 1, connectionTimeoutMillis: 30000 });
    const q = async (s, p) => (await pool.query(s, p)).rows;

    const schema = 'public';
    const rows = await q(
      `WITH consuming AS (
         SELECT consumed_deposit_id
         FROM ${schema}.deposits
         WHERE consumed_deposit_id IS NOT NULL
           AND session_type IN ('withdrawal', 'rental')
           AND status NOT IN ('cancelled', 'failed')
       )
       SELECT d.id AS deposit_id, d.user_id, u.email, u.name,
              b.booth_uid, s.slot_identifier, s.status AS slot_status,
              s.current_battery_id,
              (SELECT battery_uid FROM ${schema}.batteries cb WHERE cb.id = s.current_battery_id) AS current_uid,
              d.battery_id AS credit_battery_id,
              (SELECT battery_uid FROM ${schema}.batteries cb2 WHERE cb2.id = d.battery_id) AS credit_uid,
              d.initial_charge_level, d.created_at, d.completed_at,
              CURRENT_TIMESTAMP - d.completed_at AS age
       FROM ${schema}.deposits d
       JOIN ${schema}.booth_slots s ON d.slot_id = s.id
       JOIN ${schema}.booths b ON s.booth_id = b.id
       LEFT JOIN ${schema}.users u ON u.user_id = d.user_id
       WHERE d.session_type = 'deposit'
         AND d.status = 'completed'
         AND s.current_battery_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM consuming c WHERE c.consumed_deposit_id = d.id)
         AND d.battery_id IS DISTINCT FROM s.current_battery_id
       ORDER BY d.completed_at DESC`
    );

    console.log(`\n=== Mismatched unconsumed credits (${rows.length}) ===\n`);
    for (const r of rows) {
      console.log(`${r.booth_uid}/${r.slot_identifier} [${r.slot_status}]`);
      console.log(`  credit #${r.deposit_id} ${r.email ?? r.user_id} battery ${r.credit_battery_id} (${r.credit_uid ?? 'NULL'}) soc=${r.initial_charge_level} completed=${r.completed_at?.toISOString()}`);
      console.log(`  slot  current battery ${r.current_battery_id} (${r.current_uid ?? 'NULL'})`);
      console.log('');
    }

    const summary = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE current_battery_id IS NULL) AS slots_empty,
              count(*) FILTER (WHERE current_battery_uid ILIKE 'bat-2-%') AS slots_synthetic
       FROM (
         SELECT s.id, s.current_battery_id,
                (SELECT battery_uid FROM ${schema}.batteries cb WHERE cb.id = s.current_battery_id) AS current_battery_uid
         FROM ${schema}.booth_slots s
       ) t`
    );
    console.log('--- slot summary ---');
    console.log(JSON.stringify(summary, (k, v) => v instanceof Date ? v.toISOString() : v));
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}
main();