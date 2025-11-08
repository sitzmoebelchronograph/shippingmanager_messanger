/**
 * @fileoverview Fair Hand - Auto-COOP Sending Pilot
 *
 * Automatically sends available COOP vessels to alliance members.
 * Runs every 3 hours (0, 3, 6, 9, 12, 15, 18, 21 UTC).
 *
 * @module server/autopilot/pilot_fair_hand
 */

const cache = require('../cache');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { logAutopilotAction } = require('../logbook');

/**
 * Automatically sends available COOP vessels to alliance members.
 * Runs every 3 hours (0, 3, 6, 9, 12, 15, 18, 21 UTC).
 *
 * Logic:
 * - Check if COOP available
 * - Filter members who can receive (can_receive_coop === true)
 * - Sort by total_vessels DESC (largest fleets first)
 * - Send to each member until all COOP vessels distributed
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoCoop(autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.log('[Auto-COOP] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) {
    logger.log('[Auto-COOP] No user ID available, skipping');
    return;
  }

  const settings = state.getSettings(userId);
  if (!settings.autoCoopEnabled) {
    logger.log('[Auto-COOP] Auto-COOP is DISABLED in settings, skipping');
    return;
  }

  try {
    logger.log('[Auto-COOP] ========================================');
    logger.log('[Auto-COOP] Starting Auto-COOP distribution');
    logger.log('[Auto-COOP] ========================================');

    // Fetch COOP data with restrictions from our own API
    const axios = require('axios');
    const coopResponse = await axios.get('https://localhost:12345/api/coop/data', {
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
    });

    const coopData = coopResponse.data;
    const available = coopData.data?.coop?.available;
    const members = coopData.data?.members_coop;

    if (available === 0) {
      logger.log('[Auto-COOP] No COOP vessels available to send');
      return;
    }

    logger.log(`[Auto-COOP] Available COOP vessels: ${available}`);

    // Filter members who can receive (no restrictions)
    const eligibleMembers = members.filter(m => m.can_receive_coop === true && m.total_vessels > 0);

    if (eligibleMembers.length === 0) {
      logger.log('[Auto-COOP] No eligible members found (all have restrictions or no vessels)');

      // Notify user
      if (broadcastToUser) {
        broadcastToUser(userId, 'auto_coop_no_targets', {
          available,
          reason: 'All members have restrictions or no vessels'
        });
      }
      return;
    }

    // Sort by total_vessels DESC (largest fleets first)
    eligibleMembers.sort((a, b) => b.total_vessels - a.total_vessels);

    logger.log(`[Auto-COOP] Found ${eligibleMembers.length} eligible members`);

    // Track totals
    let totalSent = 0;
    let totalRequested = 0;
    const results = [];

    // Send to each eligible member
    for (const member of eligibleMembers) {
      // Refresh COOP data to get current available count
      const refreshResponse = await axios.get('https://localhost:12345/api/coop/data', {
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      const currentAvailable = refreshResponse.data.data?.coop?.available;

      if (currentAvailable === 0) {
        logger.log('[Auto-COOP] All COOP vessels distributed, stopping');
        break;
      }

      const maxToSend = Math.min(currentAvailable, member.total_vessels);

      logger.log(`[Auto-COOP] Sending ${maxToSend} vessels to ${member.company_name} (${member.user_id})...`);

      try {
        // Send via our own API endpoint
        const sendResponse = await axios.post('https://localhost:12345/api/coop/send-max', {
          user_id: member.user_id
        }, {
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });

        const result = sendResponse.data;
        totalRequested += result.requested;
        totalSent += result.departed;

        results.push({
          user_id: member.user_id,
          company_name: member.company_name,
          requested: result.requested,
          departed: result.departed,
          partial: result.partial
        });

        logger.log(`[Auto-COOP] OK Sent ${result.departed} of ${result.requested} to ${member.company_name}`);

        // Small delay between sends to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        logger.error(`[Auto-COOP] Failed to send to ${member.company_name}:`, error.message);
        results.push({
          user_id: member.user_id,
          company_name: member.company_name,
          error: error.message
        });
      }
    }

    logger.log('[Auto-COOP] ========================================');
    logger.log(`[Auto-COOP] Distribution complete: ${totalSent}/${totalRequested} vessels sent to ${results.length} members`);
    logger.log('[Auto-COOP] ========================================');

    // Broadcast results to user
    if (broadcastToUser) {
      logger.log(`[Auto-COOP] Broadcasting auto_coop_complete event (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);
      broadcastToUser(userId, 'auto_coop_complete', {
        totalRequested,
        totalSent,
        results
      });
    }

    // Log to autopilot logbook
    if (totalSent > 0) {
      await logAutopilotAction(
        userId,
        'Auto-COOP',
        'SUCCESS',
        `${totalSent} vessels | ${results.length} members`,
        {
          totalVessels: totalSent,
          totalRequested,
          recipientCount: results.length,
          distributions: results
        }
      );
    }

    // Invalidate COOP cache since we changed the available count
    if (totalSent > 0) {
      cache.invalidateCoopCache();
      await tryUpdateAllData();
    }

  } catch (error) {
    // Log error to autopilot logbook
    await logAutopilotAction(
      userId,
      'Auto-COOP',
      'ERROR',
      `COOP distribution failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      }
    );

    // AggregateError contains multiple errors in .errors array
    if (error.errors && Array.isArray(error.errors)) {
      logger.error('[Auto-COOP] Error during auto-COOP (AggregateError with multiple errors):');
      error.errors.forEach((err, index) => {
        logger.error(`[Auto-COOP] Error ${index + 1}/${error.errors.length}:`, err);
      });
    } else {
      logger.error('[Auto-COOP] Error during auto-COOP:', error);
    }
  }
}

module.exports = {
  autoCoop
};
