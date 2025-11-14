/**
 * @fileoverview Harbor Fee Migration Utility
 *
 * Extracts harbor fees from audit log entries and populates the harbor fee storage.
 * Matches logbook entries with vessel history by vessel name and timestamp.
 *
 * @module server/utils/migrate-harbor-fees
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { getLogDir } = require('../config');
const { saveHarborFee, markMigrationCompleted } = require('./harbor-fee-store');
const gameapi = require('../gameapi');

const LOG_DIR = path.join(getLogDir(), 'autopilot');

/**
 * Resolves vessel name to vessel ID with smart matching
 *
 * Naming logic:
 * - "Barzan" = first/only vessel with this name (no suffix)
 * - "Barzan_5836" = additional vessel purchased later (with suffix)
 *
 * Matching rules:
 * 1. Try exact match first (highest priority)
 * 2. If logbook has "Barzan", try to match current "Barzan" without suffix
 * 3. If logbook has "Barzan_5836", only match exact "Barzan_5836"
 * 4. Skip if ambiguous (vessel sold/renamed)
 *
 * @param {string} vesselName - Vessel name from logbook
 * @param {Map} vesselNameToId - Exact name mapping
 * @param {Map} vesselBaseNameToIds - Base name mapping for fuzzy match
 * @returns {number|null} Vessel ID or null if not found
 */
function resolveVesselNameToId(vesselName, vesselNameToId, vesselBaseNameToIds) {
  // Try exact match first (always preferred)
  if (vesselNameToId.has(vesselName)) {
    return vesselNameToId.get(vesselName);
  }

  // If logbook name has NO suffix (e.g. "Barzan")
  // This was the first/only vessel at the time
  if (!vesselName.includes('_')) {
    const baseName = vesselName;
    if (vesselBaseNameToIds.has(baseName)) {
      const matches = vesselBaseNameToIds.get(baseName);

      // Prefer vessel without suffix (still the only one)
      const exactMatch = matches.find(m => m.fullName === baseName);
      if (exactMatch) return exactMatch.id;

      // If only suffix versions exist, skip (ambiguous - could be any)
      // This happens when original was sold and multiple new ones purchased
      return null;
    }
  }

  // If logbook name HAS suffix (e.g. "Barzan_5836")
  // This was a specific vessel, only match exact name
  // Already tried exact match above, so this vessel doesn't exist anymore
  return null;
}

/**
 * Converts logbook timestamp (milliseconds) to MySQL datetime format
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} MySQL datetime format (YYYY-MM-DD HH:MM:SS)
 */
function timestampToMySQLDatetime(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Migrates harbor fees from audit log to harbor fee storage
 * @param {number} userId - User ID
 * @returns {Promise<{total: number, migrated: number, skipped: number, errors: Array}>} Migration stats
 */
async function migrateHarborFeesForUser(userId) {
  const logFilePath = path.join(LOG_DIR, `${userId}-autopilot-log.json`);

  let total = 0;
  let migrated = 0;
  let skipped = 0;

  try {
    // Read audit log
    const data = await fs.readFile(logFilePath, 'utf8');
    const logs = JSON.parse(data);

    logger.info(`[Harbor Fee Migration] Processing ${logs.length} log entries for user ${userId}`);

    // Get all vessels to resolve names to IDs
    const gameIndexResponse = await gameapi.getGameIndex();

    // Try multiple possible locations for vessels
    const allVessels = gameIndexResponse.data?.vessels
      || gameIndexResponse.vessels
      || gameIndexResponse.data?.user_vessels
      || [];
    logger.info(`[Harbor Fee Migration] Loaded ${allVessels.length} vessels for name resolution`);

    // Build vessel name -> ID mapping (both exact and base name)
    const vesselNameToId = new Map();
    const vesselBaseNameToIds = new Map(); // For fuzzy matching

    allVessels.forEach(v => {
      if (v.name && v.id) {
        // Exact name match
        vesselNameToId.set(v.name, v.id);

        // Base name match (before underscore)
        const baseName = v.name.split('_')[0];
        if (!vesselBaseNameToIds.has(baseName)) {
          vesselBaseNameToIds.set(baseName, []);
        }
        vesselBaseNameToIds.get(baseName).push({ id: v.id, fullName: v.name });
      }
    });

    logger.info(`[Harbor Fee Migration] Built name mapping: ${vesselNameToId.size} exact names, ${vesselBaseNameToIds.size} base names`);

    // Process each log entry
    for (const entry of logs) {
      // Look for entries with departedVessels array (Auto-Depart)
      if (entry.details?.departedVessels && Array.isArray(entry.details.departedVessels)) {
        for (const vessel of entry.details.departedVessels) {
          if (vessel.harborFee !== undefined && vessel.name) {
            total++;

            // Resolve vessel name to ID
            const vesselId = resolveVesselNameToId(vessel.name, vesselNameToId, vesselBaseNameToIds);

            if (!vesselId) {
              skipped++;
              continue; // Skip silently - many vessels are sold
            }

            // Convert logbook timestamp to MySQL datetime format
            const timestamp = timestampToMySQLDatetime(entry.timestamp);

            try {
              // Save harbor fee to storage
              await saveHarborFee(userId, vesselId, timestamp, vessel.harborFee);
              migrated++;
            } catch (error) {
              logger.error(`[Harbor Fee Migration] Failed to save fee for vessel ${vessel.name} (ID: ${vesselId}):`, error.message);
              skipped++;
            }
          }
        }
      }

      // Also check for vessels array (Manual Depart format)
      if (entry.details?.vessels && Array.isArray(entry.details.vessels)) {
        for (const vessel of entry.details.vessels) {
          if (vessel.harbor_fee !== undefined && vessel.name) {
            total++;

            // Resolve vessel name to ID
            const vesselId = resolveVesselNameToId(vessel.name, vesselNameToId, vesselBaseNameToIds);

            if (!vesselId) {
              skipped++;
              continue; // Skip silently - many vessels are sold
            }

            // Convert logbook timestamp to MySQL datetime format
            const timestamp = timestampToMySQLDatetime(entry.timestamp);

            try {
              // Save harbor fee to storage
              await saveHarborFee(userId, vesselId, timestamp, vessel.harbor_fee);
              migrated++;
            } catch (error) {
              logger.error(`[Harbor Fee Migration] Failed to save fee for vessel ${vessel.name} (ID: ${vesselId}):`, error.message);
              skipped++;
            }
          }
        }
      }

      // Check for highFeeVessels array (high harbor fee warnings)
      if (entry.details?.highFeeVessels && Array.isArray(entry.details.highFeeVessels)) {
        for (const vessel of entry.details.highFeeVessels) {
          if (vessel.harborFee !== undefined && vessel.name) {
            total++;

            // Resolve vessel name to ID
            const vesselId = resolveVesselNameToId(vessel.name, vesselNameToId, vesselBaseNameToIds);

            if (!vesselId) {
              skipped++;
              continue; // Skip silently - many vessels are sold
            }

            // Convert logbook timestamp to MySQL datetime format
            const timestamp = timestampToMySQLDatetime(entry.timestamp);

            try {
              // Save harbor fee to storage
              await saveHarborFee(userId, vesselId, timestamp, vessel.harborFee);
              migrated++;
            } catch (error) {
              logger.error(`[Harbor Fee Migration] Failed to save fee for vessel ${vessel.name} (ID: ${vesselId}):`, error.message);
              skipped++;
            }
          }
        }
      }
    }

    logger.info(`[Harbor Fee Migration] User ${userId}: ${migrated}/${total} harbor fees migrated, ${skipped} skipped`);

    // Mark migration as completed
    if (migrated > 0) {
      await markMigrationCompleted();
    }

    return { total, migrated, skipped };
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn(`[Harbor Fee Migration] No audit log found for user ${userId}`);
      return { total: 0, migrated: 0, skipped: 0 };
    }
    logger.error(`[Harbor Fee Migration] Failed to migrate for user ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Migrates harbor fees for all users
 * @returns {Promise<Object>} Migration stats by user
 */
async function migrateAllHarborFees() {
  try {
    // Get all log files in the directory
    const files = await fs.readdir(LOG_DIR);
    const logFiles = files.filter(f => f.endsWith('-autopilot-log.json'));

    logger.info(`[Harbor Fee Migration] Found ${logFiles.length} user log files`);

    const results = {};

    for (const file of logFiles) {
      // Extract userId from filename (format: {userId}-autopilot-log.json)
      const userId = file.split('-')[0];

      try {
        results[userId] = await migrateHarborFeesForUser(userId);
      } catch (error) {
        logger.error(`[Harbor Fee Migration] Failed for user ${userId}:`, error);
        results[userId] = { error: error.message };
      }
    }

    // Summary
    const totalMigrated = Object.values(results).reduce((sum, r) => sum + (r.migrated || 0), 0);
    logger.info(`[Harbor Fee Migration] COMPLETE: ${totalMigrated} total harbor fees migrated`);

    return results;
  } catch (error) {
    logger.error(`[Harbor Fee Migration] Failed to read log directory:`, error);
    throw error;
  }
}

module.exports = {
  migrateHarborFeesForUser,
  migrateAllHarborFees
};
