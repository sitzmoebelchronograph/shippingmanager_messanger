/**
 * @fileoverview Alliance Chat API Routes
 *
 * This module defines HTTP endpoints for alliance chat functionality, including
 * fetching the chat feed, sending messages, and retrieving alliance member information.
 * It acts as a proxy between the frontend and the Shipping Manager game API.
 *
 * Key Features:
 * - Chat feed retrieval with message transformation (API format → client format)
 * - Message sending with validation and rate limiting
 * - Company name lookup by user ID (used for chat rendering)
 * - Alliance member list retrieval
 * - Graceful handling of users not in alliance (no_alliance flag)
 *
 * Why This Exists:
 * - Centralizes alliance-related endpoints
 * - Abstracts game API details from frontend
 * - Provides input validation and sanitization
 * - Implements rate limiting on message sending
 * - Transforms timestamps and enriches data with company names
 *
 * Security Considerations:
 * - Message length validation (0-1000 characters)
 * - Input sanitization via validator.trim() and validator.unescape()
 * - Rate limiting: 30 messages per minute (messageLimiter)
 * - User ID validation (must be positive integer)
 * - Authentication inherited from apiCall() session cookie
 *
 * No Alliance Handling:
 * - All endpoints check getAllianceId() before proceeding
 * - Returns appropriate response when user not in alliance
 * - Prevents 404 errors from game API alliance endpoints
 *
 * @requires express - Router and middleware
 * @requires validator - Input validation and sanitization
 * @requires ../utils/api - API helper functions (apiCall, getCompanyName, etc.)
 * @requires ../middleware - Rate limiting middleware
 * @module server/routes/alliance
 */

const express = require('express');
const validator = require('validator');
const { apiCall, getCompanyName, getChatFeed, getAllianceId, getUserId, setAllianceId } = require('../utils/api');
const { messageLimiter } = require('../middleware');
const { getLastReadTimestamp, updateLastReadTimestamp } = require('../utils/read-tracker');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/chat - Retrieves alliance chat feed with enriched message data and unread count.
 *
 * This endpoint fetches the alliance chat feed from the game API, transforms
 * the raw feed data into a client-friendly format with company names and
 * formatted timestamps, and returns it as JSON along with unread count.
 *
 * Why This Transformation:
 * - API returns user_id, but frontend needs company name for display
 * - Timestamps converted from Unix epoch to UTC string for readability
 * - Separates 'chat' messages from 'feed' events for different UI rendering
 * - Company names cached to reduce API calls
 * - Backend tracks read status (prevents localStorage sync issues)
 *
 * Message Types:
 * 1. Chat Messages (type: 'chat')
 *    - Fetches company name via getCompanyName() (cached)
 *    - Includes message text and user_id
 * 2. Feed Events (type: 'feed')
 *    - Alliance joins, route completions, etc.
 *    - Company name already in replacements object
 *
 * Read Tracking:
 * - Backend stores per-user last read timestamp
 * - Unread count calculated by comparing message timestamps to lastRead
 * - Only chat messages counted as unread (not feed events)
 * - Syncs across all connected clients/devices
 *
 * No Alliance Response:
 * - Returns { no_alliance: true, messages: [], unreadCount: 0, lastReadTimestamp: 0 } when user not in alliance
 * - Frontend can detect this and hide alliance features
 *
 * Response Format:
 * {
 *   messages: [
 *     {
 *       type: 'chat',
 *       company: 'ABC Shipping',
 *       message: 'Hello!',
 *       timestamp: 'Mon, 23 Oct 2025 14:30:00 GMT',
 *       user_id: 12345
 *     },
 *     {
 *       type: 'feed',
 *       feedType: 'alliance_member_joined',
 *       company: 'XYZ Corp',
 *       timestamp: 'Mon, 23 Oct 2025 14:25:00 GMT'
 *     }
 *   ],
 *   unreadCount: 3,
 *   lastReadTimestamp: 1699876543000
 * }
 *
 * Side Effects:
 * - Makes API call to /alliance/get-chat-feed
 * - May make multiple API calls to /user/get-company for uncached names
 * - Reads user's last read timestamp from read-tracker
 *
 * @name GET /api/chat
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with messages array, unreadCount, and lastReadTimestamp
 */
router.get('/chat', async (req, res) => {
  if (!getAllianceId()) {
    return res.json({ no_alliance: true, messages: [], unreadCount: 0, lastReadTimestamp: 0 });
  }

  try {
    const feed = await getChatFeed();
    const messages = [];

    for (const msg of feed) {
      if (msg.type === 'chat') {
        const companyName = await getCompanyName(msg.user_id);
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        const timestampMs = msg.time_created * 1000;
        messages.push({
          type: 'chat',
          company: companyName,
          message: msg.message,
          timestamp: timestamp,
          timestampMs: timestampMs, // Add Unix timestamp in milliseconds for comparison
          user_id: msg.user_id
        });
      } else if (msg.type === 'feed') {
        const timestamp = new Date(msg.time_created * 1000).toUTCString();
        const timestampMs = msg.time_created * 1000;
        messages.push({
          type: 'feed',
          feedType: msg.feed_type,
          company: msg.replacements.company_name,
          timestamp: timestamp,
          timestampMs: timestampMs
        });
      }
    }

    // Get user's last read timestamp from backend
    const userId = getUserId();
    const lastReadTimestamp = getLastReadTimestamp(userId);

    // Calculate unread count (only chat messages, not feed events, not own messages)
    const unreadCount = messages.filter(msg => {
      return msg.type === 'chat' &&
             msg.timestampMs > lastReadTimestamp &&
             msg.user_id !== userId; // Exclude own messages
    }).length;

    res.json({
      messages: messages,
      unreadCount: unreadCount,
      lastReadTimestamp: lastReadTimestamp
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/send-message - Sends a message to alliance chat with validation and rate limiting.
 *
 * This endpoint receives a chat message from the frontend, validates and sanitizes it,
 * then forwards it to the game API. It's the primary workaround for the in-game chat bug
 * that causes page reloads with certain characters.
 *
 * Why This Endpoint:
 * - Bypasses in-game chat interface that has character bugs
 * - Provides input validation before hitting game API
 * - Blocks dangerous HTML/JavaScript patterns to prevent XSS attacks
 * - Rate limits to prevent spam (30 messages/minute)
 *
 * Validation Rules:
 * - Message must be string type
 * - Length: 1-1000 characters (game API limit)
 * - Trimmed of leading/trailing whitespace
 * - Dangerous patterns blocked: <script>, <iframe>, javascript:, onerror=, etc.
 *
 * Rate Limiting:
 * - Applied via messageLimiter middleware
 * - Limit: 30 requests per minute per IP
 * - Returns 429 Too Many Requests when exceeded
 * - Prevents spam and reduces ToS violation risk
 *
 * Security Strategy (Defense in Depth):
 * - Backend: Pattern blocking (blocks dangerous HTML/JS)
 * - Frontend: HTML escaping on render (escapes all HTML entities)
 * - This prevents XSS while avoiding double-escaping issues
 * - Prevents empty messages after trimming
 *
 * No Alliance Handling:
 * - Returns 400 error if user not in alliance
 * - Prevents API call to /alliance/post-chat with null alliance_id
 *
 * Side Effects:
 * - Makes API call to /alliance/post-chat
 * - Message appears in alliance chat feed immediately
 * - WebSocket broadcast will include this message in next refresh cycle
 *
 * @name POST /api/send-message
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with { message: string } body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response { success: true } or error
 */
router.post('/send-message', messageLimiter, express.json(), async (req, res) => {
  if (!getAllianceId()) {
    return res.status(400).json({ error: 'You are not in an alliance' });
  }

  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.length === 0 || message.length > 1000) {
    return res.status(400).json({ error: 'Invalid message length or content' });
  }

  const trimmedMessage = validator.trim(message);

  // Block dangerous HTML/JavaScript patterns
  const dangerousPatterns = /<script|<iframe|javascript:|data:text\/html|on\w+\s*=/i;
  if (dangerousPatterns.test(trimmedMessage)) {
    return res.status(400).json({
      error: 'Message contains forbidden HTML or JavaScript content'
    });
  }

  try {
    await apiCall('/alliance/post-chat', 'POST', {
      alliance_id: getAllianceId(),
      text: trimmedMessage
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/company-name - Retrieves company name for a given user ID.
 *
 * This endpoint looks up a company name by user ID, leveraging the cached
 * getCompanyName() function to minimize API calls. Used by frontend for
 * displaying company names in various UI contexts.
 *
 * Why This Endpoint:
 * - Centralizes company name lookups
 * - Leverages server-side cache (reduces API calls)
 * - Provides fallback for failed lookups
 * - Validates user_id to prevent invalid API calls
 *
 * Validation:
 * - user_id must be positive integer
 * - Returns 400 error for invalid user_id
 *
 * Caching:
 * - getCompanyName() uses Map-based cache
 * - Cache persists for server lifetime
 * - Significant performance improvement for repeated lookups
 *
 * Fallback:
 * - Returns "User {userId}" if lookup fails
 * - Never throws error to frontend
 *
 * Side Effects:
 * - May make API call to /user/get-company on cache miss
 * - Stores result in userNameCache
 *
 * @name POST /api/company-name
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with { user_id: number } body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response { company_name: string }
 */
router.post('/company-name', express.json(), async (req, res) => {
  const { user_id } = req.body;
  if (!Number.isInteger(user_id) || user_id <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  try {
    const companyName = await getCompanyName(user_id);
    res.json({ company_name: companyName });
  } catch {
    res.status(500).json({ error: 'Could not load company name' });
  }
});

/**
 * GET /api/alliance-members - Retrieves list of all alliance members.
 *
 * This endpoint fetches the complete alliance member roster from the game API
 * and returns it as a simplified array of user_id and company_name pairs.
 *
 * Why This Endpoint:
 * - Provides member list for UI features (member directory, mentions, etc.)
 * - Simplifies game API response (returns only needed fields)
 * - Gracefully handles users not in alliance
 *
 * No Alliance Handling:
 * - Returns empty array [] when user not in alliance
 * - Prevents 404 errors from game API
 *
 * Response Format:
 * [
 *   { user_id: 12345, company_name: "ABC Shipping" },
 *   { user_id: 67890, company_name: "XYZ Corp" }
 * ]
 *
 * Side Effects:
 * - Makes API call to /alliance/get-alliance-members
 *
 * @name GET /api/alliance-members
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with members array
 */
router.get('/alliance-members', async (req, res) => {
  if (!getAllianceId()) {
    return res.json({ members: [], current_user_id: getUserId() });
  }

  try {
    // Fetch all 4 stat variations in parallel
    const [baseData, lastSeasonData, last24hData, lifetimeData] = await Promise.all([
      apiCall('/alliance/get-alliance-members', 'POST', {
        lifetime_stats: false,
        last_24h_stats: false,
        last_season_stats: false,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        lifetime_stats: false,
        last_24h_stats: false,
        last_season_stats: true,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        lifetime_stats: false,
        last_24h_stats: true,
        last_season_stats: false,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        lifetime_stats: true,
        last_24h_stats: false,
        last_season_stats: false,
        include_last_season_top_contributors: true
      })
    ]);

    // Merge data: keep separate stats for each filter (24h, season, lifetime)
    const memberMap = new Map();

    // Process base data (initialize members)
    baseData.data.members.forEach(member => {
      memberMap.set(member.user_id, {
        user_id: member.user_id,
        company_name: member.company_name,
        role: member.role,
        is_rookie: member.is_rookie,
        time_joined: member.time_joined,
        share_value: member.share_value,
        difficulty: member.difficulty,
        tanker_ops: member.tanker_ops,
        time_last_login: member.time_last_login,
        stats: {
          last_24h: { contribution: 0, departures: 0 },
          last_season: { contribution: 0, departures: 0 },
          lifetime: { contribution: 0, departures: 0 }
        }
      });
    });

    // Add last_24h stats
    last24hData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.last_24h = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    // Add last_season stats
    lastSeasonData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.last_season = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    // Add lifetime stats
    lifetimeData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.lifetime = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    const members = Array.from(memberMap.values());

    const responseData = {
      members: members,
      current_user_id: getUserId()
    };

    // Include last_season_top_contributors if available from the base response
    if (baseData.data.last_season_top_contributors) {
      responseData.last_season_top_contributors = baseData.data.last_season_top_contributors;
    }

    res.json(responseData);
  } catch (error) {
    logger.error('[Alliance Members] Error fetching members with all stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/mark-read - Marks alliance chat as read up to a specific timestamp.
 *
 * This endpoint updates the user's last read timestamp for alliance chat,
 * which is used to calculate unread counts and prevent notification spam.
 *
 * Why This Endpoint:
 * - Provides backend-controlled read tracking (syncs across devices)
 * - Called when user opens alliance chat panel
 * - Prevents old messages from repeatedly showing as unread
 * - Stops duplicate notifications for messages user has already seen
 *
 * Request Body:
 * - timestamp: Unix timestamp in milliseconds (number)
 *   - Should be the timestamp of the latest message in the chat
 *   - All messages with timestamp <= this value are marked as read
 *
 * Validation:
 * - Timestamp must be positive integer
 * - Returns 400 error for invalid timestamp
 *
 * Side Effects:
 * - Updates user's last read timestamp in read-tracker
 * - Persists to userdata/settings/read-tracking.json
 * - Future GET /api/chat calls will use this timestamp for unread count
 *
 * @name POST /api/chat/mark-read
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with { timestamp: number } body
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response { success: true } or error
 *
 * @example
 * // Mark chat as read up to current time
 * POST /api/chat/mark-read
 * Body: { "timestamp": 1699876543000 }
 * Response: { "success": true }
 */
router.post('/chat/mark-read', express.json(), async (req, res) => {
  try {
    const { timestamp } = req.body;

    // Validate timestamp
    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
      return res.status(400).json({ error: 'Invalid timestamp. Must be a positive number.' });
    }

    // Get current user ID
    const userId = getUserId();
    if (!userId) {
      return res.status(500).json({ error: 'User ID not available' });
    }

    // Update last read timestamp
    const success = updateLastReadTimestamp(userId, timestamp);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to update read timestamp' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alliance-info - Retrieves alliance details including stats and benefits.
 *
 * This endpoint fetches comprehensive alliance information from the game API,
 * including alliance stats, benefit levels, league info, and coop status.
 *
 * Response includes:
 * - Alliance name, logo, description, language
 * - Member count, total share value
 * - Stats: departures, contribution score, coops (24h/season/total)
 * - Benefit levels and boosts (rep_boost, demand_boost, coop_boost)
 * - League level, group position, promotion status
 * - Coop status (used vs needed)
 *
 * @name GET /api/alliance-info
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with alliance data (excluding user object)
 */
router.get('/alliance-info', async (req, res) => {
  if (!getAllianceId()) {
    return res.json({ no_alliance: true });
  }

  try {
    const data = await apiCall('/alliance/get-alliance', 'POST', {
      alliance_id: getAllianceId()
    });
    res.json(data.data.alliance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alliance-info/:id - Retrieves specific alliance details by ID.
 *
 * This endpoint fetches comprehensive alliance information for ANY alliance,
 * not just the user's alliance. Used for viewing other alliances from highscores.
 *
 * @name GET /api/alliance-info/:id
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with alliance ID param
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with alliance data
 */
router.get('/alliance-info/:id', async (req, res) => {
  try {
    const allianceId = parseInt(req.params.id, 10);
    if (isNaN(allianceId)) {
      return res.status(400).json({ error: 'Invalid alliance ID' });
    }

    const data = await apiCall('/alliance/get-alliance', 'POST', {
      alliance_id: allianceId
    });

    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    res.json(data.data.alliance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alliance-members/:id - Retrieves members of a specific alliance by ID.
 *
 * This endpoint fetches member information for ANY alliance,
 * not just the user's alliance. Used for viewing other alliances from highscores.
 *
 * @name GET /api/alliance-members/:id
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with alliance ID param
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with members array
 */
router.get('/alliance-members/:id', async (req, res) => {
  try {
    const allianceId = parseInt(req.params.id, 10);
    if (isNaN(allianceId)) {
      return res.status(400).json({ error: 'Invalid alliance ID' });
    }

    // Fetch all 4 stat variations in parallel
    const [baseData, lastSeasonData, last24hData, lifetimeData] = await Promise.all([
      apiCall('/alliance/get-alliance-members', 'POST', {
        alliance_id: allianceId,
        lifetime_stats: false,
        last_24h_stats: false,
        last_season_stats: false,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        alliance_id: allianceId,
        lifetime_stats: false,
        last_24h_stats: false,
        last_season_stats: true,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        alliance_id: allianceId,
        lifetime_stats: false,
        last_24h_stats: true,
        last_season_stats: false,
        include_last_season_top_contributors: true
      }),
      apiCall('/alliance/get-alliance-members', 'POST', {
        alliance_id: allianceId,
        lifetime_stats: true,
        last_24h_stats: false,
        last_season_stats: false,
        include_last_season_top_contributors: true
      })
    ]);

    if (baseData.error) {
      return res.status(400).json({ error: baseData.error });
    }

    // Merge data: keep separate stats for each filter (24h, season, lifetime)
    const memberMap = new Map();

    // Process base data (initialize members)
    baseData.data.members.forEach(member => {
      memberMap.set(member.user_id, {
        user_id: member.user_id,
        company_name: member.company_name,
        role: member.role,
        is_rookie: member.is_rookie,
        time_joined: member.time_joined,
        share_value: member.share_value,
        difficulty: member.difficulty,
        tanker_ops: member.tanker_ops,
        time_last_login: member.time_last_login,
        stats: {
          last_24h: { contribution: 0, departures: 0 },
          last_season: { contribution: 0, departures: 0 },
          lifetime: { contribution: 0, departures: 0 }
        }
      });
    });

    // Add last_24h stats
    last24hData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.last_24h = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    // Add last_season stats
    lastSeasonData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.last_season = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    // Add lifetime stats
    lifetimeData.data.members.forEach(member => {
      if (memberMap.has(member.user_id)) {
        memberMap.get(member.user_id).stats.lifetime = {
          contribution: member.contribution || 0,
          departures: member.departures || 0
        };
      }
    });

    const members = Array.from(memberMap.values());

    // Include last_season_top_contributors if available from the base response
    const responseData = {
      members: members
    };

    if (baseData.data.last_season_top_contributors) {
      responseData.last_season_top_contributors = baseData.data.last_season_top_contributors;
    }

    res.json(responseData);
  } catch (error) {
    logger.error('[Alliance Members By ID] Error fetching members with all stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alliance-high-scores - Retrieves alliance leaderboard rankings.
 *
 * This endpoint fetches the top alliances ranked by contribution score,
 * showing their benefit levels, member counts, and league positions.
 *
 * Query Parameters:
 * - page: Page number (default: 0)
 * - tab: "current" or "previous" season (default: "current")
 * - language: "global" or specific language code (default: "global")
 * - league_level: "all" or specific level number (default: "all")
 * - score: Sorting metric, e.g., "contribution" (default: "contribution")
 *
 * @name GET /api/alliance-high-scores
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with optional query params
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with highscores data
 */
router.get('/alliance-high-scores', async (req, res) => {
  try {
    const {
      page = 0,
      tab = 'current',
      language = 'global',
      league_level = 'all',
      score = 'contribution'
    } = req.query;

    const data = await apiCall('/alliance/get-high-scores', 'POST', {
      page: parseInt(page, 10),
      tab,
      language,
      league_level,
      score
    });
    res.json(data.data.highscores);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alliance-settings - Retrieves user's alliance cooperation settings.
 *
 * This endpoint fetches the user's current alliance settings including
 * coop enabled status and any restrictions configured.
 *
 * Response includes:
 * - coop_enabled: boolean
 * - restrictions: { selected_vessel_capacity, time_restriction_arr, time_range_enabled }
 *
 * @name GET /api/alliance-settings
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with settings data
 */
router.get('/alliance-settings', async (req, res) => {
  if (!getAllianceId()) {
    return res.json({ no_alliance: true });
  }

  try {
    const data = await apiCall('/alliance/get-settings', 'POST', {
      alliance_id: getAllianceId()
    });
    res.json(data.data.settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alliance-queue-pool - Retrieves queue pool for alliance cooperation.
 *
 * This endpoint fetches the queue pool of available vessels/members for
 * alliance cooperation with filtering and pagination support.
 *
 * Request Body:
 * - pool_type: "direct" or other pool types (default: "direct")
 * - filter_share_value: "any", "low", "medium", "high" (default: "any")
 * - filter_fleet_size: "any", "small", "medium", "large" (default: "any")
 * - filter_experience: "all", "beginner", "intermediate", "expert" (default: "all")
 * - page: Page number (default: 1)
 *
 * @name POST /api/alliance-queue-pool
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with filter params
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with pool data
 */
router.post('/alliance-queue-pool', async (req, res) => {
  try {
    logger.debug('[Alliance Queue Pool] Request received:', req.body);

    if (!getAllianceId()) {
      return res.json({ no_alliance: true, pool: {} });
    }

    const {
      pool_type = 'direct',
      filter_share_value = 'any',
      filter_fleet_size = 'any',
      filter_experience = 'all',
      page = 1
    } = req.body;

    logger.debug('[Alliance Queue Pool] Calling API with pool_type:', pool_type);

    const data = await apiCall('/alliance/get-queue-pool-for-alliance', 'POST', {
      alliance_id: getAllianceId(),
      pool_type,
      filter_share_value,
      filter_fleet_size,
      filter_experience,
      page: parseInt(page, 10)
    });

    logger.debug('[Alliance Queue Pool] API response:', JSON.stringify(data));

    if (!data.data || !data.data.pool) {
      logger.error('[Alliance Queue Pool] Invalid API response:', JSON.stringify(data));
      return res.status(500).json({ error: 'Invalid API response' });
    }

    res.json(data.data.pool);
  } catch (error) {
    logger.error('[Alliance Queue Pool] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alliance-accept-user - Accepts a user's application to join the alliance.
 *
 * This endpoint allows alliance management to accept pending applications from users
 * who want to join the alliance. The user will be added as a member upon acceptance.
 *
 * Game API Endpoint: POST /alliance/accept-user-to-join-alliance
 * Required Parameters:
 * - user_id: The ID of the user applying to join
 * - alliance_id: The ID of the alliance (automatically provided)
 *
 * @name POST /api/alliance-accept-user
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with user_id
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with success/failure
 */
router.post('/alliance-accept-user', express.json(), async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!getAllianceId()) {
      return res.status(400).json({ error: 'You are not in an alliance' });
    }

    logger.debug(`[Alliance Accept User] Accepting user ${user_id} to alliance ${getAllianceId()}`);

    const data = await apiCall('/alliance/accept-user-to-join-alliance', 'POST', {
      user_id: parseInt(user_id, 10),
      alliance_id: getAllianceId()
    });

    if (data.error) {
      logger.error('[Alliance Accept User] API error:', data.error);
      return res.status(400).json({ error: data.error });
    }

    logger.info(`[Alliance Accept User] Successfully accepted user ${user_id}`);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[Alliance Accept User] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alliance-decline-user - Declines a user's application to join the alliance.
 *
 * This endpoint allows alliance management to decline pending applications from users
 * who want to join the alliance. The application will be removed from the queue.
 *
 * Game API Endpoint: POST /alliance/decline-user-direct-application
 * Required Parameters:
 * - user_id: The ID of the user whose application to decline
 * - alliance_id: The ID of the alliance (automatically provided)
 *
 * @name POST /api/alliance-decline-user
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with user_id
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with success/failure
 */
router.post('/alliance-decline-user', express.json(), async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!getAllianceId()) {
      return res.status(400).json({ error: 'You are not in an alliance' });
    }

    logger.debug(`[Alliance Decline User] Declining user ${user_id} from alliance ${getAllianceId()}`);

    const data = await apiCall('/alliance/decline-user-direct-application', 'POST', {
      user_id: parseInt(user_id, 10),
      alliance_id: getAllianceId()
    });

    if (data.error) {
      logger.error('[Alliance Decline User] API error:', data.error);
      return res.status(400).json({ error: data.error });
    }

    logger.info(`[Alliance Decline User] Successfully declined user ${user_id}`);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[Alliance Decline User] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alliance-update-user-role - Updates a member's role in the alliance.
 *
 * This endpoint allows alliance admins/leaders to change member roles.
 * Requires appropriate permissions in the alliance.
 *
 * Request Body:
 * - user_id: User ID of the member to update (required)
 * - role: New role for the member (required)
 *
 * @name POST /api/alliance-update-user-role
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object with user_id and role
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with success/failure
 */
router.post('/alliance-update-user-role', express.json(), async (req, res) => {
  if (!getAllianceId()) {
    return res.status(400).json({ error: 'You are not in an alliance' });
  }

  const { user_id, role } = req.body;

  if (!Number.isInteger(user_id) || user_id <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  if (!role || typeof role !== 'string') {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const data = await apiCall('/alliance/update-user-role', 'POST', {
      user_id,
      role
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/league-info - Retrieves user's league and group standings.
 *
 * This endpoint fetches the user's current league level, group position,
 * and related league information from the game API.
 *
 * @name GET /api/league-info
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with league data
 */
router.get('/league-info', async (req, res) => {
  try {
    const data = await apiCall('/league/get-user-league-and-group', 'POST', {});
    res.json(data.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alliance-leave - Leave the current alliance.
 *
 * @name POST /api/alliance-leave
 * @function
 * @memberof module:server/routes/alliance
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {Promise<void>} Sends JSON response with result
 */
router.post('/alliance-leave', async (req, res) => {
  if (!getAllianceId()) {
    return res.status(400).json({ error: 'Not in an alliance' });
  }

  try {
    const data = await apiCall('/alliance/leave-alliance', 'POST', {});

    if (data.error || data.success === false) {
      return res.status(500).json({ error: data.error || 'Failed to leave alliance' });
    }

    // Clear alliance ID from server state immediately
    setAllianceId(null);
    logger.info('[Alliance] Successfully left alliance, cleared alliance ID from server state');

    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error leaving alliance:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-send-welcome', express.json(), async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id || !Number.isInteger(user_id)) {
      return res.status(400).json({ error: 'Valid user_id required' });
    }

    const { handleWelcomeCommand } = require('../chatbot/commands');
    await handleWelcomeCommand(user_id.toString(), getUserId(), 'System');

    res.json({ success: true });
  } catch (error) {
    logger.error('[Alliance] Error sending welcome message:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-apply-join', express.json(), async (req, res) => {
  try {
    const { alliance_id, application_text } = req.body;

    if (!alliance_id || !Number.isInteger(alliance_id)) {
      return res.status(400).json({ error: 'Valid alliance_id required' });
    }

    const data = await apiCall('/alliance/apply-direct-to-join-alliance', 'POST', {
      alliance_id,
      application_text: application_text || ''
    });

    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error applying to join alliance:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-join-pool-any', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/join-pool-for-any-alliance', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error joining pool for any alliance:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-leave-pool-any', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/leave-pool-for-any-alliance', 'POST', {
      time_requested_in_48h: true
    });
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error leaving pool for any alliance:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-get-applications', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/get-open-alliances', 'POST', {
      limit: 50,
      offset: 0,
      filter: 'all'
    });
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error getting applications:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-cancel-application', express.json(), async (req, res) => {
  try {
    const { alliance_id } = req.body;

    if (!alliance_id || !Number.isInteger(alliance_id)) {
      return res.status(400).json({ error: 'Valid alliance_id required' });
    }

    const data = await apiCall('/alliance/cancel-direct-application-to-join-alliance', 'POST', {
      alliance_id
    });
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error cancelling application:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-cancel-all-applications', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/cancel-all-applications', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error cancelling all applications:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-join-pool-any', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/join-pool-for-any-alliance', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error joining alliance pool:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/alliance-leave-pool-any', express.json(), async (req, res) => {
  try {
    const data = await apiCall('/alliance/leave-pool-for-any-alliance', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('[Alliance] Error leaving alliance pool:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
