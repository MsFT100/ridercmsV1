const winston = require('winston');
const path = require('path');
const streamTransport = require('./logStreamTransport');
require('winston-daily-rotate-file');

const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, colorize, errors } = format;

// Custom format for log messages
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} ${level}: ${stack || message}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }), // This will automatically log the stack trace on errors
    logFormat
  ),
  transports: [
    // Console transport with its own colorized format.
    new transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    }),
    // Also send logs to our live stream transport for the admin viewer
    streamTransport,
  ],
  exitOnError: false, // Do not exit on handled exceptions
});

// --- Environment-Specific Transports ---
// Only add File transports if we are NOT in a production environment.
if (process.env.NODE_ENV !== 'production') {
  const logsDir = path.join(__dirname, '../logs');
  const fs = require('fs');

  // Create logs directory synchronously if it doesn't exist (for local dev)
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }

  // Error log rotation
  logger.add(new transports.DailyRotateFile({
    level: 'error',
    filename: path.join(logsDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true, // Zip the archived log files to save space
    maxSize: '20m',      // Rotate if file size exceeds 20MB
    maxFiles: '14d'      // Keep logs for 14 days, then delete the oldest ones
  }));

  // Combined log rotation
  logger.add(new transports.DailyRotateFile({
    filename: path.join(logsDir, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
  }));
  logger.info('Daily rotating file logging enabled for non-production environment.');
}

// Create a stream object with a 'write' function that will be used by `morgan`
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;