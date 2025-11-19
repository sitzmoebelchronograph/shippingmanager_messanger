/**
 * @fileoverview Alliance Cooperation Tabs Management
 *
 * Handles the 6-tab interface for Alliance Cooperation:
 * - Allianz: Alliance info and statistics
 * - Coop: Current coop functionality (member send buttons)
 * - Liga: User's league and group standings
 * - HighScore: Alliance leaderboard
 * - Management: Queue pool and member role management
 * - Settings: Alliance coop settings
 *
 * @module alliance-tabs
 * @requires utils - Formatting and feedback functions
 * @requires badge-manager - Badge updates
 */

import { formatNumber, escapeHtml, showSideNotification, loadSettings } from './utils.js';
import { fetchCoopData, lockCoopButtons, unlockCoopButtons } from './coop.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { openPlayerProfile } from './company-profile.js';

// Tab state management
let currentTab = 'allianz';
let tabDataCache = {
  allianz: null,
  liga: null,
  highscore: null,
  search: null,
  management: null,
  settings: null
};
let isTabLoading = false;
let isTabsInitialized = false;
let managementTabRefreshInterval = null;

// Search tab state
let searchState = {
  results: [],
  offset: 0,
  total: 0,
  query: '',
  filters: { sortBy: 'name_asc' },
  isLoading: false,
  hasMore: true
};

// Lazy loading for alliance search
let allianceLazyLoadObserver = null;
const ALLIANCE_INITIAL_LOAD = 10;
const ALLIANCE_LAZY_BATCH = 10;

/**
 * Fetches alliance info from the backend API
 * @returns {Promise<Object>} Alliance data
 */
async function fetchAllianceInfo() {
  const response = await fetch(window.apiUrl('/api/alliance-info'));
  if (!response.ok) throw new Error('Failed to fetch alliance info');
  return await response.json();
}

/**
 * Fetches alliance info by ID from the backend API
 * @param {number} allianceId - The alliance ID to fetch
 * @returns {Promise<Object>} Alliance data
 */
async function fetchAllianceInfoById(allianceId) {
  const response = await fetch(window.apiUrl(`/api/alliance-info/${allianceId}`));
  if (!response.ok) throw new Error('Failed to fetch alliance info');
  return await response.json();
}

/**
 * Fetches alliance members by ID from the backend API
 * @param {number} allianceId - The alliance ID to fetch members for
 * @returns {Promise<Array>} Members array
 */
async function fetchAllianceMembersById(allianceId) {
  const response = await fetch(window.apiUrl(`/api/alliance-members/${allianceId}`));
  if (!response.ok) throw new Error('Failed to fetch alliance members');
  return await response.json();
}

/**
 * Fetches league info from the backend API
 * @returns {Promise<Object>} League data
 */
async function fetchLeagueInfo() {
  const response = await fetch(window.apiUrl('/api/league-info'));
  if (!response.ok) throw new Error('Failed to fetch league info');
  return await response.json();
}

/**
 * Fetches high scores from the backend API
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>} High scores data
 */
async function fetchHighScores(params = {}) {
  const queryString = new URLSearchParams(params).toString();
  const url = queryString
    ? window.apiUrl(`/api/alliance-high-scores?${queryString}`)
    : window.apiUrl('/api/alliance-high-scores');
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch high scores');
  return await response.json();
}

/**
 * Fetches queue pool data from the backend API
 * @param {Object} filters - Filter parameters
 * @returns {Promise<Object>} Queue pool data
 */
async function fetchQueuePool(filters = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(window.apiUrl('/api/alliance-queue-pool'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters)
      });
      if (!response.ok) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw new Error('Failed to fetch queue pool');
      }
      return await response.json();
    } catch (error) {
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Accepts a user's application to join the alliance
 * @param {number} userId - The user ID to accept
 * @returns {Promise<Object>} Response from the API
 */
async function acceptUserToAlliance(userId) {
  const response = await fetch(window.apiUrl('/api/alliance-accept-user'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to accept user');
  }
  return data;
}

/**
 * Declines a user's application to join the alliance
 * @param {number} userId - The user ID to decline
 * @returns {Promise<Object>} Response from the API
 */
async function declineUserFromAlliance(userId) {
  const response = await fetch(window.apiUrl('/api/alliance-decline-user'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to decline user');
  }
  return data;
}

/**
 * Fetches alliance settings from the backend API
 * @returns {Promise<Object>} Alliance settings data
 */
async function fetchAllianceSettings() {
  const response = await fetch(window.apiUrl('/api/alliance-settings'));
  if (!response.ok) throw new Error('Failed to fetch alliance settings');
  return await response.json();
}

/**
 * Fetches alliance members from the backend API
 * @returns {Promise<Array>} Array of alliance members
 */
async function fetchAllianceMembers() {
  const response = await fetch(window.apiUrl('/api/alliance-members'));
  if (!response.ok) throw new Error('Failed to fetch alliance members');
  return await response.json();
}

/**
 * Updates a member's role in the alliance
 * @param {number} userId - User ID to update
 * @param {string} role - New role
 * @returns {Promise<Object>} Update result
 */
async function updateUserRole(userId, role) {
  const response = await fetch(window.apiUrl('/api/alliance-update-user-role'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, role })
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update user role');
  }
  return await response.json();
}

/**
 * Updates alliance coop settings
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Update result
 */
async function updateAllianceSettings(settings) {
  const response = await fetch(window.apiUrl('/api/coop/update-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update settings');
  }
  return await response.json();
}

/**
 * Leaves the current alliance
 * @returns {Promise<Object>} Leave result
 */
async function leaveAlliance() {
  const response = await fetch(window.apiUrl('/api/alliance-leave'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to leave alliance');
  }
  return await response.json();
}

/**
 * Shows all alliance-specific UI elements when user joins/has alliance
 */
export async function showAllAllianceUI() {
  // Show alliance chat icon
  const allianceChatIcon = document.querySelector('[data-action="allianceChat"]');
  if (allianceChatIcon) {
    allianceChatIcon.style.display = '';
  }

  // Show coop button
  const coopBtn = document.querySelector('[data-action="coop"]');
  if (coopBtn) {
    coopBtn.style.display = '';
  }

  // Hide pool button (user is now in alliance)
  const poolBtn = document.getElementById('anyAlliancePoolBtn');
  if (poolBtn) {
    poolBtn.style.display = 'none';
  }

  // Update button visibility
  if (window.updateButtonVisibility) {
    window.updateButtonVisibility('allianceChat', true);
    window.updateButtonVisibility('coop', true);
  }

  // Load and display coop data
  try {
    const response = await fetch(window.apiUrl('/api/coop-vessels'));
    if (response.ok) {
      const coopData = await response.json();
      if (coopData.success && coopData.data) {
        const available = coopData.data.available || 0;
        const cap = coopData.data.cap || 0;

        // Update coop display in header
        if (window.updateCoopDisplay) {
          window.updateCoopDisplay(cap, available);
        }

        // Update coop badge
        const color = available === 0 ? 'GREEN' : 'RED';
        if (window.updateBadge) {
          window.updateBadge('coopBadge', available, available > 0, color);
        }

        // Update coop tab badge
        if (window.updateCoopTabBadge) {
          window.updateCoopTabBadge(available);
        }

        // Save to cache
        if (window.saveBadgeCache) {
          window.saveBadgeCache({ coop: { available, cap } });
        }
      }
    }
  } catch (error) {
    console.error('[Alliance UI] Failed to load coop data:', error);
  }

  // Use existing function to show alliance tabs
  await updateTabVisibilityForAllianceMembers();

  // Set Allianz as active tab
  const allianceTabs = document.querySelectorAll('.alliance-coop-tabs .tab-button');
  allianceTabs.forEach(tab => {
    if (tab.getAttribute('data-tab') === 'allianz') {
      tab.classList.add('tab-active');
    } else {
      tab.classList.remove('tab-active');
    }
  });
}

/**
 * Immediately hides all alliance-specific UI elements after leaving
 */
export async function hideAllAllianceUI() {
  // Update settings to reflect no alliance
  if (window.settings) {
    window.settings.allianceId = null;
  }

  // IMMEDIATELY clear badge cache to prevent stale data on reload
  if (window.saveBadgeCache) {
    window.saveBadgeCache({
      coop: null,
      alliance_chat_unread: 0
    });
  }

  // Hide and clear alliance chat
  const allianceChatIcon = document.querySelector('[data-action="allianceChat"]');
  if (allianceChatIcon) {
    allianceChatIcon.style.display = 'none';
  }

  // Hide alliance chat overlay and clear messages
  const allianceChatOverlay = document.getElementById('allianceChatOverlay');
  if (allianceChatOverlay) {
    allianceChatOverlay.classList.add('hidden');
  }

  const chatFeed = document.getElementById('chatFeed');
  if (chatFeed) {
    chatFeed.innerHTML = '<p style="text-align: center; color: var(--color-text-tertiary); padding: 20px;">Not in an alliance</p>';
  }

  // Update button visibility (hide chat, keep coop visible for search access)
  if (window.updateButtonVisibility) {
    window.updateButtonVisibility('allianceChat', false);
  }

  // Clear coop badge on map icon
  if (window.updateBadge) {
    window.updateBadge('coopBadge', 0, false, 'GREEN');
    window.updateBadge('allianceChatBadge', 0, false, 'RED');
  }

  // Clear coop tab badge
  if (window.updateCoopTabBadge) {
    window.updateCoopTabBadge(0);
  }

  // Clear coop header display
  if (window.updateCoopDisplay) {
    window.updateCoopDisplay(0, 0);
  }

  // Use existing function to hide all alliance tabs except Search
  await updateTabVisibilityForNonMembers();

  // Ensure Search tab is active
  const searchTab = document.querySelector('.tab-button[data-tab="search"]');
  if (searchTab) {
    searchTab.classList.add('tab-active');
  }

  // Clear all tab content areas except search
  const tabContents = document.querySelectorAll('.alliance-tab-content');
  tabContents.forEach(content => {
    if (content.id !== 'searchContent') {
      content.classList.remove('active');
      content.innerHTML = '';
    }
  });

  // Clear tab data cache
  tabDataCache = {
    allianz: null,
    liga: null,
    highscore: null,
    search: null,
    management: null,
    settings: null
  };

  // Reset search state to force fresh search when user opens search tab
  searchState.initialized = false;
  searchState.results = [];
  searchState.offset = 0;
  searchState.query = '';
  searchState.filters = { sortBy: 'name_asc', hasOpenSlots: false };
  searchState.hasMore = true;
}

/**
 * Default welcome message for new members
 */
const DEFAULT_WELCOME_MESSAGE = 'Welcome to our Alliance!\nJoin the Ally Chat and say Hello :)';
const DEFAULT_WELCOME_SUBJECT = 'Welcome to [allianceName]';

/**
 * Loads welcome message from user settings and initializes the textarea
 */
async function loadWelcomeMessage() {
  const subjectInput = document.getElementById('welcomeSubjectInput');
  const textarea = document.getElementById('welcomeMessageInput');
  const charCount = document.getElementById('welcomeMessageCharCount');
  const saveBtn = document.getElementById('saveWelcomeMessageBtn');

  if (!textarea || !charCount || !saveBtn) return;

  // Load from user settings
  try {
    const response = await fetch(window.apiUrl('/api/settings'));
    if (response.ok) {
      const settings = await response.json();
      if (subjectInput) {
        subjectInput.value = settings.allianceWelcomeSubject || DEFAULT_WELCOME_SUBJECT;
      }
      textarea.value = settings.allianceWelcomeMessage || DEFAULT_WELCOME_MESSAGE;
    } else {
      if (subjectInput) {
        subjectInput.value = DEFAULT_WELCOME_SUBJECT;
      }
      textarea.value = DEFAULT_WELCOME_MESSAGE;
    }
  } catch (error) {
    console.error('[Alliance Tabs] Error loading welcome message:', error);
    if (subjectInput) {
      subjectInput.value = DEFAULT_WELCOME_SUBJECT;
    }
    textarea.value = DEFAULT_WELCOME_MESSAGE;
  }

  // Update character count
  updateWelcomeMessageCharCount();

  // Add event listeners
  textarea.addEventListener('input', updateWelcomeMessageCharCount);
  saveBtn.addEventListener('click', saveWelcomeMessage);
}

/**
 * Updates the character count display for welcome message
 */
function updateWelcomeMessageCharCount() {
  const textarea = document.getElementById('welcomeMessageInput');
  const charCount = document.getElementById('welcomeMessageCharCount');

  if (!textarea || !charCount) return;

  const currentLength = textarea.value.length;
  charCount.textContent = `${currentLength} / 900`;
  charCount.className = 'char-count';

  if (currentLength > 800) {
    charCount.classList.add(currentLength > 900 ? 'error' : 'warning');
  }
}

/**
 * Saves welcome message to user settings
 */
async function saveWelcomeMessage() {
  const subjectInput = document.getElementById('welcomeSubjectInput');
  const textarea = document.getElementById('welcomeMessageInput');
  const saveBtn = document.getElementById('saveWelcomeMessageBtn');

  if (!textarea || !saveBtn) return;

  const subject = subjectInput ? subjectInput.value : DEFAULT_WELCOME_SUBJECT;
  const message = textarea.value;

  if (subject.length > 100) {
    showSideNotification('Subject is too long (max 100 characters)', 'error');
    return;
  }

  if (message.length > 900) {
    showSideNotification('Welcome message is too long (max 900 characters)', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    // Get current settings
    const getResponse = await fetch(window.apiUrl('/api/settings'));
    if (!getResponse.ok) throw new Error('Failed to load current settings');
    const currentSettings = await getResponse.json();

    // Update with new welcome subject and message
    currentSettings.allianceWelcomeSubject = subject;
    currentSettings.allianceWelcomeMessage = message;

    // Save settings
    const saveResponse = await fetch(window.apiUrl('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentSettings)
    });

    if (!saveResponse.ok) throw new Error('Failed to save settings');

    showSideNotification('Welcome message saved successfully', 'success');
  } catch (error) {
    console.error('[Alliance Tabs] Error saving welcome message:', error);
    showSideNotification('Failed to save welcome message', 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Welcome Message';
  }
}

/**
 * Sends welcome message to a user via chatbot command
 * @param {number} userId - User ID to send message to
 * @param {string} companyName - Company name of the user (for notification)
 * @returns {Promise<void>} Throws error on failure
 */
async function sendWelcomeMessageToUser(userId, companyName) {
  const response = await fetch(window.apiUrl('/api/alliance-send-welcome'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to send welcome message');
  }

  // Update unread badge to reflect sent message
  if (window.debouncedUpdateUnreadBadge) {
    window.debouncedUpdateUnreadBadge();
  }

  // Show notification
  showSideNotification(`Welcome message sent to ${escapeHtml(companyName)}`, 'success');
}

/**
 * Initializes tab switching functionality
 * ONLY runs once to prevent duplicate event listeners
 */
export function initAllianceTabs() {
  if (isTabsInitialized) {
    return;
  }
  isTabsInitialized = true;

  const tabButtons = document.querySelectorAll('.alliance-coop-tabs .tab-button');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  // Pool button - use event delegation to prevent duplicates
  document.addEventListener('click', async (e) => {
    // Handle Pool button (toggles between join and leave)
    const poolBtn = e.target.closest('#anyAlliancePoolBtn');
    if (poolBtn) {
      e.preventDefault();
      e.stopPropagation();

      const isInPool = poolBtn.classList.contains('pool-leave-btn');

      try {
        if (isInPool) {
          // Leave pool
          const response = await fetch(window.apiUrl('/api/alliance-leave-pool-any'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to leave pool');
          }

          showSideNotification('Left alliance pool', 'success');
        } else {
          // Join pool
          const response = await fetch(window.apiUrl('/api/alliance-join-pool-any'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to join pool');
          }

          showSideNotification('Joined alliance pool', 'success');
        }

        // Force re-render to update button state
        searchState.initialized = false;
        await switchTab('search');
      } catch (error) {
        showSideNotification(`Failed: ${error.message}`, 'error');
      }
      return;
    }
  }, { once: false });
}

/**
 * Switches to a specific tab
 * @param {string} tabName - Name of the tab to switch to
 */
export async function switchTab(tabName) {
  if (!tabName) return;
  if (isTabLoading) return; // Prevent race conditions

  currentTab = tabName;

  // Stop management tab auto-refresh if switching away from management
  if (tabName !== 'management' && managementTabRefreshInterval) {
    clearInterval(managementTabRefreshInterval);
    managementTabRefreshInterval = null;
  }

  // Update tab buttons
  const tabButtons = document.querySelectorAll('.alliance-coop-tabs .tab-button');
  tabButtons.forEach(button => {
    if (button.getAttribute('data-tab') === tabName) {
      button.classList.add('tab-active');
    } else {
      button.classList.remove('tab-active');
    }
  });

  // Update tab content visibility
  const tabContents = document.querySelectorAll('#coopOverlay .tab-content');
  tabContents.forEach(content => {
    const contentId = content.id.replace('TabContent', '').toLowerCase();
    if (contentId === tabName) {
      content.classList.add('tab-active');
    } else {
      content.classList.remove('tab-active');
    }
  });

  // Load content for the selected tab
  isTabLoading = true;
  try {
    await loadTabContent(tabName);
  } finally {
    isTabLoading = false;
  }

  // Start management tab auto-refresh if switching to management
  if (tabName === 'management' && !managementTabRefreshInterval) {
    managementTabRefreshInterval = setInterval(async () => {
      if (currentTab === 'management') {
        try {
          await renderManagementTab();
        } catch (error) {
          console.error('[Alliance Tabs] Management tab refresh error:', error);
        }
      }
    }, 10000);
  }
}

/**
 * Loads content for a specific tab
 * @param {string} tabName - Name of the tab
 */
async function loadTabContent(tabName) {
  try {
    switch (tabName) {
      case 'allianz':
        await renderAllianzTab();
        break;
      case 'coop':
        await renderCoopTab();
        break;
      case 'liga':
        await renderLigaTab();
        break;
      case 'highscore':
        await renderHighScoreTab();
        break;
      case 'search':
        await renderSearchTab();
        break;
      case 'management':
        await renderManagementTab();
        break;
      case 'settings':
        await renderSettingsTab();
        break;
    }
  } catch (error) {
    console.error(`[Alliance Tabs] Error loading ${tabName} tab:`, error);
    const contentDiv = document.getElementById(`${tabName}Content`);
    if (contentDiv) {
      contentDiv.innerHTML = `<p class="alliance-tab-error">Failed to load ${tabName} data. Please try again.</p>`;
    }
  }
}

/**
 * Normalize color hex code (remove alpha channel if present, add # prefix)
 * @param {string} color - Color string (with or without #, may include alpha)
 * @returns {string} Normalized color (#RRGGBB format)
 */
function normalizeColor(color) {
  if (!color) return '#FFFFFF';

  let hex = color.startsWith('#') ? color.substring(1) : color;

  if (hex.length === 8) {
    hex = hex.substring(0, 6);
  }

  return `#${hex}`;
}

/**
 * Generate alliance info HTML (shared between tab and modal)
 * @param {Object} data - Alliance data
 * @param {boolean} showJoinButton - Whether to show join button
 * @param {number} allianceId - Alliance ID for join button
 * @returns {string} HTML string
 */
function generateAllianceInfoHTML(data, showJoinButton = false, allianceId = null) {
  const seasonEndDate = new Date(data.season_end_time * 1000).toLocaleDateString();
  const foundedDate = new Date(data.time_founded * 1000).toLocaleDateString();

  const primaryColor = normalizeColor(data.image_colors.primary);
  const secondaryColors = data.image_colors.secondary || ['FFFFFF', 'FFFFFF'];
  const gradientColor1 = normalizeColor(secondaryColors[0]);
  const gradientColor2 = normalizeColor(secondaryColors[1] || secondaryColors[0]);
  const gradientBg = `linear-gradient(${gradientColor1} 0%, ${gradientColor2} 100%)`;

  const logoSvgUrl = data.image ? window.apiUrl(`/api/alliance-logo/${data.image}?color=${encodeURIComponent(primaryColor)}`) : '';
  const logoInitials = data.name.substring(0, 2).toUpperCase();

  const joinButtonHtml = showJoinButton ? `<button class="vessel-buy-btn join-alliance-btn" data-alliance-id="${allianceId}">Join Alliance</button>` : '';

  return `
    <div class="alliance-info-header">
      <div class="alliance-logo-container">
        <div class="alliance-logo-wrapper large" style="background: ${gradientBg};">
          <img src="${logoSvgUrl}" alt="${escapeHtml(data.name)}" class="alliance-logo-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
          <span class="alliance-logo-text" style="color: ${primaryColor}; display: none;">${logoInitials}</span>
        </div>
      </div>
      <div class="alliance-header-info">
        <div style="display: flex; align-items: center; gap: var(--spacing-12);">
          <h3 class="alliance-name">${escapeHtml(data.name)}</h3>
          ${joinButtonHtml}
        </div>
        <div class="alliance-meta">
          <span>Members: ${data.members}</span>
          <span>Language: ${data.language}</span>
          <span>Founded: ${foundedDate}</span>
          ${allianceId ? `<span>ID: ${allianceId}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="alliance-description">
      ${escapeHtml(data.description || 'No description available.')}
    </div>

    <div class="alliance-stats-grid">
      <div class="alliance-stat-card">
        <h4>League Info</h4>
        <div class="stat-row">
          <span>League Level:</span>
          <span class="stat-value">${data.league_level}</span>
        </div>
        <div class="stat-row">
          <span>Group Position:</span>
          <span class="stat-value">#${data.group_position}</span>
        </div>
        <div class="stat-row">
          <span>Promotion:</span>
          <span class="stat-value ${data.promotion ? 'stat-success' : ''}">${data.promotion ? 'Yes' : 'No'}</span>
        </div>
        <div class="stat-row">
          <span>Season Ends:</span>
          <span class="stat-value">${seasonEndDate}</span>
        </div>
        <div class="stat-row">
          <span>Coop Status:</span>
          <span class="stat-value">${data.coop.used}/${data.coop.needed}</span>
        </div>
      </div>

      <div class="alliance-stat-card">
        <h4>Benefits (Level ${data.benefit_level})</h4>
        <div class="stat-row">
          <span>Reputation Boost:</span>
          <span class="stat-value stat-boost">+${data.benefit.rep_boost}%</span>
        </div>
        <div class="stat-row">
          <span>Demand Boost:</span>
          <span class="stat-value stat-boost">+${data.benefit.demand_boost}%</span>
        </div>
        <div class="stat-row">
          <span>Coop Boost:</span>
          <span class="stat-value stat-boost">+${data.benefit.coop_boost}</span>
        </div>
        <div class="stat-row">
          <span>Points Spent:</span>
          <span class="stat-value">${formatNumber(data.benefit.points_spend)}</span>
        </div>
        <div class="stat-row">
          <span>Departures:</span>
          <span class="stat-value">${formatNumber(data.benefit.departures)}</span>
        </div>
      </div>

      <div class="alliance-stat-card">
        <h4>Season Stats</h4>
        <div class="stat-row">
          <span>Departures (24h):</span>
          <span class="stat-value">${formatNumber(data.stats.departures_24h)}</span>
        </div>
        <div class="stat-row">
          <span>Contribution (24h):</span>
          <span class="stat-value">${formatNumber(data.stats.contribution_score_24h)}</span>
        </div>
        <div class="stat-row">
          <span>Coops (24h):</span>
          <span class="stat-value">${formatNumber(data.stats.coops_24h)}</span>
        </div>
        <div class="stat-row">
          <span>Season Departures:</span>
          <span class="stat-value">${formatNumber(data.stats.season_departures)}</span>
        </div>
        <div class="stat-row">
          <span>Season Contribution:</span>
          <span class="stat-value">${formatNumber(data.stats.season_contribution_score)}</span>
        </div>
        <div class="stat-row">
          <span>Season Coops:</span>
          <span class="stat-value">${formatNumber(data.stats.season_coops)}</span>
        </div>
      </div>

      <div class="alliance-stat-card">
        <h4>Historical Stats</h4>
        <div class="stat-row">
          <span>Total Departures:</span>
          <span class="stat-value">${formatNumber(data.stats.total_departures)}</span>
        </div>
        <div class="stat-row">
          <span>Total Contribution:</span>
          <span class="stat-value">${formatNumber(data.stats.total_contribution_score)}</span>
        </div>
        <div class="stat-row">
          <span>Total Coops:</span>
          <span class="stat-value">${formatNumber(data.stats.total_coops)}</span>
        </div>
        <div class="stat-row">
          <span>Total Share Value:</span>
          <span class="stat-value">$${formatNumber(data.total_share_value)}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the Allianz tab content
 */
async function renderAllianzTab() {
  const content = document.getElementById('allianzContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading alliance info...</p>';

  const [data, membersResponse] = await Promise.all([
    fetchAllianceInfo(),
    fetchAllianceMembers()
  ]);

  if (data.no_alliance) {
    content.innerHTML = '<p class="alliance-tab-error">You are not in an alliance.</p>';
    return;
  }

  const membersData = membersResponse.members || membersResponse;
  const lastSeasonTopContributors = membersResponse.last_season_top_contributors || [];

  tabDataCache.allianz = data;

  let html = generateAllianceInfoHTML(data);

  const roleGroups = {
    ceo: { title: 'CEO', emoji: '👨‍✈️', members: [] },
    coo: { title: 'COO', emoji: '👨‍💼', members: [] },
    management: { title: 'Management', emoji: '🧑‍💻', members: [] },
    member: { title: 'Members', emoji: '🦸‍♂️', members: [] }
  };

  membersData.forEach(member => {
    const role = member.role || 'member';
    if (roleGroups[role]) {
      roleGroups[role].members.push(member);
    } else {
      roleGroups.member.members.push(member);
    }
  });

  if (lastSeasonTopContributors.length > 0) {
    html += `
      <div class="top-contributors-section">
        <h3>Top Contributors - Last Season</h3>
        <table class="top-contributors-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Member</th>
              <th>Contribution</th>
              <th>Reward</th>
            </tr>
          </thead>
          <tbody>
    `;

    lastSeasonTopContributors.forEach((contributor, index) => {
      const member = membersData.find(m => m.user_id === contributor.user_id);
      const memberName = member ? escapeHtml(member.company_name) : 'Unknown';
      const rank = index + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
      const reward = contributor.point_reward;

      html += `
        <tr>
          <td class="rank-cell">${rank}</td>
          <td class="member-cell"><span class="clickable alliance-member-name" data-user-id="${contributor.user_id}">${memberName}</span></td>
          <td class="contribution-cell">${formatNumber(contributor.contribution_score_sum)}</td>
          <td class="reward-cell">${medal} ${reward} Diamanten</td>
        </tr>
      `;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
  }

  html += `
    <div class="members-section-header">
      <h3>Alliance Members (${membersData.length})</h3>
      <select class="member-sort-dropdown" id="memberSortDropdown">
        <option value="contribution-24h-desc">24h Contribution ↓</option>
        <option value="contribution-24h-asc">24h Contribution ↑</option>
        <option value="departures-24h-desc">24h Departures ↓</option>
        <option value="departures-24h-asc">24h Departures ↑</option>
        <option value="contribution-season-desc">Season Contribution ↓</option>
        <option value="contribution-season-asc">Season Contribution ↑</option>
        <option value="departures-season-desc">Season Departures ↓</option>
        <option value="departures-season-asc">Season Departures ↑</option>
        <option value="contribution-lifetime-desc">Lifetime Contribution ↓</option>
        <option value="contribution-lifetime-asc">Lifetime Contribution ↑</option>
        <option value="departures-lifetime-desc">Lifetime Departures ↓</option>
        <option value="departures-lifetime-asc">Lifetime Departures ↑</option>
        <option value="joined-desc">Joined ↓</option>
        <option value="joined-asc">Joined ↑</option>
        <option value="lastlogin-desc">Last Login ↓</option>
        <option value="lastlogin-asc">Last Login ↑</option>
      </select>
    </div>
    <div class="members-grid" id="membersGrid"></div>
  `;

  content.innerHTML = html;

  // Add click listeners for top contributors
  content.querySelectorAll('.top-contributors-table .alliance-member-name.clickable').forEach(nameEl => {
    nameEl.addEventListener('click', async () => {
      const userId = parseInt(nameEl.getAttribute('data-user-id'));
      await openPlayerProfile(userId, true);
    });
  });

  function renderMembers(sortBy = 'contribution-24h', sortOrder = 'desc') {
    const allMembers = [];
    const groupOrder = ['ceo', 'coo', 'management', 'member'];
    groupOrder.forEach(roleKey => {
      const group = roleGroups[roleKey];
      group.members.forEach(m => {
        allMembers.push({ ...m, roleGroup: group });
      });
    });

    allMembers.sort((a, b) => {
      let aVal, bVal;

      const aStats = a.stats || { last_24h: { contribution: 0, departures: 0 }, last_season: { contribution: 0, departures: 0 }, lifetime: { contribution: 0, departures: 0 } };
      const bStats = b.stats || { last_24h: { contribution: 0, departures: 0 }, last_season: { contribution: 0, departures: 0 }, lifetime: { contribution: 0, departures: 0 } };

      if (sortBy === 'contribution-24h') {
        aVal = aStats.last_24h.contribution || 0;
        bVal = bStats.last_24h.contribution || 0;
      } else if (sortBy === 'departures-24h') {
        aVal = aStats.last_24h.departures || 0;
        bVal = bStats.last_24h.departures || 0;
      } else if (sortBy === 'contribution-season') {
        aVal = aStats.last_season.contribution || 0;
        bVal = bStats.last_season.contribution || 0;
      } else if (sortBy === 'departures-season') {
        aVal = aStats.last_season.departures || 0;
        bVal = bStats.last_season.departures || 0;
      } else if (sortBy === 'contribution-lifetime') {
        aVal = aStats.lifetime.contribution || 0;
        bVal = bStats.lifetime.contribution || 0;
      } else if (sortBy === 'departures-lifetime') {
        aVal = aStats.lifetime.departures || 0;
        bVal = bStats.lifetime.departures || 0;
      } else if (sortBy === 'joined') {
        aVal = a.time_joined || 0;
        bVal = b.time_joined || 0;
      } else if (sortBy === 'lastlogin') {
        aVal = a.time_last_login || 0;
        bVal = b.time_last_login || 0;
      }

      if (sortOrder === 'desc') {
        return bVal - aVal;
      } else {
        return aVal - bVal;
      }
    });

    let membersHtml = '';
    allMembers.forEach(m => {
      const joinedDate = m.time_joined ? new Date(m.time_joined * 1000).toLocaleDateString() : '-';
      const lastLoginDate = m.time_last_login ? new Date(m.time_last_login * 1000).toLocaleDateString() : '-';

      let badges = '';
      if (m.tanker_ops) badges += '<span title="Tanker Operations">⛽</span> ';
      if (m.is_rookie) badges += '<span title="Rookie">🤏</span> ';
      if (m.difficulty === 'realism') badges += '<span title="Realism Mode">🤘</span>';
      else if (m.difficulty === 'easy') badges += '<span title="Easy Mode">✌️</span>';

      let shareValueHtml = '';
      if (m.share_value !== undefined && m.share_value !== null) {
        const trendArrow = m.stock_trend === 'up' ? '↑' : m.stock_trend === 'down' ? '↓' : '';
        shareValueHtml = `
          <div class="stat-row">
            <span>Share Value:</span>
            <span class="stat-value">$${formatNumber(m.share_value)} ${trendArrow}</span>
          </div>`;
      }

      const stats = m.stats || {
        last_24h: { contribution: 0, departures: 0 },
        last_season: { contribution: 0, departures: 0 },
        lifetime: { contribution: 0, departures: 0 }
      };

      membersHtml += `
        <div class="alliance-stat-card member-card">
          <h4>
            <span title="${m.roleGroup.title}">${m.roleGroup.emoji}</span> <span class="clickable alliance-member-name" data-user-id="${m.user_id}">${escapeHtml(m.company_name)}</span>
            <span class="member-badges">${badges}</span>
          </h4>
          ${shareValueHtml}
          <div class="stat-row">
            <span>24h Contribution:</span>
            <span class="stat-value">${formatNumber(stats.last_24h.contribution)}</span>
          </div>
          <div class="stat-row">
            <span>24h Departures:</span>
            <span class="stat-value">${formatNumber(stats.last_24h.departures)}</span>
          </div>
          <div class="stat-row">
            <span>Season Contribution:</span>
            <span class="stat-value">${formatNumber(stats.last_season.contribution)}</span>
          </div>
          <div class="stat-row">
            <span>Season Departures:</span>
            <span class="stat-value">${formatNumber(stats.last_season.departures)}</span>
          </div>
          <div class="stat-row">
            <span>Lifetime Contribution:</span>
            <span class="stat-value">${formatNumber(stats.lifetime.contribution)}</span>
          </div>
          <div class="stat-row">
            <span>Lifetime Departures:</span>
            <span class="stat-value">${formatNumber(stats.lifetime.departures)}</span>
          </div>
          <div class="stat-row">
            <span>Joined:</span>
            <span class="stat-value">${joinedDate}</span>
          </div>
          <div class="stat-row">
            <span>Last Login:</span>
            <span class="stat-value">${lastLoginDate}</span>
          </div>
          <button class="member-donate-btn" data-user-id="${m.user_id}" data-user-name="${escapeHtml(m.company_name)}">💎 Donate</button>
        </div>
      `;
    });

    document.getElementById('membersGrid').innerHTML = membersHtml;

    // Add click listeners for member names
    document.querySelectorAll('#membersGrid .alliance-member-name.clickable').forEach(nameEl => {
      nameEl.addEventListener('click', async () => {
        const userId = parseInt(nameEl.getAttribute('data-user-id'));
        await openPlayerProfile(userId, true);
      });
    });

    // Add click listeners for donate buttons
    document.querySelectorAll('#membersGrid .member-donate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = parseInt(btn.getAttribute('data-user-id'));
        const userName = btn.getAttribute('data-user-name');
        await showDonateDialog(userId, userName, membersData.length);
      });
    });
  }

  renderMembers();

  document.getElementById('memberSortDropdown').addEventListener('change', (e) => {
    const value = e.target.value;
    const lastDashIndex = value.lastIndexOf('-');
    const sortBy = value.substring(0, lastDashIndex);
    const sortOrder = value.substring(lastDashIndex + 1);
    renderMembers(sortBy, sortOrder);
  });
}

/**
 * Renders the Coop tab content (uses existing coop.js functionality)
 */
async function renderCoopTab() {
  const content = document.getElementById('coopContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading coop data...</p>';

  const data = await fetchCoopData();
  const coop = data.data?.coop;
  const members = data.data?.members_coop || [];

  if (!coop) {
    content.innerHTML = '<p class="alliance-tab-error">Failed to load coop data</p>';
    return;
  }

  // Get own user ID from API response
  const myUserId = data.user?.id;

  // Update coop tab badge with REAL data from API
  if (window.updateCoopTabBadge) {
    window.updateCoopTabBadge(coop.available);
  }

  // Separate members into categories
  const activeMembers = [];
  const disabledMembers = [];
  const outOfOrderMembers = [];
  let myUser = null;

  members.forEach(member => {
    if (member.user_id === myUserId) {
      myUser = member;
      return;
    }

    if (!member.enabled) {
      disabledMembers.push(member);
    } else {
      const hasBlockingRestrictions = member.restrictions.some(r => {
        if (r.blocking === true || r.type === 'low_fuel' || r.type === 'time_restriction' || r.type === 'no_vessels') {
          return true;
        }

        if (r.type === 'time_setting' && r.startHourUTC !== undefined && r.endHourUTC !== undefined) {
          const now = new Date();
          const currentHourUTC = now.getUTCHours();

          let isWithinWindow = false;
          if (r.startHourUTC <= r.endHourUTC) {
            isWithinWindow = currentHourUTC >= r.startHourUTC && currentHourUTC < r.endHourUTC;
          } else {
            isWithinWindow = currentHourUTC >= r.startHourUTC || currentHourUTC < r.endHourUTC;
          }

          return !isWithinWindow;
        }

        return false;
      });

      if (hasBlockingRestrictions) {
        outOfOrderMembers.push(member);
      } else {
        activeMembers.push(member);
      }
    }
  });

  let html = `
    <div class="coop-stats-box">
      <h3 class="coop-stats-title">Your Co-Op Stats</h3>
      <table class="coop-stats-table">
        <tr>
          <td class="coop-stat-label">Co-Op total:</td>
          <td class="coop-stat-value coop-stat-max">${coop.coop_boost || coop.cap}</td>
          <td class="coop-stat-label">Co-Op available:</td>
          <td class="coop-stat-value coop-stat-available">${coop.available}</td>
        </tr>
        <tr>
          <td class="coop-stat-label">Sent this season:</td>
          <td class="coop-stat-value coop-stat-sent">${coop.sent_this_season || 0}</td>
          <td class="coop-stat-label">Received this season:</td>
          <td class="coop-stat-value coop-stat-received">${coop.received_this_season || 0}</td>
        </tr>
        <tr>
          <td class="coop-stat-label">Sent historical:</td>
          <td class="coop-stat-value coop-stat-sent-hist">${coop.sent_historical || 0}</td>
          <td class="coop-stat-label">Received historical:</td>
          <td class="coop-stat-value coop-stat-received-hist">${coop.received_historical || 0}</td>
        </tr>
      </table>
    </div>
  `;

  // Render active members
  if (activeMembers.length > 0) {
    html += `<h3 class="coop-section-header coop-section-active">Active (${activeMembers.length})</h3>`;
    activeMembers.sort((a, b) => b.total_vessels - a.total_vessels);

    activeMembers.forEach(member => {
      const hasBlockingRestriction = member.restrictions.some(r =>
        r.blocking === true || r.type === 'no_vessels'
      );
      const shouldDisableButton = coop.available === 0 || hasBlockingRestriction;
      const buttonText = coop.available === 0 ? 'No Coop Tickets<br>available' : 'Send max';

      html += renderMemberCard(member, true, shouldDisableButton, buttonText);
    });
  }

  // Render out of order members
  if (outOfOrderMembers.length > 0) {
    html += `<h3 class="coop-section-header coop-section-warning">Out of Order (${outOfOrderMembers.length})</h3>`;
    outOfOrderMembers.sort((a, b) => b.total_vessels - a.total_vessels);

    outOfOrderMembers.forEach(member => {
      html += renderMemberCard(member, true, true);
    });
  }

  // Render disabled members
  if (disabledMembers.length > 0) {
    html += `<h3 class="coop-section-header coop-section-disabled">COOP Disabled (${disabledMembers.length})</h3>`;
    disabledMembers.sort((a, b) => b.total_vessels - a.total_vessels);

    disabledMembers.forEach(member => {
      html += renderMemberCard(member, true, true);
    });
  }

  // Render own user at the bottom
  if (myUser) {
    html += `<h3 class="coop-section-header coop-section-you">You</h3>`;
    html += renderMemberCard(myUser, false, false);
  }

  if (activeMembers.length === 0 && outOfOrderMembers.length === 0 && disabledMembers.length === 0) {
    html += '<p class="coop-empty-message">No members available for coop</p>';
  }

  content.innerHTML = html;

  // Attach click handlers to member names
  content.querySelectorAll('.coop-member-name.clickable').forEach(nameEl => {
    nameEl.addEventListener('click', async () => {
      const userId = parseInt(nameEl.getAttribute('data-user-id'));
      await openPlayerProfile(userId, true);
    });
  });
}

/**
 * Renders a single member card for the coop tab
 * @param {Object} member - Member data
 * @param {boolean} showButton - Whether to show the send button
 * @param {boolean} disabled - Whether the button should be disabled
 * @param {string} buttonText - Optional custom button text
 * @returns {string} HTML string for member card
 */
function renderMemberCard(member, showButton = true, disabled = false, buttonText = 'Send max') {
  const fuelFormatted = formatNumber(member.fuel);

  let borderClass = 'coop-card-neutral';
  if (disabled) {
    borderClass = 'coop-card-disabled';
  }

  let restrictionsHtml = '';
  if (member.restrictions && member.restrictions.length > 0) {
    restrictionsHtml = '<div class="coop-restrictions">';
    member.restrictions.forEach(r => {
      let message = r.message;

      if ((r.type === 'time_setting' || r.type === 'time_restriction') && r.startHourUTC !== undefined) {
        const now = new Date();
        const startUTC = new Date(now);
        startUTC.setUTCHours(r.startHourUTC, 0, 0, 0);
        const endUTC = new Date(now);
        endUTC.setUTCHours(r.endHourUTC === 0 ? 24 : r.endHourUTC, 0, 0, 0);

        const startLocal = String(startUTC.getHours()).padStart(2, '0') + ':00';
        const endLocal = String(endUTC.getHours()).padStart(2, '0') + ':00';

        message = `Only accepts ${startLocal}-${endLocal}`;
      }

      if (message) {
        restrictionsHtml += `<span class="coop-restriction-warning">${escapeHtml(message)}</span>`;
      }
    });
    restrictionsHtml += '</div>';
  }

  let buttonHtml = '';
  if (showButton) {
    if (!disabled) {
      buttonHtml = `<button onclick="window.sendCoopMax(${member.user_id})" class="coop-send-btn" data-permanently-disabled="false">${buttonText}</button>`;
    } else {
      buttonHtml = `<button disabled class="coop-send-btn" data-permanently-disabled="true">${buttonText}</button>`;
    }
  }

  return `
    <div class="coop-member-card ${borderClass}">
      <div class="coop-card-content">
        <div class="coop-card-info">
          <div class="coop-member-name clickable" data-user-id="${member.user_id}">${escapeHtml(member.company_name)}</div>
          <div class="coop-member-stats">
            <div>${member.total_vessels} vessels</div>
            <div>${fuelFormatted}t fuel</div>
          </div>
          ${restrictionsHtml}
        </div>
        ${buttonHtml}
      </div>
    </div>
  `;
}

/**
 * Renders the Liga tab content
 */
async function renderLigaTab() {
  const content = document.getElementById('ligaContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading league info...</p>';

  const data = await fetchLeagueInfo();
  tabDataCache.liga = data;

  const league = data.league;
  const userAllianceId = data.user_alliance_id || window.settings?.allianceId;

  const seasonEndDate = new Date(league.time_season_end * 1000);
  const seasonEndStr = seasonEndDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });

  let html = `
    <div class="league-container">
      <div class="league-header">
        <h3>League ${league.level} - Group ${league.group}</h3>
        <div class="league-season-info">
          <span>Season ends: ${seasonEndStr}</span>
        </div>
      </div>

      <div class="league-standings">
  `;

  const sortedAlliances = [...league.alliances].sort((a, b) => a.group_position - b.group_position);

  sortedAlliances.forEach((alliance) => {
    const isUserAlliance = alliance.id === userAllianceId;
    const positionClass = alliance.group_position <= 3 ? `league-top-${alliance.group_position}` : '';
    const userClass = isUserAlliance ? 'league-user-alliance' : '';

    const medal = alliance.group_position === 1 ? '🥇' : alliance.group_position === 2 ? '🥈' : alliance.group_position === 3 ? '🥉' : '';

    const promotionBadge = alliance.promotion ? '<span class="league-promotion-badge">↑ Promotion</span>' : '';
    const topTierBadge = alliance.top_tier_reward ? '<span class="league-top-tier-badge">⭐ Top Tier</span>' : '';
    const handicapBadge = alliance.league_handicap > 0 ? `<span class="league-handicap-badge">Handicap ${alliance.league_handicap}</span>` : '';

    const foundedDate = new Date(alliance.time_founded * 1000);
    const foundedStr = foundedDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });

    const languageFlag = alliance.language ? alliance.language.substring(3, 5).toUpperCase() : '';

    const primaryColor = normalizeColor(alliance.image_colors.primary);
    const secondaryColors = alliance.image_colors.secondary || ['FFFFFF', 'FFFFFF'];
    const gradientColor1 = normalizeColor(secondaryColors[0]);
    const gradientColor2 = normalizeColor(secondaryColors[1] || secondaryColors[0]);
    const gradient = `linear-gradient(${gradientColor1} 0%, ${gradientColor2} 100%)`;

    const logoInitials = alliance.name.substring(0, 2).toUpperCase();

    html += `
      <div class="league-alliance-row ${positionClass} ${userClass}">
        <div class="league-position">
          <span class="league-rank">${medal} #${alliance.group_position}</span>
        </div>
        <div class="league-alliance-logo">
          <div class="alliance-logo-wrapper" style="background: ${gradient};">
            <img src="/api/alliance-logo/${alliance.image}?color=${encodeURIComponent(primaryColor)}" alt="${escapeHtml(alliance.name)}" class="alliance-logo-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
            <span class="alliance-logo-text" style="color: ${primaryColor}; display: none;">${logoInitials}</span>
          </div>
        </div>
        <div class="league-alliance-info">
          <div class="league-alliance-name clickable" data-alliance-id="${alliance.id}">
            ${escapeHtml(alliance.name)}
            ${languageFlag ? `<span class="league-language-flag">${languageFlag}</span>` : ''}
            ${isUserAlliance ? '<span class="league-you-badge">YOU</span>' : ''}
            ${promotionBadge}
            ${topTierBadge}
            ${handicapBadge}
          </div>
          <div class="league-alliance-meta">
            <span>Level ${alliance.benefit_level}</span>
            <span>${alliance.members} members</span>
            <span>${formatNumber(alliance.total_share_value)} share value</span>
            <span>League ${alliance.league_level}</span>
            <span>Founded ${foundedStr}</span>
          </div>
        </div>
        <div class="league-stats">
          <div class="league-stat-item">
            <span class="league-stat-label">Season</span>
            <span class="league-stat-value">${formatNumber(alliance.stats.season_contribution_score)}</span>
          </div>
          <div class="league-stat-item">
            <span class="league-stat-label">24h</span>
            <span class="league-stat-value">${formatNumber(alliance.stats.contribution_score_24h)}</span>
          </div>
        </div>
      </div>
    `;
  });

  html += `
      </div>
    </div>
  `;

  content.innerHTML = html;

  const allianceNames = content.querySelectorAll('.league-alliance-name.clickable');
  allianceNames.forEach(nameEl => {
    nameEl.addEventListener('click', async () => {
      const allianceId = parseInt(nameEl.getAttribute('data-alliance-id'));
      await showAllianceDetailsModal(allianceId);
    });
  });
}

/**
 * Renders the HighScore tab content
 */
async function renderHighScoreTab() {
  const content = document.getElementById('highscoreContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading high scores...</p>';

  const data = await fetchHighScores();
  tabDataCache.highscore = data;

  const alliances = data.highscores?.alliances || data.alliances || [];
  const userAllianceId = window.settings?.allianceId;

  let html = `
    <div class="league-container">
      <div class="league-header">
        <h3>Alliance Leaderboard</h3>
      </div>
      <div class="league-standings">
  `;

  if (alliances.length > 0) {
    alliances.forEach((alliance, index) => {
      const position = index + 1;
      const positionClass = position <= 3 ? `league-top-${position}` : '';
      const isUserAlliance = alliance.id === userAllianceId;
      const userClass = isUserAlliance ? 'league-user-alliance' : '';

      const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : '';

      const primaryColor = normalizeColor(alliance.image_colors.primary);
      const secondaryColors = alliance.image_colors.secondary || ['FFFFFF', 'FFFFFF'];
      const gradientColor1 = normalizeColor(secondaryColors[0]);
      const gradientColor2 = normalizeColor(secondaryColors[1] || secondaryColors[0]);
      const gradient = `linear-gradient(${gradientColor1} 0%, ${gradientColor2} 100%)`;

      const logoInitials = alliance.name.substring(0, 2).toUpperCase();
      const languageFlag = alliance.language ? alliance.language.substring(3, 5).toUpperCase() : '';

      const foundedDate = new Date(alliance.time_founded * 1000);
      const foundedStr = foundedDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });

      html += `
        <div class="league-alliance-row ${positionClass} ${userClass}">
          <div class="league-position">
            <span class="league-rank">${medal} #${position}</span>
          </div>
          <div class="league-alliance-logo">
            <div class="alliance-logo-wrapper" style="background: ${gradient};">
              <img src="/api/alliance-logo/${alliance.image}?color=${encodeURIComponent(primaryColor)}" alt="${escapeHtml(alliance.name)}" class="alliance-logo-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
              <span class="alliance-logo-text" style="color: ${primaryColor}; display: none;">${logoInitials}</span>
            </div>
          </div>
          <div class="league-alliance-info">
            <div class="league-alliance-name clickable" data-alliance-id="${alliance.id}">
              ${escapeHtml(alliance.name)}
              ${languageFlag ? `<span class="league-language-flag">${languageFlag}</span>` : ''}
              ${isUserAlliance ? '<span class="league-you-badge">YOU</span>' : ''}
            </div>
            <div class="league-alliance-meta">
              <span>Level ${alliance.benefit_level}</span>
              <span>${alliance.members} members</span>
              <span>League ${alliance.league_level}</span>
              <span>Founded ${foundedStr}</span>
            </div>
          </div>
          <div class="league-stats">
            <div class="league-stat-item">
              <span class="league-stat-label">Contribution</span>
              <span class="league-stat-value">${formatNumber(alliance.stats.contribution)}</span>
            </div>
          </div>
        </div>
      `;
    });
  } else {
    html += '<p class="league-empty">No alliance data available.</p>';
  }

  html += `
      </div>
    </div>
  `;

  content.innerHTML = html;

  const allianceNames = content.querySelectorAll('.league-alliance-name.clickable');
  allianceNames.forEach(nameEl => {
    nameEl.addEventListener('click', async () => {
      const allianceId = parseInt(nameEl.getAttribute('data-alliance-id'));
      await showAllianceDetailsModal(allianceId);
    });
  });
}

/**
 * Shows a modal with alliance details
 * @param {number} allianceId - The alliance ID to show details for
 */
async function showAllianceDetailsModal(allianceId) {
  // Create modal overlay if it doesn't exist
  let modal = document.getElementById('allianceDetailsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'allianceDetailsModal';
    modal.className = 'overlay';
    document.body.appendChild(modal);
  }

  // Show loading state with standard window structure
  modal.innerHTML = `
    <div class="messenger-window">
      <div class="messenger-header">
        <h2>🤝 Alliance Information</h2>
        <button class="close-btn alliance-details-close-btn"><span>×</span></button>
      </div>
      <div class="alliance-details-content">
        <p class="alliance-tab-loading">Loading alliance details...</p>
      </div>
    </div>
  `;
  modal.classList.remove('hidden');

  // Add close button listener
  modal.querySelector('.alliance-details-close-btn').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  try {
    const [data, membersResponse] = await Promise.all([
      fetchAllianceInfoById(allianceId),
      fetchAllianceMembersById(allianceId)
    ]);

    const members = membersResponse.members || membersResponse;
    const lastSeasonTopContributors = membersResponse.last_season_top_contributors || [];

    // Group members by role
    const roleGroups = {
      ceo: { title: 'CEO', emoji: '👨‍✈️', members: [] },
      coo: { title: 'COO', emoji: '👨‍💼', members: [] },
      management: { title: 'Management', emoji: '🧑‍💻', members: [] },
      member: { title: 'Members', emoji: '🦸‍♂️', members: [] }
    };

    members.forEach(member => {
      const role = member.role || 'member';
      if (roleGroups[role]) {
        roleGroups[role].members.push(member);
      } else {
        roleGroups.member.members.push(member);
      }
    });

    // Check if user has alliance and if this alliance is open for joining
    const userAllianceInfo = await fetchAllianceInfo();
    const userHasAlliance = !userAllianceInfo.no_alliance;
    const isOpenAlliance = data.members < 50;
    const showJoinButton = !userHasAlliance && isOpenAlliance;

    // Build top contributors section HTML
    let topContributorsHtml = '';
    if (lastSeasonTopContributors.length > 0) {
      topContributorsHtml = `
        <div class="top-contributors-section">
          <h3>Top Contributors - Last Season</h3>
          <table class="top-contributors-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Member</th>
                <th>Contribution</th>
                <th>Reward</th>
              </tr>
            </thead>
            <tbody>
      `;

      lastSeasonTopContributors.forEach((contributor, index) => {
        const member = members.find(m => m.user_id === contributor.user_id);
        const memberName = member ? escapeHtml(member.company_name) : 'Unknown';
        const rank = index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
        const reward = contributor.point_reward;

        topContributorsHtml += `
          <tr>
            <td class="rank-cell">${rank}</td>
            <td class="member-cell"><span class="clickable alliance-member-name" data-user-id="${contributor.user_id}">${memberName}</span></td>
            <td class="contribution-cell">${formatNumber(contributor.contribution_score_sum)}</td>
            <td class="reward-cell">${medal} ${reward} 💎</td>
          </tr>
        `;
      });

      topContributorsHtml += `
            </tbody>
          </table>
        </div>
      `;
    }

    // Update content area with alliance data (using shared HTML generator)
    const contentArea = modal.querySelector('.alliance-details-content');
    contentArea.innerHTML = `
        ${generateAllianceInfoHTML(data, showJoinButton, allianceId)}

        ${topContributorsHtml}

        <div class="members-section-header">
          <h3>Members (${members.length})</h3>
          <select class="member-sort-dropdown" id="externalAllianceMemberSortDropdown">
            <option value="contribution-24h-desc">24h Contribution ↓</option>
            <option value="contribution-24h-asc">24h Contribution ↑</option>
            <option value="departures-24h-desc">24h Departures ↓</option>
            <option value="departures-24h-asc">24h Departures ↑</option>
            <option value="contribution-season-desc">Season Contribution ↓</option>
            <option value="contribution-season-asc">Season Contribution ↑</option>
            <option value="departures-season-desc">Season Departures ↓</option>
            <option value="departures-season-asc">Season Departures ↑</option>
            <option value="contribution-lifetime-desc">Lifetime Contribution ↓</option>
            <option value="contribution-lifetime-asc">Lifetime Contribution ↑</option>
            <option value="departures-lifetime-desc">Lifetime Departures ↓</option>
            <option value="departures-lifetime-asc">Lifetime Departures ↑</option>
            <option value="joined-desc">Joined ↓</option>
            <option value="joined-asc">Joined ↑</option>
            <option value="lastlogin-desc">Last Login ↓</option>
            <option value="lastlogin-asc">Last Login ↑</option>
          </select>
        </div>

        <div class="alliance-stats-grid" id="externalAllianceMembersGrid"></div>
    `;

    function renderExternalAllianceMembers(sortBy = 'contribution-24h', sortOrder = 'desc') {
      const allMembers = [];
      const groupOrder = ['ceo', 'coo', 'management', 'member'];
      groupOrder.forEach(roleKey => {
        const group = roleGroups[roleKey];
        group.members.forEach(m => {
          allMembers.push({ ...m, roleGroup: group });
        });
      });

      allMembers.sort((a, b) => {
        let aVal, bVal;

        const aStats = a.stats || { last_24h: { contribution: 0, departures: 0 }, last_season: { contribution: 0, departures: 0 }, lifetime: { contribution: 0, departures: 0 } };
        const bStats = b.stats || { last_24h: { contribution: 0, departures: 0 }, last_season: { contribution: 0, departures: 0 }, lifetime: { contribution: 0, departures: 0 } };

        if (sortBy === 'contribution-24h') {
          aVal = aStats.last_24h.contribution || 0;
          bVal = bStats.last_24h.contribution || 0;
        } else if (sortBy === 'departures-24h') {
          aVal = aStats.last_24h.departures || 0;
          bVal = bStats.last_24h.departures || 0;
        } else if (sortBy === 'contribution-season') {
          aVal = aStats.last_season.contribution || 0;
          bVal = bStats.last_season.contribution || 0;
        } else if (sortBy === 'departures-season') {
          aVal = aStats.last_season.departures || 0;
          bVal = bStats.last_season.departures || 0;
        } else if (sortBy === 'contribution-lifetime') {
          aVal = aStats.lifetime.contribution || 0;
          bVal = bStats.lifetime.contribution || 0;
        } else if (sortBy === 'departures-lifetime') {
          aVal = aStats.lifetime.departures || 0;
          bVal = bStats.lifetime.departures || 0;
        } else if (sortBy === 'joined') {
          aVal = a.time_joined || 0;
          bVal = b.time_joined || 0;
        } else if (sortBy === 'lastlogin') {
          aVal = a.time_last_login || 0;
          bVal = b.time_last_login || 0;
        }

        if (sortOrder === 'desc') {
          return bVal - aVal;
        } else {
          return aVal - bVal;
        }
      });

      let membersHtml = '';
      allMembers.forEach(m => {
        const joinedDate = m.time_joined ? new Date(m.time_joined * 1000).toLocaleDateString() : '-';
        const lastLoginDate = m.time_last_login ? new Date(m.time_last_login * 1000).toLocaleDateString() : '-';
        const shareValue = m.share_value !== undefined ? `$${formatNumber(m.share_value)}` : '-';

        const stats = m.stats || {
          last_24h: { contribution: 0, departures: 0 },
          last_season: { contribution: 0, departures: 0 },
          lifetime: { contribution: 0, departures: 0 }
        };

        let badges = '';
        if (m.tanker_ops) badges += '⛽ ';
        if (m.is_rookie) badges += '🤏 ';
        if (m.difficulty === 'realism') badges += '🤘';
        else if (m.difficulty === 'easy') badges += '✌️';

        membersHtml += `
          <div class="alliance-stat-card member-card">
            <h4 class="clickable alliance-member-name" data-user-id="${m.user_id}">${m.roleGroup.emoji} ${escapeHtml(m.company_name)}</h4>
            <div class="stat-row">
              <span>Role:</span>
              <span class="stat-value">${m.roleGroup.title} ${badges}</span>
            </div>
            <div class="stat-row">
              <span>Share Value:</span>
              <span class="stat-value">${shareValue}</span>
            </div>
            <div class="stat-row">
              <span>24h Contribution:</span>
              <span class="stat-value">${formatNumber(stats.last_24h.contribution)}</span>
            </div>
            <div class="stat-row">
              <span>24h Departures:</span>
              <span class="stat-value">${formatNumber(stats.last_24h.departures)}</span>
            </div>
            <div class="stat-row">
              <span>Season Contribution:</span>
              <span class="stat-value">${formatNumber(stats.last_season.contribution)}</span>
            </div>
            <div class="stat-row">
              <span>Season Departures:</span>
              <span class="stat-value">${formatNumber(stats.last_season.departures)}</span>
            </div>
            <div class="stat-row">
              <span>Lifetime Contribution:</span>
              <span class="stat-value">${formatNumber(stats.lifetime.contribution)}</span>
            </div>
            <div class="stat-row">
              <span>Lifetime Departures:</span>
              <span class="stat-value">${formatNumber(stats.lifetime.departures)}</span>
            </div>
            <div class="stat-row">
              <span>Joined:</span>
              <span class="stat-value">${joinedDate}</span>
            </div>
            <div class="stat-row">
              <span>Last Login:</span>
              <span class="stat-value">${lastLoginDate}</span>
            </div>
          </div>
        `;
      });

      document.getElementById('externalAllianceMembersGrid').innerHTML = membersHtml;

      contentArea.querySelectorAll('.alliance-member-name.clickable').forEach(nameEl => {
        nameEl.addEventListener('click', async () => {
          const userId = parseInt(nameEl.getAttribute('data-user-id'));
          await openPlayerProfile(userId, true);
        });
      });
    }

    renderExternalAllianceMembers();

    document.getElementById('externalAllianceMemberSortDropdown').addEventListener('change', (e) => {
      const value = e.target.value;
      const lastDashIndex = value.lastIndexOf('-');
      const sortBy = value.substring(0, lastDashIndex);
      const sortOrder = value.substring(lastDashIndex + 1);
      renderExternalAllianceMembers(sortBy, sortOrder);
    });

    // Add click listeners for top contributors table
    contentArea.querySelectorAll('.top-contributors-table .alliance-member-name.clickable').forEach(nameEl => {
      nameEl.addEventListener('click', async () => {
        const userId = parseInt(nameEl.getAttribute('data-user-id'));
        await openPlayerProfile(userId, true);
      });
    });

    // Add join button listener if button was added
    if (showJoinButton) {
      const joinBtn = modal.querySelector('.join-alliance-btn');
      if (joinBtn) {
        joinBtn.addEventListener('click', async () => {
          await handleJoinAllianceClick(allianceId, data.name);
        });
      }
    }
  } catch (error) {
    const contentArea = modal.querySelector('.alliance-details-content');
    if (contentArea) {
      contentArea.innerHTML = `<p class="alliance-tab-error">Failed to load alliance details: ${error.message}</p>`;
    }
  }
}

/**
 * Renders the Management tab content
 */
async function renderManagementTab() {
  const content = document.getElementById('managementContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading management data...</p>';

  const [directPoolData, anyPoolData, membersResponse] = await Promise.all([
    fetchQueuePool({ pool_type: 'direct' }),
    fetchQueuePool({ pool_type: 'any' }),
    fetchAllianceMembers()
  ]);

  // Combine both pool types
  const poolData = {
    direct: directPoolData.direct,
    any: anyPoolData.any,
    no_alliance: directPoolData.no_alliance
  };

  // Extract members and current user info
  const membersData = membersResponse.members || membersResponse;
  const currentUserId = membersResponse.current_user_id;
  const currentUserRole = membersData.find(m => m.user_id === currentUserId)?.role || 'member';

  tabDataCache.management = { pool: poolData, members: membersData, currentUserId, currentUserRole };

  let html = `
    <div class="management-container">
      <div class="management-section">
        <h3 class="management-section-title">Applications Queue</h3>
        <div class="queue-pool-filters">
          <select id="poolTypeFilter" class="management-filter">
            <option value="direct">Direct</option>
            <option value="any">Any</option>
          </select>
          <select id="shareValueFilter" class="management-filter">
            <option value="any">Any Share Value</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <select id="fleetSizeFilter" class="management-filter">
            <option value="any">Any Fleet Size</option>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
          <select id="experienceFilter" class="management-filter">
            <option value="all">All</option>
            <option value="rookies_only">Rookies Only</option>
          </select>
        </div>
        <div id="queuePoolContent" class="queue-pool-content">
  `;

  if (poolData.no_alliance) {
    html += '<p class="management-error">You are not in an alliance.</p>';
  } else {
    // Get items from either direct or any pool
    const poolItems = poolData.direct ? poolData.direct : poolData.any;
    if (poolItems && poolItems.length > 0) {
      poolItems.forEach(item => {
        const requestDate = new Date(item.time_requested * 1000).toLocaleString();
        const shareValueText = item.share_value > 0 ? ` - $${formatNumber(item.share_value)}` : '';
        const rookieStatus = item.user.is_rookie ? 'Yes' : 'No';

        html += `
          <div class="queue-pool-item">
            <div class="application-header">
              <span class="application-company">${escapeHtml(item.user.company_name)}</span>
              <span class="application-id">(${item.user.id})</span>
              ${shareValueText ? `<span class="application-share">${shareValueText}</span>` : ''}
              <span class="application-time">${requestDate}</span>
            </div>
            <div class="application-stats">
              <span>Experience: ${item.experience}</span>
              <span>Is Rookie: ${rookieStatus}</span>
            </div>
            <div class="application-stats">
              <span>Fleet size: ${item.fleet_size}</span>
              <span>Departures 24h: ${item.user.departures_24h}</span>
            </div>
            <div class="application-text">
              <strong>User application:</strong>
              <p>${escapeHtml(item.application_text)}</p>
            </div>
            <div class="application-actions">
              <button class="application-decline-btn" data-user-id="${item.user.id}">Decline</button>
              <button class="application-accept-btn" data-user-id="${item.user.id}">Accept</button>
            </div>
          </div>
        `;
      });
    } else {
      html += '<p class="queue-pool-empty">No applications in queue.</p>';
    }
  }

  html += `
        </div>
      </div>

      <div class="management-section">
        <h3 class="management-section-title management-section-collapsible" id="memberManagementToggle">
          <span>Member Management</span>
          <span class="toggle-icon">▼</span>
        </h3>
        <div id="memberManagementContent" class="member-management-content collapsed">
  `;

  if (membersData && membersData.length > 0) {
    // Group members by role
    const roleGroups = {
      ceo: { title: 'CEO', emoji: '👨‍✈️', members: [] },
      coo: { title: 'COO', emoji: '👨‍💼', members: [] },
      management: { title: 'Management', emoji: '🧑‍💻', members: [] },
      member: { title: 'Members', emoji: '🦸‍♂️', members: [] }
    };

    // Sort members into groups
    membersData.forEach(member => {
      const role = member.role || 'member';
      if (roleGroups[role]) {
        roleGroups[role].members.push(member);
      } else {
        roleGroups.member.members.push(member);
      }
    });

    // Helper function to render a member card
    const renderMemberCard = (member, group) => {
      // Additional emojis
      let additionalEmojis = '';
      if (member.tanker_ops) additionalEmojis += ' ⛽';
      if (member.is_rookie) additionalEmojis += ' 🤏';
      if (member.difficulty === 'realism') additionalEmojis += ' 🤘';
      else if (member.difficulty === 'easy') additionalEmojis += ' ✌️';

      // Format dates
      const joinedDate = new Date(member.time_joined * 1000).toLocaleDateString();
      const lastActiveDate = new Date(member.time_last_login * 1000).toLocaleDateString();

      // Format stock value
      const stockValue = member.share_value > 0 ? `$${formatNumber(member.share_value)}` : 'N/A';

      // Determine if role can be changed
      // ONLY CEO and COO can change roles
      // CEO can change all roles
      // COO can change all roles EXCEPT CEO
      let canChangeRole = false;
      if (currentUserRole === 'ceo') {
        canChangeRole = true;
      } else if (currentUserRole === 'coo' && member.role !== 'ceo') {
        canChangeRole = true;
      }

      let roleActionsHtml = '';
      if (canChangeRole) {
        // Build role options based on current user's permissions
        let roleOptions = `
          <option value="member" ${member.role === 'member' ? 'selected' : ''}>Member</option>
          <option value="management" ${member.role === 'management' ? 'selected' : ''}>Management</option>
        `;
        // Only CEO can assign COO or Interim CEO
        if (currentUserRole === 'ceo') {
          roleOptions += `
            <option value="interimceo" ${member.role === 'interimceo' ? 'selected' : ''}>Interim CEO</option>
            <option value="coo" ${member.role === 'coo' ? 'selected' : ''}>COO</option>
          `;
        }

        roleActionsHtml = `
          <select class="member-role-select" data-user-id="${member.user_id}">
            ${roleOptions}
          </select>
          <button class="member-role-save-btn" data-user-id="${member.user_id}" title="Save Role" onmouseover="this.querySelector('span').style.animation='pulse-arrow 0.6s ease-in-out infinite'" onmouseout="this.querySelector('span').style.animation='none'"><span>💾</span></button>
        `;
      }

      return `
        <div class="alliance-stat-card member-card">
          <h4>
            <span title="${group.title}">${group.emoji}</span> <span class="clickable alliance-member-name" data-user-id="${member.user_id}">${escapeHtml(member.company_name)}</span>
            <span class="member-badges">${additionalEmojis}</span>
          </h4>
          <div class="stat-row stat-row-muted">
            <span>ID: ${member.user_id}</span>
          </div>
          <div class="stat-row">
            <span>Stock:</span>
            <span class="stat-value">${stockValue}</span>
          </div>
          <div class="stat-row">
            <span>Joined:</span>
            <span class="stat-value">${joinedDate}</span>
          </div>
          <div class="stat-row">
            <span>Last Active:</span>
            <span class="stat-value">${lastActiveDate}</span>
          </div>
          <div class="stat-row">
            <span>Contribution:</span>
            <span class="stat-value">${member.contribution !== undefined ? formatNumber(member.contribution) : 'N/A'}</span>
          </div>
          <div class="stat-row">
            <span>Departures:</span>
            <span class="stat-value">${member.departures !== undefined ? formatNumber(member.departures) : 'N/A'}</span>
          </div>
          ${roleActionsHtml ? `
            <div class="member-card-action">
              ${roleActionsHtml}
            </div>
          ` : ''}
        </div>
      `;
    };

    // Render CEO and COO together in one row
    if (roleGroups.ceo.members.length > 0 || roleGroups.coo.members.length > 0) {
      html += `<h4 class="member-group-title">👨‍✈️ CEO & 👨‍💼 COO</h4>`;
      html += `<div class="members-grid">`;

      // Render CEO members
      roleGroups.ceo.members.forEach(member => {
        html += renderMemberCard(member, roleGroups.ceo);
      });

      // Render COO members
      roleGroups.coo.members.forEach(member => {
        html += renderMemberCard(member, roleGroups.coo);
      });

      html += `</div>`;
    }

    // Render Management
    if (roleGroups.management.members.length > 0) {
      html += `<h4 class="member-group-title">🧑‍💻 Management</h4>`;
      html += `<div class="members-grid">`;
      roleGroups.management.members.forEach(member => {
        html += renderMemberCard(member, roleGroups.management);
      });
      html += `</div>`;
    }

    // Render Members
    if (roleGroups.member.members.length > 0) {
      html += `<h4 class="member-group-title">🦸‍♂️ Members</h4>`;
      html += `<div class="members-grid">`;
      roleGroups.member.members.forEach(member => {
        html += renderMemberCard(member, roleGroups.member);
      });
      html += `</div>`;
    }
  } else {
    html += '<p class="member-management-empty">No members found.</p>';
  }

  html += `
        </div>
      </div>

      <div class="management-section">
        <h3 class="management-section-title">Welcome Message</h3>
        <p class="management-section-description">This message will be sent to new members when accepting their application.</p>
        <p class="management-section-description">Use <code>[allianceName]</code> as variable in subject and message body.</p>
        <div class="welcome-message-container">
          <div class="welcome-subject-row">
            <label for="welcomeSubjectInput">Subject:</label>
            <input type="text" id="welcomeSubjectInput"
                   class="welcome-subject-input"
                   maxlength="100"
                   placeholder="Welcome to [allianceName]">
          </div>
          <textarea id="welcomeMessageInput"
                    class="welcome-message-textarea"
                    maxlength="900"
                    placeholder="Enter your welcome message here..."
                    rows="5"></textarea>
          <div class="welcome-message-footer">
            <span id="welcomeMessageCharCount" class="char-count">0 / 900</span>
            <button id="saveWelcomeMessageBtn" class="alliance-settings-save-btn">Save Welcome Message</button>
          </div>
        </div>
      </div>
    </div>
  `;

  content.innerHTML = html;

  // Load saved welcome message from user settings
  await loadWelcomeMessage();

  // Add event listeners for live filter updates
  const filterSelects = [
    document.getElementById('poolTypeFilter'),
    document.getElementById('shareValueFilter'),
    document.getElementById('fleetSizeFilter'),
    document.getElementById('experienceFilter')
  ];

  const applyFilters = async () => {
    const filters = {
      pool_type: document.getElementById('poolTypeFilter').value,
      filter_share_value: document.getElementById('shareValueFilter').value,
      filter_fleet_size: document.getElementById('fleetSizeFilter').value,
      filter_experience: document.getElementById('experienceFilter').value,
      page: 1
    };

    const queuePoolContent = document.getElementById('queuePoolContent');
    queuePoolContent.innerHTML = '<p class="alliance-tab-loading">Loading...</p>';

    try {
      const newPoolData = await fetchQueuePool(filters);
      let poolHtml = '';

      // Get items from either direct or any pool based on selected filter
      let poolItems = newPoolData.direct ? newPoolData.direct : newPoolData.any;

      // Filter by rookie status
      if (filters.filter_experience === 'rookies_only' && poolItems) {
        poolItems = poolItems.filter(item => item.user.is_rookie === true);
      }

      // Filter by share value
      if (filters.filter_share_value !== 'any' && poolItems) {
        poolItems = poolItems.filter(item => {
          const shareValue = item.share_value;
          if (filters.filter_share_value === 'low') return shareValue > 0 && shareValue < 100000;
          if (filters.filter_share_value === 'medium') return shareValue >= 100000 && shareValue < 500000;
          if (filters.filter_share_value === 'high') return shareValue >= 500000;
          return true;
        });
      }

      // Filter by fleet size
      if (filters.filter_fleet_size !== 'any' && poolItems) {
        poolItems = poolItems.filter(item => {
          const fleetSize = item.fleet_size;
          if (filters.filter_fleet_size === 'small') return fleetSize < 10;
          if (filters.filter_fleet_size === 'medium') return fleetSize >= 10 && fleetSize < 50;
          if (filters.filter_fleet_size === 'large') return fleetSize >= 50;
          return true;
        });
      }

      if (poolItems && poolItems.length > 0) {
        poolItems.forEach(item => {
          const requestDate = new Date(item.time_requested * 1000).toLocaleString();
          const shareValueText = item.share_value > 0 ? ` - $${formatNumber(item.share_value)}` : '';
          const rookieStatus = item.user.is_rookie ? 'Yes' : 'No';

          poolHtml += `
            <div class="queue-pool-item">
              <div class="application-header">
                <span class="application-company">${escapeHtml(item.user.company_name)}</span>
                <span class="application-id">(${item.user.id})</span>
                ${shareValueText ? `<span class="application-share">${shareValueText}</span>` : ''}
                <span class="application-time">${requestDate}</span>
              </div>
              <div class="application-stats">
                <span>Experience: ${item.experience}</span>
                <span>Is Rookie: ${rookieStatus}</span>
              </div>
              <div class="application-stats">
                <span>Fleet size: ${item.fleet_size}</span>
                <span>Departures 24h: ${item.user.departures_24h}</span>
              </div>
              <div class="application-text">
                <strong>User application:</strong>
                <p>${escapeHtml(item.application_text)}</p>
              </div>
              <div class="application-actions">
                <button class="application-decline-btn" data-user-id="${item.user.id}">Decline</button>
                <button class="application-accept-btn" data-user-id="${item.user.id}">Accept</button>
              </div>
            </div>
          `;
        });
      } else {
        poolHtml = '<p class="queue-pool-empty">No applications in queue.</p>';
      }

      queuePoolContent.innerHTML = poolHtml;
    } catch {
      queuePoolContent.innerHTML = '<p class="management-error">Failed to load queue pool.</p>';
    }
  };

  filterSelects.forEach(select => {
    if (select) {
      select.addEventListener('change', applyFilters);
    }
  });

  // Add accept button listeners
  const acceptBtns = document.querySelectorAll('.application-accept-btn');
  acceptBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = parseInt(btn.getAttribute('data-user-id'));
      const companyName = btn.closest('.queue-pool-item').querySelector('.application-company').textContent;

      btn.disabled = true;
      btn.textContent = 'Accepting...';

      try {
        await acceptUserToAlliance(userId);
        showSideNotification(`Successfully accepted ${companyName} to the alliance`, 'success');

        // Send welcome message to the new member
        await sendWelcomeMessageToUser(userId, companyName);

        // Remove the application from the UI
        btn.closest('.queue-pool-item').remove();

        // Check if there are no more applications
        const remainingItems = document.querySelectorAll('.queue-pool-item');
        if (remainingItems.length === 0) {
          document.getElementById('queuePoolContent').innerHTML = '<p class="queue-pool-empty">No applications in queue.</p>';
        }
      } catch (error) {
        showSideNotification(`Failed to accept user: ${error.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Accept';
      }
    });
  });

  // Add decline button listeners
  const declineBtns = document.querySelectorAll('.application-decline-btn');
  declineBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = parseInt(btn.getAttribute('data-user-id'));
      const companyName = btn.closest('.queue-pool-item').querySelector('.application-company').textContent;

      btn.disabled = true;
      btn.textContent = 'Declining...';

      try {
        await declineUserFromAlliance(userId);
        showSideNotification(`Declined application from ${companyName}`, 'info');
        // Remove the application from the UI
        btn.closest('.queue-pool-item').remove();

        // Check if there are no more applications
        const remainingItems = document.querySelectorAll('.queue-pool-item');
        if (remainingItems.length === 0) {
          document.getElementById('queuePoolContent').innerHTML = '<p class="queue-pool-empty">No applications in queue.</p>';
        }
      } catch (error) {
        showSideNotification(`Failed to decline user: ${error.message}`, 'error');
        btn.disabled = false;
        btn.textContent = 'Decline';
      }
    });
  });

  // Add role save button listeners
  const roleSaveBtns = document.querySelectorAll('.member-role-save-btn');
  roleSaveBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const userId = parseInt(btn.getAttribute('data-user-id'));
      const selectElement = document.querySelector(`.member-role-select[data-user-id="${userId}"]`);
      const newRole = selectElement.value;

      btn.disabled = true;
      try {
        await updateUserRole(userId, newRole);
        showSideNotification(`Role updated successfully`, 'success');
      } catch (error) {
        showSideNotification(`Failed to update role: ${error.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Add click handlers for clickable member names in member cards
  const clickableMembers = document.querySelectorAll('#memberManagementContent .alliance-member-name.clickable');
  clickableMembers.forEach(memberSpan => {
    memberSpan.addEventListener('click', async () => {
      const userId = parseInt(memberSpan.getAttribute('data-user-id'));
      if (userId) {
        await openPlayerProfile(userId, true);
      }
    });
  });

  // Add toggle for Member Management section
  const memberManagementToggle = document.getElementById('memberManagementToggle');
  const memberManagementContent = document.getElementById('memberManagementContent');
  if (memberManagementToggle && memberManagementContent) {
    memberManagementToggle.addEventListener('click', () => {
      memberManagementContent.classList.toggle('collapsed');
      const toggleIcon = memberManagementToggle.querySelector('.toggle-icon');
      if (toggleIcon) {
        toggleIcon.textContent = memberManagementContent.classList.contains('collapsed') ? '▼' : '▲';
      }
    });
  }
}

/**
 * Renders the Settings tab content
 */
async function renderSettingsTab() {
  const content = document.getElementById('allianceSettingsContent');
  if (!content) return;

  content.innerHTML = '<p class="alliance-tab-loading">Loading settings...</p>';

  const [data, membersResponse] = await Promise.all([
    fetchAllianceSettings(),
    fetchAllianceMembers()
  ]);

  tabDataCache.settings = data;

  if (data.no_alliance) {
    content.innerHTML = '<p class="alliance-tab-error">You are not in an alliance.</p>';
    return;
  }

  const membersData = membersResponse.members || membersResponse;
  const currentUserId = membersResponse.current_user_id;
  const currentUserRole = membersData.find(m => m.user_id === currentUserId)?.role || 'member';
  const isCeo = currentUserRole === 'ceo';

  const timeRangeStart = data.restrictions?.time_restriction_arr?.[0] || 0;
  const timeRangeEnd = data.restrictions?.time_restriction_arr?.[1] || 24;
  const capacityMin = data.restrictions?.selected_vessel_capacity || 0;
  const timeRangeEnabled = data.restrictions?.time_range_enabled || false;

  const leaveButtonText = isCeo ? 'Close Alliance' : 'Leave Alliance';
  const leaveButtonTitle = isCeo ? 'Close this alliance for all members' : 'Leave this alliance';

  content.innerHTML = `
    <div class="alliance-settings-container">
      <h3 class="alliance-settings-title">Your Alliance Cooperation Settings</h3>

      <div class="alliance-settings-group">
        <div class="alliance-settings-item">
          <label class="alliance-settings-label">
            <input type="checkbox" id="coopEnabledToggle" ${data.coop_enabled ? 'checked' : ''}>
            <span>Enable Cooperation <span class="alliance-settings-inline-help">(Allow alliance members to send you coop vessels)</span></span>
          </label>
        </div>
        <h4>Restrictions</h4>

        <div class="alliance-settings-item">
          <label class="alliance-settings-label">
            <span>Minimum Vessel Capacity:</span>
            <input type="number" id="capacityMinInput" value="${capacityMin}" min="0" class="alliance-settings-input">
          </label>
          <p class="alliance-settings-help">Only accept coops from members with at least this vessel capacity (0 = no restriction).</p>
        </div>

        <div class="alliance-settings-item">
          <label class="alliance-settings-label">
            <input type="checkbox" id="timeRangeEnabledToggle" ${timeRangeEnabled ? 'checked' : ''}>
            <span>Enable Time Restriction</span>
          </label>
        </div>

        <div class="alliance-settings-item">
          <label class="alliance-settings-label">
            <span>Acceptance Time Range (UTC):</span>
          </label>
          <div class="time-range-inputs">
            <input type="number" id="timeRangeStart" value="${timeRangeStart}" min="0" max="23" class="alliance-settings-input-small">
            <span>to</span>
            <input type="number" id="timeRangeEnd" value="${timeRangeEnd}" min="1" max="24" class="alliance-settings-input-small">
          </div>
          <p class="alliance-settings-help">Only accept coops during this time window (UTC hours).</p>
        </div>
      </div>

      <div class="alliance-settings-footer">
        <button id="leaveAllianceBtn" class="alliance-leave-btn" title="${leaveButtonTitle}" data-is-ceo="${isCeo}">${leaveButtonText}</button>
        <div class="alliance-settings-save-area">
          <button id="saveAllianceSettingsBtn" class="alliance-settings-save-btn">Save Settings</button>
          <p class="alliance-settings-note">
            Note: These settings are fetched from the game API. Saving changes will update your in-game settings.
          </p>
        </div>
      </div>
    </div>
  `;

  // Add event listener for save button
  const saveBtn = document.getElementById('saveAllianceSettingsBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        const coopEnabled = document.getElementById('coopEnabledToggle').checked;
        const capacityMin = parseInt(document.getElementById('capacityMinInput').value, 10);
        const timeRangeEnabled = document.getElementById('timeRangeEnabledToggle').checked;
        const hhmmFrom = parseInt(document.getElementById('timeRangeStart').value, 10);
        const hhmmTo = parseInt(document.getElementById('timeRangeEnd').value, 10);

        const settings = {
          coop_enabled: coopEnabled,
          capacity_min: capacityMin,
          hhmm_from: hhmmFrom,
          hhmm_to: hhmmTo,
          time_range_enabled: timeRangeEnabled
        };

        await updateAllianceSettings(settings);
        showSideNotification('Settings saved successfully!', 'success');

        // Clear cache and reload tab
        tabDataCache.settings = null;
        await renderSettingsTab();
      } catch (error) {
        console.error('[Alliance Settings] Save failed:', error);
        showSideNotification(`Failed to save settings: ${error.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Settings';
      }
    });
  }

  // Add event listener for leave/close alliance button
  const leaveBtn = document.getElementById('leaveAllianceBtn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', async () => {
      const isCeoAction = leaveBtn.getAttribute('data-is-ceo') === 'true';

      const confirmConfig = isCeoAction ? {
        title: 'Close Alliance',
        message: '<p>Are you sure you want to close this alliance?</p><p><strong>This will disband the alliance for all members. This action cannot be undone.</strong></p>',
        confirmText: 'Close Alliance',
        cancelText: 'Cancel',
        narrow: true
      } : {
        title: 'Leave Alliance',
        message: '<p>Are you sure you want to leave this alliance?</p><p><strong>This action cannot be undone.</strong></p>',
        confirmText: 'Leave',
        cancelText: 'Cancel',
        narrow: true
      };

      const confirmed = await showConfirmDialog(confirmConfig);
      if (!confirmed) return;

      leaveBtn.disabled = true;
      leaveBtn.textContent = isCeoAction ? 'Closing...' : 'Leaving...';

      try {
        await leaveAlliance();

        // Immediately hide all alliance UI elements
        await hideAllAllianceUI();

        // Reload settings from server to ensure sync
        const updatedSettings = await loadSettings();
        if (window.settings) {
          window.settings = updatedSettings;
        }

        const successMessage = isCeoAction ? 'Alliance has been closed.' : 'You have left the alliance.';
        showSideNotification(successMessage, 'success');

        // Switch to search tab to show alliance search interface
        currentTab = 'search';
        await renderSearchTab();

      } catch (error) {
        console.error('[Alliance] Leave/Close failed:', error);
        const errorMessage = isCeoAction ? 'Failed to close alliance' : 'Failed to leave alliance';
        showSideNotification(`${errorMessage}: ${error.message}`, 'error');
        leaveBtn.disabled = false;
        leaveBtn.textContent = isCeoAction ? 'Close Alliance' : 'Leave Alliance';
      }
    });
  }
}

/**
 * Shows the alliance cooperation overlay with tabs
 */
export async function showAllianceCoopOverlay() {
  const overlay = document.getElementById('coopOverlay');
  if (!overlay) {
    console.error('[Alliance Tabs] Overlay element not found');
    return;
  }

  // Show overlay IMMEDIATELY
  overlay.classList.remove('hidden');

  // Show loading state in all tab contents
  const tabContents = overlay.querySelectorAll('.alliance-tab-content');
  tabContents.forEach(content => {
    content.innerHTML = '<div class="alliance-loading"><p>Loading...</p></div>';
  });

  // Initialize tab switching if not already done
  initAllianceTabs();

  // Check if user has alliance (async operation)
  try {
    const allianceInfo = await fetchAllianceInfo();
    const hasAlliance = !allianceInfo.no_alliance;

    if (hasAlliance) {
      // User has alliance - show all relevant tabs and check role
      await updateManagementTabVisibility();
      await updateTabVisibilityForAllianceMembers();
      await switchTab('allianz');
    } else {
      // User has NO alliance - only show Search and Settings tabs
      await updateTabVisibilityForNonMembers();
      await switchTab('search');
    }
  } catch (error) {
    console.error('[Alliance Tabs] Error fetching alliance info:', error);
    // On error, assume no alliance and show only Search and Settings
    await updateTabVisibilityForNonMembers();
    await switchTab('search');
  }
}

/**
 * Updates tab visibility for alliance members
 * Shows: Allianz, Coop, Liga, HighScore, Settings, (Management if role allows)
 */
async function updateTabVisibilityForAllianceMembers() {
  const tabs = document.querySelectorAll('.alliance-coop-tabs .tab-button');
  tabs.forEach(tab => {
    const tabName = tab.getAttribute('data-tab');
    if (tabName !== 'management') {
      tab.style.display = '';
    }
  });
}

/**
 * Updates tab visibility for non-alliance users
 * Shows ONLY: Search
 */
async function updateTabVisibilityForNonMembers() {
  const tabs = document.querySelectorAll('.alliance-coop-tabs .tab-button');
  tabs.forEach(tab => {
    const tabName = tab.getAttribute('data-tab');
    if (tabName === 'search') {
      tab.style.display = '';
    } else {
      tab.style.display = 'none';
    }
  });
}

/**
 * Updates the visibility of the Management tab based on user's alliance role
 * Only CEO, COO, and Management members can see the Management tab
 */
async function updateManagementTabVisibility() {
  const managementTabButton = document.querySelector('.tab-button[data-tab="management"]');
  if (!managementTabButton) return;

  try {
    const membersResponse = await fetchAllianceMembers();
    const membersData = membersResponse.members || membersResponse;
    const currentUserId = membersResponse.current_user_id;
    const currentUserRole = membersData.find(m => m.user_id === currentUserId)?.role || 'member';

    // Only show Management tab and Welcome Command Settings for CEO, COO, Management, and Interim CEO roles
    const allowedRoles = ['ceo', 'coo', 'management', 'interimceo'];
    const isAllowed = allowedRoles.includes(currentUserRole);

    // Show/hide Management tab
    if (isAllowed) {
      managementTabButton.style.display = '';
    } else {
      managementTabButton.style.display = 'none';
    }

    // Show/hide Welcome Command Settings box in settings
    const welcomeCommandBox = document.getElementById('welcomeCommandSettingsBox');
    if (welcomeCommandBox) {
      if (isAllowed) {
        welcomeCommandBox.style.display = '';
      } else {
        welcomeCommandBox.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('[Alliance Tabs] Error checking user role:', error);
    // Hide management tab and welcome command settings on error (fail secure)
    managementTabButton.style.display = 'none';
    const welcomeCommandBox = document.getElementById('welcomeCommandSettingsBox');
    if (welcomeCommandBox) {
      welcomeCommandBox.style.display = 'none';
    }
  }
}

/**
 * Closes the alliance cooperation overlay
 */
export function closeAllianceCoopOverlay() {
  const overlay = document.getElementById('coopOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

/**
 * Refreshes the current tab content
 */
export async function refreshCurrentTab() {
  await loadTabContent(currentTab);
}

/**
 * Gets the current active tab name
 * @returns {string} Current tab name
 */
export function getCurrentTab() {
  return currentTab;
}

/**
 * Clears the alliance tab cache to force fresh data on next tab switch
 */
export function clearAllianceTabCache() {
  tabDataCache = {
    allianz: null,
    liga: null,
    highscore: null,
    search: null,
    management: null,
    settings: null,
    coop: null
  };
}

/**
 * Updates the coop badge in the tab button
 * @param {number} count - Number of available coop slots
 */
export function updateCoopTabBadge(count) {
  const badge = document.getElementById('coopTabBadge');
  if (badge) {
    badge.textContent = count;
    if (count > 0) {
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

/**
 * Renders the Search tab content
 */
async function renderSearchTab() {
  const content = document.getElementById('searchContent');
  if (!content) return;

  // Initialize on first load
  if (!searchState.initialized) {
    searchState.initialized = true;
    searchState.offset = 0;
    searchState.results = [];
    searchState.query = '';
    searchState.filters = { sortBy: 'name_asc', hasOpenSlots: false };
    searchState.hasMore = true;
  }

  // Check indexer status
  const statusResponse = await fetch(window.apiUrl('/api/alliances/status'));
  const status = await statusResponse.json();

  // Fetch available languages
  let availableLanguages = null;
  if (status.data.isReady) {
    try {
      const languagesResponse = await fetch(window.apiUrl('/api/alliances/languages'));

      if (!languagesResponse.ok) {
        console.error('[Search] Languages API failed:', languagesResponse.status, languagesResponse.statusText);
        throw new Error(`API returned ${languagesResponse.status}`);
      }

      const languagesData = await languagesResponse.json();

      if (!languagesData.success) {
        console.error('[Search] Languages API returned error:', languagesData);
        throw new Error('API returned success: false');
      }

      if (!Array.isArray(languagesData.data.languages)) {
        console.error('[Search] Languages API returned invalid data:', languagesData);
        throw new Error('API did not return array');
      }

      availableLanguages = languagesData.data.languages;
      console.log('[Search] Loaded languages:', availableLanguages);
    } catch (error) {
      console.error('[Search] Failed to load languages:', error);
      availableLanguages = null;
    }
  }

  // Check if user has alliance
  const allianceInfo = await fetchAllianceInfo();
  const userHasAlliance = !allianceInfo.no_alliance;

  // Fetch pending applications (always check, API returns empty if user has alliance)
  let directApplications = [];
  let anyPoolApplication = null;
  try {
    const applicationsResponse = await fetch(window.apiUrl('/api/alliance-get-applications'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (applicationsResponse.ok) {
      const applicationsData = await applicationsResponse.json();
      console.log('[Search] Applications API response:', applicationsData);

      // Extract direct applications
      directApplications = applicationsData.data?.pool_state?.direct || [];

      // Extract "any alliance" pool application (if exists)
      anyPoolApplication = applicationsData.data?.pool_state?.any || null;

      console.log('[Search] Direct applications:', directApplications);
      console.log('[Search] Any pool application:', anyPoolApplication);
    } else {
      console.error('[Search] Applications API failed with status:', applicationsResponse.status);
    }
  } catch (error) {
    console.error('[Search] Failed to load pending applications:', error);
  }

  // Update pool button state (only when on search tab to prevent other tabs from affecting tab bar)
  const poolBtn = document.getElementById('anyAlliancePoolBtn');
  const inAnyPool = anyPoolApplication !== null;

  if (poolBtn) {
    if (!userHasAlliance && !inAnyPool) {
      // User not in alliance and not in pool - show "Apply" button (green)
      poolBtn.style.display = '';
      poolBtn.textContent = 'Apply for Any Alliance';
      poolBtn.classList.remove('pool-leave-btn');
      poolBtn.classList.add('pool-join-btn');
    } else if (!userHasAlliance && inAnyPool) {
      // User in pool - show "Cancel" button (red)
      poolBtn.style.display = '';
      poolBtn.textContent = 'Cancel';
      poolBtn.classList.remove('pool-join-btn');
      poolBtn.classList.add('pool-leave-btn');
    } else {
      // User has alliance - hide button
      poolBtn.style.display = 'none';
    }
  }

  // Build UI
  let html = `
    <div class="alliance-search-container">
      ${!status.data.isReady ? `
        <div class="alliance-search-overlay">
          <div class="alliance-search-overlay-content">
            <div class="alliance-search-spinner"></div>
            <div class="alliance-search-overlay-text">
              <h2>Indexing alliances...</h2>
              <p>Please wait. This may take a moment.</p>
            </div>
          </div>
        </div>
      ` : ''}


      <!-- Search Header -->
      <div class="alliance-search-header">
        <input
          type="text"
          id="allianceSearchInput"
          class="alliance-search-input"
          placeholder="Search alliances by name or description..."
          value="${escapeHtml(searchState.query)}"
        />
        <button id="allianceSearchBtn" class="alliance-search-btn">Search</button>
        <button id="allianceSearchClearBtn" class="alliance-search-clear-btn">Clear</button>
      </div>

      <!-- Filter Options -->
      <div class="alliance-search-filters">
        <select id="allianceFilterLanguage" class="alliance-filter-select" ${availableLanguages === null ? 'disabled' : ''}>
          ${availableLanguages === null ?
            `<option value="">Language filter unavailable</option>` :
            `<option value="">All Languages</option>
            ${availableLanguages.map(lang =>
              `<option value="${lang}" ${searchState.filters.language === lang ? 'selected' : ''}>${lang.toUpperCase()}</option>`
            ).join('')}`
          }
        </select>

        <select id="allianceFilterSort" class="alliance-filter-select">
          <option value="name_asc" ${searchState.filters.sortBy === 'name_asc' ? 'selected' : ''}>Name (A-Z)</option>
          <option value="name_desc" ${searchState.filters.sortBy === 'name_desc' ? 'selected' : ''}>Name (Z-A)</option>
          <option value="members_desc" ${searchState.filters.sortBy === 'members_desc' ? 'selected' : ''}>Members (High to Low)</option>
          <option value="members_asc" ${searchState.filters.sortBy === 'members_asc' ? 'selected' : ''}>Members (Low to High)</option>
          <option value="contribution_desc" ${searchState.filters.sortBy === 'contribution_desc' ? 'selected' : ''}>Contribution (High to Low)</option>
          <option value="contribution_asc" ${searchState.filters.sortBy === 'contribution_asc' ? 'selected' : ''}>Contribution (Low to High)</option>
          <option value="departures_desc" ${searchState.filters.sortBy === 'departures_desc' ? 'selected' : ''}>Departures (High to Low)</option>
          <option value="departures_asc" ${searchState.filters.sortBy === 'departures_asc' ? 'selected' : ''}>Departures (Low to High)</option>
          <option value="share_value_desc" ${searchState.filters.sortBy === 'share_value_desc' ? 'selected' : ''}>Share Value (High to Low)</option>
          <option value="share_value_asc" ${searchState.filters.sortBy === 'share_value_asc' ? 'selected' : ''}>Share Value (Low to High)</option>
          <option value="founded_desc" ${searchState.filters.sortBy === 'founded_desc' ? 'selected' : ''}>Newest First</option>
          <option value="founded_asc" ${searchState.filters.sortBy === 'founded_asc' ? 'selected' : ''}>Oldest First</option>
        </select>

        <select id="allianceFilterOpenSlots" class="alliance-filter-select">
          <option value="all" ${!searchState.filters.hasOpenSlots ? 'selected' : ''}>All Alliances</option>
          <option value="open" ${searchState.filters.hasOpenSlots ? 'selected' : ''}>Only Open</option>
        </select>
      </div>

      <!-- Pending Applications Section (only for non-alliance users) -->
      ${directApplications.length > 0 || inAnyPool ? `
        <div class="pending-applications-section">
          <div class="pending-applications-header">
            <h3>Your Pending Applications</h3>
            ${directApplications.length > 0 ? `
              <button id="cancelAllApplicationsBtn" class="cancel-all-btn">Cancel All Applications</button>
            ` : ''}
          </div>

          ${inAnyPool ? `
            <div class="pending-application-item pool-item">
              <div class="application-info">
                <strong>Queued for ANY alliance</strong>
                <p>You are in the general pool. Alliances can invite you.</p>
                ${anyPoolApplication?.time_requested ? `<p>Joined pool: ${new Date(anyPoolApplication.time_requested * 1000).toLocaleString()}</p>` : ''}
              </div>
              <button class="cancel-application-btn" data-pool="true">Cancel Queue</button>
            </div>
          ` : ''}

          ${directApplications.map(app => {
            const appDate = app.time_requested ? new Date(app.time_requested * 1000).toLocaleDateString() : '-';
            const applicationText = Array.isArray(app.application_text) ? app.application_text[0] : app.application_text;
            return `
              <div class="pending-application-item">
                <div class="application-info">
                  <strong>${escapeHtml(app.name || app.alliance_name || 'Unknown Alliance')}</strong>
                  <p>Applied: ${appDate}</p>
                  ${applicationText ? `<p class="application-text">"${escapeHtml(applicationText)}"</p>` : ''}
                </div>
                <button class="cancel-application-btn" data-alliance-id="${app.alliance_id || app.id}">Cancel</button>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      <!-- Results Container -->
      <div id="allianceSearchResults" class="alliance-search-results">
        ${searchState.results.length === 0 && searchState.initialized ?
          `<p class="alliance-search-no-results">Enter a search term or browse all alliances.</p>` :
          ''
        }
      </div>

      <!-- Loading Indicator -->
      <div id="allianceSearchLoading" class="alliance-search-loading" style="display: none;">
        Loading more...
      </div>
    </div>
  `;

  content.innerHTML = html;

  // Attach event listeners
  attachSearchEventListeners();

  // Load initial results if not loaded yet
  if (status.data.isReady && searchState.results.length === 0) {
    await performSearch(true);
  } else if (searchState.results.length > 0) {
    renderSearchResults();
  }
}

/**
 * Attach event listeners for search tab
 */
function attachSearchEventListeners() {
  const searchBtn = document.getElementById('allianceSearchBtn');
  const clearBtn = document.getElementById('allianceSearchClearBtn');
  const searchInput = document.getElementById('allianceSearchInput');
  const languageFilter = document.getElementById('allianceFilterLanguage');
  const sortFilter = document.getElementById('allianceFilterSort');
  const openSlotsFilter = document.getElementById('allianceFilterOpenSlots');

  // Search button
  if (searchBtn) {
    searchBtn.addEventListener('click', async () => {
      searchState.query = searchInput.value.trim();
      searchState.offset = 0;
      searchState.results = [];
      await performSearch(true);
    });
  }

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      searchInput.value = '';
      searchState.query = '';
      searchState.offset = 0;
      searchState.results = [];
      searchState.filters = { sortBy: 'name_asc', hasOpenSlots: false };
      if (languageFilter) languageFilter.value = '';
      if (sortFilter) sortFilter.value = 'name_asc';
      if (openSlotsFilter) openSlotsFilter.value = 'all';
      await performSearch(true);
    });
  }

  // Enter key on search input
  if (searchInput) {
    searchInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        searchState.query = searchInput.value.trim();
        searchState.offset = 0;
        searchState.results = [];
        await performSearch(true);
      }
    });
  }

  // Filter changes
  if (languageFilter) {
    languageFilter.addEventListener('change', async () => {
      searchState.filters.language = languageFilter.value || undefined;
      searchState.offset = 0;
      searchState.results = [];
      await performSearch(true);
    });
  }

  if (sortFilter) {
    sortFilter.addEventListener('change', async () => {
      searchState.filters.sortBy = sortFilter.value;
      searchState.offset = 0;
      searchState.results = [];
      await performSearch(true);
    });
  }

  if (openSlotsFilter) {
    openSlotsFilter.addEventListener('change', async () => {
      searchState.filters.hasOpenSlots = openSlotsFilter.value === 'open';
      console.log('[Search Filter] Open Slots changed:', searchState.filters.hasOpenSlots, 'filters:', searchState.filters);
      searchState.offset = 0;
      searchState.results = [];
      await performSearch(true);
    });
  }


  // Cancel All Applications button
  const cancelAllBtn = document.getElementById('cancelAllApplicationsBtn');
  if (cancelAllBtn) {
    cancelAllBtn.addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        title: 'Cancel All Applications',
        message: '<p>Are you sure you want to cancel all your pending alliance applications?</p>',
        confirmText: 'Cancel All',
        cancelText: 'Keep Applications',
        narrow: true
      });

      if (!confirmed) return;

      try {
        const response = await fetch(window.apiUrl('/api/alliance-cancel-all-applications'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to cancel applications');
        }

        showSideNotification('All applications cancelled', 'success');

        // Force re-render to immediately clear all applications
        searchState.initialized = false;
        await renderSearchTab();
      } catch (error) {
        showSideNotification(`Failed to cancel applications: ${error.message}`, 'error');
      }
    });
  }

  // Individual Cancel Application buttons
  const cancelBtns = document.querySelectorAll('.cancel-application-btn');
  cancelBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const isPool = btn.getAttribute('data-pool') === 'true';
      const allianceId = btn.getAttribute('data-alliance-id');

      const confirmed = await showConfirmDialog({
        title: isPool ? 'Cancel Queue' : 'Cancel Application',
        message: isPool
          ? '<p>Are you sure you want to leave the general alliance pool?</p>'
          : '<p>Are you sure you want to cancel this application?</p>',
        confirmText: 'Cancel',
        cancelText: 'Keep',
        narrow: true
      });

      if (!confirmed) return;

      try {
        let response;
        if (isPool) {
          response = await fetch(window.apiUrl('/api/alliance-leave-pool-any'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          response = await fetch(window.apiUrl('/api/alliance-cancel-application'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alliance_id: parseInt(allianceId) })
          });
        }

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to cancel');
        }

        showSideNotification(isPool ? 'Left general pool' : 'Application cancelled', 'success');

        // Force re-render to immediately remove cancelled application from list
        searchState.initialized = false;
        await renderSearchTab();
      } catch (error) {
        showSideNotification(`Failed to cancel: ${error.message}`, 'error');
      }
    });
  });
}

/**
 * Perform alliance search
 * @param {boolean} reset - Whether to reset results
 */
async function performSearch(reset) {
  if (searchState.isLoading) return;

  searchState.isLoading = true;

  const loadingIndicator = document.getElementById('allianceSearchLoading');
  if (loadingIndicator) {
    loadingIndicator.style.display = 'block';
  }

  try {
    const limit = reset ? ALLIANCE_INITIAL_LOAD : ALLIANCE_LAZY_BATCH;

    const response = await fetch(window.apiUrl('/api/alliances/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: searchState.query,
        filters: searchState.filters,
        offset: reset ? 0 : searchState.offset,
        limit: limit
      })
    });

    if (!response.ok) throw new Error('Search failed');

    const data = await response.json();

    console.log('[Search] API Response:', {
      query: searchState.query,
      filters: searchState.filters,
      total: data.data.total,
      resultsCount: data.data.results.length,
      ready: data.data.ready,
      isReset: reset
    });

    if (data.data.results.length > 0) {
      console.log('[Search] Sample alliance:', data.data.results[0]);
    }

    if (reset) {
      searchState.results = data.data.results;
      searchState.offset = data.data.results.length;
      searchState.total = data.data.total;
      searchState.hasMore = searchState.offset < data.data.total;
      renderSearchResults();
    } else {
      // Lazy load - append results
      if (data.data.results.length === 0) {
        // No more results to load
        searchState.hasMore = false;
        const sentinel = document.getElementById('allianceLazyLoadSentinel');
        if (sentinel) {
          sentinel.remove();
        }
        if (allianceLazyLoadObserver) {
          allianceLazyLoadObserver.disconnect();
        }
        console.log('[Alliance Lazy Load] No more results, stopped loading');
        return;
      }

      searchState.results.push(...data.data.results);
      searchState.offset += data.data.results.length;
      searchState.hasMore = searchState.offset < data.data.total;
      appendSearchResults(data.data.results);
    }
  } catch (error) {
    console.error('[Search] Error:', error);
    const resultsContainer = document.getElementById('allianceSearchResults');
    if (resultsContainer && reset) {
      resultsContainer.innerHTML = '<p class="alliance-search-error">Search failed. Please try again.</p>';
    }
  } finally {
    searchState.isLoading = false;
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }
  }
}

/**
 * Render search results
 */
function renderSearchResults() {
  const resultsContainer = document.getElementById('allianceSearchResults');
  if (!resultsContainer) return;

  if (searchState.results.length === 0) {
    resultsContainer.innerHTML = '<p class="alliance-search-no-results">No alliances found.</p>';
    return;
  }

  let html = '<div class="league-standings">';

  searchState.results.forEach((alliance) => {
    html += createAllianceRow(alliance);
  });

  html += '</div>';

  // Add sentinel element for lazy loading
  if (searchState.hasMore) {
    html += '<div id="allianceLazyLoadSentinel" style="height: 1px;"></div>';
  }

  resultsContainer.innerHTML = html;

  // Attach click handlers to alliance names
  attachAllianceClickHandlers();

  // Set up IntersectionObserver for lazy loading
  if (searchState.hasMore) {
    if (allianceLazyLoadObserver) {
      allianceLazyLoadObserver.disconnect();
    }

    const sentinel = document.getElementById('allianceLazyLoadSentinel');
    if (sentinel) {
      allianceLazyLoadObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !searchState.isLoading && searchState.hasMore) {
            console.log('[Alliance Lazy Load] Sentinel visible, loading more...');
            performSearch(false);
          }
        });
      }, {
        rootMargin: '200px'
      });

      allianceLazyLoadObserver.observe(sentinel);
    }
  }
}

/**
 * Append search results for lazy loading
 * @param {Array} newAlliances - New alliances to append
 */
function appendSearchResults(newAlliances) {
  const resultsContainer = document.getElementById('allianceSearchResults');
  if (!resultsContainer) return;

  const standingsContainer = resultsContainer.querySelector('.league-standings');
  if (!standingsContainer) return;

  newAlliances.forEach((alliance) => {
    const rowHtml = createAllianceRow(alliance);
    standingsContainer.insertAdjacentHTML('beforeend', rowHtml);
  });

  // Attach click handlers to new alliance names
  attachAllianceClickHandlers();

  // Update or remove sentinel
  let sentinel = document.getElementById('allianceLazyLoadSentinel');

  if (searchState.hasMore) {
    if (!sentinel) {
      resultsContainer.insertAdjacentHTML('beforeend', '<div id="allianceLazyLoadSentinel" style="height: 1px;"></div>');
      sentinel = document.getElementById('allianceLazyLoadSentinel');
    }

    // Re-observe sentinel
    if (allianceLazyLoadObserver && sentinel) {
      allianceLazyLoadObserver.disconnect();
      allianceLazyLoadObserver.observe(sentinel);
    }
  } else {
    // No more results, remove sentinel
    if (sentinel) {
      sentinel.remove();
    }
    if (allianceLazyLoadObserver) {
      allianceLazyLoadObserver.disconnect();
    }
  }
}

/**
 * Create HTML for a single alliance row
 * @param {Object} alliance - Alliance data
 * @returns {string} HTML string
 */
function createAllianceRow(alliance) {
  const primaryColor = normalizeColor(alliance.image_colors.primary);
  const secondaryColors = alliance.image_colors.secondary || ['FFFFFF', 'FFFFFF'];
  const gradientColor1 = normalizeColor(secondaryColors[0]);
  const gradientColor2 = normalizeColor(secondaryColors[1] || secondaryColors[0]);
  const gradient = `linear-gradient(${gradientColor1} 0%, ${gradientColor2} 100%)`;

  const logoInitials = alliance.name.substring(0, 2).toUpperCase();

  const languageFlag = alliance.language ? alliance.language.split('-')[0].toUpperCase() : '';

  return `
    <div class="league-alliance-row">
      <div class="league-alliance-logo">
        <div class="alliance-logo-wrapper" style="background: ${gradient};">
          <img src="/api/alliance-logo/${alliance.image}?color=${encodeURIComponent(primaryColor)}" alt="${escapeHtml(alliance.name)}" class="alliance-logo-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
          <span class="alliance-logo-text" style="color: ${primaryColor}; display: none;">${logoInitials}</span>
        </div>
      </div>
      <div class="league-alliance-info">
        <div class="league-alliance-name clickable" data-alliance-id="${alliance.id}">
          ${escapeHtml(alliance.name)}
          ${languageFlag ? `<span class="league-language-flag">${languageFlag}</span>` : ''}
        </div>
        <div class="league-alliance-meta">
          <span>Lvl ${alliance.benefit_level || 0}</span>
          <span>${alliance.members}/50</span>
          <span>$${formatNumber(alliance.total_share_value || 0)}</span>
          <span>Contribution ${formatNumber(alliance.stats?.contribution_score_24h || 0)}</span>
          <span>Departures ${formatNumber(alliance.stats?.departures_24h || 0)}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Attach click handlers to all alliance names in search results
 */
function attachAllianceClickHandlers() {
  const resultsContainer = document.getElementById('allianceSearchResults');
  if (!resultsContainer) return;

  resultsContainer.querySelectorAll('.league-alliance-name.clickable').forEach(nameEl => {
    // Remove old listener by cloning
    const newNameEl = nameEl.cloneNode(true);
    nameEl.replaceWith(newNameEl);

    // Add new listener
    newNameEl.addEventListener('click', async () => {
      const allianceId = parseInt(newNameEl.getAttribute('data-alliance-id'));
      await showAllianceDetailsModal(allianceId);
    });
  });
}

/**
 * Handles join alliance button click
 * Shows motivational speech dialog, then queue-for-any dialog, then applies
 * @param {number} allianceId - The alliance ID to join
 * @param {string} allianceName - The alliance name
 */
async function handleJoinAllianceClick(allianceId, allianceName) {
  try {
    // Step 1: Ask about motivational speech
    const wantsMotivation = await showConfirmDialog({
      title: 'Join Alliance',
      message: `<p>Do you want to add a motivational speech to your application before sending it to <strong>${escapeHtml(allianceName)}</strong>?</p>`,
      confirmText: 'YES',
      cancelText: 'NO',
      narrow: true
    });

    let applicationText = '';

    if (wantsMotivation) {
      // Show text input dialog
      applicationText = await showTextInputDialog({
        title: 'Motivational Speech',
        message: 'Enter your motivational speech (max 1000 characters):',
        placeholder: 'Tell them why you want to join...',
        maxLength: 1000,
        confirmText: 'Continue',
        cancelText: 'Cancel'
      });

      // User cancelled
      if (applicationText === null) {
        return;
      }
    }

    // Step 2: Ask about queue for any alliance
    const wantsQueue = await showConfirmDialog({
      title: 'Backup Queue',
      message: '<p>Do you want to queue up for joining another alliance if not accepted into this alliance within 48 hours?</p>',
      confirmText: 'YES',
      cancelText: 'NO',
      narrow: true
    });

    // If YES to queue, join the pool
    if (wantsQueue) {
      try {
        const queueResponse = await fetch(window.apiUrl('/api/alliance-join-pool-any'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!queueResponse.ok) {
          console.error('[Alliance Join] Failed to join pool for any alliance');
        }
      } catch (error) {
        console.error('[Alliance Join] Error joining pool:', error);
      }
    }

    // Step 3: Apply to join the alliance
    const applyResponse = await fetch(window.apiUrl('/api/alliance-apply-join'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alliance_id: allianceId,
        application_text: applicationText
      })
    });

    if (!applyResponse.ok) {
      const error = await applyResponse.json();
      throw new Error(error.error || 'Failed to apply to alliance');
    }

    showSideNotification(`Application sent to ${escapeHtml(allianceName)}!`, 'success');

    // Close the alliance details modal
    const modal = document.getElementById('allianceDetailsModal');
    if (modal) {
      modal.classList.add('hidden');
    }

    // Refresh search tab to show pending applications
    await renderSearchTab();

  } catch (error) {
    showSideNotification(`Failed to join alliance: ${error.message}`, 'error');
  }
}

/**
 * Shows a text input dialog
 * @param {Object} options - Dialog options
 * @returns {Promise<string|null>} The entered text or null if cancelled
 */
async function showTextInputDialog(options) {
  return new Promise((resolve) => {
    const {
      title,
      message,
      placeholder = '',
      maxLength = 1000,
      confirmText = 'OK',
      cancelText = 'Cancel'
    } = options;

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'overlay';
    dialog.innerHTML = `
      <div class="confirm-dialog" style="max-width: 500px;">
        <h3>${escapeHtml(title)}</h3>
        <div class="confirm-message">${message}</div>
        <textarea
          id="textInputDialogTextarea"
          placeholder="${escapeHtml(placeholder)}"
          maxlength="${maxLength}"
          style="width: 100%; min-height: 120px; padding: var(--spacing-8); border: 1px solid var(--color-border); border-radius: var(--radius-4); font-family: inherit; resize: vertical; margin: var(--spacing-12) 0;"
        ></textarea>
        <div style="color: var(--color-text-muted); font-size: var(--font-size-12); text-align: right; margin-bottom: var(--spacing-12);">
          <span id="textInputCharCount">0</span> / ${maxLength} characters
        </div>
        <div class="confirm-buttons">
          <button class="confirm-cancel-btn">${escapeHtml(cancelText)}</button>
          <button class="confirm-ok-btn">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const textarea = dialog.querySelector('#textInputDialogTextarea');
    const charCount = dialog.querySelector('#textInputCharCount');

    // Update character count
    textarea.addEventListener('input', () => {
      charCount.textContent = textarea.value.length;
    });

    // Focus textarea
    setTimeout(() => textarea.focus(), 100);

    const cleanup = () => {
      document.body.removeChild(dialog);
    };

    dialog.querySelector('.confirm-ok-btn').addEventListener('click', () => {
      const value = textarea.value.trim();
      cleanup();
      resolve(value);
    });

    dialog.querySelector('.confirm-cancel-btn').addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    // Close on outside click
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        cleanup();
        resolve(null);
      }
    });
  });
}

/**
 * Shows donation dialog for donating diamonds to alliance members
 * @param {number} userId - Target user ID
 * @param {string} userName - Target user name
 * @param {number} totalMembers - Total alliance member count
 */
async function showDonateDialog(userId, userName, totalMembers) {
  const pointsDisplay = document.getElementById('pointsDisplay');
  const maxPoints = parseInt(pointsDisplay?.textContent || '0');

  if (maxPoints === 0) {
    showSideNotification('You have no diamonds to donate', 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="messenger-window" style="max-width: 500px;">
      <div class="messenger-header">
        <h2>💎 Donate Diamonds</h2>
        <button class="close-btn donate-close-btn"><span>×</span></button>
      </div>
      <div class="messenger-feed" style="padding: var(--spacing-20);">
        <div style="margin-bottom: var(--spacing-16);">
          <label style="display: block; margin-bottom: var(--spacing-8); color: var(--color-text-secondary);">
            Recipient
          </label>
          <input type="text" value="${userName}" readonly style="width: 100%; padding: var(--spacing-8); background: var(--gray-700); border: 1px solid var(--color-border); border-radius: var(--radius-6); color: var(--color-text-primary);">
        </div>

        <div style="margin-bottom: var(--spacing-16);">
          <label style="display: block; margin-bottom: var(--spacing-8); color: var(--color-text-secondary);">
            Amount (max: ${maxPoints})
          </label>
          <input type="number" id="donateAmount" min="1" max="${maxPoints}" value="1" style="width: 100%; padding: var(--spacing-8); background: var(--gray-700); border: 1px solid var(--color-border); border-radius: var(--radius-6); color: var(--color-text-primary);">
        </div>

        <div style="margin-bottom: var(--spacing-16);">
          <label style="display: block; margin-bottom: var(--spacing-8); color: var(--color-text-secondary);">
            Include an optional message along with the donation (optional)
          </label>
          <textarea id="donateMessage" maxlength="140" placeholder="Type donation message" style="width: 100%; padding: var(--spacing-8); background: var(--gray-700); border: 1px solid var(--color-border); border-radius: var(--radius-6); color: var(--color-text-primary); min-height: 60px; resize: vertical;"></textarea>
          <div style="text-align: right; font-size: var(--font-size-11); color: var(--color-text-tertiary); margin-top: var(--spacing-4);">
            <span id="messageCharCount">0</span>/140
          </div>
        </div>

        <div style="margin-bottom: var(--spacing-20);">
          <label style="display: flex; align-items: center; gap: var(--spacing-8); cursor: pointer;">
            <input type="checkbox" id="donateToAll">
            <span style="color: var(--color-text-secondary); white-space: nowrap;">Send donation to every alliance member (${totalMembers})</span>
          </label>
        </div>

        <div style="display: flex; gap: var(--spacing-12);">
          <button class="vessel-filter-btn donate-cancel-btn" style="flex: 1; background: var(--gray-700); border-color: var(--color-border); color: var(--color-text-secondary);">Cancel</button>
          <button class="vessel-buy-btn donate-send-btn" style="flex: 1;">Send Donation</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.classList.remove('hidden');

  const amountInput = overlay.querySelector('#donateAmount');
  const messageTextarea = overlay.querySelector('#donateMessage');
  const charCount = overlay.querySelector('#messageCharCount');
  const toAllCheckbox = overlay.querySelector('#donateToAll');
  const closeBtn = overlay.querySelector('.donate-close-btn');
  const cancelBtn = overlay.querySelector('.donate-cancel-btn');
  const sendBtn = overlay.querySelector('.donate-send-btn');

  // Character counter
  messageTextarea.addEventListener('input', () => {
    charCount.textContent = messageTextarea.value.length;
  });

  // Update recipient when checkbox changes
  const recipientInput = overlay.querySelector('input[readonly]');
  toAllCheckbox.addEventListener('change', () => {
    if (toAllCheckbox.checked) {
      recipientInput.value = `All Alliance Members (${totalMembers})`;
    } else {
      recipientInput.value = userName;
    }
  });

  // Close handlers
  const closeDialog = () => {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 300);
  };

  closeBtn.addEventListener('click', closeDialog);
  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  // Send button handler
  sendBtn.addEventListener('click', async () => {
    const amount = parseInt(amountInput.value);
    const message = messageTextarea.value.trim();
    const sendToAll = toAllCheckbox.checked;

    if (isNaN(amount) || amount < 1 || amount > maxPoints) {
      showSideNotification(`Please enter a valid amount (1-${maxPoints})`, 'error');
      return;
    }

    const totalCost = sendToAll ? amount * totalMembers : amount;
    if (totalCost > maxPoints) {
      showSideNotification(`Not enough diamonds. Total cost: ${totalCost}, Available: ${maxPoints}`, 'error');
      return;
    }

    // Confirmation dialog
    const recipientText = sendToAll ? `${totalMembers} alliance members (${totalCost} diamonds total)` : `${userName} (${amount} diamonds)`;
    const confirmed = await showConfirmDialog({
      title: 'Confirm Donation',
      message: `<p>Are you sure you want to donate to <strong>${recipientText}</strong>?</p>${message ? `<p style="margin-top: var(--spacing-12); font-style: italic;">"${escapeHtml(message)}"</p>` : ''}`,
      confirmText: 'Send',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    // Send donation
    try {
      const response = await fetch(window.apiUrl('/api/coop/donate-points'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: sendToAll ? null : userId,
          points: amount,
          message: message || undefined,
          all_members: sendToAll
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send donation');
      }

      showSideNotification(`Successfully donated ${totalCost} diamonds!`, 'success');
      closeDialog();

      // Update points display
      const newPoints = maxPoints - totalCost;
      if (pointsDisplay) {
        pointsDisplay.textContent = newPoints;
      }
    } catch (error) {
      showSideNotification(`Failed to send donation: ${error.message}`, 'error');
    }
  });
}

// Export functions for external use
export { lockCoopButtons, unlockCoopButtons };
