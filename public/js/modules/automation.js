/**
 * @fileoverview AutoPilot Automation System for Shipping Manager
 *
 * Provides intelligent automation features with anti-detection mechanisms:
 *
 * **Features:**
 * 1. **Auto-Rebuy Fuel** - Monitors fuel prices and automatically purchases when at/below threshold
 * 2. **Auto-Rebuy CO2** - Monitors CO2 prices and automatically purchases when at/below threshold
 * 3. **Auto-Depart All** - Continuously departs all vessels in port when fuel is available
 * 4. **Auto Bulk Repair** - Repairs all vessels with wear > 0 when affordable
 * 5. **Auto Campaign Renewal** - Renews expired campaigns (reputation, awareness, green)
 *
 * **Auto-Rebuy Strategy:**
 * Simple price-driven logic - whenever price is at or below the configured threshold,
 * the system attempts to purchase. Continues buying every 30-35 seconds (when prices
 * update) until bunker is full or funds are depleted. No time windows - purely price-based.
 *
 * **Rate Limiting & Anti-Detection:**
 * - Fuel/CO2 rebuy: Event-driven (triggered by price updates every 30-35s)
 * - Auto-depart checks: Random 1-2 minute intervals
 * - Auto-repair checks: Random 1-2 minute intervals
 * - Campaign renewal checks: Random 2-3 minute intervals
 * - Global automation loop: Random 1-3 minute intervals
 *
 * **Event-Driven Architecture:**
 * Bunker price updates from bunker-management.js trigger rebuy checks via
 * triggerAutoRebuyChecks(). This ensures fuel/CO2 purchases happen immediately
 * when prices drop, without constant API polling.
 *
 * @module automation
 * @requires api - purchaseFuel, purchaseCO2, fetchVessels, fetchCampaigns, activateCampaign
 * @requires utils - formatNumber, showNotification, showSideNotification, saveSettings
 * @requires bunker-management - getCurrentBunkerState
 */

import { purchaseFuel, purchaseCO2, fetchVessels, fetchCampaigns, activateCampaign, departVessel, fetchAssignedPorts } from './api.js';
import { formatNumber, showNotification, showSideNotification, saveSettings } from './utils.js';
import { getCurrentBunkerState } from './bunker-management.js';

// ============================================================================
// State Variables
// ============================================================================

/**
 * Prevents concurrent purchase operations to avoid race conditions.
 * Set to true while fuel/CO2 purchase is in progress.
 * @type {boolean}
 */
let isAutoBuying = false;

/**
 * Cooldown timestamps to prevent rapid re-buying after a purchase.
 * Each purchase sets a 3-minute cooldown before next purchase attempt.
 */
let lastFuelPurchaseTime = 0;
let lastCO2PurchaseTime = 0;
const PURCHASE_COOLDOWN = 180000; // 3 minutes

/**
 * Timestamp (Date.now()) of last vessel departure check.
 * Used to enforce random 1-2 minute intervals between checks.
 * @type {number}
 */
let lastVesselCheck = 0;

/**
 * Timestamp (Date.now()) of last campaign renewal check.
 * Used to enforce random 2-3 minute intervals between checks.
 * @type {number}
 */
let lastCampaignCheck = 0;

/**
 * Updates the Auto-Depart settings label with status text.
 * @param {string} statusText - Status to display (e.g., "(no fuel - auto depart paused)")
 */
function updateAutoDepartLabel(statusText = '') {
  const checkbox = document.getElementById('autoDepartAll');
  if (!checkbox) return;

  const label = checkbox.parentElement;
  if (!label) return;

  // Remove existing status text
  const existingStatus = label.querySelector('.auto-depart-status');
  if (existingStatus) {
    existingStatus.remove();
  }

  // Add new status text if provided
  if (statusText) {
    const statusSpan = document.createElement('span');
    statusSpan.className = 'auto-depart-status';
    statusSpan.style.color = '#fbbf24';
    statusSpan.style.fontSize = '0.9em';
    statusSpan.style.marginLeft = '8px';
    statusSpan.textContent = statusText;
    label.appendChild(statusSpan);
  }
}

// ============================================================================
// Auto-Rebuy Fuel
// ============================================================================

/**
 * Checks if automatic fuel purchase should be triggered based on current price.
 * This function is called by bunker-management.js whenever prices update (every 30-35s).
 *
 * **Simple Logic:**
 * - Whenever price is at or below threshold, attempts to purchase fuel
 * - Continues purchasing every price update until bunker is full or funds depleted
 * - No time windows - purely price-driven
 *
 * **Threshold Selection:**
 * - Uses settings.fuelThreshold if autoRebuyFuelUseAlert is enabled
 * - Otherwise uses settings.autoRebuyFuelThreshold
 *
 * @async
 * @param {Object} settings - User settings object from window.getSettings()
 * @param {boolean} settings.autoRebuyFuel - Whether auto-rebuy is enabled
 * @param {boolean} settings.autoRebuyFuelUseAlert - Whether to use alert threshold
 * @param {number} settings.fuelThreshold - Alert threshold price ($/ton)
 * @param {number} settings.autoRebuyFuelThreshold - Auto-rebuy threshold price ($/ton)
 * @returns {Promise<void>}
 */
async function checkAutoRebuyFuel(settings) {
  if (!settings.autoRebuyFuel) return;
  if (isAutoBuying) return; // Prevent concurrent purchases

  // Check cooldown - don't buy if we just bought recently
  const timeSinceLastPurchase = Date.now() - lastFuelPurchaseTime;
  if (timeSinceLastPurchase < PURCHASE_COOLDOWN) {
    console.log(`[Auto-Rebuy Fuel] Cooldown active (${Math.floor((PURCHASE_COOLDOWN - timeSinceLastPurchase) / 1000)}s remaining)`);
    return;
  }

  try {
    const bunkerState = getCurrentBunkerState();
    const fuelPrice = bunkerState.fuelPrice;

    if (!fuelPrice) return;

    // Determine which threshold to use
    const threshold = settings.autoRebuyFuelUseAlert
      ? settings.fuelThreshold
      : settings.autoRebuyFuelThreshold;

    // If price is at or below threshold, try to buy
    if (fuelPrice <= threshold) {
      await performAutoRebuyFuel(bunkerState, fuelPrice);
    }
  } catch (error) {
    console.error('[Auto-Rebuy Fuel] Error:', error);
  }
}

/**
 * Executes automatic fuel purchase when price is favorable.
 * Calculates optimal purchase amount based on available bunker space and cash.
 *
 * **Purchase Logic:**
 * - Calculates available bunker space (maxFuel - currentFuel)
 * - Calculates maximum affordable amount (cash / fuelPrice)
 * - Purchases the lesser of available space or affordable amount
 * - Skips purchase if bunker full or insufficient funds
 *
 * **Side Effects:**
 * - Sets isAutoBuying lock during operation
 * - Triggers UI update via window.debouncedUpdateBunkerStatus()
 * - Sends notification if autoPilotNotifications enabled
 *
 * @async
 * @param {Object} bunkerState - Current bunker state from getCurrentBunkerState()
 * @param {number} bunkerState.currentFuel - Current fuel in bunker (tons)
 * @param {number} bunkerState.maxFuel - Maximum bunker capacity (tons)
 * @param {number} bunkerState.currentCash - Available cash ($)
 * @param {number} fuelPrice - Current fuel price ($/ton)
 * @returns {Promise<void>}
 */
async function performAutoRebuyFuel(bunkerState, fuelPrice) {
  isAutoBuying = true;

  try {
    // Use bunkerState which already has correct values
    const currentFuel = bunkerState.currentFuel;
    const maxFuel = bunkerState.maxFuel;
    const availableSpace = maxFuel - currentFuel;

    if (availableSpace <= 0) {
      isAutoBuying = false;
      return;
    }

    const cash = bunkerState.currentCash;
    const maxAffordable = Math.floor(cash / fuelPrice);
    const amountToBuy = Math.min(availableSpace, maxAffordable);

    if (amountToBuy <= 0) {
      isAutoBuying = false;
      return;
    }

    const result = await purchaseFuel(amountToBuy);

    if (result.success || result.data) {
      // Set cooldown timestamp to prevent rapid re-buying
      lastFuelPurchaseTime = Date.now();

      showSideNotification(`⛽ <strong>Auto-Rebuy</strong><br><br>Purchased ${amountToBuy.toFixed(0)}t fuel @ $${fuelPrice}/t`, 'success');

      // Send compact notification
      const settings = window.getSettings ? window.getSettings() : {};
      const desktopNotifsEnabled = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
      if (desktopNotifsEnabled && Notification.permission === 'granted') {
        await showNotification('⛽ Auto-Rebuy: Fuel', {
          body: `

Bought ${formatNumber(amountToBuy)}t @ $${fuelPrice}/t`,
          icon: '/favicon.ico',
          tag: 'auto-rebuy-fuel',
          silent: false
        });
      }

      // Trigger UI update
      if (window.debouncedUpdateBunkerStatus) {
        window.debouncedUpdateBunkerStatus(500);
      }
    }
  } catch (error) {
    console.error('[Auto-Rebuy Fuel] Purchase failed:', error);
    showSideNotification(`⛽ <strong>Auto-Rebuy Failed</strong><br><br>${error.message}`, 'error');
  } finally {
    isAutoBuying = false;
  }
}

// ============================================================================
// Auto-Rebuy CO2
// ============================================================================

/**
 * Checks if automatic CO2 purchase should be triggered based on current price.
 * This function is called by bunker-management.js whenever prices update (every 30-35s).
 *
 * **Simple Logic:**
 * - Whenever price is at or below threshold, attempts to purchase CO2
 * - Continues purchasing every price update until bunker is full or funds depleted
 * - No time windows - purely price-driven
 *
 * **Threshold Selection:**
 * - Uses settings.co2Threshold if autoRebuyCO2UseAlert is enabled
 * - Otherwise uses settings.autoRebuyCO2Threshold
 *
 * @async
 * @param {Object} settings - User settings object from window.getSettings()
 * @param {boolean} settings.autoRebuyCO2 - Whether auto-rebuy is enabled
 * @param {boolean} settings.autoRebuyCO2UseAlert - Whether to use alert threshold
 * @param {number} settings.co2Threshold - Alert threshold price ($/ton)
 * @param {number} settings.autoRebuyCO2Threshold - Auto-rebuy threshold price ($/ton)
 * @returns {Promise<void>}
 */
async function checkAutoRebuyCO2(settings) {
  if (!settings.autoRebuyCO2) return;
  if (isAutoBuying) return; // Prevent concurrent purchases

  // Check cooldown - don't buy if we just bought recently
  const timeSinceLastPurchase = Date.now() - lastCO2PurchaseTime;
  if (timeSinceLastPurchase < PURCHASE_COOLDOWN) {
    console.log(`[Auto-Rebuy CO2] Cooldown active (${Math.floor((PURCHASE_COOLDOWN - timeSinceLastPurchase) / 1000)}s remaining)`);
    return;
  }

  try {
    const bunkerState = getCurrentBunkerState();
    const co2Price = bunkerState.co2Price;

    if (!co2Price) return;

    // Determine which threshold to use
    const threshold = settings.autoRebuyCO2UseAlert
      ? settings.co2Threshold
      : settings.autoRebuyCO2Threshold;

    // If price is at or below threshold, try to buy
    if (co2Price <= threshold) {
      await performAutoRebuyCO2(bunkerState, co2Price);
    }
  } catch (error) {
    console.error('[Auto-Rebuy CO2] Error:', error);
  }
}

/**
 * Executes automatic CO2 purchase when price is favorable.
 * Calculates optimal purchase amount based on available bunker space and cash.
 *
 * **Purchase Logic:**
 * - Calculates available bunker space (maxCO2 - currentCO2)
 * - Calculates maximum affordable amount (cash / co2Price)
 * - Purchases the lesser of available space or affordable amount
 * - Skips purchase if bunker full or insufficient funds
 *
 * **Side Effects:**
 * - Sets isAutoBuying lock during operation
 * - Triggers UI update via window.debouncedUpdateBunkerStatus()
 * - Sends notification if autoPilotNotifications enabled
 *
 * @async
 * @param {Object} bunkerState - Current bunker state from getCurrentBunkerState()
 * @param {number} bunkerState.currentCO2 - Current CO2 in bunker (tons)
 * @param {number} bunkerState.maxCO2 - Maximum bunker capacity (tons)
 * @param {number} bunkerState.currentCash - Available cash ($)
 * @param {number} co2Price - Current CO2 price ($/ton)
 * @returns {Promise<void>}
 */
async function performAutoRebuyCO2(bunkerState, co2Price) {
  isAutoBuying = true;

  try {
    // Use bunkerState which already has correct values
    const currentCO2 = bunkerState.currentCO2;
    const maxCO2 = bunkerState.maxCO2;
    const availableSpace = maxCO2 - currentCO2;

    if (availableSpace <= 0) {
      isAutoBuying = false;
      return;
    }

    const cash = bunkerState.currentCash;
    const maxAffordable = Math.floor(cash / co2Price);
    const amountToBuy = Math.min(availableSpace, maxAffordable);

    if (amountToBuy <= 0) {
      isAutoBuying = false;
      return;
    }

    const result = await purchaseCO2(amountToBuy);

    if (result.success || result.data) {
      // Set cooldown timestamp to prevent rapid re-buying
      lastCO2PurchaseTime = Date.now();

      showSideNotification(`💨 <strong>Auto-Rebuy</strong><br><br>Purchased ${amountToBuy.toFixed(0)}t CO2 @ $${co2Price}/t`, 'success');

      // Send compact notification
      const settings = window.getSettings ? window.getSettings() : {};
      const desktopNotifsEnabled = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
      if (desktopNotifsEnabled && Notification.permission === 'granted') {
        await showNotification('💨 Auto-Rebuy: CO2', {
          body: `

Bought ${formatNumber(amountToBuy)}t @ $${co2Price}/t`,
          icon: '/favicon.ico',
          tag: 'auto-rebuy-co2',
          silent: false
        });
      }

      // Trigger UI update
      if (window.debouncedUpdateBunkerStatus) {
        window.debouncedUpdateBunkerStatus(500);
      }
    }
  } catch (error) {
    console.error('[Auto-Rebuy CO2] Purchase failed:', error);
    showSideNotification(`💨 <strong>Auto-Rebuy Failed</strong><br><br>${error.message}`, 'error');
  } finally {
    isAutoBuying = false;
  }
}

// ============================================================================
// Auto-Depart All Vessels
// ============================================================================

/**
 * Checks if vessels should be automatically departed and executes departure.
 * Runs in an endless loop with randomized intervals for anti-detection.
 *
 * **Throttling Strategy:**
 * - Randomized interval between 1-2 minutes between checks
 * - Uses lastVesselCheck timestamp to enforce minimum intervals
 * - Random timing prevents predictable patterns that could trigger anti-bot
 *
 * **Departure Logic:**
 * - Only departs vessels with status 'port' and not parked (is_parked = false)
 * - Requires fuel > 0 in bunker to proceed
 * - Skips if no vessels in port or no fuel available
 *
 * **Side Effects:**
 * - Triggers UI updates via window.debouncedUpdateVesselCount()
 * - Triggers UI updates via window.debouncedUpdateBunkerStatus()
 * - Sends notification if autoPilotNotifications enabled
 *
 * @async
 * @param {Object} settings - User settings object from window.getSettings()
 * @param {boolean} settings.autoDepartAll - Whether auto-depart is enabled
 * @returns {Promise<void>}
 */
async function checkAutoDepartAll(settings) {
  if (!settings.autoDepartAll) {
    return;
  }

  // Throttle checks - random between 1-2 minutes
  const now = Date.now();
  const minInterval = 60000; // 1 minute
  const maxInterval = 120000; // 2 minutes
  const randomInterval = minInterval + Math.random() * (maxInterval - minInterval);

  if (now - lastVesselCheck < randomInterval) {
    return;
  }
  lastVesselCheck = now;

  try {
    // 1. Get current bunker state
    const bunkerState = getCurrentBunkerState();
    const currentFuel = bunkerState.currentFuel;

    // Check if fuel went back above threshold
    if (currentFuel >= 10 && settings.autoDepartLastLowFuelWarning) {
      // Clear warning timestamp in settings (syncs across all browser sessions)
      settings.autoDepartLastLowFuelWarning = null;
      await saveSettings(settings);

      updateAutoDepartLabel(''); // Clear status text in this session

      // Show resumed notification (only in this session, that's okay)
      showSideNotification(
        '✅ <strong>Auto-Depart Resumed</strong><br><br>Fuel back above 10t - automatic departures active again',
        'success',
        5000
      );
    }

    // Check if fuel is too low
    if (currentFuel < 10) {
      console.log(`[Auto-Depart] Skipping - insufficient fuel in bunker (${currentFuel.toFixed(1)}t < 10t minimum)`);

      // Update settings label (local to this session)
      updateAutoDepartLabel('(no fuel - auto depart paused)');

      return; // Not enough fuel to depart vessels (all sessions skip)
    }

    // 2. Fetch all vessels and assigned ports
    const vesselsData = await fetchVessels();
    const assignedPorts = await fetchAssignedPorts();

    if (!vesselsData?.vessels || !assignedPorts) {
      console.error('[Auto-Depart] Missing vessel or port data');
      return;
    }

    const allVessels = vesselsData.vessels;
    const harbourVessels = allVessels.filter(v => v.status === 'port' && !v.is_parked);

    if (harbourVessels.length === 0) {
      return; // No vessels in harbor
    }

    // Track departed and failed vessels
    let departedCount = 0;
    const departedVessels = [];
    const failedVessels = [];

    // 3. Group vessels by destination and type
    const vesselsByDestinationAndType = {};

    for (const vessel of harbourVessels) {
      // Check if vessel has a route assigned (route_destination is set when in harbor)
      if (!vessel.route_destination) {
        continue;
      }

      // Skip delivery vessels (newly purchased vessels being delivered)
      if (vessel.delivery_price !== null && vessel.delivery_price > 0) {
        continue;
      }

      const destination = vessel.route_destination;
      const type = vessel.capacity_type; // 'container' or 'tanker'
      const key = `${destination}_${type}`;

      if (!vesselsByDestinationAndType[key]) {
        vesselsByDestinationAndType[key] = [];
      }
      vesselsByDestinationAndType[key].push(vessel);
    }

    // 4. For each destination+type combination, decide which vessels to depart
    for (const key in vesselsByDestinationAndType) {
      const vessels = vesselsByDestinationAndType[key];
      const firstVessel = vessels[0];
      const vesselType = firstVessel.capacity_type;

      // Determine next destination: The port that is NOT the current port
      // If vessel is in port A with route A→B or B→A, next destination is the OTHER port
      let destination;
      if (firstVessel.route_destination === firstVessel.current_port_code) {
        // Vessel completed route TO current port, next destination is origin
        destination = firstVessel.route_origin;
      } else if (firstVessel.route_origin === firstVessel.current_port_code) {
        // Vessel completed route FROM current port (returned), next destination is the other end
        destination = firstVessel.route_destination;
      } else {
        // Fallback: use route_destination
        destination = firstVessel.route_destination;
      }

      console.log(`[Auto-Depart] Vessel ${firstVessel.name} in ${firstVessel.current_port_code} → next destination: ${destination}`);

      // Find port data
      const port = assignedPorts.find(p => p.code === destination);
      if (!port) {
        console.log(`[Auto-Depart] Port not found: ${destination}`);
        continue;
      }

      // Calculate remaining demand
      const remainingDemand = calculateRemainingDemand(port, vesselType);

      // Find all vessels already en-route to this port
      const vesselsEnroute = allVessels.filter(v =>
        v.status === 'enroute' &&
        v.route_destination === destination &&
        v.capacity_type === vesselType
      );

      // Calculate capacity already en-route
      const capacityEnroute = vesselsEnroute.reduce((sum, v) => {
        return sum + getTotalCapacity(v);
      }, 0);

      // Effective demand = Remaining - Already en-route
      let effectiveDemand = Math.max(0, remainingDemand - capacityEnroute);

      // Sort vessels by capacity (largest first = most efficient)
      const sortedVessels = vessels.sort((a, b) => {
        return getTotalCapacity(b) - getTotalCapacity(a);
      });

      // Decide for each vessel
      for (const vessel of sortedVessels) {
        const vesselCapacity = getTotalCapacity(vessel);

        // CRITICAL: Skip vessel if there is NO demand at destination
        if (effectiveDemand <= 0) {
          const reason = `No demand at destination (current demand: ${remainingDemand.toLocaleString()}, already en-route: ${capacityEnroute.toLocaleString()})`;
          console.log(`[Auto-Depart] Skipping vessel ${vessel.name} (ID: ${vessel.id}) → ${destination}: ${reason}`);

          // Track failed vessel with reason
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: reason
          });

          continue;
        }

        // Utilization = How much of the vessel will be filled
        // Example: effectiveDemand=100, vesselCapacity=200 → 50% utilization (half full)
        const cargoToLoad = Math.min(effectiveDemand, vesselCapacity);
        const utilizationRate = vesselCapacity > 0 ? cargoToLoad / vesselCapacity : 0;
        const minUtilization = (settings.minVesselUtilization || 45) / 100;

        // Check if vessel utilization is above minimum threshold
        const utilizationCheck = utilizationRate >= minUtilization;

        // Debug logging for low utilization
        if (utilizationCheck) {
          // Determine speed and guards based on settings
          let speed, guards;

          if (settings.autoDepartUseRouteDefaults) {
            // Use route defaults (values set when route was created)
            speed = vessel.route_speed || vessel.max_speed;
            guards = vessel.route_guards || 0;
          } else {
            // Use custom settings
            const speedPercent = settings.autoVesselSpeed || 50;
            speed = Math.round(vessel.max_speed * (speedPercent / 100));
            // Guards are always from route settings (set when route was created)
            guards = vessel.route_guards || 0;
          }

          try {
            const result = await departVessel(vessel.id, speed, guards);

            // Extract financial data from API response
            const departInfo = result.data?.depart_info || {};
            // depart_income is already NET income (after harbor fees)
            const income = departInfo.depart_income || 0;
            const harborFee = departInfo.harbor_fee || 0;
            const fuelUsage = (departInfo.fuel_usage || 0) / 1000; // Convert to tons
            const co2Emission = (departInfo.co2_emission || 0) / 1000; // Convert to tons

            // Check if departure was actually successful
            // API returns $0 income when vessel couldn't depart (e.g., no fuel)
            if (income === 0 && fuelUsage === 0 && co2Emission === 0) {
              console.log(`[Auto-Depart] Skipping ${vessel.name} → ${destination}: Insufficient fuel or CO2 in bunker`);
              // Don't show error notification - user can see bunker status
              continue; // Skip this vessel, don't count as departed
            }

            // Successfully departed
            departedCount++;

            // Track departed vessel info
            departedVessels.push({
              name: vessel.name,
              destination: destination,
              capacity: vesselCapacity,
              utilization: utilizationRate,
              cargoLoaded: cargoToLoad,
              speed: speed,
              guards: guards,
              income: income,
              harborFee: harborFee,
              fuelUsage: fuelUsage,
              co2Emission: co2Emission
            });

            // Update effective demand for next vessel in loop
            effectiveDemand -= cargoToLoad;

          } catch (error) {
            console.error(`[Auto-Depart] Failed to depart ${vessel.name} → ${destination}:`, error);

            // Track as failed departure
            failedVessels.push({
              name: vessel.name,
              destination: destination,
              reason: error.message || 'Unknown error'
            });
          }
        }
      }
    }

    // Show error feedback for failed vessels
    if (failedVessels.length > 0) {
      // Create detailed list of failed vessels with reasons
      const failedList = failedVessels.map(v =>
        `<div style="font-size: 0.85em; opacity: 0.9; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.1);">
          🚢 <strong>${v.name}</strong> → ${v.destination}<br>
          <span style="color: #fbbf24; font-size: 0.9em;">⚠️ ${v.reason}</span>
        </div>`
      ).join('');

      const message = `
        <div style="margin-bottom: 8px;">
          <strong>🤖 Auto-Depart: ${failedVessels.length} vessel${failedVessels.length > 1 ? 's' : ''} could not depart</strong>
        </div>
        <div style="max-height: 200px; overflow-y: auto;">
          ${failedList}
        </div>
      `;

      showSideNotification(message, 'warning', null, true);
    }

    if (departedCount > 0) {
      // Calculate totals
      const totalIncome = departedVessels.reduce((sum, v) => sum + v.income, 0);
      const totalFuelUsage = departedVessels.reduce((sum, v) => sum + v.fuelUsage, 0);
      const totalCO2Emission = departedVessels.reduce((sum, v) => sum + v.co2Emission, 0);

      // Create compact vessel list (mobile-friendly)
      let vesselList = departedVessels.map(v =>
        `<div style="font-size: 0.8em; opacity: 0.85; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          <div>🚢 <strong>${v.name}</strong></div>
          <div style="font-size: 0.9em; color: #9ca3af; margin-top: 2px;">
            ${formatNumber(v.cargoLoaded)}/${formatNumber(v.capacity)} TEU (${(v.utilization * 100).toFixed(0)}%) | 💰 $${formatNumber(v.income)}
          </div>
        </div>`
      ).join('');

      const message = `
        <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 2px solid rgba(255,255,255,0.3);">
          <strong style="font-size: 1.1em;">🤖 Auto-Depart: ${departedCount} vessel${departedCount > 1 ? 's' : ''}</strong>
        </div>
        <div style="margin: 12px 0; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px; font-family: monospace;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span style="color: #9ca3af;">Total Income:</span>
            <span style="color: #10b981; font-weight: bold;">$${formatNumber(totalIncome)}</span>
          </div>
          <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.9em; color: #9ca3af;">
            <div style="font-size: 0.85em; margin-bottom: 4px; opacity: 0.8;">Consumption:</div>
            <div>⛽ ${formatNumber(totalFuelUsage)}t Fuel</div>
            <div style="margin-top: 2px;">💨 ${formatNumber(totalCO2Emission)}t CO2</div>
          </div>
        </div>
        <div style="max-height: 240px; overflow-y: auto; margin-bottom: 10px; padding-right: 8px;">
          ${vesselList}
        </div>`;

      // Use side notification (slides from right, auto-dismisses)
      showSideNotification(message, 'success', 15000); // 15 seconds for long vessel lists

      // Send compact browser notification
      const settings = window.getSettings ? window.getSettings() : {};
      const desktopNotifsEnabled = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
      if (desktopNotifsEnabled && Notification.permission === 'granted') {
        await showNotification('🚢 Auto-Depart', {
          body: `

${departedCount} vessel${departedCount > 1 ? 's' : ''} departed

💰 Income: $${formatNumber(totalIncome)}

Fuel: ${formatNumber(totalFuelUsage)}t | CO2: ${formatNumber(totalCO2Emission)}t`,
          icon: '/favicon.ico',
          tag: 'auto-depart',
          silent: false
        });
      }

      // Trigger immediate UI update (vessel count badge must update right away)
      if (window.debouncedUpdateVesselCount) {
        window.debouncedUpdateVesselCount(0);
      }
      if (window.debouncedUpdateBunkerStatus) {
        window.debouncedUpdateBunkerStatus(1000);
      }
    }
  } catch (error) {
    console.error('[Auto-Depart] Error:', error);
  }
}

/**
 * Calculates remaining demand at a port (demand - consumed).
 * Sums both cargo types for containers (dry + refrigerated) and tankers (fuel + crude_oil).
 *
 * @param {Object} port - Port object from fetchAssignedPorts()
 * @param {string} vesselType - 'container' or 'tanker'
 * @returns {number} Remaining demand in TEU or tons
 */
function calculateRemainingDemand(port, vesselType) {
  if (vesselType === 'container') {
    const dryDemand = port.demand?.container?.dry || 0;
    const dryConsumed = port.consumed?.container?.dry || 0;
    const refDemand = port.demand?.container?.refrigerated || 0;
    const refConsumed = port.consumed?.container?.refrigerated || 0;

    return (dryDemand - dryConsumed) + (refDemand - refConsumed);
  } else if (vesselType === 'tanker') {
    const fuelDemand = port.demand?.tanker?.fuel || 0;
    const fuelConsumed = port.consumed?.tanker?.fuel || 0;
    const crudeDemand = port.demand?.tanker?.crude_oil || 0;
    const crudeConsumed = port.consumed?.tanker?.crude_oil || 0;

    return (fuelDemand - fuelConsumed) + (crudeDemand - crudeConsumed);
  }

  return 0;
}

/**
 * Calculates total capacity of a vessel.
 * Sums both cargo types for containers (dry + refrigerated) and tankers (fuel + crude_oil).
 *
 * @param {Object} vessel - Vessel object from fetchVessels()
 * @returns {number} Total capacity in TEU or tons
 */
function getTotalCapacity(vessel) {
  if (vessel.capacity_type === 'container') {
    return (vessel.capacity?.dry || 0) + (vessel.capacity?.refrigerated || 0);
  } else if (vessel.capacity_type === 'tanker') {
    return (vessel.capacity?.fuel || 0) + (vessel.capacity?.crude_oil || 0);
  }
  return 0;
}

// ============================================================================
// Auto Bulk Repair - MOVED TO BACKEND (server/automation.js)
// ============================================================================
// Auto-repair now runs on the backend with configurable intervals from settings.
// The backend broadcasts 'auto_repair_complete' events via WebSocket.
// Frontend handles these events in the WebSocket message handler (chat.js).

// ============================================================================
// Auto Campaign Renewal
// ============================================================================

/**
 * Checks if marketing campaigns need renewal and automatically activates
 * the most expensive affordable campaign for each inactive type.
 * Runs with randomized intervals for anti-detection.
 *
 * **Throttling Strategy:**
 * - Randomized interval between 2-3 minutes between checks
 * - Uses lastCampaignCheck timestamp to enforce minimum intervals
 * - Random timing prevents predictable patterns that could trigger anti-bot
 *
 * **Campaign Types:**
 * Monitors three campaign types: 'reputation', 'awareness', 'green'
 *
 * **Renewal Logic:**
 * - Checks which of the three campaign types are currently inactive
 * - For each inactive type, finds the most expensive campaign that can be afforded
 * - Activates campaigns sequentially, updating cash after each purchase
 * - Skips if all campaigns active or no affordable options
 *
 * **Best Campaign Selection:**
 * - Filters campaigns by type (reputation/awareness/green)
 * - Filters by affordability (price <= currentCash)
 * - Sorts by price descending to get most expensive
 * - Selects first (most expensive) affordable campaign
 *
 * **Side Effects:**
 * - Triggers UI updates via window.debouncedUpdateBunkerStatus()
 * - Sends notification if autoPilotNotifications enabled
 * - Updates local currentCash tracker after each purchase
 *
 * @async
 * @param {Object} settings - User settings object from window.getSettings()
 * @param {boolean} settings.autoCampaignRenewal - Whether auto-renewal is enabled
 * @returns {Promise<void>}
 */
async function checkAutoCampaignRenewal(settings) {
  if (!settings.autoCampaignRenewal) return;

  // Throttle checks - random between 2-3 minutes
  const now = Date.now();
  const minInterval = 120000; // 2 minutes
  const maxInterval = 180000; // 3 minutes
  const randomInterval = minInterval + Math.random() * (maxInterval - minInterval);

  if (now - lastCampaignCheck < randomInterval) return;
  lastCampaignCheck = now;

  try {
    const data = await fetchCampaigns();
    const allCampaigns = data.data.marketing_campaigns || [];
    const activeCampaigns = data.data.active_campaigns || [];
    const activeTypes = new Set(activeCampaigns.map(c => c.option_name));

    const requiredTypes = ['reputation', 'awareness', 'green'];
    const inactiveTypes = requiredTypes.filter(type => !activeTypes.has(type));

    if (inactiveTypes.length === 0) return; // All campaigns active

    const bunkerState = getCurrentBunkerState();
    let currentCash = bunkerState.currentCash;

    // For each inactive type, find the most expensive campaign we can afford
    for (const type of inactiveTypes) {
      const typeCampaigns = allCampaigns
        .filter(c => c.option_name === type)
        .filter(c => c.price <= currentCash)
        .sort((a, b) => b.price - a.price); // Sort by price descending

      if (typeCampaigns.length === 0) {
        continue;
      }

      const bestCampaign = typeCampaigns[0];

      try {
        const result = await activateCampaign(bestCampaign.id);

        if (result.success || result.data) {
          const typeName = type.charAt(0).toUpperCase() + type.slice(1);
          const efficiency = `${bestCampaign.min_efficiency}-${bestCampaign.max_efficiency}%`;
          const duration = bestCampaign.campaign_duration;

          showSideNotification(`📊 <strong>Auto-Campaign</strong><br><br>Activated ${typeName} campaign<br>Duration: ${duration}h | Efficiency: ${efficiency}<br>Cost: $${formatNumber(bestCampaign.price)}`, 'success');

          // Send compact notification
          const settings = window.getSettings ? window.getSettings() : {};
          const desktopNotifsEnabled = settings.enableDesktopNotifications !== undefined ? settings.enableDesktopNotifications : true;
          if (desktopNotifsEnabled && Notification.permission === 'granted') {
            await showNotification('📊 Auto-Campaign', {
              body: `

${typeName}

Duration: ${duration}h | Efficiency: ${efficiency}

💰 Cost: $${formatNumber(bestCampaign.price)}`,
              icon: '/favicon.ico',
              tag: 'auto-campaign',
              silent: false
            });
          }

          // Trigger UI update
          if (window.debouncedUpdateBunkerStatus) {
            window.debouncedUpdateBunkerStatus(500);
          }

          // Update current cash after purchase
          currentCash -= bestCampaign.price;
        }
      } catch (error) {
        console.error(`[Auto-Campaign] Failed to activate ${type} campaign:`, error);
      }
    }
  } catch (error) {
    console.error('[Auto-Campaign] Error:', error);
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Triggers auto-rebuy checks for fuel and CO2 based on current prices.
 * Called by bunker-management.js whenever prices update (every 30-35 seconds).
 *
 * This is the event-driven entry point for price-dependent automation.
 * Fuel/CO2 rebuy logic executes immediately when prices drop, without
 * waiting for the global automation loop.
 *
 * @async
 * @param {Object} settings - User settings object from window.getSettings()
 * @param {boolean} settings.autoRebuyFuel - Whether fuel auto-rebuy is enabled
 * @param {boolean} settings.autoRebuyCO2 - Whether CO2 auto-rebuy is enabled
 * @returns {Promise<void>}
 * @public
 */
export async function triggerAutoRebuyChecks(settings) {
  try {
    await Promise.all([
      checkAutoRebuyFuel(settings),
      checkAutoRebuyCO2(settings)
    ]);
  } catch (error) {
    console.error('[Auto-Rebuy] Error:', error);
  }
}

/**
 * Main automation loop that runs non-price-dependent checks.
 * Executes vessel departure, repair, and campaign renewal automation.
 *
 * This function is called by the global automation scheduler (initAutomation)
 * at random 1-3 minute intervals. Price-dependent features (fuel/CO2 rebuy)
 * are NOT included here - they use triggerAutoRebuyChecks() instead.
 *
 * **Features Checked:**
 * - Auto-Depart All Vessels (with 1-2 min throttling)
 * - Auto Bulk Repair (with 1-2 min throttling)
 * - Auto Campaign Renewal (with 2-3 min throttling)
 *
 * @async
 * @returns {Promise<void>}
 * @public
 */
export async function runAutomationChecks() {
  try {
    // Get current settings dynamically
    const settings = window.getSettings ? window.getSettings() : {};

    // Run non-price-dependent checks
    // Note: Auto-repair now runs on backend (server/automation.js)
    await Promise.all([
      checkAutoDepartAll(settings),
      checkAutoCampaignRenewal(settings)
    ]);
  } catch (error) {
    console.error('[Automation] Error in automation loop:', error);
  }
}

/**
 * Initializes the AutoPilot automation system with randomized scheduling.
 *
 * **Scheduling Strategy:**
 * - Initial check runs after 5 seconds (warmup delay)
 * - Subsequent checks run at random intervals between 1-3 minutes
 * - Each interval is randomly generated to prevent predictable patterns
 * - Uses recursive setTimeout to schedule next check after current completes
 *
 * **What Gets Scheduled:**
 * Only non-price-dependent features (depart/repair/campaign) are scheduled here.
 * Fuel/CO2 rebuy runs event-driven via triggerAutoRebuyChecks() when prices update.
 *
 * This function should be called once on application startup.
 *
 * @returns {void}
 * @public
 */
export function initAutomation() {
  // Run checks with random interval between 1-3 minutes
  function scheduleNextCheck() {
    const minInterval = 60000; // 1 minute
    const maxInterval = 180000; // 3 minutes
    const randomInterval = minInterval + Math.random() * (maxInterval - minInterval);

    setTimeout(() => {
      runAutomationChecks();
      scheduleNextCheck(); // Schedule next check
    }, randomInterval);
  }

  // Run initial check after 5 seconds
  setTimeout(() => {
    runAutomationChecks();
    scheduleNextCheck(); // Start the loop
  }, 5000);
}
