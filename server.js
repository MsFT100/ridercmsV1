// --- Load Environment Variables ---
// This must be at the very top to ensure `process.env` is populated before other modules.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const logger = require('./utils/logger'); // Corrected path
const poolPromise = require('./db/index.js'); // Corrected path
const { initializeDatabase } = require('./db/init'); // Corrected path
const { initializeFirebase } = require('./utils/firebase');
const swaggerUi = require('swagger-ui-express');
const { initializeFirebaseListener } = require('./utils/firebaseListener');
const swaggerSpec = require('./utils/swaggerConfig');


// Import routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const boothRoutes = require('./routes/booths');
const mpesaRoutes = require('./routes/mpesa');


const app = express();
const PORT = process.env.PORT || 8080;

// --- Initialize Firebase Admin SDK ---
initializeFirebase();

// --- Initialize Firebase Realtime Database Listener ---
initializeFirebaseListener();

// Security check
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  logger.error('FATAL ERROR: JWT_SECRET is not defined.');
  process.exit(1);
}

// 🔧 Normalize paths (double slashes + trailing slashes)
app.use((req, res, next) => {
  // Collapse multiple slashes: // -> /
  req.url = req.url.replace(/\/{2,}/g, '/');

  // Remove trailing slash (except root "/")
  if (req.path.length > 1 && req.path.endsWith('/')) {
    req.url = req.path.slice(0, -1) + req.url.slice(req.path.length);
  }

  next();
});

// ✅ Smarter CORS setup
const allowedOrigins = [
  'https://ridercms-ced94.web.app',
  'https://ridercms-ced94.firebaseapp.com',
  '*',
  'http://localhost:3001', // Explicitly add the 'www' subdomain for production
];

// Handle new ALLOWED_ORIGINS (comma-separated list) from .env
if (process.env.ALLOWED_ORIGINS) {
  // Split by comma and trim whitespace from each origin
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()));
}

// Handle legacy CORS_ORIGIN for backward compatibility and add it to the list
if (process.env.CORS_ORIGIN) {
  logger.warn('The .env variable CORS_ORIGIN is deprecated. Please use ALLOWED_ORIGINS for a comma-separated list of domains.');
  // Add it to the list if it's not already there to avoid duplicates
  if (!allowedOrigins.includes(process.env.CORS_ORIGIN)) allowedOrigins.push(process.env.CORS_ORIGIN);
}

const corsOptions = {
  origin: (origin, callback) => {
    // `origin` is the URL of the frontend making the request.
    if (!origin) return callback(null, true); // Allow requests with no origin (like Postman, curl).

    // Flexible localhost check for development (any port).
    const isLocalhost = origin.startsWith('http://localhost:');
    // Vercel preview URLs.
    const isVercel = /\.vercel\.app$/.test(origin);
    // Check against our whitelist.
    const isWhitelisted = allowedOrigins.includes(origin);

    if (isLocalhost || isVercel || isWhitelisted) {
      // Allow the request.
      return callback(null, true);
    }

    // Block the request.
    logger.warn(`CORS blocked for origin: ${origin}`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 204 // For legacy browser compatibility
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// --- Serve Static Files ---
// Serve static files (like the logs.html page) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Use morgan for HTTP request logging, piped through our winston logger
app.use(morgan('combined', { stream: logger.stream }));

// --- API Documentation (Swagger) ---
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// --- Root Endpoint ---
// A simple endpoint to confirm the API is running when accessed via a browser.
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    message: 'Welcome to the RiderCMS API!',
    healthCheck: '/api/health'
  });
});

// --- Admin Pages ---
// A simple, un-authenticated route to serve the log viewer page.
app.get('/admin/log-viewer', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'logs.html'));
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/booths', boothRoutes);
app.use('/api/mpesa', mpesaRoutes);


// Health check
app.get('/api/health', async (req, res) => {
  try {
    const pool = await poolPromise;
    // 1. Check Database Connection by running a simple, fast query.
    const dbResult = await pool.query('SELECT NOW() as now');
    const dbTime = dbResult.rows[0].now;

    // 2. If successful, return a 200 OK status with details.
    res.status(200).json({
      success: true,
      message: 'Server is running and database is connected.',
      timestamp: new Date().toISOString(),
      database: {
        status: 'ok',
        time: dbTime,
      },
    });
  } catch (err) {
    // 3. If it fails, return a 503 Service Unavailable status.
    logger.error('Health check failed due to database connection error.', err);
    res.status(503).json({
      success: false,
      message: 'Server is running but the database connection is failing.',
      timestamp: new Date().toISOString(),
      error: 'Database connection error.',
    });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  const pool = await poolPromise;
  logger.info('Shutting down server...');
  await pool.end();
  process.exit(0);
});

// Start server
const startServer = () => {
  app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
  });
};

if (process.env.DB_DIALECT === 'postgres') {
  logger.info("DB_DIALECT is 'postgres'. Initializing database...");
  initializeDatabase().then(startServer).catch(err => {
    logger.error('Failed to initialize PostgreSQL database. Server not started.', err);
    process.exit(1);
  });
} else {
  logger.warn(`DB_DIALECT is not set to 'postgres'. Starting server without database initialization.`);
  startServer();
}

module.exports = app;