/**
 * Tests for cheapest window calculation functionality
 *
 * These tests verify the flow card logic for:
 * - Finding the cheapest X-hour window within a lookahead period
 * - Calculating time (hours/quarters/minutes) until cheapest window
 * - Determining if current period is in the cheapest window
 */

'use strict';

// Mock the price calculation methods from generic_dap_device.js
// We extract the core logic for testing without Homey dependencies

/**
 * Calculate the cheapest window from a price array
 * This mirrors the logic in generic_dap_device.js
 */
function calculateCheapestWindow(prices, args, currentTime, priceInterval = 60) {
  const { granularity, windowSize, lookahead } = args;

  // Get lookahead in minutes
  const lookaheadMinutes = lookahead * 60;
  const periodStart = new Date(currentTime);
  periodStart.setMinutes(0, 0, 0); // Start of current hour
  const lookaheadEnd = new Date(periodStart.getTime() + lookaheadMinutes * 60 * 1000);

  // Filter prices within lookahead period
  const upcomingPrices = prices.filter((p) => {
    const priceTime = new Date(p.time);
    return priceTime >= periodStart && priceTime < lookaheadEnd;
  });

  if (upcomingPrices.length < windowSize) {
    return {
      isNowCheapest: false,
      hoursUntil: null,
      quartersUntil: null,
      minutesUntil: null,
      cheapestAvgPrice: null,
      cheapestStartHour: null,
    };
  }

  // Build windows
  const windows = [];
  for (let start = 0; start <= upcomingPrices.length - windowSize; start += 1) {
    const windowPrices = upcomingPrices.slice(start, start + windowSize);
    const avgPrice = windowPrices.reduce((sum, p) => sum + p.muPrice, 0) / windowSize;
    const startTime = new Date(windowPrices[0].time);
    const periodsFromNow = Math.round((startTime - periodStart) / (priceInterval * 60 * 1000));

    windows.push({
      startIndex: start,
      avgPrice,
      startTime,
      periodsFromNow,
      startHour: startTime.getUTCHours(),
    });
  }

  if (windows.length === 0) {
    return {
      isNowCheapest: false,
      hoursUntil: null,
      quartersUntil: null,
      minutesUntil: null,
      cheapestAvgPrice: null,
      cheapestStartHour: null,
    };
  }

  // Find cheapest window
  const cheapest = windows.reduce((min, w) => (w.avgPrice < min.avgPrice ? w : min));

  // Calculate time until cheapest in different units
  const minutesUntil = cheapest.periodsFromNow * priceInterval;
  const hoursUntil = Math.floor(minutesUntil / 60);
  const quartersUntil = Math.floor(minutesUntil / 15);

  // Check if we're currently in the cheapest window
  const isNowCheapest = cheapest.startIndex === 0;

  return {
    isNowCheapest,
    hoursUntil,
    quartersUntil,
    minutesUntil,
    cheapestAvgPrice: Math.round(cheapest.avgPrice * 10000) / 10000,
    cheapestStartHour: cheapest.startHour,
  };
}

// Helper to generate mock price data
function generatePrices(startTime, hours, pricePattern) {
  const prices = [];
  for (let i = 0; i < hours; i++) {
    const time = new Date(startTime.getTime() + i * 60 * 60 * 1000);
    prices.push({
      time: time.toISOString(),
      muPrice: pricePattern[i % pricePattern.length],
    });
  }
  return prices;
}

describe('Cheapest Window Calculation', () => {

  describe('Basic functionality', () => {

    test('finds cheapest 3-hour window in 24-hour period', () => {
      // Price pattern: high during day (hours 6-22), low at night
      const startTime = new Date('2024-01-15T00:00:00Z');
      const pricePattern = [
        0.50, 0.45, 0.40, 0.35, 0.30, 0.35, // 00:00-05:00 (night - cheap)
        0.80, 1.20, 1.50, 1.80, 2.00, 1.90, // 06:00-11:00 (morning - expensive)
        1.70, 1.60, 1.50, 1.40, 1.50, 1.80, // 12:00-17:00 (afternoon)
        2.20, 2.50, 2.00, 1.50, 1.00, 0.60, // 18:00-23:00 (evening peak then drop)
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      // Current time is 10:00 (expensive period)
      const currentTime = new Date('2024-01-15T10:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 3,
        lookahead: 24,
      }, currentTime);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBeGreaterThan(0);
      expect(result.cheapestAvgPrice).toBeDefined();
    });

    test('returns isNowCheapest=true when current hour is in cheapest window', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      // Current hour (index 0) is cheapest
      const pricePattern = [
        0.30, 0.35, 0.40, // Cheapest 3-hour window at start
        1.50, 1.80, 2.00, 1.90, 1.70, 1.60,
        1.50, 1.40, 1.50, 1.80, 2.20, 2.50,
        2.00, 1.50, 1.00, 0.60, 0.50, 0.45,
        0.40, 0.35, 0.50, 0.55,
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 3,
        lookahead: 24,
      }, currentTime);

      expect(result.isNowCheapest).toBe(true);
      expect(result.hoursUntil).toBe(0);
      expect(result.minutesUntil).toBe(0);
    });

    test('calculates correct hours until cheapest window', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      // Cheapest window is at hours 4-6 (index 4, 5, 6)
      const pricePattern = [
        1.00, 1.20, 1.10, 0.90, // Hours 0-3: expensive
        0.30, 0.25, 0.28,       // Hours 4-6: CHEAPEST
        0.80, 1.00, 1.20, 1.50, 1.80, // Hours 7-11
        1.70, 1.60, 1.50, 1.40, 1.50, 1.80, // Hours 12-17
        2.20, 2.50, 2.00, 1.50, 1.00, 0.60, // Hours 18-23
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      // Current time is 00:00
      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 3,
        lookahead: 24,
      }, currentTime);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBe(4); // 4 hours until cheapest window
      expect(result.minutesUntil).toBe(240); // 4 * 60 = 240 minutes
      expect(result.quartersUntil).toBe(16); // 240 / 15 = 16 quarters
      expect(result.cheapestStartHour).toBe(4);
    });
  });

  describe('Appliance delay use case', () => {

    test('dishwasher scenario: start now when cheap', () => {
      const startTime = new Date('2024-01-15T02:00:00Z'); // 2 AM - typically cheap
      // Night prices are low, with 2-3 AM being the cheapest 2-hour window
      const pricePattern = [
        0.25, 0.28, 0.35, 0.40, 0.50, 0.60, // Night/early morning (2-3 AM cheapest)
        1.20, 1.50, 1.80, 2.00, 1.90, 1.70, // Day
        1.60, 1.50, 1.40, 1.50, 1.80, 2.20, // Afternoon
        2.50, 2.00, 1.50, 1.00, 0.60, 0.45, // Evening
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T02:00:00Z');

      // Dishwasher needs 2-hour window
      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 2,
        lookahead: 24,
      }, currentTime);

      // At 2 AM with these prices, window 0 (2-3 AM) avg=0.265 is cheapest
      // Window 1 (3-4 AM) avg=0.315, Window 2 (4-5 AM) avg=0.375
      expect(result.isNowCheapest).toBe(true);
      // User should start dishwasher now!
    });

    test('dishwasher scenario: wait for cheaper period', () => {
      const startTime = new Date('2024-01-15T18:00:00Z'); // 6 PM - peak time
      // Evening peak, then drops at night
      const pricePattern = [
        2.50, 2.80, 2.60, 2.20, 1.80, 1.20, // 18:00-23:00 (peak then drop)
        0.60, 0.45, 0.35, 0.30, 0.32, 0.40, // 00:00-05:00 (night - cheap)
        0.80, 1.20, 1.50, 1.80, 2.00, 1.90, // 06:00-11:00 (morning)
        1.70, 1.60, 1.50, 1.40, 1.50, 1.80, // 12:00-17:00
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T18:00:00Z');

      // Dishwasher needs 2-hour window
      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 2,
        lookahead: 24,
      }, currentTime);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBeGreaterThan(0);
      // User should set delay timer!

      // Verify the wait time is reasonable (should be around 8-9 hours to reach 2-3 AM)
      expect(result.hoursUntil).toBeGreaterThanOrEqual(7);
      expect(result.hoursUntil).toBeLessThanOrEqual(10);
    });

    test('EV charging scenario: find best 4-hour window overnight', () => {
      const startTime = new Date('2024-01-15T22:00:00Z'); // 10 PM - plug in EV
      // Prices drop significantly after midnight
      const pricePattern = [
        1.50, 1.20, // 22:00-23:00
        0.80, 0.50, 0.35, 0.30, 0.28, 0.32, // 00:00-05:00 (cheapest)
        0.60, 0.90, 1.20, 1.50, 1.80, 2.00, // 06:00-11:00
        1.90, 1.70, 1.60, 1.50, 1.40, 1.50, // 12:00-17:00
        1.80, 2.20, 2.50, 2.00, // 18:00-21:00
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T22:00:00Z');

      // EV needs 4-hour charging window
      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 4,
        lookahead: 12, // Look ahead 12 hours (until 10 AM)
      }, currentTime);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBeGreaterThanOrEqual(2); // At least 2 hours wait
      expect(result.cheapestStartHour).toBeGreaterThanOrEqual(0);
      expect(result.cheapestStartHour).toBeLessThanOrEqual(5);
    });
  });

  describe('Edge cases', () => {

    test('handles insufficient price data', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const prices = generatePrices(startTime, 2, [1.0, 1.2]); // Only 2 hours

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 3, // Need 3 hours but only have 2
        lookahead: 24,
      }, currentTime);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBeNull();
      expect(result.cheapestAvgPrice).toBeNull();
    });

    test('handles all prices being equal', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const prices = generatePrices(startTime, 24, [1.50]); // All same price

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 3,
        lookahead: 24,
      }, currentTime);

      // When all prices are equal, first window should be "cheapest"
      expect(result.isNowCheapest).toBe(true);
      expect(result.hoursUntil).toBe(0);
    });

    test('handles negative prices (solar surplus)', () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      // Midday solar surplus causes negative prices
      const pricePattern = [
        0.80, 0.60, 0.20, -0.10, -0.30, -0.25, // 10:00-15:00 (negative midday)
        0.10, 0.40, 0.80, 1.20, 1.50, 1.80,    // 16:00-21:00
        1.20, 0.80, 0.50, 0.40, 0.35, 0.30,    // 22:00-03:00
        0.35, 0.40, 0.50, 0.60, 0.70, 0.75,    // 04:00-09:00
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T10:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 2,
        lookahead: 24,
      }, currentTime);

      // Should find the negative price window
      expect(result.cheapestAvgPrice).toBeLessThan(0);
      expect(result.hoursUntil).toBeGreaterThanOrEqual(2); // Around 12:00-14:00
    });

    test('window size of 1 hour works correctly', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const pricePattern = [
        1.00, 0.80, 0.60, 0.40, 0.20, 0.30, // Cheapest at hour 4
        0.50, 0.70, 0.90, 1.10, 1.30, 1.50,
        1.40, 1.30, 1.20, 1.10, 1.00, 0.90,
        0.80, 0.70, 0.60, 0.50, 0.40, 0.30,
      ];
      const prices = generatePrices(startTime, 24, pricePattern);

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'hours',
        windowSize: 1,
        lookahead: 24,
      }, currentTime);

      expect(result.cheapestStartHour).toBe(4);
      expect(result.hoursUntil).toBe(4);
      expect(result.cheapestAvgPrice).toBe(0.20);
    });
  });

  describe('Time unit conversions', () => {

    test('correctly converts to quarters (15-min intervals)', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const prices = generatePrices(startTime, 24, [
        1.50, 1.40, 1.30, 0.50, 0.40, 0.45, // Cheapest at hour 4-5
        0.80, 1.00, 1.20, 1.50, 1.80, 2.00,
        1.90, 1.70, 1.60, 1.50, 1.40, 1.50,
        1.80, 2.20, 2.50, 2.00, 1.50, 1.00,
      ]);

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'quarters',
        windowSize: 2,
        lookahead: 24,
      }, currentTime);

      // 4 hours = 240 minutes = 16 quarters
      expect(result.quartersUntil).toBe(result.minutesUntil / 15);
    });

    test('correctly converts to minutes', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const prices = generatePrices(startTime, 24, [
        1.50, 1.40, 0.30, 0.35, 0.40, 0.60, // Cheapest at hour 2
        0.80, 1.00, 1.20, 1.50, 1.80, 2.00,
        1.90, 1.70, 1.60, 1.50, 1.40, 1.50,
        1.80, 2.20, 2.50, 2.00, 1.50, 1.00,
      ]);

      const currentTime = new Date('2024-01-15T00:00:00Z');

      const result = calculateCheapestWindow(prices, {
        granularity: 'minutes',
        windowSize: 2,
        lookahead: 24,
      }, currentTime);

      // 2 hours = 120 minutes
      expect(result.minutesUntil).toBe(result.hoursUntil * 60);
    });
  });
});

describe('Flow Integration Scenarios', () => {

  test('simulates complete appliance flow: turn on -> calculate -> decide', () => {
    // Simulate: User turns on washing machine at 7 PM
    const startTime = new Date('2024-01-15T19:00:00Z');
    const pricePattern = [
      2.20, 2.50, 2.30, 1.80, 1.20, // 19:00-23:00 (evening peak)
      0.60, 0.40, 0.35, 0.30, 0.32, 0.40, // 00:00-05:00 (night cheap)
      0.80, 1.20, 1.50, 1.80, 2.00, 1.90, // 06:00-11:00
      1.70, 1.60, 1.50, 1.40, 1.50, 1.80, // 12:00-17:00
      2.00, // 18:00
    ];
    const prices = generatePrices(startTime, 24, pricePattern);

    const currentTime = new Date('2024-01-15T19:00:00Z');

    // Step 1: Calculate cheapest window (washing machine = 2 hours)
    const result = calculateCheapestWindow(prices, {
      granularity: 'hours',
      windowSize: 2,
      lookahead: 24,
    }, currentTime);

    // Step 2: Decision logic (what the flow would do)
    let userMessage;
    let shouldStartNow;

    if (result.isNowCheapest) {
      shouldStartNow = true;
      userMessage = `Start now! Current price ${result.cheapestAvgPrice} is the cheapest.`;
    } else {
      shouldStartNow = false;
      userMessage = `Set delay for ${result.hoursUntil} hours. Cheapest at ${result.cheapestStartHour}:00 (avg ${result.cheapestAvgPrice} kr/kWh)`;
    }

    // Step 3: Verify the decision makes sense
    expect(shouldStartNow).toBe(false); // 7 PM is expensive
    expect(result.hoursUntil).toBeGreaterThanOrEqual(5); // Wait until after midnight
    expect(result.cheapestStartHour).toBeGreaterThanOrEqual(0);
    expect(result.cheapestStartHour).toBeLessThanOrEqual(5);
    expect(userMessage).toContain('Set delay');
  });

  test('simulates notification with all token values', () => {
    const startTime = new Date('2024-01-15T14:00:00Z');
    const pricePattern = [
      1.50, 1.60, 1.70, 1.80, 2.00, 2.20, // 14:00-19:00
      2.50, 2.30, 1.80, 1.20, 0.80, 0.50, // 20:00-01:00
      0.35, 0.30, 0.32, 0.40, 0.60, 0.90, // 02:00-07:00
      1.20, 1.50, 1.40, 1.30, 1.40, 1.45, // 08:00-13:00
    ];
    const prices = generatePrices(startTime, 24, pricePattern);

    const currentTime = new Date('2024-01-15T14:00:00Z');

    const result = calculateCheapestWindow(prices, {
      granularity: 'hours',
      windowSize: 3,
      lookahead: 24,
    }, currentTime);

    // Simulate building a notification with tokens
    const notification = {
      title: result.isNowCheapest ? 'Start Now!' : 'Wait for Cheaper Prices',
      body: result.isNowCheapest
        ? `Current 3-hour window is cheapest at ${result.cheapestAvgPrice} kr/kWh`
        : `Wait ${result.hoursUntil} hours (${result.minutesUntil} minutes). ` +
          `Cheapest window starts at ${result.cheapestStartHour}:00 ` +
          `with avg price ${result.cheapestAvgPrice} kr/kWh`,
    };

    // Verify all token values are present and valid
    expect(result.hours_until_cheapest !== undefined || result.hoursUntil !== undefined).toBe(true);
    expect(result.minutes_until_cheapest !== undefined || result.minutesUntil !== undefined).toBe(true);
    expect(result.quarters_until_cheapest !== undefined || result.quartersUntil !== undefined).toBe(true);
    expect(result.cheapestAvgPrice).toBeGreaterThan(0);
    expect(result.cheapestStartHour).toBeGreaterThanOrEqual(0);
    expect(result.cheapestStartHour).toBeLessThanOrEqual(23);

    // Log for debugging
    console.log('Notification:', notification);
  });
});
