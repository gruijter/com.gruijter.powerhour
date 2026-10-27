/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const TimeHelpers = require('../helpers/TimeHelpers');
const { estimateClearSkyGHI } = require('../helpers/ClearSkyGHI');

// Open-Meteo radiation is the average over the hour BEFORE its timestamp
// (https://github.com/open-meteo/open-meteo/discussions/1556), so a value at key K is read as
// valid at K-30min. Confirmed on real device data against solar noon.
const RADIATION_TIMESTAMP_CORRECTION_MS = 30 * 60 * 1000;

const getInterpolatedRadiation = (timestamp, weatherData) => {
  const rawT = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const t = rawT + RADIATION_TIMESTAMP_CORRECTION_MS;
  const date = new Date(t);
  date.setUTCMinutes(0, 0, 0, 0);
  const t1 = date.getTime();
  const t2 = t1 + 3600000;

  const r1 = weatherData instanceof Map ? weatherData.get(t1) : weatherData[t1];
  const r2 = weatherData instanceof Map ? weatherData.get(t2) : weatherData[t2];

  if (r1 === undefined && r2 === undefined) return 0;
  if (r1 === undefined) return r2;
  if (r2 === undefined) return r1;

  const ratio = (t - t1) / 3600000;
  return r1 + (r2 - r1) * ratio;
};

// Samples are weighted by local consistency of the power/forecast-radiation ratio, not by a
// clear-sky classification: smoothness alone cannot tell clear sky from steady overcast (tried,
// reverted). The nightly retrain is the only learning; live learning was removed.

const detectCurtailment = ({
  currentPower,
  lastPower,
  forecastData,
  yieldFactors,
  isCurtailmentActive,
  timestamp = new Date(),
  manualCurtailment = false,
  peakPower = 0,
}) => {
  const result = {
    isActive: isCurtailmentActive,
    log: null,
    changed: false,
  };

  const forecastRadiation = getInterpolatedRadiation(timestamp, forecastData);
  const slotIndex = (timestamp.getUTCHours() * 4) + Math.floor(timestamp.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = forecastRadiation * yieldFactor;

  const systemPeak = peakPower > 0 ? peakPower : Math.max(1000, ...yieldFactors.map((y) => y * 1000));

  // 1. isCloudy: radiation below 300 W/m² within +/- 2 hours (clouds or twilight nearby).
  let minRadiationInWindow = forecastRadiation;
  for (let offset = -2; offset <= 2; offset++) {
    const t = timestamp.getTime() + (offset * 3600000);
    const rad = getInterpolatedRadiation(t, forecastData);
    if (rad < minRadiationInWindow) minRadiationInWindow = rad;
  }
  const isCloudy = minRadiationInWindow < 300;

  const baseMinExpected = Math.max(250, systemPeak * 0.05);
  // Higher threshold with clouds nearby (avoids false drops)
  const triggerExpected = isCloudy ? baseMinExpected * 2 : baseMinExpected;

  const offThreshold = 20; // W

  const wasRunningThreshold = Math.max(50, systemPeak * 0.02); // W

  if (expectedPower > triggerExpected && currentPower < offThreshold && lastPower > wasRunningThreshold) {
    if (!isCurtailmentActive) {
      result.isActive = true;
      result.changed = true;
      result.log = `Curtailment detected: Expected ${Math.round(expectedPower)}W, Actual ${Math.round(currentPower)}W`;
    }
  } else if (isCurtailmentActive) {
    if (manualCurtailment) return result;

    // 3. Recovery: the lower of 80% of expected power and 10% of peak (min 250 W), so a wrong
    // forecast still recovers while dark days stay sensitive.
    const relativeRecovery = expectedPower * 0.8;
    const absoluteRecovery = Math.max(250, systemPeak * 0.10);
    const recoveryThreshold = Math.min(relativeRecovery, absoluteRecovery);

    if (currentPower >= recoveryThreshold) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Power restored to ${Math.round(currentPower)}W (Threshold: ${Math.round(recoveryThreshold)}W)`;
    } else if (!manualCurtailment && expectedPower < 100) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Low expected power (${Math.round(expectedPower)}W)`;
    }
  }

  return result;
};

const calculateSmoothedPower = ({
  currentPower,
  currentEnergy,
  lastEnergyState,
  currentTimestamp,
}) => {
  let smoothedPower = currentPower;
  const newEnergyState = { time: currentTimestamp, energy: currentEnergy };

  if (typeof currentEnergy === 'number' && lastEnergyState && lastEnergyState.time) {
    const dTime = currentTimestamp - lastEnergyState.time;
    const dEnergy = currentEnergy - lastEnergyState.energy;
    // Energy-derived power only without measure_power: coarse energy steps over short intervals
    // give large spikes (0.05 kWh / 1 min = 3000 W).
    if ((typeof currentPower !== 'number' || Number.isNaN(currentPower)) && dTime > 50000 && dEnergy > 0) {
      const avgPower = (dEnergy / (dTime / 3600000)) * 1000;
      smoothedPower = avgPower;
    }
  }
  return { smoothedPower, newEnergyState };
};

const CONFIDENCE_EPSILON = 0.0001; // measurement-precision floor (~1% relative)
const CLEAR_SKY_ADMISSION_FRACTION = 0.05; // admit above 5% of theoretical clear-sky GHI
const HOURLY_MIDPOINT_SHIFT_MS = 30 * 60 * 1000; // verified: hourly entry.t = hour start, value = hour mean
const FIVE_MIN_MIDPOINT_SHIFT_MS = 2.5 * 60 * 1000; // assumed, not verified
// Below this radiation the power/radiation ratio is too unstable to score: one near-sunrise
// sample once outweighed 13 days of consensus. Such samples get the fallback weight.
const MIN_RADIATION_FOR_CONFIDENCE = 50;
const HIGH_RES_WINDOW_MS = 30 * 60 * 1000; // +-30 min window for 5-minute confidence scoring
const HIGH_RES_GAP_BREAK_MS = 15 * 60 * 1000; // window stops at a larger gap between raw samples

// Weighted percentile over samples sorted ascending by `.yieldFactor`, each with a `.weight`.
const weightedPercentile = (sortedSamples, totalWeight, p) => {
  if (sortedSamples.length === 0 || totalWeight <= 0) return 0;
  const target = p * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < sortedSamples.length; i += 1) {
    cumulative += sortedSamples[i].weight;
    if (cumulative >= target) return sortedSamples[i].yieldFactor;
  }
  return sortedSamples[sortedSamples.length - 1].yieldFactor;
};

// No sample may weigh more than half of all others in its slot combined (so at most 1/3 of the
// total): one 5-minute sample once outweighed 13 days of hourly consensus.
const capOutlierWeights = (samples) => {
  const total = samples.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return samples;
  return samples.map((s) => {
    const others = total - s.weight;
    const cap = others * 0.5;
    return (cap > 0 && s.weight > cap) ? { ...s, weight: cap } : s;
  });
};

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// Confidence of an hourly sample from its {prev, this, next} ratios: the residual from the
// straight line through prev/next, so a fast smooth ramp at sunrise is not noise. null without
// a usable triplet (caller uses the fallback weight).
const computeHourlyConfidence = (rPrev, rThis, rNext) => {
  const rPred = (rPrev + rNext) / 2;
  const meanAbs = (Math.abs(rPrev) + Math.abs(rThis) + Math.abs(rNext)) / 3;
  if (!(meanAbs > 0)) return null;
  const rcv = Math.abs(rThis - rPred) / meanAbs;
  return 1 / ((rcv * rcv) + CONFIDENCE_EPSILON);
};

// Confidence of a 5-minute sample: MAD of the residuals from a local linear fit over +-30 min,
// relative to the window's median ratio. null with too few points.
const computeHighResConfidence = (windowPoints) => {
  const n = windowPoints.length;
  if (n < 4) return null;

  const t0 = windowPoints[0].t;
  let sumT = 0; let sumR = 0; let sumTT = 0; let sumTR = 0;
  windowPoints.forEach(({ t, r }) => {
    const dt = t - t0;
    sumT += dt; sumR += r; sumTT += dt * dt; sumTR += dt * r;
  });
  const denom = (n * sumTT) - (sumT * sumT);
  let slope = 0;
  let intercept = sumR / n;
  if (Math.abs(denom) > 1e-9) {
    slope = ((n * sumTR) - (sumT * sumR)) / denom;
    intercept = (sumR - (slope * sumT)) / n;
  }

  const residuals = windowPoints.map(({ t, r }) => Math.abs(r - (intercept + (slope * (t - t0)))));
  const mad = median(residuals);
  const medianR = median(windowPoints.map(({ r }) => r));
  if (!(Math.abs(medianR) > 0)) return null;

  const rcv = (1.4826 * mad) / Math.abs(medianR);
  return 1 / ((rcv * rcv) + CONFIDENCE_EPSILON);
};

// Raw ratio points within +-30 min of entriesWithYield[i], stopping at a gap > 15 min.
// Radiation is midpoint-shifted (FIVE_MIN_MIDPOINT_SHIFT_MS).
const buildHighResWindow = (entriesWithYield, isClipped, i, weatherMap) => {
  const centerT = entriesWithYield[i].timestamp.getTime();
  const points = [];

  let cursorT = centerT;
  for (let j = i; j >= 0; j -= 1) {
    const e = entriesWithYield[j];
    if (!e || isClipped[j]) break;
    if (centerT - e.timestamp.getTime() > HIGH_RES_WINDOW_MS) break;
    if (cursorT - e.timestamp.getTime() > HIGH_RES_GAP_BREAK_MS) break;
    const midT = e.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
    const r = getInterpolatedRadiation(midT, weatherMap);
    if (r > 10) points.unshift({ t: midT, r: e.power / r });
    cursorT = e.timestamp.getTime();
  }

  cursorT = centerT;
  for (let j = i + 1; j < entriesWithYield.length; j += 1) {
    const e = entriesWithYield[j];
    if (!e || isClipped[j]) break;
    if (e.timestamp.getTime() - centerT > HIGH_RES_WINDOW_MS) break;
    if (e.timestamp.getTime() - cursorT > HIGH_RES_GAP_BREAK_MS) break;
    const midT = e.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
    const r = getInterpolatedRadiation(midT, weatherMap);
    if (r > 10) points.push({ t: midT, r: e.power / r });
    cursorT = e.timestamp.getTime();
  }

  return points;
};

// Nightly retrain step 1/2: Insights power + Open-Meteo radiation into per-slot samples
// (power, radiation, yieldFactor, weight).
const extractSlotSamples = ({
  powerEntries, // [{ t: ISO string, y: W }] from Homey Insights
  weatherEntries, // [{ time: ms, radiation: W/m2 }] from Open-Meteo
  resolution, // 'hourly' (last14Days) | 'high' (last24Hours, 5-min)
  peakPower = 0,
  lat,
  lon,
  logger = () => {},
}) => {
  const weatherMap = new Map();
  weatherEntries.forEach((w) => {
    const date = new Date(w.time);
    date.setUTCMinutes(0, 0, 0);
    weatherMap.set(date.getTime(), w.radiation);
  });

  // Yield factors and clipping
  const entriesWithYield = powerEntries.map((entry) => {
    let power = entry.y !== undefined ? entry.y : entry.v;
    if (typeof power !== 'number' || power < 0 || power > 100000) return null;

    if (peakPower > 0) {
      if (power > peakPower * 1.1) return null;
      if (power > peakPower) power = peakPower;
    }

    const timestamp = new Date(entry.t);
    const radiation = getInterpolatedRadiation(timestamp.getTime(), weatherMap);
    if (radiation < 10) return null;

    // Dawn/dusk noise. Low power with daylight radiation is kept: that is how shading is learned.
    if (power < 10 && radiation < 50) return null;

    const yieldFactor = power / radiation;
    return {
      power, radiation, yieldFactor, timestamp,
    };
  });

  const isClipped = new Array(entriesWithYield.length).fill(false);
  for (let i = 1; i < entriesWithYield.length - 1; i += 1) {
    const prev = entriesWithYield[i - 1];
    const curr = entriesWithYield[i];
    const next = entriesWithYield[i + 1];
    if (!prev || !curr || !next) continue;

    const pMin = Math.min(prev.power, curr.power, next.power);
    const pMax = Math.max(prev.power, curr.power, next.power);
    const pAvg = (prev.power + curr.power + next.power) / 3;
    if ((pMax - pMin) < Math.max(10, pAvg * 0.01)) {
      const yMin = Math.min(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yMax = Math.max(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yAvg = (prev.yieldFactor + curr.yieldFactor + next.yieldFactor) / 3;
      if ((yMax - yMin) > (yAvg * 0.03)) isClipped[i] = true;
    }
  }
  logger(`[extractSlotSamples:${resolution}] Clipping detection: found ${isClipped.filter(Boolean).length} clipped samples.`);

  const slotSamples = new Array(96).fill(0).map(() => []);
  const computed = [];
  const pending = []; // window too small to score directly

  const admitSample = (radiation, timestampMs) => {
    if (!(radiation > 10)) return false;
    const clearSky = estimateClearSkyGHI(timestampMs, lat, lon);
    if (clearSky > 0 && !(radiation > clearSky * CLEAR_SKY_ADMISSION_FRACTION)) return false;
    return true;
  };

  const pushSample = (idx, power, radiation, weight, timestamp, isFallback) => {
    if (idx < 0 || idx >= 96) return;
    const yieldFactor = power / radiation;
    if (!(yieldFactor >= 0 && yieldFactor < 500.0)) return;
    slotSamples[idx].push({
      yieldFactor, weight, power, radiation, timestamp, isFallback,
    });
  };

  if (resolution === 'high') {
    for (let i = 0; i < entriesWithYield.length; i += 1) {
      const item = entriesWithYield[i];
      if (!item || isClipped[i]) continue;

      const midT = item.timestamp.getTime() + FIVE_MIN_MIDPOINT_SHIFT_MS;
      const midRadiation = getInterpolatedRadiation(midT, weatherMap);
      if (midRadiation <= 10 || !admitSample(midRadiation, midT)) continue;

      const slotIndex = (new Date(midT).getUTCHours() * 4) + Math.floor(new Date(midT).getUTCMinutes() / 15);
      // Below MIN_RADIATION_FOR_CONFIDENCE: fallback weight
      const windowPoints = midRadiation >= MIN_RADIATION_FOR_CONFIDENCE
        ? buildHighResWindow(entriesWithYield, isClipped, i, weatherMap) : [];
      const weight = computeHighResConfidence(windowPoints);

      if (weight === null) {
        pending.push({
          idx: slotIndex, power: item.power, radiation: midRadiation, timestamp: item.timestamp,
        });
      } else {
        computed.push({
          idx: slotIndex, power: item.power, radiation: midRadiation, weight, timestamp: item.timestamp,
        });
      }
    }
  } else {
    // Homey's hourly entries are the mean power over the hour STARTING at the timestamp (confirmed
    // against 5-minute data), so they represent the hour's midpoint. The 4 quarter slots are read
    // off a piecewise-linear curve through the midpoints; flat where a neighbour is unusable.
    for (let i = 0; i < entriesWithYield.length; i += 1) {
      const item = entriesWithYield[i];
      if (!item || isClipped[i]) continue;

      const slotIndex = (item.timestamp.getUTCHours() * 4) + Math.floor(item.timestamp.getUTCMinutes() / 15);
      const prev = entriesWithYield[i - 1];
      const next = entriesWithYield[i + 1];
      const prevOk = !!prev && !isClipped[i - 1]
        && (item.timestamp.getTime() - prev.timestamp.getTime()) === 3600000;
      const nextOk = !!next && !isClipped[i + 1]
        && (next.timestamp.getTime() - item.timestamp.getTime()) === 3600000;

      // One score per raw hour, used for its 4 quarter-hour samples.
      let weight = null;
      if (prevOk && nextOk) {
        const radThis = getInterpolatedRadiation(item.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        const radPrev = getInterpolatedRadiation(prev.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        const radNext = getInterpolatedRadiation(next.timestamp.getTime() + HOURLY_MIDPOINT_SHIFT_MS, weatherMap);
        // Below MIN_RADIATION_FOR_CONFIDENCE: fallback weight
        if (radThis >= MIN_RADIATION_FOR_CONFIDENCE && radPrev >= MIN_RADIATION_FOR_CONFIDENCE
          && radNext >= MIN_RADIATION_FOR_CONFIDENCE) {
          weight = computeHourlyConfidence(prev.power / radPrev, item.power / radThis, next.power / radNext);
        }
      }
      const subPowers = [
        prevOk ? (prev.power + item.power) / 2 : item.power,
        prevOk ? (prev.power * 0.25) + (item.power * 0.75) : item.power,
        item.power, // :30 - the hour's midpoint
        nextOk ? (item.power * 0.75) + (next.power * 0.25) : item.power,
      ];

      for (let k = 0; k < 4; k += 1) {
        const subTime = item.timestamp.getTime() + k * 900000;
        const subRadiation = getInterpolatedRadiation(subTime, weatherMap);
        if (!admitSample(subRadiation, subTime)) continue;
        if (weight === null) {
          pending.push({
            idx: slotIndex + k, power: subPowers[k], radiation: subRadiation, timestamp: new Date(subTime),
          });
        } else {
          computed.push({
            idx: slotIndex + k, power: subPowers[k], radiation: subRadiation, weight, timestamp: new Date(subTime),
          });
        }
      }
    }
  }

  // Fallback weight: the median of the computed weights this run, or 1 without any. Outliers are
  // capped per slot in aggregateYieldFactors() (capOutlierWeights()), not here.
  const fallbackWeight = computed.length > 0 ? median(computed.map((c) => c.weight)) : 1;
  computed.forEach((c) => pushSample(c.idx, c.power, c.radiation, c.weight, c.timestamp, false));
  pending.forEach((p) => pushSample(p.idx, p.power, p.radiation, fallbackWeight, p.timestamp, true));

  let maxPowerSeen = 0;
  powerEntries.forEach((e) => {
    const p = e.y !== undefined ? e.y : e.v;
    if (typeof p === 'number' && p > maxPowerSeen) maxPowerSeen = p;
  });

  const sampleCount = slotSamples.reduce((sum, s) => sum + s.length, 0);
  const filledSlots = slotSamples.filter((s) => s.length > 0).length;
  logger(`[extractSlotSamples:${resolution}] Extracted ${sampleCount} samples across ${filledSlots} slots `
    + `(fallback weight=${fallbackWeight.toFixed(2)}, used by ${pending.length} samples).`);

  return { slotSamples, maxPowerSeen };
};

// Nightly retrain step 3: per-slot samples (hourly + 'high' combined) into yieldFactors[96] by
// weighted percentile.
const aggregateYieldFactors = ({
  combinedSlotSamples, // Array(96) of samples from extractSlotSamples(), concatenated
  peakPower = 0,
  logger = () => {},
}) => {
  // Global limit: weighted ~p90 yieldFactor of the better-radiated samples, a backstop next to
  // the peakPower ceiling. The radiation bar is relative to the best radiation seen (15..100
  // W/m2): a fixed 100 left it empty through a winter cloud spell.
  let maxRadSeen = 0;
  combinedSlotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation > maxRadSeen) maxRadSeen = s.radiation;
    });
  });
  const highRadiationThreshold = Math.min(100, Math.max(15, maxRadSeen * 0.5));
  const highRadiationSamples = [];
  combinedSlotSamples.forEach((samples) => {
    samples.forEach((s) => {
      if (s.radiation >= highRadiationThreshold) highRadiationSamples.push(s);
    });
  });
  let datasetMaxYF = 0;
  if (highRadiationSamples.length > 0) {
    const capped = capOutlierWeights(highRadiationSamples);
    const sorted = capped.sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);
    datasetMaxYF = weightedPercentile(sorted, totalWeight, 0.90);
    logger(`[aggregateYieldFactors] Global limit (weighted p90): ${highRadiationSamples.length} samples, datasetMaxYF=${datasetMaxYF.toFixed(3)}`);
  }

  const newYieldFactors = new Array(96).fill(null);
  const trainingConfidence = new Array(96).fill(0);
  const confidenceValid = new Array(96).fill(false);

  combinedSlotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    // Per-slot weight cap, see capOutlierWeights().
    const sorted = capOutlierWeights(samples).sort((a, b) => a.yieldFactor - b.yieldFactor);
    const totalWeight = sorted.reduce((sum, s) => sum + s.weight, 0);

    // p75, not the median: the clear-sky bias of the old "top 25%" selection (confirmed on a clear
    // day). With few samples the percentile is blended toward p50, as p75 is easier for one outlier
    // to reach.
    const MIN_SAMPLES_FOR_FULL_PERCENTILE = 10;
    const percentileBlend = Math.min(1, sorted.length / MIN_SAMPLES_FOR_FULL_PERCENTILE);
    const targetPercentile = 0.50 + (0.25 * percentileBlend);
    let best = weightedPercentile(sorted, totalWeight, targetPercentile);

    const bestSample = sorted.reduce((closest, s) => (
      Math.abs(s.yieldFactor - best) < Math.abs(closest.yieldFactor - best) ? s : closest
    ), sorted[0]);

    // Safety cap: the data-derived global limit (softer)...
    let limit = 500.0;
    if (datasetMaxYF > 0) limit = datasetMaxYF * 1.25;

    // Loosened by a physical ceiling from peak capacity at this sample's radiation (Math.max: only
    // loosens). Only for a scored (non-fallback) sample: a fallback sample at very low radiation
    // made the ceiling meaningless.
    if (peakPower > 0 && bestSample.radiation > 0 && !bestSample.isFallback) {
      const physicalCeiling = (peakPower * 1.1) / Math.max(MIN_RADIATION_FOR_CONFIDENCE, bestSample.radiation);
      limit = Math.max(limit, physicalCeiling);
    }

    if (best > limit) best = limit;

    // Training confidence: the share of the scored (non-fallback), day-grouped observations that
    // agree with the selected value, with a Gaussian tolerance (no cliff between slots). Fallback
    // samples are excluded: equal weights would otherwise look like high confidence.
    const CONFIDENCE_AGREEMENT_SIGMA = 0.15; // relative deviation at which agreement credit is ~61%
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

  const updatedSlots = newYieldFactors.filter((y) => y !== null).length;

  // Smooth across adjacent slots. Only a slot with two real neighbours is blended: a day/night
  // boundary slot keeps its value (it leaked into the next slots otherwise).
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

  // Same smoothing for the confidence; confidenceValid is the real-neighbour mask.
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

  const log = updatedSlots === 0
    ? 'No updates derived from data - no slot samples available.'
    : `Aggregated confidence-weighted model. ${updatedSlots} slots updated. (Global limit: ${datasetMaxYF.toFixed(2)})`;

  return {
    yieldFactors: newYieldFactors,
    updated: updatedSlots > 0,
    limit: datasetMaxYF,
    trainingConfidence,
    log,
  };
};

// Intraday correction. The forecast follows the weather model's radiation, which can be far off for
// a day (clouds forecast that do not come: seen live, 2026-10-17, ~40% under clear sky). Measured
// against forecast power over the last INTRADAY_WINDOW_MS corrects the rest of today, fading out
// with lead time. Not learned: the next day starts from the model again.
const INTRADAY_WINDOW_MS = 2 * 60 * 60 * 1000;
const INTRADAY_MIN_SAMPLES = 6; // 30 min of 5-minute history
const INTRADAY_FULL_SAMPLES = 18; // fewer: the ratio is drawn toward 1
const INTRADAY_RANGE = [0.4, 2.5];
const INTRADAY_FADE_MS = 3 * 60 * 60 * 1000;
// The two halves of the window differing by this much (log of their ratios) give ~61% of the
// correction: tested on Prod 20-26 Oct 2026 against the correction without it.
const INTRADAY_STABLE_SIGMA = 0.3;

/**
 * Measured / forecast power over the last INTRADAY_WINDOW_MS, 1 without enough daylight samples.
 * @param {Array<{time:number, power:number}>} history - measured power (5-minute samples)
 * @param {function(number):number} forecastAt - model forecast (W) at a time
 * @param {number} minPowerW - samples with a lower forecast are left out (dawn, dusk)
 */
const intradayRatio = ({
  history, forecastAt, nowMs, minPowerW = 50,
}) => {
  // Per half of the window: a sky that changed within it (clouds the model had at another time)
  // says little about the coming hours.
  const halves = [{ actual: 0, forecast: 0, n: 0 }, { actual: 0, forecast: 0, n: 0 }];
  (history || []).forEach((e) => {
    if (!e || typeof e.power !== 'number' || e.time > nowMs || e.time <= nowMs - INTRADAY_WINDOW_MS) return;
    const f = forecastAt(e.time);
    if (!(f >= minPowerW)) return;
    const h = halves[e.time > nowMs - INTRADAY_WINDOW_MS / 2 ? 1 : 0];
    h.actual += Math.max(0, e.power);
    h.forecast += f;
    h.n += 1;
  });
  const n = halves[0].n + halves[1].n;
  if (n < INTRADAY_MIN_SAMPLES || halves.some((h) => h.n < INTRADAY_MIN_SAMPLES / 2 || !(h.forecast > 0))) return 1;
  const actual = halves[0].actual + halves[1].actual;
  const forecast = halves[0].forecast + halves[1].forecast;
  const ratio = Math.min(INTRADAY_RANGE[1], Math.max(INTRADAY_RANGE[0], actual / forecast));
  const r1 = halves[0].actual / halves[0].forecast;
  const r2 = halves[1].actual / halves[1].forecast;
  const stable = r1 > 0 && r2 > 0 ? Math.exp(-(Math.log(r1 / r2) ** 2) / (2 * INTRADAY_STABLE_SIGMA ** 2)) : 0;
  return 1 + (ratio - 1) * Math.min(1, n / INTRADAY_FULL_SAMPLES) * stable;
};

/**
 * Multiplier for the forecast at t: the intraday ratio, fading from nowMs on, only until untilMs
 * (end of today). 1 before the current slot.
 */
const intradayFactor = (ratio, t, nowMs, untilMs) => {
  if (!(ratio > 0) || ratio === 1 || t >= untilMs || t < nowMs - 15 * 60 * 1000) return 1;
  return 1 + (ratio - 1) * Math.exp(-Math.max(0, t - nowMs) / INTRADAY_FADE_MS);
};

// adjust(t): multiplier on the forecast at t (intradayFactor()), none by default.
const calculateForecast = ({
  forecastData,
  yieldFactors,
  timestamp = new Date(),
  timezone = 'UTC',
  adjust = null,
}) => {
  const t = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const now = new Date(t);
  const factor = (ms) => (adjust ? adjust(ms) : 1);

  // yieldFactors[] is indexed by real UTC hour (solar/device.js updateLearning()).
  const forecastRadiation = getInterpolatedRadiation(t, forecastData);
  const slotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = Math.round(forecastRadiation * yieldFactor * factor(t));

  // Day total over real UTC boundaries of the local day (DST-safe).
  let totalYield = 0;

  const dayStart = TimeHelpers.getLocalMidnightUTC(now, timezone);
  const dayEnd = TimeHelpers.getLocalMidnightUTC(new Date(dayStart.getTime() + 26 * 60 * 60 * 1000), timezone);

  for (let slotMs = dayStart.getTime(); slotMs < dayEnd.getTime(); slotMs += 15 * 60 * 1000) {
    const daySlotIndex = (new Date(slotMs).getUTCHours() * 4) + Math.floor(new Date(slotMs).getUTCMinutes() / 15);
    const rad = getInterpolatedRadiation(slotMs, forecastData);
    const yf = yieldFactors[daySlotIndex] !== undefined ? yieldFactors[daySlotIndex] : 0;
    const power = rad * yf * factor(slotMs);
    totalYield += (power * 0.25) / 1000;
  }

  return {
    expectedPower,
    totalYield: Number(totalYield.toFixed(2)),
  };
};

const getSunBounds = (dateObj, forecastData, timezone = 'UTC') => {
  // Real UTC midnight of the local day (forecastData keys are UTC).
  const startOfDay = TimeHelpers.getLocalMidnightUTC(dateObj, timezone);
  const nextDayObj = new Date(startOfDay.getTime() + 26 * 60 * 60 * 1000); // +26h always lands in the next local day
  const endOfDay = TimeHelpers.getLocalMidnightUTC(nextDayObj, timezone);

  const noon = new Date(startOfDay);
  noon.setHours(noon.getHours() + 12);

  const timestamps = Object.keys(forecastData)
    .map(Number)
    .filter((ts) => ts >= startOfDay.getTime() && ts < endOfDay.getTime() && forecastData[ts] > 0)
    .sort((a, b) => a - b);

  if (timestamps.length === 0) {
    const s = new Date(noon); s.setHours(s.getHours() - 9);
    const e = new Date(noon); e.setHours(e.getHours() + 9);
    return { start: s, end: e };
  }

  const start = new Date(timestamps[0]);
  start.setHours(start.getHours() - 1);

  const end = new Date(timestamps[timestamps.length - 1]);
  end.setHours(end.getHours() + 2);

  const diff = Math.max(noon - start, end - noon);
  return { start: new Date(noon.getTime() - diff), end: new Date(noon.getTime() + diff) };
};

// Blends this retrain's result with the previous stored yieldFactors, damping night-to-night
// swings.
const mergeYields = ({
  historicYields, previousYields, alpha = 0.7, limit = 0, peakPower = 0, trainingConfidence = [],
}) => {
  // Ceiling never below what peak capacity allows at MIN_RADIATION_FOR_CONFIDENCE: the global
  // limit comes from midday samples, where yieldFactor is lowest, and flattened legit sunrise/
  // sunset values.
  const physicalCeiling = peakPower > 0 ? (peakPower * 1.1) / MIN_RADIATION_FOR_CONFIDENCE : 0;
  const effectiveLimit = Math.max(limit, physicalCeiling);

  const merged = [];
  let updatedSlots = 0;
  for (let i = 0; i < 96; i += 1) {
    const historic = historicYields[i];
    const previous = previousYields[i] || 0;
    let newYield;

    if (historic !== null && historic !== undefined && previous > 0) {
      // Both have data. Alpha scaled by the slot's training confidence (0% keeps the previous value):
      // a single fallback sample must not override an established slot. Unscaled without confidences.
      const conf = trainingConfidence[i];
      const effectiveAlpha = conf === undefined ? alpha : alpha * (conf / 100);
      newYield = (historic * effectiveAlpha) + (previous * (1 - effectiveAlpha));
    } else if (historic !== null && historic !== undefined) {
      newYield = historic;
    } else {
      // No historic data: keep the previous value.
      newYield = previous;
    }

    // Hard cap at the physical limit, so an old model cannot drift above it.
    if (effectiveLimit > 0 && newYield > effectiveLimit * 1.01) {
      newYield = effectiveLimit * 1.01;
    }

    if (Math.abs(newYield - previous) > 0.001) {
      updatedSlots += 1;
    }
    merged[i] = newYield !== null ? newYield : 0;
  }
  return {
    yieldFactors: merged,
    log: `Merged historic and previous models. Alpha=${alpha}. ${updatedSlots} slots updated.`,
  };
};

module.exports = {
  detectCurtailment,
  calculateSmoothedPower,
  extractSlotSamples,
  aggregateYieldFactors,
  getInterpolatedRadiation,
  calculateForecast,
  intradayRatio,
  intradayFactor,
  getSunBounds,
  mergeYields,
};
