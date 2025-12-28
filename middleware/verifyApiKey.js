const logger = require('../utils/logger');

const verifyApiKey = (req, res, next) => {
    const providedKey = req.query.apiKey;
    const serverKey = process.env.ADMIN_API_KEY;

    if (!providedKey) {
        return res.status(401).json({ error: 'API Key is required.' });
    }

    if (providedKey === serverKey) {
        next(); // Key is valid, proceed to the route handler.
    } else {
        logger.warn('Invalid API Key used for log stream attempt.');
        return res.status(403).json({ error: 'Forbidden: Invalid API Key.' });
    }
};

module.exports = verifyApiKey;