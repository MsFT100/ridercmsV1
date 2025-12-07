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
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  try {
    let serviceAccount;
    if (credentials) {
      if (credentials.trim().startsWith('{')) {
        // If the variable content looks like a JSON object, parse it directly.
        serviceAccount = JSON.parse(credentials);
      } else {
        // Otherwise, treat it as a file path.
        serviceAccount = require(path.resolve(credentials));
      }
    } else {
      // Fallback for local development if the environment variable is not set.
      const fallbackPath = path.resolve(__dirname, '../config/ridercms-ced94-firebase-adminsdk-fbsvc-3d27aedd19.json');
      serviceAccount = require(fallbackPath);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    isInitialized = true;
    logger.info('Firebase Admin SDK initialized successfully.');
  } catch (error) {
    logger.error('CRITICAL: Failed to initialize Firebase Admin SDK. Check service account path and file integrity.', { error: error.message });
    process.exit(1);
  }
}

module.exports = { initializeFirebase, admin };
