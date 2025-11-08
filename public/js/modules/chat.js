/**
 * @fileoverview Alliance Chat Module - Manages real-time alliance chat functionality with WebSocket support,
 * message rendering, mention autocomplete, and notification handling. This module provides the core
 * communication interface for alliance members to collaborate and coordinate in the Shipping Manager game.
 *
 * Key Features:
 * - Real-time chat updates via WebSocket (server broadcasts every 25 seconds)
 * - User mention system with @username autocomplete (converts to [user_id] format)
 * - Mixed message types: chat messages and system feed events (member joins, route completions)
 * - Smart auto-scroll behavior (maintains position while scrolling up to read history)
 * - Desktop notifications for new messages when window is not focused
 * - Company name caching to reduce API calls
 *
 * Message Flow:
 * 1. Messages loaded from REST API on initial page load
 * 2. WebSocket pushes updates every 25 seconds from server
 * 3. New messages trigger notifications if window not focused
 * 4. Duplicate messages filtered by type+timestamp+content comparison
 *
 * Mention System:
 * - Typing "@" triggers autocomplete with alliance member list
 * - Selecting member inserts [user_id] into message
 * - Server converts [user_id] to @CompanyName on broadcast
 * - Clicking @CompanyName opens private messenger
 *
 * @module chat
 * @requires utils - HTML escaping, feedback, and notification functions
 * @requires api - Backend API calls for chat data and company names
 */

import { escapeHtml, showSideNotification, handleNotifications, showNotification, formatNumber, showChatNotification } from './utils.js';
import { getCompanyNameCached, fetchChat, sendChatMessage, fetchAllianceMembers } from './api.js';
import { updateEventDiscount } from './forecast-calendar.js';
import { updateEventData } from './event-info.js';
import { lockRepairButton, unlockRepairButton, lockBulkBuyButton, unlockBulkBuyButton, lockFuelButton, unlockFuelButton, lockCo2Button, unlockCo2Button } from './vessel-management.js';
import { lockCoopButtons, unlockCoopButtons } from './coop.js';
import { showAnchorTimer } from './anchor-purchase.js';
import { updateCurrentCash, updateCurrentFuel, updateCurrentCO2 } from './bunker-management.js';

/**
 * Converts UTC timestamp string to local timezone string using browser locale.
 * @param {string} utcString - UTC timestamp string (e.g., "Tue, 28 Oct 2025 17:00:00 GMT")
 * @returns {string} Local timezone formatted string (e.g., "Oct 28, 2025, 18:00:00")
 */
function formatLocalTime(utcString) {
  const date = new Date(utcString);
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
 * Array of all chat messages and feed events.
 * Maintained in chronological order. Contains both 'chat' and 'feed' type messages.
 * @type {Array<Object>}
 */
let allMessages = [];

/**
 * Array of alliance members for mention autocomplete.
 * Populated on chat load. Each member has user_id and company_name properties.
 * @type {Array<{user_id: number, company_name: string}>}
 */
let allianceMembers = [];

/**
 * Auto-scroll flag controlling scroll-to-bottom behavior.
 * Set to true when user sends message or is near bottom. Prevents forced scrolling when reading history.
 * @type {boolean}
 */
let autoScroll = true;

/**
 * Parses message text and converts user ID mentions to clickable company name links.
 * Handles the mention system by converting [user_id] patterns to @CompanyName with click handlers.
 *
 * Processing Steps:
 * 1. Escape HTML to prevent XSS attacks
 * 2. Find all [user_id] patterns in the message
 * 3. Fetch company names for all mentioned users (cached API calls)
 * 4. Replace [user_id] with clickable @CompanyName elements
 * 5. Convert newlines to <br> tags
 *
 * Side Effects:
 * - Makes cached API calls to resolve company names
 * - Returns HTML with embedded click handlers
 *
 * @async
 * @param {string} text - Raw message text from API (may contain [user_id] mentions)
 * @returns {Promise<string>} HTML string with mentions converted to clickable links
 *
 * @example
 * // Input: "Hey [123], check out the prices!"
 * // Output: 'Hey <strong class="company-name" data-user-id="123">@CompanyName</strong>, check out the prices!'
 */
export async function parseMessageWithMentions(text) {
  let htmlMessage = escapeHtml(text);
  const mentionIdRegex = /\[(\d+)\]/g;

  let replacementPromises = [];

  const matches = [...htmlMessage.matchAll(mentionIdRegex)];
  matches.forEach(match => {
    const userId = parseInt(match[1]);
    replacementPromises.push(getCompanyNameCached(userId));
  });

  const resolvedNames = await Promise.all(replacementPromises);
  let i = 0;

  htmlMessage = htmlMessage.replace(mentionIdRegex, (match, userId) => {
    const companyName = resolvedNames[i++];
    return `<strong class="company-name" data-user-id="${userId}" style="cursor:pointer;">@${escapeHtml(companyName)}</strong>`;
  });

  return htmlMessage.replace(/\n/g, '<br>');
}

/**
 * Loads and displays alliance chat messages with intelligent duplicate filtering and notifications.
 * This is the core function called both on page load and via WebSocket updates every 25 seconds.
 *
 * Update Strategy:
 * - Fetches latest messages from API
 * - Filters out duplicates using type+timestamp+message comparison
 * - Only re-renders if new messages found
 * - Preserves scroll position unless user is at bottom
 * - Triggers desktop notifications for new messages (if window not focused)
 *
 * No Alliance Handling:
 * - Shows friendly message if user not in alliance
 * - Disables input controls
 * - Suggests using private messages instead
 *
 * Side Effects:
 * - Updates allMessages array
 * - Re-renders chat feed DOM
 * - May trigger desktop notifications
 * - Updates scroll position based on user behavior
 * - May disable input controls if no alliance
 *
 * @async
 * @param {HTMLElement} chatFeed - Chat container DOM element to render messages into
 * @returns {Promise<void>}
 *
 * @example
 * // Called on page load and via WebSocket updates
 * const chatFeed = document.getElementById('chatFeed');
 * loadMessages(chatFeed);
 */
export async function loadMessages(chatFeed) {
  const isScrolledToBottom = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 50;

  try {
    const data = await fetchChat();

    if (data.no_alliance) {
      // User not in alliance - show message immediately (no retry needed)
      chatFeed.innerHTML = `
        <div class="empty-message" style="max-width: 500px; margin: 0 auto;">
          <div style="font-size: 48px; margin-bottom: 20px;">🤝</div>
          <h2 style="color: #60a5fa; margin-bottom: 15px; font-size: 20px;">Ahoy Captain, You're not in an Alliance!</h2>
          <p style="color: #9ca3af; line-height: 1.6;">
            Join an alliance to see the alliance chat here and communicate with your fellow shipping managers.
          </p>
          <p style="color: #9ca3af; margin-top: 10px; font-size: 14px;">
            You can still use private messages via the 📬 button above.
          </p>
        </div>
      `;
      const messageInput = document.getElementById('messageInput');
      const sendMessageBtn = document.getElementById('sendMessageBtn');
      messageInput.disabled = true;
      messageInput.placeholder = "Join an alliance to chat...";
      sendMessageBtn.disabled = true;
      return;
    }

    const newMessages = data.messages || data;

    const newOnly = newMessages.filter(msg =>
      !allMessages.some(existing =>
        existing.type === msg.type && existing.timestamp === msg.timestamp && existing.message === msg.message
      )
    );

    if (newOnly.length > 0 || allMessages.length === 0) {
      allMessages = newMessages;
      await displayMessages(allMessages, chatFeed);

      if (newOnly.length > 0) {
        handleNotifications(newOnly);
      }
    }

    if (isScrolledToBottom || autoScroll) {
      chatFeed.scrollTop = chatFeed.scrollHeight;
      autoScroll = false;
    }

  } catch (error) {
    console.error('Error loading messages:', error);
    if (allMessages.length === 0) {
      chatFeed.innerHTML = '<div class="empty-message" style="color:#ef4444;">Could not connect to chat server.</div>';
    }
  }
}

/**
 * Renders messages to the DOM with appropriate formatting for chat and feed types.
 * Handles asynchronous mention parsing and registers click events for company names.
 *
 * Message Types:
 * - 'chat': User messages with company name, timestamp, and parsed mentions
 * - 'feed': System events (member joins, route completions) with different styling
 *
 * Processing Flow:
 * 1. Check if messages array is empty
 * 2. Map each message to HTML promise (async mention parsing)
 * 3. Await all HTML promises in parallel
 * 4. Render all messages at once (prevents DOM thrashing)
 * 5. Register click events on company names for messenger integration
 *
 * Side Effects:
 * - Replaces entire chatFeed innerHTML
 * - Registers click event listeners on company names
 * - Shows "No messages yet" if array is empty
 *
 * @async
 * @param {Array<Object>} messagesToDisplay - Array of message objects to render
 * @param {string} messagesToDisplay[].type - Message type: 'chat' or 'feed'
 * @param {HTMLElement} chatFeed - Container element to render messages into
 * @returns {Promise<void>}
 */
export async function displayMessages(messagesToDisplay, chatFeed) {
  if (!messagesToDisplay || messagesToDisplay.length === 0) {
    chatFeed.innerHTML = '<div class="empty-message">No messages yet</div>';
    return;
  }

  const messageHtmlPromises = messagesToDisplay.map(async msg => {
    if (msg.type === 'chat') {
      const userId = parseInt(msg.user_id);
      const parsedMessage = await parseMessageWithMentions(msg.message);

      return `
        <div class="message">
          <div class="message-header">
            <span class="company-name" data-user-id="${userId}" style="cursor:pointer;">${escapeHtml(msg.company)}</span>
            <span class="timestamp">${formatLocalTime(msg.timestamp)}</span>
          </div>
          <div class="message-text">${parsedMessage}</div>
        </div>
      `;
    } else if (msg.type === 'feed') {
      return `
        <div class="message feed">
          <div class="message-header">
            <span>SYSTEM: ${msg.feedType}</span>
            <span class="timestamp">${formatLocalTime(msg.timestamp)}</span>
          </div>
          <div class="message-text">${escapeHtml(msg.company)}</div>
        </div>
      `;
    }
  });

  const messageHtmls = await Promise.all(messageHtmlPromises);
  chatFeed.innerHTML = messageHtmls.join('');

  registerUsernameClickEvents();
}

/**
 * Sends a chat message to the alliance feed with validation and UI updates.
 * Handles the complete flow from user input to API submission and UI refresh.
 *
 * Validation:
 * - Trims whitespace
 * - Enforces 1-1000 character limit
 * - Prevents empty messages
 *
 * Processing Flow:
 * 1. Validate message content
 * 2. Disable input controls (prevents double-send)
 * 3. Submit to API
 * 4. Clear input and reset UI state
 * 5. Enable auto-scroll for new message
 * 6. Refresh chat after 500ms delay
 * 7. Re-enable controls
 *
 * Side Effects:
 * - Disables/enables message input and send button
 * - Clears message input on success
 * - Resets textarea height to auto
 * - Updates character count display
 * - Sets autoScroll flag to true
 * - Triggers chat reload after 500ms
 * - Shows success/error feedback
 *
 * @async
 * @param {HTMLTextAreaElement} messageInput - Textarea element for message input
 * @param {HTMLElement} charCount - Element showing character count
 * @param {HTMLButtonElement} sendMessageBtn - Send button element
 * @param {HTMLElement} chatFeed - Chat container for reloading messages
 * @returns {Promise<void>}
 */
export async function sendMessage(messageInput, charCount, sendMessageBtn, chatFeed) {
  const message = messageInput.value.trim();
  if (!message || message.length > 1000) {
    showSideNotification('Invalid message length or content.', 'error');
    return;
  }

  sendMessageBtn.disabled = true;
  messageInput.disabled = true;

  try {
    await sendChatMessage(message);

    messageInput.value = '';
    messageInput.style.height = 'auto';
    charCount.textContent = '0 / 1000 characters';
    showSideNotification('Message sent!', 'success');
    autoScroll = true;

    setTimeout(() => loadMessages(chatFeed), 500);
  } catch (error) {
    showSideNotification(`Error: ${error.message}`, 'error');
  } finally {
    sendMessageBtn.disabled = false;
    messageInput.disabled = false;
    handleMessageInput(messageInput, charCount);
  }
}

/**
 * Loads alliance members list for mention autocomplete functionality.
 * Fetches and caches the member list in module-level variable for autocomplete suggestions.
 *
 * @async
 * @returns {Promise<Array<{user_id: number, company_name: string}>>} Array of alliance members
 *
 * @example
 * // Called on chat initialization
 * const members = await loadAllianceMembers();
 * // members = [{ user_id: 123, company_name: "Company A" }, ...]
 */
export async function loadAllianceMembers() {
  allianceMembers = await fetchAllianceMembers();
  return allianceMembers;
}

/**
 * Handles message input changes including auto-resize, character count, and mention autocomplete.
 * Called on every input event in the message textarea.
 *
 * Features:
 * - Auto-resizes textarea up to 240px max height
 * - Updates character count with warning/error states
 * - Triggers mention autocomplete when "@" is typed
 *
 * Character Count States:
 * - Normal: 0-900 characters (default style)
 * - Warning: 901-1000 characters (yellow)
 * - Error: >1000 characters (red)
 *
 * Side Effects:
 * - Adjusts textarea height based on content
 * - Updates character count element text and style
 * - Triggers mention autocomplete overlay
 *
 * @param {HTMLTextAreaElement} messageInput - Message textarea element
 * @param {HTMLElement} charCount - Character count display element
 */
export function handleMessageInput(messageInput, charCount) {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 240) + 'px';

  const currentLength = messageInput.value.length;
  charCount.textContent = `${currentLength} / 1000 characters`;
  charCount.className = 'char-count';

  if (currentLength > 900) {
    charCount.classList.add(currentLength > 1000 ? 'error' : 'warning');
  }

  handleMentionAutocomplete(messageInput);
}

/**
 * Triggers mention autocomplete when user types @ symbol
 * @param {HTMLTextAreaElement} messageInput - Message textarea element
 */
function handleMentionAutocomplete(messageInput) {
  const text = messageInput.value;
  const match = text.match(/@([^\s\n]*)$/);
  if (match) {
    const query = match[1].toLowerCase();

    const filteredMembers = allianceMembers.filter(member =>
      member.company_name.toLowerCase().includes(query)
    ).slice(0, 10);

    displaySuggestions(filteredMembers, text.lastIndexOf('@'), messageInput);
  } else {
    hideMemberSuggestions();
  }
}

/**
 * Displays filtered alliance member suggestions below message input
 * @param {Array<Object>} members - Filtered alliance members
 * @param {number} atIndex - Index position of @ symbol in text
 * @param {HTMLTextAreaElement} messageInput - Message textarea element
 */
function displaySuggestions(members, atIndex, messageInput) {
  let suggestionBox = document.getElementById('memberSuggestions');
  if (!suggestionBox) {
    suggestionBox = document.createElement('div');
    suggestionBox.id = 'memberSuggestions';
    suggestionBox.classList.add('hidden'); // Start hidden
    const inputWrapper = document.querySelector('.input-wrapper') || messageInput.parentElement;
    inputWrapper.appendChild(suggestionBox);
  }

  if (members.length === 0) {
    hideMemberSuggestions();
    return;
  }

  suggestionBox.innerHTML = members.map(member => `
    <div class="member-suggestion" data-user-id="${member.user_id}" data-company="${escapeHtml(member.company_name)}">
      ${escapeHtml(member.company_name)}
    </div>
  `).join('');

  suggestionBox.querySelectorAll('.member-suggestion').forEach(item => {
    item.addEventListener('click', () => {
      insertMention(item.dataset.userId, atIndex, messageInput);
      hideMemberSuggestions();
    });
  });

  suggestionBox.classList.remove('hidden');
}

/**
 * Hides mention autocomplete suggestion box
 */
function hideMemberSuggestions() {
  const suggestionBox = document.getElementById('memberSuggestions');
  if (suggestionBox) {
    suggestionBox.classList.add('hidden');
  }
}

/**
 * Inserts selected user mention as [user_id] into message input
 * @param {string} userId - User ID to mention
 * @param {number} atIndex - Index position of @ symbol
 * @param {HTMLTextAreaElement} messageInput - Message textarea element
 */
function insertMention(userId, atIndex, messageInput) {
  const text = messageInput.value;
  const beforeAt = text.substring(0, atIndex);
  const newText = beforeAt + `[${userId}] ` + text.substring(text.length);

  messageInput.value = newText;
  messageInput.focus();
  const charCount = document.getElementById('charCount');
  handleMessageInput(messageInput, charCount);
}

/**
 * Registers click handlers on company names to open private messenger
 */
function registerUsernameClickEvents() {
  document.querySelectorAll('.company-name').forEach(nameElement => {
    const userId = parseInt(nameElement.dataset.userId);
    const companyName = nameElement.textContent.replace(/^@/, '');

    if (userId && !nameElement.hasAttribute('data-has-click-handler')) {
      nameElement.setAttribute('data-has-click-handler', 'true');
      nameElement.addEventListener('click', () => {
        if (window.openMessengerFromChat) {
          window.openMessengerFromChat(companyName, userId);
        }
      });
    }
  });
}

/**
 * Handles backend auto-repair completion events from WebSocket.
 * Displays notification with vessel wear percentages and threshold info.
 *
 * The backend (server/automation.js) broadcasts 'auto_repair_complete' events
 * after successfully repairing vessels. This handler:
 * - Shows in-app feedback notification
 * - Displays individual vessel wear percentages
 * - Shows maintenance threshold from settings
 * - Sends browser notification if enabled
 * - Triggers UI updates for vessel and cash displays
 *
 * @param {Object} data - Repair completion data from backend
 * @param {number} data.count - Number of vessels repaired
 * @param {number} data.totalCost - Total repair cost
 * @param {Array<Object>} data.repairs - Array of repair details per vessel
 * @param {string} data.repairs[].name - Vessel name
 * @param {number} data.repairs[].wear - Vessel wear percentage
 * @param {number} data.repairs[].cost - Repair cost for this vessel
 * @param {string} data.message - Formatted message for display
 */
function handleBackendAutoRepairComplete(data) {
  const { count, totalCost, repairs, message } = data;

  // Get current settings for threshold
  const settings = window.getSettings ? window.getSettings() : {};
  const threshold = settings.maintenanceThreshold !== undefined ? settings.maintenanceThreshold : 10;

  // Build detailed feedback message
  let feedbackMsg = `🔧 Yard Foreman: ${count} vessel(s) repaired for $${totalCost.toLocaleString()}`;
  if (repairs && repairs.length > 0) {
    feedbackMsg += '\n\nRepaired vessels:';
    repairs.forEach(repair => {
      feedbackMsg += `\n• ${repair.name}: ${repair.wear}% wear → $${repair.cost.toLocaleString()}`;
    });
    feedbackMsg += `\n\n(Threshold: ${threshold}%)`;
  }

  // Show in-app notification
  showSideNotification(feedbackMsg, 'success');

  // Send browser notification if enabled
  const desktopNotifsEnabled = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
  if (desktopNotifsEnabled && Notification.permission === 'granted') {
    showNotification(`🔧 Yard Foreman - ${count} vessel${count > 1 ? 's' : ''} repaired`, {
      body: `\nCost: $${totalCost.toLocaleString()}\nThreshold: ${threshold}%`,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>🔧</text></svg>",
      tag: 'yard-foreman',
      silent: false
    });
  }

  // Trigger UI updates
  if (window.debouncedUpdateRepairCount) {
    window.debouncedUpdateRepairCount(500);
  }
  if (window.debouncedUpdateBunkerStatus) {
    window.debouncedUpdateBunkerStatus(500);
  }
}

// WebSocket connection tracking
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // Max 30 seconds between reconnect attempts

/**
 * Initializes WebSocket connection for real-time chat updates.
 * Establishes WSS connection and handles incoming message broadcasts from server.
 *
 * WebSocket Message Types:
 * - 'chat_update': Server broadcasts new messages every 25 seconds
 * - 'message_sent': Immediate update when any user sends a message
 * - 'settings_update': Broadcasts when settings change (triggers global callback)
 * - 'auto_repair_complete': Backend auto-repair completion notification
 *
 * Connection Strategy:
 * - Uses WSS for HTTPS pages, WS for HTTP
 * - Connects to same host as the page
 * - Automatically reconnects on disconnect with exponential backoff
 * - Fails silently if WebSocket not available
 *
 * Reconnect Logic:
 * - First reconnect: immediate
 * - Subsequent reconnects: exponential backoff (1s, 2s, 4s, 8s, ... up to 30s)
 * - Resets reconnect counter on successful connection
 *
 * Side Effects:
 * - Creates WebSocket connection
 * - Registers onmessage, onopen, onclose, onerror event handlers
 * - Triggers loadMessages() on chat updates
 * - Calls global handleSettingsUpdate() callback if available
 * - Calls handleBackendAutoRepairComplete() for repair events
 *
 * @example
 * // Called once on page load
 * initWebSocket();
 * // Server broadcasts every 25 seconds: { type: 'chat_update', data: [...messages] }
 */
export function initWebSocket() {
  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    const chatFeed = document.getElementById('chatFeed');

    ws.onopen = async () => {
      console.log('[WebSocket] Connected');
      reconnectAttempts = 0; // Reset reconnect counter on successful connection

      // Hide connection lost overlay
      const overlay = document.getElementById('connectionLostOverlay');
      if (overlay) {
        overlay.classList.add('hidden');
      }

      // CRITICAL: Check for account switch on reconnect (e.g., server restarted with different account)
      // If browser tab stayed open but server switched accounts, we need to reload the page
      try {
        const settingsResponse = await fetch('/api/settings');
        if (settingsResponse.ok) {
          const settings = await settingsResponse.json();
          const currentUserId = window.USER_STORAGE_PREFIX; // Set during initial page load
          const newUserId = settings.userId;

          // Account changed - reload page to get fresh DOM
          if (currentUserId && currentUserId !== newUserId) {
            console.log(`[WebSocket Reconnect] Account changed from ${currentUserId} to ${newUserId} - reloading page`);
            window.location.reload();
            return;
          }
        }
      } catch (error) {
        console.error('[WebSocket Reconnect] Failed to check account switch:', error);
      }
    };

    ws.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 'chat_update' || type === 'message_sent') {
        loadMessages(chatFeed);
        // Reload alliance members for @mention autocomplete (in case new member joined)
        loadAllianceMembers();
      } else if (type === 'settings_update') {
        if (window.handleSettingsUpdate) {
          window.handleSettingsUpdate(data);
        }
      } else if (type === 'auto_repair_complete') {
        handleBackendAutoRepairComplete(data);
      } else if (type === 'price_update') {
        handlePriceUpdate(data);
      } else if (type === 'price_alert') {
        handlePriceAlert(data);
      } else if (type === 'fuel_purchased') {
        handleFuelPurchased(data);
      } else if (type === 'co2_purchased') {
        handleCO2Purchased(data);
      } else if (type === 'autopilot_depart_start') {
        handleAutopilotDepartStart(data);
      } else if (type === 'vessels_depart_complete') {
        handleVesselsDepartComplete(data);
      } else if (type === 'vessels_departed') {
        handleVesselsDeparted(data);
      } else if (type === 'vessels_failed') {
        handleVesselsFailed(data);
      } else if (type === 'vessels_repaired') {
        handleVesselsRepaired(data);
      } else if (type === 'campaigns_renewed') {
        handleCampaignsRenewed(data);
      } else if (type === 'auto_coop_complete') {
        handleAutoCoopComplete(data);
      } else if (type === 'auto_coop_no_targets') {
        handleAutoCoopNoTargets(data);
      } else if (type === 'bunker_update') {
        handleBunkerUpdate(data);
      } else if (type === 'vessel_count_update') {
        handleVesselCountUpdate(data);
      } else if (type === 'repair_count_update') {
        handleRepairCountUpdate(data);
      } else if (type === 'campaign_status_update') {
        handleCampaignStatusUpdate(data);
      } else if (type === 'unread_messages_update') {
        handleUnreadMessagesUpdate(data);
      } else if (type === 'messenger_update') {
        // Update messenger badge from 10-second polling
        handleMessengerUpdate(data);
      } else if (type === 'autopilot_status') {
        // Call global function to update pause/play button
        if (window.onAutopilotStatusUpdate) {
          window.onAutopilotStatusUpdate(data);
        }
      } else if (type === 'hijacking_update') {
        handleHijackingUpdate(data);
      } else if (type === 'notification') {
        // Generic notification from backend (e.g., errors, warnings, info)
        handleGenericNotification(data);
      } else if (type === 'user_action_notification') {
        handleUserActionNotification(data);
      } else if (type === 'coop_update') {
        handleCoopUpdate(data);
      } else if (type === 'company_type_update') {
        handleCompanyTypeUpdate(data);
      } else if (type === 'header_data_update') {
        handleHeaderDataUpdate(data);
      } else if (type === 'event_data_update') {
        handleEventDataUpdate(data);
      } else if (type === 'logbook_update') {
        // Logbook entry update (new autopilot action logged)
        if (window.handleLogbookUpdate) {
          window.handleLogbookUpdate(data);
        }
      } else if (type === 'all_data_updated') {
        // Show summary line with all current values (only in summary mode)
        if (AUTOPILOT_LOG_LEVEL === 'summary' || AUTOPILOT_LOG_LEVEL === 'detailed') {
          const c = updateDataCache;
          const stockTrend = c.stock.trend === 'up' ? '↑' : c.stock.trend === 'down' ? '↓' : '→';
          const cashStr = (c.bunker.cash / 1000000).toFixed(1);
          console.log(`[Autopilot] Update: Ready=${c.vessels.ready}, Anchor=${c.vessels.anchor}, Pending=${c.vessels.pending}, Repair=${c.repair}, Campaigns=${c.campaigns}, Messages=${c.messages}, Fuel=${Math.floor(c.bunker.fuel)}t, CO2=${Math.floor(c.bunker.co2)}t, Cash=$${cashStr}M, Points=${c.bunker.points}, Stock=${c.stock.value.toFixed(2)}${stockTrend}, COOP=${c.coop.available}/${c.coop.cap}`);
        }
      } else if (type === 'repair_start') {
        lockRepairButton();
      } else if (type === 'repair_complete') {
        unlockRepairButton();
      } else if (type === 'bulk_buy_start') {
        lockBulkBuyButton();
      } else if (type === 'bulk_buy_complete') {
        unlockBulkBuyButton();
      } else if (type === 'coop_send_start') {
        lockCoopButtons();
      } else if (type === 'coop_send_complete') {
        unlockCoopButtons();
      } else if (type === 'anchor_purchase_timer') {
        showAnchorTimer(data.anchor_next_build, data.pending_amount);
      } else if (type === 'fuel_purchase_start') {
        lockFuelButton();
      } else if (type === 'fuel_purchase_complete') {
        unlockFuelButton();
      } else if (type === 'co2_purchase_start') {
        lockCo2Button();
      } else if (type === 'co2_purchase_complete') {
        unlockCo2Button();
      }
    };

    ws.onclose = () => {
      console.log('[WebSocket] Disconnected');
      attemptReconnect();
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
      ws.close(); // Trigger onclose which will attempt reconnect
    };

  } catch (e) {
    console.error('[WebSocket] Failed to initialize:', e);
    attemptReconnect();
  }
}

/**
 * Attempts to reconnect WebSocket with exponential backoff.
 * Delay increases exponentially: 0ms, 1s, 2s, 4s, 8s, 16s, 30s (max)
 * Shows connection lost overlay after 3 failed attempts.
 */
function attemptReconnect() {
  reconnectAttempts++;

  // Show connection lost overlay after 3 failed attempts
  if (reconnectAttempts >= 3) {
    const overlay = document.getElementById('connectionLostOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
    }
  }

  // Calculate delay with exponential backoff (capped at MAX_RECONNECT_DELAY)
  const delay = Math.min(
    reconnectAttempts === 1 ? 0 : Math.pow(2, reconnectAttempts - 2) * 1000,
    MAX_RECONNECT_DELAY
  );

  console.log(`[WebSocket] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);

  setTimeout(() => {
    console.log('[WebSocket] Attempting reconnect...');
    initWebSocket();
  }, delay);
}

/**
 * Sets up scroll event listener to manage auto-scroll behavior intelligently.
 * Detects when user is near the bottom of chat to enable automatic scrolling for new messages.
 *
 * Auto-Scroll Logic:
 * - Enabled when user is within 50px of bottom
 * - Disabled when user scrolls up to read history
 * - Prevents forced scrolling while user is browsing old messages
 *
 * This provides a good UX where new messages automatically scroll into view when user
 * is already at the bottom, but doesn't interrupt reading when scrolled up.
 *
 * Side Effects:
 * - Registers scroll event listener on chat feed
 * - Updates module-level autoScroll flag
 *
 * @param {HTMLElement} chatFeed - Chat container element to monitor
 *
 * @example
 * // Called once on page load
 * const chatFeed = document.getElementById('chatFeed');
 * setChatScrollListener(chatFeed);
 */
export function setChatScrollListener(chatFeed) {
  chatFeed.addEventListener('scroll', () => {
    autoScroll = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 50;
  });
}

// ============================================================================
// Backend Autopilot Event Handlers
// ============================================================================

/**
 * Log level for autopilot events
 * 'off' = No autopilot logs (production mode)
 * 'summary' = Only show summary line when all data updated
 * 'detailed' = Show individual events (price changes, actions, etc.)
 */
const AUTOPILOT_LOG_LEVEL = 'off'; // Change to 'summary' or 'detailed' for debug logs

/**
 * Cache for collecting update data to display in summary
 */
const updateDataCache = {
  vessels: { ready: 0, anchor: 0, pending: 0 },
  repair: 0,
  campaigns: 0,
  messages: 0,
  bunker: { fuel: 0, co2: 0, cash: 0, points: 0 },
  prices: { fuel: 0, co2: 0 },
  coop: { available: 0, cap: 0 },
  stock: { value: 0, trend: '' },
  anchor: { available: 0, max: 0 }
};

// Export to window for access from other modules (e.g., anchor purchase dialog)
window.updateDataCache = updateDataCache;

/**
 * Handles price updates from backend autopilot.
 * Prices are displayed in bunker management module.
 * Note: Bunker state (fuel/CO2/cash) comes separately via bunker_update event.
 */
function handlePriceUpdate(data) {
  const { fuel, co2, eventDiscount, regularFuel, regularCO2 } = data;
  updateDataCache.prices = { fuel, co2, eventDiscount, regularFuel, regularCO2 };

  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    if (eventDiscount) {
      console.log(`[Autopilot] EVENT: ${eventDiscount.percentage}% off ${eventDiscount.type} - Fuel=$${fuel}/t (was $${regularFuel}/t), CO2=$${co2}/t (was $${regularCO2}/t)`);
    } else {
      console.log(`[Autopilot] Price update: Fuel=$${fuel}/t, CO2=$${co2}/t`);
    }
  }

  // Update bunker module price displays
  const fuelPrice = document.getElementById('fuelPrice');
  if (fuelPrice) {
    fuelPrice.textContent = `$${fuel}/t`;
  }

  const co2Price = document.getElementById('co2Price');
  if (co2Price) {
    co2Price.textContent = `$${co2}/t`;
  }

  // Update header price displays with color classes
  const fuelPriceDisplay = document.getElementById('fuelPriceDisplay');
  // Only update if we have a valid price (> 0), otherwise keep last known value
  if (fuelPriceDisplay && fuel !== undefined && fuel > 0) {
    // Build price text with optional discount badge
    let priceText = `$${fuel}/t`;
    if (eventDiscount && eventDiscount.type === 'fuel') {
      priceText += ` <span class="discount-badge">-${eventDiscount.percentage}%</span>`;
    }
    fuelPriceDisplay.innerHTML = priceText;

    // Apply forecast color classes
    fuelPriceDisplay.className = ''; // Clear existing classes

    // Get settings if available
    const settings = window.getSettings ? window.getSettings() : null;

    // Check if below alert threshold (pulse animation)
    if (settings && settings.fuelThreshold && fuel < settings.fuelThreshold) {
      fuelPriceDisplay.className = 'price-pulse-alert';
    } else {
      // Apply standard color based on price ranges
      if (fuel >= 800) {
        fuelPriceDisplay.className = 'fuel-red';
      } else if (fuel >= 600) {
        fuelPriceDisplay.className = 'fuel-orange';
      } else if (fuel >= 400) {
        fuelPriceDisplay.className = 'fuel-blue';
      } else if (fuel >= 1) {
        fuelPriceDisplay.className = 'fuel-green';
      }
    }
  }

  const co2PriceDisplay = document.getElementById('co2PriceDisplay');
  // Only update if we have a VALID price from API (not 0, not undefined, not null)
  // If invalid, keep the last known cached value - DO NOT show fake values
  if (co2PriceDisplay && co2 !== undefined && co2 !== null && co2 !== 0) {
    // Build price text with optional discount badge
    let priceText = `$${co2}/t`;
    if (eventDiscount && eventDiscount.type === 'co2') {
      priceText += ` <span class="discount-badge">-${eventDiscount.percentage}%</span>`;
    }
    co2PriceDisplay.innerHTML = priceText;

    // Apply forecast color classes
    co2PriceDisplay.className = ''; // Clear existing classes

    // Get settings if available
    const settings = window.getSettings ? window.getSettings() : null;

    // Special styling for negative prices (you get paid!)
    // Note: co2 can never be 0 here due to outer check, only negative
    if (co2 < 0) {
      co2PriceDisplay.className = 'co2-negative';
    } else if (settings && settings.co2Threshold && co2 < settings.co2Threshold) {
      // Check if below alert threshold (pulse animation)
      co2PriceDisplay.className = 'price-pulse-alert';
    } else {
      // Apply standard color based on price ranges
      if (co2 >= 20) {
        co2PriceDisplay.className = 'co2-red';
      } else if (co2 >= 15) {
        co2PriceDisplay.className = 'co2-orange';
      } else if (co2 >= 10) {
        co2PriceDisplay.className = 'co2-blue';
      } else if (co2 >= 1) {
        co2PriceDisplay.className = 'co2-green';
      }
    }
  }

  // Update forecast with event discount and full event data
  if (eventDiscount) {
    updateEventDiscount(eventDiscount, cachedEventData);
  } else {
    updateEventDiscount(null, null);
  }

  // Cache prices AND event discount for next page load - only if valid
  if (window.saveBadgeCache && fuel > 0 && co2 > 0) {
    window.saveBadgeCache({
      prices: {
        fuelPrice: fuel,
        co2Price: co2,
        eventDiscount: eventDiscount,
        regularFuel: regularFuel,
        regularCO2: regularCO2
      }
    });
  }
}

/**
 * Handles price alerts from backend autopilot.
 * Shows center alert with spin animation and desktop notification.
 */
async function handlePriceAlert(data) {
  const { type, price, threshold } = data;
  const emoji = type === 'fuel' ? '⛽' : '💨';
  const label = type === 'fuel' ? 'Fuel' : 'CO2';

  console.log(`[Autopilot] Price alert: ${label} = $${price}/t (threshold: $${threshold}/t)`);

  // Show center alert (existing price alert mechanism)
  if (window.showPriceAlert) {
    window.showPriceAlert({ type, price, threshold });
  }

  // Show desktop notification
  const settings = window.getSettings ? window.getSettings() : {};
  console.log('[Autopilot] Desktop notification check:', {
    hasSettings: !!window.getSettings,
    enableDesktopNotifications: settings.enableDesktopNotifications,
    notificationPermission: Notification.permission,
    willShow: settings.enableDesktopNotifications && Notification.permission === 'granted'
  });

  if (settings.enableDesktopNotifications && Notification.permission === 'granted') {
    await showNotification(`${emoji} ${label} Price Alert - $${price}/t`, {
      body: `Price dropped to $${price}/t (threshold: $${threshold}/t)`,
      icon: `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>${emoji}</text></svg>`,
      tag: `price-alert-${type}`,
      silent: false
    });
  }

  // Show side notification
  showSideNotification(`${emoji} <strong>${label} Price Alert!</strong><br><br>New price now $${price}/t`, 'success', null, true);
}

/**
 * Handles fuel purchased event from backend autopilot.
 * Shows notification and updates bunker display.
 */
async function handleFuelPurchased(data) {
  const { amount, price, newTotal, cost } = data;

  console.log(`[Autopilot] Fuel purchased: ${amount}t @ $${price}/t = $${Math.round(cost).toLocaleString()} (new total: ${newTotal.toFixed(1)}t)`);

  const settings = window.getSettings ? window.getSettings() : {};

  // In-app alert
  if (settings.autoPilotNotifications && settings.notifyBarrelBossInApp) {
    showSideNotification(`
      <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
        <strong style="font-size: 1.1em;">⛽ Barrel Boss</strong>
      </div>
      <div style="font-family: monospace; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span>Amount:</span>
          <span><strong>${amount.toFixed(0)}t</strong></span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span>Price per ton:</span>
          <span>$${price.toLocaleString()}/t</span>
        </div>
        <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 15px;">
          <span><strong>Total Cost:</strong></span>
          <span style="color: #ef4444;"><strong>$${Math.round(cost).toLocaleString()}</strong></span>
        </div>
      </div>
    `, 'success');
  }

  // Desktop notification
  if (settings.autoPilotNotifications && settings.enableDesktopNotifications && settings.notifyBarrelBossDesktop && Notification.permission === 'granted') {
    await showNotification(`⛽ Barrel Boss - ${formatNumber(amount)}t @ $${price}/t`, {
      body: `\nTotal: $${Math.round(cost).toLocaleString()}`,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>⛽</text></svg>",
      tag: 'barrel-boss',
      silent: false
    });
  }

  // Note: Bunker update comes automatically via bunker_update event from backend
}

/**
 * Handles CO2 purchased event from backend autopilot.
 * Shows notification and updates bunker display.
 */
async function handleCO2Purchased(data) {
  const { amount, price, newTotal, cost } = data;

  console.log(`[Autopilot] CO2 purchased: ${amount}t @ $${price}/t = $${Math.round(cost).toLocaleString()} (new total: ${newTotal.toFixed(1)}t)`);

  const settings = window.getSettings ? window.getSettings() : {};

  // In-app alert
  if (settings.autoPilotNotifications && settings.notifyAtmosphereBrokerInApp) {
    showSideNotification(`
      <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
        <strong style="font-size: 1.1em;">💨 Atmosphere Broker</strong>
      </div>
      <div style="font-family: monospace; font-size: 13px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span>Amount:</span>
          <span><strong>${amount.toFixed(0)}t</strong></span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span>Price per ton:</span>
          <span>$${price.toLocaleString()}/t</span>
        </div>
        <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 15px;">
          <span><strong>Total Cost:</strong></span>
          <span style="color: #ef4444;"><strong>$${Math.round(cost).toLocaleString()}</strong></span>
        </div>
      </div>
    `, 'success');
  }

  // Desktop notification
  if (settings.autoPilotNotifications && settings.enableDesktopNotifications && settings.notifyAtmosphereBrokerDesktop && Notification.permission === 'granted') {
    await showNotification(`💨 Atmosphere Broker - ${formatNumber(amount)}t @ $${price}/t`, {
      body: `\nTotal: $${Math.round(cost).toLocaleString()}`,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>💨</text></svg>",
      tag: 'atmosphere-broker',
      silent: false
    });
  }

  // Note: Bunker update comes automatically via bunker_update event from backend
}

/**
 * Handles combined vessels depart complete event from backend autopilot.
 * Shows a single notification with both succeeded and failed vessels.
 */
async function handleVesselsDepartComplete(data) {
  const { succeeded, failed, bunker } = data;
  const totalVessels = succeeded.count + failed.count;

  console.log(`[Autopilot] Depart complete: ${succeeded.count} succeeded, ${failed.count} failed`);

  // Log vessel details
  if (succeeded.vessels && succeeded.vessels.length > 0) {
    succeeded.vessels.forEach(v => {
      console.log(`[Vessel Depart] ${v.name}: income=$${v.income}, harborFee=$${v.harborFee}`);
      const profitability = v.income - v.harborFee;
      if (profitability < 0) {
        console.warn(`[HIGH HARBOR FEE] ${v.name}: Harbor fee exceeds income by $${Math.abs(profitability)}`);
      }
    });
  }

  // Build header based on outcome
  let headerIcon = '🤖';
  let headerText = '';

  if (succeeded.count > 0 && failed.count === 0) {
    // All succeeded
    headerIcon = '';
    headerText = `🚢 Cargo Marshal`;
  } else if (succeeded.count === 0 && failed.count > 0) {
    // All failed
    headerIcon = '⚠️';
    headerText = `🚢 Cargo Marshal<br><u>${failed.count} vessel${failed.count > 1 ? 's' : ''} could not depart</u>`;
  } else {
    // Mixed results
    headerIcon = '🤖';
    headerText = `🚢 Cargo Marshal<br><u>${succeeded.count} departed, ${failed.count} failed</u>`;
  }

  // Build success section
  let successSection = '';
  if (succeeded.count > 0) {
    const settings = window.getSettings ? window.getSettings() : {};
    const harborFeeThreshold = settings.harborFeeWarningThreshold;
    const totalHarborFees = succeeded.vessels.reduce((sum, v) => sum + (v.harborFee || 0), 0);

    // Check for high harbor fee vessels (only if threshold is set)
    const highFeeCount = harborFeeThreshold ? succeeded.vessels.filter(v => {
      const feePercentage = (v.harborFee / v.income) * 100;
      return feePercentage > harborFeeThreshold;
    }).length : 0;

    const vesselList = succeeded.vessels.map(v => {
      const feePercentage = Math.round((v.harborFee / v.income) * 100);
      const isHighFee = harborFeeThreshold && feePercentage > harborFeeThreshold;
      const warningIcon = isHighFee ? '⚠️' : '';

      return `<div style="font-size: 0.8em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
        <div>${warningIcon}🚢 <strong>${v.name}</strong> | 💰 $${formatNumber(v.income)}</div>
        <div style="font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
          Utilization: ${formatNumber(v.cargoLoaded)}/${formatNumber(v.capacity)} TEU (${(v.utilization * 100).toFixed(0)}%)
        </div>
        <div style="font-size: 0.9em; color: ${isHighFee ? '#f59e0b' : '#9ca3af'}; margin-top: 2px;">
          ${isHighFee ? '⚠️ ' : ''}Harbor fee: ${feePercentage}% ($${formatNumber(v.harborFee)})
        </div>
      </div>`;
    }).join('');

    const harborFeeLabel = highFeeCount > 0 ? '⚠️ Harbor Fees (total):' : 'Harbor Fees (total):';
    const vesselDepartedLabel = highFeeCount > 0
      ? `✅ ${succeeded.count} vessel${succeeded.count > 1 ? 's' : ''} departed (${highFeeCount} ⚠️)`
      : `✅ ${succeeded.count} vessel${succeeded.count > 1 ? 's' : ''} departed`;

    successSection = `
      <div class="notification-summary-box">
        <div style="color: #4ade80; font-weight: bold; margin-bottom: 8px;">${vesselDepartedLabel}</div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: #9ca3af;">Net Profit:</span>
          <span style="color: #4ade80; font-weight: bold;">$${formatNumber(succeeded.totalIncome)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span style="color: ${highFeeCount > 0 ? '#f59e0b' : '#9ca3af'};">${harborFeeLabel}</span>
          <span style="color: #9ca3af;">$${formatNumber(totalHarborFees)}</span>
        </div>
        <div style="margin-top: 4px;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.9em; color: #9ca3af;">
          <span>Used ⛽ Fuel:</span>
          <span>${formatNumber(succeeded.totalFuelUsed)}t</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
          <span>Used 💨 CO2:</span>
          <span>${formatNumber(succeeded.totalCO2Used)}t</span>
        </div>
      </div>
      <div style="margin: 12px 0; border-top: 1px solid rgba(255,255,255,0.2);"></div>
      <div class="notification-vessel-list">
        ${vesselList}
      </div>`;
  }

  // Build failure section
  let failureSection = '';
  if (failed.count > 0) {
    const failedList = failed.vessels.map(v => {
      const cleanName = v.name.replace(/^(MV|MS|MT|SS)\s+/i, '');
      return `<div style="font-size: 0.85em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
        🚢 <strong>${cleanName}</strong> <span style="color: #ef4444;">${v.reason}</span>
      </div>`;
    }).join('');

    const bunkerInfo = bunker ? `
      <div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,0.15); border-radius: 4px; font-size: 0.85em;">
        <div style="color: #9ca3af; margin-bottom: 4px;">Current bunker:</div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #9ca3af;">⛽ Fuel:</span>
          <span style="color: #fff;">${formatNumber(Math.floor(bunker.fuel))} t</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #9ca3af;">💨 CO2:</span>
          <span style="color: #fff;">${formatNumber(Math.floor(bunker.co2))} t</span>
        </div>
      </div>` : '';

    failureSection = `
      <div class="notification-summary-box" style="background: rgba(239,68,68,0.1); border-left: 3px solid #ef4444;">
        <div style="color: #ef4444; font-weight: bold; margin-bottom: 8px;">⚠️ ${failed.count} vessel${failed.count > 1 ? 's' : ''} could not depart</div>
        ${bunkerInfo}
        <div style="margin-top: 8px;">
          ${failedList}
        </div>
      </div>`;
  }

  const message = `
    <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
      <strong style="font-size: 1.1em;">${headerIcon} ${headerText}</strong>
    </div>
    ${successSection}
    ${failureSection}`;

  // Determine notification type based on outcome
  const notificationType = succeeded.count > 0 ? 'success' : 'warning';

  // In-app notification
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.autoPilotNotifications && settings.notifyCargoMarshalInApp) {
    showSideNotification(message, notificationType, 15000);
  }

  // Separate Harbor Fee Warning Notification (only if threshold is set)
  if (succeeded.count > 0 && settings.harborFeeWarningThreshold) {
    const harborFeeThreshold = settings.harborFeeWarningThreshold;
    const highFeeVessels = succeeded.vessels.filter(v => {
      const grossIncome = v.income + v.harborFee;
      const feePercentage = (v.harborFee / grossIncome) * 100;
      return feePercentage > harborFeeThreshold;
    });

    if (highFeeVessels.length > 0) {
      const totalHarborFees = succeeded.vessels.reduce((sum, v) => sum + (v.harborFee || 0), 0);
      const highFeeList = highFeeVessels.map(v => {
        const grossIncome = v.income + v.harborFee;
        const feePercentage = Math.round((v.harborFee / grossIncome) * 100);
        return `<div style="font-size: 0.8em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          <div>🚢 <strong>${v.name}</strong> | 💰 $${formatNumber(v.income)}</div>
          <div style="font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
            Utilization: ${formatNumber(v.cargoLoaded)}/${formatNumber(v.capacity)} TEU (${(v.utilization * 100).toFixed(0)}%)
          </div>
          <div style="font-size: 0.9em; color: #f59e0b; margin-top: 2px;">
            ⚠️ Harbor fee: ${feePercentage}% ($${formatNumber(v.harborFee)})
          </div>
        </div>`;
      }).join('');

      const warningMessage = `
        <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
          <strong style="font-size: 1.1em;">🚢 Cargo Marshal</strong>
        </div>
        <div class="notification-summary-box">
          <div style="color: #f59e0b; font-weight: bold; margin-bottom: 8px;">⚠️ ${highFeeVessels.length} vessel${highFeeVessels.length > 1 ? 's' : ''} with high Harbor fee</div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span style="color: #f59e0b;">⚠️ Harbor Fees (total):</span>
            <span style="color: #9ca3af;">$${formatNumber(totalHarborFees)}</span>
          </div>
        </div>
        <div style="margin: 12px 0; border-top: 1px solid rgba(255,255,255,0.2);"></div>
        <div class="notification-vessel-list">
          ${highFeeList}
        </div>`;

      showSideNotification(warningMessage, 'warning', 12000);
    }
  }

  // Force immediate vessel count update and unlock depart button
  if (window.updateVesselCount) {
    await window.updateVesselCount();
  }

  // Explicitly unlock depart button after departure process completes
  if (window.unlockDepartButton) {
    window.unlockDepartButton();
  }
}

/**
 * Handles autopilot departure start event.
 * Locks the depart button to prevent manual interference during autopilot operation.
 */
async function handleAutopilotDepartStart(data) {
  console.log(`[Autopilot] Starting departure for ${data.vesselCount} vessels`);

  // Lock depart button immediately
  if (window.lockDepartButton) {
    window.lockDepartButton();
  }
}

/**
 * Handles vessels departed event from backend autopilot.
 * Shows detailed notification with vessel list, revenue and consumption totals.
 */
async function handleVesselsDeparted(data) {
  const { count, vessels, totalIncome, totalFuelUsed, totalCO2Used } = data;

  console.log(`[Autopilot] Vessels departed: ${count} vessels - Income: $${totalIncome.toLocaleString()}`);

  // Create compact vessel list
  const vesselList = vessels.map(v =>
    `<div style="font-size: 0.8em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
      <div>🚢 <strong>${v.name}</strong></div>
      <div style="font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
        ${formatNumber(v.cargoLoaded)}/${formatNumber(v.capacity)} TEU (${(v.utilization * 100).toFixed(0)}%) | 💰 $${formatNumber(v.income)}
      </div>
    </div>`
  ).join('');

  const message = `
    <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
      <strong style="font-size: 1.1em;">🚢 Cargo Marshal: ${count} vessel${count > 1 ? 's' : ''}</strong>
    </div>
    <div class="notification-summary-box">
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
        <span style="color: #9ca3af;">Total Income:</span>
        <span style="color: #4ade80; font-weight: bold;">$${formatNumber(totalIncome)}</span>
      </div>
      <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.9em; color: #9ca3af;">
        <div style="font-size: 0.85em; margin-bottom: 4px; opacity: 0.8;">Consumption:</div>
        <div>Used ⛽ Fuel: ${formatNumber(totalFuelUsed)}t</div>
        <div style="margin-top: 2px;">Used 💨 CO2: ${formatNumber(totalCO2Used)}t</div>
      </div>
    </div>
    <div class="notification-vessel-list">
      ${vesselList}
    </div>`;

  // In-app notification
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.autoPilotNotifications && settings.notifyCargoMarshalInApp) {
    showSideNotification(message, 'success', 15000);
  }

  // Force immediate vessel count update (bypasses anti-flicker logic)
  if (window.updateVesselCount) {
    await window.updateVesselCount();
  }
}

/**
 * Handles vessels failed event from backend autopilot.
 * Shows warning notification with failed vessel list.
 */
async function handleVesselsFailed(data) {
  const { count, vessels, bunker } = data;

  console.log(`[Autopilot] Vessels failed: ${count} vessels`);

  // Build bunker info box in same style as success notification
  let bunkerInfoBox = '';
  if (bunker) {
    const fuelDisplay = bunker.fuel !== undefined ? formatNumber(Math.floor(bunker.fuel)) : 'N/A';
    const co2Display = bunker.co2 !== undefined ? formatNumber(Math.floor(bunker.co2)) : 'N/A';
    bunkerInfoBox = `
      <div class="notification-summary-box">
        <div style="font-size: 0.85em; margin-bottom: 6px; opacity: 0.8; color: #9ca3af;">Current bunker:</div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="color: #9ca3af;">⛽ Fuel:</span>
          <span style="color: #fff; font-weight: bold;">${fuelDisplay} t</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #9ca3af;">💨 CO2:</span>
          <span style="color: #fff; font-weight: bold;">${co2Display} t</span>
        </div>
      </div>`;
  }

  // Create formatted vessel list - one line per vessel
  const failedList = vessels.map(v => {
    // Remove vessel type prefixes (MV, MS, etc.)
    const cleanName = v.name.replace(/^(MV|MS|MT|SS)\s+/i, '');
    return `<div style="font-size: 0.85em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
      🚢 <strong>${cleanName}</strong> <span style="color: #ef4444;">${v.reason}</span>
    </div>`;
  }).join('');

  const message = `
    <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
      <strong style="font-size: 1.1em;">⚠️ Cargo Marshal: ${count} vessel${count > 1 ? 's' : ''} not departed</strong>
    </div>
    ${bunkerInfoBox}
    <div style="margin-top: 8px;">
      <strong>⚠️ Failed to depart:</strong>
      <div class="notification-vessel-list" style="margin-top: 6px;">
        ${failedList}
      </div>
    </div>
  `;

  const settings = window.getSettings ? window.getSettings() : {};

  // In-app alert
  if (settings.autoPilotNotifications && settings.notifyCargoMarshalInApp) {
    showSideNotification(message, 'warning', null, true);
  }
}

/**
 * Handles vessels repaired event from backend autopilot.
 * Shows success notification with repair details and vessel list.
 */
async function handleVesselsRepaired(data) {
  const { count, totalCost, vessels } = data;

  console.log(`[Autopilot] Vessels repaired: ${count} vessels - Cost: $${totalCost.toLocaleString()}`);

  // Build vessel list similar to depart notification
  let contentHTML = '';
  if (vessels && vessels.length > 0) {
    const vesselList = vessels.map(v =>
      `<div style="font-size: 0.8em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
        <div>🔧 <strong>${v.name}</strong></div>
        <div style="font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
          Wear: ${Number(v.wear).toFixed(1)}% | Cost: $${formatNumber(v.cost)}
        </div>
      </div>`
    ).join('');

    contentHTML = `
      <div class="notification-summary-box">
        <div style="color: #4ade80; font-weight: bold; margin-bottom: 10px;">🔧 ${count} vessel${count > 1 ? 's' : ''} repaired</div>
        <div style="height: 1px; background: rgba(255,255,255,0.2); margin: 10px 0;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 1.1em;">
          <span style="color: #fff; font-weight: bold;">Total Cost:</span>
          <span style="color: #ef4444; font-weight: bold;">$${formatNumber(totalCost)}</span>
        </div>
      </div>
      <div class="notification-vessel-list">
        ${vesselList}
      </div>
    `;
  }

  const message = `
    <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
      <strong style="font-size: 1.1em;">🔧 Yard Foreman</strong>
    </div>
    ${contentHTML}
  `;

  // In-app notification
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.autoPilotNotifications && settings.notifyYardForemanInApp) {
    showSideNotification(message, 'success', null, false);
  }

  // Force immediate repair count update
  if (window.updateRepairCount) {
    window.updateRepairCount(window.getSettings ? window.getSettings() : {});
  }
}

/**
 * Handles campaigns renewed event from backend autopilot.
 * Shows success notification with renewed campaign types.
 */
async function handleCampaignsRenewed(data) {
  const { campaigns } = data;

  console.log(`[Autopilot] Campaigns renewed:`, campaigns);

  // Create list of renewed campaigns
  const campaignList = campaigns.map(c =>
    `<div style="padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">• ${c.type}: <strong>${c.name}</strong> - $${formatNumber(c.price)}</div>`
  ).join('');

  const message = `
    <div style="margin-bottom: 8px;">
      <strong>📊 Reputation Chief: ${campaigns.length} campaign${campaigns.length > 1 ? 's' : ''} renewed</strong>
    </div>
    <div class="notification-vessel-list">
      ${campaignList}
    </div>
  `;

  // In-app notification
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.autoPilotNotifications && settings.notifyReputationChiefInApp) {
    showSideNotification(message, 'success', 10000);
  }
}

/**
 * Handles auto-COOP distribution completion.
 * Shows summary of sent vessels and updates COOP badge.
 */
async function handleAutoCoopComplete(data) {
  const { totalRequested, totalSent, results } = data;

  console.log(`[Auto-COOP] Distribution complete:`, data);

  // Build result list
  const successResults = results.filter(r => !r.error);
  const failedResults = results.filter(r => r.error);

  let resultsList = '';
  if (successResults.length > 0) {
    resultsList += successResults.map(r => {
      const status = r.partial ? '⚠️' : '✓';
      return `<div style="padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">${status} ${r.company_name}: <strong>${r.departed}</strong> of ${r.requested} vessels</div>`;
    }).join('');
  }

  if (failedResults.length > 0) {
    resultsList += failedResults.map(r =>
      `<div style="padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); color: #ef4444;">❌ ${r.company_name}: Failed</div>`
    ).join('');
  }

  const message = `
    <div style="margin-bottom: 8px;">
      <strong>🤝 The Fair Hand: ${totalSent} vessel${totalSent > 1 ? 's' : ''} distributed to ${successResults.length} member${successResults.length > 1 ? 's' : ''}</strong>
    </div>
    <div class="notification-vessel-list">
      ${resultsList}
    </div>
  `;

  // In-app notification
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.autoPilotNotifications && settings.notifyFairHandInApp) {
    showSideNotification(message, totalSent === totalRequested ? 'success' : 'warning', 12000);
  }

  // Update COOP badge
  if (window.updateCoopBadge) {
    await window.updateCoopBadge();
  }
}

/**
 * Handles auto-COOP when no eligible targets found.
 * Notifies user that COOP vessels are available but can't be sent.
 */
async function handleAutoCoopNoTargets(data) {
  const { available, reason } = data;

  console.log(`[Auto-COOP] No eligible targets:`, data);

  const message = `
    <div style="margin-bottom: 8px;">
      <strong>🤝 The Fair Hand: ${available} vessel${available > 1 ? 's' : ''} available</strong>
    </div>
    <div style="color: #fbbf24;">⚠️ ${reason}</div>
  `;

  const settings = window.getSettings ? window.getSettings() : {};

  // In-app alert
  if (settings.autoPilotNotifications && settings.notifyFairHandInApp) {
    showSideNotification(message, 'warning', 8000);
  }
}

/**
 * Handles bunker state updates from backend autopilot.
 * Updates all bunker displays (fuel, CO2, cash) without API calls.
 */
function handleBunkerUpdate(data) {
  const { fuel, co2, cash, points, maxFuel, maxCO2 } = data;
  updateDataCache.bunker = { fuel, co2, cash, points };
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Bunker update: Fuel=${Math.floor(fuel)}t, CO2=${Math.floor(co2)}t, Cash=$${Math.floor(cash).toLocaleString()}, Points=${points}`);
  }

  // Update capacity values in bunker-management module
  if (window.setCapacityFromBunkerUpdate) {
    window.setCapacityFromBunkerUpdate(maxFuel, maxCO2);
  }

  // Synchronize module-level variables in bunker-management.js
  // This fixes the bug where purchase dialogs use stale cash/fuel/CO2 values
  updateCurrentFuel(fuel);
  updateCurrentCO2(co2);
  updateCurrentCash(cash);

  // Update fuel display with color coding (background fill bar only, text stays white)
  const fuelDisplay = document.getElementById('fuelDisplay');
  const fuelFill = document.getElementById('fuelFill');
  const fuelBtn = document.getElementById('fuelBtn');
  // CRITICAL: Only update if we have valid maxFuel (> 0) from API
  // DO NOT show "0 t / 0 t" on initial connect - keep empty until real data arrives
  if (fuelDisplay && maxFuel > 0) {
    fuelDisplay.innerHTML = `${formatNumber(Math.floor(fuel))} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxFuel))} <b>t</b>`;

    // Update fill bar and button styling with CSS classes
    if (fuelFill && fuelBtn) {
      const fuelPercent = Math.min(100, Math.max(0, (fuel / maxFuel) * 100));
      fuelFill.style.width = `${fuelPercent}%`;

      // Determine fill level class based on tank percentage
      let fillClass = '';
      if (fuel <= 0) {
        fillClass = 'fuel-btn-empty';
        fuelFill.style.width = '0%';
        fuelFill.style.background = 'transparent';
      } else if (fuelPercent <= 20) {
        fillClass = 'fuel-btn-low';
        fuelFill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
      } else if (fuelPercent <= 70) {
        fillClass = 'fuel-btn-medium';
        fuelFill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
      } else if (fuelPercent <= 85) {
        fillClass = 'fuel-btn-high';
        fuelFill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
      } else {
        fillClass = 'fuel-btn-full';
        fuelFill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
      }

      // Update fill-level class (controls background/border color and animation)
      // These classes: fuel-btn-empty (red pulse), fuel-btn-low (red), fuel-btn-medium (blue), fuel-btn-high (yellow), fuel-btn-full (green)
      fuelBtn.classList.remove('fuel-btn-empty', 'fuel-btn-low', 'fuel-btn-medium', 'fuel-btn-high', 'fuel-btn-full');
      if (fillClass) fuelBtn.classList.add(fillClass);

      // Update price-color class (controls TEXT color based on market price)
      // These classes are SEPARATE from fill-level - both can coexist
      // Price classes: fuel-red, fuel-orange, fuel-blue, fuel-green (text color only)
      const fuelPrice = window.updateDataCache?.prices?.fuelPrice || window.updateDataCache?.prices?.fuel;
      if (fuelPrice !== undefined && fuelPrice > 0) {
        let priceClass = '';
        if (fuelPrice >= 800) {
          priceClass = 'fuel-red';
        } else if (fuelPrice >= 600) {
          priceClass = 'fuel-orange';
        } else if (fuelPrice >= 400) {
          priceClass = 'fuel-blue';
        } else if (fuelPrice >= 1) {
          priceClass = 'fuel-green';
        }

        // Remove ONLY price-color classes (do NOT remove fill-level classes!)
        fuelBtn.classList.remove('fuel-red', 'fuel-orange', 'fuel-blue', 'fuel-green');
        if (priceClass) fuelBtn.classList.add(priceClass);
      }
    }
  }

  // Update CO2 display with color coding (background fill bar only, text stays white)
  const co2Display = document.getElementById('co2Display');
  const co2Fill = document.getElementById('co2Fill');
  const co2Btn = document.getElementById('co2Btn');
  // CRITICAL: Only update if we have valid maxCO2 (> 0) from API
  // DO NOT show "0 t / 0 t" on initial connect - keep empty until real data arrives
  if (co2Display && maxCO2 > 0) {
    const co2Value = co2 < 0 ? `-${formatNumber(Math.floor(Math.abs(co2)))}` : formatNumber(Math.floor(co2));
    co2Display.innerHTML = `${co2Value} <b>t</b> <b>/</b> ${formatNumber(Math.floor(maxCO2))} <b>t</b>`;

    // Update fill bar and button styling with CSS classes
    if (co2Fill && co2Btn) {
      const co2Percent = Math.min(100, Math.max(0, (co2 / maxCO2) * 100));
      co2Fill.style.width = `${co2Percent}%`;

      if (AUTOPILOT_LOG_LEVEL === 'detailed') {
        console.log('[DEBUG] handleBunkerUpdate - CO2 value:', co2, 'maxCO2:', maxCO2, 'co2Percent:', co2Percent, 'co2 <= 0:', (co2 <= 0));
      }

      // Determine fill level class based on tank percentage
      let fillClass = '';
      if (co2 <= 0) {
        if (AUTOPILOT_LOG_LEVEL === 'detailed') {
          console.log('[DEBUG] CO2 <= 0 detected! Value:', co2, '- Setting co2-btn-empty class');
        }
        fillClass = 'co2-btn-empty';
        co2Fill.style.width = '0%';
        co2Fill.style.background = 'transparent';
      } else if (co2Percent <= 20) {
        fillClass = 'co2-btn-low';
        co2Fill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
      } else if (co2Percent <= 70) {
        fillClass = 'co2-btn-medium';
        co2Fill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
      } else if (co2Percent <= 85) {
        fillClass = 'co2-btn-high';
        co2Fill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
      } else {
        if (AUTOPILOT_LOG_LEVEL === 'detailed') {
          console.log('[DEBUG] CO2 > 85% - Setting co2-btn-full class. Value:', co2, 'Percent:', co2Percent);
        }
        fillClass = 'co2-btn-full';
        co2Fill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
      }

      // Update fill-level class (controls background/border color and animation)
      // These classes: co2-btn-empty (red pulse), co2-btn-low (red), co2-btn-medium (blue), co2-btn-high (yellow), co2-btn-full (green)
      co2Btn.classList.remove('co2-btn-empty', 'co2-btn-low', 'co2-btn-medium', 'co2-btn-high', 'co2-btn-full');
      if (fillClass) co2Btn.classList.add(fillClass);

      // Update price-color class (controls TEXT color based on market price)
      // These classes are SEPARATE from fill-level - both can coexist
      // Price classes: co2-negative, co2-red, co2-orange, co2-blue, co2-green (text color only)
      const co2Price = window.updateDataCache?.prices?.co2Price || window.updateDataCache?.prices?.co2;
      if (co2Price !== undefined && co2Price !== null) {
        let priceClass = '';
        if (co2Price <= 0) {
          priceClass = 'co2-negative';
        } else if (co2Price >= 20) {
          priceClass = 'co2-red';
        } else if (co2Price >= 15) {
          priceClass = 'co2-orange';
        } else if (co2Price >= 10) {
          priceClass = 'co2-blue';
        } else if (co2Price >= 1) {
          priceClass = 'co2-green';
        }

        // Remove ONLY price-color classes (do NOT remove fill-level classes!)
        co2Btn.classList.remove('co2-negative', 'co2-red', 'co2-orange', 'co2-blue', 'co2-green');
        if (priceClass) co2Btn.classList.add(priceClass);
      }
    }
  }

  // Update cash display - only if we have valid bunker data (maxFuel or maxCO2 > 0)
  const cashDisplay = document.getElementById('cashDisplay');
  if (cashDisplay && (maxFuel > 0 || maxCO2 > 0)) {
    cashDisplay.innerHTML = `$${formatNumber(Math.floor(cash))}`;
  }

  // Update points display (diamonds)
  const pointsDisplay = document.getElementById('pointsDisplay');
  if (pointsDisplay && points !== undefined) {
    pointsDisplay.textContent = formatNumber(points);
  }

  // Cache bunker values for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ bunker: { fuel, co2, cash, points, maxFuel, maxCO2 } });
  }
}

/**
 * Handles vessel count updates from backend autopilot.
 * Updates badges AND button states/tooltips.
 */
function handleVesselCountUpdate(data) {
  const { readyToDepart, atAnchor, pending } = data;
  updateDataCache.vessels = { ready: readyToDepart, anchor: atAnchor, pending };
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Vessel count update: Ready=${readyToDepart}, Anchor=${atAnchor}, Pending=${pending}`);
  }

  // Update ready to depart badge
  const vesselCountBadge = document.getElementById('vesselCount');
  if (vesselCountBadge) {
    vesselCountBadge.textContent = readyToDepart;
    if (readyToDepart > 0) {
      vesselCountBadge.classList.remove('hidden');
    } else {
      vesselCountBadge.classList.add('hidden');
    }
  }

  // Update at anchor badge
  const anchorCountBadge = document.getElementById('anchorCount');
  if (anchorCountBadge) {
    anchorCountBadge.textContent = atAnchor;
    if (atAnchor > 0) {
      anchorCountBadge.classList.remove('hidden');
    } else {
      anchorCountBadge.classList.add('hidden');
    }
  }

  // Update pending vessels badge
  const pendingBadge = document.getElementById('pendingVesselsBadge');
  if (pendingBadge) {
    pendingBadge.textContent = pending;
    if (pending > 0) {
      pendingBadge.classList.remove('hidden');
    } else {
      pendingBadge.classList.add('hidden');
    }

    // Update buyVesselsBtn tooltip to show pending count
    const buyVesselsBtn = document.getElementById('buyVesselsBtn');
    if (buyVesselsBtn) {
      buyVesselsBtn.title = pending > 0 ? `Vessels in delivery: ${pending}` : 'Buy vessels';
    }
  }

  // Update depart button state and tooltip
  const departBtn = document.getElementById('departAllBtn');
  if (departBtn) {
    if (readyToDepart > 0) {
      departBtn.disabled = false;
      departBtn.title = `Depart all ${readyToDepart} vessel${readyToDepart === 1 ? '' : 's'} from harbor`;
    } else {
      departBtn.disabled = true;
      departBtn.title = 'No vessels ready to depart';
    }
  }

  // Anchor button - always enabled for purchasing anchor points
  const anchorBtn = document.getElementById('anchorBtn');
  if (anchorBtn) {
    // anchorBtn.disabled = false;  // Always enabled
    if (atAnchor > 0) {
      anchorBtn.title = `${atAnchor} vessel${atAnchor === 1 ? '' : 's'} at anchor - Click to purchase anchor points`;
    } else {
      anchorBtn.title = 'Purchase anchor points';
    }
  }

  // Update pending button visibility
  const pendingBtn = document.getElementById('filterPendingBtn');
  const pendingCountSpan = document.getElementById('pendingCount');
  if (pendingBtn && pendingCountSpan) {
    pendingCountSpan.textContent = pending;
    if (pending > 0) {
      pendingBtn.classList.remove('hidden');
    } else {
      pendingBtn.classList.add('hidden');
    }
  }

  // Cache values for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ vessels: { readyToDepart, atAnchor, pending } });
  }

  // Event-driven auto-depart: Trigger when vessels arrive in harbor
  // This is more efficient than polling - we react immediately when vessels become ready
  if (readyToDepart > 0 && window.settings?.autoDepartAll) {
    if (AUTOPILOT_LOG_LEVEL === 'detailed') {
      console.log(`[Auto-Depart] Event-driven trigger: ${readyToDepart} vessel(s) ready`);
    }
    // Notify backend to execute auto-depart
    fetch('/api/autopilot/trigger-depart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('[Auto-Depart] Failed to trigger:', err));
  }
}

/**
 * Handles repair count updates from backend.
 * Updates the "Repair" badge without API calls.
 */
function handleRepairCountUpdate(data) {
  const { count } = data;
  updateDataCache.repair = count;
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Repair count update: ${count} vessel${count === 1 ? '' : 's'} need repair`);
  }

  const repairBadge = document.getElementById('repairCount');
  if (repairBadge) {
    repairBadge.textContent = count;
    if (count > 0) {
      repairBadge.classList.remove('hidden');
    } else {
      repairBadge.classList.add('hidden');
    }
  }

  // Update repair button state
  const repairBtn = document.getElementById('repairAllBtn');
  if (repairBtn) {
    if (count > 0) {
      repairBtn.disabled = false;
      repairBtn.title = `Repair ${count} vessel${count === 1 ? '' : 's'} with high wear`;
    } else {
      repairBtn.disabled = true;
      repairBtn.title = 'No vessels need repair';
    }
  }

  // Cache value for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ repair: count });
  }
}

/**
 * Handles campaign status updates from backend.
 * Updates the "Campaigns" badge without API calls.
 */
function handleCampaignStatusUpdate(data) {
  const { activeCount } = data;
  updateDataCache.campaigns = activeCount;
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Campaign update: ${activeCount} active campaign${activeCount === 1 ? '' : 's'}`);
  }

  const campaignBadge = document.getElementById('campaignsCount');
  if (campaignBadge) {
    campaignBadge.textContent = activeCount;
    // Only show badge if < 3 campaigns (0, 1, or 2)
    if (activeCount < 3) {
      campaignBadge.classList.remove('hidden');
    } else {
      campaignBadge.classList.add('hidden');
    }
  }

  // Update header display
  const campaignsHeaderDisplay = document.getElementById('campaignsHeaderDisplay');
  if (campaignsHeaderDisplay) {
    campaignsHeaderDisplay.textContent = activeCount;
    // Green if >= 3, red if < 3
    if (activeCount >= 3) {
      campaignsHeaderDisplay.classList.add('text-success');
      campaignsHeaderDisplay.classList.remove('text-danger');
    } else {
      campaignsHeaderDisplay.classList.add('text-danger');
      campaignsHeaderDisplay.classList.remove('text-success');
    }
  }

  // Cache value for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ campaigns: activeCount });
  }
}

/**
 * Handles unread messages count updates from backend.
 * Updates the "Messages" badge without API calls.
 */
function handleUnreadMessagesUpdate(data) {
  const { count } = data;
  updateDataCache.messages = count;
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Messages update: ${count} unread message${count === 1 ? '' : 's'}`);
  }

  const messageBadge = document.getElementById('unreadBadge');
  if (messageBadge) {
    messageBadge.textContent = count;
    if (count > 0) {
      messageBadge.classList.remove('hidden');
    } else {
      messageBadge.classList.add('hidden');
    }
  }

  // Cache value for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ messages: count });
  }
}

/**
 * Handles messenger updates from 10-second polling
 * This replaces all other messenger polling mechanisms
 */
function handleMessengerUpdate(data) {
  const { messages } = data; // Unread message count
  updateDataCache.messages = messages;

  // Only log in detailed mode or if there are unread messages
  if (AUTOPILOT_LOG_LEVEL === 'detailed' || messages > 0) {
    console.log(`[Messenger] 10-sec poll: ${messages} unread message${messages === 1 ? '' : 's'}`);
  }

  const messageBadge = document.getElementById('unreadBadge');
  if (messageBadge) {
    const previousCount = parseInt(messageBadge.textContent) || 0;
    messageBadge.textContent = messages;
    if (messages > 0) {
      messageBadge.classList.remove('hidden');
    } else {
      messageBadge.classList.add('hidden');
    }

    // Show notification if count increased
    if (messages > previousCount) {
      const settings = window.getSettings ? window.getSettings() : {};
      if (settings.enableInboxNotifications !== false && document.hidden) {
        showChatNotification(
          '📬 New Message',
          `You have ${messages - previousCount} new message${messages - previousCount === 1 ? '' : 's'}`
        );
      }
    }
  }

  // Cache value for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ messages: messages });
  }
}

/**
 * Handles generic notifications from backend (errors, warnings, info).
 */
function handleGenericNotification(data) {
  const { type, message } = data;
  console.log(`[Notification] ${type}:`, message);

  // Check if this is an "insufficient resource" notification (should not be an alert)
  const isInsufficientResource = message.includes('insufficient') ||
                                  message.includes('not enough') ||
                                  message.includes('Cannot depart');

  // Show side notification (no "Got it" button for insufficient resource messages)
  showSideNotification(message, type, null, !isInsufficientResource);
}

/**
 * Handles user action notifications from backend (manual purchases, actions, etc.)
 * These are broadcasted to ALL connected clients so everyone sees when someone makes a purchase.
 */
function handleUserActionNotification(data) {
  const { type, message } = data;
  showSideNotification(message, type, 5000, false);
}

/**
 * Handles COOP targets update from backend.
 * Updates the COOP badge and header display.
 */
function handleCoopUpdate(data) {
  const { available, cap, coop_boost } = data;
  updateDataCache.coop = { available, cap, coop_boost };
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] COOP update: ${available}/${coop_boost || cap} available`);
  }

  // Update badge (green if >= 3, red if < 3)
  const badge = document.getElementById('coopBadge');
  if (badge) {
    if (available > 0) {
      badge.textContent = available;
      badge.classList.remove('hidden');
      // Green if >= 3, red if < 3
      if (available >= 3) {
        badge.classList.add('badge-green-bg');
        badge.classList.remove('badge-red-bg');
      } else {
        badge.classList.add('badge-red-bg');
        badge.classList.remove('badge-green-bg');
      }
    } else {
      badge.classList.add('hidden');
    }
  }

  // Update header display using centralized function
  if (window.updateCoopDisplay) {
    window.updateCoopDisplay(cap, available);
  }

  // Cache for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({ coop: { available, cap, coop_boost } });
  }
}

/**
 * Handles company_type updates from backend.
 * Updates global variable for vessel purchase restrictions.
 * Refreshes vessel catalog to show/hide locked banners.
 */
function handleCompanyTypeUpdate(data) {
  const { company_type } = data;
  window.USER_COMPANY_TYPE = company_type;
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log(`[Autopilot] Company type update:`, company_type);
  }

  // Show/hide tanker filter button in sell vessels dialog
  const sellTankerBtn = document.getElementById('sellFilterTankerBtn');
  if (sellTankerBtn && company_type && company_type.includes('tanker')) {
    sellTankerBtn.classList.remove('hidden');
  }

  // Refresh vessel cards if catalog is open
  if (window.refreshVesselCardsIfVisible) {
    window.refreshVesselCardsIfVisible();
  }
}

/**
 * Handles stock price and anchor capacity updates from backend.
 * Updates header displays for stock value/trend and anchor slots.
 */
function handleHeaderDataUpdate(data) {
  const { stock, anchor } = data;
  if (stock) updateDataCache.stock = stock;
  if (anchor) updateDataCache.anchor = anchor;
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    const stockMsg = stock ? `Stock=${stock.value.toFixed(2)} (${stock.trend})` : 'Stock=N/A';
    const anchorMsg = anchor ? `Anchor=${anchor.available}/${anchor.max}` : 'Anchor=N/A';
    console.log(`[Autopilot] Header data update: ${stockMsg}, ${anchorMsg}`);
  }

  // Update stock display
  if (stock) {
    const stockDisplay = document.getElementById('stockDisplay');
    const stockTrendElement = document.getElementById('stockTrend');

    if (stockDisplay && stockTrendElement) {
      const stockContainer = stockDisplay.parentElement;

      if (stock.ipo === 1) {
        stockContainer.classList.remove('hidden');
        stockDisplay.textContent = `$${stock.value.toFixed(2)}`;

        if (stock.trend === 'up') {
          stockTrendElement.textContent = '↑';
          stockTrendElement.classList.add('text-success');
          stockTrendElement.classList.remove('text-danger', 'text-neutral');
          stockDisplay.classList.add('text-success');
          stockDisplay.classList.remove('text-danger', 'text-neutral');
        } else if (stock.trend === 'down') {
          stockTrendElement.textContent = '↓';
          stockTrendElement.classList.add('text-danger');
          stockTrendElement.classList.remove('text-success', 'text-neutral');
          stockDisplay.classList.add('text-danger');
          stockDisplay.classList.remove('text-success', 'text-neutral');
        } else {
          stockTrendElement.textContent = '-';
          stockTrendElement.classList.add('text-neutral');
          stockTrendElement.classList.remove('text-success', 'text-danger');
          stockDisplay.classList.add('text-neutral');
          stockDisplay.classList.remove('text-success', 'text-danger');
        }
      } else {
        stockContainer.classList.add('hidden');
      }
    }
  }

  // Update anchor capacity display
  if (anchor) {
    const anchorSlotsDisplay = document.getElementById('anchorSlotsDisplay');
    if (anchorSlotsDisplay) {
      // Show container (anchor is NOT alliance-dependent)
      const anchorContainer = anchorSlotsDisplay.parentElement;
      if (anchorContainer) {
        anchorContainer.classList.remove('hidden');
      }

      // Format: Total 114 ⚓ Free 1 ⚓ Pending 0
      const total = anchor.max;
      const free = anchor.available;
      const pending = anchor.pending || 0;  // From settings.lastAnchorPointPurchase

      // Build display string with labels
      // Total: RED if free > 0 (slots available = bad), GREEN if free = 0 (all slots used = good)
      const totalColor = free > 0 ? '#ef4444' : '#4ade80';
      let html = `Total <span style="color: ${totalColor};">${total}</span>`;

      // Free slots - only show if > 0, in red
      if (free > 0) {
        html += ` ⚓ Free <span style="color: #ef4444;">${free}</span>`;
      }

      // Pending - only show if > 0, in orange
      if (pending > 0) {
        html += ` ⚓ Pending <span style="color: #fbbf24;">${pending}</span>`;
      }

      anchorSlotsDisplay.innerHTML = html;
    }

    // Refresh vessel purchase buttons if anchor slots changed
    if (window.refreshVesselCardsIfVisible) {
      window.refreshVesselCardsIfVisible();
    }
  }

  // Cache for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({
      stock: stock,
      anchor: anchor
    });
  }
}


/**
 * Handle hijacking negotiation updates from auto-negotiate autopilot.
 * Shows live notifications as the bot negotiates with pirates.
 *
 * @param {Object} data - Hijacking update data
 * @param {string} data.action - Type of update (offer_submitted, pirate_counter_offer, accepting_price, hijacking_resolved)
 * @param {number} data.case_id - Hijacking case ID
 */
function handleHijackingUpdate(data) {
  // Check if this is a badge/header update (from 30-second polling)
  if (data.openCases !== undefined || data.hijackedCount !== undefined) {
    if (window.DEBUG_MODE) {
      console.log('[Hijacking] Badge/Header update received:', data);
    }

    // Update hijacking inbox badge
    if (window.updateHijackingBadge) {
      window.updateHijackingBadge(data);
      if (window.DEBUG_MODE) {
        console.log('[Hijacking] Badge updated');
      }
    } else {
      console.error('[Hijacking] updateHijackingBadge not found!');
    }

    // Update hijacked vessels header display
    if (window.updateHijackedVesselsDisplay) {
      window.updateHijackedVesselsDisplay(data);
      if (window.DEBUG_MODE) {
        console.log('[Hijacking] Header display updated');
      }
    } else {
      console.error('[Hijacking] updateHijackedVesselsDisplay not found!');
    }

    // Save to badge cache for next page load
    if (window.saveBadgeCache) {
      window.saveBadgeCache({
        hijacking: {
          openCases: data.openCases,
          totalCases: data.totalCases,
          hijackedCount: data.hijackedCount
        }
      });
    }
    return;
  }

  // Handle auto-negotiate progress updates (data.data.action exists)
  const { action, case_id, round, your_offer, pirate_demand, pirate_counter, final_price, threshold, success, final_amount, vessel_name } = data.data || {};

  // Only show live progress notifications, not side notifications
  if (action === 'offer_submitted') {
    const message = `☠️ <strong>Captain Blackbeard #${case_id}</strong> Round ${round}<br>` +
                    `Bot offering: <strong>$${your_offer?.toLocaleString()}</strong><br>` +
                    `Pirate demand: $${pirate_demand?.toLocaleString()}`;
    showAutoPilotNotification(message, 'info', 5000);
  } else if (action === 'pirate_counter_offer') {
    const reduction = pirate_demand - pirate_counter;
    const percentReduction = ((reduction / pirate_demand) * 100).toFixed(1);
    const message = `☠️ <strong>Captain Blackbeard #${case_id}</strong> Round ${round}<br>` +
                    `Pirates counter: <strong>$${pirate_counter?.toLocaleString()}</strong><br>` +
                    `<span style="color: #10b981;">↓ Reduced by $${reduction?.toLocaleString()} (${percentReduction}%)</span>`;
    showAutoPilotNotification(message, 'success', 5000);
  } else if (action === 'accepting_price') {
    const message = `☠️ <strong>Captain Blackbeard #${case_id}</strong><br>` +
                    `✅ Price below $${threshold?.toLocaleString()} threshold<br>` +
                    `Accepting final price: <strong>$${final_price?.toLocaleString()}</strong>`;
    showAutoPilotNotification(message, 'success', 5000);
  } else if (action === 'hijacking_resolved') {
    // Show Captain Blackbeard success message as side notification
    const settings = window.getSettings ? window.getSettings() : {};
    const blackbeardMessage = `☠️Ahoy, Landlubber Chick!\n\nRelax, darling. I secured that old tub ${vessel_name || 'your vessel'} for a paltry $${final_amount?.toLocaleString()} Doubloons by applying a touch of 'creative problem-solving.' You owe me one!\n\n— Captain\nBlackbeard`;

    // In-app notification
    if (settings.autoPilotNotifications && settings.notifyCaptainBlackbeardInApp && window.showSideNotification) {
      window.showSideNotification(blackbeardMessage, 'success', 12000);
    }

    // Refresh messenger to show Captain Blackbeard signature
    if (window.refreshMessengerChatList) {
      window.refreshMessengerChatList();
    }
  } else if (action === 'negotiation_failed') {
    // Show Captain Blackbeard error message as side notification
    const settings = window.getSettings ? window.getSettings() : {};
    const blackbeardErrorMessage = `☠️Ahoy, Landlubber Chick!\n\nI was nothing less than a completely innocent bystander. But do have a look at Case ${case_id}. Something strange happened!\n\n— Captain\nBlackbeard`;

    // In-app notification
    if (settings.autoPilotNotifications && settings.notifyCaptainBlackbeardInApp && window.showSideNotification) {
      window.showSideNotification(blackbeardErrorMessage, 'error', 12000);
    }
  } else if (action === 'insufficient_funds') {
    // Show Captain Blackbeard insufficient funds message as side notification
    const settings = window.getSettings ? window.getSettings() : {};
    const { required, available } = data.data;
    const blackbeardMoneyMessage = `☠️Ahoy, Landlubber Chick!\n\nI negotiated Case ${case_id} down to $${required?.toLocaleString()}, but your coffers only hold $${available?.toLocaleString()}. Fill them purses, then I'll finish the job!\n\nVessel: ${vessel_name}\n\n— Captain\nBlackbeard`;

    // In-app notification
    if (settings.autoPilotNotifications && settings.notifyCaptainBlackbeardInApp && window.showSideNotification) {
      window.showSideNotification(blackbeardMoneyMessage, 'warning', 15000);
    }
  }
}

/**
 * Handles event data update from backend
 */
// Store full event data globally for forecast calendar
let cachedEventData = null;

function handleEventDataUpdate(eventData) {
  if (AUTOPILOT_LOG_LEVEL === 'detailed') {
    console.log('[Event] Event data update received:', eventData);
  }

  // Store full event data
  cachedEventData = eventData;

  // Update event info module
  updateEventData(eventData);

  // Update forecast calendar with full event data
  if (eventData && eventData.discount_type && eventData.discount_percentage) {
    const eventDiscount = {
      type: eventData.discount_type,
      percentage: eventData.discount_percentage
    };
    updateEventDiscount(eventDiscount, eventData);
  } else {
    updateEventDiscount(null, null);
  }

  // Cache event data for next page load
  if (window.saveBadgeCache) {
    window.saveBadgeCache({
      eventData: eventData
    });
  }
}
