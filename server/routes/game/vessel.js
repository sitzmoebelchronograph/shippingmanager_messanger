/**
 * @fileoverview Vessel Management Routes
 *
 * This module provides comprehensive endpoints for vessel operations including:
 * - Listing vessels in harbor
 * - Purchasing and selling vessels
 * - Vessel repairs and maintenance
 * - Vessel renaming
 * - Bulk operations with progress notifications
 *
 * Key Features:
 * - Get vessels in harbor with status and cargo information
 * - Purchase vessels with custom configuration
 * - Sell vessels individually or in bulk
 * - Repair vessels based on wear threshold
 * - Rename vessels
 * - Broadcast notifications for bulk operations
 * - Audit logging for all transactions
 * - WebSocket updates for real-time UI synchronization
 *
 * @requires express - Router and middleware
 * @requires fs - File system operations (promises)
 * @requires validator - Input sanitization
 * @requires ../../utils/api - API helper functions
 * @requires ../../gameapi - Game API interface
 * @requires ../../state - Global state management
 * @requires ../../autopilot - For capacity caching
 * @requires ../../settings-schema - Settings file utilities
 * @requires ../../utils/audit-logger - Transaction logging
 * @requires ../../websocket - WebSocket broadcasting
 * @requires ../../utils/logger - Logging utility
 * @module server/routes/game/vessel
 */

const express = require('express');
const fs = require('fs').promises;
const validator = require('validator');
const { apiCall, apiCallWithRetry, getUserId } = require('../../utils/api');
const gameapi = require('../../gameapi');
const { broadcastToUser } = require('../../websocket');
const logger = require('../../utils/logger');
const autopilot = require('../../autopilot');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../../utils/audit-logger');

const router = express.Router();

/**
 * GET /api/vessel/get-vessels
 * Retrieves all vessels currently in harbor
 *
 * Uses /game/index endpoint to get complete vessel list with status, cargo, maintenance needs, etc.
 * Also caches company_type in local settings for offline access.
 *
 * @route GET /api/vessel/get-vessels
 *
 * @returns {object} Vessel data:
 *   - vessels {array} - All user vessels with full details
 *   - experience_points {number} - Current experience points
 *   - levelup_experience_points {number} - Experience needed for next level
 *   - company_type {object} - Company type configuration
 *
 * @error 500 - Failed to retrieve vessels
 *
 * Side effects:
 * - Caches company_type to local settings file
 */
router.get('/get-vessels', async (req, res) => {
  try {
    const data = await apiCallWithRetry('/game/index', 'POST', {});

    // Cache company_type in local settings for offline access
    const userId = getUserId();
    if (userId && data.user?.company_type) {
      try {
        const { getSettingsFilePath } = require('../../settings-schema');
        const settingsFile = getSettingsFilePath(userId);

        // Read current settings
        const settingsData = await fs.readFile(settingsFile, 'utf8');
        const settings = JSON.parse(settingsData);

        // Update company_type
        settings.company_type = data.user.company_type;

        // Write back to file
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

        logger.debug(`[Vessel API] Cached company_type: ${JSON.stringify(data.user.company_type)}`);
      } catch (cacheError) {
        // Don't fail the request if caching fails
        logger.warn('[Vessel API] Failed to cache company_type:', cacheError.message);
      }
    }

    res.json({
      vessels: data.data.user_vessels,
      experience_points: data.data.experience_points,
      levelup_experience_points: data.data.levelup_experience_points,
      company_type: data.user?.company_type
    });
  } catch (error) {
    logger.error('Error getting vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve vessels' });
  }
});

/**
 * GET /api/vessel/get-all-acquirable
 * Fetches all vessels available for purchase from the marketplace
 *
 * @route GET /api/vessel/get-all-acquirable
 *
 * @returns {object} Acquirable vessels data from game API
 *
 * @error 500 - Failed to retrieve acquirable vessels
 */
router.get('/get-all-acquirable', async (req, res) => {
  try {
    const data = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting acquirable vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve acquirable vessels' });
  }
});

/**
 * POST /api/vessel/get-sell-price
 * Gets the selling price for a vessel
 *
 * Returns the selling price and original price for a user-owned vessel.
 *
 * @route POST /api/vessel/get-sell-price
 * @body {number} vessel_id - ID of the vessel to check price for
 *
 * @returns {object} Selling price data from game API
 *
 * @error 400 - Missing vessel_id
 * @error 500 - Failed to get sell price
 */
router.post('/get-sell-price', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/get-sell-price', 'POST', { vessel_id });
    res.json(data);
  } catch (error) {
    logger.error(`[Get Sell Price] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to get sell price', message: error.message });
  }
});

/**
 * POST /api/vessel/sell-vessels
 * Sells multiple vessels by their IDs
 *
 * Accepts an array of vessel IDs and sells each one individually.
 * Broadcasts notifications and bunker updates to all connected clients.
 *
 * @route POST /api/vessel/sell-vessels
 * @body {array} vessel_ids - Array of vessel IDs to sell
 *
 * @returns {object} Sale results:
 *   - success {boolean} - Operation success
 *   - sold {number} - Number of vessels successfully sold
 *   - errors {array} - Any errors that occurred (optional)
 *
 * @error 400 - Missing or invalid vessel_ids array
 * @error 500 - Failed to sell vessels
 *
 * Side effects:
 * - Broadcasts bunker update (cash increased)
 * - Sends error notifications if sale fails
 */
router.post('/sell-vessels', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids || !Array.isArray(vessel_ids) || vessel_ids.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid vessel_ids array' });
  }

  try {
    const userId = getUserId();

    // Fetch vessel details BEFORE selling to get prices
    let vesselDetails = [];
    const vesselPriceMap = new Map();

    try {
      const gameData = await apiCallWithRetry('/game/index', 'POST', {});
      const allVessels = gameData.data?.vessels || [];
      vesselDetails = allVessels.filter(v => vessel_ids.includes(v.id));

      // Build price map from vessel details (BEFORE selling)
      vesselDetails.forEach(v => {
        if (v.sell_price) {
          vesselPriceMap.set(v.id, v.sell_price);
        }
      });

      logger.debug(`[Vessel Sell] Fetched prices for ${vesselPriceMap.size} vessels before selling`);
    } catch (error) {
      logger.warn('[Vessel Sell] Failed to fetch vessel details for audit log:', error.message);
    }

    let soldCount = 0;
    const errors = [];

    // Sell each vessel individually (API only supports single vessel sales)
    for (const vesselId of vessel_ids) {
      try {
        const data = await apiCall('/vessel/sell-vessel', 'POST', { vessel_id: vesselId });
        if (data.success) {
          soldCount++;

          // Use price from BEFORE selling (from /game/index) or fall back to API response
          const sellPrice = vesselPriceMap.get(vesselId) || data.vessel?.sell_price || 0;

          if (sellPrice === 0) {
            logger.error(`[Vessel Sell] Vessel ${vesselId} sold but no price found (neither in /game/index nor in API response)`);
          } else {
            logger.debug(`[Vessel Sell] Vessel ${vesselId} sold for $${sellPrice.toLocaleString()}`);
          }
        }
      } catch (error) {
        logger.error(`[Vessel Sell] Failed to sell vessel ${vesselId}:`, error.message);
        errors.push({ vesselId, error: error.message });
      }
    }

    // Fetch and broadcast updated bunker state (cash increased)
    try {
      const gameData = await apiCallWithRetry('/game/index', 'POST', {});
      if (gameData.data?.user) {
        const user = gameData.data.user;

        // API doesn't return capacity fields - use cached values from autopilot
        const cachedCapacity = autopilot.getCachedCapacity(userId);

        broadcastToUser(userId, 'bunker_update', {
          fuel: user.fuel / 1000,
          co2: (user.co2 || user.co2_certificate) / 1000,
          cash: user.cash,
          maxFuel: cachedCapacity.maxFuel,
          maxCO2: cachedCapacity.maxCO2
        });
      }
    } catch (error) {
      logger.error('[Vessel Sell] Failed to fetch updated bunker state:', error);
    }

    res.json({
      success: true,
      sold: soldCount,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    logger.error('[Vessel Sell] Error:', error);
    const userId = getUserId();
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⛴️ <strong>Sale Failed</strong><br><br>${safeErrorMessage}`
      });
    }
    res.status(500).json({ error: 'Failed to sell vessels' });
  }
});

/**
 * POST /api/vessel/purchase-vessel
 * Purchases a new vessel with specified configuration
 *
 * Default configuration: 4-blade propeller, optional antifouling, no enhanced deck beams.
 * Validation: vessel_id and name are required fields.
 *
 * @route POST /api/vessel/purchase-vessel
 * @body {number} vessel_id - ID of vessel type to purchase
 * @body {string} name - Name for the new vessel
 * @body {string} [antifouling_model] - Optional antifouling type
 * @body {number} [count] - Number of vessels being purchased (for notification)
 * @body {boolean} [silent] - If true, suppresses notifications
 *
 * @returns {object} Purchase result from game API
 *
 * @error 400 - Invalid vessel_id, name, or other parameters
 * @error 500 - Failed to purchase vessel
 *
 * Side effects:
 * - Sends purchase notification (unless silent)
 * - Updates bunker display (cash decreased)
 * - Updates vessel count badges
 */
router.post('/purchase-vessel', express.json(), async (req, res) => {
  const { vessel_id, name, antifouling_model, count, silent } = req.body;

  // Validate required fields
  if (!vessel_id || !name) {
    return res.status(400).json({ error: 'Missing required fields: vessel_id, name' });
  }

  // Validate vessel_id is a positive integer
  if (!Number.isInteger(vessel_id) || vessel_id <= 0) {
    return res.status(400).json({ error: 'Invalid vessel_id. Must be a positive integer' });
  }

  // Validate name is a string with reasonable length
  if (typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name. Must be a string' });
  }

  if (name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: 'Invalid name length. Must be between 1 and 100 characters' });
  }

  // Validate antifouling_model if provided
  if (antifouling_model !== undefined && antifouling_model !== null && typeof antifouling_model !== 'string') {
    return res.status(400).json({ error: 'Invalid antifouling_model. Must be a string or null' });
  }

  try {
    const userId = getUserId();

    // Fetch vessel price BEFORE purchasing
    let vesselCost = 0;
    try {
      const acquirableData = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});
      const vessels = acquirableData.data?.vessels_for_sale || [];
      const vessel = vessels.find(v => v.id === vessel_id);
      if (vessel && vessel.price) {
        vesselCost = vessel.price;
        logger.debug(`[Vessel Purchase] Fetched price $${vesselCost.toLocaleString()} for vessel ${vessel_id} before purchasing`);
      } else {
        logger.warn(`[Vessel Purchase] Could not find vessel ${vessel_id} in acquirable vessels list (${vessels.length} vessels available)`);
      }
    } catch (priceError) {
      logger.warn('[Vessel Purchase] Failed to fetch vessel price before purchase:', priceError.message);
    }

    const data = await apiCall('/vessel/purchase-vessel', 'POST', {
      vessel_id,
      name,
      adjust_speed: '4_blade_propeller',
      antifouling_model: antifouling_model || null,
      enhanced_deck_beams: 0
    });

    // Broadcast notification to all clients (unless silent=true)
    if (userId && data.user_vessel && !silent) {
      const vesselName = data.user_vessel.name || name;
      const purchaseCount = count || 1;
      const safeVesselName = validator.escape(vesselName);

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `🚢 <strong>Purchase Successful!</strong><br><br>Purchased ${purchaseCount}x ${safeVesselName}`
      });
    }

    // Broadcast bunker update (cash decreased from purchase)
    if (userId && data.user) {
      broadcastToUser(userId, 'bunker_update', {
        cash: data.user.cash
      });
      logger.debug(`[Vessel Purchase] Broadcast cash update: $${data.user.cash.toLocaleString()}`);
    }

    // Broadcast vessel count update (pending vessel added)
    if (userId) {
      try {
        const vesselsResponse = await apiCall('/game/index', 'GET');
        if (vesselsResponse?.vessels) {
          const readyToDepart = vesselsResponse.vessels.filter(v =>
            v.status === 'ready' && v.maintenance > 0
          ).length;
          const atAnchor = vesselsResponse.vessels.filter(v =>
            v.status === 'anchor'
          ).length;
          const pending = vesselsResponse.vessels.filter(v =>
            v.status === 'pending'
          ).length;

          broadcastToUser(userId, 'vessel_count_update', {
            readyToDepart,
            atAnchor,
            pending
          });
          logger.debug(`[Vessel Purchase] Broadcast vessel count update: pending=${pending}`);
        }
      } catch (error) {
        logger.error('[Vessel Purchase] Failed to broadcast vessel count update:', error.message);
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing vessel:', error);

    const userId = getUserId();
    if (userId && !silent) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🚢 <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to purchase vessel' });
  }
});

/**
 * POST /api/vessel/bulk-buy-start
 * Broadcasts bulk buy start to lock buttons across all clients
 *
 * @route POST /api/vessel/bulk-buy-start
 *
 * @returns {object} Success status
 *
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast start
 *
 * Side effects:
 * - Broadcasts bulk_buy_start event to lock UI
 */
router.post('/bulk-buy-start', express.json(), async (req, res) => {
  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    broadcastToUser(userId, 'bulk_buy_start', {});
    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting bulk buy start:', error);
    res.status(500).json({ error: 'Failed to broadcast start' });
  }
});

/**
 * POST /api/vessel/broadcast-purchase-summary
 * Broadcasts a summary notification of vessel purchases to all clients
 *
 * @route POST /api/vessel/broadcast-purchase-summary
 * @body {array} vessels - Array of purchased vessel details
 * @body {number} totalCost - Total cost of all purchases
 *
 * @returns {object} Success status
 *
 * @error 400 - Missing required field: vessels
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast summary
 *
 * Side effects:
 * - Sends formatted purchase summary notification
 * - Logs purchase to audit log
 * - Broadcasts bulk_buy_complete to unlock UI
 * - Triggers harbor map refresh
 */
router.post('/broadcast-purchase-summary', express.json(), async (req, res) => {
  const { vessels, totalCost } = req.body;

  if (!vessels || !Array.isArray(vessels)) {
    return res.status(400).json({ error: 'Missing required field: vessels (array)' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Group vessels by name for display
    const vesselGroups = vessels.reduce((acc, v) => {
      if (!acc[v.name]) {
        acc[v.name] = { name: v.name, quantity: 0, price: v.price, totalPrice: 0 };
      }
      acc[v.name].quantity++;
      acc[v.name].totalPrice += v.price;
      return acc;
    }, {});
    const groupedVessels = Object.values(vesselGroups);

    // Build vessel list HTML with prices
    let vesselListHtml = '';
    if (groupedVessels.length > 5) {
      // If more than 5 types, show scrollable list
      vesselListHtml = '<div style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-right: 5px;"><ul style="margin: 0; padding-left: 20px; text-align: left;">';
      groupedVessels.forEach(v => {
        vesselListHtml += `<li>${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}</li>`;
      });
      vesselListHtml += '</ul></div>';
    } else {
      // If 5 or fewer types, show simple list
      vesselListHtml = '<br>';
      groupedVessels.forEach(v => {
        vesselListHtml += `${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}<br>`;
      });
    }

    const message = `🚢 <strong>Purchased ${vessels.length} vessel${vessels.length > 1 ? 's' : ''}!</strong>${vesselListHtml}Total Cost: $${totalCost.toLocaleString()}`;

    broadcastToUser(userId, 'user_action_notification', {
      type: 'success',
      message
    });

    // AUDIT LOG: Manual vessel purchase - Log matching the notification message
    // (using audit-logger imported at top of file)
    try {
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Vessel Purchase',
        `Purchased ${vessels.length} vessel${vessels.length > 1 ? 's' : ''}! Total Cost: $${totalCost.toLocaleString()}`,
        {
          vessel_count: vessels.length,
          total_cost: totalCost,
          vessels: groupedVessels.map(v => ({
            name: v.name,
            quantity: v.quantity,
            price_per_vessel: v.price,
            total_price: v.totalPrice
          }))
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    } catch (auditError) {
      logger.error('[Vessel Purchase] Audit logging failed:', auditError.message);
    }

    // Broadcast bulk buy complete to unlock buttons
    broadcastToUser(userId, 'bulk_buy_complete', {
      count: vessels.length
    });

    // Trigger Harbor Map refresh (vessels purchased)
    const { broadcastHarborMapRefresh } = require('../../websocket');
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_purchased', {
        count: vessels.length
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting purchase summary:', error);
    res.status(500).json({ error: 'Failed to broadcast summary' });
  }
});

/**
 * POST /api/vessel/broadcast-sale-summary
 * Broadcasts a summary notification of vessel sales to all clients
 *
 * @route POST /api/vessel/broadcast-sale-summary
 * @body {array} vessels - Array of sold vessel details
 * @body {number} totalPrice - Total revenue from sales
 * @body {number} totalVessels - Total number of vessels sold
 *
 * @returns {object} Success status
 *
 * @error 400 - Missing required field: vessels
 * @error 401 - Not authenticated
 * @error 500 - Failed to broadcast summary
 *
 * Side effects:
 * - Sends formatted sale summary notification
 * - Logs sale to audit log
 * - Triggers harbor map refresh
 */
router.post('/broadcast-sale-summary', express.json(), async (req, res) => {
  const { vessels, totalPrice, totalVessels } = req.body;

  if (!vessels || !Array.isArray(vessels)) {
    return res.status(400).json({ error: 'Missing required field: vessels (array)' });
  }

  const userId = getUserId();
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Build vessel list HTML with prices
    let vesselListHtml = '';
    if (vessels.length > 5) {
      // If more than 5, show scrollable list
      vesselListHtml = '<div style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-right: 5px;"><ul style="margin: 0; padding-left: 20px; text-align: left;">';
      vessels.forEach(v => {
        vesselListHtml += `<li>${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}</li>`;
      });
      vesselListHtml += '</ul></div>';
    } else {
      // If 5 or fewer, show simple list
      vesselListHtml = '<br>';
      vessels.forEach(v => {
        vesselListHtml += `${v.quantity}x ${v.name} - $${v.totalPrice.toLocaleString()}<br>`;
      });
    }

    const message = `⛴️ <strong>Sold ${totalVessels} vessel${totalVessels > 1 ? 's' : ''}!</strong>${vesselListHtml}Total Revenue: $${totalPrice.toLocaleString()}`;

    broadcastToUser(userId, 'user_action_notification', {
      type: 'success',
      message
    });

    // AUDIT LOG: Manual vessel sale - Log matching the notification message
    // (using audit-logger imported at top of file)
    try {
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Vessel Sale',
        `Sold ${totalVessels} vessel${totalVessels > 1 ? 's' : ''}! Total Revenue: $${totalPrice.toLocaleString()}`,
        {
          vessel_count: totalVessels,
          total_price: totalPrice,
          vessels: vessels.map(v => ({
            name: v.name,
            quantity: v.quantity,
            price_per_vessel: v.price,
            total_price: v.totalPrice
          }))
        },
        'SUCCESS',
        SOURCES.MANUAL
      );
    } catch (auditError) {
      logger.error('[Vessel Sale] Audit logging failed:', auditError.message);
    }

    // Trigger Harbor Map refresh (vessels sold)
    const { broadcastHarborMapRefresh } = require('../../websocket');
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_sold', {
        count: totalVessels
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error broadcasting sale summary:', error);
    res.status(500).json({ error: 'Failed to broadcast summary' });
  }
});

/**
 * POST /api/vessel/get-repair-preview
 * Gets repair preview with vessel list and costs
 *
 * @route POST /api/vessel/get-repair-preview
 * @body {number} threshold - Wear percentage threshold (0-100)
 *
 * @returns {object} Repair preview:
 *   - vessels {array} - Vessels needing repair with costs
 *   - totalCost {number} - Total repair cost
 *   - cash {number} - User's current cash
 *
 * @error 400 - Invalid threshold
 * @error 500 - Failed to get repair preview
 */
router.post('/get-repair-preview', express.json(), async (req, res) => {
  const { threshold } = req.body;

  if (threshold === null || threshold === undefined || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'Invalid threshold' });
  }

  try {
    // Get all vessels
    const vesselData = await apiCallWithRetry('/game/index', 'POST', {});
    const allVessels = vesselData.data.user_vessels;
    const user = vesselData.user;

    // Filter vessels needing repair
    const vesselsToRepair = allVessels.filter(v => {
      const wear = parseInt(v.wear);
      return wear >= threshold;
    });

    if (vesselsToRepair.length === 0) {
      return res.json({ vessels: [], totalCost: 0, cash: user.cash });
    }

    // Get repair costs
    const vesselIds = vesselsToRepair.map(v => v.id);
    const costData = await gameapi.getMaintenanceCost(vesselIds);

    // Build vessel details with costs
    const vesselDetails = vesselsToRepair.map(vessel => {
      const costVessel = costData.vessels.find(v => v.id === vessel.id);
      const wearMaintenance = costVessel?.maintenance_data?.find(m => m.type === 'wear');
      const cost = wearMaintenance?.price;
      return {
        id: vessel.id,
        name: vessel.name,
        wear: vessel.wear,
        cost: cost
      };
    });

    // Calculate total cost
    const calculatedTotalCost = vesselDetails.reduce((sum, v) => sum + v.cost, 0);
    const finalTotalCost = costData.totalCost > 0 ? costData.totalCost : calculatedTotalCost;

    res.json({
      vessels: vesselDetails,
      totalCost: finalTotalCost,
      cash: user.cash
    });

  } catch (error) {
    logger.error('Error getting repair preview:', error);
    res.status(500).json({ error: 'Failed to get repair preview' });
  }
});

/**
 * POST /api/vessel/bulk-repair
 * Repairs all vessels needing maintenance based on threshold
 *
 * @route POST /api/vessel/bulk-repair
 * @body {number} threshold - Wear percentage threshold (0-100)
 *
 * @returns {object} Repair results:
 *   - count {number} - Number of vessels repaired
 *   - totalCost {number} - Total repair cost
 *   - vessels {array} - Details of repaired vessels
 *
 * @error 400 - Invalid threshold or not enough cash
 * @error 500 - Failed to repair vessels
 *
 * Side effects:
 * - Broadcasts repair start/complete events
 * - Updates bunker display (cash decreased)
 * - Logs repairs to audit log
 * - Sends success/error notifications
 */
router.post('/bulk-repair', express.json(), async (req, res) => {
  const { threshold } = req.body;

  if (!threshold || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'Invalid threshold' });
  }

  try {
    // Get all vessels
    const vesselData = await apiCallWithRetry('/game/index', 'POST', {});
    const allVessels = vesselData.data.user_vessels;

    // Filter vessels needing repair
    const vesselsToRepair = allVessels.filter(v => {
      const wear = parseInt(v.wear);
      return wear >= threshold;
    });

    if (vesselsToRepair.length === 0) {
      const userId = getUserId();
      if (userId) {
        broadcastToUser(userId, 'user_action_notification', {
          type: 'info',
          message: '🔧 No vessels need repair!'
        });
      }
      return res.json({ count: 0, totalCost: 0 });
    }

    // Get repair costs
    const vesselIds = vesselsToRepair.map(v => v.id);
    const costData = await gameapi.getMaintenanceCost(vesselIds);
    const totalCost = costData.totalCost;

    // Build vessel details with costs
    const vesselDetails = vesselsToRepair.map(vessel => {
      const costVessel = costData.vessels.find(v => v.id === vessel.id);
      const wearMaintenance = costVessel?.maintenance_data?.find(m => m.type === 'wear');
      const cost = wearMaintenance?.price;
      logger.debug(`[Bulk Repair] Vessel ${vessel.name} (ID: ${vessel.id}): wear=${vessel.wear}%, cost=$${cost}`);
      return {
        id: vessel.id,
        name: vessel.name,
        wear: vessel.wear,
        cost: cost
      };
    });

    // Recalculate totalCost from vessel details (in case API returned 0)
    const calculatedTotalCost = vesselDetails.reduce((sum, v) => sum + v.cost, 0);
    logger.debug(`[Bulk Repair] Total calculated from vessels: $${calculatedTotalCost.toLocaleString()}, costData.totalCost: $${costData.totalCost.toLocaleString()}`);

    // Check cash (use calculatedTotalCost if totalCost is 0)
    const finalTotalCost = totalCost > 0 ? totalCost : calculatedTotalCost;
    const state = require('../../state');
    const userId = getUserId();
    const bunker = state.getBunkerState(userId);

    if (finalTotalCost > bunker.cash) {
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Not enough cash!</strong><br><br>Repair cost: $${totalCost.toLocaleString()}<br>Your cash: $${bunker.cash.toLocaleString()}<br>Missing: $${(totalCost - bunker.cash).toLocaleString()}`
      });
      return res.status(400).json({ error: 'Not enough cash' });
    }

    // Broadcast repair start (lock buttons across all tabs)
    if (userId) {
      broadcastToUser(userId, 'repair_start', {});
    }

    // Execute repairs
    const repairData = await gameapi.bulkRepairVessels(vesselIds);

    // Use repairData.totalCost if available (API sometimes returns it), otherwise use finalTotalCost
    const actualCost = repairData.totalCost > 0 ? repairData.totalCost : finalTotalCost;

    logger.debug(`[Manual Bulk Repair] Repaired ${vesselsToRepair.length} vessels - costData.totalCost: $${totalCost.toLocaleString()}, calculatedTotalCost: $${calculatedTotalCost.toLocaleString()}, repairData.totalCost: $${repairData.totalCost.toLocaleString()}, Using: $${actualCost.toLocaleString()}`);

    // AUDIT LOG: Manual bulk repair
    // (using audit-logger imported at top of file)

    // Validate data - FAIL LOUD if missing
    if (vesselsToRepair.length === 0) {
      throw new Error('No vessels to repair');
    }

    if (actualCost === 0) {
      throw new Error('Repair cost is 0 - API data invalid');
    }

    await auditLog(
      userId,
      CATEGORIES.VESSEL,
      'Manual Bulk Repair',
      `Repaired ${vesselsToRepair.length} vessel(s) for ${formatCurrency(actualCost)}`,
      {
        vessel_count: vesselsToRepair.length,
        total_cost: actualCost,
        threshold: threshold,
        vessels: vesselDetails.map(v => {
          if (!v.cost) {
            throw new Error(`Vessel ${v.id} (${v.name}) missing cost in repair data`);
          }
          return {
            id: v.id,
            name: v.name,
            wear: v.wear,
            cost: v.cost
          };
        })
      },
      'SUCCESS',
      SOURCES.MANUAL
    );

    // Broadcast success to all clients using same format as autopilot
    if (userId) {
      broadcastToUser(userId, 'vessels_repaired', {
        count: vesselsToRepair.length,
        totalCost: actualCost,
        vessels: vesselDetails
      });

      // Update bunker cash
      broadcastToUser(userId, 'bunker_update', {
        fuel: bunker.fuel,
        co2: bunker.co2,
        cash: bunker.cash - actualCost,
        maxFuel: bunker.maxFuel,
        maxCO2: bunker.maxCO2
      });

      // Broadcast repair complete (unlock buttons across all tabs)
      broadcastToUser(userId, 'repair_complete', {
        count: vesselsToRepair.length
      });
    }

    res.json({
      count: vesselsToRepair.length,
      totalCost: actualCost,
      vessels: vesselDetails
    });
  } catch (error) {
    logger.error('Error repairing vessels:', error);

    const userId = getUserId();
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Error</strong><br><br>${safeErrorMessage}`
      });
    }

    res.status(500).json({ error: 'Failed to repair vessels' });
  }
});

/**
 * POST /api/vessel/rename-vessel
 * Rename a vessel
 *
 * @route POST /api/vessel/rename-vessel
 * @body {number} vessel_id - ID of vessel to rename
 * @body {string} name - New name for the vessel (2-30 characters)
 *
 * @returns {object} Rename result from game API
 *
 * @error 400 - Invalid vessel_id or name
 * @error 500 - Failed to rename vessel
 *
 * Side effects:
 * - Triggers harbor map refresh with vessel_renamed event
 */
router.post('/rename-vessel', express.json(), async (req, res) => {
  try {
    const { vessel_id, name } = req.body;

    // Validate input
    if (!vessel_id) {
      return res.status(400).json({ error: 'Vessel ID is required' });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Vessel name is required' });
    }

    // Validate name length (2-30 characters)
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 30) {
      return res.status(400).json({ error: 'Vessel name must be between 2 and 30 characters' });
    }

    logger.info(`[Vessel Rename] Renaming vessel ${vessel_id} to "${trimmedName}"`);

    // Call game API
    const data = await apiCall('/vessel/rename-vessel', 'POST', {
      vessel_id: vessel_id,
      name: trimmedName
    });

    logger.info(`[Vessel Rename] Success - Vessel ${vessel_id} renamed to "${trimmedName}"`);

    // Broadcast Harbor Map refresh
    const userId = getUserId();
    if (userId) {
      const { broadcastHarborMapRefresh } = require('../../websocket');
      if (broadcastHarborMapRefresh) {
        broadcastHarborMapRefresh(userId, 'vessel_renamed', {
          vessel_id: vessel_id,
          new_name: trimmedName
        });
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('[Vessel Rename] Error:', error.message);
    res.status(500).json({ error: 'Failed to rename vessel' });
  }
});

/**
 * POST /api/vessel/park-vessel
 * Parks a vessel (moors it)
 */
router.post('/park-vessel', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/park-vessel', 'POST', { vessel_id });
    logger.info(`[Park Vessel] Vessel ${vessel_id} parked successfully`);
    res.json(data);
  } catch (error) {
    logger.error(`[Park Vessel] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to park vessel', message: error.message });
  }
});

/**
 * POST /api/vessel/resume-parked-vessel
 * Resumes a parked vessel (unmoores it)
 */
router.post('/resume-parked-vessel', express.json(), async (req, res) => {
  const { vessel_id } = req.body;

  if (!vessel_id) {
    return res.status(400).json({ error: 'Missing vessel_id' });
  }

  try {
    const data = await apiCall('/vessel/resume-parked-vessel', 'POST', { vessel_id });
    logger.info(`[Resume Parked Vessel] Vessel ${vessel_id} resumed successfully`);
    res.json(data);
  } catch (error) {
    logger.error(`[Resume Parked Vessel] Failed for vessel ${vessel_id}:`, error.message);
    res.status(500).json({ error: 'Failed to resume parked vessel', message: error.message });
  }
});

module.exports = router;