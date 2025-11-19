/**
 * @fileoverview Alliance Indexer Service
 *
 * Indexes all alliances from the game API for search functionality.
 *
 * Features:
 * - File-based persistent cache (userdata/cache/alliance_pool.json)
 * - Fast startup by loading from cache file
 * - Background refresh cycle (all alliances over 1 hour)
 * - Search and filter capabilities
 * - WebSocket notification when ready
 *
 * @module server/services/alliance-indexer
 */

const { apiCall } = require('../utils/api');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

class AllianceIndexer {
  constructor() {
    this.isIndexing = false;
    this.isReady = false;
    this.lastUpdate = null;
    this.totalAlliances = 0;
    this.cacheFilePath = path.join(__dirname, '..', '..', 'userdata', 'cache', 'alliance_pool.json');

    // Background refresh settings
    this.refreshInterval = null;
    this.REFRESH_CYCLE_DURATION = 60 * 60 * 1000; // 1 hour
    this.PAGE_SIZE = 50;
    this.currentRefreshPage = 0;
  }

  /**
   * Start indexer (called from app.js)
   */
  async start() {
    logger.info('[AllianceIndexer] Starting...');

    try {
      await fs.access(this.cacheFilePath);
      logger.info('[AllianceIndexer] Cache file exists, loading from disk...');
      await this.loadFromCache();
      this.isReady = true;
      logger.info(`[AllianceIndexer] Loaded ${this.totalAlliances} alliances from cache`);
    } catch {
      logger.info('[AllianceIndexer] Cache file does not exist, building index...');
      await this.initialIndex();
    }

    this.startBackgroundRefresh();
  }

  /**
   * Load alliances from cache file
   */
  async loadFromCache() {
    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf8');
      const cache = JSON.parse(data);
      this.totalAlliances = cache.total || 0;
      this.lastUpdate = cache.lastUpdate;
      logger.info(`[AllianceIndexer] Cache loaded: ${this.totalAlliances} alliances, last update: ${this.lastUpdate}`);
    } catch (error) {
      logger.error('[AllianceIndexer] Failed to load cache:', error.message);
      throw error;
    }
  }

  /**
   * Save alliances to cache file
   */
  async saveToCache(alliances) {
    try {
      const dir = path.dirname(this.cacheFilePath);
      await fs.mkdir(dir, { recursive: true });

      const cache = {
        total: alliances.length,
        lastUpdate: new Date().toISOString(),
        alliances: alliances
      };

      await fs.writeFile(this.cacheFilePath, JSON.stringify(cache, null, 2), 'utf8');
      this.totalAlliances = alliances.length;
      this.lastUpdate = cache.lastUpdate;
      logger.info(`[AllianceIndexer] Cache saved: ${this.totalAlliances} alliances`);
    } catch (error) {
      logger.error('[AllianceIndexer] Failed to save cache:', error.message);
      throw error;
    }
  }

  /**
   * Initial indexing with auto-retry
   */
  async initialIndex() {
    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries && !this.isReady) {
      try {
        logger.info(`[AllianceIndexer] Starting initial indexing (attempt ${retries + 1}/${maxRetries})...`);

        const alliances = await this.fetchAllAlliances();
        await this.saveToCache(alliances);

        this.isReady = true;
        logger.info(`[AllianceIndexer] Initial indexing complete: ${this.totalAlliances} alliances`);

        const { broadcast } = require('../websocket/broadcaster');
        broadcast('alliance_index_ready', {
          total: this.totalAlliances,
          timestamp: this.lastUpdate
        });

        break;
      } catch (error) {
        retries++;
        logger.error(`[AllianceIndexer] Initial indexing failed (attempt ${retries}/${maxRetries}):`, error.message);

        if (retries < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, retries), 30000);
          logger.info(`[AllianceIndexer] Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error('[AllianceIndexer] Max retries reached. Alliance search will be unavailable.');
        }
      }
    }
  }

  /**
   * Fetch all alliances from API
   * Fetches across all supported languages to get complete alliance list
   */
  async fetchAllAlliances() {
    this.isIndexing = true;

    const languages = [
      'en-GB', 'da-DK', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pl-PL', 'tr-TR',
      'ru-RU', 'ar-SA', 'nl-NL', 'pt-BR', 'pt-PT', 'zh-CN', 'id-ID', 'ja-JP',
      'ms-MY', 'ko-KR', 'th-TH'
    ];

    const allianceMap = new Map();
    let totalFetched = 0;

    logger.info(`[AllianceIndexer] Fetching alliances for ${languages.length} languages...`);

    for (let langIndex = 0; langIndex < languages.length; langIndex++) {
      const language = languages[langIndex];
      let offset = 0;
      const limit = this.PAGE_SIZE;
      let page = 1;
      let langTotal = 0;

      logger.info(`[AllianceIndexer] Language ${langIndex + 1}/${languages.length}: ${language}`);

      while (true) {
        try {
          const response = await apiCall('/alliance/get-open-alliances', 'POST', {
            limit: limit,
            offset: offset,
            filter: 'all',
            language: language
          });

          if (!response || !response.data || !response.data.alliances) {
            break;
          }

          const alliances = response.data.alliances;

          if (alliances.length === 0) {
            break;
          }

          alliances.forEach(alliance => {
            if (alliance.members > 0) {
              allianceMap.set(alliance.id, alliance);
            }
          });

          langTotal += alliances.length;
          totalFetched += alliances.length;

          logger.debug(`[AllianceIndexer] ${language} page ${page}: ${alliances.length} alliances (lang total: ${langTotal}, unique: ${allianceMap.size})`);

          offset += limit;
          page++;

          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`[AllianceIndexer] Error fetching ${language} page ${page}:`, error.message);
          throw error;
        }
      }

      logger.info(`[AllianceIndexer] ${language} complete: ${langTotal} alliances fetched (unique total: ${allianceMap.size})`);
    }

    const alliances = Array.from(allianceMap.values());
    this.isIndexing = false;

    logger.info(`[AllianceIndexer] All languages complete: ${totalFetched} total fetched, ${alliances.length} unique alliances`);

    return alliances;
  }

  /**
   * Start background refresh cycle
   * Refreshes all alliances over 1 hour (distributed evenly)
   */
  startBackgroundRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    const totalPages = Math.ceil(6400 / this.PAGE_SIZE);
    const intervalPerPage = this.REFRESH_CYCLE_DURATION / totalPages;

    logger.info(`[AllianceIndexer] Starting background refresh: ${totalPages} pages, ${Math.round(intervalPerPage/1000)}s per page`);

    this.refreshInterval = setInterval(async () => {
      if (this.isIndexing || !this.isReady) {
        return;
      }

      try {
        const offset = this.currentRefreshPage * this.PAGE_SIZE;

        const response = await apiCall('/alliance/get-open-alliances', 'POST', {
          limit: this.PAGE_SIZE,
          offset: offset,
          filter: 'all'
        });

        if (response && response.data && response.data.alliances) {
          const freshAlliances = response.data.alliances;

          const data = await fs.readFile(this.cacheFilePath, 'utf8');
          const cache = JSON.parse(data);
          const alliances = cache.alliances || [];

          freshAlliances.forEach(freshAlliance => {
            const index = alliances.findIndex(a => a.id === freshAlliance.id);
            if (freshAlliance.members > 0) {
              if (index !== -1) {
                alliances[index] = freshAlliance;
              } else {
                alliances.push(freshAlliance);
              }
            } else if (index !== -1) {
              alliances.splice(index, 1);
            }
          });

          await this.saveToCache(alliances);

          logger.debug(`[AllianceIndexer] Refreshed page ${this.currentRefreshPage + 1}/${totalPages} (${freshAlliances.length} alliances)`);
        }

        this.currentRefreshPage++;
        if (this.currentRefreshPage >= totalPages) {
          this.currentRefreshPage = 0;
          logger.info('[AllianceIndexer] Background refresh cycle complete');
        }
      } catch (error) {
        logger.error(`[AllianceIndexer] Error refreshing page ${this.currentRefreshPage}:`, error.message);
      }
    }, intervalPerPage);
  }

  /**
   * Search alliances with filters
   * @param {string} query - Search query (name or description)
   * @param {Object} filters - Filter options
   * @returns {Object} Search results
   */
  async search(query, filters = {}) {
    if (!this.isReady) {
      return {
        results: [],
        total: 0,
        ready: false
      };
    }

    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf8');
      const cache = JSON.parse(data);
      let results = cache.alliances || [];

    // Text search
    if (query && query.trim().length > 0) {
      const searchTerm = query.toLowerCase().trim();
      results = results.filter(alliance =>
        alliance.name.toLowerCase().includes(searchTerm) ||
        (alliance.description && alliance.description.toLowerCase().includes(searchTerm))
      );
    }

    // Filter by language
    if (filters.language) {
      results = results.filter(a => a.language === filters.language);
    }

    // Filter by member count
    if (filters.minMembers !== undefined) {
      results = results.filter(a => a.members >= filters.minMembers);
    }

    if (filters.maxMembers !== undefined) {
      results = results.filter(a => a.members <= filters.maxMembers);
    }

    // Filter by benefit level
    if (filters.benefitLevel !== undefined) {
      results = results.filter(a => a.benefit_level === filters.benefitLevel);
    }

    // Filter: has open slots
    if (filters.hasOpenSlots) {
      results = results.filter(a => a.members < 50);
    }

    // Sorting
    const sortBy = filters.sortBy || 'name_asc';

    switch (sortBy) {
      case 'name_asc':
        results.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name_desc':
        results.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'members_desc':
        results.sort((a, b) => b.members - a.members);
        break;
      case 'members_asc':
        results.sort((a, b) => a.members - b.members);
        break;
      case 'contribution_desc':
        results.sort((a, b) => (b.stats?.contribution_score_24h || 0) - (a.stats?.contribution_score_24h || 0));
        break;
      case 'contribution_asc':
        results.sort((a, b) => (a.stats?.contribution_score_24h || 0) - (b.stats?.contribution_score_24h || 0));
        break;
      case 'departures_desc':
        results.sort((a, b) => (b.stats?.departures_24h || 0) - (a.stats?.departures_24h || 0));
        break;
      case 'departures_asc':
        results.sort((a, b) => (a.stats?.departures_24h || 0) - (b.stats?.departures_24h || 0));
        break;
      case 'share_value_desc':
        results.sort((a, b) => (b.total_share_value || 0) - (a.total_share_value || 0));
        break;
      case 'share_value_asc':
        results.sort((a, b) => (a.total_share_value || 0) - (b.total_share_value || 0));
        break;
      case 'founded_desc':
        results.sort((a, b) => b.time_founded - a.time_founded);
        break;
      case 'founded_asc':
        results.sort((a, b) => a.time_founded - b.time_founded);
        break;
      default:
        results.sort((a, b) => a.name.localeCompare(b.name));
    }

      return {
        results,
        total: results.length,
        ready: true,
        lastUpdate: this.lastUpdate
      };
    } catch (error) {
      logger.error('[AllianceIndexer] Error reading cache for search:', error.message);
      return {
        results: [],
        total: 0,
        ready: false
      };
    }
  }

  /**
   * Get indexer status
   */
  getStatus() {
    return {
      isReady: this.isReady,
      isIndexing: this.isIndexing,
      totalAlliances: this.totalAlliances,
      lastUpdate: this.lastUpdate
    };
  }

  /**
   * Get available languages from indexed alliances
   */
  async getAvailableLanguages() {
    if (!this.isReady) {
      logger.warn('[AllianceIndexer] getAvailableLanguages called but indexer not ready');
      return [];
    }

    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf8');
      const cache = JSON.parse(data);
      const alliances = cache.alliances || [];

      const languages = new Set();
      alliances.forEach(alliance => {
        if (alliance.language !== undefined && alliance.language !== null) {
          languages.add(alliance.language);
        }
      });

      const result = Array.from(languages).sort();
      logger.info(`[AllianceIndexer] getAvailableLanguages returning ${result.length} languages:`, result);

      return result;
    } catch (error) {
      logger.error('[AllianceIndexer] Error reading cache for languages:', error.message);
      return [];
    }
  }

  /**
   * Stop indexer
   */
  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    logger.info('[AllianceIndexer] Stopped');
  }
}

// Singleton instance
const indexer = new AllianceIndexer();

module.exports = indexer;
