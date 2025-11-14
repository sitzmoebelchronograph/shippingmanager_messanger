/**
 * @fileoverview Reputation Chief - Auto Campaign Renewal Pilot
 *
 * Automatically renews reputation/awareness/green campaigns when they expire.
 * Event-driven: triggers immediately when active campaigns < 3.
 *
 * @module server/autopilot/pilot_reputation_chief
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const { auditLog, CATEGORIES, SOURCES, formatCurrency } = require('../utils/audit-logger');

/**
 * Auto campaign renewal for a single user.
 * Called by central autopilot monitor when campaigns < 3.
 *
 * @async
 * @param {Object|null} campaignData - Optional pre-fetched campaign data to avoid duplicate API calls
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoCampaignRenewal(campaignData = null, autopilotPaused, broadcastToUser, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.debug('[Auto-Campaign] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);
  if (!settings.autoCampaignRenewal) {
    logger.debug('[Auto-Campaign] Feature disabled in settings');
    return;
  }

  try {
    const campaigns = campaignData || await gameapi.fetchCampaigns();

    const activeCampaigns = campaigns.active;
    const availableCampaigns = campaigns.available;

    logger.debug(`[Auto-Campaign] Active campaigns: ${activeCampaigns.length}, Available: ${availableCampaigns.length}`);

    // Check which types are active
    const activeCampaignTypes = new Set(activeCampaigns.map(c => c.option_name));
    logger.debug(`[Auto-Campaign] Active types: ${Array.from(activeCampaignTypes).join(', ') || 'none'}`);

    // Find all types that are NOT active (need renewal)
    const allPossibleTypes = ['reputation', 'awareness', 'green'];
    const typesToRenew = allPossibleTypes.filter(type => !activeCampaignTypes.has(type));

    logger.debug(`[Auto-Campaign] Types needing renewal: ${typesToRenew.join(', ') || 'none'}`);

    if (typesToRenew.length === 0) {
      logger.debug('[Auto-Campaign] All campaign types are active, no renewal needed');
      return;
    }

    const bunker = await gameapi.fetchBunkerState();

    // Check minimum cash balance
    const minCash = settings.autoCampaignRenewalMinCash !== undefined ? settings.autoCampaignRenewalMinCash : 0;
    if (bunker.cash < minCash) {
      logger.debug(`[Auto-Campaign] Cash balance $${bunker.cash.toLocaleString()} below minimum $${minCash.toLocaleString()}`);
      return;
    }
    let currentCash = bunker.cash;

    const renewed = [];

    for (const type of typesToRenew) {
      // Find best affordable campaign of this type (most expensive that we can afford)
      const campaignsOfType = availableCampaigns
        .filter(c => c.option_name === type && c.price <= currentCash)
        .sort((a, b) => b.price - a.price); // Most expensive first

      if (campaignsOfType.length > 0) {
        const campaign = campaignsOfType[0];

        try {
          await gameapi.activateCampaign(campaign.id);
          renewed.push({ type, name: campaign.name, price: campaign.price, duration: campaign.duration });
          currentCash -= campaign.price;
          logger.debug(`[Auto-Campaign] Renewed "${campaign.name}" (${type}) - Cost: $${campaign.price.toLocaleString()}, Duration: ${campaign.duration}h`);
        } catch (error) {
          logger.error(`[Auto-Campaign] Failed to renew ${type}:`, error.message);
        }
      } else {
        logger.debug(`[Auto-Campaign] No affordable ${type} campaigns (cash: $${currentCash.toLocaleString()})`);
      }
    }

    if (renewed.length > 0) {
      // Log summary
      const summary = renewed.map(r => `${r.name} (${r.duration}h, $${r.price.toLocaleString()})`).join(', ');
      logger.info(`[Auto-Campaign] Renewed ${renewed.length} campaign(s): ${summary}`);

      if (broadcastToUser) {
        logger.debug(`[Auto-Campaign] Broadcasting campaigns_renewed (Desktop notifications: ${settings.enableDesktopNotifications ? 'ENABLED' : 'DISABLED'})`);
        broadcastToUser(userId, 'campaigns_renewed', {
          campaigns: renewed
        });
      } else {
        logger.error('[Auto-Campaign] broadcastToUser is NULL, cannot send notification!');
      }

      // Calculate total cost
      const totalCost = renewed.reduce((sum, r) => sum + r.price, 0);

      // Log to autopilot logbook
      await auditLog(
        userId,
        CATEGORIES.MARKETING,
        'Auto-Campaign',
        `${renewed.length} campaign${renewed.length > 1 ? 's' : ''} | -${formatCurrency(totalCost)}`,
        {
          campaignCount: renewed.length,
          totalCost,
          renewedCampaigns: renewed
        },
        'SUCCESS',
        SOURCES.AUTOPILOT
      );

      // Update all data to refresh campaign badge and cash/points
      await tryUpdateAllData();
    }

  } catch (error) {
    logger.error('[Auto-Campaign] Error:', error.message);

    // Log error to autopilot logbook
    await auditLog(
      userId,
      CATEGORIES.MARKETING,
      'Auto-Campaign',
      `Campaign renewal failed: ${error.message}`,
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
  autoCampaignRenewal
};
