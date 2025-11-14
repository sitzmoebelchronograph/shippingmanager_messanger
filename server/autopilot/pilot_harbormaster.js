/**
 * @fileoverview Harbormaster - Auto-Purchase Anchor Points Pilot
 *
 * Automatically purchases anchor points respecting construction timer.
 * Checks construction timer, price threshold, and cash availability before purchase.
 *
 * @module server/autopilot/pilot_harbormaster
 */

const state = require('../state');
const logger = require('../utils/logger');
const { apiCall } = require('../utils/api');
const { saveSettings } = require('../settings-schema');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

// WebSocket broadcasting function (injected)
let broadcastToUser = null;

/**
 * Sets the broadcast function (called by autopilot.js)
 */
function setBroadcastFunction(broadcastFn) {
  broadcastToUser = broadcastFn;
}

/**
 * Auto-purchase anchor points respecting construction timer.
 * Checks construction timer, price threshold, and cash availability before purchase.
 *
 * Construction Timer Safety:
 * - CRITICAL: Buying while construction is active resets the timer to 0
 * - This wastes money and time (construction starts over from 0%)
 * - Only buy when anchor_next_build is null or timestamp < now
 * - Respects same timer logic as UI buttons
 *
 * @async
 * @param {number} userId - User ID for state management
 * @returns {Promise<void>}
 */
async function autoAnchorPointPurchase(userId) {
  // Pause check removed - handled by scheduler to avoid circular dependency

  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoAnchorPointEnabled) {
    logger.debug('[Auto-Anchor Purchase] Feature disabled in settings');
    return;
  }

  try {
    // CRITICAL: Check if anchor point is currently under construction
    // GAME BUG: Buying while timer is active will RESET the timer to 0 and STEAL your money!
    const headerData = state.getHeaderData(userId);
    const anchorNextBuild = headerData?.anchor?.nextBuild;
    const now = Math.floor(Date.now() / 1000);

    logger.debug(`[Auto-Anchor] Timer Check - anchorNextBuild: ${anchorNextBuild}, now: ${now}`);

    // STRICT CHECK: If timer exists AND is in the future, DO NOT BUY
    if (anchorNextBuild !== null && anchorNextBuild !== undefined && anchorNextBuild > now) {
      const remaining = anchorNextBuild - now;
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      logger.warn(`[Auto-Anchor] TIMER ACTIVE - Construction in progress (${minutes}m ${seconds}s remaining)`);
      logger.warn(`[Auto-Anchor] BLOCKED - Cannot purchase while timer is running (Game Bug: would steal money!)`);
      return;
    }

    logger.debug(`[Auto-Anchor] Timer Check Passed - Safe to proceed with purchase`);


    const bunker = state.getBunkerState(userId);

    // Fetch current price
    const priceData = await apiCall('/anchor-point/get-anchor-price', 'POST', {});
    const price = priceData.data.price;

    // IMPORTANT: Game API only accepts amount: 1 or amount: 10
    const amount = settings.autoAnchorPointAmount !== undefined ? settings.autoAnchorPointAmount : 1;

    logger.debug(`[Auto-Anchor] Checking purchase conditions - Price: $${price.toLocaleString()}/point, Amount: ${amount} point, Current Cash: $${bunker.cash.toLocaleString()}`);

    // Calculate total cost
    const totalCost = price * amount;

    // Check minimum cash requirement FIRST
    const minCash = settings.autoAnchorPointMinCash !== undefined ? settings.autoAnchorPointMinCash : 0;

    // Only buy if we are ABOVE the minimum cash limit
    if (bunker.cash <= minCash) {
      logger.debug(`[Auto-Anchor] Skipping: Cash $${bunker.cash.toLocaleString()} is at or below minimum $${minCash.toLocaleString()}`);
      return;
    }

    // Check if we have enough cash for the purchase
    if (totalCost > bunker.cash) {
      logger.warn(`[Auto-Anchor] Insufficient funds: Need $${totalCost.toLocaleString()}, Have $${bunker.cash.toLocaleString()}`);
      return;
    }

    // Calculate remaining cash after purchase
    const remainingCash = bunker.cash - totalCost;

    // Only buy if remaining cash stays above minimum
    if (remainingCash < minCash) {
      logger.warn(`[Auto-Anchor] Skipping purchase: Would leave $${remainingCash.toLocaleString()}, need to keep minimum $${minCash.toLocaleString()}`);
      return;
    }

    logger.debug(`[Auto-Anchor] Purchasing ${amount} anchor point(s) @ $${price.toLocaleString()}/point = $${totalCost.toLocaleString()}`);

    // Purchase anchor points
    const purchaseData = await apiCall('/anchor-point/purchase-anchor-points', 'POST', { amount });

    // Check for errors
    if (purchaseData.error) {
      logger.debug(`[Auto-Anchor] Purchase failed: ${purchaseData.error.error || 'Unknown error'}`);
      return;
    }

    // Check if purchase was not successful
    if (!purchaseData.data?.success) {
      logger.debug(`[Auto-Anchor] Purchase not successful (API returned success: false)`);
      return;
    }

    // Update bunker cash
    bunker.cash -= totalCost;
    state.updateBunkerState(userId, bunker);

    // Store pending anchor points count in settings (both RAM and disk)
    const currentSettings = state.getSettings(userId);
    currentSettings.pendingAnchorPoints = amount;
    state.updateSettings(userId, currentSettings);
    await saveSettings(userId, currentSettings);

    logger.info(`[Auto-Anchor] Success! Purchased ${amount} anchor point(s) for $${totalCost.toLocaleString()}. Construction timer started.`);

    // Log to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.ANCHOR,
      'Auto-Anchor',
      `${amount} point${amount > 1 ? 's' : ''} | -${formatCurrency(totalCost)}`,
      {
        amount,
        pricePerPoint: price,
        totalCost,
        remainingCash: bunker.cash,
        constructionStarted: true
      },
      'SUCCESS',
      SOURCES.AUTOPILOT
    );

    // Broadcast success notification
    if (broadcastToUser) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">⚓ Anchor Point Purchase</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Amount:</span>
              <span><strong>${amount} point${amount > 1 ? 's' : ''}</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Price per point:</span>
              <span>$${price.toLocaleString()}</span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px; margin-bottom: 8px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${totalCost.toLocaleString()}</strong></span>
            </div>
            <div style="text-align: center; color: #10b981; font-size: 12px; font-style: italic;">
              ✓ Instantly available
            </div>
          </div>
        `
      });

      // Broadcast updated bunker state (cash decreased)
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });

      // Broadcast anchor update with new pending count
      broadcastToUser(userId, 'anchor_update', {
        pending: amount
      });

      // Send browser notification
      if (settings.enableDesktopNotifications && settings.notifyHarbormaster) {
        broadcastToUser(userId, 'desktop_notification', {
          title: '⚓ Anchorage Chief',
          message: `Purchased ${amount} anchor point${amount > 1 ? 's' : ''} for $${totalCost.toLocaleString()}. Construction started.`,
          type: 'success'
        });
      }
    }

    // Data will be updated by next main loop cycle (no need to call tryUpdateAllData - circular dependency)

  } catch (error) {
    logger.error('[Auto-Anchor] Error:', error.message);

    // Log error to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.ANCHOR,
      'Auto-Anchor',
      `Purchase failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      },
      'ERROR',
      SOURCES.AUTOPILOT
    );
  }
}

module.exports = {
  autoAnchorPointPurchase,
  setBroadcastFunction
};
