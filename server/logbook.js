/**
 * Autopilot Logbook Module
 *
 * Manages logging of all autopilot actions (success and errors) for debugging,
 * transparency, and accountability. Logs are stored per-user in JSON format.
 *
 * Features:
 * - In-memory cache with periodic disk writes (every 30 seconds)
 * - Atomic file writes to prevent corruption
 * - Filter support (status, time range, search)
 * - Export to TXT, CSV, JSON formats
 * - Manual deletion (no automatic rotation)
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('./utils/logger');

// Configuration
const { getLogDir } = require('./config');
const LOG_DIR = path.join(getLogDir(), 'autopilot');
const LOG_FILE_NAME = 'autopilot-log.json';
const WRITE_INTERVAL = 30000; // 30 seconds

// In-memory cache: { userId: [...logEntries] }
const logCache = new Map();

// Dirty flags: { userId: boolean }
const dirtyFlags = new Map();

// Write timer
let writeTimer = null;

/**
 * Initialize the logbook system
 * Start periodic disk writes
 */
function initialize() {
  // Ensure data directory exists
  fs.mkdir(LOG_DIR, { recursive: true }).catch(err => {
    logger.error('Failed to create log directory:', err);
  });

  // Start periodic write timer
  if (!writeTimer) {
    writeTimer = setInterval(flushAllToDisk, WRITE_INTERVAL);
    logger.debug('Logbook: Periodic write timer started (30s interval)');
  }
}

/**
 * Get the log file path for a user
 */
function getLogFilePath(userId) {
  return path.join(LOG_DIR, `${userId}-${LOG_FILE_NAME}`);
}

/**
 * Load logs from disk into memory cache
 */
async function loadLogsFromDisk(userId) {
  const filePath = getLogFilePath(userId);

  try {
    const data = await fs.readFile(filePath, 'utf8');
    const logs = JSON.parse(data);
    logCache.set(userId, logs);
    logger.debug(`Logbook: Loaded ${logs.length} entries for user ${userId}`);
    return logs;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist yet - create empty array
      logCache.set(userId, []);
      return [];
    }
    logger.error(`Logbook: Failed to load logs for user ${userId}:`, err);
    logCache.set(userId, []);
    return [];
  }
}

/**
 * Get logs from cache (load from disk if not cached)
 */
async function getLogsFromCache(userId) {
  if (!logCache.has(userId)) {
    await loadLogsFromDisk(userId);
  }
  return logCache.get(userId) || [];
}

/**
 * Write logs to disk atomically (temp file + rename)
 */
async function writeLogsToDisk(userId, logs) {
  const filePath = getLogFilePath(userId);
  const tempPath = `${filePath}.tmp`;

  try {
    const data = JSON.stringify(logs, null, 2);
    await fs.writeFile(tempPath, data, 'utf8');
    await fs.rename(tempPath, filePath);
    dirtyFlags.set(userId, false);
    logger.debug(`Logbook: Wrote ${logs.length} entries to disk for user ${userId}`);
  } catch (err) {
    logger.error(`Logbook: Failed to write logs for user ${userId}:`, err);
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore - file might not exist
    }
  }
}

/**
 * Flush all dirty caches to disk
 */
async function flushAllToDisk() {
  const flushPromises = [];

  for (const [userId, isDirty] of dirtyFlags.entries()) {
    if (isDirty && logCache.has(userId)) {
      const logs = logCache.get(userId);
      flushPromises.push(writeLogsToDisk(userId, logs));
    }
  }

  if (flushPromises.length > 0) {
    await Promise.all(flushPromises);
  }
}

/**
 * Log an autopilot action
 *
 * @param {string} userId - User ID
 * @param {string} autopilot - Autopilot name (e.g., "Auto-Depart", "Auto-Fuel")
 * @param {string} status - "SUCCESS" or "ERROR"
 * @param {string} summary - Human-readable summary (e.g., "12 vessels | +$1,876,204")
 * @param {object} details - Autopilot-specific details object
 * @returns {object} The created log entry
 */
async function logAutopilotAction(userId, autopilot, status, summary, details = {}) {
  const logEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    autopilot,
    status,
    summary,
    details
  };

  // Get logs from cache
  const logs = await getLogsFromCache(userId);

  // Prepend new entry (newest first)
  logs.unshift(logEntry);

  // Update cache
  logCache.set(userId, logs);
  dirtyFlags.set(userId, true);

  logger.debug(`Logbook: [${status}] ${autopilot}: ${summary}`);

  // Broadcast to all connected clients via WebSocket
  try {
    const { broadcastToUser } = require('./websocket');
    broadcastToUser(userId, 'logbook_update', logEntry);
  } catch {
    // Silently fail if WebSocket not available (e.g., during startup)
    // Don't log error to avoid spam - WebSocket might not be initialized yet
  }

  return logEntry;
}

/**
 * Determines transaction type from log entry
 * @param {object} log - Log entry
 * @returns {string} - 'INCOME', 'EXPENSE', or ''
 */
function getTransactionType(log) {
  if (!log.summary) return '';

  // Income: summary contains "+$" (e.g., "+$1,234")
  if (log.summary.includes('+$')) {
    return 'INCOME';
  }

  // Expense: summary contains "-$" (e.g., "-$1,234") OR contains only "$" with specific autopilots
  if (log.summary.includes('-$')) {
    return 'EXPENSE';
  }

  // Additional expense autopilots that show cost without minus sign
  const expenseAutopilots = ['Auto-Drydock', 'Auto-Fuel', 'Auto-CO2', 'Auto-Anchor Purchase', 'Auto-Reputation'];
  if (expenseAutopilots.includes(log.autopilot) && log.summary.includes('$')) {
    return 'EXPENSE';
  }

  return '';
}

/**
 * Get category from action name
 * @param {string} action - Action/autopilot name
 * @returns {string} Category (BUNKER, VESSEL, AUTOPILOT, ANCHOR, SETTINGS)
 */
function getCategoryFromAction(action) {
  if (!action) return 'AUTOPILOT';

  if (action.includes('Fuel') || action.includes('CO2') || action.includes('Bunker')) {
    return 'BUNKER';
  }

  if (action.includes('Vessel') || action.includes('Depart') || action.includes('Repair') || action.includes('Drydock')) {
    return 'VESSEL';
  }

  if (action.includes('Anchor')) {
    return 'ANCHOR';
  }

  if (action.includes('Settings')) {
    return 'SETTINGS';
  }

  return 'AUTOPILOT';
}

/**
 * Get source from action name
 * @param {string} action - Action/autopilot name
 * @returns {string} Source (MANUAL or AUTOPILOT)
 */
function getSourceFromAction(action) {
  if (!action) return 'AUTOPILOT';

  if (action.startsWith('Manual ') || action.includes('Manual')) {
    return 'MANUAL';
  }

  return 'AUTOPILOT';
}

/**
 * Recursively searches through an object for a search term
 * @param {*} obj - Object to search through
 * @param {string} searchTerm - Term to search for (case-insensitive)
 * @returns {boolean} - True if term found anywhere in object
 */
function searchInObject(obj, searchTerm) {
  if (!searchTerm) return true;

  const lowerSearch = searchTerm.toLowerCase();

  // Handle primitive types
  if (obj === null || obj === undefined) {
    return false;
  }
  if (typeof obj !== 'object') {
    return String(obj).toLowerCase().includes(lowerSearch);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.some(item => searchInObject(item, searchTerm));
  }

  // Handle objects
  for (const value of Object.values(obj)) {
    if (searchInObject(value, searchTerm)) {
      return true;
    }
  }

  return false;
}

/**
 * Get log entries with optional filters
 *
 * @param {string} userId - User ID
 * @param {object} filters - Filter options
 * @param {string} filters.status - "SUCCESS", "ERROR", "WARNING", or "ALL"
 * @param {string} filters.timeRange - "1h", "2h", "6h", "12h", "24h", "today", "yesterday", "48h", "7days", "lastweek", "30days", "lastmonth", or "all"
 * @param {string} filters.autopilot - Autopilot name or "ALL"
 * @param {string} filters.search - Search term (full-text search across all fields including details)
 * @returns {array} Filtered log entries
 */
async function getLogEntries(userId, filters = {}) {
  let logs = await getLogsFromCache(userId);

  // Apply status filter
  if (filters.status && filters.status !== 'ALL') {
    logs = logs.filter(log => log.status === filters.status);
  }

  // Apply transaction filter
  if (filters.transaction && filters.transaction !== 'ALL') {
    logs = logs.filter(log => getTransactionType(log) === filters.transaction);
  }

  // Apply autopilot filter
  if (filters.autopilot && filters.autopilot !== 'ALL') {
    logs = logs.filter(log => log.autopilot === filters.autopilot);
  }

  // Apply category filter
  if (filters.category && filters.category !== 'ALL') {
    logs = logs.filter(log => getCategoryFromAction(log.autopilot) === filters.category);
  }

  // Apply source filter
  if (filters.source && filters.source !== 'ALL') {
    logs = logs.filter(log => getSourceFromAction(log.autopilot) === filters.source);
  }

  // Apply time range filter
  if (filters.timeRange && filters.timeRange !== 'all') {
    const now = Date.now();
    let cutoff;

    if (filters.timeRange === '1h') {
      cutoff = now - (1 * 60 * 60 * 1000);
    } else if (filters.timeRange === '2h') {
      cutoff = now - (2 * 60 * 60 * 1000);
    } else if (filters.timeRange === '6h') {
      cutoff = now - (6 * 60 * 60 * 1000);
    } else if (filters.timeRange === '12h') {
      cutoff = now - (12 * 60 * 60 * 1000);
    } else if (filters.timeRange === '24h') {
      cutoff = now - (24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      cutoff = today.getTime();
    } else if (filters.timeRange === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      logs = logs.filter(log => log.timestamp >= yesterday.getTime() && log.timestamp < today.getTime());
      return logs; // Early return for yesterday (specific day filter)
    } else if (filters.timeRange === '48h') {
      cutoff = now - (48 * 60 * 60 * 1000);
    } else if (filters.timeRange === '7days') {
      cutoff = now - (7 * 24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'lastweek') {
      // Last week = previous Monday to Sunday
      const today = new Date();
      const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Days to go back to this week's Monday
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - daysToMonday);
      thisMonday.setHours(0, 0, 0, 0);

      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);

      const lastSunday = new Date(thisMonday);
      lastSunday.setMilliseconds(-1); // End of last Sunday

      logs = logs.filter(log => log.timestamp >= lastMonday.getTime() && log.timestamp <= lastSunday.getTime());

      // Apply remaining filters
      if (filters.search && filters.search.trim() !== '') {
        const searchTerm = filters.search.toLowerCase();
        logs = logs.filter(log => searchInObject(log, searchTerm));
      }

      return logs; // Early return
    } else if (filters.timeRange === '30days') {
      cutoff = now - (30 * 24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'lastmonth') {
      // Last month = previous calendar month
      const today = new Date();
      const firstDayOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const firstDayOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);

      logs = logs.filter(log => log.timestamp >= firstDayOfLastMonth.getTime() && log.timestamp < firstDayOfThisMonth.getTime());

      // Apply remaining filters
      if (filters.search && filters.search.trim() !== '') {
        const searchTerm = filters.search.toLowerCase();
        logs = logs.filter(log => searchInObject(log, searchTerm));
      }

      return logs; // Early return
    }

    if (cutoff !== undefined) {
      logs = logs.filter(log => log.timestamp >= cutoff);
    }
  }

  // Apply search filter (full-text search across all fields)
  if (filters.search && filters.search.trim() !== '') {
    const searchTerm = filters.search.toLowerCase();
    console.log('[Logbook] Searching for:', searchTerm);
    logs = logs.filter(log => {
      const found = searchInObject(log, searchTerm);
      if (found) {
        console.log('[Logbook] Found match in log:', log.id, log.autopilot, log.summary);
      }
      return found;
    });
    console.log('[Logbook] Search results:', logs.length, 'entries found');
  }

  return logs;
}

/**
 * Delete all logs for a user (manual cleanup)
 */
async function deleteAllLogs(userId) {
  const filePath = getLogFilePath(userId);

  try {
    // Clear cache
    logCache.set(userId, []);
    dirtyFlags.set(userId, false);

    // Delete file
    await fs.unlink(filePath);
    logger.debug(`Logbook: Deleted all logs for user ${userId}`);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist - that's fine
      return true;
    }
    logger.error(`Logbook: Failed to delete logs for user ${userId}:`, err);
    return false;
  }
}

/**
 * Get log file size in bytes
 */
async function getLogFileSize(userId) {
  const filePath = getLogFilePath(userId);

  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return 0;
    }
    logger.error(`Logbook: Failed to get file size for user ${userId}:`, err);
    return 0;
  }
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Shutdown the logbook system gracefully
 */
async function shutdown() {
  if (writeTimer) {
    clearInterval(writeTimer);
    writeTimer = null;
  }

  // Flush all dirty caches
  await flushAllToDisk();
  logger.debug('Logbook: Shutdown complete');
}

// Initialize on module load
initialize();

// Graceful shutdown on process exit
process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

module.exports = {
  logAutopilotAction,
  getLogEntries,
  deleteAllLogs,
  getLogFileSize,
  formatFileSize,
  flushAllToDisk,
  shutdown
};
