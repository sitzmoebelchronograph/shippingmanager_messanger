/**
 * @fileoverview API module for all client-server communication.
 * Handles all HTTP requests to the backend API endpoints including chat,
 * vessels, bunker management, messenger, campaigns, and user data.
 *
 * All functions implement proper error handling and return promises.
 *
 * @module api
 */

// Vessel data cache - only invalidated on actual changes (purchase, sale, WebSocket updates)
const vesselDataCache = {
  acquirable: { data: null, valid: false },
  owned: { data: null, valid: false }
};

// Force cache refresh (called by WebSocket updates or after purchases/sales)
export function invalidateVesselCache(type = 'all') {
  if (type === 'all' || type === 'acquirable') {
    vesselDataCache.acquirable.valid = false;
  }
  if (type === 'all' || type === 'owned') {
    vesselDataCache.owned.valid = false;
  }
}

/**
 * Fetches company name for a user from backend.
 * Backend handles caching, so no frontend cache needed.
 * Falls back to "User {id}" if fetch fails.
 *
 * @param {number|string} userId - User ID to fetch company name for
 * @returns {Promise<string>} Company name or fallback string
 * @example
 * const name = await getCompanyNameCached(123);
 * // => "Acme Shipping Co."
 */
export async function getCompanyNameCached(userId) {
  const userIdInt = parseInt(userId);

  try {
    const response = await fetch(window.apiUrl('/api/company-name'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userIdInt })
    });

    if (!response.ok) throw new Error('Failed to get company name');
    const data = await response.json();
    return data.company_name;
  } catch {
    return `User ${userIdInt}`;
  }
}

/**
 * Fetches the list of all alliance members.
 * Returns empty array if request fails.
 *
 * @returns {Promise<Array<Object>>} Array of alliance member objects
 * @property {number} user_id - Member's user ID
 * @property {string} company_name - Member's company name
 */
export async function fetchAllianceMembers() {
  try {
    const response = await fetch(window.apiUrl('/api/alliance-members'));
    if (!response.ok) throw new Error('Failed to load alliance members');
    const data = await response.json();
    return data.members || [];
  } catch (error) {
    console.error('Error loading alliance members:', error);
    return [];
  }
}

/**
 * Fetches the alliance chat feed including both chat messages and system feed events.
 *
 * @returns {Promise<Object>} Chat data object
 * @property {Array<Object>} feed - Array of chat/feed events
 * @property {number} own_user_id - Current user's ID
 * @property {string} own_company_name - Current user's company name
 * @throws {Error} If fetch fails
 */
export async function fetchChat() {
  try {
    const response = await fetch(window.apiUrl('/api/chat'));
    if (!response.ok) throw new Error('Failed to load chat feed');
    return await response.json();
  } catch (error) {
    console.error('Error loading messages:', error);
    throw error;
  }
}

/**
 * Sends a message to the alliance chat.
 * Message must be valid according to game rules (length, content).
 *
 * @param {string} message - Message text to send
 * @returns {Promise<Object>} Response data from server
 * @property {boolean} success - Whether message was sent successfully
 * @throws {Error} If message sending fails or validation fails
 */
export async function sendChatMessage(message) {
  try {
    const response = await fetch(window.apiUrl('/api/send-message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches all vessels owned by the current user.
 * Includes vessels in harbor, at sea, and pending delivery.
 *
 * @returns {Promise<Object>} Vessel data object
 * @property {Array<Object>} vessels - Array of vessel objects
 * @property {Object} vessels[].vessel_id - Unique vessel ID
 * @property {string} vessels[].name - Vessel name
 * @property {string} vessels[].status - Status (harbor/at_sea/pending)
 * @property {number} vessels[].wear - Wear percentage (0-100)
 * @throws {Error} If fetch fails
 */
export async function fetchVessels(useCache = true) {
  // Return cached data if valid
  if (useCache && vesselDataCache.owned.valid && vesselDataCache.owned.data) {
    if (window.DEBUG_MODE) {
      console.log('[API Cache] fetchVessels - returning from cache');
    }
    return vesselDataCache.owned.data;
  }

  if (window.DEBUG_MODE) {
    console.log('[API Cache] fetchVessels - cache miss, fetching from API (valid:', vesselDataCache.owned.valid, ', hasData:', !!vesselDataCache.owned.data, ')');
  }

  try {
    const response = await fetch(window.apiUrl('/api/vessel/get-vessels'));
    if (!response.ok) throw new Error('Failed to get vessels');
    const data = await response.json();

    // Update cache
    vesselDataCache.owned.data = data;
    vesselDataCache.owned.valid = true;

    if (window.DEBUG_MODE) {
      console.log('[API Cache] fetchVessels - cached', data.vessels?.length || 0, 'vessels');
    }

    return data;
  } catch (error) {
    console.error('Error fetching vessels:', error);
    throw error;
  }
}

/**
 * Fetches current user settings and account information.
 *
 * @returns {Promise<Object>} User settings object
 * @property {number} user_id - User ID
 * @property {string} company_name - Company name
 * @property {number} cash - Current cash balance
 * @throws {Error} If fetch fails
 */
export async function fetchUserSettings() {
  try {
    const response = await fetch(window.apiUrl('/api/user/get-settings'));
    if (!response.ok) throw new Error('Failed to get user settings');
    return await response.json();
  } catch (error) {
    console.error('Error fetching user settings:', error);
    throw error;
  }
}

/**
 * Fetches current bunker fuel and CO2 prices.
 * Prices fluctuate based on game economy and are updated every 30-35 seconds.
 *
 * @returns {Promise<Object>} Bunker prices and status
 * @property {number} fuel_price - Current fuel price per ton
 * @property {number} co2_price - Current CO2 price per ton
 * @property {number} current_fuel - Current fuel in bunker
 * @property {number} max_fuel - Maximum fuel capacity
 * @property {number} current_co2 - Current CO2 in bunker
 * @property {number} max_co2 - Maximum CO2 capacity
 * @property {number} current_cash - Current cash balance
 * @throws {Error} If fetch fails
 */
export async function fetchBunkerPrices() {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/get-prices'));
    if (!response.ok) throw new Error('Failed to get bunker prices');
    return await response.json();
  } catch (error) {
    console.error('Error fetching bunker prices:', error);
    throw error;
  }
}

/**
 * Purchases fuel for the bunker.
 * Amount is multiplied by 1000 before sending (API expects millitons).
 *
 * @param {number} amount - Amount of fuel to purchase in tons
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If purchase fails (insufficient funds, invalid amount)
 */
export async function purchaseFuel(amount) {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/purchase-fuel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount) })  // Send amount in tons, server converts to kg
    });

    const data = await response.json();

    // Check for errors - don't hide them behind success!
    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMsg);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Purchases CO2 credits for the bunker.
 * Amount is multiplied by 1000 before sending (API expects millitons).
 *
 * @param {number} amount - Amount of CO2 to purchase in tons
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If purchase fails (insufficient funds, invalid amount)
 */
export async function purchaseCO2(amount) {
  try {
    const response = await fetch(window.apiUrl('/api/bunker/purchase-co2'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount) })  // Send amount in tons, server converts to kg
    });

    const data = await response.json();

    // Check for errors - don't hide them behind success!
    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMsg);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Universal depart function - departs vessels using autopilot logic.
 * Can depart ALL vessels or specific vessels by ID.
 *
 * @param {Array<number>} [vesselIds=null] - Optional array of vessel IDs. If omitted, departs ALL vessels in harbor.
 * @returns {Promise<Object>} Departure result
 * @property {boolean} success - Whether departure was triggered
 * @property {string} message - Status message
 * @throws {Error} If request fails
 *
 * @example
 * // Depart all vessels in harbor
 * await departVessels();
 *
 * @example
 * // Depart specific vessels
 * await departVessels([123, 456, 789]);
 */
export async function departVessels(vesselIds = null) {
  try {
    const body = vesselIds ? { vessel_ids: vesselIds } : {};

    const response = await fetch(window.apiUrl('/api/route/depart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error('Failed to depart vessels');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Departs all vessels currently in harbor (backwards compatibility wrapper).
 * Uses the universal departVessels() function with no vessel IDs.
 *
 * @returns {Promise<Object>} Departure result
 * @throws {Error} If request fails
 */
export async function departAllVessels() {
  return await departVessels(null);
}

/**
 * Fetches the user's contact list.
 * Returns both regular contacts and alliance contacts.
 *
 * @returns {Promise<Object>} Contact data
 * @property {Array<Object>} contacts - Regular contacts
 * @property {Array<Object>} alliance_contacts - Alliance member contacts
 * @throws {Error} If fetch fails
 */
export async function fetchContacts() {
  try {
    const response = await fetch(window.apiUrl('/api/contact/get-contacts'));
    if (!response.ok) throw new Error('Failed to get contacts');
    return await response.json();
  } catch (error) {
    console.error('Error loading contact list:', error);
    throw error;
  }
}

/**
 * Search for users by company name.
 * Returns array of matching users with IDs and company names.
 *
 * @param {string} name - Search term (partial match)
 * @returns {Promise<Object>} Search results
 * @property {Array<Object>} data.companies - Array of matching companies
 * @property {Object} user - Current user data
 * @throws {Error} If fetch fails
 */
export async function searchUsers(name) {
  try {
    const response = await fetch(window.apiUrl('/api/user/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if (!response.ok) throw new Error('Failed to search users');
    return await response.json();
  } catch (error) {
    console.error('Error searching users:', error);
    throw error;
  }
}

/**
 * Fetches all messenger chats for the current user.
 * Includes both regular chats and system messages.
 *
 * @returns {Promise<Object>} Messenger data
 * @property {Array<Object>} chats - Array of chat conversations
 * @property {number} own_user_id - Current user's ID
 * @property {string} own_company_name - Current user's company name
 * @throws {Error} If fetch fails
 */
export async function fetchMessengerChats() {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/get-chats'));
    if (!response.ok) throw new Error('Failed to get chats');
    return await response.json();
  } catch (error) {
    console.error('Error getting chats:', error);
    throw error;
  }
}

/**
 * Fetches all messages for a specific chat conversation.
 *
 * @param {number} chatId - Chat ID to fetch messages for
 * @returns {Promise<Object>} Messages data
 * @property {Array<Object>} messages - Array of message objects
 * @throws {Error} If fetch fails
 */
export async function fetchMessengerMessages(chatId) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/get-messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId })
    });

    if (!response.ok) throw new Error('Failed to load messages');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Sends a private message to another user.
 * Creates a new chat or continues existing conversation.
 *
 * @param {number} targetUserId - Recipient's user ID
 * @param {string} subject - Message subject (only for new chats)
 * @param {string} message - Message content
 * @returns {Promise<Object>} Send result
 * @property {boolean} success - Whether message was sent
 * @throws {Error} If send fails or validation fails
 */
export async function sendPrivateMessage(targetUserId, subject, message) {
  if (window.DEBUG_MODE) {
    console.log('[API DEBUG] sendPrivateMessage called with:');
    console.log('  targetUserId:', targetUserId, 'type:', typeof targetUserId);
    console.log('  subject:', subject);
    console.log('  message:', message);
  }

  const payload = {
    target_user_id: targetUserId,
    subject: subject,
    message: message
  };

  if (window.DEBUG_MODE) {
    console.log('[API DEBUG] Payload to send:', JSON.stringify(payload, null, 2));
  }

  try {
    const response = await fetch(window.apiUrl('/api/messenger/send-private'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Response status:', response.status, response.statusText);
    }

    if (!response.ok) {
      const error = await response.json();
      if (window.DEBUG_MODE) {
        console.log('[API DEBUG] Error response:', error);
      }
      throw new Error(error.error);
    }

    const result = await response.json();
    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Success response:', result);
    }
    return result;
  } catch (error) {
    if (window.DEBUG_MODE) {
      console.log('[API DEBUG] Exception caught:', error.message);
    }
    throw error;
  }
}

/**
 * Marks a chat conversation or system message as read.
 * System messages and regular chats are handled differently by the API.
 *
 * @param {number} chatId - Chat ID to mark as read
 * @param {boolean} [isSystemChat=false] - Whether this is a system message
 * @returns {Promise<Object>} Mark-as-read result
 * @property {boolean} success - Whether marking as read was successful
 * @throws {Error} If marking as read fails
 */
export async function markChatAsRead(chatId, isSystemChat = false) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/mark-as-read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_ids: isSystemChat ? '[]' : `[${chatId}]`,
        system_message_ids: isSystemChat ? `[${chatId}]` : '[]'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to mark chat as read');
    }

    return await response.json();
  } catch (error) {
    console.error('[API] Mark as read error:', error);
    throw error;
  }
}

/**
 * Deletes a chat conversation or system message.
 * System messages and regular chats are handled differently by the API.
 *
 * @param {number} chatId - Chat ID to delete
 * @param {boolean} [isSystemChat=false] - Whether this is a system message
 * @param {number} [caseId=null] - Hijacking case ID (for hijacking messages)
 * @returns {Promise<Object>} Deletion result
 * @property {boolean} success - Whether deletion was successful
 * @throws {Error} If deletion fails
 */
export async function deleteChat(chatId, isSystemChat = false, caseId = null) {
  try {
    const response = await fetch(window.apiUrl('/api/messenger/delete-chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_ids: isSystemChat ? '[]' : `[${chatId}]`,
        system_message_ids: isSystemChat ? `[${chatId}]` : '[]',
        case_id: caseId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete chat');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches available marketing campaigns and currently active campaigns.
 * Campaigns provide temporary bonuses (reputation, awareness, green).
 *
 * @returns {Promise<Object>} Campaign data
 * @property {Object} data - Campaign data
 * @property {Array<Object>} data.marketing_campaigns - All available campaigns
 * @property {Array<Object>} data.active_campaigns - Currently active campaigns
 * @property {Object} user - User data including reputation
 * @throws {Error} If fetch fails
 */
export async function fetchCampaigns() {
  try {
    const response = await fetch(window.apiUrl('/api/marketing/get-campaigns'));
    if (!response.ok) throw new Error('Failed to fetch campaigns');
    return await response.json();
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    throw error;
  }
}

/**
 * Activates a marketing campaign by purchasing it.
 * Only 3 campaigns can be active simultaneously (one of each type).
 *
 * @param {number} campaignId - Campaign ID to activate
 * @returns {Promise<Object>} Activation result
 * @property {boolean} success - Whether activation was successful
 * @property {number} new_balance - New cash balance after purchase
 * @throws {Error} If activation fails (insufficient funds, already active)
 */
export async function activateCampaign(campaignId) {
  try {
    console.log(`[API] activateCampaign REQUEST: campaign_id=${campaignId}`);

    const response = await fetch(window.apiUrl('/api/marketing/activate-campaign'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId })
    });

    console.log(`[API] activateCampaign RESPONSE: status=${response.status} ${response.statusText}`);

    const data = await response.json();
    console.log(`[API] activateCampaign RESPONSE body:`, JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error(`[API] activateCampaign FAILED: HTTP ${response.status}`, data);
      throw new Error('Failed to activate campaign');
    }

    return data;
  } catch (error) {
    console.error('[API] Error activating campaign:', error);
    throw error;
  }
}

/**
 * Fetches all vessels available for purchase in the market.
 * Includes vessel specifications, prices, and engine types.
 *
 * @returns {Promise<Object>} Available vessels data
 * @property {Array<Object>} vessels - Array of purchasable vessels
 * @throws {Error} If fetch fails
 */
export async function fetchAcquirableVessels(useCache = true) {
  // Return cached data if valid
  if (useCache && vesselDataCache.acquirable.valid && vesselDataCache.acquirable.data) {
    return vesselDataCache.acquirable.data;
  }

  try {
    const response = await fetch(window.apiUrl('/api/vessel/get-all-acquirable'));
    if (!response.ok) throw new Error('Failed to load vessels');
    const data = await response.json();

    // Update cache
    vesselDataCache.acquirable.data = data;
    vesselDataCache.acquirable.valid = true;

    return data;
  } catch (error) {
    console.error('Error loading vessels:', error);
    throw error;
  }
}

/**
 * Purchases a vessel from the market.
 * User provides name and antifouling choice during purchase.
 *
 * @param {number} vesselId - Vessel ID to purchase
 * @param {string} name - Custom name for the vessel
 * @param {string} antifouling - Antifouling model choice
 * @returns {Promise<Object>} Purchase result
 * @property {boolean} success - Whether purchase was successful
 * @property {number} new_balance - New cash balance
 * @throws {Error} If purchase fails (insufficient funds, invalid name)
 */
export async function purchaseVessel(vesselId, name, antifouling, silent = false) {
  try {
    const response = await fetch(window.apiUrl('/api/vessel/purchase-vessel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vessel_id: vesselId,
        name: name,
        antifouling_model: antifouling,
        silent: silent
      })
    });

    const result = await response.json();

    // Invalidate vessel cache after successful purchase
    if (result.success || response.ok) {
      invalidateVesselCache('owned');
    }

    return result;
  } catch (error) {
    throw error;
  }
}

/**
 * Gets the total maintenance cost for specified vessels.
 * Used before performing bulk repair to show cost to user.
 *
 * @param {Array<number>} vesselIds - Array of vessel IDs to check cost for
 * @returns {Promise<Object>} Cost data
 * @property {number} total_cost - Total repair cost
 * @throws {Error} If request fails
 */
export async function getMaintenanceCost(vesselIds) {
  try {
    const response = await fetch(window.apiUrl('/api/maintenance/get'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
    });

    if (!response.ok) throw new Error('Failed to get repair cost');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Performs wear maintenance (repair) on multiple vessels at once.
 * Used by auto-repair feature and manual bulk repair button.
 *
 * @param {Array<number>} vesselIds - Array of vessel IDs to repair
 * @returns {Promise<Object>} Repair result
 * @property {number} repaired - Number of vessels repaired
 * @property {number} cost - Total cost of repairs
 * @throws {Error} If repair fails (insufficient funds)
 */
export async function doWearMaintenanceBulk(vesselIds) {
  try {
    const response = await fetch(window.apiUrl('/api/maintenance/do-wear-maintenance-bulk'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
    });

    if (!response.ok) throw new Error('Failed to repair vessels');
    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Departs a single vessel on its assigned route.
 * Used by intelligent auto-depart to send only profitable vessels.
 *
 * @param {number} vesselId - Vessel ID to depart
 * @param {number} speed - Speed to travel at (usually % of max_speed)
 * @param {number} [guards=0] - Number of guards (0 or 10 based on hijacking_risk)
 * @returns {Promise<Object>} Departure result
 * @property {boolean} success - Whether vessel was departed successfully
 * @throws {Error} If departure fails (no route, insufficient fuel)
 */
export async function departVessel(vesselId, speed, guards = 0) {
  try {
    const response = await fetch(window.apiUrl('/api/route/depart'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_vessel_id: vesselId,
        speed: speed,
        guards: guards,
        history: 0
      })
    });

    if (!response.ok) {
      throw new Error('Failed to depart vessel');
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

/**
 * Fetches demand and consumed data for all assigned ports.
 * Used by intelligent auto-depart to calculate remaining port capacity.
 *
 * @returns {Promise<Array<Object>>} Array of port objects with demand/consumed data
 * @property {string} code - Port code (e.g., "BOS")
 * @property {Object} demand - Port demand for container and tanker cargo
 * @property {Object} consumed - Amount already delivered to port
 * @throws {Error} If fetch fails
 */
export async function fetchAssignedPorts() {
  try {
    const response = await fetch(window.apiUrl('/api/port/get-assigned-ports'));
    if (!response.ok) throw new Error('Failed to fetch assigned ports');
    const data = await response.json();
    return data.data?.ports || [];
  } catch (error) {
    console.error('Error fetching assigned ports:', error);
    throw error;
  }
}

/**
 * Fetches user company data including fuel and CO2 capacity.
 * Used to get actual capacity values from API instead of hardcoding.
 *
 * @returns {Promise<Object>} User company data
 * @property {number} fuel_capacity - Max fuel capacity in kg
 * @property {number} co2_capacity - Max CO2 capacity in kg
 * @throws {Error} If fetch fails
 */
export async function fetchUserCompany() {
  try {
    const response = await fetch(window.apiUrl('/api/user/get-company'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to fetch user company');
    const data = await response.json();
    // Return both data.data.company and data.user for full access to all properties
    return { company: data.data?.company || {}, user: data.user || {} };
  } catch (error) {
    console.error('Error fetching user company:', error);
    throw error;
  }
}

/**
 * Fetches autopilot log entries with optional filters
 *
 * @param {Object} filters - Filter options
 * @param {string} filters.status - "SUCCESS", "ERROR", or "ALL"
 * @param {string} filters.timeRange - "today", "yesterday", "48h", or "all"
 * @param {string} filters.search - Search term for autopilot name or summary
 * @returns {Promise<Object>} Log entries data
 * @throws {Error} If fetch fails
 */
export async function fetchLogbookEntries(filters = {}) {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/get-logs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters)
    });
    if (!response.ok) throw new Error('Failed to fetch log entries');
    return await response.json();
  } catch (error) {
    console.error('Error fetching log entries:', error);
    throw error;
  }
}

/**
 * Downloads autopilot logs in specified format
 *
 * @param {string} format - "txt", "csv", or "json"
 * @param {Object} filters - Same filters as fetchLogbookEntries
 * @returns {Promise<string>} File content as text
 * @throws {Error} If download fails
 */
export async function downloadLogbookExport(format, filters = {}) {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, ...filters })
    });
    if (!response.ok) throw new Error('Failed to download logs');
    return await response.text();
  } catch (error) {
    console.error('Error downloading logs:', error);
    throw error;
  }
}

/**
 * Deletes all autopilot logs for the current user
 *
 * @returns {Promise<Object>} Success response
 * @throws {Error} If deletion fails
 */
export async function deleteAllLogs() {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/delete-all'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to delete logs');
    return await response.json();
  } catch (error) {
    console.error('Error deleting logs:', error);
    throw error;
  }
}

/**
 * Fetches current log file size
 *
 * @returns {Promise<Object>} File size data
 * @property {number} bytes - Size in bytes
 * @property {string} formatted - Human-readable size (e.g., "2.4 MB")
 * @throws {Error} If fetch fails
 */
export async function fetchLogbookFileSize() {
  try {
    const response = await fetch(window.apiUrl('/api/logbook/file-size'));
    if (!response.ok) throw new Error('Failed to fetch file size');
    return await response.json();
  } catch (error) {
    console.error('Error fetching file size:', error);
    throw error;
  }
}
