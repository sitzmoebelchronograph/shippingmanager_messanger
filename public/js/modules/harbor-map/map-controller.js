/**
 * @fileoverview Harbor Map Controller
 * Handles Leaflet.js map initialization, rendering, and user interactions
 * ONLY renders data - NO data processing (all logic in backend)
 *
 * @module harbor-map/map-controller
 */

import { fetchHarborMapOverview, fetchVesselReachablePorts, getCachedOverview } from './api-client.js';
import { showVesselPanel, hideVesselPanel } from './vessel-panel.js';
import { showPortPanel, hidePortPanel } from './port-panel.js';
import { hideRoutePanel } from './route-vessels-panel.js';
import { initializePanelDrag } from './panel-drag.js';
import { filterVessels, filterPorts, getVesselFilterOptions, getPortFilterOptions } from './filters.js';
import { showSideNotification, isMobileDevice } from '../utils.js';

// Map instance
let map = null;

/**
 * Returns the map instance for use in other modules
 * @returns {L.Map|null} The Leaflet map instance
 */
export function getMap() {
  return map;
}

// Layer groups
let vesselLayer = null;
let portLayer = null;
let routeLayer = null;
let weatherLayer = null;

// Marker cluster groups
let vesselClusterGroup = null; // For vessels enroute
let portLocationClusterGroup = null; // For ports + vessels in port (combined to prevent overlap)

// Current state
let currentPortFilter = localStorage.getItem('harborMapPortFilter') || 'my_ports'; // Port filter
let currentVesselFilter = localStorage.getItem('harborMapVesselFilter') || 'all_vessels'; // Vessel filter
let selectedVesselId = null;
let selectedPortCode = null;
let currentMapStyle = localStorage.getItem('harborMapStyle') || 'dark'; // 'standard', 'dark', or 'satellite'
let weatherEnabled = localStorage.getItem('harborMapWeather') === 'true' || false;
let weatherType = localStorage.getItem('harborMapWeatherType') || 'off'; // 'off', 'rain', 'cloud'

// Raw data (unfiltered - loaded once from API)
let rawVessels = [];
let rawPorts = [];

// Weather control reference
let weatherControl = null;

// Environmental Layer - Rotating button (off -> wind -> clouds -> temperature -> off)
let currentEnvLayer = localStorage.getItem('harborMapEnvLayer') || 'off'; // 'off', 'wind', 'clouds', 'temperature'
let envLayer = null;
let envLayerControl = null;

// POI Layer - Rotating button (off -> museums -> wrecks -> off)
// Note: POI layer planned but not implemented yet

// Current data (for route filtering)
let currentVessels = [];
let currentPorts = [];
let currentRouteFilter = localStorage.getItem('harborMapRouteFilter') || null; // null = show all, string = show specific route

/**
 * Gets current ports data
 * @returns {Array<Object>} Current ports array
 */
export function getCurrentPorts() {
  return currentPorts;
}

// Previous state (for restoration when panel closes)
let previousMapState = {
  vessels: [],
  ports: [],
  zoom: null,
  center: null
};

// Tile layers
let currentTileLayer = null;
const tileLayers = {
  standard: {
    name: 'Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors'
  },
  dark: {
    name: 'Dark Mode',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO'
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri'
  }
};

/**
 * Gets vessel type from capacity_type field
 *
 * @param {string} capacityType - Capacity type ('container' or 'tanker')
 * @returns {string} - 'container', 'tanker', or 'unknown'
 */
function getVesselType(capacityType) {
  if (!capacityType) return 'unknown';
  const lower = capacityType.toLowerCase();
  if (lower === 'container') return 'container';
  if (lower === 'tanker') return 'tanker';
  return 'unknown';
}

/**
 * Creates vessel icon with type and status classes
 *
 * @param {string} status - Vessel status ('enroute', 'port', 'anchor')
 * @param {string} vesselType - Vessel type ('container', 'tanker', 'unknown')
 * @param {number} heading - Vessel heading in degrees (0-360), optional
 * @returns {L.DivIcon} Leaflet icon
 */
function createVesselIcon(status, vesselType, heading = 0) {
  const statusClass = status === 'enroute' ? 'sailing' : status;
  const typeClass = vesselType !== 'unknown' ? vesselType : '';
  const className = `vessel-marker ${statusClass} ${typeClass}`.trim();

  // Apply rotation to triangle
  const rotation = heading ? `transform: rotate(${heading}deg);` : '';

  return L.divIcon({
    className,
    html: `<div class="vessel-icon" style="${rotation}"></div>`,
    iconSize: [12, 16],
    iconAnchor: [6, 8]
  });
}

/**
 * Calculates heading from two coordinates
 *
 * @param {Object} from - {lat, lon}
 * @param {Object} to - {lat, lon}
 * @returns {number} Heading in degrees
 */
function calculateHeading(from, to) {
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const dLon = (to.lon - from.lon) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let heading = Math.atan2(y, x) * 180 / Math.PI;
  heading = (heading + 360) % 360; // Normalize to 0-360

  return heading;
}

const portIcons = {
  default: L.divIcon({ className: 'port-marker', html: '<div class="port-icon">⚓</div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
  origin: L.divIcon({ className: 'port-marker origin', html: '<div class="port-icon">🔴</div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
  destination: L.divIcon({ className: 'port-marker destination', html: '<div class="port-icon">🟢</div>', iconSize: [12, 12], iconAnchor: [6, 6] })
};

/**
 * Initializes Leaflet map with OpenStreetMap tiles
 * Sets up layer groups and marker clusters
 *
 * @param {string} containerId - HTML element ID for map container
 * @returns {void}
 * @example
 * initMap('harbor-map-container');
 */
export function initMap(containerId) {
  // Initialize map centered on northern hemisphere
  map = L.map(containerId, {
    center: [20, 0], // Center on northern hemisphere (20° North, 0° longitude)
    zoom: 1.50,
    minZoom: 1.50, // Minimum zoom = initial zoom (can't zoom out further)
    maxZoom: 18,
    zoomDelta: 0.1, // Zoom in 0.1 steps instead of 1.0
    zoomSnap: 0.1, // Allow fractional zoom levels (0.1 precision)
    wheelPxPerZoomLevel: 120, // Mouse wheel sensitivity (higher = slower zooming)
    scrollWheelZoom: true, // Enable scroll wheel zoom
    attributionControl: false, // Disable attribution control
    worldCopyJump: true // Enable world wrapping (jump to copy when panning)
  });

  // Set maxBounds AFTER initialization to avoid Leaflet warning
  map.setMaxBounds([[-90, -180], [90, 180]]);
  map.options.maxBoundsViscosity = 0.8; // Allow some dragging beyond bounds when panel is open

  // Add saved tile layer (or default to dark)
  currentTileLayer = L.tileLayer(tileLayers[currentMapStyle].url, {
    maxZoom: 19
  }).addTo(map);

  console.log(`[Harbor Map] Initialized with saved style: ${currentMapStyle}`);

  // Set map container background color based on theme
  const mapContainer = map.getContainer();
  const backgroundColor = currentMapStyle === 'standard' ? '#e0e0e0' : '#1f1f1f';
  mapContainer.style.backgroundColor = backgroundColor;

  // Add mobile class to overlay for mobile-specific styling
  const isMobile = isMobileDevice();
  if (isMobile) {
    const overlay = document.querySelector('.harbor-map-overlay');
    if (overlay) {
      overlay.classList.add('mobile-view');
      console.log('[Harbor Map] Mobile view detected - applying mobile layout');
    }
  }

  // Initialize layer groups
  vesselLayer = L.layerGroup().addTo(map);
  portLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  // Initialize marker cluster groups with custom icons
  vesselClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 15,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    iconCreateFunction: function(cluster) {
      const markers = cluster.getAllChildMarkers();
      let containerCount = 0;
      let tankerCount = 0;

      // Count vessel types in cluster
      markers.forEach(marker => {
        const className = marker.options.icon.options.className;
        if (className.includes('container')) {
          containerCount++;
        } else if (className.includes('tanker')) {
          tankerCount++;
        }
      });

      const total = markers.length;

      // Calculate mixed color based on composition (pastel colors)
      let bgColor;
      if (containerCount === total) {
        bgColor = '#fde68a'; // Pastel yellow (all containers)
      } else if (tankerCount === total) {
        bgColor = '#fdba74'; // Pastel orange (all tankers)
      } else {
        // Mixed cluster - blend colors
        const containerRatio = containerCount / total;
        const tankerRatio = tankerCount / total;

        if (containerRatio > tankerRatio) {
          bgColor = '#fcd34d'; // Light yellow-orange (more containers)
        } else if (tankerRatio > containerRatio) {
          bgColor = '#fda874'; // Light orange-yellow (more tankers)
        } else {
          bgColor = '#fbbf72'; // Balanced pastel mix
        }
      }

      return L.divIcon({
        html: `<div style="background-color: ${bgColor}; opacity: 0.85; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #78350f; font-weight: 600; font-size: 10px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 2px 8px rgba(0,0,0,0.15);">${total}</div>`,
        className: 'vessel-cluster-icon',
        iconSize: L.point(20, 20)
      });
    }
  });

  // Combined cluster group for ports + vessels in port (to prevent overlap)
  portLocationClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 30, // Larger radius to catch overlapping port + vessel markers
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    iconCreateFunction: function(cluster) {
      // Show combined count - blue color like normal port clusters
      const count = cluster.getChildCount();
      return L.divIcon({
        html: `<div style="background-color: #bfdbfe; opacity: 0.85; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #1e3a8a; font-weight: 600; font-size: 10px; border: 1px solid rgba(255,255,255,0.4); box-shadow: 0 2px 8px rgba(0,0,0,0.15);">${count}</div>`,
        className: 'port-location-cluster-icon',
        iconSize: L.point(20, 20)
      });
    }
  });

  vesselLayer.addLayer(vesselClusterGroup);
  portLayer.addLayer(portLocationClusterGroup); // Use combined cluster instead of portClusterGroup

  // Add custom controls
  addCustomControls();

  // Initialize weather layer and dblclick handler only if enableWeatherData is enabled
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.enableWeatherData === true) {
    // Initialize weather layer with saved type
    if (weatherType !== 'off') {
      toggleWeatherLayer(weatherType);
    }

    // Add long-press handler for weather info
    let longPressTimer = null;
    let longPressLatlng = null;
    const LONG_PRESS_DELAY = 700; // milliseconds

    const handleMouseDown = (e) => {
      longPressLatlng = e.latlng;
      longPressTimer = setTimeout(async () => {
        await showWeatherInfo(longPressLatlng);
        longPressTimer = null;
      }, LONG_PRESS_DELAY);
    };

    const handleMouseUp = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const handleMouseMove = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    map.on('mousedown', handleMouseDown);
    map.on('mouseup', handleMouseUp);
    map.on('mousemove', handleMouseMove);
  }

  // Initialize panel dragging
  initializePanelDrag();
  console.log('[Harbor Map] Panel drag initialized');
}

/**
 * Shows weather info popup for a location
 *
 * @param {L.LatLng} latlng - Location coordinates
 * @param {string} tooltipContent - Optional tooltip content to show above weather
 * @returns {Promise<void>}
 */
async function showWeatherInfo(latlng, tooltipContent = null) {
  try {
    // Check if weather data is enabled in settings
    const settings = window.getSettings ? window.getSettings() : {};
    if (settings.enableWeatherData === false) {
      return; // Weather data disabled, do nothing
    }

    // Show loading popup
    const loadingPopup = L.popup()
      .setLatLng(latlng)
      .setContent('<div style="padding: 8px; text-align: center;">🌤️ Loading weather...</div>')
      .openOn(map);

    // Fetch location name and weather data in parallel
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latlng.lat.toFixed(4)}&longitude=${latlng.lng.toFixed(4)}&current_weather=true`;
    const geocodeUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latlng.lat.toFixed(4)}&lon=${latlng.lng.toFixed(4)}&zoom=10`;

    const [weatherResponse, geocodeResponse] = await Promise.all([
      fetch(weatherUrl),
      fetch(geocodeUrl, { headers: { 'User-Agent': 'ShippingManager' } })
    ]);

    const data = await weatherResponse.json();

    if (!data.current_weather) {
      throw new Error('No weather data available');
    }

    const weather = data.current_weather;

    // Try to get location name from geocoding
    let locationName = null;
    try {
      const geocodeData = await geocodeResponse.json();
      // Try to get city, town, village, or fallback
      locationName = geocodeData.address?.city ||
                    geocodeData.address?.town ||
                    geocodeData.address?.village ||
                    geocodeData.address?.county ||
                    null;
    } catch {
      // Geocoding failed, will show coordinates instead
    }

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

    // Theme-based colors - more transparency for better map visibility
    const isDark = currentMapStyle === 'dark' || currentMapStyle === 'satellite';
    const bgColor = isDark ? 'rgba(31, 31, 31, 0.7)' : 'rgba(255, 255, 255, 0.75)';
    const borderColor = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)';
    const boxShadow = isDark ? '0 2px 8px rgba(0, 0, 0, 0.3)' : '0 2px 8px rgba(0, 0, 0, 0.15)';
    const textColor = isDark ? '#e5e7eb' : '#1f2937';
    const tempColor = isDark ? '#60a5fa' : '#2563eb';

    // Display location name if available, otherwise coordinates
    const locationText = locationName
      ? `📍 ${locationName}`
      : `📍 ${latlng.lat.toFixed(2)}, ${latlng.lng.toFixed(2)}`;

    // Create combined popup with tooltip content and weather
    const tooltipSection = tooltipContent ? `
      <div style="padding: 6px 8px; font-size: 11px; line-height: 1.4; background: ${bgColor}; color: ${textColor}; border: 1px solid ${borderColor}; border-radius: 4px; box-shadow: ${boxShadow}; margin-bottom: 4px;">
        ${tooltipContent}
      </div>
    ` : '';

    const content = `
      <div>
        ${tooltipSection}
        <div style="padding: 4px 8px; font-size: 11px; line-height: 1.4; background: ${bgColor}; color: ${textColor}; border: 1px solid ${borderColor}; border-radius: 4px; box-shadow: ${boxShadow};">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 18px;">${icon}</span>
            <div>
              <div style="font-size: 14px; font-weight: 600; color: ${tempColor};">${temp}°C</div>
              <div style="font-size: 9px; opacity: 0.7;">💨 ${wind} km/h</div>
              <div style="font-size: 8px; opacity: 0.6; margin-top: 2px;">${locationText}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Update popup with weather data
    loadingPopup.setContent(content);
  } catch (error) {
    console.error('[Harbor Map] Failed to fetch weather:', error);
    L.popup()
      .setLatLng(latlng)
      .setContent('<div style="padding: 8px; text-align: center; color: #ef4444;">❌ Weather unavailable</div>')
      .openOn(map);
  }
}

/**
 * Toggles weather overlay (Rain Radar or Cloud Cover)
 *
 * @param {string} type - Weather layer type: 'off', 'rain', 'cloud'
 * @returns {void}
 */
function toggleWeatherLayer(type) {
  // Remove existing weather layer
  if (weatherLayer) {
    map.removeLayer(weatherLayer);
    weatherLayer = null;
  }

  weatherType = type;
  localStorage.setItem('harborMapWeatherType', type);

  if (type === 'rain') {
    // Rain Radar (RainViewer)
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000 / 600) * 600;

    weatherLayer = L.tileLayer(
      `https://tilecache.rainviewer.com/v2/radar/${timestamp}/512/{z}/{x}/{y}/2/1_1.png`,
      {
        opacity: 0.6,
        attribution: '© RainViewer',
        maxZoom: 18
      }
    );

    weatherLayer.addTo(map);
    weatherEnabled = true;
    localStorage.setItem('harborMapWeather', 'true');
    console.log('[Harbor Map] Rain radar enabled');
  } else {
    // Off
    weatherEnabled = false;
    localStorage.setItem('harborMapWeather', 'false');
    console.log('[Harbor Map] Weather overlay disabled');
  }
}

/**
 * Adds custom Leaflet controls (filter, refresh)
 * Positioned in top-right corner below zoom controls
 */
function addCustomControls() {
  // Vessel Filter Control
  const VesselFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-filter');

      const options = getVesselFilterOptions();
      const optionsHTML = options.map(opt =>
        `<option value="${opt.value}" ${opt.value === currentVesselFilter ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

      container.innerHTML = `
        <select id="vesselFilterSelect" title="Vessel Filter">
          ${optionsHTML}
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      container.querySelector('select').addEventListener('change', async (e) => {
        await setVesselFilter(e.target.value);
      });

      return container;
    }
  });

  // Port Filter Control
  const PortFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-filter');

      const options = getPortFilterOptions();
      const optionsHTML = options.map(opt =>
        `<option value="${opt.value}" ${opt.value === currentPortFilter ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

      container.innerHTML = `
        <select id="portFilterSelect" title="Port Filter">
          ${optionsHTML}
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      container.querySelector('select').addEventListener('change', async (e) => {
        await setPortFilter(e.target.value);
      });

      return container;
    }
  });

  // Refresh Control
  const RefreshControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-refresh');
      container.innerHTML = '<button title="Refresh">🔄</button>';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.querySelector('button').addEventListener('click', async () => {
        const { clearHarborMapCache } = await import('./api-client.js');
        await clearHarborMapCache();
        await loadOverview();
      });

      return container;
    }
  });

  // Map Style Toggle Control (cycles through: standard -> dark -> satellite -> standard)
  const MapStyleControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom map-style-toggle');

      // Emoji map for each style
      const styleEmojis = {
        'standard': '🗺️',
        'dark': '🌙',
        'satellite': '🛰️'
      };

      container.innerHTML = styleEmojis[currentMapStyle];
      container.title = 'Map Style';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener - cycle through styles
      container.addEventListener('click', () => {
        const styles = ['standard', 'dark', 'satellite'];
        const currentIndex = styles.indexOf(currentMapStyle);
        const nextIndex = (currentIndex + 1) % styles.length;
        const nextStyle = styles[nextIndex];

        changeTileLayer(nextStyle);
        container.innerHTML = styleEmojis[nextStyle];

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Map Style';
        }, 100);
      });

      return container;
    }
  });

  // Route Filter Control
  const RouteFilterControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-route-filter');
      container.innerHTML = `
        <select id="routeFilterSelect">
          <option value="">All Routes</option>
        </select>
      `;

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add change listener
      const selectElement = container.querySelector('select');
      selectElement.addEventListener('change', async (e) => {
        await setRouteFilter(e.target.value);
      });

      return container;
    }
  });

  // Fullscreen Control
  const FullscreenControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-fullscreen');
      container.innerHTML = '<button title="Fullscreen">⛶</button>';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.querySelector('button').addEventListener('click', () => {
        const mapWrapper = document.querySelector('.chat-area-wrapper');
        const button = container.querySelector('button');

        if (!mapWrapper) {
          console.error('[Harbor Map] Cannot find map wrapper for fullscreen');
          return;
        }

        if (mapWrapper.classList.contains('fullscreen')) {
          // Exit fullscreen
          mapWrapper.classList.remove('fullscreen');
          button.innerHTML = '⛶';
          button.title = 'Fullscreen';
        } else {
          // Enter fullscreen
          mapWrapper.classList.add('fullscreen');
          button.innerHTML = '⛶';
          button.title = 'Exit Fullscreen';
        }

        // Invalidate map size after transition
        setTimeout(() => {
          map.invalidateSize();
        }, 300);
      });

      return container;
    }
  });

  // Weather Control (Rain Radar Toggle)
  const WeatherControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom weather-toggle');

      const updateWeatherButton = () => {
        container.style.position = 'relative';

        if (weatherEnabled) {
          container.innerHTML = '🌧️';
        } else {
          container.innerHTML = '🌧️';
        }

        // Add or update strike-through line
        let strikeLine = container.querySelector('.weather-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'weather-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = weatherEnabled ? 'none' : 'block';
      };

      updateWeatherButton();
      container.title = 'Rain Radar';

      // Prevent map click propagation
      L.DomEvent.disableClickPropagation(container);

      // Add click listener
      container.addEventListener('click', () => {
        weatherEnabled = !weatherEnabled;

        if (weatherEnabled) {
          toggleWeatherLayer('rain');
        } else {
          toggleWeatherLayer('off');
        }

        updateWeatherButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Rain Radar';
        }, 100);
      });

      return container;
    }
  });

  // Environmental Layer Control - Rotating button (off -> wind -> clouds -> temperature -> off)
  const EnvironmentalLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom env-layer-toggle');

      // Function to update button appearance
      const updateButton = (resetTooltip = false) => {
        let tooltipText = '';

        switch(currentEnvLayer) {
          case 'wind':
            container.innerHTML = '💨';
            container.style.opacity = '1';
            break;
          case 'clouds':
            container.innerHTML = '☁️';
            container.style.opacity = '1';
            break;
          case 'temperature':
            container.innerHTML = '🌡️';
            container.style.opacity = '1';
            break;
          default: // 'off'
            container.innerHTML = '🌍';
            container.style.opacity = '0.5';
            tooltipText = 'Environmental Layers';
            break;
        }

        // Update tooltip: remove old one, then set new one after delay
        if (resetTooltip) {
          container.removeAttribute('title');
          setTimeout(() => {
            if (tooltipText) {
              container.title = tooltipText;
            }
          }, 100);
        } else {
          if (tooltipText) {
            container.title = tooltipText;
          } else {
            container.removeAttribute('title');
          }
        }
      };

      // Function to start cloud layer (static for now)
      const startCloudAnimation = () => {
        stopCloudAnimation(); // Clean up any existing animation

        console.log('[Environmental] Adding cloud layer...');

        // Use single OWM clouds layer with higher opacity for better visibility
        const opacity = currentMapStyle === 'standard' ? 0.7 : 0.5;
        envLayer = L.OWM.clouds({showLegend: false, opacity: opacity});
        envLayer.addTo(map);
      };

      // Function to stop cloud layer
      const stopCloudAnimation = () => {
        if (envLayer && map.hasLayer(envLayer)) {
          map.removeLayer(envLayer);
          envLayer = null;
        }

        console.log('[Environmental] Removed cloud layer');
      };

      // Function to switch to next layer
      const switchEnvLayer = (newLayer) => {
        // Stop cloud animation if switching away from clouds
        if (currentEnvLayer === 'clouds') {
          stopCloudAnimation();
        }

        // Remove old layer (non-animated)
        if (envLayer) {
          map.removeLayer(envLayer);
          envLayer = null;
        }

        // Add new layer
        if (newLayer !== 'off') {
          console.log(`[Environmental] Switching to ${newLayer} layer...`);
          switch(newLayer) {
            case 'wind':
              // Higher opacity in standard mode for better visibility
              const windOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
              envLayer = L.OWM.wind({opacity: windOpacity});
              envLayer.addTo(map);
              break;
            case 'clouds':
              // Use animated clouds
              startCloudAnimation();
              break;
            case 'temperature':
              // Higher opacity in standard mode for better visibility
              const tempOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
              envLayer = L.OWM.temperature({showLegend: true, opacity: tempOpacity});
              envLayer.addTo(map);
              break;
          }
        }

        currentEnvLayer = newLayer;
        localStorage.setItem('harborMapEnvLayer', newLayer);
        updateButton(true); // Reset tooltip after click
      };

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', () => {
        // Rotate through: off -> wind -> clouds -> temperature -> off
        const nextLayer = {
          'off': 'wind',
          'wind': 'clouds',
          'clouds': 'temperature',
          'temperature': 'off'
        }[currentEnvLayer] || 'wind';

        switchEnvLayer(nextLayer);
      });

      updateButton();
      return container;
    }
  });

  // Zoom Level Display Control
  const ZoomDisplayControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom zoom-display');
      container.style.cssText = `
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        pointer-events: none;
      `;

      const updateZoom = () => {
        const zoom = map.getZoom();
        container.innerHTML = `Zoom: ${zoom.toFixed(1)}`;
      };

      updateZoom();
      map.on('zoomend', updateZoom);

      return container;
    }
  });

  // Museums Layer Control - Simple toggle button (no zoom limit - not many museums)
  let museumsEnabled = localStorage.getItem('harborMapMuseumsEnabled') === 'true';
  let museumsMarkerLayer = null;

  const MuseumsLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom museums-toggle');

      const updateButton = () => {
        container.style.position = 'relative';
        container.innerHTML = '🏛️';

        let strikeLine = container.querySelector('.museums-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'museums-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = museumsEnabled ? 'none' : 'block';
      };

      updateButton();
      container.title = 'Maritime Museums';

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', async () => {
        museumsEnabled = !museumsEnabled;
        localStorage.setItem('harborMapMuseumsEnabled', museumsEnabled);

        if (museumsEnabled) {
          try {
            // Load all museums (no bbox - there aren't many)
            const response = await fetch(window.apiUrl(`/api/poi/museums`));
            if (!response.ok) return;

            const data = await response.json();
            const museums = data.museums || [];

            if (museums.length > 0) {
              museumsMarkerLayer = L.layerGroup();

              museums.forEach(poi => {
                if (!poi.lat || !poi.lon) return;

                const name = poi.tags?.name || 'Unknown Museum';
                const openingHours = poi.tags?.opening_hours || '';
                const website = poi.tags?.website || '';
                const wikipedia = poi.tags?.wikipedia || '';

                const icon = L.divIcon({
                  className: 'poi-marker',
                  html: `<div style="font-size: 20px;">🏛️</div>`,
                  iconSize: [30, 30],
                  iconAnchor: [15, 15]
                });

                const marker = L.marker([poi.lat, poi.lon], { icon });

                let tooltipContent = `<strong>${name}</strong>`;
                if (openingHours) tooltipContent += `<br>🕒 ${openingHours}`;

                marker.bindTooltip(tooltipContent, {
                  direction: 'auto',
                  offset: [0, -10]
                });

                marker.on('click', async (e) => {
                  marker.closeTooltip();
                  let popupContent = `<strong>${name}</strong><br>Museum`;
                  if (openingHours) popupContent += `<br>🕒 ${openingHours}`;
                  if (website) popupContent += `<br>🌐 <a href="${website}" target="_blank" style="color: #4a9eff;">Website</a>`;
                  if (wikipedia) {
                    const wikiUrl = wikipedia.startsWith('http') ? wikipedia : `https://en.wikipedia.org/wiki/${wikipedia}`;
                    popupContent += `<br>📖 <a href="${wikiUrl}" target="_blank" style="color: #4a9eff;">Wikipedia</a>`;
                  }
                  await showWeatherInfo(e.latlng, popupContent);
                });

                museumsMarkerLayer.addLayer(marker);
              });

              museumsMarkerLayer.addTo(map);
            }
          } catch (error) {
            console.error('[Museums] Load error:', error);
          }
        } else {
          if (museumsMarkerLayer && map.hasLayer(museumsMarkerLayer)) {
            map.removeLayer(museumsMarkerLayer);
            museumsMarkerLayer = null;
          }
        }

        updateButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Maritime Museums';
        }, 100);
      });

      if (museumsEnabled) {
        container.click();
      }

      return container;
    }
  });

  // Wrecks Layer Control - Simple toggle button
  let wrecksEnabled = localStorage.getItem('harborMapWrecksEnabled') === 'true';
  let wrecksMarkerLayer = null;
  let wrecksLoadTimeout = null; // Debounce timer for loading wrecks
  let lastWrecksBounds = null; // Track last loaded bounds to avoid duplicate loads

  // Function to load wrecks for current map view
  const loadWrecksForCurrentView = async () => {
    const currentZoom = map.getZoom();

    // Only load if enabled and zoom >= 5
    if (!wrecksEnabled || currentZoom < 5) {
      return;
    }

    try {
      // Get current map bounds
      const bounds = map.getBounds();

      // Check if bounds changed significantly (more than 10% movement)
      if (lastWrecksBounds) {
        const lastSouth = lastWrecksBounds.getSouth();
        const lastWest = lastWrecksBounds.getWest();
        const lastNorth = lastWrecksBounds.getNorth();
        const lastEast = lastWrecksBounds.getEast();

        const currentSouth = bounds.getSouth();
        const currentWest = bounds.getWest();
        const currentNorth = bounds.getNorth();
        const currentEast = bounds.getEast();

        // Calculate how much the view has moved (as percentage of view size)
        const latDiff = lastNorth - lastSouth;
        const lngDiff = lastEast - lastWest;

        const southMove = Math.abs(currentSouth - lastSouth) / latDiff;
        const westMove = Math.abs(currentWest - lastWest) / lngDiff;
        const northMove = Math.abs(currentNorth - lastNorth) / latDiff;
        const eastMove = Math.abs(currentEast - lastEast) / lngDiff;

        const maxMove = Math.max(southMove, westMove, northMove, eastMove);

        // If view moved less than 10%, skip reload
        if (maxMove < 0.1) {
          console.log(`[Wrecks] Skipping reload - view moved only ${(maxMove * 100).toFixed(1)}%`);
          return;
        }
      }

      // Remove old markers
      if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
        map.removeLayer(wrecksMarkerLayer);
        wrecksMarkerLayer = null;
      }

      const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
      console.log(`[Wrecks] Loading with bbox: ${bbox}`);

      const response = await fetch(window.apiUrl(`/api/poi/wrecks?bbox=${encodeURIComponent(bbox)}`));
      if (!response.ok) return;

      const data = await response.json();
      const wrecks = data.wrecks || [];
      console.log(`[Wrecks] API returned ${wrecks.length} wrecks for bbox`);

      if (wrecks.length > 0) {
        wrecksMarkerLayer = L.layerGroup();

        wrecks.forEach(poi => {
          if (!poi.lat || !poi.lon) return;

          const name = poi.tags?.name || 'Unknown Wreck';
          const dateSunk = poi.tags?.['wreck:date_sunk'] || poi.tags?.['wreck:year_sunk'] || '';
          const depthMetres = poi.tags?.['wreck:depth_metres'] || '';
          const cargo = poi.tags?.['wreck:cargo'] || '';
          const wreckType = poi.tags?.['wreck:type'] || '';
          const visibleAtLowTide = poi.tags?.['wreck:visible_at_low_tide'] || '';
          const description = poi.tags?.description || '';
          const website = poi.tags?.website || '';
          const wikipedia = poi.tags?.wikipedia || '';

          const icon = L.divIcon({
            className: 'poi-marker',
            html: `<div style="font-size: 20px;">🪦</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          });

          const marker = L.marker([poi.lat, poi.lon], { icon });

          let tooltipContent = `<strong>${name}</strong><br>Shipwreck`;
          if (dateSunk) tooltipContent += `<br>⚓ Sunk: ${dateSunk}`;
          if (depthMetres) tooltipContent += `<br>🌊 Depth: ${depthMetres}m`;

          marker.bindTooltip(tooltipContent, {
            direction: 'auto',
            offset: [0, -10]
          });

          marker.on('click', async (e) => {
            marker.closeTooltip();
            let popupContent = `<strong>${name}</strong>`;
            if (wreckType) popupContent += ` (${wreckType})`;
            if (!wreckType) popupContent += `<br>Shipwreck`;

            if (description) popupContent += `<br><br>${description}`;
            if (dateSunk) popupContent += `<br><br>⚓ Sunk: ${dateSunk}`;
            if (cargo) popupContent += `<br>📦 Cargo: ${cargo}`;
            if (depthMetres) popupContent += `<br>🌊 Depth: ${depthMetres} metres`;
            if (visibleAtLowTide) popupContent += `<br>🌅 Visible at low tide: ${visibleAtLowTide}`;

            if (website) popupContent += `<br><br>🌐 <a href="${website}" target="_blank" style="color: #4a9eff;">Website</a>`;
            if (wikipedia) {
              const wikiUrl = wikipedia.startsWith('http') ? wikipedia : `https://en.wikipedia.org/wiki/${wikipedia}`;
              popupContent += `<br>📖 <a href="${wikiUrl}" target="_blank" style="color: #4a9eff;">Wikipedia</a>`;
            }
            await showWeatherInfo(e.latlng, popupContent);
          });

          wrecksMarkerLayer.addLayer(marker);
        });

        wrecksMarkerLayer.addTo(map);
        console.log(`[Wrecks] Loaded ${wrecks.length} wrecks for current view`);
      }

      // Store the bounds we just loaded to prevent duplicate loads
      lastWrecksBounds = bounds;
    } catch (error) {
      console.error('[Wrecks] Load error:', error);
    }
  };

  const WrecksLayerControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom wrecks-toggle');

      const updateButton = () => {
        container.style.position = 'relative';
        container.innerHTML = '🪦';

        let strikeLine = container.querySelector('.wrecks-strike');
        if (!strikeLine) {
          strikeLine = document.createElement('div');
          strikeLine.className = 'wrecks-strike';
          strikeLine.style.cssText = `
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            height: 3px;
            background-color: #ef4444;
            transform: translateY(-50%) rotate(-45deg);
            pointer-events: none;
          `;
          container.appendChild(strikeLine);
        }
        strikeLine.style.display = wrecksEnabled ? 'none' : 'block';
      };

      updateButton();
      container.title = 'Shipwrecks';

      L.DomEvent.disableClickPropagation(container);

      container.addEventListener('click', async () => {
        const currentZoom = map.getZoom();

        // If trying to enable but zoom is too low, show warning and don't enable
        if (!wrecksEnabled && currentZoom < 5) {
          showSideNotification(
            `⚠️ <strong>Zoom in to see Wrecks</strong><br><br>Wrecks are only visible at zoom level 5 or higher. They will appear when you zoom in.`,
            'warning',
            4000
          );
          return; // Don't toggle the state
        }

        wrecksEnabled = !wrecksEnabled;
        localStorage.setItem('harborMapWrecksEnabled', wrecksEnabled);

        if (wrecksEnabled) {
          // Zoom is OK, load wrecks immediately
          await loadWrecksForCurrentView();
        } else {
          // Disabled - remove markers and reset bbox tracking
          if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
            map.removeLayer(wrecksMarkerLayer);
            wrecksMarkerLayer = null;
          }
          lastWrecksBounds = null; // Reset bounds tracking when disabled
        }

        updateButton();

        // Reset tooltip
        container.removeAttribute('title');
        setTimeout(() => {
          container.title = 'Shipwrecks';
        }, 100);
      });

      if (wrecksEnabled) {
        container.click();
      }

      return container;
    }
  });

  // Add controls to map (order matters - top to bottom for topleft, top to bottom for topright)

  // Top left controls (icon buttons - after +/- zoom which Leaflet adds automatically)
  map.addControl(new FullscreenControl());
  map.addControl(new MapStyleControl());

  // Only add Weather Control if enableWeatherData is enabled
  const settings = window.getSettings ? window.getSettings() : {};
  if (settings.enableWeatherData === true) {
    weatherControl = new WeatherControl();
    map.addControl(weatherControl);
  }

  // Add Environmental Layer Control (rotating button: off -> wind -> clouds -> temperature)
  envLayerControl = new EnvironmentalLayerControl();
  map.addControl(envLayerControl);

  // Add Museums and Wrecks Layer Controls (two separate toggle buttons)
  map.addControl(new MuseumsLayerControl());
  map.addControl(new WrecksLayerControl());

  // Add Refresh Control
  map.addControl(new RefreshControl());

  // Forecast Calendar Control - same structure as Refresh
  const ForecastControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-forecast');
      container.innerHTML = '<button title="Forecast Calendar">📅</button>';
      L.DomEvent.disableClickPropagation(container);
      container.querySelector('button').addEventListener('click', () => {
        if (window.showForecastOverlay) window.showForecastOverlay();
      });
      return container;
    }
  });

  map.addControl(new ForecastControl());

  // Logbook Control - same structure as Refresh
  const LogbookControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-logbook');
      container.innerHTML = '<button title="Captain\'s Logbook">📋</button>';
      L.DomEvent.disableClickPropagation(container);
      container.querySelector('button').addEventListener('click', () => {
        if (window.showLogbookOverlay) window.showLogbookOverlay();
      });
      return container;
    }
  });

  // Settings Control - same structure as Refresh
  const SettingsControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-settings-btn');
      container.innerHTML = '<button title="Settings">⚙️</button>';
      L.DomEvent.disableClickPropagation(container);
      container.querySelector('button').addEventListener('click', () => {
        if (window.showSettings) window.showSettings();
      });
      return container;
    }
  });

  // Docs Control - same structure as Refresh
  const DocsControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-custom leaflet-control-docs');
      container.innerHTML = '<button title="Documentation">📖</button>';
      L.DomEvent.disableClickPropagation(container);
      container.querySelector('button').addEventListener('click', () => {
        if (window.showDocsOverlay) window.showDocsOverlay();
      });
      return container;
    }
  });

  map.addControl(new LogbookControl());
  map.addControl(new SettingsControl());
  map.addControl(new DocsControl());

  // Top right controls (filter dropdowns) - THESE MUST BE LAST so they don't interfere with left controls
  map.addControl(new RouteFilterControl());
  map.addControl(new VesselFilterControl());
  map.addControl(new PortFilterControl());

  // Add Zoom Display Control (bottom left) - add AFTER filters
  map.addControl(new ZoomDisplayControl());

  // Auto-reload wrecks when zooming or moving map (with debouncing)
  map.on('zoomend', () => {
    const currentZoom = map.getZoom();

    // Clear any pending load timeout
    if (wrecksLoadTimeout) {
      clearTimeout(wrecksLoadTimeout);
      wrecksLoadTimeout = null;
    }

    if (wrecksEnabled) {
      if (currentZoom < 5) {
        // Hide wrecks if zoom too low
        if (wrecksMarkerLayer && map.hasLayer(wrecksMarkerLayer)) {
          map.removeLayer(wrecksMarkerLayer);
          wrecksMarkerLayer = null;
          lastWrecksBounds = null; // Reset bounds tracking
          console.log(`[Wrecks] Auto-hidden at zoom level ${currentZoom}`);
        }
      } else {
        // Zoom is OK, reload wrecks after 500ms delay (debounce)
        wrecksLoadTimeout = setTimeout(() => {
          loadWrecksForCurrentView();
        }, 500);
      }
    }
  });

  // Reload wrecks when map is moved (panned/dragged) with debouncing
  map.on('moveend', () => {
    // Clear any pending load timeout
    if (wrecksLoadTimeout) {
      clearTimeout(wrecksLoadTimeout);
      wrecksLoadTimeout = null;
    }

    if (wrecksEnabled && map.getZoom() >= 5) {
      // Wait 500ms after movement stops before loading (debounce)
      wrecksLoadTimeout = setTimeout(() => {
        loadWrecksForCurrentView();
      }, 500);
    }
  });

  // Set saved values in dropdowns
  const vesselFilterSelect = document.getElementById('vesselFilterSelect');
  const portFilterSelect = document.getElementById('portFilterSelect');

  if (vesselFilterSelect) {
    vesselFilterSelect.value = currentVesselFilter;
  }

  if (portFilterSelect) {
    portFilterSelect.value = currentPortFilter;
  }

  console.log(`[Harbor Map] Restored saved settings - Style: ${currentMapStyle}, Vessel Filter: ${currentVesselFilter}, Port Filter: ${currentPortFilter}, Route Filter: ${currentRouteFilter || 'All Routes'}`);

  // Initialize Environmental Layer if enabled (restore from localStorage)
  if (currentEnvLayer && currentEnvLayer !== 'off') {
    console.log(`[Environmental] Restoring ${currentEnvLayer} layer from saved state...`);
    switch(currentEnvLayer) {
      case 'wind':
        // Higher opacity in standard mode for better visibility
        const windOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
        envLayer = L.OWM.wind({opacity: windOpacity});
        if (envLayer) {
          envLayer.addTo(map);
        }
        break;
      case 'clouds':
        // Add cloud layer (static) with higher opacity in standard mode
        const cloudsOpacity = currentMapStyle === 'standard' ? 0.7 : 0.5;
        envLayer = L.OWM.clouds({showLegend: false, opacity: cloudsOpacity});
        envLayer.addTo(map);
        break;
      case 'temperature':
        // Higher opacity in standard mode for better visibility
        const tempOpacity = currentMapStyle === 'standard' ? 0.6 : 0.4;
        envLayer = L.OWM.temperature({showLegend: true, opacity: tempOpacity});
        if (envLayer) {
          envLayer.addTo(map);
        }
        break;
    }
  }

  // Apply theme class for control styling
  applyMapTheme(currentMapStyle);
}

/**
 * Applies theme class to map container for control styling
 *
 * @param {string} style - Map style key ('standard', 'dark', 'satellite')
 * @returns {void}
 */
function applyMapTheme(style) {
  const mapCanvas = document.getElementById('harborMapCanvas');
  if (!mapCanvas) return;

  // Remove all theme classes
  mapCanvas.classList.remove('theme-light', 'theme-dark', 'theme-satellite');

  // Add appropriate theme class
  if (style === 'standard') {
    mapCanvas.classList.add('theme-light');
  } else if (style === 'satellite') {
    mapCanvas.classList.add('theme-satellite');
  } else {
    // dark uses dark controls
    mapCanvas.classList.add('theme-dark');
  }

  console.log(`[Harbor Map] Applied theme class for style: ${style}`);
}

/**
 * Changes the map tile layer (theme)
 *
 * @param {string} layerKey - Key from tileLayers object
 * @returns {void}
 */
function changeTileLayer(layerKey) {
  if (!tileLayers[layerKey]) return;

  // Remove current layer
  if (currentTileLayer) {
    map.removeLayer(currentTileLayer);
  }

  // Add new layer
  currentTileLayer = L.tileLayer(tileLayers[layerKey].url, {
    maxZoom: 19
  }).addTo(map);

  // Save to localStorage
  currentMapStyle = layerKey;
  localStorage.setItem('harborMapStyle', layerKey);

  // Apply theme class for control styling
  applyMapTheme(layerKey);

  // Update map container background color
  const mapContainer = map.getContainer();
  const backgroundColor = layerKey === 'standard' ? '#e0e0e0' : '#1f1f1f';
  mapContainer.style.backgroundColor = backgroundColor;

  // Re-add environmental layer if active (to keep it on top of the new tile layer)
  if (envLayer && currentEnvLayer !== 'off') {
    envLayer.bringToFront();
  }

  console.log(`[Harbor Map] Changed map style to: ${tileLayers[layerKey].name} (saved)`);
}

/**
 * Renders vessels as markers on the map
 * Uses color-coded icons based on vessel status
 *
 * @param {Array<Object>} vessels - Vessels with position data from backend
 * @returns {void}
 * @example
 * renderVessels([{ id: 1234, position: { lat: -27.38, lon: 153.12 }, status: 'enroute', ... }]);
 */
export function renderVessels(vessels) {
  // Don't clear portLocationClusterGroup here - it will be cleared before both
  // renderVessels() and renderPorts() are called, and ports need to be added after vessels
  vesselClusterGroup.clearLayers();

  console.log(`[Harbor Map] Rendering ${vessels.length} vessels`);

  let skipped = 0;
  vessels.forEach(vessel => {
    if (!vessel.position) {
      skipped++;
      return;
    }

    // Get vessel type from capacity_type field
    const vesselType = getVesselType(vessel.capacity_type);

    // Calculate heading if vessel has route
    let heading = 0;
    if (vessel.routes && vessel.routes.length > 0 && vessel.routes[0].path && vessel.routes[0].path.length >= 2) {
      const path = vessel.routes[0].path;
      // Find current position in path and calculate heading to next point
      for (let i = 0; i < path.length - 1; i++) {
        const point = path[i];
        if (Math.abs(point.lat - vessel.position.lat) < 0.01 && Math.abs(point.lon - vessel.position.lon) < 0.01) {
          heading = calculateHeading(point, path[i + 1]);
          break;
        }
      }
      // If not found in path, use first two points
      if (heading === 0 && path.length >= 2) {
        heading = calculateHeading(path[0], path[1]);
      }
    }

    // Create icon with type, status, and heading
    const icon = createVesselIcon(vessel.status, vesselType, heading);

    // Use exact coordinates (no offset for vessels in port)
    // Vessels in port will have same coordinates as port and will be clustered together
    const vesselLat = vessel.position.lat;
    const vesselLon = vessel.position.lon;

    // Create marker
    const marker = L.marker([vesselLat, vesselLon], { icon });

    // Prepare tooltip content with detailed cargo info
    let cargoDisplay = 'N/A';
    if (vessel.capacity && vessel.capacity_max) {
      if (vessel.capacity_type === 'container') {
        const dry = vessel.capacity.dry;
        const ref = vessel.capacity.refrigerated;
        const dryMax = vessel.capacity_max.dry;
        const refMax = vessel.capacity_max.refrigerated;
        cargoDisplay = `Dry: ${dry}/${dryMax} TEU, Ref: ${ref}/${refMax} TEU`;
      } else if (vessel.capacity_type === 'tanker') {
        const fuel = vessel.capacity.fuel;
        const crude = vessel.capacity.crude_oil;
        const fuelMax = vessel.capacity_max.fuel;
        const crudeMax = vessel.capacity_max.crude_oil;
        cargoDisplay = `Fuel: ${fuel}/${fuelMax} bbl, Crude: ${crude}/${crudeMax} bbl`;
      }
    }

    const vesselTooltipContent = `
      <strong>${vessel.name}</strong><br>
      Status: ${vessel.status}${vessel.status === 'enroute' && vessel.route_speed ? ` | Speed: ${vessel.route_speed} kn` : ''}${vessel.eta !== 'N/A' ? ` | ETA: ${vessel.eta}` : ''}<br>
      Cargo: ${cargoDisplay}
    `;

    // Always bind tooltip for mouseover (NOT for click)
    marker.bindTooltip(vesselTooltipContent, {
      direction: 'auto',
      offset: [0, -10]
    });

    // Click handler - show vessel detail panel
    marker.on('click', () => {
      marker.closeTooltip();
      selectVessel(vessel.id);
    });

    // Add to appropriate cluster group
    // Vessels in port/anchor -> portLocationClusterGroup (clustered with port)
    // Vessels enroute -> vesselClusterGroup (separate)
    if (vessel.status === 'port' || vessel.status === 'anchor') {
      portLocationClusterGroup.addLayer(marker);
    } else {
      vesselClusterGroup.addLayer(marker);
    }
  });

  console.log(`[Harbor Map] Rendered ${vessels.length - skipped} vessels, skipped ${skipped} without position`);
}

/**
 * Renders ports as markers on the map
 * Uses color-coded markers for demand levels
 *
 * @param {Array<Object>} ports - Ports with demand data from backend
 * @returns {void}
 * @example
 * renderPorts([{ code: 'AUBNE', lat: -27.38, lon: 153.12, demandLevel: 'high', ... }]);
 */
export function renderPorts(ports) {
  // Don't clear portLocationClusterGroup here - vessels in port have already been added
  // by renderVessels(), and we want to add ports to the same cluster group
  // portLocationClusterGroup.clearLayers();  // DON'T DO THIS!

  console.log(`[Harbor Map] Rendering ${ports.length} ports`);
  if (ports.length > 0) {
    console.log('[Harbor Map] First port sample:', {
      code: ports[0].code,
      hasDemand: !!ports[0].demand,
      demand: ports[0].demand
    });
  }

  ports.forEach(port => {
    if (!port.lat || !port.lon) return;

    // Format demand for tooltip
    let demandText = 'No active route / Demand unknown';
    if (port.demand) {
      const parts = [];
      if (port.demand.container) {
        const dry = port.demand.container.dry || 0;
        const ref = port.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (port.demand.tanker) {
        const fuel = port.demand.tanker.fuel || 0;
        const crude = port.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Format port name
    const portName = port.code.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    // Prepare tooltip content
    const portTooltipContent = `
      <strong>${portName}</strong><br>
      ${demandText}
    `;

    // Create marker
    const marker = L.marker([parseFloat(port.lat), parseFloat(port.lon)], {
      icon: portIcons.default
    });

    // Always bind tooltip for mouseover (NOT for click)
    marker.bindTooltip(portTooltipContent, {
      direction: 'auto',
      offset: [0, -10]
    });

    // Click handler - show port detail panel
    marker.on('click', () => {
      marker.closeTooltip();
      selectPort(port.code);
    });

    portLocationClusterGroup.addLayer(marker);
  });
}

/**
 * Draws route path on map with blue polyline
 * Highlights origin (red) and destination (green) ports
 *
 * @param {Object} route - Route data from backend
 * @param {Array<Object>} ports - Array of port objects with demand data
 * @param {boolean} autoZoom - Whether to auto-zoom to route bounds (default: true)
 * @returns {void}
 * @example
 * drawRoute({ path: [{lat: -27.38, lon: 153.12}, ...], origin: 'AUBNE', destination: 'NZAKL' }, ports);
 */
export function drawRoute(route, ports = [], autoZoom = true) {
  routeLayer.clearLayers();

  if (!route || !route.path || route.path.length === 0) {
    console.log('[Harbor Map] No route to draw');
    return;
  }

  // Support both field names for backwards compatibility
  const originPort = route.origin || route.origin_port_code;
  const destinationPort = route.destination || route.destination_port_code;

  console.log('[Harbor Map] Drawing route:', {
    origin: originPort,
    destination: destinationPort,
    pathLength: route.path.length
  });

  // Draw route path as blue polyline
  const latLngs = route.path.map(p => [p.lat, p.lon]);
  const polyline = L.polyline(latLngs, {
    color: '#3388ff',
    weight: 3,
    opacity: 0.7,
    className: 'route-polyline-clickable'
  });

  // Add click handler to open route vessels panel
  polyline.on('click', async () => {
    console.log('[Harbor Map] Route line clicked:', originPort, '→', destinationPort);

    // Close any open panels first to prevent overlap
    await closeAllPanels();

    // Filter vessels that are on this route (or reverse)
    const vesselsOnRoute = currentVessels.filter(v => {
      if (!v.active_route) return false;

      const vesselOrigin = v.active_route.origin_port_code || v.active_route.origin;
      const vesselDestination = v.active_route.destination_port_code || v.active_route.destination;

      // Check both directions (forward and reverse)
      return (vesselOrigin === originPort && vesselDestination === destinationPort) ||
             (vesselOrigin === destinationPort && vesselDestination === originPort);
    });

    // Create route name for panel title
    const originName = originPort ? originPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Unknown';
    const destName = destinationPort ? destinationPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Unknown';
    const routeName = `${originName} - ${destName}`;

    console.log(`[Harbor Map] Opening route panel: ${routeName}, ${vesselsOnRoute.length} vessels`);
    showRouteVesselsPanel(routeName, vesselsOnRoute);
  });

  routeLayer.addLayer(polyline);

  // Highlight origin port (red)
  if (originPort) {
    const originName = originPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    const originMarker = L.marker(latLngs[0], { icon: portIcons.origin });

    // Find port data for demand info
    const originPortData = ports.find(p => p.code === originPort);
    let demandText = 'N/A';

    if (originPortData && originPortData.demand) {
      const parts = [];
      if (originPortData.demand.container) {
        const dry = originPortData.demand.container.dry || 0;
        const ref = originPortData.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (originPortData.demand.tanker) {
        const fuel = originPortData.demand.tanker.fuel || 0;
        const crude = originPortData.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Bind tooltip - same format as normal ports (mouseover only)
    originMarker.bindTooltip(`
      <strong>${originName}</strong><br>
      <strong>Demand</strong><br>
      ${demandText}
    `, {
      direction: 'auto',
      offset: [0, -10],
      className: 'route-port-tooltip'
    });

    // Click handler - open port panel
    originMarker.on('click', () => selectPort(originPort));

    routeLayer.addLayer(originMarker);
    console.log('[Harbor Map] Added origin port marker:', originName, latLngs[0]);
  } else {
    console.warn('[Harbor Map] No origin port in route data');
  }

  // Highlight destination port (green)
  if (destinationPort) {
    const destName = destinationPort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    const destMarker = L.marker(latLngs[latLngs.length - 1], { icon: portIcons.destination });

    // Find port data for demand info
    const destPortData = ports.find(p => p.code === destinationPort);
    let demandText = 'N/A';

    if (destPortData && destPortData.demand) {
      const parts = [];
      if (destPortData.demand.container) {
        const dry = destPortData.demand.container.dry || 0;
        const ref = destPortData.demand.container.refrigerated || 0;
        parts.push(`Container: Dry ${dry.toLocaleString()} TEU / Ref ${ref.toLocaleString()} TEU`);
      }
      if (destPortData.demand.tanker) {
        const fuel = destPortData.demand.tanker.fuel || 0;
        const crude = destPortData.demand.tanker.crude_oil || 0;
        parts.push(`Tanker: Fuel: ${fuel.toLocaleString()} bbl / Crude: ${crude.toLocaleString()} bbl`);
      }
      if (parts.length > 0) {
        demandText = parts.join('<br>');
      }
    }

    // Bind tooltip - same format as normal ports (mouseover only)
    destMarker.bindTooltip(`
      <strong>${destName}</strong><br>
      <strong>Demand</strong><br>
      ${demandText}
    `, {
      direction: 'auto',
      offset: [0, -10],
      className: 'route-port-tooltip'
    });

    // Click handler - open port panel
    destMarker.on('click', () => selectPort(destinationPort));

    routeLayer.addLayer(destMarker);
    console.log('[Harbor Map] Added destination port marker:', destName, latLngs[latLngs.length - 1]);
  } else {
    console.warn('[Harbor Map] No destination port in route data');
  }

  // Fit map to route bounds (only if autoZoom is true)
  if (autoZoom) {
    const isMobile = isMobileDevice();

    if (isMobile) {
      // Mobile: More padding and maxZoom to see full route
      map.fitBounds(polyline.getBounds(), {
        paddingTopLeft: [20, 80],
        paddingBottomRight: [20, 450],
        maxZoom: 2 // Allow very wide zoom out for intercontinental routes
      });
    } else {
      // Desktop: Right panel padding (175px panel + 50px extra + more space)
      map.fitBounds(polyline.getBounds(), {
        paddingTopLeft: [50, 50],
        paddingBottomRight: [300, 50]
      });
    }
  }
}

/**
 * Clears route layer (removes blue line and port highlights)
 *
 * @returns {void}
 * @example
 * clearRoute();
 */
export function clearRoute() {
  routeLayer.clearLayers();
}

/**
 * Sets port filter to specific value (client-side only - no API calls)
 *
 * @param {string} filter - Port filter type
 * @returns {Promise<void>}
 * @example
 * await setPortFilter('my_ports');
 */
export async function setPortFilter(filter) {
  currentPortFilter = filter;
  localStorage.setItem('harborMapPortFilter', filter);
  console.log(`[Harbor Map] Port filter changed to: ${filter} (client-side)`);

  // Close all panels and reset selection when manually changing filter
  await closeAllPanels();
  selectedVesselId = null;
  selectedPortCode = null;

  // Remove fullscreen when manually changing filters
  if (isMobileDevice()) {
    document.body.classList.remove('map-fullscreen');
  }

  // Apply filter client-side (no API call)
  await applyFiltersAndRender();
}

/**
 * Sets vessel filter to specific value (client-side only - no API calls)
 *
 * @param {string} filter - Vessel filter type
 * @returns {Promise<void>}
 * @example
 * await setVesselFilter('tanker_only');
 */
export async function setVesselFilter(filter) {
  currentVesselFilter = filter;
  localStorage.setItem('harborMapVesselFilter', filter);
  console.log(`[Harbor Map] Vessel filter changed to: ${filter} (client-side)`);

  // Close all panels and reset selection when manually changing filter
  await closeAllPanels();
  selectedVesselId = null;
  selectedPortCode = null;

  // Remove fullscreen when manually changing filters
  if (isMobileDevice()) {
    document.body.classList.remove('map-fullscreen');
  }

  // Apply filter client-side (no API call)
  await applyFiltersAndRender();
}

/**
 * Applies current filters to raw data and renders the result
 * NO API calls - pure client-side filtering
 *
 * @returns {Promise<void>}
 */
async function applyFiltersAndRender() {
  // IMPORTANT: Re-read filter values from localStorage to ensure they're up to date
  // This prevents filter state loss during automatic refreshes
  currentVesselFilter = localStorage.getItem('harborMapVesselFilter') || 'all_vessels';
  currentPortFilter = localStorage.getItem('harborMapPortFilter') || 'my_ports';

  // Sync dropdown values with current filter state
  const vesselFilterSelect = document.getElementById('vesselFilterSelect');
  const portFilterSelect = document.getElementById('portFilterSelect');
  if (vesselFilterSelect && vesselFilterSelect.value !== currentVesselFilter) {
    vesselFilterSelect.value = currentVesselFilter;
  }
  if (portFilterSelect && portFilterSelect.value !== currentPortFilter) {
    portFilterSelect.value = currentPortFilter;
  }

  // Debug: Check raw data
  const assignedPortsCount = rawPorts.filter(p => p.isAssigned === true).length;
  console.log(`[Harbor Map] Raw data - Total Ports: ${rawPorts.length}, Assigned Ports: ${assignedPortsCount}, Total Vessels: ${rawVessels.length}`);

  // Debug: Show first port structure
  if (rawPorts.length > 0) {
    console.log(`[Harbor Map] Sample port:`, rawPorts[0]);
  }

  // Apply vessel filter
  let filteredVessels = filterVessels(rawVessels, currentVesselFilter);

  // Apply port filter (ports need vessel data for some filters)
  let filteredPorts = filterPorts(rawPorts, rawVessels, currentPortFilter);

  console.log(`[Harbor Map] Applied filters - Vessel Filter: ${currentVesselFilter}, Port Filter: ${currentPortFilter}`);
  console.log(`[Harbor Map] Filtered results - Vessels: ${filteredVessels.length}/${rawVessels.length}, Ports: ${filteredPorts.length}/${rawPorts.length}`);

  // Store filtered data for route filtering
  currentVessels = filteredVessels;
  currentPorts = filteredPorts;

  // Update route dropdown
  updateRouteDropdown();

  // Check if there's an active selection (vessel, port, or route panel open)
  const vesselPanelOpen = document.getElementById('vessel-detail-panel')?.classList.contains('active');
  const portPanelOpen = document.getElementById('port-detail-panel')?.classList.contains('active');
  const routePanelOpen = document.getElementById('route-vessels-panel')?.classList.contains('active');
  const hasActiveSelection = selectedVesselId !== null || selectedPortCode !== null ||
                             vesselPanelOpen || portPanelOpen || routePanelOpen;

  if (hasActiveSelection) {
    console.log('[Harbor Map] Active selection detected - skipping render to preserve current view');

    // IMPORTANT: Update previousMapState with filtered data
    // This ensures when user closes panel, it shows the CURRENT filter, not the old one
    previousMapState.vessels = [...filteredVessels];
    previousMapState.ports = [...filteredPorts];

    // Raw data and filters are updated in background, but DON'T re-render map or reset selection
    // This allows background data refresh without disrupting user's current view
    return;
  }

  // Apply route filter if active
  const vesselsToRender = currentRouteFilter
    ? currentVessels.filter(v => v.route_name === currentRouteFilter)
    : currentVessels;

  // Clear all cluster groups before rendering
  vesselClusterGroup.clearLayers();
  portLocationClusterGroup.clearLayers();

  // If route filter is active, restore full route visualization
  if (currentRouteFilter && vesselsToRender.length > 0) {
    const firstVessel = vesselsToRender[0];

    // Build route from vessel.active_route
    if (firstVessel.status === 'enroute' && firstVessel.active_route?.path) {
      // Handle reversed routes
      const isReversed = firstVessel.active_route.reversed === true;
      const actualOrigin = isReversed
        ? (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination)
        : (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin);
      const actualDestination = isReversed
        ? (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin)
        : (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination);

      const route = {
        path: firstVessel.active_route.path,
        origin: actualOrigin,
        destination: actualDestination
      };

      // Filter ports to show only origin and destination
      const routePorts = filteredPorts.filter(p =>
        p.code === route.origin || p.code === route.destination
      );

      // Render vessels and route ports
      renderVessels(vesselsToRender);
      renderPorts(routePorts);

      // Draw route path (WITHOUT auto-zoom during refresh)
      drawRoute(route, currentPorts, false);

      console.log(`[Harbor Map] Route filter restored during refresh: ${route.origin} → ${route.destination}`);
    } else {
      // No active route available, render normally
      renderVessels(vesselsToRender);
      renderPorts(filteredPorts);
      clearRoute();
    }
  } else {
    // No route filter active

    // Logic: Only show BOTH when default filters are selected
    // Whitelist for showing both vessels AND ports
    const showBothVesselFilters = ['all_vessels', 'all_my_vessels'];
    const showBothPortFilters = ['all_ports', 'my_ports'];

    const showBothVessels = showBothVesselFilters.includes(currentVesselFilter);
    const showBothPorts = showBothPortFilters.includes(currentPortFilter);

    if (!showBothVessels) {
      // Any specific vessel filter (tanker, arrived, etc.) → hide ports
      renderVessels(vesselsToRender);
      renderPorts([]);
      if (window.DEBUG_MODE) console.log(`[Harbor Map] Vessel filter "${currentVesselFilter}" active - hiding ports`);
    } else if (!showBothPorts) {
      // Any specific port filter → hide vessels
      renderVessels([]);
      renderPorts(filteredPorts);
      if (window.DEBUG_MODE) console.log(`[Harbor Map] Port filter "${currentPortFilter}" active - hiding vessels`);
    } else {
      // Both on default (all_vessels/all_my_vessels + all_ports/my_ports) → show both
      renderVessels(vesselsToRender);
      renderPorts(filteredPorts);
    }

    clearRoute();
  }

  // Reset selection state
  selectedVesselId = null;
  selectedPortCode = null;

  hideVesselPanel();
  hidePortPanel();
}

/**
 * Loads and renders harbor map overview
 * Fetches ALL data once, then applies filters client-side
 *
 * @returns {Promise<void>}
 * @example
 * await loadOverview();
 */
export async function loadOverview() {
  try {
    // Always use cached data only
    const cachedData = getCachedOverview();

    if (cachedData) {
      console.log('[Harbor Map] Loading from cache (no API call)');

      // Store RAW data (unfiltered)
      rawVessels = cachedData.vessels;
      rawPorts = cachedData.ports;

      // Apply filters client-side
      await applyFiltersAndRender();
      return;
    }

    // No cache available - fetch ALL data once (no filter parameter)
    console.log('[Harbor Map] No cache available, fetching ALL data...');
    const data = await fetchHarborMapOverview('all_ports');

    console.log('[Harbor Map] Overview data:', {
      vessels: data.vessels.length,
      ports: data.ports.length,
      sampleVessel: data.vessels[0]
    });

    // Store RAW data (unfiltered)
    rawVessels = data.vessels;
    rawPorts = data.ports;

    // Apply filters client-side
    await applyFiltersAndRender();
  } catch (error) {
    console.error('Error loading harbor map overview:', error);
  }
}

/**
 * Closes all open panels (vessel, port, route)
 * Ensures only one panel is open at a time
 * Only hides panels, does NOT remove fullscreen or deselect
 * This allows seamless panel transitions without fullscreen flicker
 * @returns {Promise<void>}
 */
export async function closeAllPanels() {
  // Close weather popup
  if (map) {
    map.closePopup();
  }

  // Only HIDE panels (don't remove fullscreen or call deselectAll)
  // This keeps fullscreen active during panel transitions
  hideVesselPanel();
  hidePortPanel();
  hideRoutePanel();
}

/**
 * Selects a vessel and shows reachable ports
 * Hides other vessels, draws route, shows vessel panel
 *
 * @param {number} vesselId - Vessel ID to select
 * @returns {Promise<void>}
 * @example
 * await selectVessel(1234);
 */
export async function selectVessel(vesselId) {
  try {
    // Save current state BEFORE making changes
    previousMapState = {
      vessels: [...currentVessels],
      ports: [...currentPorts],
      zoom: map.getZoom(),
      center: map.getCenter()
    };

    selectedVesselId = vesselId;
    selectedPortCode = null;

    // PROGRESSIVE LOADING: Show vessel immediately with cached data
    const vessel = rawVessels.find(v => v.id === vesselId);
    if (!vessel) {
      console.error(`[Harbor Map] Vessel ${vesselId} not found in rawVessels`);
      return;
    }

    console.log(`[Harbor Map] Vessel ${vesselId} selected - showing immediately from cache`);

    // Close all panels first to avoid conflicts
    await closeAllPanels();

    // Clear ALL markers (vessels and ports)
    vesselClusterGroup.clearLayers();
    portLocationClusterGroup.clearLayers();
    clearRoute();

    // Render ONLY the selected vessel on the map (from cache)
    if (vessel && vessel.position) {
      const vesselType = getVesselType(vessel.capacity_type);
      let heading = 0;

      // Calculate heading from active_route if available
      if (vessel.active_route && vessel.active_route.path && vessel.active_route.path.length >= 2) {
        const path = vessel.active_route.path;
        for (let i = 0; i < path.length - 1; i++) {
          const point = path[i];
          if (Math.abs(point.lat - vessel.position.lat) < 0.01 && Math.abs(point.lon - vessel.position.lon) < 0.01) {
            heading = calculateHeading(point, path[i + 1]);
            break;
          }
        }
        if (heading === 0 && path.length >= 2) {
          heading = calculateHeading(path[0], path[1]);
        }
      }

      const icon = createVesselIcon(vessel.status, vesselType, heading);
      const vesselMarker = L.marker([vessel.position.lat, vessel.position.lon], { icon });

      if (vessel.status === 'port' || vessel.status === 'anchor') {
        portLocationClusterGroup.addLayer(vesselMarker);
      } else {
        vesselClusterGroup.addLayer(vesselMarker);
      }
    }

    // Show vessel panel IMMEDIATELY with cached data
    showVesselPanel(vessel);

    // NOW fetch reachable ports in background
    console.log(`[Harbor Map] Loading reachable ports in background...`);
    const data = await fetchVesselReachablePorts(vesselId);

    console.log(`[Harbor Map] Reachable ports loaded:`, {
      reachablePorts: data.reachablePorts.length,
      hasRoute: !!data.route
    });

    // Update map with reachable ports and route data

    // Draw route if vessel has one (this will draw the 2 port markers)
    // drawRoute() draws: blue line + red origin marker + green destination marker
    if (data.route) {
      // Prefer assignedPorts (correct demand) over allPorts (no demand for non-assigned)
      const portsForDemand = data.assignedPorts || data.allPorts;
      drawRoute(data.route, portsForDemand, false); // false = no auto-zoom
    } else if ((data.vessel.status === 'port' || data.vessel.status === 'anchor') && data.vessel.port_code) {
      // If vessel in port but no route: show ONLY current port
      console.log('[Harbor Map] Vessel in port (no route), showing only current port:', data.vessel.port_code);

      const currentPort = data.reachablePorts.find(p => p.code === data.vessel.port_code) ||
                         currentPorts.find(p => p.code === data.vessel.port_code);

      if (currentPort) {
        renderPorts([currentPort]); // Only render the ONE port vessel is currently in
      }
    }
    // If no route and not in port: show nothing (just the vessel)

    // Zoom to show route (prioritize route over all ports)
    const isMobile = isMobileDevice();

    if (data.route && data.route.path) {
      const bounds = L.latLngBounds();
      data.route.path.forEach(p => bounds.extend([p.lat, p.lon]));

      if (isMobile) {
        map.fitBounds(bounds, {
          paddingTopLeft: [20, 80],
          paddingBottomRight: [20, 450],
          maxZoom: 2 // Allow very wide zoom out for intercontinental routes
        });
      } else {
        map.fitBounds(bounds, {
          paddingTopLeft: [50, 50],
          paddingBottomRight: [300, 50] // More padding for panel + dragging space
        });
      }
    } else if (data.reachablePorts.length > 0) {
      // Fallback: fit all reachable ports if no route
      const bounds = L.latLngBounds();
      data.reachablePorts.forEach(port => {
        if (port.lat && port.lon) {
          bounds.extend([parseFloat(port.lat), parseFloat(port.lon)]);
        }
      });

      if (isMobile) {
        map.fitBounds(bounds, {
          paddingTopLeft: [20, 80],
          paddingBottomRight: [20, 450],
          maxZoom: 2 // Allow very wide zoom out for intercontinental routes
        });
      } else {
        map.fitBounds(bounds, {
          paddingTopLeft: [50, 50],
          paddingBottomRight: [300, 50] // More padding for panel + dragging space
        });
      }
    } else if (data.vessel && data.vessel.position) {
      // Fallback: center on vessel if no route or ports
      map.setView([data.vessel.position.lat, data.vessel.position.lon], map.getZoom(), {
        animate: true,
        duration: 0.5,
        paddingTopLeft: [50, 50],
        paddingBottomRight: [325, 50] // 275px panel + 50px padding
      });
    }

    // Vessel panel already shown with cached data - update with reachable ports if needed
    // (Panel might need reachable ports data for some features)
  } catch (error) {
    console.error(`Error selecting vessel ${vesselId}:`, error);
  }
}

/**
 * Categorizes all vessels by their relationship to a specific port (CLIENT-SIDE)
 * Replicates backend logic from harbor-map-aggregator.js
 * Splits vessels into four categories: in port, heading to, coming from, pending
 *
 * @param {string} portCode - Port code to categorize vessels for
 * @param {Array<Object>} allVessels - All user vessels from rawVessels
 * @returns {Object} { inPort: [], toPort: [], fromPort: [], pending: [] }
 * @example
 * const categorized = categorizeVesselsByPortClientSide('boston_us', rawVessels);
 * // Returns: { inPort: [v1, v2], toPort: [v3], fromPort: [v4, v5], pending: [v6] }
 */
function categorizeVesselsByPortClientSide(portCode, allVessels) {
  const inPort = [];
  const toPort = [];
  const fromPort = [];
  const pending = [];

  allVessels.forEach(vessel => {
    // Vessels being built/delivered (pending status)
    if ((vessel.status === 'pending' || vessel.status === 'delivery') && vessel.current_port_code === portCode) {
      pending.push(vessel);
    }
    // Vessels currently in port
    else if (vessel.current_port_code === portCode && vessel.status !== 'enroute') {
      inPort.push(vessel);
    }
    // Vessels heading to port (check both field names for compatibility)
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.destination === portCode || vessel.active_route?.destination_port_code === portCode)) {
      toPort.push(vessel);
    }
    // Vessels coming from port (check both field names for compatibility)
    else if (vessel.status === 'enroute' &&
             (vessel.active_route?.origin === portCode || vessel.active_route?.origin_port_code === portCode)) {
      fromPort.push(vessel);
    }
  });

  console.log(`[Harbor Map] Client-side categorization for port ${portCode}:`, {
    inPort: inPort.length,
    toPort: toPort.length,
    fromPort: fromPort.length,
    pending: pending.length
  });

  return { inPort, toPort, fromPort, pending };
}

/**
 * Selects a port and shows categorized vessels
 * Shows port panel with vessels in/to/from port
 *
 * @param {string} portCode - Port code to select
 * @returns {Promise<void>}
 * @example
 * await selectPort('AUBNE');
 */
export async function selectPort(portCode) {
  try {
    // Save current state BEFORE making changes
    previousMapState = {
      vessels: [...currentVessels],
      ports: [...currentPorts],
      zoom: map.getZoom(),
      center: map.getCenter()
    };

    console.log(`[Harbor Map] Port ${portCode} clicked`);
    selectedPortCode = portCode;
    selectedVesselId = null;

    // CLIENT-SIDE DATA LOADING (no API call needed!)
    // Find port in rawPorts
    const port = rawPorts.find(p => p.code === portCode);
    if (!port) {
      console.error(`[Harbor Map] Port ${portCode} not found in rawPorts`);
      return;
    }

    // Categorize vessels using client-side function
    const vessels = categorizeVesselsByPortClientSide(portCode, rawVessels);

    console.log(`[Harbor Map] Port data loaded from cache (0ms):`, {
      port: port.code,
      hasDemand: !!port.demand,
      vessels: {
        inPort: vessels.inPort.length,
        toPort: vessels.toPort.length,
        fromPort: vessels.fromPort.length,
        pending: vessels.pending.length
      }
    });

    // Close all panels first
    await closeAllPanels();

    // Clear ALL markers
    vesselClusterGroup.clearLayers();
    portLocationClusterGroup.clearLayers();
    clearRoute();

    // Render ONLY the selected port
    renderPorts([port]);

    // Collect ALL vessels related to this port (in, to, from)
    const allRelatedVessels = [
      ...vessels.inPort,
      ...vessels.toPort,
      ...vessels.fromPort
    ];

    // Render ONLY the related vessels
    renderVessels(allRelatedVessels);

    // Zoom to fit port + all related vessels
    const isMobile = isMobileDevice();
    const bounds = L.latLngBounds();

    // Add port to bounds
    if (port.lat && port.lon) {
      bounds.extend([port.lat, port.lon]);
    }

    // Add all vessels to bounds
    allRelatedVessels.forEach(vessel => {
      if (vessel.position && vessel.position.lat && vessel.position.lon) {
        bounds.extend([vessel.position.lat, vessel.position.lon]);
      }
    });

    // Fit bounds with appropriate padding
    if (bounds.isValid()) {
      if (isMobile) {
        map.fitBounds(bounds, {
          paddingTopLeft: [20, 80],
          paddingBottomRight: [20, 450],
          maxZoom: 2 // Allow very wide zoom out for intercontinental routes
        });
      } else {
        map.fitBounds(bounds, {
          paddingTopLeft: [50, 50],
          paddingBottomRight: [300, 50] // More padding for panel + dragging space
        });
      }
    }

    // Show port panel
    showPortPanel(port, vessels);
  } catch (error) {
    console.error(`Error selecting port ${portCode}:`, error);
  }
}

/**
 * Deselects current selection and returns to overview
 *
 * @returns {Promise<void>}
 * @example
 * await deselectAll();
 */
export async function deselectAll() {
  // Reset selection state
  selectedVesselId = null;
  selectedPortCode = null;

  // Clear current markers
  vesselClusterGroup.clearLayers();
  portLocationClusterGroup.clearLayers();
  clearRoute();

  // Save zoom and center if we had previous state
  const previousZoom = previousMapState.zoom;
  const previousCenter = previousMapState.center;

  // Clear previous state
  previousMapState = {
    vessels: [],
    ports: [],
    zoom: null,
    center: null
  };

  // IMPORTANT: Always use applyFiltersAndRender() to ensure filters are applied
  // This ensures that the current filter selection is respected when closing panels
  await applyFiltersAndRender();

  // Restore zoom and center if available
  if (previousZoom && previousCenter) {
    map.setView(previousCenter, previousZoom, {
      animate: true,
      duration: 0.5
    });
  }
}

/**
 * Gets the currently selected port code
 *
 * @returns {string|null} Port code or null if no port selected
 * @example
 * const portCode = getSelectedPortCode();
 */
export function getSelectedPortCode() {
  return selectedPortCode;
}

/**
 * Updates weather data setting and applies changes immediately to the map
 * WITHOUT reloading the entire map
 *
 * @param {boolean} enabled - Whether weather data should be enabled
 * @returns {void}
 */
export function updateWeatherDataSetting(enabled) {
  // This function is called when settings change
  // Weather controls are only initialized/removed on page load (not dynamically)
  // User must reload page for changes to take effect
  console.log('[Harbor Map] Weather data setting updated to:', enabled, '(reload required)');
}

/**
 * Gets a vessel by ID from current vessels cache
 *
 * @param {number} vesselId - Vessel ID to find
 * @returns {Promise<Object|null>} Vessel object or null if not found
 * @example
 * const vessel = await getVesselById(1234);
 */
export async function getVesselById(vesselId, skipCache = false) {
  // If skipCache is false, try to find in current cache first
  if (!skipCache) {
    const cachedVessel = currentVessels.find(v => v.id === vesselId);
    if (cachedVessel) {
      return cachedVessel;
    }
  }

  // Refresh overview from server with cache-busting timestamp
  try {
    const timestamp = Date.now();
    const response = await fetch(window.apiUrl(`/api/harbor-map/overview?filter=all_ports&_=${timestamp}`));

    if (!response.ok) {
      throw new Error(`Failed to fetch harbor map overview: ${response.statusText}`);
    }

    const overview = await response.json();
    currentVessels = overview.vessels || [];
    currentPorts = overview.ports || [];

    console.log(`[Harbor Map] Fetched fresh data from server, found ${currentVessels.length} vessels`);

    return currentVessels.find(v => v.id === vesselId) || null;
  } catch (error) {
    console.error('[Harbor Map] Failed to get vessel by ID:', error);
    return null;
  }
}

/**
 * Updates a single vessel marker on the map without full refresh
 *
 * @param {number} vesselId - Vessel ID to update
 * @returns {Promise<void>}
 * @example
 * await updateVesselMarker(1234);
 */
export async function updateVesselMarker(vesselId) {
  const vessel = await getVesselById(vesselId);
  if (!vessel) {
    console.warn('[Harbor Map] Vessel not found for marker update:', vesselId);
    return;
  }

  // Re-render all vessels to update the marker
  // This keeps the vessel visible on the map with updated status
  renderVessels(currentVessels);
  console.log('[Harbor Map] Vessel marker updated:', vesselId);
}

/**
 * Updates the route dropdown with all unique routes from current vessels
 * Populates the dropdown with route names from vessels with status 'enroute'
 *
 * @returns {void}
 * @example
 * updateRouteDropdown();
 */
function updateRouteDropdown() {
  const routeSelect = document.getElementById('routeFilterSelect');
  if (!routeSelect) {
    console.warn('[Harbor Map] Route filter select not found');
    return;
  }

  // Extract unique route names from vessels with status 'enroute'
  const routes = new Set();
  currentVessels.forEach(vessel => {
    if (vessel.status === 'enroute' && vessel.route_name) {
      routes.add(vessel.route_name);
    }
  });

  // Sort routes alphabetically
  const sortedRoutes = Array.from(routes).sort();

  console.log(`[Harbor Map] Found ${sortedRoutes.length} unique routes`);

  // Clear existing options (except "All Routes")
  routeSelect.innerHTML = '<option value="">All Routes</option>';

  // Add route options
  sortedRoutes.forEach(routeName => {
    const option = document.createElement('option');
    option.value = routeName;
    option.textContent = routeName;
    routeSelect.appendChild(option);
  });

  // Restore selected route if it exists
  if (currentRouteFilter && sortedRoutes.includes(currentRouteFilter)) {
    routeSelect.value = currentRouteFilter;
  } else {
    currentRouteFilter = null;
    routeSelect.value = '';
  }

  // Set width based on longest option text
  const allOptions = ['All Routes', ...sortedRoutes];
  let maxWidth = 0;
  const tempSpan = document.createElement('span');
  tempSpan.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap; font-size: 13px; font-weight: 500;';
  document.body.appendChild(tempSpan);

  allOptions.forEach(text => {
    tempSpan.textContent = text;
    const width = tempSpan.offsetWidth;
    if (width > maxWidth) maxWidth = width;
  });

  document.body.removeChild(tempSpan);

  // Set width: longest text + 4px left padding + 21px right padding (for space)
  routeSelect.style.width = `${maxWidth + 25}px`;
}

/**
 * Sets the route filter and re-renders map with filtered vessels
 * Also opens the route vessels panel if a route is selected
 * When a route is selected, draws the route path and shows only origin/destination ports
 *
 * @param {string} routeName - Route name to filter by (empty string = all routes)
 * @returns {Promise<void>}
 * @example
 * await setRouteFilter('Hamburg - New York');
 */
async function setRouteFilter(routeName) {
  currentRouteFilter = routeName || null;

  // Save to localStorage
  if (currentRouteFilter) {
    localStorage.setItem('harborMapRouteFilter', currentRouteFilter);
  } else {
    localStorage.removeItem('harborMapRouteFilter');
  }

  console.log(`[Harbor Map] Route filter changed to: ${currentRouteFilter || 'All Routes'}`);

  // Filter vessels - when route is selected, use ALL vessels (ignore vessel filter)
  const vesselsToRender = currentRouteFilter
    ? rawVessels.filter(v => v.route_name === currentRouteFilter)
    : currentVessels;

  console.log(`[Harbor Map] Rendering ${vesselsToRender.length} vessels (filtered by route, ignoring vessel filter)`);

  if (currentRouteFilter && vesselsToRender.length > 0) {
    // Close all other panels before showing route panel
    await closeAllPanels();

    // Route selected - extract route from first vessel
    const firstVessel = vesselsToRender[0];

    // Build route from vessel.active_route (same as in vessel click handler)
    if (firstVessel.status === 'enroute' && firstVessel.active_route?.path) {
      // Handle reversed routes
      const isReversed = firstVessel.active_route.reversed === true;
      const actualOrigin = isReversed
        ? (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination)
        : (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin);
      const actualDestination = isReversed
        ? (firstVessel.active_route.origin_port_code || firstVessel.active_route.origin)
        : (firstVessel.active_route.destination_port_code || firstVessel.active_route.destination);

      const route = {
        path: firstVessel.active_route.path,
        origin: actualOrigin,
        destination: actualDestination
      };

      // Filter ports to show only origin and destination (use rawPorts to get all ports)
      const routePorts = rawPorts.filter(p =>
        p.code === route.origin || p.code === route.destination
      );

      // Clear all markers before rendering
      vesselClusterGroup.clearLayers();
      portLocationClusterGroup.clearLayers();

      // Render vessels and route ports
      renderVessels(vesselsToRender);
      renderPorts(routePorts);

      // Draw route path (with auto-zoom)
      drawRoute(route, rawPorts, true);

      console.log(`[Harbor Map] Route drawn: ${route.origin} → ${route.destination}, ${route.path.length} points`);
    } else {
      console.warn('[Harbor Map] No active route available for vessel');

      // Clear all markers before rendering
      vesselClusterGroup.clearLayers();
      portLocationClusterGroup.clearLayers();

      renderVessels(vesselsToRender);
      renderPorts(currentPorts);
      clearRoute();
    }

    // Show route vessels panel
    showRouteVesselsPanel(currentRouteFilter, vesselsToRender);
  } else {
    // No route selected - show all vessels and ports
    renderVessels(vesselsToRender);
    renderPorts(currentPorts);
    clearRoute();
    hideRouteVesselsPanel();
  }
}

/**
 * Shows the route vessels panel with a list of all vessels on the selected route
 *
 * @param {string} routeName - Name of the route
 * @param {Array<Object>} vessels - Vessels on this route
 * @returns {void}
 */
async function showRouteVesselsPanel(routeName, vessels) {
  const { showRoutePanel } = await import('./route-vessels-panel.js');
  showRoutePanel(routeName, vessels);
}

/**
 * Hides the route vessels panel
 *
 * @returns {void}
 */
async function hideRouteVesselsPanel() {
  const { hideRoutePanel } = await import('./route-vessels-panel.js');
  hideRoutePanel();
}
