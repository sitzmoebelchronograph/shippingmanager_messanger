/**
 * Logbook API Routes
 *
 * Endpoints for retrieving, filtering, exporting, and deleting autopilot logs
 */

const express = require('express');
const router = express.Router();
const logbook = require('../logbook');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');

/**
 * POST /api/logbook/get-logs
 * Get log entries with optional filters
 *
 * Request body:
 * {
 *   status: "SUCCESS" | "ERROR" | "ALL",
 *   timeRange: "today" | "yesterday" | "48h" | "all",
 *   autopilot: "autopilot name" | "ALL",
 *   search: "search term"
 * }
 */
router.post('/get-logs', async (req, res) => {
  try {
    const userId = getUserId();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not initialized'
      });
    }

    const filters = {
      status: req.body.status || 'ALL',
      timeRange: req.body.timeRange || 'all',
      autopilot: req.body.autopilot || 'ALL',
      search: req.body.search || ''
    };

    const logs = await logbook.getLogEntries(userId, filters);

    res.json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    logger.error('Failed to get log entries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve log entries'
    });
  }
});

/**
 * POST /api/logbook/download
 * Export logs in TXT, CSV, or JSON format
 *
 * Request body:
 * {
 *   format: "txt" | "csv" | "json",
 *   status: "SUCCESS" | "ERROR" | "ALL",
 *   timeRange: "today" | "yesterday" | "48h" | "all",
 *   autopilot: "autopilot name" | "ALL",
 *   search: "search term"
 * }
 */
router.post('/download', async (req, res) => {
  try {
    const userId = getUserId();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not initialized'
      });
    }

    const format = req.body.format || 'json';
    const filters = {
      status: req.body.status || 'ALL',
      timeRange: req.body.timeRange || 'all',
      autopilot: req.body.autopilot || 'ALL',
      search: req.body.search || ''
    };

    const logs = await logbook.getLogEntries(userId, filters);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `autopilot-log-${timestamp}.${format}`;

    if (format === 'txt') {
      const content = formatLogsAsTXT(logs);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else if (format === 'csv') {
      const content = formatLogsAsCSV(logs);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else if (format === 'json') {
      const content = JSON.stringify(logs, null, 2);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid format. Must be txt, csv, or json'
      });
    }
  } catch (error) {
    logger.error('Failed to export logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export logs'
    });
  }
});

/**
 * POST /api/logbook/delete-all
 * Delete all logs for the current user
 */
router.post('/delete-all', async (req, res) => {
  try {
    const userId = getUserId();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not initialized'
      });
    }

    const success = await logbook.deleteAllLogs(userId);

    if (success) {
      res.json({
        success: true,
        message: 'All logs deleted successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete logs'
      });
    }
  } catch (error) {
    logger.error('Failed to delete logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete logs'
    });
  }
});

/**
 * GET /api/logbook/file-size
 * Get the current log file size
 */
router.get('/file-size', async (req, res) => {
  try {
    const userId = getUserId();

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not initialized'
      });
    }

    const sizeInBytes = await logbook.getLogFileSize(userId);
    const formatted = logbook.formatFileSize(sizeInBytes);

    res.json({
      success: true,
      bytes: sizeInBytes,
      formatted
    });
  } catch (error) {
    logger.error('Failed to get file size:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get file size'
    });
  }
});

/**
 * Format logs as TXT (human-readable)
 */
function formatLogsAsTXT(logs) {
  if (logs.length === 0) {
    return 'No log entries found.\n';
  }

  let output = '='.repeat(80) + '\n';
  output += 'AUTOPILOT LOGBOOK\n';
  output += '='.repeat(80) + '\n\n';

  logs.forEach((log, index) => {
    const date = new Date(log.timestamp);
    let statusIcon;
    if (log.status === 'SUCCESS') {
      statusIcon = '✅';
    } else if (log.status === 'WARNING') {
      statusIcon = '⚠️';
    } else {
      statusIcon = '❌';
    }

    output += `[${index + 1}] ${statusIcon} ${log.autopilot}\n`;
    output += `    Timestamp: ${date.toLocaleString()}\n`;
    output += `    Status:    ${log.status}\n`;
    output += `    Summary:   ${log.summary}\n`;

    if (log.details && Object.keys(log.details).length > 0) {
      output += `    Details:\n`;
      output += formatDetailsAsTXT(log.details, 6);
    }

    output += '\n' + '-'.repeat(80) + '\n\n';
  });

  return output;
}

/**
 * Format details object as indented TXT
 */
function formatDetailsAsTXT(obj, indent = 0) {
  let output = '';
  const spaces = ' '.repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      output += `${spaces}${key}:\n`;
      output += formatDetailsAsTXT(value, indent + 2);
    } else if (Array.isArray(value)) {
      output += `${spaces}${key}: [${value.length} items]\n`;
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          output += `${spaces}  [${index}]:\n`;
          output += formatDetailsAsTXT(item, indent + 4);
        } else {
          output += `${spaces}  [${index}]: ${item}\n`;
        }
      });
    } else {
      output += `${spaces}${key}: ${value}\n`;
    }
  }

  return output;
}

/**
 * Format logs as CSV (Excel-compatible)
 */
function formatLogsAsCSV(logs) {
  if (logs.length === 0) {
    return 'No log entries found.\n';
  }

  let output = 'Timestamp,Date,Time,Autopilot,Status,Summary,Details\n';

  logs.forEach(log => {
    const date = new Date(log.timestamp);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString();
    const details = JSON.stringify(log.details).replace(/"/g, '""'); // Escape quotes

    output += `${log.timestamp},"${dateStr}","${timeStr}","${log.autopilot}","${log.status}","${log.summary}","${details}"\n`;
  });

  return output;
}

module.exports = router;
