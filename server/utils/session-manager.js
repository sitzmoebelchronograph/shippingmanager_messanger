/**
 * @fileoverview Secure Session Manager
 *
 * Manages user sessions with encrypted storage of sensitive cookies.
 * Sessions are stored in sessions.json but cookies are encrypted using OS-native storage.
 *
 * Features:
 * - Automatic encryption of session cookies
 * - Platform-independent (Windows/macOS/Linux)
 * - Migration of old plaintext sessions
 * - Session validation
 *
 * @module server/utils/session-manager
 */

const fs = require('fs').promises;
const path = require('path');
const { encryptData, decryptData, isEncrypted } = require('./encryption');
const logger = require('./logger');

/**
 * Get sessions file path based on execution mode
 * @returns {string} Path to sessions.json
 */
function getSessionsPath() {
    const { getAppDataDir } = require('../config');
    const isPkg = !!process.pkg;
    console.log(`[DEBUG] getSessionsPath - process.pkg = ${isPkg}`);

    if (isPkg) {
        // Running as packaged .exe - use AppData
        const appDataPath = path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'settings', 'sessions.json');
        console.log(`[DEBUG] Using APPDATA sessions: ${appDataPath}`);
        return appDataPath;
    }
    // Running from source - use userdata
    const localPath = path.join(__dirname, '..', '..', 'userdata', 'settings', 'sessions.json');
    console.log(`[DEBUG] Using local sessions: ${localPath}`);
    return localPath;
}

/**
 * Path to sessions file (same for Python and Node.js now)
 * @constant {string}
 */
const SESSIONS_FILE = getSessionsPath();

/**
 * Load all sessions from file
 *
 * @returns {Promise<Object>} Sessions object with user IDs as keys
 */
async function loadSessions() {
    try {
        const data = await fs.readFile(SESSIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet
            return {};
        }
        logger.error('[SessionManager] Error loading sessions:', error);
        return {};
    }
}

/**
 * Load all available sessions (Python and Node.js now use same file)
 *
 * @returns {Promise<Object>} Sessions object
 */
async function loadAllSessions() {
    // Both Python and Node.js now use the same sessions.json
    return await loadSessions();
}

/**
 * Get all available sessions with decrypted cookies
 *
 * @returns {Promise<Array>} Array of {userId, cookie, companyName, loginMethod, timestamp}
 */
async function getAvailableSessions() {
    const sessions = await loadAllSessions();
    const available = [];

    for (const userId of Object.keys(sessions)) {
        try {
            const session = await getSession(userId);
            if (session && session.cookie) {
                available.push({
                    userId: userId,
                    cookie: session.cookie,
                    companyName: session.company_name || 'Unknown',
                    loginMethod: session.login_method || 'unknown',
                    timestamp: session.timestamp
                });
            }
        } catch (error) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${userId}:`, error);
        }
    }

    // Sort by timestamp (most recent first)
    available.sort((a, b) => b.timestamp - a.timestamp);

    return available;
}

/**
 * Save sessions to file
 *
 * @param {Object} sessions - Sessions object to save
 * @returns {Promise<void>}
 */
async function saveSessions(sessions) {
    try {
        // Ensure directory exists
        const dir = path.dirname(SESSIONS_FILE);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(
            SESSIONS_FILE,
            JSON.stringify(sessions, null, 2),
            'utf8'
        );
    } catch (error) {
        logger.error('[SessionManager] Error saving sessions:', error);
        throw error;
    }
}

/**
 * Get session for a specific user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<Object|null>} Session object with decrypted cookie, or null if not found
 */
async function getSession(userId) {
    const sessions = await loadAllSessions();  // Load from both locations
    const session = sessions[String(userId)];

    if (!session) {
        return null;
    }

    // Decrypt cookie if encrypted
    if (session.cookie && isEncrypted(session.cookie)) {
        const accountName = `session_${userId}`;
        const decryptedCookie = await decryptData(session.cookie, accountName);

        if (!decryptedCookie) {
            logger.error(`[SessionManager] Failed to decrypt session for user ${userId}`);
            return null;
        }

        return {
            ...session,
            cookie: decryptedCookie
        };
    }

    // Return as-is if not encrypted (for backward compatibility during migration)
    return session;
}

/**
 * Save or update session for a user
 *
 * @param {string|number} userId - User ID
 * @param {string} cookie - Session cookie (will be encrypted)
 * @param {string} companyName - Company name
 * @param {string} loginMethod - Login method used ('steam', 'firefox', 'chrome', etc.)
 * @returns {Promise<void>}
 */
async function saveSession(userId, cookie, companyName, loginMethod) {
    const sessions = await loadSessions();
    const accountName = `session_${userId}`;

    // Encrypt the cookie
    const encryptedCookie = await encryptData(cookie, accountName);

    // Store session with encrypted cookie
    sessions[String(userId)] = {
        cookie: encryptedCookie,
        timestamp: Math.floor(Date.now() / 1000),
        company_name: companyName,
        login_method: loginMethod
    };

    await saveSessions(sessions);

    logger.debug(`[SessionManager] Saved encrypted session for user ${userId} (${companyName})`);
}

/**
 * Delete session for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(userId) {
    const sessions = await loadSessions();

    if (!sessions[String(userId)]) {
        return false;
    }

    delete sessions[String(userId)];
    await saveSessions(sessions);

    logger.debug(`[SessionManager] Deleted session for user ${userId}`);
    return true;
}

/**
 * Get all user IDs that have sessions
 *
 * @returns {Promise<string[]>} Array of user IDs
 */
async function getAllUserIds() {
    const sessions = await loadAllSessions();  // Load from both locations
    return Object.keys(sessions);
}

/**
 * Migrate plaintext sessions to encrypted format
 * This should be called once during upgrade
 *
 * @returns {Promise<number>} Number of sessions migrated
 */
async function migrateToEncrypted() {
    logger.debug('[SessionManager] Starting session migration...');

    const sessions = await loadSessions();
    let migratedCount = 0;

    for (const [userId, session] of Object.entries(sessions)) {
        if (session.cookie && !isEncrypted(session.cookie)) {
            logger.debug(`[SessionManager] Migrating session for user ${userId}...`);

            const accountName = `session_${userId}`;
            const encryptedCookie = await encryptData(session.cookie, accountName);

            sessions[userId] = {
                ...session,
                cookie: encryptedCookie
            };

            migratedCount++;
        }
    }

    if (migratedCount > 0) {
        await saveSessions(sessions);
        logger.debug(`[SessionManager] OK Migrated ${migratedCount} session(s) to encrypted format`);
    } else {
        logger.debug('[SessionManager] No sessions needed migration');
    }

    return migratedCount;
}

/**
 * Check if a session exists for a user
 *
 * @param {string|number} userId - User ID
 * @returns {Promise<boolean>} True if session exists
 */
async function hasSession(userId) {
    const sessions = await loadAllSessions();  // Load from both locations
    return !!sessions[String(userId)];
}

module.exports = {
    getSession,
    saveSession,
    deleteSession,
    getAllUserIds,
    hasSession,
    migrateToEncrypted,
    getAvailableSessions
};
