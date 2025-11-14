/**
 * Service Worker for handling push notifications in the Shipping Manager Messenger application.
 * Manages the lifecycle events (install, activate), notification clicks, and client communication.
 *
 * @file Service Worker for browser notifications
 * @version 0.0.6
 */

/**
 * Install event handler.
 * Called when the service worker is first installed.
 * Skips waiting to activate immediately without requiring page refresh.
 *
 * @event install
 * @param {ExtendableEvent} event - The install event
 */
self.addEventListener('install', () => {
  console.log('[Service Worker] Installing...');
  self.skipWaiting();
});

/**
 * Activate event handler.
 * Called when the service worker is activated after installation.
 * Claims all clients to ensure the service worker controls all pages immediately.
 *
 * @event activate
 * @param {ExtendableEvent} event - The activate event
 */
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(clients.claim());
});

/**
 * Message event handler.
 * Listens for messages from the main application thread.
 * Handles SKIP_WAITING message to force service worker activation.
 *
 * @event message
 * @param {ExtendableMessageEvent} event - The message event
 * @param {Object} event.data - The message data
 * @param {string} event.data.type - The message type (e.g., 'SKIP_WAITING')
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Notification click event handler.
 * Handles user clicks on browser notifications.
 * Attempts to focus an existing application window or opens a new one.
 *
 * @event notificationclick
 * @param {NotificationEvent} event - The notification click event
 * @param {Notification} event.notification - The notification that was clicked
 */
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification click received.');
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      // Try to focus existing window
      for (let client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
