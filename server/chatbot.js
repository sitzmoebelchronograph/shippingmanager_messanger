/**
 * @fileoverview Chat Bot System
 *
 * Main orchestrator for ChatBot functionality.
 * Delegates to specialized modules for settings, parsing, commands, and scheduling.
 *
 * Features:
 * - Command parsing and execution
 * - Private message auto-reply
 * - Scheduled message sending
 * - Custom command management
 * - Rate limiting and cooldowns
 *
 * @module server/chatbot
 */

const settingsManager = require('./chatbot/settings');
const messageParser = require('./chatbot/parser');
const commandExecutor = require('./chatbot/executor');
const commandHandlers = require('./chatbot/commands');
const messageSender = require('./chatbot/sender');
const scheduler = require('./chatbot/scheduler');
const logger = require('./utils/logger');

/**
 * ChatBot class handles all bot functionality
 * Orchestrates all chatbot modules
 */
class ChatBot {
    constructor() {
        this.settings = null;
        this.lastCommandTime = new Map(); // userId -> { command -> timestamp }
        this.processedMessages = new Set(); // Track processed DMs to avoid duplicates
        this.scheduledTasks = new Map(); // taskId -> timeout
        this.initialized = false;
    }

    /**
     * Initialize the chat bot with settings
     */
    async initialize() {
        try {
            this.settings = await settingsManager.loadSettings();
            this.setupScheduledTasks();
            this.initialized = true;
            logger.debug('[ChatBot] Initialized successfully');
        } catch (error) {
            logger.error('[ChatBot] Failed to initialize:', error);
        }
    }

    /**
     * Setup scheduled tasks
     * Delegates to scheduler module
     */
    setupScheduledTasks() {
        // Pass scheduler callbacks for generateForecastText and sendAllianceMessage
        const callbacks = {
            generateForecastText: commandHandlers.generateForecastText,
            sendAllianceMessage: messageSender.sendAllianceMessage
        };

        scheduler.setupScheduledTasks(this.settings, this.scheduledTasks, callbacks);
    }

    /**
     * Execute a command
     * Internal wrapper that provides all necessary handlers and settings to executor
     * @private
     */
    async executeCommand(command, args, userId, userName, config, isDM) {
        // Build handlers object with all command handlers and sender
        const handlers = {
            handleForecastCommand: commandHandlers.handleForecastCommand,
            handleHelpCommand: commandHandlers.handleHelpCommand,
            handleWelcomeCommand: commandHandlers.handleWelcomeCommand,
            sendResponse: messageSender.sendResponse
        };

        // Delegate to executor
        await commandExecutor.executeCommand(
            command,
            args,
            userId,
            userName,
            config,
            isDM,
            handlers,
            this.settings
        );
    }

    /**
     * Process alliance chat message for commands
     * Delegates to parser module
     * @param {string} message - Message content
     * @param {string} userId - User ID
     * @param {string} userName - User name
     */
    async processAllianceMessage(message, userId, userName) {
        // Build chatbot instance data for parser
        const chatbotInstance = {
            settings: this.settings,
            lastCommandTime: this.lastCommandTime,
            executeCommandFn: this.executeCommand.bind(this)
        };

        await messageParser.processAllianceMessage(message, userId, userName, chatbotInstance);
    }

    /**
     * Process private message for auto-reply
     * Delegates to parser module
     * @param {string} messageId - Message ID
     * @param {string} body - Message body
     * @param {string} senderId - Sender user ID
     * @param {string} senderName - Sender name
     * @returns {Promise<boolean>} True if message was processed
     */
    async processPrivateMessage(messageId, body, senderId, senderName) {
        // Build chatbot instance data for parser
        const chatbotInstance = {
            settings: this.settings,
            processedMessages: this.processedMessages,
            executeCommandFn: this.executeCommand.bind(this)
        };

        return await messageParser.processPrivateMessage(
            messageId,
            body,
            senderId,
            senderName,
            chatbotInstance
        );
    }

    /**
     * Update settings from frontend
     * Delegates to settings manager and restarts scheduled tasks
     * @param {object} newSettings - New ChatBot settings (partial or full)
     */
    async updateSettings(newSettings) {
        // Update settings via settings manager
        this.settings = await settingsManager.updateSettings(newSettings, this.settings);

        // Restart scheduled tasks with new settings
        this.setupScheduledTasks();
    }
}

// Create singleton instance
const chatBot = new ChatBot();

module.exports = chatBot;
