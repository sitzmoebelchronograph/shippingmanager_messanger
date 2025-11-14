/**
 * @fileoverview Atmosphere Broker - Auto-Rebuy CO2 Pilot
 *
 * Automatically purchases CO2 when price is below threshold and bunker has space.
 * NO COOLDOWNS - purchases immediately when conditions are met.
 *
 * @module server/autopilot/pilot_atmosphere_broker
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Auto-rebuy CO2 for a single user with intelligent threshold checking.
 * NO COOLDOWN - purchases whenever price is good and space available.
 *
 * Decision Logic:
 * 1. Fetches current bunker state and prices
 * 2. Checks if price <= threshold (uses alert threshold or custom)
 * 3. Verifies cash balance >= minimum cash requirement
 * 4. Calculates available space and affordable amount
 * 5. Purchases CO2 up to bunker capacity or cash limit
 * 6. Broadcasts purchase event and updated bunker state
 *
 * Threshold Selection:
 * - If autoRebuyCO2UseAlert=true: uses co2Threshold (alert threshold)
 * - If autoRebuyCO2UseAlert=false: uses autoRebuyCO2Threshold (custom)
 *
 * Safety Features:
 * - Respects minimum cash balance (won't buy if cash < minCash)
 * - Uses Math.ceil to always fill bunker completely
 * - Updates state immediately to prevent duplicate purchases
 *
 * API Interactions:
 * - Calls gameapi.fetchBunkerState() for current levels
 * - Calls gameapi.purchaseCO2() to execute purchase
 * - Broadcasts 'co2_purchased' and 'bunker_update' events
 *
 * @async
 * @param {Object|null} bunkerState - Optional pre-fetched bunker state to avoid duplicate API calls
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoRebuyCO2(bunkerState = null, autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[Auto-Rebuy CO2] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  // Check settings
  const settings = state.getSettings(userId);
  if (!settings.autoRebuyCO2) {
    logger.debug('[Auto-Rebuy CO2] Feature disabled in settings');
    return;
  }

  try {
    // Get current state (use provided state or fetch fresh)
    const bunker = bunkerState || await gameapi.fetchBunkerState();
    state.updateBunkerState(userId, bunker);

    // Broadcast bunker state to all clients
    if (broadcastToUser) {
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });
    }

    const prices = state.getPrices(userId);

    logger.debug(`[Auto-Rebuy CO2] Check: Enabled=${settings.autoRebuyCO2}, Price=${prices.co2}, Bunker=${bunker.co2.toFixed(1)}/${bunker.maxCO2}t`);

    // Check if prices have been fetched yet
    if (!prices.co2 || prices.co2 === 0) {
      logger.debug('[Auto-Rebuy CO2] No price data available yet');
      return;
    }

    // Determine threshold (use custom or alert threshold)
    const threshold = settings.autoRebuyCO2UseAlert
      ? settings.co2Threshold
      : settings.autoRebuyCO2Threshold;

    logger.debug(`[Auto-Rebuy CO2] Threshold check: Price $${prices.co2}/t vs Threshold $${threshold}/t (UseAlert=${settings.autoRebuyCO2UseAlert})`);

    // Check if price is at or below threshold
    if (prices.co2 > threshold) {
      logger.debug(`[Auto-Rebuy CO2] Price too high: $${prices.co2}/t > $${threshold}/t threshold`);
      return;
    }

    // Check if bunker has space
    const availableSpace = bunker.maxCO2 - bunker.co2;
    if (availableSpace < 0.5) {
      logger.debug('[Auto-Rebuy CO2] Bunker full');
      return; // Bunker full
    }

    // Fill to max capacity - use Math.ceil to always buy enough to fill completely
    const amountNeeded = Math.ceil(availableSpace);

    // Calculate how much we can buy while keeping minCash reserve
    const minCash = settings.autoRebuyCO2MinCash;
    if (minCash === undefined || minCash === null) {
      logger.error('[Auto-Rebuy CO2] ERROR: autoRebuyCO2MinCash setting is missing!');
      return;
    }
    const cashAvailable = Math.max(0, bunker.cash - minCash);
    const maxAffordable = Math.floor(cashAvailable / prices.co2);

    // Buy as much as we can (limited by space or money)
    const amountToBuy = Math.min(amountNeeded, maxAffordable);

    logger.debug(`[Auto-Rebuy CO2] Calculations: Space=${availableSpace.toFixed(1)}t, Cash=$${bunker.cash.toLocaleString()}, MinCash=$${minCash.toLocaleString()}, Available=$${cashAvailable.toLocaleString()}, MaxAffordable=${maxAffordable}t, ToBuy=${amountToBuy}t`);

    if (amountToBuy <= 0) {
      logger.warn(`[Auto-Rebuy CO2] Cannot buy: Not enough cash after keeping minimum reserve`);
      return;
    }

    const totalCost = amountToBuy * prices.co2;
    const cashAfterPurchase = bunker.cash - totalCost;
    logger.debug(`[Auto-Rebuy CO2] Purchasing ${amountToBuy}t @ $${prices.co2}/t = $${totalCost.toLocaleString()} (Cash after: $${cashAfterPurchase.toLocaleString()})`);

    // Purchase CO2 - pass the price so cost can be calculated
    const result = await gameapi.purchaseCO2(amountToBuy, prices.co2);

    // Update bunker state
    bunker.co2 = result.newTotal;
    bunker.cash -= result.cost;
    state.updateBunkerState(userId, bunker);

    // Broadcast success
    if (broadcastToUser) {
      logger.debug(`[Auto-Rebuy CO2] Broadcasting co2_purchased event (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);
      broadcastToUser(userId, 'co2_purchased', {
        amount: amountToBuy,
        price: prices.co2,
        newTotal: result.newTotal,
        cost: result.cost
      });

      // Broadcast updated bunker state (CO2 AND cash changed)
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });
    }

    logger.info(`[Auto-Rebuy CO2] Purchased ${amountToBuy}t @ $${prices.co2}/t (New total: ${result.newTotal.toFixed(1)}t)`);

    // Log to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-CO2',
      `${amountToBuy}t @ ${formatCurrency(prices.co2)}/t | -${formatCurrency(result.cost)}`,
      {
        amount: amountToBuy,
        price: prices.co2,
        totalCost: result.cost,
        newTotal: result.newTotal
      },
      'SUCCESS',
      SOURCES.AUTOPILOT
    );

    // Update all header data and badges
    await tryUpdateAllData();

  } catch (error) {
    logger.error('[Auto-Rebuy CO2] Error:', error.message);

    // Log error to autopilot logbook (exclude stack trace for expected errors)
    const isExpectedError = error.message === 'not_enough_cash' || error.message === 'insufficient_funds';
    const details = isExpectedError
      ? { error: error.message }
      : { error: error.message, stack: error.stack };

    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-CO2',
      `Purchase failed: ${error.message}`,
      details,
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoRebuyCO2
};
