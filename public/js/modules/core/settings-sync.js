/**
 * @fileoverview Settings synchronization module.
 * Handles settings updates received from WebSocket broadcasts and updates UI
 * to keep all browser tabs/devices in sync.
 *
 * @module core/settings-sync
 */

import { updatePageTitle } from '../utils.js';

/**
 * Format number with thousand separators.
 * Safe alternative to regex that prevents ReDoS attacks.
 *
 * @param {number|string} value - Number to format
 * @returns {string} Formatted number with commas as thousand separators
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
 * Toggles the disabled state of individual autopilot agent notification checkboxes
 * based on the master AutoPilot Notifications toggle.
 *
 * @param {boolean} masterEnabled - Whether the master toggle is enabled
 */
export function toggleAutoPilotAgentCheckboxes(masterEnabled) {
  const agentCheckboxes = document.querySelectorAll('.autopilot-agent-checkbox');

  agentCheckboxes.forEach(checkbox => {
    checkbox.disabled = !masterEnabled;
    if (masterEnabled) {
      checkbox.parentElement.classList.remove('checkbox-container-disabled');
      checkbox.parentElement.classList.add('checkbox-container-enabled');
    } else {
      checkbox.parentElement.classList.remove('checkbox-container-enabled');
      checkbox.parentElement.classList.add('checkbox-container-disabled');
    }

    // Find or create hint text
    let hintText = checkbox.parentElement.parentElement.querySelector('.agent-notification-hint');
    if (!hintText) {
      hintText = document.createElement('p');
      hintText.className = 'agent-notification-hint';
      checkbox.parentElement.parentElement.appendChild(hintText);
    }

    // Show/hide hint based on master toggle
    if (!masterEnabled) {
      hintText.textContent = 'Disabled by master AutoPilot Notifications toggle';
      hintText.classList.remove('hidden');
    } else {
      hintText.classList.add('hidden');
    }
  });
}

/**
 * Handles settings updates received from other browser tabs/devices via WebSocket.
 *
 * When a user changes settings in one browser tab/window, the server broadcasts
 * the updated settings to ALL connected clients via WebSocket. This function
 * receives those broadcasts and synchronizes the local UI to match.
 *
 * @param {Object} newSettings - Updated settings object from server
 * @param {Object} settingsRef - Reference to the local settings object to update
 * @param {Function} onRepairCountUpdate - Callback to update repair count badge
 * @returns {Object} The updated settings object
 */
export function handleSettingsUpdate(newSettings, settingsRef, onRepairCountUpdate) {
  // Update local settings object
  Object.assign(settingsRef, newSettings);

  // Update company_type from cached settings
  if (newSettings.company_type !== undefined) {
    window.USER_COMPANY_TYPE = newSettings.company_type;
    console.log('[Settings] Updated company_type from cache:', newSettings.company_type);

    // Show/hide tanker filter button in sell vessels dialog
    const sellTankerBtn = document.getElementById('sellFilterTankerBtn');
    if (sellTankerBtn && newSettings.company_type && newSettings.company_type.includes('tanker')) {
      sellTankerBtn.classList.remove('hidden');
    }

    // Refresh vessel catalog if open to update locked/unlocked banners
    if (window.refreshVesselCatalog && typeof window.refreshVesselCatalog === 'function') {
      window.refreshVesselCatalog();
    }
  }

  // Update all checkboxes and input fields
  updateThresholdInputs(newSettings);
  updateAutoRebuyFuelUI(newSettings);
  updateAutoRebuyCO2UI(newSettings);
  updateAutoPilotToggles(newSettings);
  updateNotificationSettings(newSettings);
  updateChatBotSettings(newSettings);

  // Update page title (AutoPilot mode)
  updatePageTitle(settingsRef);

  // Update repair count if maintenance threshold changed
  if (onRepairCountUpdate) {
    onRepairCountUpdate(500);
  }

  return settingsRef;
}

/**
 * Update threshold input fields.
 * @param {Object} newSettings - New settings object
 */
function updateThresholdInputs(newSettings) {
  const fuelThresholdInput = document.getElementById('fuelThreshold');
  const co2ThresholdInput = document.getElementById('co2Threshold');
  const maintenanceThresholdInput = document.getElementById('maintenanceThreshold');

  if (fuelThresholdInput) fuelThresholdInput.value = newSettings.fuelThreshold;
  if (co2ThresholdInput) co2ThresholdInput.value = newSettings.co2Threshold;
  if (maintenanceThresholdInput) maintenanceThresholdInput.value = newSettings.maintenanceThreshold;
}

/**
 * Update auto-rebuy fuel UI elements.
 * @param {Object} newSettings - New settings object
 */
function updateAutoRebuyFuelUI(newSettings) {
  const autoRebuyFuelCheckbox = document.getElementById('autoRebuyFuel');
  const autoRebuyFuelUseAlertCheckbox = document.getElementById('autoRebuyFuelUseAlert');
  const autoRebuyFuelThresholdInput = document.getElementById('autoRebuyFuelThreshold');

  if (autoRebuyFuelCheckbox) {
    autoRebuyFuelCheckbox.checked = newSettings.autoRebuyFuel;
    const fuelOptions = document.getElementById('autoRebuyFuelOptions');
    if (fuelOptions) {
      fuelOptions.classList.toggle('hidden', !newSettings.autoRebuyFuel);
    }
  }

  if (autoRebuyFuelUseAlertCheckbox) {
    const fuelUseAlert = newSettings.autoRebuyFuelUseAlert;
    autoRebuyFuelUseAlertCheckbox.checked = fuelUseAlert;

    if (autoRebuyFuelThresholdInput) {
      if (fuelUseAlert) {
        const value = String(newSettings.fuelThreshold);
        autoRebuyFuelThresholdInput.value = formatNumberWithSeparator(value);
        autoRebuyFuelThresholdInput.disabled = true;
        autoRebuyFuelThresholdInput.classList.remove('input-enabled');
        autoRebuyFuelThresholdInput.classList.add('input-disabled');
      } else {
        const value = String(newSettings.autoRebuyFuelThreshold);
        autoRebuyFuelThresholdInput.value = formatNumberWithSeparator(value);
        autoRebuyFuelThresholdInput.disabled = false;
        autoRebuyFuelThresholdInput.classList.remove('input-disabled');
        autoRebuyFuelThresholdInput.classList.add('input-enabled');
      }
    }

    const autoRebuyFuelMinCashInput = document.getElementById('autoRebuyFuelMinCash');
    if (autoRebuyFuelMinCashInput && newSettings.autoRebuyFuelMinCash !== undefined) {
      const value = String(newSettings.autoRebuyFuelMinCash);
      autoRebuyFuelMinCashInput.value = formatNumberWithSeparator(value);
    }
  }
}

/**
 * Update auto-rebuy CO2 UI elements.
 * @param {Object} newSettings - New settings object
 */
function updateAutoRebuyCO2UI(newSettings) {
  const autoRebuyCO2Checkbox = document.getElementById('autoRebuyCO2');
  const autoRebuyCO2UseAlertCheckbox = document.getElementById('autoRebuyCO2UseAlert');
  const autoRebuyCO2ThresholdInput = document.getElementById('autoRebuyCO2Threshold');

  if (autoRebuyCO2Checkbox) {
    autoRebuyCO2Checkbox.checked = newSettings.autoRebuyCO2;
    const co2Options = document.getElementById('autoRebuyCO2Options');
    if (co2Options) {
      co2Options.classList.toggle('hidden', !newSettings.autoRebuyCO2);
    }
  }

  if (autoRebuyCO2UseAlertCheckbox) {
    const co2UseAlert = newSettings.autoRebuyCO2UseAlert;
    autoRebuyCO2UseAlertCheckbox.checked = co2UseAlert;

    if (autoRebuyCO2ThresholdInput) {
      if (co2UseAlert) {
        const value = String(newSettings.co2Threshold);
        autoRebuyCO2ThresholdInput.value = formatNumberWithSeparator(value);
        autoRebuyCO2ThresholdInput.disabled = true;
        autoRebuyCO2ThresholdInput.classList.remove('input-enabled');
        autoRebuyCO2ThresholdInput.classList.add('input-disabled');
      } else {
        const value = String(newSettings.autoRebuyCO2Threshold);
        autoRebuyCO2ThresholdInput.value = formatNumberWithSeparator(value);
        autoRebuyCO2ThresholdInput.disabled = false;
        autoRebuyCO2ThresholdInput.classList.remove('input-disabled');
        autoRebuyCO2ThresholdInput.classList.add('input-enabled');
      }
    }

    const autoRebuyCO2MinCashInput = document.getElementById('autoRebuyCO2MinCash');
    if (autoRebuyCO2MinCashInput && newSettings.autoRebuyCO2MinCash !== undefined) {
      const value = String(newSettings.autoRebuyCO2MinCash);
      autoRebuyCO2MinCashInput.value = formatNumberWithSeparator(value);
    }
  }
}

/**
 * Update autopilot toggle UI elements.
 * @param {Object} newSettings - New settings object
 */
function updateAutoPilotToggles(newSettings) {
  const autoDepartAllCheckbox = document.getElementById('autoDepartAll');
  const autoBulkRepairCheckbox = document.getElementById('autoBulkRepair');
  const autoCampaignRenewalCheckbox = document.getElementById('autoCampaignRenewal');
  const autoNegotiateHijackingCheckbox = document.getElementById('autoNegotiateHijacking');

  if (autoDepartAllCheckbox) {
    autoDepartAllCheckbox.checked = newSettings.autoDepartAll;
    const autoDepartOptions = document.getElementById('autoDepartOptions');
    if (autoDepartOptions) {
      autoDepartOptions.classList.toggle('hidden', !newSettings.autoDepartAll);
    }
  }

  if (autoBulkRepairCheckbox) {
    autoBulkRepairCheckbox.checked = newSettings.autoBulkRepair;
    const autoBulkRepairOptions = document.getElementById('autoBulkRepairOptions');
    if (autoBulkRepairOptions) {
      autoBulkRepairOptions.classList.toggle('hidden', !newSettings.autoBulkRepair);
    }
  }

  if (autoCampaignRenewalCheckbox) {
    autoCampaignRenewalCheckbox.checked = newSettings.autoCampaignRenewal;
    const autoCampaignRenewalOptions = document.getElementById('autoCampaignRenewalOptions');
    if (autoCampaignRenewalOptions) {
      autoCampaignRenewalOptions.classList.toggle('hidden', !newSettings.autoCampaignRenewal);
    }
  }

  const autoBulkRepairMinCashInput = document.getElementById('autoBulkRepairMinCash');
  if (autoBulkRepairMinCashInput && newSettings.autoBulkRepairMinCash !== undefined) {
    const value = String(newSettings.autoBulkRepairMinCash);
    autoBulkRepairMinCashInput.value = formatNumberWithSeparator(value);
  }

  const autoCampaignRenewalMinCashInput = document.getElementById('autoCampaignRenewalMinCash');
  if (autoCampaignRenewalMinCashInput && newSettings.autoCampaignRenewalMinCash !== undefined) {
    const value = String(newSettings.autoCampaignRenewalMinCash);
    autoCampaignRenewalMinCashInput.value = formatNumberWithSeparator(value);
  }

  if (autoNegotiateHijackingCheckbox) {
    autoNegotiateHijackingCheckbox.checked = newSettings.autoNegotiateHijacking;
  }
}

/**
 * Update notification settings UI.
 * @param {Object} newSettings - New settings object
 */
function updateNotificationSettings(newSettings) {
  const autoPilotNotificationsCheckbox = document.getElementById('autoPilotNotifications');
  if (autoPilotNotificationsCheckbox) {
    const notifValue = newSettings.autoPilotNotifications !== undefined ? newSettings.autoPilotNotifications : true;
    autoPilotNotificationsCheckbox.checked = notifValue;
    toggleAutoPilotAgentCheckboxes(notifValue);
  }

  // Weather data toggle
  const enableWeatherDataCheckbox = document.getElementById('enableWeatherData');
  if (enableWeatherDataCheckbox) {
    const weatherValue = newSettings.enableWeatherData !== undefined ? newSettings.enableWeatherData : true;
    enableWeatherDataCheckbox.checked = weatherValue;
  }

  // Update individual agent notification checkboxes
  const agentNotifIds = [
    'notifyBarrelBossInApp', 'notifyBarrelBossDesktop',
    'notifyAtmosphereBrokerInApp', 'notifyAtmosphereBrokerDesktop',
    'notifyCargoMarshalInApp', 'notifyCargoMarshalDesktop',
    'notifyYardForemanInApp', 'notifyYardForemanDesktop',
    'notifyReputationChiefInApp', 'notifyReputationChiefDesktop',
    'notifyFairHandInApp', 'notifyFairHandDesktop',
    'notifyHarbormasterInApp', 'notifyHarbormasterDesktop',
    'notifyCaptainBlackbeardInApp', 'notifyCaptainBlackbeardDesktop'
  ];

  agentNotifIds.forEach(id => {
    const checkbox = document.getElementById(id);
    if (checkbox && newSettings[id] !== undefined) {
      checkbox.checked = newSettings[id];
    }
  });
}

/**
 * Update Chat Bot settings UI.
 * @param {Object} newSettings - New settings object
 */
function updateChatBotSettings(newSettings) {
  const enableChatBotCheckbox = document.getElementById('enableChatBot');
  if (enableChatBotCheckbox) {
    enableChatBotCheckbox.checked = newSettings.chatbotEnabled || false;
    const isEnabled = newSettings.chatbotEnabled || false;
    const chatBotSettingsElements = document.querySelectorAll('[id^="cmd"], #enableDailyForecast, #dailyForecastTime, #enableAllianceCommands, #enableDMCommands, #commandPrefix');
    chatBotSettingsElements.forEach(el => {
      if (el.closest('div')) {
        if (isEnabled) {
          el.closest('div').classList.remove('checkbox-container-disabled');
          el.closest('div').classList.add('checkbox-container-enabled');
        } else {
          el.closest('div').classList.remove('checkbox-container-enabled');
          el.closest('div').classList.add('checkbox-container-disabled');
        }
        if (el.type === 'checkbox' || el.type === 'text' || el.type === 'time') {
          el.disabled = !isEnabled;
        }
      }
    });
  }

  const commandPrefixInput = document.getElementById('commandPrefix');
  if (commandPrefixInput && newSettings.chatbotPrefix !== undefined) {
    commandPrefixInput.value = newSettings.chatbotPrefix;
  }

  const enableDailyForecastCheckbox = document.getElementById('enableDailyForecast');
  if (enableDailyForecastCheckbox) {
    enableDailyForecastCheckbox.checked = newSettings.chatbotDailyForecastEnabled || false;
    const dailyForecastTime = document.getElementById('dailyForecastTime');
    if (dailyForecastTime) {
      dailyForecastTime.disabled = !newSettings.chatbotDailyForecastEnabled;
      if (newSettings.chatbotDailyForecastEnabled) {
        dailyForecastTime.closest('div').classList.remove('checkbox-container-disabled');
        dailyForecastTime.closest('div').classList.add('checkbox-container-enabled');
      } else {
        dailyForecastTime.closest('div').classList.remove('checkbox-container-enabled');
        dailyForecastTime.closest('div').classList.add('checkbox-container-disabled');
      }
    }
  }

  const dailyForecastTimeInput = document.getElementById('dailyForecastTime');
  if (dailyForecastTimeInput && newSettings.chatbotDailyForecastTime !== undefined) {
    dailyForecastTimeInput.value = newSettings.chatbotDailyForecastTime;
  }

  const enableAllianceCommandsCheckbox = document.getElementById('enableAllianceCommands');
  if (enableAllianceCommandsCheckbox) {
    enableAllianceCommandsCheckbox.checked = newSettings.chatbotAllianceCommandsEnabled !== false;
    const isAllianceEnabled = newSettings.chatbotAllianceCommandsEnabled !== false;
    if (document.getElementById('cmdForecast')) document.getElementById('cmdForecast').disabled = !isAllianceEnabled;
    if (document.getElementById('cmdHelp')) document.getElementById('cmdHelp').disabled = !isAllianceEnabled;
  }

  const cmdForecastCheckbox = document.getElementById('cmdForecast');
  if (cmdForecastCheckbox) cmdForecastCheckbox.checked = newSettings.chatbotForecastCommandEnabled !== false;

  const cmdForecastAllianceCheckbox = document.getElementById('cmdForecastAlliance');
  if (cmdForecastAllianceCheckbox) cmdForecastAllianceCheckbox.checked = newSettings.chatbotForecastAllianceEnabled !== false;

  const cmdForecastDMCheckbox = document.getElementById('cmdForecastDM');
  if (cmdForecastDMCheckbox) cmdForecastDMCheckbox.checked = newSettings.chatbotForecastDMEnabled !== false;

  const cmdHelpCheckbox = document.getElementById('cmdHelp');
  if (cmdHelpCheckbox) cmdHelpCheckbox.checked = newSettings.chatbotHelpCommandEnabled !== false;

  const cmdHelpAllianceCheckbox = document.getElementById('cmdHelpAlliance');
  if (cmdHelpAllianceCheckbox) cmdHelpAllianceCheckbox.checked = newSettings.chatbotHelpAllianceEnabled !== false;

  const cmdHelpDMCheckbox = document.getElementById('cmdHelpDM');
  if (cmdHelpDMCheckbox) cmdHelpDMCheckbox.checked = newSettings.chatbotHelpDMEnabled === true;

  const cmdWelcomeCheckbox = document.getElementById('cmdWelcome');
  if (cmdWelcomeCheckbox) cmdWelcomeCheckbox.checked = newSettings.chatbotWelcomeCommandEnabled !== false;

  const enableDMCommandsCheckbox = document.getElementById('enableDMCommands');
  if (enableDMCommandsCheckbox) {
    enableDMCommandsCheckbox.checked = newSettings.chatbotDMCommandsEnabled || false;
  }
}
