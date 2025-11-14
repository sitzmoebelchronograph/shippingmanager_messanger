/**
 * @fileoverview Anchor Point API Routes
 *
 * This module provides HTTP endpoints for anchor point management including
 * price retrieval and purchasing of anchor points.
 *
 * Key Features:
 * - Fetch current anchor point price and construction duration
 * - Purchase anchor points (1-10 at a time, all built in parallel)
 * - Support for auto-purchase autopilot feature
 *
 * @requires express - Router and middleware
 * @requires ../utils/api - API helper function (apiCall)
 * @module server/routes/anchor
 */

const express = require('express');
const validator = require('validator');
const { apiCall, getUserId } = require('../utils/api');
const { broadcastToUser } = require('../websocket');
const logger = require('../utils/logger');
const { saveSettings } = require('../settings-schema');

const router = express.Router();

/**
 * GET /api/anchor-point/get-price - Fetches current anchor point price and construction duration.
 * Returns: { price, duration, reset_price }
 */
router.get('/anchor-point/get-price', async (req, res) => {
  try {
    const data = await apiCall('/anchor-point/get-anchor-price', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting anchor point price:', error);
    res.status(500).json({ error: 'Failed to retrieve anchor point price' });
  }
});

/**
 * GET /api/anchor/get-price - Simplified endpoint for purchase dialog
 * Returns price, user cash, and anchor_next_build timer from /game/index
 */
router.get('/anchor/get-price', async (req, res) => {
  try {
    // Fetch price data
    const priceData = await apiCall('/anchor-point/get-anchor-price', 'POST', {});

    // Fetch anchor timer from /game/index
    const gameData = await apiCall('/game/index', 'POST', {});
    const anchorNextBuild = gameData.data?.user_settings?.anchor_next_build || null;

    res.json({
      success: true,
      price: priceData.data.price,
      duration: priceData.data.duration,
      cash: priceData.user.cash,
      anchor_next_build: anchorNextBuild
    });
  } catch (error) {
    logger.error('[Anchor] Get price failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/anchor/purchase - Simplified purchase endpoint
 */
router.post('/anchor/purchase', express.json(), async (req, res) => {
  try {
    const { amount } = req.body;

    // Validate amount: must be integer between 1-10
    if (!amount || !Number.isInteger(amount) || amount < 1 || amount > 10) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount. Must be an integer between 1 and 10'
      });
    }

    logger.debug(`[${new Date().toISOString()}] [Anchor] Purchase request: amount=${amount}`);

    // Fetch price before purchase for audit log
    const priceData = await apiCall('/anchor-point/get-anchor-price', 'POST', {});

    // Validate price data - FAIL LOUD if missing
    if (!priceData.data || priceData.data.price === undefined || priceData.data.price === null) {
      throw new Error('API response missing anchor price data');
    }

    const price = priceData.data.price;
    const totalCost = price * amount;

    const purchaseData = await apiCall('/anchor-point/purchase-anchor-points', 'POST', { amount });

    if (purchaseData.error) {
      logger.error(`[${new Date().toISOString()}] [Anchor] Game API returned error:`, JSON.stringify(purchaseData.error, null, 2));
      return res.json({
        success: false,
        error: purchaseData.error.error || 'Purchase failed'
      });
    }

    if (!purchaseData.data?.success) {
      logger.error(`[${new Date().toISOString()}] [Anchor] Purchase not successful, data:`, JSON.stringify(purchaseData.data, null, 2));
      return res.json({
        success: false,
        error: 'Purchase not successful'
      });
    }

    // Fetch updated settings to get anchor_next_build timestamp and broadcast updates
    const userId = getUserId();
    if (userId) {
      // AUDIT LOG: Manual anchor point purchase
      const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');
      await auditLog(
        userId,
        CATEGORIES.ANCHOR,
        'Manual Anchor Purchase',
        `Purchased ${amount} anchor point(s) for ${formatCurrency(totalCost)}`,
        {
          amount: amount,
          price_per_anchor: price,
          total_cost: totalCost,
          duration: priceData.data.duration
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
      try {
        const settingsData = await apiCall('/user/get-user-settings', 'POST', {});
        const anchorNextBuild = settingsData.data?.anchor_next_build;

        // Store pending anchor points count in settings (both RAM and disk)
        const state = require('../state');
        const settings = state.getSettings(userId);
        settings.pendingAnchorPoints = amount;
        settings.anchorNextBuild = anchorNextBuild;
        state.updateSettings(userId, settings);
        await saveSettings(userId, settings);

        if (anchorNextBuild) {
          // Broadcast timer to all connected clients
          broadcastToUser(userId, 'anchor_purchase_timer', {
            anchor_next_build: anchorNextBuild,
            pending_amount: amount
          });
        }

        // Fetch updated bunker/user data to broadcast header updates
        const gameData = await apiCall('/game/index', 'POST', {});

        // Update bunker state with fresh data
        if (gameData.data?.bunker) {
          const bunkerData = gameData.data.bunker;
          state.updateBunkerState(userId, {
            fuel: bunkerData.fuel,
            co2: bunkerData.co2,
            cash: gameData.data.company?.cash || gameData.user?.cash,
            maxFuel: bunkerData.max_fuel,
            maxCO2: bunkerData.max_co2
          });

          // Broadcast bunker update to update header
          broadcastToUser(userId, 'bunker_update', {
            fuel: bunkerData.fuel,
            co2: bunkerData.co2,
            cash: gameData.data.company?.cash || gameData.user?.cash,
            maxFuel: bunkerData.max_fuel,
            maxCO2: bunkerData.max_co2
          });
        }

        // Broadcast anchor update to update header (Total/Free/Pending)
        if (gameData.data?.anchor_points !== undefined) {
          const maxAnchorPoints = gameData.data.user_settings.anchor_points;
          const allVessels = gameData.data.user_vessels;
          const deliveredVessels = allVessels.filter(v => v.status !== 'pending').length;
          const pendingVessels = allVessels.filter(v => v.status === 'pending').length;
          const availableCapacity = maxAnchorPoints - deliveredVessels - pendingVessels;

          // Use stored pending amount from settings
          // (using anchorNextBuild from outer scope - already loaded on line 136)
          const now = Math.floor(Date.now() / 1000);
          const pendingAnchorPoints = (anchorNextBuild && anchorNextBuild > now) ? amount : 0;

          broadcastToUser(userId, 'anchor_update', {
            anchor: {
              max: maxAnchorPoints,
              available: availableCapacity,
              pending: pendingAnchorPoints
            }
          });
        }

        // Trigger Harbor Map refresh (ports purchased - anchors enable more ports)
        const { broadcastHarborMapRefresh } = require('../websocket');
        if (broadcastHarborMapRefresh) {
          broadcastHarborMapRefresh(userId, 'ports_purchased', {
            count: amount
          });
        }

        // Success notification handled by frontend (anchor-purchase.js)

      } catch (error) {
        logger.error('[Anchor] Failed to fetch updates for broadcast:', error);
        // Continue anyway - purchase was successful
      }
    }

    res.json({
      success: true,
      data: purchaseData.data
    });

  } catch (error) {
    logger.error('[Anchor] Purchase failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/anchor/reset-timing - Reset anchor timer (instant completion exploit)
 */
router.post('/anchor/reset-timing', async (req, res) => {
  try {
    const resetData = await apiCall('/anchor-point/reset-anchor-timing', 'POST', undefined);

    if (resetData.error) {
      return res.json({
        success: false,
        error: resetData.error
      });
    }

    if (!resetData.data?.success) {
      return res.json({
        success: false,
        error: 'Reset not successful'
      });
    }

    res.json({
      success: true,
      data: resetData.data
    });

  } catch (error) {
    logger.error('[Anchor] Reset timing failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/anchor-point/purchase - Purchases anchor points.
 * Validates amount (1-10), checks cash availability, and purchases.
 * Updates settings with purchase information for pending calculation.
 */
router.post('/anchor-point/purchase', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount < 1 || amount > 10) {
    return res.status(400).json({ error: 'Invalid amount (must be 1-10)' });
  }

  try {
    const userId = getUserId();
    const state = require('../state');

    // Get current price
    const priceData = await apiCall('/anchor-point/get-anchor-price', 'POST', {});
    const price = priceData.data.price;
    const totalCost = price * amount;

    // Check if user has enough cash
    const bunker = state.getBunkerState(userId);
    if (totalCost > bunker.cash) {
      if (userId) {
        broadcastToUser(userId, 'user_action_notification', {
          type: 'error',
          message: `⚓ <strong>Not enough cash!</strong><br><br>Cost: $${totalCost.toLocaleString()}<br>Your cash: $${bunker.cash.toLocaleString()}<br>Missing: $${(totalCost - bunker.cash).toLocaleString()}`
        });
      }
      return res.status(400).json({ error: 'Not enough cash' });
    }

    // Purchase anchor points
    const purchaseData = await apiCall('/anchor-point/purchase-anchor-points', 'POST', { amount });

    if (purchaseData.data?.success) {
      logger.info(`[Manual Anchor Purchase] User bought ${amount} anchor point(s) @ $${price.toLocaleString()}/point = $${totalCost.toLocaleString()}`);

      // Broadcast success notification
      if (userId) {
        // Success notification handled by frontend (anchor-purchase.js)

        // Update bunker cash (no API return for updated user data, so we estimate)
        broadcastToUser(userId, 'bunker_update', {
          fuel: bunker.fuel,
          co2: bunker.co2,
          cash: bunker.cash - totalCost,
          maxFuel: bunker.maxFuel,
          maxCO2: bunker.maxCO2
        });
      }
    }

    res.json(purchaseData);
  } catch (error) {
    logger.error('Error purchasing anchor points:', error);

    const userId = getUserId();
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⚓ <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to purchase anchor points' });
  }
});

module.exports = router;
