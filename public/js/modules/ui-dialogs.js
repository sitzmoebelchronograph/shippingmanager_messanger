/**
 * @fileoverview UI Dialogs Module - Manages all modal dialogs and overlay interfaces for user interactions.
 * Provides reusable dialog components for confirmations, settings, campaigns, contacts, and vessel/anchor information.
 *
 * Key Features:
 * - Generic confirmation dialog with customizable title, message, and details
 * - Settings overlay for managing price thresholds and AutoPilot options
 * - Marketing campaigns browser with activation functionality
 * - Contact list display with direct messaging integration
 * - Affordability calculations with visual indicators (green/red)
 *
 * Dialog Types:
 * - Confirmation Dialogs: Purchase confirmations, deletion warnings
 * - Settings Panel: Price thresholds, auto-rebuy toggles, AutoPilot features
 * - Campaign Browser: Shows active/inactive campaigns with purchase buttons
 * - Contact List: Filterable list of contacts and alliance members
 * - Info Dialogs: Anchor status, vessel information
 *
 * @module ui-dialogs
 * @requires utils - Formatting and feedback functions
 * @requires api - Backend API calls for data fetching
 */

import { escapeHtml, formatNumber, renderStars, showSideNotification } from './utils.js';
import { fetchCampaigns, activateCampaign, fetchContacts } from './api.js';
import { showAnchorPurchaseDialog } from './anchor-purchase.js';

/**
 * Shows a customizable confirmation dialog with optional details table.
 * Returns a promise that resolves to true/false based on user choice.
 *
 * Features:
 * - Custom title and message
 * - Optional details table with label/value pairs
 * - Affordability check (highlights Total Cost vs Available Cash)
 * - Customizable button text
 * - Click-outside-to-close functionality
 *
 * Affordability Logic:
 * - If second-to-last row is "Total Cost" and last row is "Available Cash"
 * - Compares values numerically
 * - Adds 'affordable' (green) or 'too-expensive' (red) CSS class
 *
 * @param {Object} options - Configuration options
 * @param {string} options.title - Dialog title
 * @param {string} [options.message] - Main message text
 * @param {Array<{label: string, value: string}>} [options.details] - Details table rows
 * @param {string} [options.confirmText='Confirm'] - Confirm button text
 * @param {string} [options.cancelText='Cancel'] - Cancel button text (empty string to hide)
 * @returns {Promise<boolean>} True if confirmed, false if canceled or closed
 *
 * @example
 * const confirmed = await showConfirmDialog({
 *   title: 'Purchase Fuel',
 *   message: 'Buy fuel to fill tank?',
 *   confirmText: 'Buy',
 *   details: [
 *     { label: 'Amount needed', value: '2,500t' },
 *     { label: 'Total Cost', value: '$1,000,000' },
 *     { label: 'Available Cash', value: '$5,000,000' }
 *   ]
 * });
 */
export function showConfirmDialog(options) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = options.narrow ? 'confirm-dialog confirm-dialog-narrow' : 'confirm-dialog';

    const detailsHtml = options.details ? `
      <div class="confirm-dialog-details">
        ${options.details.map((detail, index) => {
          const isSecondToLastRow = index === options.details.length - 2;

          let rowClass = '';
          if (isSecondToLastRow && detail.label === 'Total Cost') {
            const totalCostMatch = detail.value.match(/[\d,]+/);
            const cashAfterMatch = options.details[options.details.length - 1].value.match(/-?[\d,]+/);

            if (totalCostMatch && cashAfterMatch) {
              const cashAfter = parseInt(cashAfterMatch[0].replace(/,/g, ''));
              // If "Cash after" is positive, purchase is affordable
              rowClass = cashAfter >= 0 ? ' affordable' : ' too-expensive';
            }
          }

          // Mark Cost rows as expense (red)
          if (detail.label === 'Cost' || detail.label === 'Total Cost') {
            rowClass += ' expense-row';
          }

          // Add custom className to value span (for price color coding)
          const valueClass = detail.className ? ` ${detail.className}` : '';

          return `
            <div class="confirm-dialog-detail-row${rowClass}">
              <span class="label">${escapeHtml(detail.label)}</span>
              <span class="value${valueClass}">${escapeHtml(detail.value)}</span>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    const cancelButtonHtml = options.cancelText !== ''
      ? `<button class="confirm-dialog-btn cancel" data-action="cancel">${escapeHtml(options.cancelText || 'Cancel')}</button>`
      : '';

    dialog.innerHTML = `
      <div class="confirm-dialog-header">
        <h3>${escapeHtml(options.title || 'Confirm')}</h3>
      </div>
      <div class="confirm-dialog-body">
        ${options.message ? options.message : ''}
        ${detailsHtml}
      </div>
      <div class="confirm-dialog-footer">
        ${cancelButtonHtml}
        <button class="confirm-dialog-btn confirm" data-action="confirm">${escapeHtml(options.confirmText || 'Confirm')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Check if too expensive and disable confirm button
    const tooExpensiveRow = dialog.querySelector('.confirm-dialog-detail-row.too-expensive');
    const confirmButton = dialog.querySelector('.confirm-dialog-btn.confirm');
    if (tooExpensiveRow && confirmButton) {
      confirmButton.disabled = true;
      confirmButton.classList.add('disabled');
      confirmButton.title = 'Insufficient funds';
    }

    const handleClick = (e) => {
      const action = e.target.dataset.action;

      // Prevent confirm if button is disabled (insufficient funds)
      if (action === 'confirm' && e.target.disabled) {
        return;
      }

      if (action === 'confirm' || action === 'cancel') {
        document.body.removeChild(overlay);
        resolve(action === 'confirm');
      }
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(false);
      }
    });

    dialog.addEventListener('click', handleClick);
  });
}

/**
 * Displays the settings overlay with current settings populated in form fields.
 * Manages price thresholds and AutoPilot configuration interface.
 *
 * Settings Categories:
 * - Price Thresholds: Fuel, CO2, Maintenance alerts
 * - Auto-Rebuy: Automated fuel/CO2 purchasing with customizable triggers
 * - AutoPilot Features: Auto-depart, auto-repair, auto-campaigns
 * - Notifications: AutoPilot action notifications
 *
 * Dynamic UI Behavior:
 * - Auto-rebuy sections expand/collapse based on toggle state
 * - Threshold inputs lock when "Use Alert Price" is enabled
 * - Notifications checkbox only visible when AutoPilot features active
 *
 * Side Effects:
 * - Shows settings overlay
 * - Populates form fields from settings object
 * - Sets up conditional UI visibility
 *
 * @param {Object} settings - Current settings object
 * @param {number} settings.fuelThreshold - Fuel price alert threshold in $/ton
 * @param {number} settings.co2Threshold - CO2 price alert threshold in $/ton
 * @param {number} settings.maintenanceThreshold - Wear percentage for repair alerts
 * @param {boolean} settings.autoRebuyFuel - Enable auto-fuel purchasing
 * @param {boolean} settings.autoRebuyCO2 - Enable auto-CO2 purchasing
 * @param {boolean} settings.autoDepartAll - Enable auto-depart on ready vessels
 * @param {boolean} settings.autoBulkRepair - Enable auto-repair at threshold
 * @param {boolean} settings.autoCampaignRenewal - Enable auto-campaign renewal
 * @param {boolean} settings.autoPilotNotifications - Show notifications for AutoPilot actions
 */
export function showSettings(settings) {
  document.getElementById('fuelThreshold').value = settings.fuelThreshold;
  document.getElementById('co2Threshold').value = settings.co2Threshold;
  document.getElementById('maintenanceThreshold').value = settings.maintenanceThreshold;

  // Auto-Rebuy Fuel
  document.getElementById('autoRebuyFuel').checked = settings.autoRebuyFuel || false;
  const fuelOptions = document.getElementById('autoRebuyFuelOptions');
  if (settings.autoRebuyFuel) {
    fuelOptions.classList.remove('hidden');
  } else {
    fuelOptions.classList.add('hidden');
  }

  const fuelUseAlert = settings.autoRebuyFuelUseAlert !== undefined ? settings.autoRebuyFuelUseAlert : true;
  document.getElementById('autoRebuyFuelUseAlert').checked = fuelUseAlert;

  const fuelThresholdInput = document.getElementById('autoRebuyFuelThreshold');
  if (fuelUseAlert) {
    fuelThresholdInput.value = settings.fuelThreshold;
    fuelThresholdInput.disabled = true;
    fuelThresholdInput.classList.add('disabled');
  } else {
    if (settings.autoRebuyFuelThreshold !== undefined) {
      fuelThresholdInput.value = settings.autoRebuyFuelThreshold;
    }
    fuelThresholdInput.disabled = false;
    fuelThresholdInput.classList.remove('disabled');
    fuelThresholdInput.classList.add('enabled');
  }

  // Auto-Rebuy CO2
  document.getElementById('autoRebuyCO2').checked = settings.autoRebuyCO2 || false;
  const co2Options = document.getElementById('autoRebuyCO2Options');
  if (settings.autoRebuyCO2) {
    co2Options.classList.remove('hidden');
  } else {
    co2Options.classList.add('hidden');
  }

  const co2UseAlert = settings.autoRebuyCO2UseAlert !== undefined ? settings.autoRebuyCO2UseAlert : true;
  document.getElementById('autoRebuyCO2UseAlert').checked = co2UseAlert;

  const co2ThresholdInput = document.getElementById('autoRebuyCO2Threshold');
  if (co2UseAlert) {
    co2ThresholdInput.value = settings.co2Threshold;
    co2ThresholdInput.disabled = true;
    co2ThresholdInput.classList.add('disabled');
  } else {
    if (settings.autoRebuyCO2Threshold !== undefined) {
      co2ThresholdInput.value = settings.autoRebuyCO2Threshold;
    }
    co2ThresholdInput.disabled = false;
    co2ThresholdInput.classList.remove('disabled');
    co2ThresholdInput.classList.add('enabled');
  }

  document.getElementById('autoDepartAll').checked = settings.autoDepartAll || false;
  document.getElementById('autoBulkRepair').checked = settings.autoBulkRepair || false;
  document.getElementById('autoCampaignRenewal').checked = settings.autoCampaignRenewal || false;

  // Desktop notifications master toggle
  const enableDesktopNotifs = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
  document.getElementById('enableDesktopNotifications').checked = enableDesktopNotifs;

  // Individual AutoPilot notification toggles (InApp + Desktop)
  document.getElementById('notifyBarrelBossInApp').checked = settings.notifyBarrelBossInApp !== undefined ? settings.notifyBarrelBossInApp : true;
  document.getElementById('notifyBarrelBossDesktop').checked = settings.notifyBarrelBossDesktop !== undefined ? settings.notifyBarrelBossDesktop : true;
  document.getElementById('notifyAtmosphereBrokerInApp').checked = settings.notifyAtmosphereBrokerInApp !== undefined ? settings.notifyAtmosphereBrokerInApp : true;
  document.getElementById('notifyAtmosphereBrokerDesktop').checked = settings.notifyAtmosphereBrokerDesktop !== undefined ? settings.notifyAtmosphereBrokerDesktop : true;
  document.getElementById('notifyCargoMarshalInApp').checked = settings.notifyCargoMarshalInApp !== undefined ? settings.notifyCargoMarshalInApp : true;
  document.getElementById('notifyCargoMarshalDesktop').checked = settings.notifyCargoMarshalDesktop !== undefined ? settings.notifyCargoMarshalDesktop : true;
  document.getElementById('notifyYardForemanInApp').checked = settings.notifyYardForemanInApp !== undefined ? settings.notifyYardForemanInApp : true;
  document.getElementById('notifyYardForemanDesktop').checked = settings.notifyYardForemanDesktop !== undefined ? settings.notifyYardForemanDesktop : true;
  document.getElementById('notifyReputationChiefInApp').checked = settings.notifyReputationChiefInApp !== undefined ? settings.notifyReputationChiefInApp : true;
  document.getElementById('notifyReputationChiefDesktop').checked = settings.notifyReputationChiefDesktop !== undefined ? settings.notifyReputationChiefDesktop : true;
  document.getElementById('notifyFairHandInApp').checked = settings.notifyFairHandInApp !== undefined ? settings.notifyFairHandInApp : true;
  document.getElementById('notifyFairHandDesktop').checked = settings.notifyFairHandDesktop !== undefined ? settings.notifyFairHandDesktop : true;
  document.getElementById('notifyHarbormasterInApp').checked = settings.notifyHarbormasterInApp !== undefined ? settings.notifyHarbormasterInApp : true;
  document.getElementById('notifyHarbormasterDesktop').checked = settings.notifyHarbormasterDesktop !== undefined ? settings.notifyHarbormasterDesktop : true;
  document.getElementById('notifyCaptainBlackbeardInApp').checked = settings.notifyCaptainBlackbeardInApp !== undefined ? settings.notifyCaptainBlackbeardInApp : true;
  document.getElementById('notifyCaptainBlackbeardDesktop').checked = settings.notifyCaptainBlackbeardDesktop !== undefined ? settings.notifyCaptainBlackbeardDesktop : true;

  // Intelligent Auto-Depart Settings
  const useRouteDefaults = settings.autoDepartUseRouteDefaults !== undefined ? settings.autoDepartUseRouteDefaults : true;
  document.getElementById('autoDepartUseRouteDefaults').checked = useRouteDefaults;

  const customSettingsDiv = document.getElementById('autoDepartCustomSettings');
  const minUtilInput = document.getElementById('minVesselUtilization');
  const speedInput = document.getElementById('autoVesselSpeed');

  if (useRouteDefaults) {
    customSettingsDiv.classList.add('hidden');
  } else {
    customSettingsDiv.classList.remove('hidden');
    if (settings.minVesselUtilization !== undefined) {
      minUtilInput.value = settings.minVesselUtilization;
    }
    if (settings.autoVesselSpeed !== undefined) {
      speedInput.value = settings.autoVesselSpeed;
    }
  }

  // Restore section states from per-user localStorage
  const sectionStates = JSON.parse(window.getStorage('settingsSectionStates') || '{}');
  Object.keys(sectionStates).forEach(contentId => {
    const content = document.getElementById(contentId);
    const toggleId = contentId.replace('Content', 'Toggle');
    const toggle = document.getElementById(toggleId);

    if (content && toggle) {
      if (sectionStates[contentId] === 'open') {
        content.classList.remove('hidden');
        toggle.textContent = '➖';
      } else {
        content.classList.add('hidden');
        toggle.textContent = '➕';
      }
    }
  });

  document.getElementById('settingsOverlay').classList.remove('hidden');
}

/**
 * Closes the settings overlay.
 */
export function closeSettings() {
  document.getElementById('settingsOverlay').classList.add('hidden');
}

/**
 * Displays marketing campaigns overlay with active campaigns and purchase options.
 * Shows company reputation stars and allows activating campaigns for reputation, awareness, and green.
 *
 * Campaign Display:
 * - Active campaigns shown with time remaining
 * - Inactive campaigns grouped by type with purchase buttons
 * - Reputation score displayed as star rating
 * - Duration and efficiency shown for each option
 *
 * Side Effects:
 * - Fetches campaign data from API
 * - Shows campaigns overlay
 * - Renders HTML with inline event handlers for purchase buttons
 *
 * @async
 * @returns {Promise<void>}
 */
export async function showCampaignsOverlay() {
  try {
    const data = await fetchCampaigns();
    const allCampaigns = data.data.marketing_campaigns || [];
    const activeCampaigns = data.data.active_campaigns || [];
    const activeTypes = new Set(activeCampaigns.map(c => c.option_name));
    const totalReputation = data.user.reputation || 0;
    const userCash = data.user.cash || 0;

    const contentDiv = document.getElementById('campaignsContent');
    const requiredTypes = ['reputation', 'awareness', 'green'];

    let html = '';

    html += `
      <div class="campaign-reputation-section">
        <div class="campaign-reputation-title">
          Company Reputation
        </div>
        <div class="campaign-reputation-stars">
          ${renderStars(totalReputation)}
        </div>
        <div class="campaign-reputation-percent">
          ${totalReputation}%
        </div>
      </div>
    `;

    if (activeCampaigns.length > 0) {
      html += `
        <div class="campaign-section-active">
          <h3 class="campaign-section-header">
            ✅ Active Campaigns
          </h3>
          <div class="campaign-items">
      `;

      activeCampaigns.forEach(campaign => {
        const typeName = campaign.option_name.charAt(0).toUpperCase() + campaign.option_name.slice(1);
        const typeIcon = campaign.option_name === 'reputation' ? '⭐' : campaign.option_name === 'awareness' ? '📢' : '🌱';
        const efficiency = `${campaign.increase}%`;
        const duration = campaign.duration;

        const now = Math.floor(Date.now() / 1000);
        const timeLeft = campaign.end_time - now;
        const hoursLeft = Math.floor(timeLeft / 3600);
        const minutesLeft = Math.floor((timeLeft % 3600) / 60);
        const timeLeftStr = `${hoursLeft}h ${minutesLeft}m`;

        html += `
          <div class="campaign-item-active">
            <div class="campaign-item-active-header">
              <div class="campaign-item-active-title">
                ${typeIcon} ${typeName}
              </div>
              <div class="campaign-item-active-time">
                ${timeLeftStr} remaining
              </div>
            </div>
            <div class="campaign-item-active-details">
              <span>Duration: ${duration}h</span>
              <span>Efficiency: ${efficiency}</span>
            </div>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    }

    const inactiveTypes = requiredTypes.filter(type => !activeTypes.has(type));

    if (inactiveTypes.length > 0) {
      inactiveTypes.forEach((type) => {
        const typeName = type.charAt(0).toUpperCase() + type.slice(1);
        const typeIcon = type === 'reputation' ? '⭐' : type === 'awareness' ? '📢' : '🌱';
        const typeCampaigns = allCampaigns.filter(c => c.option_name === type);

        html += `
          <div class="campaign-section">
            <h3 class="campaign-section-header-inactive">
              ${typeIcon} ${typeName} Campaigns
            </h3>
            <div class="campaign-items">
        `;

        typeCampaigns.forEach(campaign => {
          const duration = campaign.campaign_duration;
          const efficiency = `${campaign.min_efficiency}-${campaign.max_efficiency}%`;
          const price = formatNumber(campaign.price);
          const canAfford = userCash >= campaign.price;

          html += `
            <div class="campaign-item-inactive">
              <div class="campaign-item-info">
                <div class="campaign-item-duration">
                  ${duration}h Duration
                </div>
                <div class="campaign-item-efficiency">
                  Efficiency: ${efficiency}
                </div>
              </div>
              <div class="campaign-item-price-wrapper">
                <div class="${canAfford ? 'campaign-item-price-affordable' : 'campaign-item-price-unaffordable'}">
                  $${price}
                </div>
              </div>
              <button
                ${canAfford ? '' : 'disabled'}
                onclick="${canAfford ? `window.buyCampaign(${campaign.id}, '${typeName}', ${duration}, ${campaign.price})` : ''}"
                class="${canAfford ? 'campaign-buy-btn' : 'campaign-buy-btn-disabled'}"
              >
                Buy
              </button>
            </div>
          `;
        });

        html += `
            </div>
          </div>
        `;
      });
    }

    contentDiv.innerHTML = html;
    document.getElementById('campaignsOverlay').classList.remove('hidden');
  } catch (error) {
    console.error('Error showing campaigns overlay:', error);
    showSideNotification('Failed to load campaigns', 'error');
  }
}

/**
 * Closes the campaigns overlay.
 */
export function closeCampaignsOverlay() {
  document.getElementById('campaignsOverlay').classList.add('hidden');
}

/**
 * Initiates marketing campaign purchase with confirmation dialog.
 * Shows cost breakdown and activates campaign upon confirmation.
 *
 * @async
 * @param {number} campaignId - Campaign ID to activate
 * @param {string} typeName - Campaign type name (Reputation/Awareness/Green)
 * @param {number} duration - Campaign duration in hours
 * @param {number} price - Campaign cost in dollars
 * @param {Object} [updateCallbacks] - Optional callbacks for UI updates
 * @param {Function} updateCallbacks.updateCampaignsStatus - Refresh campaigns status
 * @param {Function} updateCallbacks.updateBunkerStatus - Refresh cash display
 * @returns {Promise<void>}
 */
export async function buyCampaign(campaignId, typeName, duration, price, updateCallbacks) {
  const confirmed = await showConfirmDialog({
    title: '📊 Activate Campaign',
    message: `Do you want to activate this ${typeName} campaign?`,
    confirmText: 'Activate',
    narrow: true,
    details: [
      { label: 'Type', value: typeName },
      { label: 'Duration', value: `${duration} hours` },
      { label: 'Cost', value: `$${formatNumber(price)}` }
    ]
  });

  if (!confirmed) return;

  try {
    const data = await activateCampaign(campaignId);

    // After purchase attempt, refresh campaigns to verify it actually activated
    const campaignsData = await fetchCampaigns();
    const activeCampaigns = campaignsData.data.active_campaigns || [];

    // Check if the campaign we just tried to buy is now active
    const isCampaignActive = activeCampaigns.some(c => c.id === campaignId);

    if (isCampaignActive) {
      // Campaign is active - purchase was successful
      showSideNotification(`✅ ${typeName} campaign activated for ${duration} hours!`, 'success');

      // Refresh the campaign overlay to show updated state
      await showCampaignsOverlay();

      // WebSocket will auto-update campaign badge and bunker status
      if (updateCallbacks && updateCallbacks.updateBunkerStatus) {
        await updateCallbacks.updateBunkerStatus();
      }
    } else {
      // Campaign is not active - purchase failed
      let errorMsg = data.error || 'Failed to activate campaign';

      // Format common error messages
      if (errorMsg === 'not_enough_cash') {
        errorMsg = '<strong>Campaign Manager</strong><br><br>Insufficient funds to activate campaign!';
      } else if (errorMsg === 'campaign_type_already_active') {
        errorMsg = '<strong>Campaign Manager</strong><br><br>This campaign type is already active!';
      } else if (errorMsg.includes('not_enough') || errorMsg.includes('insufficient')) {
        errorMsg = `<strong>Campaign Manager</strong><br><br>${errorMsg}`;
      } else {
        errorMsg = `<strong>Campaign Manager</strong><br><br>${errorMsg}`;
      }

      showSideNotification(errorMsg, 'error');

      // Refresh the campaign overlay to show updated state even on error
      await showCampaignsOverlay();

      // WebSocket will auto-update campaign badge and bunker status
      if (updateCallbacks && updateCallbacks.updateBunkerStatus) {
        await updateCallbacks.updateBunkerStatus();
      }
    }

  } catch (error) {
    console.error('Error buying campaign:', error);
    showSideNotification('Failed to activate campaign', 'error');

    // Refresh the campaign overlay even on exception
    try {
      await showCampaignsOverlay();

      // WebSocket will auto-update campaign badge and bunker status
      if (updateCallbacks && updateCallbacks.updateBunkerStatus) {
        await updateCallbacks.updateBunkerStatus();
      }
    } catch (refreshError) {
      console.error('Failed to refresh campaigns overlay:', refreshError);
    }
  }
}

/**
 * Displays contact list overlay with contacts and alliance members.
 * Allows clicking send button to start new private conversation.
 *
 * Contact Categories:
 * - Personal Contacts: User's saved contacts
 * - Alliance Contacts: Current alliance members
 *
 * Side Effects:
 * - Fetches contacts from API
 * - Shows contact list overlay
 * - Registers click handlers to open messenger
 *
 * @async
 * @returns {Promise<void>}
 */
export async function showContactList() {
  try {
    const data = await fetchContacts();
    const contacts = data.contacts || [];
    const allianceContacts = data.alliance_contacts || [];

    const listContainer = document.getElementById('contactListFeed');

    if (contacts.length === 0 && allianceContacts.length === 0) {
      listContainer.innerHTML = '<div class="empty-message">No contacts found.</div>';
    } else {
      const renderContactList = (contactsList) => {
        return contactsList.map((contact) => {
          const contactName = contact.company_name || `User ${contact.id}`;
          const userId = contact.id;

          return `
            <div class="contact-row">
              <div class="contact-name-cell">
                <span class="contact-name">${escapeHtml(contactName)}</span><span class="contact-id"> (${userId})</span>
              </div>
              <div class="contact-button-cell">
                <button class="contact-send-btn" data-user-id="${userId}" data-company-name="${escapeHtml(contactName)}">
                  📩 Send
                </button>
              </div>
            </div>
          `;
        }).join('');
      };

      let html = '';

      if (contacts.length > 0) {
        html += `
          <div class="contact-section">
            <h3 class="contact-section-title">Contacts</h3>
            <div class="contact-table">
              ${renderContactList(contacts)}
            </div>
          </div>
        `;
      }

      if (allianceContacts.length > 0) {
        html += `
          <div class="contact-section">
            <h3 class="contact-section-title">Alliance Contacts</h3>
            <div class="contact-table">
              ${renderContactList(allianceContacts)}
            </div>
          </div>
        `;
      }

      listContainer.innerHTML = html;

      listContainer.querySelectorAll('.contact-send-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const userId = parseInt(btn.dataset.userId);
          const companyName = btn.dataset.companyName;

          document.getElementById('contactListOverlay').classList.add('hidden');
          if (window.openNewChatFromContact) {
            window.openNewChatFromContact(companyName, userId);
          }
        });
      });
    }

    document.getElementById('contactListOverlay').classList.remove('hidden');

  } catch (error) {
    console.error('Error loading contact list:', error);
    alert(`Error: ${error.message}`);
  }
}

export function closeContactList() {
  document.getElementById('contactListOverlay').classList.add('hidden');
}

export async function showAnchorInfo() {
  // Show anchor purchase dialog (instant completion via reset-timing exploit)
  showAnchorPurchaseDialog();
}
