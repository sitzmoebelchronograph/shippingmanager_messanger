/**
 * @fileoverview Private Messaging Module - Handles direct message conversations between players and system notifications.
 * Provides a WhatsApp-style messaging interface with conversation selection, message threading, and system message handling.
 *
 * Key Features:
 * - Multi-conversation management with subject-based threading
 * - System notification handling (vessel hijacking, stock transactions, alliance events)
 * - Chat selection overlay for choosing between multiple conversations with same user
 * - Message bubble UI with sender identification
 * - Unread badge tracking
 * - Chat deletion with confirmation
 * - Integration with contact list and alliance chat
 *
 * Conversation Flow:
 * 1. User clicks company name (from chat/contacts)
 * 2. System fetches all conversations with that user
 * 3. Conversation selection overlay displays (or creates new chat)
 * 4. Selected conversation opens with full message history
 * 5. User can send replies or delete conversation
 *
 * System Messages:
 * - Read-only notifications from game (vessel hijacked, stock trades, etc.)
 * - Formatted with specialized templates per message type
 * - Grouped under "Gameplay" participant
 * - Cannot reply (input hidden for system chats)
 *
 * @module messenger
 * @requires utils - HTML escaping functions
 * @requires api - Messenger API calls
 * @requires ui-dialogs - Confirmation dialogs
 */

import { escapeHtml, showSideNotification, showNotification } from './utils.js';
import { fetchMessengerChats, fetchMessengerMessages, sendPrivateMessage as apiSendPrivateMessage, deleteChat as apiDeleteChat, markChatAsRead as apiMarkChatAsRead, fetchContacts, searchUsers } from './api.js';
import { showConfirmDialog } from './ui-dialogs.js';
import { updateBadge } from './badge-manager.js';

/**
 * Formats timestamp using browser locale without timezone.
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {string} Formatted date/time (e.g., "Oct 28, 2025, 18:00:23")
 */
function formatTimestamp(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000);
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
 * Current active private chat state.
 * Tracks the currently opened conversation with all its metadata.
 * @type {Object}
 * @property {number|null} chatId - Chat ID from API (null for new chats)
 * @property {string|null} subject - Conversation subject line
 * @property {string|null} targetCompanyName - Name of other participant
 * @property {number|null} targetUserId - User ID of other participant
 * @property {Array} messages - Array of message objects in this conversation
 * @property {boolean} isNewChat - True if creating new conversation
 * @property {boolean} isSystemChat - True if this is a system notification
 */
let currentPrivateChat = {
  chatId: null,
  subject: null,
  targetCompanyName: null,
  targetUserId: null,
  messages: [],
  isNewChat: false
};

/**
 * Array of all private chats fetched from API.
 * Includes both user conversations and system notifications.
 * @type {Array<Object>}
 */
let allPrivateChats = [];

/**
 * Filtered chats for current selection overlay.
 * Subset of allPrivateChats relevant to current target user.
 * @type {Array<Object>}
 */
let userChatsForSelection = [];

/**
 * Polling interval for active hijacking negotiations.
 * Checks for pirate responses every 5 seconds.
 * @type {number|null}
 */
let hijackingPollingInterval = null;

/**
 * Opens messenger interface for a specific user or system notifications.
 * Fetches all conversations and displays selection overlay or system message list.
 *
 * Special Handling:
 * - If targetCompanyName is "Gameplay", shows system notifications list
 * - Otherwise shows all conversations with the specified user
 * - Allows creating new conversation if none exist
 *
 * Side Effects:
 * - Fetches all messenger chats from API
 * - Updates allPrivateChats module variable
 * - Shows chat selection overlay
 *
 * @async
 * @param {string} targetCompanyName - Company name to message, or "Gameplay" for system notifications
 * @param {number|null} targetUserId - User ID of target (null for system messages)
 * @returns {Promise<void>}
 *
 * @example
 * // From alliance chat - user clicks @CompanyName
 * openMessenger("Player Company", 456);
 *
 * // From toolbar - user clicks Gameplay notifications
 * openMessenger("Gameplay", null);
 */
export async function openMessenger(targetCompanyName, targetUserId) {
  // Reset hijacking inbox flag when opening messenger normally
  window.cameFromHijackingInbox = false;

  // Remove hijacking case view class when opening normally
  const messengerOverlay = document.getElementById('messengerOverlay');
  if (messengerOverlay) {
    messengerOverlay.classList.remove('hijacking-case-view');
  }

  try {
    const data = await fetchMessengerChats();
    allPrivateChats = data.chats;

    // Check if this is for system messages
    if (targetCompanyName === 'Gameplay') {
      showSystemMessagesSelection(data.chats, data.own_user_id);
      return;
    }

    const userChats = allPrivateChats.filter(chat => {
      if (chat.system_chat) return false;
      return chat.participants_string === targetCompanyName;
    });

    showChatSelection(targetCompanyName, targetUserId, userChats, data.own_user_id);

  } catch (error) {
    console.error('Error opening messenger:', error);
    alert(`Error: ${error.message}`);
  }
}

function showSystemMessagesSelection(allChats, ownUserId) {
  // Filter system chats but exclude hijacking messages (they go to Phone Booth)
  const systemChats = allChats.filter(chat =>
    chat.system_chat && chat.body !== 'vessel_got_hijacked'
  );
  const sortedChats = systemChats.sort((a, b) => (b.time_last_message || 0) - (a.time_last_message || 0));
  userChatsForSelection = sortedChats;

  document.getElementById('chatSelectionTitle').textContent = 'Gameplay - 📢 System Notifications';
  const listContainer = document.getElementById('chatSelectionList');

  if (sortedChats.length === 0) {
    listContainer.innerHTML = '<div class="empty-message">No system notifications yet.</div>';
  } else {
    listContainer.innerHTML = sortedChats.map((chat, index) => {
      const title = getSystemMessageTitle(chat.body, chat.values);
      const timestamp = formatTimestamp(chat.time_last_message);
      const unreadIndicator = chat.new ? '<span class="unread-indicator"></span>' : '';

      return `
        <div class="chat-selection-item" data-chat-index="${index}" style="position: relative; padding-right: 40px;">
          <div style="flex: 1;">
            <h3>${title}${unreadIndicator}</h3>
            <p>${timestamp}</p>
          </div>
          <button class="delete-chat-btn" data-chat-index="${index}">🗑️</button>
        </div>
      `;
    }).join('');

    listContainer.querySelectorAll('.chat-selection-item').forEach(item => {
      const chatItem = item.querySelector('div[style*="flex: 1"]');
      if (chatItem) {
        chatItem.addEventListener('click', () => {
          const chatIndex = parseInt(item.dataset.chatIndex);
          const selectedChat = userChatsForSelection[chatIndex];
          document.getElementById('chatSelectionOverlay').classList.add('hidden');
          openExistingChat('Gameplay', null, selectedChat, ownUserId);
        });
      }
    });

    listContainer.querySelectorAll('.delete-chat-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const chatIndex = parseInt(btn.dataset.chatIndex);
        const chatToDelete = sortedChats[chatIndex];
        const chatItem = btn.closest('.chat-selection-item');

        const wasDeleted = await deleteChatWithConfirmation(chatToDelete);
        // Remove element immediately from DOM if deleted
        if (wasDeleted && chatItem) {
          chatItem.remove();
        }
      });
    });
  }

  document.getElementById('chatSelectionOverlay').classList.remove('hidden');
}

function showChatSelection(targetCompanyName, targetUserId, chats, ownUserId) {
  const sortedChats = [...chats].sort((a, b) => (b.time_last_message || 0) - (a.time_last_message || 0));
  userChatsForSelection = sortedChats;

  currentPrivateChat.targetCompanyName = targetCompanyName;
  currentPrivateChat.targetUserId = targetUserId;

  document.getElementById('chatSelectionTitle').textContent = `Conversations with ${targetCompanyName}`;
  const listContainer = document.getElementById('chatSelectionList');

  let html = `
    <div class="chat-selection-item" data-is-new="true" style="border-color: #4ade80;">
      <div style="flex: 1;">
        <h3 style="color: #4ade80;">+ Start New Conversation</h3>
        <p>Create a new conversation with a custom subject</p>
      </div>
    </div>
  `;

  html += sortedChats.map((chat, index) => {
    const lastMsg = chat.last_message ? escapeHtml(chat.last_message.substring(0, 60)) + '...' : 'No messages';
    const subject = chat.subject || 'No subject';
    const unreadIndicator = chat.new ? '<span class="unread-indicator"></span>' : '';

    // Format timestamp
    const timestamp = formatTimestamp(chat.time_last_message);

    return `
      <div class="chat-selection-item" data-chat-index="${index}" style="position: relative; padding-right: 40px;">
        <div style="flex: 1;">
          <h3>${escapeHtml(targetCompanyName)} - ${escapeHtml(subject)}${unreadIndicator}</h3>
          <p>${lastMsg}</p>
          <p style="font-size: 11px; opacity: 0.7; margin-top: 4px;">${timestamp}</p>
        </div>
        <button class="delete-chat-btn" data-chat-index="${index}">🗑️</button>
      </div>
    `;
  }).join('');

  listContainer.innerHTML = html;

  listContainer.querySelectorAll('.chat-selection-item').forEach(item => {
    const chatItem = item.querySelector('div[style*="flex: 1"]');
    if (chatItem) {
      chatItem.addEventListener('click', async () => {
        if (item.dataset.isNew === 'true') {
          document.getElementById('chatSelectionOverlay').classList.add('hidden');
          openNewChat(targetCompanyName, targetUserId);
        } else {
          const chatIndex = parseInt(item.dataset.chatIndex);
          const selectedChat = userChatsForSelection[chatIndex];
          document.getElementById('chatSelectionOverlay').classList.add('hidden');
          openExistingChat(targetCompanyName, targetUserId, selectedChat, ownUserId);
        }
      });
    }
  });

  // Add delete button handlers
  listContainer.querySelectorAll('.delete-chat-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chatIndex = parseInt(btn.dataset.chatIndex);
      const chatToDelete = sortedChats[chatIndex];
      const chatItem = btn.closest('.chat-selection-item');

      const wasDeleted = await deleteChatWithConfirmation(chatToDelete);
      // Remove element immediately from DOM if deleted
      if (wasDeleted && chatItem) {
        chatItem.remove();
      }
    });
  });

  document.getElementById('chatSelectionOverlay').classList.remove('hidden');
}

export async function openExistingChat(targetCompanyName, targetUserId, chat, ownUserId) {
  const isSystemChat = chat.system_chat || false;

  currentPrivateChat = {
    chatId: chat.id,
    subject: chat.subject || 'Message',
    targetCompanyName: targetCompanyName,
    targetUserId: targetUserId,
    messages: [],
    isNewChat: false,
    isSystemChat: isSystemChat,
    body: chat.body || null,
    values: chat.values || null
  };

  document.getElementById('messengerOverlay').classList.remove('hidden');

  // Set window size based on chat type
  const messengerWindow = document.querySelector('#messengerOverlay .messenger-window');
  messengerWindow.classList.remove('messenger-window-narrow', 'messenger-window-system');
  if (isSystemChat && chat.body === 'vessel_got_hijacked') {
    // Pirate Demands = narrow template (400px)
    messengerWindow.classList.add('messenger-window-narrow');
  } else if (isSystemChat) {
    // System notifications = auto-size to content
    messengerWindow.classList.add('messenger-window-system');
  }

  // Set title based on chat type
  if (isSystemChat) {
    if (chat.body === 'vessel_got_hijacked') {
      document.getElementById('messengerTitle').textContent = `☠️ Pirate Demands`;
    } else {
      document.getElementById('messengerTitle').textContent = `📢 ${targetCompanyName} - System Notification`;
    }
  } else {
    document.getElementById('messengerTitle').textContent = `🗣️ ${targetCompanyName} - ${chat.subject || 'Chat'}`;
  }

  document.getElementById('subjectInputWrapper').classList.add('hidden');
  document.getElementById('messengerFeed').innerHTML = '<div class="empty-message">Loading...</div>';

  // System chats are single notifications, not conversations
  if (isSystemChat) {
    await displaySystemMessage(chat);
    // Hide input area for system messages
    document.getElementById('messengerInput').classList.add('hidden');
    document.getElementById('sendPrivateMessageBtn').classList.add('hidden');
  } else {
    await loadPrivateMessages(chat.id, ownUserId);
    // Show input area for regular chats
    document.getElementById('messengerInput').classList.remove('hidden');
    document.getElementById('sendPrivateMessageBtn').classList.remove('hidden');
    document.getElementById('messengerInput').focus();
  }

  // Mark as read after displaying the message (if it was unread)
  if (chat.new) {
    try {
      await apiMarkChatAsRead(chat.id, isSystemChat);
      console.log(`[Messenger] Marked chat ${chat.id} as read (system: ${isSystemChat})`);
    } catch (error) {
      console.error('[Messenger] Failed to mark chat as read:', error);
    }
  }

  if (window.debouncedUpdateUnreadBadge) {
    setTimeout(() => window.debouncedUpdateUnreadBadge(1000), 1000);
  }
}

/**
 * Opens interface for creating a new conversation with a user.
 * Displays messenger overlay with subject input and empty message feed.
 *
 * Side Effects:
 * - Updates currentPrivateChat state with new chat parameters
 * - Shows messenger overlay
 * - Displays subject input field
 * - Focuses subject input for user entry
 *
 * @param {string} targetCompanyName - Company name of message recipient
 * @param {number} targetUserId - User ID of message recipient
 *
 * @example
 * // User clicks "New Conversation" from chat selection
 * openNewChat("Player Company", 456);
 */
export function openNewChat(targetCompanyName, targetUserId) {
  currentPrivateChat = {
    chatId: null,
    subject: null,
    targetCompanyName: targetCompanyName,
    targetUserId: targetUserId,
    messages: [],
    isNewChat: true
  };

  document.getElementById('messengerOverlay').classList.remove('hidden');

  // New conversation = normal template (wide with min-height)
  const messengerWindow = document.querySelector('#messengerOverlay .messenger-window');
  messengerWindow.classList.remove('messenger-window-narrow', 'messenger-window-system');

  document.getElementById('messengerTitle').textContent = `🗣️ ${targetCompanyName} - New Conversation`;
  document.getElementById('subjectInputWrapper').classList.remove('hidden');
  document.getElementById('subjectInput').value = '';
  document.getElementById('messengerFeed').innerHTML =
    '<div class="empty-message">New conversation. Enter a subject and send your first message.</div>';

  document.getElementById('subjectInput').focus();
}

/**
 * Loads and displays messages for a specific conversation.
 * Fetches message history from API and renders in bubble format.
 *
 * @async
 * @param {number} chatId - Chat ID to load messages for
 * @returns {Promise<void>}
 */
async function loadPrivateMessages(chatId) {
  try {
    const { messages, user_id: ownUserId } = await fetchMessengerMessages(chatId);
    displayPrivateMessages(messages, ownUserId);
  } catch (error) {
    document.getElementById('messengerFeed').innerHTML =
      `<div class="empty-message" style="color:#ef4444;">Error loading messages: ${error.message}</div>`;
  }
}

function displayPrivateMessages(messages, ownUserId) {
  const feed = document.getElementById('messengerFeed');
  feed.innerHTML = '';

  if (!messages || messages.length === 0) {
    feed.innerHTML = '<div class="empty-message">No messages in this chat yet.</div>';
    return;
  }

  messages.forEach(msg => {
    const isOwn = msg.user_id === ownUserId;
    const bubble = document.createElement('div');

    const timestamp = formatTimestamp(msg.created_at);

    bubble.className = `message-bubble ${isOwn ? 'own' : 'other'}`;
    bubble.innerHTML = `
      ${escapeHtml(msg.body || '').replace(/\n/g, '<br>')}
      <div style="font-size:10px; opacity:0.7; margin-top:5px; text-align:${isOwn ? 'right' : 'left'};">${timestamp}</div>
    `;

    feed.appendChild(bubble);
  });

  feed.scrollTop = feed.scrollHeight;

  // Show input footer for private messages
  const inputContainer = document.querySelector('.messenger-input');
  if (inputContainer) {
    inputContainer.classList.remove('hidden');
  }
}

function getSystemMessageTitle(body) {
  if (!body) return 'System Notification';

  if (body === 'vessel_got_hijacked') return '☠️ Vessel Hijacked';
  if (body === 'user_bought_stock') return '📈 Stock Purchase';
  if (body === 'user_sold_stock') return '📉 Stock Sale';
  if (body.includes('alliance') && body.includes('donation')) return '💰 Alliance Donation';
  if (body.includes('accepted_to_join_alliance')) return '🤝 Alliance Joined';
  if (body.startsWith('intro_pm_')) return '📚 Tutorial Message';

  // Fallback: format the body text (replace underscores, capitalize words)
  return body
    .replace(/_/g, ' ')
    .replace(/\//g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

async function displaySystemMessage(chat) {
  const feed = document.getElementById('messengerFeed');
  feed.innerHTML = '';

  const bubble = document.createElement('div');
  if (chat.body === 'vessel_got_hijacked') {
    bubble.className = 'message-bubble hijacking';
  } else {
    bubble.className = 'message-bubble system message-bubble-system';
  }

  const timestamp = formatTimestamp(chat.time_last_message);

  // Check if this is a hijacking notification - fetch case details first
  let caseDetails = null;
  let autopilotResolved = false;

  if (chat.body === 'vessel_got_hijacked' && chat.values?.case_id) {
    try {
      const response = await fetch('/api/hijacking/get-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: chat.values.case_id })
      });
      const data = await response.json();
      if (response.ok && data.data) {
        caseDetails = data.data;
        console.log('[Hijacking] Case details loaded:', caseDetails);

        // Load negotiation history from server
        let negotiationHistory = [];
        let resolvedAt = null;
        let paymentVerification = null;
        try {
          const historyResponse = await fetch(`/api/hijacking/history/${chat.values.case_id}`);
          const historyData = await historyResponse.json();
          negotiationHistory = historyData.history || [];
          autopilotResolved = historyData.autopilot_resolved || false;
          resolvedAt = historyData.resolved_at || null;
          paymentVerification = historyData.payment_verification || null;
        } catch (error) {
          console.error('Error loading hijack history:', error);
        }

        // Add initial demand if not in history
        if (negotiationHistory.length === 0 && chat.values.requested_amount) {
          negotiationHistory.push({
            type: 'pirate',
            amount: chat.values.requested_amount,
            timestamp: chat.time_last_message
          });
        }

        // Check if we need to add user proposal
        if (caseDetails.user_proposal &&
            !negotiationHistory.find(h => h.type === 'user' && h.amount === caseDetails.user_proposal)) {
          negotiationHistory.push({
            type: 'user',
            amount: caseDetails.user_proposal,
            timestamp: Date.now() / 1000
          });
        }

        // Check if pirates counter-offered (requested amount changed)
        const lastPirateOffer = negotiationHistory.filter(h => h.type === 'pirate').pop();
        if (lastPirateOffer && caseDetails.requested_amount !== lastPirateOffer.amount) {
          negotiationHistory.push({
            type: 'pirate',
            amount: caseDetails.requested_amount,
            timestamp: Date.now() / 1000
          });
        }

        // Save updated history to server
        try {
          // Preserve autopilot_resolved, resolved_at, and payment_verification if they exist
          const dataToSave = {
            history: negotiationHistory
          };

          // Always preserve these fields if they exist
          if (autopilotResolved) {
            dataToSave.autopilot_resolved = true;
          }
          if (resolvedAt) {
            dataToSave.resolved_at = resolvedAt;
          }
          if (paymentVerification) {
            dataToSave.payment_verification = paymentVerification;
          }

          await fetch(`/api/hijacking/history/${chat.values.case_id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataToSave)
          });
        } catch (error) {
          console.error('Error saving hijack history:', error);
        }

        caseDetails.offers = negotiationHistory;
        caseDetails.payment_verification = paymentVerification;

        // Polling removed - we now use 2-minute verification system after each offer
        // No automatic polling to avoid unnecessary chat reloads
      }
    } catch (error) {
      console.error('Error fetching hijacking case:', error);
    }
  }

  // Store chat data for later use
  bubble.dataset.chatBody = chat.body;
  bubble.dataset.chatValues = JSON.stringify(chat.values);
  if (caseDetails) {
    bubble.dataset.caseDetails = JSON.stringify(caseDetails);
  }

  // Format the system message based on body type
  let messageContent = formatSystemMessage(chat.body, chat.values, chat.subject, caseDetails, chat.time_last_message, autopilotResolved);

  bubble.innerHTML = `
    ${messageContent}
    <div style="font-size:10px; opacity:0.7; margin-top:10px;">${timestamp}</div>
  `;

  feed.appendChild(bubble);
  feed.scrollTop = feed.scrollHeight;

  // Add click handlers for hijacking offer buttons (if any)
  document.querySelectorAll('.hijacking-offer-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const caseId = this.dataset.caseId;
      // Deselect all buttons for this case
      document.querySelectorAll(`.hijacking-offer-btn[data-case-id="${caseId}"]`).forEach(b => {
        b.classList.remove('selected', 'hijacking-offer-btn-selected');
        b.classList.add('hijacking-offer-btn-unselected');
      });
      // Select this button
      this.classList.add('selected', 'hijacking-offer-btn-selected');
      this.classList.remove('hijacking-offer-btn-unselected');
    });
  });

  // Hide input footer for system messages
  const inputContainer = document.querySelector('.messenger-input');
  if (inputContainer) {
    inputContainer.classList.add('hidden');
  }
}

function formatSystemMessage(body, values, subject, caseDetails, messageTimestamp, autopilotResolved = false) {
  // Handle different system message types
  if (!body) return '<div style="color: #94a3b8;">System notification (no details)</div>';

  const v = values || {};

  // Vessel hijacked
  if (body === 'vessel_got_hijacked' && v.vessel_name) {
    const caseId = v.case_id;

    // Use case details if available, otherwise fall back to message values
    const requestedAmount = caseDetails?.requested_amount || v.requested_amount || 0;
    const userProposal = caseDetails?.user_proposal || null;
    const paidAmount = caseDetails?.paid_amount || null;
    const caseStatus = caseDetails?.status || null;
    const initialAmount = v.requested_amount || 0; // Original demand from message
    const registeredAt = caseDetails?.registered_at || messageTimestamp || null;

    let actionsHTML = '';
    let statusHTML = '';
    let negotiationHistoryHTML = '';

    // Use negotiation history from caseDetails if available (loaded from server)
    // Otherwise build it from current API data
    let negotiationHistory = caseDetails?.offers || [];

    // If no stored history, build from current data (first time)
    if (negotiationHistory.length === 0) {
      // Add initial pirate demand
      if (initialAmount > 0) {
        negotiationHistory.push({
          type: 'pirate',
          amount: initialAmount,
          timestamp: registeredAt
        });
      }

      // Add user proposal if exists
      if (userProposal && userProposal > 0) {
        negotiationHistory.push({
          type: 'user',
          amount: userProposal,
          timestamp: null
        });
      }

      // Add pirate counter-offer if they changed the price
      if (requestedAmount !== initialAmount && requestedAmount > 0) {
        negotiationHistory.push({
          type: 'pirate',
          amount: requestedAmount,
          timestamp: null
        });
      }
    }

    // Build negotiation history HTML
    if (negotiationHistory.length > 0) {
      negotiationHistoryHTML = `
        <div class="hijacking-history-box">
          <div class="hijacking-history-title">📝 Negotiation History:</div>
          <div class="hijacking-history-content">
      `;

      negotiationHistory.forEach((offer) => {
        const isUserOffer = offer.type === 'user';
        const amount = offer.amount;
        const colorClass = isUserOffer ? 'hijacking-history-user' : 'hijacking-history-pirate';

        negotiationHistoryHTML += `
          <div class="hijacking-history-item">
            <span class="${colorClass}">
              ${isUserOffer ? '👤 You offered' : '☠️ Pirates demanded'}:
            </span>
            <strong class="${colorClass}">
              $${amount.toLocaleString()}
            </strong>
          </div>
        `;
      });

      negotiationHistoryHTML += `
          </div>
        </div>
      `;
    }

    // Check if case is actually resolved (paid OR status = 'solved')
    const isResolved = paidAmount !== null || caseStatus === 'solved';

    if (isResolved) {
      // Case is resolved (paid) - if paid_amount is null but status is 'solved', use requested_amount
      const finalAmount = paidAmount || requestedAmount;

      // Check payment verification
      const paymentVerification = caseDetails?.payment_verification;
      let verificationHTML = '';

      if (paymentVerification) {
        if (paymentVerification.verified) {
          // Payment verified - show Blackbeard signature ONLY if autopilot resolved
          if (autopilotResolved) {
            verificationHTML = `
              <div style="position: absolute; right: -8px; top: calc(35% + 50px); transform: translateY(-50%); text-align: right;">
                <div style="font-family: 'Segoe Script', 'Lucida Handwriting', 'Brush Script MT', cursive; font-size: 24px; font-weight: 900; color: #8b4513; opacity: 0.7; transform: rotate(-15deg); letter-spacing: 1px;">
                  Blackbeard
                </div>
              </div>
            `;
          } else {
            // User resolved manually - show verification details without Blackbeard signature
            verificationHTML = `
              <div style="margin-top: 12px; padding: 10px; background: rgba(16, 185, 129, 0.1); border: 2px solid #10b981; border-radius: 4px;">
                <div style="color: #10b981; font-weight: bold; font-size: 14px; text-align: center;">✓ Payment Verified</div>
                <div style="margin-top: 8px; font-size: 12px; color: #9ca3af;">
                  Expected: <strong>$${paymentVerification.expected_amount.toLocaleString()}</strong><br>
                  Paid: <strong>$${paymentVerification.actual_paid.toLocaleString()}</strong><br>
                  Cash Before: $${paymentVerification.cash_before.toLocaleString()}<br>
                  Cash After: $${paymentVerification.cash_after.toLocaleString()}
                </div>
              </div>
            `;
          }
        } else {
          // Payment NOT verified - show FAILED
          verificationHTML = `
            <div style="margin-top: 12px; padding: 10px; background: rgba(239, 68, 68, 0.2); border: 2px solid #ef4444; border-radius: 4px;">
              <div style="color: #ef4444; font-weight: bold; font-size: 18px; text-align: center;">⚠️ PAYMENT VERIFICATION FAILED ⚠️</div>
              <div style="margin-top: 8px; font-size: 12px; color: #fca5a5;">
                Expected: <strong>$${paymentVerification.expected_amount.toLocaleString()}</strong><br>
                Actually Paid: <strong>$${paymentVerification.actual_paid.toLocaleString()}</strong><br>
                Cash Before: $${paymentVerification.cash_before.toLocaleString()}<br>
                Cash After: $${paymentVerification.cash_after.toLocaleString()}
              </div>
            </div>
          `;
        }
      } else {
        // No verification data - check autopilot_resolved flag
        if (autopilotResolved) {
          // Autopilot resolved without verification data (old case)
          verificationHTML = `
            <div style="position: absolute; right: -8px; top: calc(35% + 50px); transform: translateY(-50%); text-align: right;">
              <div style="font-family: 'Segoe Script', 'Lucida Handwriting', 'Brush Script MT', cursive; font-size: 24px; font-weight: 900; color: #8b4513; opacity: 0.7; transform: rotate(-15deg); letter-spacing: 1px;">
                Blackbeard
              </div>
            </div>
          `;
        } else {
          // Manual resolution without verification data
          verificationHTML = '';
        }
      }

      actionsHTML = `
        ${negotiationHistoryHTML}
        <div class="hijacking-resolved-box">
          <div class="hijacking-resolved-title">✓ Case Resolved</div>
          <div class="hijacking-resolved-amount">
            Final Amount Paid: <strong>$${finalAmount.toLocaleString()}</strong>
          </div>
          ${verificationHTML}
        </div>
      `;
    } else {
      // Case is still active - show negotiation status and buttons
      if (userProposal) {
        statusHTML = `
          <div style="margin-top: 12px; padding: 10px; background: rgba(251, 146, 60, 0.1); border-left: 3px solid #fbbf24; border-radius: 4px;">
            <div style="font-size: 12px; opacity: 0.9;">
              <strong>Your Last Offer:</strong> $${userProposal.toLocaleString()}<br>
              <strong>Current Demand:</strong> $${requestedAmount.toLocaleString()}
            </div>
          </div>
        `;
      }

      // CRITICAL: Stop negotiating if price is under $20,000 OR if user has made 2+ offers
      // Below $20k threshold, accept the deal - you've reached a good price!
      // After 2 offers, must accept or risk game bug (pays full initial price on 3rd offer)
      const userOfferCount = negotiationHistory.filter(h => h.type === 'user').length;
      const canNegotiate = requestedAmount >= 20000 && userOfferCount < 2;

      if (canNegotiate) {
        actionsHTML = `
          ${statusHTML}
          ${negotiationHistoryHTML}
          <div id="hijacking-actions-${caseId}" style="margin-top: 16px; display: flex; gap: 8px;">
            <button class="btn-primary" onclick="window.acceptHijackingPrice(${caseId}, ${requestedAmount})" style="flex: 1; padding: 8px 16px; background: #4ade80; border: none; color: white; border-radius: 4px; cursor: pointer;">Accept Price ($${requestedAmount.toLocaleString()})</button>
            <button class="btn-secondary" onclick="window.showNegotiateOptions(${caseId}, ${requestedAmount})" style="flex: 1; padding: 8px 16px; background: #3b82f6; border: none; color: white; border-radius: 4px; cursor: pointer;">Negotiate Price</button>
          </div>
          <div id="hijacking-negotiate-${caseId}" style="display: none; margin-top: 16px; padding: 12px; background: rgba(59, 130, 246, 0.1); border-radius: 4px;">
            <div style="margin-bottom: 12px; font-weight: bold; text-align: center;">Choose your counter-offer:</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
              <button class="hijacking-offer-btn" data-case-id="${caseId}" data-fixed-amount="1">
                <div style="font-weight: bold; margin-bottom: 4px;">A Copper Pot</div>
                <div style="font-size: 11px; opacity: 0.8;">$1</div>
              </button>
              <button class="hijacking-offer-btn" data-case-id="${caseId}" data-percentage="0.25">
                <div style="font-weight: bold; margin-bottom: 4px;">A Tattered Patch</div>
                <div style="font-size: 11px; opacity: 0.8;">$${Math.floor(requestedAmount * 0.25).toLocaleString()}</div>
              </button>
            </div>
            <hr style="border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 12px 0;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
              <button class="hijacking-offer-btn" data-case-id="${caseId}" data-percentage="0.50">
                <div style="font-weight: bold; margin-bottom: 4px;">A Fair Trade</div>
                <div style="font-size: 11px; opacity: 0.8;">$${Math.floor(requestedAmount * 0.50).toLocaleString()}</div>
              </button>
              <button class="hijacking-offer-btn" data-case-id="${caseId}" data-percentage="0.75">
                <div style="font-weight: bold; margin-bottom: 4px;">The Lion's Share</div>
                <div style="font-size: 11px; opacity: 0.8;">$${Math.floor(requestedAmount * 0.75).toLocaleString()}</div>
              </button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button class="btn-primary" onclick="window.proposeHijackingPrice(${caseId}, ${requestedAmount})" style="padding: 8px 12px; background: #3b82f6; border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 500;">Propose Price</button>
              <button class="btn-secondary" onclick="window.cancelNegotiate(${caseId})" style="padding: 8px 12px; background: #6b7280; border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 500;">Cancel</button>
            </div>
          </div>
        `;
      } else {
        // Price is under $20,000 OR user has made 3+ offers - only allow accept, no more negotiation
        const maxOffersReached = userOfferCount >= 2;

        if (maxOffersReached) {
          // After 3 offers: Show critical warning about game bug
          actionsHTML = `
            ${statusHTML}
            ${negotiationHistoryHTML}
            <div style="margin-top: 12px; padding: 12px; background: rgba(239, 68, 68, 0.1); border-radius: 8px; text-align: center;">
              <div style="font-size: 14px; font-weight: bold; color: #ef4444; margin-bottom: 4px;">⚠️ Maximum Offers Reached</div>
              <div style="font-size: 12px; color: #9ca3af;">You must accept or risk paying the full initial ransom</div>
            </div>
            <div id="hijacking-actions-${caseId}" style="margin-top: 16px;">
              <button class="btn-primary" onclick="window.acceptHijackingPrice(${caseId}, ${requestedAmount})" style="width: 100%; padding: 12px; background: #10b981; border: none; color: white; border-radius: 6px; cursor: pointer; font-weight: 500;">Accept Price ($${requestedAmount.toLocaleString()})</button>
            </div>
          `;
        } else {
          // Price is under $20,000 - show Blackbeard message
          actionsHTML = `
            ${statusHTML}
            ${negotiationHistoryHTML}
            <div style="margin-top: 12px; padding: 12px; background: rgba(34, 197, 94, 0.1); border-left: 3px solid #4ade80; border-radius: 4px; position: relative;">
              <div style="font-size: 13px; font-weight: bold; color: #4ade80; margin-bottom: 8px;">
                ☠️ Goal achieved, won't get cheaper. Give them the few bucks
              </div>
              <div style="font-size: 12px; opacity: 0.8; font-style: italic; margin-top: 8px; color: #6b7280;">
                "If you were waiting for the opportune moment, that was it."<br>
                — Captain Blackbeard
              </div>
              <div style="position: absolute; right: -8px; top: calc(50% - 10px); transform: translateY(-50%); text-align: right;">
                <div style="font-family: 'Segoe Script', 'Lucida Handwriting', 'Brush Script MT', cursive; font-size: 24px; font-weight: 900; color: #8b4513; opacity: 0.7; transform: rotate(-15deg); letter-spacing: 1px;">
                  Blackbeard
                </div>
              </div>
            </div>
            <div id="hijacking-actions-${caseId}" style="margin-top: 16px;">
              <button class="btn-primary" onclick="window.acceptHijackingPrice(${caseId}, ${requestedAmount})" style="padding: 12px 24px; background: #4ade80; border: none; color: white; border-radius: 4px; cursor: pointer; font-weight: bold;">Pay Ransom ($${requestedAmount.toLocaleString()})</button>
            </div>
          `;
        }
      }
    }

    // Get original ransom demand (first pirate offer)
    const originalDemand = negotiationHistory.find(h => h.type === 'pirate')?.amount || initialAmount || requestedAmount;

    // Format location: remove underscores and capitalize first letters
    const formattedLocation = (v.tr_danger_zone || 'Unknown')
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    return `
      <div class="hijacking-info-box">
        <div class="hijacking-info-title">☠️ Vessel Hijacked!</div>
        <div class="hijacking-info-details">
          <strong>Vessel:</strong> ${escapeHtml(v.vessel_name)}<br>
          <strong>Location:</strong> ${escapeHtml(formattedLocation)}<br>
          <strong>Ransom Demand:</strong> $${originalDemand.toLocaleString()}<br>
          <strong>Case ID:</strong> ${caseId || 'N/A'}
        </div>
      </div>
      ${actionsHTML}
    `;
  }

  // Stock transactions
  if (body === 'user_bought_stock' && v.stockOwner) {
    return `
      <div style="color: #4ade80;">📈 Stock Purchase</div>
      <div style="margin-top: 8px;">
        <strong>Company:</strong> ${escapeHtml(v.stockOwner)}<br>
        <strong>Shares:</strong> ${(v.stockAmount || 0).toLocaleString()}<br>
        <strong>Total Value:</strong> $${(v.totalAmount || 0).toLocaleString()}
      </div>
    `;
  }

  if (body === 'user_sold_stock' && v.stockOwner) {
    return `
      <div style="color: #fbbf24;">📉 Stock Sale</div>
      <div style="margin-top: 8px;">
        <strong>Company:</strong> ${escapeHtml(v.stockOwner)}<br>
        <strong>Shares:</strong> ${(v.stockAmount || 0).toLocaleString()}<br>
        <strong>Total Value:</strong> $${(v.totalAmount || 0).toLocaleString()}
      </div>
    `;
  }

  // Alliance donation
  if (body.includes('alliance') && body.includes('donation') && v.amount) {
    return `
      <div style="color: #a78bfa;">💰 Alliance Donation</div>
      <div style="margin-top: 8px;">
        <strong>Amount:</strong> ${v.amount}<br>
        ${v.comment ? `<strong>Message:</strong> "${escapeHtml(v.comment)}"` : ''}
      </div>
    `;
  }

  // Alliance accepted
  if (body.includes('accepted_to_join_alliance') && v.alliance_name) {
    return `
      <div style="color: #4ade80;">🤝 Alliance Joined</div>
      <div style="margin-top: 8px;">
        You have joined <strong>${escapeHtml(v.alliance_name)}</strong>!
      </div>
    `;
  }

  // User applied to join alliance
  if (body === 'user_applied_to_join_alliance_message' && v.company_name) {
    return `
      <div style="color: #fbbf24; font-size: 16px; font-weight: bold;">Ahoy Captain!</div>
      <div style="margin-top: 12px; line-height: 1.6;">
        <strong>${escapeHtml(v.company_name)}</strong> has applied to join your alliance.<br><br>
        Respond to him in the recruitment section in the alliance menu.
      </div>
    `;
  }

  // Alliance interim CEO notification
  if (body === 'alliance_interrim_ceo' && v.allianceName) {
    const allianceName = escapeHtml(v.allianceName);
    const ceoName = escapeHtml(v.currentCeo || 'the CEO');
    const buttonId = `interimCeoThankBtn_${Date.now()}`;

    // Attach event listener after render
    setTimeout(() => {
      const btn = document.getElementById(buttonId);
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Sending...';

          try {
            // Fetch alliance members to get CEO user ID
            const membersResponse = await fetch('/api/alliance/members');
            const membersData = await membersResponse.json();

            if (!membersResponse.ok) {
              throw new Error('Failed to fetch alliance members');
            }

            // Find CEO in members list
            const ceoMember = membersData.members?.find(m =>
              m.company_name === v.currentCeo || m.role === 'ceo'
            );

            if (!ceoMember) {
              throw new Error('CEO not found in alliance members');
            }

            // Send thank you message to alliance chat with CEO mention
            const thankYouMessage = `[${ceoMember.user_id}] Thank you for your trust!`;

            const sendResponse = await fetch('/api/alliance/send-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: thankYouMessage })
            });

            if (!sendResponse.ok) {
              throw new Error('Failed to send message');
            }

            btn.textContent = 'Message Sent!';
            btn.style.background = 'var(--color-success-20)';
            btn.style.borderColor = 'var(--color-success-30)';
          } catch (error) {
            console.error('[Interim CEO] Error sending thank you:', error);
            btn.textContent = 'Failed to send';
            btn.style.background = 'var(--color-danger-20)';
            btn.disabled = false;
          }
        });
      }
    }, 100);

    return `
      <div style="color: #fbbf24; font-size: 18px; font-weight: bold;">🎉 Congratulations!</div>
      <div style="margin-top: 12px; line-height: 1.6;">
        You have been made <strong>Interim CEO</strong> in your alliance <strong>${allianceName}</strong>
        as the current CEO <strong>${ceoName}</strong> has been inactive.<br><br>
        Once he is active again he will resume his role, but until then you're in charge!
      </div>
      <div style="margin-top: 16px;">
        <button id="${buttonId}" style="background: var(--color-info-20); border: 1px solid var(--color-info-30); color: var(--color-info-lighter); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600;">
          Say Thank You
        </button>
      </div>
    `;
  }

  // Tutorial/intro messages
  if (body.startsWith('intro_pm_')) {
    return `
      <div style="color: #60a5fa;">📚 Tutorial Message</div>
      ${subject ? `<div style="margin-top: 8px;">${escapeHtml(subject)}</div>` : ''}
    `;
  }

  // Fallback: show raw data
  return `
    <div style="color: #94a3b8;"><strong>Type:</strong> ${escapeHtml(body)}</div>
    ${subject ? `<div style="margin-top: 5px;"><strong>Subject:</strong> ${escapeHtml(subject)}</div>` : ''}
    ${values ? `<div style="margin-top: 5px; font-size: 11px; opacity: 0.8;"><strong>Data:</strong> ${escapeHtml(JSON.stringify(values, null, 2))}</div>` : ''}
  `;
}

export function closeMessenger() {
  // Reset hijacking inbox flag
  window.cameFromHijackingInbox = false;

  // Stop hijacking polling when closing messenger
  stopHijackingPolling();

  // Clear any active hijacking timers
  Object.keys(window).forEach(key => {
    if (key.startsWith('hijackTimer_')) {
      clearInterval(window[key]);
      delete window[key];
    }
  });

  const messengerOverlay = document.getElementById('messengerOverlay');
  messengerOverlay.classList.add('hidden');
  // Remove hijacking case view class
  messengerOverlay.classList.remove('hijacking-case-view');
  currentPrivateChat = { chatId: null, subject: null, targetCompanyName: null, targetUserId: null, messages: [], isNewChat: false, isSystemChat: false };
  document.getElementById('messengerFeed').innerHTML = '';
  document.getElementById('messengerInput').value = '';
  document.getElementById('subjectInput').value = '';
  document.getElementById('subjectInputWrapper').classList.add('hidden');
  // Restore input area visibility
  document.getElementById('messengerInput').classList.remove('hidden');
  document.getElementById('sendPrivateMessageBtn').classList.remove('hidden');
}

/**
 * Closes chat selection overlay and clears selection state.
 */
export function closeChatSelection() {
  document.getElementById('chatSelectionOverlay').classList.add('hidden');
  userChatsForSelection = [];
}

/**
 * Displays overlay showing all private conversations sorted by recent activity.
 * Provides unified view of all chats with delete functionality per conversation.
 *
 * Features:
 * - Sorted by most recent message timestamp
 * - Shows message preview and timestamp
 * - Displays unread indicator badge
 * - Trash icon per chat for deletion
 * - Clicking chat opens full conversation
 *
 * Side Effects:
 * - Fetches all chats from API
 * - Shows all chats overlay
 * - Registers click handlers for each chat and delete button
 *
 * @async
 * @returns {Promise<void>}
 *
 * @example
 * // User clicks mailbox icon in toolbar
 * showAllChats();
 */
export async function showAllChats() {
  try {
    const data = await fetchMessengerChats();
    // Exclude hijacking messages (they go to Phone Booth)
    const chats = data.chats.filter(chat =>
      !(chat.system_chat && chat.body === 'vessel_got_hijacked')
    );

    // Fetch contacts to build name-to-ID mapping
    const contactsData = await fetchContacts();
    const nameToIdMap = new Map();

    // Add all contacts to the map
    if (contactsData.contacts) {
      contactsData.contacts.forEach(contact => {
        if (contact.company_name && contact.id) {
          nameToIdMap.set(contact.company_name, contact.id);
        }
      });
    }

    // Add all alliance contacts to the map
    if (contactsData.alliance_contacts) {
      contactsData.alliance_contacts.forEach(contact => {
        if (contact.company_name && contact.id) {
          nameToIdMap.set(contact.company_name, contact.id);
        }
      });
    }

    if (window.DEBUG_MODE) {
      console.log('[MESSENGER DEBUG] Built name-to-ID map with', nameToIdMap.size, 'entries');
    }

    const sortedChats = chats.sort((a, b) => (b.time_last_message || 0) - (a.time_last_message || 0));

    const listContainer = document.getElementById('allChatsList');

    if (sortedChats.length === 0) {
      listContainer.innerHTML = '<div class="empty-message">No private conversations yet.</div>';
    } else {
      listContainer.innerHTML = sortedChats.map((chat, index) => {
        const isSystemChat = chat.system_chat || false;
        const lastMsg = isSystemChat ? getSystemMessageTitle(chat.body, chat.values) : (chat.last_message ? escapeHtml(chat.last_message.substring(0, 60)) + '...' : 'No messages');
        const subject = isSystemChat ? '📢 System Notification' : (chat.subject || 'No subject');
        const participant = chat.participants_string || 'Unknown';
        const unreadIndicator = chat.new ? '<span class="unread-indicator"></span>' : '';

        // Format timestamp
        const timestamp = formatTimestamp(chat.time_last_message);

        return `
          <div class="chat-selection-item" data-chat-index="${index}" style="position: relative; padding-right: 40px;">
            <div style="flex: 1;">
              <h3>${escapeHtml(participant)} - ${escapeHtml(subject)}${unreadIndicator}</h3>
              <p>${lastMsg}</p>
              <p style="font-size: 11px; opacity: 0.7; margin-top: 4px;">${timestamp}</p>
            </div>
            <button class="delete-chat-btn" data-chat-index="${index}">🗑️</button>
          </div>
        `;
      }).join('');

      listContainer.querySelectorAll('.chat-selection-item').forEach(item => {
        const chatItem = item.querySelector('div[style*="flex: 1"]');
        if (chatItem) {
          chatItem.addEventListener('click', async () => {
            const chatIndex = parseInt(item.dataset.chatIndex);
            const selectedChat = sortedChats[chatIndex];

            if (window.DEBUG_MODE) {
              console.log('[MESSENGER DEBUG] Opening chat from showAllChats:');
              console.log('  selectedChat:', selectedChat);
              console.log('  participants_string:', selectedChat.participants_string);
              console.log('  own_user_id:', data.own_user_id);
            }

            const targetCompanyName = selectedChat.participants_string;
            let targetUserId = nameToIdMap.get(targetCompanyName);

            if (window.DEBUG_MODE) {
              console.log('  targetUserId from map:', targetUserId, 'type:', typeof targetUserId);
              console.log('  targetCompanyName:', targetCompanyName);
            }

            // If not found in contact list and not a system chat, try user search
            if (!targetUserId && !selectedChat.system_chat && targetCompanyName) {
              if (window.DEBUG_MODE) {
                console.log('[MESSENGER DEBUG] User not in contacts, searching via /user/search...');
              }
              try {
                const searchResults = await searchUsers(targetCompanyName);
                if (searchResults.data && searchResults.data.companies && searchResults.data.companies.length > 0) {
                  // Find exact match
                  const exactMatch = searchResults.data.companies.find(c => c.company_name === targetCompanyName);
                  if (exactMatch) {
                    targetUserId = exactMatch.id;
                    if (window.DEBUG_MODE) {
                      console.log('[MESSENGER DEBUG] Found user via search:', targetUserId);
                    }
                  } else if (window.DEBUG_MODE) {
                    console.warn('[MESSENGER DEBUG] No exact match in search results');
                  }
                }
              } catch (error) {
                if (window.DEBUG_MODE) {
                  console.error('[MESSENGER DEBUG] User search failed:', error);
                }
              }
            }

            if (!targetUserId && !selectedChat.system_chat) {
              if (window.DEBUG_MODE) {
                console.warn('[MESSENGER DEBUG] Could not resolve user ID for:', targetCompanyName);
              }
            }

            document.getElementById('allChatsOverlay').classList.add('hidden');
            openExistingChat(targetCompanyName, targetUserId, selectedChat, data.own_user_id);
          });
        }
      });

      listContainer.querySelectorAll('.delete-chat-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const chatIndex = parseInt(btn.dataset.chatIndex);
          const chatToDelete = sortedChats[chatIndex];
          const chatItem = btn.closest('.chat-selection-item');

          const wasDeleted = await deleteChatWithConfirmation(chatToDelete);
          // Remove element immediately from DOM if deleted
          if (wasDeleted && chatItem) {
            chatItem.remove();
          }
        });
      });
    }

    document.getElementById('allChatsOverlay').classList.remove('hidden');

  } catch (error) {
    console.error('Error loading all chats:', error);
    alert(`Error: ${error.message}`);
  }
}

/**
 * Closes the all chats overlay.
 */
export function closeAllChats() {
  document.getElementById('allChatsOverlay').classList.add('hidden');
}

/**
 * Updates the unread message badge count in the UI.
 * Shows count of unread user messages (excludes system notifications).
 *
 * Badge Behavior:
 * - Visible only when unread count > 0
 * - Hidden when no unread messages
 * - Only counts non-system chats
 *
 * Side Effects:
 * - Fetches all messenger chats from API
 * - Updates badge visibility and count
 *
 * @async
 * @returns {Promise<void>}
 */
export async function updateUnreadBadge(retryCount = 0) {
  try {
    const data = await fetchMessengerChats();
    // Filter out hijacking messages - they go to Blackbeard's Phone Booth now
    const unreadCount = data.chats.filter(chat => {
      if (!chat.new) return false;
      // Exclude hijacking system messages
      if (chat.system_chat && chat.body === 'vessel_got_hijacked') {
        return false;
      }
      return true;
    }).length;

    // Get previous count from per-user cache
    const cacheKey = window.CACHE_KEY || 'badgeCache';
    const previousCache = localStorage.getItem(cacheKey);
    const previousCount = previousCache ? JSON.parse(previousCache).messages || 0 : 0;

    // Update badge using badge-manager
    updateBadge('unreadBadge', unreadCount, unreadCount > 0, 'RED');

    if (unreadCount > 0) {

      // Show browser notification if count increased and notifications are enabled
      if (unreadCount > previousCount && window.settings?.enableInboxNotifications) {
        // Find new unread messages
        const unreadChats = data.chats.filter(chat => chat.new);
        const systemMessages = unreadChats.filter(chat => chat.system_chat);
        const userMessages = unreadChats.filter(chat => !chat.system_chat);

        let notificationTitle = `📬 ${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`;
        let notificationBody = '';

        if (systemMessages.length > 0 && userMessages.length > 0) {
          notificationBody = `${userMessages.length} private message${userMessages.length === 1 ? '' : 's'}, ${systemMessages.length} system notification${systemMessages.length === 1 ? '' : 's'}`;
        } else if (systemMessages.length > 0) {
          // Check if any are hijack messages
          const hijackMessages = systemMessages.filter(chat => chat.body === 'vessel_got_hijacked');
          if (hijackMessages.length > 0) {
            notificationTitle = '☠️ Vessel Hijacked!';
            notificationBody = `${hijackMessages.length} vessel${hijackMessages.length === 1 ? ' has' : 's have'} been hijacked! Check your inbox immediately.`;
          } else {
            notificationBody = `${systemMessages.length} system notification${systemMessages.length === 1 ? '' : 's'}`;
          }
        } else {
          notificationBody = `${userMessages.length} new private message${userMessages.length === 1 ? '' : 's'}`;
        }

        // Show desktop notification
        if (Notification.permission === 'granted') {
          showNotification(notificationTitle, {
            body: `

${notificationBody}`,
            icon: '/favicon.ico',
            tag: "shipping-manager-inbox",
            requireInteraction: systemMessages.some(chat => chat.body === 'vessel_got_hijacked'), // Keep hijack notifications visible
            data: { action: 'open-inbox' }
          });
        }
      }
    }

    // Save to cache for next page load
    if (window.saveBadgeCache) {
      window.saveBadgeCache({ messages: unreadCount });
    }
  } catch (error) {
    // Check if it's a network error (ERR_NETWORK_CHANGED, Failed to fetch, etc.)
    const isNetworkError = error.message.includes('fetch') ||
                          error.message.includes('network') ||
                          error.name === 'TypeError';

    // Retry up to 2 times with exponential backoff
    if (isNetworkError && retryCount < 2) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s
      console.log(`[Messenger] Network error, retrying in ${delay}ms (attempt ${retryCount + 1}/2)`);
      setTimeout(() => updateUnreadBadge(retryCount + 1), delay);
    } else {
      console.error('Error checking unread messages:', error);
    }
  }
}

export async function sendPrivateMessage() {
  const messageInput = document.getElementById('messengerInput');
  const subjectInput = document.getElementById('subjectInput');
  const sendBtn = document.getElementById('sendPrivateMessageBtn');
  const message = messageInput.value.trim();

  if (!message || message.length > 1000) {
    alert('Invalid message length.');
    return;
  }

  let subject;
  if (currentPrivateChat.isNewChat) {
    subject = subjectInput.value.trim();
    if (!subject || subject.length === 0) {
      alert('Please enter a subject.');
      subjectInput.focus();
      return;
    }
  } else {
    subject = currentPrivateChat.subject;
  }

  // Show "Sending..." feedback
  const originalBtnText = sendBtn.textContent;
  sendBtn.textContent = 'Sending...';
  sendBtn.disabled = true;
  messageInput.disabled = true;

  try {
    await apiSendPrivateMessage(currentPrivateChat.targetUserId, subject, message);

    // Show success notification
    showSideNotification(`📬 <strong>Message sent</strong><br><br>Sent to ${escapeHtml(currentPrivateChat.targetCompanyName)}`, 'success', 3000);

    messageInput.value = '';
    messageInput.style.height = 'auto';

    if (window.debouncedUpdateUnreadBadge) {
      window.debouncedUpdateUnreadBadge();
    }

    // Reload messages to show the new message in the chat
    if (currentPrivateChat.chatId) {
      // Existing chat - reload messages
      await loadPrivateMessages(currentPrivateChat.chatId);
    } else {
      // New chat - refresh to get the chat ID
      const savedCompanyName = currentPrivateChat.targetCompanyName;
      const savedUserId = currentPrivateChat.targetUserId;
      closeMessenger();
      setTimeout(() => {
        openMessenger(savedCompanyName, savedUserId);
      }, 300); // Faster reload
    }

  } catch (error) {
    showSideNotification(`📬 <strong>Error</strong><br><br>${escapeHtml(error.message)}`, 'error', 5000);
  } finally {
    sendBtn.textContent = originalBtnText;
    sendBtn.disabled = false;
    messageInput.disabled = false;
  }
}

export function getCurrentPrivateChat() {
  return currentPrivateChat;
}

async function deleteChatWithConfirmation(chat) {
  const participant = chat.participants_string || 'Unknown';
  const isSystemChat = chat.system_chat || false;

  // For system chats, use getSystemMessageTitle() to format subject
  let subject = chat.subject || 'No subject';
  if (isSystemChat && chat.body) {
    subject = getSystemMessageTitle(chat.body, chat.values);
  }

  const confirmed = await showConfirmDialog({
    title: '🗑️ Delete Chat',
    message: `Do you want to delete this conversation?`,
    details: [
      { label: 'Participant', value: participant },
      { label: 'Subject', value: subject }
    ],
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });

  if (!confirmed) return false;

  try {
    // Extract case_id from values if this is a hijacking message
    const caseId = (isSystemChat && chat.body === 'vessel_got_hijacked' && chat.values?.case_id)
      ? chat.values.case_id
      : null;

    await apiDeleteChat(chat.id, isSystemChat, caseId);

    if (window.debouncedUpdateUnreadBadge) {
      window.debouncedUpdateUnreadBadge();
    }

    return true;
  } catch (error) {
    alert(`Error deleting chat: ${error.message}`);
    return false;
  }
}

export async function deleteCurrentChat() {
  if (!currentPrivateChat.chatId) {
    alert('No chat to delete');
    return;
  }

  // For system chats, use getSystemMessageTitle() to format subject
  let subject = currentPrivateChat.subject || 'No subject';
  if (currentPrivateChat.isSystemChat && currentPrivateChat.body) {
    subject = getSystemMessageTitle(currentPrivateChat.body, currentPrivateChat.values);
  }

  const confirmed = await showConfirmDialog({
    title: '🗑️ Delete Chat',
    message: `Do you want to delete this conversation?`,
    details: [
      { label: 'Participant', value: currentPrivateChat.targetCompanyName },
      { label: 'Subject', value: subject }
    ],
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    // Extract case_id from values if this is a hijacking message
    const isSystemChat = currentPrivateChat.isSystemChat || false;
    const caseId = (isSystemChat && currentPrivateChat.body === 'vessel_got_hijacked' && currentPrivateChat.values?.case_id)
      ? currentPrivateChat.values.case_id
      : null;

    await apiDeleteChat(currentPrivateChat.chatId, isSystemChat, caseId);
    closeMessenger();

    if (window.debouncedUpdateUnreadBadge) {
      window.debouncedUpdateUnreadBadge();
    }
  } catch (error) {
    alert(`Error deleting chat: ${error.message}`);
  }
}

/**
 * Hijacking handler: Accept the full ransom price
 */
window.acceptHijackingPrice = async function(caseId, amount) {
  // CRITICAL: ALWAYS get current price from API - NEVER trust cached values!
  let actualAmount = amount;

  try {
    const caseResponse = await fetch('/api/hijacking/get-case', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id: caseId })
    });

    const caseData = await caseResponse.json();
    if (caseResponse.ok && caseData.data) {
      actualAmount = caseData.data.requested_amount;
      console.log(`[Hijacking] Current price from API: $${actualAmount} (cached was: $${amount})`);
    }
  } catch (error) {
    console.error('[Hijacking] Failed to get current price, using cached:', error);
  }

  // Get current cash from header display
  const cashDisplay = document.getElementById('cashDisplay');
  const cashText = cashDisplay?.textContent || '$0';
  const currentCash = parseInt(cashText.replace(/[$,\s]/g, '')) || 0;

  const confirmed = await showConfirmDialog({
    title: '☠️ Accept Ransom',
    message: `Accept the ransom demand and pay the full price?`,
    details: [
      { label: 'Case ID', value: caseId },
      { label: 'Total Cost', value: `$${actualAmount.toLocaleString()}` },
      { label: 'Available Cash', value: `$${currentCash.toLocaleString()}` }
    ],
    confirmText: 'Pay Ransom',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    // Pay the ransom (not submit offer!)
    const response = await fetch('/api/hijacking/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id: caseId })
    });

    const data = await response.json();
    console.log('[Hijacking] Pay ransom response:', data);

    if (!response.ok) {
      throw new Error(data.error || 'Failed to pay ransom');
    }

    // Reload the case details to get the REAL status from API
    const caseResponse = await fetch('/api/hijacking/get-case', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id: caseId })
    });

    const caseData = await caseResponse.json();
    console.log('[Hijacking] Get case after accept:', caseData);

    if (!caseResponse.ok || !caseData.data) {
      throw new Error('Failed to reload case details');
    }

    const updatedCase = caseData.data;

    // Get the original chat values from the stored data
    const feed = document.getElementById('messengerFeed');
    const bubble = feed.querySelector('.message-bubble.system');

    if (bubble) {
      // Retrieve stored chat values
      const storedValues = bubble.dataset.chatValues ? JSON.parse(bubble.dataset.chatValues) : {};

      // Reconstruct chat with updated data
      const chat = {
        body: 'vessel_got_hijacked',
        values: {
          case_id: caseId,
          vessel_name: storedValues.vessel_name || 'Unknown',
          tr_danger_zone: storedValues.tr_danger_zone || 'Unknown',
          requested_amount: updatedCase.requested_amount || 0
        },
        time_last_message: Date.now() / 1000
      };

      // Re-render the message with updated case details
      await displaySystemMessage(chat);

      // Check if payment was actually successful (paid_amount OR status = 'solved')
      if (updatedCase.paid_amount !== null || updatedCase.status === 'solved') {
        const finalAmount = updatedCase.paid_amount || updatedCase.requested_amount;
        showSideNotification(
          `<strong>✓ Ransom Paid!</strong><br><br>` +
          `Amount: $${finalAmount.toLocaleString()}<br>` +
          `Your vessel will be released.`,
          'success',
          5000
        );
      } else {
        // Payment didn't go through - show current status
        showSideNotification(
          `<strong>Payment sent</strong><br><br>` +
          `Your offer: $${amount.toLocaleString()}<br>` +
          `Current demand: $${updatedCase.requested_amount.toLocaleString()}`,
          'info',
          5000
        );
      }
    }

  } catch (error) {
    console.error('[Hijacking] Error:', error);
    showSideNotification(`Error: ${error.message}`, 'error');
  }
};

/**
 * Hijacking handler: Show negotiation options
 */
window.showNegotiateOptions = function(caseId) {
  const actionsDiv = document.getElementById(`hijacking-actions-${caseId}`);
  const negotiateDiv = document.getElementById(`hijacking-negotiate-${caseId}`);

  if (actionsDiv) actionsDiv.style.display = 'none';
  if (negotiateDiv) negotiateDiv.style.display = 'block';
};

/**
 * Hijacking handler: Cancel negotiation and return to main actions
 */
window.cancelNegotiate = function(caseId) {
  const actionsDiv = document.getElementById(`hijacking-actions-${caseId}`);
  const negotiateDiv = document.getElementById(`hijacking-negotiate-${caseId}`);

  if (actionsDiv) actionsDiv.style.display = 'flex';
  if (negotiateDiv) negotiateDiv.style.display = 'none';

  // Clear radio selection
  const radios = document.querySelectorAll(`input[name="hijacking-offer-${caseId}"]`);
  radios.forEach(radio => radio.checked = false);
};

/**
 * Hijacking handler: Propose selected counter-offer
 */
window.proposeHijackingPrice = async function(caseId, requestedAmount) {
  const selectedButton = document.querySelector(`.hijacking-offer-btn[data-case-id="${caseId}"].selected`);

  if (!selectedButton) {
    showSideNotification('Please select an offer option', 'warning');
    return;
  }

  // Check if this is a fixed amount offer or percentage-based
  let offerAmount;
  if (selectedButton.dataset.fixedAmount) {
    offerAmount = parseInt(selectedButton.dataset.fixedAmount);
  } else {
    const percentage = parseFloat(selectedButton.dataset.percentage);
    offerAmount = Math.floor(requestedAmount * percentage);
  }

  // Get offer name from button
  const offerName = selectedButton.querySelector('div:first-child').textContent;

  // Get current cash from header display
  const cashDisplay = document.getElementById('cashDisplay');
  const cashText = cashDisplay?.textContent || '$0';
  const currentCash = parseInt(cashText.replace(/[$,\s]/g, '')) || 0;

  const confirmed = await showConfirmDialog({
    title: '☠️ Submit Counter-Offer',
    message: `Submit this counter-offer to the pirates?`,
    details: [
      { label: 'Case ID', value: caseId },
      { label: 'Offer Type', value: offerName },
      { label: 'Total Cost', value: `$${offerAmount.toLocaleString()}` },
      { label: 'Available Cash', value: `$${currentCash.toLocaleString()}` }
    ],
    confirmText: 'Submit Offer',
    cancelText: 'Cancel'
  });

  if (!confirmed) return;

  try {
    // Send the offer
    const response = await fetch('/api/hijacking/submit-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_id: caseId, amount: offerAmount })
    });

    const data = await response.json();
    console.log('[Hijacking] Submit offer response:', data);

    if (!response.ok) {
      throw new Error(data.error || 'Failed to submit offer');
    }

    // Save user's offer to history immediately
    try {
      // Load existing history
      const historyResponse = await fetch(`/api/hijacking/history/${caseId}`);
      const historyData = await historyResponse.json();
      const negotiationHistory = historyData.history || [];

      // Add user's offer to history
      negotiationHistory.push({
        type: 'user',
        amount: offerAmount,
        timestamp: Date.now() / 1000
      });

      // Save updated history (preserve ALL existing metadata fields)
      const dataToSave = {
        history: negotiationHistory
      };

      // Preserve autopilot_resolved if it exists
      if (historyData.autopilot_resolved !== undefined) {
        dataToSave.autopilot_resolved = historyData.autopilot_resolved;
      }

      // Preserve resolved_at if it exists
      if (historyData.resolved_at) {
        dataToSave.resolved_at = historyData.resolved_at;
      }

      // Preserve payment_verification if it exists
      if (historyData.payment_verification) {
        dataToSave.payment_verification = historyData.payment_verification;
      }

      await fetch(`/api/hijacking/history/${caseId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });

      console.log('[Hijacking] User offer saved to history:', offerAmount);
    } catch (error) {
      console.error('[Hijacking] Failed to save user offer to history:', error);
    }

    // Show success notification
    showSideNotification(`Offer submitted!`, 'success', 3000);

    // Get counter-offer from API response (immediate, no waiting!)
    const pirateCounterOffer = data.data?.requested_amount;
    console.log('[Hijacking] Submit offer response:', data);
    console.log('[Hijacking] Pirate counter-offer:', pirateCounterOffer);

    if (!pirateCounterOffer) {
      throw new Error('API did not return counter-offer');
    }

    // Save pirate counter-offer to history
    let negotiationHistory = [];
    try {
      const historyResponse = await fetch(`/api/hijacking/history/${caseId}`);
      const historyData = await historyResponse.json();
      negotiationHistory = historyData.history || [];

      negotiationHistory.push({
        type: 'pirate',
        amount: pirateCounterOffer,
        timestamp: Date.now() / 1000
      });

      // Save updated history (preserve ALL existing metadata fields)
      const dataToSave = {
        history: negotiationHistory
      };

      // Preserve autopilot_resolved if it exists
      if (historyData.autopilot_resolved !== undefined) {
        dataToSave.autopilot_resolved = historyData.autopilot_resolved;
      }

      // Preserve resolved_at if it exists
      if (historyData.resolved_at) {
        dataToSave.resolved_at = historyData.resolved_at;
      }

      // Preserve payment_verification if it exists
      if (historyData.payment_verification) {
        dataToSave.payment_verification = historyData.payment_verification;
      }

      await fetch(`/api/hijacking/history/${caseId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });

      console.log('[Hijacking] Pirate counter-offer saved to history:', pirateCounterOffer);
    } catch (error) {
      console.error('[Hijacking] Failed to save pirate counter-offer to history:', error);
    }

    // Count how many user offers have been made (max 2 before auto-accept bug on 3rd)
    const userOfferCount = negotiationHistory.filter(h => h.type === 'user').length;
    console.log('[Hijacking] User has made', userOfferCount, 'offers');

    // Reload the hijacking message to show updated negotiation history
    // displaySystemMessage already renders everything correctly, no need for showCounterOfferUI
    if (currentPrivateChat && currentPrivateChat.body === 'vessel_got_hijacked') {
      await displaySystemMessage(currentPrivateChat);
    }

    // Show notification about pirate response
    showSideNotification(`☠️ Pirates counter-offered: $${pirateCounterOffer.toLocaleString()}`, 'warning', 6000);

    // Scroll to see the new offer
    const feed = document.getElementById('messengerFeed');
    if (feed) {
      setTimeout(() => {
        feed.scrollTop = feed.scrollHeight;
      }, 100);
    }

  } catch (error) {
    console.error('[Hijacking] Error:', error);
    showSideNotification(`Error: ${error.message}`, 'error');
  }
};

/**
 * Stop hijacking case polling.
 */
function stopHijackingPolling() {
  if (hijackingPollingInterval) {
    console.log('[Hijacking] Stopping polling');
    clearInterval(hijackingPollingInterval);
    hijackingPollingInterval = null;
  }
}
