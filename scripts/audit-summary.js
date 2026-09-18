/* eslint-disable no-console */
require('dotenv').config();
const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');

async function main() {
  let connector;
  let pool;
  try {
    connector = new Connector();
    const o = await connector.getOptions({ instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME, ipType: process.env.DB_IP_TYPE || 'PUBLIC' });
    pool = new Pool({ ...o, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 1, connectionTimeoutMillis: 30000 });
    const q = async (s, p) => (await pool.query(s, p)).rows;

    const base = `
      WITH consuming AS (
        SELECT consumed_deposit_id FROM public.deposits
        WHERE consumed_deposit_id IS NOT NULL AND session_type IN ('withdrawal','rental') AND status NOT IN ('cancelled','failed')
      )
      SELECT d.id AS deposit_id, d.user_id, d.slot_id, d.battery_id, d.completed_at
      FROM public.deposits d
      JOIN public.booth_slots s ON d.slot_id = s.id
      WHERE d.session_type='deposit' AND d.status='completed'
        AND s.current_battery_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM consuming c WHERE c.consumed_deposit_id = d.id)
        AND d.battery_id IS DISTINCT FROM s.current_battery_id`;

    const total = await q(`SELECT count(*)::int AS n FROM (${base}) t`);
    const bySlot = await q(`
      WITH consuming AS (
        SELECT consumed_deposit_id FROM public.deposits
        WHERE consumed_deposit_id IS NOT NULL AND session_type IN ('withdrawal','rental') AND status NOT IN ('cancelled','failed')
      )
      SELECT s.slot_identifier, count(*)::int AS n, max(d.completed_at) AS latest
      FROM public.deposits d
      JOIN public.booth_slots s ON d.slot_id = s.id
      WHERE d.session_type='deposit' AND d.status='completed'
        AND s.current_battery_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM consuming c WHERE c.consumed_deposit_id = d.id)
        AND d.battery_id IS DISTINCT FROM s.current_battery_id
      GROUP BY s.slot_identifier ORDER BY s.slot_identifier`);

    const aged = await q(`
      WITH consuming AS (
        SELECT consumed_deposit_id FROM public.deposits
        WHERE consumed_deposit_id IS NOT NULL AND session_type IN ('withdrawal','rental') AND status NOT IN ('cancelled','failed')
      )
      SELECT count(*) FILTER (WHERE d.completed_at < NOW() - INTERVAL '7 days')::int AS older_7d,
             count(*) FILTER (WHERE d.completed_at >= NOW() - INTERVAL '7 days')::int AS last_7d
      FROM public.deposits d
      JOIN public.booth_slots s ON d.slot_id = s.id
      WHERE d.session_type='deposit' AND d.status='completed'
        AND s.current_battery_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM consuming c WHERE c.consumed_deposit_id = d.id)
        AND d.battery_id IS DISTINCT FROM s.current_battery_id`);

    console.log(`total mismatched unconsumed credits: ${total[0].n}`);
    console.log(`\nper slot:`);
    for (const r of bySlot) console.log(`  ${r.slot_identifier}: ${r.n} (latest ${r.latest?.toISOString()})`);
    console.log(`\nby age: ${JSON.stringify(aged[0])}`);
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}
main();