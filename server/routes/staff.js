/**
 * @fileoverview Staff Management Routes
 *
 * This module provides endpoints for staff management including:
 * - Getting user staff data
 * - Raising/reducing staff salaries
 * - Training staff perks
 *
 * @requires express - Router and middleware
 * @requires ../utils/api - API helper functions
 * @requires ../utils/logger - Logging utility
 * @module server/routes/staff
 */

const express = require('express');
const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/staff/get-user-staff
 * Returns user's staff data including training, morale, and salaries
 *
 * @route POST /api/staff/get-user-staff
 * @returns {object} Staff data including all staff types and their perks
 * @error 500 - Failed to fetch staff data
 */
router.post('/get-user-staff', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/staff/get-user-staff', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error(`[Staff] Error fetching staff: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch staff data' });
  }
});

/**
 * POST /api/staff/raise-salary
 * Raises salary for a specific staff type
 *
 * @route POST /api/staff/raise-salary
 * @param {string} req.body.type - Staff type (cfo, coo, cmo, cto, captain, etc.)
 * @returns {object} Updated staff data with new salary
 * @error 500 - Failed to raise salary
 */
router.post('/raise-salary', express.json(), async (req, res) => {
  try {
    const { type } = req.body;
    const data = await apiCall('/staff/raise-salary', 'POST', { type });

    // Broadcast staff update via WebSocket
    try {
      const { broadcastToUser } = require('../websocket/broadcaster');
      const { getUserId } = require('../utils/api');
      const userId = getUserId();
      if (userId && data.data?.staff) {
        broadcastToUser(userId, 'staff_update', {
          staff_type: type,
          staff: data.data.staff,
          user: data.user
        });
      }
    } catch (broadcastError) {
      logger.error(`[Staff] WebSocket broadcast failed: ${broadcastError.message}`);
    }

    res.json(data);
  } catch (error) {
    logger.error(`[Staff] Error raising salary: ${error.message}`);
    res.status(500).json({ error: 'Failed to raise salary' });
  }
});

/**
 * POST /api/staff/reduce-salary
 * Reduces salary for a specific staff type
 *
 * @route POST /api/staff/reduce-salary
 * @param {string} req.body.type - Staff type (cfo, coo, cmo, cto, captain, etc.)
 * @returns {object} Updated staff data with new salary
 * @error 500 - Failed to reduce salary
 */
router.post('/reduce-salary', express.json(), async (req, res) => {
  try {
    const { type } = req.body;
    const data = await apiCall('/staff/reduce-salary', 'POST', { type });

    // Broadcast staff update via WebSocket
    try {
      const { broadcastToUser } = require('../websocket/broadcaster');
      const { getUserId } = require('../utils/api');
      const userId = getUserId();
      if (userId && data.data?.staff) {
        broadcastToUser(userId, 'staff_update', {
          staff_type: type,
          staff: data.data.staff,
          user: data.user
        });
      }
    } catch (broadcastError) {
      logger.error(`[Staff] WebSocket broadcast failed: ${broadcastError.message}`);
    }

    res.json(data);
  } catch (error) {
    logger.error(`[Staff] Error reducing salary: ${error.message}`);
    res.status(500).json({ error: 'Failed to reduce salary' });
  }
});

/**
 * POST /api/staff/spend-training-point
 * Spends a training point on a staff perk
 *
 * @route POST /api/staff/spend-training-point
 * @param {string} req.body.type - Staff type (cfo, coo, cmo, cto, captain, first_officer, boatswain, technical_officer)
 * @param {string} req.body.perk_type - Perk type name
 *
 * Available perk types by staff:
 * - CFO: shop_cash, lower_channel_fees, cheap_anchor_points, cheap_fuel, cheap_co2, cheap_harbor_fees, cheap_route_creation_fee
 * - COO: happier_staff, less_crew, improved_staff_negotiations, lower_hijacking_chance, cheap_guards
 * - CMO: higher_demand, cheap_marketing
 * - CTO: reduce_co2_consumption, reduce_fuel_consumption, travel_speed_increase, slower_wear, cheaper_maintenance
 * - Captain: lower_crew_unhappiness
 * - First Officer: less_crew_needed
 * - Boatswain: slower_wear_boatswain
 * - Technical Officer: less_fuel_consumption
 *
 * @returns {object} Updated staff data with trained perk
 * @error 500 - Failed to train perk
 */
router.post('/spend-training-point', express.json(), async (req, res) => {
  try {
    const { type, perk_type } = req.body;
    const data = await apiCall('/staff/spend-training-point', 'POST', { type, perk_type });

    // Broadcast staff update via WebSocket
    try {
      const { broadcastToUser } = require('../websocket/broadcaster');
      const { getUserId } = require('../utils/api');
      const userId = getUserId();
      if (userId && data.data?.staff) {
        broadcastToUser(userId, 'staff_update', {
          staff_type: type,
          staff: data.data.staff,
          user: data.user,
          perk_modifiers: data.data.perk_modifiers
        });
      }
    } catch (broadcastError) {
      logger.error(`[Staff] WebSocket broadcast failed: ${broadcastError.message}`);
    }

    res.json(data);
  } catch (error) {
    logger.error(`[Staff] Error training perk: ${error.message}`);
    res.status(500).json({ error: 'Failed to train perk' });
  }
});

module.exports = router;
