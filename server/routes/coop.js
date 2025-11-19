/**
 * @fileoverview Alliance Cooperation Routes
 *
 * Handles cooperation/coop vessel management within alliances.
 * Provides endpoints for viewing coop stats and member information.
 *
 * @module server/routes/coop
 * @requires express
 * @requires ../utils/api
 */

const express = require('express');
const router = express.Router();
const { apiCall, getUserId } = require('../utils/api');
const { broadcastToUser } = require('../websocket');
const logger = require('../utils/logger');

/**
 * GET /api/coop/data - Retrieves alliance cooperation data
 *
 * Fetches coop statistics including:
 * - Available coop slots (how many more vessels can be sent)
 * - Cap (maximum coop vessels per season)
 * - Sent/received this season
 * - Historical sent/received totals
 * - Member coop data (enabled status, fuel, vessels, etc.)
 *
 * Response Structure:
 * {
 *   data: {
 *     coop: {
 *       available: number,           // Coop slots remaining
 *       cap: number,                 // Maximum coop vessels per season
 *       sent_this_season: number,    // Vessels sent this season
 *       received_this_season: number,// Vessels received this season
 *       sent_historical: number,     // Total vessels sent historically
 *       received_historical: number  // Total vessels received historically
 *     },
 *     members_coop: [{
 *       user_id: number,
 *       company_name: string,        // Added from alliance contacts
 *       enabled: boolean,            // Whether coop is enabled for this member
 *       sent_this_season: number,
 *       sent_last_season: number,
 *       received_this_season: number,
 *       sent_historical: number,
 *       received_historical: number,
 *       total_vessels: number,
 *       fuel: number,
 *       donations_this_season: number,
 *       donations_historical: number,
 *       has_real_purchase: boolean
 *     }]
 *   }
 * }
 *
 * @name GET /api/coop/data
 * @function
 * @memberof module:server/routes/coop
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with coop data
 */
router.get('/coop/data', async (req, res) => {
  try {
    // Fetch coop data, contact data, member settings, and alliance data in parallel
    const [coopData, contactData, memberSettings, allianceData] = await Promise.all([
      apiCall('/coop/get-coop-data', 'POST', {}),
      apiCall('/contact/get-contacts', 'POST', {}),
      apiCall('/alliance/get-member-settings', 'POST', {}).catch(err => {
        logger.warn('[COOP] Failed to fetch member settings:', err.message);
        return { data: [] };
      }),
      apiCall('/alliance/get-user-alliance', 'POST', {})
    ]);

    // Add coop_boost (maximum coop slots with alliance boost) from alliance data
    if (allianceData.data?.alliance?.benefit?.coop_boost) {
      coopData.data.coop.coop_boost = allianceData.data.alliance.benefit.coop_boost;
    }

    const allianceContacts = contactData.data?.alliance_contacts;
    const settings = memberSettings.data;

    // Create a map of user_id -> company_name
    const companyNameMap = {};
    allianceContacts.forEach(contact => {
      companyNameMap[contact.id] = contact.company_name;
    });

    // Add own user's company name from COOP response (not always in alliance_contacts)
    if (coopData.user?.id && coopData.user?.company_name) {
      companyNameMap[coopData.user.id] = coopData.user.company_name;
    }

    // Create a map of user_id -> settings
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.user_id] = s;
    });

    // Add company_name and restrictions to each member in coop data
    if (coopData.data?.members_coop) {
      coopData.data.members_coop = coopData.data.members_coop.map(member => {
        const userSettings = settingsMap[member.user_id];
        const restrictions = [];

        // Check for no vessels
        if (member.total_vessels === 0) {
          restrictions.push({ type: 'no_vessels', message: 'No vessels available' });
        }

        // Check for low fuel (less than 10t = 10000kg)
        const fuelTons = member.fuel / 1000;
        if (fuelTons < 10) {
          restrictions.push({ type: 'low_fuel', message: `Low fuel (${fuelTons.toFixed(1)}t)` });
        }

        // Check for time restrictions (ALWAYS show if configured, mark if currently out of range)
        if (userSettings.restrictions?.time_range_enabled) {
          const [startHour, endHour] = userSettings.restrictions.time_restriction_arr;
          const now = new Date();
          const currentHour = now.getUTCHours(); // Game uses UTC

          // Convert endHour=0 to 24 (midnight)
          const effectiveEndHour = endHour === 0 ? 24 : endHour;

          let inTimeRange = false;
          if (startHour < effectiveEndHour) {
            // Normal range: e.g., 11-24 means 11:00 to 24:00 (midnight)
            inTimeRange = currentHour >= startHour && currentHour < effectiveEndHour;
          } else {
            // Range over midnight: e.g., 22-6 means 22:00 to 06:00 next day
            inTimeRange = currentHour >= startHour || currentHour < endHour;
          }

          // Send UTC hours to frontend for local timezone conversion
          restrictions.push({
            type: inTimeRange ? 'time_setting' : 'time_restriction',
            message: null, // Will be formatted in frontend with local timezone
            startHourUTC: startHour,
            endHourUTC: endHour,
            blocking: !inTimeRange
          });
        }

        // Check for vessel capacity restriction (ALWAYS show if configured)
        if (userSettings.restrictions?.selected_vessel_capacity > 0) {
          const minCapacityTons = Math.round(userSettings.restrictions.selected_vessel_capacity / 1000);
          restrictions.push({
            type: 'capacity_setting',
            message: `Only vessels ≥ ${minCapacityTons}t`,
            blocking: false // Capacity is always just a filter, not blocking
          });
        }

        return {
          ...member,
          company_name: companyNameMap[member.user_id] || `User ${member.user_id}`,
          restrictions,
          can_receive_coop: restrictions.length === 0
        };
      });
    }

    res.json(coopData);
  } catch (error) {
    logger.error('Error fetching coop data:', error);
    res.status(500).json({ error: 'Failed to fetch coop data' });
  }
});

/**
 * POST /api/coop/send-max - Sends maximum available coop vessels to a user
 *
 * @name POST /api/coop/send-max
 * @function
 * @memberof module:server/routes/coop
 * @param {express.Request} req - Express request object with { user_id: number }
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with depart result
 */
router.post('/coop/send-max', async (req, res) => {
  try {
    const { user_id } = req.body;

    // Validate user_id is provided and is a positive integer
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!Number.isInteger(user_id) || user_id <= 0) {
      return res.status(400).json({ error: 'Invalid user_id. Must be a positive integer' });
    }

    // Fetch current coop data to get available vessels and member info
    const coopData = await apiCall('/coop/get-coop-data', 'POST', {});
    const available = coopData.data?.coop?.available;

    if (available === 0) {
      return res.status(400).json({ error: 'No coop vessels available to send' });
    }

    // Find target member to check their vessel count
    const members = coopData.data?.members_coop;
    const targetMember = members.find(m => m.user_id === user_id);

    if (!targetMember) {
      return res.status(404).json({ error: 'Target user not found in alliance' });
    }

    // Calculate max vessels to send: min(my available, target's total vessels)
    const maxToSend = Math.min(available, targetMember.total_vessels);

    if (maxToSend === 0) {
      return res.status(400).json({ error: 'Target user has no vessels available' });
    }

    // Broadcast coop send start to lock buttons on all clients
    const userId = getUserId();
    if (userId) {
      broadcastToUser(userId, 'coop_send_start', {});
    }

    // Send max vessels to target user
    logger.info(`[COOP] Attempting to send ${maxToSend} vessels to user ${user_id}`);
    const result = await apiCall('/route/depart-coop', 'POST', {
      user_id,
      vessels: maxToSend
    });

    logger.debug('[COOP] API Response:', JSON.stringify(result, null, 2));

    // Check for errors in response
    if (result.error) {
      // Parse popup_alerts for real error message
      let errorCode = result.error;
      if (result.user?.popup_alerts && Array.isArray(result.user.popup_alerts)) {
        const coopAlert = result.user.popup_alerts.find(a => a.type === 'coop_departure');
        if (coopAlert?.data?.error) {
          errorCode = coopAlert.data.error;
        }
      }

      // Map error codes to user-friendly messages
      const errorMessages = {
        'coop_departure_no_income': 'Vessels not profitable',
        'no_vessels_are_ready_to_depart': 'No vessels ready to depart',
        'no_data': 'No data available'
      };

      const errorMessage = errorMessages[errorCode] || errorCode.replace(/_/g, ' ');

      // Broadcast complete even on error to unlock buttons
      if (userId) {
        broadcastToUser(userId, 'coop_send_complete', { departed: 0 });
      }

      return res.status(400).json({
        error: errorMessage,
        target_user: targetMember.company_name
      });
    }

    const departed = result.data?.vessels_departed;

    // Log successful COOP send
    if (userId && departed > 0) {
      try {
        const { auditLog, CATEGORIES, SOURCES } = require('../utils/audit-logger');

        await auditLog(
          userId,
          CATEGORIES.COOP,
          'Manual COOP Send',
          `Sent ${departed} vessel(s) to ${targetMember.company_name}`,
          {
            target_user_id: user_id,
            target_company_name: targetMember.company_name,
            vessels_sent: departed,
            vessels_requested: maxToSend,
            partial: departed < maxToSend
          },
          'SUCCESS',
          SOURCES.MANUAL
        );
      } catch (auditError) {
        logger.error('[COOP] Audit logging failed:', auditError.message);
        // Continue anyway - COOP send was successful
      }
    }

    // Broadcast coop send complete to unlock buttons
    if (userId) {
      broadcastToUser(userId, 'coop_send_complete', { departed });
    }

    // Fetch updated coop data and broadcast to update badge/header
    if (userId) {
      try {
        const updatedCoopData = await apiCall('/coop/get-coop-data', 'POST', {});
        const coop = updatedCoopData.data?.coop;
        if (coop) {
          broadcastToUser(userId, 'coop_update', {
            available: coop.available,
            cap: coop.cap,
            coop_boost: updatedCoopData.data?.alliance?.benefit?.coop_boost || coop.cap
          });
        }
      } catch (error) {
        logger.warn('[COOP] Failed to fetch updated coop data for broadcast:', error.message);
      }
    }

    res.json({
      success: true,
      requested: maxToSend,
      departed,
      partial: departed < maxToSend,
      data: result.data
    });

  } catch (error) {
    logger.error('[COOP] Error sending max vessels:', error);

    // Broadcast complete on exception to unlock buttons
    const userId = getUserId();
    if (userId) {
      broadcastToUser(userId, 'coop_send_complete', { departed: 0 });
    }

    res.status(500).json({ error: 'Failed to send coop vessels' });
  }
});

/**
 * POST /api/coop/update-settings - Updates alliance cooperation settings
 *
 * Updates the user's coop settings including enabled status and restrictions.
 *
 * Request Body:
 * {
 *   coop_enabled: boolean,      // Enable/disable coop
 *   capacity_min: number,       // Minimum vessel capacity (0 = no restriction)
 *   hhmm_from: number,          // Start hour UTC (0-23)
 *   hhmm_to: number,            // End hour UTC (1-24)
 *   time_range_enabled: boolean // Enable time restriction
 * }
 *
 * Response: Game API response
 */
router.post('/coop/update-settings', async (req, res) => {
  try {
    const settings = req.body;

    logger.info('[COOP] Updating settings:', settings);

    const result = await apiCall('/coop/update-settings', 'POST', settings);

    // Check if API returned an error
    if (result.error || result.success === false) {
      logger.error('[COOP] API returned error:', result);
      return res.status(500).json({ error: result.error || 'API request failed' });
    }

    logger.info('[COOP] Settings updated successfully:', result);

    res.json(result);
  } catch (error) {
    logger.error('[COOP] Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update coop settings' });
  }
});

module.exports = router;
