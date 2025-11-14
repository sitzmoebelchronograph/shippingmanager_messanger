/**
 * @fileoverview Vessel Detail Panel Component
 * Renders vessel information panel with trip history and actions
 * ONLY renders data - NO data processing
 *
 * @module harbor-map/vessel-panel
 */

import { fetchVesselHistory, exportVesselHistory } from './api-client.js';
import { deselectAll, getMap } from './map-controller.js';
import { isMobileDevice } from '../utils.js';

/**
 * Converts country code to flag emoji
 * @param {string} countryCode - Two-letter country code (e.g., 'US', 'ES')
 * @returns {string} Flag emoji or empty string
 */
function getCountryFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

/**
 * Gets country code for a port from map controller's current ports
 * @param {string} portCode - Port code (e.g., 'hamburg', 'tarragona')
 * @returns {string} Country code or empty string
 */
function getPortCountryCode(portCode) {
  if (!portCode || !window.harborMap) return '';
  try {
    const ports = window.harborMap.getCurrentPorts();
    const port = ports.find(p => p.code === portCode);
    return port?.country || '';
  } catch {
    return '';
  }
}

/**
 * Shows vessel detail panel with vessel information
 * Displays status, cargo, ETA, and loads trip history
 *
 * @param {Object} vessel - Vessel object from backend
 * @returns {Promise<void>}
 * @example
 * await showVesselPanel({ id: 1234, name: 'SS Example', status: 'enroute', ... });
 */
export async function showVesselPanel(vessel) {
  const panel = document.getElementById('vessel-detail-panel');
  if (!panel) return;


  // Helper functions for efficiency classes
  const getCO2Class = (factor) => {
    if (factor < 1.0) return 'vessel-spec-co2-efficient';
    if (factor === 1.0) return 'vessel-spec-co2-standard';
    return 'vessel-spec-co2-inefficient';
  };

  const getFuelClass = (factor) => {
    if (factor < 1.0) return 'vessel-spec-fuel-efficient';
    if (factor === 1.0) return 'vessel-spec-fuel-standard';
    return 'vessel-spec-fuel-inefficient';
  };

  const formatNumber = (num) => Math.floor(num).toLocaleString();

  // Format port name with capital first letter
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return portCode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  };

  // Capacity display (max capacity)
  let capacityDisplay = vessel.formattedCargo || 'N/A';
  if (vessel.capacity_type === 'container' && vessel.capacity_max) {
    const dry = vessel.capacity_max.dry;
    const ref = vessel.capacity_max.refrigerated;
    const total = dry + ref;
    capacityDisplay = `${formatNumber(total)} TEU (${formatNumber(dry)} dry / ${formatNumber(ref)} ref)`;
  } else if (vessel.capacity_type === 'tanker' && vessel.capacity_max) {
    const fuel = vessel.capacity_max.fuel;
    const crude = vessel.capacity_max.crude_oil;
    const maxCapacity = Math.max(fuel, crude);
    capacityDisplay = `${formatNumber(maxCapacity)} bbl (${formatNumber(fuel)} bbl fuel / ${formatNumber(crude)} bbl crude)`;
  }

  // Current cargo loaded (detailed breakdown)
  // API uses 'capacity' for current loaded cargo, 'capacity_max' for maximum capacity
  let loadedCargoDisplay = '<p><strong>Loaded Cargo:</strong> N/A</p>';
  if (vessel.capacity) {
    if (vessel.capacity_type === 'container') {
      const dryLoaded = vessel.capacity.dry;
      const refLoaded = vessel.capacity.refrigerated;
      const dryMax = vessel.capacity_max?.dry;
      const refMax = vessel.capacity_max?.refrigerated;
      const totalLoaded = dryLoaded + refLoaded;
      const totalMax = dryMax + refMax;
      const utilization = totalMax > 0 ? Math.round((totalLoaded / totalMax) * 100) : 0;
      loadedCargoDisplay = `
        <p><strong>Loaded Cargo:</strong></p>
        <p style="margin-left: 10px;">Total: ${formatNumber(totalLoaded)}/${formatNumber(totalMax)} TEU (${utilization}%)</p>
        <p style="margin-left: 10px;">Dry: ${formatNumber(dryLoaded)}/${formatNumber(dryMax)} TEU</p>
        <p style="margin-left: 10px;">Refrigerated: ${formatNumber(refLoaded)}/${formatNumber(refMax)} TEU</p>
      `;
    } else if (vessel.capacity_type === 'tanker') {
      const fuelLoaded = vessel.capacity.fuel;
      const crudeLoaded = vessel.capacity.crude_oil;
      const fuelMax = vessel.capacity_max?.fuel;
      const crudeMax = vessel.capacity_max?.crude_oil;
      const totalLoaded = fuelLoaded + crudeLoaded;
      const totalMax = fuelMax + crudeMax;
      const utilization = totalMax > 0 ? Math.round((totalLoaded / totalMax) * 100) : 0;

      loadedCargoDisplay = `
        <p><strong>Loaded Cargo:</strong></p>
        <p style="margin-left: 10px;">Total: ${formatNumber(totalLoaded)}/${formatNumber(totalMax)} bbl (${utilization}%)</p>
        <p style="margin-left: 10px;">Fuel: ${formatNumber(fuelLoaded)}/${formatNumber(fuelMax)} bbl</p>
        <p style="margin-left: 10px;">Crude Oil: ${formatNumber(crudeLoaded)}/${formatNumber(crudeMax)} bbl</p>
      `;
    }
  }

  // Vessel image URL (cached via backend proxy)
  const imageUrl = vessel.type ? `/api/vessel-image/${vessel.type}` : '';

  // Render vessel full info with collapsible sections
  panel.innerHTML = `
    <div class="panel-header">
      <h3>
        <span id="vessel-name-display-${vessel.id}" class="vessel-name-display">${vessel.name}</span>
        <input
          type="text"
          id="vessel-name-input-${vessel.id}"
          class="vessel-name-input hidden"
          value="${vessel.name.replace(/"/g, '&quot;')}"
          maxlength="30"
          data-vessel-id="${vessel.id}"
        />
        <button
          class="rename-vessel-btn"
          onclick="window.harborMap.startRenameVessel(${vessel.id})"
          title="Rename vessel"
        >✏️</button>
      </h3>
      <button class="close-btn" onclick="window.harborMap.closeVesselPanel()">×</button>
    </div>

    <div class="panel-body">
      ${imageUrl ? `
        <div class="vessel-image-container">
          <img src="${imageUrl}" alt="${vessel.type_name}" class="vessel-image" onerror="this.style.display='none'">
          <div id="vessel-weather-overlay" style="position: absolute; top: 1px; left: 1px; background: rgba(0, 0, 0, 0.185); padding: 3px 5px; border-radius: 3px; font-size: 11px; color: #fff; backdrop-filter: blur(2px);">
            <div style="color: #94a3b8; font-size: 9px;">Loading...</div>
          </div>
        </div>
      ` : ''}

      ${(vessel.status === 'port' || vessel.status === 'anchor') ? `
        <div class="vessel-action-emojis">
          ${vessel.status === 'port' ? `
            <span
              class="action-emoji"
              onclick="window.harborMap.departVessel(${vessel.id})"
              title="Depart vessel from port"
            >🏁</span>
          ` : ''}
          <span
            class="action-emoji"
            onclick="window.harborMap.openRepairDialog(${vessel.id})"
            title="Repair & Drydock - Wear: ${vessel.wear ? parseFloat(vessel.wear).toFixed(1) : 'N/A'}% | Until Drydock: ${formatNumber(vessel.hours_until_check)}h"
          >🔧</span>
          <span
            class="action-emoji"
            onclick="window.harborMap.sellVesselFromPanel(${vessel.id}, '${vessel.name.replace(/'/g, "\\'")}')"
            title="Sell this vessel"
          >💵</span>
        </div>
      ` : ''}

      <div class="vessel-info-section collapsible">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Status & Current Cargo
        </h4>
        <div class="section-content">
          <p><strong>Status:</strong> ${(() => {
            if (vessel.status === 'pending' && vessel.time_arrival && vessel.time_arrival > 0) {
              const remaining = vessel.time_arrival;
              const days = Math.floor(remaining / 86400);
              const hours = Math.floor((remaining % 86400) / 3600);
              const minutes = Math.floor((remaining % 3600) / 60);
              let timeDisplay = '';
              if (days > 0) {
                timeDisplay = `${days}d ${hours}h`;
              } else if (hours > 0) {
                timeDisplay = `${hours}h ${minutes}m`;
              } else {
                timeDisplay = `${minutes}m`;
              }
              return `${vessel.status} (Delivery in: ${timeDisplay})`;
            }
            return vessel.status;
          })()}</p>
          ${vessel.eta !== 'N/A' ? `<p><strong>ETA:</strong> ${vessel.eta}</p>` : ''}
          ${vessel.current_port_code ? `<p><strong>Current Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.current_port_code))} ${formatPortName(vessel.current_port_code)}</p>` : ''}
          ${(() => {
            if (!vessel.time_arrival || vessel.time_arrival <= 0) return '';
            const arrivalDate = new Date(vessel.time_arrival * 1000);
            // If year is 1970, it's invalid (unix epoch default)
            if (arrivalDate.getFullYear() === 1970) {
              return '<p><strong>Last Arrival:</strong> None</p>';
            }
            return `<p><strong>Last Arrival:</strong> ${arrivalDate.toLocaleString()}</p>`;
          })()}
          ${loadedCargoDisplay}
          ${vessel.prices && (vessel.prices.dry || vessel.prices.refrigerated) ? `
            <p><strong>Dry Container Rate:</strong> $${vessel.prices.dry}/TEU</p>
            <p><strong>Refrigerated Rate:</strong> $${vessel.prices.refrigerated}/TEU</p>
          ` : ''}
          ${vessel.prices && (vessel.prices.fuel || vessel.prices.crude_oil) ? `
            <p><strong>Fuel Rate:</strong> $${vessel.prices.fuel}/bbl</p>
            <p><strong>Crude Oil Rate:</strong> $${vessel.prices.crude_oil}/bbl</p>
          ` : ''}
          ${(() => {
            if (vessel.status !== 'enroute' || !vessel.route_distance || !vessel.capacity) return '';

            let totalRevenue = 0;
            let hasLoadedCargo = false;

            if (vessel.capacity_type === 'container' && vessel.capacity && vessel.prices) {
              const dryLoaded = vessel.capacity.dry;
              const refLoaded = vessel.capacity.refrigerated;
              if (dryLoaded > 0 || refLoaded > 0) {
                hasLoadedCargo = true;
                totalRevenue = (dryLoaded * (vessel.prices.dry || 0)) + (refLoaded * (vessel.prices.refrigerated || 0));
              }
            } else if (vessel.capacity_type === 'tanker' && vessel.capacity && vessel.prices) {
              const fuelLoaded = vessel.capacity.fuel;
              const crudeLoaded = vessel.capacity.crude_oil;
              if (fuelLoaded > 0 || crudeLoaded > 0) {
                hasLoadedCargo = true;
                totalRevenue = (fuelLoaded * (vessel.prices.fuel || 0)) + (crudeLoaded * (vessel.prices.crude_oil || 0));
              }
            }

            if (!hasLoadedCargo || totalRevenue === 0) return '';

            const pricePerNm = (totalRevenue / vessel.route_distance).toFixed(2);
            return `<p><strong>Revenue per nm:</strong> $${parseFloat(pricePerNm).toLocaleString()}/nm</p>`;
          })()}
        </div>
      </div>

      <div class="vessel-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Operations & Maintenance
        </h4>
        <div class="section-content">
          <p><strong>Wear:</strong> ${vessel.wear ? parseFloat(vessel.wear).toFixed(2) : 'N/A'}%</p>
          <p><strong>Travelled Hours:</strong> ${formatNumber(vessel.travelled_hours)}h</p>
          <p><strong>Hours Until Maintenance:</strong> ${formatNumber(vessel.hours_until_check)}h</p>
          <p><strong>Service Interval:</strong> ${formatNumber(vessel.hours_between_service)}h</p>
          ${vessel.total_distance_traveled ? `<p><strong>Total Distance:</strong> ${formatNumber(vessel.total_distance_traveled)} nm</p>` : ''}
          ${vessel.time_acquired ? `<p><strong>Acquired:</strong> ${new Date(vessel.time_acquired * 1000).toLocaleDateString()}</p>` : ''}
          ${vessel.maintenance_start_time ? `<p><strong>Maintenance Start:</strong> ${new Date(vessel.maintenance_start_time * 1000).toLocaleString()}</p>` : ''}
          ${vessel.maintenance_end_time ? `<p><strong>Maintenance End:</strong> ${new Date(parseInt(vessel.maintenance_end_time) * 1000).toLocaleString()}</p>` : ''}
          ${vessel.next_route_is_maintenance !== null ? `<p><strong>Next Route Maintenance:</strong> ${vessel.next_route_is_maintenance ? 'Yes' : 'No'}</p>` : ''}
        </div>
      </div>

      ${vessel.status === 'enroute' && (vessel.route_origin || vessel.route_destination || vessel.route_name) ? `
        <div class="vessel-info-section collapsible collapsed">
          <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="toggle-icon">▼</span> Route Details
          </h4>
          <div class="section-content">
            ${vessel.route_name ? `<p><strong>Route Name:</strong> ${vessel.route_name}</p>` : ''}
            ${vessel.route_origin ? `<p><strong>Origin Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.route_origin))} ${formatPortName(vessel.route_origin)}</p>` : ''}
            ${vessel.route_destination ? `<p><strong>Destination Port:</strong> ${getCountryFlag(getPortCountryCode(vessel.route_destination))} ${formatPortName(vessel.route_destination)}</p>` : ''}
            ${vessel.route_distance ? `<p><strong>Distance:</strong> ${formatNumber(vessel.route_distance)} nm</p>` : ''}
            ${vessel.route_speed ? `<p><strong>Speed:</strong> ${vessel.route_speed} kn</p>` : ''}
            ${vessel.route_guards !== undefined && vessel.route_guards >= 0 ? `<p><strong>Guards:</strong> ${vessel.route_guards}</p>` : ''}
            ${vessel.active_route?.canal_fee !== undefined && vessel.active_route.canal_fee !== null ? `<p><strong>Canal Fee:</strong> $${formatNumber(vessel.active_route.canal_fee)}</p>` : ''}
            ${vessel.route_end_time ? `<p><strong>Arrival Time:</strong> ${new Date(vessel.route_end_time * 1000).toLocaleString()}</p>` : ''}
            ${vessel.route_dry_operation !== undefined ? `<p><strong>Dry Operation:</strong> ${vessel.route_dry_operation ? 'Yes' : 'No'}</p>` : ''}
            ${vessel.active_route?.loading_time !== undefined ? `<p><strong>Loading Time:</strong> ${vessel.active_route.loading_time}h</p>` : ''}
            ${vessel.active_route?.unloading_time !== undefined ? `<p><strong>Unloading Time:</strong> ${vessel.active_route.unloading_time}h</p>` : ''}
            ${vessel.active_route?.duration !== undefined && vessel.active_route.duration !== null ? `<p><strong>Route Duration:</strong> ${formatNumber(vessel.active_route.duration)}h</p>` : ''}
            ${vessel.routes && vessel.routes[0]?.hijacking_risk !== undefined ? `<p><strong>Hijacking Risk:</strong> ${vessel.routes[0].hijacking_risk}%</p>` : ''}
          </div>
        </div>
      ` : ''}

      <div class="vessel-info-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Vessel Specifications
        </h4>
        <div class="section-content">
          <div class="vessel-specs">
            <div class="vessel-spec"><strong>Type:</strong> ${vessel.type_name || 'N/A'}</div>
            <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
            <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(vessel.range)} nm</div>
            <div class="vessel-spec ${getCO2Class(vessel.co2_factor)}"><strong>CO2 Factor:</strong> ${vessel.co2_factor || 'N/A'}</div>
            <div class="vessel-spec ${getFuelClass(vessel.fuel_factor)}"><strong>Fuel Factor:</strong> ${vessel.fuel_factor || 'N/A'}</div>
            <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(vessel.fuel_capacity)} t</div>
            <div class="vessel-spec"><strong>Service:</strong> ${vessel.hours_between_service || 'N/A'}h</div>
            <div class="vessel-spec"><strong>Engine:</strong> ${vessel.engine_type || 'N/A'} (${formatNumber(vessel.kw)} kW)</div>
            <div class="vessel-spec"><strong>Speed:</strong> ${vessel.max_speed || 'N/A'} kn</div>
            <div class="vessel-spec"><strong>Year:</strong> ${vessel.year || 'N/A'}</div>
            <div class="vessel-spec"><strong>Length:</strong> ${vessel.length || 'N/A'} m</div>
            ${vessel.width && vessel.width !== 0 ? `<div class="vessel-spec"><strong>Width:</strong> ${vessel.width} m</div>` : ''}
            <div class="vessel-spec"><strong>IMO:</strong> ${vessel.imo || 'N/A'}</div>
            <div class="vessel-spec"><strong>MMSI:</strong> ${vessel.mmsi || 'N/A'}</div>
            ${vessel.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
            ${vessel.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${vessel.antifouling}</div>` : ''}
            ${vessel.bulbous_bow ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🌊 Bulbous Bow:</strong> equipped</div>' : ''}
            ${vessel.enhanced_thrusters ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🔧 Enhanced Thrusters:</strong> equipped</div>' : ''}
            ${vessel.is_parked ? '<div class="vessel-spec vessel-spec-fullwidth"><strong>🅿️ Parked:</strong> vessel is parked</div>' : ''}
            ${vessel.perks ? `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${vessel.perks}</div>` : ''}
          </div>
        </div>
      </div>


      <div class="vessel-info-section vessel-history-section collapsible collapsed">
        <h4 class="section-toggle" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span> Trip History
          <div class="history-export-dropdown" style="margin-left: auto; position: relative;">
            <button class="history-export-btn" onclick="event.stopPropagation(); window.harborMap.toggleExportMenu()" title="Export History">💾</button>
            <div id="historyExportMenu" class="history-export-menu hidden">
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('txt')">📄 TXT</button>
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('csv')">📊 CSV</button>
              <button class="history-export-menu-item" onclick="event.stopPropagation(); window.harborMap.exportHistoryFormat('json')">🗂️ JSON</button>
            </div>
          </div>
        </h4>
        <div class="section-content">
          <div id="vessel-history-loading">Loading history...</div>
          <div id="vessel-history-content"></div>
        </div>
      </div>
    </div>
  `;

  // Show panel
  panel.classList.add('active');

  // Load weather data for vessel location (if vessel has location)
  if (vessel.position && vessel.position.lat && vessel.position.lon && imageUrl) {
    loadVesselWeather(parseFloat(vessel.position.lat), parseFloat(vessel.position.lon));
  }

  // Enable fullscreen on mobile when panel opens
  const isMobile = isMobileDevice();
  console.log('[Vessel Panel] isMobile:', isMobile, 'window.innerWidth:', window.innerWidth);
  if (isMobile) {
    document.body.classList.add('map-fullscreen');
    console.log('[Vessel Panel] Added map-fullscreen class to body. Classes:', document.body.classList.toString());
  }

  // Setup export menu close handler (like logbook)
  setTimeout(() => {
    document.addEventListener('click', closeExportMenuOnClickOutside);
  }, 100);

  // Setup infinite scroll for history
  setupInfiniteScroll(panel);

  // Load trip history
  await loadVesselHistory(vessel.id);
}

/**
 * Closes export menu when clicking outside
 * @param {Event} e - Click event
 */
function closeExportMenuOnClickOutside(e) {
  const menu = document.getElementById('historyExportMenu');
  const exportBtn = document.querySelector('.history-export-btn');

  if (menu && !menu.classList.contains('hidden') && exportBtn && !exportBtn.contains(e.target) && !menu.contains(e.target)) {
    menu.classList.add('hidden');
  }
}

/**
 * Sets up infinite scroll for vessel history
 * Automatically loads more trips when scrolling near bottom
 * @param {HTMLElement} panel - The vessel detail panel
 */
function setupInfiniteScroll(panel) {
  // Wait for history section to be rendered
  setTimeout(() => {
    const historySection = panel.querySelector('.vessel-history-section .section-content');
    if (!historySection) {
      console.warn('[Vessel Panel] History section not found for infinite scroll');
      return;
    }

    historySection.addEventListener('scroll', () => {
      // Check if user scrolled near bottom (within 100px)
      const scrolledToBottom = historySection.scrollHeight - historySection.scrollTop - historySection.clientHeight < 100;

      if (scrolledToBottom && displayedHistoryCount < allHistoryData.length) {
        console.log(`[Vessel Panel] Loading more history... (${displayedHistoryCount}/${allHistoryData.length})`);
        renderHistoryPage();
      }
    });
  }, 100);
}

/**
 * Hides vessel detail panel
 *
 * @returns {void}
 * @example
 * hideVesselPanel();
 */
export function hideVesselPanel() {
  const panel = document.getElementById('vessel-detail-panel');
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

  // DON'T remove fullscreen here - only in closeVesselPanel()
  // This allows seamless transitions between panels on mobile
}

// Store current vessel ID and history data for pagination
let currentVesselId = null;
let allHistoryData = [];
let displayedHistoryCount = 0;
const HISTORY_PAGE_SIZE = 3;

/**
 * Loads and renders vessel trip history
 * Displays past trips with origin, destination, cargo, profit
 *
 * @param {number} vesselId - Vessel ID
 * @returns {Promise<void>}
 * @example
 * await loadVesselHistory(1234);
 */
async function loadVesselHistory(vesselId) {
  const loadingEl = document.getElementById('vessel-history-loading');
  const contentEl = document.getElementById('vessel-history-content');

  if (!loadingEl || !contentEl) return;

  // Store vessel ID for export
  currentVesselId = vesselId;

  try {
    const data = await fetchVesselHistory(vesselId);

    // Hide loading
    loadingEl.style.display = 'none';

    // Render history
    if (!data.history || data.history.length === 0) {
      contentEl.innerHTML = '<p class="no-data">No trip history available</p>';
      return;
    }

    // Store full history (reverse to show newest first)
    allHistoryData = data.history.reverse();
    displayedHistoryCount = 0;

    // Render first 3 trips
    renderHistoryPage();

  } catch (error) {
    loadingEl.style.display = 'none';
    contentEl.innerHTML = '<p class="error">Failed to load trip history</p>';
    console.error('Error loading vessel history:', error);
  }
}

/**
 * Renders a page of history entries
 * Shows HISTORY_PAGE_SIZE trips at a time
 */
function renderHistoryPage() {
  const contentEl = document.getElementById('vessel-history-content');

  if (!contentEl) return;

  // Format cargo display as HTML list
  const formatCargo = (cargo) => {
    if (!cargo) return '<ul class="cargo-list"><li>N/A</li></ul>';
    if (typeof cargo === 'string') return `<ul class="cargo-list"><li>${cargo}</li></ul>`;

    // Container cargo
    if (cargo.dry !== undefined || cargo.refrigerated !== undefined) {
      const dry = cargo.dry;
      const ref = cargo.refrigerated;
      return `
        <ul class="cargo-list">
          <li>Dry: ${dry} TEU</li>
          <li>Ref: ${ref} TEU</li>
        </ul>
      `;
    }

    // Tanker cargo
    if (cargo.fuel !== undefined || cargo.crude_oil !== undefined) {
      const fuel = cargo.fuel;
      const crude = cargo.crude_oil;
      let items = [];
      if (fuel > 0) items.push(`<li>Fuel: ${fuel.toLocaleString()} bbl</li>`);
      if (crude > 0) items.push(`<li>Crude: ${crude.toLocaleString()} bbl</li>`);
      return `<ul class="cargo-list">${items.join('')}</ul>`;
    }

    return `<ul class="cargo-list"><li>${JSON.stringify(cargo)}</li></ul>`;
  };

  // Format duration (seconds to human readable)
  const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  // Get next page of trips
  const nextTrips = allHistoryData.slice(displayedHistoryCount, displayedHistoryCount + HISTORY_PAGE_SIZE);
  displayedHistoryCount += nextTrips.length;

  // Format port name with capital first letter
  const formatPortName = (portCode) => {
    if (!portCode) return 'N/A';
    return portCode.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  };

  // Render trips
  const historyHtml = nextTrips.map(trip => {
    // Calculate revenue per nautical mile if we have cargo and profit
    let revenuePerNm = null;
    if (trip.profit && trip.distance && trip.cargo) {
      // Check if cargo was actually loaded (not empty)
      let hasLoadedCargo = false;
      if (typeof trip.cargo === 'object' && trip.cargo !== null) {
        if (trip.cargo.dry > 0 || trip.cargo.refrigerated > 0 || trip.cargo.fuel > 0 || trip.cargo.crude_oil > 0) {
          hasLoadedCargo = true;
        }
      }

      if (hasLoadedCargo) {
        // Convert km to nautical miles (1 nm = 1.852 km)
        const distanceNm = trip.distance / 1.852;
        revenuePerNm = (trip.profit / distanceNm).toFixed(2);
      }
    }

    // Check if it's a service trip (no cargo loaded)
    const isServiceTrip = !trip.profit && trip.cargo &&
      (trip.cargo.dry === 0 && trip.cargo.refrigerated === 0 &&
       trip.cargo.fuel === 0 && trip.cargo.crude_oil === 0);

    // Check if harbor fee is high (threshold: $50,000)
    const harborFeeThreshold = 50000;
    const isHighHarborFee = trip.harbor_fee && trip.harbor_fee > harborFeeThreshold;
    const entryClass = isHighHarborFee ? 'history-entry high-harbor-fee' : 'history-entry';

    return `
    <div class="${entryClass}">
      <div class="history-route">
        <strong>${formatPortName(trip.origin)}</strong> → <strong>${formatPortName(trip.destination)}</strong>
      </div>
      <div class="history-details">
        <div class="history-row">
          <span>Date: ${trip.date ? new Date(trip.date).toLocaleString() : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span class="cargo-label">Cargo:</span>
        </div>
        <div class="history-row cargo-row">
          ${formatCargo(trip.cargo)}
        </div>
        <div class="history-row">
          <span>Income: ${isServiceTrip ? 'Service Trip' : (trip.profit ? '$' + trip.profit.toLocaleString() : '$N/A')}</span>
        </div>
        ${trip.harbor_fee ? `
        <div class="history-row${isHighHarborFee ? ' high-fee-text' : ''}">
          <span>Harbor Fee: $${trip.harbor_fee.toLocaleString()}</span>
        </div>
        ` : ''}
        <div class="history-row">
          <span>Fuel: ${trip.fuel_used ? Math.round(trip.fuel_used / 1000).toLocaleString() + ' t' : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>Distance: ${trip.distance ? trip.distance.toLocaleString() + ' km' : 'N/A'}</span>
        </div>
        <div class="history-row">
          <span>Duration: ${formatDuration(trip.duration)}</span>
        </div>
        <div class="history-row">
          <span>Wear: ${trip.wear ? trip.wear.toFixed(2) + '%' : 'N/A'}</span>
        </div>
        ${revenuePerNm ? `
        <div class="history-row">
          <span>Revenue/nm: $${parseFloat(revenuePerNm).toLocaleString()}/nm</span>
        </div>
        ` : ''}
      </div>
    </div>
    `;
  }).join('');

  // Append to existing content (infinite scroll)
  contentEl.innerHTML += historyHtml;
}

/**
 * Closes vessel panel and returns to overview
 *
 * @returns {Promise<void>}
 * @example
 * await closeVesselPanel();
 */
export async function closeVesselPanel() {
  hideVesselPanel();

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

  await deselectAll();
}

/**
 * Departs vessel using existing depart API
 *
 * @param {number} vesselId - Vessel ID to depart
 * @returns {Promise<void>}
 * @example
 * await departVessel(1234);
 */
export async function departVessel(vesselId) {
  try {
    // Import departVessels from api module
    const { departVessels } = await import('../api.js');

    console.log(`[Vessel Panel] Departing vessel ${vesselId}...`);

    const result = await departVessels([vesselId]);

    if (result.success) {
      console.log('[Vessel Panel] Vessel departed successfully');

      // Update vessel count in header
      if (window.updateVesselCount) {
        await window.updateVesselCount();
      }

      // Wait longer for server to process the departure and update status
      console.log('[Vessel Panel] Waiting for server to process departure...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get updated vessel data with retry logic (fetches fresh data from server)
      if (window.harborMap && window.harborMap.getVesselById) {
        let updatedVessel = null;
        let attempts = 0;
        const maxAttempts = 3;

        // Retry getting vessel data until status changes or max attempts reached
        while (attempts < maxAttempts) {
          updatedVessel = await window.harborMap.getVesselById(vesselId, true); // skipCache = true

          if (updatedVessel && updatedVessel.status !== 'port') {
            console.log('[Vessel Panel] Vessel status updated to:', updatedVessel.status);
            break;
          }

          attempts++;
          if (attempts < maxAttempts) {
            console.log(`[Vessel Panel] Status still 'port', retrying (${attempts}/${maxAttempts})...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Next iteration will fetch fresh data from server
          }
        }

        if (updatedVessel) {
          console.log('[Vessel Panel] Vessel data updated, final status:', updatedVessel.status);

          // Re-select the vessel to update both panel AND marker/tooltip on map
          if (window.harborMap && window.harborMap.selectVesselFromMap) {
            await window.harborMap.selectVesselFromMap(vesselId);
            console.log('[Vessel Panel] Panel and map marker updated with new status');
          }
        } else {
          console.warn('[Vessel Panel] Could not find vessel after departure:', vesselId);
        }
      }
    } else {
      console.error('[Vessel Panel] Departure failed:', result);
      alert(`Failed to depart vessel: ${result.message || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('[Vessel Panel] Departure error:', error);
    alert(`Error departing vessel: ${error.message}`);
  }
}


/**
 * Toggle export menu visibility
 */
export function toggleExportMenu() {
  const menu = document.getElementById('historyExportMenu');
  if (menu) {
    menu.classList.toggle('hidden');
  }
}

/**
 * Export vessel history in specified format
 * Uses backend export endpoint (like autopilot logbook)
 *
 * @param {string} format - 'txt', 'csv', or 'json'
 */
export async function exportHistoryFormat(format) {
  const menu = document.getElementById('historyExportMenu');
  if (menu) {
    menu.classList.add('hidden');
  }

  if (!currentVesselId) {
    alert('No vessel selected');
    return;
  }

  if (!allHistoryData || allHistoryData.length === 0) {
    alert('No history data to export');
    return;
  }

  try {
    console.log(`[Vessel Panel] Exporting history for vessel ${currentVesselId} as ${format}`);

    // Fetch export from backend
    const content = await exportVesselHistory(currentVesselId, format);

    // Determine file extension and MIME type
    let mimeType, extension;
    if (format === 'txt') {
      mimeType = 'text/plain';
      extension = 'txt';
    } else if (format === 'csv') {
      mimeType = 'text/csv';
      extension = 'csv';
    } else if (format === 'json') {
      mimeType = 'application/json';
      extension = 'json';
    }

    // Trigger download
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vessel-history-${currentVesselId}-${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[Vessel Panel] Export successful: ${allHistoryData.length} entries as ${format.toUpperCase()}`);
  } catch (error) {
    console.error('[Vessel Panel] Export failed:', error);
    alert('Export failed. Please try again.');
  }
}

/**
 * Sells a vessel from the vessel panel with confirmation dialog
 * Fetches actual sell price from API before showing confirmation
 *
 * @param {number} vesselId - Vessel ID to sell
 * @param {string} vesselName - Vessel name for display
 * @returns {Promise<void>}
 */
export async function sellVesselFromPanel(vesselId, vesselName) {
  try {
    // Import dialog and utils
    const { showConfirmDialog } = await import('../ui-dialogs.js');
    const { showSideNotification, formatNumber } = await import('../utils.js');

    // Get actual sell price from API
    const priceResponse = await fetch(window.apiUrl('/api/vessel/get-sell-price'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_id: vesselId })
    });

    if (!priceResponse.ok) {
      const errorText = await priceResponse.text();
      console.error('[Vessel Panel] Sell price API error:', errorText);
      throw new Error(`Failed to get sell price: ${priceResponse.status} ${priceResponse.statusText}`);
    }

    const priceData = await priceResponse.json();
    console.log('[Vessel Panel] Sell price response:', priceData);

    if (!priceData.data?.selling_price && priceData.data?.selling_price !== 0) {
      throw new Error(`API did not return selling_price. Response: ${JSON.stringify(priceData)}`);
    }

    const sellPrice = priceData.data.selling_price;
    const originalPrice = priceData.data.original_price;

    // Show confirmation dialog with custom formatting
    const confirmed = await showConfirmDialog({
      title: `Vessel ${vesselName}`,
      message: `
        <div style="text-align: center; line-height: 1.8;">
          <div style="color: #9ca3af; font-size: 14px; margin-bottom: 8px;">
            Original Price: $${formatNumber(originalPrice)}
          </div>
          <div style="color: #6b7280; margin-bottom: 8px;">
            ━━━━━━━━━━━━━━━━━━━━━━
          </div>
          <div style="color: #10b981; font-size: 16px; font-weight: 600;">
            Sell Price: $${formatNumber(sellPrice)}
          </div>
        </div>
      `,
      confirmText: 'Sell'
    });

    if (!confirmed) return;

    // Sell vessel via API
    const response = await fetch(window.apiUrl('/api/vessel/sell-vessels'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: [vesselId] })
    });

    if (!response.ok) throw new Error('Failed to sell vessel');

    await response.json();

    showSideNotification(`✅ Sold ${vesselName} for $${formatNumber(sellPrice)}`, 'success');

    // Close panel and reload overview
    await closeVesselPanel();

    // Update vessel count badge
    if (window.updateVesselCount) {
      await window.updateVesselCount();
    }
  } catch (error) {
    console.error('[Vessel Panel] Sell error:', error);
    const errorMsg = error.message || error.toString() || 'Unknown error';
    alert(`Error selling vessel: ${errorMsg}`);
  }
}

/**
 * Opens repair & drydock dialog for a specific vessel
 * @param {number} vesselId - Vessel ID
 */
async function openRepairDialog(vesselId) {
  const settings = window.settings || {};

  // Import openRepairAndDrydockDialog from vessel-management
  if (window.openRepairAndDrydockDialog) {
    await window.openRepairAndDrydockDialog(settings, vesselId);
  } else {
    showSideNotification('Repair dialog not available', 'error');
  }
}

/**
 * Start editing vessel name - switches to input mode
 * @param {number} vesselId - Vessel ID to rename
 */
export function startRenameVessel(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  // Hide display, show input
  displaySpan.classList.add('hidden');
  inputField.classList.remove('hidden');
  inputField.focus();
  inputField.select();

  // Save on Enter key
  inputField.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await saveVesselRename(vesselId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelVesselRename(vesselId);
    }
  });

  // Save on blur (clicking outside)
  inputField.addEventListener('blur', async () => {
    await saveVesselRename(vesselId);
  }, { once: true });
}

/**
 * Cancel vessel rename - restore display mode
 * @param {number} vesselId - Vessel ID
 */
function cancelVesselRename(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  // Restore original value
  inputField.value = displaySpan.textContent;

  // Show display, hide input
  displaySpan.classList.remove('hidden');
  inputField.classList.add('hidden');
}

/**
 * Save vessel rename - call API and update display
 * @param {number} vesselId - Vessel ID to rename
 */
async function saveVesselRename(vesselId) {
  const displaySpan = document.getElementById(`vessel-name-display-${vesselId}`);
  const inputField = document.getElementById(`vessel-name-input-${vesselId}`);

  if (!displaySpan || !inputField) return;

  const currentName = displaySpan.textContent;
  const newName = inputField.value.trim();

  // Validate length
  if (newName.length < 2 || newName.length > 30) {
    const { showSideNotification } = await import('../utils.js');
    showSideNotification('Vessel name must be between 2 and 30 characters', 'error', 4000);
    // Restore original value
    inputField.value = currentName;
    cancelVesselRename(vesselId);
    return;
  }

  // Same name - no change needed
  if (newName === currentName) {
    cancelVesselRename(vesselId);
    return;
  }

  try {
    // Call backend API
    const response = await fetch('/api/vessel/rename-vessel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_id: vesselId, name: newName })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to rename vessel');
    }

    // Check if API returned success
    if (data.success === true || data.data?.success === true) {
      const { showSideNotification } = await import('../utils.js');
      showSideNotification('Saved', 'success', 2000);

      // Trigger full Harbor Map refresh to update all markers and data
      const { refreshHarborMap } = await import('./map-controller.js');
      await refreshHarborMap();

      // Re-select the vessel to show updated panel
      const { selectVessel } = await import('./map-controller.js');
      await selectVessel(vesselId);
    } else {
      throw new Error('Rename failed');
    }
  } catch (error) {
    console.error('[Vessel Rename] Error:', error);
    const { showSideNotification } = await import('../utils.js');
    showSideNotification(error.message || 'Failed to rename vessel', 'error', 4000);
    // Restore original value on error
    inputField.value = currentName;
    cancelVesselRename(vesselId);
  }
}

/**
 * Loads and displays weather data for vessel location
 * Fetches weather from Open-Meteo API and renders in overlay on vessel image
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<void>}
 */
async function loadVesselWeather(lat, lon) {
  const weatherOverlay = document.getElementById('vessel-weather-overlay');
  if (!weatherOverlay) return;

  try {
    // Check if weather data is enabled in settings
    const settings = window.getSettings ? window.getSettings() : {};
    if (settings.enableWeatherData === false) {
      weatherOverlay.style.display = 'none';
      return;
    }

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current_weather=true`;
    const response = await fetch(weatherUrl);
    const data = await response.json();

    if (!data.current_weather) {
      throw new Error('No weather data available');
    }

    const weather = data.current_weather;

    // Weather code to emoji mapping
    const weatherEmoji = {
      0: '☀️',    // Clear sky
      1: '🌤️',   // Mainly clear
      2: '⛅',    // Partly cloudy
      3: '☁️',    // Overcast
      45: '🌫️',  // Fog
      48: '🌫️',  // Depositing rime fog
      51: '🌧️',  // Drizzle light
      53: '🌧️',  // Drizzle moderate
      55: '🌧️',  // Drizzle dense
      61: '🌧️',  // Rain slight
      63: '🌧️',  // Rain moderate
      65: '🌧️',  // Rain heavy
      71: '🌨️',  // Snow fall slight
      73: '🌨️',  // Snow fall moderate
      75: '🌨️',  // Snow fall heavy
      77: '❄️',   // Snow grains
      80: '🌦️',  // Rain showers slight
      81: '🌦️',  // Rain showers moderate
      82: '🌦️',  // Rain showers violent
      85: '🌨️',  // Snow showers slight
      86: '🌨️',  // Snow showers heavy
      95: '⛈️',   // Thunderstorm
      96: '⛈️',   // Thunderstorm with hail
      99: '⛈️'    // Thunderstorm with heavy hail
    };

    const icon = weatherEmoji[weather.weathercode] || '🌤️';
    const temp = weather.temperature.toFixed(1);
    const wind = weather.windspeed.toFixed(0);

    // Render compact weather display
    weatherOverlay.innerHTML = `
      <div style="display: flex; align-items: center; gap: 4px;">
        <span style="font-size: 16px;">${icon}</span>
        <div style="line-height: 1.1;">
          <div style="font-weight: 600; font-size: 10px;">${temp}°C</div>
          <div style="font-size: 8px; opacity: 0.8;">💨 ${wind} km/h</div>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('[Vessel Panel] Failed to fetch weather:', error);
    weatherOverlay.innerHTML = '<div style="color: #ef4444; font-size: 10px;">Weather unavailable</div>';
  }
}

// Expose functions to window for onclick handlers
window.harborMap = window.harborMap || {};
window.harborMap.closeVesselPanel = closeVesselPanel;
window.harborMap.departVessel = departVessel;
window.harborMap.sellVesselFromPanel = sellVesselFromPanel;
window.harborMap.openRepairDialog = openRepairDialog;
window.harborMap.toggleExportMenu = toggleExportMenu;
window.harborMap.exportHistoryFormat = exportHistoryFormat;
window.harborMap.startRenameVessel = startRenameVessel;
