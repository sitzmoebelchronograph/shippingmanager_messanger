/**
 * @fileoverview Cargo Marshal - Auto-Depart Vessels Pilot
 *
 * Automatically departs vessels with intelligent demand-based routing.
 * Includes race condition prevention and $0 revenue protection.
 *
 * @module server/autopilot/pilot_cargo_marshal
 */

const gameapi = require('../gameapi');
const state = require('../state');
const logger = require('../utils/logger');
const { getUserId } = require('../utils/api');
const config = require('../config');
const { logAutopilotAction } = require('../logbook');

const DEBUG_MODE = config.DEBUG_MODE;

/**
 * Calculates remaining demand at a port.
 *
 * @param {Object} port - Port object
 * @param {string} vesselType - 'container' or 'tanker'
 * @returns {number} Remaining demand
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
 *
 * @param {Object} vessel - Vessel object
 * @returns {number} Total capacity
 */
function getTotalCapacity(vessel) {
  if (vessel.capacity_type === 'container') {
    return (vessel.capacity_max?.dry || 0) + (vessel.capacity_max?.refrigerated || 0);
  } else if (vessel.capacity_type === 'tanker') {
    return (vessel.capacity_max?.fuel || 0) + (vessel.capacity_max?.crude_oil || 0);
  }
  return 0;
}

/**
 * Universal vessel departure function with intelligent demand-based routing.
 * Works with any list of vessel IDs or all vessels if vesselIds=null.
 * Used by BOTH autopilot and manual departure operations.
 *
 * @async
 * @param {number} userId - User ID for state management
 * @param {Array<number>|null} vesselIds - Array of vessel IDs to depart, or null for all vessels
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} autoRebuyAll - Function to trigger fuel/CO2 rebuy
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<Object>} Result object: { success: boolean, reason?: string, error?: string }
 */
async function departVessels(userId, vesselIds = null, broadcastToUser, autoRebuyAll, tryUpdateAllData) {
  try {
    const settings = state.getSettings(userId);

    // Get current bunker state
    const bunker = await gameapi.fetchBunkerState();
    state.updateBunkerState(userId, bunker);

    // Check if fuel is too low (use minFuelThreshold setting)
    if (bunker.fuel < settings.minFuelThreshold) {
      logger.log(`[Depart] Skipping - insufficient fuel (${bunker.fuel.toFixed(1)}t < ${settings.minFuelThreshold}t minimum)`);

      // Notify user about insufficient fuel
      if (broadcastToUser) {
        broadcastToUser(userId, 'notification', {
          type: 'error',
          message: `<p><strong>Harbor master</strong></p><p>Cannot depart vessels - insufficient fuel!<br>Current: ${bunker.fuel.toFixed(1)}t | Required minimum: ${settings.minFuelThreshold}t</p>`
        });
      }
      return { success: false, reason: 'insufficient_fuel' };
    }

    // Fetch vessels ONCE at the start
    const allVessels = await gameapi.fetchVessels();
    // NOTE: We will fetch port data BEFORE EACH DEPART to avoid race conditions

    // Filter vessels: either specific IDs or all in harbor
    let harbourVessels;
    if (vesselIds && vesselIds.length > 0) {
      // Filter by specific vessel IDs
      const vesselIdSet = new Set(vesselIds);
      harbourVessels = allVessels.filter(v =>
        vesselIdSet.has(v.id) &&
        v.status === 'port' &&
        !v.is_parked
      );
      if (DEBUG_MODE) {
        logger.log(`[Depart] Filtering ${vesselIds.length} requested vessels, found ${harbourVessels.length} in harbor`);
      }
    } else {
      // Depart ALL vessels in harbor
      harbourVessels = allVessels.filter(v => v.status === 'port' && !v.is_parked);
    }

    if (DEBUG_MODE) {
      logger.log(`[Depart] Found ${harbourVessels.length} vessels to process (total: ${allVessels.length})`);
    }

    // Broadcast vessel count to all clients (use consistent format)
    if (broadcastToUser) {
      const readyToDepart = allVessels.filter(v => v.status === 'port').length;
      const atAnchor = allVessels.filter(v => v.status === 'anchor').length;
      const pending = allVessels.filter(v => v.status === 'pending').length;

      broadcastToUser(userId, 'vessel_count_update', {
        readyToDepart,
        atAnchor,
        pending
      });
    }

    if (harbourVessels.length === 0) {
      if (DEBUG_MODE) {
        logger.log('[Depart] No vessels to depart, skipping');
      }
      return { success: true, reason: 'no_vessels' };
    }

    // Notify frontend that autopilot departure has started (locks depart button)
    if (broadcastToUser) {
      broadcastToUser(userId, 'autopilot_depart_start', {
        vesselCount: harbourVessels.length
      });
    }

    // Track departed, failed, and warning vessels
    const departedVessels = [];
    const failedVessels = [];
    const warningVessels = [];

    // Separate arrays for logbook (not cleared after batches)
    const allDepartedVessels = [];
    const allWarningVessels = [];

    const CHUNK_SIZE = 20;
    let processedCount = 0;

    // Helper function to send notifications for current batch
    async function sendBatchNotifications() {
      // Send combined notification if there are any vessels (departed or failed)
      if (departedVessels.length > 0 || failedVessels.length > 0) {
        const totalIncome = departedVessels.reduce((sum, v) => sum + v.income, 0);
        const totalFuelUsed = departedVessels.reduce((sum, v) => sum + v.fuelUsed, 0);
        const totalCO2Used = departedVessels.reduce((sum, v) => sum + v.co2Used, 0);

        if (DEBUG_MODE) {
          logger.log(`[Depart] Batch: ${departedVessels.length} departed, ${failedVessels.length} failed - Income: $${totalIncome.toLocaleString()}`);
        }

        if (broadcastToUser) {
          const bunkerState = await gameapi.fetchBunkerState();

          // Send combined event with both succeeded and failed vessels
          broadcastToUser(userId, 'vessels_depart_complete', {
            succeeded: {
              count: departedVessels.length,
              vessels: departedVessels.slice(),
              totalIncome: totalIncome,
              totalFuelUsed: totalFuelUsed,
              totalCO2Used: totalCO2Used
            },
            failed: {
              count: failedVessels.length,
              vessels: failedVessels.slice()
            },
            bunker: {
              fuel: bunkerState.fuel,
              co2: bunkerState.co2
            }
          });
        }

        // Trigger auto-rebuy after each successful batch (if enabled)
        if (departedVessels.length > 0) {
          if (DEBUG_MODE) {
            logger.log(`[Depart] Triggering auto-rebuy after ${departedVessels.length} vessels departed in this batch`);
          }
          await autoRebuyAll();
        }

        departedVessels.length = 0; // Clear array for next batch
        failedVessels.length = 0; // Clear array for next batch
      }
    }

    // Group vessels by destination and type
    const vesselsByDestinationAndType = {};

    for (const vessel of harbourVessels) {
      if (!vessel.route_destination) {
        if (DEBUG_MODE) {
          logger.log(`[Depart] Skipping ${vessel.name}: no route destination`);
        }
        failedVessels.push({
          name: vessel.name,
          destination: 'Unknown',
          reason: 'No route assigned'
        });
        continue;
      }
      if (vessel.delivery_price !== null && vessel.delivery_price > 0) {
        if (DEBUG_MODE) {
          logger.log(`[Depart] Skipping ${vessel.name}: delivery contract active ($${vessel.delivery_price})`);
        }
        failedVessels.push({
          name: vessel.name,
          destination: vessel.route_destination || 'Unknown',
          reason: 'Delivery contract active'
        });
        continue;
      }

      const destination = vessel.route_destination;
      const type = vessel.capacity_type;
      const key = `${destination}_${type}`;

      if (!vesselsByDestinationAndType[key]) {
        vesselsByDestinationAndType[key] = [];
      }
      vesselsByDestinationAndType[key].push(vessel);
    }

    if (DEBUG_MODE) {
      logger.log(`[Depart] Grouped vessels into ${Object.keys(vesselsByDestinationAndType).length} destination+type groups`);
    }

    // Process each destination+type group
    for (const key in vesselsByDestinationAndType) {
      const vessels = vesselsByDestinationAndType[key];
      const firstVessel = vessels[0];
      const vesselType = firstVessel.capacity_type;

      if (DEBUG_MODE) {
        logger.log(`[Depart] Processing group: ${key} (${vessels.length} vessels)`);
      }

      // Determine next destination
      let destination;
      if (firstVessel.route_destination === firstVessel.current_port_code) {
        destination = firstVessel.route_origin;
      } else if (firstVessel.route_origin === firstVessel.current_port_code) {
        destination = firstVessel.route_destination;
      } else {
        destination = firstVessel.route_destination;
      }

      if (DEBUG_MODE) {
        logger.log(`[Depart] Destination: ${destination}`);
      }

      // Sort vessels by capacity (largest first)
      const sortedVessels = vessels.sort((a, b) => getTotalCapacity(b) - getTotalCapacity(a));

      // Process each vessel individually with FRESH port data
      for (const vessel of sortedVessels) {
        const vesselCapacity = getTotalCapacity(vessel);

        // CRITICAL: Fetch FRESH port data BEFORE EACH depart to avoid race conditions
        // This prevents $0 revenue when vessels arrive at destination during the depart loop
        const freshPorts = await gameapi.fetchAssignedPorts();
        const port = freshPorts.find(p => p.code === destination);

        if (!port) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: 'Port not in assigned ports'
          });
          continue;
        }

        // Calculate CURRENT remaining demand with fresh data
        const remainingDemand = calculateRemainingDemand(port, vesselType);

        if (DEBUG_MODE) {
          logger.log(`[Depart] ${vessel.name}: Demand check - Remaining: ${remainingDemand}`);
        }

        // Skip if no demand
        if (remainingDemand <= 0) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `No demand at destination`
          });
          continue;
        }

        // CRITICAL: Check if price-per-TEU is 0 at destination using auto-price API
        try {
          if (vessel.route_id) {
            const autoPriceData = await gameapi.fetchAutoPrice(vessel.id, vessel.route_id);

            const dryPrice = autoPriceData?.data?.dry || 0;
            const refPrice = autoPriceData?.data?.ref || 0;
            const fuelPrice = autoPriceData?.data?.fuel || 0;
            const crudePrice = autoPriceData?.data?.crude_oil || 0;

            const hasValidPrice = vesselType === 'container'
              ? (dryPrice > 0 || refPrice > 0)
              : (fuelPrice > 0 || crudePrice > 0);

            if (!hasValidPrice) {
              logger.log(`[Depart] ⚠️ ${vessel.name}: Price per TEU is $0 at ${destination} - BLOCKING departure to avoid losses`);
              failedVessels.push({
                name: vessel.name,
                destination: destination,
                reason: `CRITICAL: Price per TEU is $0 at destination - would result in losses`
              });
              continue;
            }

            if (DEBUG_MODE) {
              logger.log(`[Depart] ${vessel.name}: Price check OK - Dry: $${dryPrice}, Ref: $${refPrice}, Fuel: $${fuelPrice}, Crude: $${crudePrice}`);
            }
          }
        } catch (error) {
          logger.error(`[Depart] ${vessel.name}: Failed to fetch auto-price - BLOCKING departure to avoid potential losses`);
          logger.error(`[Depart] Error details: ${error.message}`);
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Cannot verify destination price (API error: ${error.message}) - blocking to prevent potential losses`
          });
          continue;
        }

        // Check utilization
        const cargoToLoad = Math.min(remainingDemand, vesselCapacity);
        const utilizationRate = vesselCapacity > 0 ? cargoToLoad / vesselCapacity : 0;
        const minUtilization = settings.minCargoUtilization / 100;

        if (utilizationRate < minUtilization) {
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: `Utilization too low (${(utilizationRate * 100).toFixed(0)}% < ${(minUtilization * 100).toFixed(0)}%)`
          });
          continue;
        }

        // Determine speed and guards
        let speed, guards;

        if (settings.autoDepartUseRouteDefaults) {
          speed = vessel.route_speed || vessel.max_speed;
          guards = vessel.route_guards;
        } else {
          const speedPercent = settings.autoVesselSpeed;
          speed = Math.round(vessel.max_speed * (speedPercent / 100));
          guards = vessel.route_guards;
        }

        try {
          if (DEBUG_MODE) {
            logger.log(`[Depart] Attempting to depart vessel: name="${vessel.name}", id=${vessel.id}, status="${vessel.status}"`);
          }
          const result = await gameapi.departVessel(vessel.id, speed, guards);

          // Check if departure failed
          if (result.success === false) {
            // SPECIAL CASE: Vessel already departed
            if (result.error === 'Vessel not found or status invalid') {
              logger.log(`[Depart] Vessel ${vessel.name} was already departed (race condition - ignoring)`);
              continue;
            }

            // SPECIAL CASE: CO2 "errors"
            if (result.errorMessage && (result.errorMessage.toLowerCase().includes('co2') ||
                                       result.errorMessage.toLowerCase().includes('emission'))) {
              logger.log(`[Depart] ${vessel.name} departed with CO2 warning - vessel sent but no stats available, skipping notification`);
              continue;
            }

            logger.log(`[Depart] Failed to depart ${vessel.name}: "${result.errorMessage}"`);

            let detailedReason = result.errorMessage;
            if (result.apiResponse && result.apiResponse.message) {
              detailedReason = result.apiResponse.message;
            }

            const lowerReason = detailedReason.toLowerCase();

            if (lowerReason.includes('fuel') || lowerReason.includes('bunker')) {
              const requiredFuel = vessel.route_fuel_required || vessel.fuel_required;
              if (requiredFuel) {
                detailedReason = `No fuel (${requiredFuel.toFixed(1)}t)`;
              } else {
                detailedReason = 'No fuel';
              }
            } else if (lowerReason.includes('demand') || (remainingDemand <= 0 && lowerReason.includes('failed'))) {
              detailedReason = `No demand at ${destination} (${remainingDemand.toFixed(1)}t remaining demand, vessel capacity ${vesselCapacity.toFixed(1)}t)`;
            } else if (lowerReason === 'failed to depart vessel') {
              detailedReason = result.errorMessage || 'Failed to depart vessel';
            }

            failedVessels.push({
              name: vessel.name,
              destination: destination,
              reason: detailedReason
            });
            continue;
          }

          // Check for silent failures
          if (result.income === 0 && result.fuelUsed === 0) {
            continue;
          }

          // Check for $0 revenue
          if (result.income === 0 && result.harborFee === 0) {
            logger.log(`[Depart] WARNING: ${vessel.name} departed with $0 revenue - demand exhausted during batch`);
            const warningData = {
              name: result.vesselName,
              destination: result.destination,
              reason: 'Demand exhausted - $0 revenue'
            };
            warningVessels.push(warningData);
            allWarningVessels.push(warningData);
            continue;
          }

          // Check for negative net income bug
          const hasFeeCalculationBug = result.netIncome < 0;

          // Calculate actual utilization from API response
          const actualCargoLoaded = result.cargoLoaded;
          const actualUtilization = vesselCapacity > 0 ? actualCargoLoaded / vesselCapacity : 0;

          // Successfully departed
          const vesselData = {
            name: result.vesselName,
            destination: result.destination,
            capacity: vesselCapacity,
            utilization: actualUtilization,  // Use ACTUAL from API
            cargoLoaded: actualCargoLoaded,  // Use ACTUAL from API
            speed: result.speed,
            guards: result.guards,
            income: result.income,
            harborFee: result.harborFee,
            netIncome: result.netIncome,
            hasFeeCalculationBug: hasFeeCalculationBug,
            fuelUsed: result.fuelUsed,
            co2Used: result.co2Used,
            // Include detailed cargo breakdown for debugging
            teuDry: result.teuDry,
            teuRefrigerated: result.teuRefrigerated,
            fuelCargo: result.fuelCargo,
            crudeCargo: result.crudeCargo
          };
          departedVessels.push(vesselData);
          allDepartedVessels.push(vesselData);

        } catch (error) {
          logger.error(`[Depart] Failed to depart ${vessel.name}:`, error.message);
          failedVessels.push({
            name: vessel.name,
            destination: destination,
            reason: error.message || 'Unknown error'
          });
        }

        // Check if we've processed a chunk of vessels
        processedCount++;
        if (processedCount % CHUNK_SIZE === 0) {
          await sendBatchNotifications();
        }
      }
    }

    // Send final batch for any remaining vessels
    if (departedVessels.length > 0 || failedVessels.length > 0) {
      await sendBatchNotifications();
    }

    // Trigger rebuy and update data after departures
    if (processedCount > 0) {
      await autoRebuyAll();
      await tryUpdateAllData();
    }

    // Calculate totals from ALL departed vessels (not just last batch)
    const totalRevenue = allDepartedVessels.reduce((sum, v) => sum + (v.netIncome || 0), 0);
    const totalFuelUsed = allDepartedVessels.reduce((sum, v) => sum + (v.fuelUsed || 0), 0);
    const totalCO2Used = allDepartedVessels.reduce((sum, v) => sum + (v.co2Used || 0), 0);
    const totalHarborFees = allDepartedVessels.reduce((sum, v) => sum + (v.harborFee || 0), 0);

    return {
      success: true,
      departedCount: allDepartedVessels.length,
      failedCount: failedVessels.length,
      warningCount: allWarningVessels.length,
      departedVessels: allDepartedVessels.slice(),
      warningVessels: allWarningVessels.slice(),
      totalRevenue,
      totalFuelUsed,
      totalCO2Used,
      totalHarborFees
    };

  } catch (error) {
    logger.error('[Depart] Error:', error.message);
    return { success: false, reason: 'error', error: error.message };
  }
}

/**
 * Intelligent auto-depart wrapper for autopilot system.
 * Calls departVessels() with null vesselIds to depart ALL vessels in harbor.
 *
 * @async
 * @param {boolean} autopilotPaused - Autopilot pause state
 * @param {Function} broadcastToUser - WebSocket broadcast function
 * @param {Function} autoRebuyAll - Function to trigger fuel/CO2 rebuy
 * @param {Function} tryUpdateAllData - Function to update all game data
 * @returns {Promise<void>}
 */
async function autoDepartVessels(autopilotPaused, broadcastToUser, autoRebuyAll, tryUpdateAllData) {
  // Check if autopilot is paused
  if (autopilotPaused) {
    logger.log('[Auto-Depart] Skipped - Autopilot is PAUSED');
    return;
  }

  const userId = getUserId();
  if (!userId) return;

  const settings = state.getSettings(userId);

  if (!settings.autoDepartAll) {
    if (DEBUG_MODE) {
      logger.log('[Auto-Depart] Feature disabled in settings');
    }
    return;
  }

  if (DEBUG_MODE) {
    logger.log(`[Auto-Depart] Checking... ${settings.autoDepartAll ? 'ENABLED' : 'DISABLED'}`);
  }

  try {
    // Call universal depart function with all vessels (vesselIds = null)
    const result = await departVessels(userId, null, broadcastToUser, autoRebuyAll, tryUpdateAllData);

    // Log success to autopilot logbook
    if (result.success && result.reason !== 'no_vessels' && result.departedCount > 0) {
      await logAutopilotAction(
        userId,
        'Auto-Depart',
        'SUCCESS',
        `${result.departedCount} vessels | +$${result.totalRevenue.toLocaleString()}`,
        {
          vesselCount: result.departedCount,
          totalRevenue: result.totalRevenue,
          totalFuelUsed: result.totalFuelUsed,
          totalCO2Used: result.totalCO2Used,
          totalHarborFees: result.totalHarborFees,
          departedVessels: result.departedVessels
        }
      );
    }

    // Log warnings if any vessels had $0 revenue
    if (result.success && result.warningCount > 0) {
      await logAutopilotAction(
        userId,
        'Auto-Depart',
        'WARNING',
        `${result.warningCount} vessel${result.warningCount > 1 ? 's' : ''} with demand exhausted | $0 revenue`,
        {
          vesselCount: result.warningCount,
          warningVessels: result.warningVessels
        }
      );
    }
  } catch (error) {
    logger.error('[Auto-Depart] Error:', error.message);

    // Log error to autopilot logbook
    await logAutopilotAction(
      userId,
      'Auto-Depart',
      'ERROR',
      `Departure failed: ${error.message}`,
      {
        error: error.message,
        stack: error.stack
      }
    );
  }
}

module.exports = {
  departVessels,
  autoDepartVessels,
  calculateRemainingDemand,
  getTotalCapacity
};
