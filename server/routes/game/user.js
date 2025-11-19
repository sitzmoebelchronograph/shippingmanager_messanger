/**
 * @fileoverview User, Port, Game and Version Routes
 *
 * This module provides endpoints for user settings, company data, port information,
 * game index data, and version checking against GitHub releases.
 *
 * Key Features:
 * - User company and settings retrieval
 * - Company type caching for offline access
 * - Assigned ports data for capacity calculations
 * - Game index endpoint proxy
 * - Version update checking with GitHub API
 *
 * @requires express - Router and middleware
 * @requires fs - File system operations (promises)
 * @requires axios - HTTP client for GitHub API
 * @requires ../../utils/api - API helper functions
 * @requires ../../settings-schema - Settings file path utilities
 * @requires ../../utils/logger - Logging utility
 * @module server/routes/game/user
 */

const express = require('express');
const fs = require('fs').promises;
const { apiCall, getUserId } = require('../../utils/api');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * POST /api/user/get-company
 * Returns user company data including capacity values
 * Can fetch own company (no user_id) or another player's company (with user_id)
 *
 * @route POST /api/user/get-company
 * @param {number} [req.body.user_id] - Optional user ID to fetch (omit for own company)
 *
 * @returns {object} Company data including:
 *   - Company details
 *   - Capacity values
 *   - User statistics
 *
 * @error 500 - Failed to fetch company data
 */
router.post('/get-company', express.json(), async (req, res) => {
  try {
    const { user_id } = req.body;
    const requestBody = user_id ? { user_id } : {};
    const data = await apiCall('/user/get-company', 'POST', requestBody);
    res.json(data);
  } catch (error) {
    logger.error('Error fetching company data:', error);
    res.status(500).json({ error: 'Failed to fetch company data' });
  }
});

/**
 * POST /api/staff/get-user-staff
 * Returns staff information including morale, salaries, and training perks
 *
 * @route POST /api/staff/get-user-staff
 *
 * @returns {object} Staff data including:
 *   - data.info: Crew and management morale summary
 *   - data.staff: Array of staff types with salaries, training, etc.
 *   - user: Current user data
 *
 * @error 500 - Failed to fetch staff data
 */
router.post('/staff/get-user-staff', async (req, res) => {
  try {
    const data = await apiCall('/staff/get-user-staff', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching staff data:', error);
    res.status(500).json({ error: 'Failed to fetch staff data' });
  }
});

/**
 * GET /api/user/get-settings
 * Retrieves user settings including anchor points (used for auto-rebuy calculations)
 * Also caches company_type in local settings for offline access
 *
 * @route GET /api/user/get-settings
 *
 * @returns {object} User settings including:
 *   - Anchor points configuration
 *   - Company type
 *   - Other user preferences
 *
 * @error 500 - Failed to retrieve user settings
 *
 * Side effects:
 * - Caches company_type to local settings file for offline access
 */
router.get('/get-settings', async (req, res) => {
  try {
    const data = await apiCall('/user/get-user-settings', 'GET', {});

    // Cache company_type in local settings for offline access
    const userId = getUserId();
    if (userId && data.user?.company_type) {
      try {
        const { getSettingsFilePath } = require('../../settings-schema');
        const settingsFile = getSettingsFilePath(userId);

        // Read current settings
        const settingsData = await fs.readFile(settingsFile, 'utf8');
        const settings = JSON.parse(settingsData);

        // Update company_type
        settings.company_type = data.user.company_type;

        // Write back to file
        await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

        logger.debug(`[User Settings] Cached company_type: ${JSON.stringify(data.user.company_type)}`);
      } catch (cacheError) {
        // Don't fail the request if caching fails
        logger.warn('[User Settings] Failed to cache company_type:', cacheError.message);
      }
    }

    res.json(data);
  } catch (error) {
    logger.error('Error getting user settings:', error);
    res.status(500).json({ error: 'Failed to retrieve user settings' });
  }
});

/**
 * GET /api/port/get-assigned-ports
 * Retrieves demand and consumed data for all assigned ports
 *
 * Used by intelligent auto-depart to calculate remaining port capacity.
 * Returns port demand/consumed for both container and tanker cargo types.
 *
 * @route GET /api/port/get-assigned-ports
 *
 * @returns {object} Port data:
 *   - data.ports {array} - Array of port objects with demand/consumed data
 *
 * @error 500 - Failed to fetch assigned ports
 */
router.get('/port/get-assigned-ports', async (req, res) => {
  try {
    const data = await apiCall('/port/get-assigned-ports', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error fetching assigned ports:', error);
    res.status(500).json({ error: 'Failed to fetch assigned ports' });
  }
});

/**
 * POST /api/game/index
 * Proxies /game/index endpoint from game API
 *
 * Central game state endpoint that returns comprehensive game data.
 *
 * @route POST /api/game/index
 *
 * @returns {object} Complete game state data
 *
 * @error 500 - Failed to fetch game index data
 */
router.post('/game/index', async (req, res) => {
  try {
    const data = await apiCall('/game/index', 'POST', {});
    res.json(data);
  } catch (error) {
    logger.error('Error calling /game/index:', error);
    res.status(500).json({ error: 'Failed to fetch game index data' });
  }
});

/**
 * Version check cache variables
 * Caches GitHub API results for 15 minutes to avoid rate limits
 */
let versionCheckCache = null;
let versionCheckCacheTime = 0;
const VERSION_CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

/**
 * GET /api/version/check
 * Check for updates from GitHub
 *
 * Fetches latest release from GitHub and compares with current version.
 * Caches result for 15 minutes to avoid hitting GitHub API rate limits.
 *
 * @route GET /api/version/check
 *
 * @returns {object} Version information:
 *   - currentVersion {string} - Current app version
 *   - latestVersion {string} - Latest available version
 *   - updateAvailable {boolean} - Whether an update is available
 *   - downloadUrl {string} - Direct download URL for installer
 *   - releaseUrl {string} - GitHub release page URL
 *   - releaseName {string} - Name of the release
 *   - releaseNotes {string} - Release notes/changelog
 *
 * @error Returns current version with error flag if GitHub check fails
 */
router.get('/version/check', async (req, res) => {
  try {
    // Check if cache is still valid
    const now = Date.now();
    if (versionCheckCache && (now - versionCheckCacheTime) < VERSION_CACHE_DURATION) {
      return res.json(versionCheckCache);
    }

    // Read current version from package.json
    // Use require() instead of fs.readFile() - works in both dev and pkg
    const packageJson = require('../../../package.json');
    const currentVersion = packageJson.version;

    // Fetch latest release from GitHub
    const axios = require('axios');
    const githubResponse = await axios.get(
      'https://api.github.com/repos/sitzmoebelchronograph/shippingmanager_copilot/releases/latest',
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'ShippingManager-CoPilot'
        },
        timeout: 5000
      }
    );

    const latestRelease = githubResponse.data;
    const latestVersion = latestRelease.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

    // Find the installer asset (usually .exe or .zip)
    const installerAsset = latestRelease.assets.find(asset =>
      asset.name.includes('Setup') || asset.name.endsWith('.exe') || asset.name.endsWith('.zip')
    );

    // Compare versions
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    const result = {
      currentVersion,
      latestVersion,
      updateAvailable,
      downloadUrl: installerAsset ? installerAsset.browser_download_url : latestRelease.html_url,
      releaseUrl: latestRelease.html_url,
      releaseName: latestRelease.name,
      releaseNotes: latestRelease.body
    };

    // Cache the result
    versionCheckCache = result;
    versionCheckCacheTime = now;

    res.json(result);
  } catch (error) {
    logger.error('Error checking version:', error);

    // Return current version even if GitHub check fails
    try {
      const packageJson = require('../../../package.json');
      res.json({
        currentVersion: packageJson.version,
        latestVersion: packageJson.version,
        updateAvailable: false,
        error: 'Failed to check for updates'
      });
    } catch {
      res.status(500).json({ error: 'Failed to check version' });
    }
  }
});

/**
 * Compare two semantic version strings
 * @param {string} v1 - First version (e.g., "0.1.5.0")
 * @param {string} v2 - Second version (e.g., "0.1.4.3")
 * @returns {number} - 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

module.exports = router;