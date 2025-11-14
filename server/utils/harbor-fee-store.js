/**
 * @fileoverview Harbor Fee Storage Utility
 *
 * Stores harbor fees from vessel departures for display in vessel history.
 * Uses JSON file storage with vesselId_timestamp as key.
 *
 * @module server/utils/harbor-fee-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const HARBOR_FEES_DIR = path.join(__dirname, '../../userdata/harbor-fees');
const MIGRATION_MARKER_FILE = path.join(HARBOR_FEES_DIR, '.migration-completed');

/**
 * Ensures harbor fees directory exists
 */
async function ensureDirectory() {
  try {
    await fs.mkdir(HARBOR_FEES_DIR, { recursive: true });
  } catch (error) {
    logger.error('[Harbor Fee Store] Failed to create directory:', error.message);
  }
}

/**
 * Gets file path for user's harbor fees
 * @param {number} userId - User ID
 * @returns {string} File path
 */
function getFilePath(userId) {
  return path.join(HARBOR_FEES_DIR, `harbor-fees-${userId}.json`);
}

/**
 * Loads harbor fees from disk
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Harbor fees map { "vesselId_timestamp": harborFee }
 */
async function loadHarborFees(userId) {
  try {
    const filePath = getFilePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}; // File doesn't exist yet
    }
    logger.error(`[Harbor Fee Store] Failed to load fees for user ${userId}:`, error.message);
    return {};
  }
}

/**
 * Saves harbor fee for a vessel trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp (from created_at or current time)
 * @param {number} harborFee - Harbor fee amount
 * @returns {Promise<void>}
 */
async function saveHarborFee(userId, vesselId, timestamp, harborFee) {
  try {
    await ensureDirectory();

    const fees = await loadHarborFees(userId);
    const key = `${vesselId}_${timestamp}`;
    fees[key] = harborFee;

    const filePath = getFilePath(userId);
    await fs.writeFile(filePath, JSON.stringify(fees, null, 2), 'utf8');

    logger.debug(`[Harbor Fee Store] Saved fee for ${key}: $${harborFee}`);
  } catch (error) {
    logger.error(`[Harbor Fee Store] Failed to save fee:`, error.message);
  }
}

/**
 * Gets harbor fee for a specific trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @returns {Promise<number|null>} Harbor fee or null if not found
 */
async function getHarborFee(userId, vesselId, timestamp) {
  const fees = await loadHarborFees(userId);
  const key = `${vesselId}_${timestamp}`;
  return fees[key] || null;
}

/**
 * Enriches vessel history entries with harbor fees with fuzzy timestamp matching
 *
 * Timestamps can differ by up to 60 seconds between:
 * - Logbook entry (when depart API was called)
 * - Vessel history API (server processing time)
 *
 * @param {number} userId - User ID
 * @param {Array<Object>} historyEntries - Vessel history entries
 * @returns {Promise<Array<Object>>} History entries with harbor_fee added
 */
async function enrichHistoryWithFees(userId, historyEntries) {
  const fees = await loadHarborFees(userId);

  return historyEntries.map(entry => {
    // Try exact match first
    const exactKey = `${entry.vessel_id}_${entry.created_at}`;
    if (fees[exactKey]) {
      return {
        ...entry,
        harbor_fee: fees[exactKey]
      };
    }

    // Fuzzy match: Find harbor fee within ±60 seconds
    const entryTimestamp = new Date(entry.created_at).getTime();
    const TOLERANCE_MS = 60 * 1000; // 60 seconds

    for (const [key, fee] of Object.entries(fees)) {
      const [vesselId, timestamp] = key.split('_');

      // Check if vessel ID matches
      if (parseInt(vesselId) !== entry.vessel_id) continue;

      // Check if timestamp is within tolerance
      const feeTimestamp = new Date(timestamp).getTime();
      const diff = Math.abs(entryTimestamp - feeTimestamp);

      if (diff <= TOLERANCE_MS) {
        return {
          ...entry,
          harbor_fee: fee
        };
      }
    }

    // No match found
    return {
      ...entry,
      harbor_fee: null
    };
  });
}

/**
 * Checks if migration has already been completed
 * @returns {Promise<boolean>} True if migration was already done
 */
async function isMigrationCompleted() {
  try {
    await fs.access(MIGRATION_MARKER_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Marks migration as completed
 * @returns {Promise<void>}
 */
async function markMigrationCompleted() {
  try {
    await ensureDirectory();
    await fs.writeFile(MIGRATION_MARKER_FILE, new Date().toISOString(), 'utf8');
    logger.info('[Harbor Fee Store] Migration marked as completed');
  } catch (error) {
    logger.error('[Harbor Fee Store] Failed to mark migration as completed:', error.message);
  }
}

module.exports = {
  saveHarborFee,
  getHarborFee,
  enrichHistoryWithFees,
  isMigrationCompleted,
  markMigrationCompleted
};
