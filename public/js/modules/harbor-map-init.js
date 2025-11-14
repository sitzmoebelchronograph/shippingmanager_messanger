/**
 * @fileoverview Harbor Map Initialization Module
 * Wires up harbor map functionality with event listeners
 * Exports initialization function to be called from script.js
 *
 * @module harbor-map-init
 */

import { initMap, loadOverview, updateWeatherDataSetting } from './harbor-map/map-controller.js';
import { prefetchHarborMapData, invalidateOverviewCache } from './harbor-map/api-client.js';
import { initializeMapIconBar } from './map-icon-bar.js';

let mapInitialized = false;
let autoUpdateInterval = null;

/**
 * Pre-loads harbor map data for instant opening
 * Call this during app initialization
 *
 * @returns {Promise<void>}
 */
export async function preloadHarborMapData() {
  // Invalidate old cache (might contain filtered data from old version)
  invalidateOverviewCache();

  // Always fetch ALL data - filtering happens client-side
  await prefetchHarborMapData('all_ports');
}

// Rate limiting for Harbor Map refresh
let lastRefreshTime = 0;
const REFRESH_COOLDOWN = 30000; // 30 seconds

/**
 * Refreshes harbor map if open (called from external update routines)
 * This is called by vessel-management.js when vessel data is updated
 * ONLY refreshes if no detail panel is open (to avoid disrupting user)
 * Rate limited: 30s cooldown between refreshes
 *
 * @returns {Promise<void>}
 */
export async function refreshHarborMapIfOpen() {
  try {
    // Rate limiting check
    const now = Date.now();
    const timeSinceLastRefresh = now - lastRefreshTime;

    if (timeSinceLastRefresh < REFRESH_COOLDOWN) {
      const remainingSeconds = Math.floor((REFRESH_COOLDOWN - timeSinceLastRefresh) / 1000);
      console.log(`[Harbor Map] Skipping refresh (cooldown active, ${remainingSeconds}s remaining)`);
      return;
    }

    // Check if Harbor Map tab is active
    const harborMapCanvas = document.getElementById('harborMapCanvas');
    const isMapVisible = harborMapCanvas && harborMapCanvas.offsetParent !== null;

    if (!isMapVisible) {
      // Map tab is not active - skip update entirely to save resources
      return;
    }

    // Map is visible - update cache (always fetch ALL data)
    await prefetchHarborMapData('all_ports');

    // Map is open - check if panels are open
    const vesselPanel = document.getElementById('vessel-detail-panel');
    const portPanel = document.getElementById('port-detail-panel');
    const isVesselPanelOpen = vesselPanel?.classList.contains('active');
    const isPortPanelOpen = portPanel?.classList.contains('active');

    if (isVesselPanelOpen) {
      // Vessel panel open - cache already updated, don't refresh display (would disrupt user)
      console.log('[Harbor Map] Cache updated (vessel panel open, skipping display refresh)');
    } else if (isPortPanelOpen) {
      // Port panel open - refresh port panel to show updated vessel lists
      const { selectPort, getSelectedPortCode } = await import('./harbor-map/map-controller.js');
      const currentPortCode = getSelectedPortCode();
      if (currentPortCode) {
        await selectPort(currentPortCode);
        console.log('[Harbor Map] Port panel refreshed with new vessel data');
      }
    } else {
      // No panel open - safe to refresh display
      await loadOverview();

      // Force map size recalculation (important for mobile/fullscreen transitions)
      const { getMap } = await import('./harbor-map/map-controller.js');
      const map = getMap();
      if (map) {
        map.invalidateSize();
      }

      console.log('[Harbor Map] Map refreshed with new vessel data');
    }

    // Update last refresh timestamp
    lastRefreshTime = Date.now();
  } catch (error) {
    console.error('[Harbor Map] Refresh failed:', error);
  }
}

/**
 * Starts auto-update interval for harbor map data (25 seconds)
 * DEPRECATED: Now uses vessel-management.js update routine instead
 *
 * @returns {void}
 */
export function startHarborMapAutoUpdate() {
  console.log('[Harbor Map] Auto-update is now handled by vessel-management.js');
  // No longer needed - we piggyback on existing vessel updates
}

/**
 * Stops auto-update interval
 *
 * @returns {void}
 */
export function stopHarborMapAutoUpdate() {
  if (autoUpdateInterval) {
    clearInterval(autoUpdateInterval);
    autoUpdateInterval = null;
    console.log('[Harbor Map] Auto-update stopped');
  }
}

/**
 * Initializes harbor map as main content (not overlay)
 * Called once on DOMContentLoaded
 *
 * @returns {Promise<void>}
 * @example
 * await initHarborMap();
 */
export async function initHarborMap() {
  const mapCanvas = document.getElementById('harborMapCanvas');

  if (!mapCanvas) {
    console.error('Harbor map canvas not found in DOM');
    return;
  }

  // Initialize map immediately (main content, not overlay)
  if (!mapInitialized) {
    initMap('harborMapCanvas');
    mapInitialized = true;
    console.log('Harbor map initialized as main content');
  }

  // Initialize floating icon bar
  initializeMapIconBar();

  // Load data
  await loadOverview();
}

/**
 * Opens harbor map (legacy function, no longer needed)
 * Map is now always visible as main content
 *
 * @returns {Promise<void>}
 * @deprecated Map is now main content, not an overlay
 */
export async function openHarborMap() {
  console.log('[Harbor Map] openHarborMap() called but map is now main content (always visible)');
}

/**
 * Closes harbor map (legacy function, no longer needed)
 * Map is now always visible as main content
 *
 * @returns {Promise<void>}
 * @deprecated Map is now main content, not an overlay
 */
export async function closeHarborMap() {
  console.log('[Harbor Map] closeHarborMap() called but map is now main content (always visible)');
}

/**
 * Reloads the harbor map to apply setting changes
 * Only reloads if map is currently open
 *
 * @returns {Promise<void>}
 */
export async function reloadMap() {
  const overlay = document.getElementById('harborMapOverlay');
  if (!overlay) return;

  const isMapOpen = !overlay.classList.contains('hidden');

  if (!isMapOpen) {
    console.log('[Harbor Map] Map is closed, no reload needed');
    return;
  }

  console.log('[Harbor Map] Reloading map to apply settings...');

  // Force re-initialization on next open
  mapInitialized = false;

  // Close and reopen
  await closeHarborMap();
  await openHarborMap();
}

/**
 * Wrapper to select vessel from map popup button
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 */
async function selectVesselFromMap(vesselId) {
  const { selectVessel } = await import('./harbor-map/map-controller.js');
  await selectVessel(vesselId);
}

/**
 * Gets vessel by ID (exposed for vessel panel updates)
 */
async function getVesselByIdWrapper(vesselId, skipCache = false) {
  const { getVesselById } = await import('./harbor-map/map-controller.js');
  return await getVesselById(vesselId, skipCache);
}

/**
 * Updates vessel marker (exposed for vessel panel updates)
 */
async function updateVesselMarkerWrapper(vesselId) {
  const { updateVesselMarker } = await import('./harbor-map/map-controller.js');
  return await updateVesselMarker(vesselId);
}

/**
 * Departs vessel from panel (exposed for HTML onclick)
 */
async function departVesselWrapper(vesselId) {
  const { departVessel } = await import('./harbor-map/vessel-panel.js');
  return await departVessel(vesselId);
}

/**
 * Sells vessel from panel (exposed for HTML onclick)
 */
async function sellVesselFromPanelWrapper(vesselId, vesselName) {
  const { sellVesselFromPanel } = await import('./harbor-map/vessel-panel.js');
  return await sellVesselFromPanel(vesselId, vesselName);
}

// Expose to window for external access
window.openHarborMap = openHarborMap;
window.closeHarborMap = closeHarborMap;
window.harborMap = window.harborMap || {};
window.harborMap.selectVesselFromMap = selectVesselFromMap;
window.harborMap.refreshIfOpen = refreshHarborMapIfOpen;
window.harborMap.reloadMap = reloadMap;
window.harborMap.updateWeatherDataSetting = updateWeatherDataSetting;
window.harborMap.getVesselById = getVesselByIdWrapper;
window.harborMap.updateVesselMarker = updateVesselMarkerWrapper;
window.harborMap.departVessel = departVesselWrapper;
window.harborMap.sellVesselFromPanel = sellVesselFromPanelWrapper;
