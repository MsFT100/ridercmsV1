const pool = require('./index.js');
const logger = require('../utils/logger');

//postgres
const initializeDatabase = async () => {
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
        status VARCHAR(50) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'opening', 'maintenance', 'faulty', 'offline')),
        current_battery_id INT REFERENCES batteries(id) ON DELETE SET NULL,
        charge_level_percent INT CHECK (charge_level_percent BETWEEN 0 AND 100), -- Mirrored from Firebase for quick lookups
        door_status VARCHAR(20) DEFAULT 'closed' CHECK (door_status IN ('open', 'closed', 'locked')), -- Mirrored from Firebase
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
        mpesa_checkout_id VARCHAR(255) UNIQUE, -- For tracking payment status
        status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
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


const initializeDatabaseMysql = async () => {
  // MySQL doesn't use a client from the pool for transactions in the same way.
  // We get a connection and pass it around.
  const connection = await pool.getConnection();
  try {
    logger.info('Initializing MySQL database schema...');
    await connection.beginTransaction();

    await connection.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE,
        vehicle_registration VARCHAR(50),
        license_number VARCHAR(50),
        wallet_balance DECIMAL(12,2) DEFAULT 0.00,
        fcm_token TEXT,
        status VARCHAR(20) CHECK (status IN ('active', 'inactive', 'suspended')),
        rating DECIMAL(10,1) DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS riders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) UNIQUE,
        email VARCHAR(255) UNIQUE NOT NULL,
        fcm_token TEXT,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        driver_id INT UNIQUE NOT NULL,
        brand VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        vehicle_year INT NOT NULL,
        license_plate VARCHAR(20) UNIQUE NOT NULL,
        color VARCHAR(50),
        fuel_type VARCHAR(50),
        vehicle_type VARCHAR(50) NOT NULL,
        logbook_url TEXT,
        insurance_url TEXT,
        vehicle_front_photo_url TEXT,
        psv_license_url TEXT,
        good_conduct_url TEXT,
        selfie_url TEXT,
        inspection_report_url TEXT,
        psv_sticker_url TEXT,
        vehicle_rear_photo_url TEXT,
        vehicle_side_photo_url TEXT,
        vehicle_interior_photo_url TEXT,
        registration_paid_at TIMESTAMP NULL,
        registration_expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rider_id INT NOT NULL,
        driver_id INT NOT NULL,
        trip_id INT,
        payment_method_id INT,
        currency VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2),
        base_fare DECIMAL(10,2),
        surge_multiplier FLOAT,
        platform_fee DECIMAL(10,2),
        driver_payout DECIMAL(10,2),
        status VARCHAR(20) CHECK (status IN ('initiated', 'authorized', 'captured', 'failed', 'refunded')),
        gateway_transaction_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (rider_id) REFERENCES riders(id),
        FOREIGN KEY (driver_id) REFERENCES drivers(id)
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS mpesa_callbacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        callback_type VARCHAR(20),
        payload JSON NOT NULL,
        is_processed BOOLEAN DEFAULT false,
        processing_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        ` + "`key`" + ` VARCHAR(100) PRIMARY KEY,
        ` + "`value`" + ` JSON NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rider_id INT NOT NULL,
        driver_id INT,
        trip_type VARCHAR(20) NOT NULL CHECK (trip_type IN ('ride', 'parcel')),
        status VARCHAR(50) NOT NULL DEFAULT 'requested' CHECK (status IN (
          'requested', 'accepted', 'en_route_to_pickup', 'arrived_at_pickup', 
          'in_progress', 'completed', 'cancelled'
        )),
        pickup_address TEXT,
        dropoff_address TEXT,
        pickup_latitude DECIMAL(9, 6),
        pickup_longitude DECIMAL(9, 6),
        dropoff_latitude DECIMAL(9, 6),
        dropoff_longitude DECIMAL(9, 6),
        estimated_fare DECIMAL(10, 2),
        actual_fare DECIMAL(10, 2),
        distance_km FLOAT,
        duration_minutes INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (rider_id) REFERENCES riders(id),
        FOREIGN KEY (driver_id) REFERENCES drivers(id)
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        creator_id INT NOT NULL,
        creator_role VARCHAR(20) NOT NULL CHECK (creator_role IN ('driver', 'rider')),
        subject VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );`);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS mpesa_transactions (
        checkout_request_id VARCHAR(255) PRIMARY KEY,
        account_reference VARCHAR(255) NOT NULL,
        user_id INT NOT NULL,
        user_type VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`);

    // --- Populate default settings if they don't exist ---
    const defaultSettings = [
      {
        key: 'fare_rates',
        value: JSON.stringify({
          sedan: { base_fare: 100.00, per_km_rate: 40.00, per_minute_rate: 4.00, minimum_fare: 250.00 },
          motorbike: { base_fare: 50.00, per_km_rate: 25.00, per_minute_rate: 3.00, minimum_fare: 100.00 },
          van: { base_fare: 200.00, per_km_rate: 60.00, per_minute_rate: 5.00, minimum_fare: 400.00 }
        }),
        description: 'Fare structure for different vehicle types (base, per_km, per_minute, minimum).'
      },
      { key: 'vat_percentage', value: '16', description: 'The Value Added Tax percentage to apply.' },
      { key: 'free_ride_eligibility_threshold', value: '500', description: 'Rides costing less than this amount are eligible for free credit.' },
      { key: 'max_free_credit_per_user', value: '1000', description: 'Total lifetime free credit cap per user account in KES.' },
      { key: 'driver_dispatch_radius_km', value: '5', description: 'Maximum dispatch radius for ride requests in kilometers.' },
      { key: 'vehicle_registration_fee', value: '2500', description: 'One-time vehicle registration fee in KES.' }
    ];

    const insertSettingQuery = "INSERT INTO app_settings (`key`, `value`, `description`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `key`=`key`;";

    for (const setting of defaultSettings) {
      const valueToInsert = setting.key === 'fare_rates' ? setting.value : `"${setting.value}"`;
      await connection.query(insertSettingQuery, [setting.key, valueToInsert, setting.description]);
    }
    logger.info('Default application settings verified for MySQL.');

    await connection.commit();
    logger.info('MySQL database schema initialized successfully.');
  } catch (err) {
    await connection.rollback();
    logger.error('Error initializing MySQL database schema:', err);
    throw err;
  } finally {
    connection.release();
  }
};

module.exports = { initializeDatabase, initializeDatabaseMysql };