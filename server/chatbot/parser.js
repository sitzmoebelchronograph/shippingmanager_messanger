/**
 * @fileoverview ChatBot Message Parser Module
 *
 * Parses incoming alliance chat and private messages for commands.
 * Handles command resolution, cooldowns, validation, and execution routing.
 *
 * @module server/chatbot/parser
 */

const { getUserId, apiCall } = require('../utils/api');
const { getSettingsFilePath } = require('../settings-schema');
const logger = require('../utils/logger');

/**
 * Check if user has management role in alliance (CEO, COO, Management, Interim CEO)
 * @param {number} userId - User ID to check
 * @returns {Promise<boolean>} True if user has management role
 */
async function hasManagementRole(userId) {
    try {
        const response = await apiCall('/alliance/get-alliance-members', 'POST', {});
        const members = response?.data?.members || response?.members || [];
        const member = members.find(m => m.user_id === userId);
        const role = member?.role || 'member';
        const allowedRoles = ['ceo', 'coo', 'management', 'interimceo'];
        return allowedRoles.includes(role);
    } catch (error) {
        logger.error('[ChatBot] Error checking management role:', error);
        return false; // Fail-secure: deny access on error
    }
}

/**
 * Resolve command name from input (including aliases)
 * @param {string} input - Command input string
 * @param {object} settings - ChatBot settings
 * @returns {string|null} - Resolved command name or null if not found
 */
function resolveCommandName(input, settings) {
    const commandLower = input.toLowerCase();

    // Check exact match first
    if (settings.commands[commandLower]) {
        return commandLower;
    }

    // Check aliases
    for (const [cmdName, cmdConfig] of Object.entries(settings.commands)) {
        if (cmdConfig.aliases && cmdConfig.aliases.includes(commandLower)) {
            return cmdName;
        }
    }

    // Check custom commands
    return null;
}

/**
 * Find custom command by trigger
 * @param {string} trigger - Command trigger string
 * @param {object} settings - ChatBot settings
 * @returns {object|undefined} Custom command object or undefined
 */
function findCustomCommand(trigger, settings) {
    return settings.customCommands?.find(cmd =>
        cmd.trigger.toLowerCase() === trigger.toLowerCase()
    );
}

/**
 * Check if command is on cooldown
 * @param {string} userId - User ID
 * @param {string} command - Command name
 * @param {Map} lastCommandTime - Map of user cooldowns (userId -> { command -> timestamp })
 * @param {object} settings - ChatBot settings
 * @returns {boolean} True if on cooldown
 */
function isOnCooldown(userId, command, lastCommandTime, settings) {
    const userCooldowns = lastCommandTime.get(userId);
    if (!userCooldowns) return false;

    const lastTime = userCooldowns[command];
    if (!lastTime) return false;

    const cooldownMs = (settings.allianceCommands?.cooldownSeconds || 30) * 1000;
    return Date.now() - lastTime < cooldownMs;
}

/**
 * Update cooldown for command
 * @param {string} userId - User ID
 * @param {string} command - Command name
 * @param {Map} lastCommandTime - Map of user cooldowns
 */
function updateCooldown(userId, command, lastCommandTime) {
    if (!lastCommandTime.has(userId)) {
        lastCommandTime.set(userId, {});
    }
    lastCommandTime.get(userId)[command] = Date.now();
}

/**
 * Validate command arguments
 * @param {string} command - Command name
 * @param {Array<string>} args - Command arguments
 * @returns {boolean} - True if arguments are valid
 */
function validateCommandArguments(command, args) {
    switch (command) {
        case 'forecast':
            return validateForecastArguments(args);

        case 'help':
            // Help command accepts no arguments
            return args.length === 0;

        case 'welcome':
            return validateWelcomeArguments(args);

        default:
            // Custom commands or unknown commands - accept any arguments
            return true;
    }
}

/**
 * Validate forecast command arguments
 * Valid formats:
 * - No args (default: tomorrow)
 * - 1 arg: day (number 1-31)
 * - 2 args: day (number 1-31) + timezone (valid timezone string)
 * @param {Array<string>} args - Command arguments
 * @returns {boolean} True if valid
 */
function validateForecastArguments(args) {
    // No arguments is valid (default: tomorrow)
    if (args.length === 0) {
        return true;
    }

    // 1 argument: must be a valid day number (1-31)
    if (args.length === 1) {
        const day = parseInt(args[0]);
        return !isNaN(day) && day >= 1 && day <= 31;
    }

    // 2 arguments: day (1-31) + timezone
    if (args.length === 2) {
        const day = parseInt(args[0]);
        const timezone = args[1].toUpperCase();

        // Validate day
        if (isNaN(day) || day < 1 || day > 31) {
            return false;
        }

        // Validate timezone
        const validTimezones = [
            'PST', 'PDT', 'MST', 'MDT', 'CST', 'CDT', 'EST', 'EDT',
            'GMT', 'BST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST',
            'JST', 'KST', 'IST',
            'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST',
            'NZST', 'NZDT',
            'UTC'
        ];

        return validTimezones.includes(timezone);
    }

    // More than 2 arguments is invalid
    return false;
}

/**
 * Validate welcome command arguments
 * Valid format: 1 arg (user ID as numeric string, optionally wrapped in brackets)
 * Game chat automatically wraps numbers in brackets
 * @param {Array<string>} args - Command arguments
 * @returns {boolean} True if valid
 */
function validateWelcomeArguments(args) {
    // Must have exactly 1 argument (user ID)
    if (args.length !== 1) {
        return false;
    }

    // User ID must be numeric, optionally wrapped in brackets [123456]
    const userId = args[0];
    // Match either plain number or number in brackets
    return /^\d+$/.test(userId) || /^\[\d+\]$/.test(userId);
}

/**
 * Check if a command is allowed in a specific channel (alliance or DM)
 * @param {string} command - Command name
 * @param {string} channel - Channel type ('alliance' or 'dm')
 * @returns {boolean} True if allowed
 */
function isCommandAllowedInChannel(command, channel) {
    try {
        const userId = getUserId();
        if (!userId) {
            return channel === 'alliance';
        }

        const settingsPath = getSettingsFilePath(userId);
        // Read current settings to get latest values
        const data = require('fs').readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(data);

        // Build setting key based on command and channel
        // e.g., chatbotForecastAllianceEnabled or chatbotForecastDMEnabled
        const capitalizedCommand = command.charAt(0).toUpperCase() + command.slice(1);
        const channelType = channel === 'dm' ? 'DM' : 'Alliance';
        const settingKey = `chatbot${capitalizedCommand}${channelType}Enabled`;

        // Check if setting exists and return its value
        if (settingKey in settings) {
            return settings[settingKey];
        }

        // Default behavior if setting doesn't exist
        // Allow in alliance by default, block in DM by default
        return channel === 'alliance';
    } catch (error) {
        logger.error('[ChatBot] Error checking command channel permission:', error);
        // On error, allow in alliance, block in DM
        return channel === 'alliance';
    }
}

/**
 * Process alliance chat message for commands
 * @param {string} message - Message content
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} chatbotInstance - ChatBot instance (for settings, lastCommandTime, executeCommand)
 */
async function processAllianceMessage(message, userId, userName, chatbotInstance) {
    const { settings, lastCommandTime, executeCommandFn } = chatbotInstance;

    if (!settings?.enabled) {
        return;
    }

    if (!settings?.allianceCommands?.enabled) {
        return;
    }

    // Check if message starts with command prefix
    const prefix = settings.commandPrefix || '!';
    if (!message.startsWith(prefix)) {
        // Not a command, ignore silently
        return;
    }

    // Parse command
    const parts = message.slice(prefix.length).trim().split(/\s+/);
    const commandInput = parts[0].toLowerCase();
    const args = parts.slice(1);

    logger.debug(`[ChatBot] Command from ${userName}: !${commandInput} ${args.join(' ')}`);

    // Resolve command name (including aliases)
    const command = resolveCommandName(commandInput, settings);
    if (!command) {
        // Check custom commands as fallback
        const customCmd = findCustomCommand(commandInput, settings);
        if (!customCmd || !customCmd.enabled) {
            return; // Ignore unknown or disabled commands
        }
        // Custom command handling would go here
        return;
    }

    // Get command config
    const cmdConfig = settings.commands[command];
    if (!cmdConfig || !cmdConfig.enabled) {
        return; // Ignore disabled commands
    }

    // Check if command is allowed in alliance chat based on settings
    const isAllianceAllowed = isCommandAllowedInChannel(command, 'alliance');
    if (!isAllianceAllowed) {
        logger.debug(`[ChatBot] Command '${command}' not allowed in alliance chat per settings`);
        return;
    }

    // Validate arguments BEFORE executing command
    if (!validateCommandArguments(command, args)) {
        logger.debug(`[ChatBot] Invalid arguments for command '${command}': [${args.join(', ')}]`);
        return;
    }

    // Check admin permission (for commands like welcome that require management role)
    if (cmdConfig.adminOnly) {
        const isManagement = await hasManagementRole(userId);
        if (!isManagement) {
            logger.debug(`[ChatBot] User ${userId} tried admin command ${command} without management role`);
            return;
        }
    }

    // Check cooldown
    if (isOnCooldown(userId, command, lastCommandTime, settings)) {
        logger.debug(`[ChatBot] Command ${command} on cooldown for user ${userId}`);
        return;
    }

    // Execute command
    try {
        await executeCommandFn(command, args, userId, userName, cmdConfig, false);
        updateCooldown(userId, command, lastCommandTime);
    } catch (error) {
        logger.error(`[ChatBot] Error executing command ${command}:`, error);
        // Errors ONLY go to console - no messages to users!
    }
}

/**
 * Process private message for auto-reply
 * Subject is ignored - only message body is parsed for commands
 * @param {string} messageId - Message ID
 * @param {string} body - Message body
 * @param {string} senderId - Sender user ID
 * @param {string} senderName - Sender name
 * @param {object} chatbotInstance - ChatBot instance
 * @returns {Promise<boolean>} True if message was processed
 */
async function processPrivateMessage(messageId, body, senderId, senderName, chatbotInstance) {
    const { settings, processedMessages, executeCommandFn } = chatbotInstance;

    if (!settings?.enabled || !settings?.dmCommands?.enabled) {
        logger.debug(`[ChatBot] DM processing disabled - enabled:${settings?.enabled} dmCommands:${settings?.dmCommands?.enabled}`);
        return false;
    }

    // Check if already processed
    if (processedMessages.has(messageId)) {
        return false;
    }

    // IMPORTANT: Parse command from message BODY only (subject is ignored)
    // In DMs, prefix is OPTIONAL (e.g., "forecast 2 GMT" or "!forecast 2 GMT")
    const prefix = settings.commandPrefix || '!';
    const bodyTrimmed = body.trim();

    logger.debug(`[ChatBot] Processing DM body: "${bodyTrimmed}"`);

    // Try with prefix first, then without
    let commandText;
    if (bodyTrimmed.startsWith(prefix)) {
        // Has prefix: "!forecast 2 GMT"
        commandText = bodyTrimmed.slice(prefix.length).trim();
    } else {
        // No prefix: "forecast 2 GMT"
        commandText = bodyTrimmed;
    }

    const parts = commandText.split(/\s+/);
    const commandInput = parts[0].toLowerCase();
    const args = parts.slice(1);

    logger.debug(`[ChatBot] Parsed command:"${commandInput}" args:[${args.join(', ')}]`);

    // Resolve command name (including aliases)
    const command = resolveCommandName(commandInput, settings);
    if (!command) {
        logger.debug(`[ChatBot] Command not resolved: "${commandInput}"`);
        // Check custom commands as fallback
        const customCmd = findCustomCommand(commandInput, settings);
        if (!customCmd || !customCmd.enabled) {
            return false; // Not a valid command
        }
        // Custom command handling would go here
        return false;
    }

    logger.debug(`[ChatBot] Resolved command: "${command}"`);

    // Get command config
    const cmdConfig = settings.commands[command];
    if (!cmdConfig || !cmdConfig.enabled) {
        logger.debug(`[ChatBot] Command "${command}" not enabled in config`);
        return false;
    }

    // Check if command is allowed in DMs based on settings
    const isDMAllowed = isCommandAllowedInChannel(command, 'dm');
    if (!isDMAllowed) {
        logger.debug(`[ChatBot] Command "${command}" not allowed in DMs`);
        return false;
    }

    // Validate arguments BEFORE executing command
    if (!validateCommandArguments(command, args)) {
        logger.debug(`[ChatBot] Invalid arguments for DM command '${command}': [${args.join(', ')}]`);
        return false;
    }

    logger.debug(`[ChatBot] DM command from ${senderName}: !${command}`);

    // Mark as processed
    processedMessages.add(messageId);

    // Execute command
    try {
        await executeCommandFn(command, args, senderId, senderName, cmdConfig, true);

        return true;
    } catch (error) {
        logger.error(`[ChatBot] Error processing DM command ${command}:`, error);
        // Errors ONLY go to console - no messages to users!
        return true; // Still mark as processed
    }
}

module.exports = {
    processAllianceMessage,
    processPrivateMessage,
    resolveCommandName,
    findCustomCommand,
    isOnCooldown,
    updateCooldown,
    validateCommandArguments,
    validateForecastArguments,
    validateWelcomeArguments,
    isCommandAllowedInChannel
};
