const winston = require('winston');
const path = require('path');
const streamTransport = require('./logStreamTransport');
require('winston-daily-rotate-file');

const isProduction = process.env.NODE_ENV === 'production';

const logLevels = {
  console: {
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
  },
};

const transports = [];

if (isProduction) {
  // In production, log to the console. Cloud providers like Google Cloud Run
  // automatically capture stdout/stderr and send it to their logging service.
  transports.push(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json() // Use JSON format for structured logging
    ),
  }));
  console.log('Production logging enabled (console).'); // Use console.log for initial setup info
} else {
  // In development, log to both the console (with colors) and a rotating file.
  transports.push(new winston.transports.Console(logLevels.console));
  transports.push(new winston.transports.DailyRotateFile({
    filename: path.join(__dirname, '../logs/application-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  }));
  console.log('Development logging enabled (console + daily rotating file).');
}

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug', // Be more verbose in development
  transports,
  exitOnError: false, // Do not exit on handled exceptions
});

// Create a stream object with a 'write' function that will be used by `morgan`
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;