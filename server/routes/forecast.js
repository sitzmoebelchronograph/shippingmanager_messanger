/**
 * @fileoverview Forecast API Route - Clean Timezone Implementation
 *
 * APPROACH:
 * - Source data (forecast.json) is ALWAYS in CEST (UTC+2) - never changes
 * - API converts from CEST to requested timezone (default: server local timezone)
 * - All timezone calculations happen server-side
 * - Response includes clear metadata about source and delivered timezone
 *
 * @module server/routes/forecast
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const { getLocalAppDataDir } = require('../config');

/**
 * Get forecast data file path based on execution mode
 * @returns {string} Path to forecast.json
 */
function getForecastDataPath() {
    if (process.pkg) {
        // Running as .exe - use AppData\Local (machine-specific cache data)
        return path.join(getLocalAppDataDir(), 'ShippingManagerCoPilot', 'sysdata', 'forecast', 'forecast.json');
    }
    // Running from source - use project directory
    return path.join(__dirname, '../../sysdata/forecast/forecast.json');
}

/**
 * Parse numeric UTC offset from string formats
 * Supports: "UTC-6", "GMT-6", "UTC+2", "-06:00", "+02:00", "-6", "+2"
 * @param {string} timezone - Timezone string
 * @returns {number|null} UTC offset in hours, or null if invalid
 */
function parseNumericOffset(timezone) {
    const str = timezone.trim();

    // Format 1: "UTC-6", "UTC+2", "GMT-6", "GMT+2"
    // eslint-disable-next-line security/detect-unsafe-regex
    const utcMatch = str.match(/^(UTC|GMT)([+-]?\d+(?:\.\d+)?)$/i);
    if (utcMatch) {
        return parseFloat(utcMatch[2]);
    }

    // Format 2: "-06:00", "+02:00", "-6:00", "+2:00"
    const colonMatch = str.match(/^([+-]?)(\d{1,2}):(\d{2})$/);
    if (colonMatch) {
        const sign = colonMatch[1] === '-' ? -1 : 1;
        const hours = parseInt(colonMatch[2], 10);
        const minutes = parseInt(colonMatch[3], 10);
        return sign * (hours + minutes / 60);
    }

    // Format 3: "-6", "+2", "6", "-5.5"
    // eslint-disable-next-line security/detect-unsafe-regex
    const plainMatch = str.match(/^([+-]?\d+(?:\.\d+)?)$/);
    if (plainMatch) {
        return parseFloat(plainMatch[1]);
    }

    return null;
}

/**
 * Get UTC offset for timezone abbreviations or numeric offsets
 * @param {string} timezone - Timezone abbreviation (e.g., "PST", "CEST", "UTC") or numeric offset ("UTC-6", "GMT-6", "-6")
 * @returns {number|null} UTC offset in hours, or null if invalid
 */
function getTimezoneOffsetHours(timezone) {
    const timezoneOffsets = {
        // North America
        'PST': -8, 'PDT': -7,  // Pacific
        'MST': -7, 'MDT': -6,  // Mountain
        'CST': -6, 'CDT': -5,  // Central US
        'EST': -5, 'EDT': -4,  // Eastern

        // Europe
        'GMT': 0,  'BST': 1,   // UK
        'WET': 0,  'WEST': 1,  // Western Europe
        'CET': 1,  'CEST': 2,  // Central Europe
        'EET': 2,  'EEST': 3,  // Eastern Europe

        // Asia
        'JST': 9,              // Japan
        'KST': 9,              // Korea
        'CST_CHINA': 8,        // China
        'IST': 5.5,            // India

        // Australia
        'AEST': 10, 'AEDT': 11,// Australia Eastern
        'ACST': 9.5, 'ACDT': 10.5,// Australia Central
        'AWST': 8,             // Australia Western

        // New Zealand
        'NZST': 12, 'NZDT': 13,

        // Other
        'UTC': 0,
        'Z': 0
    };

    const normalized = timezone.toUpperCase();

    // First, try named timezone abbreviations
    if (Object.prototype.hasOwnProperty.call(timezoneOffsets, normalized)) {
        return timezoneOffsets[normalized];
    }

    // Second, try parsing as numeric offset
    const numericOffset = parseNumericOffset(timezone);
    if (numericOffset !== null) {
        // Validate range (-12 to +14)
        if (numericOffset >= -12 && numericOffset <= 14) {
            return numericOffset;
        }
    }

    return null; // Invalid timezone
}

/**
 * Get all valid timezone abbreviations and formats
 * @returns {Object} Object with named timezones and numeric format examples
 */
function getValidTimezones() {
    return {
        named_timezones: [
            'PST', 'PDT', 'MST', 'MDT', 'CST', 'CDT', 'EST', 'EDT',
            'GMT', 'BST', 'WET', 'WEST', 'CET', 'CEST', 'EET', 'EEST',
            'JST', 'KST', 'IST',
            'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST',
            'NZST', 'NZDT',
            'UTC'
        ],
        numeric_formats: [
            'UTC-6', 'UTC+2', 'GMT-6', 'GMT+2',  // UTC/GMT with offset
            '-06:00', '+02:00',                   // ISO 8601 format
            '-6', '+2', '0'                       // Plain numeric offset
        ],
        note: 'Numeric offsets must be between -12 and +14 hours'
    };
}

/**
 * Detect server's local timezone
 * @returns {Object} Timezone info { name, utcOffset, offsetString }
 */
function getServerLocalTimezone() {
    const now = new Date();

    // Get UTC offset in hours
    const offsetMinutes = -now.getTimezoneOffset();
    const offsetHours = offsetMinutes / 60;

    // Determine if DST is active (for European timezones)
    const jan = new Date(now.getFullYear(), 0, 1);
    const jul = new Date(now.getFullYear(), 6, 1);
    const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());

    // Try to get timezone name
    let timezoneName = 'UTC';

    // For Central European timezone (most common case)
    if (offsetHours === 1 && !isDST) {
        timezoneName = 'CET';
    } else if (offsetHours === 2 && isDST) {
        timezoneName = 'CEST';
    } else if (offsetHours === 0) {
        timezoneName = 'UTC';
    } else {
        // Generic fallback
        timezoneName = `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
    }

    return {
        name: timezoneName,
        utcOffset: offsetHours,
        offsetString: `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`,
        isDST: isDST
    };
}

/**
 * Get data for previous day, handling month boundaries
 * @param {Array} forecastData - All forecast data
 * @param {number} currentDay - Current day number
 * @returns {Object|null} Previous day data or null if not available
 */
function getPreviousDayData(forecastData, currentDay) {
    if (currentDay > 1) {
        // Simple case: previous day in same month
        return forecastData.find(d => d.day === currentDay - 1);
    }

    // Day 1: need last day of previous month
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed

    // Get last day of previous month
    const lastDayOfPrevMonth = new Date(year, month, 0).getDate();

    return forecastData.find(d => d.day === lastDayOfPrevMonth);
}

/**
 * Get data for next day, handling month boundaries
 * @param {Array} forecastData - All forecast data
 * @param {number} currentDay - Current day number
 * @returns {Object|null} Next day data or null if not available
 */
function getNextDayData(forecastData, currentDay) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed

    // Get last day of current month
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();

    if (currentDay < lastDayOfMonth) {
        // Simple case: next day in same month
        return forecastData.find(d => d.day === currentDay + 1);
    }

    // Last day of month: need day 1 of next month
    return forecastData.find(d => d.day === 1);
}

/**
 * Convert CEST (UTC+2) forecast data to target timezone
 *
 * @param {Array} forecastData - Original data in CEST
 * @param {string} targetTimezone - Target timezone abbreviation
 * @returns {Object} { success, data, error }
 */
function convertCESTToTimezone(forecastData, targetTimezone) {
    // Get UTC offsets
    const sourceOffset = 2; // CEST is always UTC+2
    const targetOffset = getTimezoneOffsetHours(targetTimezone);

    if (targetOffset === null) {
        return {
            success: false,
            error: 'Invalid timezone',
            message: `Timezone "${targetTimezone}" not recognized`,
            valid_timezones: getValidTimezones()
        };
    }

    // Calculate hour offset
    const hoursOffset = targetOffset - sourceOffset;

    // If no offset needed, return data as-is
    if (hoursOffset === 0) {
        logger.debug('[Forecast] No timezone conversion needed (already CEST)');
        return {
            success: true,
            data: forecastData,
            hoursOffset: 0
        };
    }

    // Convert intervals (30-minute intervals, so hours * 2)
    const intervalOffset = Math.round(hoursOffset * 2);

    logger.debug(`[Forecast] Converting CEST to ${targetTimezone}: ${hoursOffset} hours (${intervalOffset} intervals)`);

    // Convert each day
    const convertedData = forecastData.map(dayData => {
        if (!dayData.hourly_intervals || dayData.hourly_intervals.length === 0) {
            return dayData; // Return as-is if no intervals
        }

        const currentIntervals = dayData.hourly_intervals;
        const convertedIntervals = [];

        // Get adjacent day data for wrapping
        const prevDayData = getPreviousDayData(forecastData, dayData.day);
        const nextDayData = getNextDayData(forecastData, dayData.day);

        for (let i = 0; i < 48; i++) {
            // Check if current interval exists
            if (!currentIntervals[i]) {
                logger.warn(`[Forecast] Missing interval ${i} for day ${dayData.day}, skipping`);
                continue;
            }

            // Calculate source index
            // LOGIC: We're displaying target timezone, need to find corresponding CEST time
            // Negative offset (west, like CET): target is BEHIND source, so need LATER CEST times
            // Positive offset (east, like JST): target is AHEAD of source, so need EARLIER CEST times
            // Example: CET is 1h behind CEST, so CET 00:00 = CEST 01:00 (need index +2)
            const sourceIntervalIndex = i - intervalOffset;

            let sourceInterval;

            if (sourceIntervalIndex >= 0 && sourceIntervalIndex < 48) {
                // Source is within current day
                sourceInterval = currentIntervals[sourceIntervalIndex];

                // If source interval doesn't exist, use current as fallback
                if (!sourceInterval) {
                    logger.warn(`[Forecast] Missing source interval ${sourceIntervalIndex} for day ${dayData.day}, using current interval`);
                    sourceInterval = currentIntervals[i];
                }
            } else if (sourceIntervalIndex < 0) {
                // Need data from previous day (eastward timezone, like JST)
                if (!prevDayData || !prevDayData.hourly_intervals) {
                    // Fallback: use first available interval from current day
                    logger.warn(`[Forecast] Previous day data not available for day ${dayData.day}, using fallback`);
                    sourceInterval = currentIntervals[0];
                } else {
                    const wrappedIndex = 48 + sourceIntervalIndex;
                    sourceInterval = prevDayData.hourly_intervals[wrappedIndex];

                    // If wrapped interval doesn't exist, use first of current day
                    if (!sourceInterval) {
                        logger.warn(`[Forecast] Missing wrapped interval ${wrappedIndex} from previous day, using fallback`);
                        sourceInterval = currentIntervals[0];
                    }
                }
            } else {
                // Need data from next day (westward timezone, like CET, PST)
                if (!nextDayData || !nextDayData.hourly_intervals) {
                    // Fallback: use last available interval from current day
                    logger.warn(`[Forecast] Next day data not available for day ${dayData.day}, using fallback`);
                    sourceInterval = currentIntervals[currentIntervals.length - 1];
                } else {
                    const wrappedIndex = sourceIntervalIndex - 48;
                    sourceInterval = nextDayData.hourly_intervals[wrappedIndex];

                    // If wrapped interval doesn't exist, use last of current day
                    if (!sourceInterval) {
                        logger.warn(`[Forecast] Missing wrapped interval ${wrappedIndex} from next day, using fallback`);
                        sourceInterval = currentIntervals[currentIntervals.length - 1];
                    }
                }
            }

            // Keep the time labels, but use source interval's prices
            convertedIntervals.push({
                start_time: currentIntervals[i].start_time,
                end_time: currentIntervals[i].end_time,
                fuel_price_per_ton: sourceInterval.fuel_price_per_ton,
                co2_price_per_ton: sourceInterval.co2_price_per_ton
            });
        }

        return {
            day: dayData.day,
            hourly_intervals: convertedIntervals
        };
    });

    return {
        success: true,
        data: convertedData,
        hoursOffset: hoursOffset
    };
}

/**
 * Generate metadata for API response
 * @param {string} targetTimezone - Target timezone
 * @param {number} hoursOffset - Hours offset from CEST
 * @returns {Object} Metadata object
 */
function generateMetadata(targetTimezone, hoursOffset) {
    const targetOffset = getTimezoneOffsetHours(targetTimezone);

    return {
        source_timezone: 'CEST',
        source_utc_offset: 2,
        delivered_timezone: targetTimezone,
        delivered_utc_offset: targetOffset,
        timezone_shift_hours: hoursOffset,
        timestamp: new Date().toISOString(),
        note: `Data originally captured in CEST (UTC+2), converted to ${targetTimezone} (UTC${targetOffset >= 0 ? '+' : ''}${targetOffset})`
    };
}

/**
 * Generate formatted text output for chatbot
 * @param {Object} dayData - Day data with intervals
 * @param {number} day - Day number
 * @param {string} timezone - Timezone abbreviation
 * @param {string} companyName - Company name for header
 * @returns {string} Formatted text
 */
function generateChatbotText(dayData, day, timezone, companyName, eventDiscount = null) {
    const now = new Date();
    const dateStr = `${String(day).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

    let text = `📢 ${companyName}'s Forecast Service\n\n`;
    text += `Forecast 👉 ${dateStr} (${timezone})\n\n`;

    // Add event discount notice if active
    if (eventDiscount && eventDiscount.percentage && eventDiscount.type) {
        const type = eventDiscount.type.charAt(0).toUpperCase() + eventDiscount.type.slice(1);
        text += `Event Active: ${type} -${eventDiscount.percentage}%\n\n`;
    }

    text += 'TIME   FUEL  CO2\n';
    text += '-------------------\n';

    // Show ALL 30-minute intervals (48 entries)
    for (const interval of dayData.hourly_intervals) {
        const time = interval.start_time.substring(0, 5);

        // Apply event discount if active
        let fuelPrice = interval.fuel_price_per_ton;
        let co2Price = interval.co2_price_per_ton;

        if (eventDiscount && eventDiscount.percentage) {
            if (eventDiscount.type === 'fuel') {
                fuelPrice = Math.round(fuelPrice * (1 - eventDiscount.percentage / 100));
            } else if (eventDiscount.type === 'co2') {
                co2Price = Math.round(co2Price * (1 - eventDiscount.percentage / 100));
            }
        }

        const fuel = String(fuelPrice).padStart(4, ' ');
        const co2 = String(co2Price).padStart(3, ' ');
        text += `${time}  ${fuel}  ${co2}\n`;
    }

    text += `\nFair winds 🚢`;

    return text;
}

/**
 * GET /api/forecast
 * Returns forecast data converted to target timezone
 *
 * Query parameters:
 * - timezone: Target timezone (default: server local timezone)
 * - source=chatbot: Returns formatted text instead of JSON
 * - day: Specific day (1-31, default: current day for chatbot mode)
 */
router.get('/', async (req, res) => {
    try {
        const { source, day, timezone: requestedTz } = req.query;

        // Validate source parameter
        const validSources = ['chatbot', 'json'];
        if (source && !validSources.includes(source)) {
            return res.status(400).json({
                error: 'Invalid source parameter',
                valid_sources: validSources
            });
        }

        // Validate day parameter if provided
        if (day !== undefined) {
            const dayNum = parseInt(day);
            if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
                return res.status(400).json({
                    error: 'Invalid day parameter. Must be a number between 1 and 31'
                });
            }
        }

        // Load original CEST forecast data
        const dataPath = getForecastDataPath();
        const rawData = await fs.readFile(dataPath, 'utf-8');
        const forecastData = JSON.parse(rawData);

        // Determine target timezone (default: server local timezone)
        const serverTz = getServerLocalTimezone();
        const targetTimezone = requestedTz ? requestedTz.toUpperCase() : serverTz.name;

        logger.debug(`[Forecast] Request: timezone=${targetTimezone}, source=${source || 'json'}, day=${day || 'all'}`);

        // Convert from CEST to target timezone
        const conversionResult = convertCESTToTimezone(forecastData, targetTimezone);

        if (!conversionResult.success) {
            return res.status(400).json(conversionResult);
        }

        const convertedData = conversionResult.data;
        const hoursOffset = conversionResult.hoursOffset;

        // Chatbot mode: return formatted text
        if (source === 'chatbot') {
            const { getUserCompanyName } = require('../utils/api');
            const companyName = getUserCompanyName() || 'Captain';

            // Get current event discount info
            const { fetchPrices } = require('../gameapi');
            let eventDiscount = null;
            try {
                const prices = await fetchPrices();
                eventDiscount = prices.eventDiscount || null;
            } catch (error) {
                logger.error('[Forecast] Error fetching event discount:', error);
                // Continue without event discount
            }

            // Determine day (default to tomorrow for chatbot)
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const targetDay = day ? parseInt(day) : tomorrow.getDate();

            // Find the day data
            const dayData = convertedData.find(d => d.day === targetDay);
            if (!dayData) {
                return res.status(404).send(`No forecast data available for day ${targetDay}`);
            }

            // Generate formatted text with event discount
            const text = generateChatbotText(dayData, targetDay, targetTimezone, companyName, eventDiscount);

            // Send as plain text
            res.type('text/plain; charset=utf-8').send(text);
        } else {
            // Normal JSON response
            const response = {
                metadata: generateMetadata(targetTimezone, hoursOffset),
                data: convertedData
            };

            logger.debug(`[Forecast] Serving data in ${targetTimezone} (${hoursOffset >= 0 ? '+' : ''}${hoursOffset}h from CEST)`);

            res.json(response);
        }
    } catch (error) {
        logger.error('[Forecast] Error loading forecast data:', error);
        res.status(500).json({
            error: 'Failed to load forecast data',
            message: error.message
        });
    }
});

/**
 * GET /api/forecast/raw
 * Returns original unmodified CEST data (for debugging)
 */
router.get('/raw', async (req, res) => {
    try {
        const dataPath = getForecastDataPath();
        const rawData = await fs.readFile(dataPath, 'utf-8');
        const forecastData = JSON.parse(rawData);

        res.json({
            metadata: {
                timezone: 'CEST',
                utc_offset: 2,
                adjusted: false,
                note: 'Original data as captured, no timezone conversion applied',
                timestamp: new Date().toISOString()
            },
            data: forecastData
        });
    } catch (error) {
        logger.error('[Forecast] Error loading raw data:', error);
        res.status(500).json({
            error: 'Failed to load forecast data',
            message: error.message
        });
    }
});

// Export router and helper functions for direct use by ChatBot
module.exports = router;
module.exports.convertCESTToTimezone = convertCESTToTimezone;
module.exports.getServerLocalTimezone = getServerLocalTimezone;
module.exports.generateChatbotText = generateChatbotText;
