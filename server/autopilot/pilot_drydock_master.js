/**
 * @fileoverview Drydock Master - Auto Drydock Pilot
 *
 * Automatically sends vessels to drydock when hours_until_check reaches threshold.
 * Respects minimum cash balance requirements.
 *
 * @module server/autopilot/pilot_drydock_master
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId, apiCall } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Auto send vessels to drydock based on hours_until_check threshold.
 *
 * Decision Logic:
 * 1. Fetches all vessels and filters by hours_until_check <= autoDrydockThreshold
 * 2. Checks minimum cash balance requirement
 * 3. Sends all eligible vessels to drydock using configured type/speed
 * 4. Broadcasts drydock notification with vessel list
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoDrydockVessels(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[Auto-Drydock] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoDrydock) {
    logger.debug('[Auto-Drydock] Feature disabled in settings');
    return;
  }

  try {
    const threshold = settings.autoDrydockThreshold;
    const maintenanceType = settings.autoDrydockType || 'major';
    const speed = settings.autoDrydockSpeed || 'minimum';

    const bunker = await gameapi.fetchBunkerState();
    const vessels = await gameapi.fetchVessels();

    // Filter vessels that need drydock
    // Skip vessels that already have drydock scheduled (next_route_is_maintenance = true)
    const vesselsNeedingDrydock = vessels.filter(v => {
      const hours = v.hours_until_check !== undefined ? v.hours_until_check : 999;
      const alreadyScheduled = v.next_route_is_maintenance === true;
      return hours <= threshold && !alreadyScheduled;
    });

    logger.debug(`[Auto-Drydock] Found ${vesselsNeedingDrydock.length} vessels with hours_until_check <= ${threshold}`);

    if (vesselsNeedingDrydock.length === 0) {
      logger.debug('[Auto-Drydock] No vessels need drydock');
      return;
    }

    const vesselIds = vesselsNeedingDrydock.map(v => v.id);

    logger.debug(`[Auto-Drydock] Fetching cost preview for ${vesselIds.length} vessels`);

    // Fetch cost preview before executing
    const costPreview = await apiCall('/maintenance/get', 'POST', {
      vessel_ids: JSON.stringify(vesselIds),
      speed,
      maintenance_type: maintenanceType
    });

    // Extract costs per vessel based on maintenance type
    const vesselCosts = new Map();
    let totalCost = 0;

    if (costPreview?.data?.vessels) {
      for (const vesselData of costPreview.data.vessels) {
        const maintenanceData = vesselData.maintenance_data;
        if (maintenanceData) {
          // Find the correct maintenance type (drydock_major or drydock_minor)
          const maintenanceKey = maintenanceType === 'major' ? 'drydock_major' : 'drydock_minor';
          const maintenance = maintenanceData.find(m => m.type === maintenanceKey);

          if (maintenance) {
            const cost = maintenance.discounted_price || maintenance.price || 0;
            vesselCosts.set(vesselData.id, cost);
            totalCost += cost;
          }
        }
      }
    }

    logger.debug(`[Auto-Drydock] Total cost: $${totalCost.toLocaleString()}`);

    // Check minimum cash balance AFTER deducting costs
    const minCash = settings.autoDrydockMinCash !== undefined ? settings.autoDrydockMinCash : 0;
    const cashAfterDrydock = bunker.cash - totalCost;

    if (cashAfterDrydock < minCash) {
      logger.warn(`[Auto-Drydock] Insufficient funds: Current $${bunker.cash.toLocaleString()} - Cost $${totalCost.toLocaleString()} = $${cashAfterDrydock.toLocaleString()} (below minimum $${minCash.toLocaleString()})`);
      return;
    }
    logger.debug(`[Auto-Drydock] Sending ${vesselIds.length} vessels to drydock (type: ${maintenanceType}, speed: ${speed})`);

    // Send to drydock
    await apiCall('/maintenance/do-major-drydock-maintenance-bulk', 'POST', {
      vessel_ids: JSON.stringify(vesselIds),
      speed,
      maintenance_type: maintenanceType
    });

    logger.info(`[Auto-Drydock] Sent ${vesselIds.length} vessels to drydock (Total cost: $${totalCost.toLocaleString()})`);

    // Build vessel list with names, hours, and costs
    const vesselList = vesselsNeedingDrydock.map(vessel => {
      const hours = vessel.hours_until_check !== undefined ? vessel.hours_until_check : 999;
      const cost = vesselCosts.get(vessel.id) || 0;
      return {
        id: vessel.id,
        name: vessel.name,
        hours_until_check: hours,
        route_destination: vessel.route_destination || 'None',
        cost: cost
      };
    });

    if (broadcastToUser) {
      logger.debug(`[Auto-Drydock] Broadcasting vessels_drydocked event (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);

      broadcastToUser(userId, 'vessels_drydocked', {
        count: vesselIds.length,
        maintenanceType,
        speed,
        totalCost: totalCost,
        vessels: vesselList
      });
    }

    // Log to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.VESSEL,
      'Auto-Drydock',
      `${vesselIds.length} vessels | ${maintenanceType} | ${speed} | ${formatCurrency(totalCost)}`,
      {
        vesselCount: vesselIds.length,
        maintenanceType,
        speed,
        totalCost: totalCost,
        drydockedVessels: vesselList
      },
      'SUCCESS',
      SOURCES.AUTOPILOT
    );

    // Update all data to refresh drydock badge count
    await tryUpdateAllData();

    // Force immediate drydock count update (in case tryUpdateAllData was skipped due to lock)
    const { updateDrydockCount } = require('../autopilot');
    await updateDrydockCount();

  } catch (error) {
    logger.error('[Auto-Drydock] Error:', error.message);

    // Log error to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.VESSEL,
      'Auto-Drydock',
      `Drydock failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoDrydockVessels
};
