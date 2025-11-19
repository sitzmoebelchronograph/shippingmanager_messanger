/**
 * @fileoverview ChatBot Command Executor Module
 *
 * Routes parsed commands to appropriate handlers.
 * Handles both built-in commands (forecast, help) and custom commands.
 *
 * @module server/chatbot/executor
 */

/**
 * Execute a command
 * @param {string} command - Command name
 * @param {Array<string>} args - Command arguments
 * @param {string} userId - User ID
 * @param {string} userName - User name
 * @param {object} config - Command configuration
 * @param {boolean} isDM - Whether command came from DM
 * @param {object} handlers - Command handler functions
 * @param {Function} handlers.handleForecastCommand - Forecast command handler
 * @param {Function} handlers.handleHelpCommand - Help command handler
 * @param {Function} handlers.handleWelcomeCommand - Welcome command handler
 * @param {Function} handlers.sendResponse - Response sender function
 * @param {object} settings - ChatBot settings (for help command)
 */
async function executeCommand(command, args, userId, userName, config, isDM, handlers, settings) {
    const { handleForecastCommand, handleHelpCommand, handleWelcomeCommand, sendResponse } = handlers;

    switch (command) {
        case 'forecast':
            await handleForecastCommand(args, userId, userName, config, isDM, sendResponse);
            break;

        case 'help':
            await handleHelpCommand(userId, userName, config, isDM, settings, sendResponse);
            break;

        case 'welcome':
            await handleWelcomeCommand(args, userName);
            break;

        default:
            // Custom command
            if (config.message) {
                await sendResponse(config.message, config.responseType, userId, isDM);
            }
            break;
    }
}

module.exports = {
    executeCommand
};
