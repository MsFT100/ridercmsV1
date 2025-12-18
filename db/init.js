const poolPromise = require('./index.js');
const logger = require('../utils/logger');

//postgres
const initializeDatabase = async () => {
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    logger.info('Initializing database schema...');

    // It's good practice to wrap table creation in transactions
    // and check for existence to prevent errors on subsequent runs.
    await client.query('BEGIN');


    const createUsersTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL, -- Firebase UID
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) UNIQUE,
        phone_verified BOOLEAN DEFAULT false,
        balance DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        profile_image_url TEXT, -- URL for the user's profile picture
        fcm_token TEXT, -- For sending push notifications
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
        role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`;

    const createMpesaCallbacksTableQuery = `
      CREATE TABLE IF NOT EXISTS mpesa_callbacks (
        id SERIAL PRIMARY KEY,
        callback_type VARCHAR(20),
        payload JSONB NOT NULL,
        is_processed BOOLEAN DEFAULT false,
        processing_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`;

    const createAppSettingsTableQuery = `
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`;

    const createBoothsTableQuery = `
      CREATE TABLE IF NOT EXISTS booths (
        id SERIAL PRIMARY KEY,
        booth_uid VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'booth-001'
        name VARCHAR(255),
        location_address TEXT,
        latitude DECIMAL(9, 6),
        longitude DECIMAL(9, 6),
        status VARCHAR(50) NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'maintenance')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;

    const createBatteriesTableQuery = `
      CREATE TABLE IF NOT EXISTS batteries (
        id SERIAL PRIMARY KEY,
        battery_uid VARCHAR(100) UNIQUE NOT NULL, -- A unique serial number for the battery
        user_id VARCHAR(255) REFERENCES users(user_id) ON DELETE SET NULL, -- Track the owner
        charge_level_percent INT DEFAULT 100 CHECK (charge_level_percent BETWEEN 0 AND 100),
        health_status VARCHAR(50) NOT NULL DEFAULT 'good' CHECK (health_status IN ('good', 'degraded', 'faulty')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(battery_uid)
      );
    `;

    const createBoothSlotsTableQuery = `
      CREATE TABLE IF NOT EXISTS booth_slots (
        id SERIAL PRIMARY KEY,
        booth_id INT NOT NULL REFERENCES booths(id) ON DELETE CASCADE,
        slot_identifier VARCHAR(50) NOT NULL, -- e.g., 'A01', 'B05'
        status VARCHAR(50) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'opening', 'maintenance', 'faulty', 'offline', 'disabled')),
        current_battery_id INT REFERENCES batteries(id) ON DELETE SET NULL,
        charge_level_percent INT CHECK (charge_level_percent BETWEEN 0 AND 100), -- Mirrored from Firebase for quick lookups
        door_status VARCHAR(20) DEFAULT 'closed' CHECK (door_status IN ('open', 'closed', 'locked')), -- Mirrored from Firebase
        is_charging BOOLEAN DEFAULT FALSE,
        telemetry JSONB, -- To store the full telemetry object from Firebase
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ, -- To track when the last telemetry was received
        UNIQUE(booth_id, slot_identifier) -- A slot identifier must be unique within its booth
      );
    `;

    const createDepositsTableQuery = `
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL, -- Firebase UID of the user
        booth_id INT NOT NULL REFERENCES booths(id),
        slot_id INT NOT NULL REFERENCES booth_slots(id),
        battery_id INT REFERENCES batteries(id) ON DELETE SET NULL,
        session_type VARCHAR(20) NOT NULL CHECK (session_type IN ('deposit', 'withdrawal')),
        initial_charge_level INT, -- Stored on deposit
        amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00, -- Amount charged for the session
        mpesa_checkout_id VARCHAR(255) UNIQUE, -- For tracking payment status
        status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'opening', 'in_progress', 'completed', 'failed', 'cancelled')),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        notes TEXT, -- For logging reasons for state changes (e.g., auto-cancellation)
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;

    const createProblemReportsTableQuery = `
      CREATE TABLE IF NOT EXISTS problem_reports (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        booth_id INT REFERENCES booths(id) ON DELETE SET NULL,
        slot_id INT REFERENCES booth_slots(id) ON DELETE SET NULL,
        battery_id INT REFERENCES batteries(id) ON DELETE SET NULL,
        report_type VARCHAR(50) NOT NULL CHECK (report_type IN ('battery_issue', 'slot_issue', 'general_feedback')),
        description TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'wont_fix')),
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        -- Ensure at least one of the reported items is not null
        CHECK (booth_id IS NOT NULL OR battery_id IS NOT NULL)
      );
    `;


    const applyTrigger = async (tableName) => {
      const triggerName = `trigger_update_${tableName}_updated_at`;
      const checkTrigger = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = $1)",
        [triggerName]
      );
      if (!checkTrigger.rows[0].exists) {
        await client.query(`
          CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON ${tableName}
          FOR EACH ROW
          EXECUTE PROCEDURE update_updated_at_column();
        `);
      }
    };


    await client.query(createUsersTableQuery);
    await client.query(createMpesaCallbacksTableQuery);
    await client.query(createAppSettingsTableQuery);
    await client.query(createBoothsTableQuery);
    await client.query(createBatteriesTableQuery);
    await client.query(createBoothSlotsTableQuery);
    await client.query(createDepositsTableQuery);
    await client.query(createProblemReportsTableQuery);

    // --- Schema Alterations for existing databases (Idempotent) ---
    // Add 'notes' column to 'deposits' table if it doesn't exist.
    const checkNotesColumnQuery = `
      SELECT 1 FROM information_schema.columns
      WHERE table_name='deposits' AND column_name='notes';
    `;
    const { rows } = await client.query(checkNotesColumnQuery);
    if (rows.length === 0) {
      await client.query('ALTER TABLE deposits ADD COLUMN notes TEXT;');
      logger.info("Added 'notes' column to 'deposits' table.");
    }
    

    const createUpdateTimestampFunction = `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `;

    
    await client.query(createUpdateTimestampFunction);
    await Promise.all([ 'users', 'mpesa_callbacks', 'app_settings', 'booths', 'batteries', 'booth_slots', 'deposits', 'problem_reports'].map(applyTrigger));

    // --- Populate default settings if they don't exist ---
    const defaultSettings = [
      {
        key: 'pricing',
        value: JSON.stringify({
          base_swap_fee: 5.00,
          cost_per_charge_percent: 10.00,
          overtime_penalty_per_minute: 0.10
        }),
        description: 'Pricing rules for battery swaps.'
      },
      {
        key: 'withdrawal_rules',
        value: JSON.stringify({
          min_charge_level: 95
        }),
        description: 'Rules governing when a user can withdraw a battery.'
      }
    ];

    const insertSettingQuery = `
      INSERT INTO app_settings (key, value, description)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (key) DO NOTHING;
    `;

    for (const setting of defaultSettings) {
      await client.query(insertSettingQuery, [setting.key, setting.value, setting.description]);
    }
    logger.info('Default application settings verified.');

    await client.query('COMMIT');
    logger.info('Database schema initialized successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Error initializing database schema:', err);
    // Re-throw the error to be caught by the caller in server.js
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { initializeDatabase };
module.exports = { initializeDatabase };