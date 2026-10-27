'use strict';

const assert = require('assert');
const S = require('../../lib/strategies/SolarLearningStrategy');

const H = 3600 * 1000;
const now = Date.UTC(2026, 9, 17, 11);
const history = (power, fromMs = now - 2 * H) => {
  const out = [];
  for (let t = fromMs; t <= now; t += 5 * 60 * 1000) out.push({ time: t, power });
  return out;
};
const forecastAt = () => 500;

// Clear morning, clouds forecast: 1.5x measured.
const r = S.intradayRatio({ history: history(750), forecastAt, nowMs: now });
assert.ok(Math.abs(r - 1.5) < 1e-9, `ratio ${r}`);
// Only the last hour measured: no correction; few in the first hour: drawn toward 1.
assert.strictEqual(S.intradayRatio({ history: history(750, now - 45 * 60 * 1000), forecastAt, nowMs: now }), 1);
const few = S.intradayRatio({ history: history(750, now - 75 * 60 * 1000), forecastAt, nowMs: now });
assert.ok(few > 1 && few < 1.5, `few samples ${few}`);
// Sky changed within the window (first hour 1x, last hour 2x): damped.
const changed = history(500).map((e) => (e.time > now - H ? { ...e, power: 1000 } : e));
const damped = S.intradayRatio({ history: changed, forecastAt, nowMs: now });
assert.ok(damped > 1 && damped < 1.2, `changed sky ${damped}`);
// Dawn (forecast under the minimum) does not count; extremes clamped.
assert.strictEqual(S.intradayRatio({
  history: history(750), forecastAt: () => 20, nowMs: now, minPowerW: 50,
}), 1);
assert.strictEqual(S.intradayRatio({ history: history(5000), forecastAt, nowMs: now }), 2.5);

// Factor: full now, fading, 1 tomorrow and in the past.
const until = now + 8 * H;
assert.strictEqual(S.intradayFactor(1.5, now, now, until), 1.5);
const in3h = S.intradayFactor(1.5, now + 3 * H, now, until);
assert.ok(Math.abs(in3h - (1 + 0.5 / Math.E)) < 1e-9, `3 h: ${in3h}`);
assert.strictEqual(S.intradayFactor(1.5, until, now, until), 1, 'not tomorrow');
assert.strictEqual(S.intradayFactor(1.5, now - H, now, until), 1, 'not the past');

// calculateForecast applies it.
const forecastData = {};
for (let t = now - 12 * H; t <= now + 36 * H; t += H) forecastData[t] = 400;
const yieldFactors = new Array(96).fill(1);
const plain = S.calculateForecast({ forecastData, yieldFactors, timestamp: now });
const adj = S.calculateForecast({
  forecastData, yieldFactors, timestamp: now, adjust: (t) => S.intradayFactor(1.5, t, now, until),
});
assert.strictEqual(adj.expectedPower, Math.round(plain.expectedPower * 1.5));
assert.ok(adj.totalYield > plain.totalYield);
console.log('solar intraday tests passed');
