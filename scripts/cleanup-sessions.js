/* eslint-disable no-console */
require("dotenv").config();
const pool = require("../db");
async function main() {
  const args = process.argv.slice(2);
  let dryRun = false, mode = "cancelled";
  for (const a of args) {
    if (a === "--dry-run" || a === "-n") { dryRun = true; continue; }
    if (a.startsWith("--mode=")) { mode = a.split("=")[1]; }
  }
  const pg = await pool;
  const c = await pg.connect();
  try {
    let q = "";
    if (mode === "cancelled" || mode === "all-cancelled") {
      q = "SELECT id, status, session_type, created_at FROM deposits WHERE status='cancelled' ORDER BY created_at DESC";
    } else if (mode === "failed") {
      q = "SELECT id, status, session_type, created_at FROM deposits WHERE status='failed' ORDER BY created_at DESC";
    } else if (mode === "today") {
      q = "SELECT id, status, session_type, created_at FROM deposits WHERE created_at >= CURRENT_DATE ORDER BY created_at DESC";
    } else if (mode === "two-weeks" || mode === "14-days") {
      q = "SELECT id, status, session_type, created_at FROM deposits WHERE created_at >= NOW() - INTERVAL '14 days' ORDER BY created_at DESC";
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
    const { rows } = await c.query(q);
    console.log(`mode=${mode} dry=${dryRun} found=${rows.length}`);
    for (const r of rows.slice(0, 20)) {
      console.log(`${r.id} ${r.status} ${r.session_type}`);
    }
    if (rows.length > 20) console.log(`...${rows.length-20} more`);
    if (dryRun || rows.length === 0) return;
    const ids = rows.map(r => r.id);
    await c.query("BEGIN");
    await c.query("DELETE FROM deposits WHERE id = ANY($1::int[])", [ids]);
    await c.query("COMMIT");
    console.log(`Deleted ${ids.length}`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    c.release();
  }
}
main();
