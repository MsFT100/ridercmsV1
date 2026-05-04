const { Router } = require('express');
const { admin } = require('../../utils/firebase.js');
const logger = require('../../utils/logger.js');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');
const poolPromise = require('../../db');

const router = Router();

/**
 * POST /api/admin/users/set-role
 * @summary Set a custom role for a user
 * @description Sets a custom role for a specified user in Firebase Authentication custom claims. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required:
 *           - uid
 *           - newRole
 *         properties:
 *           uid:
 *             type: string
 *             description: The Firebase UID of the target user.
 *           newRole:
 *             type: string
 *             description: The new role to assign.
 *             enum: [admin, customer, driver]
 * @responses
 *   200:
 *     description: Role updated successfully.
 *   400:
 *     description: Bad request (e.g., missing parameters, invalid role).
 *   401:
 *     description: Unauthorized (token missing or invalid).
 *   403:
 *     description: Forbidden (user is not an admin).
 *   500:
 *     description: Internal server error.
 */
router.post('/users/set-role', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid, newRole } = req.body;
  const validRoles = ['admin', 'customer', 'driver']; // Define your application's roles

  if (!uid || !newRole) {
    return res.status(400).json({ error: 'Both uid and newRole are required.' });
  }

  if (!validRoles.includes(newRole)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
  }

  try {
    // Set the custom claim on the target user.
    await admin.auth().setCustomUserClaims(uid, { role: newRole });

    logger.info(`Admin (UID: ${req.user.uid}) changed role for user (UID: ${uid}) to '${newRole}'.`);
    res.status(200).json({ message: `Successfully set role for user ${uid} to ${newRole}.` });
  } catch (error) {
    logger.error(`Failed to set role for user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to set user role.', details: error.message });
  }
});

/**
 * GET /api/admin/users
 * @summary List all users
 * @description Retrieves a paginated list of all users from Firebase Authentication. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: pageSize
 *     schema:
 *       type: integer
 *       default: 100
 *     description: The number of users to fetch per page (max 1000).
 *   - in: query
 *     name: pageToken
 *     schema:
 *       type: string
 *     description: The token for fetching the next page of results, obtained from a previous request.
 * @responses
 *   200:
 *     description: A list of users.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             users:
 *               type: array
 *               items:
 *                 type: object
 *                   properties:
 *                     phoneNumber:
 *                       type: string
 *             nextPageToken:
 *               type: string
 */
router.get('/users', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 100, 1000);
  const pageToken = req.query.pageToken || undefined;

  try {
    const listUsersResult = await admin.auth().listUsers(pageSize, pageToken);

    // Map the full user records to a more concise format for the response.
    const users = listUsersResult.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName,
      phoneNumber: userRecord.phoneNumber,
      role: userRecord.customClaims?.role || 'customer', // Default to 'customer' if no role is set
      disabled: userRecord.disabled,
      creationTime: userRecord.metadata.creationTime,
      lastSignInTime: userRecord.metadata.lastSignInTime,
    }));

    res.status(200).json({
      users,
      nextPageToken: listUsersResult.pageToken, // Send this token back to the client for the next request
    });
  } catch (error) {
    logger.error('Failed to list users:', error);
    res.status(500).json({ error: 'Failed to retrieve user list.', details: error.message });
  }
});

/**
 * POST /api/admin/users/set-status
 * @summary Activate, deactivate, or suspend a user
 * @description Activates or deactivates a user in both Firebase Authentication (enabling/disabling their login) and the local PostgreSQL database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @requestBody
 *   required: true
 *   content:
 *     application/json:
 *       schema:
 *         type: object
 *         required:
 *           - uid
 *           - status
 *         properties:
 *           uid:
 *             type: string
 *             description: The Firebase UID of the target user.
 *           status:
 *             type: string
 *             description: The new status for the user. 'inactive' or 'suspended' will disable the user.
 *             enum: [active, inactive, suspended]
 * @responses
 *   200:
 *     description: User status updated successfully.
 *   400:
 *     description: Bad request (e.g., missing parameters, invalid status).
 */
router.post('/users/set-status', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid, status } = req.body;
  const validStatuses = ['active', 'inactive', 'suspended'];

  if (!uid || !status) {
    return res.status(400).json({ error: 'Both uid and status are required.' });
  }

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  // 'inactive' or 'suspended' in our DB means 'disabled' in Firebase Auth.
  const isDisabled = status !== 'active';

  const pool = await poolPromise;
  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // 1. Update Firebase Auth user state
    await admin.auth().updateUser(uid, { disabled: isDisabled });

    // 2. Update PostgreSQL user status
    const result = await pgClient.query("UPDATE users SET status = $1 WHERE user_id = $2", [status, uid]);

    if (result.rowCount === 0) {
      throw new Error(`User with UID ${uid} not found in the database.`);
    }

    await pgClient.query('COMMIT');
    logger.info(`Admin (UID: ${req.user.uid}) updated status for user (UID: ${uid}) to '${status}'. Firebase disabled: ${isDisabled}.`);
    res.status(200).json({ message: `Successfully set status for user ${uid} to '${status}'.` });
  } catch (error) {
    await pgClient.query('ROLLBACK');
    logger.error(`Failed to update status for user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to update user status.', details: error.message });
  } finally {
    pgClient.release();
  }
});

/**
 * DELETE /api/admin/users/:uid
 * @summary Delete a user
 * @description Deletes a user from both Firebase Authentication and the local PostgreSQL database. This is a protected route only accessible by users with the 'admin' role.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: path
 *     name: uid
 *     required: true
 *     schema:
 *       type: string
 *     description: The Firebase UID of the user to delete.
 * @responses
 *   200:
 *     description: User deleted successfully.
 *   404:
 *     description: User not found.
 *   500:
 *     description: Internal server error.
 */
router.delete('/users/:uid', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const { uid } = req.params;

  const pool = await poolPromise;
  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // 1. Delete the user from Firebase Authentication first.
    // If this fails, the transaction will be rolled back and nothing will happen in the local DB.
    await admin.auth().deleteUser(uid);

    // 2. If Firebase deletion is successful, delete the user from the PostgreSQL database.
    // The ON DELETE CASCADE constraint on the users table should handle related records.
    const deleteResult = await pgClient.query('DELETE FROM users WHERE user_id = $1', [uid]);

    if (deleteResult.rowCount === 0) {
      // If no rows were deleted, the user didn't exist in our DB.
      // This is not a critical error, as the primary record in Firebase Auth was just deleted.
      logger.warn(`User (UID: ${uid}) was deleted from Firebase Auth but was not found in the local PostgreSQL database.`);
    }

    // 3. If both operations succeed, commit the transaction.
    await pgClient.query('COMMIT');

    logger.info(`Admin (UID: ${req.user.uid}) successfully deleted user (UID: ${uid}).`);
    res.status(200).json({ message: `User ${uid} deleted successfully.` });
  } catch (error) {
    await pgClient.query('ROLLBACK');
    logger.error(`Failed to delete user ${uid}:`, error);
    res.status(500).json({ error: 'Failed to delete user. The operation was rolled back.', details: error.message });
  } finally {
    pgClient.release();
  }
});

module.exports = router;
