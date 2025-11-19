/**
 * @fileoverview Debounced API calls module.
 * Provides debouncing functionality to prevent excessive API calls when
 * user actions trigger rapid updates (e.g., adjusting threshold sliders).
 *
 * @module core/debounced-api
 */

/**
 * Debouncing timeout storage for preventing excessive API calls.
 * Uses a Map to manage multiple debounce timers efficiently.
 *
 * @type {Map<string, number>}
 */
const debounceTimeouts = new Map();

/**
 * Creates a debounced function that delays executing the given function until
 * after the specified delay has elapsed since the last invocation.
 *
 * @param {string} key - Unique identifier for this debounced function's timeout
 * @param {Function} func - The function to debounce
 * @returns {Function} Debounced function that accepts a delay parameter
 *
 * @example
 * const debouncedFn = createDebouncedFunction('myKey', () => console.log('Called'));
 * debouncedFn(500); // Executes after 500ms of inactivity
 */
export function createDebouncedFunction(key, func) {
  return function(delay = 800) {
    clearTimeout(debounceTimeouts.get(key));
    debounceTimeouts.set(key, setTimeout(func, delay));
  };
}

/**
 * Cancel a pending debounced function.
 *
 * @param {string} key - Unique identifier for the debounced function to cancel
 *
 * @example
 * cancelDebouncedFunction('bunker');
 */
export function cancelDebouncedFunction(key) {
  const timeoutId = debounceTimeouts.get(key);
  if (timeoutId) {
    clearTimeout(timeoutId);
    debounceTimeouts.delete(key);
  }
}

/**
 * Cancel all pending debounced functions.
 * Useful during cleanup or page unload.
 */
export function cancelAllDebouncedFunctions() {
  debounceTimeouts.forEach((timeoutId) => {
    clearTimeout(timeoutId);
  });
  debounceTimeouts.clear();
}

/**
 * Check if a debounced function is pending.
 *
 * @param {string} key - Unique identifier for the debounced function
 * @returns {boolean} True if a timeout is pending for this key
 */
export function isDebouncePending(key) {
  return debounceTimeouts.has(key);
}

/**
 * Debounced functions factory.
 * Creates pre-configured debounced functions for common API operations.
 */
export class DebouncedAPIManager {
  constructor() {
    this.functions = new Map();
  }

  /**
   * Register a new debounced API function.
   *
   * @param {string} name - Name of the debounced function
   * @param {Function} apiFunction - The API function to debounce
   * @returns {Function} The debounced function
   */
  register(name, apiFunction) {
    const debouncedFn = createDebouncedFunction(name, apiFunction);
    this.functions.set(name, debouncedFn);
    return debouncedFn;
  }

  /**
   * Get a registered debounced function.
   *
   * @param {string} name - Name of the debounced function
   * @returns {Function|undefined} The debounced function if registered
   */
  get(name) {
    return this.functions.get(name);
  }

  /**
   * Call a registered debounced function.
   *
   * @param {string} name - Name of the debounced function
   * @param {number} delay - Delay in milliseconds
   * @returns {boolean} True if function was called, false if not registered
   */
  call(name, delay = 800) {
    const fn = this.functions.get(name);
    if (fn) {
      fn(delay);
      return true;
    }
    return false;
  }

  /**
   * Cancel all pending debounced functions.
   */
  cancelAll() {
    cancelAllDebouncedFunctions();
  }
}

// Global instance for backward compatibility
const globalManager = new DebouncedAPIManager();

export { globalManager as debouncedAPIManager };
