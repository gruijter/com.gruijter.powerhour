'use strict';
// Re-run the combined Step1(hourly,13d)+Step2(5-min,last day) winter benchmark across much
// larger systems (10kW, 20kW) and geographically diverse locations, assuming peakPower is
// correctly set by the user (so all physicalCeiling protections are actually active - see
// SolarLearningStrategy.js's peakPower-gated logic). Synthetic only - no real device data
// exists for these sizes/locations, unlike the NL/Zuid-Oost-West regression elsewhere.
const SolarLearningStrategy = require('../../../lib/strategies/SolarLearningStrategy');
const { estimateClearSkyGHI } = require('../../../lib/helpers/ClearSkyGHI');

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// TRUE_YIELD scales with system size the same way real STC-rated capacity does: ~1.0 yield
// factor per 1000W of peak capacity at full (1000 W/m2 GHI) output.
function buildTrue5Min(dayStart, seedBase, isClear, lat, lon) {
  const points = [];
  for (let i = 0; i < 288; i += 1) {
    const t = dayStart + i * 5 * 60000;
    const clearSky = estimateClearSkyGHI(t, lat, lon);
    if (clearSky <= 0) { points.push({ t, trueRadiation: 0 }); continue; }
    const cloudAttenuation = isClear ? 1.0 : (0.10 + 0.15 * pseudoRandom(seedBase + i * 0.7));
    const cellNoise = isClear ? 1.0 : (1 + (pseudoRandom(seedBase + i * 3.1) - 0.5) * 0.4);
    points.push({ t, trueRadiation: clearSky * cloudAttenuation * cellNoise });
  }
  return points;
}

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

function buildHourlyDay(dayStart, seedBase, isClear, lat, lon, trueYield) {
  const true5min = buildTrue5Min(dayStart, seedBase, isClear, lat, lon);
  const powerEntries = [];
  for (let h = 0; h < 24; h += 1) {
    const hourStart = dayStart + h * 3600000;
    const inHour = true5min.filter((p) => p.t >= hourStart && p.t < hourStart + 3600000);
    const avgPower = trueYield * (inHour.reduce((s, p) => s + p.trueRadiation, 0) / (inHour.length || 1));
    powerEntries.push({ t: new Date(hourStart).toISOString(), y: avgPower });
  }
  const weatherEntries = buildHourlyForecastFromTrue(true5min, dayStart, seedBase, isClear);
  return { powerEntries, weatherEntries };
}

function build5MinDay(dayStart, seedBase, isClear, lat, lon, trueYield) {
  const true5min = buildTrue5Min(dayStart, seedBase, isClear, lat, lon);
  const powerEntries = true5min.map((p) => ({ t: new Date(p.t).toISOString(), y: trueYield * p.trueRadiation }));
  const weatherEntries = buildHourlyForecastFromTrue(true5min, dayStart, seedBase, isClear);
  return { powerEntries, weatherEntries };
}

function runScenario(label, loc, peakPower, cfgDays) {
  const trueYield = peakPower / 1000;
  let hourlyPower = [], hourlyWeather = [], highPower = [], highWeather = [];
  cfgDays.forEach((isClear, d) => {
    const dayStart = new Date(Date.UTC(2026, loc.month - 1, loc.startDay + d, 0, 0, 0)).getTime();
    const seedBase = d * 1000 + 1;
    const isLast = d === cfgDays.length - 1;
    if (isLast) {
      const day = build5MinDay(dayStart, seedBase, isClear, loc.lat, loc.lon, trueYield);
      highPower = highPower.concat(day.powerEntries);
      highWeather = highWeather.concat(day.weatherEntries);
    } else {
      const day = buildHourlyDay(dayStart, seedBase, isClear, loc.lat, loc.lon, trueYield);
      hourlyPower = hourlyPower.concat(day.powerEntries);
      hourlyWeather = hourlyWeather.concat(day.weatherEntries);
    }
  });

  const r1 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: hourlyPower, weatherEntries: hourlyWeather, resolution: 'hourly', peakPower, lat: loc.lat, lon: loc.lon, logger: () => {},
  });
  const r2 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: highPower, weatherEntries: highWeather, resolution: 'high', peakPower, lat: loc.lat, lon: loc.lon, logger: () => {},
  });
  const combined = r1.slotSamples.map((s, idx) => [...s, ...r2.slotSamples[idx]]);
  const res = SolarLearningStrategy.aggregateYieldFactors({ combinedSlotSamples: combined, peakPower, logger: () => {} });
  const yf = res.yieldFactors.filter((y) => y !== null && y > 0);
  const trueYF = 1.0; // yieldFactor is dimensionless (power/radiation), independent of trueYield scale
  const status = yf.length === 0 ? 'GEEN SLOTS GELEERD' : '';
  console.log(`  [${peakPower / 1000}kW] ${label}: range ${yf.length ? Math.min(...yf).toFixed(3) : '-'} - ${yf.length ? Math.max(...yf).toFixed(3) : '-'} (true=${trueYF.toFixed(3)}), slots=${yf.length}, limit=${res.limit.toFixed(3)} ${status}`);
}

const LOCATIONS = [
  { name: 'Nederland (52.09N, 5.00E) - referentie', lat: 52.09, lon: 5.00, month: 12, startDay: 10 },
  { name: 'Tromso, Noorwegen (69.65N, 18.96E) - poolnacht', lat: 69.65, lon: 18.96, month: 12, startDay: 10 },
  { name: 'Singapore (1.35N, 103.82E) - evenaar', lat: 1.35, lon: 103.82, month: 6, startDay: 10 },
  { name: 'Sydney, Australie (33.87S, 151.21E) - ZH winter', lat: -33.87, lon: 151.21, month: 6, startDay: 10 },
  { name: 'Phoenix, VS (33.45N, 112.07W) - woestijn, hoge instraling', lat: 33.45, lon: -112.07, month: 12, startDay: 10 },
];

const PEAK_POWERS = [10000, 20000];

LOCATIONS.forEach((loc) => {
  console.log(`\n=== ${loc.name} ===`);
  PEAK_POWERS.forEach((peakPower) => {
    runScenario('14 bewolkte dagen (laatste dag 5-min res)', loc, peakPower, Array(14).fill(false));
    runScenario('13 bewolkt + laatste dag helder', loc, peakPower, [...Array(13).fill(false), true]);
    runScenario('14 heldere dagen', loc, peakPower, Array(14).fill(true));
  });
});
