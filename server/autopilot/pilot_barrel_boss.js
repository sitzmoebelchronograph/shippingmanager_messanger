/**
 * @fileoverview Barrel Boss - Auto-Rebuy Fuel Pilot
 *
 * Automatically purchases fuel when price is below threshold and bunker has space.
 * NO COOLDOWNS - purchases immediately when conditions are met.
 *
 * @module server/autopilot/pilot_barrel_boss
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Auto-rebuy fuel for a single user with intelligent threshold checking.
 * NO COOLDOWN - purchases whenever price is good and space available.
 *
 * Decision Logic:
 * 1. Fetches current bunker state and prices
 * 2. Checks if price <= threshold (uses alert threshold or custom)
 * 3. Verifies cash balance >= minimum cash requirement
 * 4. Calculates available space and affordable amount
 * 5. Purchases fuel up to bunker capacity or cash limit
 * 6. Broadcasts purchase event and updated bunker state
 *
 * Threshold Selection:
 * - If autoRebuyFuelUseAlert=true: uses fuelThreshold (alert threshold)
 * - If autoRebuyFuelUseAlert=false: uses autoRebuyFuelThreshold (custom)
 *
 * Safety Features:
 * - Respects minimum cash balance (won't buy if cash < minCash)
 * - Uses Math.ceil to always fill bunker completely
 * - Updates state immediately to prevent duplicate purchases
 *
 * API Interactions:
 * - Calls gameapi.fetchBunkerState() for current levels
 * - Calls gameapi.purchaseFuel() to execute purchase
 * - Broadcasts 'fuel_purchased' and 'bunker_update' events
 *
 * @async
 * @param {Object|null} bunkerState - Optional pre-fetched bunker state to avoid duplicate API calls
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all header data
 * @returns {Promise<void>}
 */
async function autoRebuyFuel(bunkerState = null, autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[Auto-Rebuy Fuel] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  // Check settings
  const settings = state.getSettings(userId);
  if (!settings.autoRebuyFuel) {
    logger.debug('[Auto-Rebuy Fuel] Feature disabled in settings');
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

    logger.debug(`[Auto-Rebuy Fuel] Check: Enabled=${settings.autoRebuyFuel}, Price=${prices.fuel}, Bunker=${bunker.fuel.toFixed(1)}/${bunker.maxFuel}t`);

    // Check if prices have been fetched yet
    if (!prices.fuel || prices.fuel === 0) {
      logger.debug('[Auto-Rebuy Fuel] No price data available yet');
      return;
    }

    // Determine threshold (use custom or alert threshold)
    const threshold = settings.autoRebuyFuelUseAlert
      ? settings.fuelThreshold
      : settings.autoRebuyFuelThreshold;

    logger.debug(`[Auto-Rebuy Fuel] Threshold check: Price $${prices.fuel}/t vs Threshold $${threshold}/t (UseAlert=${settings.autoRebuyFuelUseAlert})`);

    // Check if price is at or below threshold
    if (prices.fuel > threshold) {
      logger.debug(`[Auto-Rebuy Fuel] Price too high: $${prices.fuel}/t > $${threshold}/t threshold`);
      return;
    }

    // Check if bunker has space
    const availableSpace = bunker.maxFuel - bunker.fuel;
    if (availableSpace < 0.5) {
      logger.debug('[Auto-Rebuy Fuel] Bunker full');
      return; // Bunker full
    }

    // Fill to max capacity - use Math.ceil to always buy enough to fill completely
    const amountNeeded = Math.ceil(availableSpace);

    // Calculate how much we can buy while keeping minCash reserve
    const minCash = settings.autoRebuyFuelMinCash;
    if (minCash === undefined || minCash === null) {
      logger.error('[Auto-Rebuy Fuel] ERROR: autoRebuyFuelMinCash setting is missing!');
      return;
    }
    const cashAvailable = Math.max(0, bunker.cash - minCash);
    const maxAffordable = Math.floor(cashAvailable / prices.fuel);

    // Buy as much as we can (limited by space or money)
    const amountToBuy = Math.min(amountNeeded, maxAffordable);

    logger.debug(`[Auto-Rebuy Fuel] Calculations: Space=${availableSpace.toFixed(1)}t, Cash=$${bunker.cash.toLocaleString()}, MinCash=$${minCash.toLocaleString()}, Available=$${cashAvailable.toLocaleString()}, MaxAffordable=${maxAffordable}t, ToBuy=${amountToBuy}t`);

    if (amountToBuy <= 0) {
      logger.warn(`[Auto-Rebuy Fuel] Cannot buy: Not enough cash after keeping minimum reserve`);
      return;
    }

    const totalCost = amountToBuy * prices.fuel;
    const cashAfterPurchase = bunker.cash - totalCost;
    logger.debug(`[Auto-Rebuy Fuel] Purchasing ${amountToBuy}t @ $${prices.fuel}/t = $${totalCost.toLocaleString()} (Cash after: $${cashAfterPurchase.toLocaleString()})`);
    logger.debug(`[Auto-Rebuy Fuel] Current bunker state BEFORE purchase: Cash=$${bunker.cash.toLocaleString()}, Fuel=${bunker.fuel.toFixed(1)}t/${bunker.maxFuel}t`);

    // Purchase fuel - pass the price so cost can be calculated
    const result = await gameapi.purchaseFuel(amountToBuy, prices.fuel);

    logger.debug(`[Auto-Rebuy Fuel] Purchase successful, API returned: newTotal=${result.newTotal.toFixed(1)}t, cost=$${result.cost.toLocaleString()}`);

    // Update bunker state
    bunker.fuel = result.newTotal;
    bunker.cash -= result.cost;
    state.updateBunkerState(userId, bunker);

    // Broadcast success
    if (broadcastToUser) {
      logger.debug(`[Auto-Rebuy Fuel] Broadcasting fuel_purchased event (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);
      broadcastToUser(userId, 'fuel_purchased', {
        amount: amountToBuy,
        price: prices.fuel,
        newTotal: result.newTotal,
        cost: result.cost
      });

      // Broadcast updated bunker state (fuel AND cash changed)
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });
    }

    logger.info(`[Auto-Rebuy Fuel] Purchased ${amountToBuy}t @ $${prices.fuel}/t (New total: ${result.newTotal.toFixed(1)}t)`);

    // Log to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-Fuel',
      `${amountToBuy}t @ ${formatCurrency(prices.fuel)}/t | -${formatCurrency(result.cost)}`,
      {
        amount: amountToBuy,
        price: prices.fuel,
        totalCost: result.cost,
        newTotal: result.newTotal
      },
      'SUCCESS',
      SOURCES.AUTOPILOT
    );

    // Update all header data and badges
    await tryUpdateAllData();

  } catch (error) {
    logger.error('[Auto-Rebuy Fuel] Error:', error.message);

    // Log error to autopilot logbook (exclude stack trace for expected errors)
    const isExpectedError = error.message === 'not_enough_cash' || error.message === 'insufficient_funds';
    const details = isExpectedError
      ? { error: error.message }
      : { error: error.message, stack: error.stack };

    await auditLog(
      userId,
      CATEGORIES.BUNKER,
      'Auto-Fuel',
      `Purchase failed: ${error.message}`,
      details,
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoRebuyFuel
};
