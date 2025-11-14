/**
 * @fileoverview Cross-Platform Encryption Utility
 *
 * Provides secure storage for sensitive data using OS-native credential storage:
 * - Windows: DPAPI (Data Protection API)
 * - macOS: Keychain
 * - Linux: libsecret (Secret Service API)
 *
 * Uses 'keytar' package which abstracts the platform-specific implementations.
 *
 * Security Features:
 * - Data is encrypted with OS user account credentials
 * - Only the same user on the same machine can decrypt
 * - No master password needed (uses OS authentication)
 * - If file is copied to another machine, data is useless
 *
 * Known Issues & Workarounds:
 * - Python/Node.js keyring incompatibility on Windows: Python's keyring library stores
 *   credentials as UTF-16, creating null bytes between characters when read by Node.js
 *   keytar (which expects UTF-8). The decryptData() function includes automatic detection
 *   and removal of these null bytes. This affects sessions saved by Python (browser login)
 *   but not sessions saved differently (Steam login).
 *
 * @module server/utils/encryption
 */

const os = require('os');
const crypto = require('crypto');
const logger = require('./logger');

// Try to load keytar - it might not be available on all systems
let keytar;
try {
    keytar = require('keytar');
    logger.debug('[Encryption] Using native OS credential storage (keytar)');
} catch {
    logger.warn('[Encryption] keytar not available, falling back to local encryption');
    keytar = null;
}

/**
 * Service name used for keytar credential storage
 * @constant {string}
 */
const SERVICE_NAME = 'ShippingManagerCoPilot';

/**
 * Algorithm used for fallback encryption when keytar is unavailable
 * @constant {string}
 */
const FALLBACK_ALGORITHM = 'aes-256-gcm';

/**
 * Get or create a machine-specific encryption key (fallback mode only)
 * This is less secure than OS keyring but better than plaintext
 *
 * @returns {Buffer} 32-byte encryption key
 */
function getMachineKey() {
    // Use machine-specific identifiers to derive a key
    const machineId = os.hostname() + os.userInfo().username + os.platform();
    return crypto.createHash('sha256').update(machineId).digest();
}

/**
 * Encrypt sensitive data using OS-native credential storage or fallback
 *
 * @param {string} data - Data to encrypt (will be converted to string if not already)
 * @param {string} accountName - Unique identifier for this data (e.g., 'session_1234567')
 * @returns {Promise<string>} Encrypted data as base64 string
 *
 * @example
 * const encrypted = await encryptData('my-secret-cookie', 'session_12345');
 * // Returns: "ENCRYPTED:base64data..." or "v1:iv:authTag:encrypted"
 */
async function encryptData(data, accountName) {
    const dataString = String(data);

    // Try to use OS keyring first (most secure)
    if (keytar) {
        try {
            // Store in OS credential manager
            await keytar.setPassword(SERVICE_NAME, accountName, dataString);

            // Return a marker that indicates data is in keyring
            return `KEYRING:${accountName}`;
        } catch (error) {
            logger.warn(`[Encryption] Failed to use keyring, falling back: ${error.message}`);
            // Fall through to fallback encryption
        }
    }

    // Fallback: AES-256-GCM encryption with machine-specific key
    try {
        const key = getMachineKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(FALLBACK_ALGORITHM, key, iv);

        let encrypted = cipher.update(dataString, 'utf8', 'base64');
        encrypted += cipher.final('base64');

        const authTag = cipher.getAuthTag().toString('base64');

        // Format: version:iv:authTag:encryptedData
        return `v1:${iv.toString('base64')}:${authTag}:${encrypted}`;
    } catch (error) {
        logger.error('[Encryption] Fallback encryption failed:', error);
        throw new Error('Failed to encrypt data');
    }
}

/**
 * Decrypt data that was encrypted with encryptData()
 *
 * Handles three storage formats:
 * 1. OS keyring (KEYRING:account_name) - Most secure, uses Windows DPAPI/macOS Keychain/Linux libsecret
 * 2. Fallback encryption (v1:iv:authTag:data) - AES-256-GCM when keyring unavailable
 * 3. Plaintext (legacy) - For migration from older versions
 *
 * IMPORTANT: This function includes a workaround for Python/Node.js keyring incompatibility.
 * Python's keyring library stores credentials as UTF-16 on Windows, which creates null bytes (0x00)
 * between each character when read by Node.js's keytar library (which expects UTF-8).
 * Example: "eyJpdiI6..." becomes "e\0y\0J\0p\0d\0i\0..." (680 chars instead of 340)
 *
 * The workaround:
 * - Uses findCredentials() instead of getPassword() (which returns null for UTF-16 entries)
 * - Detects UTF-16 encoding by checking for null bytes at every 2nd position
 * - Removes null bytes by filtering to even-indexed characters only
 *
 * This affects browser sessions saved by Python but not Steam sessions (saved differently).
 *
 * @param {string} encryptedData - Encrypted data string from encryptData()
 * @returns {Promise<string|null>} Decrypted data or null if decryption fails
 *
 * @example
 * const decrypted = await decryptData('KEYRING:session_12345');
 * // Returns: 'my-secret-cookie' or null
 *
 * @example
 * // UTF-16 workaround automatically applied:
 * // Input from keyring: "e\0y\0J\0..." (680 chars with null bytes)
 * // Output: "eyJ..." (340 chars, null bytes removed)
 */
async function decryptData(encryptedData) {
    if (!encryptedData) {
        return null;
    }

    // Check if data is in OS keyring
    if (encryptedData.startsWith('KEYRING:')) {
        if (keytar) {
            try {
                const storedAccountName = encryptedData.substring(8); // Remove "KEYRING:" prefix

                // WORKAROUND for Python/Node.js keyring incompatibility:
                // Use findCredentials() instead of getPassword() because getPassword() returns null
                // for UTF-16 encoded entries stored by Python's keyring library.
                // This happens because Python stores as UTF-16 on Windows while Node.js keytar expects UTF-8.
                const credentials = await keytar.findCredentials(SERVICE_NAME);
                const credential = credentials.find(c => c.account === storedAccountName);

                if (!credential) {
                    logger.error(`[Encryption] Credential not found for ${storedAccountName}`);
                    return null;
                }

                let password = credential.password;

                // WORKAROUND: Fix Python's UTF-16 encoding (creates null bytes between characters)
                // Python's keyring stores "eyJpdiI6..." as "e\0y\0J\0p\0d\0i\0..." (UTF-16 LE)
                // This doubles the length: 340 chars → 680 chars with null bytes at every odd index
                // Detection: Check if every 2nd character (index 1, 3, 5...) is 0x00
                if (password && password.length > 300 && password.length % 2 === 0) {
                    // Sample first 20 characters to check for UTF-16 pattern
                    let hasNullBytes = true;
                    for (let i = 1; i < Math.min(20, password.length); i += 2) {
                        if (password.charCodeAt(i) !== 0) {
                            hasNullBytes = false;
                            break;
                        }
                    }

                    if (hasNullBytes) {
                        // Remove null bytes: keep only even-indexed characters (0, 2, 4, 6...)
                        // Example: "e\0y\0J\0" -> "eyJ"
                        const fixed = password.split('').filter((_, i) => i % 2 === 0).join('');
                        logger.warn(`[Encryption] Fixed Python UTF-16 encoding issue (${password.length} to ${fixed.length} chars)`);
                        password = fixed;
                    }
                }
                return password;
            } catch (error) {
                logger.error(`[Encryption] Failed to retrieve from keyring: ${error.message}`);
                return null;
            }
        } else {
            logger.error('[Encryption] Data is in keyring but keytar not available');
            return null;
        }
    }

    // Check if data is fallback-encrypted
    if (encryptedData.startsWith('v1:')) {
        try {
            const parts = encryptedData.split(':');
            if (parts.length !== 4) {
                throw new Error('Invalid encrypted data format');
            }

            const [, ivBase64, authTagBase64, encrypted] = parts;

            const key = getMachineKey();
            const iv = Buffer.from(ivBase64, 'base64');
            const authTag = Buffer.from(authTagBase64, 'base64');

            const decipher = crypto.createDecipheriv(FALLBACK_ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);

            let decrypted = decipher.update(encrypted, 'base64', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (error) {
            logger.error('[Encryption] Fallback decryption failed:', error.message);
            return null;
        }
    }

    // If data doesn't start with known prefix, assume it's plaintext (for migration)
    logger.warn('[Encryption] Detected plaintext data (not encrypted)');
    return encryptedData;
}

/**
 * Check if data is encrypted
 *
 * @param {string} data - Data to check
 * @returns {boolean} True if data appears to be encrypted
 */
function isEncrypted(data) {
    if (!data || typeof data !== 'string') {
        return false;
    }
    return data.startsWith('KEYRING:') || data.startsWith('v1:');
}

/**
 * Delete encrypted data from OS keyring
 * Only works for keyring-stored data
 *
 * @param {string} accountName - Account name to delete
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteEncryptedData(accountName) {
    if (keytar) {
        try {
            return await keytar.deletePassword(SERVICE_NAME, accountName);
        } catch (error) {
            logger.error(`[Encryption] Failed to delete from keyring: ${error.message}`);
            return false;
        }
    }
    return false;
}

/**
 * Get information about the encryption system
 *
 * @returns {Object} System information
 */
function getEncryptionInfo() {
    return {
        platform: os.platform(),
        usingKeyring: !!keytar,
        backend: keytar ? (
            os.platform() === 'win32' ? 'Windows DPAPI' :
            os.platform() === 'darwin' ? 'macOS Keychain' :
            'Linux libsecret'
        ) : 'Fallback AES-256-GCM',
        secure: !!keytar
    };
}

module.exports = {
    encryptData,
    decryptData,
    isEncrypted,
    deleteEncryptedData,
    getEncryptionInfo
};
