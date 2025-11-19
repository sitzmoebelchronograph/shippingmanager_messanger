/**
 * @fileoverview Contribution Gain Storage Utility
 *
 * Stores alliance contribution points gained from vessel departures for display in vessel history.
 * Uses JSON file storage with vesselId_timestamp as key.
 * Architecture is identical to harbor-fee-store.js for consistency.
 *
 * @module server/utils/contribution-store
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const CONTRIBUTIONS_DIR = path.join(__dirname, '../../userdata/contributions');

/**
 * Ensures contributions directory exists
 */
async function ensureDirectory() {
  try {
    await fs.mkdir(CONTRIBUTIONS_DIR, { recursive: true });
  } catch (error) {
    logger.error('[Contribution Store] Failed to create directory:', error.message);
  }
}

/**
 * Gets file path for user's contribution gains
 * @param {number} userId - User ID
 * @returns {string} File path
 */
function getFilePath(userId) {
  return path.join(CONTRIBUTIONS_DIR, `contributions-${userId}.json`);
}

/**
 * Loads contribution gains from disk
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Contribution gains map { "vesselId_timestamp": contributionGained }
 */
async function loadContributionGains(userId) {
  try {
    const filePath = getFilePath(userId);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}; // File doesn't exist yet
    }
    logger.error(`[Contribution Store] Failed to load gains for user ${userId}:`, error.message);
    return {};
  }
}

/**
 * Saves contribution gain for a vessel trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp (from created_at or current time)
 * @param {number} contributionGained - Contribution points gained
 * @returns {Promise<void>}
 */
async function saveContributionGain(userId, vesselId, timestamp, contributionGained) {
  try {
    await ensureDirectory();

    const gains = await loadContributionGains(userId);
    const key = `${vesselId}_${timestamp}`;
    gains[key] = contributionGained;

    const filePath = getFilePath(userId);
    await fs.writeFile(filePath, JSON.stringify(gains, null, 2), 'utf8');

    logger.debug(`[Contribution Store] Saved gain for ${key}: ${contributionGained.toFixed(2)} contribution`);
  } catch (error) {
    logger.error(`[Contribution Store] Failed to save gain:`, error.message);
  }
}

/**
 * Gets contribution gain for a specific trip
 * @param {number} userId - User ID
 * @param {number} vesselId - Vessel ID
 * @param {string} timestamp - Trip timestamp
 * @returns {Promise<number|null>} Contribution gain or null if not found
 */
async function getContributionGain(userId, vesselId, timestamp) {
  const gains = await loadContributionGains(userId);
  const key = `${vesselId}_${timestamp}`;
  return gains[key] || null;
}

/**
 * Enriches vessel history entries with contribution gains with fuzzy timestamp matching
 *
 * Timestamps can differ by up to 60 seconds between:
 * - Logbook entry (when depart API was called)
 * - Vessel history API (server processing time)
 *
 * @param {number} userId - User ID
 * @param {Array<Object>} historyEntries - Vessel history entries
 * @returns {Promise<Array<Object>>} History entries with contribution_gained added
 */
async function enrichHistoryWithContributions(userId, historyEntries) {
  const gains = await loadContributionGains(userId);

  return historyEntries.map(entry => {
    // Try exact match first
    const exactKey = `${entry.vessel_id}_${entry.created_at}`;
    if (gains[exactKey]) {
      return {
        ...entry,
        contribution_gained: gains[exactKey]
      };
    }

    // Fuzzy match: Find contribution gain within ±60 seconds
    const entryTimestamp = new Date(entry.created_at).getTime();
    const TOLERANCE_MS = 60 * 1000; // 60 seconds

    for (const [key, gain] of Object.entries(gains)) {
      const [vesselId, timestamp] = key.split('_');

      // Check if vessel ID matches
      if (parseInt(vesselId) !== entry.vessel_id) continue;

      // Check if timestamp is within tolerance
      const gainTimestamp = new Date(timestamp).getTime();
      const diff = Math.abs(entryTimestamp - gainTimestamp);

      if (diff <= TOLERANCE_MS) {
        return {
          ...entry,
          contribution_gained: gain
        };
      }
    }

    // No match found
    return {
      ...entry,
      contribution_gained: null
    };
  });
}

module.exports = {
  saveContributionGain,
  getContributionGain,
  enrichHistoryWithContributions
};
