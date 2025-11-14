/**
 * @fileoverview Game Management API Routes
 *
 * This module provides HTTP endpoints for managing game resources including vessels,
 * fuel/CO2 purchases, user settings, vessel maintenance, marketing campaigns, and
 * vessel acquisitions. These endpoints proxy requests to the Shipping Manager game API
 * while adding validation and error handling.
 *
 * Key Features:
 * - Vessel management (list vessels in harbor, purchase new vessels, bulk repairs)
 * - Bunker operations (fuel and CO2 price monitoring and purchasing)
 * - Route management (depart all vessels at once)
 * - Marketing campaigns (view available campaigns, activate/renew)
 * - User settings retrieval (anchor points, company data)
 *
 * Why This Module:
 * - Consolidates all game resource management endpoints
 * - Provides validation before forwarding to game API
 * - Standardizes error responses across all game operations
 * - Enables automation features (auto-rebuy, auto-depart, auto-repair)
 *
 * Common Patterns:
 * - GET endpoints retrieve current state (prices, vessels, settings)
 * - POST endpoints perform actions (purchase, depart, repair)
 * - All endpoints include error handling with descriptive messages
 * - Graceful degradation (empty arrays instead of errors for UI-critical endpoints)
 *
 * @requires express - Router and middleware
 * @requires ../utils/api - API helper function (apiCall)
 * @module server/routes/game
 */

const express = require('express');
const validator = require('validator');
const { apiCall, apiCallWithRetry, getUserId } = require('../utils/api');
const gameapi = require('../gameapi');
const { broadcastToUser } = require('../websocket');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const autopilot = require('../autopilot');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

const router = express.Router();

/** GET /api/vessel/get-vessels - Retrieves all vessels currently in harbor. Uses /game/index endpoint to get complete vessel list with status, cargo, maintenance needs, etc. Also caches company_type in local settings. */
router.get('/vessel/get-vessels', async (req, res) => {
  try {
    const data = await apiCallWithRetry('/game/index', 'POST', {});

    // Cache company_type in local settings for offline access
    const userId = getUserId();
    if (userId && data.user?.company_type) {
      try {
        const { getSettingsFilePath } = require('../settings-schema');
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

/** POST /api/user/get-company - Returns user company data including capacity values. */
router.post('/user/get-company', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/user/get-company', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching company data:', error);
    res.status(500).json({ error: 'Failed to fetch company data' });
  }
});

/** GET /api/user/get-settings - Retrieves user settings including anchor points (used for auto-rebuy calculations). Also caches company_type in local settings. */
router.get('/user/get-settings', async (req, res) => {
  try {
    const data = await apiCall('/user/get-user-settings', 'GET', {});

    // Cache company_type in local settings for offline access
    const userId = getUserId();
    if (userId && data.user?.company_type) {
      try {
        const { getSettingsFilePath } = require('../settings-schema');
        const settingsFile = getSettingsFilePath(userId);

        // Read current settings
        const settingsData = await fs.readFile(settingsFile, 'utf8');
        const settings = JSON.parse(settingsData);

        // Update company_type
        settings.company_type = data.user.company_type;

        // Write back to file
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

        logger.debug(`[User Settings] Cached company_type: ${JSON.stringify(data.user.company_type)}`);
      } catch (cacheError) {
        // Don't fail the request if caching fails
        logger.warn('[User Settings] Failed to cache company_type:', cacheError.message);
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('Error getting user settings:', error);
    res.status(500).json({ error: 'Failed to retrieve user settings' });
  }
});

/** GET /api/bunker/get-prices - Fetches current market prices for fuel and CO2. Critical for price alerts and auto-rebuy features. */
router.get('/bunker/get-prices', async (req, res) => {
  try {
    const data = await apiCall('/bunker/get-prices', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting bunker prices:', error);
    res.status(500).json({ error: 'Failed to retrieve bunker prices' });
  }
});

/**
 * POST /api/bunker/purchase-fuel - Purchases specified amount of fuel.
 * Validation: amount must be positive integer. Used by manual purchases and auto-rebuy automation.
 */
router.post('/bunker/purchase-fuel', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userId = getUserId();
  const state = require('../state');

  // LOCK: Prevent concurrent fuel purchases (race condition protection)
  if (state.getLockStatus(userId, 'fuelPurchase')) {
    logger.debug('[Fuel Purchase] SKIPPED - Another fuel purchase is already in progress');
    return res.status(409).json({ error: 'Fuel purchase already in progress' });
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'fuelPurchase', true);
  if (userId) {
    broadcastToUser(userId, 'fuel_purchase_start', {});
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: true,
      co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });
  }
  logger.debug('[Fuel Purchase] Lock acquired');

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-fuel', 'POST', { amount });

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use values from state
      const { broadcastBunkerUpdate } = require('../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: bunkerBefore.maxFuel,
        maxCO2: bunkerBefore.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.info(`[Manual Fuel Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash before: $${cashBefore.toLocaleString('en-US')} Cash after: $${cashAfter.toLocaleString('en-US')})`);

      // AUDIT LOG: Manual fuel purchase
      // (using audit-logger imported at top of file)

      // Validate data - FAIL LOUD if missing
      if (!data.user || data.user.fuel === undefined || data.user.fuel === null) {
        throw new Error('API response missing user.fuel data');
      }

      await auditLog(
        userId,
        CATEGORIES.BUNKER,
        'Manual Fuel Purchase',
        `+${amount}t @ ${formatCurrency(actualPricePerTon)}/t = ${formatCurrency(actualCost)}`,
        {
          amount_tons: amount,
          price_per_ton: actualPricePerTon,
          total_cost: actualCost,
          balance_before: cashBefore,
          balance_after: cashAfter,
          inventory_before_kg: bunkerBefore.fuel,
          inventory_after_kg: data.user.fuel
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">⛽ Fuel Purchase</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Amount:</span>
              <span><strong>${Math.round(amount).toLocaleString('en-US')}t</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Price per ton:</span>
              <span>$${actualPricePerTon}/t</span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${actualCost.toLocaleString('en-US')}</strong></span>
            </div>
          </div>
        `
      });

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    // Release lock BEFORE sending response
    state.setLockStatus(userId, 'fuelPurchase', false);
    logger.debug('[Fuel Purchase] Lock released');

    // Broadcast fuel purchase complete and updated lock status
    broadcastToUser(userId, 'fuel_purchase_complete', { amount });
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: false,
      co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing fuel:', error);

    // Release lock on error
    state.setLockStatus(userId, 'fuelPurchase', false);

    // Broadcast error notification to all clients
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `⛽ <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });

      // Broadcast fuel purchase complete and updated lock status
      broadcastToUser(userId, 'fuel_purchase_complete', { amount: 0 });
      broadcastToUser(userId, 'lock_status', {
        depart: state.getLockStatus(userId, 'depart'),
        fuelPurchase: false,
        co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });
    }

    res.status(500).json({ error: 'Failed to purchase fuel' });
  } finally {
    // ALWAYS release lock, even if error occurred
    state.setLockStatus(userId, 'fuelPurchase', false);
    logger.debug('[Fuel Purchase] Lock released (finally)');
  }
});

/**
 * POST /api/bunker/purchase-co2 - Purchases specified amount of CO2 certificates.
 * Validation: amount must be positive integer. Used by manual purchases and auto-rebuy automation.
 */
router.post('/bunker/purchase-co2', express.json(), async (req, res) => {
  const { amount } = req.body;

  if (!amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const userId = getUserId();
  const state = require('../state');

  // LOCK: Prevent concurrent CO2 purchases (race condition protection)
  if (state.getLockStatus(userId, 'co2Purchase')) {
    logger.debug('[CO2 Purchase] SKIPPED - Another CO2 purchase is already in progress');
    return res.status(409).json({ error: 'CO2 purchase already in progress' });
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'co2Purchase', true);
  if (userId) {
    broadcastToUser(userId, 'co2_purchase_start', {});
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
      co2Purchase: true,
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });
  }
  logger.debug('[CO2 Purchase] Lock acquired');

  try {
    // Get cash BEFORE purchase to calculate actual cost
    const bunkerBefore = state.getBunkerState(userId);
    const cashBefore = bunkerBefore ? bunkerBefore.cash : 0;

    // API expects amount in tons (NOT kg) - send directly
    const data = await apiCall('/bunker/purchase-co2', 'POST', { amount });

    // Broadcast bunker update to all clients (manual purchase)
    if (userId && data.user) {
      // API doesn't return capacity fields - use values from state
      const { broadcastBunkerUpdate } = require('../websocket');

      broadcastBunkerUpdate(userId, {
        fuel: data.user.fuel / 1000,
        co2: (data.user.co2 || data.user.co2_certificate) / 1000,
        cash: data.user.cash,
        maxFuel: bunkerBefore.maxFuel,
        maxCO2: bunkerBefore.maxCO2
      });

      // Calculate ACTUAL cost from API response (includes discounts!)
      const cashAfter = data.user.cash;
      const actualCost = Math.round(cashBefore - cashAfter);
      const actualPricePerTon = Math.round(actualCost / amount);

      logger.info(`[Manual CO2 Purchase] User bought ${amount}t @ $${actualPricePerTon}/t = $${actualCost.toLocaleString('en-US')} (Cash before: $${cashBefore.toLocaleString('en-US')} Cash after: $${cashAfter.toLocaleString('en-US')})`);

      // AUDIT LOG: Manual CO2 purchase
      // (using audit-logger imported at top of file)

      // Validate data - FAIL LOUD if missing
      const co2After = data.user.co2 || data.user.co2_certificate;
      if (co2After === undefined || co2After === null) {
        throw new Error('API response missing user.co2/co2_certificate data');
      }

      await auditLog(
        userId,
        CATEGORIES.BUNKER,
        'Manual CO2 Purchase',
        `+${amount}t @ ${formatCurrency(actualPricePerTon)}/t = ${formatCurrency(actualCost)}`,
        {
          amount_tons: amount,
          price_per_ton: actualPricePerTon,
          total_cost: actualCost,
          balance_before: cashBefore,
          balance_after: cashAfter,
          inventory_before_kg: bunkerBefore.co2,
          inventory_after_kg: co2After
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `
          <div style="font-family: monospace; font-size: 13px;">
            <div style="text-align: center; border-bottom: 2px solid rgba(255,255,255,0.3); padding-bottom: 8px; margin-bottom: 12px;">
              <strong style="font-size: 14px;">💨 CO2 Purchase</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Amount:</span>
              <span><strong>${Math.round(amount).toLocaleString('en-US')}t</strong></span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span>Price per ton:</span>
              <span>$${actualPricePerTon}/t</span>
            </div>
            <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
            <div style="display: flex; justify-content: space-between; font-size: 15px;">
              <span><strong>Total:</strong></span>
              <span style="color: #ef4444;"><strong>$${actualCost.toLocaleString('en-US')}</strong></span>
            </div>
          </div>
        `
      });

      // Trigger immediate data update
      await autopilot.tryUpdateAllData();
    }

    // Release lock BEFORE sending response
    state.setLockStatus(userId, 'co2Purchase', false);
    logger.debug('[CO2 Purchase] Lock released');

    // Broadcast CO2 purchase complete and updated lock status
    broadcastToUser(userId, 'co2_purchase_complete', { amount });
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
      co2Purchase: false,
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy')
    });

    res.json(data);
  } catch (error) {
    logger.error('Error purchasing CO2:', error);

    // Release lock on error
    state.setLockStatus(userId, 'co2Purchase', false);

    // Broadcast error notification to all clients
    if (userId) {
      // Escape error message to prevent XSS
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `💨 <strong>Purchase Failed</strong><br><br>${safeErrorMessage}`
      });

      // Broadcast CO2 purchase complete and updated lock status
      broadcastToUser(userId, 'co2_purchase_complete', { amount: 0 });
      broadcastToUser(userId, 'lock_status', {
        depart: state.getLockStatus(userId, 'depart'),
        fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
        co2Purchase: false,
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy')
      });
    }

    res.status(500).json({ error: 'Failed to purchase CO2' });
  } finally {
    // ALWAYS release lock, even if error occurred
    state.setLockStatus(userId, 'co2Purchase', false);
    logger.debug('[CO2 Purchase] Lock released (finally)');
  }
});

/**
 * POST /api/route/depart - Universal depart endpoint
 * Accepts optional array of vessel IDs. If no IDs provided, departs ALL vessels in harbor.
 * Uses the EXACT same logic and notifications as autopilot.
 *
 * Request body (optional):
 * {
 *   vessel_ids: [123, 456, 789]  // Optional - if omitted, departs ALL vessels
 * }
 */
router.post('/route/depart', async (req, res) => {
  try {
    const userId = getUserId();

    // Extract vessel IDs from request body (optional)
    const vesselIds = req.body?.vessel_ids || null;

    if (vesselIds && !Array.isArray(vesselIds)) {
      return res.status(400).json({ error: 'vessel_ids must be an array' });
    }

    if (vesselIds) {
      logger.debug(`[Depart API] Departing ${vesselIds.length} specific vessels`);
    } else {
      logger.debug(`[Depart API] Departing ALL vessels in harbor`);
    }

    // Call universal depart function
    // vesselIds = null means "depart all"
    // vesselIds = [1,2,3] means "depart these specific vessels"
    const { broadcastHarborMapRefresh } = require('../websocket');
    // (using broadcastToUser imported at top of file)
    const result = await autopilot.departVessels(userId, vesselIds, broadcastToUser, autopilot.autoRebuyAll, autopilot.tryUpdateAllData);

    // LOGBOOK: Manual vessel departure (same format as Auto-Depart)
    if (result && result.success && result.departedCount > 0) {
      // Log success
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Depart',
        `${result.departedCount} vessels | +${formatCurrency(result.totalRevenue)}`,
        {
          vesselCount: result.departedCount,
          totalRevenue: result.totalRevenue,
          totalFuelUsed: result.totalFuelUsed,
          totalCO2Used: result.totalCO2Used,
          totalHarborFees: result.totalHarborFees,
          departedVessels: result.departedVessels
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

      // Log warnings if any vessels had excessive harbor fees
      if (result.highFeeCount > 0) {
        const totalHarborFees = result.highFeeVessels.reduce((sum, v) => sum + v.harborFee, 0);
        await auditLog(
          userId,
          CATEGORIES.VESSEL,
          'Manual Depart',
          `${result.highFeeCount} vessel${result.highFeeCount > 1 ? 's' : ''} with excessive harbor fees | ${formatCurrency(totalHarborFees)} fees`,
          {
            vesselCount: result.highFeeCount,
            totalHarborFees: totalHarborFees,
            highFeeVessels: result.highFeeVessels
          },
          'WARNING',
          SOURCES.MANUAL
        );
      }
    }

    // Trigger Harbor Map refresh (vessels departed)
    if (broadcastHarborMapRefresh) {
      broadcastHarborMapRefresh(userId, 'vessels_departed', {
        count: vesselIds ? vesselIds.length : 'all'
      });
    }

    res.json(result || { success: true, message: 'Depart triggered' });
  } catch (error) {
    logger.error('[Depart API] Error:', error);
    res.status(500).json({ error: 'Failed to depart vessels' });
  }
});



/**
 * GET /api/port/get-assigned-ports - Retrieves demand and consumed data for all assigned ports.
 * Used by intelligent auto-depart to calculate remaining port capacity.
 * Returns port demand/consumed for both container and tanker cargo types.
 * @returns {Object} data.ports - Array of port objects with demand/consumed data
 */
router.get('/port/get-assigned-ports', async (req, res) => {
  try {
    const data = await apiCall('/port/get-assigned-ports', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching assigned ports:', error);
    res.status(500).json({ error: 'Failed to fetch assigned ports' });
  }
});

/** POST /api/maintenance/get - Calculates maintenance cost for specified vessels. Returns total repair cost and individual vessel costs. */
router.post('/maintenance/get', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  try {
    const data = await apiCall('/maintenance/get', 'POST', { vessel_ids });
    res.json(data);
  } catch (error) {
    logger.error('Error getting maintenance cost:', error);
    res.status(500).json({ error: 'Failed to get maintenance cost' });
  }
});

/** POST /api/maintenance/do-wear-maintenance-bulk - Performs bulk wear maintenance on multiple vessels. Repairs all specified vessels in a single API call. */
router.post('/maintenance/do-wear-maintenance-bulk', express.json(), async (req, res) => {
  const { vessel_ids } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  try {
    const data = await apiCall('/maintenance/do-wear-maintenance-bulk', 'POST', { vessel_ids });
    res.json(data);
  } catch (error) {
    logger.error('Error performing bulk maintenance:', error);
    res.status(500).json({ error: 'Failed to perform bulk maintenance' });
  }
});

/** POST /api/maintenance/get-drydock-status - Gets drydock maintenance pricing for specified vessels. Returns pricing for major/minor drydock and wear repairs. */
router.post('/maintenance/get-drydock-status', express.json(), async (req, res) => {
  const { vessel_ids, speed, maintenance_type } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  if (!speed || !['maximum', 'minimum'].includes(speed)) {
    return res.status(400).json({ error: 'Invalid speed. Must be "maximum" or "minimum"' });
  }

  if (!maintenance_type || !['major', 'minor'].includes(maintenance_type)) {
    return res.status(400).json({ error: 'Invalid maintenance_type. Must be "major" or "minor"' });
  }

  try {
    const data = await apiCall('/maintenance/get', 'POST', {
      vessel_ids
    });

    // Parse maintenance data and extract correct costs based on type
    const vessels = data.data.vessels.map(v => {
      const maintenanceType = maintenance_type === 'major' ? 'drydock_major' : 'drydock_minor';
      const maintenanceInfo = v.maintenance_data?.find(m => m.type === maintenanceType);

      return {
        id: v.id,
        cost: maintenanceInfo?.discounted_price || maintenanceInfo?.price || 0,
        duration: maintenanceInfo?.duration || 0,
        nearest_dry_dock: v.nearest_dry_dock
      };
    });

    const totalCost = vessels.reduce((sum, v) => sum + v.cost, 0);

    res.json({
      vessels,
      totalCost,
      cash: data.user.cash
    });
  } catch (error) {
    logger.error('Error getting drydock status:', error);
    res.status(500).json({ error: 'Failed to get drydock status' });
  }
});

/** POST /api/maintenance/bulk-drydock - Executes drydock maintenance for specified vessels. Sends vessels to nearest drydock for major or minor antifouling restoration. */
router.post('/maintenance/bulk-drydock', express.json(), async (req, res) => {
  const { vessel_ids, speed, maintenance_type } = req.body;

  if (!vessel_ids) {
    return res.status(400).json({ error: 'Missing vessel_ids' });
  }

  if (!speed || !['maximum', 'minimum'].includes(speed)) {
    return res.status(400).json({ error: 'Invalid speed. Must be "maximum" or "minimum"' });
  }

  if (!maintenance_type || !['major', 'minor'].includes(maintenance_type)) {
    return res.status(400).json({ error: 'Invalid maintenance_type. Must be "major" or "minor"' });
  }

  const userId = getUserId();
  const state = require('../state');

  // LOCK: Prevent concurrent drydock operations (race condition protection)
  if (state.getLockStatus(userId, 'drydock')) {
    logger.debug('[Drydock] SKIPPED - Another drydock operation is already in progress');
    return res.status(409).json({ error: 'Drydock operation already in progress' });
  }

  // Set lock and broadcast to all clients
  state.setLockStatus(userId, 'drydock', true);
  broadcastToUser(userId, 'drydock_start', {});
  broadcastToUser(userId, 'lock_status', {
    depart: state.getLockStatus(userId, 'depart'),
    fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
    co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
    repair: state.getLockStatus(userId, 'repair'),
    bulkBuy: state.getLockStatus(userId, 'bulkBuy'),
    drydock: true
  });
  logger.debug('[Drydock] Lock acquired');

  try {
    const data = await apiCall('/maintenance/do-major-drydock-maintenance-bulk', 'POST', {
      vessel_ids,
      speed,
      maintenance_type
    });
    const vesselCount = JSON.parse(vessel_ids).length;
    if (userId && data.data?.success) {
      logger.info(`[Manual Drydock] User sent ${vesselCount} vessel(s) to drydock (${maintenance_type}, ${speed} speed)`);

      // AUDIT LOG: Manual bulk drydock
      // (using audit-logger imported at top of file)

      const vessels = data.data.vessels || [];
      let totalCost = 0;

      // Calculate total cost if vessel data is available
      if (vessels.length > 0) {
        totalCost = vessels.reduce((sum, v) => sum + (v.cost || 0), 0);
      }

      // Log with available data (even if vessels array is empty)
      await auditLog(
        userId,
        CATEGORIES.VESSEL,
        'Manual Bulk Drydock',
        vessels.length > 0
          ? `Sent ${vessels.length} vessel(s) to ${maintenance_type} drydock (${speed} speed) for ${formatCurrency(totalCost)}`
          : `Sent ${vesselCount} vessel(s) to ${maintenance_type} drydock (${speed} speed)`,
        {
          vessel_count: vessels.length > 0 ? vessels.length : vesselCount,
          total_cost: totalCost > 0 ? totalCost : undefined,
          maintenance_type: maintenance_type,
          speed: speed,
          vessels: vessels.length > 0 ? vessels.map(v => ({
            id: v.id,
            cost: v.cost,
            duration: v.duration,
            nearest_dry_dock: v.nearest_dry_dock
          })) : undefined
        },
        'SUCCESS',
        SOURCES.MANUAL
      );

      // Broadcast success notification
      broadcastToUser(userId, 'user_action_notification', {
        type: 'success',
        message: `🔧 <strong>Drydock Scheduled!</strong><br><br>Sent ${vesselCount} vessel(s) to drydock`
      });

      // Broadcast bunker update (cash/fuel/co2 updated)
      if (data.user) {
        const cachedCapacity = autopilot.getCachedCapacity(userId);
        broadcastToUser(userId, 'bunker_update', {
          fuel: data.user.fuel / 1000,
          co2: (data.user.co2 || data.user.co2_certificate) / 1000,
          cash: data.user.cash,
          maxFuel: cachedCapacity.maxFuel,
          maxCO2: cachedCapacity.maxCO2
        });
      }

      // Trigger immediate drydock count update
      await autopilot.tryUpdateAllData();
    }

    // Release lock BEFORE sending response
    state.setLockStatus(userId, 'drydock', false);
    logger.debug('[Drydock] Lock released');

    // Broadcast drydock complete and updated lock status
    broadcastToUser(userId, 'drydock_complete', { count: vesselCount });
    broadcastToUser(userId, 'lock_status', {
      depart: state.getLockStatus(userId, 'depart'),
      fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
      co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
      repair: state.getLockStatus(userId, 'repair'),
      bulkBuy: state.getLockStatus(userId, 'bulkBuy'),
      drydock: false
    });

    res.json(data);
  } catch (error) {
    logger.error('Error executing drydock:', error);

    // Release lock on error
    state.setLockStatus(userId, 'drydock', false);

    if (userId) {
      const safeErrorMessage = validator.escape(error.message || 'Unknown error');
      broadcastToUser(userId, 'user_action_notification', {
        type: 'error',
        message: `🔧 <strong>Drydock Failed</strong><br><br>${safeErrorMessage}`
      });

      // Broadcast drydock complete and updated lock status on error
      broadcastToUser(userId, 'drydock_complete', { count: 0 });
      broadcastToUser(userId, 'lock_status', {
        depart: state.getLockStatus(userId, 'depart'),
        fuelPurchase: state.getLockStatus(userId, 'fuelPurchase'),
        co2Purchase: state.getLockStatus(userId, 'co2Purchase'),
        repair: state.getLockStatus(userId, 'repair'),
        bulkBuy: state.getLockStatus(userId, 'bulkBuy'),
        drydock: false
      });

      // AUDIT LOG: Manual bulk drydock failed
      // (using audit-logger imported at top of file)
      try {
        const vesselCount = vessel_ids ? JSON.parse(vessel_ids).length : 0;

        await auditLog(
          userId,
          CATEGORIES.VESSEL,
          'Manual Bulk Drydock',
          `Failed to send ${vesselCount} vessel(s) to ${maintenance_type || 'unknown'} drydock: ${error.message}`,
          {
            vessel_count: vesselCount,
            maintenance_type: maintenance_type || 'unknown',
            speed: speed || 'unknown',
            error: error.message,
            stack: error.stack
          },
          'ERROR',
          SOURCES.MANUAL
        );
      } catch (auditError) {
        logger.error('[Drydock] Audit logging failed:', auditError.message);
      }
    }

    res.status(500).json({ error: 'Failed to execute drydock' });
  } finally {
    // ALWAYS release lock, even if error occurred
    state.setLockStatus(userId, 'drydock', false);
    logger.debug('[Drydock] Lock released (finally)');
  }
});

/**
 * GET /api/marketing/get-campaigns - Retrieves available marketing campaigns and active campaign status.
 * Graceful error handling: Returns empty arrays instead of error to prevent UI breaking.
 */
router.get('/marketing/get-campaigns', async (req, res) => {
  try {
    const data = await apiCall('/marketing-campaign/get-marketing', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting marketing campaigns:', error.message, error.stack);

    // Return empty campaigns instead of error to prevent UI breaking
    res.json({
      data: {
        marketing_campaigns: [],
        active_campaigns: []
      },
      user: {
        reputation: 0
      }
    });
  }
});

/** POST /api/marketing/activate-campaign - Activates a marketing campaign by campaign_id. Used for manual activation and auto-renewal automation. */
router.post('/marketing/activate-campaign', express.json(), async (req, res) => {
  const { campaign_id } = req.body;

  if (!campaign_id) {
    return res.status(400).json({ error: 'Missing campaign_id' });
  }

  try {
    const data = await apiCall('/marketing-campaign/activate-marketing-campaign', 'POST', { campaign_id });

    // Log campaign activation (regardless of data.success value)
    const userId = getUserId();
    if (userId) {
      // (using audit-logger imported at top of file)
      try {
        // Fetch campaign details to get name and price
        const campaigns = await gameapi.fetchCampaigns();

        // Search in both available and active campaigns (campaign might have moved to active after activation)
        let activatedCampaign = campaigns?.available?.find(c => c.id === campaign_id);
        if (!activatedCampaign) {
          activatedCampaign = campaigns?.active?.find(c => c.id === campaign_id);
        }

        if (activatedCampaign) {
          await auditLog(
            userId,
            CATEGORIES.MARKETING,
            'Campaign Activation',
            `${activatedCampaign.name} (${activatedCampaign.option_name}) | -${formatCurrency(activatedCampaign.price)}`,
            {
              campaign_id,
              campaign_name: activatedCampaign.name,
              campaign_type: activatedCampaign.option_name,
              price: activatedCampaign.price,
              duration: activatedCampaign.duration
            },
            'SUCCESS',
            SOURCES.MANUAL
          );
        } else {
          // Campaign not found in available or active - log with minimal info
          logger.warn(`[Marketing] Campaign ${campaign_id} not found in campaigns list after activation`);
          await auditLog(
            userId,
            CATEGORIES.MARKETING,
            'Campaign Activation',
            `Campaign ID ${campaign_id} activated`,
            {
              campaign_id
            },
            'SUCCESS',
            SOURCES.MANUAL
          );
        }
      } catch (auditError) {
        logger.error('[Marketing] Audit logging failed:', auditError.message);
      }
    }

    // Clear campaign cache to force fresh data fetch
    const cache = require('../cache');
    cache.invalidateCampaignCache();
    logger.debug('[Marketing] Campaign cache invalidated after activation');

    // Trigger data update to refresh campaign badge and header
    // (using autopilot imported at top of file)
    if (autopilot && autopilot.tryUpdateAllData) {
      try {
        await autopilot.tryUpdateAllData();
        logger.debug('[Marketing] Campaign data update triggered after activation');
      } catch (updateError) {
        logger.error('[Marketing] Failed to update campaign data:', updateError.message);
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('Error activating campaign:', error);

    // Log failed activation attempt
    const userId = getUserId();
    if (userId) {
      // (using audit-logger imported at top of file)
      try {
        await auditLog(
          userId,
          CATEGORIES.MARKETING,
          'Campaign Activation',
          `Failed to activate campaign ${campaign_id}`,
          {
            campaign_id,
            error: error.message
          },
          'ERROR',
          SOURCES.MANUAL
        );
      } catch (auditError) {
        logger.error('[Marketing] Audit logging failed:', auditError.message);
      }
    }

    res.status(500).json({ error: 'Failed to activate campaign' });
  }
});

/** GET /api/vessel/get-all-acquirable - Fetches all vessels available for purchase from the marketplace. */
router.get('/vessel/get-all-acquirable', async (req, res) => {
  try {
    const data = await apiCall('/vessel/get-all-acquirable-vessels', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error getting acquirable vessels:', error);
    res.status(500).json({ error: 'Failed to retrieve acquirable vessels' });
  }
});

/**
 * POST /api/vessel/get-sell-price - Gets the selling price for a vessel.
 * Returns the selling price and original price for a user-owned vessel.
 */
router.post('/vessel/get-sell-price', express.json(), async (req, res) => {
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
 * POST /api/vessel/sell-vessels - Sells multiple vessels by their IDs.
 * Accepts an array of vessel IDs and sells each one individually.
 * Broadcasts notifications and bunker updates to all connected clients.
 */
router.post('/vessel/sell-vessels', express.json(), async (req, res) => {
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
 * POST /api/vessel/purchase-vessel - Purchases a new vessel with specified configuration.
 * Default configuration: 4-blade propeller, optional antifouling, no enhanced deck beams.
 * Validation: vessel_id and name are required fields.
 */
router.post('/vessel/purchase-vessel', express.json(), async (req, res) => {
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
 * POST /api/vessel/bulk-buy-start - Broadcasts bulk buy start to lock buttons across all clients
 */
router.post('/vessel/bulk-buy-start', express.json(), async (req, res) => {
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
 * POST /api/vessel/broadcast-purchase-summary - Broadcasts a summary notification of vessel purchases to all clients
 */
router.post('/vessel/broadcast-purchase-summary', express.json(), async (req, res) => {
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
    const { broadcastHarborMapRefresh } = require('../websocket');
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
 * POST /api/vessel/broadcast-sale-summary - Broadcasts a summary notification of vessel sales to all clients
 */
router.post('/vessel/broadcast-sale-summary', express.json(), async (req, res) => {
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
    const { broadcastHarborMapRefresh } = require('../websocket');
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

/** POST /api/vessel/get-repair-preview - Gets repair preview with vessel list and costs */
router.post('/vessel/get-repair-preview', express.json(), async (req, res) => {
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

/** POST /api/vessel/bulk-repair - Repairs all vessels needing maintenance based on threshold */
router.post('/vessel/bulk-repair', express.json(), async (req, res) => {
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
    const state = require('../state');
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

/** POST /api/vessel/rename-vessel - Rename a vessel */
router.post('/vessel/rename-vessel', express.json(), async (req, res) => {
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
      const { broadcastHarborMapRefresh } = require('../websocket');
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

/** POST /api/check-price-alerts - Manually trigger price alert check (called on page load) */
router.post('/check-price-alerts', async (req, res) => {
  try {
    await autopilot.checkPriceAlerts();
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Failed to check price alerts:', error.message);
    res.status(500).json({ error: 'Failed to check price alerts' });
  }
});

/** POST /api/autopilot/trigger-depart - Event-driven auto-depart trigger (called when vessels arrive in harbor) */
router.post('/autopilot/trigger-depart', async (req, res) => {
  try {
    const userId = getUserId();
    const state = require('../state');

    const settings = state.getSettings(userId);

    // Only execute if auto-depart is enabled
    if (!settings?.autoDepartAll) {
      return res.json({ success: false, message: 'Auto-depart not enabled' });
    }

    logger.debug(`[Auto-Depart] Event-driven trigger received for user ${userId}`);

    // Execute auto-depart with all required parameters
    // (using broadcastToUser imported at top of file)
    await autopilot.autoDepartVessels(
      autopilot.isAutopilotPaused(),
      broadcastToUser,
      autopilot.autoRebuyAll,
      autopilot.tryUpdateAllData
    );

    res.json({ success: true, message: 'Auto-depart triggered' });
  } catch (error) {
    logger.error('[Auto-Depart] Trigger failed:', error);
    res.status(500).json({ error: 'Failed to trigger auto-depart' });
  }
});

/**
 * POST /api/autopilot/toggle - Pause/Resume autopilot
 *
 * Toggles autopilot paused state. When paused, the central autopilot monitor
 * still runs on its schedule, but skips all actions (depart, repair, rebuy, etc.).
 * Header data updates continue to run normally.
 */
router.post('/autopilot/toggle', async (req, res) => {
  try {
    const userId = getUserId();
    // (using broadcastToUser imported at top of file)

    // Toggle paused state in autopilot.js (global state)
    const currentlyPaused = autopilot.isAutopilotPaused();
    const newPausedState = !currentlyPaused;

    if (newPausedState) {
      autopilot.pauseAutopilot();
    } else {
      autopilot.resumeAutopilot();
    }

    const status = newPausedState ? 'paused' : 'resumed';
    logger.info(`[Autopilot] User ${userId} ${status} autopilot`);

    // Broadcast status to this user's connected clients
    broadcastToUser(userId, 'autopilot_status', {
      paused: newPausedState,
      message: `Autopilot ${status}`
    });

    res.json({
      success: true,
      paused: newPausedState,
      message: `Autopilot ${status}`
    });
  } catch (error) {
    logger.error('[Autopilot] Toggle failed:', error);
    res.status(500).json({ error: 'Failed to toggle autopilot' });
  }
});

/**
 * GET /api/autopilot/status - Get current autopilot pause status
 *
 * Returns the current autopilot paused state (global state from autopilot.js).
 * Used on page load to sync button state across all devices.
 */
router.get('/autopilot/status', async (req, res) => {
  try {
    const isPaused = autopilot.isAutopilotPaused();

    res.json({
      success: true,
      paused: isPaused
    });
  } catch (error) {
    logger.error('[Autopilot] Get status failed:', error);
    res.status(500).json({ error: 'Failed to get autopilot status' });
  }
});

/** POST /api/game/index - Proxies /game/index endpoint from game API */
router.post('/game/index', async (req, res) => {
  try {
    const data = await apiCall('/game/index', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error calling /game/index:', error);
    res.status(500).json({ error: 'Failed to fetch game index data' });
  }
});

module.exports = router;
