/* eslint-disable no-console */
/**
 * One-time script to grant admin privileges to a user.
 *
 * This script updates BOTH:
 * 1) Firebase custom claims (`role: admin`) used by admin route authorization.
 * 2) PostgreSQL `users.role` used by profile/session responses.
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
const poolPromise = require('../db');

initializeFirebase(); // Initialize the Firebase Admin SDK

const uid = process.argv[2];

if (!uid) {
  console.error('Error: Please provide a User UID as an argument.');
  console.log('Usage: node scripts/set-admin.js <USER_UID>');
  process.exit(1);
}

async function run() {
  const targetRole = 'admin';
  let pool;
  let firebaseUpdated = false;

  try {
    // 1) Update Firebase custom claims (used by admin middleware).
    await admin.auth().setCustomUserClaims(uid, { role: targetRole });
    firebaseUpdated = true;

    // Read back claims to confirm.
    const updatedUser = await admin.auth().getUser(uid);
    const firebaseRole = updatedUser.customClaims?.role || null;
    console.log(`[Firebase] Updated user ${uid} custom role to: ${firebaseRole}`);

    // 2) Update PostgreSQL role (used by /api/auth/profile response).
    pool = await poolPromise;
    const updateRes = await pool.query(
      `UPDATE users
       SET role = $1, updated_at = NOW()
       WHERE user_id = $2
       RETURNING user_id, role, status`,
      [targetRole, uid]
    );

    if (updateRes.rowCount === 0) {
      console.warn(`[PostgreSQL] No row found in users table for uid=${uid}. Firebase role is admin, DB row was not updated.`);
    } else {
      const row = updateRes.rows[0];
      console.log(`[PostgreSQL] Updated users row: uid=${row.user_id}, role=${row.role}, status=${row.status}`);
    }

    console.log(`Success! User ${uid} has been granted the '${targetRole}' role.`);
    console.log('If the user is logged in, force token refresh or log out/log in to get new Firebase claims.');
  } catch (error) {
    if (firebaseUpdated) {
      console.error('[Partial Success] Firebase role was updated, but database update failed.');
    }
    console.error('Error setting admin role:', error);
    process.exitCode = 1;
  } finally {
    // Ensure script exits cleanly when a DB pool was created.
    if (pool) {
      if (pool.connector) {
        pool.connector.close();
      }
      await pool.end().catch(() => {});
    }
  }
}

run();
