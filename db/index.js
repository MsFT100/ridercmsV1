const { Pool } = require('pg');
const { Connector } = require('@google-cloud/cloud-sql-connector');
const logger = require('../utils/logger');

let pool;
const connector = new Connector();

function parseBoolean(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function getInstanceConnectionName() {
  const instanceFromLegacy = process.env.INSTANCE_CONNECTION_NAME;
  const instanceFromDb = process.env.DB_INSTANCE_CONNECTION_NAME;

  if (instanceFromLegacy && instanceFromDb && instanceFromLegacy !== instanceFromDb) {
    logger.warn(
      `Both INSTANCE_CONNECTION_NAME and DB_INSTANCE_CONNECTION_NAME are set with different values. `
      + `Using INSTANCE_CONNECTION_NAME="${instanceFromLegacy}".`
    );
  }

  return instanceFromLegacy || instanceFromDb;
}

function getConnectionMode() {
  return (process.env.DB_CONNECTION_MODE || 'auto').toLowerCase();
}

function validateInstanceConnectionName(instanceConnectionName) {
  const parts = String(instanceConnectionName).split(':');
  if (parts.length !== 3 || parts.some((part) => !part.trim())) {
    throw new Error(
      `Invalid DB instance connection name "${instanceConnectionName}". `
      + 'Expected format: "project-id:region:instance-name".'
    );
  }
}

function createPoolFromDatabaseUrl(connectionString) {
  const sslFromEnv = parseBoolean(process.env.DB_SSL);
  const needsSslByDefault = Boolean(connectionString)
    && (connectionString.includes('render.com') || connectionString.includes('google'));
  const enableSsl = sslFromEnv === null ? needsSslByDefault : sslFromEnv;

  logger.info('Configuring database connection via DATABASE_URL.');
  return new Pool({
    connectionString,
    ssl: enableSsl ? { rejectUnauthorized: false } : false,
  });
}

function isCloudSqlAuthError(err) {
  const message = String(err && err.message ? err.message : err);
  return (
    message.includes('NOT_AUTHORIZED')
    || message.includes('cloudsql.instances.get')
    || message.includes('cloudsql.instances.connect')
  );
}

function wrapCloudSqlError(err, instanceConnectionName) {
  if (!isCloudSqlAuthError(err)) return err;

  const enhanced = new Error(
    `Cloud SQL connector auth failed for "${instanceConnectionName}". `
    + 'Grant the runtime identity roles/cloudsql.client, verify the instance name, '
    + 'or use DB_CONNECTION_MODE=database_url with DATABASE_URL for direct Postgres access.'
  );
  enhanced.cause = err;
  return enhanced;
}

async function createPoolFromCloudSql(instanceConnectionName) {
  validateInstanceConnectionName(instanceConnectionName);
  logger.info(`Configuring database connection via Google Cloud SQL Connector for "${instanceConnectionName}".`);

  const clientOpts = await connector.getOptions({
    instanceConnectionName,
    ipType: process.env.DB_IP_TYPE || 'PUBLIC',
  });

  const cloudSqlPool = new Pool({
    ...clientOpts,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // --- POOL SETTINGS ---
    max: Number(process.env.DB_POOL_MAX || 5), // Keep this low for Cloud Run
    idleTimeoutMillis: 30000,                  // Close idle clients after 30 seconds
    connectionTimeoutMillis: 5000,             // Fail fast if the DB is unreachable
    keepAlive: true,                           // Send TCP keep-alive packets
    // -------------------
  });

  // Used by server shutdown hook when present.
  cloudSqlPool.connector = connector;
  return cloudSqlPool;
}

async function configurePool() {
  const mode = getConnectionMode();
  const connectionString = process.env.DATABASE_URL;
  const instanceConnectionName = getInstanceConnectionName();

  if (!['auto', 'database_url', 'cloudsql_connector'].includes(mode)) {
    throw new Error(
      `Invalid DB_CONNECTION_MODE "${process.env.DB_CONNECTION_MODE}". `
      + 'Use one of: auto, database_url, cloudsql_connector.'
    );
  }

  if (mode === 'database_url') {
    if (!connectionString) {
      throw new Error('DB_CONNECTION_MODE=database_url requires DATABASE_URL.');
    }
    return createPoolFromDatabaseUrl(connectionString);
  }

  if (mode === 'cloudsql_connector') {
    if (!instanceConnectionName) {
      throw new Error(
        'DB_CONNECTION_MODE=cloudsql_connector requires DB_INSTANCE_CONNECTION_NAME (or INSTANCE_CONNECTION_NAME).'
      );
    }
    try {
      return await createPoolFromCloudSql(instanceConnectionName);
    } catch (err) {
      throw wrapCloudSqlError(err, instanceConnectionName);
    }
  }

  // Auto mode:
  // 1) Prefer DATABASE_URL when present (Render/direct Postgres)
  // 2) Otherwise try Cloud SQL connector
  if (connectionString) {
    return createPoolFromDatabaseUrl(connectionString);
  }

  if (instanceConnectionName) {
    try {
      return await createPoolFromCloudSql(instanceConnectionName);
    } catch (err) {
      throw wrapCloudSqlError(err, instanceConnectionName);
    }
  }

  throw new Error(
    'No DB config found. Set DATABASE_URL, or DB_INSTANCE_CONNECTION_NAME/INSTANCE_CONNECTION_NAME.'
  );
}
// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing HTTP server and DB pool');
  if (pool) {
    await pool.end();
    logger.info('Database pool closed');
  }
  if (connector) {
    connector.close();
    logger.info('Cloud SQL Connector closed');
  }
  process.exit(0);
});

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
