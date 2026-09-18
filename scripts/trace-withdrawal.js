/* eslint-disable no-console */
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
    const show = (l, r) => { console.log(`--- ${l} ---`); for (const x of r) console.log(JSON.stringify(x, (k, v) => v instanceof Date ? v.toISOString() : v)); };

    const G = '5r25LNK1MkXbZ2R88pBYD7UePDl2'; // geokagwe
    const O = 'YRsWs4g4XMeZplYEzG6AK7kghZ23'; // ousraymond

    show('deposit #16250 (consumed by geokagwe withdrawal 19692)', await q(
      `SELECT d.id, d.user_id, u.email, d.session_type, d.status, d.battery_id,
              d.slot_id, d.amount, d.created_at, d.completed_at
       FROM public.deposits d LEFT JOIN public.users u ON u.user_id = d.user_id
       WHERE d.id = 16250`));

    show('who is slot 1709217', await q(
      `SELECT s.id, s.slot_identifier, s.status, s.current_battery_id, s.charge_level_percent, s.is_charging,
              b.booth_uid, b.name
       FROM public.booth_slots s JOIN public.booths b ON s.booth_id = b.id
       WHERE s.id = 1709217`));

    show('batteries 3891 (ousraymond) + current slot battery', await q(
      `SELECT id, battery_uid, charge_level_percent, health_status, withdrawn_at, created_at
       FROM public.batteries
       WHERE id IN (3891, 3978, (SELECT current_battery_id FROM public.booth_slots WHERE id = 1709217))`));

    show('is battery 3891 still linked to any slot / any active deposits on ousraymond deposit 19650', await q(
      `SELECT s.id AS slot_id, s.slot_identifier, s.status AS slot_status, s.current_battery_id,
              (SELECT status FROM public.deposits WHERE id = 19650) AS deposit_19650_status
       FROM public.booth_slots s
       WHERE s.current_battery_id = 3891`));

    show('geokagwe deposits history (credit chain)', await q(
      `SELECT d.id, d.session_type, d.status, d.battery_id, d.slot_id, d.amount,
              d.consumed_deposit_id, d.created_at, d.completed_at
       FROM public.deposits d WHERE d.user_id = $1
       ORDER BY d.created_at DESC LIMIT 15`, [G]));

    show('ousraymond deposits history', await q(
      `SELECT d.id, d.session_type, d.status, d.battery_id, d.slot_id, d.amount,
              d.consumed_deposit_id, d.created_at, d.completed_at
       FROM public.deposits d WHERE d.user_id = $1
       ORDER BY d.created_at DESC LIMIT 10`, [O]));

    show('battery 3891 deposit chain (whoever used it)', await q(
      `SELECT d.id, d.user_id, u.email, d.session_type, d.status, d.slot_id, d.created_at, d.completed_at,
              d.consumed_deposit_id
       FROM public.deposits d LEFT JOIN public.users u ON u.user_id = d.user_id
       WHERE d.battery_id = 3891 ORDER BY d.created_at`));
  } catch (e) {
    console.error('failed:', e.message);
  } finally {
    if (pool) await pool.end();
    if (connector) connector.close();
  }
}
main();