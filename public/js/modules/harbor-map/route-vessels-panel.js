/**
 * @fileoverview Route Vessels Panel Component
 * Shows a list of all vessels on a selected route
 * Clicking a vessel opens the vessel detail panel
 *
 * @module harbor-map/route-vessels-panel
 */

import { getMap, selectVessel } from './map-controller.js';
import { isMobileDevice } from '../utils.js';

/**
 * Shows the route vessels panel with a list of vessels
 * Displays vessel name, status, ETA, and cargo summary
 *
 * @param {string} routeName - Name of the route
 * @param {Array<Object>} vessels - Vessels on this route
 * @returns {void}
 * @example
 * showRoutePanel('Hamburg - New York', vessels);
 */
export function showRoutePanel(routeName, vessels) {
  const panel = document.getElementById('route-vessels-panel');
  if (!panel) {
    console.error('[Route Panel] Panel element not found');
    return;
  }

  // Extract route name from first vessel if routeName is invalid
  if (!routeName || routeName === 'null' || routeName === 'undefined') {
    if (vessels && vessels.length > 0 && vessels[0].route_name) {
      routeName = vessels[0].route_name;
    } else {
      console.error('[Route Panel] Cannot determine route name');
      return;
    }
  }

  console.log(`[Route Panel] Showing panel for route: ${routeName} with ${vessels.length} vessels`);

  // Store vessels for selection
  storeVessels(vessels);

  // Format vessel list
  const vesselListHtml = vessels.length > 0
    ? vessels.map(vessel => `
        <div class="route-vessel-item" data-vessel-id="${vessel.id}" onclick="window.harborMap.selectRouteVessel(${vessel.id})">
          <div class="route-vessel-header">
            <span class="route-vessel-name">${vessel.name}</span>
            <span class="route-vessel-status status-${vessel.status}">${vessel.status}</span>
          </div>
          <div class="route-vessel-details">
            ${vessel.eta !== 'N/A' ? `<div class="route-vessel-eta">⏱️ ETA: ${vessel.eta}</div>` : ''}
            ${vessel.formattedCargo ? `<div class="route-vessel-cargo">📦 ${vessel.formattedCargo}</div>` : ''}
          </div>
        </div>
      `).join('')
    : '<p class="no-data">No vessels found on this route</p>';

  // Render panel content
  panel.innerHTML = `
    <div class="panel-header">
      <h3>🚢 ${routeName}</h3>
      <button class="close-btn" onclick="window.harborMap.closeRoutePanel()">×</button>
    </div>
    <div class="panel-body">
      <div class="route-vessels-count">
        ${vessels.length} vessel${vessels.length !== 1 ? 's' : ''} on route
      </div>
      <div class="route-vessels-list">
        ${vesselListHtml}
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');

  // Enable fullscreen on mobile when panel opens
  if (isMobileDevice()) {
    document.body.classList.add('map-fullscreen');
  }
}

/**
 * Hides the route vessels panel
 *
 * @returns {void}
 * @example
 * hideRoutePanel();
 */
export function hideRoutePanel() {
  const panel = document.getElementById('route-vessels-panel');
  if (!panel) return;

  panel.classList.remove('active');

  // Reset transform if panel was dragged
  panel.style.transform = '';
  panel.style.transition = '';

  // Close weather popup
  const map = getMap();
  if (map) {
    map.closePopup();
  }

  // DON'T remove fullscreen here - only in closeRoutePanel()
  // This allows seamless transitions between panels on mobile

  console.log('[Route Panel] Panel hidden');
}

/**
 * Stores vessels for later selection
 * Called internally by showRoutePanel
 *
 * @param {Array<Object>} vessels - Vessels to store
 * @returns {void}
 */
function storeVessels() {
  // Function exists for potential future use
}

/**
 * Selects a vessel from the route panel and opens its detail panel
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 * @example
 * await selectRouteVessel(1234);
 */
export async function selectRouteVessel(vesselId) {
  console.log(`[Route Panel] Selecting vessel ${vesselId} from route panel`);

  // Use the same selection logic as clicking vessel on map
  // This will: save state, clear markers, show only vessel+route+2 ports, zoom, open panel
  await selectVessel(vesselId);
}

/**
 * Closes the route panel and clears the route filter
 *
 * @returns {void}
 * @example
 * closeRoutePanel();
 */
export async function closeRoutePanel() {
  hideRoutePanel();

  // Clear route filter by setting dropdown to "All Routes"
  const routeSelect = document.getElementById('routeFilterSelect');
  if (routeSelect) {
    routeSelect.value = '';
    // Trigger change event to clear filter
    routeSelect.dispatchEvent(new Event('change'));
  }

  // Remove fullscreen on mobile when explicitly closing panel
  if (isMobileDevice()) {
    document.body.classList.remove('map-fullscreen');

    // Force map invalidate size after fullscreen change
    const { getMap } = await import('./map-controller.js');
    const map = getMap();
    if (map) {
      setTimeout(() => {
        map.invalidateSize();
      }, 100);
    }
  }
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.selectRouteVessel = selectRouteVessel;
window.harborMap.closeRoutePanel = closeRoutePanel;
