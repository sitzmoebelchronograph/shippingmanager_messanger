/**
 * @fileoverview Yard Foreman - Auto Bulk Repair Pilot
 *
 * Automatically repairs vessels when wear reaches threshold.
 * Respects minimum cash balance requirements.
 *
 * @module server/autopilot/pilot_yard_foreman
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const config = require('../config');
const { logAutopilotAction } = require('../logbook');

const DEBUG_MODE = config.DEBUG_MODE;

/**
 * Auto repair vessels for a single user based on wear threshold.
 *
 * Decision Logic:
 * 1. Fetches all vessels and filters by wear >= maintenanceThreshold
 * 2. Checks minimum cash balance requirement
 * 3. Fetches repair cost for all vessels needing repair
 * 4. If affordable, repairs all vessels in bulk
 * 5. Broadcasts repair notification with vessel list and costs
 *
 * API Quirk - $0 Cost Bug:
 * - Sometimes API returns totalCost=$0 even when repair is valid
 * - We attempt repair anyway as workaround for this API bug
 * - Actual cost is deducted from cash regardless of API response
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoRepairVessels(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.log('[Auto-Repair] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoBulkRepair) {
    if (DEBUG_MODE) {
      logger.log('[Auto-Repair] Feature disabled in settings');
    }
    return;
  }

  try {
    const threshold = settings.maintenanceThreshold;

    const bunker = await gameapi.fetchBunkerState();
    const vessels = await gameapi.fetchVessels();

    const vesselsNeedingRepair = vessels.filter(v => v.wear >= threshold);

    if (DEBUG_MODE) {
      logger.log(`[Auto-Repair] Found ${vesselsNeedingRepair.length} vessels with wear >= ${threshold}%`);
    }

    if (vesselsNeedingRepair.length === 0) {
      if (DEBUG_MODE) {
        logger.log('[Auto-Repair] No vessels need repair');
      }
      return;
    }

    // Check minimum cash balance
    const minCash = settings.autoBulkRepairMinCash !== undefined ? settings.autoBulkRepairMinCash : 0;
    if (bunker.cash < minCash) {
      logger.log(`[Auto-Repair] Cash balance $${bunker.cash.toLocaleString()} below minimum $${minCash.toLocaleString()}`);
      return;
    }

    const vesselIds = vesselsNeedingRepair.map(v => v.id);
    const costData = await gameapi.getMaintenanceCost(vesselIds);

    // Validate API response - check if all vessels have price data
    if (!costData.vessels || costData.vessels.length === 0) {
      logger.error('[Auto-Repair] API returned no vessel cost data - skipping repair');
      return;
    }

    const missingPrices = costData.vessels.filter(v => {
      const wearMaintenance = v.maintenance_data?.find(m => m.type === 'wear');
      return wearMaintenance?.price === undefined;
    });

    if (missingPrices.length > 0) {
      logger.error(`[Auto-Repair] API returned incomplete data - ${missingPrices.length} vessels missing price - skipping repair`);
      return;
    }

    if (DEBUG_MODE) {
      logger.log(`[Auto-Repair] Repair cost: $${costData.totalCost.toLocaleString()} | Cash: $${bunker.cash.toLocaleString()}`);
    }

    if (costData.totalCost === 0) {
      logger.log('[Auto-Repair] API returned $0 cost - attempting repair anyway (API bug workaround)');
    }

    // Always attempt repair if we have enough cash
    if (costData.totalCost === 0 || bunker.cash >= costData.totalCost) {
      const result = await gameapi.bulkRepairVessels(vesselIds);

      logger.log(`[Auto-Repair] Repaired ${result.count} vessels - API returned cost: $${result.totalCost.toLocaleString()}, Calculated cost: $${costData.totalCost.toLocaleString()}`);

      // Build vessel list with names, wear, and costs
      const vesselList = vesselsNeedingRepair.map(vessel => {
        // Find cost data for this vessel
        const costVessel = costData.vessels.find(v => v.id === vessel.id);
        const wearMaintenance = costVessel?.maintenance_data?.find(m => m.type === 'wear');
        const cost = wearMaintenance?.price;

        return {
          id: vessel.id,
          name: vessel.name,
          wear: vessel.wear,
          cost: cost
        };
      });

      if (broadcastToUser) {
        if (DEBUG_MODE) {
          logger.log(`[Auto-Repair] Broadcasting vessels_repaired event (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);
        }

        broadcastToUser(userId, 'vessels_repaired', {
          count: result.count,
          totalCost: costData.totalCost,
          vessels: vesselList
        });
      }

      // Log to autopilot logbook
      await logAutopilotAction(
        userId,
        'Auto-Repair',
        'SUCCESS',
        `${result.count} vessels | -$${costData.totalCost.toLocaleString()}`,
        {
          vesselCount: result.count,
          totalCost: costData.totalCost,
          repairedVessels: vesselList
        }
      );

      // Update all data to refresh repair badge count
      await tryUpdateAllData();
    } else {
      logger.log(`[Auto-Repair] Insufficient funds: need $${costData.totalCost.toLocaleString()}, have $${bunker.cash.toLocaleString()}`);
    }

  } catch (error) {
    logger.error('[Auto-Repair] Error:', error.message);

    // Log error to autopilot logbook
    await logAutopilotAction(
      userId,
      'Auto-Repair',
      'ERROR',
      `Repair failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      }
    );
  }
}

module.exports = {
  autoRepairVessels
};
