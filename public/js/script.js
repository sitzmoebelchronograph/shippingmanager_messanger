/**
 * @fileoverview Main application entry point for the Shipping Manager web interface.
 *
 * This is the CRITICAL initialization and orchestration module that:
 * - Loads and manages global settings state from the server
 * - Initializes all feature modules (chat, messenger, bunker, vessels, automation)
 * - Sets up 60+ event listeners for UI interactions
 * - Establishes WebSocket connection for real-time updates
 * - Configures auto-refresh intervals with randomized delays for anti-detection
 * - Handles settings synchronization across multiple browser tabs/devices
 * - Exposes global functions for HTML onclick handlers and cross-module access
 *
 * **Architectural Role:**
 * Acts as the dependency injection point and initialization sequencer. All modules
 * are pure functions that receive their dependencies (DOM elements, callbacks, settings)
 * from this central orchestrator. This prevents circular dependencies and makes
 * testing/refactoring easier.
 *
 * **Initialization Sequence:**
 * 1. Load settings from server (blocks until ready)
 * 2. Register service worker for mobile notifications
 * 3. Initialize custom tooltips
 * 4. Attach 60+ event listeners to UI elements
 * 5. Load initial data with 500ms delays between calls (prevents API socket hang-ups)
 * 6. Initialize WebSocket for real-time updates
 * 7. Initialize automation system (AutoPilot features)
 * 8. Start auto-refresh intervals with randomized delays
 *
 * **Anti-Detection Pattern:**
 * Uses randomized intervals (e.g., 25-27s instead of fixed 25s) to avoid triggering
 * server-side bot detection based on perfectly timed API calls.
 *
 * @module script
 * @requires ./modules/utils - Core utilities and settings management
 * @requires ./modules/api - API communication layer
 * @requires ./modules/ui-dialogs - Modal dialogs and overlays
 * @requires ./modules/chat - Alliance chat functionality
 * @requires ./modules/messenger - Private messaging system
 * @requires ./modules/bunker-management - Fuel/CO2 purchasing
 * @requires ./modules/vessel-management - Vessel operations and catalog
 * @requires ./modules/automation - AutoPilot automation system
 */

// Import utilities
import {
  loadSettings,
  saveSettings,
  initCustomTooltips,
  registerServiceWorker,
  requestNotificationPermission,
  showNotification,
  showSideNotification,
  updatePageTitle,
  escapeHtml
} from './modules/utils.js';

// Import API functions
import { initForecastCalendar, updateEventDiscount } from './modules/forecast-calendar.js';
import { initEventInfo, updateEventData } from './modules/event-info.js';
import { initLogbook, prependLogEntry } from './modules/logbook.js';

// Security: Block demo mode parameter in URL
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('demo')) {
  document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:monospace;font-size:18px;color:#ef4444;">⛔ Demo mode has been removed</div>';
  throw new Error('Demo mode has been removed');
}

// API prefix for all requests
const API_PREFIX = '/api';
window.API_PREFIX = API_PREFIX;

// Cache key for badge data
const CACHE_KEY = 'badgeCache';
window.CACHE_KEY = CACHE_KEY;

// ===== PER-USER LOCALSTORAGE HELPERS =====
/**
 * Get user-specific localStorage key to prevent data leakage between accounts.
 * Automatically prefixes key with userId when available.
 * @param {string} key - Base key name (e.g., 'autopilotPaused')
 * @returns {string} User-specific key (e.g., 'autopilotPaused_1234')
 */
function getUserStorageKey(key) {
  // Use window.CACHE_KEY if it's for badge cache
  if (key === 'badgeCache') {
    return window.CACHE_KEY || 'badgeCache';
  }
  // For other keys, check if we have a userId from settings
  if (window.USER_STORAGE_PREFIX) {
    return `${key}_${window.USER_STORAGE_PREFIX}`;
  }
  // Fallback to non-prefixed key if userId not yet loaded
  return key;
}

/**
 * Get item from localStorage with automatic per-user prefixing.
 * @param {string} key - Storage key
 * @returns {string|null} Stored value or null
 */
function getStorage(key) {
  return localStorage.getItem(getUserStorageKey(key));
}

/**
 * Set item in localStorage with automatic per-user prefixing.
 * @param {string} key - Storage key
 * @param {string} value - Value to store
 */
function setStorage(key, value) {
  localStorage.setItem(getUserStorageKey(key), value);
}

// Expose globally for use in other modules
window.getStorage = getStorage;
window.setStorage = setStorage;

// ===== DEBUG MODE =====
// Set to true to see detailed console logs for development/troubleshooting
// Can be toggled in browser console: window.DEBUG_MODE = true
const DEBUG_MODE = false;
window.DEBUG_MODE = DEBUG_MODE;

// Helper to enable debug mode dynamically
if (typeof window !== 'undefined') {
  console.log('[Debug] To enable debug mode, run: window.DEBUG_MODE = true');
}

/**
 * Format number with thousand separators (German notation: dot)
 * Safe alternative to regex /\B(?=(\d{3})+(?!\d))/g that prevents ReDoS attacks.
 *
 * This function replaces the unsafe regex pattern that was flagged by ESLint
 * security/detect-unsafe-regex due to nested quantifiers causing exponential
 * backtracking (ReDoS vulnerability).
 *
 * @param {number|string} value - Number to format
 * @returns {string} Formatted number with commas as thousand separators (e.g., "10,000")
 *
 * @example
 * formatNumberWithSeparator(1000)      // "1,000"
 * formatNumberWithSeparator("10000")   // "10,000"
 * formatNumberWithSeparator(1234567)   // "1,234,567"
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
 * Helper function to build API URLs
 * @param {string} endpoint - API endpoint path (e.g., '/user/get-settings')
 * @returns {string} Full API URL with correct prefix
 */
window.apiUrl = function(endpoint) {
  // Remove leading /api if present (to avoid double prefix)
  const cleanEndpoint = endpoint.replace(/^\/api/, '');
  return `${API_PREFIX}${cleanEndpoint}`;
};

// Import UI dialogs
import {
  showSettings,
  closeSettings,
  showCampaignsOverlay,
  closeCampaignsOverlay,
  buyCampaign,
  showContactList,
  closeContactList,
  showAnchorInfo,
  showConfirmDialog
} from './modules/ui-dialogs.js';

// Import coop management
import {
  showCoopOverlay,
  closeCoopOverlay,
  sendCoopMax
} from './modules/coop.js';

// Import chat functionality
import {
  loadMessages,
  sendMessage,
  handleMessageInput,
  loadAllianceMembers,
  initWebSocket,
  setChatScrollListener,
  markAllianceChatAsRead
} from './modules/chat.js';

// Expose loadMessages and markAllianceChatAsRead to window for alliance chat badge updates
window.loadMessages = loadMessages;
window.markAllianceChatAsRead = markAllianceChatAsRead;

// Import messenger functionality
import {
  openMessenger,
  openNewChat,
  closeMessenger,
  closeChatSelection,
  showAllChats,
  closeAllChats,
  updateUnreadBadge,
  sendPrivateMessage,
  getCurrentPrivateChat,
  deleteCurrentChat
} from './modules/messenger.js';

// Import hijacking functionality
import {
  openHijackingInbox,
  closeHijackingInbox,
  updateHijackingBadge,
  updateHijackedVesselsDisplay
} from './modules/hijacking.js';

// Import bunker management
import {
  updateBunkerStatus,
  buyMaxFuel,
  buyMaxCO2,
  setCapacityFromBunkerUpdate
} from './modules/bunker-management.js';

// Automation moved to backend (server/autopilot.js + server/scheduler.js)

// Import vessel management
import {
  updateVesselCount,
  updateRepairCount,
  departAllVessels,
  openRepairAndDrydockDialog,
  loadAcquirableVessels,
  showPendingVessels,
  showShoppingCart,
  lockDepartButton,
  unlockDepartButton,
  isDepartInProgress
} from './modules/vessel-management.js';

// Import vessel selling functions
import {
  openSellVesselsOverlay,
  closeSellVesselsOverlay,
  setSellFilter,
  showSellCart
} from './modules/vessel-selling.js';

// Import harbor map initialization
import { initHarborMap } from './modules/harbor-map-init.js';

// Import badge manager for centralized badge updates
import { updateBadge, updateButtonState, updateButtonTooltip, updateButtonVisibility } from './modules/badge-manager.js';

// =============================================================================
// Global State and DOM Element References
// =============================================================================

/**
 * Chat feed container element for displaying alliance messages.
 * @type {HTMLElement}
 */
const chatFeed = document.getElementById('chatFeed');

/**
 * Alliance chat message input textarea.
 * @type {HTMLTextAreaElement}
 */
const messageInput = document.getElementById('messageInput');

/**
 * Send button for alliance chat messages.
 * @type {HTMLButtonElement}
 */
const sendMessageBtn = document.getElementById('sendMessageBtn');

/**
 * Character counter display for alliance chat input (500 char limit).
 * @type {HTMLElement}
 */
const charCount = document.getElementById('charCount');

/**
 * Global settings object loaded from server.
 * Contains user preferences for alerts, thresholds, and AutoPilot features.
 * Loaded asynchronously during DOMContentLoaded and synchronized across tabs via WebSocket.
 *
 * @type {Object|null}
 * @property {number} fuelThreshold - Price threshold for fuel alerts ($/ton)
 * @property {number} co2Threshold - Price threshold for CO2 alerts ($/ton)
 * @property {number} maintenanceThreshold - Maintenance % threshold for repair alerts
 * @property {boolean} autoRebuyFuel - Enable automatic fuel purchasing
 * @property {boolean} autoRebuyFuelUseAlert - Use alert threshold for auto-rebuy
 * @property {number} autoRebuyFuelThreshold - Custom threshold for fuel auto-rebuy
 * @property {boolean} autoRebuyCO2 - Enable automatic CO2 purchasing
 * @property {boolean} autoRebuyCO2UseAlert - Use alert threshold for CO2 auto-rebuy
 * @property {number} autoRebuyCO2Threshold - Custom threshold for CO2 auto-rebuy
 * @property {boolean} autoDepartAll - Enable automatic vessel departures
 * @property {boolean} autoBulkRepair - Enable automatic bulk repairs
 * @property {boolean} autoCampaignRenewal - Enable automatic campaign renewal
 * @property {boolean} autoPilotNotifications - Enable AutoPilot action notifications
 * @property {boolean} enableWeatherData - Enable weather data API calls on map
 */
let settings = null; // Will be loaded async on DOMContentLoaded

/**
 * Debouncing timeout storage for preventing excessive API calls.
 * Uses a Map to manage multiple debounce timers efficiently.
 *
 * @type {Map<string, number>}
 */
const debounceTimeouts = new Map();

// =============================================================================
// Badge Caching System
// =============================================================================

/**
 * Updates COOP display in header with proper color coding.
 * Centralized function called from multiple locations.
 *
 * @param {number} cap - Total COOP capacity
 * @param {number} available - Available vessels to send
 */
function updateCoopDisplay(cap, available) {
  const coopDisplay = document.getElementById('coopDisplay');
  const coopContainer = coopDisplay?.parentElement;
  const coopModalBtn = document.querySelector('button[onclick="openCoopModal()"]');
  const coopActionBtn = document.getElementById('coopBtn');

  // Hide if cap === 0 (user not in alliance)
  if (cap === 0) {
    if (coopContainer) coopContainer.classList.add('hidden');
    if (coopModalBtn) coopModalBtn.style.display = 'none';
    if (coopActionBtn) coopActionBtn.style.display = 'none';
    return;
  }

  // Show if it was hidden
  if (coopContainer) coopContainer.classList.remove('hidden');
  if (coopModalBtn) coopModalBtn.style.display = '';
  if (coopActionBtn) coopActionBtn.style.display = '';

  if (coopDisplay) {
    if (available > 0) {
      // Red number with red available count in parentheses
      coopDisplay.innerHTML = `<span class="coop-display-available">${cap} (${available})</span>`;
    } else {
      // Green number without parentheses when all vessels sent
      coopDisplay.innerHTML = `<span class="coop-display-full">${cap}</span>`;
    }
  }
}

/**
 * Load all cached data from localStorage and update UI.
 * Loads: badges, prices, bunker levels, cash, campaigns, stock, COOP, anchor slots, etc.
 * Does NOT load: messages (to prevent flicker), points (always fetched fresh)
 * Called on page load to show last known values until WebSocket sends fresh data.
 */
function loadCache() {
  try {
    // CRITICAL: REFUSE to load cache if user ID not validated
    if (!window.USER_STORAGE_PREFIX) {
      console.log(`[Cache] REFUSE: window.USER_STORAGE_PREFIX not set - cannot validate cache`);
      updateEventData(null);
      return;
    }

    // Validation: CACHE_KEY must be set (no fallbacks!)
    if (!window.CACHE_KEY) {
      console.log(`[Cache] REFUSE: window.CACHE_KEY not set - cannot load cache`);
      updateEventData(null);
      return;
    }

    const cached = localStorage.getItem(window.CACHE_KEY);
    if (!cached) {
      console.log('[Cache] No cached badges found (key: ' + window.CACHE_KEY + ')');
      // Ensure event banner stays hidden when no cache exists
      updateEventData(null);
      return;
    }

    const data = JSON.parse(cached);
    if (window.DEBUG_MODE) {
      console.log('[Cache] Loaded cached badges:', data);
    }

    // Vessel badges and button states
    if (data.vessels) {
      const { readyToDepart, atAnchor, pending } = data.vessels;

      // Ready to depart badge and button
      if (readyToDepart !== undefined) {
        updateBadge('vesselCount', readyToDepart, readyToDepart > 0, 'BLUE');
        // Button state controlled by vessel count on page load
        // Server will send lock_status via WebSocket to update if operation in progress
        updateButtonState('departAll', readyToDepart === 0);
        updateButtonTooltip('departAll',
          readyToDepart > 0
            ? `Depart all ${readyToDepart} vessel${readyToDepart === 1 ? '' : 's'} from harbor`
            : 'No vessels ready to depart'
        );
      }

      // Anchor badge and button
      if (atAnchor !== undefined) {
        updateBadge('anchorCount', atAnchor, atAnchor > 0, 'RED');
        updateButtonTooltip('anchor',
          atAnchor > 0
            ? `${atAnchor} vessel${atAnchor === 1 ? '' : 's'} at anchor - Click to purchase anchor points`
            : 'Purchase anchor points'
        );
      }

      // Pending vessels badge and button
      if (pending !== undefined) {
        updateBadge('pendingVesselsBadge', pending, pending > 0, 'ORANGE');
        updateButtonTooltip('buyVessels', pending > 0 ? `Vessels in delivery: ${pending}` : 'Buy vessels');

        // Update pending filter button in overlay (if exists)
        const pendingBtn = document.getElementById('filterPendingBtn');
        const pendingCountSpan = document.getElementById('pendingCount');
        if (pendingBtn && pendingCountSpan) {
          pendingCountSpan.textContent = pending;
          if (pending > 0) {
            pendingBtn.classList.remove('hidden');
          } else {
            pendingBtn.classList.add('hidden');
          }
        }
      }
    }

    // Repair badge and button state
    if (data.repair) {
      const { count } = data.repair;
      if (count !== undefined) {
        updateBadge('repairCount', count, count > 0, 'RED');
      }
    }

    // Drydock badge
    if (data.drydock) {
      const { count } = data.drydock;
      if (count !== undefined) {
        updateBadge('drydockCount', count, count > 0, 'ORANGE');
      }
    }

    // Update repair button state (enabled if repair OR drydock count > 0)
    if (data.repair || data.drydock) {
      const repairCount = data.repair?.count ?? 0;
      const drydockCount = data.drydock?.count ?? 0;
      const hasRepairOrDrydock = repairCount > 0 || drydockCount > 0;
      updateButtonState('repairAll', !hasRepairOrDrydock);

      let tooltip;
      if (repairCount > 0 && drydockCount > 0) {
        tooltip = `Repair ${repairCount} vessel${repairCount === 1 ? '' : 's'} or drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`;
      } else if (repairCount > 0) {
        tooltip = `Repair ${repairCount} vessel${repairCount === 1 ? '' : 's'} with high wear`;
      } else if (drydockCount > 0) {
        tooltip = `Drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`;
      } else {
        tooltip = 'No vessels need repair or drydock';
      }
      updateButtonTooltip('repairAll', tooltip);
    }

    // Campaigns badge
    if (data.campaigns !== undefined) {
      // Only show badge if < 3 campaigns
      updateBadge('campaignsCount', data.campaigns, data.campaigns < 3, 'RED');

      // Update header display
      const campaignsHeaderDisplay = document.getElementById('campaignsHeaderDisplay');
      if (campaignsHeaderDisplay) {
        campaignsHeaderDisplay.textContent = data.campaigns;
        // Green if <= 3, red if > 3
        if (data.campaigns <= 3) {
          campaignsHeaderDisplay.classList.add('text-success');
          campaignsHeaderDisplay.classList.remove('text-danger');
        } else {
          campaignsHeaderDisplay.classList.add('text-danger');
          campaignsHeaderDisplay.classList.remove('text-success');
        }
      }
    }

    // Messages badge - SKIP loading from cache
    // We always call updateUnreadBadge() immediately after loading,
    // so loading from cache would cause flickering (cache shows 0, then API shows 1)
    // Let updateUnreadBadge() handle the initial display

    // Fuel and CO2 prices
    if (data.prices) {
      const { fuelPrice, co2Price, eventDiscount } = data.prices;

      const fuelPriceDisplay = document.getElementById('fuelPriceDisplay');
      // Only update if we have a valid price (> 0), otherwise keep last known value
      if (fuelPriceDisplay && fuelPrice !== undefined && fuelPrice > 0) {
        // Build price text with optional discount badge
        let priceText = `$${fuelPrice}/t`;
        if (eventDiscount && eventDiscount.type === 'fuel') {
          priceText += ` <span class="discount-badge">-${eventDiscount.percentage}%</span>`;
        }
        fuelPriceDisplay.innerHTML = priceText;

        // Apply forecast color classes
        fuelPriceDisplay.className = ''; // Clear existing classes

        // Check if below alert threshold (pulse animation)
        if (settings && settings.fuelThreshold && fuelPrice < settings.fuelThreshold) {
          fuelPriceDisplay.className = 'price-pulse-alert';
        } else {
          // Apply standard color based on price ranges
          if (fuelPrice >= 800) {
            fuelPriceDisplay.className = 'fuel-red';
          } else if (fuelPrice >= 600) {
            fuelPriceDisplay.className = 'fuel-orange';
          } else if (fuelPrice >= 400) {
            fuelPriceDisplay.className = 'fuel-blue';
          } else if (fuelPrice >= 1) {
            fuelPriceDisplay.className = 'fuel-green';
          }
        }
      }

      const co2PriceDisplay = document.getElementById('co2PriceDisplay');
      // Only update if we have a valid price (> 0), otherwise keep last known value
      if (co2PriceDisplay && co2Price !== undefined && co2Price > 0) {
        // Build price text with optional discount badge
        let priceText = `$${co2Price}/t`;
        if (eventDiscount && eventDiscount.type === 'co2') {
          priceText += ` <span class="discount-badge">-${eventDiscount.percentage}%</span>`;
        }
        co2PriceDisplay.innerHTML = priceText;

        // Apply forecast color classes
        co2PriceDisplay.className = ''; // Clear existing classes

        // Check if below alert threshold (pulse animation)
        if (settings && settings.co2Threshold && co2Price < settings.co2Threshold) {
          co2PriceDisplay.className = 'price-pulse-alert';
        } else {
          // Apply standard color based on price ranges
          if (co2Price >= 20) {
            co2PriceDisplay.className = 'co2-red';
          } else if (co2Price >= 15) {
            co2PriceDisplay.className = 'co2-orange';
          } else if (co2Price >= 10) {
            co2PriceDisplay.className = 'co2-blue';
          } else if (co2Price >= 1) {
            co2PriceDisplay.className = 'co2-green';
          }
        }
      }

      // Update forecast with cached event discount and event data
      const eventData = data.prices.eventData || null;
      if (eventDiscount) {
        updateEventDiscount(eventDiscount, eventData);
      } else {
        updateEventDiscount(null, null);
      }
    }

    // Event data (complete event info with name, ports, etc.)
    if (data.eventData) {
      updateEventData(data.eventData);
    } else {
      updateEventData(null);
    }

    // COOP data (alliance cooperation)
    if (data.coop) {
      const { available, cap } = data.coop;

      // Show COOP container in header
      const coopContainer = document.getElementById('coopContainer');
      if (coopContainer) {
        coopContainer.classList.remove('hidden');
      }

      // Show COOP button in action menu
      const coopBtn = document.getElementById('coopBtn');
      if (coopBtn) {
        coopBtn.style.display = '';
      }
      updateButtonVisibility('coop', true);

      // Show Alliance Chat button in action menu and icon bar
      const allianceChatBtn = document.getElementById('allianceChatBtn');
      if (allianceChatBtn) {
        allianceChatBtn.style.display = '';
      }
      updateButtonVisibility('allianceChat', true);

      // Only show if cap > 0 (user in alliance)
      if (cap > 0) {
        // Update COOP display
        updateCoopDisplay(cap, available);
      }
    }
    // Note: We DON'T hide buttons if no coop data in cache
    // They will be hidden by WebSocket update if user is not in alliance

    // Bunker status
    if (data.bunker) {
      const { fuel, co2, cash, maxFuel, maxCO2 } = data.bunker;

      // Load capacity values from cache if available (only if valid > 0)
      if (maxFuel !== undefined && maxFuel > 0 && maxCO2 !== undefined && maxCO2 > 0) {
        import('./modules/bunker-management.js').then(module => {
          module.setCapacityFromBunkerUpdate(maxFuel, maxCO2);
        });
      }

      // Capacity updates are handled by chat.js to avoid duplicate logs

      const fuelDisplay = document.getElementById('fuelDisplay');
      const fuelFill = document.getElementById('fuelFill');
      const fuelBtn = document.getElementById('fuelBtn');
      if (fuelDisplay && fuel !== undefined && maxFuel !== undefined && (maxFuel > 0 || fuel <= 0)) {
        const maxFuelText = maxFuel > 0 ? Math.floor(maxFuel).toLocaleString('en-US') : '--';
        fuelDisplay.innerHTML = `${Math.floor(fuel).toLocaleString('en-US')} <b>t</b> <b>/</b> ${maxFuelText} <b>t</b>`;


        // Update fill bar and button styling with CSS classes
        if (fuelFill && fuelBtn) {
          const fuelPercent = maxFuel > 0 ? Math.min(100, Math.max(0, (fuel / maxFuel) * 100)) : 0;
          fuelFill.style.width = `${fuelPercent}%`;

          // Determine fill level class based on tank percentage
          let fillClass = '';
          if (fuel <= 0) {
            fillClass = 'fuel-btn-empty';
            fuelFill.style.width = '0%';
            fuelFill.style.background = 'transparent';
          } else if (fuelPercent <= 20) {
            fillClass = 'fuel-btn-low';
            fuelFill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
          } else if (fuelPercent <= 70) {
            fillClass = 'fuel-btn-medium';
            fuelFill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
          } else if (fuelPercent <= 85) {
            fillClass = 'fuel-btn-high';
            fuelFill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
          } else {
            fillClass = 'fuel-btn-full';
            fuelFill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
          }

          // Update fill-level class (controls background/border color and animation)
          // These classes: fuel-btn-empty (red pulse), fuel-btn-low (red), fuel-btn-medium (blue), fuel-btn-high (yellow), fuel-btn-full (green)
          fuelBtn.classList.remove('fuel-btn-empty', 'fuel-btn-low', 'fuel-btn-medium', 'fuel-btn-high', 'fuel-btn-full');
          if (fillClass) fuelBtn.classList.add(fillClass);

          // Update price-color class (controls TEXT color based on market price)
          // These classes are SEPARATE from fill-level - both can coexist
          // Price classes: fuel-red, fuel-orange, fuel-blue, fuel-green (text color only)
          const fuelPrice = data.prices?.fuelPrice || data.prices?.fuel;
          if (fuelPrice !== undefined && fuelPrice > 0) {
            let priceClass = '';
            if (fuelPrice >= 800) {
              priceClass = 'fuel-red';
            } else if (fuelPrice >= 600) {
              priceClass = 'fuel-orange';
            } else if (fuelPrice >= 400) {
              priceClass = 'fuel-blue';
            } else if (fuelPrice >= 1) {
              priceClass = 'fuel-green';
            }

            // Remove ONLY price-color classes (do NOT remove fill-level classes!)
            fuelBtn.classList.remove('fuel-red', 'fuel-orange', 'fuel-blue', 'fuel-green');
            if (priceClass) fuelBtn.classList.add(priceClass);
          }
        }
      }

      const co2Display = document.getElementById('co2Display');
      const co2Fill = document.getElementById('co2Fill');
      const co2Btn = document.getElementById('co2Btn');
      if (co2Display && co2 !== undefined && maxCO2 !== undefined && (maxCO2 > 0 || co2 < 0)) {
        const co2Value = co2 < 0 ? `-${Math.floor(Math.abs(co2)).toLocaleString('en-US')}` : Math.floor(co2).toLocaleString('en-US');
        const maxCO2Text = maxCO2 > 0 ? Math.floor(maxCO2).toLocaleString('en-US') : '--';
        co2Display.innerHTML = `${co2Value} <b>t</b> <b>/</b> ${maxCO2Text} <b>t</b>`;


        // Update fill bar and button styling with CSS classes
        if (co2Fill && co2Btn) {
          const co2Percent = maxCO2 > 0 ? Math.min(100, Math.max(0, (co2 / maxCO2) * 100)) : 0;
          co2Fill.style.width = `${co2Percent}%`;

          // Determine fill level class based on tank percentage
          let fillClass = '';
          if (co2 <= 0) {
            fillClass = 'co2-btn-empty';
            co2Fill.style.width = '0%';
            co2Fill.style.background = 'transparent';
          } else if (co2Percent <= 20) {
            fillClass = 'co2-btn-low';
            co2Fill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
          } else if (co2Percent <= 70) {
            fillClass = 'co2-btn-medium';
            co2Fill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
          } else if (co2Percent <= 85) {
            fillClass = 'co2-btn-high';
            co2Fill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
          } else {
            fillClass = 'co2-btn-full';
            co2Fill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
          }

          // Update fill-level class (controls background/border color and animation)
          // These classes: co2-btn-empty (red pulse), co2-btn-low (red), co2-btn-medium (blue), co2-btn-high (yellow), co2-btn-full (green)
          co2Btn.classList.remove('co2-btn-empty', 'co2-btn-low', 'co2-btn-medium', 'co2-btn-high', 'co2-btn-full');
          if (fillClass) co2Btn.classList.add(fillClass);

          // Update price-color class (controls TEXT color based on market price)
          // These classes are SEPARATE from fill-level - both can coexist
          // Price classes: co2-negative, co2-red, co2-orange, co2-blue, co2-green (text color only)
          const co2Price = data.prices?.co2Price || data.prices?.co2;
          if (co2Price !== undefined && co2Price !== null) {
            let priceClass = '';
            if (co2Price <= 0) {
              priceClass = 'co2-negative';
            } else if (co2Price >= 20) {
              priceClass = 'co2-red';
            } else if (co2Price >= 15) {
              priceClass = 'co2-orange';
            } else if (co2Price >= 10) {
              priceClass = 'co2-blue';
            } else if (co2Price >= 1) {
              priceClass = 'co2-green';
            }

            // Remove ONLY price-color classes (do NOT remove fill-level classes!)
            co2Btn.classList.remove('co2-negative', 'co2-red', 'co2-orange', 'co2-blue', 'co2-green');
            if (priceClass) co2Btn.classList.add(priceClass);
          }
        }
      }

      const cashDisplay = document.getElementById('cashDisplay');
      if (cashDisplay && cash !== undefined) {
        cashDisplay.innerHTML = `$ ${Math.floor(cash).toLocaleString('en-US')}`;
      }

      // Points (Premium Currency) with color coding
      const points = data.bunker.points;
      const pointsDisplay = document.getElementById('pointsDisplay');
      if (pointsDisplay && points !== undefined) {
        pointsDisplay.textContent = points.toLocaleString('en-US');
        // Red if 0, yellow if < 600, green if >= 600
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

    // COOP (only show if user is in an alliance)
    const coopContainer = document.getElementById('coopContainer');
    const coopBtn = document.getElementById('coopBtn');
    if (data.coop) {
      const { available, cap } = data.coop;

      // Show COOP container in header
      if (coopContainer) {
        coopContainer.classList.remove('hidden');
      }

      // Show COOP button in action menu and icon bar
      if (coopBtn) {
        coopBtn.style.display = '';
      }
      updateButtonVisibility('coop', true);

      // Show Alliance Chat button in action menu and icon bar
      const allianceChatBtn = document.getElementById('allianceChatBtn');
      if (allianceChatBtn) {
        allianceChatBtn.style.display = '';
      }
      updateButtonVisibility('allianceChat', true);

      // Update COOP badge using badge-manager (red if available > 0, green if all slots used)
      const color = available === 0 ? 'GREEN' : 'RED';
      updateBadge('coopBadge', available, available > 0, color);
      console.log(`[COOP Badge] Updated via badge-manager: available=${available}, color=${color}`);

      // Update COOP header display
      updateCoopDisplay(cap, available);
    } else {
      // Hide COOP container and button if not in alliance
      if (coopContainer) {
        coopContainer.classList.add('hidden');
      }
      if (coopBtn) {
        coopBtn.style.display = 'none';
      }
      updateButtonVisibility('coop', false);

      // Hide Alliance Chat button if not in alliance
      const allianceChatBtn = document.getElementById('allianceChatBtn');
      if (allianceChatBtn) {
        allianceChatBtn.style.display = 'none';
      }
      updateButtonVisibility('allianceChat', false);
    }

    // Stock & Anchor
    if (data.stock || data.anchor) {
      if (data.stock) {
        const stockDisplay = document.getElementById('stockDisplay');
        const stockTrendElement = document.getElementById('stockTrend');
        const stockContainer = document.getElementById('stockContainer');

        // Only show stock if user has IPO active
        if (data.stock.ipo === 1) {
          if (stockContainer) {
            stockContainer.classList.remove('hidden');
          }
          if (stockDisplay && data.stock.value !== undefined && data.stock.value !== null) {
            stockDisplay.textContent = `$${data.stock.value.toFixed(2)}`;
          }
          if (stockTrendElement && data.stock.trend) {
            if (data.stock.trend === 'up') {
              stockTrendElement.textContent = '↑';
              stockTrendElement.classList.add('text-success');
              stockTrendElement.classList.remove('text-danger', 'text-neutral');
              if (stockDisplay) {
                stockDisplay.classList.add('text-success');
                stockDisplay.classList.remove('text-danger', 'text-neutral');
              }
            } else if (data.stock.trend === 'down') {
              stockTrendElement.textContent = '↓';
              stockTrendElement.classList.add('text-danger');
              stockTrendElement.classList.remove('text-success', 'text-neutral');
              if (stockDisplay) {
                stockDisplay.classList.add('text-danger');
                stockDisplay.classList.remove('text-success', 'text-neutral');
              }
            } else {
              stockTrendElement.textContent = '-';
              stockTrendElement.classList.add('text-neutral');
              stockTrendElement.classList.remove('text-success', 'text-danger');
              if (stockDisplay) {
                stockDisplay.classList.add('text-neutral');
                stockDisplay.classList.remove('text-success', 'text-danger');
              }
            }
          }
        } else {
          // Hide stock container if no IPO
          if (stockContainer) {
            stockContainer.classList.add('hidden');
          }
        }
      }
      if (data.anchor) {
        const anchorDisplay = document.getElementById('anchorSlotsDisplay');
        if (anchorDisplay) {
          // Format: Total 114 ⚓ Free 1 ⚓ Pending 0
          const total = data.anchor.max;
          const free = data.anchor.available;
          const pending = data.anchor.pending || 0;

          // Build display string with labels
          // Total: RED if free > 0 (slots available = bad), GREEN if free = 0 (all slots used = good)
          const totalClass = free > 0 ? 'anchor-total-bad' : 'anchor-total-good';
          let html = `Total <span class="${totalClass}">${total}</span>`;

          // Free slots - only show if > 0, in red
          if (free > 0) {
            html += ` ⚓ Free <span class="anchor-free">${free}</span>`;
          }

          // Pending - only show if > 0, in orange
          if (pending > 0) {
            html += ` ⚓ Pending <span class="anchor-pending">${pending}</span>`;
          }

          anchorDisplay.innerHTML = html;
        }
      }
    }

    // Hijacking badge and button state
    if (data.hijacking !== undefined) {
      const { openCases, hijackedCount } = data.hijacking;

      // Update badge using badge-manager (only shows for OPEN cases)
      updateBadge('hijackingBadge', openCases, openCases > 0, 'RED');

      // Button is always enabled
      const button = document.getElementById('hijackingBtn');
      if (button) {
        button.disabled = false;
      }

      // Update header display
      const hijackedDisplay = document.getElementById('hijackedVesselsDisplay');
      const hijackedCountEl = document.getElementById('hijackedCount');
      const hijackedIcon = document.getElementById('hijackedIcon');

      if (hijackedDisplay && hijackedCountEl && hijackedIcon && hijackedCount !== undefined) {
        if (hijackedCount > 0) {
          hijackedCountEl.textContent = hijackedCount;
          hijackedDisplay.style.display = 'flex';
          hijackedIcon.classList.add('hijacked-glow');
        } else {
          hijackedDisplay.style.display = 'none';
          hijackedIcon.classList.remove('hijacked-glow');
        }
      }
    }

  } catch (error) {
    console.error('[Cache] Failed to load cached badges:', error);
  }
}

/**
 * Saves badge values to localStorage for next page load.
 * Called by WebSocket handlers when new data arrives.
 */
function saveBadgeCache(data) {
  try {
    const cacheKey = window.CACHE_KEY || 'badgeCache';
    const currentCache = localStorage.getItem(cacheKey);
    const cache = currentCache ? JSON.parse(currentCache) : {};

    // Merge new data into cache
    Object.assign(cache, data);

    localStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch (error) {
    console.error('[Cache] Failed to save badge cache:', error);
  }
}

// Make cache and display functions available globally
window.saveBadgeCache = saveBadgeCache;
window.updateCoopDisplay = updateCoopDisplay;

// Make bunker capacity setter available globally for chat.js
window.setCapacityFromBunkerUpdate = setCapacityFromBunkerUpdate;

// =============================================================================
// Debounced Update Functions
// =============================================================================

/**
 * Debounced bunker status update to prevent excessive API calls.
 * Fetches current fuel/CO2 prices and storage levels, updates UI badges,
 * and triggers price alerts if thresholds are met.
 *
 * **Why debouncing?** When settings change rapidly (e.g., user adjusting threshold
 * slider), we want to wait until they're done before making expensive API calls.
 *
 * @function
 * @param {number} [delay=800] - Delay in milliseconds before executing update
 * @example
 * // Called when fuel threshold changes
 * debouncedUpdateBunkerStatus(800);
 */
/**
 * Creates a debounced function that delays executing the given function until
 * after the specified delay has elapsed since the last invocation.
 *
 * @function
 * @param {string} key - Unique identifier for this debounced function's timeout
 * @param {Function} func - The function to debounce
 * @returns {Function} Debounced function that accepts a delay parameter
 * @example
 * const debouncedFn = createDebouncedFunction('myKey', () => console.log('Called'));
 * debouncedFn(500); // Executes after 500ms of inactivity
 */
function createDebouncedFunction(key, func) {
  return function(delay) {
    clearTimeout(debounceTimeouts.get(key));
    debounceTimeouts.set(key, setTimeout(func, delay));
  };
}

const debouncedUpdateBunkerStatus = createDebouncedFunction('bunker', () => updateBunkerStatus(settings));

/**
 * Debounced vessel count update to prevent excessive API calls.
 * Fetches vessels in harbor and updates the "Ready" badge count.
 *
 * @function
 * @param {number} [delay=800] - Delay in milliseconds before executing update
 * @example
 * // Called after vessel departure or purchase
 * debouncedUpdateVesselCount(500);
 */
const debouncedUpdateVesselCount = createDebouncedFunction('vessel', () => updateVesselCount());

/**
 * Debounced unread message badge update.
 * Fetches unread private message counts and updates the messenger badge.
 *
 * @function
 * @param {number} [delay=1000] - Delay in milliseconds before executing update
 * @example
 * // Called after sending/reading messages
 * debouncedUpdateUnreadBadge(1000);
 */
const debouncedUpdateUnreadBadge = createDebouncedFunction('unread', () => updateUnreadBadge());

/**
 * Debounced repair count update to prevent excessive API calls.
 * Fetches vessels needing maintenance based on threshold and updates "Repair" badge.
 *
 * @function
 * @param {number} [delay=800] - Delay in milliseconds before executing update
 * @example
 * // Called when maintenance threshold setting changes
 * debouncedUpdateRepairCount(500);
 */
const debouncedUpdateRepairCount = createDebouncedFunction('repair', () => updateRepairCount(settings));

// =============================================================================
// Global Function Exposure (Cross-Module Access Pattern)
// =============================================================================

/**
 * Expose debounced update functions globally for access by other modules.
 * Modules are ES6 modules with isolated scope, so cross-module communication
 * requires explicit window exposure.
 *
 * @global
 */
window.debouncedUpdateBunkerStatus = debouncedUpdateBunkerStatus;
window.debouncedUpdateVesselCount = debouncedUpdateVesselCount;
window.debouncedUpdateUnreadBadge = debouncedUpdateUnreadBadge;
window.debouncedUpdateRepairCount = debouncedUpdateRepairCount;
window.updateVesselCount = updateVesselCount;
window.lockDepartButton = lockDepartButton;
window.unlockDepartButton = unlockDepartButton;
window.isDepartInProgress = isDepartInProgress;
window.openRepairAndDrydockDialog = openRepairAndDrydockDialog;

/**
 * Expose settings getter for automation module.
 * Allows automation to access current settings without tight coupling.
 *
 * @function
 * @global
 * @returns {Object} Current settings object
 */
window.getSettings = () => settings;

// =============================================================================
// Settings Section Toggle (Collapsable Sections)
// =============================================================================

/**
 * Toggles a collapsable section in the settings modal
 * @param {string} contentId - ID of the content div to toggle
 */
function toggleSection(contentId) {
  const content = document.getElementById(contentId);
  const toggleId = contentId.replace('Content', 'Toggle');
  const toggle = document.getElementById(toggleId);

  if (!content || !toggle) return;

  const isHidden = content.classList.contains('hidden');

  // Toggle display
  if (isHidden) {
    content.classList.remove('hidden');
  } else {
    content.classList.add('hidden');
  }
  toggle.textContent = isHidden ? '➖' : '➕';

  // Save state to per-user localStorage
  const sectionStates = JSON.parse(getStorage('settingsSectionStates') || '{}');
  sectionStates[contentId] = isHidden ? 'open' : 'closed';
  setStorage('settingsSectionStates', JSON.stringify(sectionStates));
}

// Make function globally available
window.toggleSection = toggleSection;

// =============================================================================
// WebSocket Settings Synchronization Handler
// =============================================================================

/**
 * Toggles the disabled state of individual autopilot agent notification checkboxes
 * based on the master AutoPilot Notifications toggle.
 *
 * @function
 * @global
 * @param {boolean} masterEnabled - Whether the master toggle is enabled
 */
function toggleAutoPilotAgentCheckboxes(masterEnabled) {
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
 * **Critical Multi-Client Sync Function:**
 * When a user changes settings in one browser tab/window, the server broadcasts
 * the updated settings to ALL connected clients via WebSocket. This function
 * receives those broadcasts and synchronizes the local UI to match.
 *
 * **What it updates:**
 * - All checkbox states (AutoPilot features)
 * - All threshold input values (fuel, CO2, maintenance)
 * - Visibility of conditional UI elements (auto-rebuy options)
 * - Disabled state of threshold inputs (when "use alert" is checked)
 * - Page title (shows "AutoPilot" indicator when features enabled)
 * - Repair count badge (if maintenance threshold changed)
 *
 * **Important Pattern:**
 * When "Use Alert" checkbox is enabled for auto-rebuy features, the custom
 * threshold input becomes disabled and shows the alert threshold value instead.
 * This prevents conflicting configurations.
 *
 * @function
 * @global
 * @param {Object} newSettings - Updated settings object from server
 * @param {number} newSettings.fuelThreshold - Alert threshold for fuel
 * @param {number} newSettings.co2Threshold - Alert threshold for CO2
 * @param {number} newSettings.maintenanceThreshold - Maintenance % threshold
 * @param {boolean} newSettings.autoRebuyFuel - Auto-rebuy fuel enabled
 * @param {boolean} newSettings.autoRebuyFuelUseAlert - Use alert threshold for fuel rebuy
 * @param {number} newSettings.autoRebuyFuelThreshold - Custom fuel rebuy threshold
 * @param {boolean} newSettings.autoRebuyCO2 - Auto-rebuy CO2 enabled
 * @param {boolean} newSettings.autoRebuyCO2UseAlert - Use alert threshold for CO2 rebuy
 * @param {number} newSettings.autoRebuyCO2Threshold - Custom CO2 rebuy threshold
 * @param {boolean} newSettings.autoDepartAll - Auto-depart vessels enabled
 * @param {boolean} newSettings.autoBulkRepair - Auto-repair vessels enabled
 * @param {boolean} newSettings.autoCampaignRenewal - Auto-renew campaigns enabled
 * @param {boolean} newSettings.autoPilotNotifications - Show AutoPilot notifications
 *
 * @example
 * // Called by WebSocket message handler in chat.js
 * // when server broadcasts: { type: 'settings_update', data: {...} }
 * window.handleSettingsUpdate(data);
 */
window.handleSettingsUpdate = (newSettings) => {
  // Update local settings object
  settings = newSettings;

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
  const fuelThresholdInput = document.getElementById('fuelThreshold');
  const co2ThresholdInput = document.getElementById('co2Threshold');
  const maintenanceThresholdInput = document.getElementById('maintenanceThreshold');
  const autoRebuyFuelCheckbox = document.getElementById('autoRebuyFuel');
  const autoRebuyFuelUseAlertCheckbox = document.getElementById('autoRebuyFuelUseAlert');
  const autoRebuyFuelThresholdInput = document.getElementById('autoRebuyFuelThreshold');
  const autoRebuyCO2Checkbox = document.getElementById('autoRebuyCO2');
  const autoRebuyCO2UseAlertCheckbox = document.getElementById('autoRebuyCO2UseAlert');
  const autoRebuyCO2ThresholdInput = document.getElementById('autoRebuyCO2Threshold');
  const autoDepartAllCheckbox = document.getElementById('autoDepartAll');
  const autoBulkRepairCheckbox = document.getElementById('autoBulkRepair');
  const autoCampaignRenewalCheckbox = document.getElementById('autoCampaignRenewal');
  const autoPilotNotificationsCheckbox = document.getElementById('autoPilotNotifications');
  const autoNegotiateHijackingCheckbox = document.getElementById('autoNegotiateHijacking');

  if (fuelThresholdInput) fuelThresholdInput.value = newSettings.fuelThreshold;
  if (co2ThresholdInput) co2ThresholdInput.value = newSettings.co2Threshold;
  if (maintenanceThresholdInput) maintenanceThresholdInput.value = newSettings.maintenanceThreshold;

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

  // Update individual agent notification checkboxes (InApp + Desktop)
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

  if (autoNegotiateHijackingCheckbox) autoNegotiateHijackingCheckbox.checked = newSettings.autoNegotiateHijacking;

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

  // Update Chat Bot settings
  const enableChatBotCheckbox = document.getElementById('enableChatBot');
  if (enableChatBotCheckbox) {
    enableChatBotCheckbox.checked = newSettings.chatbotEnabled || false;
    // Enable/disable other chat bot settings based on main toggle
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
  if (commandPrefixInput && newSettings.chatbotPrefix !== undefined) commandPrefixInput.value = newSettings.chatbotPrefix;

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
  if (dailyForecastTimeInput && newSettings.chatbotDailyForecastTime !== undefined) dailyForecastTimeInput.value = newSettings.chatbotDailyForecastTime;

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

  const enableDMCommandsCheckbox = document.getElementById('enableDMCommands');
  if (enableDMCommandsCheckbox) {
    enableDMCommandsCheckbox.checked = newSettings.chatbotDMCommandsEnabled || false;
    // Note: Delete DM checkbox doesn't exist in current HTML
  }

  // Update page title (AutoPilot mode)
  updatePageTitle(settings);

  // Update repair count if maintenance threshold changed
  debouncedUpdateRepairCount(500);
};

// =============================================================================
// Test Notification Function
// =============================================================================

/**
 * Tests browser notification system with a sample price alert.
 * Triggered by "Test Alert" button in settings dialog.
 *
 * **What it does:**
 * 1. Checks notification permission status
 * 2. Sends a browser notification with current threshold values
 * 3. Shows an in-page alert overlay with the same information
 * 4. If notification fails, displays detailed error information
 *
 * **Use case:** Allows users to verify notifications work before relying on
 * AutoPilot price alerts. Shows permission status, secure context, and protocol
 * information for troubleshooting.
 *
 * @async
 * @function
 * @returns {Promise<void>}
 *
 * @example
 * // Called from settings dialog test button
 * await testBrowserNotification();
 */
async function testBrowserNotification() {
  const hasPermission = await requestNotificationPermission();

  if (!hasPermission) {
    showSideNotification('Please enable notifications first!', 'error');
    return;
  }

  try {
    await showNotification('🔔 Test Price Alert', {
      body: `

Test Alert!

Fuel threshold: $${settings.fuelThreshold}/ton
CO2 threshold: $${settings.co2Threshold}/ton`,
      icon: '/favicon.ico',
      tag: 'test-alert',
      silent: false
    });

    showSideNotification(`⚠️ <strong>Test Alert</strong><br><br>⛽ Fuel threshold: $${settings.fuelThreshold}/ton<br>💨 CO2 threshold: $${settings.co2Threshold}/ton`, 'warning', null, true);
  } catch (error) {
    console.error('[Test Alert] Notification error:', error);
    showSideNotification(`🔔 <strong>Failed to send notification</strong><br><br>Error: ${error.message}<br>Permission: ${Notification.permission}<br>Secure: ${window.isSecureContext ? 'Yes' : 'No'}<br>Protocol: ${window.location.protocol}`, 'error', null, true);
  }
}

// =============================================================================
// Window-Exposed Functions for HTML onclick Handlers
// =============================================================================

/**
 * Wrapper for campaign purchase that exposes the function to HTML onclick handlers.
 * HTML elements cannot directly call module-scoped functions, so this exposes
 * the functionality globally via window object.
 *
 * **Why needed:**
 * Campaign buttons in the overlay are dynamically generated with inline onclick
 * handlers that need access to this function. Alternative would be event delegation,
 * but inline handlers are simpler for dynamic content.
 *
 * @function
 * @global
 * @param {number} campaignId - Unique identifier for the campaign
 * @param {string} typeName - Campaign type name (e.g., "Premium Transport", "Luxury Cargo")
 * @param {number} duration - Campaign duration in days
 * @param {number} price - Campaign cost in game currency
 *
 * @example
 * // Called from dynamically generated HTML button
 * <button onclick="window.buyCampaign(123, 'Premium Transport', 30, 50000)">
 *   Buy Campaign
 * </button>
 */
window.buyCampaign = (campaignId, typeName, duration, price) => {
  buyCampaign(campaignId, typeName, duration, price, {
    updateBunkerStatus: () => debouncedUpdateBunkerStatus(500)
  });
};

/**
 * Global wrapper for sendCoopMax function.
 * Allows HTML onclick handlers to call the coop send function.
 *
 * @global
 * @param {number} userId - Target user ID to send coop vessels to
 */
window.sendCoopMax = (userId) => {
  sendCoopMax(userId);
};

/**
 * Exposes messenger opening function for chat message user interactions.
 * Allows clicking on usernames in chat to open private message conversation.
 *
 * @function
 * @global
 */
window.openMessengerFromChat = openMessenger;

/**
 * Exposes new chat opening function for contact list interactions.
 * Allows clicking on contacts to start new private conversations.
 *
 * @function
 * @global
 */
window.openNewChatFromContact = openNewChat;

/**
 * Exposes hijacking badge update function for WebSocket updates.
 * Updates the Blackbeard's Phone Booth button badge.
 *
 * @function
 * @global
 */
window.updateHijackingBadge = updateHijackingBadge;

/**
 * Exposes hijacked vessels display update function for WebSocket updates.
 * Updates the header pirate emoji with hijacked vessel count.
 *
 * @function
 * @global
 */
window.updateHijackedVesselsDisplay = updateHijackedVesselsDisplay;

/**
 * Expose functions for map icon bar to call directly
 * These are used by map-icon-bar.js to handle icon clicks
 * @global
 */
window.departAllVessels = departAllVessels;
window.showAnchorInfo = showAnchorInfo;
window.showAllChats = showAllChats;
window.openHijackingInbox = openHijackingInbox;
window.showContactList = showContactList;
window.showCampaignsOverlay = showCampaignsOverlay;
window.showCoopOverlay = showCoopOverlay;
window.openSellVesselsOverlay = openSellVesselsOverlay;
window.showSettings = showSettings;

/**
 * Wrapper function for logbook overlay (icon bar action)
 */
window.showLogbookOverlay = function() {
  // Call openLogbook function exposed by logbook module
  if (window.openLogbook) {
    window.openLogbook();
  }
};

// =============================================================================
// DOMContentLoaded - Main Application Initialization
// =============================================================================

/**
 * Main application initialization handler.
 * Executes when DOM is fully loaded and ready for manipulation.
 *
 * **Initialization Sequence (Order is Critical):**
 *
 * 1. **Load Settings** - MUST happen first as other modules depend on settings state
 * 2. **Register Service Worker** - Enables background notifications on mobile devices
 * 3. **Initialize Tooltips** - Sets up custom tooltip behavior for all [data-tooltip] elements
 * 4. **Attach Event Listeners** - Binds 60+ UI interactions (buttons, inputs, checkboxes)
 * 5. **Load Initial Data** - Fetches alliance members, messages, vessels, bunker status
 *    - Uses 500ms delays between calls to prevent API socket hang-ups (server limitation)
 * 6. **Initialize WebSocket** - Establishes real-time chat and settings sync connection
 * 7. **Initialize Automation** - Starts AutoPilot monitoring system
 * 8. **Update Page Title** - Sets title based on AutoPilot status
 * 9. **Start Auto-Refresh Intervals** - Sets up periodic data updates with randomization
 *
 * **Event Listener Categories:**
 * - Alliance chat (send message, input handling, Enter key)
 * - Private messenger (open, close, send, delete chat)
 * - Chat selection overlay (navigation between chats)
 * - Contact list (open, close, select contact)
 * - Settings dialog (open, close, test alerts)
 * - Vessel catalog (open, close, filter, purchase)
 * - Settings thresholds (fuel, CO2, maintenance)
 * - AutoPilot checkboxes (auto-rebuy, auto-depart, auto-repair, auto-renew)
 * - Auto-rebuy options (use alert threshold vs custom threshold)
 * - Vessel management (depart all, repair all, anchor info)
 * - Bunker management (buy fuel, buy CO2)
 * - Notification permission (request, auto-request on load)
 *
 * **Auto-Refresh Intervals (Anti-Detection Pattern):**
 * Uses randomized intervals to avoid perfectly timed API calls that could
 * trigger server-side bot detection:
 * - Chat messages: 25-27 seconds (25000 + random 2000ms)
 * - Unread badges: 30-35 seconds (30000 + random 5000ms)
 * - Vessel counts: 60-70 seconds (60000 + random 10000ms)
 * - Repair counts: 60-70 seconds (60000 + random 10000ms)
 * - Bunker status: 30-35 seconds (30000 + random 5000ms)
 * - Campaign status: 60-70 seconds (60000 + random 10000ms)
 *
 * **Settings Synchronization Pattern:**
 * When settings change:
 * 1. Update local `settings` object
 * 2. Call `saveSettings()` to persist to server via POST /api/settings/save
 * 3. Server broadcasts update to ALL connected WebSocket clients
 * 4. Other clients receive update and call `handleSettingsUpdate()`
 * 5. All tabs/devices stay in sync automatically
 *
 * **Auto-Rebuy Threshold Logic:**
 * - "Use Alert Threshold" checkbox enables/disables custom threshold input
 * - When checked: input shows alert threshold value and becomes disabled
 * - When unchecked: input becomes editable for custom threshold
 * - This prevents conflicting configurations (e.g., alert at $400 but rebuy at $500)
 *
 * @event DOMContentLoaded
 * @async
 * @listens DOMContentLoaded
 */
document.addEventListener('DOMContentLoaded', async () => {
  // ===== STEP 1: Load Settings =====
  // CRITICAL: Must happen first as other modules depend on settings state
  settings = await loadSettings();

  // Expose settings globally for modules that need access (e.g., map-icon-bar, vessel-panel)
  window.settings = settings;

  // Set global DEBUG_MODE from server settings (controlled by systray Debug Mode toggle)
  if (settings.debugMode !== undefined) {
    window.DEBUG_MODE = settings.debugMode;
    if (window.DEBUG_MODE) {
      console.log('[Debug] Debug Mode ENABLED - verbose logging active');
    }
  }

  // Update UI with loaded settings (must happen after DOM is ready)
  // This ensures all checkboxes reflect the loaded settings state
  window.handleSettingsUpdate(settings);

  // CRITICAL: Set per-user storage prefix IMMEDIATELY before any cache access
  if (settings.userId) {
    // Set prefix and keys based on current userId
    window.USER_STORAGE_PREFIX = settings.userId;
    window.CACHE_KEY = `badgeCache_${settings.userId}`;

    if (window.DEBUG_MODE) {
      console.log(`[Storage] Per-user storage initialized for userId: ${settings.userId}`);
      console.log(`[Cache] Using per-user cache key: ${window.CACHE_KEY}`);
    }
  }

  // Initialize ALL UI elements with loaded settings
  // NO DEFAULTS - if settings missing, server returns defaults from GET /api/settings
  // Thresholds
  if (document.getElementById('fuelThreshold')) {
    const value = String(settings.fuelThreshold);
    document.getElementById('fuelThreshold').value = formatNumberWithSeparator(value);
  }
  if (document.getElementById('co2Threshold')) {
    const value = String(settings.co2Threshold);
    document.getElementById('co2Threshold').value = formatNumberWithSeparator(value);
  }
  if (document.getElementById('maintenanceThreshold')) document.getElementById('maintenanceThreshold').value = settings.maintenanceThreshold;

  // Auto-Rebuy Fuel
  if (document.getElementById('autoRebuyFuel')) {
    document.getElementById('autoRebuyFuel').checked = settings.autoRebuyFuel;
    const autoRebuyFuelOptions = document.getElementById('autoRebuyFuelOptions');
    if (autoRebuyFuelOptions) {
      autoRebuyFuelOptions.classList.toggle('hidden', !settings.autoRebuyFuel);
    }
    const autoRebuyFuelMinCashSection = document.getElementById('autoRebuyFuelMinCashSection');
    if (autoRebuyFuelMinCashSection) {
      autoRebuyFuelMinCashSection.classList.toggle('hidden', !settings.autoRebuyFuel);
    }
  }
  if (document.getElementById('autoRebuyFuelUseAlert')) document.getElementById('autoRebuyFuelUseAlert').checked = settings.autoRebuyFuelUseAlert;
  if (document.getElementById('autoRebuyFuelThreshold')) {
    const value = String(settings.autoRebuyFuelThreshold);
    document.getElementById('autoRebuyFuelThreshold').value = formatNumberWithSeparator(value);
  }
  if (document.getElementById('autoRebuyFuelMinCash') && settings.autoRebuyFuelMinCash !== undefined) {
    const value = String(settings.autoRebuyFuelMinCash);
    document.getElementById('autoRebuyFuelMinCash').value = formatNumberWithSeparator(value);
  }

  // Auto-Rebuy CO2
  if (document.getElementById('autoRebuyCO2')) {
    document.getElementById('autoRebuyCO2').checked = settings.autoRebuyCO2;
    const autoRebuyCO2Options = document.getElementById('autoRebuyCO2Options');
    if (autoRebuyCO2Options) {
      autoRebuyCO2Options.classList.toggle('hidden', !settings.autoRebuyCO2);
    }
    const autoRebuyCO2MinCashSection = document.getElementById('autoRebuyCO2MinCashSection');
    if (autoRebuyCO2MinCashSection) {
      autoRebuyCO2MinCashSection.classList.toggle('hidden', !settings.autoRebuyCO2);
    }
  }
  if (document.getElementById('autoRebuyCO2UseAlert')) document.getElementById('autoRebuyCO2UseAlert').checked = settings.autoRebuyCO2UseAlert;
  if (document.getElementById('autoRebuyCO2Threshold')) {
    const value = String(settings.autoRebuyCO2Threshold);
    document.getElementById('autoRebuyCO2Threshold').value = formatNumberWithSeparator(value);
  }
  if (document.getElementById('autoRebuyCO2MinCash') && settings.autoRebuyCO2MinCash !== undefined) {
    const value = String(settings.autoRebuyCO2MinCash);
    document.getElementById('autoRebuyCO2MinCash').value = formatNumberWithSeparator(value);
  }

  // Auto-Depart
  if (document.getElementById('autoDepartAll')) {
    document.getElementById('autoDepartAll').checked = settings.autoDepartAll;
    const autoDepartOptions = document.getElementById('autoDepartOptions');
    if (autoDepartOptions) {
      autoDepartOptions.classList.toggle('hidden', !settings.autoDepartAll);
    }
  }
  if (document.getElementById('autoDepartUseRouteDefaults')) {
    document.getElementById('autoDepartUseRouteDefaults').checked = settings.autoDepartUseRouteDefaults;
    const autoDepartCustomSettings = document.getElementById('autoDepartCustomSettings');
    if (autoDepartCustomSettings) {
      autoDepartCustomSettings.classList.toggle('hidden', settings.autoDepartUseRouteDefaults);
    }
  }
  if (document.getElementById('minFuelThreshold')) {
    const value = String(settings.minFuelThreshold);
    document.getElementById('minFuelThreshold').value = formatNumberWithSeparator(value);
  }
  // Min cargo utilization (now in General Settings)
  if (document.getElementById('minCargoUtilization')) {
    document.getElementById('minCargoUtilization').value = settings.minCargoUtilization || '';
  }
  // Harbor fee warning threshold (now in General Settings)
  if (document.getElementById('harborFeeWarningThreshold')) {
    document.getElementById('harborFeeWarningThreshold').value = settings.harborFeeWarningThreshold || '';
  }
  // Drydock threshold (in General Settings)
  if (document.getElementById('autoDrydockThreshold')) {
    document.getElementById('autoDrydockThreshold').value = settings.autoDrydockThreshold || 150;
  }
  if (document.getElementById('autoVesselSpeed')) document.getElementById('autoVesselSpeed').value = settings.autoVesselSpeed;

  // Auto-Repair
  if (document.getElementById('autoBulkRepair')) {
    document.getElementById('autoBulkRepair').checked = settings.autoBulkRepair;
    const autoBulkRepairOptions = document.getElementById('autoBulkRepairOptions');
    if (autoBulkRepairOptions) {
      autoBulkRepairOptions.classList.toggle('hidden', !settings.autoBulkRepair);
    }
  }
  if (document.getElementById('autoBulkRepairMinCash') && settings.autoBulkRepairMinCash !== undefined) {
    const value = String(settings.autoBulkRepairMinCash);
    document.getElementById('autoBulkRepairMinCash').value = formatNumberWithSeparator(value);
  }

  // Auto-Drydock
  if (document.getElementById('autoDrydock')) {
    document.getElementById('autoDrydock').checked = settings.autoDrydock;
    const autoDrydockOptions = document.getElementById('autoDrydockOptions');
    if (autoDrydockOptions) {
      autoDrydockOptions.classList.toggle('hidden', !settings.autoDrydock);
    }
  }
  if (document.getElementById('autoDrydockType')) {
    document.getElementById('autoDrydockType').value = settings.autoDrydockType || 'major';
  }
  if (document.getElementById('autoDrydockSpeed')) {
    document.getElementById('autoDrydockSpeed').value = settings.autoDrydockSpeed || 'minimum';
  }
  if (document.getElementById('autoDrydockMinCash') && settings.autoDrydockMinCash !== undefined) {
    const value = String(settings.autoDrydockMinCash);
    document.getElementById('autoDrydockMinCash').value = formatNumberWithSeparator(value);
  }

  // Auto-Campaign
  if (document.getElementById('autoCampaignRenewal')) {
    document.getElementById('autoCampaignRenewal').checked = settings.autoCampaignRenewal;
    const autoCampaignRenewalOptions = document.getElementById('autoCampaignRenewalOptions');
    if (autoCampaignRenewalOptions) {
      autoCampaignRenewalOptions.classList.toggle('hidden', !settings.autoCampaignRenewal);
    }
  }
  if (document.getElementById('autoCampaignRenewalMinCash') && settings.autoCampaignRenewalMinCash !== undefined) {
    const value = String(settings.autoCampaignRenewalMinCash);
    document.getElementById('autoCampaignRenewalMinCash').value = formatNumberWithSeparator(value);
  }

  // Auto-COOP
  if (document.getElementById('autoCoopEnabled')) {
    document.getElementById('autoCoopEnabled').checked = settings.autoCoopEnabled;
    const autoCoopOptions = document.getElementById('autoCoopOptions');
    if (autoCoopOptions) {
      autoCoopOptions.classList.toggle('hidden', !settings.autoCoopEnabled);
    }
  }

  // Auto-Anchor Points
  if (document.getElementById('autoAnchorPointEnabled')) {
    document.getElementById('autoAnchorPointEnabled').checked = settings.autoAnchorPointEnabled;
    const autoAnchorPointOptions = document.getElementById('autoAnchorPointOptions');
    if (autoAnchorPointOptions) {
      autoAnchorPointOptions.classList.toggle('hidden', !settings.autoAnchorPointEnabled);
    }
  }
  // Auto-Anchor Point Min Cash
  if (document.getElementById('autoAnchorPointMinCash') && settings.autoAnchorPointMinCash !== undefined) {
    const value = String(settings.autoAnchorPointMinCash);
    document.getElementById('autoAnchorPointMinCash').value = formatNumberWithSeparator(value);
  }
  // Auto-Anchor Point Amount (radio buttons)
  if (document.getElementById('autoAnchorAmount1') && document.getElementById('autoAnchorAmount10')) {
    if (settings.autoAnchorPointAmount === 10) {
      document.getElementById('autoAnchorAmount10').checked = true;
    } else {
      document.getElementById('autoAnchorAmount1').checked = true;
    }
  }

  // Auto-Negotiate Hijacking
  if (document.getElementById('autoNegotiateHijacking')) {
    document.getElementById('autoNegotiateHijacking').checked = settings.autoNegotiateHijacking;
    const autoNegotiateOptions = document.getElementById('autoNegotiateOptions');
    if (autoNegotiateOptions) {
      autoNegotiateOptions.classList.toggle('hidden', !settings.autoNegotiateHijacking);
    }
  }

  // Desktop Notifications
  if (document.getElementById('enableDesktopNotifications')) document.getElementById('enableDesktopNotifications').checked = settings.enableDesktopNotifications;

  // AutoPilot Notifications
  if (document.getElementById('autoPilotNotifications')) {
    // Use the value from settings, default to true if undefined
    const notifValue = settings.autoPilotNotifications !== undefined ? settings.autoPilotNotifications : true;
    document.getElementById('autoPilotNotifications').checked = notifValue;
  }

  // Individual Agent Notifications
  // Individual Agent Notifications (InApp + Desktop)
  if (document.getElementById('notifyBarrelBossInApp')) document.getElementById('notifyBarrelBossInApp').checked = settings.notifyBarrelBossInApp !== false;
  if (document.getElementById('notifyBarrelBossDesktop')) document.getElementById('notifyBarrelBossDesktop').checked = settings.notifyBarrelBossDesktop !== false;
  if (document.getElementById('notifyAtmosphereBrokerInApp')) document.getElementById('notifyAtmosphereBrokerInApp').checked = settings.notifyAtmosphereBrokerInApp !== false;
  if (document.getElementById('notifyAtmosphereBrokerDesktop')) document.getElementById('notifyAtmosphereBrokerDesktop').checked = settings.notifyAtmosphereBrokerDesktop !== false;
  if (document.getElementById('notifyCargoMarshalInApp')) document.getElementById('notifyCargoMarshalInApp').checked = settings.notifyCargoMarshalInApp !== false;
  if (document.getElementById('notifyCargoMarshalDesktop')) document.getElementById('notifyCargoMarshalDesktop').checked = settings.notifyCargoMarshalDesktop !== false;
  if (document.getElementById('notifyYardForemanInApp')) document.getElementById('notifyYardForemanInApp').checked = settings.notifyYardForemanInApp !== false;
  if (document.getElementById('notifyYardForemanDesktop')) document.getElementById('notifyYardForemanDesktop').checked = settings.notifyYardForemanDesktop !== false;
  if (document.getElementById('notifyDrydockMasterInApp')) document.getElementById('notifyDrydockMasterInApp').checked = settings.notifyDrydockMasterInApp !== false;
  if (document.getElementById('notifyDrydockMasterDesktop')) document.getElementById('notifyDrydockMasterDesktop').checked = settings.notifyDrydockMasterDesktop !== false;
  if (document.getElementById('notifyReputationChiefInApp')) document.getElementById('notifyReputationChiefInApp').checked = settings.notifyReputationChiefInApp !== false;
  if (document.getElementById('notifyReputationChiefDesktop')) document.getElementById('notifyReputationChiefDesktop').checked = settings.notifyReputationChiefDesktop !== false;
  if (document.getElementById('notifyFairHandInApp')) document.getElementById('notifyFairHandInApp').checked = settings.notifyFairHandInApp !== false;
  if (document.getElementById('notifyFairHandDesktop')) document.getElementById('notifyFairHandDesktop').checked = settings.notifyFairHandDesktop !== false;
  if (document.getElementById('notifyHarbormasterInApp')) document.getElementById('notifyHarbormasterInApp').checked = settings.notifyHarbormasterInApp !== false;
  if (document.getElementById('notifyHarbormasterDesktop')) document.getElementById('notifyHarbormasterDesktop').checked = settings.notifyHarbormasterDesktop !== false;
  if (document.getElementById('notifyCaptainBlackbeardInApp')) document.getElementById('notifyCaptainBlackbeardInApp').checked = settings.notifyCaptainBlackbeardInApp !== false;
  if (document.getElementById('notifyCaptainBlackbeardDesktop')) document.getElementById('notifyCaptainBlackbeardDesktop').checked = settings.notifyCaptainBlackbeardDesktop !== false;

  // Inbox Notifications
  if (document.getElementById('enableInboxNotifications')) document.getElementById('enableInboxNotifications').checked = settings.enableInboxNotifications !== false; // Default to true

  // Chat Bot Settings
  if (document.getElementById('enableChatBot')) {
    document.getElementById('enableChatBot').checked = settings.chatbotEnabled || false;
    // Enable/disable other chat bot settings based on main toggle
    const isEnabled = settings.chatbotEnabled || false;
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
  if (document.getElementById('commandPrefix') && settings.chatbotPrefix !== undefined) document.getElementById('commandPrefix').value = settings.chatbotPrefix;
  if (document.getElementById('enableDailyForecast')) {
    document.getElementById('enableDailyForecast').checked = settings.chatbotDailyForecastEnabled || false;
    const dailyForecastTime = document.getElementById('dailyForecastTime');
    if (dailyForecastTime) {
      dailyForecastTime.disabled = !settings.chatbotDailyForecastEnabled;
      if (settings.chatbotDailyForecastEnabled) {
        dailyForecastTime.closest('div').classList.remove('checkbox-container-disabled');
        dailyForecastTime.closest('div').classList.add('checkbox-container-enabled');
      } else {
        dailyForecastTime.closest('div').classList.remove('checkbox-container-enabled');
        dailyForecastTime.closest('div').classList.add('checkbox-container-disabled');
      }
    }
  }
  if (document.getElementById('dailyForecastEnabled')) document.getElementById('dailyForecastEnabled').checked = settings.chatbotDailyForecastEnabled || false;
  if (document.getElementById('dailyForecastTime') && settings.chatbotDailyForecastTime !== undefined) document.getElementById('dailyForecastTime').value = settings.chatbotDailyForecastTime;
  if (document.getElementById('enableAllianceCommands')) {
    document.getElementById('enableAllianceCommands').checked = settings.chatbotAllianceCommandsEnabled !== false; // Default to true
    const isAllianceEnabled = settings.chatbotAllianceCommandsEnabled !== false;
    if (document.getElementById('cmdForecast')) document.getElementById('cmdForecast').disabled = !isAllianceEnabled;
    if (document.getElementById('cmdHelp')) document.getElementById('cmdHelp').disabled = !isAllianceEnabled;
  }
  if (document.getElementById('cmdForecast')) {
    document.getElementById('cmdForecast').checked = settings.chatbotForecastCommandEnabled !== false; // Default to true
    // Set channel checkboxes
    if (document.getElementById('cmdForecastAlliance')) {
      document.getElementById('cmdForecastAlliance').checked = settings.chatbotForecastAlliaseEnabled !== false;
      document.getElementById('cmdForecastAlliance').disabled = !settings.chatbotForecastCommandEnabled;
    }
    if (document.getElementById('cmdForecastDM')) {
      document.getElementById('cmdForecastDM').checked = settings.chatbotForecastDMEnabled !== false;
      document.getElementById('cmdForecastDM').disabled = !settings.chatbotForecastCommandEnabled;
    }
    // Load aliases
    if (document.getElementById('cmdForecastAliases')) {
      const aliases = settings.chatbotForecastAliases || ['prices', 'price'];
      document.getElementById('cmdForecastAliases').value = aliases.join(', ');
    }
  }
  if (document.getElementById('cmdHelp')) {
    document.getElementById('cmdHelp').checked = settings.chatbotHelpCommandEnabled !== false; // Default to true
    // Set channel checkboxes
    if (document.getElementById('cmdHelpAlliance')) {
      document.getElementById('cmdHelpAlliance').checked = settings.chatbotHelpAllianceEnabled !== false;
      document.getElementById('cmdHelpAlliance').disabled = !settings.chatbotHelpCommandEnabled;
    }
    if (document.getElementById('cmdHelpDM')) {
      document.getElementById('cmdHelpDM').checked = settings.chatbotHelpDMEnabled === true; // Default to false
      document.getElementById('cmdHelpDM').disabled = !settings.chatbotHelpCommandEnabled;
    }
    // Load aliases
    if (document.getElementById('cmdHelpAliases')) {
      const aliases = settings.chatbotHelpAliases || ['commands', 'help'];
      document.getElementById('cmdHelpAliases').value = aliases.join(', ');
    }
  }
  if (document.getElementById('enableDMCommands')) {
    document.getElementById('enableDMCommands').checked = settings.chatbotDMCommandsEnabled || false;
    // Note: Delete DM checkbox doesn't exist in current HTML
  }

  // ===== STEP 1.5: Load User Settings (CEO Level & Points) =====
  try {
    const userResponse = await fetch(apiUrl('/api/user/get-settings'));
    if (userResponse.ok) {
      const userData = await userResponse.json();

      // CEO Level - NO FALLBACK! If missing, throw error for debugging
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

      // Calculate XP progress to show fill progress
      try {
        // Use userData we already fetched - NO FALLBACKS! Fail fast if data missing
        const expPoints = userData.user?.experience_points || userData.data?.settings?.experience_points;
        const currentLevelExp = userData.user?.current_level_experience_points || userData.data?.settings?.current_level_experience_points;
        const levelupExp = userData.user?.levelup_experience_points || userData.data?.settings?.levelup_experience_points;

        if (expPoints === undefined || currentLevelExp === undefined || levelupExp === undefined) {
          throw new Error('XP data missing from API response');
        }

        // Calculate progress within current level (not total XP)
        // Progress = (current XP - XP at level start) / (XP needed for next level - XP at level start)
        const expInCurrentLevel = expPoints - currentLevelExp;
        const expNeededForLevel = levelupExp - currentLevelExp;
        const progress = Math.min(100, Math.max(0, (expInCurrentLevel / expNeededForLevel) * 100));

        console.log(`[CEO Level Progress] Current: ${expPoints}, Level Start: ${currentLevelExp}, Next Level: ${levelupExp}, Progress: ${progress.toFixed(1)}%`);

        // Update fill bar (SVG rect grows from left to right)
        const ceoLevelFill = document.getElementById('ceoLevelFill');
        if (ceoLevelFill) {
          // SVG rect width is in viewBox units (0-24), scale percentage to 24
          const widthInViewBox = (progress / 100) * 24;
          ceoLevelFill.setAttribute('width', widthInViewBox);
        }
      } catch (error) {
        console.error('Failed to calculate XP progress:', error);
      }

      // Points (Premium Currency) with color coding
      const points = userData.user?.points || 0;
      const pointsDisplay = document.getElementById('pointsDisplay');
      if (pointsDisplay) {
        pointsDisplay.textContent = points.toLocaleString('en-US');
        // Red if 0, yellow if < 600, green if >= 600
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

  // ===== STEP 2: Register Service Worker =====
  // Enables background notifications on mobile devices
  await registerServiceWorker();

  // ===== STEP 3: Initialize Custom Tooltips =====
  initCustomTooltips();

  // ===== STEP 4: Attach Event Listeners =====

  // --- Alliance Chat Event Listeners ---
  // Send message button click
  sendMessageBtn.addEventListener('click', () => sendMessage(messageInput, charCount, sendMessageBtn, chatFeed));

  // Chat input character counter
  messageInput.addEventListener('input', () => handleMessageInput(messageInput, charCount));

  // Enter key to send message (Shift+Enter for new line)
  // Prevents sending when member suggestion dropdown is open (@ mentions)
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const suggestionBox = document.getElementById('memberSuggestions');

      // If autocomplete dropdown is visible, select first suggestion instead of sending
      if (suggestionBox && !suggestionBox.classList.contains('hidden')) {
        e.preventDefault();
        const firstSuggestion = suggestionBox.querySelector('.member-suggestion');
        if (firstSuggestion) {
          firstSuggestion.click();
        }
        return;
      }

      // Otherwise send message
      e.preventDefault();
      sendMessage(messageInput, charCount, sendMessageBtn, chatFeed);
    }
  });

  // Chat scroll detection for "load more" functionality
  setChatScrollListener(chatFeed);

  // --- Private Messenger Event Listeners ---
  // Close messenger overlay
  document.getElementById('closeMessengerBtn').addEventListener('click', closeMessenger);

  // Delete current private chat conversation
  document.getElementById('deleteChatBtn').addEventListener('click', deleteCurrentChat);

  // --- Hijacking Inbox Event Listeners ---
  // Hijacking button is now on map icon bar (calls window.openHijackingInbox)

  // Close hijacking inbox overlay
  document.getElementById('closeHijackingBtn').addEventListener('click', closeHijackingInbox);

  // Back button: closes current chat view and reopens recipient selection
  document.getElementById('backToSelectionBtn').addEventListener('click', () => {
    // Check if we came from hijacking inbox
    if (window.cameFromHijackingInbox) {
      window.cameFromHijackingInbox = false;
      closeMessenger();
      openHijackingInbox();
      return;
    }

    // Normal behavior: go back to chat selection
    const currentChat = getCurrentPrivateChat();
    const targetCompanyName = currentChat.targetCompanyName;
    const targetUserId = currentChat.targetUserId;
    closeMessenger();
    openMessenger(targetCompanyName, targetUserId);
  });

  // Send private message button
  document.getElementById('sendPrivateMessageBtn').addEventListener('click', sendPrivateMessage);

  // Enter key to send private message (Shift+Enter for new line)
  document.getElementById('messengerInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrivateMessage();
    }
  });

  // --- Chat Selection Overlay Event Listeners ---
  // Back button in chat selection (returns to all chats overview)
  document.getElementById('backToAllChatsBtn').addEventListener('click', () => {
    closeChatSelection();
    showAllChats();
  });

  // Close chat selection overlay
  document.getElementById('closeChatSelectionBtn').addEventListener('click', closeChatSelection);

  // --- All Chats Overview Event Listeners ---
  // All chats button is now on map icon bar (calls window.showAllChats)

  // Close all chats list
  document.getElementById('closeAllChatsBtn').addEventListener('click', closeAllChats);

  // --- Contact List Event Listeners ---
  // Contact list button is now on map icon bar (calls window.showContactList)

  // Close contact list overlay
  document.getElementById('closeContactListBtn').addEventListener('click', closeContactList);

  // --- Settings and Dialogs Event Listeners ---

  // Settings button is now on map icon bar (calls window.showSettings)
  window.showSettings = () => {
    showSettings(settings);
  };

  // Close settings dialog
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);

  // Delete logbook button with confirmation
  document.getElementById('deleteLogbookBtn').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog({
      title: 'Delete All Logbook Entries?',
      message: '<p>This will permanently delete <strong style="color: #ef4444;">the entire logbook history</strong>.</p><p style="color: #ef4444; font-weight: 600; margin-top: 12px;">⚠️ This action cannot be undone!</p>',
      confirmText: 'Delete All',
      cancelText: 'Cancel',
      narrow: true
    });

    if (confirmed) {
      try {
        const { deleteAllLogsConfirmed } = await import('./modules/logbook.js');
        await deleteAllLogsConfirmed();
        showNotification('All logbook entries deleted', 'success');
      } catch (error) {
        console.error('[Logbook] Delete failed:', error);
        showNotification('Failed to delete logbook entries', 'error');
      }
    }
  });

  // Alliance chat button is now on map icon bar (calls window.showAllianceChatOverlay)
  window.showAllianceChatOverlay = () => {
    const overlay = document.getElementById('allianceChatOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');

      // Mark all messages as read when opening chat
      const chatFeed = document.getElementById('chatFeed');
      if (chatFeed && window.loadMessages) {
        window.loadMessages(chatFeed);
      }
    }
  };

  // Close alliance chat overlay
  document.getElementById('closeChatBtn').addEventListener('click', async () => {
    const overlay = document.getElementById('allianceChatOverlay');
    if (overlay) {
      overlay.classList.add('hidden');

      // Mark messages as read when closing chat
      if (window.markAllianceChatAsRead) {
        await window.markAllianceChatAsRead();
      }
    }
  });

  // Documentation button is now on map icon bar (calls window.showDocsOverlay)
  window.showDocsOverlay = () => {
    window.open('/docs/index.html', '_blank');
  };

  // Campaigns button is now on map icon bar (calls window.showCampaignsOverlay)

  // Close campaigns overlay
  document.getElementById('closeCampaignsBtn').addEventListener('click', closeCampaignsOverlay);

  // Forecast button is now on map icon bar (calls window.showForecastOverlay)
  window.showForecastOverlay = () => {
    document.getElementById('forecastOverlay').classList.remove('hidden');

    // Pass current event data to forecast calendar if available
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

  // Close forecast overlay
  document.getElementById('closeForecastBtn').addEventListener('click', () => {
    document.getElementById('forecastOverlay').classList.add('hidden');
  });

  // Initialize event info module
  initEventInfo();

  // Initialize logbook module
  initLogbook();

  // Initialize harbor map as main content (async to load data)
  // DON'T await - let it load in background so header can finish loading
  initHarborMap().catch(error => {
    console.error('[Init] Failed to initialize harbor map:', error);
  });

  // Coop button is now on map icon bar (calls window.showCoopOverlay)

  // Close coop overlay
  document.getElementById('closeCoopBtn').addEventListener('click', closeCoopOverlay);

  // Test notification button in settings
  document.getElementById('testAlertBtn').addEventListener('click', testBrowserNotification);

  // --- Vessel Catalog Event Listeners ---
  // Buy vessels button is now on map icon bar (calls window.showBuyVesselsOverlay)
  window.showBuyVesselsOverlay = async () => {
    // Load current bunker data (including cash) before showing purchase dialog
    await updateBunkerStatus(settings);
    document.getElementById('buyVesselsOverlay').classList.remove('hidden');
    await loadAcquirableVessels();
  };

  // Sell vessels button is now on map icon bar (calls window.openSellVesselsOverlay)

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

  // Filter to show only pending vessel purchases (not yet delivered)
  document.getElementById('filterPendingBtn').addEventListener('click', async () => {
    const { fetchVessels } = await import('./modules/api.js');
    const response = await fetchVessels();
    const pendingVessels = (response.vessels || []).filter(v => v.status === 'pending');
    showPendingVessels(pendingVessels);
  });

  // Close vessel catalog overlay
  document.getElementById('closeBuyVesselsBtn').addEventListener('click', () => {
    document.getElementById('buyVesselsOverlay').classList.add('hidden');
  });

  // Toggle filter dropdown menu
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

  // Live filtering - apply filters when any checkbox or dropdown changes
  document.getElementById('filterDropdownMenu').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') {
      applyVesselFilters();
    }
  });

  // Reset filters button
  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    resetVesselFilters();
  });

  // Sort by price button
  document.getElementById('sortPriceBtn').addEventListener('click', () => {
    togglePriceSort();
  });

  // Cart button (show shopping cart dialog)
  document.getElementById('cartBtn').addEventListener('click', showShoppingCart);

  // --- Number Formatting for All Number Fields ---
  // Apply thousand separators (dots) to all numeric input fields in settings
  const formattedNumberFields = [
    'fuelThreshold',
    'co2Threshold',
    'minFuelThreshold',
    'autoRebuyFuelThreshold',
    'autoRebuyFuelMinCash',
    'autoRebuyCO2Threshold',
    'autoRebuyCO2MinCash',
    'autoBulkRepairMinCash',
    'autoDrydockMinCash',
    'autoCampaignRenewalMinCash',
    'autoAnchorPointMinCash'
  ];

  formattedNumberFields.forEach(fieldId => {
    const input = document.getElementById(fieldId);
    if (input) {
      // Format on input (while typing)
      input.addEventListener('input', function(e) {
        // Remove all non-digits
        let value = e.target.value.replace(/\D/g, '');
        // Add thousand separators (dots)
        let formattedValue = formatNumberWithSeparator(value);
        // Update field with formatted value
        e.target.value = formattedValue;
      });

      // Format initial value on page load
      if (input.value) {
        let value = input.value.replace(/\D/g, '');
        input.value = formatNumberWithSeparator(value);
      }
    }
  });

  // --- Settings Threshold Event Listeners ---
  // Fuel price alert threshold ($/ton)
  document.getElementById('fuelThreshold').addEventListener('change', function() {
    settings.fuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // CO2 price alert threshold ($/ton)
  document.getElementById('co2Threshold').addEventListener('change', function() {
    settings.co2Threshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // Maintenance alert threshold (percentage)
  // Updates repair count badge when changed
  document.getElementById('maintenanceThreshold').addEventListener('change', function() {
    settings.maintenanceThreshold = parseInt(this.value);
    saveSettings(settings);
    debouncedUpdateRepairCount(500);
  });

  // --- AutoPilot Notifications Toggle ---
  // AutoPilot Notifications master toggle
  // When UNCHECKED: All notifications are suppressed regardless of individual settings
  // When CHECKED: Individual agent settings determine notification behavior
  const autoPilotNotificationsCheckbox = document.getElementById('autoPilotNotifications');

  if (autoPilotNotificationsCheckbox) {
    autoPilotNotificationsCheckbox.addEventListener('change', function() {
      settings.autoPilotNotifications = this.checked;
      toggleAutoPilotAgentCheckboxes(this.checked);
      saveSettings(settings);
    });
  }

  // Initialize agent checkboxes state on load
  // Use the actual setting value, default to true if undefined
  const initialNotifState = settings.autoPilotNotifications !== undefined ? settings.autoPilotNotifications : true;
  toggleAutoPilotAgentCheckboxes(initialNotifState);

  // --- Weather Data Toggle ---
  const enableWeatherDataCheckbox = document.getElementById('enableWeatherData');
  if (enableWeatherDataCheckbox) {
    enableWeatherDataCheckbox.addEventListener('change', async function() {
      const wasChecked = this.checked;
      settings.enableWeatherData = wasChecked;

      console.log('[Settings] Weather Data changed to:', wasChecked);
      await saveSettings(settings);
      console.log('[Settings] Weather Data saved');

      // Notify user that reload is required
      showNotification('Weather data setting saved. Please reload the page (F5) for changes to take effect.', 'info', 6000);

      // Update map controller (just for logging, no dynamic changes)
      if (window.harborMap && window.harborMap.updateWeatherDataSetting) {
        window.harborMap.updateWeatherDataSetting(wasChecked);
      }
    });
  }

  // Individual Agent Notification toggles (InApp + Desktop)
  const agentNotificationIds = [
    'notifyBarrelBossInApp',
    'notifyBarrelBossDesktop',
    'notifyAtmosphereBrokerInApp',
    'notifyAtmosphereBrokerDesktop',
    'notifyCargoMarshalInApp',
    'notifyCargoMarshalDesktop',
    'notifyYardForemanInApp',
    'notifyYardForemanDesktop',
    'notifyDrydockMasterInApp',
    'notifyDrydockMasterDesktop',
    'notifyReputationChiefInApp',
    'notifyReputationChiefDesktop',
    'notifyFairHandInApp',
    'notifyFairHandDesktop',
    'notifyHarbormasterInApp',
    'notifyHarbormasterDesktop',
    'notifyCaptainBlackbeardInApp',
    'notifyCaptainBlackbeardDesktop'
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

  // --- AutoPilot Auto-Rebuy Fuel Event Listeners ---
  // Enable/disable auto-rebuy fuel
  // Shows/hides additional options when toggled
  document.getElementById('autoRebuyFuel').addEventListener('change', function() {
    settings.autoRebuyFuel = this.checked;
    // Show/hide threshold options and min cash section based on checkbox state
    document.getElementById('autoRebuyFuelOptions').classList.toggle('hidden', !this.checked);
    const minCashSection = document.getElementById('autoRebuyFuelMinCashSection');
    if (minCashSection) minCashSection.classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Toggle between using alert threshold vs custom threshold for auto-rebuy
  // When checked: uses fuelThreshold and disables custom input
  // When unchecked: enables custom threshold input
  document.getElementById('autoRebuyFuelUseAlert').addEventListener('change', function() {
    settings.autoRebuyFuelUseAlert = this.checked;
    const thresholdInput = document.getElementById('autoRebuyFuelThreshold');

    if (this.checked) {
      // Use alert value: set to fuelThreshold and disable input
      thresholdInput.value = settings.fuelThreshold;
      thresholdInput.disabled = true;
      thresholdInput.classList.remove('input-enabled');
      thresholdInput.classList.add('input-disabled');
    } else {
      // Use custom value: enable input
      thresholdInput.disabled = false;
      thresholdInput.classList.remove('input-disabled');
      thresholdInput.classList.add('input-enabled');
    }

    saveSettings(settings);
  });

  // Custom threshold for auto-rebuy fuel (only used when "use alert" unchecked)
  document.getElementById('autoRebuyFuelThreshold').addEventListener('change', function() {
    settings.autoRebuyFuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // Min cash balance for auto-rebuy fuel
  document.getElementById('autoRebuyFuelMinCash').addEventListener('change', function() {
    settings.autoRebuyFuelMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoRebuyFuelMinCash);
    saveSettings(settings);
  });

  // --- AutoPilot Auto-Rebuy CO2 Event Listeners ---
  // Enable/disable auto-rebuy CO2
  // Shows/hides additional options when toggled
  document.getElementById('autoRebuyCO2').addEventListener('change', function() {
    settings.autoRebuyCO2 = this.checked;
    // Show/hide threshold options and min cash section based on checkbox state
    document.getElementById('autoRebuyCO2Options').classList.toggle('hidden', !this.checked);
    const minCashSection = document.getElementById('autoRebuyCO2MinCashSection');
    if (minCashSection) minCashSection.classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Toggle between using alert threshold vs custom threshold for CO2 auto-rebuy
  // When checked: uses co2Threshold and disables custom input
  // When unchecked: enables custom threshold input
  document.getElementById('autoRebuyCO2UseAlert').addEventListener('change', function() {
    settings.autoRebuyCO2UseAlert = this.checked;
    const thresholdInput = document.getElementById('autoRebuyCO2Threshold');

    if (this.checked) {
      // Use alert value: set to co2Threshold and disable input
      thresholdInput.value = settings.co2Threshold;
      thresholdInput.disabled = true;
      thresholdInput.classList.remove('input-enabled');
      thresholdInput.classList.add('input-disabled');
    } else {
      // Use custom value: enable input
      thresholdInput.disabled = false;
      thresholdInput.classList.remove('input-disabled');
      thresholdInput.classList.add('input-enabled');
    }

    saveSettings(settings);
  });

  // Custom threshold for auto-rebuy CO2 (only used when "use alert" unchecked)
  document.getElementById('autoRebuyCO2Threshold').addEventListener('change', function() {
    settings.autoRebuyCO2Threshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // Min cash balance for auto-rebuy CO2
  document.getElementById('autoRebuyCO2MinCash').addEventListener('change', function() {
    settings.autoRebuyCO2MinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoRebuyCO2MinCash);
    saveSettings(settings);
  });

  // --- AutoPilot Feature Toggles ---
  // Auto-depart all ready vessels
  document.getElementById('autoDepartAll').addEventListener('change', function() {
    settings.autoDepartAll = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoDepartOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-repair all vessels below maintenance threshold
  document.getElementById('autoBulkRepair').addEventListener('change', function() {
    settings.autoBulkRepair = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoBulkRepairOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Min cash balance for auto bulk repair
  document.getElementById('autoBulkRepairMinCash').addEventListener('change', function() {
    settings.autoBulkRepairMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoBulkRepairMinCash);
    saveSettings(settings);
  });

  // Auto-drydock vessels
  document.getElementById('autoDrydock').addEventListener('change', function() {
    settings.autoDrydock = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoDrydockOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Drydock maintenance type
  document.getElementById('autoDrydockType').addEventListener('change', function() {
    settings.autoDrydockType = this.value;
    saveSettings(settings);
  });

  // Drydock route speed
  document.getElementById('autoDrydockSpeed').addEventListener('change', function() {
    settings.autoDrydockSpeed = this.value;
    saveSettings(settings);
  });

  // Min cash balance for auto drydock
  document.getElementById('autoDrydockMinCash').addEventListener('change', function() {
    settings.autoDrydockMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoDrydockMinCash);
    saveSettings(settings);
  });

  // Auto-renew expiring campaigns
  document.getElementById('autoCampaignRenewal').addEventListener('change', function() {
    settings.autoCampaignRenewal = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoCampaignRenewalOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Min cash balance for auto campaign renewal
  document.getElementById('autoCampaignRenewalMinCash').addEventListener('change', function() {
    settings.autoCampaignRenewalMinCash = parseInt(this.value.replace(/,/g, ''));
    this.value = formatNumberWithSeparator(settings.autoCampaignRenewalMinCash);
    saveSettings(settings);
  });

  // Auto-COOP distribution
  document.getElementById('autoCoopEnabled').addEventListener('change', function() {
    settings.autoCoopEnabled = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoCoopOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-Anchor Point Purchase
  document.getElementById('autoAnchorPointEnabled').addEventListener('change', function() {
    settings.autoAnchorPointEnabled = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoAnchorPointOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-Negotiate Hijacking
  document.getElementById('autoNegotiateHijacking').addEventListener('change', function() {
    settings.autoNegotiateHijacking = this.checked;
    // Show/hide options based on checkbox state
    document.getElementById('autoNegotiateOptions').classList.toggle('hidden', !this.checked);
    saveSettings(settings);
    updatePageTitle(settings);
  });

  // Auto-Anchor Point Min Cash
  document.getElementById('autoAnchorPointMinCash').addEventListener('change', function() {
    const value = parseInt(this.value.replace(/,/g, ''));
    if (value >= 0) {
      settings.autoAnchorPointMinCash = value;
      this.value = formatNumberWithSeparator(settings.autoAnchorPointMinCash);
      saveSettings(settings);
    } else {
      if (settings.autoAnchorPointMinCash !== undefined) {
        this.value = formatNumberWithSeparator(settings.autoAnchorPointMinCash);
      }
    }
  });

  // Auto-Anchor Point Amount Radio Buttons
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

  // Desktop notifications master toggle
  document.getElementById('enableDesktopNotifications').addEventListener('change', function() {
    settings.enableDesktopNotifications = this.checked;
    saveSettings(settings);
  });

  // Inbox notifications toggle
  document.getElementById('enableInboxNotifications').addEventListener('change', function() {
    settings.enableInboxNotifications = this.checked;
    saveSettings(settings);
  });

  // --- Intelligent Auto-Depart Settings ---

  // Toggle between using route defaults vs custom settings
  document.getElementById('autoDepartUseRouteDefaults').addEventListener('change', function() {
    settings.autoDepartUseRouteDefaults = this.checked;
    const customSettingsDiv = document.getElementById('autoDepartCustomSettings');

    if (this.checked) {
      // Use route defaults: hide custom settings
      customSettingsDiv.classList.add('hidden');
    } else {
      // Use custom settings: show inputs
      customSettingsDiv.classList.remove('hidden');
    }

    saveSettings(settings);
  });

  // Minimum fuel threshold for auto-depart
  document.getElementById('minFuelThreshold').addEventListener('change', function() {
    settings.minFuelThreshold = parseInt(this.value.replace(/,/g, ''));
    saveSettings(settings);
  });

  // Min cargo utilization (moved to General Settings - applies to manual + auto depart)
  const minCargoUtilizationSelect = document.getElementById('minCargoUtilization');
  if (minCargoUtilizationSelect) {
    minCargoUtilizationSelect.addEventListener('change', function() {
      settings.minCargoUtilization = this.value === '' ? null : parseInt(this.value);
      saveSettings(settings);
    });
  }

  // Harbor fee warning threshold (in General Settings)
  const harborFeeWarningThresholdSelect = document.getElementById('harborFeeWarningThreshold');
  if (harborFeeWarningThresholdSelect) {
    harborFeeWarningThresholdSelect.addEventListener('change', function() {
      settings.harborFeeWarningThreshold = this.value === '' ? null : parseInt(this.value);
      saveSettings(settings);
    });
  }

  // Drydock threshold (in General Settings)
  const autoDrydockThresholdSelect = document.getElementById('autoDrydockThreshold');
  if (autoDrydockThresholdSelect) {
    autoDrydockThresholdSelect.addEventListener('change', function() {
      settings.autoDrydockThreshold = parseInt(this.value);
      saveSettings(settings);
    });
  }

  // Vessel speed as percentage of max_speed (only used when not using route defaults)
  document.getElementById('autoVesselSpeed').addEventListener('change', function() {
    settings.autoVesselSpeed = parseInt(this.value);
    saveSettings(settings);
  });

  // --- Chat Bot Settings Event Listeners ---
  // Enable/disable Chat Bot
  const enableChatBotCheckbox = document.getElementById('enableChatBot');
  if (enableChatBotCheckbox) {
    enableChatBotCheckbox.addEventListener('change', function() {
      settings.chatbotEnabled = this.checked;
      // Show/hide other chat bot settings when enabled/disabled
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

  // Daily forecast enabled
  const dailyForecastEnabledCheckbox = document.getElementById('dailyForecastEnabled');
  if (dailyForecastEnabledCheckbox) {
    dailyForecastEnabledCheckbox.addEventListener('change', function() {
      settings.chatbotDailyForecastEnabled = this.checked;
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
      // Enable/disable individual command checkboxes
      document.getElementById('cmdForecast').disabled = !this.checked;
      document.getElementById('cmdHelp').disabled = !this.checked;
      saveSettings(settings);
    });
  }

  // Forecast command enabled
  const cmdForecastCheckbox = document.getElementById('cmdForecast');
  if (cmdForecastCheckbox) {
    cmdForecastCheckbox.addEventListener('change', function() {
      settings.chatbotForecastCommandEnabled = this.checked;
      // Enable/disable channel checkboxes based on command state
      if (document.getElementById('cmdForecastAlliance')) document.getElementById('cmdForecastAlliance').disabled = !this.checked;
      if (document.getElementById('cmdForecastDM')) document.getElementById('cmdForecastDM').disabled = !this.checked;
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
      // Enable/disable channel checkboxes based on command state
      if (document.getElementById('cmdHelpAlliance')) document.getElementById('cmdHelpAlliance').disabled = !this.checked;
      if (document.getElementById('cmdHelpDM')) document.getElementById('cmdHelpDM').disabled = !this.checked;
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

  // DM commands enabled
  const enableDMCommandsCheckbox = document.getElementById('enableDMCommands');
  if (enableDMCommandsCheckbox) {
    enableDMCommandsCheckbox.addEventListener('change', function() {
      settings.chatbotDMCommandsEnabled = this.checked;
      // Find and toggle the delete DM checkbox if it exists
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

  // Note: Delete DM after reply checkbox doesn't exist in current HTML
  // Will handle it if/when it's added to the UI

  // Add custom command button - only if element exists
  const addCustomCommandBtn = document.getElementById('addCustomCommand');
  if (addCustomCommandBtn) {
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

    const commandDiv = document.createElement('div');
    commandDiv.className = 'custom-command-item';
    commandDiv.innerHTML = `
      <div class="command-header-row">
        <input type="text" placeholder="Command (e.g. status)" data-command-index="${commandIndex}" data-field="command" class="command-input">
        <button class="remove-custom-command" data-command-index="${commandIndex}">Remove</button>
      </div>

      <div class="response-container">
        <textarea
          placeholder="Response text (max 1000 characters, use Shift+Enter for line breaks)"
          data-command-index="${commandIndex}"
          data-field="response"
          maxlength="1000"
          class="response-textarea"></textarea>
        <div class="char-counter-container">
          <span class="char-counter" data-command-index="${commandIndex}">0</span> / 1000
        </div>
      </div>

      <div class="response-options">
        <div class="response-option-row">
          <div class="response-option-header">Response Channel:</div>
          <label class="response-option-label">
            <input type="checkbox" data-command-index="${commandIndex}" data-field="allianceEnabled" checked class="response-option-checkbox">
            <span class="response-option-text">Alliance Chat</span>
          </label>
          <label class="response-option-label">
            <input type="checkbox" data-command-index="${commandIndex}" data-field="dmEnabled" checked class="response-option-checkbox">
            <span class="response-option-text">Direct Messages</span>
          </label>
        </div>
        <label class="response-option-label">
          <input type="checkbox" data-command-index="${commandIndex}" data-field="adminOnly" class="response-option-checkbox">
          <span class="response-option-text-admin">Admin Only</span>
        </label>
      </div>
    `;

    commandsContainer.appendChild(commandDiv);

    // Add event listeners to the new inputs
    commandDiv.querySelectorAll('input[type="text"]').forEach(input => {
      input.addEventListener('input', function() {
        const index = parseInt(this.dataset.commandIndex);
        const field = this.dataset.field;
        if (settings.chatbotCustomCommands[index]) {
          settings.chatbotCustomCommands[index][field] = this.value;
          saveSettings(settings);
        }
      });
    });

    // Textarea with character counter
    const textarea = commandDiv.querySelector('textarea');
    const charCounter = commandDiv.querySelector('.char-counter');
    textarea.addEventListener('input', function() {
      const index = parseInt(this.dataset.commandIndex);
      if (settings.chatbotCustomCommands[index]) {
        settings.chatbotCustomCommands[index].response = this.value;
        saveSettings(settings);
      }
      charCounter.textContent = this.value.length;
    });

    commandDiv.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', function() {
        const index = parseInt(this.dataset.commandIndex);
        const field = this.dataset.field;
        if (settings.chatbotCustomCommands[index]) {
          settings.chatbotCustomCommands[index][field] = this.checked;
          saveSettings(settings);
        }
      });
    });

    commandDiv.querySelector('.remove-custom-command').addEventListener('click', function() {
      const index = parseInt(this.dataset.commandIndex);
      settings.chatbotCustomCommands.splice(index, 1);
      commandDiv.remove();
      // Re-index remaining commands
      document.querySelectorAll('.custom-command-item').forEach((item, newIndex) => {
        item.querySelectorAll('[data-command-index]').forEach(el => {
          el.dataset.commandIndex = newIndex;
        });
      });
      saveSettings(settings);
    });
    });
  }

  // Load existing custom commands - only if container exists
  const customCommandsList = document.getElementById('customCommandsList');
  if (customCommandsList && settings.chatbotCustomCommands && settings.chatbotCustomCommands.length > 0) {
    const commandsContainer = document.getElementById('customCommandsList');
    settings.chatbotCustomCommands.forEach((cmd, index) => {
      const commandDiv = document.createElement('div');
      commandDiv.className = 'custom-command-item';
      commandDiv.innerHTML = `
        <div class="command-header-row">
          <input type="text" placeholder="Command (e.g. status)" data-command-index="${index}" data-field="command" value="${escapeHtml(cmd.command)}" class="command-input">
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

      commandsContainer.appendChild(commandDiv);

      // Add event listeners
      commandDiv.querySelectorAll('input[type="text"]').forEach(input => {
        input.addEventListener('input', function() {
          const idx = parseInt(this.dataset.commandIndex);
          const field = this.dataset.field;
          if (settings.chatbotCustomCommands[idx]) {
            settings.chatbotCustomCommands[idx][field] = this.value;
            saveSettings(settings);
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
          saveSettings(settings);
        }
        charCounter.textContent = this.value.length;
      });

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
    });
  }

  // --- Vessel Management Event Listeners ---
  // NOTE: Depart, anchor, and repair button clicks are now handled by map icon bar (map-icon-bar.js)
  // Hidden buttons have been removed from index.html to eliminate duplicate UI elements

  // --- Bunker Management Event Listeners ---
  // Buy maximum fuel based on available storage
  document.getElementById('fuelBtn').addEventListener('click', buyMaxFuel);

  // Buy maximum CO2 certificates based on available storage
  document.getElementById('co2Btn').addEventListener('click', buyMaxCO2);

  // --- Messenger Input Auto-Resize ---
  // Automatically adjusts textarea height as user types (max 120px)
  document.getElementById('messengerInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';

    // Update character counter
    const charCounter = document.getElementById('messengerCharCount');
    if (charCounter) {
      charCounter.textContent = `${this.value.length} / 1000`;
    }
  });

  // --- Notification Permission Management ---
  // Button to manually request notification permission
  const notificationBtn = document.getElementById('notificationBtn');
  if (notificationBtn) {
    // Update button state based on browser permission AND settings
    /**
     * Updates notification button UI state
     * @returns {void}
     */
    const updateNotificationButtonState = () => {
      // Only show button if browser permission is missing (regardless of settings)
      if (Notification.permission !== "granted") {
        // Show red disabled megaphone
        notificationBtn.classList.remove('enabled');
        notificationBtn.classList.add('disabled');
        notificationBtn.classList.remove('hidden');
      } else {
        // Hide button completely when browser permission is granted
        notificationBtn.classList.add('hidden');
      }
    };

    // Set initial state
    updateNotificationButtonState();

    // Check permission status every 2 seconds to auto-hide button when permission granted
    setInterval(updateNotificationButtonState, 2000);

    notificationBtn.addEventListener('click', async () => {
      // Only handle browser permission (device-specific), not global settings

      if (Notification.permission === "denied") {
        // Browser has blocked notifications - user must enable in browser settings
        showSideNotification('⚠️ <strong>Browser Blocked</strong><br><br>Enable in browser settings', 'warning', null, true);
        return;
      }

      if (Notification.permission === "default") {
        // Ask for browser permission
        const hasPermission = await requestNotificationPermission();
        if (hasPermission) {
          showSideNotification('✅ <strong>Browser Permission Granted</strong>', 'success');
        }
        updateNotificationButtonState();
        return;
      }

      if (Notification.permission === "granted") {
        // Already granted - show info
        showSideNotification('✅ <strong>Browser Permission</strong><br><br>Already granted for this device', 'success');
      }
    });

  }

  // Auto-request notification permission on load (if not already decided)
  if ("Notification" in window && Notification.permission === "default") {
    await requestNotificationPermission();
  }

  // ===== STEP 5: Load Initial Data =====
  // Show cached values immediately for instant display
  // WebSocket will send fresh data once connected and update everything

  if (window.DEBUG_MODE) {
    console.log('[Init] Loading cached values...');
  }
  loadCache();
  if (window.DEBUG_MODE) {
    console.log('[Init] Cached values displayed - waiting for WebSocket to send fresh data');
  }

  // Trigger price alert check on backend (will send alerts via WebSocket if needed)
  try {
    fetch('/api/check-price-alerts', { method: 'POST' });
    if (window.DEBUG_MODE) {
      console.log('[Init] Price alert check triggered');
    }
  } catch (error) {
    console.error('[Init] Failed to trigger price alerts:', error);
  }

  // SEQUENTIAL: Load chat data (needs delays to prevent socket hang-ups)
  await loadAllianceMembers();

  // WebSocket will send initial chat data on connect
  // No need for retry loop - backend handles initial data push
  // If no data received within 500ms, fall back to single API call
  await new Promise(resolve => setTimeout(resolve, 500));

  const feedContent = chatFeed.innerHTML;
  if (feedContent.includes('Loading chat...')) {
    // WebSocket didn't send initial data yet - make single API call as fallback
    if (window.DEBUG_MODE) {
      console.log('[Init] No initial WebSocket data - making fallback API call');
    }
    await loadMessages(chatFeed);
  } else {
    if (window.DEBUG_MODE) {
      console.log('[Init] Chat data received via WebSocket');
    }
  }

  // Update unread message badge
  updateUnreadBadge();
  if (window.DEBUG_MODE) {
    console.log('[Init] Unread badge updated!');
  }

  // Map is now main content - no need to preload
  // Auto-updates are handled by vessel-management.js via refreshHarborMapIfOpen()

  // Define autopilot button update function BEFORE WebSocket connects
  // This must be available when WebSocket sends initial autopilot_status event
  /**
   * Updates autopilot button icon and title
   * @param {boolean} isPaused - True if autopilot is paused
   * @returns {void}
   */
  window.updateAutopilotButton = function(isPaused) {
    const icon = document.getElementById('autopilotToggleIcon');
    const headerTitle = document.querySelector('.autopilot-active');

    if (icon && headerTitle) {
      if (isPaused) {
        // Paused state - RED with PLAY icon (to resume)
        icon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        headerTitle.classList.add('paused');
      } else {
        // Running state - GREEN with PAUSE icon (two bars)
        icon.innerHTML = `<path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>`;
        headerTitle.classList.remove('paused');
      }
    }
  };

  /**
   * Toggles autopilot pause/resume state
   * @async
   * @returns {Promise<void>}
   */
  window.toggleAutopilot = async function() {
    try {
      const cachedPauseState = getStorage('autopilotPaused');
      const currentlyPaused = cachedPauseState ? JSON.parse(cachedPauseState) : false;
      const newPauseState = !currentlyPaused;

      console.log('[Autopilot Toggle] Switching from', currentlyPaused ? 'PAUSED' : 'RUNNING', 'to', newPauseState ? 'PAUSED' : 'RUNNING');

      // Send toggle request to backend
      const response = await fetch(window.apiUrl('/api/autopilot/toggle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: newPauseState })
      });

      if (!response.ok) {
        throw new Error('Failed to toggle autopilot');
      }

      await response.json();

      // Update UI immediately (WebSocket will send notification to all clients)
      setStorage('autopilotPaused', JSON.stringify(newPauseState));
      window.updateAutopilotButton(newPauseState);

      // Note: Side notification will be shown via WebSocket broadcast (onAutopilotStatusUpdate)
      // This ensures all connected clients see the notification, not just this one

    } catch (error) {
      console.error('[Autopilot Toggle] Error:', error);
      showSideNotification('❌ <strong>Failed to toggle autopilot</strong><br>Please try again', 'error', 5000, true);
    }
  };

  /**
   * Handles autopilot status updates from WebSocket
   * @param {Object} data - Status update data
   * @param {boolean} data.paused - Autopilot pause state
   * @returns {void}
   */
  window.onAutopilotStatusUpdate = function(data) {
    // Get previous state to detect actual changes
    const cachedPauseState = getStorage('autopilotPaused');
    const previousPaused = cachedPauseState ? JSON.parse(cachedPauseState) : null;
    const hasChanged = previousPaused !== null && previousPaused !== data.paused;

    // Also save to per-user localStorage for instant load on next page refresh
    setStorage('autopilotPaused', JSON.stringify(data.paused));
    window.updateAutopilotButton(data.paused);

    // Show side notification ONLY if state actually changed (not on initial load)
    if (hasChanged) {
      if (data.paused) {
        showSideNotification('<strong>AutoPilot ⏸️</strong><br><br>All automated functions are now on hold', 'warning', 5000, true);
      } else {
        showSideNotification('<strong>AutoPilot ▶️</strong><br><br>All automated functions are now active', 'success', 5000, true);
      }
    }
  };

  // Logbook update handler
  window.handleLogbookUpdate = function(logEntry) {
    // Call logbook module to prepend new entry
    if (typeof prependLogEntry === 'function') {
      prependLogEntry(logEntry);
    }
  };

  // Load autopilot pause state from per-user localStorage BEFORE WebSocket connects
  // CRITICAL: Only load if userId validated to prevent showing wrong account state
  try {
    const currentUserId = window.USER_STORAGE_PREFIX;

    // Validation: Only load autopilot state if userId validated
    if (!currentUserId) {
      console.log('[Autopilot UI] Skipping cached state - userId not validated (will use WebSocket state)');
      // Default to "running" - WebSocket will send correct state
      window.updateAutopilotButton(false);
    } else {
      // Safe to load cached state - userId validated
      const cachedPauseState = getStorage('autopilotPaused');
      if (cachedPauseState !== null) {
        const isPaused = JSON.parse(cachedPauseState);
        console.log('[Autopilot UI] Loaded cached pause state:', isPaused ? 'PAUSED' : 'RUNNING');
        window.updateAutopilotButton(isPaused);
      } else {
        // No cached state - default to running
        console.log('[Autopilot UI] No cached state found - defaulting to RUNNING');
        window.updateAutopilotButton(false);
      }
    }
  } catch (error) {
    console.error('[Autopilot UI] Failed to load cached pause state:', error);
    // On error, default to running
    window.updateAutopilotButton(false);
  }

  // ===== STEP 6: Initialize WebSocket =====
  // Establishes wss:// connection for real-time chat updates and settings sync
  initWebSocket();

  // ===== STEP 7: Automation System =====
  // Moved to backend: server/autopilot.js + server/scheduler.js
  // Backend autopilot initialized in app.js via scheduler.initSchedulers()

  // ===== STEP 8: Update Page Title =====
  // Shows "AutoPilot" indicator in title if any automation features enabled
  updatePageTitle(settings);

  // ===== STEP 9: WebSocket-Only Updates (NO POLLING) =====
  //
  // IMPORTANT: ALL data updates come exclusively from backend via WebSocket:
  // - WebSocket connection is maintained and reconnects automatically on disconnect
  // - Backend pushes all updates at configured intervals (25s for chat, 60s for badges)
  // - NO frontend polling needed - reduces API load and prevents duplicate calls
  //
  // WebSocket Events:
  // - chat_update: Alliance chat messages (25s interval)
  // - vessel_count_update: Vessel badges (60s interval)
  // - repair_count_update: Repair badge (60s interval)
  // - campaign_status_update: Campaigns badge (60s interval)
  // - unread_messages_update: Messages badge (10s interval)
  // - bunker_update: Bunker status (60s interval)
  // - coop_targets_update: Coop badge (60s interval)
  //
  // Frontend only loads initial data on page load, then receives all updates via WebSocket.
  // This eliminates duplicate API calls (frontend + backend both polling same endpoints).

  // ===== STEP 10: Page Visibility API =====
  // Refresh chat messages when page becomes visible again.
  // Badge data comes from WebSocket which maintains connection automatically.
  // Debounce mechanism to prevent duplicate refreshes
  let refreshInProgress = false;
  let lastRefreshTime = 0;
  const REFRESH_COOLDOWN = 1000; // 1 second cooldown

  /**
   * Refreshes chat messages with cooldown protection
   * @async
   * @param {string} source - Trigger source for logging
   * @returns {Promise<void>}
   */
  const refreshChatData = async (source) => {
    const now = Date.now();

    // Skip if refresh is already in progress or within cooldown
    if (refreshInProgress || (now - lastRefreshTime) < REFRESH_COOLDOWN) {
      if (DEBUG_MODE) {
        console.log(`[${source}] Skipping refresh (cooldown or in progress)`);
      }
      return;
    }

    refreshInProgress = true;
    lastRefreshTime = now;
    if (DEBUG_MODE) {
      console.log(`[${source}] Refreshing chat messages`);
    }

    try {
      await loadMessages(chatFeed);
      if (DEBUG_MODE) {
        console.log(`[${source}] Chat messages refreshed`);
      }
    } catch (error) {
      console.error(`[${source}] Error refreshing chat:`, error);
    } finally {
      refreshInProgress = false;
    }
  };

  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      await refreshChatData('Visibility');
    }
  });

  // ===== STEP 11: Focus API (additional insurance for PC browsers) =====
  // Some PC browsers don't trigger visibilitychange reliably, so we also
  // listen to window focus events for extra coverage.
  window.addEventListener('focus', async () => {
    await refreshChatData('Focus');
  });
});
