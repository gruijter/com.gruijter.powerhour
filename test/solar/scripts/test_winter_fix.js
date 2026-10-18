'use strict';

const SolarLearningStrategy = require('../../../lib/strategies/SolarLearningStrategy');
const { estimateClearSkyGHI } = require('../../../lib/helpers/ClearSkyGHI');

const { extractSlotSamples, aggregateYieldFactors } = SolarLearningStrategy;

const LAT = 52.09;
const LON = 5.00;
const PEAK_POWER = 1000;
const TRUE_YIELD = 1.0;

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Builds realistic Homey Insights power (hourly average) + OpenMeteo weather (hourly average, hour-end timestamped)
function buildWinterDay(dayOffset, seedBase, isClear = false) {
  const powerEntries = [];
  const weatherEntries = [];
  const dayStart = new Date(`2026-12-${String(10 + dayOffset).padStart(2, '0')}T00:00:00Z`).getTime();

  // Calculate hourly average power and radiation for 24 hours
  for (let h = 0; h < 24; h += 1) {
    const hourStart = dayStart + h * 3600000;
    let sumForecastRad = 0;
    let sumPower = 0;

    // 12 5-minute sub-intervals in this hour
    for (let m = 0; m < 12; m += 1) {
      const t = hourStart + m * 5 * 60000;
      const clearSky = estimateClearSkyGHI(t, LAT, LON);
      if (clearSky <= 0) continue;

      const cloudAttenuation = isClear ? 1.0 : (0.10 + 0.15 * pseudoRandom(seedBase + h * 12 + m * 0.7));
      const cellNoise = isClear ? 1.0 : (1 + (pseudoRandom(seedBase + h * 12 + m * 3.1) - 0.5) * 0.4);
      const trueRadiation = clearSky * cloudAttenuation * cellNoise;
      const forecastNoise = isClear ? 1.0 : (1 + (pseudoRandom(seedBase + h * 12 + m * 5.3 + 100) - 0.5) * 0.3);
      const forecastRadiation = Math.max(0, trueRadiation * forecastNoise);
      const power = TRUE_YIELD * trueRadiation;

      sumForecastRad += forecastRadiation;
      sumPower += power;
    }

    const avgPower = sumPower / 12;
    const avgForecastRad = sumForecastRad / 12;

    // Homey Insights entry (timestamp = hour start, value = hour average)
    powerEntries.push({ t: new Date(hourStart).toISOString(), y: avgPower });
    // Open-Meteo entry: real API timestamps radiation at hour END, not hour start (see
    // RADIATION_TIMESTAMP_CORRECTION_MS in SolarLearningStrategy.js) - match that here or this
    // sim just re-tests the already-fixed 30min misalignment bug instead of winter cloud noise.
    weatherEntries.push({ time: hourStart + 3600000, radiation: Math.round(avgForecastRad) });
  }

  return { powerEntries, weatherEntries };
}

function runSim(daysConfig, label) {
  let allPower = [];
  let allWeather = [];
  daysConfig.forEach((cfg, d) => {
    const day = buildWinterDay(d, d * 1000 + 1, cfg.isClear);
    allPower = allPower.concat(day.powerEntries);
    allWeather = allWeather.concat(day.weatherEntries);
  });

  const r1 = extractSlotSamples({
    powerEntries: allPower, weatherEntries: allWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  });
  const res = aggregateYieldFactors({ combinedSlotSamples: r1.slotSamples, peakPower: PEAK_POWER, logger: () => {} });
  const yf = res.yieldFactors.filter((y) => y !== null && y > 0);
  console.log(`[${label}] Learned YF range: ${Math.min(...yf).toFixed(3)} - ${Math.max(...yf).toFixed(3)} (true = ${TRUE_YIELD.toFixed(3)}), slots=${yf.length}, limit=${res.limit.toFixed(3)}`);
  return { r1, res };
}

console.log('--- REALISTIC HOURLY SIMULATION ---');
runSim(Array(14).fill({ isClear: false }), '14 Cloudy Days');
runSim([...Array(13).fill({ isClear: false }), { isClear: true }], '13 Cloudy + 1 Clear');
runSim(Array(14).fill({ isClear: true }), '14 Clear Days');
