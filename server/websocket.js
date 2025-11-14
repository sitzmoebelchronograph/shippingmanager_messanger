/**
 * @fileoverview WebSocket Server and Real-Time Chat Update Management
 *
 * This module manages bidirectional real-time communication between the server and connected
 * browser clients using WebSocket protocol. It implements automatic chat feed broadcasting
 * at regular intervals to keep all connected clients synchronized with alliance chat updates.
 *
 * Key Features:
 * - WebSocket server initialization and connection lifecycle management
 * - Automatic chat feed polling every 25 seconds (configurable in config.js)
 * - Broadcast system pushing updates to all connected clients simultaneously
 * - Message transformation (converting API format to client-ready format)
 * - Company name caching to reduce API calls during message processing
 * - Graceful handling of users not in alliance (skips polling)
 *
 * Why This Architecture:
 * - HTTP polling from frontend would be inefficient and waste bandwidth
 * - Server-side polling centralizes API calls (1 API call → N clients)
 * - WebSocket enables instant push updates without client polling
 * - Automatic refresh ensures clients stay synchronized even if inactive
 * - 25-second interval balances freshness with rate limit compliance
 *
 * Message Flow:
 *   API (25s interval) → getChatFeed() → Transform Messages → Broadcast → All Clients
 *
 * WebSocket Protocol:
 * - Messages sent as JSON strings: { type: 'chat_update', data: [...messages] }
 * - Client connects via wss://localhost:12345 (secure WebSocket)
 * - Server broadcasts to all OPEN connections only (skips CONNECTING/CLOSING states)
 *
 * Rate Limiting Consideration:
 * - One server-side API call every 25 seconds for all clients
 * - Without WebSocket, 10 clients would make 10 API calls every 25 seconds
 * - Centralized polling reduces API load by factor of N (number of clients)
 *
 * @requires ws - WebSocket server implementation
 * @requires ./utils/api - API helper functions (getChatFeed, getCompanyName, getAllianceId)
 * @requires ./config - Configuration constants (CHAT_REFRESH_INTERVAL)
 * @module server/websocket
 */

const WebSocket = require('ws');
const { getChatFeed, getCompanyName, getAllianceId, apiCall } = require('./utils/api');
const config = require('./config');
const { getAppDataDir } = require('./config');
const logger = require('./utils/logger');
// chatBot is lazy-loaded to avoid circular dependency (chatbot requires websocket)
const fs = require('fs');
const path = require('path');

/**
 * Get cache file path for processed DM message IDs for a specific user
 * @param {string|number} userId - User ID
 * @returns {string} Path to user-specific processed messages cache file
 */
function getProcessedMessagesCachePath(userId) {
  return process.pkg
    ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`)
    : path.join(__dirname, '..', 'userdata', 'chatbot', `processed_dm_messages-${userId}.json`);
}

/**
 * In-memory map of processed message IDs per user (loaded from cache files)
 * @type {Map<string, Set<string>>}
 */
const processedMessageIds = new Map();

/**
 * Get processed message IDs set for a specific user
 * @param {string|number} userId - User ID
 * @returns {Set<string>} Set of processed message identifiers
 */
function getProcessedMessageIds(userId) {
  const userIdString = String(userId);
  if (!processedMessageIds.has(userIdString)) {
    processedMessageIds.set(userIdString, new Set());
  }
  return processedMessageIds.get(userIdString);
}

/**
 * Load processed message IDs from cache file for a specific user
 * @param {string|number} userId - User ID
 */
function loadProcessedMessageCache(userId) {
  try {
    const cachePath = getProcessedMessagesCachePath(userId);
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      const ids = JSON.parse(data);
      const userSet = getProcessedMessageIds(userId);
      ids.forEach(id => userSet.add(id));
      logger.debug(`[Messenger] Loaded ${userSet.size} processed message IDs from cache for user ${userId}`);
    } else {
      logger.debug(`[Messenger] No cache file found for user ${userId}, starting with empty processed messages cache`);
    }
  } catch (error) {
    logger.error(`[Messenger] Error loading processed messages cache for user ${userId}:`, error.message);
    // Ensure empty set exists even on error
    getProcessedMessageIds(userId);
  }
}

/**
 * Save processed message IDs to cache file for a specific user
 * @param {string|number} userId - User ID
 */
function saveProcessedMessageCache(userId) {
  try {
    const cachePath = getProcessedMessagesCachePath(userId);
    const dataDir = path.dirname(cachePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const userSet = getProcessedMessageIds(userId);
    fs.writeFileSync(cachePath, JSON.stringify([...userSet], null, 2));
  } catch (error) {
    logger.error(`[Messenger] Error saving processed messages cache for user ${userId}:`, error.message);
  }
}

/**
 * WebSocket server instance (shared across all connections)
 * @type {WebSocket.Server|null}
 */
let wss = null;

/**
 * Interval timer for automatic chat refresh (25-second polling)
 * @type {NodeJS.Timeout|null}
 */
let chatRefreshInterval = null;

/**
 * Flag to prevent overlapping chat refresh requests.
 * @type {boolean}
 */
let isChatRefreshing = false;

/**
 * Timestamp of last processed message (Unix timestamp in seconds).
 * Used to detect new messages for ChatBot processing.
 * @type {number}
 */
let lastProcessedMessageTime = Date.now() / 1000;

/**
 * Interval timer for automatic messenger refresh (15-second polling)
 * @type {NodeJS.Timeout|null}
 */
let messengerRefreshInterval = null;

/**
 * Flag to prevent overlapping messenger refresh requests.
 * @type {boolean}
 */
let isMessengerRefreshing = false;

/**
 * Interval timer for automatic hijacking refresh (30-second polling)
 * @type {NodeJS.Timeout|null}
 */
let hijackingRefreshInterval = null;

/**
 * Flag to prevent overlapping hijacking refresh requests.
 * @type {boolean}
 */
let isHijackingRefreshing = false;

/**
 * Cache for solved/paid hijacking cases to reduce API calls.
 * Cases in this set will not trigger /hijacking/get-case API calls.
 * @type {Set<number>}
 */
const solvedHijackingCases = new Set();

/**
 * Shared cache for hijacking case details.
 * Maps case_id -> { details, timestamp, isOpen }
 * Reduces duplicate /hijacking/get-case API calls.
 * @type {Map<number, {details: Object, timestamp: number, isOpen: boolean}>}
 */
const hijackingCaseDetailsCache = new Map();

/**
 * Cache TTL for hijacking case details.
 * Open cases: 5 minutes (prices can change)
 * Solved cases: Permanent (never changes)
 * @constant {number}
 */
const HIJACKING_CASE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Shared cache for /messenger/get-chats API responses.
 * Reduces duplicate API calls from messenger refresh, hijacking refresh, and badge updates.
 * @type {{ data: Array|null, timestamp: number }}
 */
let messengerChatsCache = {
  data: null,
  timestamp: 0
};

/**
 * Cache TTL for /messenger/get-chats in milliseconds (15 seconds).
 * @constant {number}
 */
const MESSENGER_CHATS_CACHE_TTL = 15000;

/**
 * Fetches messenger chats with shared caching to reduce duplicate API calls.
 *
 * Multiple systems need chat data (messenger refresh, hijacking refresh, badge updates).
 * Without caching, each would make separate API calls to /messenger/get-chats.
 * This function implements a 15-second cache that all systems share.
 *
 * Cache Logic:
 * - If cache is fresh (< 15 seconds old), return cached data immediately
 * - If cache is stale (>= 15 seconds old), fetch fresh data and update cache
 * - Cache is shared across all callers (messenger, hijacking, badges)
 *
 * Impact:
 * - Reduces ~3 duplicate API calls per 15-second window to just 1 call
 * - Saves ~12 API calls/minute during typical usage
 * - All callers get synchronized data from same fetch
 *
 * @async
 * @function getCachedMessengerChats
 * @returns {Promise<Array>} Array of chat objects from /messenger/get-chats
 *
 * @example
 * // Called by messenger refresh, hijacking refresh, and badge updates
 * const chats = await getCachedMessengerChats();
 * const unreadCount = chats.filter(c => c.new).length;
 */
async function getCachedMessengerChats() {
  const now = Date.now();
  const cacheAge = now - messengerChatsCache.timestamp;

  // Return cached data if still fresh
  if (messengerChatsCache.data && cacheAge < MESSENGER_CHATS_CACHE_TTL) {
    logger.debug(`[Messenger Cache] Using cached data (age: ${Math.round(cacheAge / 1000)}s)`);
    return messengerChatsCache.data;
  }

  // Cache stale or empty - fetch fresh data
  try {
    // (using apiCall imported at top of file)
    const data = await apiCall('/messenger/get-chats', 'POST', {});
    const chats = data?.data;

    // Update cache
    messengerChatsCache = {
      data: chats,
      timestamp: now
    };

    logger.debug(`[Messenger Cache] Fetched fresh data (${chats.length} chats)`);

    return chats;
  } catch (error) {
    logger.error('[Messenger Cache] Error fetching chats:', error.message);

    // Return stale cache if available (better than nothing)
    if (messengerChatsCache.data) {
      logger.warn('[Messenger Cache] Returning stale cache due to error');
      return messengerChatsCache.data;
    }

    return [];
  }
}

/**
 * Fetches hijacking case details with shared caching to reduce duplicate API calls.
 *
 * Caching strategy:
 * - Solved cases: Cached permanently (never changes)
 * - Open cases: Cached for 5 minutes (prices can change)
 *
 * This eliminates duplicate /hijacking/get-case calls from:
 * - performHijackingRefresh() (60s interval)
 * - autoNegotiateHijacking() (via autopilot)
 *
 * @param {number} caseId - Hijacking case ID
 * @returns {Promise<{isOpen: boolean, details: Object, cached: boolean}|null>}
 */
async function getCachedHijackingCase(caseId) {
  try {
    const now = Date.now();

    // Check if already in cache
    if (hijackingCaseDetailsCache.has(caseId)) {
      const cached = hijackingCaseDetailsCache.get(caseId);
      const age = now - cached.timestamp;

      // Solved cases: Cache forever
      if (!cached.isOpen) {
        logger.debug(`[Hijacking Cache] Case ${caseId} (solved) from cache`);
        return { ...cached, cached: true };
      }

      // Open cases: Cache for 5 minutes
      if (age < HIJACKING_CASE_CACHE_TTL) {
        logger.debug(`[Hijacking Cache] Case ${caseId} (open) from cache (age: ${Math.round(age / 1000)}s)`);
        return { ...cached, cached: true };
      }

      // Cache expired for open case
      logger.debug(`[Hijacking Cache] Case ${caseId} cache expired (age: ${Math.round(age / 1000)}s), refreshing`);
    }

    // Fetch fresh data from API
    const caseData = await apiCall('/hijacking/get-case', 'POST', { case_id: caseId });
    const details = caseData?.data;
    if (!details) return null;

    const isOpen = details.paid_amount === null && details.status !== 'solved';

    // Store in cache
    hijackingCaseDetailsCache.set(caseId, {
      details,
      timestamp: now,
      isOpen
    });

    // Also add to solvedHijackingCases Set if solved (legacy compatibility)
    if (!isOpen) {
      solvedHijackingCases.add(caseId);
      logger.debug(`[Hijacking] Case ${caseId} solved, added to cache`);
    }

    logger.debug(`[Hijacking Cache] Case ${caseId} fetched from API (status: ${isOpen ? 'open' : 'solved'})`);

    return { isOpen, details, cached: false };
  } catch (error) {
    logger.error(`[Hijacking Cache] Error fetching case ${caseId}:`, error.message);
    return null;
  }
}

/**
 * Initializes the WebSocket server and sets up connection event handlers.
 *
 * This function creates a WebSocket server that operates in "noServer" mode, meaning
 * it shares the HTTPS server's port rather than opening a separate port. The upgrade
 * from HTTP to WebSocket happens via the HTTP server's 'upgrade' event (handled in app.js).
 *
 * Why noServer Mode:
 * - Shares HTTPS port 12345 instead of requiring separate WebSocket port
 * - Simplifies firewall configuration (one port instead of two)
 * - Works seamlessly with HTTPS and self-signed certificates
 * - Standard pattern for integrating WebSocket with Express
 *
 * Connection Lifecycle:
 * 1. Client sends HTTP Upgrade request to wss://localhost:12345
 * 2. Server upgrades connection to WebSocket protocol
 * 3. 'connection' event fires, logging "Client connected"
 * 4. Client remains connected until page close or network interruption
 * 5. 'close' event fires, logging "Client disconnected"
 *
 * Error Handling:
 * - Errors logged to console but don't crash server
 * - Clients can reconnect automatically after errors
 *
 * Side Effects:
 * - Sets module-level `wss` variable for use in broadcast()
 * - Logs connection/disconnection events to console
 *
 * @function initWebSocket
 * @param {https.Server} server - HTTPS server instance (from app.js)
 * @returns {WebSocket.Server} WebSocket server instance
 *
 * @example
 * const server = createHttpsServer(app);
 * const wss = initWebSocket();
 * // WebSocket server now listening for upgrade requests
 */
function initWebSocket() {
  wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', async (ws) => {
    logger.debug('[WebSocket] Client connected');

    // Send ALL cached data immediately on connect
    try {
      const autopilot = require('./autopilot');
      const { getUserId } = require('./utils/api');
      const state = require('./state');

      const userId = getUserId();
      if (userId) {
        // Load processed message IDs cache for this user (if not already loaded)
        if (!processedMessageIds.has(String(userId))) {
          loadProcessedMessageCache(userId);
        }

        logger.debug('[WebSocket] Sending all cached data to client...');

        // Send current autopilot pause status FIRST
        ws.send(JSON.stringify({
          type: 'autopilot_status',
          data: { paused: autopilot.isAutopilotPaused() }
        }));

        // Send current lock statuses (prevents stuck locks after page reload/server restart)
        const locks = state.getAllLocks(userId);
        ws.send(JSON.stringify({
          type: 'lock_status',
          data: locks
        }));

        // Send ALL cached data from state
        try {
          // Prices
          const prices = state.getPrices(userId);
          // CRITICAL: Only send prices if BOTH fuel AND co2 are valid (> 0)
          // DO NOT send if either is 0, undefined, or null - frontend will keep cached value
          if (prices && prices.fuel > 0 && prices.co2 > 0) {
            ws.send(JSON.stringify({
              type: 'price_update',
              data: {
                fuel: prices.fuel,
                co2: prices.co2,
                eventDiscount: prices.eventDiscount,
                regularFuel: prices.regularFuel,
                regularCO2: prices.regularCO2
              }
            }));
            logger.debug('[WebSocket] OK Prices sent');
          } else if (prices) {
            logger.warn(`[WebSocket] ✗ Prices NOT sent - invalid values: fuel=${prices.fuel}, co2=${prices.co2}`);
          }

          // Bunker state (fuel, CO2, cash, points)
          const bunker = state.getBunkerState(userId);
          if (bunker) {
            ws.send(JSON.stringify({
              type: 'bunker_update',
              data: bunker
            }));
            logger.debug('[WebSocket] OK Bunker state sent');
          }

          // Vessel counts
          let vesselCounts = state.getVesselCounts(userId);
          if (!vesselCounts) {
            // No cached data - fetch fresh from game API
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

                vesselCounts = { readyToDepart, atAnchor, pending };
                state.updateVesselCounts(userId, vesselCounts);
                logger.debug('[WebSocket] Vessel counts fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch vessel counts:', error.message);
            }
          }

          if (vesselCounts) {
            ws.send(JSON.stringify({
              type: 'vessel_count_update',
              data: vesselCounts
            }));
            logger.debug('[WebSocket] OK Vessel counts sent');
          }

          // Repair count
          let repairCount = state.getRepairCount(userId);
          if (repairCount === undefined) {
            // No cached data - fetch fresh from game API
            try {
              const vesselsResponse = await apiCall('/game/index', 'GET');
              if (vesselsResponse?.vessels) {
                const { getUserSettings } = require('./utils/api');
                const userSettings = getUserSettings();
                const maintenanceThreshold = userSettings?.maintenanceThreshold;
                if (maintenanceThreshold !== undefined) {
                  repairCount = vesselsResponse.vessels.filter(v =>
                    v.status === 'ready' && v.maintenance < maintenanceThreshold
                  ).length;
                  state.updateRepairCount(userId, repairCount);
                  logger.debug('[WebSocket] Repair count fetched from API');
                }
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch repair count:', error.message);
            }
          }

          if (repairCount !== undefined) {
            ws.send(JSON.stringify({
              type: 'repair_count_update',
              data: { count: repairCount }
            }));
            logger.debug('[WebSocket] OK Repair count sent');
          }

          // Drydock count
          let drydockCount = state.getDrydockCount(userId);
          if (drydockCount === undefined) {
            // No cached data - fetch fresh from game API
            try {
              const vesselsResponse = await apiCall('/game/index', 'GET');
              if (vesselsResponse?.vessels) {
                const { getUserSettings } = require('./utils/api');
                const userSettings = getUserSettings();
                const drydockThreshold = userSettings?.autoDrydockThreshold;
                if (drydockThreshold !== undefined) {
                  drydockCount = vesselsResponse.vessels.filter(v =>
                    v.status === 'ready' && v.age >= drydockThreshold
                  ).length;
                  state.updateDrydockCount(userId, drydockCount);
                  logger.debug('[WebSocket] Drydock count fetched from API');
                }
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch drydock count:', error.message);
            }
          }

          if (drydockCount !== undefined) {
            ws.send(JSON.stringify({
              type: 'drydock_count_update',
              data: { count: drydockCount }
            }));
            logger.debug('[WebSocket] OK Drydock count sent');
          }

          // Campaign status
          let campaignStatus = state.getCampaignStatus(userId);
          if (!campaignStatus) {
            // No cached data - fetch fresh from game API
            try {
              const campaignsResponse = await apiCall('/campaign/get-campaign', 'POST', {});
              if (campaignsResponse?.data?.campaigns) {
                const campaigns = campaignsResponse.data.campaigns;
                const activeCount = campaigns.filter(c => c.status === 'active').length;
                const active = campaigns.filter(c => c.status === 'active');
                campaignStatus = { activeCount, active };
                state.updateCampaignStatus(userId, campaignStatus);
                logger.debug('[WebSocket] Campaign status fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch campaign status:', error.message);
            }
          }

          if (campaignStatus) {
            ws.send(JSON.stringify({
              type: 'campaign_status_update',
              data: campaignStatus
            }));
            logger.debug('[WebSocket] OK Campaign status sent');
          }

          // COOP data - alliance-dependent
          // (using getAllianceId imported at top of file)
          const allianceId = getAllianceId();

          if (!allianceId) {
            // User NOT in alliance - send explicit clear signal
            ws.send(JSON.stringify({
              type: 'coop_update',
              data: { available: 0, cap: 0, coop_boost: 0 }
            }));
            logger.debug('[WebSocket] OK COOP cleared (no alliance)');
          } else {
            // User in alliance - fetch/send COOP data
            let coopData = state.getCoopData(userId);
            if (!coopData) {
              // No cached data - fetch fresh from game API
              try {
                const coopResponse = await apiCall('/coop/get-coop-data', 'POST', {});
                if (coopResponse?.data?.coop) {
                  const coop = coopResponse.data.coop;
                  coopData = {
                    available: coop.available,
                    cap: coop.cap,
                    coop_boost: coop.coop_boost
                  };
                  // Cache for future use
                  state.updateCoopData(userId, coopData);
                  logger.debug('[WebSocket] OK COOP data fetched from API (cache was empty)');
                }
              } catch (coopError) {
                logger.error('[WebSocket] Failed to fetch COOP data:', coopError.message);
              }
            }

            // Always send COOP data (even if null - will be loaded later by updateAllData)
            // This ensures the COOP button becomes visible immediately for alliance members
            if (coopData) {
              ws.send(JSON.stringify({
                type: 'coop_update',
                data: coopData
              }));
              logger.debug('[WebSocket] OK COOP data sent');
            } else {
              // Send placeholder to make button visible (data will be updated later)
              ws.send(JSON.stringify({
                type: 'coop_update',
                data: { available: 0, cap: 1, coop_boost: 0 }  // cap: 1 to show button
              }));
              logger.debug('[WebSocket] OK COOP placeholder sent (data will load later)');
            }
          }

          // Header data (stock, anchor) - alliance-dependent
          // Send header data (stock + anchor)
          let headerData = state.getHeaderData(userId);
          if (!headerData) {
            // No cached data - fetch fresh from game API
            try {
              const userSettingsResponse = await apiCall('/user/get-user-settings', 'GET');
              if (userSettingsResponse?.user?.stock && userSettingsResponse?.user?.anchorpoints) {
                const stock = userSettingsResponse.user.stock;
                const anchor = userSettingsResponse.user.anchorpoints;
                headerData = {
                  stock: {
                    value: stock.value,
                    trend: stock.trend,
                    ipo: stock.ipo
                  },
                  anchor: {
                    available: anchor.available,
                    max: anchor.max
                  }
                };
                state.updateHeaderData(userId, headerData);
                logger.debug('[WebSocket] Header data fetched from API');
              }
            } catch (error) {
              logger.error('[WebSocket] Failed to fetch header data:', error.message);
            }
          }

          if (headerData) {
            // If user NOT in alliance, clear stock but keep anchor (anchor is NOT alliance-dependent)
            if (!allianceId) {
              ws.send(JSON.stringify({
                type: 'header_data_update',
                data: {
                  stock: { value: 0, trend: 'none', ipo: 0 },
                  anchor: headerData.anchor || { available: 0, max: 0 }
                }
              }));
              logger.debug('[WebSocket] OK Header data sent (stock cleared, anchor kept - no alliance)');
            } else {
              // User in alliance - send full header data
              ws.send(JSON.stringify({
                type: 'header_data_update',
                data: headerData
              }));
              logger.debug('[WebSocket] OK Header data sent');
            }
          }

          // Event data
          const eventData = state.getEventData(userId);
          if (eventData) {
            ws.send(JSON.stringify({
              type: 'event_data_update',
              data: eventData
            }));
            logger.debug('[WebSocket] OK Event data sent');
          }

        } catch (cacheError) {
          logger.error('[WebSocket] Failed to send cached data:', cacheError.message);
        }

        // Send initial chat data
        try {
          const allianceId = getAllianceId();
          if (allianceId) {
            const chatData = await getChatFeed();
            if (chatData && chatData.messages && chatData.messages.length > 0) {
              const messages = await Promise.all(
                chatData.messages.map(async (msg) => {
                  let companyName = msg.user_company_name || 'Unknown';
                  if (!msg.user_company_name && msg.user_id) {
                    companyName = await getCompanyName(msg.user_id);
                  }
                  return {
                    type: msg.type || 'chat',
                    userId: msg.user_id,
                    companyName: companyName,
                    message: msg.message,
                    timestamp: msg.timestamp
                  };
                })
              );
              ws.send(JSON.stringify({
                type: 'chat_update',
                data: messages
              }));
              logger.debug('[WebSocket] OK Chat data sent');
            }
          }
        } catch (chatError) {
          logger.error('[WebSocket] Failed to send chat data:', chatError.message);
        }

        // Send messenger/hijacking counts
        try {
          const chats = await getCachedMessengerChats();
          const unreadCount = chats.filter(chat => {
            if (!chat.new) return false;
            if (chat.system_chat && chat.body === 'vessel_got_hijacked') return false;
            return true;
          }).length;

          ws.send(JSON.stringify({
            type: 'messenger_update',
            data: { messages: unreadCount, chats: chats.length }
          }));
          logger.debug('[WebSocket] OK Messenger counts sent');

          // Hijacking counts
          const hijackingChats = chats.filter(chat =>
            chat.system_chat && chat.body === 'vessel_got_hijacked'
          );
          const casesWithDetails = await Promise.all(
            hijackingChats.map(async (chat) => {
              const caseId = chat.values?.case_id;
              if (!caseId) return null;
              return await getCachedHijackingCase(caseId);
            })
          );
          const cases = casesWithDetails.filter(c => c !== null);
          const openCases = cases.filter(c => c.isOpen).length;
          const hijackedCount = cases.filter(c => {
            const status = c.details?.status;
            return status === 'in_progress' || (c.isOpen && status !== 'solved');
          }).length;

          ws.send(JSON.stringify({
            type: 'hijacking_update',
            data: { openCases, totalCases: cases.length, hijackedCount }
          }));
          logger.debug('[WebSocket] OK Hijacking counts sent');

        } catch (messengerError) {
          logger.error('[WebSocket] Failed to send messenger/hijacking data:', messengerError.message);
        }

        logger.debug('[WebSocket] All cached data sent to client');
      }
    } catch (error) {
      logger.error('[WebSocket] Failed to send initial data:', error.message);
    }

    ws.on('close', () => {
      logger.debug('[WebSocket] Client disconnected');
    });

    ws.on('error', (error) => {
      logger.error('[WebSocket] Error:', error.message);
    });
  });

  return wss;
}

/**
 * Broadcasts a message to all connected WebSocket clients.
 *
 * This function sends data to every client currently connected to the WebSocket server.
 * It only sends to clients in OPEN state (connected and ready), skipping clients that
 * are CONNECTING, CLOSING, or CLOSED.
 *
 * Why This Pattern:
 * - Centralized broadcast logic used by multiple features (chat updates, system notifications)
 * - Automatically skips clients in transitional states to prevent errors
 * - Type-based routing allows frontend to handle different message types appropriately
 * - JSON serialization ensures structured data transmission
 *
 * Message Format:
 * {
 *   type: 'chat_update' | 'system_notification' | ...,
 *   data: <any>
 * }
 *
 * Safety Features:
 * - Early return if WebSocket server not initialized
 * - readyState check prevents sending to disconnecting clients
 * - JSON.stringify errors won't crash server (client.send handles errors)
 *
 * Use Cases:
 * - Chat feed updates every 25 seconds
 * - New message notifications
 * - System status updates
 * - Real-time game state changes
 *
 * @function broadcast
 * @param {string} type - Message type for client-side routing (e.g., 'chat_update')
 * @param {*} data - Payload data (will be JSON serialized)
 * @returns {void}
 *
 * @example
 * broadcast('chat_update', [
 *   { type: 'chat', company: 'ABC Corp', message: 'Hello!' }
 * ]);
 * // Sends to all connected clients:
 * // {"type":"chat_update","data":[{"type":"chat",...}]}
 *
 * @example
 * broadcast('system_notification', { message: 'Server restarting in 5 minutes' });
 */
function broadcast(type, data) {
  if (!wss) {
    logger.error('[WebSocket] Cannot broadcast, wss is NULL');
    return;
  }

  const openClients = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);

  logger.debug(`[WebSocket] Broadcasting '${type}' to ${openClients.length} client(s)`);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, data }));
    }
  });
}

/**
 * Helper function to broadcast bunker updates with current prices.
 * ALWAYS includes prices to prevent race condition where prices get overwritten with undefined.
 *
 * @param {number} userId - User ID
 * @param {Object} bunkerData - Bunker state (fuel, co2, cash, maxFuel, maxCO2)
 * @returns {void}
 */
function broadcastBunkerUpdate(userId, bunkerData) {
  const state = require('./state');
  const currentPrices = state.getPrices(userId);

  const fullBunkerData = {
    ...bunkerData,
    prices: {
      fuelPrice: currentPrices.fuel,
      co2Price: currentPrices.co2,
      eventDiscount: currentPrices.eventDiscount,
      regularFuel: currentPrices.regularFuel,
      regularCO2: currentPrices.regularCO2
    }
  };

  broadcast('bunker_update', fullBunkerData);
}

/**
 * Broadcasts a message to all WebSocket clients belonging to a specific user.
 *
 * In this single-user application, all connected clients belong to the same user,
 * so this function simply wraps broadcast(). The userId parameter is accepted for
 * future scalability (multi-user support).
 *
 * Used by autopilot features to send events to user's connected clients:
 * - price_update: Price changes (fuel/CO2)
 * - price_alert: Price threshold alerts
 * - fuel_purchased: Auto-rebuy fuel success
 * - co2_purchased: Auto-rebuy CO2 success
 * - vessels_departed: Auto-depart success
 * - vessels_failed: Auto-depart failures
 * - vessels_repaired: Auto-repair success
 * - campaigns_renewed: Auto-campaign renewal success
 *
 * @function broadcastToUser
 * @param {number} userId - User ID (currently unused, for future multi-user support)
 * @param {string} type - Message type for client-side routing
 * @param {*} data - Payload data (will be JSON serialized)
 * @returns {void}
 *
 * @example
 * broadcastToUser(12345, 'fuel_purchased', {
 *   amount: 100,
 *   price: 380,
 *   newTotal: 500,
 *   cost: 38000
 * });
 */
function broadcastToUser(userId, type, data) {
  // Special handling for bunker_update: ALWAYS include current prices to prevent race condition
  if (type === 'bunker_update' && data && !data.prices) {
    const state = require('./state');
    const currentPrices = state.getPrices(userId);

    // ONLY add prices if they are valid (not 0) - prevents broadcasting fake default values
    if (currentPrices.fuel > 0 && currentPrices.co2 > 0) {
      data.prices = {
        fuelPrice: currentPrices.fuel,
        co2Price: currentPrices.co2,
        eventDiscount: currentPrices.eventDiscount,
        regularFuel: currentPrices.regularFuel,
        regularCO2: currentPrices.regularCO2
      };
    }
  }

  // In single-user mode, broadcast to all clients
  // userId parameter reserved for future multi-user support
  broadcast(type, data);
}

/**
 * Starts automatic chat feed polling and broadcasting to all connected clients.
 *
 * This function implements server-side polling of the alliance chat feed at regular intervals
 * (25 seconds by default). It fetches chat messages from the game API, transforms them into
 * a client-friendly format, and broadcasts updates to all connected WebSocket clients.
 *
 * Why Server-Side Polling:
 * - Centralizes API calls (one call serves all clients)
 * - Reduces game API load compared to per-client polling
 * - Ensures all clients stay synchronized with same data
 * - Complies with rate limiting (30 req/min across all clients)
 * - Clients receive updates even when browser tab is inactive
 *
 * Polling Interval:
 * - Default: 25 seconds (config.CHAT_REFRESH_INTERVAL)
 * - Balances freshness with API rate limits
 * - 25s = 2.4 calls/minute, well below 30 req/min limit
 * - Leaves headroom for manual chat sends and other API operations
 *
 * Message Types Handled:
 * 1. Chat Messages (type: 'chat')
 *    - Fetches company name via getCompanyName() with caching
 *    - Converts Unix timestamp to UTC string
 *    - Includes user_id for sender identification
 *
 * 2. Feed Events (type: 'feed')
 *    - Alliance member joins, route completions, etc.
 *    - Already includes company name in replacements
 *    - No additional API call needed
 *
 * No Alliance Handling:
 * - Checks getAllianceId() every interval
 * - If null (user not in alliance), skips API call
 * - Prevents 404 errors from alliance-specific endpoints
 * - Allows app to work for non-alliance users
 *
 * Error Handling:
 * - API errors logged but don't stop polling
 * - Interval continues running even if one fetch fails
 * - Prevents cascading failures from transient network issues
 *
 * Side Effects:
 * - Makes API call to /alliance/get-feed every 25 seconds
 * - May make multiple API calls to /user/get-user-settings for uncached company names
 * - Broadcasts to all connected WebSocket clients
 * - Sets module-level chatRefreshInterval variable
 *
 * @function startChatAutoRefresh
 * @returns {void}
 *
 * @example
 * // Called from app.js during server initialization
 * startChatAutoRefresh();
 * // Begins polling every 25 seconds
 * // Broadcasts chat_update messages to all connected clients
 *
 * @example
 * // Typical broadcast message structure:
 * {
 *   type: 'chat_update',
 *   data: [
 *     {
 *       type: 'chat',
 *       company: 'ABC Shipping',
 *       message: 'Hello everyone!',
 *       timestamp: 'Mon, 23 Oct 2025 14:30:00 GMT',
 *       user_id: 12345
 *     },
 *     {
 *       type: 'feed',
 *       feedType: 'alliance_member_joined',
 *       company: 'XYZ Corp',
 *       timestamp: 'Mon, 23 Oct 2025 14:25:00 GMT'
 *     }
 *   ]
 * }
 */
/**
 * Performs a single chat refresh cycle.
 * Fetches latest chat messages, broadcasts to clients, and processes with ChatBot.
 * Uses module-level isChatRefreshing flag to prevent overlapping requests.
 *
 * @async
 * @function performChatRefresh
 * @returns {Promise<void>}
 */
async function performChatRefresh() {
  if (!getAllianceId()) {
    return;
  }

  // Skip if previous refresh is still running
  if (isChatRefreshing) {
    logger.debug('[Chat Refresh] Skipping - previous request still running');
    return;
  }

  isChatRefreshing = true;

  try {
    const feed = await getChatFeed();
    const messages = [];
    let hasNewMessages = false;

    for (const msg of feed) {
      if (msg.type === 'chat') {
        const companyName = await getCompanyName(msg.user_id);
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        messages.push({
          type: 'chat',
          company: companyName,
          message: msg.message,
          timestamp: timestamp,
          user_id: msg.user_id
        });

        // Check if this is a new message for ChatBot processing
        if (msg.time_created > lastProcessedMessageTime) {
          hasNewMessages = true;
          // Process with ChatBot (async, don't await) - lazy-loaded to avoid circular dependency
          const chatBot = require('./chatbot');
          chatBot.processAllianceMessage(msg.message, msg.user_id, companyName)
            .catch(err => logger.error('[ChatBot] Error processing alliance message:', err));
        }
      } else if (msg.type === 'feed') {
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        messages.push({
          type: 'feed',
          feedType: msg.feed_type,
          company: msg.replacements.company_name,
          timestamp: timestamp
        });
      }
    }

    // Update last processed time if we had new messages
    if (hasNewMessages) {
      lastProcessedMessageTime = Date.now() / 1000;
    }

    if (messages.length > 0 || wss.clients.size > 0) {
      broadcast('chat_update', messages);
    }
  } catch (error) {
    // Only log non-timeout errors
    if (!error.message.includes('socket hang up') && !error.message.includes('ECONNRESET')) {
      logger.error('[Chat Refresh] Error:', error.message);
    }
  } finally {
    isChatRefreshing = false; // Always release the lock
  }
}

/**
 * Starts automatic chat refresh polling at configured interval (default: 20 seconds).
 * Calls performChatRefresh() on each cycle.
 * Chat and messenger polls run simultaneously in the same interval to reduce API load.
 *
 * @function startChatAutoRefresh
 * @returns {void}
 */
function startChatAutoRefresh() {
  chatRefreshInterval = setInterval(async () => {
    // Run chat and messenger refresh in parallel
    await Promise.all([
      performChatRefresh(),
      performMessengerRefresh()
    ]);
  }, config.CHAT_REFRESH_INTERVAL);
}

/**
 * Triggers an immediate chat refresh after a short delay.
 * Used by ChatBot to immediately broadcast bot responses without waiting for next polling cycle.
 *
 * The 3-second delay ensures the Game API has time to persist the message before we fetch it.
 * This prevents race conditions where we fetch before the message is saved.
 *
 * Safe to call multiple times - the isChatRefreshing flag prevents overlapping requests.
 *
 * @function triggerImmediateChatRefresh
 * @returns {void}
 *
 * @example
 * // After sending a bot response
 * await sendAllianceMessage(response);
 * triggerImmediateChatRefresh(); // Clients will see response in ~3 seconds instead of up to 25s
 */
function triggerImmediateChatRefresh() {
  logger.debug('[Chat Refresh] Immediate refresh triggered - will execute in 3 seconds');
  setTimeout(async () => {
    await performChatRefresh();
  }, 3000); // 3-second delay to allow Game API to persist the message
}

/**
 * Performs a single messenger refresh cycle.
 * Fetches unread messages, broadcasts to clients, and processes DM commands with ChatBot.
 * Uses module-level isMessengerRefreshing flag to prevent overlapping requests.
 *
 * @async
 * @function performMessengerRefresh
 * @returns {Promise<void>}
 */
async function performMessengerRefresh() {
  // Skip if previous refresh is still running
  if (isMessengerRefreshing) {
    logger.debug('[Messenger Refresh] Skipping - previous request still running');
    return;
  }

  isMessengerRefreshing = true;

  try {
    // (using apiCall and getUserId from utils/api - imported at top of file via getChatFeed, getCompanyName, getAllianceId, apiCall)
    const { getUserId } = require('./utils/api');
    const userId = getUserId();
    if (!userId) {
      logger.error('[Messenger Refresh] No user ID available');
      isMessengerRefreshing = false;
      return;
    }

    // Load processed messages cache for this user if not already loaded
    if (!processedMessageIds.has(String(userId))) {
      loadProcessedMessageCache(userId);
    }

    // Fetch messenger chats (using shared cache to reduce API calls)
    const chats = await getCachedMessengerChats();

    // Count unread messages (messages with 'new' flag)
    // Exclude hijacking messages - they go to Blackbeard's Phone Booth
    const unreadCount = chats.filter(chat => {
      if (!chat.new) return false;
      // Exclude hijacking system messages
      if (chat.system_chat && chat.body === 'vessel_got_hijacked') {
        return false;
      }
      return true;
    }).length;

    // Broadcast unread count to all clients
    broadcast('messenger_update', {
      messages: unreadCount,
      chats: chats.length
    });

    // Process chats with ChatBot - Check ONLY UNREAD chats to reduce API spam
    // The processedMessageIds cache ensures we don't reply twice to the same message
    for (const chat of chats) {
      // Skip system chats
      if (chat.system_chat) continue;

      // CRITICAL: Only check unread chats to reduce API calls
      // Without this check, we'd fetch /messenger/get-chat for EVERY chat (10+ chats = 10+ API calls every 15 seconds!)
      if (!chat.new) continue;

      try {
        // Fetch messages for this chat
        const messagesData = await apiCall('/messenger/get-chat', 'POST', {
          chat_id: chat.id
        });

        const messages = messagesData?.data?.chat?.messages || messagesData?.data?.messages;

        // Find the latest message from the sender (not from us)
        const senderMessages = messages.filter(msg => msg.is_mine === false).reverse();

        if (senderMessages.length === 0) {
          continue; // No messages from sender
        }

        // IMPORTANT: Only process the LATEST message, even if multiple are unread
        // This prevents duplicate replies if user sends same command multiple times
        const latestMessage = senderMessages[0];

        // Create unique identifier
        const messageIdentifier = `${chat.id}_${latestMessage.created_at}`;

        // Check if we've already processed this message
        const userProcessedIds = getProcessedMessageIds(userId);
        if (userProcessedIds.has(messageIdentifier)) {
          continue; // Already replied to this message
        }

        // Only log if chat is unread (to reduce spam in logs)
        if (chat.new) {
          logger.info(`[Messenger] New DM from ${chat.participants_string}: "${latestMessage.body || chat.subject}"`);
        }

        // Process with ChatBot - lazy-loaded to avoid circular dependency
        const chatBot = require('./chatbot');
        const wasProcessed = await chatBot.processPrivateMessage(
          messageIdentifier,
          latestMessage.body || '',
          latestMessage.user_id,
          chat.participants_string
        );

        // Only add to processed cache if bot actually handled the message
        if (wasProcessed) {
          userProcessedIds.add(messageIdentifier);
          saveProcessedMessageCache(userId);
          logger.info(`[Messenger] Bot replied and cached: ${messageIdentifier}`);
        } else {
          // Add to cache even if not processed, so we don't spam logs every polling cycle
          userProcessedIds.add(messageIdentifier);
          saveProcessedMessageCache(userId);
          logger.debug(`[Messenger] Message ignored (not a valid command): ${messageIdentifier}`);
        }

      } catch (error) {
        logger.error(`[Messenger] Error processing chat ${chat.id}:`, error.message);
      }
    }

    // Log only in debug mode
    if (unreadCount > 0) {
      logger.debug(`[Messenger] ${unreadCount} unread messages detected`);
    } else {
      logger.debug(`[Messenger] Poll complete: 0 unread messages`);
    }
  } catch (error) {
    // Only log non-timeout errors
    if (!error.message.includes('socket hang up') && !error.message.includes('ECONNRESET')) {
      logger.error('[Messenger] Error:', error.message);
    }
  } finally {
    isMessengerRefreshing = false; // Always release the lock
  }
}

/**
 * Messenger polling is now handled by startChatAutoRefresh() to run simultaneously.
 * This function is kept for backwards compatibility but does nothing.
 * Both chat and messenger refresh happen together in the same 20-second interval.
 *
 * @function startMessengerAutoRefresh
 * @returns {void}
 */
function startMessengerAutoRefresh() {
  // Messenger refresh now runs together with chat refresh in startChatAutoRefresh()
  // No separate interval needed - both APIs are called simultaneously
  logger.info('[Messenger] Messenger polling synchronized with chat polling (20s interval)');
}

/**
 * Triggers an immediate messenger refresh after a short delay.
 * Used by ChatBot to immediately broadcast DM responses without waiting for next polling cycle.
 *
 * The 3-second delay ensures the Game API has time to persist the message before we fetch it.
 * This prevents race conditions where we fetch before the message is saved.
 *
 * Safe to call multiple times - the isMessengerRefreshing flag prevents overlapping requests.
 *
 * @function triggerImmediateMessengerRefresh
 * @returns {void}
 *
 * @example
 * // After sending a DM response
 * await sendPrivateMessage(userId, subject, response);
 * triggerImmediateMessengerRefresh(); // Client will see response in ~3 seconds instead of up to 10s
 */
function triggerImmediateMessengerRefresh() {
  logger.debug('[Messenger Refresh] Immediate refresh triggered - will execute in 3 seconds');
  setTimeout(async () => {
    await performMessengerRefresh();
  }, 3000); // 3-second delay to allow Game API to persist the message
}

/**
 * Stops the automatic messenger polling and clears the interval timer.
 *
 * @function stopMessengerAutoRefresh
 * @returns {void}
 */
function stopMessengerAutoRefresh() {
  if (messengerRefreshInterval) {
    clearInterval(messengerRefreshInterval);
    messengerRefreshInterval = null;
  }
}

/**
 * Stops the automatic chat feed polling and clears the interval timer.
 *
 * This function provides a clean shutdown mechanism for the chat auto-refresh feature.
 * It's primarily used during server shutdown or when temporarily disabling automatic updates.
 *
 * Why This Matters:
 * - Prevents interval from continuing after server shutdown
 * - Cleans up resources properly to avoid memory leaks
 * - Allows pausing auto-refresh without restarting server
 * - Sets interval reference to null for garbage collection
 *
 * Use Cases:
 * - Server graceful shutdown (SIGTERM/SIGINT handlers)
 * - Temporarily disabling auto-refresh for maintenance
 * - Reconfiguring refresh interval (stop, then restart with new interval)
 *
 * Side Effects:
 * - Clears the setInterval timer
 * - Sets chatRefreshInterval to null
 * - No more automatic broadcasts until startChatAutoRefresh() called again
 *
 * @function stopChatAutoRefresh
 * @returns {void}
 *
 * @example
 * // During server shutdown
 * process.on('SIGTERM', () => {
 *   console.log('Shutting down server...');
 *   stopChatAutoRefresh();
 *   server.close();
 * });
 *
 * @example
 * // Reconfiguring refresh interval
 * stopChatAutoRefresh();
 * config.CHAT_REFRESH_INTERVAL = 30000; // Change to 30 seconds
 * startChatAutoRefresh();
 */
function stopChatAutoRefresh() {
  if (chatRefreshInterval) {
    clearInterval(chatRefreshInterval);
    chatRefreshInterval = null;
  }
}

/**
 * Performs a single hijacking refresh cycle.
 * Fetches hijacking cases and broadcasts badge/header counts to all clients.
 * Uses module-level isHijackingRefreshing flag to prevent overlapping requests.
 *
 * What This Does:
 * - Fetches all hijacking cases via /api/hijacking/get-cases
 * - Counts OPEN cases (paid_amount === null && status !== 'solved')
 * - Counts total cases (open + closed)
 * - Counts hijacked vessels (vessels with status 'in_progress')
 * - Broadcasts to all clients for badge and header updates
 *
 * Why This Exists:
 * - Keeps hijacking inbox badge count up-to-date
 * - Updates header pirate emoji count (hijacked vessels)
 * - Separates hijacking from messenger badge logic
 * - Enables real-time tracking of hijacking status changes
 *
 * Broadcast Data:
 * {
 *   openCases: number,      // Open hijacking cases (for badge)
 *   totalCases: number,     // Total cases (open + closed)
 *   hijackedCount: number   // Currently hijacked vessels (for header emoji)
 * }
 *
 * @async
 * @function performHijackingRefresh
 * @returns {Promise<void>}
 */
async function performHijackingRefresh() {
  // Skip if previous refresh is still running
  if (isHijackingRefreshing) {
    logger.debug('[Hijacking Refresh] Skipping - previous request still running');
    return;
  }

  isHijackingRefreshing = true;

  try {
    // (using apiCall imported at top of file)

    // Fetch messenger chats (using shared cache to reduce API calls)
    const allChats = await getCachedMessengerChats();

    // Filter for hijacking cases
    const hijackingChats = allChats.filter(chat =>
      chat.system_chat && chat.body === 'vessel_got_hijacked'
    );

    // Fetch details for each case (using shared cache)
    const casesWithDetails = await Promise.all(
      hijackingChats.map(async (chat) => {
        const caseId = chat.values?.case_id;
        if (!caseId) return null;

        // Use shared cache function to get case details
        return await getCachedHijackingCase(caseId);
      })
    );

    const cases = casesWithDetails.filter(c => c !== null);

    // Count cached vs fetched for logging
    const cachedCount = cases.filter(c => c.cached).length;
    const fetchedCount = cases.length - cachedCount;

    // Count open cases (for badge)
    const openCases = cases.filter(c => c.isOpen).length;

    // Count hijacked vessels (status = 'in_progress')
    const hijackedCount = cases.filter(c => {
      const status = c.details?.status;
      return status === 'in_progress' || (c.isOpen && status !== 'solved');
    }).length;

    // Broadcast to all clients
    const hijackingData = {
      openCases: openCases,
      totalCases: cases.length,
      hijackedCount: hijackedCount
    };
    logger.debug(`[Hijacking Refresh] Broadcasting update: ${openCases} open, ${hijackedCount} hijacked (${fetchedCount} API calls, ${cachedCount} cached)`);
    broadcast('hijacking_update', hijackingData);

    logger.debug(`[Hijacking] ${openCases} open cases, ${hijackedCount} hijacked vessels`);
  } catch (error) {
    // Only log non-timeout and non-connection errors
    if (!error.message.includes('socket hang up') &&
        !error.message.includes('ECONNRESET') &&
        !error.message.includes('ECONNREFUSED')) {
      logger.error('[Hijacking Refresh] Error:', error.message);
    }
  } finally {
    isHijackingRefreshing = false; // Always release the lock
  }
}

/**
 * Starts automatic hijacking refresh polling at 60-second interval.
 * Calls performHijackingRefresh() on each cycle.
 *
 * Why 60 Seconds:
 * - Hijacking status changes infrequently
 * - Longer interval reduces API load significantly
 * - Still provides reasonably real-time updates
 * - Balances freshness with performance (reduces ~2 calls/min)
 *
 * @function startHijackingAutoRefresh
 * @returns {void}
 */
function startHijackingAutoRefresh() {
  hijackingRefreshInterval = setInterval(async () => {
    await performHijackingRefresh();
  }, 60000); // 60 seconds
}

/**
 * Stops the automatic hijacking polling and clears the interval timer.
 *
 * @function stopHijackingAutoRefresh
 * @returns {void}
 */
function stopHijackingAutoRefresh() {
  if (hijackingRefreshInterval) {
    clearInterval(hijackingRefreshInterval);
    hijackingRefreshInterval = null;
  }
}

/**
 * Triggers an immediate hijacking refresh after a short delay.
 * Used after auto-negotiate completes or when case status changes.
 *
 * @function triggerImmediateHijackingRefresh
 * @returns {void}
 */
function triggerImmediateHijackingRefresh() {
  logger.debug('[Hijacking Refresh] Immediate refresh triggered - will execute in 2 seconds');
  setTimeout(async () => {
    await performHijackingRefresh();
  }, 2000); // 2-second delay to allow API to update
}

// ============================================================================
// Harbor Map Refresh Management (Rate-Limited)
// ============================================================================

// Rate limiting for Harbor Map refresh broadcasts
let lastHarborMapBroadcast = 0;
const HARBOR_MAP_COOLDOWN = 30000; // 30 seconds

/**
 * Broadcasts a Harbor Map refresh event with rate limiting.
 * Only broadcasts if > 30 seconds since last broadcast.
 *
 * @param {string} userId - User ID
 * @param {string} reason - Reason for refresh (e.g., "vessels_departed", "vessels_purchased", "ports_purchased", "interval")
 * @param {Object} data - Additional data to include in broadcast
 * @returns {boolean} - True if broadcast sent, false if skipped due to cooldown
 */
function broadcastHarborMapRefresh(userId, reason, data = {}) {
  const now = Date.now();
  const timeSinceLastBroadcast = now - lastHarborMapBroadcast;

  // Skip if within cooldown period
  if (timeSinceLastBroadcast < HARBOR_MAP_COOLDOWN) {
    logger.debug(`[Harbor Map] Skipping broadcast (cooldown active, ${Math.floor((HARBOR_MAP_COOLDOWN - timeSinceLastBroadcast) / 1000)}s remaining)`);
    return false;
  }

  // Update last broadcast timestamp
  lastHarborMapBroadcast = now;

  // Broadcast the event
  broadcastToUser(userId, 'harbor_map_refresh_required', {
    reason,
    timestamp: now,
    ...data
  });

  logger.debug(`[Harbor Map] Refresh broadcast sent (reason: ${reason})`);
  return true;
}

module.exports = {
  initWebSocket,
  broadcast,
  broadcastToUser,
  broadcastBunkerUpdate,
  broadcastHarborMapRefresh,
  startChatAutoRefresh,
  stopChatAutoRefresh,
  triggerImmediateChatRefresh,
  startMessengerAutoRefresh,
  stopMessengerAutoRefresh,
  triggerImmediateMessengerRefresh,
  startHijackingAutoRefresh,
  stopHijackingAutoRefresh,
  triggerImmediateHijackingRefresh,
  getCachedMessengerChats,  // Export shared cache function for use by other modules
  getCachedHijackingCase    // Export shared cache function for hijacking cases
};
