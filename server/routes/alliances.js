/**
 * @fileoverview Alliance Search Routes
 *
 * Provides API endpoints for searching and filtering alliances.
 *
 * @module server/routes/alliances
 */

const express = require('express');
const router = express.Router();
const allianceIndexer = require('../services/alliance-indexer');
const logger = require('../utils/logger');

/**
 * Search alliances
 * POST /api/alliances/search
 *
 * Request body:
 * {
 *   query: string (optional) - Search term for name/description
 *   filters: {
 *     language: string (optional) - Filter by language code
 *     minMembers: number (optional) - Minimum member count
 *     maxMembers: number (optional) - Maximum member count
 *     benefitLevel: number (optional) - Specific benefit level
 *     hasOpenSlots: boolean (optional) - Only alliances with < 50 members
 *     sortBy: string (optional) - Sort order (members_desc, members_asc, etc.)
 *   },
 *   offset: number (optional) - Pagination offset (default 0)
 *   limit: number (optional) - Results per page (default 10)
 * }
 */
router.post('/search', async (req, res) => {
  try {
    const { query = '', filters = {}, offset = 0, limit = 10 } = req.body;

    // Check if indexer is ready
    const status = allianceIndexer.getStatus();
    if (!status.isReady) {
      return res.json({
        success: true,
        data: {
          results: [],
          total: 0,
          offset: 0,
          limit: limit,
          ready: false,
          indexing: status.isIndexing
        }
      });
    }

    // Search
    const searchResults = await allianceIndexer.search(query, filters);

    // Paginate
    const paginatedResults = searchResults.results.slice(offset, offset + limit);

    logger.debug(`[Alliances] Search: query="${query}", filters=${JSON.stringify(filters)}, results=${searchResults.total}`);

    res.json({
      success: true,
      data: {
        results: paginatedResults,
        total: searchResults.total,
        offset: offset,
        limit: limit,
        ready: true,
        lastUpdate: searchResults.lastUpdate
      }
    });

  } catch (error) {
    logger.error('[Alliances] Search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search alliances',
      message: error.message
    });
  }
});

/**
 * Get indexer status
 * GET /api/alliances/status
 */
router.get('/status', (req, res) => {
  const status = allianceIndexer.getStatus();

  res.json({
    success: true,
    data: status
  });
});

/**
 * Get available languages
 * GET /api/alliances/languages
 */
router.get('/languages', async (req, res) => {
  const languages = await allianceIndexer.getAvailableLanguages();

  res.json({
    success: true,
    data: {
      languages: languages
    }
  });
});

module.exports = router;
