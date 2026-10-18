'use strict';
const fs = require('fs');
const path = require('path');
const SolarLearningStrategy = require('../../../lib/strategies/SolarLearningStrategy');
const { estimateClearSkyGHI } = require('../../../lib/helpers/ClearSkyGHI');

const LAT = 52.09, LON = 5.00, PEAK_POWER = 1000, TRUE_YIELD = 1.0;

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Realistic 14-day winter generator (with correct Open-Meteo hour-end timestamps)
function buildRealisticWinter(daysConfig) {
  let allPower = [], allWeather = [];
  daysConfig.forEach((cfg, d) => {
    const dayStart = new Date(`2026-12-${String(10 + d).padStart(2, '0')}T00:00:00Z`).getTime();
    for (let h = 0; h < 24; h += 1) {
      const hourStart = dayStart + h * 3600000;
      let sumTrueRad = 0;
      let sumForecastRad = 0;
      let sumPower = 0;
      
      for (let m = 0; m < 12; m += 1) {
        const t = hourStart + m * 5 * 60000;
        const clearSky = estimateClearSkyGHI(t, LAT, LON);
        if (clearSky <= 0) continue;
        
        const cloudAttenuation = cfg.isClear ? 1.0 : (0.10 + 0.15 * pseudoRandom(d * 1000 + h * 12 + m * 0.7));
        const cellNoise = cfg.isClear ? 1.0 : (1 + (pseudoRandom(d * 1000 + h * 12 + m * 3.1) - 0.5) * 0.4);
        const trueRadiation = clearSky * cloudAttenuation * cellNoise;
        const forecastNoise = cfg.isClear ? 1.0 : (1 + (pseudoRandom(d * 1000 + h * 12 + m * 5.3 + 100) - 0.5) * 0.3);
        const forecastRadiation = Math.max(0, trueRadiation * forecastNoise);
        const power = TRUE_YIELD * trueRadiation;
        
        sumTrueRad += trueRadiation;
        sumForecastRad += forecastRadiation;
        sumPower += power;
      }
      
      const avgPower = sumPower / 12;
      const avgForecastRad = sumForecastRad / 12;
      
      allPower.push({ t: new Date(hourStart).toISOString(), y: avgPower });
      allWeather.push({ time: hourStart + 3600000, radiation: Math.round(avgForecastRad) });
    }
  });
  return { allPower, allWeather };
}

// Full revised extractSlotSamples & aggregateYieldFactors & mergeYields
function revisedExtractSlotSamples(args) {
  // Same as SolarLearningStrategy.extractSlotSamples, but scale fallback weight by radiation
  const result = SolarLearningStrategy.extractSlotSamples(args);
  // Scale fallback weights
  result.slotSamples.forEach(samples => {
    samples.forEach(s => {
      if (s.isFallback && s.radiation < 50) {
        s.weight = s.weight * Math.max(0.05, s.radiation / 50);
      }
    });
  });
  return result;
}

function revisedAggregateYieldFactors({ combinedSlotSamples, peakPower = 0, logger = () => {} }) {
  // 1. Dynamic datasetMaxYF: Top-radiation tier adaptive threshold
  let maxRadSeen = 0;
  combinedSlotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation > maxRadSeen) maxRadSeen = s.radiation;
    });
  });

  const highRadThreshold = Math.min(100, Math.max(15, maxRadSeen * 0.5));
  const highRadiationSamples = [];
  combinedSlotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation >= highRadThreshold) highRadiationSamples.push(s);
    });
  });

  let datasetMaxYF = 0;
  if (highRadiationSamples.length > 0) {
    const total = highRadiationSamples.reduce((sum, s) => sum + s.weight, 0);
    const capped = total <= 0 ? highRadiationSamples : highRadiationSamples.map((s) => {
      const others = total - s.weight;
      const cap = others * 0.5;
      return (cap > 0 && s.weight > cap) ? { ...s, weight: cap } : s;
    });
    const sorted = capped.sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);
    const target = 0.90 * totalWeight;
    let cumulative = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      cumulative += sorted[i].weight;
      if (cumulative >= target) {
        datasetMaxYF = sorted[i].yieldFactor;
        break;
      }
    }
    if (datasetMaxYF === 0 && sorted.length > 0) datasetMaxYF = sorted[sorted.length - 1].yieldFactor;
  }

  const newYieldFactors = new Array(96).fill(null);
  const trainingConfidence = new Array(96).fill(0);
  const confidenceValid = new Array(96).fill(false);

  combinedSlotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    // Cap outlier weights
    const total = samples.reduce((sum, s) => sum + s.weight, 0);
    const capped = total <= 0 ? samples : samples.map((s) => {
      const others = total - s.weight;
      const cap = others * 0.5;
      return (cap > 0 && s.weight > cap) ? { ...s, weight: cap } : s;
    });

    const sorted = [...capped].sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);

    // Ratio Estimator (sum(w*P) / sum(w*R))
    let sumWPower = 0, sumWRad = 0;
    capped.forEach((s) => {
      sumWPower += s.weight * s.power;
      sumWRad += s.weight * s.radiation;
    });
    const ratioEst = sumWRad > 0 ? sumWPower / sumWRad : 0;

    // Percentile Estimator (p50 -> p75)
    const MIN_SAMPLES_FOR_FULL_PERCENTILE = 10;
    const percentileBlend = Math.min(1, sorted.length / MIN_SAMPLES_FOR_FULL_PERCENTILE);
    const targetPercentile = 0.50 + (0.25 * percentileBlend);
    const target = targetPercentile * totalWeight;
    let cumulative = 0;
    let percEst = sorted[sorted.length - 1].yieldFactor;
    for (let i = 0; i < sorted.length; i += 1) {
      cumulative += sorted[i].weight;
      if (cumulative >= target) {
        percEst = sorted[i].yieldFactor;
        break;
      }
    }

    // SNR-adaptive blend based on slot mean radiation
    const meanRad = totalWeight > 0 ? sumWRad / totalWeight : 0;
    const snrFactor = Math.min(1, Math.max(0, (meanRad - 30) / (100 - 30)));
    let best = (snrFactor * percEst) + ((1 - snrFactor) * ratioEst);

    const bestSample = sorted.reduce((closest, s) => (
      Math.abs(s.yieldFactor - best) < Math.abs(closest.yieldFactor - best) ? s : closest
    ), sorted[0]);

    // Safety limit
    let limit = 500.0;
    if (datasetMaxYF > 0) limit = datasetMaxYF * 1.25;
    if (peakPower > 0 && bestSample.radiation > 0) {
      const physicalCeiling = (peakPower * 1.1) / Math.max(50, bestSample.radiation);
      limit = Math.max(limit, physicalCeiling);
    }
    if (best > limit) best = limit;

    // Model Fit confidence
    const CONFIDENCE_AGREEMENT_SIGMA = 0.15;
    const verified = sorted.filter((s) => !s.isFallback);
    const byDay = new Map();
    verified.forEach((s) => {
      const day = new Date(s.timestamp).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { weightSum: 0, yfWeightedSum: 0 });
      const entry = byDay.get(day);
      entry.weightSum += s.weight;
      entry.yfWeightedSum += s.weight * s.yieldFactor;
    });
    const perDay = [...byDay.values()].map((e) => ({
      weight: e.weightSum,
      yieldFactor: e.yfWeightedSum / e.weightSum,
    }));
    const totalDayWeight = perDay.reduce((sum, d) => sum + d.weight, 0);
    if (totalDayWeight > 0 && best > 0) {
      const weightedAgreementSum = perDay.reduce((sum, d) => {
        const relDev = Math.abs(d.yieldFactor - best) / best;
        const agreement = Math.exp(-0.5 * (relDev / CONFIDENCE_AGREEMENT_SIGMA) ** 2);
        return sum + (d.weight * agreement);
      }, 0);
      trainingConfidence[idx] = (weightedAgreementSum / totalDayWeight) * 100;
      confidenceValid[idx] = true;
    }

    newYieldFactors[idx] = best;
  });

  // 3-pass neighbor smoothing
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

  for (let pass = 0; pass < 3; pass += 1) {
    const smoothedConf = [...trainingConfidence];
    for (let i = 1; i < 95; i += 1) {
      if (!confidenceValid[i] || !confidenceValid[i - 1] || !confidenceValid[i + 1]) continue;
      smoothedConf[i] = (trainingConfidence[i - 1] * 0.25) + (trainingConfidence[i] * 0.5) + (trainingConfidence[i + 1] * 0.25);
    }
    if (confidenceValid[0] && confidenceValid[1]) {
      smoothedConf[0] = (trainingConfidence[0] * 0.75) + (trainingConfidence[1] * 0.25);
    }
    if (confidenceValid[95] && confidenceValid[94]) {
      smoothedConf[95] = (trainingConfidence[95] * 0.75) + (trainingConfidence[94] * 0.25);
    }
    for (let i = 0; i < 96; i += 1) trainingConfidence[i] = smoothedConf[i];
  }

  const updatedSlots = newYieldFactors.filter((y) => y !== null).length;
  return {
    yieldFactors: newYieldFactors,
    updated: updatedSlots > 0,
    limit: datasetMaxYF,
    trainingConfidence,
    log: `Aggregated confidence-weighted model. ${updatedSlots} slots updated. (Global limit: ${datasetMaxYF.toFixed(2)})`,
  };
}

console.log('=== BENCHMARK 1: Realistic Winter Scenarios ===');
const scenarios = [
  { name: '14 Cloudy Days', cfg: Array(14).fill({ isClear: false }) },
  { name: '13 Cloudy + 1 Clear Day', cfg: [...Array(13).fill({ isClear: false }), { isClear: true }] },
  { name: '7 Cloudy + 7 Clear Days', cfg: Array(7).fill({ isClear: false }).concat(Array(7).fill({ isClear: true })) },
  { name: '14 Clear Days', cfg: Array(14).fill({ isClear: true }) },
];

scenarios.forEach(sc => {
  const { allPower, allWeather } = buildRealisticWinter(sc.cfg);
  const rOld = SolarLearningStrategy.extractSlotSamples({ powerEntries: allPower, weatherEntries: allWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {} });
  const rNew = revisedExtractSlotSamples({ powerEntries: allPower, weatherEntries: allWeather, resolution: 'hourly', peakPower: PEAK_POWER, lat: LAT, lon: LON, logger: () => {} });

  const cOld = SolarLearningStrategy.aggregateYieldFactors({ combinedSlotSamples: rOld.slotSamples, peakPower: PEAK_POWER });
  const cNew = revisedAggregateYieldFactors({ combinedSlotSamples: rNew.slotSamples, peakPower: PEAK_POWER });

  const yOld = cOld.yieldFactors.filter(y => y !== null && y > 0);
  const yNew = cNew.yieldFactors.filter(y => y !== null && y > 0);
  console.log(`\nScenario: ${sc.name} (True = ${TRUE_YIELD.toFixed(3)})`);
  console.log(`  CURRENT:  min=${Math.min(...yOld).toFixed(3)}, max=${Math.max(...yOld).toFixed(3)}, limit=${cOld.limit.toFixed(3)}`);
  console.log(`  REVISED:  min=${Math.min(...yNew).toFixed(3)}, max=${Math.max(...yNew).toFixed(3)}, limit=${cNew.limit.toFixed(3)}`);
});
