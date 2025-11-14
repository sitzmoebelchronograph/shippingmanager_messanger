/**
 * @fileoverview Bunker Management Module - Handles fuel and CO2 quota purchasing, real-time price monitoring,
 * and automated price alerts for the Shipping Manager game. This module tracks commodity prices in 30-minute
 * UTC time slots and triggers browser/desktop notifications when prices fall below user-defined thresholds.
 * Also monitors marketing campaign status and notifies users when campaigns are not fully active.
 *
 * Key Features:
 * - Real-time fuel and CO2 price tracking with 30-minute UTC time slot granularity
 * - Price alert system with browser notifications when thresholds are met
 * - Maximum capacity tracking and purchase cost calculations
 * - Marketing campaign monitoring (3 types: reputation, awareness, green)
 * - Auto-rebuy integration for automated purchasing when conditions are met
 *
 * Price Alert Logic:
 * - Alerts trigger once per price change (prevents spam)
 * - Resets when price goes above threshold (allows re-alert on next drop)
 * - Supports both in-app visual alerts and desktop notifications
 *
 * @module bunker-management
 * @requires utils - Formatting, feedback, and notification functions
 * @requires api - Backend API calls for price data and purchases
 * @requires ui-dialogs - Confirmation dialogs for purchases
 */

import { formatNumber, showSideNotification } from './utils.js';
import { fetchBunkerPrices, purchaseFuel as apiPurchaseFuel, purchaseCO2 as apiPurchaseCO2 } from './api.js';
import { showConfirmDialog } from './ui-dialogs.js';

/**
 * Maximum fuel storage capacity in tons.
 * Fetched from API (/user/get-company) - NEVER hardcoded.
 * @type {number}
 */
let maxFuel = 0;

/**
 * Maximum CO2 quota storage capacity in tons.
 * Fetched from API (/user/get-company) - NEVER hardcoded.
 * @type {number}
 */
let maxCO2 = 0;

/**
 * Current fuel inventory in tons.
 * Updated from API responses and decremented when vessels depart.
 * @type {number}
 */
let currentFuel = 0;

/**
 * Current CO2 quota inventory in tons.
 * Can be negative if player exceeded their quota. Updated from API responses.
 * @type {number}
 */
let currentCO2 = 0;

/**
 * Current cash balance in dollars.
 * Updated from API responses and used for purchase affordability checks.
 * NOTE: Always use window.updateDataCache.bunker.cash for live value in purchase dialogs
 * @type {number}
 */
let currentCash = 0;

/**
 * Current fuel price per ton in dollars.
 * Retrieved from API based on current UTC time slot (30-minute intervals).
 * @type {number|null}
 */
let fuelPrice = null;

/**
 * Current CO2 quota price per ton in dollars.
 * Retrieved from API based on current UTC time slot (30-minute intervals).
 * @type {number|null}
 */
let co2Price = null;

/**
 * Sets capacity values from bunker_update event data.
 * Called when WebSocket sends maxFuel and maxCO2 values.
 * Only logs when capacity values actually change.
 * @param {number} newMaxFuel - Max fuel capacity in tons
 * @param {number} newMaxCO2 - Max CO2 capacity in tons
 */
export function setCapacityFromBunkerUpdate(newMaxFuel, newMaxCO2) {
  // Check if values are provided and valid
  if (newMaxFuel !== undefined && newMaxFuel > 0) {
    // First time initialization (maxFuel is 0) - set without logging
    if (maxFuel === 0) {
      maxFuel = newMaxFuel;
    }
    // Value changed - update and log
    else if (newMaxFuel !== maxFuel) {
      maxFuel = newMaxFuel;
      console.log(`[Bunker] Capacity updated from server - Fuel: ${maxFuel}t, CO2: ${maxCO2}t`);
    }
  }

  if (newMaxCO2 !== undefined && newMaxCO2 > 0) {
    // First time initialization (maxCO2 is 0) - set without logging
    if (maxCO2 === 0) {
      maxCO2 = newMaxCO2;
    }
    // Value changed - update and log (only if we didn't already log for fuel)
    else if (newMaxCO2 !== maxCO2) {
      maxCO2 = newMaxCO2;
      // Only log if fuel didn't change (to avoid double logging)
      if (newMaxFuel === undefined || newMaxFuel <= 0 || newMaxFuel === maxFuel) {
        console.log(`[Bunker] Capacity updated from server - Fuel: ${maxFuel}t, CO2: ${maxCO2}t`);
      }
    }
  }
}

/**
 * Updates bunker (fuel/CO2) status display and triggers price alerts if thresholds are met.
 * This is the core function for monitoring commodity prices and inventory levels.
 *
 * Price Monitoring Strategy:
 * - Prices update every 30 minutes based on UTC time slots (e.g., 14:00, 14:30, 15:00)
 * - Compares current prices against user-configured thresholds
 * - Triggers visual and desktop notifications when prices drop below thresholds
 * - Only alerts once per price drop to prevent notification spam
 *
 * Side Effects:
 * - Updates DOM elements for fuel, CO2, cash, and price displays
 * - Triggers browser notifications (if permission granted)
 * - Shows in-app price alert overlays
 * - Calls auto-rebuy checks via global callback (if AutoPilot enabled)
 * - Updates button tooltips with purchase calculations
 *
 * @async
 * @param {Object} settings - User settings object containing price thresholds
 * @param {number} settings.fuelThreshold - Fuel price threshold in $/ton for alerts
 * @param {number} settings.co2Threshold - CO2 price threshold in $/ton for alerts
 * @returns {Promise<void>}
 * @throws {Error} Silently catches and logs errors to console
 *
 * @example
 * // Called automatically every 30-35 seconds by main app
 * updateBunkerStatus({ fuelThreshold: 400, co2Threshold: 7 });
 */
export async function updateBunkerStatus(settings) {
  try {
    // Fetch bunker state (fuel/CO2/cash levels) from API
    // Prices come from WebSocket updates (window.updateDataCache.prices)
    const data = await fetchBunkerPrices();

    if (!data.user || data.user.cash === undefined) {
      console.error('[Bunker Management] API returned invalid data:', data);
      throw new Error('Failed to fetch bunker data: user.cash is undefined');
    }

    currentFuel = data.user.fuel / 1000;
    currentCO2 = data.user.co2 / 1000;
    currentCash = data.user.cash;

    // Use prices from WebSocket cache (already processed by backend)
    // This avoids redundant time slot matching and uses the same source as the header
    if (window.updateDataCache && window.updateDataCache.prices) {
      const cachedPrices = window.updateDataCache.prices;

      if (cachedPrices.fuel && cachedPrices.fuel > 0) {
        fuelPrice = cachedPrices.fuel;
      }

      if (cachedPrices.co2 && cachedPrices.co2 > 0) {
        co2Price = cachedPrices.co2;
      }

      console.log('[Bunker Management] Using prices from WebSocket cache - fuel:', fuelPrice, 'co2:', co2Price);
    } else {
      console.warn('[Bunker Management] Price cache not available yet, prices may be stale');
    }

    const fuelDisplay = document.getElementById('fuelDisplay');
    const co2Display = document.getElementById('co2Display');
    const cashDisplay = document.getElementById('cashDisplay');
    const fuelPriceDisplay = document.getElementById('fuelPriceDisplay');
    const co2PriceDisplay = document.getElementById('co2PriceDisplay');

    // CRITICAL: Only update displays if we have VALID MAX values (right side > 0)
    // Left side (current values) CAN be 0 or even negative (CO2) - that's OK!
    // We only check if maxFuel/maxCO2 > 0 to know we have real data from API
    // If max values are 0, we got invalid data or no data yet - DO NOT display anything

    if (maxFuel > 0) {
      // currentFuel can be 0 (empty tank) - that's fine, we still show it
      fuelDisplay.innerHTML = `${formatNumber(Math.floor(currentFuel))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxFuel))} <b>t</b>`;
    }

    if (maxCO2 > 0) {
      // currentCO2 can be 0 or NEGATIVE - that's fine, we still show it
      if (currentCO2 < 0) {
        co2Display.innerHTML = `-${formatNumber(Math.floor(Math.abs(currentCO2)))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxCO2))} <b>t</b>`;
      } else {
        co2Display.innerHTML = `${formatNumber(Math.floor(currentCO2))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxCO2))} <b>t</b>`;
      }
    }

    // Cash: If we have valid bunker data (maxFuel > 0), show cash even if 0 (user could be broke)
    // Only skip display if we have NO data yet at all
    if (maxFuel > 0 || maxCO2 > 0) {
      cashDisplay.textContent = `$${formatNumber(currentCash)}`;
    }

    // Only update price display if we have valid prices (> 0), otherwise keep last known value
    if (fuelPrice && fuelPrice > 0) {
      fuelPriceDisplay.textContent = `$${formatNumber(fuelPrice)}/t`;
      fuelPriceDisplay.className = ''; // Clear existing classes

      // Check if below alert threshold (pulse animation)
      if (fuelPrice < settings.fuelThreshold) {
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

    // CRITICAL: Only update CO2 price if VALID (> 0)
    // DO NOT show 0 or invalid values - keep cached value instead
    if (co2Price !== null && co2Price !== undefined && co2Price > 0) {
      co2PriceDisplay.textContent = `$${formatNumber(co2Price)}/t`;
      co2PriceDisplay.className = ''; // Clear existing classes

      // Check if below alert threshold (pulse animation)
      if (co2Price < settings.co2Threshold) {
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
    } else if (co2Price !== null && co2Price !== undefined && co2Price < 0) {
      // Special case: Negative CO2 prices (you get paid!)
      co2PriceDisplay.textContent = `$${formatNumber(co2Price)}/t`;
      co2PriceDisplay.className = 'co2-negative';
    } else if (co2Price === 0) {
      // Log detailed warning if co2Price is exactly 0 - this should NEVER happen
      // This means either: 1) Never loaded any prices yet, or 2) API gave us invalid data
      console.warn('[Bunker Management] ⚠️ CO2 price is ZERO - NOT displaying (keeping cached value in display)', {
        reason: 'co2Price module variable is still 0 (initial value or invalid API data)',
        currentPriceDataFound: !!currentPriceData,
        apiCallSucceeded: !!data,
        pricesArrayLength: data?.data?.prices?.length || 0,
        note: 'If this happens on first load, it is normal. If it happens later, check if API call succeeded or if time slot matching failed.'
      });
    }
    // If co2Price is null, undefined, or EXACTLY 0: DO NOTHING - keep last cached value

    const fuelNeeded = Math.ceil(Math.max(0, maxFuel - currentFuel));
    const co2Needed = Math.ceil(Math.max(0, maxCO2 - currentCO2));
    const fuelCost = Math.round(fuelNeeded * fuelPrice);
    const co2Cost = Math.round(co2Needed * co2Price);

    document.getElementById('fuelBtn').title = `Buy ${formatNumber(fuelNeeded)}t fuel for $${formatNumber(fuelCost)} (Price: $${fuelPrice}/t)`;
    document.getElementById('co2Btn').title = `Buy ${formatNumber(co2Needed)}t CO2 for $${formatNumber(co2Cost)} (Price: $${co2Price}/t)`;

    // Cache prices for next page load - only if valid
    if (window.saveBadgeCache && fuelPrice > 0 && co2Price > 0) {
      window.saveBadgeCache({ prices: { fuelPrice, co2Price } });
    }

    // Price alerts and auto-rebuy are now handled exclusively by backend
    // Backend checks prices at :01 and :31 minutes every hour
    // See: server/autopilot.js - autoRebuyForAllUsers()

  } catch (error) {
    console.error('Error updating bunker status:', error);
  }
}

/**
 * Initiates purchase of fuel to fill the tank to maximum capacity.
 * Calculates amount needed, shows confirmation dialog with cost breakdown, and processes purchase.
 *
 * Purchase Flow:
 * 1. Calculate fuel needed (maxFuel - currentFuel)
 * 2. Check if already full (early exit if needed = 0)
 * 3. Calculate total cost (needed × current price)
 * 4. Show confirmation dialog with purchase details
 * 5. Process API purchase if confirmed
 * 6. Trigger bunker status refresh after successful purchase
 *
 * Side Effects:
 * - Shows confirmation dialog (blocks until user responds)
 * - Makes API call to purchase fuel
 * - Updates UI via debounced bunker status refresh
 * - Shows success/error feedback messages
 *
 * @async
 * @returns {Promise<void>}
 *
 * @example
 * // User clicks "Buy Fuel" button
 * buyMaxFuel();
 * // Shows dialog: "Purchase 2,500t fuel for $1,000,000?"
 */
export async function buyMaxFuel() {
  // Check if capacity values are loaded from server
  if (maxFuel === 0 || maxCO2 === 0) {
    showSideNotification('⛽ Storage capacity not yet loaded - please wait', 'error');
    return;
  }

  // Frontend is DUMB - only use prices from Header (provided by Backend via WebSocket)
  // Backend is SMART - handles all fallback logic (last price, discounted prices, validation)

  const fuelNeeded = Math.ceil(Math.max(0, maxFuel - currentFuel));
  console.log(`[Bunker] Tank status - maxFuel: ${maxFuel}t, currentFuel: ${currentFuel}t, fuelNeeded: ${fuelNeeded}t`);

  if (fuelNeeded === 0) {
    showSideNotification('⛽ Fuel tank is already full!', 'info');
    return;
  }

  // Get CURRENT cash from cache (not stale module variable)
  const actualCash = window.updateDataCache?.bunker?.cash || currentCash;

  // Get current price from header display (provided by Backend via WebSocket)
  // Backend handles: TimeSlot fallback, discounted prices, validation
  const fuelPriceDisplay = document.getElementById('fuelPriceDisplay');
  let displayedPrice = 0;
  let hasDiscount = false;
  let discountPercentage = 0;

  if (fuelPriceDisplay && fuelPriceDisplay.textContent) {
    // Parse "$576/t -20%" format
    const text = fuelPriceDisplay.textContent;
    const priceStart = text.indexOf('$') + 1;
    const priceEnd = text.indexOf('/t');
    if (priceStart > 0 && priceEnd > priceStart) {
      displayedPrice = parseInt(text.substring(priceStart, priceEnd));
      const discountStart = text.indexOf('-');
      const discountEnd = text.indexOf('%');
      if (discountStart > -1 && discountEnd > discountStart) {
        hasDiscount = true;
        discountPercentage = parseInt(text.substring(discountStart + 1, discountEnd));
      }
    }
  }

  // Validation: Price MUST be available from Backend
  if (displayedPrice === 0) {
    console.error('[Purchase Fuel] Price not available from Header - Backend has not sent prices yet');
    showSideNotification('⛽ Price data not yet loaded - please wait for Backend', 'error');
    return;
  }

  const eventDiscount = hasDiscount ? { percentage: discountPercentage, type: 'fuel' } : null;

  // Determine price color class (same logic as header)
  let priceColorClass = '';
  if (displayedPrice >= 800) {
    priceColorClass = 'fuel-red';
  } else if (displayedPrice >= 600) {
    priceColorClass = 'fuel-orange';
  } else if (displayedPrice >= 400) {
    priceColorClass = 'fuel-blue';
  } else if (displayedPrice >= 1) {
    priceColorClass = 'fuel-green';
  }

  if (window.DEBUG_MODE) {
    console.log(`[Bunker] buyMaxFuel - actualCash: $${actualCash}, currentCash (var): $${currentCash}, displayedPrice: $${displayedPrice}/t (base: $${fuelPrice}/t), hasDiscount: ${hasDiscount}, priceColor: ${priceColorClass}`);
  }

  // Calculate how much we can afford
  const maxAffordable = Math.floor(actualCash / displayedPrice);
  const amountToBuy = Math.min(fuelNeeded, maxAffordable);

  if (window.DEBUG_MODE) {
    console.log(`[Bunker] Purchase calculation - fuelNeeded: ${fuelNeeded}t, maxAffordable: ${maxAffordable}t, amountToBuy: ${amountToBuy}t`);
  }

  if (amountToBuy === 0) {
    showSideNotification('⛽ Insufficient funds to purchase fuel', 'error');
    return;
  }

  // Calculate total cost using ACTUAL price (with event discount)
  const totalCost = Math.round(amountToBuy * displayedPrice);
  const isPartialFill = amountToBuy < fuelNeeded;

  const confirmed = await showConfirmDialog({
    title: '⛽ Purchase Fuel',
    message: isPartialFill
      ? `Insufficient funds to fill tank completely. Purchase ${formatNumber(amountToBuy)}t instead?`
      : 'Do you want to purchase fuel to fill your tank?',
    confirmText: 'Buy Fuel',
    details: [
      { label: 'Amount', value: `${formatNumber(amountToBuy)}t${isPartialFill ? ` (of ${formatNumber(fuelNeeded)}t needed)` : ''}` },
      { label: hasDiscount ? `Price (incl -${eventDiscount.percentage}%)` : 'Price', value: `$${formatNumber(displayedPrice)}/t`, className: priceColorClass },
      { label: 'Total Cost', value: `$${formatNumber(totalCost)}` },
      { label: 'Cash after', value: `$${formatNumber(Math.round(actualCash - totalCost))}` }
    ]
  });

  if (!confirmed) {
    return;
  }

  try {
    if (window.DEBUG_MODE) {
      console.log(`[Fuel Purchase] SENDING TO API - amountToBuy: ${amountToBuy}t, Math.round(amountToBuy): ${Math.round(amountToBuy)}t, totalCost: $${totalCost}, actualCash: $${actualCash}, displayedPrice: $${displayedPrice}/t`);
    }

    await apiPurchaseFuel(amountToBuy);

    // Backend broadcasts notification to ALL clients via WebSocket
    // No need to show notification here - all clients will receive it

    // Still update bunker status locally for immediate feedback
    if (window.debouncedUpdateBunkerStatus) {
      window.debouncedUpdateBunkerStatus(500);
    }
  } catch (error) {
    // Show actual error message - don't hide failures!
    console.error('[Fuel Purchase] Error:', error);
    if (window.DEBUG_MODE) {
      console.error('[Fuel Purchase] Error details - amountToBuy:', amountToBuy, 'totalCost:', totalCost, 'actualCash:', actualCash, 'displayedPrice:', displayedPrice);
    }
    showSideNotification(`⛽ Purchase failed: ${error.message}`, 'error');
  }
}

/**
 * Initiates purchase of CO2 quota to fill storage to maximum capacity.
 * Calculates amount needed, shows confirmation dialog with cost breakdown, and processes purchase.
 *
 * Purchase Flow:
 * 1. Calculate CO2 needed (maxCO2 - currentCO2)
 * 2. Check if already full (early exit if needed = 0)
 * 3. Calculate total cost (needed × current price)
 * 4. Show confirmation dialog with purchase details
 * 5. Process API purchase if confirmed
 * 6. Trigger bunker status refresh after successful purchase
 *
 * Side Effects:
 * - Shows confirmation dialog (blocks until user responds)
 * - Makes API call to purchase CO2 quota
 * - Updates UI via debounced bunker status refresh
 * - Shows success/error feedback messages
 *
 * @async
 * @returns {Promise<void>}
 *
 * @example
 * // User clicks "Buy CO2" button
 * buyMaxCO2();
 * // Shows dialog: "Purchase 25,000t CO2 for $175,000?"
 */
export async function buyMaxCO2() {
  // Fetch capacity from API if not loaded yet - NO HARDCODED VALUES!
  if (maxFuel === 0 || maxCO2 === 0) {
    try {
      await updateCapacityFromAPI();
    } catch {
      showSideNotification('💨 Cannot purchase - failed to fetch storage capacity', 'error');
      return;
    }
  }

  // Frontend is DUMB - only use prices from Header (provided by Backend via WebSocket)
  // Backend is SMART - handles all fallback logic (last price, discounted prices, validation)

  const co2Needed = Math.ceil(Math.max(0, maxCO2 - currentCO2));

  if (co2Needed === 0) {
    showSideNotification('💨 CO2 storage is already full!', 'info');
    return;
  }

  // Get CURRENT cash from cache (not stale module variable)
  const actualCash = window.updateDataCache?.bunker?.cash || currentCash;

  // Get current price from header display (provided by Backend via WebSocket)
  // Backend handles: TimeSlot fallback, discounted prices, validation
  const co2PriceDisplay = document.getElementById('co2PriceDisplay');
  let displayedPrice = 0;
  let hasDiscount = false;
  let discountPercentage = 0;

  if (co2PriceDisplay && co2PriceDisplay.textContent) {
    // Parse "$24/t -20%" format
    const text = co2PriceDisplay.textContent;
    const priceStart = text.indexOf('$') + 1;
    const priceEnd = text.indexOf('/t');
    if (priceStart > 0 && priceEnd > priceStart) {
      displayedPrice = parseInt(text.substring(priceStart, priceEnd));
      const discountStart = text.indexOf('-');
      const discountEnd = text.indexOf('%');
      if (discountStart > -1 && discountEnd > discountStart) {
        hasDiscount = true;
        discountPercentage = parseInt(text.substring(discountStart + 1, discountEnd));
      }
    }
  }

  // Validation: Price MUST be available from Backend
  if (displayedPrice === 0) {
    console.error('[Purchase CO2] Price not available from Header - Backend has not sent prices yet');
    showSideNotification('💨 Price data not yet loaded - please wait for Backend', 'error');
    return;
  }

  const eventDiscount = hasDiscount ? { percentage: discountPercentage, type: 'co2' } : null;

  // Determine price color class (same logic as header)
  let priceColorClass = '';
  if (displayedPrice >= 20) {
    priceColorClass = 'co2-red';
  } else if (displayedPrice >= 15) {
    priceColorClass = 'co2-orange';
  } else if (displayedPrice >= 10) {
    priceColorClass = 'co2-blue';
  } else if (displayedPrice >= 1) {
    priceColorClass = 'co2-green';
  }

  // Calculate how much we can afford
  const maxAffordable = Math.floor(actualCash / displayedPrice);
  const amountToBuy = Math.min(co2Needed, maxAffordable);

  if (window.DEBUG_MODE) {
    console.log(`[Bunker] buyMaxCO2 - actualCash: $${actualCash}, maxAffordable: ${maxAffordable}t, amountToBuy: ${amountToBuy}t`);
  }

  if (amountToBuy === 0) {
    showSideNotification('💨 Insufficient funds to purchase CO2', 'error');
    return;
  }

  // Calculate total cost using ACTUAL price (with event discount)
  const totalCost = Math.round(amountToBuy * displayedPrice);
  const isPartialFill = amountToBuy < co2Needed;

  const confirmed = await showConfirmDialog({
    title: '💨 Purchase CO2',
    message: isPartialFill
      ? `Insufficient funds to fill storage completely. Purchase ${formatNumber(amountToBuy)}t instead?`
      : 'Do you want to purchase CO2 to fill your storage?',
    confirmText: 'Buy CO2',
    details: [
      { label: 'Amount', value: `${formatNumber(amountToBuy)}t${isPartialFill ? ` (of ${formatNumber(co2Needed)}t needed)` : ''}` },
      { label: hasDiscount ? `Price (incl -${eventDiscount.percentage}%)` : 'Price', value: `$${formatNumber(displayedPrice)}/t`, className: priceColorClass },
      { label: 'Total Cost', value: `$${formatNumber(totalCost)}` },
      { label: 'Cash after', value: `$${formatNumber(Math.round(actualCash - totalCost))}` }
    ]
  });

  if (!confirmed) {
    return;
  }

  try {
    if (window.DEBUG_MODE) {
      console.log(`[CO2 Purchase] SENDING TO API - amountToBuy: ${amountToBuy}t, Math.round(amountToBuy): ${Math.round(amountToBuy)}t, totalCost: $${totalCost}, actualCash: $${actualCash}, displayedPrice: $${displayedPrice}/t`);
    }

    await apiPurchaseCO2(amountToBuy);

    // Backend broadcasts notification to ALL clients via WebSocket
    // No need to show notification here - all clients will receive it

    // Still update bunker status locally for immediate feedback
    if (window.debouncedUpdateBunkerStatus) {
      window.debouncedUpdateBunkerStatus(500);
    }
  } catch (error) {
    // Show actual error message - don't hide failures!
    console.error('[CO2 Purchase] Error:', error);
    if (window.DEBUG_MODE) {
      console.error('[CO2 Purchase] Error details - amountToBuy:', amountToBuy, 'totalCost:', totalCost, 'actualCash:', actualCash, 'displayedPrice:', displayedPrice);
    }
    showSideNotification(`💨 Purchase failed: ${error.message}`, 'error');
  }
}

/**
 * Returns a snapshot of the current bunker inventory and pricing state.
 * Used by other modules to access bunker data without direct variable access.
 *
 * This function provides read-only access to critical bunker management data,
 * allowing other modules (like vessel-management) to check affordability and
 * inventory levels before performing operations.
 *
 * @returns {Object} Current bunker state object
 * @returns {number} return.currentFuel - Current fuel inventory in tons
 * @returns {number} return.currentCO2 - Current CO2 quota in tons (can be negative)
 * @returns {number} return.currentCash - Current cash balance in dollars
 * @returns {number} return.fuelPrice - Current fuel price per ton in dollars
 * @returns {number} return.co2Price - Current CO2 price per ton in dollars
 * @returns {number} return.maxFuel - Maximum fuel capacity in tons
 * @returns {number} return.maxCO2 - Maximum CO2 capacity in tons
 *
 * @example
 * const bunkerState = getCurrentBunkerState();
 * if (bunkerState.currentCash >= purchaseCost) {
 *   // Proceed with purchase
 * }
 */
export function getCurrentBunkerState() {
  return {
    currentFuel,
    currentCO2,
    currentCash,
    fuelPrice,
    co2Price,
    maxFuel,
    maxCO2
  };
}

/**
 * Updates the current cash balance and refreshes the UI display.
 * Used by other modules to update cash after purchases or vessel operations.
 *
 * This function provides a centralized way to update cash display without
 * directly accessing module-level variables, maintaining encapsulation.
 *
 * Side Effects:
 * - Updates module-level currentCash variable
 * - Updates DOM element with formatted cash value
 *
 * @param {number} newCash - New cash balance in dollars
 *
 * @example
 * // After purchasing a vessel for $5,000,000
 * const currentState = getCurrentBunkerState();
 * updateCurrentCash(currentState.currentCash - 5000000);
 */
export function updateCurrentCash(newCash) {
  currentCash = newCash;
  document.getElementById('cashDisplay').textContent = `$${formatNumber(currentCash)}`;
}

/**
 * Updates the current fuel inventory and refreshes the UI display.
 * Used by other modules to update fuel after vessel departures or refueling.
 *
 * Side Effects:
 * - Updates module-level currentFuel variable
 * - Updates DOM element with formatted fuel value showing current/max
 *
 * @param {number} newFuel - New fuel inventory in tons
 *
 * @example
 * // After vessels depart and use 150 tons of fuel
 * const currentState = getCurrentBunkerState();
 * updateCurrentFuel(currentState.currentFuel - 150);
 */
export function updateCurrentFuel(newFuel) {
  currentFuel = newFuel;
  document.getElementById('fuelDisplay').innerHTML = `${formatNumber(Math.floor(currentFuel))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxFuel))} <b>t</b>`;
}

/**
 * Updates the current CO2 quota inventory and refreshes the UI display.
 * Handles negative values (quota overage) with special formatting.
 *
 * Side Effects:
 * - Updates module-level currentCO2 variable
 * - Updates DOM element with formatted CO2 value showing current/max
 * - Displays negative sign prefix when quota is exceeded
 *
 * @param {number} newCO2 - New CO2 quota in tons (can be negative)
 *
 * @example
 * // After vessels depart and emit 300 tons of CO2
 * const currentState = getCurrentBunkerState();
 * updateCurrentCO2(currentState.currentCO2 - 300);
 * // Display might show: "-50 t / 55,000 t" if player exceeded quota
 */
export function updateCurrentCO2(newCO2) {
  currentCO2 = newCO2;
  if (currentCO2 < 0) {
    document.getElementById('co2Display').innerHTML = `-${formatNumber(Math.floor(Math.abs(currentCO2)))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxCO2))} <b>t</b>`;
  } else {
    document.getElementById('co2Display').innerHTML = `${formatNumber(Math.floor(currentCO2))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxCO2))} <b>t</b>`;
  }
}
