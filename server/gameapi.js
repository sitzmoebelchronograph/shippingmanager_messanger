/**
 * @fileoverview Game API Client
 *
 * Centralized module for all API calls to the Shipping Manager game server.
 * Provides clean interface for autopilot features to interact with game API.
 *
 * All functions use the apiCall helper from utils/api which handles:
 * - Session cookie authentication
 * - Connection pooling (Keep-Alive)
 * - Error handling
 * - Request timeouts
 *
 * Used exclusively by server/autopilot.js for automated actions.
 * Manual user actions still use routes in server/routes/game.js
 *
 * @module server/gameapi
 */

const { apiCall, getUserId } = require('./utils/api');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const cache = require('./cache');

// Harbor fee bug logs directory - use APPDATA when running as .exe
const { getAppDataDir } = require('./config');
const HARBOR_FEE_BUG_DIR = process.pkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'logs', 'harborfeebug')
  : path.join(__dirname, '..', 'userdata', 'logs', 'harborfeebug');

// Known harbor fee bugs file (for game developers)
const HARBOR_BUGS_FILE = process.pkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'logs', 'known-harbor-fee-bugs.json')
  : path.join(__dirname, '..', 'userdata', 'logs', 'known-harbor-fee-bugs.json');

// Bunker price bug logs directory
const BUNKER_PRICE_BUG_DIR = process.pkg
  ? path.join(getAppDataDir(), 'ShippingManagerCoPilot', 'userdata', 'logs', 'bunkerpricebug')
  : path.join(__dirname, '..', 'userdata', 'logs', 'bunkerpricebug');

/**
 * Fetches current market prices for fuel and CO2.
 * Called by scheduler at :01 and :31 every hour.
 *
 * IMPORTANT API QUIRKS:
 * - Game updates prices at :01 and :31 past the hour (server local time)
 * - Prices are in $/ton
 * - Response includes ALL 48 price intervals for current day
 * - Current price must be matched by time slot (HH:00 or HH:30)
 * - Time slots use LOCAL server time, NOT UTC
 *
 * Why This Timing Matters:
 * - Scheduler calls at :02 and :32 to ensure fresh prices are available
 * - Calling at :00 or :30 risks getting stale prices (race condition)
 * - 29-minute purchase window at each price point
 *
 * @async
 * @returns {Promise<{fuel: number, co2: number}>} Current prices in $/ton
 * @throws {Error} If API returns malformed data or network error
 */
async function fetchPrices() {
  const data = await apiCall('/bunker/get-prices', 'POST', {});

  // API returns array of prices with timestamps
  // Structure: { data: { prices: [{fuel_price, co2_price, time, day}, ...] }, user: {...} }

  if (!data.data || !data.data.prices || data.data.prices.length === 0) {
    throw new Error('No prices found in API response');
  }

  const prices = data.data.prices;

  // API time slots are in UTC
  // Get current UTC time to find matching price
  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();

  // Between 00:00:00 and 00:29:59 UTC → search for "00:00"
  // Between 00:30:00 and 00:59:59 UTC → search for "00:30"
  const currentTime = `${String(utcHours).padStart(2, '0')}:${utcMinutes < 30 ? '00' : '30'}`;

  logger.debug(`[GameAPI] Searching for UTC time slot "${currentTime}" at ${now.toISOString()}`);
  logger.debug(`[GameAPI] Available time slots:`, prices.map(p => p.time).join(', '));

  // Find price matching current UTC time slot
  let currentPrice = prices.find(p => p.time === currentTime);

  // Check for event discounts
  const eventFuelDiscount = data.data.event_fuel_discount || null;
  const eventCO2Discount = data.data.event_co2_discount || null;
  const discountedFuel = data.data.discounted_fuel || null;
  const discountedCO2 = data.data.discounted_co2 || null;

  // Build eventDiscount object for compatibility
  let eventDiscount = null;
  if (eventFuelDiscount && discountedFuel) {
    eventDiscount = { percentage: eventFuelDiscount, type: 'fuel' };
  } else if (eventCO2Discount && discountedCO2) {
    eventDiscount = { percentage: eventCO2Discount, type: 'co2' };
  }

  // NO FALLBACK - If time slot not found and no event prices, THROW ERROR
  if (!currentPrice && (discountedFuel === null || discountedCO2 === null)) {
    logger.error(`[GameAPI] CRITICAL: Time slot not found in API response`);
    logger.error(`  Searched for: "${currentTime}"`);
    logger.error(`  Current time: ${now.toISOString()} (UTC: ${utcHours}:${utcMinutes})`);
    logger.error(`  Available slots: ${prices.map(p => p.time).join(', ')}`);
    logger.error(`  Event discounts: fuel=${discountedFuel}, co2=${discountedCO2}`);

    // Save full raw response to file for debugging
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `price-response-MISSING-${currentTime.replace(':', '-')}-${timestamp}.json`;
    const filepath = path.join(BUNKER_PRICE_BUG_DIR, filename);

    try {
      fs.mkdirSync(BUNKER_PRICE_BUG_DIR, { recursive: true });
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      logger.error(`  Raw API response saved to: ${filepath}`);
    } catch (err) {
      logger.error(`  Failed to save response file: ${err.message}`);
    }

    throw new Error(`Time slot "${currentTime}" not found in API response. Expected this slot to exist. Response saved to ${filepath}`);
  }

  // Use discounted prices if available, otherwise use matched price
  const finalFuelPrice = discountedFuel !== null ? discountedFuel : currentPrice.fuel_price;
  const finalCO2Price = discountedCO2 !== null ? discountedCO2 : currentPrice.co2_price;

  // CRITICAL VALIDATION: If API returns invalid prices (0, null, undefined), throw error
  // This prevents broadcasting invalid prices to clients
  if (!finalFuelPrice || finalFuelPrice <= 0) {
    logger.error(`[GameAPI] API returned INVALID fuel price: ${finalFuelPrice} (discounted: ${discountedFuel}, regular: ${currentPrice.fuel_price})`);
    throw new Error(`Invalid fuel price from API: ${finalFuelPrice}`);
  }
  if (!finalCO2Price || finalCO2Price <= 0) {
    logger.error(`[GameAPI] API returned INVALID CO2 price: ${finalCO2Price} (discounted: ${discountedCO2}, regular: ${currentPrice.co2_price})`);
    throw new Error(`Invalid CO2 price from API: ${finalCO2Price}`);
  }

  if (eventDiscount) {
    logger.debug(`[GameAPI] EVENT ACTIVE: ${eventDiscount.percentage}% off ${eventDiscount.type}`);
    logger.debug(`[GameAPI] Current prices (${currentPrice.time}): Fuel=$${finalFuelPrice}/t${discountedFuel ? ` (was $${currentPrice.fuel_price})` : ''}, CO2=$${finalCO2Price}/t${discountedCO2 ? ` (was $${currentPrice.co2_price})` : ''}`);
  } else {
    logger.debug(`[GameAPI] Current prices (${currentPrice.time}): Fuel=$${finalFuelPrice}/t, CO2=$${finalCO2Price}/t`);
  }

  // Fetch full event data if there's an active event
  let eventData = null;
  if (eventDiscount) {
    try {
      eventData = await fetchEventData();
    } catch (error) {
      logger.warn('[GameAPI] Failed to fetch event data:', error.message);
    }
  }

  return {
    fuel: finalFuelPrice,
    co2: finalCO2Price,
    eventDiscount: eventDiscount,
    eventData: eventData, // Full event with time_start, time_end, etc.
    regularFuel: currentPrice.fuel_price,
    regularCO2: currentPrice.co2_price
  };
}

/**
 * Fetches current bunker state (fuel, CO2, cash, capacity).
 * Used by auto-rebuy to check if purchase is needed.
 *
 * CRITICAL API QUIRK:
 * - /bunker/get-prices does NOT return capacity fields (max_fuel, max_co2)
 * - Must use /game/index endpoint which includes user_settings.max_fuel/.max_co2
 * - This is why we can't use /bunker/get-prices for bunker state
 *
 * Unit Conversions:
 * - API stores values in kilograms (kg)
 * - We convert to tons (t) for readability: 1t = 1000kg
 * - All internal logic uses tons, only API calls use kg
 *
 * @async
 * @returns {Promise<Object>} Bunker state with fuel, co2, cash, maxFuel, maxCO2 (all in tons except cash)
 * @throws {Error} If user_settings or capacity fields missing
 */
async function fetchBunkerState() {
  const data = await apiCall('/game/index', 'POST', {});
  const user = data.user;
  const settings = data.data.user_settings;

  if (!user) {
    logger.error('[GameAPI] ERROR: user object missing from API response!');
    throw new Error('user object missing from API');
  }

  if (!settings || !settings.max_fuel || !settings.max_co2) {
    logger.error('[GameAPI] ERROR: user_settings or capacity fields missing from API response!');
    throw new Error('user_settings or capacity fields missing from API');
  }

  const bunkerState = {
    fuel: user.fuel / 1000, // Convert kg to tons
    co2: user.co2 / 1000,
    cash: user.cash,
    points: user.points,
    maxFuel: settings.max_fuel / 1000,
    maxCO2: settings.max_co2 / 1000
  };

  logger.debug(`[GameAPI] Bunker state: Fuel=${bunkerState.fuel.toFixed(1)}t/${bunkerState.maxFuel.toFixed(0)}t, CO2=${bunkerState.co2.toFixed(1)}t/${bunkerState.maxCO2.toFixed(0)}t, Cash=$${bunkerState.cash}, Points=${bunkerState.points}`);

  return bunkerState;
}

/**
 * Purchases specified amount of fuel.
 * Used by auto-rebuy feature.
 *
 * API Quirks:
 * - API expects amount in kilograms (kg), not tons
 * - This function accepts tons and converts to kg internally (amount * 1000)
 * - Response does NOT include updated capacity fields (max_fuel, max_co2)
 * - Response does NOT include purchase cost - we calculate it ourselves
 * - Purchase is INSTANT (no delay/cooldown in game API)
 *
 * Why Unit Conversion:
 * - Game UI displays tons (more readable: "500t" vs "500000kg")
 * - API internally uses kg for precision
 * - Conversion factor: 1 ton = 1000 kg (always integer math)
 *
 * @async
 * @param {number} amount - Amount in tons (integer)
 * @param {number|null} [pricePerTon=null] - Optional price override, fetches from state if null
 * @returns {Promise<Object>} Purchase result: {success, amount, newTotal, cost}
 * @throws {Error} If API call fails
 */
async function purchaseFuel(amount, pricePerTon = null, userId = null) {
  // API expects amount in kg, we work in tons - convert tons to kg
  const amountInKg = amount * 1000;

  logger.debug(`[GameAPI] purchaseFuel REQUEST: Sending ${amount}t (${amountInKg}kg) to API`);
  logger.debug(`[GameAPI] purchaseFuel REQUEST body:`, JSON.stringify({ amount: amountInKg }, null, 2));

  const data = await apiCall('/bunker/purchase-fuel', 'POST', { amount: amountInKg });

  logger.debug(`[GameAPI] purchaseFuel RESPONSE:`, JSON.stringify(data, null, 2));

  // Check if purchase was successful
  if (data.error || data.success === false) {
    const errorMsg = data.error || 'Purchase failed';
    if (data.user && data.user.cash !== undefined) {
      logger.info(`[GameAPI] Purchase FAILED with error "${errorMsg}" - API reports current cash: $${data.user.cash.toLocaleString()}`);
    }
    throw new Error(errorMsg);
  }

  // Calculate cost ourselves since API doesn't return it
  // If price not provided, get it from state
  let cost = 0;
  if (pricePerTon) {
    cost = amount * pricePerTon;
  } else {
    const state = require('./state');
    const actualUserId = userId || getUserId();
    const prices = state.getPrices(actualUserId);
    cost = amount * prices.fuel;
  }

  const result = {
    success: true,
    amount: amount, // Return amount in tons
    newTotal: data.user.fuel / 1000, // kg to tons
    cost: cost
  };
  logger.debug(`[GameAPI] Purchased ${amount}t fuel for $${result.cost}, new total: ${result.newTotal.toFixed(1)}t`);
  return result;
}

/**
 * Purchases specified amount of CO2 certificates.
 * Used by auto-rebuy feature.
 *
 * API Quirks:
 * - Same quirks as purchaseFuel (see above)
 * - API field name is 'co2' OR 'co2_certificate' depending on endpoint
 * - Always check both fields: data.user.co2 || data.user.co2_certificate
 *
 * @async
 * @param {number} amount - Amount in tons (integer)
 * @param {number|null} [pricePerTon=null] - Optional price override, fetches from state if null
 * @returns {Promise<Object>} Purchase result: {success, amount, newTotal, cost}
 * @throws {Error} If API call fails
 */
async function purchaseCO2(amount, pricePerTon = null, userId = null) {
  // API expects amount in kg, we work in tons - convert tons to kg
  const amountInKg = amount * 1000;
  const data = await apiCall('/bunker/purchase-co2', 'POST', { amount: amountInKg });

  logger.debug(`[GameAPI] purchaseCO2 API response:`, JSON.stringify(data, null, 2));

  // Check if purchase was successful
  if (data.error || data.success === false) {
    throw new Error(data.error || 'Purchase failed');
  }

  // Calculate cost ourselves since API doesn't return it
  // If price not provided, get it from state
  let cost = 0;
  if (pricePerTon) {
    cost = amount * pricePerTon;
  } else {
    const state = require('./state');
    const actualUserId = userId || getUserId();
    const prices = state.getPrices(actualUserId);
    cost = amount * prices.co2;
  }

  const result = {
    success: true,
    amount: amount, // Return amount in tons
    newTotal: (data.user.co2 || data.user.co2_certificate) / 1000, // kg to tons
    cost: cost
  };
  logger.debug(`[GameAPI] Purchased ${amount}t CO2 for $${result.cost}, new total: ${result.newTotal.toFixed(1)}t`);
  return result;
}

/**
 * Fetches all vessels currently in harbor.
 * Used by auto-depart to determine which vessels to send.
 *
 * Returns:
 * - Only vessels with status 'in_harbor' or 'ready'
 * - Includes vessel specs, assigned routes, cargo capacity, wear level
 * - Does NOT include historical voyage data (use /vessel/get-vessel-history)
 *
 * @async
 * @returns {Promise<Array<Object>>} Array of vessel objects
 * @throws {Error} If API call fails
 */
async function fetchVessels() {
  const data = await apiCall('/game/index', 'POST', {});
  return data.data.user_vessels;
}

/**
 * Departs a single vessel on its assigned route.
 * Used by intelligent auto-depart feature.
 *
 * CRITICAL API BEHAVIORS:
 * - Vessel must have assigned route (route_id) and valid price-per-TEU (> 0)
 * - API returns depart_income as NET income (after harbor fees already deducted)
 * - Harbor fee calculation bug exists at some ports (fee > income, resulting in negative profit)
 * - API error "Vessel not found or status invalid" = vessel already departed (race condition)
 *
 * Error Handling Strategy:
 * - Always pass through ACTUAL error message from API (don't mask it)
 * - "Vessel not found" is OK during auto-depart (vessel departed between checks)
 * - Negative netIncome triggers debug logging + saves raw API response to file
 *
 * Parameters:
 * - speed: Vessel's cruising speed in knots (from vessel specs)
 * - guards: 0 or 10 (game mechanic for piracy protection)
 * - history: Always 0 (don't add to history - undocumented API parameter)
 *
 * @async
 * @param {number} vesselId - User vessel ID
 * @param {number} speed - Travel speed in knots
 * @param {number} [guards=0] - Number of guards (0 or 10)
 * @returns {Promise<Object>} Departure result: {success, vesselId, income, netIncome, fuelUsed, ...}
 * @throws {Error} Only on network/critical failures (not on game logic errors)
 */
async function departVessel(vesselId, speed, guards = 0) {
  const data = await apiCall('/route/depart', 'POST', {
    user_vessel_id: vesselId,
    speed: speed,
    guards: guards,
    history: 0
  });

  // Check if API returned an error
  if (!data.data || !data.data.depart_info) {
    // IMPORTANT: Always pass through the ACTUAL error message from the API
    const actualError = data.error || 'Unknown error';

    logger.debug(`[GameAPI] Depart failed for vessel ${vesselId} - Error: "${actualError}"`);

    // Special case: Vessel already departed (race condition)
    if (actualError === 'Vessel not found or status invalid') {
      logger.debug(`[GameAPI] Vessel ${vesselId} was already departed (race condition - ignoring)`);
    }

    return {
      success: false,
      vesselId: vesselId,
      error: actualError,
      errorMessage: actualError,  // Pass through the ACTUAL error
      apiResponse: data
    };
  }

  const departInfo = data.data.depart_info;
  const vesselData = data.data.user_vessels?.[0];

  // depart_income is already NET income (after harbor fees)
  // Do NOT subtract harbor_fee again - that would be double-deduction
  const income = departInfo.depart_income;

  // Track high harbor fee issues (for profitability warnings)
  const profitCheck = departInfo.depart_income - departInfo.harbor_fee;
  if (profitCheck < 0) {
    const destination = vesselData?.route_destination || 'UNKNOWN';

    // Load known bugs list
    let knownBugs = { description: "Known harbors with harbor fee calculation bugs. Collected for game developers.", bugs: {} };
    try {
      if (fs.existsSync(HARBOR_BUGS_FILE)) {
        knownBugs = JSON.parse(fs.readFileSync(HARBOR_BUGS_FILE, 'utf8'));
      }
    } catch (err) {
      logger.debug(`[gameapi.departVessel] Failed to load known bugs file: ${err.message}`);
    }

    // Check if this harbor is already known
    const isKnownBug = knownBugs.bugs[destination] !== undefined;

    if (!isKnownBug) {
      // NEW BUG - Log full details and save to file
      logger.error(`[gameapi.departVessel] HIGH HARBOR FEE detected (NEW HARBOR)!`);
      logger.error(`  Vessel: ${vesselData?.name} (ID: ${vesselId})`);
      logger.error(`  Destination: ${destination}`);
      logger.error(`  Income: $${departInfo.depart_income}`);
      logger.error(`  Harbor Fee: $${departInfo.harbor_fee}`);
      logger.error(`  Profitability: $${profitCheck}`);

      // Save full raw response to file for game developers
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `depart-response-${vesselData?.name || vesselId}-${timestamp}.json`;
      const filepath = path.join(HARBOR_FEE_BUG_DIR, filename);

      try {
        // Ensure harbor fee bug directory exists
        fs.mkdirSync(HARBOR_FEE_BUG_DIR, { recursive: true });
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        logger.error(`  Raw API response saved to: ${filepath}`);
      } catch (err) {
        logger.error(`  Failed to save response file: ${err.message}`);
      }

      // Add to known bugs list
      knownBugs.bugs[destination] = {
        first_seen: new Date().toISOString(),
        vessel_name: vesselData?.name,
        vessel_id: vesselId,
        income: departInfo.depart_income,
        harbor_fee: departInfo.harbor_fee,
        profitability: profitCheck,
        response_file: filepath
      };

      try {
        fs.writeFileSync(HARBOR_BUGS_FILE, JSON.stringify(knownBugs, null, 2));
        logger.error(`  Harbor ${destination} added to known bugs list`);
      } catch (err) {
        logger.error(`  Failed to update known bugs file: ${err.message}`);
      }
    } else {
      // Known bug - just debug log
      logger.debug(`[gameapi.departVessel] High harbor fee at known harbor: ${destination} (Income: $${departInfo.depart_income}, Fee: $${departInfo.harbor_fee}, Profit: $${profitCheck})`);
    }
  }

  // Calculate actual cargo loaded from depart_info
  const teuDry = departInfo.teu_dry || 0;
  const teuRefer = departInfo.teu_refrigerated || 0;
  const fuelCargo = departInfo.fuel || 0;
  const crudeCargo = departInfo.crude_oil || 0;

  // Total cargo depends on vessel type
  const totalCargo = teuDry + teuRefer + fuelCargo + crudeCargo;

  // LOG DEPART_INFO FOR EVERY VESSEL
  logger.debug(`[Depart API Response] Vessel: ${vesselData?.name} (ID: ${vesselId})`);
  logger.debug(`[Depart API Response] depart_info: ${JSON.stringify(departInfo, null, 2)}`);

  return {
    success: true,
    vesselId: vesselId,
    vesselName: vesselData?.name,
    destination: vesselData?.route_destination,
    income: income,
    harborFee: departInfo.harbor_fee,
    netIncome: income, // depart_income is already NET (after fees)
    fuelUsed: departInfo.fuel_usage / 1000, // kg to tons
    co2Used: departInfo.co2_emission / 1000, // kg to tons,
    speed: speed,
    guards: guards,
    // Actual cargo loaded (from API response)
    cargoLoaded: totalCargo,
    teuDry: teuDry,
    teuRefrigerated: teuRefer,
    fuelCargo: fuelCargo,
    crudeCargo: crudeCargo
  };
}

/**
 * Fetches demand and consumed data for all assigned ports.
 * Used by intelligent auto-depart to calculate remaining port capacity.
 *
 * @returns {Promise<Array>} Array of port objects with demand/consumed data
 */
async function fetchAssignedPorts() {
  const data = await apiCall('/port/get-assigned-ports', 'POST', {});
  return data.data.ports;
}

/**
 * Fetches available marketing campaigns and active campaign status.
 * Uses cache to avoid duplicate API calls (campaigns change rarely).
 * Used by auto-campaign-renewal feature.
 *
 * @returns {Promise<Object>} Campaigns data with available and active campaigns
 */
async function fetchCampaigns() {
  try {
    // Check cache first
    const cached = cache.getCampaignCache();
    if (cached) {
      const available = cached.data.marketing_campaigns;
      const active = cached.data.active_campaigns;

      logger.debug(`[GameAPI] Campaigns from cache - Active: ${active.length}, Available: ${available.length}`);

      return {
        available: available,
        active: active
      };
    }

    // Cache miss - fetch from API
    const data = await apiCall('/marketing-campaign/get-marketing', 'POST', {});

    // Store in cache
    cache.setCampaignCache(data);

    const available = data.data.marketing_campaigns;
    const active = data.data.active_campaigns;

    logger.debug(`[GameAPI] Fetched campaigns from API - Active: ${active.length}, Available: ${available.length}`);

    return {
      available: available,
      active: active
    };
  } catch (error) {
    logger.error('[GameAPI] Error fetching campaigns:', error.message);
    return {
      available: [],
      active: []
    };
  }
}

/**
 * Activates a marketing campaign by ID.
 * Used by auto-campaign-renewal feature.
 *
 * @param {number} campaignId - Campaign ID to activate
 * @returns {Promise<Object>} Activation result
 */
async function activateCampaign(campaignId) {
  await apiCall('/marketing-campaign/activate-marketing-campaign', 'POST', {
    campaign_id: campaignId
  });

  // Invalidate campaign cache after activation
  cache.invalidateCampaignCache();

  return {
    success: true,
    campaignId: campaignId
  };
}

/**
 * Calculates maintenance cost for specified vessels.
 * Used by auto-repair feature to check total cost before executing repairs.
 *
 * CRITICAL API QUIRK:
 * - API expects vessel_ids as JSON STRING: "[123,456,789]"
 * - NOT as array: [123,456,789]
 * - Must call JSON.stringify(vesselIds) before sending
 * - This is inconsistent with other endpoints (they accept arrays)
 *
 * Response Structure:
 * - Returns array of vessels with maintenance_data
 * - Each vessel has maintenance_data array with type: 'wear', 'drydock', etc.
 * - API does NOT provide total_cost field - must calculate ourselves
 * - Calculate: sum all vessel.maintenance_data.find(m => m.type === 'wear').price
 *
 * @async
 * @param {Array<number>} vesselIds - Array of vessel IDs
 * @returns {Promise<Object>} {totalCost, vessels} - Calculated total and vessel details
 * @throws {Error} If API call fails
 */
async function getMaintenanceCost(vesselIds) {
  logger.debug(`[GameAPI] Requesting maintenance cost for vessel IDs: [${vesselIds.join(', ')}]`);

  // Frontend sends: JSON.stringify({ vessel_ids: JSON.stringify(vesselIds) })
  // Which results in: { vessel_ids: "[17696320,17696321]" }
  // So we need to send the array as a JSON string
  const vesselIdsString = JSON.stringify(vesselIds);
  logger.debug(`[GameAPI] Sending vessel_ids as JSON string: ${vesselIdsString}`);

  try {
    const data = await apiCall('/maintenance/get', 'POST', { vessel_ids: vesselIdsString });

    if (data.error) {
      logger.error(`[GameAPI] API Error: ${data.error}`);
      return { totalCost: 0, vessels: [] };
    }

    const vessels = data.data?.vessels;

    // Calculate total cost from individual vessel maintenance_data (API doesn't provide total_cost)
    let totalCost = 0;
    vessels.forEach(vessel => {
      const wearMaintenance = vessel.maintenance_data?.find(m => m.type === 'wear');
      if (wearMaintenance) {
        totalCost += wearMaintenance.price;
      }
    });

    logger.debug(`[GameAPI] Calculated total maintenance cost: $${totalCost} for ${vesselIds.length} vessels`);
    return {
      totalCost: totalCost,
      vessels: vessels
    };
  } catch (error) {
    logger.error(`[GameAPI] getMaintenanceCost failed:`, error.message);
    throw error;
  }
}

/**
 * Performs bulk wear maintenance on multiple vessels.
 * Used by auto-repair feature to repair all vessels at once.
 *
 * API Quirks:
 * - Same JSON string requirement as getMaintenanceCost (see above)
 * - Must send: vessel_ids: JSON.stringify([123,456,789])
 * - API DOES return total_cost field (unlike getMaintenanceCost)
 * - Repairs execute instantly (no animation/delay in game)
 * - All repairs succeed or all fail (atomic operation)
 *
 * @async
 * @param {Array<number>} vesselIds - Array of vessel IDs to repair
 * @returns {Promise<Object>} {success, count, totalCost} - Repair result
 * @throws {Error} If API call fails
 */
async function bulkRepairVessels(vesselIds) {
  logger.debug(`[GameAPI] Executing bulk repair for vessel IDs: [${vesselIds.join(', ')}]`);

  // Frontend sends vessel_ids as JSON string: "[17696320,17696321]"
  const vesselIdsString = JSON.stringify(vesselIds);
  logger.debug(`[GameAPI] Sending vessel_ids as JSON string: ${vesselIdsString}`);

  const data = await apiCall('/maintenance/do-wear-maintenance-bulk', 'POST', {
    vessel_ids: vesselIdsString
  });

  if (data.error) {
    logger.error(`[GameAPI] Bulk repair API Error: ${data.error}`);
    return { success: false, count: 0, totalCost: 0 };
  }

  const totalCost = data.data?.total_cost || 0;
  logger.debug(`[GameAPI] Repaired ${vesselIds.length} vessels - API returned cost: $${totalCost}`);

  return {
    success: true,
    count: vesselIds.length,
    totalCost: totalCost
  };
}

/**
 * Fetches count of vessels needing repair.
 * Used by scheduler to update repair badge.
 *
 * @returns {Promise<number>} Count of vessels with wear > 0
 */
async function fetchRepairCount() {
  const data = await apiCall('/game/index', 'POST', {});
  const vessels = data.data.user_vessels;
  return vessels.filter(v => v.wear > 0).length;
}

/**
 * Fetches unread private message count.
 * Used by scheduler to update messages badge.
 *
 * @returns {Promise<number>} Count of unread messages
 */
async function fetchUnreadMessages() {
  try {
    // Use shared cache from websocket.js to reduce duplicate API calls
    const { getCachedMessengerChats } = require('./websocket');
    const chats = await getCachedMessengerChats();

    // Debug: Log all chats with their properties
    logger.debug(`[GameAPI] Total chats: ${chats.length}`);
    chats.forEach((chat, i) => {
      logger.debug(`[GameAPI] Chat ${i}: system_chat=${chat.system_chat}, new=${chat.new}, subject="${chat.subject || 'N/A'}"`);
    });

    // Count ALL chats where new=true (including system messages like hijack notifications)
    const unreadCount = chats.filter(chat => chat.new).length;
    logger.debug(`[GameAPI] Unread messages count (including system): ${unreadCount}`);
    return unreadCount;
  } catch (error) {
    logger.error('[GameAPI] Error fetching unread messages:', error.message);
    return 0;
  }
}

/**
 * Fetches auto-calculated price for a route.
 * Used to check if price-per-TEU is 0 before departure.
 *
 * @param {number} userVesselId - User's vessel ID
 * @param {number} routeId - Route ID
 * @returns {Promise<Object>} Auto-price response with suggested pricing
 */
async function fetchAutoPrice(userVesselId, routeId) {
  try {
    const data = await apiCall('/demand/auto-price', 'POST', {
      user_vessel_id: userVesselId,
      route_id: routeId
    });

    logger.debug(`[GameAPI] Auto-price for vessel ${userVesselId} on route ${routeId}:`, data);

    return data;
  } catch (error) {
    logger.error(`[GameAPI] Error fetching auto-price for vessel ${userVesselId}:`, error.message);
    throw error;
  }
}

/**
 * Fetches active event data from game.
 * Used by scheduler to broadcast complete event information to frontend.
 *
 * Event Structure:
 * - id: Event ID
 * - type: Event type (e.g., "demand_and_discount")
 * - capacity_type: Container or tanker
 * - name: Event name identifier
 * - daily_demand_multiplier: Demand boost (e.g., 50x)
 * - ports: JSON string of port codes (must be parsed)
 * - discount_type: Resource type ("fuel" or "co2")
 * - discount_percentage: Discount amount (e.g., 20)
 * - time_start, time_end, ends_in: Event timing info
 * - header_key, subheader_key, description_key: Localization keys
 *
 * @async
 * @returns {Promise<Object|null>} Event object or null if no active event
 * @throws {Error} If API call fails
 */
async function fetchEventData() {
  const data = await apiCall('/game/index', 'POST', {});

  if (!data.data || !data.data.event || data.data.event.length === 0) {
    logger.debug('[GameAPI] No active events');
    return null;
  }

  const event = data.data.event[0];

  logger.debug(`[GameAPI] Active event: ${event.name} (${event.type})`);
  logger.debug(`[GameAPI] Discount: ${event.discount_percentage}% off ${event.discount_type}`);
  logger.debug(`[GameAPI] Demand multiplier: ${event.daily_demand_multiplier}x`);
  logger.debug(`[GameAPI] Ends in: ${Math.floor(event.ends_in / 3600)}h ${Math.floor((event.ends_in % 3600) / 60)}m`);

  return event;
}

/**
 * Fetches complete game state from /game/index
 * Returns all vessels, ports, and game data
 *
 * @returns {Promise<Object>} Game index data with vessels and ports
 */
async function getGameIndex() {
  return await apiCall('/game/index', 'POST', {});
}

/**
 * Fetches all ports assigned to the user
 * Returns ports with demand data
 *
 * @returns {Promise<Object>} Response with ports array
 */
async function getAssignedPorts() {
  return await apiCall('/port/get-assigned-ports', 'POST', {});
}

/**
 * Fetches reachable ports for a specific vessel
 * Note: Response includes empty demand arrays, must aggregate with game/index
 *
 * @param {number} vesselId - Vessel ID to get reachable ports for
 * @returns {Promise<Object>} Response with ports array
 */
async function getVesselPorts(vesselId) {
  return await apiCall('/route/get-vessel-ports', 'POST', {
    user_vessel_id: vesselId
  });
}

/**
 * Fetches trip history for a specific vessel
 *
 * @param {number} vesselId - Vessel ID to get history for
 * @returns {Promise<Object>} Response with history array
 */
async function getVesselHistory(vesselId) {
  return await apiCall('/vessel/get-vessel-history', 'POST', {
    vessel_id: vesselId
  });
}

/**
 * Fetches all user vessels with complete data
 *
 * @returns {Promise<Object>} Response with vessels array
 */
async function getAllUserVessels() {
  return await apiCall('/vessel/get-all-user-vessels', 'POST', {});
}

module.exports = {
  fetchPrices,
  fetchBunkerState,
  purchaseFuel,
  purchaseCO2,
  fetchVessels,
  departVessel,
  fetchAssignedPorts,
  fetchCampaigns,
  activateCampaign,
  getMaintenanceCost,
  bulkRepairVessels,
  fetchRepairCount,
  fetchUnreadMessages,
  fetchAutoPrice,
  fetchEventData,
  getGameIndex,
  getAssignedPorts,
  getVesselPorts,
  getVesselHistory,
  getAllUserVessels
};
