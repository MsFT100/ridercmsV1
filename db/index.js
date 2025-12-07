const { Pool } = require('pg');
require('dotenv').config();

// The pg library automatically uses the DATABASE_URL environment variable if it exists.
// For production on Render, this is all we need.
// For local development, we can construct the config from individual .env variables.
const isProduction = process.env.NODE_ENV === 'production';

const connectionConfig = isProduction
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false, // Required for Render connections
      },
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
    };

const pool = new Pool(connectionConfig);

module.exports = pool;