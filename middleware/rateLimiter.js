const rateLimit = require('express-rate-limit');

// @ts-ignore
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// @ts-ignore
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

// @ts-ignore
const boothLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// @ts-ignore
const mpesaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

module.exports = {
  globalLimiter,
  authLimiter,
  boothLimiter,
  mpesaLimiter,
};
