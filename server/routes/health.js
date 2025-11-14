/**
 * @fileoverview Health Check Endpoint
 *
 * Provides HTTP health check endpoint for monitoring server status.
 * Used by start.py to detect when server is fully initialized.
 *
 * @module server/routes/health
 */

const express = require('express');
const router = express.Router();

/**
 * Health check endpoint
 * Returns server status and ready state
 *
 * @route GET /health
 * @returns {Object} { status: "ok", ready: boolean, timestamp: ISO8601 }
 */
router.get('/', (req, res) => {
  const { isServerReady } = require('../scheduler');

  res.json({
    status: 'ok',
    ready: isServerReady(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
