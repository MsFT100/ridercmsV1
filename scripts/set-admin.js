/* eslint-disable no-console */
/**
 * One-time script to grant admin privileges to a user.
 *
 * This script uses the Firebase Admin SDK to set a custom user claim, which is the
 * source of truth for authorization in the application.
 *
 * Usage:
 * 1. Make sure your service account credentials are set up in a .env file
 *    (GOOGLE_APPLICATION_CREDENTIALS).
 * 2. Find the UID of the user you want to make an admin from the Firebase Console.
 * 3. Run the script from your project root:
 *    node scripts/set-admin.js <USER_UID>
 *
 * Example:
 *    node scripts/set-admin.js JSz924CDHmZO3axhxHamwP4zvQr1
 */
require('dotenv').config();
const { admin, initializeFirebase } = require('../utils/firebase');

initializeFirebase(); // Initialize the Firebase Admin SDK

const uid = process.argv[2];

if (!uid) {
  console.error('Error: Please provide a User UID as an argument.');
  console.log('Usage: node scripts/set-admin.js <USER_UID>');
  process.exit(1);
}

admin.auth().setCustomUserClaims(uid, { role: 'admin' })
  .then(() => {
    console.log(`Success! User ${uid} has been granted the 'admin' role.`);
    console.log('They may need to log out and log back in for the change to take effect.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error setting custom claims:', error);
    process.exit(1);
  });