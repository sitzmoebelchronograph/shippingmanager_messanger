/**
 * @fileoverview Event registry module.
 * Centralizes all DOM event listener registrations for the application.
 * This module attaches 60+ event listeners to UI elements.
 *
 * @module core/event-registry
 */

import { saveSettings, updatePageTitle, showNotification, showSideNotification, requestNotificationPermission, escapeHtml } from '../utils.js';

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
 * Register all chat-related event listeners.
 *
 * @param {Object} elements - DOM elements
 * @param {Object} handlers - Event handler functions
 */
export function registerChatEventListeners(elements, handlers) {
  const { messageInput, sendMessageBtn, chatFeed } = elements;
  const { sendMessage, handleMessageInput, setChatScrollListener } = handlers;

  // Send message button click
  sendMessageBtn.addEventListener('click', () => sendMessage(messageInput, elements.charCount, sendMessageBtn, chatFeed));

  // Chat input character counter
  messageInput.addEventListener('input', () => handleMessageInput(messageInput, elements.charCount));

  // Enter key to send message (Shift+Enter for new line)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const suggestionBox = document.getElementById('memberSuggestions');

      // If autocomplete dropdown is visible, select first suggestion
      if (suggestionBox && !suggestionBox.classList.contains('hidden')) {
        e.preventDefault();
        const firstSuggestion = suggestionBox.querySelector('.member-suggestion');
        if (firstSuggestion) {
          firstSuggestion.click();
        }
        return;
      }

      e.preventDefault();
      sendMessage(messageInput, elements.charCount, sendMessageBtn, chatFeed);
    }
  });

  // Chat scroll detection for "load more"
  setChatScrollListener(chatFeed);
}

/**
 * Register all messenger-related event listeners.
 *
 * @param {Object} handlers - Event handler functions
 */
export function registerMessengerEventListeners(handlers) {
  const {
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
  } = handlers;

  // Close messenger overlay
  document.getElementById('closeMessengerBtn').addEventListener('click', closeMessenger);

  // Delete current private chat
  document.getElementById('deleteChatBtn').addEventListener('click', deleteCurrentChat);

  // Close hijacking inbox
  document.getElementById('closeHijackingBtn').addEventListener('click', closeHijackingInbox);

  // Back button in messenger
  document.getElementById('backToSelectionBtn').addEventListener('click', () => {
    if (window.cameFromHijackingInbox) {
      window.cameFromHijackingInbox = false;
      closeMessenger();
      openHijackingInbox();
      return;
    }

    const currentChat = getCurrentPrivateChat();
    const targetCompanyName = currentChat.targetCompanyName;
    const targetUserId = currentChat.targetUserId;
    closeMessenger();
    openMessenger(targetCompanyName, targetUserId);
  });

  // Send private message button
  document.getElementById('sendPrivateMessageBtn').addEventListener('click', sendPrivateMessage);

  // Enter key to send private message
  document.getElementById('messengerInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrivateMessage();
    }
  });

  // Back button in chat selection
  document.getElementById('backToAllChatsBtn').addEventListener('click', () => {
    closeChatSelection();
    showAllChats();
  });

  // Close chat selection overlay
  document.getElementById('closeChatSelectionBtn').addEventListener('click', closeChatSelection);

  // Close all chats list
  document.getElementById('closeAllChatsBtn').addEventListener('click', closeAllChats);

  // Messenger input auto-resize
  document.getElementById('messengerInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';

    const charCounter = document.getElementById('messengerCharCount');
    if (charCounter) {
      charCounter.textContent = `${this.value.length} / 1000`;
    }
  });
}

/**
 * Register dialog and overlay event listeners.
 *
 * @param {Object} handlers - Event handler functions
 * @param {Object} settings - Settings object reference
 * @param {Function} testBrowserNotification - Test notification function
 */
export function registerDialogEventListeners(handlers, settings, testBrowserNotification) {
  const {
    showSettings,
    closeSettings,
    closeContactList,
    closeCampaignsOverlay,
    closeCoopOverlay,
    closeAllianceCoopOverlay
  } = handlers;

  // Settings wrapper
  window.showSettings = () => {
    showSettings(settings);
  };

  // Close settings
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);

  // Close contact list
  document.getElementById('closeContactListBtn').addEventListener('click', closeContactList);

  // Close campaigns overlay
  document.getElementById('closeCampaignsBtn').addEventListener('click', closeCampaignsOverlay);

  // Close coop overlay (now uses alliance-tabs module)
  document.getElementById('closeCoopBtn').addEventListener('click', closeAllianceCoopOverlay || closeCoopOverlay);

  // Test notification button
  document.getElementById('testAlertBtn').addEventListener('click', testBrowserNotification);

  // Delete logbook button with confirmation
  document.getElementById('deleteLogbookBtn').addEventListener('click', async () => {
    const { showConfirmDialog } = await import('../ui-dialogs.js');
    const confirmed = await showConfirmDialog({
      title: 'Delete All Logbook Entries?',
      message: '<p>This will permanently delete <strong style="color: #ef4444;">the entire logbook history</strong>.</p><p style="color: #ef4444; font-weight: 600; margin-top: 12px;">This action cannot be undone!</p>',
      confirmText: 'Delete All',
      cancelText: 'Cancel',
      narrow: true
    });

    if (confirmed) {
      try {
        const { deleteAllLogsConfirmed } = await import('../logbook.js');
        await deleteAllLogsConfirmed();
        showNotification('All logbook entries deleted', 'success');
      } catch (error) {
        console.error('[Logbook] Delete failed:', error);
        showNotification('Failed to delete logbook entries', 'error');
      }
    }
  });
}

/**
 * Register vessel catalog event listeners.
 *
 * @param {Object} handlers - Event handler functions
 * @param {Object} settings - Settings object
 */
export function registerVesselCatalogEventListeners(handlers, settings) {
  const {
    loadAcquirableVessels,
    showPendingVessels,
    showShoppingCart,
    updateBunkerStatus,
    setSellFilter,
    showSellCart,
    closeSellVesselsOverlay
  } = handlers;

  // Buy vessels overlay wrapper
  window.showBuyVesselsOverlay = async () => {
    await updateBunkerStatus(settings);
    document.getElementById('buyVesselsOverlay').classList.remove('hidden');
    await loadAcquirableVessels();
  };

  // Close sell vessels overlay
  document.getElementById('closeSellVesselsBtn').addEventListener('click', closeSellVesselsOverlay);

  // Sell vessel filter buttons
  document.getElementById('sellFilterContainerBtn').addEventListener('click', (e) => {
    document.querySelectorAll('#sellVesselsOverlay .vessel-filter-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    setSellFilter('container');
  });

  document.getElementById('sellFilterTankerBtn').addEventListener('click', (e) => {
    document.querySelectorAll('#sellVesselsOverlay .vessel-filter-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    setSellFilter('tanker');
  });

  // Sell cart button
  document.getElementById('sellCartBtn').addEventListener('click', showSellCart);

  // Filter pending vessels
  document.getElementById('filterPendingBtn').addEventListener('click', async () => {
    const { fetchVessels } = await import('../api.js');
    const response = await fetchVessels();
    const pendingVessels = (response.vessels || []).filter(v => v.status === 'pending');
    await showPendingVessels(pendingVessels);
  });

  // Close vessel catalog overlay
  document.getElementById('closeBuyVesselsBtn').addEventListener('click', () => {
    document.getElementById('buyVesselsOverlay').classList.add('hidden');
  });

  // Toggle filter dropdown
  document.getElementById('filterDropdownBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('filterDropdownMenu');
    menu.classList.toggle('hidden');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('filterDropdownMenu');
    const btn = document.getElementById('filterDropdownBtn');
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  // Live filtering
  document.getElementById('filterDropdownMenu').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
      if (window.applyVesselFilters) window.applyVesselFilters();
    }
  });

  // Reset filters button
  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    if (window.resetVesselFilters) window.resetVesselFilters();
  });

  // Sort by price button
  document.getElementById('sortPriceBtn').addEventListener('click', () => {
    if (window.togglePriceSort) window.togglePriceSort();
  });

  // Cart button
  document.getElementById('cartBtn').addEventListener('click', showShoppingCart);
}

/**
 * Register settings threshold input event listeners.
 *
 * @param {Object} settings - Settings object reference
 * @param {Function} debouncedUpdateRepairCount - Debounced repair count update
 */
export function registerSettingsThresholdListeners(settings, debouncedUpdateRepairCount) {
  // Fuel threshold
  document.getElementById('fuelThreshold').addEventListener('change', function() {
    settings.fuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // CO2 threshold
  document.getElementById('co2Threshold').addEventListener('change', function() {
    settings.co2Threshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // Maintenance threshold
  document.getElementById('maintenanceThreshold').addEventListener('change', function() {
    settings.maintenanceThreshold = parseInt(this.value);
    saveSettings(settings);
    debouncedUpdateRepairCount(500);
  });
}

/**
 * Register AutoPilot checkbox event listeners.
 *
 * @param {Object} settings - Settings object reference
 * @param {Function} toggleAutoPilotAgentCheckboxes - Toggle agent checkboxes function
 */
export function registerAutoPilotListeners(settings, toggleAutoPilotAgentCheckboxes) {
  // AutoPilot Notifications master toggle
  const autoPilotNotificationsCheckbox = document.getElementById('autoPilotNotifications');
  if (autoPilotNotificationsCheckbox) {
    autoPilotNotificationsCheckbox.addEventListener('change', function() {
      settings.autoPilotNotifications = this.checked;
      toggleAutoPilotAgentCheckboxes(this.checked);
      saveSettings(settings);
    });
  }

  // Weather data toggle
  const enableWeatherDataCheckbox = document.getElementById('enableWeatherData');
  if (enableWeatherDataCheckbox) {
    enableWeatherDataCheckbox.addEventListener('change', async function() {
      settings.enableWeatherData = this.checked;
      console.log('[Settings] Weather Data changed to:', this.checked);
      await saveSettings(settings);
      showNotification('Weather data setting saved. Please reload the page (F5) for changes to take effect.', 'info', 6000);

      if (window.harborMap && window.harborMap.updateWeatherDataSetting) {
        window.harborMap.updateWeatherDataSetting(this.checked);
      }
    });
  }

  // Individual agent notification toggles
  const agentNotificationIds = [
    'notifyBarrelBossInApp', 'notifyBarrelBossDesktop',
    'notifyAtmosphereBrokerInApp', 'notifyAtmosphereBrokerDesktop',
    'notifyCargoMarshalInApp', 'notifyCargoMarshalDesktop',
    'notifyYardForemanInApp', 'notifyYardForemanDesktop',
    'notifyDrydockMasterInApp', 'notifyDrydockMasterDesktop',
    'notifyReputationChiefInApp', 'notifyReputationChiefDesktop',
    'notifyFairHandInApp', 'notifyFairHandDesktop',
    'notifyHarbormasterInApp', 'notifyHarbormasterDesktop',
    'notifyCaptainBlackbeardInApp', 'notifyCaptainBlackbeardDesktop'
  ];

  agentNotificationIds.forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      checkbox.addEventListener('change', function() {
        settings[id] = this.checked;
        saveSettings(settings);
      });
    }
  });
}

/**
 * Register auto-rebuy fuel event listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerAutoRebuyFuelListeners(settings) {
  document.getElementById('autoRebuyFuel').addEventListener('change', function() {
    settings.autoRebuyFuel = this.checked;
    document.getElementById('autoRebuyFuelOptions').classList.toggle('hidden', !this.checked);
    const minCashSection = document.getElementById('autoRebuyFuelMinCashSection');
    if (minCashSection) minCashSection.classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoRebuyFuelUseAlert').addEventListener('change', function() {
    settings.autoRebuyFuelUseAlert = this.checked;
    const thresholdInput = document.getElementById('autoRebuyFuelThreshold');

    if (this.checked) {
      thresholdInput.value = settings.fuelThreshold;
      thresholdInput.disabled = true;
      thresholdInput.classList.remove('input-enabled');
      thresholdInput.classList.add('input-disabled');
    } else {
      thresholdInput.disabled = false;
      thresholdInput.classList.remove('input-disabled');
      thresholdInput.classList.add('input-enabled');
    }

    saveSettings(settings);
  });

  document.getElementById('autoRebuyFuelThreshold').addEventListener('change', function() {
    settings.autoRebuyFuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  document.getElementById('autoRebuyFuelMinCash').addEventListener('change', function() {
    settings.autoRebuyFuelMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoRebuyFuelMinCash);
    saveSettings(settings);
  });
}

/**
 * Register auto-rebuy CO2 event listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerAutoRebuyCO2Listeners(settings) {
  document.getElementById('autoRebuyCO2').addEventListener('change', function() {
    settings.autoRebuyCO2 = this.checked;
    document.getElementById('autoRebuyCO2Options').classList.toggle('hidden', !this.checked);
    const minCashSection = document.getElementById('autoRebuyCO2MinCashSection');
    if (minCashSection) minCashSection.classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoRebuyCO2UseAlert').addEventListener('change', function() {
    settings.autoRebuyCO2UseAlert = this.checked;
    const thresholdInput = document.getElementById('autoRebuyCO2Threshold');

    if (this.checked) {
      thresholdInput.value = settings.co2Threshold;
      thresholdInput.disabled = true;
      thresholdInput.classList.remove('input-enabled');
      thresholdInput.classList.add('input-disabled');
    } else {
      thresholdInput.disabled = false;
      thresholdInput.classList.remove('input-disabled');
      thresholdInput.classList.add('input-enabled');
    }

    saveSettings(settings);
  });

  document.getElementById('autoRebuyCO2Threshold').addEventListener('change', function() {
    settings.autoRebuyCO2Threshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  document.getElementById('autoRebuyCO2MinCash').addEventListener('change', function() {
    settings.autoRebuyCO2MinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoRebuyCO2MinCash);
    saveSettings(settings);
  });
}

/**
 * Register AutoPilot feature toggle event listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerAutoPilotFeatureListeners(settings) {
  // Auto-depart
  document.getElementById('autoDepartAll').addEventListener('change', function() {
    settings.autoDepartAll = this.checked;
    document.getElementById('autoDepartOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-repair
  document.getElementById('autoBulkRepair').addEventListener('change', function() {
    settings.autoBulkRepair = this.checked;
    document.getElementById('autoBulkRepairOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoBulkRepairMinCash').addEventListener('change', function() {
    settings.autoBulkRepairMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoBulkRepairMinCash);
    saveSettings(settings);
  });

  // Auto-drydock
  document.getElementById('autoDrydock').addEventListener('change', function() {
    settings.autoDrydock = this.checked;
    document.getElementById('autoDrydockOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoDrydockType').addEventListener('change', function() {
    settings.autoDrydockType = this.value;
    saveSettings(settings);
  });

  document.getElementById('autoDrydockSpeed').addEventListener('change', function() {
    settings.autoDrydockSpeed = this.value;
    saveSettings(settings);
  });

  document.getElementById('autoDrydockMinCash').addEventListener('change', function() {
    settings.autoDrydockMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoDrydockMinCash);
    saveSettings(settings);
  });

  // Auto-campaign
  document.getElementById('autoCampaignRenewal').addEventListener('change', function() {
    settings.autoCampaignRenewal = this.checked;
    document.getElementById('autoCampaignRenewalOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoCampaignRenewalMinCash').addEventListener('change', function() {
    settings.autoCampaignRenewalMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoCampaignRenewalMinCash);
    saveSettings(settings);
  });

  // Auto-COOP
  document.getElementById('autoCoopEnabled').addEventListener('change', function() {
    settings.autoCoopEnabled = this.checked;
    document.getElementById('autoCoopOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-Anchor Points
  document.getElementById('autoAnchorPointEnabled').addEventListener('change', function() {
    settings.autoAnchorPointEnabled = this.checked;
    document.getElementById('autoAnchorPointOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  document.getElementById('autoAnchorPointMinCash').addEventListener('change', function() {
    const value = parseInt(this.value.replace(/,/g, ''));
    if (value >= 0) {
      settings.autoAnchorPointMinCash = value;
      this.value = formatNumberWithSeparator(settings.autoAnchorPointMinCash);
      saveSettings(settings);
    } else if (settings.autoAnchorPointMinCash !== undefined) {
      this.value = formatNumberWithSeparator(settings.autoAnchorPointMinCash);
    }
  });

  document.getElementById('autoAnchorAmount1').addEventListener('change', function() {
    if (this.checked) {
      settings.autoAnchorPointAmount = 1;
      saveSettings(settings);
    }
  });

  document.getElementById('autoAnchorAmount10').addEventListener('change', function() {
    if (this.checked) {
      settings.autoAnchorPointAmount = 10;
      saveSettings(settings);
    }
  });

  // Auto-Negotiate Hijacking
  document.getElementById('autoNegotiateHijacking').addEventListener('change', function() {
    settings.autoNegotiateHijacking = this.checked;
    document.getElementById('autoNegotiateOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Desktop notifications
  document.getElementById('enableDesktopNotifications').addEventListener('change', function() {
    settings.enableDesktopNotifications = this.checked;
    saveSettings(settings);
  });

  // Inbox notifications
  document.getElementById('enableInboxNotifications').addEventListener('change', function() {
    settings.enableInboxNotifications = this.checked;
    saveSettings(settings);
  });
}

/**
 * Register intelligent auto-depart settings listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerAutoDepartSettingsListeners(settings) {
  document.getElementById('autoDepartUseRouteDefaults').addEventListener('change', function() {
    settings.autoDepartUseRouteDefaults = this.checked;
    const customSettingsDiv = document.getElementById('autoDepartCustomSettings');

    if (this.checked) {
      customSettingsDiv.classList.add('hidden');
    } else {
      customSettingsDiv.classList.remove('hidden');
    }

    saveSettings(settings);
  });

  document.getElementById('minFuelThreshold').addEventListener('change', function() {
    settings.minFuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  const minCargoUtilizationSelect = document.getElementById('minCargoUtilization');
  if (minCargoUtilizationSelect) {
    minCargoUtilizationSelect.addEventListener('change', function() {
      settings.minCargoUtilization = this.value === '' ? null : parseInt(this.value);
      saveSettings(settings);
    });
  }

  const harborFeeWarningThresholdSelect = document.getElementById('harborFeeWarningThreshold');
  if (harborFeeWarningThresholdSelect) {
    harborFeeWarningThresholdSelect.addEventListener('change', function() {
      settings.harborFeeWarningThreshold = this.value === '' ? null : parseInt(this.value);
      saveSettings(settings);
    });
  }

  const autoDrydockThresholdSelect = document.getElementById('autoDrydockThreshold');
  if (autoDrydockThresholdSelect) {
    autoDrydockThresholdSelect.addEventListener('change', function() {
      settings.autoDrydockThreshold = parseInt(this.value);
      saveSettings(settings);
    });
  }

  document.getElementById('autoVesselSpeed').addEventListener('change', function() {
    settings.autoVesselSpeed = parseInt(this.value);
    saveSettings(settings);
  });
}

/**
 * Register bunker management button listeners.
 *
 * @param {Object} handlers - Bunker management handlers
 */
export function registerBunkerListeners(handlers) {
  const { buyMaxFuel, buyMaxCO2 } = handlers;

  document.getElementById('fuelBtn').addEventListener('click', buyMaxFuel);
  document.getElementById('co2Btn').addEventListener('click', buyMaxCO2);
}

/**
 * Register notification permission button listener.
 */
export function registerNotificationPermissionListener() {
  const notificationBtn = document.getElementById('notificationBtn');
  if (!notificationBtn) return;

  notificationBtn.addEventListener('click', async () => {
    if (Notification.permission === "denied") {
      showSideNotification('Browser Blocked<br><br>Enable in browser settings', 'warning', null, true);
      return;
    }

    if (Notification.permission === "default") {
      const hasPermission = await requestNotificationPermission();
      if (hasPermission) {
        showSideNotification('Browser Permission Granted', 'success');
      }
      return;
    }

    if (Notification.permission === "granted") {
      showSideNotification('Browser Permission<br><br>Already granted for this device', 'success');
    }
  });
}

/**
 * Register number formatting for input fields.
 *
 * @param {string[]} fieldIds - Array of field IDs to format
 */
export function registerNumberFormatting(fieldIds) {
  fieldIds.forEach(fieldId => {
    const input = document.getElementById(fieldId);
    if (input) {
      input.addEventListener('input', function(e) {
        let value = e.target.value.replace(/\D/g, '');
        let formattedValue = formatNumberWithSeparator(value);
        e.target.value = formattedValue;
      });

      if (input.value) {
        let value = input.value.replace(/\D/g, '');
        input.value = formatNumberWithSeparator(value);
      }
    }
  });
}

/**
 * Register section toggle function globally.
 *
 * @param {Function} getStorage - Storage getter
 * @param {Function} setStorage - Storage setter
 */
export function registerSectionToggle(getStorage, setStorage) {
  window.toggleSection = function(contentId) {
    const content = document.getElementById(contentId);
    const toggleId = contentId.replace('Content', 'Toggle');
    const toggle = document.getElementById(toggleId);

    if (!content || !toggle) return;

    const isHidden = content.classList.contains('hidden');

    if (isHidden) {
      content.classList.remove('hidden');
    } else {
      content.classList.add('hidden');
    }
    toggle.textContent = isHidden ? '➖' : '➕';

    const sectionStates = JSON.parse(getStorage('settingsSectionStates') || '{}');
    sectionStates[contentId] = isHidden ? 'open' : 'closed';
    setStorage('settingsSectionStates', JSON.stringify(sectionStates));
  };
}

/**
 * Register Chat Bot settings event listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerChatBotSettingsListeners(settings) {
  // Enable/disable Chat Bot
  const enableChatBotCheckbox = document.getElementById('enableChatBot');
  if (enableChatBotCheckbox) {
    enableChatBotCheckbox.addEventListener('change', function() {
      settings.chatbotEnabled = this.checked;
      const chatBotSettingsElements = document.querySelectorAll('[id^="cmd"], #enableDailyForecast, #dailyForecastTime, #enableAllianceCommands, #enableDMCommands, #commandPrefix');
      chatBotSettingsElements.forEach(el => {
        if (el.closest('div')) {
          if (this.checked) {
            el.closest('div').classList.remove('checkbox-container-disabled');
            el.closest('div').classList.add('checkbox-container-enabled');
          } else {
            el.closest('div').classList.remove('checkbox-container-enabled');
            el.closest('div').classList.add('checkbox-container-disabled');
          }
          if (el.type === 'checkbox' || el.type === 'text' || el.type === 'time') {
            el.disabled = !this.checked;
          }
        }
      });
      saveSettings(settings);
    });
  }

  // Command prefix
  const commandPrefixInput = document.getElementById('commandPrefix');
  if (commandPrefixInput) {
    commandPrefixInput.addEventListener('input', function() {
      settings.chatbotPrefix = this.value;
      saveSettings(settings);
    });
  }

  // Daily forecast enabled
  const enableDailyForecastCheckbox = document.getElementById('enableDailyForecast');
  if (enableDailyForecastCheckbox) {
    enableDailyForecastCheckbox.addEventListener('change', function() {
      settings.chatbotDailyForecastEnabled = this.checked;
      const dailyForecastTime = document.getElementById('dailyForecastTime');
      if (dailyForecastTime) {
        dailyForecastTime.disabled = !this.checked;
        if (this.checked) {
          dailyForecastTime.closest('div').classList.remove('checkbox-container-disabled');
          dailyForecastTime.closest('div').classList.add('checkbox-container-enabled');
        } else {
          dailyForecastTime.closest('div').classList.remove('checkbox-container-enabled');
          dailyForecastTime.closest('div').classList.add('checkbox-container-disabled');
        }
      }
      saveSettings(settings);
    });
  }

  // Daily forecast time
  const dailyForecastTimeInput = document.getElementById('dailyForecastTime');
  if (dailyForecastTimeInput) {
    dailyForecastTimeInput.addEventListener('change', function() {
      settings.chatbotDailyForecastTime = this.value;
      saveSettings(settings);
    });
  }

  // Alliance commands enabled
  const enableAllianceCommandsCheckbox = document.getElementById('enableAllianceCommands');
  if (enableAllianceCommandsCheckbox) {
    enableAllianceCommandsCheckbox.addEventListener('change', function() {
      settings.chatbotAllianceCommandsEnabled = this.checked;
      const cmdForecast = document.getElementById('cmdForecast');
      const cmdHelp = document.getElementById('cmdHelp');
      if (cmdForecast) cmdForecast.disabled = !this.checked;
      if (cmdHelp) cmdHelp.disabled = !this.checked;
      saveSettings(settings);
    });
  }

  // Forecast command enabled
  const cmdForecastCheckbox = document.getElementById('cmdForecast');
  if (cmdForecastCheckbox) {
    cmdForecastCheckbox.addEventListener('change', function() {
      settings.chatbotForecastCommandEnabled = this.checked;
      const cmdForecastAlliance = document.getElementById('cmdForecastAlliance');
      const cmdForecastDM = document.getElementById('cmdForecastDM');
      if (cmdForecastAlliance) cmdForecastAlliance.disabled = !this.checked;
      if (cmdForecastDM) cmdForecastDM.disabled = !this.checked;
      saveSettings(settings);
    });
  }

  // Forecast Alliance channel
  const cmdForecastAllianceCheckbox = document.getElementById('cmdForecastAlliance');
  if (cmdForecastAllianceCheckbox) {
    cmdForecastAllianceCheckbox.addEventListener('change', function() {
      settings.chatbotForecastAllianceEnabled = this.checked;
      saveSettings(settings);
    });
  }

  // Forecast DM channel
  const cmdForecastDMCheckbox = document.getElementById('cmdForecastDM');
  if (cmdForecastDMCheckbox) {
    cmdForecastDMCheckbox.addEventListener('change', function() {
      settings.chatbotForecastDMEnabled = this.checked;
      saveSettings(settings);
    });
  }

  // Forecast Aliases
  const cmdForecastAliasesInput = document.getElementById('cmdForecastAliases');
  if (cmdForecastAliasesInput) {
    cmdForecastAliasesInput.addEventListener('blur', function() {
      const aliasString = this.value.trim();
      if (aliasString) {
        settings.chatbotForecastAliases = aliasString.split(',').map(s => s.trim()).filter(s => s);
      } else {
        settings.chatbotForecastAliases = [];
      }
      saveSettings(settings);
    });
  }

  // Help command enabled
  const cmdHelpCheckbox = document.getElementById('cmdHelp');
  if (cmdHelpCheckbox) {
    cmdHelpCheckbox.addEventListener('change', function() {
      settings.chatbotHelpCommandEnabled = this.checked;
      const cmdHelpAlliance = document.getElementById('cmdHelpAlliance');
      const cmdHelpDM = document.getElementById('cmdHelpDM');
      if (cmdHelpAlliance) cmdHelpAlliance.disabled = !this.checked;
      if (cmdHelpDM) cmdHelpDM.disabled = !this.checked;
      saveSettings(settings);
    });
  }

  // Help Alliance channel
  const cmdHelpAllianceCheckbox = document.getElementById('cmdHelpAlliance');
  if (cmdHelpAllianceCheckbox) {
    cmdHelpAllianceCheckbox.addEventListener('change', function() {
      settings.chatbotHelpAllianceEnabled = this.checked;
      saveSettings(settings);
    });
  }

  // Help DM channel
  const cmdHelpDMCheckbox = document.getElementById('cmdHelpDM');
  if (cmdHelpDMCheckbox) {
    cmdHelpDMCheckbox.addEventListener('change', function() {
      settings.chatbotHelpDMEnabled = this.checked;
      saveSettings(settings);
    });
  }

  // Help Aliases
  const cmdHelpAliasesInput = document.getElementById('cmdHelpAliases');
  if (cmdHelpAliasesInput) {
    cmdHelpAliasesInput.addEventListener('blur', function() {
      const aliasString = this.value.trim();
      if (aliasString) {
        settings.chatbotHelpAliases = aliasString.split(',').map(s => s.trim()).filter(s => s);
      } else {
        settings.chatbotHelpAliases = [];
      }
      saveSettings(settings);
    });
  }

  // Welcome command enabled
  const cmdWelcomeCheckbox = document.getElementById('cmdWelcome');
  if (cmdWelcomeCheckbox) {
    cmdWelcomeCheckbox.addEventListener('change', function() {
      settings.chatbotWelcomeCommandEnabled = this.checked;
      saveSettings(settings);
    });
  }

  // DM commands enabled
  const enableDMCommandsCheckbox = document.getElementById('enableDMCommands');
  if (enableDMCommandsCheckbox) {
    enableDMCommandsCheckbox.addEventListener('change', function() {
      settings.chatbotDMCommandsEnabled = this.checked;
      const deleteDMCheckbox = document.querySelector('[id*="deleteDM"], [id*="deleteAfterReply"]');
      if (deleteDMCheckbox) {
        deleteDMCheckbox.disabled = !this.checked;
        if (this.checked) {
          deleteDMCheckbox.closest('div').classList.remove('checkbox-container-disabled');
          deleteDMCheckbox.closest('div').classList.add('checkbox-container-enabled');
        } else {
          deleteDMCheckbox.closest('div').classList.remove('checkbox-container-enabled');
          deleteDMCheckbox.closest('div').classList.add('checkbox-container-disabled');
        }
      }
      saveSettings(settings);
    });
  }
}

/**
 * Register custom commands list event listeners.
 *
 * @param {Object} settings - Settings object reference
 */
export function registerCustomCommandsListeners(settings) {
  const addCustomCommandBtn = document.getElementById('addCustomCommand');
  if (!addCustomCommandBtn) return;

  addCustomCommandBtn.addEventListener('click', function() {
    const commandsContainer = document.getElementById('customCommandsList');
    const commandIndex = (settings.chatbotCustomCommands || []).length;

    const newCommand = {
      command: '',
      response: '',
      allianceEnabled: true,
      dmEnabled: true,
      adminOnly: false
    };

    if (!settings.chatbotCustomCommands) {
      settings.chatbotCustomCommands = [];
    }
    settings.chatbotCustomCommands.push(newCommand);

    const commandDiv = createCustomCommandElement(commandIndex, newCommand, settings);
    commandsContainer.appendChild(commandDiv);
  });

  // Load existing custom commands
  const customCommandsList = document.getElementById('customCommandsList');
  if (customCommandsList && settings.chatbotCustomCommands && settings.chatbotCustomCommands.length > 0) {
    settings.chatbotCustomCommands.forEach((cmd, index) => {
      const commandDiv = createCustomCommandElement(index, cmd, settings);
      customCommandsList.appendChild(commandDiv);
    });
  }
}

/**
 * Create a custom command element with all event listeners.
 *
 * @param {number} index - Command index
 * @param {Object} cmd - Command object
 * @param {Object} settings - Settings object
 * @returns {HTMLElement} Command div element
 */
function createCustomCommandElement(index, cmd, settings) {
  const commandDiv = document.createElement('div');
  commandDiv.className = 'custom-command-item';
  commandDiv.innerHTML = `
    <div class="command-header-row">
      <input type="text" placeholder="Command (e.g. status)" data-command-index="${index}" data-field="command" value="${escapeHtml(cmd.command || '')}" class="command-input">
      <button class="remove-custom-command" data-command-index="${index}">Remove</button>
    </div>

    <div class="response-container">
      <textarea
        placeholder="Response text (max 1000 characters, use Shift+Enter for line breaks)"
        data-command-index="${index}"
        data-field="response"
        maxlength="1000"
        class="response-textarea">${escapeHtml(cmd.response || '')}</textarea>
      <div class="char-counter-container">
        <span class="char-counter" data-command-index="${index}">${(cmd.response || '').length}</span> / 1000
      </div>
    </div>

    <div class="response-options">
      <div class="response-option-row">
        <div class="response-option-header">Response Channel:</div>
        <label class="response-option-label">
          <input type="checkbox" data-command-index="${index}" data-field="allianceEnabled" ${cmd.allianceEnabled !== false ? 'checked' : ''} class="response-option-checkbox">
          <span class="response-option-text">Alliance Chat</span>
        </label>
        <label class="response-option-label">
          <input type="checkbox" data-command-index="${index}" data-field="dmEnabled" ${cmd.dmEnabled !== false ? 'checked' : ''} class="response-option-checkbox">
          <span class="response-option-text">Direct Messages</span>
        </label>
      </div>
      <label class="response-option-label">
        <input type="checkbox" data-command-index="${index}" data-field="adminOnly" ${cmd.adminOnly ? 'checked' : ''} class="response-option-checkbox">
        <span class="response-option-text-admin">Admin Only</span>
      </label>
    </div>
  `;

  // Debounce timer for auto-save
  let saveTimer = null;

  // Add event listeners for text inputs
  commandDiv.querySelectorAll('input[type="text"]').forEach(input => {
    input.addEventListener('input', function() {
      const idx = parseInt(this.dataset.commandIndex);
      const field = this.dataset.field;
      if (settings.chatbotCustomCommands[idx]) {
        settings.chatbotCustomCommands[idx][field] = this.value;
        // Debounce save - only save after 1 second of no typing
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveSettings(settings);
        }, 1000);
      }
    });
  });

  // Textarea with character counter
  const textarea = commandDiv.querySelector('textarea');
  const charCounter = commandDiv.querySelector('.char-counter');
  textarea.addEventListener('input', function() {
    const idx = parseInt(this.dataset.commandIndex);
    if (settings.chatbotCustomCommands[idx]) {
      settings.chatbotCustomCommands[idx].response = this.value;
      // Debounce save - only save after 1 second of no typing
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveSettings(settings);
      }, 1000);
    }
    charCounter.textContent = this.value.length;
  });

  // Checkbox inputs
  commandDiv.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', function() {
      const idx = parseInt(this.dataset.commandIndex);
      const field = this.dataset.field;
      if (settings.chatbotCustomCommands[idx]) {
        settings.chatbotCustomCommands[idx][field] = this.checked;
        saveSettings(settings);
      }
    });
  });

  // Remove button
  commandDiv.querySelector('.remove-custom-command').addEventListener('click', function() {
    const idx = parseInt(this.dataset.commandIndex);
    settings.chatbotCustomCommands.splice(idx, 1);
    commandDiv.remove();
    // Re-index remaining commands
    document.querySelectorAll('.custom-command-item').forEach((item, newIdx) => {
      item.querySelectorAll('[data-command-index]').forEach(el => {
        el.dataset.commandIndex = newIdx;
      });
    });
    saveSettings(settings);
  });

  return commandDiv;
}
