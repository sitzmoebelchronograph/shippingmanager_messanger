/**
 * @fileoverview Settings Schema and Validation
 *
 * This module defines the COMPLETE settings schema with strict validation.
 * NO FALLBACKS - if a setting is missing or invalid, the application CRASHES.
 *
 * Philosophy:
 * - Settings are REQUIRED, not optional
 * - Missing settings = HARD ERROR and application exit
 * - No silent fallbacks with || operators
 * - First run: Create settings.json with defaults
 * - Every run: Validate ALL required keys exist
 * - Invalid value: Write default and continue
 * - Missing file or unreadable: CRASH
 *
 * @module server/settings-schema
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./utils/logger');
const { getAppDataDir } = require('./config');

// Get settings directory - use APPDATA when running as .exe
const SETTINGS_DIR = process.pkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'settings')
  : path.join(__dirname, '..', 'userdata', 'settings');

/**
 * Get settings file path for a specific user.
 *
 * @param {number|null} userId - User ID (null for legacy settings.json)
 * @returns {string} Path to settings file
 */
function getSettingsFilePath(userId = null) {
  if (userId) {
    return path.join(SETTINGS_DIR, `settings-${userId}.json`);
  }
  // Legacy fallback
  return path.join(SETTINGS_DIR, 'settings.json');
}

const SETTINGS_FILE = getSettingsFilePath(); // Legacy default

/**
 * Complete settings schema with default values.
 * This is the SINGLE SOURCE OF TRUTH for all settings.
 *
 * @constant {Object}
 */
const SETTINGS_SCHEMA = {
  // General Settings
  harborFeeWarningThreshold: 50,  // Warning when harbor fee > X% of gross income (10, 20, 30, 40, 50, 60, 70, 80, 90, 99)
  minCargoUtilization: 80,  // Minimum cargo utilization percentage (applies to manual + auto depart)
  enableWeatherData: true,  // Enable weather data on map (double-click to show weather from Open-Meteo API)

  // Alert Thresholds
  fuelThreshold: 400,
  co2Threshold: 6,
  maintenanceThreshold: 5,

  // Auto-Rebuy Fuel
  autoRebuyFuel: false,
  autoRebuyFuelUseAlert: true,
  autoRebuyFuelThreshold: 450,
  autoRebuyFuelMinCash: 1000000,

  // Auto-Rebuy CO2
  autoRebuyCO2: false,
  autoRebuyCO2UseAlert: true,
  autoRebuyCO2Threshold: 7,
  autoRebuyCO2MinCash: 1000000,

  // Auto-Depart
  autoDepartAll: false,
  autoDepartUseRouteDefaults: true,
  minFuelThreshold: 100,
  minVesselUtilization: 75,  // DEPRECATED - moved to General Settings as minCargoUtilization
  autoVesselSpeed: 50,

  // Auto-Repair
  autoBulkRepair: false,
  autoBulkRepairMinCash: 500000,

  // Auto-Drydock
  autoDrydock: false,
  autoDrydockThreshold: 150,  // Send to drydock when hours_until_check <= X (options: >150, 150, 100, 75, 50, 25)
  autoDrydockType: 'major',  // Maintenance type: 'major' (100% antifouling) or 'minor' (60% antifouling)
  autoDrydockSpeed: 'minimum',  // Route speed: 'maximum' (fast, more fuel) or 'minimum' (slow, less fuel)
  autoDrydockMinCash: 500000,  // Minimum cash reserve before sending vessels to drydock

  // Auto-Campaign
  autoCampaignRenewal: false,
  autoCampaignRenewalMinCash: 12000000,

  // Auto-COOP
  autoCoopEnabled: false,

  // Autopilot State
  autopilotPaused: false,  // Persistent pause state (survives server restart)

  // Auto-Anchor Points
  // NOTE: Game API only accepts amount 1 or 10
  autoAnchorPointEnabled: false,
  autoAnchorPointAmount: 1,  // Amount to purchase: 1 or 10
  autoAnchorPointMinCash: 20000000,  // Minimum cash balance before purchasing anchor points
  pendingAnchorPoints: 0,  // Number of anchor points currently under construction (runtime state, persisted for display)

  // Auto-Negotiate Hijacking
  autoNegotiateHijacking: false,

  // Notifications
  enableDesktopNotifications: true,
  autoPilotNotifications: true,      // Master toggle for ALL autopilot notifications (in-app + desktop)

  // Barrel Boss (Fuel Auto-Rebuy) Notifications
  notifyBarrelBossInApp: true,
  notifyBarrelBossDesktop: true,

  // Atmosphere Broker (CO2 Auto-Rebuy) Notifications
  notifyAtmosphereBrokerInApp: true,
  notifyAtmosphereBrokerDesktop: true,

  // Cargo Marshal (Auto-Depart) Notifications
  notifyCargoMarshalInApp: true,
  notifyCargoMarshalDesktop: true,

  // Yard Foreman (Auto-Repair) Notifications
  notifyYardForemanInApp: true,
  notifyYardForemanDesktop: true,

  // Drydock Master (Auto-Drydock) Notifications
  notifyDrydockMasterInApp: true,
  notifyDrydockMasterDesktop: true,

  // Reputation Chief (Auto-Campaign) Notifications
  notifyReputationChiefInApp: true,
  notifyReputationChiefDesktop: true,

  // Fair Hand (Auto-COOP) Notifications
  notifyFairHandInApp: true,
  notifyFairHandDesktop: true,

  // Harbormaster (Auto-Anchor Points) Notifications
  notifyHarbormasterInApp: true,
  notifyHarbormasterDesktop: true,

  // Captain Blackbeard (Auto-Negotiate Hijacking) Notifications
  notifyCaptainBlackbeardInApp: true,
  notifyCaptainBlackbeardDesktop: true,

  // Header Update Interval (in seconds)
  headerDataInterval: 60,

  // Login Method
  loginMethod: 'not_selected', // 'not_selected', 'steam', or 'browser'

  // Chat Bot Settings
  chatbotEnabled: false,
  chatbotPrefix: '!',
  chatbotDailyForecastEnabled: false,
  chatbotDailyForecastTime: '18:00',
  chatbotAllianceCommandsEnabled: true,
  chatbotCooldownSeconds: 30,

  // Command Channel Settings (where commands can be used)
  chatbotForecastCommandEnabled: true,
  chatbotForecastAllianceEnabled: true,  // Forecast works in alliance chat
  chatbotForecastDMEnabled: true,         // Forecast works in DMs
  chatbotForecastAliases: ['prices', 'price'],  // Alternative command words

  chatbotHelpCommandEnabled: true,
  chatbotHelpAllianceEnabled: true,       // Help works in alliance chat
  chatbotHelpDMEnabled: false,            // Help does NOT work in DMs
  chatbotHelpAliases: ['commands', 'help'],  // Alternative command words

  chatbotDMCommandsEnabled: false,
  chatbotCustomCommands: [],

  // Campaign Data (cached from API)
  company_type: null  // User's company type from game API (e.g., ['container', 'tanker'])
};

/**
 * Get list of all required setting keys.
 *
 * @returns {string[]} Array of required setting keys
 */
function getRequiredKeys() {
  return Object.keys(SETTINGS_SCHEMA);
}

/**
 * Get default value for a setting key.
 *
 * @param {string} key - Setting key
 * @returns {*} Default value
 * @throws {Error} If key doesn't exist in schema
 */
function getDefault(key) {
  if (!(key in SETTINGS_SCHEMA)) {
    throw new Error(`FATAL: Setting key "${key}" does not exist in schema`);
  }
  return SETTINGS_SCHEMA[key];
}

/**
 * Get complete default settings object.
 *
 * @returns {Object} Copy of default settings
 */
function getDefaults() {
  return { ...SETTINGS_SCHEMA };
}

/**
 * Validate a single setting value and coerce to correct type.
 *
 * @param {string} key - Setting key
 * @param {*} value - Value to validate
 * @returns {*} Validated and coerced value
 */
function validateValue(key, value) {
  const defaultValue = getDefault(key);
  const defaultType = typeof defaultValue;

  // Special validation for headerDataInterval - only allow specific values (in SECONDS)
  // UI shows minutes (1, 2, 3, 4, 5, 10, 15) and stores seconds (60, 120, 180, 240, 300, 600, 900)
  if (key === 'headerDataInterval') {
    const allowedIntervals = [60, 120, 180, 240, 300, 600, 900]; // Seconds: 1min, 2min, 3min, 4min, 5min, 10min, 15min
    const parsed = parseInt(value);

    if (isNaN(parsed)) {
      throw new Error(`Invalid header data interval: "${value}" is not a number. Must be one of: 60s, 120s, 180s, 240s, 300s, 600s, 900s (1, 2, 3, 4, 5, 10, 15 minutes)`);
    }

    if (!allowedIntervals.includes(parsed)) {
      throw new Error(`Invalid header data interval: ${parsed} seconds. Must be one of: 60s, 120s, 180s, 240s, 300s, 600s, 900s (1, 2, 3, 4, 5, 10, 15 minutes)`);
    }

    return parsed;
  }

  // Special validation for maintenanceThreshold - only allow specific values (in PERCENT)
  // UI shows percentages (2%, 3%, 4%, 5%, 10%, 15%, 20%, 25%)
  if (key === 'maintenanceThreshold') {
    const allowedThresholds = [2, 3, 4, 5, 10, 15, 20, 25]; // Percent
    const parsed = parseInt(value);

    if (isNaN(parsed)) {
      throw new Error(`Invalid maintenance threshold: "${value}" is not a number. Must be one of: 2%, 3%, 4%, 5%, 10%, 15%, 20%, 25%`);
    }

    if (!allowedThresholds.includes(parsed)) {
      throw new Error(`Invalid maintenance threshold: ${parsed}%. Must be one of: 2%, 3%, 4%, 5%, 10%, 15%, 20%, 25%`);
    }

    return parsed;
  }

  if (defaultType === 'number') {
    // Remove thousand separators (commas) before parsing
    // "30,000,000" -> "30000000"
    const cleanValue = typeof value === 'string' ? value.replace(/,/g, '') : value;
    const parsed = parseInt(cleanValue);
    if (isNaN(parsed)) {
      logger.warn(`[Settings] Invalid number for "${key}": ${value}, using default: ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }

  if (defaultType === 'boolean') {
    // Handle undefined explicitly for optional booleans
    if (value === undefined && (key === 'autoRebuyFuelUseAlert' || key === 'autoRebuyCO2UseAlert' || key === 'enableDesktopNotifications' || key === 'autoPilotNotifications' || key === 'autoDepartUseRouteDefaults')) {
      return defaultValue;
    }
    return !!value;
  }

  if (defaultType === 'string') {
    return String(value);
  }

  // Handle arrays (like chatbotCustomCommands)
  if (Array.isArray(defaultValue)) {
    if (!Array.isArray(value)) {
      logger.warn(`[Settings] Invalid array for "${key}": ${value}, using default: []`);
      return defaultValue;
    }
    return value;
  }

  // Handle nullable fields (like company_type)
  if (defaultValue === null) {
    // Allow null or valid value
    if (value === null || value === undefined) {
      return null;
    }
    // For company_type, expect array of strings
    if (key === 'company_type') {
      if (Array.isArray(value)) {
        return value;
      }
      logger.warn(`[Settings] Invalid company_type: ${value}, using default: null`);
      return null;
    }
    return value;
  }

  // Handle objects (like lastAnchorPointPurchase)
  if (defaultType === 'object' && defaultValue !== null) {
    if (typeof value !== 'object' || value === null) {
      logger.warn(`[Settings] Invalid object for "${key}": ${value}, using default`);
      return defaultValue;
    }
    // Validate nested properties
    const validated = {};
    for (const prop in defaultValue) {
      if (prop in value) {
        const propType = typeof defaultValue[prop];
        if (propType === 'number') {
          const parsed = parseInt(value[prop]);
          validated[prop] = isNaN(parsed) ? defaultValue[prop] : parsed;
        } else {
          validated[prop] = value[prop];
        }
      } else {
        validated[prop] = defaultValue[prop];
      }
    }
    return validated;
  }

  throw new Error(`FATAL: Unknown type for setting "${key}": ${defaultType}`);
}

/**
 * Validate complete settings object.
 * Ensures ALL required keys exist and have valid values.
 *
 * @param {Object} settings - Settings object to validate
 * @returns {Object} Validated settings with all required keys
 * @throws {Error} Never - always returns valid settings or writes defaults
 */
function validateSettings(settings) {
  const validated = {};
  const requiredKeys = getRequiredKeys();
  let needsWrite = false;

  for (const key of requiredKeys) {
    if (!(key in settings)) {
      logger.warn(`[Settings] Missing key "${key}", using default: ${getDefault(key)}`);
      validated[key] = getDefault(key);
      needsWrite = true;
    } else {
      validated[key] = validateValue(key, settings[key]);
    }
  }

  return { validated, needsWrite };
}

/**
 * Initialize settings system.
 * - If settings.json doesn't exist: Create with defaults
 * - If settings.json exists: Validate and fill missing keys
 * - If settings.json is unreadable: CRASH
 *
 * @param {number|null} userId - User ID for user-specific settings
 * @returns {Promise<Object>} Validated settings object
 * @throws {Error} If file cannot be read or written
 */
async function initializeSettings(userId = null) {
  const settingsFile = getSettingsFilePath(userId);
  const fileLabel = userId ? `settings-${userId}.json` : 'settings.json';

  try {
    // Try to read existing file
    const data = await fs.readFile(settingsFile, 'utf8');
    const settings = JSON.parse(data);

    logger.debug(`[Settings] Loading from ${fileLabel}...`);

    // Validate and fill missing keys
    const { validated, needsWrite } = validateSettings(settings);

    if (needsWrite) {
      logger.debug('[Settings] Missing keys detected, writing complete settings...');

      // Ensure settings directory exists
      const settingsDir = path.dirname(settingsFile);
      await fs.mkdir(settingsDir, { recursive: true });

      await fs.writeFile(settingsFile, JSON.stringify(validated, null, 2), 'utf8');
      logger.debug('[Settings] Settings file updated with missing defaults');
    }

    logger.debug('[Settings] User settings loaded successfully');
    return validated;

  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist - first run
      logger.debug(`[Settings] ${fileLabel} not found, creating with defaults...`);

      // Ensure settings directory exists
      const settingsDir = path.dirname(settingsFile);
      await fs.mkdir(settingsDir, { recursive: true });

      const defaults = getDefaults();
      await fs.writeFile(settingsFile, JSON.stringify(defaults, null, 2), 'utf8');
      logger.debug(`[Settings] Created ${fileLabel} with default values`);
      return defaults;
    }

    // Any other error is FATAL
    logger.error('═══════════════════════════════════════════════════════════');
    logger.error(`FATAL ERROR: Cannot read or write ${fileLabel}`);
    logger.error('═══════════════════════════════════════════════════════════');
    logger.error('Error:', error.message);
    logger.error('Path:', settingsFile);
    logger.error('');
    logger.error('Possible causes:');
    logger.error('- File is corrupted (invalid JSON)');
    logger.error('- No read/write permissions');
    logger.error('- Disk is full');
    logger.error('');
    logger.error('Please fix the issue and restart the application.');
    logger.error('═══════════════════════════════════════════════════════════');

    // HARD CRASH
    process.exit(1);
  }
}

/**
 * Save settings to file for a specific user.
 *
 * @param {number|null} userId - User ID for user-specific settings
 * @param {Object} settings - Settings object to save
 * @returns {Promise<void>}
 */
async function saveSettings(userId, settings) {
  const settingsFile = getSettingsFilePath(userId);
  const fileLabel = userId ? `settings-${userId}.json` : 'settings.json';

  try {
    // Ensure settings directory exists
    const settingsDir = path.dirname(settingsFile);
    await fs.mkdir(settingsDir, { recursive: true });

    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    logger.debug(`[Settings] Saved to ${fileLabel}`);
  } catch (error) {
    logger.error(`[Settings] Error saving ${fileLabel}:`, error);
    throw error;
  }
}

module.exports = {
  SETTINGS_SCHEMA,
  getRequiredKeys,
  getDefault,
  getDefaults,
  validateValue,
  validateSettings,
  initializeSettings,
  saveSettings,
  getSettingsFilePath,
  SETTINGS_FILE
};
