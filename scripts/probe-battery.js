/* eslint-disable no-console */
require('dotenv').config();
const poolPromise = require('../db');

async function main() {
  const pool = await poolPromise;
  try {
    console.log('--- probing public.batteries id=3959 ---');
    const r = await pool.query(
      `SELECT b.id, b.battery_uid, b.charge_level_percent, b.health_status,
              b.withdrawn_at, b.withdrawal_reason, b.created_at, b.updated_at
       FROM public.batteries b
       WHERE b.id = 3959 OR b.battery_uid = 'bat-2-1789739562699'`
    );
    console.log(r.rows.length ? JSON.stringify(r.rows, null, 2) : 'no rows');
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await pool.end();
  }
}
main();