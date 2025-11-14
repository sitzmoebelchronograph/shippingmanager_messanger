// Emergency crash handler - catches uncaught exceptions BEFORE Winston logger is initialized
// In debug mode, this writes to stderr which is redirected to debug.log by start.py
// In normal mode, it tries to use Winston logger if available, otherwise writes to stderr
process.on('uncaughtException', (err) => {
  const timestamp = new Date().toISOString();
  const errorMsg = `[${timestamp}] UNCAUGHT EXCEPTION:\n${err.stack}\n`;

  // Try to write to Winston logger if it's already loaded
  try {
    if (global.logger) {
      global.logger.error('UNCAUGHT EXCEPTION:', err);
    }
  } catch {
    // Logger not available yet
  }

  // Fallback: console.error writes to stderr
  // In debug mode: stderr -> debug.log (via start.py)
  // In normal mode: stderr -> DEVNULL (but Winston logger should have caught it above)
  console.error(errorMsg);

  process.exit(1);
});

/**
 * @fileoverview Main application entry point for Shipping Manager CoPilot.
 * This is a standalone HTTPS web server that provides a workaround for the in-game chat bug
 * where certain characters cause page reloads. The application proxies API calls to
 * shippingmanager.cc with session-based authentication, providing real-time WebSocket updates,
 * alliance chat, private messaging, and game management features (fuel/CO2 purchasing, vessel
 * departures, bulk repairs, marketing campaigns).
 *
 * The server architecture:
 * - Express-based HTTPS server with self-signed certificates
 * - WebSocket server for real-time chat updates (25-second refresh interval)
 * - Modular route handlers for alliance, messenger, and game management
 * - Rate limiting and security middleware
 * - Network-accessible on all interfaces (listens on 0.0.0.0)
 *
 * @module app
 * @requires express
 * @requires os
 * @requires dotenv
 * @requires ./server/config
 * @requires ./server/middleware
 * @requires ./server/utils/api
 * @requires ./server/certificate
 * @requires ./server/websocket
 * @requires ./server/routes/alliance
 * @requires ./server/routes/messenger
 * @requires ./server/routes/game
 * @requires ./server/routes/settings
 * @requires ./server/routes/logbook
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Server modules
const logger = require('./server/utils/logger');
global.logger = logger;  // Make logger available to uncaught exception handler
const config = require('./server/config');
const { setupMiddleware } = require('./server/middleware');
const { initializeAlliance } = require('./server/utils/api');
const { createHttpsServer } = require('./server/certificate');
const { initWebSocket, broadcastToUser, startChatAutoRefresh, startMessengerAutoRefresh } = require('./server/websocket');
const { initScheduler } = require('./server/scheduler');
const autopilot = require('./server/autopilot');
const sessionManager = require('./server/utils/session-manager');

// Parent process monitoring - auto-shutdown if parent (Python) dies
if (process.ppid) {
  const checkParentInterval = setInterval(() => {
    try {
      // Check if parent process still exists
      process.kill(process.ppid, 0); // Signal 0 just checks existence
    } catch {
      // Parent process is dead, shut down immediately
      console.error('[SM-CoPilot] Parent process died, shutting down...');
      clearInterval(checkParentInterval);
      process.exit(0);
    }
  }, 1000); // Check every second
}

// Setup file logging - create new log file on each startup
// Use APPDATA for logs when running as .exe (pkg sets process.pkg)
const LOG_DIR = process.pkg
  ? path.join(config.getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'logs')
  : path.join(__dirname, 'userdata', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOG_DIR, 'server.log');

// Winston handles file logging automatically with timestamps
logger.info(`[Logging] Server logs will be written to: ${LOG_FILE}`);

// Route modules
const allianceRoutes = require('./server/routes/alliance');
const messengerRoutes = require('./server/routes/messenger');
const gameRoutes = require('./server/routes/game');
const settingsRoutes = require('./server/routes/settings');
const coopRoutes = require('./server/routes/coop');
const forecastRoutes = require('./server/routes/forecast');
const anchorRoutes = require('./server/routes/anchor');
const healthRoutes = require('./server/routes/health');
const logbookRoutes = require('./server/routes/logbook');
const harborMapRoutes = require('./server/routes/harbor-map');
const poiRoutes = require('./server/routes/poi');
const vesselImageRoutes = require('./server/routes/vessel-image');

// Initialize Express app
const app = express();

// Setup middleware
setupMiddleware(app);

/**
 * Serves the Certificate Authority (CA) certificate for download.
 * Users can install this CA certificate to trust all server certificates
 * generated by this application across their network.
 *
 * @name GET /ca-cert.pem
 * @function
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {void} Downloads the CA certificate file or sends 404 error
 */
app.get('/ca-cert.pem', (req, res) => {
  const { getAppDataDir } = require('./server/config');
  const CERTS_DIR = path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'certs');
  const caCertPath = path.join(CERTS_DIR, 'ca-cert.pem');

  res.download(caCertPath, 'ShippingManager-CA.pem', (err) => {
    if (err) {
      logger.error('Error downloading CA certificate:', err);
      res.status(404).send('CA certificate not found');
    }
  });
});

// Setup routes
app.use('/api', allianceRoutes);
app.use('/api', messengerRoutes);
app.use('/api', gameRoutes);
app.use('/api', settingsRoutes);
app.use('/api', coopRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api', anchorRoutes);
app.use('/health', healthRoutes);
app.use('/api/logbook', logbookRoutes);
app.use('/api/harbor-map', harborMapRoutes);
app.use('/api/poi', poiRoutes);
app.use('/api/vessel-image', vesselImageRoutes);

// Autopilot pause/resume endpoint
app.post('/api/autopilot/toggle', async (req, res) => {
  const isPaused = autopilot.isAutopilotPaused();

  if (isPaused) {
    await autopilot.resumeAutopilot();
    res.json({ success: true, paused: false });
  } else {
    await autopilot.pauseAutopilot();
    res.json({ success: true, paused: true });
  }
});

// Get autopilot status endpoint
app.get('/api/autopilot/status', (req, res) => {
  res.json({ paused: autopilot.isAutopilotPaused() });
});

// Create HTTPS server
const server = createHttpsServer(app);

// Initialize WebSocket
const wss = initWebSocket();

// HTTP Upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Settings initialization (will be done after user is loaded)
const { initializeSettings } = require('./server/settings-schema');
const chatBot = require('./server/chatbot');

(async () => {
  // Start server
  server.listen(config.PORT, config.HOST, async () => {
    // Load session cookie from encrypted storage FIRST
    logger.info('[Session] Loading sessions from encrypted storage...');

    try {
      const availableSessions = await sessionManager.getAvailableSessions();

      // Debug: Show all available sessions
      logger.info(`[Session] Found ${availableSessions.length} session(s) in storage`);
      availableSessions.forEach((s, idx) => {
        logger.debug(`[Session]   [${idx}] User ID: ${s.userId} (${typeof s.userId}), Company: ${s.companyName}, Method: ${s.loginMethod}`);
      });

      if (availableSessions.length === 0) {
        logger.error('[FATAL] No sessions found. Please run start.py to log in.');
        process.exit(1);
      }

      let selectedSession;

      // User selection ONLY via ENV (from start.py) - NO persistence
      const selectedUserId = process.env.SELECTED_USER_ID;
      logger.debug(`[Session] ENV SELECTED_USER_ID: ${selectedUserId} (${typeof selectedUserId})`);

      if (selectedUserId) {
        // User was selected via start.py - use that specific session
        logger.debug(`[Session] Searching for user ID: ${selectedUserId} in ${availableSessions.length} sessions...`);
        selectedSession = availableSessions.find(s => s.userId === selectedUserId);

        if (!selectedSession) {
          logger.error(`[FATAL] Selected user ${selectedUserId} not found in available sessions.`);
          logger.error('[FATAL] Available user IDs:');
          availableSessions.forEach(s => {
            logger.error(`[FATAL]   - ${s.userId} (type: ${typeof s.userId}) - ${s.companyName}`);
            logger.error(`[FATAL]     Match result: ${s.userId} === ${selectedUserId} ? ${s.userId === selectedUserId}`);
            logger.error(`[FATAL]     String match: "${String(s.userId)}" === "${String(selectedUserId)}" ? ${String(s.userId) === String(selectedUserId)}`);
          });
          logger.error('[FATAL] Please run start.py again to select a valid session.');
          process.exit(1);
        }

        logger.info(`[Session] Match found! Using session for user ${selectedSession.userId} (${selectedSession.companyName})`);
      } else if (availableSessions.length === 1) {
        // Only one session available - use it automatically
        selectedSession = availableSessions[0];
        logger.info(`[Session] Using session for user ${selectedSession.userId} (${selectedSession.companyName})`);
      } else {
        // Multiple sessions but no selection - error out
        logger.error('[FATAL] Multiple sessions found but no session selected.');
        logger.error('[FATAL] Please run start.py to select which session to use.');
        logger.error('[FATAL] Available sessions:');
        availableSessions.forEach(s => {
          logger.error(`[FATAL]   - User ${s.userId}: ${s.companyName} (${s.loginMethod})`);
        });
        process.exit(1);
      }

      // Set the session cookie in config
      config.setSessionCookie(selectedSession.cookie);
      logger.info('[Session] Session cookie loaded and decrypted');

    } catch (error) {
      logger.error('[FATAL] Failed to load session:', error.message);
      process.exit(1);
    }

    // Initialize alliance and user data
    await initializeAlliance();

    // Migrate any plaintext sessions to encrypted storage
    try {
      logger.debug('[Security] Checking for plaintext sessions to encrypt...');
      const migratedCount = await sessionManager.migrateToEncrypted();
      if (migratedCount > 0) {
        logger.info(`[Security] OK Successfully encrypted ${migratedCount} session(s)`);
      }
    } catch (error) {
      logger.error('[Security] Session migration failed:', error.message);
      logger.error('[Security] Sessions will remain in current format');
    }

    const state = require('./server/state');
    const { getUserId } = require('./server/utils/api');
    const userId = getUserId();

    if (!userId) {
      logger.error('[FATAL] Cannot load user ID. Please check session cookie.');
      process.exit(1);
    }

    logger.debug(`[Settings] Detected User ID: ${userId}`);
    logger.info(`[Settings] Loading user settings...`);

    // NOW load user-specific settings
    const settings = await initializeSettings(userId);

    // Load validated settings into state BEFORE initializing scheduler
    state.updateSettings(userId, settings);
    logger.info('[Autopilot] Settings loaded and validated:');
    if (settings.autoRebuyFuel) logger.debug(`[Autopilot] Barrel Boss enabled`);
    if (settings.autoRebuyCO2) logger.debug(`[Autopilot] Atmosphere Broker enabled`);
    if (settings.autoDepartAll) logger.debug(`[Autopilot] Cargo Marshal enabled`);
    if (settings.autoAnchorPointEnabled) logger.debug(`[Autopilot] Harbormaster enabled`);
    if (settings.autoBulkRepair) logger.debug(`[Autopilot] Yard Foreman enabled`);
    if (settings.autoCampaignRenewal) logger.debug(`[Autopilot] Reputation Chief enabled`);
    if (settings.autoCoopEnabled) logger.debug(`[Autopilot] Fair Hand enabled`);
    if (settings.autoNegotiateHijacking) logger.debug(`[Autopilot] Cap'n Blackbeard enabled`);

  // Initialize autopilot system (AFTER settings are loaded)
  autopilot.setBroadcastFunction(broadcastToUser);
  initScheduler();
  logger.info('[Autopilot] Backend autopilot system initialized');

  // Initialize Chat Bot with current settings
  const chatBotSettings = {
    enabled: settings.chatbotEnabled,
    commandPrefix: settings.chatbotPrefix,
    allianceCommands: {
      enabled: settings.chatbotAllianceCommandsEnabled,
      cooldownSeconds: settings.chatbotCooldownSeconds || 30
    },
    commands: {
      forecast: {
        enabled: settings.chatbotForecastCommandEnabled,
        responseType: 'dm',
        adminOnly: false
      },
      help: {
        enabled: settings.chatbotHelpCommandEnabled,
        responseType: 'dm',
        adminOnly: false
      }
    },
    scheduledMessages: {
      dailyForecast: {
        enabled: settings.chatbotDailyForecastEnabled,
        timeUTC: settings.chatbotDailyForecastTime,
        dayOffset: 1
      }
    },
    dmCommands: {
      enabled: settings.chatbotDMCommandsEnabled,
      deleteAfterReply: settings.chatbotDeleteDMAfterReply
    },
    customCommands: settings.chatbotCustomCommands || []
  };

  await chatBot.initialize(chatBotSettings);
  logger.info('[ChatBot] Chat Bot initialized with settings:');
  logger.debug(`[ChatBot] Enabled: ${settings.chatbotEnabled ? 'true' : 'false'}`);
  logger.debug(`[ChatBot] Command Prefix "${settings.chatbotPrefix}"`);
  if (settings.chatbotDailyForecastEnabled) {
    logger.debug(`[ChatBot] Daily Forecast enabled at ${settings.chatbotDailyForecastTime} UTC`);
  }
  if (settings.chatbotAllianceCommandsEnabled) {
    logger.debug(`[ChatBot] Alliance Commands enabled`);
  }
  if (settings.chatbotDMCommandsEnabled) {
    logger.debug(`[ChatBot] DM Commands enabled`);
  }

  // Start chat and messenger polling (both synchronized at 20 seconds)
  startChatAutoRefresh();
  startMessengerAutoRefresh();
  logger.debug('[Alliance Chat] Started 20-second chat polling');
  logger.debug('[Messenger] Started 20-second messenger polling');

  // Initialize POI cache and start automatic refresh
  await poiRoutes.initializePOICache();
  poiRoutes.startAutomaticCacheRefresh();

  // All automation runs via scheduler.js and autopilot.js

  // Display network addresses
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }

  // Only show network addresses if server is listening on all interfaces (0.0.0.0)
  const isNetworkAccessible = config.HOST === '0.0.0.0';

  if (isNetworkAccessible) {
    // Show all URLs in single line
    const urls = [`https://localhost:${config.PORT}`, ...addresses.map(addr => `https://${addr}:${config.PORT}`)];
    logger.info(`[Frontend] ShippingManager CoPilot Frontend running on: ${urls.join(', ')}`);
  } else {
    // Show only the configured specific IP
    logger.info(`[Frontend] ShippingManager CoPilot Frontend running on: https://${config.HOST}:${config.PORT}`);
  }
  logger.warn(`[Frontend] Self-signed certificate - accept security warning in browser`);
  });
})();
