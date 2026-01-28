/**
 * Tests for cheapest window calculation functionality
 *
 * These tests verify the shared cheapest-window module logic for:
 * - Finding the cheapest X-hour window within a lookahead period
 * - Calculating time (hours/quarters/minutes) until cheapest window
 * - Determining if current period is in the cheapest window
 */

'use strict';

const { calculateCheapestWindow, calculatePeriodsUntilCheapest } = require('../cheapest-window');

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

// Helper to create periodStart from currentTime (start of current hour)
function getPeriodStart(currentTime) {
  const periodStart = new Date(currentTime);
  periodStart.setMinutes(0, 0, 0);
  return periodStart;
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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 3,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 3,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 3,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      // Dishwasher needs 2-hour window
      const result = calculateCheapestWindow(prices, {
        windowSize: 2,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      // Dishwasher needs 2-hour window
      const result = calculateCheapestWindow(prices, {
        windowSize: 2,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      // EV needs 4-hour charging window
      const result = calculateCheapestWindow(prices, {
        windowSize: 4,
        lookahead: 12, // Look ahead 12 hours (until 10 AM)
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 3, // Need 3 hours but only have 2
        lookahead: 24,
      }, periodStart);

      expect(result.isNowCheapest).toBe(false);
      expect(result.hoursUntil).toBeNull();
      expect(result.cheapestAvgPrice).toBeNull();
    });

    test('handles all prices being equal', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      const prices = generatePrices(startTime, 24, [1.50]); // All same price

      const currentTime = new Date('2024-01-15T00:00:00Z');
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 3,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 2,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 1,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 2,
        lookahead: 24,
      }, periodStart);

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
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 2,
        lookahead: 24,
      }, periodStart);

      // 2 hours = 120 minutes
      expect(result.minutesUntil).toBe(result.hoursUntil * 60);
    });
  });

  describe('15-minute interval support', () => {

    test('works with 15-minute price intervals', () => {
      const startTime = new Date('2024-01-15T00:00:00Z');
      // Generate 96 quarter-hourly prices (24 hours)
      const prices = [];
      for (let i = 0; i < 96; i++) {
        const time = new Date(startTime.getTime() + i * 15 * 60 * 1000);
        // Price pattern: cheap at quarters 16-19 (hour 4)
        const muPrice = (i >= 16 && i <= 19) ? 0.25 : 1.50;
        prices.push({ time: time.toISOString(), muPrice });
      }

      const currentTime = new Date('2024-01-15T00:00:00Z');
      const periodStart = getPeriodStart(currentTime);

      const result = calculateCheapestWindow(prices, {
        windowSize: 4, // 4 quarters = 1 hour
        lookahead: 24,
      }, periodStart, 15); // 15-minute intervals

      expect(result.isNowCheapest).toBe(false);
      expect(result.minutesUntil).toBe(240); // 16 quarters * 15 min = 240 min
      expect(result.hoursUntil).toBe(4);
    });
  });
});

describe('calculatePeriodsUntilCheapest', () => {

  test('finds cheapest window index correctly', () => {
    const prices = [
      { muPrice: 1.00 },
      { muPrice: 0.80 },
      { muPrice: 0.30 }, // Cheapest 2-period window starts here
      { muPrice: 0.35 },
      { muPrice: 0.60 },
      { muPrice: 1.00 },
    ];

    const result = calculatePeriodsUntilCheapest(prices, 2);

    expect(result.periodsUntil).toBe(2); // Index 2
    expect(result.avgPrice).toBeCloseTo(0.325, 4); // (0.30 + 0.35) / 2
  });

  test('returns null for insufficient data', () => {
    const prices = [{ muPrice: 1.00 }];

    const result = calculatePeriodsUntilCheapest(prices, 3);

    expect(result.periodsUntil).toBeNull();
    expect(result.avgPrice).toBeNull();
  });

  test('returns index 0 when first window is cheapest', () => {
    const prices = [
      { muPrice: 0.10 },
      { muPrice: 0.15 },
      { muPrice: 1.00 },
      { muPrice: 1.50 },
    ];

    const result = calculatePeriodsUntilCheapest(prices, 2);

    expect(result.periodsUntil).toBe(0);
    expect(result.avgPrice).toBeCloseTo(0.125, 4);
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
    const periodStart = getPeriodStart(currentTime);

    // Step 1: Calculate cheapest window (washing machine = 2 hours)
    const result = calculateCheapestWindow(prices, {
      windowSize: 2,
      lookahead: 24,
    }, periodStart);

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
    const periodStart = getPeriodStart(currentTime);

    const result = calculateCheapestWindow(prices, {
      windowSize: 3,
      lookahead: 24,
    }, periodStart);

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
    expect(result.hoursUntil).toBeDefined();
    expect(result.minutesUntil).toBeDefined();
    expect(result.quartersUntil).toBeDefined();
    expect(result.cheapestAvgPrice).toBeGreaterThan(0);
    expect(result.cheapestStartHour).toBeGreaterThanOrEqual(0);
    expect(result.cheapestStartHour).toBeLessThanOrEqual(23);

    // Log for debugging
    console.log('Notification:', notification);
  });
});
