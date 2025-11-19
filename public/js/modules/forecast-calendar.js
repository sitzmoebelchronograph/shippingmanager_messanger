/**
 * @fileoverview Forecast Calendar Module
 *
 * Displays an interactive price forecast calendar with page-flip navigation.
 * Shows fuel and CO2 prices for upcoming days with color-coded pricing tiers.
 *
 * The module now relies on server-side timezone conversion - all data is
 * received already converted to the browser's local timezone.
 *
 * @module forecast-calendar
 */

let pageFlip = null;
let daysData = [];
let deliveredTimezone = null; // Timezone the data was delivered in
let currentEventDiscount = null; // Current event discount {percentage, type}
let currentEventData = null; // Full event data with time_start, time_end (UTC timestamps)
let currentMonth = null; // Currently displayed month (1-12)
let currentYear = null; // Currently displayed year
let monthDataCache = {}; // Cache for loaded months: key = "YYYY-MM", value = daysData array
let requestedStartPage = null; // Requested start page for navigation (null = auto-detect today)

/**
 * Color classes for fuel prices
 * Uses same thresholds as central function in utils.js
 */
function getFuelClass(price) {
    if (price > 750) return 'fuel-red';
    if (price >= 650) return 'fuel-orange';
    if (price >= 500) return 'fuel-blue';
    if (price >= 1) return 'fuel-green';
    return '';
}

/**
 * Color classes for CO2 prices
 */
function getCo2Class(price) {
    if (price >= 20) return 'co2-red';
    if (price >= 15) return 'co2-orange';
    if (price >= 10) return 'co2-blue';
    if (price >= 1) return 'co2-green';
    return '';
}

/**
 * Get browser timezone abbreviation
 * Uses Intl.DateTimeFormat to detect local timezone
 */
function getBrowserTimezone() {
    try {
        const now = new Date();

        // Get UTC offset in hours
        const offsetMinutes = -now.getTimezoneOffset();
        const offsetHours = offsetMinutes / 60;

        // Determine if DST is active
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());

        // For Central European timezone (most common)
        if (offsetHours === 1 && !isDST) return 'CET';
        if (offsetHours === 2 && isDST) return 'CEST';
        if (offsetHours === 0) return 'UTC';

        // For US timezones
        if (offsetHours === -8 && !isDST) return 'PST';
        if (offsetHours === -7 && isDST) return 'PDT';
        if (offsetHours === -5 && !isDST) return 'EST';
        if (offsetHours === -4 && isDST) return 'EDT';

        // Fallback: generic UTC offset
        return `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
    } catch (e) {
        console.error('[Forecast] Error detecting timezone:', e);
        return 'UTC';
    }
}

/**
 * Check if event is active on any hour of a specific day (for badge display)
 * @param {number} dayNumber - Day of month (1-31)
 * @param {number} month - Month (1-12)
 * @param {number} year - Year
 * @returns {boolean} True if event overlaps with this day
 */
function isEventActiveOnDay(dayNumber, month, year) {
    if (!currentEventData || !currentEventData.time_start || !currentEventData.time_end) {
        return false;
    }

    // Convert event UTC timestamps to CEST (+2 hours)
    const startUTC = new Date(currentEventData.time_start * 1000);
    const endUTC = new Date(currentEventData.time_end * 1000);

    const startCEST = new Date(startUTC.getTime() + (2 * 60 * 60 * 1000));
    const endCEST = new Date(endUTC.getTime() + (2 * 60 * 60 * 1000));

    // Create date range for the day we're checking
    const dayStart = new Date(year, month - 1, dayNumber, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, dayNumber, 23, 59, 59);

    // Event is active if ANY part of the day overlaps with event period
    return dayStart <= endCEST && dayEnd >= startCEST;
}

/**
 * Check if event discount applies to a specific hour
 * @param {Object} interval - Hourly interval object with start_time (HH:MM format)
 * @param {number} dayNumber - Day of month (1-31)
 * @param {number} month - Month (1-12)
 * @param {number} year - Year
 * @returns {boolean} True if event is active during this specific hour
 */
function isEventActiveAtTime(interval, dayNumber, month, year) {
    if (!currentEventData || !currentEventData.time_start || !currentEventData.time_end || !interval || !interval.start_time) {
        return false;
    }

    // Parse hour from start_time (format: "HH:MM")
    const [hours, minutes] = interval.start_time.split(':').map(Number);

    // Create Date object for this specific hour in CEST
    const checkTime = new Date(year, month - 1, dayNumber, hours, minutes, 0);

    // Convert event UTC timestamps to CEST (+2 hours)
    const startUTC = new Date(currentEventData.time_start * 1000);
    const endUTC = new Date(currentEventData.time_end * 1000);

    const startCEST = new Date(startUTC.getTime() + (2 * 60 * 60 * 1000));
    const endCEST = new Date(endUTC.getTime() + (2 * 60 * 60 * 1000));

    // Event is active if this specific hour is within the event period
    return checkTime >= startCEST && checkTime < endCEST;
}

/**
 * Create HTML table for forecast intervals
 * Data is already in correct timezone from server
 */
function createTableHTML(hourlyIntervals, dayNumber, month, year) {
    let html = '<table class="forecast-table">';
    html += `<thead><tr><th>Time</th><th>Fuel $/t</th><th>CO<sup>2</sup> $/t</th></tr></thead>`;
    html += '<tbody>';

    const maxRows = 24;

    // Get current browser time for highlighting
    const now = new Date();
    const currentDay = now.getDate();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const currentHour = now.getHours();
    const currentMinutes = now.getMinutes();

    for (let i = 0; i < maxRows; i++) {
        const interval = hourlyIntervals[i];

        if (!interval) {
            html += `<tr><td>&nbsp;</td><td></td><td></td></tr>`;
            continue;
        }

        // Times are already in correct timezone from server
        const time = interval.start_time.substring(0, 5);

        // Parse interval hour and minutes
        const [intervalHour, intervalMinutes] = interval.start_time.split(':').map(Number);

        // Check if this is the current hour slot
        const isCurrentHour =
            dayNumber === currentDay &&
            month === currentMonth &&
            year === currentYear &&
            intervalHour === currentHour &&
            intervalMinutes <= currentMinutes &&
            currentMinutes < (intervalMinutes + 30);

        // Apply discount ONLY if event is active during this specific hour
        let fuelPrice = interval.fuel_price_per_ton;
        let co2Price = interval.co2_price_per_ton;

        // Check if event is active at this specific hour (not the whole day)
        const eventActiveAtThisHour = isEventActiveAtTime(interval, dayNumber, month, year);

        if (eventActiveAtThisHour && currentEventDiscount) {
            if (currentEventDiscount.type === 'fuel') {
                fuelPrice = Math.round(fuelPrice * (1 - currentEventDiscount.percentage / 100));
            } else if (currentEventDiscount.type === 'co2') {
                co2Price = Math.round(co2Price * (1 - currentEventDiscount.percentage / 100));
            }
        }

        const fuelClass = getFuelClass(fuelPrice);
        const co2Class = getCo2Class(co2Price);
        const currentClass = isCurrentHour ? ' current-hour' : '';

        html += `<tr class="${currentClass}">
                    <td>${time}</td>
                    <td class="${fuelClass}">${fuelPrice}</td>
                    <td class="${co2Class}">${co2Price}</td>
                 </tr>`;
    }

    html += '</tbody></table>';
    return html;
}

/**
 * Render the forecast book with page-flip
 * Includes current month + adjacent months for seamless navigation
 */
function renderBook() {
    const bookElement = document.getElementById('calendarBook');
    bookElement.innerHTML = '';

    // Update event badge (outside the book)
    updateEventBadge();

    // Build data array including previous and next months
    // Each entry needs month/year info to avoid mixing days from different months
    let allMonthsData = [];

    // Add previous month data if cached (only valid days for that month)
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();

    if (monthDataCache[prevKey]) {
        // Only include days that exist in this month (e.g., Feb only has 28/29 days)
        allMonthsData = monthDataCache[prevKey]
            .filter(day => day.day <= daysInPrevMonth)
            .map(day => ({
                ...day,
                month: prevMonth,
                year: prevYear
            }));
    }

    // Add current month data (only valid days)
    const daysInCurrentMonth = new Date(currentYear, currentMonth, 0).getDate();
    const currentMonthData = daysData
        .filter(day => day.day <= daysInCurrentMonth)
        .map(day => ({
            ...day,
            month: currentMonth,
            year: currentYear
        }));
    allMonthsData = [...allMonthsData, ...currentMonthData];

    // Add next month data if cached (only valid days)
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    const nextKey = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    const daysInNextMonth = new Date(nextYear, nextMonth, 0).getDate();

    if (monthDataCache[nextKey]) {
        const nextMonthData = monthDataCache[nextKey]
            .filter(day => day.day <= daysInNextMonth)
            .map(day => ({
                ...day,
                month: nextMonth,
                year: nextYear
            }));
        allMonthsData = [...allMonthsData, ...nextMonthData];
    }

    // Render all pages
    allMonthsData.forEach((dayData) => {
        // Use the month/year from the data itself
        const formattedDate = `${String(dayData.day).padStart(2, '0')}/${String(dayData.month).padStart(2, '0')}/${dayData.year}`;

        const appendPage = (titleSuffix, contentHTML) => {
            const page = document.createElement('div');
            page.className = 'page';

            // Show delivered timezone
            const tzInfo = deliveredTimezone || 'Loading...';

            const finalContent = `
                <div class="page-content">
                    <h2>${formattedDate} ${titleSuffix} ${tzInfo}</h2>
                    ${contentHTML}
                </div>
            `;
            page.innerHTML = finalContent;
            bookElement.appendChild(page);
        };

        if (dayData.status === 'missing' || !dayData.hourly_intervals || dayData.hourly_intervals.length === 0) {
            appendPage('', '<p class="not-collected-message">Data not collected yet</p>');

            const emptyPage = document.createElement('div');
            emptyPage.className = 'page';
            bookElement.appendChild(emptyPage);
            return;
        }

        const currentIntervals = dayData.hourly_intervals;

        // Simple split: data is already in correct timezone from server
        // First half: 00:00 - 11:30 (intervals 0-23)
        // Second half: 12:00 - 23:30 (intervals 24-47)
        let finalFirstHalf = currentIntervals.slice(0, 24);
        let finalSecondHalf = currentIntervals.slice(24, 48);

        // Ensure we always have 24 entries for each half
        while (finalFirstHalf.length < 24) finalFirstHalf.push(null);
        while (finalSecondHalf.length < 24) finalSecondHalf.push(null);

        appendPage('AM -', createTableHTML(finalFirstHalf, dayData.day, dayData.month, dayData.year));
        appendPage('PM -', createTableHTML(finalSecondHalf, dayData.day, dayData.month, dayData.year));
    });

    const PageFlipConstructor = (window.St && window.St.PageFlip) || window.PageFlip;

    if (typeof PageFlipConstructor !== 'function') {
        console.error('[Forecast] PageFlip library not loaded');
        return;
    }

    // Calculate offset for previous month pages
    let prevMonthPagesOffset = 0;
    if (monthDataCache[prevKey]) {
        prevMonthPagesOffset = monthDataCache[prevKey].length * 2; // 2 pages per day
    }

    // Determine start page
    let startPage = prevMonthPagesOffset; // Default to start of current month
    if (requestedStartPage !== null) {
        // Use requested start page (for navigation)
        startPage = requestedStartPage;
        requestedStartPage = null; // Reset after use
    } else {
        // Auto-detect based on current day (only if viewing current month)
        const now = new Date();
        if (currentMonth === (now.getMonth() + 1) && currentYear === now.getFullYear()) {
            const currentDayOfMonth = now.getDate();
            const todayIndex = daysData.findIndex(d => d.day === currentDayOfMonth);
            if (todayIndex !== -1) {
                startPage = prevMonthPagesOffset + (todayIndex * 2);
            }
        }
    }

    // Calculate page size based on available container space
    // Use clientWidth/Height which excludes padding
    const containerWidth = bookElement.clientWidth - 5;
    const containerHeight = bookElement.clientHeight;

    // Each page is half the width (for 2-page spread)
    const pageWidth = Math.floor(containerWidth / 2);
    // Make calendar smaller to fit with padding
    const pageHeight = containerHeight - 30;

    pageFlip = new PageFlipConstructor(
        bookElement,
        {
            width: pageWidth,
            height: pageHeight,
            size: 'fixed',
            flippingTime: 600,
            showCover: false,
            maxShadowOpacity: 0.5,
            mobileScrollSupport: true,
            startPage: startPage,
            clickEventForward: false,
            swipeDistance: 30,
            useMouseEvents: true,
            drawShadow: true,
            maxWidth: pageWidth,
            minWidth: pageWidth,
            maxHeight: pageHeight,
            minHeight: pageHeight,
        }
    );

    pageFlip.loadFromHTML(document.querySelectorAll('.page'));

    // Update event badge when page is flipped (day-specific display)
    pageFlip.on('flip', () => {
        // Update badge to show only if event active on currently visible day
        updateEventBadge();

        // Add shake animation if badge is visible
        const badge = document.getElementById('forecastEventBadge');
        if (badge && !badge.classList.contains('hidden')) {
            badge.classList.add('shake');
            setTimeout(() => {
                badge.classList.remove('shake');
            }, 500);
        }
    });

    // Update badge for initial page on load
    setTimeout(() => updateEventBadge(), 100);
}


/**
 * Preload a specific month into cache
 */
async function preloadMonth(month, year) {
    const cacheKey = `${year}-${String(month).padStart(2, '0')}`;

    if (monthDataCache[cacheKey]) {
        return; // Already cached
    }

    try {
        const browserTz = getBrowserTimezone();
        const response = await fetch(`/api/forecast?timezone=${browserTz}`);
        if (!response.ok) return;

        const responseData = await response.json();
        if (responseData.error) return;

        const fetchedData = responseData.data || responseData;
        if (!Array.isArray(fetchedData)) return;

        // Fill in missing days for target month
        const daysInMonth = new Date(year, month, 0).getDate();
        const existingDays = new Set(fetchedData.map(d => d.day));

        let monthData = [...fetchedData];
        for (let i = 1; i <= daysInMonth; i++) {
            if (!existingDays.has(i)) {
                monthData.push({ day: i, status: 'missing' });
            }
        }

        monthData.sort((a, b) => a.day - b.day);

        // Cache the month data
        monthDataCache[cacheKey] = monthData;

    } catch (error) {
        console.error(`[Forecast] Error preloading ${cacheKey}:`, error);
    }
}


/**
 * Load forecast data from server for a specific month
 * Server automatically converts to browser's timezone
 * @param {number} month - Month to load (1-12), defaults to current month
 * @param {number} year - Year to load, defaults to current year
 */
async function loadForecastData(month = null, year = null) {
    try {
        // Default to current month/year if not specified
        const now = new Date();
        const targetMonth = month || (now.getMonth() + 1);
        const targetYear = year || now.getFullYear();

        // Check cache first
        const cacheKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
        if (monthDataCache[cacheKey]) {
            daysData = monthDataCache[cacheKey];
            currentMonth = targetMonth;
            currentYear = targetYear;
            renderBook();
            return;
        }

        // Get browser's timezone
        const browserTz = getBrowserTimezone();

        // Request data in browser's timezone
        const response = await fetch(`/api/forecast?timezone=${browserTz}`);
        if (!response.ok) {
            throw new Error(`HTTP Error! Status: ${response.status}`);
        }
        const responseData = await response.json();

        // Check for error response
        if (responseData.error) {
            throw new Error(responseData.error);
        }

        // Extract metadata
        if (responseData.metadata) {
            deliveredTimezone = responseData.metadata.delivered_timezone;
        }

        // Extract the data array from the response
        const fetchedData = responseData.data || responseData;

        if (!Array.isArray(fetchedData)) {
            throw new Error('Forecast data is not an array');
        }

        // Fill in missing days for target month
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
        const existingDays = new Set(fetchedData.map(d => d.day));

        let monthData = [...fetchedData];
        for (let i = 1; i <= daysInMonth; i++) {
            if (!existingDays.has(i)) {
                monthData.push({ day: i, status: 'missing' });
            }
        }

        monthData.sort((a, b) => a.day - b.day);

        // Cache the data
        monthDataCache[cacheKey] = monthData;

        // Set current state
        daysData = monthData;
        currentMonth = targetMonth;
        currentYear = targetYear;

        // Preload adjacent months immediately for seamless navigation
        const prevMonth = targetMonth === 1 ? 12 : targetMonth - 1;
        const prevYear = targetMonth === 1 ? targetYear - 1 : targetYear;
        const nextMonth = targetMonth === 12 ? 1 : targetMonth + 1;
        const nextYear = targetMonth === 12 ? targetYear + 1 : targetYear;

        // Initial render
        renderBook();

        // Preload both adjacent months in parallel (non-blocking)
        Promise.all([
            preloadMonth(prevMonth, prevYear),
            preloadMonth(nextMonth, nextYear)
        ]).then(() => {
            // Calculate current page before re-render
            const currentPageBeforeReload = pageFlip ? pageFlip.getCurrentPageIndex() : null;

            // Re-render to include adjacent months
            if (currentPageBeforeReload !== null) {
                // Adjust page offset: prev month pages will be added, so add their count
                const prevMonthPages = monthDataCache[`${prevYear}-${String(prevMonth).padStart(2, '0')}`]?.length * 2 || 0;
                requestedStartPage = currentPageBeforeReload + prevMonthPages;
            }

            renderBook();
        });
    } catch (error) {
        console.error('[Forecast] Error loading data:', error);
        const bookElement = document.getElementById('calendarBook');
        bookElement.innerHTML = `
            <div style="padding: 20px; text-align: center; color: #ef4444;">
                <h2>Loading Error</h2>
                <p>Error: ${error.message}</p>
                <p style="font-style: italic; font-size: 12px;">Ensure forecast data is available</p>
            </div>
        `;
    }
}

/**
 * Get currently visible day from PageFlip
 * @returns {Object|null} {day, month, year} or null if not available
 */
function getCurrentVisibleDay() {
    if (!pageFlip) return null;

    const currentPageIndex = pageFlip.getCurrentPageIndex();

    // Each day has 2 pages (AM/PM), so divide by 2
    const dayIndex = Math.floor(currentPageIndex / 2);

    // Get day from rendered data
    // We need to reconstruct the allMonthsData array logic
    // Calculate which day this corresponds to across prev/current/next months

    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const prevKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;

    let offset = 0;

    // Count prev month days
    if (monthDataCache[prevKey]) {
        const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate();
        const prevMonthDays = monthDataCache[prevKey].filter(day => day.day <= daysInPrevMonth).length;

        if (dayIndex < prevMonthDays) {
            // Day is in previous month
            const day = monthDataCache[prevKey][dayIndex];
            return { day: day.day, month: prevMonth, year: prevYear };
        }
        offset += prevMonthDays;
    }

    // Check current month
    const daysInCurrentMonth = new Date(currentYear, currentMonth, 0).getDate();
    const currentMonthDays = daysData.filter(day => day.day <= daysInCurrentMonth).length;

    if (dayIndex < offset + currentMonthDays) {
        // Day is in current month
        const localIndex = dayIndex - offset;
        const day = daysData[localIndex];
        return { day: day.day, month: currentMonth, year: currentYear };
    }
    offset += currentMonthDays;

    // Must be in next month
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    const nextKey = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

    if (monthDataCache[nextKey]) {
        const localIndex = dayIndex - offset;
        const day = monthDataCache[nextKey][localIndex];
        return { day: day.day, month: nextMonth, year: nextYear };
    }

    return null;
}

/**
 * Updates the event badge display based on the currently visible day
 * Badge shows if the day you're viewing has event hours (not if event is active right now)
 */
function updateEventBadge() {
    const badge = document.getElementById('forecastEventBadge');
    const text = document.getElementById('forecastEventText');

    if (!badge || !text) return;

    // Get currently visible day
    const visibleDay = getCurrentVisibleDay();

    if (!visibleDay || !currentEventDiscount || !currentEventData) {
        badge.classList.add('hidden');
        return;
    }

    // Check if the currently visible day has ANY event hours
    const isEventActive = isEventActiveOnDay(visibleDay.day, visibleDay.month, visibleDay.year);

    if (isEventActive) {
        const resourceName = currentEventDiscount.type === 'fuel' ? 'Fuel' : 'CO2';
        text.innerHTML = `${resourceName} Event! -${currentEventDiscount.percentage}%`;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

/**
 * Update event discount and re-render forecast
 * @param {Object|null} eventDiscount - Event discount info {percentage, type} or null to clear
 * @param {Object|null} eventData - Full event data with time_start, time_end (optional)
 */
export function updateEventDiscount(eventDiscount, eventData = null) {
    // Check if forecast modal is open
    const forecastModal = document.getElementById('forecastOverlay');
    const isModalOpen = forecastModal && !forecastModal.classList.contains('hidden');

    // Always update cached values
    currentEventDiscount = eventDiscount;
    currentEventData = eventData;

    // Only render if modal is actually open
    if (!isModalOpen) {
        return;
    }

    const discountChanged = JSON.stringify(currentEventDiscount) !== JSON.stringify(eventDiscount);
    const eventDataChanged = JSON.stringify(currentEventData) !== JSON.stringify(eventData);

    // Only re-render if discount or event data changed AND forecast is loaded
    if ((discountChanged || eventDataChanged) && daysData.length > 0) {
        renderBook();
    } else if (daysData.length > 0) {
        // Just update the badge without re-rendering the whole book
        updateEventBadge();
    }
}

/**
 * Initialize forecast calendar when modal is opened
 */
export function initForecastCalendar() {
    // Load PageFlip library if not already loaded
    if (!window.PageFlip && !window.St) {
        // Load passive event wrapper first
        const wrapperScript = document.createElement('script');
        wrapperScript.src = '/js/vendor/page-flip-passive-wrapper.js';
        wrapperScript.onload = () => {
            // Then load PageFlip library
            const script = document.createElement('script');
            script.src = '/js/vendor/page-flip.browser.min.js';
            script.onload = () => {
                loadForecastData();
            };
            script.onerror = () => {
                console.error('[Forecast] Failed to load PageFlip library');
            };
            document.head.appendChild(script);
        };
        document.head.appendChild(wrapperScript);
    } else {
        loadForecastData();
    }
}
