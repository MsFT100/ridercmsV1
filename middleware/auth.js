const { admin } = require('../utils/firebase');
const logger = require('../utils/logger');

/**
 * Middleware to verify a Firebase ID token from the Authorization header.
 * If the token is valid, it attaches the decoded token to `req.user`.
 *
 * Expects the token to be in the format: `Authorization: Bearer <token>`
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
    // Attach the decoded token to the request object for use in subsequent handlers
    req.user = decodedToken;
    next(); // Pass control to the next handler
  } catch (error) {
    logger.error('Authentication error: Invalid token.', error);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Unauthorized: Token has expired.' });
    }
    return res.status(403).json({ error: 'Unauthorized: Invalid token.' });
  }
};

/**
 * Middleware to verify if the authenticated user has the 'admin' role.
 * This should be used AFTER `verifyFirebaseToken`.
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