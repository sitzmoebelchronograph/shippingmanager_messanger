/**
 * @fileoverview Autopilot Service - Main Orchestrator
 *
 * Centralized autopilot logic running on the backend.
 * Coordinates all pilot modules and manages shared state.
 *
 * Key Features:
 * - Price updates at fixed times (:01 and :31 every hour)
 * - Orchestrates 8 specialized pilot modules
 * - Badge updates (repair count, campaigns, hijacking)
 * - Main event loop coordination
 *
 * @module server/autopilot
 */

const gameapi = require('./gameapi');
const state = require('./state');
const cache = require('./cache');
const config = require('./config');
const { getUserId, apiCall } = require('./utils/api');
const logger = require('./utils/logger');
const path = require('path');
const fs = require('fs');

// Import pilot modules
const { autoRebuyFuel } = require('./autopilot/pilot_barrel_boss');
const { autoRebuyCO2 } = require('./autopilot/pilot_atmosphere_broker');
const { departVessels, autoDepartVessels, calculateRemainingDemand, getTotalCapacity } = require('./autopilot/pilot_cargo_marshal');
const { autoRepairVessels } = require('./autopilot/pilot_yard_foreman');
const { autoCampaignRenewal } = require('./autopilot/pilot_reputation_chief');
const { autoCoop } = require('./autopilot/pilot_fair_hand');
const { autoAnchorPointPurchase } = require('./autopilot/pilot_harbormaster');
const { autoNegotiateHijacking } = require('./autopilot/pilot_captain_blackbeard');

const DEBUG_MODE = config.DEBUG_MODE;

// WebSocket broadcasting function (injected by websocket.js)
let broadcastToUser = null;

/**
 * Injects WebSocket broadcasting function.
 * Called by websocket.js during initialization.
 */
function setBroadcastFunction(broadcastFn) {
  broadcastToUser = broadcastFn;
  logger.log('[Autopilot] Broadcast function set:', broadcastFn ? 'OK' : 'NULL');
}

// Global pause state
let autopilotPaused = false;

/**
 * Initializes autopilot pause state from persistent settings.
 * Called once during server startup in scheduler.js
 */
function initializeAutopilotState(userId) {
  const settings = state.getSettings(userId);
  if (settings && typeof settings.autopilotPaused === 'boolean') {
    autopilotPaused = settings.autopilotPaused;
    logger.log(`[Autopilot] Loaded pause state from settings: ${autopilotPaused ? 'PAUSED' : 'RUNNING'}`);
  } else {
    logger.log('[Autopilot] No saved pause state, defaulting to RUNNING');
  }
}

/**
 * Pauses all autopilot functions globally and saves state to settings
 */
async function pauseAutopilot() {
  autopilotPaused = true;
  logger.log('[Autopilot] PAUSED - All autopilot functions suspended');

  try {
    const userId = getUserId();
    if (userId) {
      const settings = state.getSettings(userId);
      settings.autopilotPaused = true;

      const { getSettingsFilePath } = require('./settings-schema');
      const fsPromises = require('fs').promises;
      const settingsFile = getSettingsFilePath(userId);
      await fsPromises.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      logger.log('[Autopilot] Pause state saved to settings');
    }
  } catch (error) {
    logger.error('[Autopilot] Failed to save pause state:', error);
  }
}

/**
 * Resumes all autopilot functions globally and saves state to settings
 */
async function resumeAutopilot() {
  autopilotPaused = false;
  logger.log('[Autopilot] RESUMED - All autopilot functions active');

  try {
    const userId = getUserId();
    if (userId) {
      const settings = state.getSettings(userId);
      settings.autopilotPaused = false;

      const { getSettingsFilePath } = require('./settings-schema');
      const fsPromises = require('fs').promises;
      const settingsFile = getSettingsFilePath(userId);
      await fsPromises.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      logger.log('[Autopilot] Resume state saved to settings');
    }
  } catch (error) {
    logger.error('[Autopilot] Failed to save resume state:', error);
  }
}

/**
 * Returns current autopilot pause state
 */
function isAutopilotPaused() {
  return autopilotPaused;
}

// ============================================================================
// Price Updates & Alerts
// ============================================================================

/**
 * Updates fuel and CO2 prices from API and broadcasts to all users.
 * Called by scheduler at :01 and :31 every hour (twice per hour).
 */
async function updatePrices() {
  try {
    const prices = await gameapi.fetchPrices();

    const userId = getUserId();
    if (!userId) return;

    // Update state with individual price values
    state.updatePrices(userId, prices.fuel, prices.co2, prices.eventDiscount, prices.regularFuel, prices.regularCO2);

    if (broadcastToUser) {
      broadcastToUser(userId, 'price_update', prices);
    }

    await checkPriceAlerts(userId, prices);

  } catch (error) {
    logger.error('[Prices] Failed to update prices:', error.message);
  }
}

/**
 * Checks if current prices trigger user-configured alerts.
 */
async function checkPriceAlerts(userId, prices) {
  const settings = state.getSettings(userId);
  if (!settings.enablePriceAlerts) return;

  const alerts = [];

  if (prices.fuel <= settings.fuelThreshold) {
    alerts.push({
      type: 'fuel',
      price: prices.fuel,
      threshold: settings.fuelThreshold
    });
  }

  if (prices.co2 <= settings.co2Threshold) {
    alerts.push({
      type: 'co2',
      price: prices.co2,
      threshold: settings.co2Threshold
    });
  }

  if (alerts.length > 0 && broadcastToUser) {
    broadcastToUser(userId, 'price_alerts', alerts);
  }
}

// ============================================================================
// Auto-Rebuy Orchestration
// ============================================================================

/**
 * Wrapper to rebuy both fuel and CO2.
 * Called after vessel departures and in main loop.
 */
async function autoRebuyAll() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const bunker = await gameapi.fetchBunkerState();

    await autoRebuyFuel(bunker, autopilotPaused, broadcastToUser);
    await autoRebuyCO2(bunker, autopilotPaused, broadcastToUser);

  } catch (error) {
    logger.error('[Auto-Rebuy All] Error:', error.message);
  }
}

// ============================================================================
// Badge Updates
// ============================================================================

/**
 * Updates repair count badge
 */
async function updateRepairCount() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const settings = state.getSettings(userId);
    const threshold = settings.maintenanceThreshold;

    const vessels = await gameapi.fetchVessels();
    const repairCount = vessels.filter(v => v.wear >= threshold).length;

    if (broadcastToUser) {
      broadcastToUser(userId, 'repair_count_update', {
        count: repairCount
      });
    }
  } catch (error) {
    logger.error('[Header] Failed to update repair count:', error.message);
  }
}

/**
 * Updates campaign status and triggers auto-renewal if needed.
 * EVENT-DRIVEN: Triggers auto-renewal immediately when active campaigns < 3.
 */
async function updateCampaigns() {
  logger.debug(`[Auto-Campaign] updateCampaigns() called`);
  const userId = getUserId();
  if (!userId) {
    logger.debug(`[Auto-Campaign] updateCampaigns() - No userId, returning early`);
    return;
  }

  try {
    const campaigns = await gameapi.fetchCampaigns();
    const activeCount = countActiveCampaignTypes(campaigns);

    logger.debug(`[Auto-Campaign] updateCampaigns() - Active count: ${activeCount}, Total active: ${(campaigns.active || []).length}`);
    logger.debug(`[Auto-Campaign] Active campaigns: ${JSON.stringify((campaigns.active || []).map(c => ({ name: c.name, type: c.option_name })))}`);

    if (broadcastToUser) {
      broadcastToUser(userId, 'campaign_status_update', {
        activeCount: activeCount,
        active: campaigns.active
      });
    }

    // EVENT-DRIVEN: Auto-renew immediately when campaigns drop below 3
    const settings = state.getSettings(userId);
    logger.debug(`[Auto-Campaign] autoCampaignRenewal setting: ${settings.autoCampaignRenewal}, activeCount < 3: ${activeCount < 3}`);
    if (settings.autoCampaignRenewal && activeCount < 3) {
      logger.log(`[Auto-Campaign] EVENT TRIGGERED: ${activeCount}/3 campaigns active, starting renewal`);
      await autoCampaignRenewal(campaigns, autopilotPaused, broadcastToUser, tryUpdateAllData);
    }
  } catch (error) {
    logger.error('[Header] Failed to update campaigns:', error.message);
  }
}

/**
 * Updates unread message count (DISABLED - now handled by WebSocket polling)
 */
async function updateUnreadMessages() {
  // DISABLED: Messenger polling now handled by 10-second WebSocket interval
  return;
}

/**
 * Updates vessel count badges
 */
async function updateVesselCount() {
  const userId = getUserId();
  if (!userId) return;

  try {
    const vessels = await gameapi.fetchVessels();

    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    const pending = vessels.filter(v => v.status === 'pending').length;

    if (broadcastToUser) {
      broadcastToUser(userId, 'vessel_count_update', {
        readyToDepart,
        atAnchor,
        pending
      });
    }
  } catch (error) {
    logger.error('[Header] Failed to update vessel count:', error.message);
  }
}

// ============================================================================
// All Data Update (Game State)
// ============================================================================

let updateAllDataLock = false;

/**
 * Fetches complete game state and broadcasts to all users.
 * Updates: bunker, prices, coop, stock, anchor, events, hijacking.
 */
async function updateAllData() {
  if (updateAllDataLock) {
    if (DEBUG_MODE) {
      logger.log('[UpdateAll] Skipping - already in progress (locked)');
    }
    return;
  }

  updateAllDataLock = true;

  try {
    const userId = getUserId();
    if (!userId) {
      updateAllDataLock = false;
      return;
    }

    if (DEBUG_MODE) {
      logger.log('[UpdateAll] Starting complete data fetch...');
    }

    // Fetch all data
    const gameIndexData = await apiCall('/game/index', 'POST', {});
    const user = gameIndexData.user;
    const gameSettings = gameIndexData.data.user_settings;
    const vessels = gameIndexData.data.user_vessels;
    const eventArray = gameIndexData.data.event || [];

    // Extract event data if available
    const eventData = eventArray.length > 0 ? eventArray[0] : null;

    // Additional API calls for data not in /game/index
    const [coopData, allianceData] = await Promise.all([
      fetchCoopDataCached(),
      fetchAllianceDataCached()
    ]);

    // Add coop_boost from alliance data
    if (allianceData.data?.alliance?.benefit?.coop_boost && coopData.data?.coop) {
      coopData.data.coop.coop_boost = allianceData.data.alliance.benefit.coop_boost;
    }

    // Update bunker state
    const newMaxFuel = gameSettings.max_fuel / 1000;
    const newMaxCO2 = gameSettings.max_co2 / 1000;

    const bunkerUpdate = {
      fuel: user.fuel / 1000,        // Convert kg to tons
      co2: user.co2 / 1000,          // Convert kg to tons
      cash: user.cash,
      points: user.points,
      maxFuel: newMaxFuel,
      maxCO2: newMaxCO2
    };
    state.updateBunkerState(userId, bunkerUpdate);

    if (broadcastToUser) {
      const { broadcastBunkerUpdate } = require('./websocket');
      broadcastBunkerUpdate(userId, bunkerUpdate);

      // Broadcast company_type for vessel purchase restrictions
      if (user.company_type) {
        broadcastToUser(userId, 'company_type_update', {
          company_type: user.company_type
        });
      }
    }

    // Update COOP data
    if (coopData.data?.coop && allianceData.data?.alliance) {
      const coop = coopData.data.coop;
      const coopUpdate = {
        available: coop.available,
        cap: coop.cap,
        coop_boost: coop.coop_boost
      };
      state.updateCoopData(userId, coopUpdate);

      if (broadcastToUser) {
        broadcastToUser(userId, 'coop_update', coopUpdate);
      }
    }

    // Update stock and anchor data
    const stockValue = user.stock_value;
    const stockTrend = user.stock_trend;
    const ipo = user.ipo;
    const maxAnchorPoints = gameSettings.anchor_points;
    const deliveredVessels = vessels.filter(v => v.status !== 'pending').length;
    const pendingVessels = vessels.filter(v => v.status === 'pending').length;
    const availableCapacity = maxAnchorPoints - deliveredVessels - pendingVessels;

    const anchorNextBuild = gameSettings.anchor_next_build || null;
    const now = Math.floor(Date.now() / 1000);
    // Get pending count from settings (stored during purchase)
    const settings = state.getSettings(userId);
    const pendingAnchorPoints = (anchorNextBuild && anchorNextBuild > now) ? settings.pendingAnchorPoints : 0;

    const headerUpdate = {
      stock: { value: stockValue, trend: stockTrend, ipo },
      anchor: {
        available: availableCapacity,
        max: maxAnchorPoints,
        pending: pendingAnchorPoints,
        nextBuild: anchorNextBuild
      }
    };
    state.updateHeaderData(userId, headerUpdate);

    if (broadcastToUser) {
      broadcastToUser(userId, 'header_data_update', headerUpdate);
    }

    // Update event data
    if (DEBUG_MODE) {
      logger.log('[UpdateAll] Event data:', eventData ? `Found event: ${eventData.name}` : 'No active event');
    }
    if (eventData) {
      state.updateEventData(userId, eventData);
      if (broadcastToUser) {
        broadcastToUser(userId, 'event_data_update', eventData);
      }
    }

    // Send completion event
    if (broadcastToUser) {
      broadcastToUser(userId, 'all_data_updated', { timestamp: Date.now() });
    }

    if (DEBUG_MODE) {
      logger.log('[UpdateAll] All data broadcasted successfully');
    }

  } catch (error) {
    logger.error('[UpdateAll] Failed to fetch all data:', error.message);
  } finally {
    updateAllDataLock = false;
  }
}

/**
 * Wrapper for updateAllData() that skips if locked.
 * Used by pilots to avoid blocking when update is already in progress.
 */
async function tryUpdateAllData() {
  if (updateAllDataLock) {
    if (DEBUG_MODE) {
      logger.log('[UpdateAll] Skipping tryUpdateAllData - locked');
    }
    return;
  }
  await updateAllData();
}

/**
 * Analyze vessels and determine which should depart based on profitability.
 * Shared logic used by BOTH manual and auto departure.
 */
async function analyzeVesselDepartures(allVessels, assignedPorts, settings) {
  const harbourVessels = allVessels.filter(v => v.status === 'port' && !v.is_parked);
  const toDepart = [];
  const toSkip = [];

  const vesselsByDestinationAndType = {};

  for (const vessel of harbourVessels) {
    if (!vessel.route_destination) {
      toSkip.push({
        vessel,
        reason: 'No route assigned'
      });
      continue;
    }

    if (vessel.delivery_price !== null && vessel.delivery_price > 0) {
      toSkip.push({
        vessel,
        reason: `Delivery contract active ($${vessel.delivery_price})`
      });
      continue;
    }

    const destination = vessel.route_destination;
    const type = vessel.capacity_type;
    const key = `${destination}_${type}`;

    if (!vesselsByDestinationAndType[key]) {
      vesselsByDestinationAndType[key] = [];
    }
    vesselsByDestinationAndType[key].push(vessel);
  }

  for (const key in vesselsByDestinationAndType) {
    const vessels = vesselsByDestinationAndType[key];
    const firstVessel = vessels[0];
    const vesselType = firstVessel.capacity_type;

    let destination;
    if (firstVessel.route_destination === firstVessel.current_port_code) {
      destination = firstVessel.route_origin;
    } else {
      destination = firstVessel.route_destination;
    }

    const port = assignedPorts.find(p => p.code === destination);
    if (!port) {
      vessels.forEach(v => toSkip.push({
        vessel: v,
        reason: `Port ${destination} not in assigned ports`
      }));
      continue;
    }

    const remainingDemand = calculateRemainingDemand(port, vesselType);

    if (remainingDemand <= 0) {
      vessels.forEach(v => toSkip.push({
        vessel: v,
        reason: `No demand at ${destination}`
      }));
      continue;
    }

    const sortedVessels = vessels.sort((a, b) => getTotalCapacity(b) - getTotalCapacity(a));

    for (const vessel of sortedVessels) {
      const vesselCapacity = getTotalCapacity(vessel);

      if (remainingDemand <= 0) {
        toSkip.push({
          vessel,
          reason: `No demand at ${destination}`
        });
        continue;
      }

      const cargoToLoad = Math.min(remainingDemand, vesselCapacity);
      const utilizationRate = vesselCapacity > 0 ? cargoToLoad / vesselCapacity : 0;
      const minUtilization = settings.minCargoUtilization / 100;

      if (utilizationRate < minUtilization) {
        toSkip.push({
          vessel,
          reason: `Low utilization (${(utilizationRate * 100).toFixed(0)}% < ${settings.minCargoUtilization}% min)`
        });
        continue;
      }

      toDepart.push({
        vessel,
        destination,
        cargoToLoad,
        utilizationRate,
        remainingDemand
      });
    }
  }

  return { toDepart, toSkip };
}

// ============================================================================
// Cached Data Helpers
// ============================================================================

async function fetchCoopDataCached() {
  const cached = cache.getCoopCache();
  if (cached) {
    return cached;
  }

  const data = await apiCall('/coop/get-coop-data', 'POST', {});
  cache.setCoopCache(data);
  return data;
}

async function fetchAllianceDataCached() {
  const cached = cache.getAllianceCache();
  if (cached) {
    return cached;
  }

  const data = await apiCall('/alliance/get-user-alliance', 'POST', {});
  cache.setAllianceCache(data);
  return data;
}

// ============================================================================
// Capacity Helper (for exports)
// ============================================================================

function getCachedCapacity(vessel) {
  return getTotalCapacity(vessel);
}

// ============================================================================
// Main Event Loop
// ============================================================================

const LOOP_INTERVAL = 60000;  // 60 seconds
let previousPrices = null;

/**
 * Main event-driven autopilot loop.
 * Runs every 60 seconds, checks game state, triggers autopilot functions.
 */
async function mainEventLoop() {
  const userId = getUserId();
  if (!userId) {
    setTimeout(mainEventLoop, LOOP_INTERVAL);
    return;
  }

  const settings = state.getSettings(userId);
  if (!settings) {
    setTimeout(mainEventLoop, LOOP_INTERVAL);
    return;
  }

  try {
    // Update prices EVERY loop (60 seconds)
    await updatePrices();

    // Validate data
    const prices = state.getPrices(userId);
    const bunker = state.getBunkerState(userId);

    if (!prices || prices.fuel <= 0 || prices.co2 <= 0) {
      logger.warn('[Loop] Skipping - prices not loaded yet (fuel: $' + (prices?.fuel || 0) + ', co2: $' + (prices?.co2 || 0) + ')');
      setTimeout(mainEventLoop, LOOP_INTERVAL);
      return;
    }

    if (!bunker || bunker.cash === undefined || bunker.points === undefined) {
      logger.warn('[Loop] Skipping - bunker data not loaded yet');
      setTimeout(mainEventLoop, LOOP_INTERVAL);
      return;
    }

    // Fetch vessel data for badges
    const gameIndexData = await apiCall('/game/index', 'POST', {});
    const vessels = gameIndexData.data.user_vessels;

    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    const pending = vessels.filter(v => v.status === 'pending').length;

    if (broadcastToUser) {
      broadcastToUser(userId, 'vessel_count_update', {
        readyToDepart,
        atAnchor,
        pending
      });
    }

    // Skip automation if paused
    if (autopilotPaused) {
      if (DEBUG_MODE) {
        logger.log('[Loop] Autopilot paused, skipping automation (badge update completed)');
      }
      setTimeout(mainEventLoop, LOOP_INTERVAL);
      return;
    }

    // Auto-rebuy runs EVERY loop
    await autoRebuyAll();

    // Vessels ready to depart
    if (settings.autoDepartAll && readyToDepart > 0) {
      logger.log(`[Loop] ${readyToDepart} vessel(s) ready to depart`);
      await autoDepartVessels(autopilotPaused, broadcastToUser, autoRebuyAll, tryUpdateAllData);
    }

    // Vessels need repair
    const needsRepair = vessels.filter(v => v.wear >= settings.maintenanceThreshold).length;
    if (settings.autoBulkRepair && needsRepair > 0) {
      logger.log(`[Loop] ${needsRepair} vessel(s) need repair`);
      await autoRepairVessels(autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // COOP targets available
    if (settings.autoCoopEnabled) {
      const coopData = await fetchCoopDataCached();
      const available = coopData.data?.coop?.available;
      if (available > 0) {
        logger.log(`[Loop] ${available} COOP target(s) available`);
        await autoCoop(autopilotPaused, broadcastToUser, tryUpdateAllData);
      }
    }

    // Hijacking cases
    if (settings.autoNegotiateHijacking) {
      await autoNegotiateHijacking(autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // Anchor point purchase
    if (settings.autoAnchorPointEnabled) {
      await autoAnchorPointPurchase(userId, autopilotPaused, broadcastToUser, tryUpdateAllData);
    }

    // Campaign status update and auto-renewal
    await updateCampaigns();

  } catch (error) {
    logger.error('[Loop] FATAL ERROR in main event loop:', error);
    logger.error('[Loop] Stack trace:', error.stack);
    logger.error('[Loop] Application will exit due to fatal error in main loop');
    process.exit(1);
  }

  setTimeout(mainEventLoop, LOOP_INTERVAL);
}

/**
 * Starts the main event loop.
 */
function startMainEventLoop() {
  logger.log('[Loop] Starting main event loop (60s interval)');
  mainEventLoop();
}

/**
 * Counts active campaign types (reputation, awareness, green).
 */
function countActiveCampaignTypes(campaigns) {
  const active = campaigns.active;
  const activeTypes = new Set(active.map(c => c.option_name));
  const requiredTypes = ['reputation', 'awareness', 'green'];
  return requiredTypes.filter(type => activeTypes.has(type)).length;
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  setBroadcastFunction,
  initializeAutopilotState,
  pauseAutopilot,
  resumeAutopilot,
  isAutopilotPaused,
  updatePrices,
  checkPriceAlerts,
  autoRebuyFuel,
  autoRebuyCO2,
  autoRebuyAll,
  departVessels,
  autoDepartVessels,
  autoRepairVessels,
  autoCoop,
  autoAnchorPointPurchase,
  autoNegotiateHijacking,
  autoCampaignRenewal,
  updateRepairCount,
  updateCampaigns,
  updateUnreadMessages,
  updateAllData,
  tryUpdateAllData,
  updateVesselCount,
  getCachedCapacity,
  analyzeVesselDepartures,
  calculateRemainingDemand,
  getTotalCapacity,
  startMainEventLoop
};
