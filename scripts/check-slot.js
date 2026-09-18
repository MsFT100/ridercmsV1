/* eslint-disable no-console */
require('dotenv').config();
const { Connector } = require('@google-cloud/cloud-sql-connector');
const { Pool } = require('pg');

const slot = process.argv[2] || 'slot011';

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
    const q = async (s, p) => (await pool.query(s, p)).rows;
    const show = (l, r) => { console.log(`--- ${l} ---`); for (const x of r) console.log(JSON.stringify(x, (k, v) => v instanceof Date ? v.toISOString() : v)); };

    const rows = await q(
      `SELECT d.id, d.user_id, u.email, d.session_type, d.status,
              d.mpesa_checkout_id, d.consumed_deposit_id, d.battery_id,
              d.amount, d.slot_id, d.created_at, d.started_at, d.completed_at
       FROM public.deposits d
       LEFT JOIN public.users u ON u.user_id = d.user_id
       WHERE d.slot_id = (SELECT s.id FROM public.booth_slots s
                          JOIN public.booths b ON s.booth_id = b.id
                          WHERE s.slot_identifier = $1)
       ORDER BY d.created_at DESC
       LIMIT 40`, [slot]);
    show(`all sessions for ${slot}`, rows);

    const users = await q(`SELECT user_id, name, email, phone, balance FROM public.users WHERE user_id = ANY($1::text[])`, [
      [...new Set(rows.map((r) => r.user_id).filter(Boolean))]
    ]);
    show('users involved', users);
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}
main();