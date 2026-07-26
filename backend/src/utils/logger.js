const winston = require('winston');
require('winston-daily-rotate-file'); // registers winston.transports.DailyRotateFile

const isProduction = process.env.NODE_ENV === 'production';
// Directory for rotated log files. Overridable via LOG_DIR for deployments
// that want logs on a separate volume/mount; defaults to ./logs next to the
// process. This directory is git-ignored (see .gitignore) — it's runtime
// output, not source.
const logDir = process.env.LOG_DIR || 'logs';

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) =>
    `[${timestamp}] ${level.toUpperCase()}: ${stack || message}`)
);

const transports = [new winston.transports.Console()];

// File-based, rotating logs so restarting/redeploying the process doesn't
// lose history the way console-only logging does. Kept behind NODE_ENV so
// local `npm run dev` doesn't litter the working directory with log files;
// every deployment target should run with NODE_ENV=production regardless.
if (isProduction) {
  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info',
    }),
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
    }),
  );
}

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: logFormat,
  transports,
});

module.exports = logger;
