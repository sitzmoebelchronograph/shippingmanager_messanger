/**
 * @fileoverview ChatBot Message Sender Module
 *
 * Handles sending responses via alliance chat or private messages.
 * Supports public responses, DMs, and both.
 *
 * @module server/chatbot/sender
 */

const { apiCall, getAllianceId, getUserId } = require('../utils/api');
const { triggerImmediateChatRefresh, triggerImmediateMessengerRefresh } = require('../websocket');
const logger = require('../utils/logger');

/**
 * Send response based on type
 * @param {string} message - Message content
 * @param {string} responseType - Response type ('public', 'dm', 'both')
 * @param {string} userId - User ID to send DM to
 * @param {boolean} isDM - Whether command came from DM
 */
async function sendResponse(message, responseType, userId, isDM) {
    logger.debug(`[ChatBot] sendResponse: userId=${userId}, isDM=${isDM}, configResponseType=${responseType}`);

    // Simple rule: Alliance chat → public, DM → dm
    if (!isDM) {
        // Alliance chat command → always public response
        responseType = 'public';
        logger.debug(`[ChatBot] Alliance chat command → public response`);
    } else {
        // DM command → always dm response
        responseType = 'dm';
        logger.debug(`[ChatBot] DM command → dm response`);
    }

    switch (responseType) {
        case 'public':
            await sendAllianceMessage(message);
            break;

        case 'dm':
            const result = await sendPrivateMessage(userId, 'Bot Response', message);

            // If self-DM failed, fall back to public response
            if (!result) {
                const currentUserId = getUserId();
                if (userId === currentUserId) {
                    // Send shortened public response
                    const shortMsg = message.length > 200 ?
                        message.substring(0, 197) + '...' :
                        message;
                    await sendAllianceMessage(`[Auto-Reply] ${shortMsg}`);
                }
            }
            break;

        case 'both':
            await sendAllianceMessage(message.substring(0, 200) + '...'); // Short version
            await sendPrivateMessage(userId, 'Full Response', message);
            break;
    }
}

/**
 * Log error to console only - NEVER send errors to chat or DM
 * @param {string} userId - User ID
 * @param {string} command - Command name
 * @param {Error} error - Error object
 */
async function sendErrorMessage(userId, command, error) {
    // ONLY log to console - no messages to users
    logger.error(`[ChatBot] Error executing command '${command}' for user ${userId}:`, error);
    // That's it - no sending messages anywhere!
}

/**
 * Send alliance message
 * @param {string} message - Message content
 */
async function sendAllianceMessage(message) {
    try {
        const allianceId = getAllianceId();

        // CRITICAL: Game API has 1000 character limit
        if (message.length > 1000) {
            logger.error(`[ChatBot] WARNING: Message too long! ${message.length} chars (max: 1000)`);
            logger.error(`[ChatBot] Message will be truncated to avoid API error`);

            // Truncate message and add indicator
            message = message.substring(0, 997) + '...';
        }

        // Use the correct endpoint that posts to alliance chat
        const response = await apiCall('/alliance/post-chat', 'POST', {
            alliance_id: allianceId,
            text: message
        });

        // Only log errors
        if (response?.error) {
            logger.error('[ChatBot] API returned error:', response.error);
        } else {
            // Trigger immediate chat refresh so clients see the response quickly
            // instead of waiting up to 25 seconds for next polling cycle
            triggerImmediateChatRefresh();
        }
    } catch (error) {
        logger.error('[ChatBot] Failed to send alliance message:', error);
        logger.error('[ChatBot] Error details:', error.response?.data || error.message);
    }
}

/**
 * Send private message
 * @param {string} userId - Recipient user ID
 * @param {string} subject - Message subject
 * @param {string} message - Message body
 * @returns {Promise<object|null>} API response or null on failure
 */
async function sendPrivateMessage(userId, subject, message) {
    const myUserId = getUserId();

    try {
        // CRITICAL: Game API has 1000 character limit for messages
        if (message.length > 1000) {
            logger.error(`[ChatBot] WARNING: DM too long! ${message.length} chars (max: 1000)`);
            logger.error(`[ChatBot] Message will be truncated to avoid API error`);

            // Truncate message and add indicator
            message = message.substring(0, 997) + '...';
        }

        const response = await apiCall('/messenger/send-message', 'POST', {
            recipient: userId,
            subject: subject,
            body: message
        });

        // Trigger immediate messenger refresh so user sees the response quickly
        // instead of waiting up to 10 seconds for next polling cycle
        if (response && !response.error) {
            triggerImmediateMessengerRefresh();
        }

        return response;
    } catch (error) {
        logger.error(`[ChatBot] Failed to send private message to ${userId}:`, error);
        logger.error(`[ChatBot] Error details:`, error.response?.data || error.message);

        // Special handling for self-DM attempts
        if (userId === myUserId) {
            logger.error(`[ChatBot] Cannot send DM to yourself - game API limitation`);
            logger.debug(`[ChatBot] Falling back to public response`);
            // Don't re-throw for self-DM, handle gracefully
            return null;
        }

        throw error; // Re-throw for other errors
    }
}

module.exports = {
    sendResponse,
    sendErrorMessage,
    sendAllianceMessage,
    sendPrivateMessage
};
