/**
 * @fileoverview ChatBot Command Handlers Module
 *
 * Handles built-in command logic (forecast, help).
 * Custom commands are handled by executor.js.
 *
 * @module server/chatbot/commands
 */

const logger = require('../utils/logger');
const fs = require('fs').promises;
const { getUserId, getAllianceName } = require('../utils/api');
const { getSettingsFilePath } = require('../settings-schema');

/**
 * Handle forecast command
 * @param {Array<string>} args - Command arguments [day, timezone]
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 * @param {Function} sendResponseFn - Function to send response
 */
async function handleForecastCommand(args, userId, userName, config, isDM, sendResponseFn) {
    // Parse arguments
    const now = new Date();
    let day;
    let responseType = config.responseType || 'dm';

    // If no arguments, use tomorrow (default forecast behavior)
    if (args.length === 0) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        day = tomorrow.getDate();
    } else {
        day = parseInt(args[0]) || now.getDate() + 1; // Default to tomorrow if arg invalid
    }

    // Default timezone: undefined = server will use its local timezone
    // This allows the API to determine the appropriate timezone
    let timezone = args[1] || undefined;

    // Validate day (1-31)
    if (day < 1 || day > 31) {
        throw new Error('Invalid day. Please specify a day between 1 and 31.');
    }

    // Validate timezone if provided
    const validTimezones = [
        'PST', 'PDT', 'MST', 'MDT', 'CST', 'CDT', 'EST', 'EDT',
        'GMT', 'BST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST',
        'JST', 'KST', 'IST',
        'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST',
        'NZST', 'NZDT',
        'UTC'
    ];

    if (timezone && !validTimezones.includes(timezone.toUpperCase())) {
        // Invalid timezone - send error message
        const errorMsg = `❌ Invalid timezone: "${timezone}"\n\n`;
        const tzList = `⁉️ Supported timezones:\n${validTimezones.join(', ')}`;
        await sendResponseFn(errorMsg + tzList, responseType, userId, isDM);
        return; // Exit early
    }

    // Normalize timezone to uppercase (if provided)
    if (timezone) {
        timezone = timezone.toUpperCase();
    }

    // Get forecast data
    const forecastText = await generateForecastText(day, timezone);

    // Only send response if we got valid forecast text
    if (forecastText && forecastText.trim()) {
        await sendResponseFn(forecastText, responseType, userId, isDM);
    } else {
        logger.debug('[ChatBot] No forecast text generated - skipping response');
    }
}

/**
 * Generate forecast text for a specific day
 * @param {number} day - Day of month (1-31)
 * @param {string|undefined} timezone - Timezone abbreviation (undefined = server local timezone)
 * @returns {Promise<string>} Forecast text
 */
async function generateForecastText(day, timezone) {
    try {
        logger.debug(`[ChatBot] Generating forecast for day ${day}${timezone ? ` in ${timezone}` : ' (server timezone)'}`);

        // Use the existing forecast API endpoint (includes event discounts, formatting, etc.)
        const axios = require('axios');
        const { getSessionCookie } = require('../config');

        // Build query parameters
        const params = new URLSearchParams({
            source: 'chatbot',
            day: day.toString()
        });

        if (timezone) {
            params.append('timezone', timezone);
        }

        // Call internal API endpoint
        const response = await axios.get(`https://localhost:12345/api/forecast?${params.toString()}`, {
            headers: {
                'Cookie': `shipping_manager_session=${getSessionCookie()}`
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });

        const forecastText = response.data;

        logger.debug(`[ChatBot] Forecast generated successfully for day ${day}`);
        return forecastText;

    } catch (error) {
        logger.error('[ChatBot] Error generating forecast:', error.message);
        logger.debug('[ChatBot] Full error:', error);
        // Return empty response on error - no error messages to users
        return '';
    }
}

/**
 * Handle help command
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 * @param {object} settings - ChatBot settings object
 * @param {Function} sendResponseFn - Function to send response
 */
async function handleHelpCommand(userId, userName, config, isDM, settings, sendResponseFn) {
    const prefix = settings.commandPrefix || '!';

    let helpText = '🤖 Available Commands\n\n';

    // Built-in commands
    if (settings.commands.forecast?.enabled) {
        helpText += `👉 Get fuel and CO₂ price forecast\n\n`;
        helpText += `${prefix}forecast [day] [timezone]\n`;
        helpText += `• day: 1-31 (default: tomorrow)\n`;
        helpText += `• timezone: (default: server timezone)\n\n`;
        helpText += `💡 Examples\n`;
        helpText += `• ${prefix}forecast 26 UTC\n`;
        helpText += `• ${prefix}forecast 15\n`;
        helpText += `• ${prefix}forecast\n\n`;
        helpText += `⁉️ Supported timezones:\n`;
        helpText += `PST, PDT, MST, MDT, CST, CDT, EST, EDT, GMT, BST, WET, WEST, CET, CEST, EET, EEST, JST, KST, IST, AEST, AEDT, ACST, ACDT, AWST, NZST, NZDT, UTC\n\n`;
    }

    if (settings.commands.help?.enabled) {
        helpText += `👉 Show help\n\n`;
        helpText += `${prefix}help\n\n`;
    }

    if (settings.commands.welcome?.enabled) {
        helpText += `👉 Send welcome message\n\n`;
        helpText += `${prefix}welcome @Username\n`;
        helpText += `Type @Username in chat (converts to [UserID])\n`;
        helpText += `⚠️ Admin only: CEO, COO, Management, Interim CEO\n\n`;
    }

    // Custom commands
    for (const cmd of settings.customCommands || []) {
        if (cmd.enabled) {
            helpText += `👉 ${cmd.description || 'Custom command'}\n\n`;
            helpText += `${prefix}${cmd.trigger}`;
            if (cmd.adminOnly) {
                helpText += ' (admin only)';
            }
            helpText += '\n\n';
        }
    }

    helpText += `Response times may vary up to 15 seconds - keep calm :)`;

    await sendResponseFn(helpText, config.responseType || 'public', userId, isDM);
}

/**
 * Handle welcome command - sends welcome message to a specific user
 * Only usable by management members (CEO, COO, Management, Interim CEO)
 * @param {Array<string>} args - Command arguments [targetUserId]
 * @param {string} userName - User name of command caller
 */
async function handleWelcomeCommand(args, userName) {
    // This command only works for the bot owner (management check is done by adminOnly flag)
    let targetUserId = args[0];

    if (!targetUserId) {
        logger.error('[ChatBot] Welcome command missing user ID argument');
        return;
    }

    // Strip brackets if present (game chat wraps numbers in brackets)
    if (/^\[\d+\]$/.test(targetUserId)) {
        targetUserId = targetUserId.slice(1, -1); // Remove [ and ]
    }

    // Validate user ID is numeric
    if (!/^\d+$/.test(targetUserId)) {
        logger.error(`[ChatBot] Welcome command invalid user ID: ${targetUserId}`);
        return;
    }

    try {
        // Load welcome message from bot owner's settings
        const botOwnerId = getUserId();
        const settingsPath = getSettingsFilePath(botOwnerId);
        const data = await fs.readFile(settingsPath, 'utf8');
        const settings = JSON.parse(data);

        // Get alliance name for variable replacement
        const allianceName = getAllianceName() || 'our Alliance';

        // Load subject and message from settings
        let welcomeSubject = settings.allianceWelcomeSubject ||
            'Welcome to [allianceName]';
        let welcomeMessage = settings.allianceWelcomeMessage ||
            'Welcome to our Alliance!\nJoin the Ally Chat and say Hello :)';

        // Replace [allianceName] variable in subject and message
        welcomeSubject = welcomeSubject.replace(/\[allianceName\]/g, allianceName);
        welcomeMessage = welcomeMessage.replace(/\[allianceName\]/g, allianceName);

        // Send welcome message as DM to target user with custom subject
        // Use dynamic require to avoid circular dependency
        const { sendPrivateMessage } = require('./sender');
        await sendPrivateMessage(targetUserId, welcomeSubject, welcomeMessage);

        logger.debug(`[ChatBot] Welcome message sent to user ${targetUserId} by ${userName}`);
    } catch (error) {
        logger.error('[ChatBot] Error sending welcome message:', error);
    }
}

module.exports = {
    handleForecastCommand,
    generateForecastText,
    handleHelpCommand,
    handleWelcomeCommand
};
