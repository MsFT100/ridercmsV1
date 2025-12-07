const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const verifyAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }

    const token = authHeader.split('Bearer ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // This is the crucial part: check for the 'admin' role.
        if (decoded.role !== 'admin') {
            logger.warn(`Forbidden: User with role '${decoded.role}' tried to access admin route.`);
            return res.status(403).json({ error: 'Forbidden: Access denied.' });
        }

        req.user = decoded; // Attach decoded admin info to the request
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
    }
};

module.exports = verifyAdmin;
