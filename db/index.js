const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

async function configurePool() {
  logger.info('Configuring database connection via DATABASE_URL.');

  const connectionString = process.env.DATABASE_URL;

  // Enable SSL for remote connections, especially for providers like Render.
  // This makes the connection work for both local dev against a remote DB and in production.
  const needsSsl = connectionString && connectionString.includes('render.com');

  return new Pool({
    connectionString: connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
}

// We must use an async function to initialize and export the pool
// because the Cloud SQL Connector's `getOptions` is async.
module.exports = (async () => {
  if (!process.env.DATABASE_URL) {
    logger.error('CRITICAL: DATABASE_URL environment variable is not set. Server cannot start.');
    process.exit(1);
  }
  pool = await configurePool();
  pool.on('connect', () => {
    logger.debug('New database client connected to the pool.');
  });
  pool.on('error', (err) => {
    logger.error('Unexpected error on idle database client', err);
  });
  return pool;
})();