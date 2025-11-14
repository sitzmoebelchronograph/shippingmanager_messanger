/**
 * @fileoverview Harbor Map API Routes
 *
 * This module provides HTTP endpoints for the Harbor Map & Live Route Monitoring System.
 * Handles vessel positions, port data aggregation, and real-time route visualization.
 *
 * Key Features:
 * - Vessel position tracking with linear interpolation
 * - Port demand analytics with color indicators
 * - Reachable ports calculation for vessel-specific routes
 * - "My Ports" vs "All Ports" filtering
 * - Vessel categorization by port (in/to/from)
 *
 * Architecture:
 * - ALL API calls happen in backend
 * - ALL data processing happens in backend
 * - Frontend receives ready-to-render data only
 *
 * @requires express - Router and middleware
 * @requires ../utils/api - API helper function (apiCall)
 * @module server/routes/harbor-map
 */

const express = require('express');
const { getUserId } = require('../utils/api');
const gameapi = require('../gameapi');
const logger = require('../utils/logger');
const config = require('../config');
const { enrichHistoryWithFees } = require('../utils/harbor-fee-store');
const { migrateHarborFeesForUser } = require('../utils/migrate-harbor-fees');

const {
  aggregateVesselData,
  aggregateReachablePorts,
  categorizeVesselsByPort,
  filterAssignedPorts,
  extractPortsFromGameIndex
} = require('./harbor-map-aggregator');

const router = express.Router();

// Cache for game/index data (30-second TTL)
// Short TTL ensures vessel positions update quickly after departures
let gameIndexCache = null;
let gameIndexCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * Fetches game/index data with caching
 * Uses 30-second TTL to keep vessel positions fresh
 *
 * @returns {Promise<Object>} Game index data with vessels and ports
 * @throws {Error} If API call fails
 */
async function getGameIndexCached() {
  const now = Date.now();

  // Return cached data if still valid
  if (gameIndexCache && (now - gameIndexCacheTime) < CACHE_TTL) {
    return gameIndexCache;
  }

  // Fetch fresh data
  const response = await gameapi.getGameIndex();

  if (!response?.data) {
    throw new Error('Failed to fetch game index');
  }

  // Update cache
  gameIndexCache = response.data;
  gameIndexCacheTime = now;

  return gameIndexCache;
}

/**
 * GET /api/harbor-map/overview
 * Returns all vessels with positions and all ports (default: My Ports)
 *
 * Response:
 * {
 *   vessels: [{ id, name, position: {lat, lon, progress}, eta, status, ... }],
 *   ports: [{ code, lat, lon, demand, demandLevel }],
 *   filter: 'my_ports' | 'all_ports'
 * }
 */
router.get('/overview', async (req, res) => {
  try {
    const filter = req.query.filter || 'my_ports'; // 'my_ports' or 'all_ports' or specific filters

    // Validate filter parameter - whitelist approach
    const validFilters = [
      'my_ports',
      'all_ports',
      'my_ports_with_arrived_vessels',
      'my_ports_with_anchored_vessels',
      'my_ports_with_vessels_in_maint',
      'my_ports_with_pending_vessels'
    ];
    if (!validFilters.includes(filter)) {
      return res.status(400).json({
        error: 'Invalid filter parameter',
        valid_filters: validFilters
      });
    }

    // Fetch game index (cached) for ports
    const gameIndexData = await getGameIndexCached();
    const allPortsWithDemand = extractPortsFromGameIndex(gameIndexData);

    // Fetch vessels from dedicated endpoint
    const vesselsResponse = await gameapi.getAllUserVessels();
    const allVessels = vesselsResponse?.data?.user_vessels || [];

    logger.debug(`[Harbor Map] getAllUserVessels response: ${allVessels.length} vessels`);

    // Aggregate vessel data with calculated positions
    const vesselsWithPositions = aggregateVesselData(allVessels, allPortsWithDemand);

    // Fetch assigned ports (for both filters - needed for correct demand data)
    const assignedPortsResponse = await gameapi.getAssignedPorts();
    const assignedPorts = assignedPortsResponse?.data?.ports || [];

    // Filter ports AND vessels based on user preference
    let ports;
    let vessels = vesselsWithPositions;

    if (filter === 'my_ports') {
      // Only show assigned ports (mark them with isAssigned: true)
      ports = filterAssignedPorts(assignedPorts, allPortsWithDemand).map(p => ({ ...p, isAssigned: true }));
      logger.debug(`[Harbor Map] Filter: ${filter}, Assigned ports: ${assignedPorts.length}, Filtered ports: ${ports.length}, All ports: ${allPortsWithDemand.length}`);
    } else if (filter === 'my_ports_with_arrived_vessels') {
      // Only show assigned ports with vessels in 'port' status AND only show those vessels
      const assignedPortsWithDemand = filterAssignedPorts(assignedPorts, allPortsWithDemand);
      const portsWithArrivedVessels = new Set(
        vesselsWithPositions.filter(v => v.status === 'port' && v.current_port_code).map(v => v.current_port_code)
      );
      ports = assignedPortsWithDemand.filter(p => portsWithArrivedVessels.has(p.code)).map(p => ({ ...p, isAssigned: true }));
      vessels = vesselsWithPositions.filter(v => v.status === 'port' && v.current_port_code && portsWithArrivedVessels.has(v.current_port_code));
      logger.debug(`[Harbor Map] Filter: ${filter}, Ports: ${ports.length}, Vessels: ${vessels.length}`);
    } else if (filter === 'my_ports_with_anchored_vessels') {
      // Only show assigned ports with vessels in 'anchor' status AND only show those vessels
      const assignedPortsWithDemand = filterAssignedPorts(assignedPorts, allPortsWithDemand);
      const portsWithAnchoredVessels = new Set(
        vesselsWithPositions.filter(v => v.status === 'anchor' && v.current_port_code).map(v => v.current_port_code)
      );
      ports = assignedPortsWithDemand.filter(p => portsWithAnchoredVessels.has(p.code)).map(p => ({ ...p, isAssigned: true }));
      vessels = vesselsWithPositions.filter(v => v.status === 'anchor' && v.current_port_code && portsWithAnchoredVessels.has(v.current_port_code));
      logger.debug(`[Harbor Map] Filter: ${filter}, Ports: ${ports.length}, Vessels: ${vessels.length}`);
    } else if (filter === 'my_ports_with_vessels_in_maint') {
      // Only show assigned ports with vessels in 'maintenance' status AND only show those vessels
      const assignedPortsWithDemand = filterAssignedPorts(assignedPorts, allPortsWithDemand);
      const portsWithMaintenanceVessels = new Set(
        vesselsWithPositions.filter(v => v.status === 'maintenance' && v.current_port_code).map(v => v.current_port_code)
      );
      ports = assignedPortsWithDemand.filter(p => portsWithMaintenanceVessels.has(p.code)).map(p => ({ ...p, isAssigned: true }));
      vessels = vesselsWithPositions.filter(v => v.status === 'maintenance' && v.current_port_code && portsWithMaintenanceVessels.has(v.current_port_code));
      logger.debug(`[Harbor Map] Filter: ${filter}, Ports: ${ports.length}, Vessels: ${vessels.length}`);
    } else if (filter === 'my_ports_with_pending_vessels') {
      // Only show assigned ports with vessels in 'pending' or 'delivery' status AND only show those vessels
      const assignedPortsWithDemand = filterAssignedPorts(assignedPorts, allPortsWithDemand);
      const portsWithPendingVessels = new Set(
        vesselsWithPositions.filter(v => (v.status === 'pending' || v.status === 'delivery') && v.current_port_code).map(v => v.current_port_code)
      );
      ports = assignedPortsWithDemand.filter(p => portsWithPendingVessels.has(p.code)).map(p => ({ ...p, isAssigned: true }));
      vessels = vesselsWithPositions.filter(v => (v.status === 'pending' || v.status === 'delivery') && v.current_port_code && portsWithPendingVessels.has(v.current_port_code));
      logger.debug(`[Harbor Map] Filter: ${filter}, Ports: ${ports.length}, Vessels: ${vessels.length}`);
    } else {
      // Show all ports, but merge assigned ports (with correct demand) with all other ports
      const assignedPortsWithDemand = filterAssignedPorts(assignedPorts, allPortsWithDemand);

      // Debug: Log first assigned port to see structure
      if (config.DEBUG_MODE && assignedPortsWithDemand.length > 0) {
        logger.debug(`[Harbor Map] Sample assigned port:`, JSON.stringify(assignedPortsWithDemand[0], null, 2));
      }

      // Create a map of assigned ports by code for quick lookup
      const assignedPortMap = new Map(assignedPortsWithDemand.map(p => [p.code, p]));

      // Merge: use assigned port data if available (has correct demand), otherwise use game/index data
      // Mark assigned ports with isAssigned flag for client-side filtering
      ports = allPortsWithDemand.map(port => {
        const assignedPort = assignedPortMap.get(port.code);
        if (assignedPort) {
          return { ...assignedPort, isAssigned: true }; // Mark as assigned
        }
        return { ...port, isAssigned: false }; // Mark as not assigned
      });

      const assignedCount = ports.filter(p => p.isAssigned === true).length;
      logger.debug(`[Harbor Map] Filter: ${filter}, All ports: ${ports.length}, Assigned ports marked: ${assignedCount}, Assigned ports from API: ${assignedPortsWithDemand.length}`);
    }

    res.json({
      vessels: vessels,
      ports,
      filter
    });
  } catch (error) {
    logger.error('Error fetching harbor map overview:', error);
    res.status(500).json({ error: 'Failed to fetch harbor map data' });
  }
});

/**
 * GET /api/harbor-map/vessel/:vesselId/reachable-ports
 * Returns reachable ports for a specific vessel with demand data
 *
 * Response:
 * {
 *   vessel: { id, name, position, eta, status, ... },
 *   reachablePorts: [{ code, lat, lon, demand, demandLevel, distance, eta }],
 *   route: { path: [{lat, lon}], origin, destination }
 * }
 */
router.get('/vessel/:vesselId/reachable-ports', async (req, res) => {
  try {
    const vesselId = parseInt(req.params.vesselId);

    // Fetch game index (cached) for ports
    const gameIndexData = await getGameIndexCached();
    const allPortsWithDemand = extractPortsFromGameIndex(gameIndexData);

    // Fetch assigned ports (has correct demand data for user's ports)
    const assignedPortsResponse = await gameapi.getAssignedPorts();
    const assignedPorts = assignedPortsResponse?.data?.ports || [];

    // Fetch vessels from dedicated endpoint
    const vesselsResponse = await gameapi.getAllUserVessels();
    const allVessels = vesselsResponse?.data?.user_vessels || [];

    // Find specific vessel
    const vessel = allVessels.find(v => v.id === vesselId);
    if (!vessel) {
      return res.status(404).json({ error: 'Vessel not found' });
    }

    // Aggregate vessel data
    const [vesselWithPosition] = aggregateVesselData([vessel], allPortsWithDemand);

    // Fetch reachable ports from API
    const reachableResponse = await gameapi.getVesselPorts(vesselId);
    const reachablePorts = reachableResponse?.data?.ports || [];

    // Aggregate reachable ports with demand data
    const portsWithDemand = aggregateReachablePorts(
      reachablePorts,
      allPortsWithDemand,
      vessel.capacity_type
    );

    // Extract route if vessel is sailing
    let route = null;
    if (vessel.status === 'enroute' && vessel.active_route?.path) {
      logger.debug(`[Harbor Map] Active route for vessel ${vesselId}:`, JSON.stringify(vessel.active_route, null, 2));

      // Handle reversed routes - if reversed=true, swap origin and destination
      const isReversed = vessel.active_route.reversed === true;
      const actualOrigin = isReversed
        ? (vessel.active_route.destination_port_code || vessel.active_route.destination)
        : (vessel.active_route.origin_port_code || vessel.active_route.origin);
      const actualDestination = isReversed
        ? (vessel.active_route.origin_port_code || vessel.active_route.origin)
        : (vessel.active_route.destination_port_code || vessel.active_route.destination);

      route = {
        path: vessel.active_route.path,
        origin: actualOrigin,
        destination: actualDestination
      };
      logger.debug(`[Harbor Map] Route created (reversed=${isReversed}) with origin: ${route.origin}, destination: ${route.destination}`);
    }

    res.json({
      vessel: vesselWithPosition,
      reachablePorts: portsWithDemand,
      allPorts: allPortsWithDemand, // All ports from game/index (coordinates)
      assignedPorts: assignedPorts, // User's ports with CORRECT demand data
      route
    });
  } catch (error) {
    logger.error(`Error fetching reachable ports for vessel ${req.params.vesselId}:`, error);
    res.status(500).json({ error: 'Failed to fetch reachable ports' });
  }
});

/**
 * GET /api/harbor-map/port/:portCode
 * Returns port details with categorized vessels (in/to/from)
 *
 * Response:
 * {
 *   port: { code, name, lat, lon, demand, demandLevel },
 *   vessels: {
 *     inPort: [{ id, name, position, ... }],
 *     toPort: [{ id, name, position, eta, ... }],
 *     fromPort: [{ id, name, position, eta, ... }]
 *   }
 * }
 */
router.get('/port/:portCode', async (req, res) => {
  try {
    const portCode = req.params.portCode.toLowerCase(); // Port codes are lowercase in game/index

    // Validate portCode to prevent injection attacks
    // Port codes should only contain lowercase letters, numbers, underscores
    if (!/^[a-z0-9_]+$/.test(portCode)) {
      return res.status(400).json({
        error: 'Invalid port code format. Only lowercase letters, numbers, and underscores allowed.'
      });
    }

    // Limit length
    if (portCode.length > 50) {
      return res.status(400).json({ error: 'Port code too long (max 50 characters)' });
    }

    // Fetch game index (cached) for all ports (coordinates/metadata)
    const gameIndexData = await getGameIndexCached();
    const allPortsFromIndex = extractPortsFromGameIndex(gameIndexData);

    // Fetch assigned ports (correct demand data)
    const assignedPortsResponse = await gameapi.getAssignedPorts();
    const assignedPorts = assignedPortsResponse?.data?.ports || [];

    // Try to find port in assigned ports first (has correct demand structure)
    let port = assignedPorts.find(p => p.code === portCode);

    // If not in assigned ports, use game/index data (will have empty demand)
    if (!port) {
      port = allPortsFromIndex.find(p => p.code === portCode);
    }

    if (!port) {
      logger.warn(`Port ${portCode} not found. Assigned: ${assignedPorts.length}, Game Index: ${allPortsFromIndex.length}`);
      return res.status(404).json({
        error: 'Port not found',
        portCode,
        message: `Port ${portCode} not found in game data.`
      });
    }

    logger.debug(`[Harbor Map] Port ${portCode} found in: ${assignedPorts.find(p => p.code === portCode) ? 'assigned-ports' : 'game-index'}`);
    logger.debug(`[Harbor Map] Port demand structure: ${JSON.stringify(port.demand)}`);
    logger.debug(`[Harbor Map] Assigned ports list: ${assignedPorts.map(p => p.code).join(', ')}`);

    // If port has no demand and is in assigned ports, try to find it with alternate matching
    if ((!port.demand || port.demand.length === 0) && assignedPorts.length > 0) {
      logger.debug(`[Harbor Map] Port has no demand, searching assigned ports by partial match...`);
      const alternateMatch = assignedPorts.find(p =>
        p.code.toLowerCase().includes(portCode) ||
        portCode.includes(p.code.toLowerCase())
      );
      if (alternateMatch) {
        logger.debug(`[Harbor Map] Found alternate match: ${alternateMatch.code} with demand: ${JSON.stringify(alternateMatch.demand)}`);
        port = alternateMatch;
      }
    }

    // Fetch vessels from dedicated endpoint
    const vesselsResponse = await gameapi.getAllUserVessels();
    const allVessels = vesselsResponse?.data?.user_vessels || [];

    logger.debug(`[Harbor Map] Fetched ${allVessels.length} vessels from API`);

    // Aggregate vessel data
    const vesselsWithPositions = aggregateVesselData(allVessels, allPortsFromIndex);

    // Categorize vessels by port
    const categorizedVessels = categorizeVesselsByPort(portCode, vesselsWithPositions);

    logger.debug(`[Harbor Map] Port ${portCode} vessels: inPort=${categorizedVessels.inPort.length}, toPort=${categorizedVessels.toPort.length}, fromPort=${categorizedVessels.fromPort.length}`);

    res.json({
      port,
      vessels: categorizedVessels
    });
  } catch (error) {
    logger.error(`Error fetching port data for ${req.params.portCode}:`, error);
    res.status(500).json({ error: 'Failed to fetch port data' });
  }
});

/**
 * GET /api/harbor-map/vessel/:vesselId/history
 * Returns vessel trip history for detail panel
 *
 * Response:
 * {
 *   vessel: { id, name, ... },
 *   history: [{ date, origin, destination, cargo, profit }]
 * }
 */
router.get('/vessel/:vesselId/history', async (req, res) => {
  try {
    const vesselId = parseInt(req.params.vesselId);
    const userId = getUserId();

    logger.debug(`[Harbor Map] Fetching history for vessel ${vesselId}`);

    // Fetch vessel history from API
    const historyResponse = await gameapi.getVesselHistory(vesselId);

    if (!historyResponse?.data?.vessel_history) {
      logger.warn(`[Harbor Map] No history found for vessel ${vesselId}`);
      return res.status(404).json({ error: 'Vessel history not found' });
    }

    logger.debug(`[Harbor Map] Found ${historyResponse.data.vessel_history.length} history entries for vessel ${vesselId}`);

    // Enrich history with harbor fees from our storage
    const enrichedHistory = await enrichHistoryWithFees(userId, historyResponse.data.vessel_history);

    // Transform API response to match frontend expectations
    res.json({
      history: enrichedHistory.map(trip => ({
        date: trip.created_at,
        origin: trip.route_origin,
        destination: trip.route_destination,
        cargo: trip.cargo,
        profit: trip.route_income,
        distance: trip.total_distance,
        fuel_used: trip.fuel_used,
        wear: trip.wear,
        duration: trip.duration,
        harbor_fee: trip.harbor_fee
      }))
    });
  } catch (error) {
    logger.error(`Error fetching vessel history for ${req.params.vesselId}:`, error);
    res.status(500).json({ error: 'Failed to fetch vessel history' });
  }
});

/**
 * POST /api/harbor-map/clear-cache
 * Clears game/index cache to force fresh data
 *
 * Response:
 * { success: true, message: 'Cache cleared' }
 */
router.post('/clear-cache', (req, res) => {
  gameIndexCache = null;
  gameIndexCacheTime = 0;
  logger.info('[Harbor Map] Cache cleared');

  res.json({ success: true, message: 'Cache cleared' });
});

/**
 * POST /api/harbor-map/vessel/:vesselId/history/export
 * Exports vessel history in TXT, CSV, or JSON format
 *
 * Request Body:
 * { format: 'txt' | 'csv' | 'json' }
 *
 * Response:
 * File download with formatted history data
 */
router.post('/vessel/:vesselId/history/export', async (req, res) => {
  try {
    const vesselId = parseInt(req.params.vesselId);
    const format = req.body.format || 'json';

    // Validate format parameter immediately
    if (!['txt', 'csv', 'json'].includes(format)) {
      return res.status(400).json({
        error: 'Invalid format. Must be txt, csv, or json'
      });
    }

    logger.debug(`[Harbor Map] Exporting history for vessel ${vesselId} as ${format}`);

    // Fetch vessel history from API
    const historyResponse = await gameapi.getVesselHistory(vesselId);

    if (!historyResponse?.data?.vessel_history) {
      return res.status(404).json({ error: 'Vessel history not found' });
    }

    const history = historyResponse.data.vessel_history;
    const vessel = historyResponse.data.vessel || { name: `Vessel ${vesselId}` };

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `vessel-history-${vesselId}-${timestamp}.${format}`;

    if (format === 'txt') {
      const content = formatHistoryAsTXT(vessel, history);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else if (format === 'csv') {
      const content = formatHistoryAsCSV(history);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else if (format === 'json') {
      // Add revenue_per_nm to each trip in history
      const enrichedHistory = history.map(trip => {
        const hasLoadedCargo = (
          (trip.cargo?.dry > 0 || trip.cargo?.refrigerated > 0) ||
          (trip.cargo?.fuel > 0 || trip.cargo?.crude_oil > 0)
        );

        let revenuePerNm = null;
        if (hasLoadedCargo && trip.route_income && trip.total_distance && trip.total_distance > 0) {
          revenuePerNm = parseFloat((trip.route_income / trip.total_distance).toFixed(2));
        }

        return {
          ...trip,
          revenue_per_nm: revenuePerNm
        };
      });

      const content = JSON.stringify({
        vessel: {
          id: vesselId,
          name: vessel.name,
          type: vessel.type_name
        },
        exported: new Date().toISOString(),
        total_trips: enrichedHistory.length,
        history: enrichedHistory
      }, null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else {
      return res.status(400).json({ error: 'Invalid format. Must be txt, csv, or json' });
    }

    logger.debug(`[Harbor Map] Exported ${history.length} history entries as ${format}`);
  } catch (error) {
    logger.error(`Error exporting vessel history for ${req.params.vesselId}:`, error);
    res.status(500).json({ error: 'Failed to export vessel history' });
  }
});

/**
 * Formats vessel history as TXT (human-readable)
 */
function formatHistoryAsTXT(vessel, history) {
  let txt = `Vessel Trip History Export\n`;
  txt += `================================\n\n`;
  txt += `Vessel: ${vessel.name}\n`;
  txt += `Type: ${vessel.type_name || 'N/A'}\n`;
  txt += `Total Trips: ${history.length}\n`;
  txt += `Exported: ${new Date().toLocaleString()}\n\n`;
  txt += `================================\n\n`;

  history.forEach((trip, index) => {
    txt += `Trip #${index + 1}\n`;
    txt += `${'─'.repeat(40)}\n`;
    txt += `Date: ${trip.created_at}\n`;
    txt += `Route: ${trip.route_origin} → ${trip.route_destination}\n`;
    txt += `Distance: ${trip.total_distance} NM\n`;
    txt += `Duration: ${trip.duration}\n\n`;

    txt += `Cargo:\n`;
    let hasLoadedCargo = false;
    if (trip.cargo?.dry !== undefined) {
      txt += `  Dry: ${trip.cargo.dry} TEU\n`;
      txt += `  Refrigerated: ${trip.cargo.refrigerated} TEU\n`;
      hasLoadedCargo = (trip.cargo.dry > 0 || trip.cargo.refrigerated > 0);
    } else if (trip.cargo?.fuel !== undefined) {
      txt += `  Fuel: ${trip.cargo.fuel} tons\n`;
      txt += `  Crude Oil: ${trip.cargo.crude_oil} tons\n`;
      hasLoadedCargo = (trip.cargo.fuel > 0 || trip.cargo.crude_oil > 0);
    }
    txt += `\n`;

    txt += `Financials:\n`;
    txt += `  Income: $${trip.route_income.toLocaleString()}\n`;
    txt += `  Fuel Used: ${trip.fuel_used} tons\n`;
    txt += `  Wear: ${trip.wear}%\n`;

    // Calculate revenue per nautical mile if cargo was loaded
    if (hasLoadedCargo && trip.route_income && trip.total_distance && trip.total_distance > 0) {
      const revenuePerNm = (trip.route_income / trip.total_distance).toFixed(2);
      txt += `  Revenue per NM: $${parseFloat(revenuePerNm).toLocaleString()}/nm\n`;
    }

    txt += `\n\n`;
  });

  return txt;
}

/**
 * Formats vessel history as CSV (spreadsheet-compatible)
 */
/**
 * Escape CSV formula injection (=, +, @, - at start of cell)
 * Prefixes dangerous characters with single quote to force text mode in Excel
 * @param {string} value - Value to escape
 * @returns {string} Escaped value safe for CSV
 */
function escapeCSVFormula(value) {
  if (!value) return '';
  const str = String(value);
  // If starts with formula characters, prefix with single quote
  if (/^[=+@\-]/.test(str)) {
    return "'" + str.replace(/"/g, '""'); // Also escape quotes
  }
  return str.replace(/"/g, '""'); // Just escape quotes
}

function formatHistoryAsCSV(history) {
  let csv = 'Date,Origin,Destination,Distance,Duration,Cargo_Dry,Cargo_Ref,Cargo_Fuel,Cargo_Crude,Income,Fuel_Used,Wear,Revenue_Per_NM\n';

  history.forEach(trip => {
    const date = trip.created_at || '';
    const origin = trip.route_origin || '';
    const destination = trip.route_destination || '';
    const distance = trip.total_distance || 0;
    const duration = trip.duration || '';
    const cargoDry = trip.cargo?.dry || '';
    const cargoRef = trip.cargo?.refrigerated || '';
    const cargoFuel = trip.cargo?.fuel || '';
    const cargoCrude = trip.cargo?.crude_oil || '';
    const income = trip.route_income;
    const fuel = trip.fuel_used;
    const wear = trip.wear;

    // Calculate revenue per nautical mile if cargo was loaded
    let revenuePerNm = '';
    const hasLoadedCargo = (
      (trip.cargo?.dry > 0 || trip.cargo?.refrigerated > 0) ||
      (trip.cargo?.fuel > 0 || trip.cargo?.crude_oil > 0)
    );
    if (hasLoadedCargo && income > 0 && distance > 0) {
      revenuePerNm = (income / distance).toFixed(2);
    }

    // Escape string fields to prevent CSV formula injection
    csv += `"${escapeCSVFormula(date)}","${escapeCSVFormula(origin)}","${escapeCSVFormula(destination)}",${distance},"${escapeCSVFormula(duration)}",${cargoDry},${cargoRef},${cargoFuel},${cargoCrude},${income},${fuel},${wear},${revenuePerNm}\n`;
  });

  return csv;
}

/**
 * POST /api/harbor-map/migrate-harbor-fees
 * Migrates harbor fees from audit log to harbor fee storage (one-time migration)
 *
 * Response:
 * { success: true, stats: { total, migrated, skipped } }
 */
router.post('/migrate-harbor-fees', async (req, res) => {
  try {
    const userId = getUserId();

    logger.info(`[Harbor Map] Starting harbor fee migration for user ${userId}`);

    const stats = await migrateHarborFeesForUser(userId);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('[Harbor Map] Harbor fee migration failed:', error);
    res.status(500).json({ error: 'Migration failed', message: error.message });
  }
});

module.exports = router;
