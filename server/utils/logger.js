/**
 * @fileoverview Centralized logging utility with winston
 *
 * Provides consistent timestamp formatting and log levels across all server logs.
 * Format: [2025-11-02T12:34:56.789Z] [LEVEL] message
 *
 * @module server/utils/logger
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getLogDir } = require('../config');

/**
 * Load log level from startup settings and debug mode.
 * Must be done inline to avoid circular dependency with config.js.
 *
 * Priority:
 * 1. If DEBUG_MODE env var is set (from systray toggle), use 'debug'
 * 2. Otherwise use settings.logLevel (from settings.json)
 *
 * @returns {string} Log level (info, debug, warn, error)
 */
function loadLogLevel() {
  // Check if Debug Mode is enabled via environment variable (set by start.py)
  if (process.env.DEBUG_MODE === 'true') {
    return 'debug';
  }

  try {
    const isPkg = !!process.pkg;
    let settingsPath;

    if (isPkg) {
      // Running as .exe - use AppData/Local
      if (process.platform === 'win32') {
        settingsPath = path.join(os.homedir(), 'AppData', 'Local', 'ShippingManagerCoPilot', 'userdata', 'settings', 'settings.json');
      } else {
        settingsPath = path.join(os.homedir(), '.local', 'share', 'ShippingManagerCoPilot', 'userdata', 'settings', 'settings.json');
      }
    } else {
      // Running from source - use userdata
      settingsPath = path.join(__dirname, '..', '..', 'userdata', 'settings', 'settings.json');
    }

    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      return settings.logLevel || 'info';
    }
  } catch {
    // Silent fallback (ignore errors during settings read)
  }
  return 'info';
}

/**
 * Check if debug mode is enabled from environment variable.
 * Set by start.py based on systray Debug Mode toggle.
 * @returns {boolean} True if debug mode is enabled
 */
function isDebugMode() {
  return process.env.DEBUG_MODE === 'true';
}

/**
 * Custom format for console output with timestamps
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DDTHH:mm:ssZ'
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);


/**
 * Get log file paths based on environment (dev vs packaged)
 */
const logDir = getLogDir();
// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const serverLogPath = path.join(logDir, 'server.log');
const debugLogPath = path.join(logDir, 'debug.log');

/**
 * Build transports array - only include debug.log when debug mode is active
 */
// Winston only writes to console (stdout)
// Python's start.py captures stdout and routes to log files based on level
const transports = [
  new winston.transports.Console({
    format: consoleFormat
  })
];

/**
 * Winston logger instance with log level from startup settings
 */
const logger = winston.createLogger({
  level: loadLogLevel(),  // Load from settings.json (no env vars)
  format: consoleFormat,
  transports: transports
});

/**
 * Log error message with timestamp
 * @param {...any} args - Arguments to log
 */
function error(...args) {
  logger.error(args.join(' '));
}

/**
 * Log warning message with timestamp
 * @param {...any} args - Arguments to log
 */
function warn(...args) {
  logger.warn(args.join(' '));
}

/**
 * Log debug message with timestamp
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
  logger.debug(args.join(' '));
}

/**
 * Log info message with timestamp
 * @param {...any} args - Arguments to log
 */
function info(...args) {
  logger.info(args.join(' '));
}

module.exports = {
  info,
  error,
  warn,
  debug,
  serverLogPath,
  debugLogPath,
  logger, // Export raw winston logger for advanced use
  isDebugMode // Export debug mode checker
};
