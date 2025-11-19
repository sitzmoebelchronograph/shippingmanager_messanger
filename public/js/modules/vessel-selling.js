/**
 * @fileoverview Vessel Selling Module
 *
 * Handles selling of owned vessels grouped by model.
 * Only vessels in harbor (not enroute) can be sold.
 * Displays all vessel specs like the purchase catalog.
 * Shows list of owned vessels with max 5 visible (scrollable).
 *
 * @module vessel-selling
 */

import { showConfirmDialog } from './ui-dialogs.js';
import { showSideNotification, formatNumber } from './utils.js';
import { selectVessel } from './harbor-map/map-controller.js';

let currentSellVessels = [];
let selectedSellVessels = [];
let currentSellFilter = 'container';
let globalPriceMap = new Map(); // Global price map for access in event handlers

const SELL_CART_CACHE_KEY = 'vessel_sell_cart';

/**
 * Load sell cart from localStorage
 */
function loadSellCartFromCache() {
  try {
    const cached = localStorage.getItem(SELL_CART_CACHE_KEY);
    if (cached) {
      selectedSellVessels = JSON.parse(cached);

      // Migrate old format to new format if needed
      let needsMigration = false;
      selectedSellVessels.forEach(item => {
        if (!item.vesselPrices && item.sellPrice !== undefined) {
          needsMigration = true;
          // Convert old format to new format
          item.vesselPrices = item.vesselIds.map(id => ({
            vesselId: id,
            sellPrice: item.sellPrice,
            originalPrice: item.originalPrice
          }));
          delete item.sellPrice;
          delete item.originalPrice;
        }
      });

      if (needsMigration) {
        saveSellCartToCache();
        console.log('[Vessel Selling] Migrated cart to new format');
      }

      updateBulkSellButton();
      console.log('[Vessel Selling] Loaded', selectedSellVessels.length, 'items from cache');
    }
  } catch (error) {
    console.error('[Vessel Selling] Failed to load cart from cache:', error);
  }
}

/**
 * Save sell cart to localStorage
 */
function saveSellCartToCache() {
  try {
    localStorage.setItem(SELL_CART_CACHE_KEY, JSON.stringify(selectedSellVessels));
  } catch (error) {
    console.error('[Vessel Selling] Failed to save cart to cache:', error);
  }
}

/**
 * Clear sell cart cache
 */
function clearSellCartCache() {
  try {
    localStorage.removeItem(SELL_CART_CACHE_KEY);
  } catch (error) {
    console.error('[Vessel Selling] Failed to clear cart cache:', error);
  }
}

/**
 * Opens the sell vessels overlay and loads user vessels
 * ALWAYS fetches fresh data when opening - no stale cached data
 */
export async function openSellVesselsOverlay() {
  document.getElementById('sellVesselsOverlay').classList.remove('hidden');
  loadSellCartFromCache();

  // Show cached data immediately (if available) for instant display
  if (currentSellVessels && currentSellVessels.length > 0) {
    // Display cached static data immediately
    await displaySellVessels();
  }

  // Then fetch fresh data in background for dynamic fields
  // Clear cache and fetch new data
  currentSellVessels = [];
  await loadUserVesselsForSale();
}

/**
 * Closes the sell vessels overlay
 */
export function closeSellVesselsOverlay() {
  document.getElementById('sellVesselsOverlay').classList.add('hidden');
  selectedSellVessels = [];
  updateBulkSellButton();
}

/**
 * Refreshes the vessel list in the sell vessels overlay.
 * Called when vessels are departed by autopilot or manually to update the UI.
 * Only refreshes if the overlay is currently open.
 *
 * @returns {Promise<void>}
 */
export async function refreshVesselsForSale() {
  // Only refresh if overlay is open
  const overlay = document.getElementById('sellVesselsOverlay');
  if (!overlay || overlay.classList.contains('hidden')) {
    return;
  }

  console.log('[Vessel Selling] Refreshing vessels due to departure');
  await loadUserVesselsForSale();
}

/**
 * Loads user's vessels and groups them by model
 * Implements progressive loading - shows static data first, then updates dynamic data
 */
async function loadUserVesselsForSale() {
  const startTime = performance.now();
  try {
    // Import fetchVessels which uses cache
    const { fetchVessels } = await import('./api.js');

    const fetchStart = performance.now();
    // This will use cache if available (instant), otherwise fetches
    const data = await fetchVessels();
    const fetchEnd = performance.now();
    if (window.DEBUG_MODE) {
      console.log(`[Sell Perf] Fetch vessels: ${(fetchEnd - fetchStart).toFixed(2)}ms`);
    }

    const vessels = data.vessels || [];

    currentSellVessels = vessels;

    const displayStart = performance.now();
    await displaySellVessels();
    const displayEnd = performance.now();
    if (window.DEBUG_MODE) {
      console.log(`[Sell Perf] Display vessels: ${(displayEnd - displayStart).toFixed(2)}ms`);
    }

    // Clean up cart - remove vessels that no longer exist (sold/deleted)
    const existingVesselIds = new Set(vessels.map(v => v.id));
    const itemsToRemove = [];
    const itemsToUpdate = [];

    selectedSellVessels.forEach(item => {
      // Check if all vessel IDs in this cart item still exist
      const validVesselIds = item.vesselIds.filter(id => existingVesselIds.has(id));

      if (validVesselIds.length === 0) {
        // All vessels for this item are gone - remove from cart
        itemsToRemove.push(item.modelKey);
        console.log(`[Cart] Removing ${item.modelName} from cart - all vessels sold/deleted`);
      } else if (validVesselIds.length < item.vesselIds.length) {
        // Some vessels are gone - update the item and recalculate prices
        item.vesselIds = validVesselIds;
        item.quantity = validVesselIds.length;
        itemsToUpdate.push(item);
        console.log(`[Cart] Updated ${item.modelName} - reduced quantity to ${validVesselIds.length}, recalculating prices`);
      }
    });

    // Recalculate prices for updated items
    if (itemsToUpdate.length > 0 && priceMap && priceMap.size > 0) {
      itemsToUpdate.forEach(item => {
        let totalSellPrice = 0;
        let totalOriginalPrice = 0;
        let pricesFound = 0;

        item.vesselIds.forEach(vesselId => {
          const priceInfo = priceMap.get(vesselId);
          if (priceInfo && priceInfo.sellPrice !== undefined && priceInfo.originalPrice !== undefined) {
            totalSellPrice += priceInfo.sellPrice;
            totalOriginalPrice += priceInfo.originalPrice;
            pricesFound++;
          }
        });

        if (pricesFound > 0) {
          item.sellPrice = totalSellPrice / pricesFound;
          item.originalPrice = totalOriginalPrice / pricesFound;
          console.log(`[Cart] Recalculated prices for ${item.modelName}: sell=$${item.sellPrice}, original=$${item.originalPrice}`);
        } else {
          // No valid prices found - mark as undefined
          item.sellPrice = undefined;
          item.originalPrice = undefined;
          console.warn(`[Cart] No valid prices found for ${item.modelName}`);
        }
      });
    }

    // Remove invalid items
    itemsToRemove.forEach(modelKey => {
      removeVesselSelectionFromCart(modelKey);
    });

    if (itemsToRemove.length > 0) {
      saveSellCartToCache();
    }

    const totalTime = performance.now() - startTime;
    if (window.DEBUG_MODE) {
      console.log(`[Sell Perf] Total load time: ${totalTime.toFixed(2)}ms`);
    }
  } catch (error) {
    console.error('[Vessel Selling] Error loading vessels:', error);
    showSideNotification('Failed to load vessels', 'error');
  }
}

/**
 * Fetches sell prices for all unique vessel models in parallel
 * @param {Object} grouped - Grouped vessels by model
 * @returns {Map} Map of vesselId -> {sellPrice, originalPrice}
 */
async function fetchAllSellPrices(grouped) {
  const priceMap = new Map();
  const priceRequests = [];

  // Fetch prices for ALL vessels, not just the first one
  Object.entries(grouped).forEach(([, group]) => {
    // Get prices for all harbor vessels in this group
    group.harborVessels.forEach(vessel => {
      priceRequests.push(
        fetch(window.apiUrl('/api/vessel/get-sell-price'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vessel_id: vessel.id })
        })
          .then(response => response.ok ? response.json() : null)
          .then(data => {
            if (data && data.data && data.data.selling_price !== undefined) {
              priceMap.set(vessel.id, {
                sellPrice: data.data.selling_price,
                originalPrice: data.data.original_price
              });
            }
          })
          .catch(error => {
            console.error(`[Vessel Selling] Failed to get sell price for vessel ${vessel.id}:`, error);
          })
      );
    });
  });

  // Wait for all price requests to complete in parallel
  await Promise.all(priceRequests);

  return priceMap;
}

/**
 * Groups vessels by exact ship model (same specs/type/image)
 * Groups by: type (image path) + type_name + year + capacity + engine
 */
function groupVesselsByModel(vessels) {
  const grouped = {};

  vessels.forEach(vessel => {
    // Create unique key based on ship specs (these determine the model)
    // Same type image, type_name, year, engine = same ship model
    const modelKey = `${vessel.type}_${vessel.type_name}_${vessel.year}_${vessel.engine_type}_${vessel.capacity_max?.dry || 0}_${vessel.capacity_max?.refrigerated || 0}_${vessel.capacity_max?.fuel || 0}_${vessel.capacity_max?.crude_oil || 0}`;

    if (!grouped[modelKey]) {
      grouped[modelKey] = {
        model: vessel,  // Use first vessel as template for specs/image
        vessels: [],
        harborVessels: []
      };
    }

    grouped[modelKey].vessels.push(vessel);

    // Harbor = not enroute
    if (vessel.status !== 'enroute') {
      grouped[modelKey].harborVessels.push(vessel);
    }
  });

  return grouped;
}

/**
 * Displays vessels grouped by model, sorted by harbor count
 */
async function displaySellVessels() {
  const feed = document.getElementById('sellVesselCatalogFeed');
  const filtered = currentSellVessels.filter(v => v.capacity_type === currentSellFilter);

  if (filtered.length === 0) {
    feed.innerHTML = `
      <div class="sell-empty-state">
        <div class="sell-empty-icon">⛴️</div>
        <div class="sell-empty-title">No ${currentSellFilter} vessels</div>
        <div class="sell-empty-subtitle">You don't own any ${currentSellFilter} vessels</div>
      </div>
    `;
    return;
  }

  const grouped = groupVesselsByModel(filtered);

  // First render the cards with static data (immediate display)
  let priceMap = new Map();

  // Use cached prices if available for immediate display
  if (window.cachedSellPrices && window.cachedSellPrices.size > 0) {
    priceMap = window.cachedSellPrices;
    globalPriceMap = priceMap; // Update global for access in event handlers
  }

  // Separate into harbor and at sea
  const atPort = [];
  const atSea = [];

  Object.entries(grouped).forEach(([modelKey, group]) => {
    if (group.harborVessels.length > 0) {
      atPort.push([modelKey, group]);
    } else {
      atSea.push([modelKey, group]);
    }
  });

  // Sort each by harbor count (descending)
  atPort.sort((a, b) => b[1].harborVessels.length - a[1].harborVessels.length);
  atSea.sort((a, b) => b[1].vessels.length - a[1].vessels.length);

  const container = document.createElement('div');

  // Info notice at top
  if (atSea.length > 0) {
    const notice = document.createElement('div');
    notice.className = 'sell-info-notice';
    notice.innerHTML = 'ℹ️ Only vessels at port can be sold.';
    container.appendChild(notice);
  }

  // Helper function to render a vessel card
  const renderVesselCard = async (modelKey, group, canSell, priceMap) => {
    const model = group.model;
    const allVessels = group.vessels;
    const harborVessels = group.harborVessels;

    const selectedItem = selectedSellVessels.find(v => v.modelKey === modelKey);
    const isSelected = !!selectedItem;

    const imageUrl = `/api/vessel-image/${model.type}`;
    const capacityDisplay = getCapacityDisplay(model);
    const co2Class = getCO2EfficiencyClass(model.co2_factor);
    const fuelClass = getFuelEfficiencyClass(model.fuel_factor);

    let additionalAttrs = '';
    if (model.width && model.width !== 0) {
      additionalAttrs += `<div class="vessel-spec"><strong>Width:</strong> ${model.width} m</div>`;
    }
    if (model.perks && model.perks !== null) {
      additionalAttrs += `<div class="vessel-spec vessel-spec-fullwidth"><strong>Perks:</strong> ${model.perks}</div>`;
    }

    const card = document.createElement('div');
    card.className = `vessel-card${isSelected ? ' selected' : ''}${!canSell ? ' disabled' : ''}`;

    card.innerHTML = `
      <div class="vessel-image-container">
        <img src="${imageUrl}" alt="${model.type_name}" class="vessel-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect fill=%22%23374151%22 width=%22400%22 height=%22300%22/><text x=%2250%%22 y=%2250%%22 fill=%22%239ca3af%22 text-anchor=%22middle%22 font-size=%2224%22>⛴️</text></svg>'">
      </div>
      <div class="vessel-content">
        <div class="vessel-header">
          <h3 class="vessel-name">${allVessels[0].name.replace(/_\d+$/, '')}</h3>
        </div>
        <div class="vessel-specs">
          <div class="vessel-spec"><strong>Capacity:</strong> ${capacityDisplay}</div>
          <div class="vessel-spec"><strong>Range:</strong> ${formatNumber(model.range)} nm</div>
          <div class="vessel-spec ${co2Class}"><strong>CO2 Factor:</strong> ${model.co2_factor}</div>
          <div class="vessel-spec ${fuelClass}"><strong>Fuel Factor:</strong> ${model.fuel_factor}</div>
          <div class="vessel-spec"><strong>Fuel Cap.:</strong> ${formatNumber(model.fuel_capacity)} t</div>
          <div class="vessel-spec"><strong>Service:</strong> ${model.hours_between_service}h</div>
          <div class="vessel-spec"><strong>Engine:</strong> ${model.engine_type} (${formatNumber(model.kw)} kW)</div>
          <div class="vessel-spec"><strong>Speed:</strong> ${model.max_speed} kn</div>
          <div class="vessel-spec"><strong>Type:</strong> ${model.type_name}</div>
          <div class="vessel-spec"><strong>Owned:</strong> ${allVessels.length}</div>
          <div class="vessel-spec"><strong>Year:</strong> ${model.year}</div>
          <div class="vessel-spec"><strong>Length:</strong> ${model.length} m</div>
          <div class="vessel-spec"><strong>IMO:</strong> ${model.imo || 'N/A'}</div>
          <div class="vessel-spec"><strong>MMSI:</strong> ${model.mmsi || 'N/A'}</div>
          ${model.gearless || model.antifouling || additionalAttrs ? '<div class="vessel-spec vessel-spec-divider"></div>' : ''}
          ${model.gearless ? '<div class="vessel-spec vessel-spec-fullwidth vessel-spec-gearless"><strong>⚙️ Gearless:</strong> own cranes</div>' : ''}
          ${model.antifouling ? `<div class="vessel-spec vessel-spec-fullwidth vessel-spec-antifouling"><strong>🛡️ Antifouling:</strong> ${model.antifouling}</div>` : ''}
          ${additionalAttrs}
        </div>

        <div class="sell-vessel-list-section">
          <div class="sell-vessel-list-header">
            <span class="sell-vessel-list-title">Your Vessels</span>
            <span class="sell-vessel-list-count">${harborVessels.length} in harbor / ${allVessels.length} total</span>
          </div>
          <div class="sell-vessel-list-container" data-model-key="${modelKey}">
            ${(() => {
              // Sort: harbor vessels first, then at sea
              const sorted = [...allVessels].sort((a, b) => {
                const aInHarbor = a.status !== 'enroute';
                const bInHarbor = b.status !== 'enroute';
                if (aInHarbor && !bInHarbor) return -1;
                if (!aInHarbor && bInHarbor) return 1;
                return 0;
              });

              return sorted.map((v) => {
                const canSelect = v.status !== 'route' && v.status !== 'enroute';

                // Get the sell price for this specific vessel
                const vesselPriceInfo = priceMap && priceMap.get ? priceMap.get(v.id) : null;
                const vesselSellPrice = vesselPriceInfo ? vesselPriceInfo.sellPrice : null;

                // Show loading placeholder if price not yet available
                const priceDisplay = vesselSellPrice
                  ? `<span class="sell-vessel-price">$${formatNumber(vesselSellPrice)}</span>`
                  : `<span class="sell-vessel-price" data-vessel-id="${v.id}">Loading...</span>`;

                // Status: emoji only, text as mouseover
                let statusDisplay;
                if (v.status === 'port') {
                  statusDisplay = '<span title="Harbor" style="color: #10b981;">⚓</span>';
                } else if (v.status === 'anchor') {
                  statusDisplay = '<span title="Anchored">⚓</span>';
                } else if (v.status === 'route' || v.status === 'enroute') {
                  statusDisplay = '<span title="En Route">🚢</span>';
                } else if (v.status === 'pending') {
                  statusDisplay = '<span title="Delivery">⏳</span>';
                } else {
                  statusDisplay = v.status;
                }

                return `
                  <div class="sell-vessel-list-item">
                    <div class="sell-vessel-item-left">
                      ${canSelect && canSell ? `<input type="checkbox" class="vessel-checkbox sell-vessel-checkbox" data-vessel-id="${v.id}" data-model-key="${modelKey}" data-sell-price="${vesselSellPrice || 0}">` : '<div class="sell-vessel-checkbox-placeholder"></div>'}
                      <span class="${canSelect ? 'sell-vessel-name-available' : 'sell-vessel-name-unavailable'}">${v.name}</span>
                      <button class="vessel-locate-btn" data-vessel-id="${v.id}" title="Show on map" onmouseover="this.querySelector('span').style.animation='pulse-arrow 0.6s ease-in-out infinite'" onmouseout="this.querySelector('span').style.animation='none'"><span>📍</span></button>
                    </div>
                    <div class="sell-vessel-item-right">
                      ${canSelect ? priceDisplay : ''}
                      <span class="sell-vessel-status">${statusDisplay}</span>
                    </div>
                  </div>
                `;
              }).join('');
            })()}
          </div>
        </div>

        ${canSell ? `
          <div class="vessel-actions">
            <input type="number" class="vessel-quantity-input" data-model-key="${modelKey}" value="1" min="1" max="${harborVessels.length}" />
            <div class="vessel-action-buttons">
              <button class="vessel-select-btn${isSelected ? ' selected' : ''}" data-model-key="${modelKey}">
                Add to Cart
              </button>
              <button class="vessel-buy-btn vessel-sell-now-btn" data-model-key="${modelKey}">
                Sell Now
              </button>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    // Locate vessel on map button handlers - ALWAYS register for all vessels
    const locateButtons = card.querySelectorAll('.vessel-locate-btn');
    locateButtons.forEach(btn => {
      btn.addEventListener('click', async () => {
        const vesselId = parseInt(btn.dataset.vesselId);

        // Close sell vessels overlay
        document.getElementById('sellVesselsOverlay').classList.add('hidden');

        // Open harbor map and select vessel
        if (window.showHarborMapOverlay) {
          await window.showHarborMapOverlay();
        }

        // Select the vessel on map
        await selectVessel(vesselId);
      });
    });

    if (canSell) {
      const selectBtn = card.querySelector('.vessel-select-btn');
      const sellBtn = card.querySelector('.vessel-buy-btn');
      const quantityInput = card.querySelector('.vessel-quantity-input');
      const checkboxes = card.querySelectorAll('.vessel-checkbox');

      // Checkbox change handler - update cart when checkbox is clicked
      checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
          const checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');
          const selectedVesselIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.vesselId));
          const quantity = selectedVesselIds.length;

          // Update quantity input to match
          if (quantityInput) {
            quantityInput.value = quantity;
          }

          // Update cart - store individual vessel prices and names
          if (quantity > 0) {
            const vesselPrices = [];
            const vesselNames = {};

            selectedVesselIds.forEach(vesselId => {
              const vessel = harborVessels.find(v => v.id === vesselId);
              if (vessel) {
                vesselNames[vesselId] = vessel.name;
              }

              const priceInfo = globalPriceMap && globalPriceMap.get ? globalPriceMap.get(vesselId) : null;
              if (priceInfo && priceInfo.sellPrice !== undefined && priceInfo.originalPrice !== undefined) {
                vesselPrices.push({
                  vesselId,
                  sellPrice: priceInfo.sellPrice,
                  originalPrice: priceInfo.originalPrice
                });
              }
            });

            updateVesselSelectionInCart(modelKey, quantity, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, vesselPrices, vesselNames);
          } else {
            removeVesselSelectionFromCart(modelKey);
          }
        });
      });

      // Quantity input change handler - just select checkboxes (no cart update)
      if (quantityInput) {
        quantityInput.addEventListener('input', () => {
          const quantity = parseInt(quantityInput.value) || 0;
          const maxQuantity = harborVessels.length;

          if (quantity > maxQuantity) {
            quantityInput.value = maxQuantity;
            return;
          }

          // Uncheck all first
          checkboxes.forEach(cb => cb.checked = false);

          // Select first 'quantity' checkboxes (top to bottom)
          if (quantity > 0) {
            Array.from(checkboxes).slice(0, quantity).forEach(cb => cb.checked = true);
          }

          // Trigger change event on first checkbox to update cart
          if (checkboxes.length > 0) {
            checkboxes[0].dispatchEvent(new Event('change'));
          }
        });
      }

      if (selectBtn) {
        selectBtn.addEventListener('click', () => {
          let checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');

          // If nothing selected, auto-select from quantity input
          if (checkedBoxes.length === 0) {
            const quantity = quantityInput?.value ? parseInt(quantityInput.value) : 1;
            checkboxes.forEach(cb => cb.checked = false);
            Array.from(checkboxes).slice(0, quantity).forEach(cb => cb.checked = true);
            checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');
          }

          const selectedVesselIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.vesselId));

          if (selectedVesselIds.length === 0) {
            showSideNotification('Please select at least one vessel', 'error');
            return;
          }

          // Collect individual vessel prices AND names
          const vesselPrices = [];
          const vesselNames = {};

          selectedVesselIds.forEach(vesselId => {
            const vessel = harborVessels.find(v => v.id === vesselId);
            if (vessel) {
              vesselNames[vesselId] = vessel.name;
            }

            const priceInfo = globalPriceMap && globalPriceMap.get ? globalPriceMap.get(vesselId) : null;
            if (priceInfo && priceInfo.sellPrice !== undefined && priceInfo.originalPrice !== undefined) {
              vesselPrices.push({
                vesselId,
                sellPrice: priceInfo.sellPrice,
                originalPrice: priceInfo.originalPrice
              });
            }
          });

          // Update cart (replaces quantity, does not increment)
          updateVesselSelectionInCart(modelKey, selectedVesselIds.length, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, vesselPrices, vesselNames);
          showSideNotification(`Added ${selectedVesselIds.length}x ${allVessels[0].name.replace(/_\d+$/, '')} to cart`, 'success');
        });
      }

      if (sellBtn) {
        sellBtn.addEventListener('click', () => {
          let checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');

          // If nothing selected, auto-select from top based on quantity input
          if (checkedBoxes.length === 0) {
            const quantity = quantityInput?.value ? parseInt(quantityInput.value) : 1;
            Array.from(checkboxes).slice(0, quantity).forEach(cb => cb.checked = true);
            checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');
          }

          const selectedVesselIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.vesselId));

          if (selectedVesselIds.length === 0) {
            showSideNotification('Please select at least one vessel', 'error');
            return;
          }

          // Collect individual vessel prices and names
          const vesselPrices = [];
          const vesselNames = {};

          selectedVesselIds.forEach(vesselId => {
            // Get vessel name
            const vessel = harborVessels.find(v => v.id === vesselId);
            if (vessel) {
              vesselNames[vesselId] = vessel.name;
            }

            // Get price info from global price map
            const priceInfo = globalPriceMap && globalPriceMap.get ? globalPriceMap.get(vesselId) : null;
            if (priceInfo && priceInfo.sellPrice !== undefined && priceInfo.originalPrice !== undefined) {
              vesselPrices.push({
                vesselId,
                sellPrice: priceInfo.sellPrice,
                originalPrice: priceInfo.originalPrice
              });
            }
          });

          // Add to cart
          updateVesselSelectionInCart(modelKey, selectedVesselIds.length, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, vesselPrices, vesselNames);

          // Immediately open the cart dialog
          showSellCart();
        });
      }
    }

    return card;
  };

  // At Port or on Delivery section
  if (atPort.length > 0) {
    const portHeader = document.createElement('h2');
    portHeader.className = 'sell-section-header port';
    portHeader.textContent = '⚓ At Port or on Delivery';
    container.appendChild(portHeader);

    const portGrid = document.createElement('div');
    portGrid.className = 'vessel-catalog-grid';
    for (const [modelKey, group] of atPort) {
      // Pass the entire priceMap so each vessel can look up its own price
      portGrid.appendChild(await renderVesselCard(modelKey, group, true, priceMap));
    }
    container.appendChild(portGrid);
  }

  // At Sea section
  if (atSea.length > 0) {
    const seaHeader = document.createElement('h2');
    seaHeader.className = 'sell-section-header sea';
    seaHeader.textContent = '🚢 At Sea';
    container.appendChild(seaHeader);

    const seaGrid = document.createElement('div');
    seaGrid.className = 'vessel-catalog-grid';
    for (const [modelKey, group] of atSea) {
      // No price info for vessels at sea (can't be sold)
      seaGrid.appendChild(await renderVesselCard(modelKey, group, false, null));
    }
    container.appendChild(seaGrid);
  }

  feed.innerHTML = '';
  feed.appendChild(container);

  // Restore checkboxes for cached items
  selectedSellVessels.forEach(item => {
    updateSelectButtonState(item.modelKey, item.quantity);
  });

  // Now fetch prices in background and update when ready (progressive loading)
  fetchAllSellPrices(grouped).then(newPriceMap => {
    // Cache prices for next time
    window.cachedSellPrices = newPriceMap;
    globalPriceMap = newPriceMap; // Update global for access in event handlers

    // Update all price displays
    newPriceMap.forEach((priceInfo, vesselId) => {
      // Update price display in vessel list (using data-vessel-id attribute)
      const priceSpan = document.querySelector(`.sell-vessel-price[data-vessel-id="${vesselId}"]`);
      if (priceSpan) {
        priceSpan.textContent = `$${formatNumber(priceInfo.sellPrice)}`;
      }

      // Update checkbox data attribute
      const checkbox = document.querySelector(`.vessel-checkbox[data-vessel-id="${vesselId}"]`);
      if (checkbox) {
        checkbox.dataset.sellPrice = priceInfo.sellPrice;
      }
    });

    // Update the local priceMap variable too
    priceMap = newPriceMap;

    if (window.DEBUG_MODE) {
      console.log(`[Sell Perf] Updated ${newPriceMap.size} prices after progressive load`);
    }
  }).catch(error => {
    console.error('[Vessel Selling] Error fetching sell prices:', error);
  });
}

/**
 * Formats vessel capacity display for user vessels (selling catalog).
 * Display differs from acquirable vessels because API endpoint returns different data structure:
 * - User vessels (selling): Detailed breakdown (vessel.capacity_max.dry, .refrigerated, etc.)
 * - Acquirable vessels: Simple capacity number (vessel.capacity)
 */
function getCapacityDisplay(vessel) {
  if (vessel.capacity_type === 'container') {
    const dry = vessel.capacity_max?.dry || 0;
    const ref = vessel.capacity_max?.refrigerated || 0;
    const total = dry + ref;
    return `${formatNumber(total)} TEU (${formatNumber(dry)} dry / ${formatNumber(ref)} ref)`;
  } else if (vessel.capacity_type === 'tanker') {
    const fuel = vessel.capacity_max?.fuel || 0;
    const crude = vessel.capacity_max?.crude_oil || 0;
    const maxCapacity = Math.max(fuel, crude);
    return `${formatNumber(maxCapacity)} bbl (${formatNumber(fuel)} bbl fuel / ${formatNumber(crude)} bbl crude)`;
  } else {
    // Other vessel types (bulk carriers, etc)
    return `${formatNumber(vessel.capacity_max || 0)}t`;
  }
}

/**
 * Gets CSS class for CO2 efficiency factor (lower is better)
 */
function getCO2EfficiencyClass(factor) {
  if (factor < 1.0) return 'vessel-spec-co2-efficient'; // green
  if (factor === 1.0) return 'vessel-spec-co2-standard'; // gray
  return 'vessel-spec-co2-inefficient'; // orange
}

/**
 * Gets CSS class for Fuel efficiency factor (lower is better)
 */
function getFuelEfficiencyClass(factor) {
  if (factor < 1.0) return 'vessel-spec-fuel-efficient'; // green
  if (factor === 1.0) return 'vessel-spec-fuel-standard'; // gray
  return 'vessel-spec-fuel-inefficient'; // orange
}

/**
 * Updates vessel selection in cart (replaces quantity - used by cart controls)
 */
function updateVesselSelectionInCart(modelKey, quantity, modelName, vesselIds, vesselPrices, vesselNames) {
  const index = selectedSellVessels.findIndex(v => v.modelKey === modelKey);

  if (index > -1) {
    // Update existing selection
    selectedSellVessels[index].quantity = quantity;
    selectedSellVessels[index].vesselIds = vesselIds;
    selectedSellVessels[index].vesselPrices = vesselPrices;
    selectedSellVessels[index].vesselNames = vesselNames;
  } else {
    // Add new selection
    selectedSellVessels.push({ modelKey, quantity, modelName, vesselIds, vesselPrices, vesselNames });
  }

  const totalCount = selectedSellVessels.reduce((sum, item) => sum + item.quantity, 0);
  const sellCartCountEl = document.getElementById('sellCartCount');
  const sellCartBtn = document.getElementById('sellCartBtn');

  if (sellCartCountEl) sellCartCountEl.textContent = totalCount;
  if (sellCartBtn) {
    if (selectedSellVessels.length > 0) {
      sellCartBtn.classList.remove('hidden');
    } else {
      sellCartBtn.classList.add('hidden');
    }
  }

  // Update the select button state
  updateSelectButtonState(modelKey, quantity);
  saveSellCartToCache();
}

/**
 * Removes vessel selection from cart
 */
function removeVesselSelectionFromCart(modelKey) {
  const index = selectedSellVessels.findIndex(v => v.modelKey === modelKey);

  if (index > -1) {
    selectedSellVessels.splice(index, 1);
  }

  const totalCount = selectedSellVessels.reduce((sum, item) => sum + item.quantity, 0);
  const sellCartCountEl = document.getElementById('sellCartCount');
  const sellCartBtn = document.getElementById('sellCartBtn');

  if (sellCartCountEl) sellCartCountEl.textContent = totalCount;
  if (sellCartBtn) {
    if (selectedSellVessels.length > 0) {
      sellCartBtn.classList.remove('hidden');
    } else {
      sellCartBtn.classList.add('hidden');
    }
  }

  // Update the select button state
  updateSelectButtonState(modelKey, 0);
  saveSellCartToCache();
}

/**
 * Updates the select button state without re-rendering
 */
function updateSelectButtonState(modelKey) {
  const cards = document.querySelectorAll('.vessel-card');
  cards.forEach(card => {
    const selectBtn = card.querySelector(`.vessel-select-btn[data-model-key="${modelKey}"]`);
    if (selectBtn) {
      const cartItem = selectedSellVessels.find(v => v.modelKey === modelKey);
      if (cartItem) {
        selectBtn.classList.add('selected');
        card.classList.add('selected');
      } else {
        selectBtn.classList.remove('selected');
        card.classList.remove('selected');
      }

      // Update checkboxes - only check the ones in vesselIds
      const checkboxes = card.querySelectorAll(`.vessel-checkbox[data-model-key="${modelKey}"]`);
      checkboxes.forEach(checkbox => {
        const vesselId = parseInt(checkbox.dataset.vesselId);
        if (cartItem && cartItem.vesselIds.includes(vesselId)) {
          checkbox.checked = true;
        } else {
          checkbox.checked = false;
        }
      });
    }
  });
}

/**
 * Updates sell cart button visibility
 */
function updateBulkSellButton() {
  const sellCartBtn = document.getElementById('sellCartBtn');
  const sellCartCountEl = document.getElementById('sellCartCount');

  if (selectedSellVessels.length > 0) {
    const totalCount = selectedSellVessels.reduce((sum, item) => sum + item.quantity, 0);
    sellCartBtn.classList.remove('hidden');
    sellCartCountEl.textContent = totalCount;
  } else {
    sellCartBtn.classList.add('hidden');
  }
}

// sellVessels function removed - "Sell Now" button now uses the cart dialog via showSellCart()

/**
 * Shows the sell cart overlay
 */
export function showSellCart() {
  if (selectedSellVessels.length === 0) {
    showSideNotification('Cart is empty', 'info');
    return;
  }

  // Calculate total from individual vessel prices
  const totalRevenue = selectedSellVessels.reduce((sum, item) => {
    if (!item.vesselPrices || item.vesselPrices.length === 0) {
      // Check for legacy format
      if (item.sellPrice !== undefined && item.sellPrice !== null) {
        return sum + (item.sellPrice * item.quantity);
      }
      console.warn(`[Cart] Warning: no vessel prices for ${item.modelName}, skipping from total`);
      return sum;
    }
    const itemTotal = item.vesselPrices.reduce((priceSum, vp) => priceSum + (vp.sellPrice || 0), 0);
    return sum + itemTotal;
  }, 0);
  const totalItems = selectedSellVessels.reduce((sum, item) => sum + item.quantity, 0);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog shopping-cart-dialog';

  // Build cart items HTML - show individual vessels, not grouped
  const cartItemsHtml = selectedSellVessels.map(item => {
    // Get vessel names from priceMap or use IDs
    let vesselLines = [];

    if (item.vesselPrices && item.vesselPrices.length > 0) {
      // Show each vessel as individual line
      item.vesselPrices.forEach(vp => {
        const vesselName = item.vesselNames && item.vesselNames[vp.vesselId]
          ? item.vesselNames[vp.vesselId]
          : `${item.modelName}_${vp.vesselId}`;

        vesselLines.push(`
          <div class="cart-item invoice-line" data-vessel-id="${vp.vesselId}" data-model-key="${item.modelKey}">
            <span class="invoice-name">${vesselName}</span>
            <span class="invoice-unit-price">$${formatNumber(vp.sellPrice || 0)}</span>
            <span class="invoice-total">$${formatNumber(vp.sellPrice || 0)}</span>
            <button class="remove-btn-small" data-vessel-id="${vp.vesselId}" data-model-key="${item.modelKey}" title="Remove">×</button>
          </div>
        `);
      });
    }

    return vesselLines.join('');
  }).join('');

  dialog.innerHTML = `
    <div class="confirm-dialog-header invoice-header">
      <h3>Sell Order Summary</h3>
      <div class="confirm-dialog-buttons">
        <button class="confirm-dialog-btn cancel" data-action="cancel">Cancel</button>
        <button class="confirm-dialog-btn confirm" data-action="sell">Confirm Sale</button>
      </div>
    </div>
    <div class="confirm-dialog-body invoice-body">
      <div class="invoice-header-row">
        <span class="invoice-name">Vessel</span>
        <span class="invoice-unit-price">Price</span>
        <span class="invoice-total">Total</span>
        <span class="invoice-action"></span>
      </div>
      <div class="cart-items invoice-items">
        ${cartItemsHtml}
      </div>
      <div class="invoice-separator"></div>
      <div class="invoice-totals">
        <div class="invoice-total-row">
          <span class="invoice-total-label">Total Vessels:</span>
          <span class="invoice-total-value">${totalItems}</span>
        </div>
        <div class="invoice-total-row grand-total">
          <span class="invoice-total-label">Total Amount:</span>
          <span class="invoice-total-value">$${formatNumber(totalRevenue)}</span>
        </div>
      </div>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Event handlers
  const closeOverlay = () => {
    document.body.removeChild(overlay);
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOverlay();
  });

  dialog.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', closeOverlay);
  });

  dialog.querySelector('[data-action="sell"]').addEventListener('click', async () => {
    closeOverlay();
    await bulkSellVessels();
  });

  // Plus/Minus/Remove buttons
  dialog.querySelectorAll('.qty-btn-small.plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelKey = btn.dataset.modelKey;
      // Find item in cart and increase quantity by 1 (if available)
      const item = selectedSellVessels.find(v => v.modelKey === modelKey);
      if (item) {
        // Check max available
        const cards = document.querySelectorAll('.vessel-card');
        cards.forEach(card => {
          const quantityInput = card.querySelector(`.vessel-quantity-input[data-model-key="${modelKey}"]`);
          if (quantityInput) {
            const maxQuantity = parseInt(quantityInput.max);
            if (item.quantity < maxQuantity) {
              item.quantity++;
              // Update checkboxes
              const checkboxes = card.querySelectorAll('.vessel-checkbox');
              if (checkboxes[item.quantity - 1]) {
                checkboxes[item.quantity - 1].checked = true;

                // Add the new vessel to vesselIds and vesselPrices
                const newVesselId = parseInt(checkboxes[item.quantity - 1].dataset.vesselId);
                if (!item.vesselIds.includes(newVesselId)) {
                  item.vesselIds.push(newVesselId);

                  // Add price info for the new vessel
                  const priceInfo = priceMap && priceMap.get ? priceMap.get(newVesselId) : null;
                  if (priceInfo && priceInfo.sellPrice !== undefined) {
                    if (!item.vesselPrices) item.vesselPrices = [];
                    item.vesselPrices.push({
                      vesselId: newVesselId,
                      sellPrice: priceInfo.sellPrice,
                      originalPrice: priceInfo.originalPrice
                    });
                  }
                }
              }
              quantityInput.value = item.quantity;
              saveSellCartToCache();
              updateBulkSellButton();
              closeOverlay();
              showSellCart();
            }
          }
        });
      }
    });
  });

  dialog.querySelectorAll('.qty-btn-small.minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelKey = btn.dataset.modelKey;
      const item = selectedSellVessels.find(v => v.modelKey === modelKey);
      if (item && item.quantity > 1) {
        item.quantity--;
        // Update checkboxes
        const cards = document.querySelectorAll('.vessel-card');
        cards.forEach(card => {
          const quantityInput = card.querySelector(`.vessel-quantity-input[data-model-key="${modelKey}"]`);
          if (quantityInput) {
            const checkboxes = card.querySelectorAll('.vessel-checkbox');
            if (checkboxes[item.quantity]) {
              checkboxes[item.quantity].checked = false;

              // Remove the vessel from vesselIds and vesselPrices
              const removedVesselId = parseInt(checkboxes[item.quantity].dataset.vesselId);
              const vesselIndex = item.vesselIds.indexOf(removedVesselId);
              if (vesselIndex > -1) {
                item.vesselIds.splice(vesselIndex, 1);

                // Remove price info for this vessel
                if (item.vesselPrices) {
                  const priceIndex = item.vesselPrices.findIndex(vp => vp.vesselId === removedVesselId);
                  if (priceIndex > -1) {
                    item.vesselPrices.splice(priceIndex, 1);
                  }
                }
              }
            }
            quantityInput.value = item.quantity;
          }
        });
        saveSellCartToCache();
        updateBulkSellButton();
        closeOverlay();
        showSellCart();
      }
    });
  });

  dialog.querySelectorAll('.remove-btn-small').forEach(btn => {
    btn.addEventListener('click', () => {
      const vesselId = parseInt(btn.dataset.vesselId);
      const modelKey = btn.dataset.modelKey;

      // Find the item in cart
      const item = selectedSellVessels.find(v => v.modelKey === modelKey);
      if (item) {
        // Remove this specific vessel
        const vesselIndex = item.vesselIds.indexOf(vesselId);
        if (vesselIndex > -1) {
          item.vesselIds.splice(vesselIndex, 1);
          item.quantity--;

          // Remove from vesselPrices
          if (item.vesselPrices) {
            const priceIndex = item.vesselPrices.findIndex(vp => vp.vesselId === vesselId);
            if (priceIndex > -1) {
              item.vesselPrices.splice(priceIndex, 1);
            }
          }

          // Remove from vesselNames
          if (item.vesselNames && item.vesselNames[vesselId]) {
            delete item.vesselNames[vesselId];
          }

          // If no vessels left, remove the whole item
          if (item.quantity === 0 || item.vesselIds.length === 0) {
            const itemIndex = selectedSellVessels.indexOf(item);
            if (itemIndex > -1) {
              selectedSellVessels.splice(itemIndex, 1);
            }
          }

          // Uncheck the checkbox in the sell vessels overlay
          const cards = document.querySelectorAll('.vessel-card');
          cards.forEach(card => {
            const checkbox = card.querySelector(`.vessel-checkbox[data-vessel-id="${vesselId}"]`);
            if (checkbox) checkbox.checked = false;
          });

          saveSellCartToCache();
          updateBulkSellButton();
          closeOverlay();
          if (selectedSellVessels.length > 0) {
            showSellCart();
          }
        }
      }
    });
  });
}

/**
 * Performs bulk sell of selected vessels
 */
export async function bulkSellVessels() {
  if (selectedSellVessels.length === 0) return;

  try {
    let totalVessels = 0;
    let totalPrice = 0;
    const vesselIds = [];
    const vesselDetails = [];

    selectedSellVessels.forEach(sel => {
      totalVessels += sel.quantity;
      let itemTotal = 0;

      // Calculate total from individual vessel prices
      if (sel.vesselPrices && sel.vesselPrices.length > 0) {
        itemTotal = sel.vesselPrices.reduce((sum, vp) => sum + (vp.sellPrice || 0), 0);
      } else if (sel.sellPrice !== undefined) {
        // Legacy format support
        itemTotal = sel.sellPrice * sel.quantity;
      }

      totalPrice += itemTotal;
      vesselIds.push(...sel.vesselIds);

      // Add detail line for this model
      vesselDetails.push({
        label: `${sel.quantity}x ${sel.modelName}`,
        value: `$${formatNumber(itemTotal)}`
      });
    });

    // Add separator and total
    vesselDetails.push({
      label: '────────────',
      value: '────────────'
    });
    vesselDetails.push({
      label: 'Total Revenue',
      value: `$${formatNumber(totalPrice)}`
    });

    const confirmed = await showConfirmDialog({
      title: `⛴️ Bulk Sell (${totalVessels} Vessels)`,
      message: 'The following vessels will be sold:',
      confirmText: 'Sell All',
      cancelText: 'Cancel',
      details: vesselDetails
    });

    if (!confirmed) return;

    const response = await fetch(window.apiUrl('/api/vessel/sell-vessels'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: vesselIds })
    });

    if (!response.ok) throw new Error('Failed to sell vessels');

    // Send summary notification to backend (broadcasts to ALL clients with detailed list)
    try {
      const vesselsForSummary = selectedSellVessels.map(sel => ({
        name: sel.modelName,
        quantity: sel.quantity,
        price: sel.sellPrice,
        totalPrice: sel.sellPrice * sel.quantity
      }));

      await fetch(window.apiUrl('/api/vessel/broadcast-sale-summary'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vessels: vesselsForSummary,
          totalPrice: totalPrice,
          totalVessels: totalVessels
        })
      });
    } catch (error) {
      console.error('Error broadcasting sale summary:', error);
    }

    // Clear cart and reload vessels
    selectedSellVessels = [];
    clearSellCartCache();
    updateBulkSellButton();

    // Reload the vessel list to remove sold vessels
    await loadUserVesselsForSale();

    showSideNotification(`Successfully sold ${totalVessels} vessels for $${formatNumber(totalPrice)}`, 'success');

  } catch (error) {
    console.error('[Vessel Selling] Bulk sell error:', error);
    showSideNotification('Failed to bulk sell vessels', 'error');
  }
}

/**
 * Sets the current filter type
 */
export async function setSellFilter(type) {
  currentSellFilter = type;
  await displaySellVessels();
}
