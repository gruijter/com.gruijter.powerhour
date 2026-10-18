'use strict';

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

function buildWinterDay(dayOffset, seedBase, isClear = false) {
  const powerEntries = [];
  const weatherEntries = [];
  const dayStart = new Date(`2026-12-${String(10 + dayOffset).padStart(2, '0')}T00:00:00Z`).getTime();

  for (let h = 0; h < 24; h += 1) {
    const hourStart = dayStart + h * 3600000;
    let sumForecastRad = 0;
    let sumPower = 0;

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

    powerEntries.push({ t: new Date(hourStart).toISOString(), y: avgPower });
    // hour-END timestamp, matching real Open-Meteo behavior (see test_winter_fix.js note)
    weatherEntries.push({ time: hourStart + 3600000, radiation: Math.round(avgForecastRad) });
  }

  return { powerEntries, weatherEntries };
}

// Custom aggregation testing functions
function testEstimatorCurrent(slotSamples, peakPower) {
  const res = SolarLearningStrategy.aggregateYieldFactors({ combinedSlotSamples: slotSamples, peakPower, logger: () => {} });
  const yf = res.yieldFactors.filter((y) => y !== null && y > 0);
  return {
    min: yf.length > 0 ? Math.min(...yf) : 0,
    max: yf.length > 0 ? Math.max(...yf) : 0,
    slots: yf.length,
    limit: res.limit,
    yieldFactors: res.yieldFactors,
  };
}

// Helper: cap outlier weights
function capOutlierWeights(samples) {
  const total = samples.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return samples;
  return samples.map((s) => {
    const others = total - s.weight;
    const cap = others * 0.5;
    return (cap > 0 && s.weight > cap) ? { ...s, weight: cap } : s;
  });
}

function weightedPercentile(sortedSamples, totalWeight, p) {
  if (sortedSamples.length === 0 || totalWeight <= 0) return 0;
  const target = p * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < sortedSamples.length; i += 1) {
    cumulative += sortedSamples[i].weight;
    if (cumulative >= target) return sortedSamples[i].yieldFactor;
  }
  return sortedSamples[sortedSamples.length - 1].yieldFactor;
}

// Proposed Estimator: Ratio-Estimator + SNR adaptive blend + Adaptive datasetMaxYF
function testEstimatorProposed(slotSamples, peakPower) {
  // 1. Dynamic datasetMaxYF from top radiation tier
  let maxRadSeen = 0;
  slotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation > maxRadSeen) maxRadSeen = s.radiation;
    });
  });

  const highRadThreshold = Math.min(100, Math.max(15, maxRadSeen * 0.5));
  const highRadiationSamples = [];
  slotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation >= highRadThreshold) highRadiationSamples.push(s);
    });
  });

  let datasetMaxYF = 0;
  if (highRadiationSamples.length > 0) {
    const capped = capOutlierWeights(highRadiationSamples);
    const sorted = capped.sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);
    datasetMaxYF = weightedPercentile(sorted, totalWeight, 0.90);
  }

  const newYieldFactors = new Array(96).fill(null);

  slotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    const capped = capOutlierWeights(samples);
    const sorted = [...capped].sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);

    // Ratio Estimator (sum(w*power) / sum(w*radiation))
    let sumWPower = 0;
    let sumWRad = 0;
    capped.forEach((s) => {
      sumWPower += s.weight * s.power;
      sumWRad += s.weight * s.radiation;
    });
    const ratioEst = sumWRad > 0 ? sumWPower / sumWRad : 0;

    // Percentile Estimator (p50 -> p75)
    const MIN_SAMPLES_FOR_FULL_PERCENTILE = 10;
    const percentileBlend = Math.min(1, sorted.length / MIN_SAMPLES_FOR_FULL_PERCENTILE);
    const targetPercentile = 0.50 + (0.25 * percentileBlend);
    const percEst = weightedPercentile(sorted, totalWeight, targetPercentile);

    // Mean radiation for this slot
    const meanRad = sumWRad / (totalWeight || 1);
    // SNR blend: when radiation is high (>100 W/m2), trust percentile (p75) to filter cloud-misses.
    // When radiation is low (<50 W/m2), trust ratio estimator to eliminate Jensen ratio bias.
    const snrFactor = Math.min(1, Math.max(0, (meanRad - 30) / (100 - 30)));
    let best = (snrFactor * percEst) + ((1 - snrFactor) * ratioEst);

    // Safety cap
    let limit = 500.0;
    if (datasetMaxYF > 0) limit = datasetMaxYF * 1.25;
    if (peakPower > 0 && meanRad > 0) {
      // Anchor physical ceiling to max(50, radiation) so it doesn't blow up to infinity at 10 W/m2
      const physicalCeiling = (peakPower * 1.1) / Math.max(50, meanRad);
      limit = Math.max(limit, physicalCeiling);
    }
    if (best > limit) best = limit;

    newYieldFactors[idx] = best;
  });

  // Neighbor smoothing (3 pass)
  for (let pass = 0; pass < 3; pass += 1) {
    const smoothed = [...newYieldFactors];
    for (let i = 1; i < 95; i += 1) {
      if (newYieldFactors[i] === null) continue;
      const prev = newYieldFactors[i - 1];
      const next = newYieldFactors[i + 1];
      if (prev === null || next === null) continue;
      smoothed[i] = (prev * 0.25) + (newYieldFactors[i] * 0.5) + (next * 0.25);
    }
    if (newYieldFactors[0] !== null && newYieldFactors[1] !== null) {
      smoothed[0] = (newYieldFactors[0] * 0.75) + (newYieldFactors[1] * 0.25);
    }
    if (newYieldFactors[95] !== null && newYieldFactors[94] !== null) {
      smoothed[95] = (newYieldFactors[95] * 0.75) + (newYieldFactors[94] * 0.25);
    }
    for (let i = 0; i < 96; i += 1) newYieldFactors[i] = smoothed[i];
  }

  const yf = newYieldFactors.filter((y) => y !== null && y > 0);
  return {
    min: yf.length > 0 ? Math.min(...yf) : 0,
    max: yf.length > 0 ? Math.max(...yf) : 0,
    slots: yf.length,
    limit: datasetMaxYF,
    yieldFactors: newYieldFactors,
  };
}

function runComparison(daysConfig, label) {
  let allPower = [];
  let allWeather = [];
  daysConfig.forEach((cfg, d) => {
    const day = buildWinterDay(d, d * 1000 + 1, cfg.isClear);
    allPower = allPower.concat(day.powerEntries);
    allWeather = allWeather.concat(day.weatherEntries);
  });

  const r1 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: allPower, weatherEntries: allWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {},
  });

  const cur = testEstimatorCurrent(r1.slotSamples, PEAK_POWER);
  const prop = testEstimatorProposed(r1.slotSamples, PEAK_POWER);

  console.log(`\n=== SCENARIO: ${label} ===`);
  console.log(`CURRENT:  YF range ${cur.min.toFixed(3)} - ${cur.max.toFixed(3)} (slots=${cur.slots}, limit=${cur.limit.toFixed(3)})`);
  console.log(`PROPOSED: YF range ${prop.min.toFixed(3)} - ${prop.max.toFixed(3)} (slots=${prop.slots}, limit=${prop.limit.toFixed(3)})`);
}

console.log('--- RUNNING ESTIMATOR BENCHMARKS ---');
runComparison(Array(14).fill({ isClear: false }), '14 Cloudy Winter Days');
runComparison([...Array(13).fill({ isClear: false }), { isClear: true }], '13 Cloudy + 1 Clear Winter Day');
runComparison(Array(14).fill({ isClear: true }), '14 Clear Winter Days');
