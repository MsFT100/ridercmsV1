const { Pool } = require('pg');
const { Connector } = require('@google-cloud/cloud-sql-connector');
const logger = require('../utils/logger');

let pool;

const isProduction = process.env.NODE_ENV === 'production';
const dbInstance = process.env.DB_INSTANCE_CONNECTION_NAME;

async function configurePool() {
  if (isProduction && dbInstance) {
    // --- Production: Use Cloud SQL Connector ---
    logger.info(`Production environment detected. Configuring Cloud SQL Connector for instance: ${dbInstance}`);
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: dbInstance,
      ipType: 'PUBLIC', // Or 'PRIVATE' if using VPC
    });
    return new Pool({
      ...clientOpts,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 10, // Max number of connections
    });
  }
  // --- Development or Fallback: Use standard TCP connection ---
  if (isProduction && !dbInstance) {
    logger.warn('NODE_ENV is production, but DB_INSTANCE_CONNECTION_NAME is not set. Falling back to DATABASE_URL.');
  } else {
    logger.info('Development environment detected. Connecting to database via DATABASE_URL.');
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // SSL is recommended for all environments, but can be disabled for local dev if needed.
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

// We must use an async function to initialize and export the pool
// because the Cloud SQL Connector's `getOptions` is async.
module.exports = (async () => {
  pool = await configurePool();
  pool.on('connect', () => {
    logger.debug('New database client connected to the pool.');
  });
  pool.on('error', (err) => {
    logger.error('Unexpected error on idle database client', err);
  });
  return pool;
})();