/**
 * @fileoverview Autopilot Logbook Module - Display and manage autopilot action logs
 *
 * Provides transparency into all autopilot operations with SUCCESS/ERROR tracking.
 * Features table view with filters, search, expand/collapse details, and export functionality.
 *
 * Key Features:
 * - Real-time log updates via WebSocket
 * - Filters: Status (All/Success/Warning/Error), Time Range (Today/Yesterday/48h/7days/lastweek/30days/lastmonth/All), Autopilot (dynamic list)
 * - Search: Full-text search across all fields including nested details
 * - Expand/collapse: Click rows to see detailed operation data, double-click details to collapse
 * - Export: Download logs as TXT, CSV, or JSON
 * - Smart auto-prepend: New entries appear at top without scrolling user
 *
 * @module logbook
 * @requires utils - HTML escaping and notification functions
 * @requires api - Logbook API calls
 */

import { escapeHtml, showNotification } from './utils.js';
import { fetchLogbookEntries, downloadLogbookExport, deleteAllLogs, fetchLogbookFileSize } from './api.js';
import { showConfirmDialog } from './ui-dialogs.js';

/**
 * Current filter state
 * @type {Object}
 */
let currentFilters = {
  status: 'ALL',
  timeRange: 'all',
  autopilot: 'ALL',
  search: ''
};

/**
 * All loaded log entries
 * @type {Array}
 */
let logEntries = [];

/**
 * Set of expanded entry IDs
 * @type {Set<string>}
 */
const expandedEntries = new Set();

/**
 * Initializes the logbook module
 * Sets up event listeners and loads initial data
 */
export function initLogbook() {
  const logbookBtn = document.getElementById('logbookBtn');
  const logbookOverlay = document.getElementById('logbookOverlay');
  const logbookCloseBtn = document.getElementById('logbookCloseBtn');
  const logbookFilterStatus = document.getElementById('logbookFilterStatus');
  const logbookFilterTime = document.getElementById('logbookFilterTime');
  const logbookFilterAutopilot = document.getElementById('logbookFilterAutopilot');
  const logbookFilterSearch = document.getElementById('logbookFilterSearch');
  const logbookExportBtn = document.getElementById('logbookExportBtn');
  const logbookExportMenu = document.getElementById('logbookExportMenu');
  const logbookExportTxt = document.getElementById('logbookExportTxt');
  const logbookExportCsv = document.getElementById('logbookExportCsv');
  const logbookExportJson = document.getElementById('logbookExportJson');

  if (!logbookBtn || !logbookOverlay) {
    console.warn('[Logbook] UI elements not found');
    return;
  }

  // Open logbook
  logbookBtn.addEventListener('click', async () => {
    logbookOverlay.classList.remove('hidden');
    await loadLogs();
  });

  // Close logbook
  logbookCloseBtn.addEventListener('click', () => {
    logbookOverlay.classList.add('hidden');
  });

  // Toggle export menu
  logbookExportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logbookExportMenu.classList.toggle('hidden');
  });

  // Close export menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!logbookExportMenu.classList.contains('hidden') && !logbookExportBtn.contains(e.target)) {
      logbookExportMenu.classList.add('hidden');
    }
  });

  // Filter: Status
  logbookFilterStatus.addEventListener('change', async (e) => {
    currentFilters.status = e.target.value;
    await loadLogs();
  });

  // Filter: Time Range
  logbookFilterTime.addEventListener('change', async (e) => {
    currentFilters.timeRange = e.target.value;
    await loadLogs();
  });

  // Filter: Autopilot
  logbookFilterAutopilot.addEventListener('change', async (e) => {
    currentFilters.autopilot = e.target.value;
    await loadLogs();
  });

  // Filter: Search (debounced)
  let searchTimeout;
  logbookFilterSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      currentFilters.search = e.target.value;
      await loadLogs();
    }, 300);
  });

  // Export buttons
  logbookExportTxt.addEventListener('click', () => {
    exportLogs('txt');
    logbookExportMenu.classList.add('hidden');
  });
  logbookExportCsv.addEventListener('click', () => {
    exportLogs('csv');
    logbookExportMenu.classList.add('hidden');
  });
  logbookExportJson.addEventListener('click', () => {
    exportLogs('json');
    logbookExportMenu.classList.add('hidden');
  });

  console.log('[Logbook] Module initialized');
}

/**
 * Loads log entries from server with current filters
 */
async function loadLogs() {
  try {
    const data = await fetchLogbookEntries(currentFilters);

    if (data.success) {
      logEntries = data.logs || [];
      renderLogTable();

      // Update count display
      const countEl = document.getElementById('logbookCount');
      if (countEl) {
        countEl.textContent = `${logEntries.length} entries`;
      }
    } else {
      showNotification('Failed to load logs', 'error');
    }
  } catch (error) {
    console.error('[Logbook] Failed to load logs:', error);
    showNotification('Failed to load logs', 'error');
  }
}

/**
 * Updates autopilot filter dropdown with unique autopilot names from logs
 */
function updateAutopilotFilter() {
  const autopilotSelect = document.getElementById('logbookFilterAutopilot');
  if (!autopilotSelect) return;

  // Get unique autopilot names from all entries
  const uniqueAutopilots = [...new Set(logEntries.map(e => e.autopilot))].sort();

  // Store current selection
  const currentValue = autopilotSelect.value;

  // Rebuild options
  autopilotSelect.innerHTML = '<option value="ALL">All</option>';
  uniqueAutopilots.forEach(autopilot => {
    const option = document.createElement('option');
    option.value = autopilot;
    option.textContent = autopilot;
    autopilotSelect.appendChild(option);
  });

  // Restore selection if still valid
  if (uniqueAutopilots.includes(currentValue)) {
    autopilotSelect.value = currentValue;
  } else if (currentValue !== 'ALL') {
    autopilotSelect.value = 'ALL';
    currentFilters.autopilot = 'ALL';
  }
}

/**
 * Recursively searches through an object for a search term
 * @param {*} obj - Object to search through
 * @param {string} searchTerm - Term to search for (case-insensitive)
 * @returns {boolean} - True if term found anywhere in object
 */
function searchInObject(obj, searchTerm) {
  if (!searchTerm) return true;

  const lowerSearch = searchTerm.toLowerCase();

  // Handle primitive types
  if (obj === null || obj === undefined) {
    return false;
  }
  if (typeof obj !== 'object') {
    return String(obj).toLowerCase().includes(lowerSearch);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.some(item => searchInObject(item, searchTerm));
  }

  // Handle objects
  for (const value of Object.values(obj)) {
    if (searchInObject(value, searchTerm)) {
      return true;
    }
  }

  return false;
}

/**
 * Renders the log table with current entries
 */
function renderLogTable() {
  const tbody = document.getElementById('logbookTableBody');
  if (!tbody) return;

  // Update autopilot filter dropdown with unique autopilot names
  updateAutopilotFilter();

  if (logEntries.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="logbook-empty">
          No log entries found. Autopilot actions will appear here.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logEntries.map(entry => {
    const isExpanded = expandedEntries.has(entry.id);
    let statusIcon, statusClass;
    if (entry.status === 'SUCCESS') {
      statusIcon = '✅';
      statusClass = 'logbook-success';
    } else if (entry.status === 'WARNING') {
      statusIcon = '⚠️';
      statusClass = 'logbook-warning';
    } else {
      statusIcon = '❌';
      statusClass = 'logbook-error';
    }
    const date = new Date(entry.timestamp);

    return `
      <tr class="logbook-row ${isExpanded ? 'expanded' : ''}" data-id="${entry.id}">
        <td class="logbook-timestamp">${formatTimestamp(date)}</td>
        <td class="logbook-autopilot">${escapeHtml(entry.autopilot)}</td>
        <td class="logbook-status ${statusClass}">${statusIcon} ${entry.status}</td>
        <td class="logbook-summary">${escapeHtml(entry.summary)}</td>
      </tr>
      ${isExpanded ? renderDetailsRow(entry) : ''}
    `;
  }).join('');

  // Add click listeners to rows
  tbody.querySelectorAll('.logbook-row').forEach(row => {
    row.addEventListener('click', () => {
      const entryId = row.dataset.id;
      toggleExpanded(entryId);
    });
  });

  // Add double-click listeners to details rows to collapse
  tbody.querySelectorAll('.logbook-details-row').forEach(detailsRow => {
    detailsRow.addEventListener('dblclick', () => {
      // Find the previous row (the main logbook-row) to get the entry ID
      const mainRow = detailsRow.previousElementSibling;
      if (mainRow && mainRow.classList.contains('logbook-row')) {
        const entryId = mainRow.dataset.id;
        toggleExpanded(entryId);
      }
    });
  });
}

/**
 * Renders the details row for an expanded entry
 */
function renderDetailsRow(entry) {
  const detailsHtml = formatDetails(entry.details);

  return `
    <tr class="logbook-details-row">
      <td colspan="4">
        <div class="logbook-details">
          <h4>Details</h4>
          ${detailsHtml}
        </div>
      </td>
    </tr>
  `;
}

/**
 * Formats details object as nested HTML
 */
function formatDetails(obj, level = 0) {
  if (!obj || typeof obj !== 'object') {
    return `<div class="logbook-detail-value">${escapeHtml(String(obj))}</div>`;
  }

  const indent = level * 20;
  let html = '<div class="logbook-detail-object">';

  for (const [key, value] of Object.entries(obj)) {
    html += `<div class="logbook-detail-row" style="margin-left: ${indent}px;">`;
    html += `<span class="logbook-detail-key">${escapeHtml(key)}:</span> `;

    if (value === null || value === undefined) {
      html += `<span class="logbook-detail-value logbook-detail-null">null</span>`;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      html += formatDetails(value, level + 1);
    } else if (Array.isArray(value)) {
      html += `<span class="logbook-detail-array">[${value.length} items]</span>`;
      if (value.length > 0) {
        html += '<div class="logbook-detail-array-items">';
        value.forEach((item, index) => {
          html += `<div class="logbook-detail-row" style="margin-left: ${indent + 20}px;">`;
          html += `<span class="logbook-detail-key">[${index}]:</span> `;
          if (typeof item === 'object') {
            html += formatDetails(item, level + 2);
          } else {
            html += `<span class="logbook-detail-value">${escapeHtml(String(item))}</span>`;
          }
          html += '</div>';
        });
        html += '</div>';
      }
    } else if (typeof value === 'boolean') {
      html += `<span class="logbook-detail-boolean">${value}</span>`;
    } else if (typeof value === 'number') {
      // Only format as currency for money-related fields
      const isCurrency = /cost|price|income|fee|revenue|cash|payment/i.test(key);
      const formatted = isCurrency ? value.toLocaleString() : value;
      html += `<span class="logbook-detail-number">${formatted}</span>`;
    } else {
      html += `<span class="logbook-detail-value">${escapeHtml(String(value))}</span>`;
    }

    html += '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * Toggles expanded state for an entry
 */
function toggleExpanded(entryId) {
  if (expandedEntries.has(entryId)) {
    expandedEntries.delete(entryId);
  } else {
    expandedEntries.add(entryId);
  }
  renderLogTable();
}

/**
 * Formats timestamp for display
 */
function formatTimestamp(date) {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/**
 * Exports logs in specified format
 */
async function exportLogs(format) {
  try {
    const data = await downloadLogbookExport(format, currentFilters);

    // Create blob and download
    let blob;
    let filename;

    if (format === 'json') {
      blob = new Blob([data], { type: 'application/json' });
      filename = `autopilot-log-${Date.now()}.json`;
    } else if (format === 'csv') {
      blob = new Blob([data], { type: 'text/csv' });
      filename = `autopilot-log-${Date.now()}.csv`;
    } else if (format === 'txt') {
      blob = new Blob([data], { type: 'text/plain' });
      filename = `autopilot-log-${Date.now()}.txt`;
    }

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showNotification(`Exported ${logEntries.length} entries as ${format.toUpperCase()}`, 'success');
  } catch (error) {
    console.error('[Logbook] Export failed:', error);
    showNotification('Export failed', 'error');
  }
}

/**
 * Prepends a new log entry to the table (called via WebSocket)
 * Uses smart loading to preserve user's scroll position
 */
export function prependLogEntry(entry) {
  // Store current scroll position
  const tbody = document.getElementById('logbookTableBody');
  const container = tbody ? tbody.closest('.logbook-table-container') : null;
  const scrollTop = container ? container.scrollTop : 0;

  // Add entry to array
  logEntries.unshift(entry);

  // Re-render table
  renderLogTable();

  // Restore scroll position (smart auto-prepend)
  if (container && scrollTop > 0) {
    container.scrollTop = scrollTop;
  }

  // Update count
  const countEl = document.getElementById('logbookCount');
  if (countEl) {
    countEl.textContent = `${logEntries.length} entries`;
  }
}

/**
 * Deletes all logs for the current user
 * Called from settings module
 */
export async function deleteAllLogsConfirmed() {
  try {
    const data = await deleteAllLogs();

    if (data.success) {
      logEntries = [];
      renderLogTable();
      showNotification('AutoPilot Logbook', {
        body: 'All logs deleted',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50%" x="50%" text-anchor="middle" font-size="80">📣</text></svg>'
      });
    } else {
      showNotification('AutoPilot Logbook', {
        body: 'Failed to delete logs',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50%" x="50%" text-anchor="middle" font-size="80">📣</text></svg>'
      });
    }
  } catch (error) {
    console.error('[Logbook] Delete failed:', error);
    showNotification('AutoPilot Logbook', {
      body: 'Failed to delete logs',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50%" x="50%" text-anchor="middle" font-size="80">📣</text></svg>'
    });
  }
}

/**
 * Fetches and returns current log file size
 * Called from settings module
 */
export async function getLogFileSize() {
  try {
    const data = await fetchLogbookFileSize();
    if (data.success) {
      return data.formatted;
    }
    return '0 B';
  } catch (error) {
    console.error('[Logbook] Failed to get file size:', error);
    return 'Unknown';
  }
}
