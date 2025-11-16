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

/**
 * Current filter state
 * @type {Object}
 */
let currentFilters = {
  status: 'ALL',
  transaction: 'ALL',
  timeRange: 'all',
  action: 'ALL',  // Combined filter: specific action, category, or source
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
  const logbookOverlay = document.getElementById('logbookOverlay');
  const logbookCloseBtn = document.getElementById('logbookCloseBtn');
  const logbookFilterStatus = document.getElementById('logbookFilterStatus');
  const logbookFilterTransaction = document.getElementById('logbookFilterTransaction');
  const logbookFilterTime = document.getElementById('logbookFilterTime');
  const logbookFilterAction = document.getElementById('logbookFilterAction');
  const logbookFilterSearch = document.getElementById('logbookFilterSearch');
  const logbookExportBtn = document.getElementById('logbookExportBtn');
  const logbookExportMenu = document.getElementById('logbookExportMenu');
  const logbookExportTxt = document.getElementById('logbookExportTxt');
  const logbookExportCsv = document.getElementById('logbookExportCsv');
  const logbookExportJson = document.getElementById('logbookExportJson');

  if (!logbookOverlay) {
    console.warn('[Logbook] Overlay not found');
    return;
  }

  // Expose function to open logbook (called by map icon bar)
  window.openLogbook = async () => {
    logbookOverlay.classList.remove('hidden');
    await loadLogs();
  };

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

  // Filter: Transaction
  logbookFilterTransaction.addEventListener('change', async (e) => {
    currentFilters.transaction = e.target.value;
    await loadLogs();
  });

  // Filter: Time Range
  logbookFilterTime.addEventListener('change', async (e) => {
    currentFilters.timeRange = e.target.value;
    await loadLogs();
  });

  // Filter: Action (combined: specific action, category, or source)
  logbookFilterAction.addEventListener('change', async (e) => {
    currentFilters.action = e.target.value;
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
 * Converts combined action filter to backend-compatible filters
 */
function convertActionFilterToBackend() {
  const backendFilters = {
    status: currentFilters.status,
    transaction: currentFilters.transaction,
    timeRange: currentFilters.timeRange,
    search: currentFilters.search,
    autopilot: 'ALL',
    category: 'ALL',
    source: 'ALL'
  };

  const action = currentFilters.action;

  if (action.startsWith('CATEGORY:')) {
    backendFilters.category = action.substring(9); // Remove "CATEGORY:" prefix
  } else if (action.startsWith('SOURCE:')) {
    backendFilters.source = action.substring(7); // Remove "SOURCE:" prefix
  } else if (action.startsWith('ACTION:')) {
    backendFilters.autopilot = action.substring(7); // Remove "ACTION:" prefix
  }
  // else action is 'ALL', so all backend filters stay 'ALL'

  return backendFilters;
}

/**
 * Loads log entries from server with current filters
 */
async function loadLogs() {
  try {
    const backendFilters = convertActionFilterToBackend();
    const data = await fetchLogbookEntries(backendFilters);

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
 * Updates action filter dropdown with unique action names from logs
 */
function updateActionFilter() {
  const actionSelect = document.getElementById('logbookFilterAction');
  if (!actionSelect) return;

  // Get unique action names from all entries
  const uniqueActions = [...new Set(logEntries.map(e => e.autopilot))].sort();

  // Store current selection
  const currentValue = actionSelect.value;

  // Rebuild options - keep categories and sources, add specific actions at the end
  actionSelect.innerHTML = `
    <option value="ALL">All Actions</option>
    <option disabled>─── Categories ───</option>
    <option value="CATEGORY:BUNKER">📦 Bunker</option>
    <option value="CATEGORY:VESSEL">🚢 Vessel</option>
    <option value="CATEGORY:AUTOPILOT">🤖 Autopilot</option>
    <option value="CATEGORY:ANCHOR">⚓ Anchor</option>
    <option value="CATEGORY:SETTINGS">⚙️ Settings</option>
    <option disabled>─── Sources ───</option>
    <option value="SOURCE:MANUAL">✋ Manual</option>
    <option value="SOURCE:AUTOPILOT">🤖 Autopilot</option>
  `;

  // Add separator and specific actions if any exist
  if (uniqueActions.length > 0) {
    const separator = document.createElement('option');
    separator.disabled = true;
    separator.textContent = '─── Actions ───';
    actionSelect.appendChild(separator);

    uniqueActions.forEach(action => {
      const option = document.createElement('option');
      option.value = `ACTION:${action}`;
      option.textContent = action;
      actionSelect.appendChild(option);
    });
  }

  // Restore selection if still valid
  if (currentValue.startsWith('ACTION:')) {
    const actionName = currentValue.substring(7); // Remove "ACTION:" prefix
    if (uniqueActions.includes(actionName)) {
      actionSelect.value = currentValue;
    } else {
      actionSelect.value = 'ALL';
      currentFilters.action = 'ALL';
    }
  } else if (currentValue !== 'ALL' && !currentValue.startsWith('CATEGORY:') && !currentValue.startsWith('SOURCE:')) {
    // Old value was something else, reset
    actionSelect.value = 'ALL';
    currentFilters.action = 'ALL';
  } else {
    // Keep category or source selection
    actionSelect.value = currentValue;
  }
}

/**
 * Determines transaction type from entry summary
 * @param {Object} entry - Log entry
 * @returns {string} - 'income', 'expense', or ''
 */
function getTransactionType(entry) {
  if (!entry.summary) return '';

  // Ensure summary is a string
  const summary = String(entry.summary);

  // Income: summary contains "+$" (e.g., "+$1,234")
  if (summary.includes('+$')) {
    return 'income';
  }

  // Expense: summary contains "-$" (e.g., "-$1,234") OR contains only "$" with specific autopilots
  if (summary.includes('-$')) {
    return 'expense';
  }

  // Additional expense autopilots AND manual actions that show cost without minus sign
  const expenseActions = [
    'Auto-Drydock',
    'Auto-Fuel',
    'Auto-CO2',
    'Auto-Anchor Purchase',
    'Auto-Reputation',
    'Auto-Repair',
    'Auto-Blackbeard',
    'Auto-Campaign',
    'Manual Fuel Purchase',
    'Manual CO2 Purchase',
    'Manual Bulk Repair',
    'Manual Bulk Drydock',
    'Manual Vessel Purchase',
    'Manual Anchor Purchase',
    'Manual Pay Ransom',
    'Manual Campaign Activation'
  ];
  if (expenseActions.includes(entry.autopilot) && summary.includes('$')) {
    return 'expense';
  }

  // Manual Vessel Sale and Departure are income (both manual and auto)
  const incomeActions = [
    'Manual Vessel Sale',
    'Manual Vessel Departure',
    'Manual-Depart',
    'Auto-Depart'
  ];
  if (incomeActions.includes(entry.autopilot) && summary.includes('$')) {
    return 'income';
  }

  return '';
}

/**
 * Renders the log table with current entries
 */
function renderLogTable() {
  const tbody = document.getElementById('logbookTableBody');
  if (!tbody) return;

  // Update autopilot filter dropdown with unique autopilot names
  updateActionFilter();

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

    // Determine transaction type for styling
    const transactionType = getTransactionType(entry);
    const transactionClass = transactionType ? `logbook-${transactionType}` : '';

    // Always render details row (hidden by default) for instant expand/collapse
    return `
      <tr class="logbook-row ${isExpanded ? 'expanded' : ''} ${transactionClass}" data-id="${entry.id}">
        <td class="logbook-status ${statusClass}">${statusIcon}</td>
        <td class="logbook-timestamp">${formatTimestamp(date)}</td>
        <td class="logbook-autopilot">${escapeHtml(entry.autopilot)}</td>
        <td class="logbook-summary">${escapeHtml(entry.summary)}</td>
      </tr>
      <tr class="logbook-details-row ${isExpanded ? '' : 'hidden'}" data-details-for="${entry.id}">
        <td colspan="4">
          <div class="logbook-details">
            <h4>Details</h4>
            ${formatDetails(entry.details)}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Event delegation: single listener on tbody for better performance
  // Remove old listeners first to avoid duplicates on re-render
  tbody.onclick = null;
  tbody.ondblclick = null;

  tbody.onclick = (e) => {
    const row = e.target.closest('.logbook-row');
    if (!row) return;

    const entryId = row.dataset.id;
    const detailsRow = row.nextElementSibling;

    // Toggle state tracking (for re-render consistency)
    if (expandedEntries.has(entryId)) {
      expandedEntries.delete(entryId);
    } else {
      expandedEntries.add(entryId);
    }

    // Direct DOM manipulation - instant, no re-render
    row.classList.toggle('expanded');
    if (detailsRow && detailsRow.classList.contains('logbook-details-row')) {
      detailsRow.classList.toggle('hidden');
    }
  };

  tbody.ondblclick = (e) => {
    const detailsRow = e.target.closest('.logbook-details-row');
    if (!detailsRow) return;

    const mainRow = detailsRow.previousElementSibling;
    if (mainRow && mainRow.classList.contains('logbook-row')) {
      const entryId = mainRow.dataset.id;
      expandedEntries.delete(entryId);
      mainRow.classList.remove('expanded');
      detailsRow.classList.add('hidden');
    }
  };
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
 * Formats timestamp for display with date and time on separate lines
 */
function formatTimestamp(date) {
  const dateStr = date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return `${dateStr}<br>${timeStr}`;
}

/**
 * Exports logs in specified format
 */
async function exportLogs(format) {
  try {
    const backendFilters = convertActionFilterToBackend();
    const data = await downloadLogbookExport(format, backendFilters);

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
