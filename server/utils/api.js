/**
 * @fileoverview API Helper Functions and Game API Integration
 *
 * This module provides centralized API communication with the Shipping Manager game server
 * (shippingmanager.cc). It handles authentication, connection pooling, state management,
 * and caching to optimize API calls and reduce rate limit risk.
 *
 * Key Responsibilities:
 * - Authenticated API calls with session cookie injection
 * - HTTP Keep-Alive connection pooling for performance
 * - User and alliance state initialization and management
 * - Company name caching to reduce redundant API calls
 * - Error handling and fallback mechanisms
 *
 * Why This Architecture:
 * - Centralizes all game API communication in one module
 * - Connection pooling reduces latency (reuses TCP connections)
 * - State caching reduces API load (important for rate limiting)
 * - Session cookie loaded from encrypted storage via session-manager
 * - Graceful degradation when user not in alliance
 *
 * Connection Pooling Strategy:
 * - Keep-Alive enabled: Reuses TCP connections instead of opening new ones
 * - Max 10 simultaneous connections: Prevents overwhelming API server
 * - LIFO scheduling: Most recently used socket first (better connection reuse)
 * - 30-second keep-alive: Balance between connection reuse and resource usage
 * - This mimics normal browser behavior, reducing detection risk
 *
 * State Management:
 * - USER_ID: Current user's unique identifier
 * - USER_COMPANY_NAME: Current user's company name
 * - ALLIANCE_ID: User's alliance ID (null if not in alliance)
 * - userNameCache: Map of user_id → company_name (reduces API calls)
 *
 * Rate Limiting Considerations:
 * - Fewer API calls via caching = lower rate limit risk
 * - Keep-Alive reduces overhead, faster responses
 * - Connection pooling prevents connection exhaustion
 * - Mimics normal browser traffic patterns
 *
 * @requires axios - HTTP client for API calls
 * @requires https - HTTPS agent configuration
 * @requires ../config - Configuration constants (API URL, session cookie)
 * @module server/utils/api
 */

const axios = require('axios');
const https = require('https');
const config = require('../config');
const logger = require('./logger');

/**
 * User's alliance ID (null if not in alliance)
 * @type {number|null}
 */
let ALLIANCE_ID = null;

/**
 * User's alliance name (null if not in alliance)
 * @type {string|null}
 */
let ALLIANCE_NAME = null;

/**
 * Current user's unique identifier
 * @type {number|null}
 */
let USER_ID = null;

/**
 * Current user's company name
 * @type {string|null}
 */
let USER_COMPANY_NAME = null;

/**
 * Cache mapping user IDs to company names (reduces API calls)
 * @type {Map<number, string>}
 */
const userNameCache = new Map();

/**
 * API Request Statistics Tracker
 * Tracks all requests to shippingmanager.cc for monitoring rate limits and usage patterns
 */
const apiStats = {
  totalRequests: 0,
  requestsByEndpoint: new Map(),
  startTime: Date.now(),
  lastResetTime: Date.now(),
  requestsLastMinute: 0,
  requestTimestamps: [], // Store timestamps with endpoints for last minute calculation
  lastMinuteByEndpoint: new Map() // Track requests per endpoint in last minute
};

// Log statistics every minute
setInterval(() => {
  const now = Date.now();

  // Calculate requests in last minute
  const oneMinuteAgo = now - 60000;
  apiStats.requestTimestamps = apiStats.requestTimestamps.filter(item => item.time > oneMinuteAgo);
  const requestsLastMinute = apiStats.requestTimestamps.length;

  // Count requests by endpoint in last minute
  const lastMinuteByEndpoint = new Map();
  apiStats.requestTimestamps.forEach(item => {
    const count = lastMinuteByEndpoint.get(item.endpoint) || 0;
    lastMinuteByEndpoint.set(item.endpoint, count + 1);
  });

  // Get top 10 endpoints from last minute only
  const sortedEndpoints = Array.from(lastMinuteByEndpoint.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Build compact one-line stats
  const topEndpointsStr = sortedEndpoints.map(([endpoint, count]) => `${endpoint}:${count}x`).join(', ');

  logger.debug(`[API Stats] ${requestsLastMinute} req/min | Top 10: ${topEndpointsStr}`);
}, 60000); // 1 minute = 60000ms

/**
 * HTTPS agent with Keep-Alive for connection pooling and performance optimization.
 *
 * This agent maintains persistent TCP connections to the game API server, reducing
 * latency and overhead from repeatedly establishing TLS handshakes.
 *
 * Configuration Rationale:
 * - keepAlive: true - Reuses connections instead of opening new ones per request
 * - keepAliveMsecs: 30s - TCP keep-alive packets every 30 seconds
 * - maxSockets: 10 - Limits concurrent connections (avoids API server overload)
 * - maxFreeSockets: 5 - Keeps 5 idle connections ready for immediate reuse
 * - timeout: 120s - Socket timeout (allows very slow endpoints like chat/messenger to complete)
 * - scheduling: 'lifo' - Uses most recently used socket first (better cache locality)
 *
 * Anti-Detection Benefits:
 * - Connection pooling mimics normal browser behavior
 * - Limits concurrent connections (doesn't look like a bot storm)
 * - Keep-Alive is standard browser feature
 * - Reduces number of TLS handshakes (less suspicious traffic pattern)
 *
 * @constant {https.Agent}
 */
const httpsAgent = new https.Agent({
  keepAlive: true,                // Enable Keep-Alive
  keepAliveMsecs: 30000,          // Keep connections alive for 30 seconds
  maxSockets: 10,                 // Max 10 simultaneous connections (good for anti-detection)
  maxFreeSockets: 5,              // Max 5 idle sockets
  timeout: 120000,                // Socket timeout 120s (unified timeout for large API responses)
  scheduling: 'lifo'              // Use most recently used socket first
});

/**
 * Makes authenticated HTTP API calls to the Shipping Manager game server.
 *
 * This is the core function for all API communication. It handles authentication
 * via session cookie, sets appropriate headers to mimic browser requests, and
 * uses connection pooling for performance.
 *
 * Why This Design:
 * - Centralizes authentication logic (session cookie from environment)
 * - Mimics browser requests (headers, user agent, origin)
 * - Uses Keep-Alive agent for connection reuse
 * - Consistent error handling across all API calls
 * - Configurable timeout (default 30s, extended for slow endpoints like messenger)
 *
 * Authentication:
 * - Session cookie injected via config.SESSION_COOKIE
 * - Cookie extracted from Steam client by start.py and stored in encrypted session storage
 * - Provides full account access (same as logged-in browser session)
 * - Cookie stored encrypted in session-manager (AES-256-GCM)
 *
 * Headers:
 * - User-Agent: Mozilla/5.0 (looks like browser, not bot)
 * - Origin: https://shippingmanager.cc (required for CORS)
 * - Content-Type: application/json (API expects JSON)
 * - Accept: application/json (indicates we want JSON response)
 * - Cookie: Session authentication
 *
 * Error Handling:
 * - HTTP errors: Extracts status code from response
 * - Network errors: Returns error message
 * - Logs errors to console for debugging
 * - Throws error for caller to handle
 *
 * Side Effects:
 * - Makes HTTPS request to shippingmanager.cc
 * - Reuses existing TCP connections via Keep-Alive agent
 * - Logs errors to console
 *
 * @function apiCall
 * @param {string} endpoint - API endpoint (e.g., '/alliance/get-chat-feed')
 * @param {string} [method='POST'] - HTTP method (GET, POST, etc.)
 * @param {Object} [body={}] - Request payload (will be JSON stringified)
 * @param {number} [timeout=90000] - Request timeout in milliseconds (default 90s)
 * @returns {Promise<Object>} API response data (already parsed from JSON)
 * @throws {Error} When API request fails (network error or HTTP error status)
 *
 * @example
 * // Fetch alliance chat feed
 * const data = await apiCall('/alliance/get-chat-feed', 'POST', { alliance_id: 123 });
 * console.log(data.data.chat_feed);
 *
 * @example
 * // Get user settings (default POST method, empty body)
 * const userData = await apiCall('/user/get-user-settings');
 * console.log(userData.user.company_name);
 *
 * @example
 * // Slow endpoint with extended timeout (60 seconds)
 * const chats = await apiCall('/messenger/get-chats', 'POST', {}, 60000);
 */
async function apiCall(endpoint, method = 'POST', body = {}, timeout = 90000, retryCount = 0) {
  const maxRetries = 3;

  // Track API request
  apiStats.totalRequests++;
  apiStats.requestTimestamps.push({ time: Date.now(), endpoint: endpoint });
  const currentCount = apiStats.requestsByEndpoint.get(endpoint) || 0;
  apiStats.requestsByEndpoint.set(endpoint, currentCount + 1);

  try {
    // Determine if we should send as JSON or form-urlencoded
    // Empty body should be sent as form-urlencoded with empty string
    const isEmptyBody = !body || (typeof body === 'object' && Object.keys(body).length === 0);
    const requestData = isEmptyBody ? '' : body;
    const contentType = isEmptyBody ? 'application/x-www-form-urlencoded' : 'application/json';

    const response = await axios({
      method,
      url: `${config.SHIPPING_MANAGER_API}${endpoint}`,
      data: requestData,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': contentType,
        'Game-Version': '1.0.313',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Origin': 'https://shippingmanager.cc',
        'Referer': 'https://shippingmanager.cc/loading',
        'Cookie': (() => {
          let cookies = `shipping_manager_session=${config.SESSION_COOKIE}`;
          if (config.getAppPlatformCookie()) {
            cookies += `; app_platform=${config.getAppPlatformCookie()}`;
          }
          if (config.getAppVersionCookie()) {
            cookies += `; app_version=${config.getAppVersionCookie()}`;
          }
          return cookies;
        })()
      },
      httpsAgent: httpsAgent,      // Use Keep-Alive agent
      timeout: timeout              // Request timeout (configurable, default 90s)
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      // API responded with error status - return the data so we can see actual errors
      logger.error(`API Error: ${endpoint} - Status ${error.response.status}`);
      logger.error(`Response data:`, JSON.stringify(error.response.data, null, 2));

      // Special handling for 401 Unauthorized - this is critical
      if (error.response.status === 401) {
        logger.error('[CRITICAL] 401 Unauthorized - Session cookie is invalid!');
        logger.error('[CRITICAL] Endpoint:', endpoint);
        logger.error('[CRITICAL] This means the session cookie cannot authenticate.');
        const cookiePreview = config.SESSION_COOKIE ?
          `${config.SESSION_COOKIE.substring(0, 10)}...${config.SESSION_COOKIE.substring(config.SESSION_COOKIE.length - 10)}` :
          'NONE';
        logger.error('[CRITICAL] Cookie preview:', cookiePreview);
        logger.error('[CRITICAL] Cookie length:', config.SESSION_COOKIE ? config.SESSION_COOKIE.length : 0);
      }

      // Return error response with actual API error message
      return {
        success: false,
        error: error.response.data?.error || `Request failed with status ${error.response.status}`,
        message: error.response.data?.message || error.response.data?.error,
        statusCode: error.response.status,
        ...error.response.data
      };
    } else {
      // Network error or timeout
      const isRetryableError = error.code === 'ECONNRESET' ||
                               error.code === 'ETIMEDOUT' ||
                               error.code === 'ECONNREFUSED' ||
                               error.message.includes('socket hang up') ||
                               error.message.includes('timeout');

      // Retry with exponential backoff for network errors
      if (isRetryableError && retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
        logger.debug(`[API Retry] ${endpoint} - Network error (${error.message}), retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
        await sleep(delay);
        return apiCall(endpoint, method, body, timeout, retryCount + 1);
      }

      // Max retries reached or non-retryable error
      logger.error(`API Error: ${endpoint} - ${error.message}`);
      throw new Error(error.message);
    }
  }
}

/**
 * Sleep helper for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Makes API call with automatic retry on network errors.
 *
 * This wrapper around apiCall() handles transient network failures by automatically
 * retrying failed requests. Common network errors include:
 * - "socket hang up" (ECONNRESET) - Connection closed unexpectedly
 * - "ETIMEDOUT" - Request timeout
 * - "ENOTFOUND" - DNS lookup failed
 *
 * Retry Strategy:
 * - 3 attempts maximum (initial + 2 retries)
 * - Exponential backoff: 1s, 2s between attempts
 * - Only retries on network errors (not HTTP 4xx/5xx errors)
 * - Logs retry attempts to console
 *
 * Why This Is Needed:
 * - Game API sometimes has socket errors under load
 * - Temporary network glitches should not fail operations
 * - Automatic retry is user-friendly (no manual refresh needed)
 * - Exponential backoff prevents overwhelming struggling API
 *
 * @function apiCallWithRetry
 * @param {string} endpoint - API endpoint (e.g., '/game/index')
 * @param {string} [method='POST'] - HTTP method
 * @param {Object} [body={}] - Request payload
 * @param {number} [timeout=90000] - Request timeout in milliseconds
 * @param {number} [maxRetries=3] - Maximum retry attempts
 * @returns {Promise<Object>} API response data
 * @throws {Error} When all retry attempts fail
 *
 * @example
 * // Fetch vessels with automatic retry
 * const data = await apiCallWithRetry('/game/index', 'POST', {});
 */
async function apiCallWithRetry(endpoint, method = 'POST', body = {}, timeout = 90000, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall(endpoint, method, body, timeout);
    } catch (error) {
      // Check if this is a network error that should be retried
      const isNetworkError = error.message && (
        error.message.includes('socket hang up') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('ECONNREFUSED')
      );

      // If network error and we have retries left, try again
      if (isNetworkError && attempt < maxRetries) {
        const delay = 1000 * attempt; // Exponential backoff: 1s, 2s
        logger.debug(`[API Retry] ${endpoint} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      // Either not a network error, or we're out of retries
      throw error;
    }
  }
}

/**
 * Retrieves a user's company name with intelligent caching to reduce API calls.
 *
 * This function implements a memory cache for company names, significantly reducing
 * API calls during chat feed processing. The cache persists for the lifetime of the
 * server process.
 *
 * Why Caching Matters:
 * - Chat feeds can contain 50+ messages from same users
 * - Without cache: 50 API calls per chat refresh (25s interval)
 * - With cache: ~2-3 API calls per refresh (only new users)
 * - Reduces rate limit risk by 95%+
 * - Faster response times (cache lookup vs network roundtrip)
 *
 * Cache Strategy:
 * - Map-based cache: O(1) lookup time
 * - Persistent: Cache never cleared (safe assumption: usernames don't change often)
 * - Grows linearly with unique users seen (minimal memory impact)
 * - Thread-safe: Node.js single-threaded, no race conditions
 *
 * Fallback Behavior:
 * - If API call fails (user deleted, API error), returns "User {userId}"
 * - Prevents cascade failures from missing user data
 * - Silent error handling (no throw, no log spam)
 *
 * Side Effects:
 * - Makes API call to /user/get-company on cache miss
 * - Stores result in userNameCache Map
 * - Logs errors silently (doesn't log to console)
 *
 * @function getCompanyName
 * @param {number} userId - User's unique identifier
 * @returns {Promise<string>} Company name (from cache or API) or "User {userId}" on failure
 *
 * @example
 * const name = await getCompanyName(12345);
 * console.log(name); // "ABC Shipping Co."
 * // Second call returns instantly from cache
 * const nameAgain = await getCompanyName(12345);
 *
 * @example
 * // Failed API call
 * const name = await getCompanyName(99999); // Deleted user
 * console.log(name); // "User 99999"
 */
async function getCompanyName(userId) {
  if (userNameCache.has(userId)) {
    return userNameCache.get(userId);
  }

  try {
    const data = await apiCall('/user/get-company', 'POST', { user_id: userId });
    const companyName = data.data.company.company_name;
    userNameCache.set(userId, companyName);
    return companyName;
  } catch {
    return `User ${userId}`;
  }
}

/**
 * Initializes user and alliance state on server startup.
 *
 * This critical initialization function loads user identity and alliance membership
 * from the game API. It must complete successfully before the server can function,
 * as many endpoints depend on USER_ID and ALLIANCE_ID state.
 *
 * Why This Runs at Startup:
 * - USER_ID needed for filtering own messages in chat
 * - ALLIANCE_ID required for all alliance-specific endpoints
 * - Company name used for logging and debugging
 * - Early failure prevents server from running with invalid state
 * - Session cookie validation (fails if cookie invalid/expired)
 *
 * Initialization Sequence:
 * 1. Load user settings (USER_ID, USER_COMPANY_NAME)
 *    - Endpoint: /user/get-user-settings
 *    - Always required - exits if fails
 * 2. Attempt to load alliance membership
 *    - Endpoint: /alliance/get-user-alliance
 *    - Optional - sets ALLIANCE_ID to null if not in alliance
 *
 * Graceful Degradation:
 * - User not in alliance: ALLIANCE_ID = null, continues running
 * - Alliance endpoints will return empty arrays
 * - Chat auto-refresh skips when ALLIANCE_ID is null
 * - Other features (vessels, bunker, etc.) still work
 *
 * Failure Modes:
 * - User settings fail: process.exit(1) - Critical failure
 * - Alliance API error: Treats as "not in alliance" - Non-critical
 * - Invalid session cookie: User settings fail → exit
 * - Network error: User settings fail → exit
 *
 * Side Effects:
 * - Sets module-level variables: USER_ID, USER_COMPANY_NAME, ALLIANCE_ID
 * - Makes 1-2 API calls on startup
 * - Logs initialization status to console
 * - Exits process (process.exit(1)) if user settings fail
 *
 * @function initializeAlliance
 * @returns {Promise<void>}
 * @throws {Error} Never throws - exits process on critical failure
 *
 * @example
 * // Called from app.js during server startup
 * await initializeAlliance();
 * // Console output:
 * // ✓ User loaded: ABC Shipping Co. (ID: 12345)
 * // ✓ Alliance loaded: Best Alliance (ID: 67890)
 *
 * @example
 * // User not in alliance
 * await initializeAlliance();
 * // Console output:
 * // ✓ User loaded: ABC Shipping Co. (ID: 12345)
 * // ⚠ User is not in an alliance
 */
async function initializeAlliance() {
  try {
    // Debug: Show cookie info (first and last 10 chars for security)
    const cookie = config.SESSION_COOKIE;
    const cookiePreview = cookie ? `${cookie.substring(0, 10)}...${cookie.substring(cookie.length - 10)}` : 'NONE';
    logger.debug(`[Session] Initializing with cookie: ${cookiePreview} (length: ${cookie ? cookie.length : 0})`);

    // 1. Load User ID and Company Name first
    logger.debug(`[Session] Calling API: /user/get-user-settings...`);
    const userData = await apiCall('/user/get-user-settings', 'POST', {});

    // Check if API call failed
    if (!userData || userData.success === false || userData.error) {
      logger.error('[FATAL] API call to /user/get-user-settings failed!');
      logger.error('[FATAL] Response:', JSON.stringify(userData, null, 2));
      logger.error('[FATAL] This usually means:');
      logger.error('[FATAL]   1. Session cookie is invalid or expired');
      logger.error('[FATAL]   2. Session cookie is for wrong user');
      logger.error('[FATAL]   3. Game API rejected the request');
      logger.error('[FATAL] Cookie used:', cookiePreview);
      throw new Error(`Session validation failed: ${userData.error || userData.message || 'Unknown error'}`);
    }

    // Check if user data structure is correct
    if (!userData.user || !userData.user.id) {
      logger.error('[FATAL] API response missing user data!');
      logger.error('[FATAL] Response structure:', JSON.stringify(userData, null, 2));
      throw new Error('Invalid API response structure - missing user data');
    }

    USER_ID = userData.user.id;
    USER_COMPANY_NAME = userData.user.company_name;
    logger.debug(`[Session] User loaded: ${USER_COMPANY_NAME} (ID: ${USER_ID})`);
    logger.info(`[Session] User login successful`);

    // 2. Try to load Alliance ID
    try {
      const allianceData = await apiCall('/alliance/get-user-alliance', 'POST', {});
      if (allianceData.data && allianceData.data.alliance && allianceData.data.alliance.id) {
        ALLIANCE_ID = allianceData.data.alliance.id;
        ALLIANCE_NAME = allianceData.data.alliance.name;
        logger.debug(`[Session] Alliance loaded: ${ALLIANCE_NAME} (ID: ${ALLIANCE_ID})`);
        logger.info(`[Session] Alliance loaded`);
      } else {
        ALLIANCE_ID = null;
        ALLIANCE_NAME = null;
        logger.debug(`[Session] User is not in an alliance`);
      }
    } catch {
      ALLIANCE_ID = null;
      ALLIANCE_NAME = null;
      logger.debug(`[Session] User is not in an alliance`);
    }
  } catch (error) {
    logger.error('[FATAL] ======================================');
    logger.error('[FATAL] SESSION INITIALIZATION FAILED');
    logger.error('[FATAL] ======================================');
    logger.error('[FATAL] Error message:', error.message);
    logger.error('[FATAL] Error stack:', error.stack);
    logger.error('[FATAL] ======================================');
    logger.error('[FATAL] The session cookie is invalid or expired.');
    logger.error('[FATAL] Please restart the application and select a valid session.');
    logger.error('[FATAL] ======================================');
    process.exit(1);
  }
}

/**
 * Fetches the alliance chat feed from the game API.
 *
 * This function retrieves all recent messages and feed events for the user's alliance.
 * It's used by WebSocket auto-refresh (every 25 seconds) and manual chat refresh requests.
 *
 * Why This Function:
 * - Centralizes chat feed retrieval logic
 * - Handles "no alliance" case gracefully (returns empty array)
 * - Error handling prevents crashes during network issues
 * - Used by both WebSocket auto-refresh and manual refresh endpoints
 *
 * Feed Contents:
 * - Chat messages: User messages with message text, user_id, timestamp
 * - Feed events: Alliance joins, route completions, system announcements
 * - Typically last 50-100 items (game API decides)
 * - Ordered by time_created (most recent last)
 *
 * No Alliance Handling:
 * - Returns empty array immediately if ALLIANCE_ID is null
 * - Prevents 404 errors from /alliance/get-chat-feed endpoint
 * - Allows app to work for users not in alliance
 *
 * Error Handling:
 * - API errors caught and logged
 * - Returns empty array on error (prevents crash)
 * - Silent failures (doesn't throw, doesn't stop auto-refresh)
 *
 * Side Effects:
 * - Makes API call to /alliance/get-chat-feed
 * - Logs errors to console
 *
 * @function getChatFeed
 * @returns {Promise<Array>} Array of chat messages and feed events, or empty array if no alliance/error
 *
 * @example
 * const feed = await getChatFeed();
 * // Returns:
 * // [
 * //   { type: 'chat', user_id: 123, message: 'Hello!', time_created: 1729695000 },
 * //   { type: 'feed', feed_type: 'route_completed', replacements: {...}, time_created: 1729694500 }
 * // ]
 *
 * @example
 * // User not in alliance
 * const feed = await getChatFeed();
 * console.log(feed); // []
 */
async function getChatFeed() {
  if (!ALLIANCE_ID) {
    return [];
  }

  try {
    // Unified 90s timeout for chat feed (can be very slow with many messages)
    const data = await apiCall('/alliance/get-chat-feed', 'POST', { alliance_id: ALLIANCE_ID });
    return data.data.chat_feed;
  } catch (error) {
    // Silently handle socket hang ups (common with slow API) - only log other errors
    if (!error.message.includes('socket hang up') && !error.message.includes('ECONNRESET')) {
      logger.error('Error loading chat feed:', error.message);
    }
    return [];
  }
}

/**
 * Returns the current user's alliance ID.
 *
 * This getter provides read-only access to the alliance ID state variable.
 * Used by routes and WebSocket module to check alliance membership.
 *
 * @function getAllianceId
 * @returns {number|null} Alliance ID or null if user not in alliance
 *
 * @example
 * const allianceId = getAllianceId();
 * if (allianceId) {
 *   // User is in alliance, show alliance features
 * }
 */
function getAllianceId() {
  return ALLIANCE_ID;
}

/**
 * Returns the current user's unique identifier.
 *
 * This getter provides read-only access to the user ID state variable.
 * Used by routes to filter messages, identify ownership, etc.
 *
 * @function getUserId
 * @returns {number|null} User ID or null if not initialized
 *
 * @example
 * const userId = getUserId();
 * const isOwnMessage = message.user_id === userId;
 */
function getUserId() {
  return USER_ID;
}

/**
 * Returns the current user's company name.
 *
 * This getter provides read-only access to the company name state variable.
 * Used for logging, debugging, and UI display.
 *
 * @function getUserCompanyName
 * @returns {string|null} Company name or null if not initialized
 *
 * @example
 * const companyName = getUserCompanyName();
 * console.log(`Logged in as: ${companyName}`);
 */
function getUserCompanyName() {
  return USER_COMPANY_NAME;
}

/**
 * Returns the current user's alliance name
 * @returns {string|null} Alliance name or null if not in alliance
 */
function getAllianceName() {
  return ALLIANCE_NAME;
}

/**
 * Updates the cached alliance ID and name
 * @param {number|null} newAllianceId - New alliance ID or null if user left alliance
 * @param {string|null} newAllianceName - New alliance name (optional)
 */
function setAllianceId(newAllianceId, newAllianceName = null) {
  ALLIANCE_ID = newAllianceId;
  if (newAllianceName !== null) {
    ALLIANCE_NAME = newAllianceName;
  }
}

/**
 * Checks current alliance membership and updates cached ID if changed.
 * Broadcasts alliance_changed event to all clients when change detected.
 *
 * Call this periodically (e.g., in main event loop) to detect alliance switches.
 *
 * @returns {Promise<boolean>} True if alliance ID changed
 *
 * @example
 * // In main event loop (every 60s)
 * await checkAndUpdateAllianceId();
 */
async function checkAndUpdateAllianceId() {
  try {
    const allianceData = await apiCall('/alliance/get-user-alliance', 'POST', {});

    let newAllianceId = null;
    let newAllianceName = null;

    if (allianceData.data && allianceData.data.alliance && allianceData.data.alliance.id) {
      newAllianceId = allianceData.data.alliance.id;
      newAllianceName = allianceData.data.alliance.name || null;
    }

    if (newAllianceId === ALLIANCE_ID) {
      return false;
    }

    const oldId = ALLIANCE_ID;
    const oldName = ALLIANCE_NAME;

    setAllianceId(newAllianceId, newAllianceName);

    logger.info(`[Alliance] Alliance changed: ${oldName || 'None'} (${oldId}) -> ${newAllianceName || 'None'} (${newAllianceId})`);

    try {
      const { broadcast } = require('../websocket/broadcaster');
      broadcast('alliance_changed', {
        old_alliance_id: oldId,
        new_alliance_id: newAllianceId,
        old_alliance_name: oldName,
        new_alliance_name: newAllianceName
      });

      // Trigger immediate data refresh when alliance changes
      logger.info('[Alliance] Triggering immediate data refresh after alliance change');
      const { updateAllData } = require('../autopilot');
      const { performChatRefresh } = require('../websocket/chat-refresh');

      setImmediate(() => {
        // Refresh all standard data (bunker, prices, coop, vessels, etc.)
        updateAllData().catch(err => {
          logger.error('[Alliance] Failed to refresh data after alliance change:', err.message);
        });

        // Also refresh chat messages if user joined an alliance
        if (newAllianceId !== null) {
          performChatRefresh().catch(err => {
            logger.error('[Alliance] Failed to refresh chat after alliance change:', err.message);
          });
        }
      });
    } catch (error) {
      logger.error('[Alliance] Failed to broadcast alliance change:', error.message);
    }

    return true;
  } catch (error) {
    logger.debug('[Alliance] Failed to check alliance ID:', error.message);
    return false;
  }
}

module.exports = {
  apiCall,
  apiCallWithRetry,
  getCompanyName,
  initializeAlliance,
  getChatFeed,
  getAllianceId,
  getAllianceName,
  setAllianceId,
  checkAndUpdateAllianceId,
  getUserId,
  getUserCompanyName
};
