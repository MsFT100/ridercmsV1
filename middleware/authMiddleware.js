const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        // Attach the decoded user payload (e.g., { id, uid, role }) to the request object
        req.user = decoded;
        return next();
    } catch (err) {
        logger.error('Invalid token:', err);
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
    }
};

module.exports = verifyToken; // Export the function directly