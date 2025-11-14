/**
 * @fileoverview Utility Functions Module - Provides essential helper functions for HTML escaping, formatting,
 * notifications, feedback dialogs, service worker management, and settings persistence.
 *
 * Key Categories:
 * - HTML & Formatting: escapeHtml, formatNumber, renderStars
 * - User Feedback: showSideNotification
 * - Notifications: Browser/desktop notifications with service worker support
 * - Service Worker: Registration and notification handling
 * - Settings: Load/save to server, AutoPilot detection, page title updates
 * - Tooltips: Custom tooltip system
 *
 * Notification Strategy:
 * - Attempts direct Notification API first (works in most browsers)
 * - Falls back to service worker notifications if direct fails
 * - Graceful degradation with error messages
 * - Auto-closes after 5 seconds
 *
 * Settings Persistence:
 * - Stored on server (not localStorage) for multi-device sync
 * - Loaded on app initialization
 * - Saved on every settings change
 *
 * @module utils
 */

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * Converts &, <, >, ", and ' to their HTML entity equivalents.
 *
 * This is critical for security when displaying user-generated content like
 * chat messages, company names, or any data from the API.
 *
 * @param {string} text - Raw text to escape
 * @returns {string} HTML-safe escaped text
 *
 * @example
 * escapeHtml('<script>alert("XSS")</script>');
 * // Returns: '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
 */
export function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * Formats numbers with thousands separators and optional decimal places.
 * Uses US locale formatting (comma as thousands separator, period as decimal).
 *
 * @param {number} num - Number to format
 * @returns {string} Formatted number string (e.g., "1,234,567.89")
 *
 * @example
 * formatNumber(1234567.89); // Returns: "1,234,567.89"
 * formatNumber(1000);       // Returns: "1,000"
 */
export function formatNumber(num) {
  // Round to whole number if it's close to an integer
  const rounded = Math.round(num);
  if (Math.abs(num - rounded) < 0.01) {
    return rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Shows a side notification (slides in from right, auto-dismisses after duration)
 *
 * @param {string} message - HTML message content
 * @param {string} type - Notification type: 'success', 'error', 'warning', 'info'
 * @param {number} duration - Display duration in milliseconds (default based on type)
 * @param {boolean} isAlert - Whether this is an alert notification (megaphone + Got it button)
 */
export function showSideNotification(message, type = 'info', duration = null, isAlert = false) {
  try {
    const container = document.getElementById('sideNotifications');

    if (!container) {
      console.error('[showSideNotification] CRITICAL ERROR: sideNotifications container not found! This should never happen.');
      console.error('[showSideNotification] Message that failed to display:', message);
      console.error('[showSideNotification] Type:', type, 'isAlert:', isAlert);
      return;
    }

  // Determine duration based on type if not specified
  if (!duration) {
    if (isAlert) {
      duration = 20000; // 20 seconds for alerts
    } else if (type === 'warning') {
      duration = 12000; // 12 seconds for warnings
    } else if (type === 'error') {
      duration = 10000; // 10 seconds for errors
    } else {
      duration = 6000; // 6 seconds for success/info
    }
  }

  // Create notification element
  const notification = document.createElement('div');
  notification.className = `side-notification ${type}`;

  // Add alert class if this is an alert notification
  if (isAlert) {
    notification.classList.add('alert');
  }

  // Create message content wrapper
  const messageContent = document.createElement('div');
  messageContent.className = 'notification-message';
  messageContent.innerHTML = message;
  notification.appendChild(messageContent);

  // Add "Got it" button for alerts OR X button for normal notifications
  if (isAlert) {
    const gotItBtn = document.createElement('button');
    gotItBtn.className = 'got-it-btn';
    gotItBtn.textContent = 'Got it';
    gotItBtn.onclick = (e) => {
      e.stopPropagation();
      dismissNotification(notification);
    };
    notification.appendChild(gotItBtn);
  } else {
    // Add X close button for normal notifications
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '×';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      dismissNotification(notification);
    };
    notification.appendChild(closeBtn);
  }

  // Add to container (append to bottom)
  container.appendChild(notification);

  // Track hover state to prevent auto-dismiss
  let isHovered = false;
  let dismissTimeout = null;

  notification.addEventListener('mouseenter', () => {
    isHovered = true;
    if (dismissTimeout) {
      clearTimeout(dismissTimeout);
      dismissTimeout = null;
    }
  });

  notification.addEventListener('mouseleave', () => {
    isHovered = false;
    // Restart auto-dismiss timer when mouse leaves
    scheduleDismiss();
  });

  // Function to dismiss notification
  function dismissNotification(notif) {
    if (dismissTimeout) {
      clearTimeout(dismissTimeout);
    }
    notif.classList.add('slide-out-animation');
    setTimeout(() => {
      if (notif.parentNode) {
        notif.parentNode.removeChild(notif);
      }
    }, 300);
  }

  // Schedule auto-dismiss
  function scheduleDismiss() {
    if (dismissTimeout) {
      clearTimeout(dismissTimeout);
    }
    dismissTimeout = setTimeout(() => {
      if (!isHovered) {
        dismissNotification(notification);
      }
    }, duration);
  }

  // Initial auto-dismiss schedule
  scheduleDismiss();

  return notification;
  } catch (error) {
    console.error('[showSideNotification] CRITICAL ERROR: Exception thrown while creating notification!');
    console.error('[showSideNotification] Error:', error);
    console.error('[showSideNotification] Message:', message);
    console.error('[showSideNotification] Stack trace:', error.stack);
  }
}

/**
 * Renders a reputation score as star rating with partial stars.
 * Converts percentage (0-100) to 5-star display with gradient for partial stars.
 *
 * Star Calculation:
 * - Full stars: floor(percentage / 20)
 * - Partial star: remainder as percentage gradient
 * - Empty stars: remaining to reach 5 total
 *
 * Colors:
 * - Filled: Gold (#fbbf24)
 * - Empty: Gray transparent (rgba(156, 163, 175, 0.2))
 *
 * @param {number} percentage - Reputation percentage (0-100)
 * @returns {string} HTML string with star emojis and styling
 *
 * @example
 * renderStars(73); // Returns: 3.65 stars (3 full, 1 partial at 65%, 1 empty)
 */
export function renderStars(percentage) {
  const fullStars = Math.floor(percentage / 20);
  const remainder = percentage % 20;
  const partialPercent = (remainder / 20) * 100;
  const emptyStars = 5 - fullStars - (remainder > 0 ? 1 : 0);

  let stars = '';

  for (let i = 0; i < fullStars; i++) {
    stars += '<span style="color: #fbbf24;">⭐</span>';
  }

  if (remainder > 0) {
    stars += `
      <span style="
        background: linear-gradient(to right, #fbbf24 0%, #fbbf24 ${partialPercent}%, rgba(156, 163, 175, 0.2) ${partialPercent}%, rgba(156, 163, 175, 0.2) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        color: transparent;
      ">⭐</span>
    `;
  }

  for (let i = 0; i < emptyStars; i++) {
    stars += '<span style="color: rgba(156, 163, 175, 0.2);">⭐</span>';
  }

  return stars;
}

/**
 * Requests browser notification permission from the user.
 * Checks current permission status and prompts if not yet decided.
 *
 * Permission States:
 * - 'granted': Already have permission, returns true
 * - 'denied': User denied, returns false (cannot re-request)
 * - 'default': Not yet asked, prompts user
 *
 * @async
 * @returns {Promise<boolean>} True if permission granted, false otherwise
 */
export async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "denied") {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  }
  return false;
}

/**
 * Service worker registration object.
 * Used for showing notifications via service worker API when direct API fails.
 * @type {ServiceWorkerRegistration|null}
 */
let swRegistration = null;

/**
 * Registers service worker for notification support and offline capabilities.
 * Handles installation, waiting, and activation states for proper service worker lifecycle.
 *
 * Service Worker Purpose:
 * - Enables notifications in browsers that don't support direct Notification API
 * - Provides fallback for notification display
 * - Required for showing notifications when page is not focused
 *
 * Lifecycle Handling:
 * - Waits for installing worker to activate
 * - Skips waiting for waiting worker
 * - Logs status of already-active worker
 *
 * Side Effects:
 * - Registers /sw.js service worker
 * - Updates module-level swRegistration variable
 * - Logs registration status to console
 *
 * @async
 * @returns {Promise<ServiceWorkerRegistration|null>} Service worker registration or null if not supported
 */
export async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');

      if (swRegistration.installing) {
        await new Promise((resolve) => {
          swRegistration.installing.addEventListener('statechange', (e) => {
            if (e.target.state === 'activated') {
              resolve();
            }
          });
        });
      } else if (swRegistration.waiting) {
        swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      return swRegistration;
    } catch (error) {
      console.error('[Service Worker] Registration failed:', error);
      return null;
    }
  }
  return null;
}

/**
 * Shows a browser/desktop notification with fallback strategies.
 * Attempts direct Notification API first, falls back to service worker if needed.
 *
 * Notification Strategy:
 * 1. Try creating notification directly (works in most browsers)
 * 2. If direct fails, use service worker showNotification (background support)
 * 3. If both fail, show error price alert
 *
 * Default Enhancements:
 * - Vibration pattern: [200ms, 100ms pause, 200ms]
 * - Badge: Anchor emoji
 * - Click handler: Focus window and close notification
 * - Auto-close after 5 seconds (unless autoClose: false)
 *
 * @async
 * @param {string} title - Notification title
 * @param {Object} options - Notification options
 * @param {string} [options.body] - Notification body text
 * @param {string} [options.icon] - Icon URL or data URI
 * @param {string} [options.tag] - Unique tag for notification grouping
 * @param {boolean} [options.silent=false] - Silent notification
 * @param {boolean} [options.autoClose=true] - Auto-close after 5 seconds
 * @param {Object} [options.data] - Custom data attached to notification
 * @returns {Promise<boolean>} True if notification shown successfully
 * @throws {Error} Shows error price alert on failure
 *
 * @example
 * showNotification('Fuel Price Alert', {
 *   body: 'Fuel dropped to $350/ton',
 *   icon: '/favicon.ico',
 *   tag: 'fuel-alert'
 * });
 */
export async function showNotification(title, options) {
  if (Notification.permission !== 'granted') {
    return false;
  }

  const enhancedOptions = {
    ...options,
    vibrate: [200, 100, 200],
    requireInteraction: false,
    badge: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>⚓</text></svg>"
  };

  try {
    try {
      const notification = new Notification(title, enhancedOptions);
      notification.onclick = function() {
        window.focus();
        notification.close();
      };
      if (options.autoClose !== false) {
        setTimeout(() => notification.close(), 5000);
      }
      return true;
    } catch {
      if (swRegistration && swRegistration.active) {
        await swRegistration.showNotification(title, enhancedOptions);
        return true;
      } else {
        throw new Error('Service Worker not ready. Please reload the page.');
      }
    }
  } catch (error) {
    showSideNotification(`🔔 <strong>Notification Error</strong><br><br>${error.message}`, 'error', null, true);
    throw error;
  }
}

export async function showChatNotification(title, message) {
  if (Notification.permission === "granted" && document.hidden) {
    await showNotification(title, {
      body: message,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='50%' x='50%' text-anchor='middle' font-size='80'>⚓</text></svg>",
      tag: "shipping-manager-chat",
      silent: false,
      data: { action: 'focus-chat' }
    });
  }
}

export function handleNotifications(newMessages, lastReadTimestamp) {
  if (document.hidden) {
    // Get current user ID to filter out own messages
    const currentUserId = window.USER_STORAGE_PREFIX;

    // Filter messages to only show notifications for truly new messages
    // Backend provides lastReadTimestamp, only notify for messages after that
    const unreadMessages = newMessages.filter(msg => {
      if (!lastReadTimestamp) return true; // If no lastRead, show all

      // Get message timestamp in milliseconds
      const msgTimestamp = msg.timestampMs || new Date(msg.timestamp).getTime();

      // Only show notification if message is newer than last read
      // AND not sent by current user (no notifications for own messages)
      if (msg.type === 'chat' && msg.user_id && currentUserId) {
        if (String(msg.user_id) === String(currentUserId)) {
          return false; // Skip own messages
        }
      }

      return msgTimestamp > lastReadTimestamp;
    });

    unreadMessages.forEach(msg => {
      if (msg.type === 'chat') {
        showChatNotification(
          `💬 ${msg.company}`,
          msg.message.substring(0, 100) + (msg.message.length > 100 ? '...' : '')
        );
      } else if (msg.type === 'feed') {
        showChatNotification(
          '📢 Alliance Event',
          `${msg.feedType}: ${msg.company}`
        );
      }
    });
  }
}

// --- Tooltip System ---

export function initCustomTooltips() {
  // Detect if device has touch capability (mobile/tablet)
  const isTouchDevice = ('ontouchstart' in window) ||
                        (navigator.maxTouchPoints > 0) ||
                        (navigator.msMaxTouchPoints > 0);

  // If touch device, remove ALL title attributes and don't create tooltips
  if (isTouchDevice) {
    // Remove all existing title attributes
    document.querySelectorAll('[title]').forEach(el => {
      el.removeAttribute('title');
    });

    // Watch for dynamically added elements and remove their titles too
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) { // Element node
            if (node.hasAttribute && node.hasAttribute('title')) {
              node.removeAttribute('title');
            }
            // Check children too
            if (node.querySelectorAll) {
              node.querySelectorAll('[title]').forEach(el => {
                el.removeAttribute('title');
              });
            }
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return; // Don't initialize tooltip system at all
  }

  // Desktop only - original tooltip code
  const tooltip = document.createElement('div');
  tooltip.className = 'custom-tooltip';
  document.body.appendChild(tooltip);

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[title]');
    if (target && target.hasAttribute('title')) {
      const title = target.getAttribute('title');
      if (!title) return;

      target.setAttribute('data-title', title);
      target.removeAttribute('title');

      tooltip.textContent = title;
      tooltip.classList.add('show');

      const moveTooltip = (event) => {
        const x = event.clientX;
        const y = event.clientY;
        const tooltipRect = tooltip.getBoundingClientRect();

        let left = x + 10;
        let top = y + 10;

        if (left + tooltipRect.width > window.innerWidth) {
          left = window.innerWidth - tooltipRect.width - 10;
        }

        if (top + tooltipRect.height > window.innerHeight) {
          top = y - tooltipRect.height - 10;
        }

        if (left < 10) {
          left = 10;
        }

        if (top < 10) {
          top = 10;
        }

        tooltip.style.setProperty('--tooltip-left', left + 'px');
        tooltip.style.setProperty('--tooltip-top', top + 'px');
      };

      moveTooltip(e);
      target.addEventListener('mousemove', moveTooltip);

      const hideTooltip = () => {
        tooltip.classList.remove('show');
        target.removeEventListener('mousemove', moveTooltip);
        target.removeEventListener('mouseout', hideTooltip);

        if (target.hasAttribute('data-title')) {
          target.setAttribute('title', target.getAttribute('data-title'));
          target.removeAttribute('data-title');
        }
      };

      target.addEventListener('mouseout', hideTooltip);
    }
  });
}

// --- Settings Functions ---

export async function loadSettings() {
  try {
    const response = await fetch(window.apiUrl('/api/settings'));
    const settings = await response.json();
    return settings;
  } catch (error) {
    console.error('Error loading settings from server:', error);
    // Return default settings if server request fails
    return {
      fuelThreshold: 400,
      co2Threshold: 7,
      maintenanceThreshold: 10,
      autoRebuyFuel: false,
      autoRebuyFuelUseAlert: true,
      autoRebuyFuelThreshold: 400,
      autoRebuyCO2: false,
      autoRebuyCO2UseAlert: true,
      autoRebuyCO2Threshold: 7,
      autoDepartAll: false,
      autoBulkRepair: false,
      autoCampaignRenewal: false,
      autoPilotNotifications: false
    };
  }
}

export async function saveSettings(settings) {
  try {
    const response = await fetch(window.apiUrl('/api/settings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(settings)
    });

    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = 'Failed to save settings';
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();

    // Verify settings were actually saved by loading them back
    const verifyResponse = await fetch(window.apiUrl('/api/settings'));
    if (!verifyResponse.ok) {
      throw new Error('Failed to verify settings');
    }

    const savedSettings = await verifyResponse.json();

    // Compare a few critical values to ensure they match
    const criticalFields = ['fuelThreshold', 'co2Threshold', 'autoRebuyFuel', 'autoRebuyCO2', 'autoDepartAll', 'autoPilotNotifications'];
    let allMatch = true;

    for (const field of criticalFields) {
      if (settings[field] !== savedSettings[field]) {
        console.error(`[Settings] Mismatch for ${field}: sent=${settings[field]}, received=${savedSettings[field]}`);
        allMatch = false;
      }
    }

    if (allMatch) {
      // Show success notification only if settings actually match
      showSideNotification('<div style="text-align: center;">⚙️ <strong>Settings saved</strong></div>', 'success', 2000, false);
    } else {
      // Show warning if settings don't match
      showSideNotification('⚙️ <strong>Settings saved but verification failed</strong><br><br>Please reload page', 'error', 4000);
    }

    return result;
  } catch (error) {
    console.error('Error saving settings to server:', error);

    // Show specific error message if available
    let errorMessage = 'Failed to save settings';
    if (error.message && error.message !== 'Failed to save settings') {
      errorMessage = error.message;
    }

    showSideNotification(`⚙️ <strong>Failed to save settings</strong><br><br>${errorMessage}`, 'error', 5000);
    throw error;
  }
}

export function isAutoPilotActive(settings) {
  return settings.autoRebuyFuel ||
         settings.autoRebuyCO2 ||
         settings.autoDepartAll ||
         settings.autoBulkRepair ||
         settings.autoCampaignRenewal ||
         settings.autoCoopEnabled ||
         settings.autoAnchorPointEnabled ||
         settings.autoNegotiateHijacking;
}

export function updatePageTitle(settings) {
  const autoPilotActive = isAutoPilotActive(settings);

  const browserTabTitle = autoPilotActive
    ? '⚓ Shipping Manager - ✨AutoPilot✨'
    : '⚓ Shipping Manager - CoPilot';

  // Update browser tab title
  document.title = browserTabTitle;

  // Update page header with shiny effect ONLY on "AutoPilot" word
  const headerElement = document.getElementById('pageHeaderTitle');

  if (headerElement) {
    // Get notification button first
    const notificationBtn = document.getElementById('notificationBtn');

    if (autoPilotActive) {
      // Create AutoPilot text and button
      headerElement.innerHTML = `Shipping Manager -<span style="margin-left: -10px;"> <span class="autopilot-active" id="autopilotUnit" onclick="window.toggleAutopilot()" title="Toggle AutoPilot">AutoPilot <span id="autopilotToggleBtn" class="autopilot-toggle-btn"><svg id="autopilotToggleIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg></span></span></span><span id="notificationBtnContainer"></span>`;

      // Insert notification button right after the AutoPilot button
      if (notificationBtn) {
        const container = document.getElementById('notificationBtnContainer');
        if (container) {
          container.appendChild(notificationBtn);
        } else {
          headerElement.appendChild(notificationBtn);
        }
      }

      // Update button state after recreating it
      if (window.updateAutopilotButton) {
        try {
          const cachedPauseState = window.getStorage('autopilotPaused');
          const isPaused = cachedPauseState ? JSON.parse(cachedPauseState) : false;
          window.updateAutopilotButton(isPaused);
        } catch (error) {
          console.error('[updatePageTitle] Failed to update button state:', error);
          window.updateAutopilotButton(false);
        }
      }
    } else {
      headerElement.textContent = 'Shipping Manager - CoPilot';

      // Re-append notification button after textContent change
      if (notificationBtn) {
        headerElement.appendChild(notificationBtn);
      }
    }
  }

}

/**
 * Detects if the current device is a mobile device based on screen width and user agent.
 * Uses a combination of viewport width check and user agent parsing for reliability.
 *
 * @returns {boolean} - True if mobile device, false otherwise
 * @example
 * if (isMobileDevice()) {
 *   console.log('Mobile layout active');
 * }
 */
export function isMobileDevice() {
  // Check viewport width (< 768px is considered mobile)
  const isMobileWidth = window.innerWidth < 768;

  // Check user agent for mobile devices
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent.toLowerCase());

  // Return true if either check indicates mobile
  return isMobileWidth || isMobileUA;
}
