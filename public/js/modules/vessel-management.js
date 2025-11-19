/**
 * @fileoverview Vessel Management Module - Handles all vessel-related operations including purchasing,
 * departures, bulk repair, and vessel catalog browsing with filtering.
 *
 * Key Features:
 * - Vessel count tracking (ready to depart, at anchor, pending delivery)
 * - Bulk departure with fuel/CO2 consumption and income calculation
 * - Bulk repair system with wear threshold filtering
 * - Vessel catalog with container/tanker filtering
 * - Engine type filtering for specialized searches
 * - Multi-vessel purchase with confirmation and sequential API calls
 * - Stock price display for IPO companies
 * - Pending vessel tracking with delivery countdown
 *
 * Purchase Flow:
 * - Single purchase: Click "Buy Now" for immediate purchase
 * - Bulk purchase: Select multiple vessels, click "Bulk Buy"
 * - Sequential API calls with 1.5s delay to prevent rate limiting
 * - Cash updates after each successful purchase
 * - Auto-stops on limit reached or insufficient funds
 *
 * Departure System:
 * - Departs all vessels in "port" status simultaneously
 * - Calculates fuel consumption and CO2 emissions
 * - Shows income from vessel departures minus harbor fees
 * - Updates bunker inventory immediately for UX responsiveness
 * - Refreshes vessel and bunker status after completion
 *
 * Repair System:
 * - Filters vessels by wear percentage threshold (user configurable)
 * - Fetches repair costs for all qualifying vessels
 * - Shows total cost with affordability check
 * - Bulk repair via single API call
 *
 * @module vessel-management
 * @requires utils - Formatting and feedback functions
 * @requires api - Vessel API endpoints
 * @requires ui-dialogs - Confirmation dialogs
 * @requires bunker-management - Cash and fuel inventory management
 */

import { formatNumber, showSideNotification } from './utils.js';
import { escapeHtml } from './utils.js';
import {
  fetchVessels,
  fetchUserSettings,
  departAllVessels as apiDepartAllVessels,
  fetchAcquirableVessels,
  purchaseVessel as apiPurchaseVessel
} from './api.js';
import { selectVessel } from './harbor-map/map-controller.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { getCurrentBunkerState, updateCurrentCash } from './bunker-management.js';
import { updateBadge, updateButtonState, updateButtonTooltip } from './badge-manager.js';

/**
 * Load cart from localStorage (user-specific)
 */
function loadCartFromStorage() {
  try {
    const storageKey = window.USER_STORAGE_PREFIX ? `vesselCart_${window.USER_STORAGE_PREFIX}` : 'vesselCart';
    const stored = localStorage.getItem(storageKey);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('[Vessel Cart] Failed to load from storage:', error);
    return [];
  }
}

/**
 * Save cart to localStorage (user-specific)
 */
function saveCartToStorage() {
  try {
    const storageKey = window.USER_STORAGE_PREFIX ? `vesselCart_${window.USER_STORAGE_PREFIX}` : 'vesselCart';
    localStorage.setItem(storageKey, JSON.stringify(selectedVessels));
  } catch (error) {
    console.error('[Vessel Cart] Failed to save to storage:', error);
  }
}

/**
 * Array of all vessels available for purchase.
 * Populated from API and filtered by type/engine for display.
 * @type {Array<Object>}
 */
let allAcquirableVessels = [];

/**
 * Current vessel type filter: 'container' or 'tanker'.
 * @type {string}
 */
let currentVesselFilter = 'container';

/**
 * Current engine type filter (null shows all engines).
 * Populated from unique engine types in vessel catalog.
 * @type {string|null}
 */
let selectedEngineType = null;

/**
 * Array of selected vessels for bulk purchase.
 * Each item contains vessel object and quantity.
 * Persisted in localStorage to survive page reloads.
 * @type {Array<{vessel: Object, quantity: number}>}
 */
let selectedVessels = loadCartFromStorage();

/**
 * Cache for last known vessel counts to prevent flickering during updates
 */
let lastKnownCounts = {
  pending: null,
  port: null,
  anchor: null
};

/**
 * Get available anchor slots from global cache
 * @returns {number} Number of free anchor slots (from updateDataCache.anchor.available)
 */
function getAvailableAnchorSlots() {
  // Read DIRECTLY from global cache that's managed by chat.js
  // This is the SAME value shown in the header as "Free X"
  if (window.updateDataCache && window.updateDataCache.anchor && window.updateDataCache.anchor.available !== undefined) {
    return window.updateDataCache.anchor.available;
  }
  // Fallback: if cache not available yet, return 0 (disabled buttons until data loads)
  return 0;
}

/**
 * Refresh vessel cards display if vessels are currently visible
 * This updates button states based on available anchor slots
 * NOTE: This function is no longer called automatically - overlays only refresh when user opens them
 * Keeping function for backward compatibility but it should not be used
 * @deprecated Auto-refresh disabled to prevent filter resets
 */
function refreshVesselCardsIfVisible() {
  // Function intentionally disabled - do nothing
  // Vessel catalog will update when user reopens it
  console.warn('[Vessel Management] refreshVesselCardsIfVisible() called but auto-refresh is disabled');
}

// Keep function on window for backward compatibility but it does nothing now
window.refreshVesselCardsIfVisible = refreshVesselCardsIfVisible;

/**
 * Server-controlled lock states.
 * IMPORTANT: These are READ-ONLY on client side. Only server can modify via WebSocket events.
 * Client receives lock_status updates from server and must never set these directly.
 *
 * Lock Types:
 * - depart: Vessel departure operation in progress
 * - repair: Bulk repair operation in progress
 * - bulkBuy: Bulk vessel purchase in progress
 * - fuelPurchase: Fuel purchase operation in progress
 * - co2Purchase: CO2 purchase operation in progress
 *
 * @type {Object}
 */
const serverLockState = {
  depart: false,
  repair: false,
  bulkBuy: false,
  fuelPurchase: false,
  co2Purchase: false,
  drydock: false
};

/**
 * Updates lock state from server WebSocket event.
 * Called by chat.js when receiving 'lock_status' event.
 * Updates internal state AND UI to reflect server lock status.
 *
 * @param {Object} locks - Lock state object from server
 */
export function updateLockStateFromServer(locks) {
  if (locks.depart !== undefined) {
    serverLockState.depart = locks.depart;
    // Update depart button UI based on server lock state and vessel count
    const countBadge = document.querySelector('.map-icon-item[data-action="departAll"] .map-icon-badge');
    const hasVessels = countBadge && !countBadge.classList.contains('hidden') && parseInt(countBadge.textContent) > 0;
    updateButtonState('departAll', locks.depart || !hasVessels);
  }

  if (locks.repair !== undefined) {
    serverLockState.repair = locks.repair;
    updateButtonState('repairAll', locks.repair);
  }

  if (locks.bulkBuy !== undefined) {
    serverLockState.bulkBuy = locks.bulkBuy;
    const cartBtn = document.getElementById('cartBtn');
    if (cartBtn) {
      cartBtn.disabled = locks.bulkBuy;
    }
  }

  if (locks.fuelPurchase !== undefined) {
    serverLockState.fuelPurchase = locks.fuelPurchase;
    const fuelBtn = document.getElementById('fuelBtn');
    if (fuelBtn) {
      fuelBtn.disabled = locks.fuelPurchase;
    }
  }

  if (locks.co2Purchase !== undefined) {
    serverLockState.co2Purchase = locks.co2Purchase;
    const co2Btn = document.getElementById('co2Btn');
    if (co2Btn) {
      co2Btn.disabled = locks.co2Purchase;
    }
  }

  if (locks.drydock !== undefined) {
    serverLockState.drydock = locks.drydock;
    updateButtonState('drydockAll', locks.drydock);
  }

  console.log('[Lock State] Updated from server:', serverLockState);
}

/**
 * Updates vessel count badges and status displays for different vessel states.
 * Fetches current vessel data and updates UI badges for ready-to-depart, at-anchor, and pending vessels.
 *
 * Vessel States:
 * - 'port': Ready to depart (shows on depart button badge)
 * - 'anchor': At anchor waiting for route planning (shows on anchor button)
 * - 'pending': Vessel purchased but not yet delivered (shows delivery countdown)
 *
 * Additional Data Updates:
 * - Anchor capacity: Available slots vs maximum
 * - Stock price: For companies that have gone IPO
 * - Stock trend: Up/down indicator
 *
 * Side Effects:
 * - Fetches vessel and user settings data from API
 * - Updates multiple DOM badges and displays
 * - Enables/disables buttons based on vessel availability
 * - Updates button tooltips with contextual information
 *
 * @async
 * @returns {Promise<void>}
 *
 * @example
 * // Called once on page load
 * updateVesselCount();
 */
export async function updateVesselCount() {
  try {
    // Fetch data
    const data = await fetchVessels();
    const vessels = data.vessels || [];

    const readyToDepart = vessels.filter(v => v.status === 'port' && !v.is_parked).length;
    const atAnchor = vessels.filter(v => v.status === 'anchor').length;
    const pendingVessels = vessels.filter(v => v.status === 'pending').length;

    // Cache new values
    lastKnownCounts.pending = pendingVessels;
    lastKnownCounts.port = readyToDepart;
    lastKnownCounts.anchor = atAnchor;

    // Update harbor map if open (piggyback on vessel data update)
    if (window.harborMap && window.harborMap.refreshIfOpen) {
      await window.harborMap.refreshIfOpen();
    }

    // Update pending vessels badge
    updateBadge('pendingVesselsBadge', pendingVessels, pendingVessels > 0, 'ORANGE');
    updateButtonTooltip('buyVessels', pendingVessels > 0 ? `Vessels in delivery: ${pendingVessels}` : 'Buy vessels');

    // Update pending filter button in overlay (if exists)
    const pendingBtn = document.getElementById('filterPendingBtn');
    const pendingCountSpan = document.getElementById('pendingCount');
    if (pendingBtn && pendingCountSpan) {
      pendingCountSpan.textContent = pendingVessels;
      if (pendingVessels > 0) {
        pendingBtn.classList.remove('hidden');
      } else {
        pendingBtn.classList.add('hidden');
      }
    }

    // Update depart badge and button
    updateBadge('vesselCount', readyToDepart, readyToDepart > 0, 'BLUE');
    updateButtonState('departAll', readyToDepart === 0 || serverLockState.depart);
    updateButtonTooltip('departAll',
      readyToDepart > 0
        ? `Depart all ${readyToDepart} vessel${readyToDepart === 1 ? '' : 's'} from harbor`
        : 'No vessels ready to depart'
    );

    // Update anchor badge and button
    updateBadge('anchorCount', atAnchor, atAnchor > 0, 'RED');
    updateButtonTooltip('anchor',
      atAnchor > 0
        ? `${atAnchor} vessel${atAnchor === 1 ? '' : 's'} at anchor - Click to purchase anchor points`
        : 'Purchase anchor points'
    );

    const settingsResponse = await fetchUserSettings();
    if (settingsResponse) {
      // Anchor slots are managed by global updateDataCache.anchor.available (read-only)
      const stockValue = settingsResponse.user?.stock_value || 0;
      const stockTrend = settingsResponse.user?.stock_trend || '';

      // Anchor display is handled by script.js and chat.js - don't duplicate here

      const stockDisplay = document.getElementById('stockDisplay');
      const stockTrendElement = document.getElementById('stockTrend');
      const ipo = settingsResponse.user?.ipo || 0;

      if (stockDisplay && stockTrendElement) {
        const stockContainer = stockDisplay.parentElement;

        if (ipo === 1) {
          stockContainer.classList.remove('hidden');
          stockDisplay.textContent = `$${stockValue.toFixed(2)}`;

          if (stockTrend === 'up') {
            stockTrendElement.textContent = '↑';
            stockTrendElement.classList.add('text-success');
            stockTrendElement.classList.remove('text-danger');
          } else if (stockTrend === 'down') {
            stockTrendElement.textContent = '↓';
            stockTrendElement.classList.add('text-danger');
            stockTrendElement.classList.remove('text-success');
          } else {
            stockTrendElement.textContent = '';
            stockTrendElement.classList.remove('text-success', 'text-danger');
          }
        } else {
          stockContainer.classList.add('hidden');
        }
      }
    }

    // Refresh vessel cards to update button states based on new anchor slot availability
    refreshVesselCardsIfVisible();

  } catch (error) {
    console.error('Error updating vessel count:', error);
  }
}

/**
 * Departs all vessels currently in harbor (status 'port').
 * Calculates and displays fuel usage, CO2 emissions, income, and harbor fees.
 *
 * Departure Process:
 * 1. Disables depart button to prevent double-click
 * 2. Calls API to depart all ready vessels
 * 3. Extracts resource usage and income from response
 * 4. Updates local cash/fuel/CO2 immediately for UX
 * 5. Triggers delayed refresh of vessel and bunker displays
 * 6. Shows detailed price alert with departure summary
 *
 * Partial Departure Handling:
 * - If not all vessels departed (insufficient fuel): Shows error with count
 * - If no vessels departed: Shows critical error message
 * - If all departed successfully: Shows success message with details
 *
 * Resource Updates:
 * - Cash: Increased by (depart_income - harbor_fee)
 * - Fuel: Decreased by fuel_usage
 * - CO2: Decreased by co2_emission
 *
 * Side Effects:
 * - Makes API call to depart vessels
 * - Updates bunker state (cash, fuel, CO2)
 * - Triggers debounced vessel and bunker status updates
 * - Shows price alert with departure details
 * - Disables button during operation
 *
 * @async
 * @returns {Promise<void>}
 *
 * @example
 * // User clicks "Depart All" button
 * departAllVessels();
 * // Shows: "5 vessels departed! Fuel: 150t, CO2: 45t, Net income: $125,000"
 */
export async function departAllVessels() {
  // Server will handle lock checking - no client-side lock check needed
  // Button lock is controlled by server via WebSocket lock_status events

  try {
    const data = await apiDepartAllVessels();

    // Backend broadcasts notification to ALL clients via WebSocket
    // No need to show notification here - all clients will receive it

    // Server will broadcast lock_status to unlock button
    // No client-side state manipulation needed

    if (window.DEBUG_MODE) {
      if (data.success === false) {
        console.log('[Depart All] Departure failed:', data.reason);
      } else {
        console.log('[Depart All] Departure succeeded');
      }
    }

  } catch (error) {
    // Network errors or other exceptions
    console.error('[Depart All] Error:', error);
    // Server will handle unlock via lock_status event
  }
}

export async function updateRepairCount(settings) {
  try {
    const data = await fetchVessels();
    const vessels = data.vessels || [];

    const vesselsNeedingRepair = vessels.filter(v => {
      const wear = parseInt(v.wear) || 0;
      return wear >= settings.maintenanceThreshold;
    });

    // Update repair badge using badge-manager
    updateBadge('repairCount', vesselsNeedingRepair.length, vesselsNeedingRepair.length > 0, 'RED');

    // Get drydock count from badge (if exists)
    const drydockBadge = document.querySelector('.map-icon-item[data-action="repairAll"] .map-icon-badge-bottom-left');
    const drydockCount = drydockBadge ? (parseInt(drydockBadge.textContent) || 0) : 0;

    // Update button state (check both repair AND drydock counts)
    const hasWork = vesselsNeedingRepair.length > 0 || drydockCount > 0;
    updateButtonState('repairAll', !hasWork);

    // Update tooltip
    if (vesselsNeedingRepair.length > 0 && drydockCount > 0) {
      updateButtonTooltip('repairAll', `Repair ${vesselsNeedingRepair.length} vessel${vesselsNeedingRepair.length === 1 ? '' : 's'} or drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`);
    } else if (vesselsNeedingRepair.length > 0) {
      updateButtonTooltip('repairAll', `Repair ${vesselsNeedingRepair.length} vessel${vesselsNeedingRepair.length === 1 ? '' : 's'} with ${settings.maintenanceThreshold}%+ wear`);
    } else if (drydockCount > 0) {
      updateButtonTooltip('repairAll', `Drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`);
    } else {
      updateButtonTooltip('repairAll', 'No vessels need repair or drydock');
    }
  } catch (error) {
    console.error('Error updating repair count:', error);
  }
}

/**
 * Repairs all vessels with wear at or above the configured maintenance threshold.
 * Shows confirmation dialog with total cost and processes bulk repair.
 *
 * Repair Flow:
 * 1. Fetch current vessels from API
 * 2. Filter vessels by wear threshold from settings
 * 3. Get repair cost estimate for all qualifying vessels
 * 4. Check affordability (cash >= total cost)
 * 5. Show confirmation dialog with cost breakdown
 * 6. Process bulk repair API call
 * 7. Update bunker status and repair count displays
 *
 * Cost Calculation:
 * - Fetches maintenance data for each vessel
 * - Sums "wear" type maintenance costs
 * - Compares against current cash
 *
 * Side Effects:
 * - Fetches vessel and maintenance cost data
 * - Shows confirmation dialog
 * - Makes bulk repair API call
 * - Updates cash via bunker state
 * - Triggers debounced status updates
 * - Shows success/error feedback
 * - Disables button during operation
 *
 * @async
 * @param {Object} settings - User settings object
 * @param {number} settings.maintenanceThreshold - Minimum wear percentage to trigger repair
 * @returns {Promise<void>}
 *
 * @example
 * // Repairs all vessels with 10%+ wear
 * repairAllVessels({ maintenanceThreshold: 10 });
 */
/**
 * Shows bulk repair dialog with vessel list and costs
 */
/**
 * Shows tabbed dialog with Wear Repairs and Drydock tabs
 * @param {Object} settings - User settings
 * @param {number} repairCount - Badge count for repairs
 * @param {number} drydockCount - Badge count for drydock
 * @param {number} [specificVesselId] - Optional: Show only this vessel
 */
async function showRepairAndDrydockDialog(settings, repairCount, drydockCount, specificVesselId = null) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog bulk-repair-dialog';

    // Show dialog immediately with loading state
    dialog.innerHTML = `
      <div class="confirm-dialog-header">
        <h3>🔧 Vessel Maintenance</h3>
        <div class="confirm-dialog-buttons">
          <button class="confirm-dialog-btn cancel" data-action="cancel-loading">Close</button>
        </div>
      </div>
      <div class="confirm-dialog-body" style="text-align: center; padding: 60px;">
        <div style="font-size: 32px; margin-bottom: 16px;">⏳</div>
        <div style="color: #9ca3af;">Loading vessel data...</div>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Allow closing during loading
    let isCancelled = false;
    const cancelButton = dialog.querySelector('[data-action="cancel-loading"]');
    if (cancelButton) {
      cancelButton.addEventListener('click', () => {
        isCancelled = true;
        overlay.remove();
        resolve(false);
      });
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        isCancelled = true;
        overlay.remove();
        resolve(false);
      }
    });

    // Determine initial active tab based on badge counts
    let activeTab = repairCount > 0 ? 'repair' : 'drydock';

    // Declare repairData and drydockData outside if/else
    let repairData;
    let drydockData;

    // If specific vessel ID provided, fetch only that vessel
    if (specificVesselId) {
      const indexResponse = await fetch(window.apiUrl('/api/game/index'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const indexData = await indexResponse.json();
      const allVessels = indexData.data.user_vessels || [];
      const specificVessel = allVessels.find(v => v.id === specificVesselId);

      if (!specificVessel) {
        showSideNotification('Vessel not found', 'error');
        resolve(false);
        return;
      }

      // Fetch repair cost for specific vessel (IGNORE thresholds - always show)
      const wear = parseFloat(specificVessel.wear) || 0;
      let repairCostData = { vessels: [], totalCost: 0, cash: 0 };

      try {
        const repairResponse = await fetch(window.apiUrl('/api/vessel/get-repair-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: 0 }) // Use threshold 0 to get all vessels
        });
        const allRepairData = await repairResponse.json();

        // Filter for specific vessel
        const specificRepairVessel = allRepairData.vessels?.find(v => v.id === specificVesselId);
        if (specificRepairVessel) {
          // Found in API response - use real cost
          repairCostData = {
            vessels: [specificRepairVessel],
            totalCost: specificRepairVessel.cost || 0,
            cash: allRepairData.cash || 0
          };
        } else {
          // Not in API response (probably wear = 0%) - add manually with $0 cost
          repairCostData = {
            vessels: [{
              id: specificVessel.id,
              name: specificVessel.name,
              wear: wear.toFixed(2),
              cost: 0
            }],
            totalCost: 0,
            cash: allRepairData.cash || indexData.data.bunker?.cash || 0
          };
        }
      } catch (error) {
        console.error('[Vessel Management] Failed to fetch repair costs:', error);
        // Fallback: show vessel with $0 cost
        repairCostData = {
          vessels: [{
            id: specificVessel.id,
            name: specificVessel.name,
            wear: wear.toFixed(2),
            cost: 0
          }],
          totalCost: 0,
          cash: indexData.data.bunker?.cash || 0
        };
      }

      repairData = {
        vessels: repairCostData.vessels,
        totalCost: repairCostData.totalCost,
        cash: repairCostData.cash
      };

      // Prepare drydock data for specific vessel (IGNORE thresholds - always show)
      const drydockDataRaw = [specificVessel];
      const vesselIds = [specificVessel.id];

      let costData = { vessels: [], totalCost: 0, cash: 0 };
      try {
        const costResponse = await fetch(window.apiUrl('/api/maintenance/get-drydock-status'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vessel_ids: JSON.stringify(vesselIds),
            speed: settings.autoDrydockSpeed || 'minimum',
            maintenance_type: settings.autoDrydockType || 'major'
          })
        });
        costData = await costResponse.json();
        console.log('[Vessel Management] Drydock cost response:', costData);
      } catch (error) {
        console.error('[Vessel Management] Failed to fetch drydock costs:', error);
      }

      // ALWAYS show vessel, even if API returns no cost (e.g., 350h until check)
      drydockData = {
        vessels: drydockDataRaw.map(v => {
          const costVessel = costData.vessels?.find(cv => cv.id === v.id);
          return {
            ...v,
            cost: costVessel?.cost || 0
          };
        }),
        totalCost: costData.totalCost || 0,
        cash: costData.cash || repairCostData.cash || 0
      };

      // Determine active tab based on what's available
      activeTab = repairData.vessels.length > 0 ? 'repair' : 'drydock';

      // Update counts for badge display
      repairCount = repairData.vessels.length;
      drydockCount = drydockData.vessels.length;

      // Continue with dialog rendering below (skip fetch)
    } else {
      // Fetch data for both tabs (normal mode - all vessels meeting criteria)
      const [repairDataFetch, drydockDataRaw] = await Promise.all([
        repairCount > 0 ? fetch(window.apiUrl('/api/vessel/get-repair-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: settings.maintenanceThreshold })
        }).then(res => res.json()) : Promise.resolve({ vessels: [] }),

        drydockCount > 0 ? fetch(window.apiUrl('/api/game/index'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).then(res => res.json()).then(data => {
          const vessels = data.data.user_vessels || [];
          return vessels.filter(v => {
            const hours = v.hours_until_check !== undefined ? v.hours_until_check : 999;
            const alreadyScheduled = v.next_route_is_maintenance === true;
            return hours <= settings.autoDrydockThreshold && !alreadyScheduled;
          });
        }) : Promise.resolve([])
      ]);

      repairData = repairDataFetch;

      // Fetch drydock costs
      drydockData = { vessels: [], totalCost: 0, cash: 0 };
      if (drydockDataRaw.length > 0) {
        const vesselIds = drydockDataRaw.map(v => v.id);
        const costResponse = await fetch(window.apiUrl('/api/maintenance/get-drydock-status'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vessel_ids: JSON.stringify(vesselIds),
            speed: settings.autoDrydockSpeed || 'minimum',
            maintenance_type: settings.autoDrydockType || 'major'
          })
        });
        const costData = await costResponse.json();

        // Merge vessel data with costs
        drydockData.vessels = drydockDataRaw.map(v => {
          const costVessel = costData.vessels?.find(cv => cv.id === v.id);
          return {
            ...v,
            cost: costVessel?.cost || 0
          };
        });
        drydockData.totalCost = costData.totalCost || 0;
        drydockData.cash = costData.cash || 0;
      }
    }

    // If user cancelled during loading, don't update dialog
    if (isCancelled) {
      return;
    }

    const updateDialog = () => {
      // Determine which execute button to show based on active tab
      const executeButtonHTML = activeTab === 'repair'
        ? (repairData.vessels?.length > 0 ? '<button class="confirm-dialog-btn confirm" id="executeRepair">Repair All</button>' : '')
        : (drydockData.vessels?.length > 0 ? '<button class="confirm-dialog-btn confirm" id="executeDrydock">Send to Drydock</button>' : '');

      dialog.innerHTML = `
        <div class="confirm-dialog-header">
          <h3>🔧 Vessel Maintenance</h3>
          <div class="confirm-dialog-buttons">
            <button class="confirm-dialog-btn cancel" data-action="cancel">Close</button>
            ${executeButtonHTML}
          </div>
        </div>
        <div class="confirm-dialog-body">
          <div class="repair-tabs">
            <button class="tab-button ${activeTab === 'repair' ? 'tab-active' : ''}" data-tab="repair">
              Wear Repairs
              ${repairCount > 0 ? `<span class="tab-badge">${repairCount}</span>` : ''}
            </button>
            <button class="tab-button ${activeTab === 'drydock' ? 'tab-active' : ''}" data-tab="drydock">
              Drydock
              ${drydockCount > 0 ? `<span class="tab-badge">${drydockCount}</span>` : ''}
            </button>
          </div>

          <div class="tab-content ${activeTab === 'repair' ? 'tab-active' : ''}" id="repairTab">
            ${renderRepairTab(repairData, settings)}
          </div>

          <div class="tab-content ${activeTab === 'drydock' ? 'tab-active' : ''}" id="drydockTab">
            ${renderDrydockTab(drydockData, settings, specificVesselId !== null)}
          </div>
        </div>
      `;

      // Tab switching
      dialog.querySelectorAll('[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeTab = btn.dataset.tab;
          updateDialog();
        });
      });

      // Close button
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });

      // Repair tab execute button
      const repairExecuteBtn = dialog.querySelector('#executeRepair');
      if (repairExecuteBtn) {
        repairExecuteBtn.addEventListener('click', async () => {
          // Close dialog
          overlay.remove();

          // Execute repair directly (no need to reload data - we already have it)
          // Disable repair button during operation
          updateButtonState('repairAll', true);

          try {
            // Call backend to repair all vessels
            const response = await fetch(window.apiUrl('/api/vessel/bulk-repair'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ threshold: settings.maintenanceThreshold })
            });

            await response.json();

            // Re-enable button
            updateButtonState('repairAll', false);

            // Update counts
            if (window.debouncedUpdateRepairCount && window.debouncedUpdateBunkerStatus) {
              setTimeout(() => window.debouncedUpdateRepairCount(800), 1000);
              setTimeout(() => window.debouncedUpdateBunkerStatus(800), 1200);
            }
          } catch (error) {
            console.error('[Bulk Repair] Error:', error);
            // Re-enable button on error
            updateButtonState('repairAll', false);
          }

          resolve(true);
        });
      }

      // Drydock tab execute button
      const drydockExecuteBtn = dialog.querySelector('#executeDrydock');
      if (drydockExecuteBtn) {
        drydockExecuteBtn.addEventListener('click', async () => {
          await executeDrydock(settings, dialog, overlay);
          resolve(true);
        });
      }

      // Live update drydock costs when speed or type changes
      const drydockSpeedSelect = dialog.querySelector('#drydockSpeed');
      const drydockTypeSelect = dialog.querySelector('#drydockType');

      const updateDrydockCosts = async () => {
        if (!drydockSpeedSelect || !drydockTypeSelect) return;

        const selectedSpeed = drydockSpeedSelect.value;
        const selectedType = drydockTypeSelect.value;

        // Get all vessel IDs from drydockData
        const vesselIds = drydockData.vessels.map(v => v.id);
        if (vesselIds.length === 0) return;

        try {
          const costResponse = await fetch(window.apiUrl('/api/maintenance/get-drydock-status'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vessel_ids: JSON.stringify(vesselIds),
              speed: selectedSpeed,
              maintenance_type: selectedType
            })
          });
          const costData = await costResponse.json();

          // Update drydockData with new costs
          drydockData.vessels = drydockData.vessels.map(v => {
            const costVessel = costData.vessels?.find(cv => cv.id === v.id);
            return {
              ...v,
              cost: costVessel?.cost || 0
            };
          });
          drydockData.totalCost = costData.totalCost || 0;
          drydockData.cash = costData.cash || drydockData.cash;

          // Update settings temporarily for rendering
          settings.autoDrydockSpeed = selectedSpeed;
          settings.autoDrydockType = selectedType;

          // Re-render dialog
          updateDialog();
        } catch (error) {
          console.error('[Vessel Management] Failed to update drydock costs:', error);
        }
      };

      if (drydockSpeedSelect) {
        drydockSpeedSelect.addEventListener('change', updateDrydockCosts);
      }
      if (drydockTypeSelect) {
        drydockTypeSelect.addEventListener('change', updateDrydockCosts);
      }
    };

    // Update dialog content (overlay already added to DOM above)
    updateDialog();
    // Note: overlay click listener already added above during loading state
  });
}

/**
 * Renders the Repair tab content
 */
function renderRepairTab(costData, settings) {
  const vessels = costData.vessels || [];
  const totalCost = costData.totalCost || 0;
  const bunkerCash = costData.cash || 0;
  const affordable = bunkerCash >= totalCost;

  if (vessels.length === 0) {
    return '<div style="text-align: center; color: #9ca3af; padding: 40px;">No vessels need repair</div>';
  }

  const vesselListHtml = vessels.map(v => `
    <div class="repair-vessel-row">
      <span class="vessel-name">${escapeHtml(v.name)}</span>
      <span class="vessel-wear">${v.wear}%</span>
      <span class="vessel-cost">$${formatNumber(v.cost)}</span>
    </div>
  `).join('');

  return `
    <div class="repair-summary ${affordable ? 'affordable' : 'too-expensive'}">
      <div class="summary-row">
        <span class="label">Vessels to repair:</span>
        <span class="value">${vessels.length}</span>
      </div>
      <div class="summary-row total">
        <span class="label">Total Cost:</span>
        <span class="value">$${formatNumber(totalCost)}</span>
      </div>
      <div class="summary-row cash">
        <span class="label">Available Cash:</span>
        <span class="value">$${formatNumber(bunkerCash)}</span>
      </div>
      <div class="summary-row threshold">
        <span class="label">Wear Threshold:</span>
        <span class="value">${settings.maintenanceThreshold}%+</span>
      </div>
    </div>
    <div class="repair-vessel-list">
      <div class="repair-vessel-header">
        <span>Vessel Name</span>
        <span>Wear</span>
        <span>Cost</span>
      </div>
      ${vesselListHtml}
    </div>
  `;
}

/**
 * Renders the Drydock tab content
 * @param {Object} drydockData - Drydock vessels and costs
 * @param {Object} settings - User settings
 * @param {boolean} [isSpecificVessel=false] - Whether showing specific vessel (hides threshold)
 */
function renderDrydockTab(drydockData, settings, isSpecificVessel = false) {
  const vessels = drydockData.vessels || [];
  const totalCost = drydockData.totalCost || 0;
  const bunkerCash = drydockData.cash || 0;
  const affordable = bunkerCash >= totalCost;

  if (vessels.length === 0) {
    return '<div style="text-align: center; color: #9ca3af; padding: 40px;">No vessels need drydock</div>';
  }

  const vesselListHtml = vessels.map(v => {
    const hours = v.hours_until_check !== undefined ? v.hours_until_check : 999;
    const route = v.route_destination ? `→ ${v.route_destination}` : 'No route';
    const cost = v.cost || 0;
    return `
      <div class="drydock-vessel-row">
        <input type="checkbox" class="drydock-vessel-checkbox" data-vessel-id="${v.id}" checked>
        <span class="vessel-name">${escapeHtml(v.name)}</span>
        <span class="vessel-hours">${hours}h</span>
        <span class="vessel-route">${escapeHtml(route)}</span>
        <span class="vessel-cost">$${formatNumber(cost)}</span>
      </div>
    `;
  }).join('');

  const typeLabel = settings.autoDrydockType === 'major' ? 'Major (100%)' : 'Minor (60%)';
  const speedLabel = settings.autoDrydockSpeed === 'maximum' ? 'Maximum' : 'Minimum';

  return `
    <div class="repair-summary ${affordable ? 'affordable' : 'too-expensive'}">
      <div class="summary-row">
        <span class="label">Vessels to drydock:</span>
        <span class="value">${vessels.length}</span>
      </div>
      <div class="summary-row total">
        <span class="label">Total Cost:</span>
        <span class="value">$${formatNumber(totalCost)}</span>
      </div>
      <div class="summary-row cash">
        <span class="label">Available Cash:</span>
        <span class="value">$${formatNumber(bunkerCash)}</span>
      </div>
      <div class="summary-row">
        <span class="label">Type:</span>
        <span class="value">${typeLabel}</span>
      </div>
      <div class="summary-row">
        <span class="label">Speed:</span>
        <span class="value">${speedLabel}</span>
      </div>
      ${!isSpecificVessel ? `
        <div class="summary-row threshold">
          <span class="label">Hours Threshold:</span>
          <span class="value">${settings.autoDrydockThreshold}h</span>
        </div>
      ` : ''}
    </div>
    <div class="drydock-options">
      <div class="drydock-option-group">
        <label for="drydockSpeed">Route Speed</label>
        <select id="drydockSpeed">
          <option value="minimum" ${settings.autoDrydockSpeed === 'minimum' ? 'selected' : ''}>Minimum (Slow, Less Fuel)</option>
          <option value="maximum" ${settings.autoDrydockSpeed === 'maximum' ? 'selected' : ''}>Maximum (Fast, More Fuel)</option>
        </select>
      </div>
      <div class="drydock-option-group">
        <label for="drydockType">Maintenance Type</label>
        <select id="drydockType">
          <option value="major" ${settings.autoDrydockType === 'major' ? 'selected' : ''}>Major (100% Antifouling)</option>
          <option value="minor" ${settings.autoDrydockType === 'minor' ? 'selected' : ''}>Minor (60% Antifouling)</option>
        </select>
      </div>
    </div>
    <div class="repair-vessel-list">
      <div class="repair-vessel-header" style="grid-template-columns: auto 2fr 1fr 1fr 1fr;">
        <span>Select</span>
        <span>Vessel Name</span>
        <span>Hours</span>
        <span>Route</span>
        <span>Cost</span>
      </div>
      ${vesselListHtml}
    </div>
  `;
}

/**
 * Executes drydock for selected vessels
 */
async function executeDrydock(settings, dialog, overlay) {
  const checkedBoxes = dialog.querySelectorAll('.drydock-vessel-checkbox:checked');
  if (checkedBoxes.length === 0) {
    showSideNotification('No vessels selected', 'info');
    return;
  }

  const vesselIds = Array.from(checkedBoxes).map(cb => cb.dataset.vesselId);
  const speed = dialog.querySelector('#drydockSpeed').value;
  const maintenanceType = dialog.querySelector('#drydockType').value;

  try {
    overlay.remove();

    const response = await fetch(window.apiUrl('/api/maintenance/bulk-drydock'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vessel_ids: JSON.stringify(vesselIds),
        speed,
        maintenance_type: maintenanceType
      })
    });

    const data = await response.json();

    if (data.error) {
      showSideNotification(`Drydock failed: ${data.error}`, 'error');
    }
  } catch (error) {
    console.error('[Drydock] Error:', error);
    showSideNotification('Drydock failed', 'error');
  }
}

function showBulkRepairDialog(costData, threshold) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog bulk-repair-dialog';

    const vessels = costData.vessels || [];
    const totalCost = costData.totalCost || 0;
    const bunkerCash = costData.cash || 0;
    const affordable = bunkerCash >= totalCost;

    // Build vessel list HTML
    const vesselListHtml = vessels.map(v => `
      <div class="repair-vessel-row">
        <span class="vessel-name">${escapeHtml(v.name)}</span>
        <span class="vessel-wear">${v.wear}%</span>
        <span class="vessel-cost">$${formatNumber(v.cost)}</span>
      </div>
    `).join('');

    dialog.innerHTML = `
      <div class="confirm-dialog-header">
        <h3>🔧 Bulk Vessel Repair</h3>
        <div class="confirm-dialog-buttons">
          <button class="confirm-dialog-btn cancel" data-action="cancel">Cancel</button>
          <button class="confirm-dialog-btn confirm" data-action="confirm">Repair All</button>
        </div>
      </div>
      <div class="confirm-dialog-body">
        <div class="repair-summary ${affordable ? 'affordable' : 'too-expensive'}">
          <div class="summary-row">
            <span class="label">Vessels to repair:</span>
            <span class="value">${vessels.length}</span>
          </div>
          <div class="summary-row total">
            <span class="label">Total Cost:</span>
            <span class="value">$${formatNumber(totalCost)}</span>
          </div>
          <div class="summary-row cash">
            <span class="label">Available Cash:</span>
            <span class="value">$${formatNumber(bunkerCash)}</span>
          </div>
          <div class="summary-row threshold">
            <span class="label">Wear Threshold:</span>
            <span class="value">${threshold}%+</span>
          </div>
        </div>
        <div class="repair-vessel-list">
          <div class="repair-vessel-header">
            <span>Vessel Name</span>
            <span>Wear</span>
            <span>Cost</span>
          </div>
          ${vesselListHtml}
        </div>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const handleClose = (confirmed) => {
      overlay.remove();
      resolve(confirmed);
    };

    dialog.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleClose(btn.dataset.action === 'confirm');
      });
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) handleClose(false);
    });
  });
}

/**
 * Opens tabbed dialog with Wear Repairs and Drydock options
 * @param {Object} settings - User settings
 * @param {number} [specificVesselId] - Optional: Show only this vessel
 */
export async function openRepairAndDrydockDialog(settings, specificVesselId = null) {
  // Get badge counts from map icon bar
  const repairCountBadge = document.querySelector('.map-icon-item[data-action="repairAll"] .map-icon-badge');
  const drydockCountBadge = document.querySelector('.map-icon-item[data-action="repairAll"] .map-icon-badge-bottom-left');

  const repairCount = repairCountBadge ? (parseInt(repairCountBadge.textContent) || 0) : 0;
  const drydockCount = drydockCountBadge ? (parseInt(drydockCountBadge.textContent) || 0) : 0;

  // If specific vessel ID provided, always show dialog (even if counts are 0)
  if (!specificVesselId && repairCount === 0 && drydockCount === 0) {
    showSideNotification('No vessels need repair or drydock', 'info');
    return;
  }

  // Show tabbed dialog
  await showRepairAndDrydockDialog(settings, repairCount, drydockCount, specificVesselId);
}

export async function repairAllVessels(settings) {
  // Get repair count from badge
  const repairCountBadge = document.querySelector('.map-icon-item[data-action="repairAll"] .map-icon-badge');
  const vesselsNeedingRepair = repairCountBadge ? (parseInt(repairCountBadge.textContent) || 0) : 0;

  if (vesselsNeedingRepair === 0) return;

  try {
    // Fetch vessel data and repair costs from backend
    // Disable button during preview
    updateButtonState('repairAll', true);

    const costResponse = await fetch(window.apiUrl('/api/vessel/get-repair-preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: settings.maintenanceThreshold })
    });

    const costData = await costResponse.json();

    if (!costData.vessels || costData.vessels.length === 0) {
      showSideNotification('No vessels need repair', 'info');
      updateButtonState('repairAll', false);
      return;
    }

    // Show detailed confirmation dialog with vessel list (button stays disabled)
    const confirmed = await showBulkRepairDialog(costData, settings.maintenanceThreshold);

    if (!confirmed) {
      updateButtonState('repairAll', false);
      return;
    }

    // Button stays disabled during repair
    // Call backend which handles everything and broadcasts to all clients
    const response = await fetch(window.apiUrl('/api/vessel/bulk-repair'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: settings.maintenanceThreshold })
    });

    await response.json();

    // Backend broadcasts notification to ALL clients via WebSocket
    // No need to show notification here - all clients will receive it

    // Update locally for immediate feedback, then re-enable button
    if (window.debouncedUpdateRepairCount && window.debouncedUpdateBunkerStatus) {
      await window.debouncedUpdateRepairCount(800);
      await window.debouncedUpdateBunkerStatus(800);
    }

    // Re-enable button AFTER badge updates complete
    updateButtonState('repairAll', false);

  } catch (error) {
    // Error notifications are also broadcasted by backend
    console.error('[Bulk Repair] Error:', error);

    // Re-enable button on error
    updateButtonState('repairAll', false);
  }
}

// Track if filters have been populated to avoid re-populating on every open
let filtersPopulated = false;

export async function loadAcquirableVessels(preserveFilters = false) {
  try {
    const data = await fetchAcquirableVessels();
    allAcquirableVessels = data.data.vessels_for_sale || [];

    if (window.DEBUG_MODE) console.log('[Load Vessels] Loaded', allAcquirableVessels.length, 'vessels');

    // Log first few vessels to understand data structure (only once)
    if (window.DEBUG_MODE && allAcquirableVessels.length > 0 && !filtersPopulated) {
      console.log('[Load Vessels] Sample vessel data:', allAcquirableVessels[0]);
      console.log('[Load Vessels] Vessel types in data:', [...new Set(allAcquirableVessels.map(v => v.capacity_type))]);
      console.log('[Load Vessels] Engine types in data:', [...new Set(allAcquirableVessels.map(v => v.engine_type))]);
      console.log('[Load Vessels] Year range in data:', Math.min(...allAcquirableVessels.map(v => v.year)), '-', Math.max(...allAcquirableVessels.map(v => v.year)));

      // Check for special properties
      const withPerks = allAcquirableVessels.filter(v => v.perks && v.perks !== null && v.perks !== '');
      const creditsOnly = allAcquirableVessels.filter(v => v.only_for_credits);
      console.log('[Load Vessels] Special properties:', {
        withPerks: withPerks.length,
        creditsOnly: creditsOnly.length,
        perksExample: withPerks.length > 0 ? { name: withPerks[0].name, perks: withPerks[0].perks, perkType: typeof withPerks[0].perks } : 'None',
        creditsExample: creditsOnly.length > 0 ? { name: creditsOnly[0].name, only_for_credits: creditsOnly[0].only_for_credits, valueType: typeof creditsOnly[0].only_for_credits } : 'None'
      });
    }

    // Populate dynamic filters based on actual vessel data (only first time)
    if (!filtersPopulated) {
      populateDynamicFilters();
      filtersPopulated = true;
    }

    // Show/hide "Credits Only" filter based on whether any vessels exist
    const creditsOnlyCheckbox = document.querySelector('input[name="special"][value="credits"]');
    const hasCreditsOnlyVessels = allAcquirableVessels.some(v => v.only_for_credits);
    if (creditsOnlyCheckbox) {
      const creditsLabel = creditsOnlyCheckbox.closest('label');
      if (creditsLabel) {
        if (hasCreditsOnlyVessels) {
          creditsLabel.style.display = '';
        } else {
          creditsLabel.style.display = 'none';
          creditsOnlyCheckbox.checked = false; // Uncheck if hidden
        }
      }
    }

    // Vessel images are preloaded on page load (script.js STEP 8.5)
    // No need to preload here anymore

    // Apply or preserve filters based on parameter
    if (preserveFilters) {
      // Just re-display with existing filters (after purchase)
      displayFilteredVessels();
    } else {
      // Initialize filters from DOM checkboxes (first load)
      window.applyVesselFilters();
    }

    // Restore cart badge from localStorage
    updateCartBadge();
  } catch (error) {
    console.error('Error loading vessels:', error);
    document.getElementById('vesselCatalogFeed').innerHTML = `
      <div style="text-align: center; color: #ef4444; padding: 40px;">
        Failed to load vessels. Please try again.
      </div>
    `;
  }
}

/**
 * Get capacity display for acquirable vessels.
 * Display differs from selling catalog because API endpoint returns different data structure:
 * - Acquirable vessels: Simple capacity number (vessel.capacity_max as number)
 * - User vessels (selling): Detailed breakdown object (vessel.capacity_max.dry, .refrigerated, etc.)
 */
function getCapacityDisplay(vessel) {
  if (vessel.capacity_type === 'container') {
    // Container vessels - capacity_max can be number or object {dry, refrigerated}
    if (typeof vessel.capacity_max === 'object') {
      // Total capacity is dry + refrigerated (not max of either)
      const dry = vessel.capacity_max.dry ?? 0;
      const ref = vessel.capacity_max.refrigerated ?? 0;
      const total = dry + ref;
      return `${formatNumber(total)} TEU`;
    }
    return `${formatNumber(vessel.capacity_max ?? 0)} TEU`;
  } else if (vessel.capacity_type === 'tanker') {
    // Tanker vessels - capacity_max can be number or object {crude_oil, fuel}
    if (typeof vessel.capacity_max === 'object') {
      // Total capacity is fuel + crude (not max of either)
      const fuel = vessel.capacity_max.fuel ?? 0;
      const crude = vessel.capacity_max.crude_oil ?? 0;
      const total = fuel + crude;
      return `${formatNumber(total)} bbl`;
    }
    return `${formatNumber(vessel.capacity_max ?? 0)} bbl`;
  } else {
    // Other vessel types (bulk carriers, etc)
    return `${formatNumber(vessel.capacity_max ?? 0)}t`;
  }
}

/**
 * Get CSS class name for CO2 efficiency factor
 * @param {number} factor - CO2 efficiency factor
 * @returns {string} CSS class name
 */
function getCO2EfficiencyClass(factor) {
  if (factor < 1.0) return 'vessel-spec-co2-efficient';
  if (factor === 1.0) return 'vessel-spec-co2-standard';
  return 'vessel-spec-co2-inefficient';
}

/**
 * Get CSS class name for Fuel efficiency factor
 * @param {number} factor - Fuel efficiency factor
 * @returns {string} CSS class name
 */
function getFuelEfficiencyClass(factor) {
  if (factor < 1.0) return 'vessel-spec-fuel-efficient';
  if (factor === 1.0) return 'vessel-spec-fuel-standard';
  return 'vessel-spec-fuel-inefficient';
}

// Track if pending view is active
let isPendingViewActive = false;

export async function showPendingVessels(pendingVessels) {
  // Toggle pending view
  if (isPendingViewActive) {
    // User clicked pending again - restore previous view
    isPendingViewActive = false;

    // Show cart button again
    const cartBtn = document.getElementById('cartBtn');
    if (cartBtn) cartBtn.classList.remove('hidden');

    // Load and show regular acquirable vessels - this will read filters from DOM
    await loadAcquirableVessels(false);
    return;
  }

  // Entering pending view
  isPendingViewActive = true;

  const feed = document.getElementById('vesselCatalogFeed');

  const cartBtn = document.getElementById('cartBtn');
  if (cartBtn) cartBtn.classList.add('hidden');

  if (pendingVessels.length === 0) {
    feed.innerHTML = `
      <div style="text-align: center; color: #9ca3af; padding: 40px;">
        No pending vessels
      </div>
    `;
    isPendingViewActive = false;
    return;
  }

  // Show ALL pending vessels - no filters applied
  const filteredVessels = pendingVessels;

  // Sort by price
  filteredVessels.sort((a, b) => {
    if (priceSort === 'asc') {
      return (a.price || 0) - (b.price || 0);
    } else {
      return (b.price || 0) - (a.price || 0);
    }
  });

  if (filteredVessels.length === 0) {
    feed.innerHTML = `
      <div style="text-align: center; color: #9ca3af; padding: 40px;">
        No pending vessels match the selected filters
      </div>
    `;
    return;
  }

  // Store for lazy loading
  currentlyDisplayedVessels = filteredVessels;

  const grid = document.createElement('div');
  grid.className = filteredVessels.length === 1 ? 'vessel-catalog-grid single-vessel' : 'vessel-catalog-grid';
  grid.id = 'vesselCatalogGrid';

  // Disconnect existing observer if any
  if (lazyLoadObserver) {
    lazyLoadObserver.disconnect();
  }

  // Load initial batch only
  const initialBatch = filteredVessels.slice(0, INITIAL_LOAD_COUNT);

  initialBatch.forEach(vessel => {
    // Use the same createVesselCard() function for consistent styling
    // Mark as pending vessel for any special styling needed
    const card = createVesselCard(vessel, true); // true = isPending
    grid.appendChild(card);
  });

  // If more vessels exist, add lazy load sentinel
  if (filteredVessels.length > INITIAL_LOAD_COUNT) {
    const sentinel = document.createElement('div');
    sentinel.id = 'lazyLoadSentinel';
    sentinel.className = 'lazy-load-sentinel';
    sentinel.innerHTML = '<div style="text-align: center; padding: 20px; color: #9ca3af;">Loading more vessels...</div>';
    grid.appendChild(sentinel);

    // Setup Intersection Observer for lazy loading
    lazyLoadObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadMorePendingVessels();
        }
      });
    }, {
      rootMargin: '200px'
    });

    lazyLoadObserver.observe(sentinel);
  }

  feed.innerHTML = '';
  feed.appendChild(grid);

  // Adjust window size if only 1 vessel is displayed
  const buyVesselsOverlay = document.getElementById('buyVesselsOverlay');
  const messengerWindow = buyVesselsOverlay?.querySelector('.messenger-window');
  if (messengerWindow) {
    if (filteredVessels.length === 1) {
      messengerWindow.classList.add('messenger-window-single-vessel');
    } else {
      messengerWindow.classList.remove('messenger-window-single-vessel');
    }
  }

  if (window.DEBUG_MODE) console.log(`[Pending Vessels] Showing ${Math.min(INITIAL_LOAD_COUNT, filteredVessels.length)} of ${filteredVessels.length} vessels (lazy loading enabled)`);
}

/**
 * Load more pending vessels when scrolling
 */
function loadMorePendingVessels() {
  const grid = document.getElementById('vesselCatalogGrid');
  const sentinel = document.getElementById('lazyLoadSentinel');

  if (!grid || !sentinel) return;

  // Count currently loaded vessels (exclude sentinel)
  const currentCount = grid.children.length - 1;

  // Get next batch
  const nextBatch = currentlyDisplayedVessels.slice(currentCount, currentCount + LAZY_LOAD_BATCH);

  if (nextBatch.length === 0) {
    sentinel.remove();
    if (lazyLoadObserver) {
      lazyLoadObserver.disconnect();
    }
    return;
  }

  // Insert new vessels before sentinel
  nextBatch.forEach(vessel => {
    const imageUrl = `/api/vessel-image/${vessel.type}`;

    let timeDisplay = '';
    const remaining = vessel.time_arrival || 0;

    if (remaining > 0) {
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor((remaining % 86400) / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      if (days > 0) {
        timeDisplay = `${days}d ${hours}h`;
      } else if (hours > 0) {
        timeDisplay = `${hours}h ${minutes}m`;
      } else {
        timeDisplay = `${minutes}m`;
      }
    } else {
      timeDisplay = 'Ready';
    }

    const capacityDisplay = getCapacityDisplay(vessel);
    const co2Class = getCO2EfficiencyClass(vessel.co2_factor);
    const fuelClass = getFuelEfficiencyClass(vessel.fuel_factor);

    let additionalAttrs = '';
    if (vessel.width && vessel.width !== 0) {
      additionalAttrs += `<div class="vessel-spec"><strong>Width:</strong> ${vessel.width} m</div>`;
    }
    if (vessel.price_in_points && vessel.price_in_points !== 0) {
      additionalAttrs += `<div class="vessel-spec"><strong>Points Price:</strong> ${formatNumber(vessel.price_in_points)}</div>`;
    }
    if (vessel.perks && vessel.perks !== null) {
      additionalAttrs += `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${vessel.perks}</div>`;
    }

    const card = document.createElement('div');
    card.className = 'vessel-card pending-vessel';
    card.innerHTML = `
      <div class="vessel-image-container">
        <img src="${imageUrl}" alt="${vessel.name}" class="vessel-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>⛴️</text></svg>'">
        ${vessel.only_for_credits ? '<div class="vessel-credits-only-badge">$</div>' : ''}
        <div class="vessel-time-badge">⏱️ ${timeDisplay}</div>
        <div class="vessel-price-badge">$${formatNumber(vessel.price || 0)}</div>
      </div>
      <div class="vessel-content">
        <div class="vessel-header">
          <h3 class="vessel-name">${vessel.name}</h3>
        </div>
        <div class="vessel-specs">
          <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
          <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range || 0)} nm</div>
          <div class="vessel-spec ${co2Class}"><strong>CO2 Factor:</strong> ${vessel.co2_factor}</div>
          <div class="vessel-spec ${fuelClass}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor}</div>
          <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(vessel.fuel_capacity || 0)} t</div>
          <div class="vessel-spec"><strong>Service:</strong> ${vessel.hours_between_service || 0}h</div>
          <div class="vessel-spec"><strong>Engine:</strong> ${vessel.engine_type || 'N/A'} (${formatNumber(vessel.kw || 0)} kW)</div>
          <div class="vessel-spec"><strong>Speed:</strong> ${vessel.max_speed || 0} kn</div>
          <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name || vessel.type}</div>
          <div class="vessel-spec"><strong>Port:</strong> ${(vessel.current_port_code || '').replace(/_/g, ' ')}</div>
          <div class="vessel-spec"><strong>Year:</strong> ${vessel.year || 'N/A'}</div>
          <div class="vessel-spec"><strong>Length:</strong> ${vessel.length || 0} m</div>
          <div class="vessel-spec"><strong>IMO:</strong> ${vessel.imo || 'N/A'}</div>
          <div class="vessel-spec"><strong>MMSI:</strong> ${vessel.mmsi || 'N/A'}</div>
          ${vessel.gearless || vessel.antifouling || additionalAttrs ? '<div class="vessel-spec-divider"></div>' : ''}
          ${vessel.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
          ${vessel.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${vessel.antifouling}</div>` : ''}
          ${additionalAttrs}
        </div>
      </div>
    `;
    grid.insertBefore(card, sentinel);
  });

  if (window.DEBUG_MODE) console.log(`[Lazy Load] Loaded ${nextBatch.length} more pending vessels (${currentCount + nextBatch.length}/${currentlyDisplayedVessels.length})`);

  // If all loaded, remove sentinel
  if (currentCount + nextBatch.length >= currentlyDisplayedVessels.length) {
    sentinel.remove();
    if (lazyLoadObserver) {
      lazyLoadObserver.disconnect();
    }
  }
}

export function displayVessels() {
  const feed = document.getElementById('vesselCatalogFeed');

  let filtered;

  if (selectedEngineType) {
    filtered = allAcquirableVessels.filter(v => v.engine_type === selectedEngineType);
  } else {
    filtered = allAcquirableVessels.filter(v => v.capacity_type === currentVesselFilter);
  }

  if (filtered.length === 0) {
    const filterText = selectedEngineType
      ? `No vessels with engine type "${selectedEngineType}"`
      : `No ${currentVesselFilter} vessels available`;
    feed.innerHTML = `
      <div style="text-align: center; color: #9ca3af; padding: 40px;">
        ${filterText}
      </div>
    `;
    return;
  }

  filtered.sort((a, b) => a.price - b.price);

  const grid = document.createElement('div');
  grid.className = 'vessel-catalog-grid';

  filtered.forEach(vessel => {
    const selectedItem = selectedVessels.find(v => v.vessel.id === vessel.id);
    const isSelected = !!selectedItem;
    const imageUrl = `/api/vessel-image/${vessel.type}`;

    // Check if anchor slots are available
    const availableSlots = getAvailableAnchorSlots();
    const canPurchase = availableSlots > 0;

    const capacityDisplay = getCapacityDisplay(vessel);
    const co2Class = getCO2EfficiencyClass(vessel.co2_factor);
    const fuelClass = getFuelEfficiencyClass(vessel.fuel_factor);

    let additionalAttrs = '';
    if (vessel.width && vessel.width !== 0) {
      additionalAttrs += `<div class="vessel-spec"><strong>Width:</strong> ${vessel.width} m</div>`;
    }
    if (vessel.price_in_points && vessel.price_in_points !== 0) {
      additionalAttrs += `<div class="vessel-spec"><strong>Points Price:</strong> ${formatNumber(vessel.price_in_points)}</div>`;
    }
    if (vessel.perks && vessel.perks !== null) {
      additionalAttrs += `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${vessel.perks}</div>`;
    }

    const card = document.createElement('div');
    card.className = 'vessel-card';
    card.innerHTML = `
      <div class="vessel-image-container">
        <img src="${imageUrl}" alt="${vessel.name}" class="vessel-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>⛴️</text></svg>'">
        ${vessel.only_for_credits ? '<div class="vessel-credits-overlay">$</div>' : ''}
      </div>
      <div class="vessel-content">
        <div class="vessel-header">
          <h3 class="vessel-name">${vessel.name}</h3>
          <div class="vessel-price">$${formatNumber(vessel.price)}</div>
        </div>
        <div class="vessel-specs">
          <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
          <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range)} nm</div>
          <div class="vessel-spec ${co2Class}"><strong>CO2 Factor:</strong> ${vessel.co2_factor}</div>
          <div class="vessel-spec ${fuelClass}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor}</div>
          <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(vessel.fuel_capacity)} t</div>
          <div class="vessel-spec"><strong>Service:</strong> ${vessel.hours_between_service}h</div>
          <div class="vessel-spec"><strong>Engine:</strong> ${vessel.engine_type} (${formatNumber(vessel.kw)} kW)</div>
          <div class="vessel-spec"><strong>Speed:</strong> ${vessel.max_speed} kn</div>
          <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name}</div>
          <div class="vessel-spec"><strong>Port:</strong> ${vessel.current_port_code.replace(/_/g, ' ')}</div>
          <div class="vessel-spec"><strong>Year:</strong> ${vessel.year}</div>
          <div class="vessel-spec"><strong>Length:</strong> ${vessel.length} m</div>
          <div class="vessel-spec"><strong>IMO:</strong> ${vessel.imo || 'N/A'}</div>
          <div class="vessel-spec"><strong>MMSI:</strong> ${vessel.mmsi || 'N/A'}</div>
          ${vessel.gearless || vessel.antifouling || additionalAttrs ? '<div class="vessel-spec vessel-spec-divider"></div>' : ''}
          ${vessel.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
          ${vessel.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${vessel.antifouling}</div>` : ''}
          ${additionalAttrs}
        </div>
        <div class="vessel-actions">
          <input type="number" class="vessel-quantity-input" data-vessel-id="${vessel.id}" value="${isSelected ? selectedItem.quantity : 1}" min="1" max="99" ${!canPurchase ? 'disabled' : ''} />
          <div class="vessel-action-buttons">
            <button class="vessel-select-btn" data-vessel-id="${vessel.id}" ${!canPurchase ? 'disabled title="Not enough anchor slots"' : ''}>
              Add to Cart
            </button>
            <button class="vessel-buy-btn" data-vessel-id="${vessel.id}" ${!canPurchase ? 'disabled title="Not enough anchor slots"' : ''}>
              Buy Now
            </button>
          </div>
        </div>
      </div>
    `;

    card.querySelector('.vessel-select-btn').addEventListener('click', () => {
      const quantityInput = card.querySelector('.vessel-quantity-input');
      const quantity = parseInt(quantityInput.value) || 1;
      toggleVesselSelection(vessel, quantity);
    });
    card.querySelector('.vessel-buy-btn').addEventListener('click', () => {
      const quantityInput = card.querySelector('.vessel-quantity-input');
      const quantity = parseInt(quantityInput.value) || 1;
      purchaseSingleVessel(vessel, quantity);
    });

    grid.appendChild(card);
  });

  feed.innerHTML = '';
  feed.appendChild(grid);
}

export function showEngineFilterOverlay() {
  const overlay = document.getElementById('engineFilterOverlay');
  const listContainer = document.getElementById('engineFilterList');

  const engineTypes = [...new Set(allAcquirableVessels.map(v => v.engine_type))].sort();

  let html = '<div style="max-width: 800px; margin: 0 auto;">';

  html += `
    <div class="chat-selection-item" data-engine="" style="cursor: pointer; padding: 15px; background: ${!selectedEngineType ? 'rgba(16, 185, 129, 0.2)' : 'rgba(31, 41, 55, 0.4)'}; border: 1px solid ${!selectedEngineType ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.1)'}; border-radius: 8px; transition: all 0.2s; margin-bottom: 10px;">
      <div style="font-weight: 600; color: #e0e0e0;">All Engines</div>
      <div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">Show all vessels</div>
    </div>
  `;

  html += '<div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">';

  engineTypes.forEach((engineType, index) => {
    const count = allAcquirableVessels.filter(v => v.engine_type === engineType).length;
    const isSelected = selectedEngineType === engineType;
    const isLastAndOdd = (index === engineTypes.length - 1) && (engineTypes.length % 2 !== 0);

    html += `
      <div class="chat-selection-item engine-filter-item${isSelected ? ' selected' : ''}" data-engine="${engineType}" style="cursor: pointer; padding: 15px; border: 1px solid ${isSelected ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.1)'}; border-radius: 8px; transition: all 0.2s;${isLastAndOdd ? ' grid-column: 1 / -1; max-width: 50%; margin: 0 auto;' : ''}">
        <div style="font-weight: 600; color: #e0e0e0;">⚙️ ${engineType}</div>
        <div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">${count} vessel${count === 1 ? '' : 's'} available</div>
      </div>
    `;
  });

  html += '</div></div>';
  listContainer.innerHTML = html;

  listContainer.querySelectorAll('.chat-selection-item').forEach(item => {
    item.addEventListener('click', () => {
      const engineType = item.getAttribute('data-engine');
      selectedEngineType = engineType || null;

      if (selectedEngineType) {
        document.getElementById('filterContainerBtn').classList.remove('active');
        document.getElementById('filterTankerBtn').classList.remove('active');
        document.getElementById('filterEngineBtn').classList.add('active');
      } else {
        document.getElementById('filterEngineBtn').classList.remove('active');
        if (currentVesselFilter === 'container') {
          document.getElementById('filterContainerBtn').classList.add('active');
        } else {
          document.getElementById('filterTankerBtn').classList.add('active');
        }
      }

      overlay.classList.add('hidden');
      displayVessels();
    });
  });

  overlay.classList.remove('hidden');
}

export function closeEngineFilterOverlay() {
  document.getElementById('engineFilterOverlay').classList.add('hidden');
}

function toggleVesselSelection(vessel, quantity) {
  const index = selectedVessels.findIndex(v => v.vessel.id === vessel.id);

  if (index > -1) {
    // Add to existing quantity
    selectedVessels[index].quantity += quantity;
  } else {
    // Add new item to cart
    selectedVessels.push({ vessel, quantity });
  }

  saveCartToStorage();
  updateCartBadge();
  displayVessels();
}

function updateCartBadge() {
  const totalCount = selectedVessels.reduce((sum, item) => sum + item.quantity, 0);
  const selectedCountEl = document.getElementById('selectedCount');
  const cartBtn = document.getElementById('cartBtn');
  const cartCountEl = document.getElementById('cartCount');

  if (selectedCountEl) selectedCountEl.textContent = totalCount;
  if (cartCountEl) cartCountEl.textContent = totalCount;
  if (cartBtn) {
    if (selectedVessels.length > 0) {
      cartBtn.classList.remove('hidden');
    } else {
      cartBtn.classList.add('hidden');
    }
  }
}

function removeFromCart(vesselId) {
  selectedVessels = selectedVessels.filter(v => v.vessel.id !== vesselId);
  saveCartToStorage();
  updateCartBadge();
  displayVessels();
}

function updateCartItemQuantity(vesselId, newQuantity) {
  const index = selectedVessels.findIndex(v => v.vessel.id === vesselId);
  if (index > -1 && newQuantity > 0) {
    selectedVessels[index].quantity = newQuantity;
    saveCartToStorage();
    updateCartBadge();
  }
}

export function showShoppingCart() {
  if (selectedVessels.length === 0) {
    showSideNotification('Cart is empty', 'info');
    return;
  }

  const bunkerState = getCurrentBunkerState();

  // Calculate total
  const totalCost = selectedVessels.reduce((sum, item) => sum + (item.vessel.price * item.quantity), 0);
  const totalItems = selectedVessels.reduce((sum, item) => sum + item.quantity, 0);
  const affordable = bunkerState.currentCash >= totalCost;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog shopping-cart-dialog';

  // Build cart items HTML in invoice style
  const cartItemsHtml = selectedVessels.map(item => `
    <div class="cart-item invoice-line" data-vessel-id="${item.vessel.id}">
      <span class="invoice-name">${escapeHtml(item.vessel.name)}</span>
      <span class="invoice-unit-price">$${formatNumber(item.vessel.price)}</span>
      <div class="invoice-quantity-controls">
        <button class="cart-qty-btn minus" data-vessel-id="${item.vessel.id}">−</button>
        <span class="cart-qty-display">${item.quantity}</span>
        <button class="cart-qty-btn plus" data-vessel-id="${item.vessel.id}">+</button>
      </div>
      <span class="invoice-total">$${formatNumber(item.vessel.price * item.quantity)}</span>
      <button class="remove-btn-small" data-vessel-id="${item.vessel.id}" title="Remove">×</button>
    </div>
  `).join('');

  dialog.innerHTML = `
    <div class="confirm-dialog-header invoice-header">
      <h3>Purchase Order Summary</h3>
      <div class="confirm-dialog-buttons">
        <button class="confirm-dialog-btn cancel" data-action="cancel">Cancel</button>
        <button class="confirm-dialog-btn confirm ${!affordable ? 'disabled' : ''}" data-action="checkout" ${!affordable ? 'disabled' : ''}>Confirm Purchase</button>
      </div>
    </div>
    <div class="confirm-dialog-body invoice-body">
      <div class="invoice-header-row">
        <span class="invoice-name">Vessel</span>
        <span class="invoice-unit-price">Price</span>
        <span class="invoice-quantity">Qty</span>
        <span class="invoice-total">Total</span>
        <span class="invoice-action"></span>
      </div>
      <div class="cart-items invoice-items">
        ${cartItemsHtml}
      </div>
      <div class="invoice-separator"></div>
      <div class="invoice-totals">
        <div class="invoice-total-row">
          <span class="invoice-total-label">Total Vessels:</span>
          <span class="invoice-total-value">${totalItems}</span>
        </div>
        <div class="invoice-total-row">
          <span class="invoice-total-label">Cash Available:</span>
          <span class="invoice-total-value">$${formatNumber(bunkerState.currentCash)}</span>
        </div>
        <div class="invoice-total-row grand-total ${!affordable ? 'too-expensive' : ''}">
          <span class="invoice-total-label">Total Amount:</span>
          <span class="invoice-total-value">$${formatNumber(totalCost)}</span>
        </div>
      </div>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Handle close
  const handleClose = () => {
    overlay.remove();
  };

  // Handle checkout
  const handleCheckout = () => {
    overlay.remove();
    purchaseBulk();
  };

  // Button handlers
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', handleClose);
  const checkoutBtn = dialog.querySelector('[data-action="checkout"]');
  if (checkoutBtn && !checkoutBtn.disabled) {
    checkoutBtn.addEventListener('click', handleCheckout);
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) handleClose();
  });

  // Quantity controls
  dialog.querySelectorAll('.cart-qty-btn.minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      const item = selectedVessels.find(v => v.vessel.id === vesselId);
      if (item && item.quantity > 1) {
        updateCartItemQuantity(vesselId, item.quantity - 1);
        overlay.remove();
        showShoppingCart(); // Refresh dialog
      }
    });
  });

  dialog.querySelectorAll('.cart-qty-btn.plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      const item = selectedVessels.find(v => v.vessel.id === vesselId);
      if (item && item.quantity < 99) {
        updateCartItemQuantity(vesselId, item.quantity + 1);
        overlay.remove();
        showShoppingCart(); // Refresh dialog
      }
    });
  });

  // Remove buttons
  dialog.querySelectorAll('.cart-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      removeFromCart(vesselId);

      if (selectedVessels.length === 0) {
        overlay.remove();
        showSideNotification('Cart is now empty', 'info');
      } else {
        overlay.remove();
        showShoppingCart(); // Refresh dialog
      }
    });
  });
}

/**
 * Purchases one or more copies of a specific vessel with confirmation and sequential processing.
 * Handles single and multi-quantity purchases with affordability checks and rate limiting.
 *
 * Purchase Flow:
 * 1. Calculate total cost (price × quantity)
 * 2. Build confirmation dialog with itemized list
 * 3. Show affordability indicator (green/red)
 * 4. Process purchases sequentially with 1.5s delays
 * 5. Update cash after each successful purchase
 * 6. Handle errors (limit reached, insufficient funds, network errors)
 * 7. Remove from selection list
 * 8. Refresh vessel catalog and counts
 *
 * Error Handling:
 * - 'vessel_limit_reached': Stops purchasing, shows count purchased
 * - 'not_enough_cash': Stops purchasing, shows count purchased
 * - Other errors: Shows error but may continue with remaining
 * - Network errors: Logs and shows feedback
 *
 * Rate Limiting:
 * - 1.5 second delay between purchases to prevent API throttling
 * - No delay after final purchase
 *
 * Side Effects:
 * - Shows confirmation dialog
 * - Makes multiple API calls (one per vessel)
 * - Updates cash after each purchase
 * - Removes from selectedVessels array
 * - Updates selection count badge
 * - Triggers vessel count refresh
 * - Reloads vessel catalog
 * - Shows success/error feedback
 *
 * @async
 * @param {Object} vessel - Vessel object to purchase
 * @param {number} [quantity=1] - Number of copies to purchase
 * @returns {Promise<void>}
 *
 * @example
 * // Buy 3 copies of a container vessel
 * purchaseSingleVessel(vesselObject, 3);
 */
export async function purchaseSingleVessel(vessel, quantity = 1) {
  const bunkerState = getCurrentBunkerState();
  const totalCost = vessel.price * quantity;

  if (window.DEBUG_MODE) console.log('[Purchase Vessel] Bunker state:', bunkerState);
  if (bunkerState.currentCash === 0) {
    console.warn('[Purchase Vessel] WARNING: currentCash is 0! This may indicate bunker data not loaded yet.');
  }

  const vesselDetails = [];
  for (let i = 0; i < quantity; i++) {
    vesselDetails.push({
      label: `${i + 1}. ${vessel.name}`,
      value: `$${formatNumber(vessel.price)}`
    });
  }
  vesselDetails.push({
    label: 'Total Cost',
    value: `$${formatNumber(totalCost)}`
  });
  vesselDetails.push({
    label: 'Cash Available',
    value: `$${formatNumber(bunkerState.currentCash)}`
  });

  const confirmed = await showConfirmDialog({
    title: `Purchase ${quantity > 1 ? `${quantity} Vessels` : 'Vessel'}`,
    message: quantity > 1 ? 'Purchasing multiple vessels with 1.5s delay between each:' : null,
    details: vesselDetails,
    confirmText: 'Buy',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  let successCount = 0;
  const purchasedVessels = [];

  for (let i = 0; i < quantity; i++) {
    try {
      const data = await apiPurchaseVessel(vessel.id, vessel.name, vessel.antifouling, true); // silent=true

      if (data.error) {
        if (data.error === 'vessel_limit_reached') {
          const msg = successCount > 0
            ? `🚢 <strong>Vessel limit reached! Purchased ${successCount} vessel(s), cannot buy more.</strong>`
            : `🚢 <strong>Vessel limit reached! Cannot purchase any vessels.</strong>`;
          showSideNotification(msg, 'error', null, false);
          break;
        } else if (data.error === 'not_enough_cash') {
          const msg = successCount > 0
            ? `🚢 <strong>Not enough cash! Purchased ${successCount} vessel(s), ran out of money.</strong>`
            : `🚢 <strong>Not enough cash! Cannot afford this vessel.</strong>`;
          showSideNotification(msg, 'error', null, true);
          break;
        } else {
          const msg = successCount > 0
            ? `🚢 <strong>Error: ${data.error} - Purchased ${successCount} so far</strong>`
            : `🚢 <strong>Error: ${data.error}</strong>`;
          showSideNotification(msg, 'error');
        }
      } else {
        successCount++;
        purchasedVessels.push({ name: vessel.name, price: vessel.price });
        if (data.user && data.user.cash !== undefined) {
          updateCurrentCash(data.user.cash);
        }
      }

      if (i < quantity - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    } catch (error) {
      console.error('Error purchasing vessel:', error);
      showSideNotification(`🚢 <strong>Network error purchasing ${vessel.name}</strong>`, 'error', null, true);
    }
  }

  // Send summary notification to backend (broadcasts to ALL clients)
  if (successCount > 0) {
    try {
      const totalCost = purchasedVessels.reduce((sum, v) => sum + v.price, 0);
      await fetch(`${window.API_PREFIX}/vessel/broadcast-purchase-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessels: purchasedVessels, totalCost })
      });
    } catch (error) {
      console.error('Error broadcasting purchase summary:', error);
    }
  }

  if (successCount > 0 && window.updateVesselCount) {
    await updateVesselCount();
  }

  selectedVessels = selectedVessels.filter(v => v.vessel.id !== vessel.id);
  updateCartBadge();

  await loadAcquirableVessels(true);
}

export async function purchaseBulk() {
  if (selectedVessels.length === 0) return;

  const bunkerState = getCurrentBunkerState();
  const vesselDetails = [];
  let totalCost = 0;
  let itemNumber = 1;

  if (window.DEBUG_MODE) console.log('[Purchase Bulk] Bunker state:', bunkerState);
  if (bunkerState.currentCash === 0) {
    console.warn('[Purchase Bulk] WARNING: currentCash is 0! This may indicate bunker data not loaded yet.');
  }

  selectedVessels.forEach(item => {
    for (let i = 0; i < item.quantity; i++) {
      vesselDetails.push({
        label: `${itemNumber}. ${item.vessel.name}`,
        value: `$${formatNumber(item.vessel.price)}`
      });
      totalCost += item.vessel.price;
      itemNumber++;
    }
  });

  vesselDetails.push({
    label: 'Total Cost',
    value: `$${formatNumber(totalCost)}`
  });
  vesselDetails.push({
    label: 'Cash Available',
    value: `$${formatNumber(bunkerState.currentCash)}`
  });

  const totalVesselCount = selectedVessels.reduce((sum, item) => sum + item.quantity, 0);

  const confirmed = await showConfirmDialog({
    title: `Bulk Purchase (${totalVesselCount} Vessels)`,
    message: 'Purchasing vessels sequentially with 1.5s delay between each:',
    details: vesselDetails,
    confirmText: 'Buy All',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  // Broadcast bulk buy start to lock buttons on all clients
  try {
    await fetch(`${window.API_PREFIX}/vessel/bulk-buy-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error broadcasting bulk buy start:', error);
  }

  const cartBtn = document.getElementById('cartBtn');
  cartBtn.disabled = true;
  cartBtn.textContent = 'Purchasing...';

  let successCount = 0;
  const purchasedVessels = [];

  for (let i = 0; i < selectedVessels.length; i++) {
    const item = selectedVessels[i];

    for (let q = 0; q < item.quantity; q++) {
      try {
        const data = await apiPurchaseVessel(item.vessel.id, item.vessel.name, item.vessel.antifouling, true); // silent=true

        if (data.error) {
          console.error(`Failed to purchase ${item.vessel.name}:`, data.error);

          if (data.error === 'vessel_limit_reached') {
            const msg = successCount > 0
              ? `🚢 <strong>Vessel limit reached! Purchased ${successCount} vessel(s), could not buy more.</strong>`
              : `🚢 <strong>Vessel limit reached! Cannot purchase any vessels.</strong>`;
            showSideNotification(msg, 'error', null, false);
            i = selectedVessels.length;
            break;
          } else if (data.error === 'not_enough_cash') {
            const msg = successCount > 0
              ? `🚢 <strong>Not enough cash! Purchased ${successCount} vessel(s), ran out of money.</strong>`
              : `🚢 <strong>Not enough cash! Cannot afford any vessels.</strong>`;
            showSideNotification(msg, 'error', null, true);
            i = selectedVessels.length;
            break;
          } else {
            const msg = successCount > 0
              ? `🚢 <strong>Error: ${data.error} - Purchased ${successCount} so far</strong>`
              : `🚢 <strong>Error: ${data.error}</strong>`;
            showSideNotification(msg, 'error');
          }
        } else {
          successCount++;
          purchasedVessels.push({ name: item.vessel.name, price: item.vessel.price });
          if (data.user && data.user.cash !== undefined) {
            updateCurrentCash(data.user.cash);
          }
        }
      } catch (error) {
        console.error(`Error purchasing ${item.vessel.name}:`, error);
        showSideNotification(`🚢 <strong>Network error purchasing ${item.vessel.name}</strong>`, 'error', null, true);
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Send summary notification to backend (broadcasts to ALL clients)
  if (successCount > 0) {
    try {
      const purchaseTotalCost = purchasedVessels.reduce((sum, v) => sum + v.price, 0);
      await fetch(`${window.API_PREFIX}/vessel/broadcast-purchase-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessels: purchasedVessels, totalCost: purchaseTotalCost })
      });
    } catch (error) {
      console.error('Error broadcasting purchase summary:', error);
    }
  } else {
    // If no successful purchases, still need to broadcast complete to unlock buttons
    try {
      await fetch(`${window.API_PREFIX}/vessel/broadcast-purchase-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vessels: [], totalCost: 0 })
      });
    } catch (error) {
      console.error('Error broadcasting bulk buy complete:', error);
    }
  }

  if (cartBtn) {
    cartBtn.disabled = false;
    cartBtn.textContent = `🛒 Cart (0)`;
    cartBtn.classList.add('hidden');
  }

  selectedVessels = [];
  saveCartToStorage(); // Clear cart from localStorage
  const selectedCountEl = document.getElementById('selectedCount');
  if (selectedCountEl) selectedCountEl.textContent = '0';

  // Backend broadcasts notification to ALL clients via WebSocket
  // No need to show notification here - all clients will receive it

  if (successCount > 0 && window.updateVesselCount) {
    await updateVesselCount();
  }

  await loadAcquirableVessels(true);
}

export function setVesselFilter(filter) {
  currentVesselFilter = filter;
  selectedEngineType = null;
}

export function getVesselFilter() {
  return currentVesselFilter;
}

/**
 * Locks the depart button when autopilot or manual departure starts.
 * Called by WebSocket handler when 'autopilot_depart_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockDepartButton() {
  updateButtonState('departAll', true);
  if (window.DEBUG_MODE) console.log('[Depart Button] Locked (UI only) - departure in progress');
}

/**
 * Unlocks the depart button when departure process completes.
 * Called by WebSocket handler when 'vessels_depart_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockDepartButton() {
  // Check if there are vessels ready to depart
  const countBadge = document.querySelector('.map-icon-item[data-action="departAll"] .map-icon-badge');
  const hasVessels = countBadge && !countBadge.classList.contains('hidden') && parseInt(countBadge.textContent) > 0;
  updateButtonState('departAll', !hasVessels);
  if (window.DEBUG_MODE) console.log('[Depart Button] Unlocked (UI only) - departure complete');
}

/**
 * Returns whether a departure operation is currently in progress.
 * Used to prevent button state changes during departure.
 * Returns server-controlled lock state (READ-ONLY).
 * @global
 * @returns {boolean} True if departure is in progress
 */
export function isDepartInProgress() {
  return serverLockState.depart;
}

/**
 * Locks the repair button when repair process starts.
 * Called by WebSocket handler when 'repair_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockRepairButton() {
  updateButtonState('repairAll', true);
  if (window.DEBUG_MODE) console.log('[Repair Button] Locked (UI only) - repair in progress');
}

/**
 * Unlocks the repair button when repair process completes.
 * Called by WebSocket handler when 'repair_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockRepairButton() {
  updateButtonState('repairAll', false);
  if (window.DEBUG_MODE) console.log('[Repair Button] Unlocked (UI only) - repair complete');
}

/**
 * Locks the bulk buy (cart) button when bulk purchase starts.
 * Called by WebSocket handler when 'bulk_buy_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockBulkBuyButton() {
  const cartBtn = document.getElementById('cartBtn');
  if (cartBtn) {
    cartBtn.disabled = true;
  }
  if (window.DEBUG_MODE) console.log('[Bulk Buy Button] Locked (UI only) - bulk purchase in progress');
}

/**
 * Unlocks the bulk buy (cart) button when bulk purchase completes.
 * Called by WebSocket handler when 'bulk_buy_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockBulkBuyButton() {
  const cartBtn = document.getElementById('cartBtn');
  if (cartBtn) {
    cartBtn.disabled = false;
  }
  if (window.DEBUG_MODE) console.log('[Bulk Buy Button] Unlocked (UI only) - bulk purchase complete');
}

/**
 * Locks the fuel purchase button.
 * Called by WebSocket handler when 'fuel_purchase_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockFuelButton() {
  const fuelBtn = document.getElementById('fuelBtn');
  if (fuelBtn) {
    fuelBtn.disabled = true;
  }
  if (window.DEBUG_MODE) console.log('[Fuel Button] Locked (UI only) - fuel purchase in progress');
}

/**
 * Unlocks the fuel purchase button.
 * Called by WebSocket handler when 'fuel_purchase_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockFuelButton() {
  const fuelBtn = document.getElementById('fuelBtn');
  if (fuelBtn) {
    fuelBtn.disabled = false;
  }
  if (window.DEBUG_MODE) console.log('[Fuel Button] Unlocked (UI only) - fuel purchase complete');
}

/**
 * Locks the CO2 purchase button.
 * Called by WebSocket handler when 'co2_purchase_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockCo2Button() {
  const co2Btn = document.getElementById('co2Btn');
  if (co2Btn) {
    co2Btn.disabled = true;
  }
  if (window.DEBUG_MODE) console.log('[CO2 Button] Locked (UI only) - CO2 purchase in progress');
}

/**
 * Unlocks the CO2 purchase button.
 * Called by WebSocket handler when 'co2_purchase_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockCo2Button() {
  const co2Btn = document.getElementById('co2Btn');
  if (co2Btn) {
    co2Btn.disabled = false;
  }
  if (window.DEBUG_MODE) console.log('[CO2 Button] Unlocked (UI only) - CO2 purchase complete');
}

/**
 * Locks the drydock button when drydock process starts.
 * Called by WebSocket handler when 'drydock_start' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function lockDrydockButton() {
  updateButtonState('drydockAll', true);
  if (window.DEBUG_MODE) console.log('[Drydock Button] Locked (UI only) - drydock in progress');
}

/**
 * Unlocks the drydock button when drydock process completes.
 * Called by WebSocket handler when 'drydock_complete' is received.
 * UI-ONLY function - state is managed by server via lock_status events.
 * @global
 */
export function unlockDrydockButton() {
  updateButtonState('drydockAll', false);
  if (window.DEBUG_MODE) console.log('[Drydock Button] Unlocked (UI only) - drydock complete');
}

// ===== NEW FILTER SYSTEM =====

/**
 * Populate dynamic filter dropdowns based on actual vessel data
 */
function populateDynamicFilters() {
  if (window.DEBUG_MODE) console.log('[Filters] Populating dynamic filters from', allAcquirableVessels.length, 'vessels');

  // Price Range: 500k steps up to 10M, then 10M steps to 100M, then 50M steps to 200M
  const priceMin = document.getElementById('priceMin');
  const priceMax = document.getElementById('priceMax');
  priceMin.innerHTML = '<option value="0">0</option>';
  priceMax.innerHTML = '';

  // 500k steps: 0.5M to 10M
  for (let price = 500000; price <= 10000000; price += 500000) {
    const label = `${(price / 1000000).toFixed(1)}M`;
    priceMin.innerHTML += `<option value="${price}">${label}</option>`;
    priceMax.innerHTML += `<option value="${price}">${label}</option>`;
  }

  // 10M steps: 10M to 100M
  for (let price = 10000000; price <= 100000000; price += 10000000) {
    const label = `${(price / 1000000)}M`;
    priceMin.innerHTML += `<option value="${price}">${label}</option>`;
    priceMax.innerHTML += `<option value="${price}">${label}</option>`;
  }

  // 50M steps: 100M to 200M
  for (let price = 100000000; price <= 200000000; price += 50000000) {
    const label = `${(price / 1000000)}M`;
    priceMin.innerHTML += `<option value="${price}">${label}</option>`;
    priceMax.innerHTML += `<option value="${price}">${label}</option>`;
  }

  // Add "max" option for priceMax
  priceMax.innerHTML += '<option value="Infinity">max</option>';
  priceMax.value = 'Infinity';

  // Year Built: All unique years from vessel data (MOVED TO BOTTOM - unwichtig)
  const years = [...new Set(allAcquirableVessels.map(v => v.year))].sort((a, b) => a - b);
  const yearMin = document.getElementById('yearMin');
  const yearMax = document.getElementById('yearMax');
  yearMin.innerHTML = `<option value="0">${years[0]}</option>`;
  yearMax.innerHTML = `<option value="9999">${years[years.length - 1]}</option>`;

  years.forEach(year => {
    yearMin.innerHTML += `<option value="${year}">${year}</option>`;
    yearMax.innerHTML += `<option value="${year}">${year}</option>`;
  });
  yearMax.value = '9999';

  // Engine Type: Multiselect with all unique engine types
  // CRITICAL: Only "All Engines" should be selected by default, NOT all individual options
  const engineTypes = [...new Set(allAcquirableVessels.map(v => v.engine_type))].sort();
  const engineSelect = document.getElementById('engineType');
  engineSelect.innerHTML = '<option value="all" selected>All Engines</option>';

  engineTypes.forEach(engineType => {
    const displayName = engineType.toUpperCase().replace(/_/g, ' ');
    // NOT selected by default - user must select manually
    engineSelect.innerHTML += `<option value="${engineType}">${displayName}</option>`;
  });

  // Max Speed: 5kn steps from min to max speed (NO "kn" in dropdown, it's in title)
  const speeds = allAcquirableVessels.map(v => v.max_speed);
  const minSpeed = Math.floor(Math.min(...speeds) / 5) * 5;
  const maxSpeed = Math.ceil(Math.max(...speeds) / 5) * 5;
  const speedMin = document.getElementById('speedMin');
  const speedMax = document.getElementById('speedMax');
  speedMin.innerHTML = `<option value="0">${minSpeed}</option>`;
  speedMax.innerHTML = `<option value="999">${maxSpeed}</option>`;

  for (let speed = minSpeed; speed <= maxSpeed; speed += 5) {
    speedMin.innerHTML += `<option value="${speed}">${speed}</option>`;
    speedMax.innerHTML += `<option value="${speed}">${speed}</option>`;
  }
  speedMax.value = '999';

  // Service Hours: 50h steps from min to max (NO "h" in dropdown, it's in title)
  const serviceHours = allAcquirableVessels.map(v => v.hours_between_service);
  const minService = Math.floor(Math.min(...serviceHours) / 50) * 50;
  const maxService = Math.ceil(Math.max(...serviceHours) / 50) * 50;
  const serviceMin = document.getElementById('serviceMin');
  const serviceMax = document.getElementById('serviceMax');
  serviceMin.innerHTML = `<option value="0">${minService}</option>`;
  serviceMax.innerHTML = '';

  for (let service = minService; service <= maxService; service += 50) {
    serviceMin.innerHTML += `<option value="${service}">${service}</option>`;
    serviceMax.innerHTML += `<option value="${service}">${service}</option>`;
  }

  // Add "max" option for serviceMax
  serviceMax.innerHTML += '<option value="Infinity">max</option>';
  serviceMax.value = 'Infinity';

  // Fuel Factor: 0.5 steps from ACTUAL min to max (NOT from 0!)
  const fuelFactors = allAcquirableVessels.map(v => v.fuel_factor);
  const minFuel = Math.floor(Math.min(...fuelFactors) * 2) / 2;
  const maxFuel = Math.ceil(Math.max(...fuelFactors) * 2) / 2;
  const fuelMin = document.getElementById('fuelFactorMin');
  const fuelMax = document.getElementById('fuelFactorMax');
  fuelMin.innerHTML = '';
  fuelMax.innerHTML = '';

  for (let fuel = minFuel; fuel <= maxFuel; fuel += 0.5) {
    fuelMin.innerHTML += `<option value="${fuel}">${fuel.toFixed(1)}</option>`;
    fuelMax.innerHTML += `<option value="${fuel}">${fuel.toFixed(1)}</option>`;
  }
  fuelMin.value = minFuel.toString();
  fuelMax.value = maxFuel.toString();

  // CO2 Factor: 0.5 steps from ACTUAL min to max (NOT from 0!)
  const co2Factors = allAcquirableVessels.map(v => v.co2_factor);
  const minCO2 = Math.floor(Math.min(...co2Factors) * 2) / 2;
  const maxCO2 = Math.ceil(Math.max(...co2Factors) * 2) / 2;
  const co2Min = document.getElementById('co2FactorMin');
  const co2Max = document.getElementById('co2FactorMax');
  co2Min.innerHTML = '';
  co2Max.innerHTML = '';

  for (let co2 = minCO2; co2 <= maxCO2; co2 += 0.5) {
    co2Min.innerHTML += `<option value="${co2}">${co2.toFixed(1)}</option>`;
    co2Max.innerHTML += `<option value="${co2}">${co2.toFixed(1)}</option>`;
  }
  co2Min.value = minCO2.toString();
  co2Max.value = maxCO2.toString();

  // Capacity: Dynamic based on which vessel types are selected
  updateCapacityDropdowns();

  if (window.DEBUG_MODE) {
    console.log('[Filters] Dynamic filters populated:', {
      years: years.length,
      engineTypes: engineTypes.length,
      speedRange: `${minSpeed}-${maxSpeed}kn`,
      serviceRange: `${minService}-${maxService}h`,
      fuelFactorRange: `${minFuel}-${maxFuel}`,
      co2FactorRange: `${minCO2}-${maxCO2}`
    });
  }
}

/**
 * Update capacity dropdowns based on selected vessel types
 * Shows/hides TEU and BBL sections depending on which vessel types are selected
 */
function updateCapacityDropdowns() {
  const vesselTypeCheckboxes = document.querySelectorAll('input[name="vesselType"]:checked');
  const selectedTypes = Array.from(vesselTypeCheckboxes).map(cb => cb.value);

  const teuSection = document.getElementById('capacityTEUSection');
  const bblSection = document.getElementById('capacityBBLSection');

  // Show/hide sections based on selected types
  if (selectedTypes.includes('container')) {
    teuSection.classList.remove('hidden');

    // Get actual max TEU from API (min always starts at 0)
    const containerCapacities = allAcquirableVessels
      .filter(v => v.capacity_type === 'container')
      .map(v => v.capacity_max || 0);

    if (containerCapacities.length === 0) {
      teuSection.classList.add('hidden');
      return;
    }

    const apiMaxTEU = Math.max(...containerCapacities);

    // Fixed step sizes: 0 | 50 | 100 | 250 | 500 | 1k | 2k | 3k | 4k | 5k | 10k | 15k | 20k | 25k
    const teuSteps = [0, 50, 100, 250, 500, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 20000, 25000];

    // Filter steps to only include values <= API max
    const validSteps = teuSteps.filter(step => step <= apiMaxTEU);

    // Always include actual max from API
    const finalSteps = [...new Set([...validSteps, apiMaxTEU])].sort((a, b) => a - b);

    const capacityMinTEU = document.getElementById('capacityMinTEU');
    const capacityMaxTEU = document.getElementById('capacityMaxTEU');
    capacityMinTEU.innerHTML = '';
    capacityMaxTEU.innerHTML = '';

    // Populate Min dropdown
    finalSteps.forEach(cap => {
      const label = cap >= 1000 ? `${(cap / 1000)}k` : `${cap}`;
      capacityMinTEU.innerHTML += `<option value="${cap}">${label}</option>`;
    });

    // Populate Max dropdown (with steps + "max" option)
    finalSteps.forEach(cap => {
      const label = cap >= 1000 ? `${(cap / 1000)}k` : `${cap}`;
      capacityMaxTEU.innerHTML += `<option value="${cap}">${label}</option>`;
    });
    // Add "max" option (value = Infinity to show all vessels >= minValue)
    capacityMaxTEU.innerHTML += `<option value="Infinity">max</option>`;

    capacityMinTEU.value = 0;
    capacityMaxTEU.value = 'Infinity';  // Default to "max"

    if (window.DEBUG_MODE) console.log('[Filters] TEU range:', { min: 0, apiMax: apiMaxTEU, steps: finalSteps });
  } else {
    teuSection.classList.add('hidden');
  }

  if (selectedTypes.includes('tanker')) {
    bblSection.classList.remove('hidden');

    // Get actual max BBL from API (min always starts at 0)
    const tankerCapacities = allAcquirableVessels
      .filter(v => v.capacity_type === 'tanker')
      .map(v => {
        const cap = v.capacity_max || {};
        return Math.max(
          cap.crude_oil || 0,
          cap.chemicals || 0,
          cap.lng || 0,
          cap.products || 0,
          cap.fuel || 0
        );
      });

    if (tankerCapacities.length === 0) {
      bblSection.classList.add('hidden');
      return;
    }

    const apiMaxBBL = Math.max(...tankerCapacities);

    // Fixed BBL step sizes: 0 | 5k | 10k | 25k | 50k | 75k | 100k | 150k | 200k | 250k | 300k | 400k | 500k | 750k | 1M
    const bblSteps = [0, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000, 250000, 300000, 400000, 500000, 750000, 1000000];

    // Filter steps to only include values <= API max
    const validSteps = bblSteps.filter(step => step <= apiMaxBBL);

    // Always include actual max from API
    const finalSteps = [...new Set([...validSteps, apiMaxBBL])].sort((a, b) => a - b);

    const capacityMinBBL = document.getElementById('capacityMinBBL');
    const capacityMaxBBL = document.getElementById('capacityMaxBBL');
    capacityMinBBL.innerHTML = '';
    capacityMaxBBL.innerHTML = '';

    // Populate Min dropdown
    finalSteps.forEach(cap => {
      const label = cap >= 1000 ? `${(cap / 1000)}k` : `${cap}`;
      capacityMinBBL.innerHTML += `<option value="${cap}">${label}</option>`;
    });

    // Populate Max dropdown (with steps + "max" option)
    finalSteps.forEach(cap => {
      const label = cap >= 1000 ? `${(cap / 1000)}k` : `${cap}`;
      capacityMaxBBL.innerHTML += `<option value="${cap}">${label}</option>`;
    });
    // Add "max" option (value = Infinity to show all vessels >= minValue)
    capacityMaxBBL.innerHTML += `<option value="Infinity">max</option>`;

    capacityMinBBL.value = 0;
    capacityMaxBBL.value = 'Infinity';  // Default to "max"

    if (window.DEBUG_MODE) console.log('[Filters] BBL range:', { min: 0, apiMax: apiMaxBBL, steps: finalSteps });
  } else {
    bblSection.classList.add('hidden');
  }
}

// Auto-apply filters when any filter input changes
document.addEventListener('DOMContentLoaded', () => {
  // Vessel type checkboxes: update capacity dropdowns AND apply filters
  document.querySelectorAll('input[name="vesselType"]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      if (allAcquirableVessels.length > 0) {
        updateCapacityDropdowns();
        applyVesselFilters();
      }
    });
  });

  // Special checkboxes: apply filters on change
  document.querySelectorAll('input[name="special"]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
      if (allAcquirableVessels.length > 0) {
        applyVesselFilters();
      }
    });
  });

  // All filter dropdowns: apply filters on change
  const filterSelects = [
    'priceMin', 'priceMax',
    'yearMin', 'yearMax',
    'engineType',
    'speedMin', 'speedMax',
    'serviceMin', 'serviceMax',
    'fuelFactorMin', 'fuelFactorMax',
    'co2FactorMin', 'co2FactorMax',
    'capacityMin', 'capacityMax'
  ];

  filterSelects.forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('change', () => {
        if (allAcquirableVessels.length > 0) {
          applyVesselFilters();
        }
      });
    }
  });
});

// ===== IMAGE CACHING SYSTEM =====
// Since same vessel.type = same image, cache images by type to avoid redundant loads
// Vessel image preloading completely handled in script.js STEP 8.5
// All vessel and harbor images are preloaded on page load in background

/**
 * Create a vessel card element with image caching
 */
function createVesselCard(vessel, isPending = false) {
  const imageUrl = `/api/vessel-image/${vessel.type}`;

  // Images are preloaded on page load (script.js STEP 8.5)
  // No need to check cache here - all images already loaded

  // Pending vessels don't show purchase buttons
  let isVesselTypeLocked = false;
  let availableSlots = 0;
  let canPurchase = false;

  if (!isPending) {
    // Check if user has unlocked this vessel type
    // Container is ALWAYS unlocked (everyone has it by default)
    // Tanker is locked until company_type includes "tanker"
    const userCompanyType = window.USER_COMPANY_TYPE;
    isVesselTypeLocked = vessel.capacity_type === 'tanker' && (!userCompanyType || !userCompanyType.includes('tanker'));

    // Check if anchor slots are available
    availableSlots = getAvailableAnchorSlots();
    canPurchase = availableSlots > 0 && !isVesselTypeLocked;
  }

  const capacityDisplay = getCapacityDisplay(vessel);
  const co2Class = getCO2EfficiencyClass(vessel.co2_factor);
  const fuelClass = getFuelEfficiencyClass(vessel.fuel_factor);

  let additionalAttrs = '';
  if (vessel.width && vessel.width !== 0) {
    additionalAttrs += `<div class="vessel-spec"><strong>Width:</strong> ${vessel.width} m</div>`;
  }
  if (vessel.price_in_points && vessel.price_in_points !== 0) {
    additionalAttrs += `<div class="vessel-spec"><strong>Points Price:</strong> ${formatNumber(vessel.price_in_points)}</div>`;
  }
  if (vessel.perks && vessel.perks !== null) {
    additionalAttrs += `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${vessel.perks}</div>`;
  }

  const card = document.createElement('div');
  card.className = isPending ? 'vessel-card pending-vessel' : 'vessel-card';
  card.innerHTML = `
    <div class="vessel-image-container">
      <img src="${imageUrl}" alt="${vessel.name}" class="vessel-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>⛴️</text></svg>'">
      ${vessel.only_for_credits ? '<div class="vessel-credits-overlay">$</div>' : ''}
      ${isVesselTypeLocked ? '<div class="vessel-locked-overlay"><div class="vessel-locked-banner">🔒 Locked</div><div class="vessel-locked-text">Unlock ' + vessel.capacity_type + ' vessels first</div></div>' : ''}
      ${isPending ? `<div class="vessel-time-badge">⏱️ In Delivery ${(() => {
        const remaining = vessel.time_arrival || 0;
        if (remaining > 0) {
          const days = Math.floor(remaining / 86400);
          const hours = Math.floor((remaining % 86400) / 3600);
          const minutes = Math.floor((remaining % 3600) / 60);
          if (days > 0) return `${days}d ${hours}h`;
          if (hours > 0) return `${hours}h ${minutes}m`;
          return `${minutes}m`;
        }
        return 'Ready';
      })()}</div>` : ''}
      ${isPending ? '<button class="vessel-locate-btn vessel-locate-btn-image" data-vessel-id="' + vessel.id + '" title="Show on map" onmouseover="this.querySelector(\'span\').style.animation=\'pulse-arrow 0.6s ease-in-out infinite\'" onmouseout="this.querySelector(\'span\').style.animation=\'none\'"><span>📍</span></button>' : ''}
    </div>
    <div class="vessel-content">
      <div class="vessel-header">
        <h3 class="vessel-name">${vessel.name}</h3>
        <div class="vessel-price">$${formatNumber(vessel.price)}</div>
      </div>
      <div class="vessel-specs">
        <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
        <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range)} nm</div>
        <div class="vessel-spec ${co2Class}"><strong>CO2 Factor:</strong> ${vessel.co2_factor}</div>
        <div class="vessel-spec ${fuelClass}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor}</div>
        <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(vessel.fuel_capacity)} t</div>
        <div class="vessel-spec"><strong>Service:</strong> ${vessel.hours_between_service}h</div>
        <div class="vessel-spec"><strong>Engine:</strong> ${vessel.engine_type} (${formatNumber(vessel.kw)} kW)</div>
        <div class="vessel-spec"><strong>Speed:</strong> ${vessel.max_speed} kn</div>
        <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name}</div>
        <div class="vessel-spec"><strong>Port:</strong> ${vessel.current_port_code.replace(/_/g, ' ')}</div>
        <div class="vessel-spec"><strong>Year:</strong> ${vessel.year}</div>
        <div class="vessel-spec"><strong>Length:</strong> ${vessel.length} m</div>
        <div class="vessel-spec"><strong>IMO:</strong> ${vessel.imo || 'N/A'}</div>
        <div class="vessel-spec"><strong>MMSI:</strong> ${vessel.mmsi || 'N/A'}</div>
        ${vessel.gearless || vessel.antifouling || additionalAttrs ? '<div class="vessel-spec vessel-spec-divider"></div>' : ''}
        ${vessel.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
        ${vessel.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${vessel.antifouling}</div>` : ''}
        ${additionalAttrs}
      </div>
      ${!isPending ? `
        <div class="vessel-actions">
          <input type="number" class="vessel-quantity-input" data-vessel-id="${vessel.id}" value="1" min="1" max="99" ${!canPurchase ? 'disabled' : ''} />
          <div class="vessel-action-buttons">
            <button class="vessel-select-btn" data-vessel-id="${vessel.id}" ${!canPurchase ? 'disabled title="' + (isVesselTypeLocked ? 'Vessel type locked' : 'Not enough anchor slots') + '"' : ''}>
              Add to Cart
            </button>
            <button class="vessel-buy-btn" data-vessel-id="${vessel.id}" ${!canPurchase ? 'disabled title="' + (isVesselTypeLocked ? 'Vessel type locked' : 'Not enough anchor slots') + '"' : ''}>
              Buy Now
            </button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  // Only add event listeners for acquirable vessels
  if (!isPending) {
    card.querySelector('.vessel-select-btn').addEventListener('click', () => {
      const quantityInput = card.querySelector('.vessel-quantity-input');
      const quantity = parseInt(quantityInput.value) || 1;
      toggleVesselSelection(vessel, quantity);
      quantityInput.value = 1; // Reset to 1 after adding to cart
    });
    card.querySelector('.vessel-buy-btn').addEventListener('click', () => {
      const quantityInput = card.querySelector('.vessel-quantity-input');
      const quantity = parseInt(quantityInput.value) || 1;
      purchaseSingleVessel(vessel, quantity);
    });
  } else {
    // For pending vessels, add locate button listener
    const locateBtn = card.querySelector('.vessel-locate-btn');
    if (locateBtn) {
      locateBtn.addEventListener('click', async () => {
        const vesselId = parseInt(locateBtn.dataset.vesselId);

        // Close buy vessels overlay
        document.getElementById('buyVesselsOverlay').classList.add('hidden');

        // Open harbor map and select vessel
        if (window.showHarborMapOverlay) {
          await window.showHarborMapOverlay();
        }

        // Select the vessel on map
        await selectVessel(vesselId);
      });
    }
  }

  return card;
}

let currentFilters = {
  vesselType: ['container', 'tanker'],
  priceMin: 0,
  priceMax: 999999999,
  yearMin: 0,
  yearMax: 9999,
  engineTypes: [], // Array of selected engine types
  speedMin: 0,
  speedMax: 999,
  serviceMin: 0,
  serviceMax: 999999,
  fuelFactorMin: 0,
  fuelFactorMax: 999,
  co2FactorMin: 0,
  co2FactorMax: 999,
  capacityMinTEU: 0,
  capacityMaxTEU: 999999,
  capacityMinBBL: 0,
  capacityMaxBBL: 999999,
  special: [] // Default: show all vessels (with AND without perks)
};

let priceSort = 'asc'; // 'asc' or 'desc'

// Track if filters are in default state
function areFiltersDefault() {
  const vesselTypeChecked = document.querySelectorAll('input[name="vesselType"]:checked').length;
  const vesselTypeTotal = document.querySelectorAll('input[name="vesselType"]').length;

  const engineSelect = document.getElementById('engineType');
  const allEnginesSelected = engineSelect.value === 'all';

  // Check if special filters are in default state (both unchecked)
  const perksChecked = document.querySelector('input[name="special"][value="perks"]')?.checked || false;
  const creditsChecked = document.querySelector('input[name="special"][value="credits"]')?.checked || false;
  const specialFiltersDefault = !perksChecked && !creditsChecked;

  return vesselTypeChecked === vesselTypeTotal &&
         specialFiltersDefault && // Default: both unchecked
         allEnginesSelected &&
         document.getElementById('priceMin').value === '0' &&
         document.getElementById('priceMax').value === 'Infinity' &&
         document.getElementById('yearMin').value === '0' &&
         document.getElementById('yearMax').value === '9999' &&
         document.getElementById('speedMin').value === '0' &&
         document.getElementById('speedMax').value === '999' &&
         document.getElementById('serviceMin').value === '0' &&
         document.getElementById('serviceMax').value === 'Infinity' &&
         document.getElementById('fuelFactorMin').value === document.getElementById('fuelFactorMin').options[0].value &&
         document.getElementById('fuelFactorMax').value === document.getElementById('fuelFactorMax').options[document.getElementById('fuelFactorMax').options.length - 1].value &&
         document.getElementById('co2FactorMin').value === document.getElementById('co2FactorMin').options[0].value &&
         document.getElementById('co2FactorMax').value === document.getElementById('co2FactorMax').options[document.getElementById('co2FactorMax').options.length - 1].value &&
         (!document.getElementById('capacityMinTEU') || document.getElementById('capacityMinTEU').value === '0') &&
         (!document.getElementById('capacityMaxTEU') || document.getElementById('capacityMaxTEU').value === 'Infinity') &&
         (!document.getElementById('capacityMinBBL') || document.getElementById('capacityMinBBL').value === '0') &&
         (!document.getElementById('capacityMaxBBL') || document.getElementById('capacityMaxBBL').value === 'Infinity');
}

/**
 * Apply all selected filters to vessel catalog
 */
window.applyVesselFilters = function() {
  if (window.DEBUG_MODE) console.log('[Apply Filters] Collecting filter values from dropdowns...');

  // Vessel Type checkboxes
  currentFilters.vesselType = [];
  document.querySelectorAll('input[name="vesselType"]:checked').forEach(cb => {
    currentFilters.vesselType.push(cb.value);
  });

  // Price Range dropdowns
  currentFilters.priceMin = parseFloat(document.getElementById('priceMin').value) || 0;
  const priceMaxEl = document.getElementById('priceMax');
  currentFilters.priceMax = priceMaxEl.value === 'Infinity' ? Infinity : parseFloat(priceMaxEl.value) || 999999999;

  // Year Built dropdowns
  currentFilters.yearMin = parseInt(document.getElementById('yearMin').value) || 0;
  currentFilters.yearMax = parseInt(document.getElementById('yearMax').value) || 9999;

  // Engine Type dropdown
  const engineSelect = document.getElementById('engineType');
  const selectedEngine = engineSelect.value;
  if (selectedEngine === 'all') {
    currentFilters.engineTypes = []; // Empty means show all
  } else {
    currentFilters.engineTypes = [selectedEngine];
  }

  // Speed Range dropdowns
  currentFilters.speedMin = parseFloat(document.getElementById('speedMin').value) || 0;
  currentFilters.speedMax = parseFloat(document.getElementById('speedMax').value) || 999;

  // Service Hours dropdowns
  currentFilters.serviceMin = parseFloat(document.getElementById('serviceMin').value) || 0;
  const serviceMaxEl = document.getElementById('serviceMax');
  currentFilters.serviceMax = serviceMaxEl.value === 'Infinity' ? Infinity : parseFloat(serviceMaxEl.value) || 999999;

  // Fuel Factor dropdowns
  currentFilters.fuelFactorMin = parseFloat(document.getElementById('fuelFactorMin').value) || 0;
  currentFilters.fuelFactorMax = parseFloat(document.getElementById('fuelFactorMax').value) || 999;

  // CO2 Factor dropdowns
  currentFilters.co2FactorMin = parseFloat(document.getElementById('co2FactorMin').value) || 0;
  currentFilters.co2FactorMax = parseFloat(document.getElementById('co2FactorMax').value) || 999;

  // Capacity Size dropdowns (separate for TEU and BBL)
  const teuMinEl = document.getElementById('capacityMinTEU');
  const teuMaxEl = document.getElementById('capacityMaxTEU');
  const bblMinEl = document.getElementById('capacityMinBBL');
  const bblMaxEl = document.getElementById('capacityMaxBBL');

  currentFilters.capacityMinTEU = teuMinEl ? parseFloat(teuMinEl.value) || 0 : 0;
  currentFilters.capacityMaxTEU = teuMaxEl ? (teuMaxEl.value === 'Infinity' ? Infinity : parseFloat(teuMaxEl.value) || 999999) : 999999;
  currentFilters.capacityMinBBL = bblMinEl ? parseFloat(bblMinEl.value) || 0 : 0;
  currentFilters.capacityMaxBBL = bblMaxEl ? (bblMaxEl.value === 'Infinity' ? Infinity : parseFloat(bblMaxEl.value) || 999999) : 999999;

  // Special checkboxes
  currentFilters.special = [];
  document.querySelectorAll('input[name="special"]:checked').forEach(cb => {
    currentFilters.special.push(cb.value);
  });

  // Show/hide reset button based on whether filters are in default state
  const resetBar = document.getElementById('resetFiltersBtn');
  if (areFiltersDefault()) {
    resetBar.classList.add('hidden');
  } else {
    resetBar.classList.remove('hidden');
  }

  if (window.DEBUG_MODE) console.log('[Apply Filters] Collected filters:', currentFilters);

  // Apply filters and redisplay
  displayFilteredVessels();
};

/**
 * Reset all filters to default (show all vessels)
 */
window.resetVesselFilters = function() {
  // Reset vessel type checkboxes to checked (all types)
  document.querySelectorAll('input[name="vesselType"]').forEach(cb => {
    cb.checked = true;
  });

  // Reset special checkboxes: both unchecked (show all vessels)
  document.querySelector('input[name="special"][value="perks"]').checked = false;
  document.querySelector('input[name="special"][value="credits"]').checked = false;

  // Reset all dropdowns to min/max values
  document.getElementById('priceMin').value = '0';
  document.getElementById('priceMax').value = 'Infinity';
  document.getElementById('yearMin').value = '0';
  document.getElementById('yearMax').value = '9999';

  // Reset engine type dropdown to "All Engines"
  const engineSelect = document.getElementById('engineType');
  engineSelect.value = 'all';

  document.getElementById('speedMin').value = '0';
  document.getElementById('speedMax').value = '999';
  document.getElementById('serviceMin').value = '0';
  document.getElementById('serviceMax').value = 'Infinity';
  // Reset Factor dropdowns to their actual min/max values (first and last option)
  const fuelFactorMin = document.getElementById('fuelFactorMin');
  const fuelFactorMax = document.getElementById('fuelFactorMax');
  if (fuelFactorMin && fuelFactorMin.options.length > 0) {
    fuelFactorMin.value = fuelFactorMin.options[0].value;
    fuelFactorMax.value = fuelFactorMax.options[fuelFactorMax.options.length - 1].value;
  }

  const co2FactorMin = document.getElementById('co2FactorMin');
  const co2FactorMax = document.getElementById('co2FactorMax');
  if (co2FactorMin && co2FactorMin.options.length > 0) {
    co2FactorMin.value = co2FactorMin.options[0].value;
    co2FactorMax.value = co2FactorMax.options[co2FactorMax.options.length - 1].value;
  }

  // Reset capacity dropdowns to their min/max (first and last option)
  const capacityMinTEU = document.getElementById('capacityMinTEU');
  const capacityMaxTEU = document.getElementById('capacityMaxTEU');
  if (capacityMinTEU && capacityMinTEU.options.length > 0) {
    capacityMinTEU.value = capacityMinTEU.options[0].value;
    capacityMaxTEU.value = capacityMaxTEU.options[capacityMaxTEU.options.length - 1].value;
  }

  const capacityMinBBL = document.getElementById('capacityMinBBL');
  const capacityMaxBBL = document.getElementById('capacityMaxBBL');
  if (capacityMinBBL && capacityMinBBL.options.length > 0) {
    capacityMinBBL.value = capacityMinBBL.options[0].value;
    capacityMaxBBL.value = capacityMaxBBL.options[capacityMaxBBL.options.length - 1].value;
  }

  if (window.DEBUG_MODE) console.log('[Filters] Reset to defaults');
  applyVesselFilters();
};

/**
 * Toggle price sort between ascending and descending
 */
window.togglePriceSort = function() {
  const btn = document.getElementById('sortPriceBtn');
  if (priceSort === 'asc') {
    priceSort = 'desc';
    btn.innerHTML = '💰 Price ↓';
    btn.dataset.sort = 'desc';
  } else {
    priceSort = 'asc';
    btn.innerHTML = '💰 Price ↑';
    btn.dataset.sort = 'asc';
  }
  displayFilteredVessels();
};

/**
 * Check if vessel passes all filter criteria
 */
function vesselPassesFilters(vessel) {
  // Vessel Type - If no types selected, show none
  if (currentFilters.vesselType.length === 0) {
    return false;
  }
  if (!currentFilters.vesselType.includes(vessel.capacity_type)) {
    return false;
  }

  // Price Range
  const price = vessel.price || 0;
  const maxPrice = currentFilters.priceMax === Infinity ? Number.MAX_SAFE_INTEGER : currentFilters.priceMax;
  if (price < currentFilters.priceMin || price > maxPrice) {
    return false;
  }

  // Year Built
  const year = vessel.year || 0;
  if (year < currentFilters.yearMin || year > currentFilters.yearMax) {
    return false;
  }

  // Engine Type - If specific engines selected, filter by them
  if (currentFilters.engineTypes.length > 0) {
    const engineType = vessel.engine_type || '';
    if (!currentFilters.engineTypes.includes(engineType)) {
      return false;
    }
  }

  // Max Speed
  const speed = vessel.max_speed || 0;
  if (speed < currentFilters.speedMin || speed > currentFilters.speedMax) {
    return false;
  }

  // Service Hours
  const service = vessel.hours_between_service || 0;
  const maxService = currentFilters.serviceMax === Infinity ? Number.MAX_SAFE_INTEGER : currentFilters.serviceMax;
  if (service < currentFilters.serviceMin || service > maxService) {
    return false;
  }

  // Fuel Factor
  const fuelFactor = vessel.fuel_factor;
  if (fuelFactor < currentFilters.fuelFactorMin || fuelFactor > currentFilters.fuelFactorMax) {
    return false;
  }

  // CO2 Factor
  const co2Factor = vessel.co2_factor;
  if (co2Factor < currentFilters.co2FactorMin || co2Factor > currentFilters.co2FactorMax) {
    return false;
  }

  // Capacity Size - Check against appropriate filter (TEU for containers, BBL for tankers)
  if (vessel.capacity_type === 'container') {
    const vesselCapacity = vessel.capacity_max || 0;
    const maxTEU = currentFilters.capacityMaxTEU === Infinity ? Number.MAX_SAFE_INTEGER : currentFilters.capacityMaxTEU;
    if (vesselCapacity < currentFilters.capacityMinTEU || vesselCapacity > maxTEU) {
      return false;
    }
  } else if (vessel.capacity_type === 'tanker') {
    const cap = vessel.capacity_max || {};
    const vesselCapacity = Math.max(
      cap.crude_oil || 0,
      cap.chemicals || 0,
      cap.lng || 0,
      cap.products || 0
    );
    const maxBBL = currentFilters.capacityMaxBBL === Infinity ? Number.MAX_SAFE_INTEGER : currentFilters.capacityMaxBBL;
    if (vesselCapacity < currentFilters.capacityMinBBL || vesselCapacity > maxBBL) {
      return false;
    }
  }

  // Special filters - INCLUSIVE filtering (show ONLY vessels matching at least one checked filter)
  // If at least one special filter is active, vessel must match one of them
  if (currentFilters.special.length > 0) {
    let matchesSpecialFilter = false;

    // Check if vessel matches "Credits Only" filter
    // only_for_credits can be: true, 1, "1", or any truthy value
    if (currentFilters.special.includes('credits') && vessel.only_for_credits) {
      matchesSpecialFilter = true;
      if (window.DEBUG_MODE) console.log('[Filter] Vessel matches "Credits Only":', vessel.name, 'only_for_credits:', vessel.only_for_credits);
    }

    // Check if vessel matches "Has Perks" filter
    // Perks can be any of these:
    // - antifouling: string like "type_a" (null = no antifouling)
    // - bulbous_bow: 1 or 0
    // - enhanced_thrusters: 1 or 0
    // - perks: string description (null = no perks)
    if (currentFilters.special.includes('perks')) {
      const hasAnyPerk = (
        (vessel.antifouling && vessel.antifouling !== null && vessel.antifouling !== '') ||
        vessel.bulbous_bow === 1 ||
        vessel.enhanced_thrusters === 1 ||
        (vessel.perks && vessel.perks !== null && vessel.perks !== '')
      );

      if (hasAnyPerk) {
        matchesSpecialFilter = true;
        if (window.DEBUG_MODE) {
          const perkDetails = [];
          if (vessel.antifouling) perkDetails.push(`antifouling:${vessel.antifouling}`);
          if (vessel.bulbous_bow === 1) perkDetails.push('bulbous_bow');
          if (vessel.enhanced_thrusters === 1) perkDetails.push('enhanced_thrusters');
          if (vessel.perks) perkDetails.push(`perks:${vessel.perks}`);
          console.log('[Filter] Vessel matches "Has Perks":', vessel.name, perkDetails.join(', '));
        }
      }
    }

    // If no special filter matches, exclude this vessel
    if (!matchesSpecialFilter) {
      if (window.DEBUG_MODE && currentFilters.special.includes('perks')) {
        console.log('[Filter] Vessel EXCLUDED (no perks):', vessel.name, {
          antifouling: vessel.antifouling,
          bulbous_bow: vessel.bulbous_bow,
          enhanced_thrusters: vessel.enhanced_thrusters,
          perks: vessel.perks,
          only_for_credits: vessel.only_for_credits
        });
      }
      return false;
    }
  }
  // If NO special filters are active (both unchecked), show ALL vessels (no filtering)

  return true;
}

// Lazy loading state
let currentlyDisplayedVessels = [];
let lazyLoadObserver = null;
const INITIAL_LOAD_COUNT = 12; // Load first 12 vessels immediately
const LAZY_LOAD_BATCH = 12; // Load 12 more when scrolling

/**
 * Display filtered and sorted vessels with lazy loading
 */
function displayFilteredVessels() {
  if (window.DEBUG_MODE) {
    console.log('[Filters] displayFilteredVessels called');
    console.log('[Filters] allAcquirableVessels:', allAcquirableVessels.length);
    console.log('[Filters] currentFilters:', currentFilters);
  }

  const filteredVessels = allAcquirableVessels.filter(vesselPassesFilters);

  if (window.DEBUG_MODE) console.log('[Filters] After filter:', filteredVessels.length);

  // Sort by price
  filteredVessels.sort((a, b) => {
    if (priceSort === 'asc') {
      return (a.price || 0) - (b.price || 0);
    } else {
      return (b.price || 0) - (a.price || 0);
    }
  });

  // Store filtered vessels for lazy loading
  currentlyDisplayedVessels = filteredVessels;

  // Render vessels
  const feed = document.getElementById('vesselCatalogFeed');
  if (!feed) {
    console.error('[Filters] vesselCatalogFeed not found!');
    return;
  }

  if (filteredVessels.length === 0) {
    feed.innerHTML = '<div style="text-align: center; padding: 40px; color: #9ca3af; font-size: 16px;">No vessels match the selected filters</div>';
    return;
  }

  feed.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = filteredVessels.length === 1 ? 'vessel-catalog-grid single-vessel' : 'vessel-catalog-grid';
  grid.id = 'vesselCatalogGrid';

  // Disconnect existing observer if any
  if (lazyLoadObserver) {
    lazyLoadObserver.disconnect();
  }

  // Load initial batch
  const initialBatch = filteredVessels.slice(0, INITIAL_LOAD_COUNT);
  initialBatch.forEach(vessel => {
    const card = createVesselCard(vessel);
    grid.appendChild(card);
  });

  // If more vessels exist, add lazy load sentinel
  if (filteredVessels.length > INITIAL_LOAD_COUNT) {
    const sentinel = document.createElement('div');
    sentinel.id = 'lazyLoadSentinel';
    sentinel.className = 'lazy-load-sentinel';
    sentinel.innerHTML = '<div style="text-align: center; padding: 20px; color: #9ca3af;">Loading more vessels...</div>';
    grid.appendChild(sentinel);

    // Setup Intersection Observer for lazy loading
    lazyLoadObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadMoreVessels();
        }
      });
    }, {
      rootMargin: '200px' // Start loading 200px before sentinel is visible
    });

    lazyLoadObserver.observe(sentinel);
  }

  feed.appendChild(grid);

  // Adjust window size if only 1 vessel is displayed
  const buyVesselsOverlay = document.getElementById('buyVesselsOverlay');
  const messengerWindow = buyVesselsOverlay?.querySelector('.messenger-window');
  if (messengerWindow) {
    if (filteredVessels.length === 1) {
      messengerWindow.classList.add('messenger-window-single-vessel');
    } else {
      messengerWindow.classList.remove('messenger-window-single-vessel');
    }
  }

  if (window.DEBUG_MODE) console.log(`[Filters] Showing ${Math.min(INITIAL_LOAD_COUNT, filteredVessels.length)} of ${filteredVessels.length} vessels (lazy loading enabled)`);
}

/**
 * Load next batch of vessels when scrolling
 */
function loadMoreVessels() {
  const grid = document.getElementById('vesselCatalogGrid');
  const sentinel = document.getElementById('lazyLoadSentinel');

  if (!grid || !sentinel) return;

  // Count currently loaded vessels (exclude sentinel)
  const currentCount = grid.children.length - 1;

  // Get next batch
  const nextBatch = currentlyDisplayedVessels.slice(currentCount, currentCount + LAZY_LOAD_BATCH);

  if (nextBatch.length === 0) {
    // No more vessels to load, remove sentinel
    sentinel.remove();
    if (lazyLoadObserver) {
      lazyLoadObserver.disconnect();
    }
    return;
  }

  // Insert new vessels before sentinel
  nextBatch.forEach(vessel => {
    const card = createVesselCard(vessel);
    grid.insertBefore(card, sentinel);
  });

  if (window.DEBUG_MODE) console.log(`[Lazy Load] Loaded ${nextBatch.length} more vessels (${currentCount + nextBatch.length}/${currentlyDisplayedVessels.length})`);

  // If all loaded, remove sentinel
  if (currentCount + nextBatch.length >= currentlyDisplayedVessels.length) {
    sentinel.remove();
    if (lazyLoadObserver) {
      lazyLoadObserver.disconnect();
    }
  }
}
