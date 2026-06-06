const { admin } = require('../utils/firebase');
const logger = require('../utils/logger');
const schemaStorage = require('../utils/schemaStorage');

/**
 * Middleware to verify a Firebase ID token from the Authorization header.
 * If the token is valid, it attaches the decoded token to `req.user`.
 *
 * Expects the token to be in the format: `Authorization: Bearer <token>`
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 * @returns {Promise<void|import('express').Response>} Returns nothing on success, or an error response.
 */
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Authentication error: No Bearer token provided.');
    return res.status(403).json({ error: 'Unauthorized: No token provided.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    if (decodedToken.role === 'developer') {
      req.schema = 'dev';
      schemaStorage.enterWith('dev');
    } else {
      req.schema = 'public';
    }
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Unauthorized: Token has expired.' });
    }
    if (error.code === 'auth/user-disabled') {
      return res.status(403).json({ error: 'Account pending approval. Please wait for admin activation.' });
    }
    return res.status(403).json({ error: 'Unauthorized: Invalid token.' });
  }
};

/**
 * Middleware to verify if the authenticated user has the 'admin' role.
 * This should be used AFTER `verifyFirebaseToken`.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 * @returns {void|import('express').Response} Returns nothing on success, or an error response.
 */
const isAdmin = (req, res, next) => {
  // `verifyFirebaseToken` should have already run and attached the user object.
  const { role } = req.user;

  if (role === 'admin') {
    // User has the admin role, proceed to the next handler.
    return next();
  }

  // User is authenticated but does not have the required role.
  logger.warn(`Forbidden: User (UID: ${req.user.uid}) with role '${role}' tried to access an admin-only route.`);
  return res.status(403).json({ error: 'Forbidden: You do not have permission to perform this action.' });
};

module.exports = {
  verifyFirebaseToken,
  isAdmin,
};