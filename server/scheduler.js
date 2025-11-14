/**
 * @fileoverview Scheduler Service
 *
 * Manages timed tasks using cron.
 *
 * Event-Driven Autopilot Architecture:
 * - Main loop runs every 60 seconds, checks game state
 * - Triggers autopilot functions based on conditions (vessels ready, repair needed, etc.)
 * - Price updates: :01 and :31 every hour (when game updates prices)
 * - Auto-Anchor: Every 5 minutes (separate from main loop)
 *
 * @module server/scheduler
 */

// Using 'cron' package instead of 'node-cron' because it handles DST properly
const { CronJob } = require('cron');
const autopilot = require('./autopilot');
const state = require('./state');
const { getUserId } = require('./utils/api');
const logger = require('./utils/logger');
const { isMigrationCompleted } = require('./utils/harbor-fee-store');
const { migrateHarborFeesForUser } = require('./utils/migrate-harbor-fees');

/**
 * Server ready state flag
 * Set to true after initial data load completes
 */
let serverReady = false;

/**
 * Initializes all schedulers.
 * Called once during server startup.
 */
function initScheduler() {
  logger.info('[Scheduler] Initializing schedulers...');

  // 1. Price Updates: At :01, :16, :31, :46 every hour (4 times per hour)
  // Game prices change at :00 and :30, we fetch 1 minute after to ensure fresh data
  new CronJob('0 1,16,31,46 * * * *', async () => {
    try {
      const userId = getUserId();
      if (!userId) return;

      logger.info('[Scheduler] Updating prices...');
      await autopilot.updatePrices();
    } catch (error) {
      logger.error('[Scheduler] Price update failed:', error.message);
    }
  }, null, true, 'Europe/Berlin');

  // 2. Auto-Anchor: Every 5 minutes
  new CronJob('0 */5 * * * *', async () => {
    try {
      logger.debug('[Scheduler] Auto-Anchor cron triggered');
      const userId = getUserId();
      if (!userId) {
        logger.debug('[Scheduler] Auto-Anchor skipped - no userId');
        return;
      }

      if (!serverReady) {
        logger.debug('[Scheduler] Auto-Anchor skipped - server not ready');
        return;
      }

      const settings = state.getSettings(userId);
      if (settings.autoAnchorPointEnabled) {
        const bunker = state.getBunkerState(userId);
        if (!bunker || bunker.points === undefined) {
          logger.warn('[Scheduler] Auto-Anchor skipped - bunker data not loaded');
          return;
        }

        logger.info('[Scheduler] Running Auto-Anchor (Harbormaster)');
        await autopilot.autoAnchorPointPurchase(userId);
      }
    } catch (error) {
      logger.error('[Scheduler] Auto-Anchor failed:', error);
    }
  }, null, true, 'Europe/Berlin');

  logger.info('[Scheduler] Schedulers initialized');
  logger.info('[Scheduler] - Auto-Anchor: every 5 minutes');
  logger.info('[Scheduler] - Price updates: every 60 seconds (in main event loop)');

  // Initial startup: Load essential data BEFORE starting event loop
  logger.info('[Scheduler] Loading initial UI data in 10 seconds...');
  setTimeout(async () => {
    logger.info('[Scheduler] INITIAL DATA LOAD FOR UI');

    try {
      const userId = getUserId();
      if (!userId) {
        throw new Error('[Scheduler] No user ID available');
      }

      const settings = state.getSettings(userId);
      if (!settings) {
        throw new Error('[Scheduler] No settings available');
      }

      // Initialize autopilot pause state
      autopilot.initializeAutopilotState(userId);

      // Load all initial data
      logger.info('[Scheduler] Step 1/3: Loading all game data...');
      await autopilot.updateAllData();

      logger.info('[Scheduler] Step 2/3: Loading current prices...');
      await autopilot.updatePrices();

      logger.info('[Scheduler] Step 3/3: Checking price alerts...');
      const prices = state.getPrices(userId);
      await autopilot.checkPriceAlerts(userId, prices);

      logger.info('[Scheduler] INITIAL DATA LOADED - UI READY');

      // Mark server as ready
      serverReady = true;

      // Harbor Fee Migration: Run once automatically on first startup
      logger.info('[Scheduler] Checking harbor fee migration status...');
      try {
        const migrationCompleted = await isMigrationCompleted();
        if (!migrationCompleted) {
          logger.info('[Scheduler] Starting automatic harbor fee migration...');
          logger.info('[Scheduler] This is a one-time migration of historical data from logbook');
          logger.info('[Scheduler] To re-run migration, delete: userdata/harbor-fees/.migration-completed');

          const stats = await migrateHarborFeesForUser(userId);

          if (stats.migrated > 0) {
            logger.info(`[Scheduler] Harbor fee migration completed: ${stats.migrated}/${stats.total} fees migrated`);
          } else {
            logger.info('[Scheduler] Harbor fee migration: No fees to migrate');
          }
        } else {
          logger.debug('[Scheduler] Harbor fee migration already completed (skip)');
        }
      } catch (error) {
        logger.error('[Scheduler] Harbor fee migration failed:', error.message);
        logger.error('[Scheduler] Migration can be re-run by deleting: userdata/harbor-fees/.migration-completed');
      }

      // Run Auto-Anchor once on startup
      logger.info('[Scheduler] Running Auto-Anchor on startup...');
      try {
        if (!autopilot.isAutopilotPaused()) {
          // (using settings from outer scope - already loaded on line 97)
          if (settings.autoAnchorPointEnabled) {
            await autopilot.autoAnchorPointPurchase(userId);
          } else {
            logger.debug('[Scheduler] Auto-Anchor disabled in settings');
          }
        } else {
          logger.debug('[Scheduler] Auto-Anchor skipped - Autopilot is PAUSED');
        }
      } catch (error) {
        logger.error('[Scheduler] Auto-Anchor startup run failed:', error);
      }

      // Start event-driven autopilot loop (60s interval)
      logger.info('[Scheduler] Starting event-driven autopilot loop...');
      autopilot.startMainEventLoop();

    } catch (error) {
      logger.error('[Scheduler] Initial data load failed:', error);
    }
  }, 10000);
}

/**
 * Check if server has completed initial data load
 * @returns {boolean} True if server is ready
 */
function isServerReady() {
  return serverReady;
}

module.exports = {
  initScheduler,
  isServerReady
};
