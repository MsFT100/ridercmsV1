const admin = require('firebase-admin');
const path = require('path');
const logger = require('./logger');

let isInitialized = false;

function initializeFirebase() {
  if (isInitialized) {
    return;
  }

  // IMPORTANT: Ensure your service account key JSON file is correctly referenced.
  // Using an environment variable is the most secure and flexible method.
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;
  const isProduction = process.env.NODE_ENV === 'production';

  try {
    if (!databaseURL) {
      logger.error('CRITICAL: FIREBASE_DATABASE_URL is not set in environment variables. This is required for Realtime Database functionality.');
      process.exit(1);
    }

    if (credentialsPath) {
      // Method 1: Use explicit credentials file (for local dev or non-GCP environments).
      logger.info(`Initializing Firebase with credentials from path: ${credentialsPath}`);
      const serviceAccount = require(path.resolve(credentialsPath));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: databaseURL,
      });
    } else if (isProduction) {
      // Method 2: Use Application Default Credentials (for Cloud Run, App Engine, etc.).
      logger.info('GOOGLE_APPLICATION_CREDENTIALS not set. Initializing Firebase using Application Default Credentials.');
      // The databaseURL still needs to be provided even with default credentials.
      admin.initializeApp({ databaseURL: databaseURL });
    } else {
      // Error: Not in production and no credentials file provided.
      logger.error('CRITICAL: GOOGLE_APPLICATION_CREDENTIALS is not set. This is required for local development.');
      process.exit(1);
    }

    isInitialized = true;
    logger.info('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    logger.error('CRITICAL: Failed to initialize Firebase Admin SDK. Check service account permissions or file integrity.', { error: error.message });
    process.exit(1);
  }
}


module.exports = { initializeFirebase, admin };
