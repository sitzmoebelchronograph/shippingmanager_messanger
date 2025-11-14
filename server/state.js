/**
 * @fileoverview State Management Module
 *
 * In-memory state management for autopilot features.
 * Stores state including bunker levels, prices, settings, and alert tracking.
 *
 * Why In-Memory:
 * - Fast access (no DB queries)
 * - Simple implementation
 * - State rebuilt from game API on server restart
 *
 * Multi-Account Support:
 * - Supports switching between different game accounts (via start.py)
 * - Each game account has isolated state stored in Map<gameUserId, UserState>
 * - gameUserId is the user.id from shippingmanager.cc API (e.g., 1234567, 7654321)
 * - Account switching automatically uses correct state (no manual clearing needed)
 * - No data leakage between different game accounts
 *
 * State Structure:
 * - bunker: Current fuel, CO2, cash, and capacity levels
 * - prices: Latest fuel/CO2 prices (updated at :01 and :31)
 * - lastAlerts: Last price that triggered an alert (prevents duplicate alerts)
 * - settings: User's autopilot settings (loaded from localStorage via WebSocket)
 *
 * @module server/state
 */

/**
 * Multi-account state storage.
 * Maps game user ID (from shippingmanager.cc API) to state object.
 * @type {Map<string, UserState>}
 */
const userStates = new Map();

/**
 * @typedef {Object} BunkerState
 * @property {number} fuel - Current fuel in tons
 * @property {number} co2 - Current CO2 certificates in tons
 * @property {number} cash - Current cash balance
 * @property {number} maxFuel - Maximum fuel capacity in tons
 * @property {number} maxCO2 - Maximum CO2 capacity in tons
 */

/**
 * @typedef {Object} PriceState
 * @property {number} fuel - Current fuel price ($/ton)
 * @property {number} co2 - Current CO2 price ($/ton)
 * @property {number} timestamp - Unix timestamp when prices were fetched
 */

/**
 * @typedef {Object} AlertState
 * @property {number|null} fuel - Last fuel price that triggered alert (null if no alert sent)
 * @property {number|null} co2 - Last CO2 price that triggered alert (null if no alert sent)
 */

/**
 * @typedef {Object} UserSettings
 * @property {boolean} autoRebuyFuel - Enable auto-rebuy fuel
 * @property {boolean} autoRebuyCO2 - Enable auto-rebuy CO2
 * @property {boolean} autoDepartAll - Enable auto-depart vessels
 * @property {boolean} autoBulkRepair - Enable auto-bulk repair
 * @property {boolean} autoCampaignRenewal - Enable auto-campaign renewal
 * @property {number} fuelThreshold - Fuel price alert threshold ($/ton)
 * @property {number} co2Threshold - CO2 price alert threshold ($/ton)
 * @property {number} fuelTargetPercent - Target fuel level percentage (0-100)
 * @property {number} co2TargetPercent - Target CO2 level percentage (0-100)
 * @property {number} autoDepartInterval - Auto-depart interval in minutes (1, 2, 3, 5, 10, or 15)
 * @property {boolean} enableDesktopNotifications - Enable browser notifications
 */

/**
 * @typedef {Object} UserState
 * @property {BunkerState} bunker - Current bunker state
 * @property {PriceState} prices - Current market prices
 * @property {AlertState} lastAlerts - Last alert prices (prevents duplicates)
 * @property {UserSettings} settings - User's autopilot settings
 */

/**
 * Gets user state for specific userId, creating default state if not initialized.
 * Each user has isolated state in the Map.
 *
 * @param {string|number} userId - User ID (will be converted to string)
 * @returns {UserState} User's state object
 */
function getUserState(userId) {
  // CRITICAL: Always convert userId to string for consistent Map keys
  // API returns number, but we need string for consistent lookups
  const userIdString = String(userId);

  if (!userStates.has(userIdString)) {
    userStates.set(userIdString, {
      bunker: {
        fuel: 0,
        co2: 0,
        cash: 0,
        maxFuel: 0,
        maxCO2: 0
      },
      prices: {
        fuel: 0,
        co2: 0,
        timestamp: 0
      },
      lastAlerts: {
        fuel: null,
        co2: null
      },
      settings: null,  // Will be loaded from file via initializeSettings() - NO DEFAULTS HERE!
      autopilotState: {},
      vesselCounts: null,
      repairCount: null,
      drydockCount: null,
      campaignStatus: null,
      coopData: null,
      headerData: null,
      eventData: null,
      locks: {
        depart: false,
        fuelPurchase: false,
        co2Purchase: false,
        repair: false,
        bulkBuy: false,
        drydock: false
      }
    });
  }
  return userStates.get(userIdString);
}

/**
 * Updates bunker state.
 *
 * @param {string} userId - User ID
 * @param {BunkerState} bunker - New bunker state
 */
function updateBunkerState(userId, bunker) {
  const state = getUserState(userId);
  state.bunker = { ...state.bunker, ...bunker };
}

/**
 * Gets current bunker state.
 *
 * @param {string} userId - User ID
 * @returns {BunkerState} Current bunker state
 */
function getBunkerState(userId) {
  return getUserState(userId).bunker;
}

/**
 * Updates market prices.
 *
 * @param {string} userId - User ID
 * @param {number} fuelPrice - New fuel price ($/ton)
 * @param {number} co2Price - New CO2 price ($/ton)
 * @param {Object} [eventDiscount] - Event discount info {percentage, type}
 * @param {number} [regularFuel] - Regular fuel price before discount
 * @param {number} [regularCO2] - Regular CO2 price before discount
 */
function updatePrices(userId, fuelPrice, co2Price, eventDiscount = null, regularFuel = null, regularCO2 = null) {
  const state = getUserState(userId);
  state.prices = {
    fuel: fuelPrice,
    co2: co2Price,
    eventDiscount: eventDiscount,
    regularFuel: regularFuel,
    regularCO2: regularCO2,
    timestamp: Date.now()
  };
}

/**
 * Gets current market prices.
 *
 * @param {string} userId - User ID
 * @returns {PriceState} Current market prices
 */
function getPrices(userId) {
  return getUserState(userId).prices;
}

/**
 * Updates autopilot settings.
 *
 * @param {string} userId - User ID
 * @param {Partial<UserSettings>} settings - Settings to update (partial or full object)
 */
function updateSettings(userId, settings) {
  const state = getUserState(userId);
  // First load: settings is null, set directly
  // Subsequent updates: merge with existing settings
  state.settings = state.settings === null ? settings : { ...state.settings, ...settings };
}

/**
 * Gets autopilot settings.
 *
 * @param {string} userId - User ID
 * @returns {UserSettings} Current settings
 * @throws {Error} If settings have not been loaded yet
 */
function getSettings(userId) {
  const settings = getUserState(userId).settings;
  if (settings === null) {
    throw new Error(`FATAL: Settings not loaded for user ${userId}. Settings must be initialized via updateSettings() before use.`);
  }
  return settings;
}

/**
 * Sets last fuel alert price (prevents duplicate alerts).
 *
 * @param {string} userId - User ID
 * @param {number} price - Fuel price that triggered alert
 */
function setLastFuelAlert(userId, price) {
  const state = getUserState(userId);
  state.lastAlerts.fuel = price;
}

/**
 * Gets last fuel alert price.
 *
 * @param {string} userId - User ID
 * @returns {number|null} Last fuel price that triggered alert
 */
function getLastFuelAlert(userId) {
  return getUserState(userId).lastAlerts.fuel;
}

/**
 * Sets last CO2 alert price (prevents duplicate alerts).
 *
 * @param {string} userId - User ID
 * @param {number} price - CO2 price that triggered alert
 */
function setLastCO2Alert(userId, price) {
  const state = getUserState(userId);
  state.lastAlerts.co2 = price;
}

/**
 * Gets last CO2 alert price.
 *
 * @param {string} userId - User ID
 * @returns {number|null} Last CO2 price that triggered alert
 */
function getLastCO2Alert(userId) {
  return getUserState(userId).lastAlerts.co2;
}

/**
 * Gets autopilot monitoring state for change detection.
 * Used to track previous values and detect changes.
 *
 * @param {string} userId - User ID
 * @returns {Object} Previous autopilot state
 */
function getAutopilotState(userId) {
  const state = getUserState(userId);
  return state.autopilotState || {};
}

/**
 * Sets autopilot monitoring state for change detection.
 *
 * @param {string} userId - User ID
 * @param {Object} autopilotState - Current autopilot state
 */
function setAutopilotState(userId, autopilotState) {
  const state = getUserState(userId);
  state.autopilotState = autopilotState;
}

/**
 * Sets autopilot paused state.
 * When paused, the autopilot monitor still runs but skips all actions.
 * Header updates continue to run normally.
 *
 * @param {string} userId - User ID
 * @param {boolean} paused - True to pause, false to resume
 */
function setAutopilotPaused(userId, paused) {
  const state = getUserState(userId);
  if (!state.autopilotState) {
    state.autopilotState = {};
  }
  state.autopilotState.paused = paused;
}

/**
 * Checks if autopilot is currently paused.
 *
 * @param {string} userId - User ID
 * @returns {boolean} True if paused, false if running
 */
function isAutopilotPaused(userId) {
  const state = getUserState(userId);
  return state.autopilotState?.paused || false;
}

/**
 * Updates vessel counts.
 * @param {string} userId - User ID
 * @param {Object} counts - Vessel counts {readyToDepart, atAnchor, pending}
 */
function updateVesselCounts(userId, counts) {
  const state = getUserState(userId);
  state.vesselCounts = counts;
}

/**
 * Gets vessel counts.
 * @param {string} userId - User ID
 * @returns {Object|null} Vessel counts
 */
function getVesselCounts(userId) {
  return getUserState(userId).vesselCounts;
}

/**
 * Updates repair count.
 * @param {string} userId - User ID
 * @param {number} count - Number of vessels needing repair
 */
function updateRepairCount(userId, count) {
  const state = getUserState(userId);
  state.repairCount = count;
}

/**
 * Gets repair count.
 * @param {string} userId - User ID
 * @returns {number|null} Repair count
 */
function getRepairCount(userId) {
  return getUserState(userId).repairCount;
}

/**
 * Updates drydock count.
 * @param {string} userId - User ID
 * @param {number} count - Number of vessels in drydock
 */
function updateDrydockCount(userId, count) {
  const state = getUserState(userId);
  state.drydockCount = count;
}

/**
 * Gets drydock count.
 * @param {string} userId - User ID
 * @returns {number|null} Drydock count
 */
function getDrydockCount(userId) {
  return getUserState(userId).drydockCount;
}

/**
 * Updates campaign status.
 * @param {string} userId - User ID
 * @param {Object} status - Campaign status {activeCount}
 */
function updateCampaignStatus(userId, status) {
  const state = getUserState(userId);
  state.campaignStatus = status;
}

/**
 * Gets campaign status.
 * @param {string} userId - User ID
 * @returns {Object|null} Campaign status
 */
function getCampaignStatus(userId) {
  return getUserState(userId).campaignStatus;
}

/**
 * Updates COOP data.
 * @param {string} userId - User ID
 * @param {Object} data - COOP data {available, cap, coop_boost}
 */
function updateCoopData(userId, data) {
  const state = getUserState(userId);
  state.coopData = data;
}

/**
 * Gets COOP data.
 * @param {string} userId - User ID
 * @returns {Object|null} COOP data
 */
function getCoopData(userId) {
  return getUserState(userId).coopData;
}

/**
 * Updates header data.
 * @param {string} userId - User ID
 * @param {Object} data - Header data {stock, anchor}
 */
function updateHeaderData(userId, data) {
  const state = getUserState(userId);
  state.headerData = data;
}

/**
 * Gets header data.
 * @param {string} userId - User ID
 * @returns {Object|null} Header data
 */
function getHeaderData(userId) {
  return getUserState(userId).headerData;
}

/**
 * Updates event data.
 * @param {string} userId - User ID
 * @param {Object} data - Event data
 */
function updateEventData(userId, data) {
  const state = getUserState(userId);
  state.eventData = data;
}

/**
 * Gets event data.
 * @param {string} userId - User ID
 * @returns {Object|null} Event data
 */
function getEventData(userId) {
  return getUserState(userId).eventData;
}

/**
 * Gets lock status for a specific operation.
 *
 * @param {string} userId - User ID
 * @param {string} lockType - Lock type ('depart', 'fuelPurchase', 'co2Purchase', 'repair', 'bulkBuy')
 * @returns {boolean} Lock status
 */
function getLockStatus(userId, lockType) {
  const state = getUserState(userId);
  return state.locks[lockType] || false;
}

/**
 * Sets lock status for a specific operation.
 *
 * @param {string} userId - User ID
 * @param {string} lockType - Lock type ('depart', 'fuelPurchase', 'co2Purchase', 'repair', 'bulkBuy')
 * @param {boolean} locked - Lock status
 */
function setLockStatus(userId, lockType, locked) {
  const state = getUserState(userId);
  state.locks[lockType] = locked;
}

/**
 * Gets all lock statuses for a user.
 *
 * @param {string} userId - User ID
 * @returns {Object} All lock statuses
 */
function getAllLocks(userId) {
  return getUserState(userId).locks;
}

module.exports = {
  getUserState,
  updateBunkerState,
  getBunkerState,
  updatePrices,
  getPrices,
  updateSettings,
  getSettings,
  setLastFuelAlert,
  getLastFuelAlert,
  setLastCO2Alert,
  getLastCO2Alert,
  getAutopilotState,
  setAutopilotState,
  setAutopilotPaused,
  isAutopilotPaused,
  updateVesselCounts,
  getVesselCounts,
  updateRepairCount,
  getRepairCount,
  updateDrydockCount,
  getDrydockCount,
  updateCampaignStatus,
  getCampaignStatus,
  updateCoopData,
  getCoopData,
  updateHeaderData,
  getHeaderData,
  updateEventData,
  getEventData,
  getLockStatus,
  setLockStatus,
  getAllLocks
};
