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
const { apiCall, getCompanyName, getChatFeed, getAllianceId, getUserId } = require('../utils/api');
const { messageLimiter } = require('../middleware');
const { getLastReadTimestamp, updateLastReadTimestamp } = require('../utils/read-tracker');

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
    return res.json([]);
  }

  try {
    const data = await apiCall('/alliance/get-alliance-members', 'POST', {});
    const members = data.data.members.map(member => ({
      user_id: member.user_id,
      company_name: member.company_name
    }));
    res.json(members);
  } catch (error) {
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

module.exports = router;
