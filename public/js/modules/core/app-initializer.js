/**
 * @fileoverview Application initializer module.
 * Orchestrates the initialization sequence and loads initial data.
 *
 * @module core/app-initializer
 */

import { loadSettings, registerServiceWorker, initCustomTooltips, updatePageTitle, requestNotificationPermission } from '../utils.js';
import { setUserStoragePrefix, getStorage, setStorage } from './storage-manager.js';
import { loadCache, saveBadgeCache, updateCoopDisplay } from './badge-cache.js';
import { createDebouncedFunction } from './debounced-api.js';
import { handleSettingsUpdate, toggleAutoPilotAgentCheckboxes } from './settings-sync.js';
import { initAutopilotControls, loadAutopilotState, triggerPriceAlertCheck } from './websocket-client.js';
import { initVersionChecker, initVisibilityHandler, initNotificationButtonUpdater, preloadAllImages } from './auto-refresh.js';
import { exportApiUrl, exportDebugMode, exportCacheKeys, exportStorageFunctions, exportDebouncedFunctions, exportSettingsHandler, exportAutopilotFunctions, exportVersionFunctions, exportOverlayFunctions, exportLogbookHandler } from './global-exports.js';
import * as eventRegistry from './event-registry.js';

import { updateBunkerStatus, buyMaxFuel, buyMaxCO2, setCapacityFromBunkerUpdate } from '../bunker-management.js';
import { updateVesselCount, updateRepairCount, departAllVessels, openRepairAndDrydockDialog, loadAcquirableVessels, showPendingVessels, showShoppingCart, lockDepartButton, unlockDepartButton, isDepartInProgress } from '../vessel-management.js';
import { openSellVesselsOverlay, closeSellVesselsOverlay, setSellFilter, showSellCart } from '../vessel-selling.js';
import { loadMessages, sendMessage, handleMessageInput, loadAllianceMembers, initWebSocket, setChatScrollListener, markAllianceChatAsRead } from '../chat.js';
import { openMessenger, openNewChat, closeMessenger, closeChatSelection, showAllChats, closeAllChats, updateUnreadBadge, sendPrivateMessage, getCurrentPrivateChat, deleteCurrentChat } from '../messenger.js';
import { openHijackingInbox, closeHijackingInbox, updateHijackingBadge, updateHijackedVesselsDisplay } from '../hijacking.js';
import { showSettings, closeSettings, showCampaignsOverlay, closeCampaignsOverlay, buyCampaign, showContactList, closeContactList, showAnchorInfo } from '../ui-dialogs.js';
import { closeCoopOverlay, sendCoopMax } from '../coop.js';
import { showAllianceCoopOverlay, closeAllianceCoopOverlay, initAllianceTabs, updateCoopTabBadge, showAllAllianceUI, hideAllAllianceUI, switchTab, clearAllianceTabCache } from '../alliance-tabs.js';
import { initForecastCalendar, updateEventDiscount } from '../forecast-calendar.js';
import { initEventInfo } from '../event-info.js';
import { initLogbook, prependLogEntry } from '../logbook.js';
import { initHarborMap } from '../harbor-map-init.js';
import { initCompanyProfile } from '../company-profile.js';
import { showSideNotification, showNotification } from '../utils.js';

/**
 * Format number with thousand separators.
 * @param {number|string} value - Number to format
 * @returns {string} Formatted number
 */
function formatNumberWithSeparator(value) {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat('en-US', {
    useGrouping: true,
    maximumFractionDigits: 0
  }).format(num);
}

/**
 * Initialize the application.
 * This is the main entry point that orchestrates all initialization steps.
 *
 * @param {string} apiPrefix - API prefix for all requests
 * @returns {Promise<Object>} Initialized settings object
 */
export async function initializeApp(apiPrefix) {
  // Export API URL helper globally
  exportApiUrl(apiPrefix);

  // Export debug mode (will be updated after settings load)
  exportDebugMode(false);

  // Export storage functions globally
  exportStorageFunctions({ getStorage, setStorage });

  // STEP 1: Load Settings
  console.log('[Init] Loading settings...');
  const settings = await loadSettings();
  window.settings = settings;

  // Update debug mode from settings
  if (settings.debugMode !== undefined) {
    window.DEBUG_MODE = settings.debugMode;
    if (window.DEBUG_MODE) {
      console.log('[Debug] Debug Mode ENABLED - verbose logging active');
    }
  }

  // STEP 1.5: Set per-user storage prefix
  if (settings.userId) {
    setUserStoragePrefix(settings.userId);
    const cacheKey = `badgeCache_${settings.userId}`;
    exportCacheKeys(cacheKey, settings.userId);

    if (window.DEBUG_MODE) {
      console.log(`[Cache] Using per-user cache key: ${cacheKey}`);
    }
  }

  // Initialize UI with loaded settings
  initializeSettingsUI(settings);

  // Load user settings (CEO level, points)
  await loadUserSettings();

  // STEP 2: Register Service Worker
  await registerServiceWorker();

  // STEP 3: Initialize Custom Tooltips
  initCustomTooltips();

  // STEP 4: Create debounced functions
  const debouncedFunctions = createDebouncedFunctions(settings);
  exportDebouncedFunctions(debouncedFunctions);

  // STEP 5: Export settings handler
  const settingsUpdateHandler = (newSettings) => {
    return handleSettingsUpdate(newSettings, settings, debouncedFunctions.repair);
  };
  exportSettingsHandler(settingsUpdateHandler);

  // STEP 6: Initialize autopilot controls
  const autopilotControls = initAutopilotControls(
    getStorage,
    setStorage,
    showSideNotification,
    window.apiUrl
  );
  exportAutopilotFunctions(autopilotControls);

  // Load autopilot state from cache
  loadAutopilotState(autopilotControls.updateButton, getStorage);

  // STEP 7: Export logbook handler
  exportLogbookHandler(prependLogEntry);

  // STEP 8: Register event listeners
  registerAllEventListeners(settings, debouncedFunctions);

  // STEP 9: Initialize modules
  initEventInfo();
  initLogbook();
  initCompanyProfile();
  initAllianceTabs();

  // Initialize harbor map (async, don't block)
  initHarborMap().catch(error => {
    console.error('[Init] Failed to initialize harbor map:', error);
  });

  // STEP 10: Load cached data
  if (window.DEBUG_MODE) {
    console.log('[Init] Loading cached values...');
  }
  loadCache(settings);
  if (window.DEBUG_MODE) {
    console.log('[Init] Cached values displayed - waiting for WebSocket to send fresh data');
  }

  // Trigger price alert check
  await triggerPriceAlertCheck(window.DEBUG_MODE);

  // STEP 11: Load initial data
  await loadInitialData();

  // STEP 12: Initialize WebSocket
  initWebSocket();

  // STEP 13: Update page title
  updatePageTitle(settings);

  // STEP 14: Start background preloading
  preloadAllImages(window.DEBUG_MODE);

  // STEP 15: Initialize version checker
  const versionFunctions = initVersionChecker(window.apiUrl, window.DEBUG_MODE);
  exportVersionFunctions(versionFunctions);

  // STEP 16: Initialize page visibility handler
  const chatFeed = document.getElementById('chatFeed');
  initVisibilityHandler(loadMessages, chatFeed, window.DEBUG_MODE);

  // STEP 17: Initialize notification button updater
  initNotificationButtonUpdater();

  // STEP 18: Auto-request notification permission
  if ("Notification" in window && Notification.permission === "default") {
    await requestNotificationPermission();
  }

  // Export overlay functions
  exportOverlayFunctions({
    showSettings: () => showSettings(settings),
    showAllianceChat: createAllianceChatHandler(),
    showDocs: () => window.open('/docs/index.html', '_blank'),
    showForecast: createForecastHandler(),
    showBuyVessels: createBuyVesselsHandler(settings)
  });

  // Expose global functions for backward compatibility
  exposeGlobalFunctions(settings, debouncedFunctions);

  return settings;
}

/**
 * Initialize settings UI with loaded values.
 *
 * @param {Object} settings - Settings object
 */
function initializeSettingsUI(settings) {
  // Call the settings update handler to sync UI
  handleSettingsUpdate(settings, settings, () => {});

  // Thresholds
  setFormattedInputValue('fuelThreshold', settings.fuelThreshold);
  setFormattedInputValue('co2Threshold', settings.co2Threshold);
  setInputValue('maintenanceThreshold', settings.maintenanceThreshold);

  // Auto-Rebuy Fuel
  setCheckboxState('autoRebuyFuel', settings.autoRebuyFuel, 'autoRebuyFuelOptions', 'autoRebuyFuelMinCashSection');
  setCheckboxValue('autoRebuyFuelUseAlert', settings.autoRebuyFuelUseAlert);
  setFormattedInputValue('autoRebuyFuelThreshold', settings.autoRebuyFuelThreshold);
  setFormattedInputValue('autoRebuyFuelMinCash', settings.autoRebuyFuelMinCash);

  // Auto-Rebuy CO2
  setCheckboxState('autoRebuyCO2', settings.autoRebuyCO2, 'autoRebuyCO2Options', 'autoRebuyCO2MinCashSection');
  setCheckboxValue('autoRebuyCO2UseAlert', settings.autoRebuyCO2UseAlert);
  setFormattedInputValue('autoRebuyCO2Threshold', settings.autoRebuyCO2Threshold);
  setFormattedInputValue('autoRebuyCO2MinCash', settings.autoRebuyCO2MinCash);

  // Auto-Depart
  setCheckboxState('autoDepartAll', settings.autoDepartAll, 'autoDepartOptions');
  setCheckboxValue('autoDepartUseRouteDefaults', settings.autoDepartUseRouteDefaults);
  toggleElementVisibility('autoDepartCustomSettings', !settings.autoDepartUseRouteDefaults);
  setFormattedInputValue('minFuelThreshold', settings.minFuelThreshold);
  setInputValue('minCargoUtilization', settings.minCargoUtilization || '');
  setInputValue('harborFeeWarningThreshold', settings.harborFeeWarningThreshold || '');
  setInputValue('autoDrydockThreshold', settings.autoDrydockThreshold || 150);
  setInputValue('autoVesselSpeed', settings.autoVesselSpeed);

  // Auto-Repair
  setCheckboxState('autoBulkRepair', settings.autoBulkRepair, 'autoBulkRepairOptions');
  setFormattedInputValue('autoBulkRepairMinCash', settings.autoBulkRepairMinCash);

  // Auto-Drydock
  setCheckboxState('autoDrydock', settings.autoDrydock, 'autoDrydockOptions');
  setInputValue('autoDrydockType', settings.autoDrydockType || 'major');
  setInputValue('autoDrydockSpeed', settings.autoDrydockSpeed || 'minimum');
  setFormattedInputValue('autoDrydockMinCash', settings.autoDrydockMinCash);

  // Auto-Campaign
  setCheckboxState('autoCampaignRenewal', settings.autoCampaignRenewal, 'autoCampaignRenewalOptions');
  setFormattedInputValue('autoCampaignRenewalMinCash', settings.autoCampaignRenewalMinCash);

  // Auto-COOP
  setCheckboxState('autoCoopEnabled', settings.autoCoopEnabled, 'autoCoopOptions');

  // Auto-Anchor Points
  setCheckboxState('autoAnchorPointEnabled', settings.autoAnchorPointEnabled, 'autoAnchorPointOptions');
  setFormattedInputValue('autoAnchorPointMinCash', settings.autoAnchorPointMinCash);
  if (settings.autoAnchorPointAmount === 10) {
    setCheckboxValue('autoAnchorAmount10', true);
  } else {
    setCheckboxValue('autoAnchorAmount1', true);
  }

  // Auto-Negotiate Hijacking
  setCheckboxState('autoNegotiateHijacking', settings.autoNegotiateHijacking, 'autoNegotiateOptions');

  // Notifications
  setCheckboxValue('enableDesktopNotifications', settings.enableDesktopNotifications);
  setCheckboxValue('autoPilotNotifications', settings.autoPilotNotifications !== undefined ? settings.autoPilotNotifications : true);
  setCheckboxValue('enableInboxNotifications', settings.enableInboxNotifications !== false);

  // Initialize agent checkboxes state
  const initialNotifState = settings.autoPilotNotifications !== undefined ? settings.autoPilotNotifications : true;
  toggleAutoPilotAgentCheckboxes(initialNotifState);
}

/**
 * Helper to set formatted input value.
 */
function setFormattedInputValue(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined) {
    el.value = formatNumberWithSeparator(String(value));
  }
}

/**
 * Helper to set input value.
 */
function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

/**
 * Helper to set checkbox value.
 */
function setCheckboxValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = value;
}

/**
 * Helper to set checkbox state with options visibility.
 */
function setCheckboxState(checkboxId, checked, ...optionIds) {
  const el = document.getElementById(checkboxId);
  if (el) {
    el.checked = checked;
    optionIds.forEach(optionId => {
      const optionEl = document.getElementById(optionId);
      if (optionEl) {
        optionEl.classList.toggle('hidden', !checked);
      }
    });
  }
}

/**
 * Helper to toggle element visibility.
 */
function toggleElementVisibility(id, visible) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('hidden', !visible);
  }
}

/**
 * Load user settings (CEO level, points).
 */
async function loadUserSettings() {
  try {
    const userResponse = await fetch(window.apiUrl('/api/user/get-settings'));
    if (userResponse.ok) {
      const userData = await userResponse.json();

      // CEO Level
      const ceoLevel = userData.user?.ceo_level || userData.data?.settings?.ceo_level;
      if (!ceoLevel) {
        throw new Error('CEO level missing from API response');
      }

      const ceoLevelBadge = document.getElementById('ceoLevelBadge');
      const ceoLevelNumber = document.getElementById('ceoLevelNumber');
      if (ceoLevelBadge && ceoLevelNumber) {
        ceoLevelNumber.textContent = ceoLevel;
        ceoLevelBadge.classList.remove('hidden');
      }

      // Calculate XP progress
      const expPoints = userData.user?.experience_points || userData.data?.settings?.experience_points;
      const currentLevelExp = userData.user?.current_level_experience_points || userData.data?.settings?.current_level_experience_points;
      const levelupExp = userData.user?.levelup_experience_points || userData.data?.settings?.levelup_experience_points;

      if (expPoints !== undefined && currentLevelExp !== undefined && levelupExp !== undefined) {
        const expInCurrentLevel = expPoints - currentLevelExp;
        const expNeededForLevel = levelupExp - currentLevelExp;
        const progress = Math.min(100, Math.max(0, (expInCurrentLevel / expNeededForLevel) * 100));

        console.log(`[CEO Level Progress] Current: ${expPoints}, Level Start: ${currentLevelExp}, Next Level: ${levelupExp}, Progress: ${progress.toFixed(1)}%`);

        const ceoLevelFill = document.getElementById('ceoLevelFill');
        if (ceoLevelFill) {
          const widthInViewBox = (progress / 100) * 24;
          ceoLevelFill.setAttribute('width', widthInViewBox);
        }
      }

      // Points
      const points = userData.user?.points || 0;
      const pointsDisplay = document.getElementById('pointsDisplay');
      if (pointsDisplay) {
        pointsDisplay.textContent = points.toLocaleString('en-US');
        pointsDisplay.classList.remove('text-danger', 'text-warning', 'text-success');
        if (points === 0) {
          pointsDisplay.classList.add('text-danger');
        } else if (points < 600) {
          pointsDisplay.classList.add('text-warning');
        } else {
          pointsDisplay.classList.add('text-success');
        }
      }
    }
  } catch (error) {
    console.error('[User Settings] Failed to load:', error);
  }
}

/**
 * Create debounced functions for API calls.
 *
 * @param {Object} settings - Settings object
 * @returns {Object} Debounced functions
 */
function createDebouncedFunctions(settings) {
  return {
    bunker: createDebouncedFunction('bunker', () => updateBunkerStatus(settings)),
    vessel: createDebouncedFunction('vessel', () => updateVesselCount()),
    unread: createDebouncedFunction('unread', () => updateUnreadBadge()),
    repair: createDebouncedFunction('repair', () => updateRepairCount(settings))
  };
}

/**
 * Register all event listeners.
 *
 * @param {Object} settings - Settings object
 * @param {Object} debouncedFunctions - Debounced functions
 */
function registerAllEventListeners(settings, debouncedFunctions) {
  const chatElements = {
    messageInput: document.getElementById('messageInput'),
    sendMessageBtn: document.getElementById('sendMessageBtn'),
    chatFeed: document.getElementById('chatFeed'),
    charCount: document.getElementById('charCount')
  };

  eventRegistry.registerChatEventListeners(chatElements, {
    sendMessage,
    handleMessageInput,
    setChatScrollListener
  });

  eventRegistry.registerMessengerEventListeners({
    closeMessenger,
    deleteCurrentChat,
    getCurrentPrivateChat,
    openMessenger,
    sendPrivateMessage,
    closeChatSelection,
    showAllChats,
    closeAllChats,
    openHijackingInbox,
    closeHijackingInbox
  });

  eventRegistry.registerDialogEventListeners(
    { showSettings, closeSettings, closeContactList, closeCampaignsOverlay, closeCoopOverlay, closeAllianceCoopOverlay },
    settings,
    createTestBrowserNotification(settings)
  );

  eventRegistry.registerVesselCatalogEventListeners({
    loadAcquirableVessels,
    showPendingVessels,
    showShoppingCart,
    updateBunkerStatus,
    setSellFilter,
    showSellCart,
    closeSellVesselsOverlay
  }, settings);

  eventRegistry.registerSettingsThresholdListeners(settings, debouncedFunctions.repair);
  eventRegistry.registerAutoPilotListeners(settings, toggleAutoPilotAgentCheckboxes);
  eventRegistry.registerAutoRebuyFuelListeners(settings);
  eventRegistry.registerAutoRebuyCO2Listeners(settings);
  eventRegistry.registerAutoPilotFeatureListeners(settings);
  eventRegistry.registerAutoDepartSettingsListeners(settings);
  eventRegistry.registerBunkerListeners({ buyMaxFuel, buyMaxCO2 });
  eventRegistry.registerNotificationPermissionListener();
  eventRegistry.registerSectionToggle(getStorage, setStorage);
  eventRegistry.registerChatBotSettingsListeners(settings);
  eventRegistry.registerCustomCommandsListeners(settings);

  eventRegistry.registerNumberFormatting([
    'fuelThreshold', 'co2Threshold', 'minFuelThreshold',
    'autoRebuyFuelThreshold', 'autoRebuyFuelMinCash',
    'autoRebuyCO2Threshold', 'autoRebuyCO2MinCash',
    'autoBulkRepairMinCash', 'autoDrydockMinCash',
    'autoCampaignRenewalMinCash', 'autoAnchorPointMinCash'
  ]);
}

/**
 * Load initial data with delays to prevent socket hang-ups.
 */
async function loadInitialData() {
  const chatFeed = document.getElementById('chatFeed');

  await loadAllianceMembers();

  // Wait for WebSocket initial data
  await new Promise(resolve => setTimeout(resolve, 500));

  const feedContent = chatFeed.innerHTML;
  if (feedContent.includes('Loading chat...')) {
    if (window.DEBUG_MODE) {
      console.log('[Init] No initial WebSocket data - making fallback API call');
    }
    await loadMessages(chatFeed);
  } else if (window.DEBUG_MODE) {
    console.log('[Init] Chat data received via WebSocket');
  }

  updateUnreadBadge();
  if (window.DEBUG_MODE) {
    console.log('[Init] Unread badge updated!');
  }
}

/**
 * Create test browser notification function.
 *
 * @param {Object} settings - Settings object
 * @returns {Function} Test notification function
 */
function createTestBrowserNotification(settings) {
  return async function testBrowserNotification() {
    const hasPermission = await requestNotificationPermission();

    if (!hasPermission) {
      showSideNotification('Please enable notifications first!', 'error');
      return;
    }

    try {
      await showNotification('Test Price Alert', {
        body: `Test Alert!\n\nFuel threshold: $${settings.fuelThreshold}/ton\nCO2 threshold: $${settings.co2Threshold}/ton`,
        icon: '/favicon.ico',
        tag: 'test-alert',
        silent: false
      });

      showSideNotification(`<strong>Test Alert</strong><br><br>Fuel threshold: $${settings.fuelThreshold}/ton<br>CO2 threshold: $${settings.co2Threshold}/ton`, 'warning', null, true);
    } catch (error) {
      console.error('[Test Alert] Notification error:', error);
      showSideNotification(`<strong>Failed to send notification</strong><br><br>Error: ${error.message}<br>Permission: ${Notification.permission}<br>Secure: ${window.isSecureContext ? 'Yes' : 'No'}<br>Protocol: ${window.location.protocol}`, 'error', null, true);
    }
  };
}

/**
 * Create alliance chat overlay handler.
 *
 * @returns {Function} Handler function
 */
function createAllianceChatHandler() {
  return function() {
    const overlay = document.getElementById('allianceChatOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      const chatFeed = document.getElementById('chatFeed');
      if (chatFeed && window.loadMessages) {
        window.loadMessages(chatFeed);
      }
      if (chatFeed) {
        chatFeed.scrollTop = chatFeed.scrollHeight;
      }
    }
  };
}

/**
 * Create forecast overlay handler.
 *
 * @returns {Function} Handler function
 */
function createForecastHandler() {
  return function() {
    document.getElementById('forecastOverlay').classList.remove('hidden');

    const cachedData = window.lastUpdateData;
    if (cachedData && cachedData.prices) {
      const eventDiscount = cachedData.prices.eventDiscount || null;
      const eventData = cachedData.prices.eventData || null;
      if (eventDiscount && eventData) {
        updateEventDiscount(eventDiscount, eventData);
      }
    }

    initForecastCalendar();
  };
}

/**
 * Create buy vessels overlay handler.
 *
 * @param {Object} settings - Settings object
 * @returns {Function} Handler function
 */
function createBuyVesselsHandler(settings) {
  return async function() {
    await updateBunkerStatus(settings);
    document.getElementById('buyVesselsOverlay').classList.remove('hidden');
    await loadAcquirableVessels();
  };
}

/**
 * Expose global functions for backward compatibility.
 *
 * @param {Object} settings - Settings object
 * @param {Object} debouncedFunctions - Debounced functions
 */
function exposeGlobalFunctions(settings, debouncedFunctions) {
  // Campaign purchase wrapper
  window.buyCampaign = (campaignId, typeName, duration, price) => {
    buyCampaign(campaignId, typeName, duration, price, {
      updateBunkerStatus: () => debouncedFunctions.bunker(500)
    });
  };

  // COOP wrapper
  window.sendCoopMax = sendCoopMax;

  // Messenger functions
  window.openMessengerFromChat = openMessenger;
  window.openNewChatFromContact = openNewChat;
  window.loadMessages = loadMessages;
  window.markAllianceChatAsRead = markAllianceChatAsRead;

  // Hijacking functions
  window.updateHijackingBadge = updateHijackingBadge;
  window.updateHijackedVesselsDisplay = updateHijackedVesselsDisplay;

  // Map icon bar functions
  window.departAllVessels = departAllVessels;
  window.showAnchorInfo = showAnchorInfo;
  window.showAllChats = showAllChats;
  window.openHijackingInbox = openHijackingInbox;
  window.showContactList = showContactList;
  window.showCampaignsOverlay = showCampaignsOverlay;
  window.showCoopOverlay = showAllianceCoopOverlay;
  window.openSellVesselsOverlay = openSellVesselsOverlay;

  // Alliance tabs
  window.showAllianceCoopOverlay = showAllianceCoopOverlay;
  window.closeAllianceCoopOverlay = closeAllianceCoopOverlay;
  window.updateCoopTabBadge = updateCoopTabBadge;
  window.showAllAllianceUI = showAllAllianceUI;
  window.hideAllAllianceUI = hideAllAllianceUI;
  window.switchAllianceTab = switchTab;
  window.switchTab = switchTab;
  window.clearAllianceTabCache = clearAllianceTabCache;

  // Vessel management
  window.updateVesselCount = updateVesselCount;
  window.lockDepartButton = lockDepartButton;
  window.unlockDepartButton = unlockDepartButton;
  window.isDepartInProgress = isDepartInProgress;
  window.openRepairAndDrydockDialog = openRepairAndDrydockDialog;

  // Bunker management
  window.setCapacityFromBunkerUpdate = setCapacityFromBunkerUpdate;
  window.saveBadgeCache = saveBadgeCache;
  window.updateCoopDisplay = updateCoopDisplay;

  // Settings
  window.getSettings = () => settings;

  // Logbook
  window.showLogbookOverlay = function() {
    if (window.openLogbook) {
      window.openLogbook();
    }
  };

  // Alliance chat close button
  document.getElementById('closeChatBtn').addEventListener('click', async () => {
    const overlay = document.getElementById('allianceChatOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      if (window.markAllianceChatAsRead) {
        await window.markAllianceChatAsRead();
      }
    }
  });

  // Forecast close button
  document.getElementById('closeForecastBtn').addEventListener('click', () => {
    document.getElementById('forecastOverlay').classList.add('hidden');
  });
}
