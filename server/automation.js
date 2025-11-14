/**
 * @fileoverview Backend Automation System
 *
 * Runs server-side automation tasks with configurable intervals:
 * - Auto-Repair: Repairs vessels based on settings (interval from settings)
 *
 * Why Backend:
 * - Runs even when browser is closed
 * - More reliable timing (not affected by browser sleep/throttling)
 * - Centralized control for all users
 *
 * @module server/automation
 */

const { apiCall } = require('./utils/api');
const fs = require('fs').promises;
const path = require('path');
const { broadcast } = require('./websocket');
const { getSettingsDir } = require('./config');

const SETTINGS_FILE = path.join(getSettingsDir(), 'settings.json');

// Auto-repair timer
let autoRepairTimer = null;

/**
 * Parse interval string to get min/max hours
 * @param {string} interval - Format: "2-3" or "6-12"
 * @returns {Object} {min: number, max: number} in milliseconds
 */
function parseInterval(interval) {
  const [min, max] = interval.split('-').map(Number);
  return {
    min: min * 60 * 60 * 1000, // Convert hours to ms
    max: max * 60 * 60 * 1000
  };
}

/**
 * Get random interval within range
 * @param {string} intervalStr - Format: "2-3"
 * @returns {number} Random milliseconds within range
 */
function getRandomInterval(intervalStr) {
  const { min, max } = parseInterval(intervalStr);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Load settings from file
 * @returns {Promise<Object>} Settings object
 */
async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[Backend Automation] Failed to load settings:', error);
    return {
      autoBulkRepair: false,
      autoRepairInterval: '2-3',
      maintenanceThreshold: 10
    };
  }
}

/**
 * Auto-repair vessels below maintenance threshold
 */
async function runAutoRepair() {
  try {
    const settings = await loadSettings();

    if (!settings.autoBulkRepair) {
      return;
    }

    // Get all vessels
    const vesselsData = await apiCall('/game/index', 'POST', {});
    if (!vesselsData?.vessels) {
      console.error('[Backend Auto-Repair] No vessel data');
      return;
    }

    const vessels = vesselsData.vessels;

    // Filter vessels that need repair (wear > 0 and not being delivered)
    const vesselsToRepair = vessels.filter(v => {
      const wear = parseInt(v.wear);
      const isDelivery = v.delivery_price !== null && v.delivery_price > 0;
      return wear > 0 && !isDelivery;
    });

    if (vesselsToRepair.length === 0) {
      return;
    }

    // Get maintenance cost
    const vesselIds = vesselsToRepair.map(v => v.id);
    const costData = await apiCall('/maintenance/get', 'POST', {
      user_vessel_ids: vesselIds
    });

    let totalCost = 0;
    const repairDetails = [];

    if (costData.data?.vessels) {
      costData.data.vessels.forEach(vessel => {
        const wearMaintenance = vessel.maintenance_data?.find(m => m.type === 'wear');
        if (wearMaintenance) {
          const vesselInfo = vesselsToRepair.find(v => v.id === vessel.id);
          const wear = parseInt(vesselInfo?.wear);
          totalCost += wearMaintenance.price;
          repairDetails.push({
            name: vesselInfo?.name || `Vessel ${vessel.id}`,
            wear: wear,
            cost: wearMaintenance.price
          });
        }
      });
    }

    // Check if we have enough cash
    const userSettings = await apiCall('/user/get-user-settings', 'POST', {});
    const currentCash = userSettings.user?.cash;

    if (totalCost > currentCash) {
      return;
    }

    // Perform repair
    const result = await apiCall('/maintenance/do-wear-maintenance-bulk', 'POST', {
      user_vessel_ids: vesselIds
    });

    if (result.success || result.data) {
      // Broadcast to all connected clients
      const message = `🔧 Backend Auto-Repair: ${repairDetails.length} vessel(s) repaired for $${totalCost.toLocaleString()}`;
      broadcast('auto_repair_complete', {
        count: repairDetails.length,
        totalCost: totalCost,
        repairs: repairDetails,
        message: message
      });
    }
  } catch (error) {
    console.error('[Backend Auto-Repair] Error:', error);
  }
}

/**
 * Schedule next auto-repair check
 */
function scheduleAutoRepair() {
  if (autoRepairTimer) {
    clearTimeout(autoRepairTimer);
  }

  loadSettings().then(settings => {
    if (!settings.autoBulkRepair) {
      return;
    }

    const interval = getRandomInterval(settings.autoRepairInterval || '2-3');

    autoRepairTimer = setTimeout(async () => {
      await runAutoRepair();
      scheduleAutoRepair(); // Schedule next check
    }, interval);
  });
}

/**
 * Initialize backend automation
 */
function initialize() {
  scheduleAutoRepair();
}

/**
 * Restart auto-repair timer (called when settings change)
 */
function restartAutoRepair() {
  scheduleAutoRepair();
}

module.exports = {
  initialize,
  restartAutoRepair
};
