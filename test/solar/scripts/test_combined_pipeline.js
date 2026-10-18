'use strict';

// Combined Step1(hourly, 13 days) + Step2(5-min, last 24h) winter benchmark - the gap flagged
// in test/solar/README.md section 3/5/6 as never having been tested. Mirrors drivers/solar/device.js
// updateLearning() exactly: same weatherHistory (hourly-resolution Open-Meteo, hour-END
// timestamped) feeds BOTH extractSlotSamples calls, Step1 gets true hourly-averaged power,
// Step2 gets true 5-minute power - the forecast itself never has finer-than-hourly resolution
// in real life, so getInterpolatedRadiation() piecewise-linearly interpolates between hourly
// points for every 5-min Step2 sample. That mismatch (real 5-min cloud variability vs a smooth
// hourly-interpolated forecast) is the actual Jensen's-bias-relevant noise source for the 'high'
// path - not per-sample forecast noise (Open-Meteo doesn't have finer granularity to be noisy at).
const SolarLearningStrategy = require('../../../lib/strategies/SolarLearningStrategy');
const { estimateClearSkyGHI } = require('../../../lib/helpers/ClearSkyGHI');

const LAT = 52.09;
const LON = 5.00;
const PEAK_POWER = 1000;
const TRUE_YIELD = 1.0;

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// True 5-min radiation for one day: clear-sky * cloud attenuation * cell noise, both varying
// at 5-min cadence (real passing-cloud variability). Returns per-5-min {t, trueRadiation}.
function buildTrue5Min(dayStart, seedBase, isClear) {
  const points = [];
  for (let i = 0; i < 288; i += 1) {
    const t = dayStart + i * 5 * 60000;
    const clearSky = estimateClearSkyGHI(t, LAT, LON);
    if (clearSky <= 0) {
      points.push({ t, trueRadiation: 0 }); continue;
    }
    const cloudAttenuation = isClear ? 1.0 : (0.10 + 0.15 * pseudoRandom(seedBase + i * 0.7));
    const cellNoise = isClear ? 1.0 : (1 + (pseudoRandom(seedBase + i * 3.1) - 0.5) * 0.4);
    points.push({ t, trueRadiation: clearSky * cloudAttenuation * cellNoise });
  }
  return points;
}

// Open-Meteo only ever reports HOURLY radiation (average over the hour, timestamped hour-end,
// see RADIATION_TIMESTAMP_CORRECTION_MS) - build that from the true 5-min trajectory, plus a
// separate independent hourly forecast-model error (weather models mis-predict whole hours, not
// individual 5-min instants).
function buildHourlyForecastFromTrue(true5min, dayStart, seedBase, isClear) {
  const weatherEntries = [];
  for (let h = 0; h < 24; h += 1) {
    const hourStart = dayStart + h * 3600000;
    const inHour = true5min.filter((p) => p.t >= hourStart && p.t < hourStart + 3600000);
    const avgTrue = inHour.reduce((s, p) => s + p.trueRadiation, 0) / (inHour.length || 1);
    const forecastNoise = isClear ? 1.0 : (1 + (pseudoRandom(seedBase + h * 5.3 + 100) - 0.5) * 0.3);
    const forecastRadiation = Math.max(0, avgTrue * forecastNoise);
    weatherEntries.push({ time: hourStart + 3600000, radiation: Math.round(forecastRadiation) });
  }
  return weatherEntries;
}

function buildHourlyDay(dayStart, seedBase, isClear) {
  // Step 1 input: real hourly-averaged Homey Insights power entries.
  const true5min = buildTrue5Min(dayStart, seedBase, isClear);
  const powerEntries = [];
  for (let h = 0; h < 24; h += 1) {
    const hourStart = dayStart + h * 3600000;
    const inHour = true5min.filter((p) => p.t >= hourStart && p.t < hourStart + 3600000);
    const avgPower = TRUE_YIELD * (inHour.reduce((s, p) => s + p.trueRadiation, 0) / (inHour.length || 1));
    powerEntries.push({ t: new Date(hourStart).toISOString(), y: avgPower });
  }
  const weatherEntries = buildHourlyForecastFromTrue(true5min, dayStart, seedBase, isClear);
  return { powerEntries, weatherEntries };
}

function build5MinDay(dayStart, seedBase, isClear) {
  // Step 2 input: real 5-minute Homey Insights power entries (true short-timescale variability).
  const true5min = buildTrue5Min(dayStart, seedBase, isClear);
  const powerEntries = true5min.map((p) => ({ t: new Date(p.t).toISOString(), y: TRUE_YIELD * p.trueRadiation }));
  const weatherEntries = buildHourlyForecastFromTrue(true5min, dayStart, seedBase, isClear);
  return { powerEntries, weatherEntries };
}

function runScenario(label, cfgDays, lastDayIsHighRes) {
  let hourlyPower = [];
  let hourlyWeather = [];
  let highPower = [];
  let highWeather = [];
  cfgDays.forEach((isClear, d) => {
    const dayStart = new Date(`2026-12-${String(10 + d).padStart(2, '0')}T00:00:00Z`).getTime();
    const seedBase = d * 1000 + 1;
    const isLast = d === cfgDays.length - 1;
    if (isLast && lastDayIsHighRes) {
      const day = build5MinDay(dayStart, seedBase, isClear);
      highPower = highPower.concat(day.powerEntries);
      highWeather = highWeather.concat(day.weatherEntries);
    } else {
      const day = buildHourlyDay(dayStart, seedBase, isClear);
      hourlyPower = hourlyPower.concat(day.powerEntries);
      hourlyWeather = hourlyWeather.concat(day.weatherEntries);
    }
  });

  const r1 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: hourlyPower, weatherEntries: hourlyWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  });
  const r2 = lastDayIsHighRes ? SolarLearningStrategy.extractSlotSamples({
    powerEntries: highPower, weatherEntries: highWeather, resolution: 'high', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  }) : { slotSamples: new Array(96).fill(0).map(() => []) };

  const combined = r1.slotSamples.map((s, idx) => [...s, ...r2.slotSamples[idx]]);
  const res = SolarLearningStrategy.aggregateYieldFactors({ combinedSlotSamples: combined, peakPower: PEAK_POWER, logger: () => {} });
  const yf = res.yieldFactors.filter((y) => y !== null && y > 0);
  console.log(`[${label}] YF range: ${Math.min(...yf).toFixed(3)} - ${Math.max(...yf).toFixed(3)} (true=1.000), slots=${yf.length}, limit=${res.limit.toFixed(3)}`);
}

console.log('--- COMBINED STEP1(hourly,13d) + STEP2(5-min,last day) WINTER BENCHMARK ---');
runScenario('14 Cloudy Days (last day = 5-min res)', Array(14).fill(false), true);
runScenario('13 Cloudy + last day Clear (5-min res)', [...Array(13).fill(false), true], true);
runScenario('13 Clear + last day Cloudy (5-min res)', [...Array(13).fill(true), false], true);
runScenario('14 Clear Days (last day = 5-min res)', Array(14).fill(true), true);
console.log('\n--- For reference: pure hourly (Step 1 only), no Step 2 ---');
runScenario('14 Cloudy Days (hourly only)', Array(14).fill(false), false);

// --- Diagnostic: find which slot produces the 0.550 minimum ---
console.log('\n--- DIAGNOSTIC: 13 Cloudy + last day Clear (5-min res) ---');
(function diag() {
  let hourlyPower = [];
  let hourlyWeather = [];
  let highPower = [];
  let highWeather = [];
  const cfgDays = [...Array(13).fill(false), true];
  cfgDays.forEach((isClear, d) => {
    const dayStart = new Date(`2026-12-${String(10 + d).padStart(2, '0')}T00:00:00Z`).getTime();
    const seedBase = d * 1000 + 1;
    const isLast = d === cfgDays.length - 1;
    if (isLast) {
      const day = build5MinDay(dayStart, seedBase, isClear);
      highPower = highPower.concat(day.powerEntries);
      highWeather = highWeather.concat(day.weatherEntries);
    } else {
      const day = buildHourlyDay(dayStart, seedBase, isClear);
      hourlyPower = hourlyPower.concat(day.powerEntries);
      hourlyWeather = hourlyWeather.concat(day.weatherEntries);
    }
  });
  const r1 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: hourlyPower, weatherEntries: hourlyWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  });
  const r2 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: highPower, weatherEntries: highWeather, resolution: 'high', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  });
  const combined = r1.slotSamples.map((s, idx) => [...s, ...r2.slotSamples[idx]]);
  const res = SolarLearningStrategy.aggregateYieldFactors({ combinedSlotSamples: combined, peakPower: PEAK_POWER, logger: () => {} });
  let minIdx = -1;
  let minVal = Infinity;
  res.yieldFactors.forEach((y, i) => {
    if (y !== null && y > 0 && y < minVal) {
      minVal = y; minIdx = i;
    }
  });
  console.log(`Min YF at slot ${minIdx} (UTC ${Math.floor(minIdx / 4)}:${(minIdx % 4) * 15}) = ${minVal.toFixed(3)}`);
  console.log(`Samples in that slot (${combined[minIdx].length}):`);
  combined[minIdx].forEach((s) => {
    console.log(`  power=${s.power.toFixed(1)}W rad=${s.radiation.toFixed(2)} yf=${s.yieldFactor.toFixed(3)} weight=${s.weight.toFixed(2)}`
      + ` fallback=${s.isFallback} t=${new Date(s.timestamp).toISOString()}`);
  });
}());
