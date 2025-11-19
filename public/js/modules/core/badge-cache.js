/**
 * @fileoverview Badge cache management module.
 * Handles loading and saving badge/status data to localStorage for instant
 * display on page load before WebSocket sends fresh data.
 *
 * @module core/badge-cache
 */

import { updateBadge, updateButtonState, updateButtonTooltip, updateButtonVisibility } from '../badge-manager.js';
import { updateEventDiscount } from '../forecast-calendar.js';
import { updateEventData } from '../event-info.js';
import { getFuelPriceClass, getCO2PriceClass } from '../utils.js';

/**
 * Updates COOP display in header with proper color coding.
 * Centralized function called from multiple locations.
 *
 * @param {number} cap - Total COOP capacity
 * @param {number} available - Available vessels to send
 */
export function updateCoopDisplay(cap, available) {
  const coopDisplay = document.getElementById('coopDisplay');
  const coopContainer = coopDisplay?.parentElement;
  const coopModalBtn = document.querySelector('button[onclick="openCoopModal()"]');

  // Hide header elements if cap === 0 (user not in alliance), but keep action button visible
  if (cap === 0) {
    if (coopContainer) coopContainer.classList.add('hidden');
    if (coopModalBtn) coopModalBtn.style.display = 'none';
    return;
  }

  // Show if it was hidden
  if (coopContainer) coopContainer.classList.remove('hidden');
  if (coopModalBtn) coopModalBtn.style.display = '';

  if (coopDisplay) {
    // Clear and rebuild using DOM manipulation
    coopDisplay.textContent = '';

    const coopSpan = document.createElement('span');
    if (available > 0) {
      // Red number with red available count in parentheses
      coopSpan.className = 'coop-display-available';
      coopSpan.textContent = `${cap} (${available})`;
    } else {
      // Green number without parentheses when all vessels sent
      coopSpan.className = 'coop-display-full';
      coopSpan.textContent = cap;
    }
    coopDisplay.appendChild(coopSpan);
  }
}

/**
 * Load all cached data from localStorage and update UI.
 * Loads: badges, prices, bunker levels, cash, campaigns, stock, COOP, anchor slots, etc.
 * Does NOT load: messages (to prevent flicker), points (always fetched fresh)
 * Called on page load to show last known values until WebSocket sends fresh data.
 *
 * @param {Object} settings - Current settings object for threshold comparison
 */
export function loadCache(settings) {
  try {
    // CRITICAL: REFUSE to load cache if user ID not validated
    if (!window.USER_STORAGE_PREFIX) {
      console.log(`[Cache] REFUSE: window.USER_STORAGE_PREFIX not set - cannot validate cache`);
      updateEventData(null);
      return;
    }

    // Validation: CACHE_KEY must be set (no fallbacks!)
    if (!window.CACHE_KEY) {
      console.log(`[Cache] REFUSE: window.CACHE_KEY not set - cannot load cache`);
      updateEventData(null);
      return;
    }

    const cached = localStorage.getItem(window.CACHE_KEY);
    if (!cached) {
      console.log('[Cache] No cached badges found (key: ' + window.CACHE_KEY + ')');
      // Ensure event banner stays hidden when no cache exists
      updateEventData(null);
      return;
    }

    const data = JSON.parse(cached);
    if (window.DEBUG_MODE) {
      console.log('[Cache] Loaded cached badges:', data);
    }

    // Vessel badges and button states
    loadVesselBadges(data);

    // Repair badge and button state
    loadRepairBadges(data);

    // Campaigns badge
    loadCampaignsBadge(data);

    // Fuel and CO2 prices
    loadPrices(data, settings);

    // Event data (complete event info with name, ports, etc.)
    if (data.eventData) {
      updateEventData(data.eventData);
    } else {
      updateEventData(null);
    }

    // COOP data (alliance cooperation)
    loadCoopData(data, settings);

    // Bunker status
    loadBunkerStatus(data);

    // Stock & Anchor
    loadStockAndAnchor(data);

    // Hijacking badge and button state
    loadHijackingBadge(data);

  } catch (error) {
    console.error('[Cache] Failed to load cached badges:', error);
  }
}

/**
 * Load vessel badges from cache.
 * @param {Object} data - Cached data object
 */
function loadVesselBadges(data) {
  if (!data.vessels) return;

  const { readyToDepart, atAnchor, pending } = data.vessels;

  // Ready to depart badge and button
  if (readyToDepart !== undefined) {
    updateBadge('vesselCount', readyToDepart, readyToDepart > 0, 'BLUE');
    updateButtonState('departAll', readyToDepart === 0);
    updateButtonTooltip('departAll',
      readyToDepart > 0
        ? `Depart all ${readyToDepart} vessel${readyToDepart === 1 ? '' : 's'} from harbor`
        : 'No vessels ready to depart'
    );
  }

  // Anchor badge and button
  if (atAnchor !== undefined) {
    updateBadge('anchorCount', atAnchor, atAnchor > 0, 'RED');
    updateButtonTooltip('anchor',
      atAnchor > 0
        ? `${atAnchor} vessel${atAnchor === 1 ? '' : 's'} at anchor - Click to purchase anchor points`
        : 'Purchase anchor points'
    );
  }

  // Pending vessels badge and button
  if (pending !== undefined) {
    updateBadge('pendingVesselsBadge', pending, pending > 0, 'ORANGE');
    updateButtonTooltip('buyVessels', pending > 0 ? `Vessels in delivery: ${pending}` : 'Buy vessels');

    // Update pending filter button in overlay (if exists)
    const pendingBtn = document.getElementById('filterPendingBtn');
    const pendingCountSpan = document.getElementById('pendingCount');
    if (pendingBtn && pendingCountSpan) {
      pendingCountSpan.textContent = pending;
      if (pending > 0) {
        pendingBtn.classList.remove('hidden');
      } else {
        pendingBtn.classList.add('hidden');
      }
    }
  }
}

/**
 * Load repair badges from cache.
 * @param {Object} data - Cached data object
 */
function loadRepairBadges(data) {
  if (data.repair) {
    const { count } = data.repair;
    if (count !== undefined) {
      updateBadge('repairCount', count, count > 0, 'RED');
    }
  }

  if (data.drydock) {
    const { count } = data.drydock;
    if (count !== undefined) {
      updateBadge('drydockCount', count, count > 0, 'ORANGE');
    }
  }

  // Update repair button state (enabled if repair OR drydock count > 0)
  if (data.repair || data.drydock) {
    const repairCount = data.repair?.count ?? 0;
    const drydockCount = data.drydock?.count ?? 0;
    const hasRepairOrDrydock = repairCount > 0 || drydockCount > 0;
    updateButtonState('repairAll', !hasRepairOrDrydock);

    let tooltip;
    if (repairCount > 0 && drydockCount > 0) {
      tooltip = `Repair ${repairCount} vessel${repairCount === 1 ? '' : 's'} or drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`;
    } else if (repairCount > 0) {
      tooltip = `Repair ${repairCount} vessel${repairCount === 1 ? '' : 's'} with high wear`;
    } else if (drydockCount > 0) {
      tooltip = `Drydock ${drydockCount} vessel${drydockCount === 1 ? '' : 's'}`;
    } else {
      tooltip = 'No vessels need repair or drydock';
    }
    updateButtonTooltip('repairAll', tooltip);
  }
}

/**
 * Load campaigns badge from cache.
 * @param {Object} data - Cached data object
 */
function loadCampaignsBadge(data) {
  if (data.campaigns === undefined) return;

  // Only show badge if < 3 campaigns
  updateBadge('campaignsCount', data.campaigns, data.campaigns < 3, 'RED');

  // Update header display
  const campaignsDisplay = document.getElementById('campaignsDisplay');
  if (campaignsDisplay) {
    campaignsDisplay.textContent = data.campaigns;
    if (data.campaigns <= 3) {
      campaignsDisplay.classList.add('text-success');
      campaignsDisplay.classList.remove('text-danger');
    } else {
      campaignsDisplay.classList.add('text-danger');
      campaignsDisplay.classList.remove('text-success');
    }
  }
}

/**
 * Load fuel and CO2 prices from cache.
 * @param {Object} data - Cached data object
 * @param {Object} settings - Current settings for threshold comparison
 */
function loadPrices(data, settings) {
  if (!data.prices) return;

  const { fuelPrice, co2Price, eventDiscount } = data.prices;

  const fuelPriceDisplay = document.getElementById('fuelPriceDisplay');
  if (fuelPriceDisplay && fuelPrice !== undefined && fuelPrice > 0) {
    fuelPriceDisplay.textContent = '';
    fuelPriceDisplay.appendChild(document.createTextNode(`$${fuelPrice}/t`));

    if (eventDiscount && eventDiscount.type === 'fuel') {
      const discountBadge = document.createElement('span');
      discountBadge.className = 'discount-badge';
      discountBadge.textContent = `-${eventDiscount.percentage}%`;
      fuelPriceDisplay.appendChild(document.createTextNode(' '));
      fuelPriceDisplay.appendChild(discountBadge);
    }

    fuelPriceDisplay.className = '';
    if (settings && settings.fuelThreshold && fuelPrice < settings.fuelThreshold) {
      fuelPriceDisplay.className = 'price-pulse-alert';
    } else {
      fuelPriceDisplay.className = getFuelPriceClass(fuelPrice);
    }
  }

  const co2PriceDisplay = document.getElementById('co2PriceDisplay');
  if (co2PriceDisplay && co2Price !== undefined && co2Price > 0) {
    co2PriceDisplay.textContent = '';
    co2PriceDisplay.appendChild(document.createTextNode(`$${co2Price}/t`));

    if (eventDiscount && eventDiscount.type === 'co2') {
      const discountBadge = document.createElement('span');
      discountBadge.className = 'discount-badge';
      discountBadge.textContent = `-${eventDiscount.percentage}%`;
      co2PriceDisplay.appendChild(document.createTextNode(' '));
      co2PriceDisplay.appendChild(discountBadge);
    }

    co2PriceDisplay.className = '';
    if (settings && settings.co2Threshold && co2Price < settings.co2Threshold) {
      co2PriceDisplay.className = 'price-pulse-alert';
    } else {
      co2PriceDisplay.className = getCO2PriceClass(co2Price);
    }
  }

  // Update forecast with cached event discount and event data
  const eventData = data.prices.eventData || null;
  if (eventDiscount) {
    updateEventDiscount(eventDiscount, eventData);
  } else {
    updateEventDiscount(null, null);
  }
}

/**
 * Load COOP data from cache.
 * @param {Object} data - Cached data object
 * @param {Object} settings - Settings object with allianceId
 */
function loadCoopData(data, settings) {
  const coopContainer = document.getElementById('coopContainer');
  const coopBtn = document.getElementById('coopBtn');

  if (data.coop) {
    const { available, cap } = data.coop;

    // User has LEFT alliance if settings explicitly says allianceId is null
    // If settings is undefined or allianceId is not set, assume user still has alliance (data is from cache)
    const userLeftAlliance = settings && settings.allianceId === null;

    if (!userLeftAlliance) {
      // Show alliance UI
      if (coopContainer) coopContainer.classList.remove('hidden');
      if (coopBtn) coopBtn.style.display = '';
      updateButtonVisibility('coop', true);

      const allianceChatBtn = document.querySelector('[data-action="allianceChat"]');
      if (allianceChatBtn) allianceChatBtn.style.display = '';
      updateButtonVisibility('allianceChat', true);

      const color = available === 0 ? 'GREEN' : 'RED';
      updateBadge('coopBadge', available, available > 0, color);
      console.log(`[COOP Badge] Updated via badge-manager: available=${available}, color=${color}`);

      // Also update the coop tab badge if the function is available
      if (window.updateCoopTabBadge) {
        window.updateCoopTabBadge(available);
      }

      if (cap > 0) {
        updateCoopDisplay(cap, available);
      }
    } else {
      // User left alliance but cache still has coop data - hide everything
      const allianceChatBtn = document.querySelector('[data-action="allianceChat"]');
      if (allianceChatBtn) allianceChatBtn.style.display = 'none';
      updateButtonVisibility('allianceChat', false);

      if (coopContainer) coopContainer.classList.add('hidden');
      updateBadge('coopBadge', 0, false, 'GREEN');
      if (window.updateCoopDisplay) {
        window.updateCoopDisplay(0, 0);
      }
    }
  } else {
    // User has no alliance or no coop data - hide everything
    if (coopContainer) coopContainer.classList.add('hidden');

    const allianceChatBtn = document.querySelector('[data-action="allianceChat"]');
    if (allianceChatBtn) allianceChatBtn.style.display = 'none';
    updateButtonVisibility('allianceChat', false);

    // Clear all coop badges
    updateBadge('coopBadge', 0, false, 'GREEN');
    if (window.updateCoopTabBadge) {
      window.updateCoopTabBadge(0);
    }
    if (window.updateCoopDisplay) {
      window.updateCoopDisplay(0, 0);
    }
  }
}

/**
 * Load bunker status from cache.
 * @param {Object} data - Cached data object
 */
function loadBunkerStatus(data) {
  if (!data.bunker) return;

  const { fuel, co2, cash, maxFuel, maxCO2, points } = data.bunker;

  // CRITICAL: Don't load cache if BOTH fuel AND co2 are 0 - this is likely stale/invalid data
  // Real data will have at least some fuel or CO2 in tanks
  if (fuel === 0 && co2 === 0) {
    if (window.DEBUG_MODE) {
      console.log('[Cache] Bunker cache skipped - both fuel and co2 are 0');
    }
    return;
  }

  // Load capacity values from cache if available
  if (maxFuel !== undefined && maxFuel > 0 && maxCO2 !== undefined && maxCO2 > 0) {
    import('../bunker-management.js').then(module => {
      module.setCapacityFromBunkerUpdate(maxFuel, maxCO2);
    });
  }

  // Fuel display
  const fuelDisplay = document.getElementById('fuelDisplay');
  const fuelFill = document.getElementById('fuelFill');
  const fuelBtn = document.getElementById('fuelBtn');
  if (fuelDisplay && fuel !== undefined && maxFuel > 0) {
    fuelDisplay.textContent = `${Math.floor(fuel).toLocaleString('en-US')} t / ${Math.floor(maxFuel).toLocaleString('en-US')} t`;

    if (fuelFill && fuelBtn) {
      const fuelPercent = Math.min(100, Math.max(0, (fuel / maxFuel) * 100));
      fuelFill.style.width = `${fuelPercent}%`;

      let fillClass = '';
      if (fuel <= 0) {
        fillClass = 'fuel-btn-empty';
        fuelFill.style.width = '0%';
        fuelFill.style.background = 'transparent';
      } else if (fuelPercent <= 20) {
        fillClass = 'fuel-btn-low';
        fuelFill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
      } else if (fuelPercent <= 70) {
        fillClass = 'fuel-btn-medium';
        fuelFill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
      } else if (fuelPercent <= 85) {
        fillClass = 'fuel-btn-high';
        fuelFill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
      } else {
        fillClass = 'fuel-btn-full';
        fuelFill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
      }

      fuelBtn.classList.remove('fuel-btn-empty', 'fuel-btn-low', 'fuel-btn-medium', 'fuel-btn-high', 'fuel-btn-full');
      if (fillClass) fuelBtn.classList.add(fillClass);

      const fuelPrice = data.prices?.fuelPrice || data.prices?.fuel;
      if (fuelPrice !== undefined && fuelPrice > 0) {
        const priceClass = getFuelPriceClass(fuelPrice);
        fuelBtn.classList.remove('fuel-red', 'fuel-orange', 'fuel-blue', 'fuel-green');
        if (priceClass) fuelBtn.classList.add(priceClass);
      }
    }
  }

  // CO2 display
  const co2Display = document.getElementById('co2Display');
  const co2Fill = document.getElementById('co2Fill');
  const co2Btn = document.getElementById('co2Btn');
  if (co2Display && co2 !== undefined && maxCO2 > 0) {
    const co2Value = co2 < 0 ? `-${Math.floor(Math.abs(co2)).toLocaleString('en-US')}` : Math.floor(co2).toLocaleString('en-US');
    co2Display.textContent = `${co2Value} t / ${Math.floor(maxCO2).toLocaleString('en-US')} t`;

    if (co2Fill && co2Btn) {
      const co2Percent = Math.min(100, Math.max(0, (co2 / maxCO2) * 100));
      co2Fill.style.width = `${co2Percent}%`;

      let fillClass = '';
      if (co2 <= 0) {
        fillClass = 'co2-btn-empty';
        co2Fill.style.width = '0%';
        co2Fill.style.background = 'transparent';
      } else if (co2Percent <= 20) {
        fillClass = 'co2-btn-low';
        co2Fill.style.background = 'linear-gradient(to right, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.4))';
      } else if (co2Percent <= 70) {
        fillClass = 'co2-btn-medium';
        co2Fill.style.background = 'linear-gradient(to right, rgba(96, 165, 250, 0.3), rgba(96, 165, 250, 0.5))';
      } else if (co2Percent <= 85) {
        fillClass = 'co2-btn-high';
        co2Fill.style.background = 'linear-gradient(to right, rgba(251, 191, 36, 0.3), rgba(251, 191, 36, 0.5))';
      } else {
        fillClass = 'co2-btn-full';
        co2Fill.style.background = 'linear-gradient(to right, rgba(74, 222, 128, 0.3), rgba(74, 222, 128, 0.5))';
      }

      co2Btn.classList.remove('co2-btn-empty', 'co2-btn-low', 'co2-btn-medium', 'co2-btn-high', 'co2-btn-full');
      if (fillClass) co2Btn.classList.add(fillClass);

      const co2Price = data.prices?.co2Price || data.prices?.co2;
      if (co2Price !== undefined && co2Price !== null) {
        let priceClass = '';
        if (co2Price <= 0) {
          priceClass = 'co2-negative';
        } else if (co2Price >= 20) {
          priceClass = 'co2-red';
        } else if (co2Price >= 15) {
          priceClass = 'co2-orange';
        } else if (co2Price >= 10) {
          priceClass = 'co2-blue';
        } else if (co2Price >= 1) {
          priceClass = 'co2-green';
        }

        co2Btn.classList.remove('co2-negative', 'co2-red', 'co2-orange', 'co2-blue', 'co2-green');
        if (priceClass) co2Btn.classList.add(priceClass);
      }
    }
  }

  // Cash display
  const cashDisplay = document.getElementById('cashDisplay');
  if (cashDisplay && cash !== undefined) {
    cashDisplay.textContent = `$ ${Math.floor(cash).toLocaleString('en-US')}`;
  }

  // Points display
  const pointsDisplay = document.getElementById('pointsDisplay');
  if (pointsDisplay && points !== undefined) {
    pointsDisplay.textContent = points.toLocaleString('en-US');
    pointsDisplay.classList.remove('text-danger', 'text-warning', 'text-success');
    if (points === 0) {
      pointsDisplay.classList.add('text-danger');
    } else if (points < 600) {
      pointsDisplay.classList.add('text-warning');
    } else {
      pointsDisplay.classList.add('text-success');
    }
  }
}

/**
 * Load stock and anchor data from cache.
 * @param {Object} data - Cached data object
 */
function loadStockAndAnchor(data) {
  if (!data.stock && !data.anchor) return;

  if (data.stock) {
    const stockDisplay = document.getElementById('stockDisplay');
    const stockTrendElement = document.getElementById('stockTrend');
    const stockContainer = document.getElementById('stockContainer');

    if (data.stock.ipo === 1) {
      if (stockContainer) stockContainer.classList.remove('hidden');
      if (stockDisplay && data.stock.value !== undefined && data.stock.value !== null) {
        stockDisplay.textContent = `$${data.stock.value.toFixed(2)}`;
      }
      if (stockTrendElement && data.stock.trend) {
        if (data.stock.trend === 'up') {
          stockTrendElement.textContent = '↑';
          stockTrendElement.classList.add('text-success');
          stockTrendElement.classList.remove('text-danger', 'text-neutral');
          if (stockDisplay) {
            stockDisplay.classList.add('text-success');
            stockDisplay.classList.remove('text-danger', 'text-neutral');
          }
        } else if (data.stock.trend === 'down') {
          stockTrendElement.textContent = '↓';
          stockTrendElement.classList.add('text-danger');
          stockTrendElement.classList.remove('text-success', 'text-neutral');
          if (stockDisplay) {
            stockDisplay.classList.add('text-danger');
            stockDisplay.classList.remove('text-success', 'text-neutral');
          }
        } else {
          stockTrendElement.textContent = '-';
          stockTrendElement.classList.add('text-neutral');
          stockTrendElement.classList.remove('text-success', 'text-danger');
          if (stockDisplay) {
            stockDisplay.classList.add('text-neutral');
            stockDisplay.classList.remove('text-success', 'text-danger');
          }
        }
      }
    } else {
      if (stockContainer) stockContainer.classList.add('hidden');
    }
  }

  if (data.anchor) {
    const anchorDisplay = document.getElementById('anchorSlotsDisplay');
    if (anchorDisplay) {
      const total = data.anchor.max;
      const free = data.anchor.available;
      const pending = data.anchor.pending || 0;

      anchorDisplay.textContent = '';
      anchorDisplay.appendChild(document.createTextNode('Total '));

      const totalSpan = document.createElement('span');
      totalSpan.textContent = total;
      totalSpan.className = free > 0 ? 'anchor-total-bad' : 'anchor-total-good';
      anchorDisplay.appendChild(totalSpan);

      if (free > 0) {
        anchorDisplay.appendChild(document.createTextNode(' ⚓ Free '));
        const freeSpan = document.createElement('span');
        freeSpan.textContent = free;
        freeSpan.className = 'anchor-free';
        anchorDisplay.appendChild(freeSpan);
      }

      if (pending > 0) {
        anchorDisplay.appendChild(document.createTextNode(' ⚓ Pending '));
        const pendingSpan = document.createElement('span');
        pendingSpan.textContent = pending;
        pendingSpan.className = 'anchor-pending';
        anchorDisplay.appendChild(pendingSpan);
      }
    }
  }
}

/**
 * Load hijacking badge from cache.
 * @param {Object} data - Cached data object
 */
function loadHijackingBadge(data) {
  if (data.hijacking === undefined) return;

  const { openCases, hijackedCount } = data.hijacking;

  updateBadge('hijackingBadge', openCases, openCases > 0, 'RED');

  const button = document.getElementById('hijackingBtn');
  if (button) {
    button.disabled = false;
  }

  const hijackedDisplay = document.getElementById('hijackedVesselsDisplay');
  const hijackedCountEl = document.getElementById('hijackedCount');
  const hijackedIcon = document.getElementById('hijackedIcon');

  if (hijackedDisplay && hijackedCountEl && hijackedIcon && hijackedCount !== undefined) {
    if (hijackedCount > 0) {
      hijackedCountEl.textContent = hijackedCount;
      hijackedDisplay.classList.remove('hidden');
      hijackedIcon.classList.add('hijacked-glow');
    } else {
      hijackedDisplay.classList.add('hidden');
      hijackedIcon.classList.remove('hijacked-glow');
    }
  }
}

/**
 * Saves badge values to localStorage for next page load.
 * Called by WebSocket handlers when new data arrives.
 *
 * @param {Object} data - Data to merge into cache
 *
 * @example
 * saveBadgeCache({ vessels: { readyToDepart: 5 } });
 */
export function saveBadgeCache(data) {
  try {
    const cacheKey = window.CACHE_KEY || 'badgeCache';
    const currentCache = localStorage.getItem(cacheKey);
    const cache = currentCache ? JSON.parse(currentCache) : {};

    // Merge new data into cache
    Object.assign(cache, data);

    localStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch (error) {
    console.error('[Cache] Failed to save badge cache:', error);
  }
}

// Expose globally for backward compatibility
window.saveBadgeCache = saveBadgeCache;
window.updateCoopDisplay = updateCoopDisplay;
