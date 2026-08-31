/* eslint-disable no-console */
require('dotenv').config();
const { admin, initializeFirebase } = require('../utils/firebase');
const poolPromise = require('../db');

initializeFirebase();

const DEV_EMAIL = 'dev@ridercms.test';
const DEV_PASSWORD = 'Maxtek2020';
const DEV_NAME = 'Frontend Developer';
const DEV_PHONE = '+254700000001';

async function seed() {
  let pool;
  let firebaseUid;

  try {
    // 1. Create or find the developer in Firebase Auth
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(DEV_EMAIL);
      console.log(`[Firebase] Developer user already exists: ${userRecord.uid}`);
    } catch {
      userRecord = await admin.auth().createUser({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        displayName: DEV_NAME,
        phoneNumber: DEV_PHONE,
        disabled: false,
      });
      console.log(`[Firebase] Created developer user: ${userRecord.uid}`);
    }

    firebaseUid = userRecord.uid;

    // Ensure the account is enabled and has developer role
    await admin.auth().updateUser(firebaseUid, { disabled: false });
    await admin.auth().setCustomUserClaims(firebaseUid, { role: 'developer' });
    console.log(`[Firebase] Set custom claims: { role: 'developer' }`);

    // 2. Connect to PostgreSQL and seed dev schema
    // NOTE: Dev schema tables must already exist (run server at least once to create them via db/init.js).
    pool = await poolPromise;
    const client = await pool.connect();
    try {
      await client.query('SET search_path TO dev');

      // --- Users ---
      await client.query(
        `INSERT INTO users (user_id, name, phone, phone_verified, balance, email, role, status)
         VALUES ($1, $2, $3, true, 100.00, $4, 'developer', 'active')
         ON CONFLICT (user_id) DO UPDATE SET
           name = EXCLUDED.name,
           role = 'developer',
           status = 'active',
           updated_at = NOW()`,
        [firebaseUid, DEV_NAME, DEV_PHONE, DEV_EMAIL]
      );
      console.log('[DB] Seeded developer user in dev.users');

      // --- Booths ---
      await client.query(
        `INSERT INTO booths (booth_uid, name, location_address, latitude, longitude, status)
         VALUES
           ('dev-booth-alpha', 'Dev Booth Alpha', 'Developer Street, Test Zone', -1.2921, 36.8219, 'online'),
           ('dev-booth-beta', 'Dev Booth Beta', 'Sandbox Avenue, Lab 2', -1.2922, 36.8220, 'online')
         ON CONFLICT (booth_uid) DO UPDATE SET status = 'online'`
      );
      console.log('[DB] Seeded 2 virtual booths');

      // Fetch booth IDs
      const boothRows = await client.query('SELECT id, booth_uid FROM booths');
      const boothMap = {};
      for (const row of boothRows.rows) {
        boothMap[row.booth_uid] = row.id;
      }

      // --- Slots ---
      const slotData = [
        { booth: 'dev-booth-alpha', slots: ['A1', 'A2', 'A3', 'A4'] },
        { booth: 'dev-booth-beta', slots: ['B1', 'B2', 'B3', 'B4'] },
      ];

      for (const booth of slotData) {
        const boothId = boothMap[booth.booth];
        for (const slotId of booth.slots) {
          await client.query(
            `INSERT INTO booth_slots (booth_id, slot_identifier, status, door_status)
             VALUES ($1, $2, 'available', 'closed')
             ON CONFLICT (booth_id, slot_identifier) DO NOTHING`,
            [boothId, slotId]
          );
        }
      }
      console.log('[DB] Seeded 8 virtual slots');

      // --- Batteries ---
      const batteries = [
        { uid: 'DEV-BAT-001', charge: 85, health: 'good' },
        { uid: 'DEV-BAT-002', charge: 62, health: 'good' },
        { uid: 'DEV-BAT-003', charge: 100, health: 'good' },
        { uid: 'DEV-BAT-004', charge: 34, health: 'degraded' },
        { uid: 'DEV-BAT-005', charge: 97, health: 'good' },
        { uid: 'DEV-RENT-001', charge: 100, health: 'good' },
        { uid: 'DEV-RENT-002', charge: 98, health: 'good' },
      ];

      for (const bat of batteries) {
        await client.query(
          `INSERT INTO batteries (battery_uid, charge_level_percent, health_status)
           VALUES ($1, $2, $3)
           ON CONFLICT (battery_uid) DO UPDATE SET
             charge_level_percent = $2,
             health_status = $3`,
          [bat.uid, bat.charge, bat.health]
        );
      }
      console.log('[DB] Seeded 7 virtual batteries');

      // --- Rental pool: stock unowned batteries into occupied slots ---
      // These slots are 'occupied' with a battery but have NO deposit owner,
      // so the rental service treats them as borrowable pool stock.
      const poolStocks = [
        { booth: 'dev-booth-alpha', slot: 'A1', batteryUid: 'DEV-RENT-001' },
        { booth: 'dev-booth-beta', slot: 'B1', batteryUid: 'DEV-RENT-002' },
      ];

      for (const stock of poolStocks) {
        const boothId = boothMap[stock.booth];
        const batteryRes = await client.query(
          'SELECT id, charge_level_percent FROM batteries WHERE battery_uid = $1',
          [stock.batteryUid]
        );
        if (boothId && batteryRes.rowCount > 0) {
          const battery = batteryRes.rows[0];
          await client.query(
            `UPDATE booth_slots
             SET status = 'occupied', current_battery_id = $1, charge_level_percent = $2,
                 is_charging = true, door_status = 'closed', telemetry = NULL
             WHERE booth_id = $3 AND slot_identifier = $4`,
            [battery.id, battery.charge_level_percent, boothId, stock.slot]
          );
        }
      }
      console.log('[DB] Seeded 2 rental-pool batteries in occupied slots');

      // --- App Settings (dev-specific) ---
      const devSettings = [
        {
          key: 'pricing',
          value: JSON.stringify({
            base_swap_fee: 0.00,
            cost_per_charge_percent: 0.00,
            overtime_penalty_per_minute: 0.00,
            rental_time_fee_per_minute: 0.00,
            rental_energy_rate_per_percent: 0.00,
          }),
          description: 'Dev pricing — all fees waived',
        },
        {
          key: 'withdrawal_rules',
          value: JSON.stringify({ min_charge_level: 0 }),
          description: 'Dev rules — no minimum charge required',
        },
      ];

      for (const setting of devSettings) {
        await client.query(
          `INSERT INTO app_settings (key, value, description)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, description = $3`,
          [setting.key, setting.value, setting.description]
        );
      }
      console.log('[DB] Seeded dev app settings (zero fees)');

      console.log('\n--- Seed Complete ---');
      console.log(`Email:    ${DEV_EMAIL}`);
      console.log(`Password: ${DEV_PASSWORD}`);
      console.log(`Role:     developer`);
      console.log(`Schema:   dev (isolated from public)`);
      console.log('Frontend developer can log in and test the full flow without paying or touching real data.');
    } finally {
      await client.query('SET search_path TO public');
      client.release();
    }
  } catch (error) {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  } finally {
    if (pool) {
      if (pool.connector) pool.connector.close();
      await pool.end().catch(() => {});
    }
    process.exit(0);
  }
}

seed();
