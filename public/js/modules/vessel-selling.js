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

let currentSellVessels = [];
let selectedSellVessels = [];
let currentSellFilter = 'container';

const SELL_CART_CACHE_KEY = 'vessel_sell_cart';

/**
 * Load sell cart from localStorage
 */
function loadSellCartFromCache() {
  try {
    const cached = localStorage.getItem(SELL_CART_CACHE_KEY);
    if (cached) {
      selectedSellVessels = JSON.parse(cached);
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
 */
export async function openSellVesselsOverlay() {
  document.getElementById('sellVesselsOverlay').classList.remove('hidden');
  loadSellCartFromCache();
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
 */
async function loadUserVesselsForSale() {
  try {
    const response = await fetch(window.apiUrl('/api/vessel/get-vessels'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) throw new Error('Failed to load vessels');

    const data = await response.json();
    const vessels = data.vessels || [];

    currentSellVessels = vessels;
    await displaySellVessels();
  } catch (error) {
    console.error('[Vessel Selling] Error loading vessels:', error);
    showSideNotification('Failed to load vessels', 'error');
  }
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
    notice.innerHTML = 'ℹ️ Only vessels at port can be sold. Vessels at sea are shown below for reference.';
    container.appendChild(notice);
  }

  // Helper function to render a vessel card
  const renderVesselCard = async (modelKey, group, canSell) => {
    const model = group.model;
    const allVessels = group.vessels;
    const harborVessels = group.harborVessels;

    // Get actual sell price from API for first harbor vessel
    let sellPrice;
    let originalPrice;
    if (harborVessels.length > 0) {
      try {
        const priceResponse = await fetch(window.apiUrl('/api/vessel/get-sell-price'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vessel_id: harborVessels[0].id })
        });
        if (priceResponse.ok) {
          const priceData = await priceResponse.json();
          sellPrice = priceData.data.selling_price;
          originalPrice = priceData.data.original_price;
        }
      } catch (error) {
        console.error('[Vessel Selling] Failed to get sell price:', error);
      }
    }

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
          <div class="vessel-price">${sellPrice !== undefined ? '$' + formatNumber(sellPrice) : (harborVessels.length === 0 ? 'At Sea' : 'Price N/A')}</div>
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
                      ${canSelect && canSell ? `<input type="checkbox" class="vessel-checkbox sell-vessel-checkbox" data-vessel-id="${v.id}" data-model-key="${modelKey}">` : '<div class="sell-vessel-checkbox-placeholder"></div>'}
                      <span class="${canSelect ? 'sell-vessel-name-available' : 'sell-vessel-name-unavailable'}">${v.name}</span>
                    </div>
                    <span class="sell-vessel-status">${statusDisplay}</span>
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

          // Update cart
          if (quantity > 0) {
            updateVesselSelectionInCart(modelKey, quantity, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, sellPrice, originalPrice);
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
            const quantity = parseInt(quantityInput?.value) || 1;
            checkboxes.forEach(cb => cb.checked = false);
            Array.from(checkboxes).slice(0, quantity).forEach(cb => cb.checked = true);
            checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');
          }

          const selectedVesselIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.vesselId));

          if (selectedVesselIds.length === 0) {
            showSideNotification('Please select at least one vessel', 'error');
            return;
          }

          // Update cart (replaces quantity, does not increment)
          updateVesselSelectionInCart(modelKey, selectedVesselIds.length, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, sellPrice, originalPrice);
          showSideNotification(`Added ${selectedVesselIds.length}x ${allVessels[0].name.replace(/_\d+$/, '')} to cart`, 'success');
        });
      }

      if (sellBtn) {
        sellBtn.addEventListener('click', () => {
          let checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');

          // If nothing selected, auto-select from top based on quantity input
          if (checkedBoxes.length === 0) {
            const quantity = parseInt(quantityInput?.value) || 1;
            Array.from(checkboxes).slice(0, quantity).forEach(cb => cb.checked = true);
            checkedBoxes = card.querySelectorAll('.vessel-checkbox:checked');
          }

          const selectedVesselIds = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.vesselId));

          if (selectedVesselIds.length === 0) {
            showSideNotification('Please select at least one vessel', 'error');
            return;
          }

          sellVessels(modelKey, selectedVesselIds.length, allVessels[0].name.replace(/_\d+$/, ''), selectedVesselIds, sellPrice, originalPrice);
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
      portGrid.appendChild(await renderVesselCard(modelKey, group, true));
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
      seaGrid.appendChild(await renderVesselCard(modelKey, group, false));
    }
    container.appendChild(seaGrid);
  }

  feed.innerHTML = '';
  feed.appendChild(container);

  // Restore checkboxes for cached items
  selectedSellVessels.forEach(item => {
    updateSelectButtonState(item.modelKey, item.quantity);
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
function updateVesselSelectionInCart(modelKey, quantity, modelName, vesselIds, sellPrice, originalPrice) {
  const index = selectedSellVessels.findIndex(v => v.modelKey === modelKey);

  if (index > -1) {
    // Update existing selection
    selectedSellVessels[index].quantity = quantity;
    selectedSellVessels[index].vesselIds = vesselIds;
  } else {
    // Add new selection
    selectedSellVessels.push({ modelKey, quantity, modelName, vesselIds, sellPrice, originalPrice });
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

/**
 * Sells vessels of a specific model
 */
async function sellVessels(modelKey, quantity, modelName, vesselIds, sellPrice, originalPrice) {
  try {
    const totalPrice = sellPrice * quantity;

    const confirmed = await showConfirmDialog({
      title: `Vessel ${modelName}`,
      message: `
        <div style="text-align: center; line-height: 1.8;">
          <div style="color: #9ca3af; font-size: 14px; margin-bottom: 8px;">
            Original Price: ${formatNumber(originalPrice)}
          </div>
          <div style="color: #6b7280; margin-bottom: 8px;">
            ━━━━━━━━━━━━━━━━━━━━━━
          </div>
          <div style="color: #10b981; font-size: 16px; font-weight: 600;">
            Sell Price: ${formatNumber(sellPrice)}
          </div>
        </div>
      `,
      confirmText: 'Sell'
    });

    if (!confirmed) return;

    const response = await fetch(window.apiUrl('/api/vessel/sell-vessels'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel_ids: vesselIds })
    });

    if (!response.ok) throw new Error('Failed to sell vessels');

    await response.json();

    showSideNotification(`✅ Sold ${quantity}x ${modelName} for $${formatNumber(totalPrice)}`, 'success');

    // Remove sold vessels from cart
    const index = selectedSellVessels.findIndex(v => v.modelKey === modelKey);
    if (index > -1) {
      selectedSellVessels.splice(index, 1);
      saveSellCartToCache();
      updateBulkSellButton();
    }

    // Reload vessels
    await loadUserVesselsForSale();

  } catch (error) {
    console.error('[Vessel Selling] Error:', error);
    showSideNotification('Failed to sell vessels', 'error');
  }
}

/**
 * Shows the sell cart overlay
 */
export function showSellCart() {
  if (selectedSellVessels.length === 0) {
    showSideNotification('Cart is empty', 'info');
    return;
  }

  // Calculate total
  const totalRevenue = selectedSellVessels.reduce((sum, item) => sum + (item.sellPrice * item.quantity), 0);
  const totalItems = selectedSellVessels.reduce((sum, item) => sum + item.quantity, 0);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog shopping-cart-dialog';

  // Build cart items HTML
  const cartItemsHtml = selectedSellVessels.map(item => `
    <div class="cart-item" data-model-key="${item.modelKey}">
      <div class="cart-item-info">
        <div class="cart-item-name">
          ${item.modelName}
          <span class="cart-item-original-price">(${item.originalPrice !== undefined ? '$' + formatNumber(item.originalPrice) : 'N/A'})</span>
        </div>
        <div class="cart-item-price">$${formatNumber(item.sellPrice)}</div>
      </div>
      <div class="cart-item-controls">
        <button class="cart-qty-btn minus" data-model-key="${item.modelKey}">−</button>
        <span class="cart-qty-display">${item.quantity}</span>
        <button class="cart-qty-btn plus" data-model-key="${item.modelKey}">+</button>
        <button class="cart-remove-btn" data-model-key="${item.modelKey}" title="Remove from cart">🗑️</button>
      </div>
    </div>
  `).join('');

  dialog.innerHTML = `
    <div class="confirm-dialog-header">
      <h3>💵 Sell Cart</h3>
      <div class="confirm-dialog-buttons">
        <button class="confirm-dialog-btn cancel" data-action="cancel">Close</button>
        <button class="confirm-dialog-btn confirm" data-action="sell">💰 Sell All</button>
      </div>
    </div>
    <div class="confirm-dialog-body">
      <div class="cart-summary affordable">
        <div class="summary-row">
          <span class="label">Total Items:</span>
          <span class="value">${totalItems} vessel${totalItems === 1 ? '' : 's'}</span>
        </div>
        <div class="summary-row total">
          <span class="label">Total Revenue:</span>
          <span class="value">$${formatNumber(totalRevenue)}</span>
        </div>
      </div>
      <div class="cart-separator"></div>
      <div class="cart-items">
        ${cartItemsHtml}
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
  dialog.querySelectorAll('.cart-qty-btn.plus').forEach(btn => {
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
              }
              quantityInput.value = item.quantity;
              updateBulkSellButton();
              closeOverlay();
              showSellCart();
            }
          }
        });
      }
    });
  });

  dialog.querySelectorAll('.cart-qty-btn.minus').forEach(btn => {
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
            }
            quantityInput.value = item.quantity;
          }
        });
        updateBulkSellButton();
        closeOverlay();
        showSellCart();
      }
    });
  });

  dialog.querySelectorAll('.cart-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modelKey = btn.dataset.modelKey;
      removeVesselSelectionFromCart(modelKey);
      // Uncheck all checkboxes for this model
      const cards = document.querySelectorAll('.vessel-card');
      cards.forEach(card => {
        const checkboxes = card.querySelectorAll(`.vessel-checkbox[data-model-key="${modelKey}"]`);
        checkboxes.forEach(cb => cb.checked = false);
        const quantityInput = card.querySelector(`.vessel-quantity-input[data-model-key="${modelKey}"]`);
        if (quantityInput) quantityInput.value = 0;
      });
      closeOverlay();
      if (selectedSellVessels.length > 0) {
        showSellCart();
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
      const itemTotal = sel.sellPrice * sel.quantity;
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

    selectedSellVessels = [];
    clearSellCartCache();
    updateBulkSellButton();
    await loadUserVesselsForSale();

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
