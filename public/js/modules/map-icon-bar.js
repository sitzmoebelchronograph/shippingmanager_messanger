/**
 * @fileoverview Map Icon Bar
 * Floating icon bar on harbor map that provides quick access to actions
 * Desktop: Horizontal top-right, Mobile: Vertical right side
 *
 * @module map-icon-bar
 */

/**
 * Initialize map icon bar
 * - Wire up click handlers to call functions directly
 * - No more hidden buttons or MutationObserver syncing
 */
export function initializeMapIconBar() {
  const iconBar = document.getElementById('mapIconBar');
  if (!iconBar) {
    console.warn('[Map Icon Bar] Icon bar not found');
    return;
  }

  // Import functions dynamically when needed
  // Note: We'll attach these at runtime from script.js to avoid circular dependencies

  // Wire up click handlers
  const iconItems = iconBar.querySelectorAll('.map-icon-item');
  iconItems.forEach(item => {
    const action = item.dataset.action;

    item.addEventListener('click', () => {
      // Call the appropriate function based on action
      handleIconAction(action);
    });
  });

  console.log('[Map Icon Bar] Initialized');
}

/**
 * Handle icon click action
 * @param {string} action - Action name from data-action attribute
 */
function handleIconAction(action) {
  // Map actions to their corresponding functions
  // These functions are exposed on window object by script.js
  const actionHandlers = {
    'departAll': window.departAllVessels,
    'anchor': window.showAnchorInfo,
    'repairAll': () => window.openRepairAndDrydockDialog(window.getSettings ? window.getSettings() : {}),
    'buyVessels': window.showBuyVesselsOverlay,
    'sellVessels': window.openSellVesselsOverlay,
    'messenger': window.showAllChats,
    'hijacking': window.openHijackingInbox,
    'campaigns': window.showCampaignsOverlay,
    'coop': window.showCoopOverlay,
    'allianceChat': window.showAllianceChatOverlay,
    'contactList': window.showContactList,
    'settings': window.showSettings,
    'forecast': window.showForecastOverlay,
    'logbook': window.showLogbookOverlay,
    'docs': window.showDocsOverlay
  };

  const handler = actionHandlers[action];
  if (handler && typeof handler === 'function') {
    handler();
  } else {
    console.warn(`[Map Icon Bar] No handler found for action: ${action}`);
  }
}
