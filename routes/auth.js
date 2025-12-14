const { Router } = require('express');
const { admin } = require('../utils/firebase'); // Use the initialized admin instance
const logger = require('../utils/logger');
const poolPromise = require('../db'); // Import the PostgreSQL connection pool
const { verifyFirebaseToken } = require('../middleware/auth'); // We will create this new middleware
const uploadToGcsMiddleware = require('../middleware/upload');
const axios = require('axios'); // For making HTTP requests to Google's reCAPTCHA service
const router = Router();

/**
 * Verifies a Google reCAPTCHA v3 token.
 * @param {string} token The reCAPTCHA token from the client.
 * @returns {Promise<boolean>} True if the token is valid and the score is above the threshold.
 */
async function verifyRecaptcha(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    logger.error('RECAPTCHA_SECRET_KEY is not set in environment variables. Skipping verification.');
    // In a production environment, you should fail hard here.
    // For development, we can allow it to pass.
    return process.env.NODE_ENV !== 'production';
  }

  const verificationUrl = 'https://www.google.com/recaptcha/api/siteverify';

  try {
    const response = await axios.post(verificationUrl, new URLSearchParams({
      secret: secret,
      response: token,
    }));

    const { success, score } = response.data;
    return success && score >= 0.5;
  } catch (error) {
    logger.error('Error verifying reCAPTCHA token:', error);
    return false;
  }
}

// --- 1. User Registration Endpoint ---
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - name
 *               - recaptchaToken
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address.
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User's password (min 6 characters).
 *               name:
 *                 type: string
 *                 description: User's full name.
 *               recaptchaToken:
 *                 type: string
 *                 description: Google reCAPTCHA v3 token for verification.
 *     responses:
 *       201:
 *         description: User registered successfully.
 *       400:
 *         description: Bad request (e.g., reCAPTCHA failed, invalid input).
 *       409:
 *         description: Conflict (e.g., email already exists).
 *       500:
 *         description: Internal server error.
 */
router.post('/register', async (req, res) => {
  const { email, password, name, phoneNumber, recaptchaToken } = req.body;
  const defaultRole = 'user';

  let userRecord; // To hold the created Firebase Auth user for rollback purposes
  try {
    // 0. Verify reCAPTCHA token before proceeding
    if (!await verifyRecaptcha(recaptchaToken)) {
      return res.status(400).json({ error: 'reCAPTCHA verification failed. Please try again.' });
    }

    // 1. Create user in Firebase Authentication
    userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      phoneNumber,
      disabled: true, // User is disabled by default, requires admin approval.
    });
    
    // 2. Set custom role claim for authorization
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: defaultRole });

    // 3. Insert user record into PostgreSQL with 'inactive' status
    const pool = await poolPromise;
    const pgClient = await pool.connect();
    try {
      await pgClient.query(
        'INSERT INTO users (user_id, email, name, phone, role, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [userRecord.uid, userRecord.email, name, phoneNumber, defaultRole, 'inactive']
      );
    } finally {
      pgClient.release(); // Always release the client back to the pool
    }

    logger.info(
      `New user registered (pending approval): ${email} (UID: ${userRecord.uid}) with role '${defaultRole}'. ` +
      `Account is currently disabled.`
    );
    res.status(201).json({
      message: 'User registered successfully. Your account is pending admin approval.',
      userId: userRecord.uid,
      role: defaultRole,
    });
  } catch (error) {
    logger.error('Error during registration:', error);

    // Attempt to roll back previous steps if any part of the process failed
    if (userRecord && userRecord.uid) {
      // If the PostgreSQL insert fails, roll back the Firebase Auth user creation.
      try {
        await admin.auth().deleteUser(userRecord.uid);
        logger.warn(`Rolled back Firebase Auth user (UID: ${userRecord.uid}) due to a subsequent step failing.`);
      } catch (deleteError) {
        logger.error(`CRITICAL: Failed to roll back Firebase Auth user (UID: ${userRecord.uid}). Manual cleanup required.`, deleteError);
      }
    }

    // Handle specific Firebase Auth errors
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'The email address is already in use by another account.' });
    }
    if (error.code === 'auth/invalid-phone-number') {
      return res.status(400).json({ error: 'The phone number is not valid. Please use E.164 format (e.g., +15551234567).' });
    }
    // Generic error for other Firebase Auth or Firestore issues
    res.status(500).json({ error: 'An internal error occurred during registration.', details: error.message });
  }
});

/**
 * @swagger
 * /api/auth/user-by-phone:
 *   post:
 *     summary: Get user's email by their phone number
 *     tags: [Authentication]
 *     description: Used during the login process to allow users to sign in with their phone number instead of email. This is a public endpoint.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 description: The user's phone number in E.164 format.
 *     responses:
 *       200:
 *         description: The user's email was found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 email:
 *                   type: string
 *                   format: email
 *       404:
 *         description: No user found with the provided phone number.
 *       500:
 *         description: Internal server error.
 */
router.post('/user-by-phone', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  // This endpoint is public for the login flow, so no token verification is needed.
  // It simply acts as a lookup service.
  const pool = await poolPromise;
  const pgClient = await pool.connect();
  try {
    // Query the database for a user with the given phone number
    const userRes = await pgClient.query(
      'SELECT email FROM users WHERE phone = $1',
      [phoneNumber]
    );

    if (userRes.rows.length === 0) {
      // No user found with that phone number
      logger.warn(`Phone-to-email lookup failed: No user found for phone number ${phoneNumber}`);
      return res.status(404).json({ error: 'No user found with that phone number.' });
    }

    // User found, return their email
    const user = userRes.rows[0];
    logger.info(`Phone-to-email lookup successful for phone number ${phoneNumber}`);
    res.status(200).json({ email: user.email });
  } catch (error) {
    logger.error(`Error during phone-to-email lookup for ${phoneNumber}:`, error);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    pgClient.release(); // Make sure to release the client back to the pool
  }
});

/**
 * POST /api/auth/verify-phone
 * Consumes an ID token from a successful client-side phone OTP verification.
 * Verifies the token and marks the user's phone as verified in the database.
 */
router.post('/verify-phone', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(401).json({ error: 'ID token not provided.' });
  }

  try {
    // 1. Verify the ID token. This proves the user completed the OTP flow.
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, phone_number } = decodedToken;

    if (!phone_number) {
      return res.status(400).json({ error: 'Token is not from a phone number authentication.' });
    }

    // 2. Update the user's status in PostgreSQL
    const pool = await poolPromise;
    const pgClient = await pool.connect();
    try {
      await pgClient.query("UPDATE users SET phone_verified = true, updated_at = NOW() WHERE user_id = $1", [uid]);
      logger.info(`Phone number ${phone_number} verified for user UID: ${uid}`);
    } finally {
      pgClient.release();
    }

    res.status(200).json({ status: 'success', message: 'Phone number verified successfully.' });
  } catch (error) {
    logger.error('Error verifying phone auth token:', error);
    res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
  }
});

// --- 2. Get Current User Profile Endpoint ---
/**
 * GET /api/auth/profile
 * This endpoint is protected by the verifyFirebaseToken middleware. If the token
 * is valid, it fetches the user's full profile from the database and returns it.
 * @swagger
 * /api/auth/profile:
 *   get:
 *     summary: Get the current user's profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The user's profile data.
 *       401:
 *         description: Unauthorized, token is missing or invalid.
 *       404:
 *         description: User profile not found in the database.
 *       500:
 *         description: Internal server error.
 */
router.get('/profile', verifyFirebaseToken, async (req, res) => {
  // The verifyFirebaseToken middleware has already validated the token
  // and attached the user's decoded token to req.user.
  const { uid } = req.user;

  const pool = await poolPromise;
  const pgClient = await pool.connect();
  try {
    // Fetch the user's full profile from PostgreSQL
    let userRes = await pgClient.query(
      'SELECT user_id as "id", email, name, phone as "phoneNumber", role, status, phone_verified as "phoneVerified", balance FROM users WHERE user_id = $1',
      [uid]
    );

    if (userRes.rows.length === 0) {
      logger.error(`Session valid for UID ${uid}, but user not found in PostgreSQL.`);
      return res.status(404).json({ error: 'User profile not found.' });
    }

    const userProfile = userRes.rows[0];

    // --- Check for an active battery session (consistent with login) ---
    const batteryQuery = `
      SELECT
        b.battery_uid as "batteryUid",
        s.charge_level_percent as "chargeLevel",
        bo.booth_uid AS "boothUid",
        s.slot_identifier AS "slotIdentifier"
      FROM batteries b
      LEFT JOIN booth_slots s ON b.id = s.current_battery_id
      LEFT JOIN booths bo ON s.booth_id = bo.id
      WHERE b.user_id = $1
    `;
    const batteryRes = await pgClient.query(batteryQuery, [uid]);

    if (batteryRes.rows.length > 0) {
      userProfile.activeBatterySession = batteryRes.rows[0];
    }

    // Return the user profile
    res.status(200).json(userProfile);
  } catch (error) {
    logger.error(`Error fetching session for user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to retrieve user session.' });
  } finally {
    pgClient.release();
  }
});

/**
 * POST /api/auth/profile/picture
 * Updates the current user's profile picture.
 * Expects a multipart/form-data request with a single file field named 'profileImage'.
 */
router.post(
  '/profile/picture',
  [
    verifyFirebaseToken,
    uploadToGcsMiddleware('profileImage', 'profile-pictures'),
  ],
  async (req, res) => {
    const { uid } = req.user;

    if (!req.file || !req.file.gcsUrl) {
      return res.status(400).json({ error: 'No image file was uploaded.' });
    }

    const imageUrl = req.file.gcsUrl;
    const pool = await poolPromise;
    const client = await pool.connect();
    try {
      // Update the user's record in PostgreSQL with the new image URL
      await client.query('UPDATE users SET profile_image_url = $1 WHERE user_id = $2', [imageUrl, uid]);

      // Optionally, update the user's photoURL in Firebase Auth as well
      await admin.auth().updateUser(uid, { photoURL: imageUrl });

      logger.info(`User ${uid} updated their profile picture. New URL: ${imageUrl}`);
      res.status(200).json({ message: 'Profile picture updated successfully.', imageUrl });
    } catch (error) {
      logger.error(`Failed to update profile picture for user ${uid}:`, error);
      res.status(500).json({ error: 'Failed to update profile picture.', details: error.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
