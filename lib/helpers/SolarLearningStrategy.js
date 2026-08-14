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

const TimeHelpers = require('../TimeHelpers');

const getInterpolatedRadiation = (timestamp, weatherData) => {
  const t = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
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

const getStrategy = ({
  currentPower,
  forecastData,
  yieldFactors,
  timestamp = new Date(),
  globalMaxYF = 0,
  peakPower = 0,
}) => {
  const result = {
    yieldFactors: [...yieldFactors],
    updated: false,
    log: null,
  };

  // Use interpolated radiation for the center of the bucket (approx +7.5 mins if timestamp is start)
  const forecastRadiation = getInterpolatedRadiation(timestamp.getTime() + 450000, forecastData);

  if (forecastRadiation === undefined || forecastRadiation < 10) {
    // Ignore low radiation or missing data
    return result;
  }

  let power = Math.max(0, currentPower);

  if (peakPower > 0) {
    if (power > peakPower * 1.1) {
      result.log = `Ignored outlier power: P=${power.toFixed(0)}W > 1.1 * PeakPower=${peakPower}W`;
      return result;
    }
    if (power > peakPower) power = peakPower;
  }

  const yieldFactor = power / forecastRadiation;

  if (!Number.isFinite(yieldFactor)) return result;
  // Sanity check: Max 500.0 allows for arrays up to ~500kWp (Large farms/commercial)
  if (yieldFactor < 0.05 || yieldFactor > 500.0) return result;

  // Spike protection using global max from the robust historic model
  if (globalMaxYF > 0 && yieldFactor > globalMaxYF * 1.25) {
    result.log = `Ignored outlier yield (Spike): Inst=${yieldFactor.toFixed(2)} > 1.25 * GlobalMax=${globalMaxYF.toFixed(2)}`;
    return result;
  }

  // Update EMA
  const slotIndex = (timestamp.getUTCHours() * 4) + Math.floor(timestamp.getUTCMinutes() / 15);
  const oldYield = result.yieldFactors[slotIndex] !== undefined ? result.yieldFactors[slotIndex] : 0;

  // Asymmetric learning:
  // Up: Moderate (0.2) to capture clear sky peaks without over-reacting to cloud-edge effects.
  // Down: Slow (0.05) to adapt to seasonal changes (shading) while resisting transient clouds.
  let alpha = 0;
  if (yieldFactor > oldYield) {
    alpha = 0.2;
  } else {
    alpha = 0.05;
  }

  // Reject sudden drops > 80% to ignore transient anomalies (e.g. severe dark clouds).
  // Structural shading is handled by the nightly batch process.
  if (oldYield > 0 && yieldFactor < oldYield) {
    const relativeDrop = (oldYield - yieldFactor) / oldYield;
    if (relativeDrop > 0.8) {
      result.log = `Ignored outlier yield (Drop ${(relativeDrop * 100).toFixed(0)}%): Model=${oldYield.toFixed(2)}, Inst=${yieldFactor.toFixed(2)} (P=${power}, R=${forecastRadiation.toFixed(0)})`;
      return result;
    }
  }

  let newYield;
  // If a slot is uninitialized, learn instantly. Otherwise, use EMA.
  if (oldYield === 0) {
    newYield = yieldFactor;
  } else {
    newYield = (alpha * yieldFactor) + ((1 - alpha) * oldYield);
  }

  result.yieldFactors[slotIndex] = newYield;
  result.updated = true;
  result.log = `Updated yield for slot ${slotIndex}: ${oldYield.toFixed(2)} -> ${newYield.toFixed(2)} (Inst=${yieldFactor.toFixed(2)}, P=${power}, R=${forecastRadiation.toFixed(0)})`;

  return result;
};

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

  // 1. isCloudy Detection (Rolling Window)
  // Check radiation in a +/- 2 hour window. If it drops below 300 W/m²,
  // there are clouds (or twilight) nearby. Protects against time-shifted forecasts.
  let minRadiationInWindow = forecastRadiation;
  for (let offset = -2; offset <= 2; offset++) {
    const t = timestamp.getTime() + (offset * 3600000);
    const rad = getInterpolatedRadiation(t, forecastData);
    if (rad < minRadiationInWindow) minRadiationInWindow = rad;
  }
  const isCloudy = minRadiationInWindow < 300;

  // 2. Detection Thresholds (Turning ON)
  const baseMinExpected = Math.max(250, systemPeak * 0.05);
  // Require higher expected power to trigger curtailment if clouds are nearby (avoids false drops)
  const triggerExpected = isCloudy ? baseMinExpected * 2 : baseMinExpected;

  const offThreshold = 20; // W - Power below this is considered 'off'

  const wasRunningThreshold = Math.max(50, systemPeak * 0.02); // W

  if (expectedPower > triggerExpected && currentPower < offThreshold && lastPower > wasRunningThreshold) {
    if (!isCurtailmentActive) {
      result.isActive = true;
      result.changed = true;
      result.log = `Curtailment detected: Expected ${Math.round(expectedPower)}W, Actual ${Math.round(currentPower)}W`;
    }
  } else if (isCurtailmentActive) {
    if (manualCurtailment) return result; // Manual override, never auto-recover

    // 3. Recovery Thresholds (Turning OFF)
    // Strict relative rule: 80% of current expected power
    const relativeRecovery = expectedPower * 0.8;
    // Absolute bypass: undeniably online if producing > 10% of peak (min 250W)
    const absoluteRecovery = Math.max(250, systemPeak * 0.10);
    // Use the lowest of the two. This guarantees recovery on wrong forecasts (absolute bypass),
    // while remaining sensitive enough for genuinely dark days (relative rule).
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

const processBucket = ({
  bucket,
  currentSlotIndex,
  currentTimestamp,
  currentPower,
  currentEnergy,
}) => {
  const result = {
    bucket: bucket ? { ...bucket } : {
      index: currentSlotIndex,
      startTime: currentTimestamp,
      startEnergy: currentEnergy,
      samples: [],
    },
    finishedBucket: null,
  };

  if (typeof currentPower === 'number') {
    result.bucket.samples.push(currentPower);
  }

  if (currentSlotIndex !== result.bucket.index) {
    let bucketAvgPower = 0;
    let valid = false;
    let log = null;

    const samplesAvg = result.bucket.samples.length > 0
      ? result.bucket.samples.reduce((a, b) => a + b, 0) / result.bucket.samples.length
      : 0;

    if (typeof currentEnergy === 'number' && typeof result.bucket.startEnergy === 'number') {
      const dEnergy = currentEnergy - result.bucket.startEnergy;
      const dTime = currentTimestamp - result.bucket.startTime;
      if (dTime > 10 * 60 * 1000 && dEnergy >= 0) {
        // If energy difference is 0 but samples show power, the meter has low resolution. Skip to fallback.
        if (!(dEnergy === 0 && samplesAvg > 10)) {
          bucketAvgPower = (dEnergy / (dTime / 3600000)) * 1000;
          valid = true;
          log = `Bucket ${result.bucket.index} finished. Avg (Energy): ${Math.round(bucketAvgPower)}W`;
        }
      }
    }

    if (!valid && result.bucket.samples.length > 0) {
      bucketAvgPower = samplesAvg;
      valid = true;
      log = `Bucket ${result.bucket.index} finished. Avg (Samples): ${Math.round(bucketAvgPower)}W`;
    }

    if (valid) {
      result.finishedBucket = {
        avgPower: bucketAvgPower,
        startTime: result.bucket.startTime,
        log,
      };
    }

    result.bucket = {
      index: currentSlotIndex,
      startTime: currentTimestamp,
      startEnergy: currentEnergy,
      samples: [],
    };
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
    // Only use energy-derived power if the real-time 'measure_power' is missing.
    // Calculating power from coarse energy steps (e.g., 0.05 kWh) over short 1-minute
    // intervals creates massive artificial math spikes (0.05 kWh / 1 min = 3000W).
    // The learning buckets already safely use energy over 15-minute windows.
    if ((typeof currentPower !== 'number' || Number.isNaN(currentPower)) && dTime > 50000 && dEnergy > 0) {
      const avgPower = (dEnergy / (dTime / 3600000)) * 1000; // kWh -> W
      smoothedPower = avgPower;
    }
  }
  return { smoothedPower, newEnergyState };
};

const processHistoricData = ({
  powerEntries, // Array of { t: string (ISO), y: number (Watt) } from Homey Insights
  weatherEntries, // Array of { time: number (ms), radiation: number (W/m2) } from OpenMeteo
  currentYieldFactors,
  resolution,
  maxYieldFactorLimit, // Optional: Hard limit from a previous robust pass (e.g. Step 1)
  peakPower = 0,
  logger = () => {},
}) => {
  // Create a map for fast weather lookup (rounded to hour)
  const weatherMap = new Map();
  const maxSlotRad = new Array(96).fill(0);

  // Below this, a slot's own historic max radiation is itself low (near sunrise/sunset),
  // so power/radiation ratios there carry much more relative noise than at higher radiation.
  // Used to relax statistics that assume noise is small relative to the signal.
  const MIN_RADIATION_FOR_ROBUST_STATS = 300; // W/m2

  // Calculate the Global Maximum Yield Factor from the input baseline (Step 1).
  // This defines the "Maximum Physical Capability" of the array.
  // Use the 90th percentile to ignore isolated math spikes from previous runs.
  let globalMaxYF = 0;
  if (currentYieldFactors) {
    const active = currentYieldFactors.filter((y) => y !== null && y > 0).sort((a, b) => a - b);
    if (active.length > 0) {
      const p90Index = Math.floor(active.length * 0.90);
      globalMaxYF = active[p90Index];
    }
  }

  logger(`[processHistoricData] Start. Res=${resolution}, Input Samples P=${powerEntries.length} W=${weatherEntries.length}, Limit=${maxYieldFactorLimit}, BaseGlobalMax=${globalMaxYF.toFixed(3)}`);

  // 1. Build a map of the maximum radiation seen per hour (0-23) over the history
  const maxHourlyRad = new Array(24).fill(0);
  weatherEntries.forEach((w) => {
    const date = new Date(w.time);
    date.setUTCMinutes(0, 0, 0);
    weatherMap.set(date.getTime(), w.radiation);

    const hour = date.getUTCHours();
    if (w.radiation > maxHourlyRad[hour]) {
      maxHourlyRad[hour] = w.radiation;
    }
  });

  // Interpolate hourly maxes to a smooth 96-slot envelope to prevent false rejections.
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4);
    const frac = (i % 4) / 4.0; // 0, 0.25, 0.5, 0.75
    const val1 = maxHourlyRad[hour];
    const val2 = maxHourlyRad[(hour + 1) % 24]; // Wrap around
    maxSlotRad[i] = val1 + (val2 - val1) * frac;
  }

  // Pre-calculate yield factors and detect clipping
  const entriesWithYield = powerEntries.map((entry) => {
    let power = entry.y !== undefined ? entry.y : entry.v;
    if (typeof power !== 'number' || power < 0 || power > 100000) return null;

    if (peakPower > 0) {
      if (power > peakPower * 1.1) return null; // Reject physical impossibilities
      if (power > peakPower) power = peakPower;
    }

    const timestamp = new Date(entry.t);
    const radiation = getInterpolatedRadiation(timestamp.getTime(), weatherMap);

    // Need some radiation to calculate yield
    if (radiation < 10) return null;

    // Noise Floor Filter:
    // If radiation is very low (<50) and power is <10W, it's just dawn/dusk sensor noise, skip it.
    // Note: If power is <10W but we expect daylight (radiation >= 50 W/m2), we DO NOT skip it.
    // This allows the algorithm to learn severe structural shading where yield drops to near 0.
    if (power < 10 && radiation < 50) return null;

    const yieldFactor = power / radiation;
    return {
      power, radiation, yieldFactor, timestamp,
    };
  });

  const isClipped = new Array(entriesWithYield.length).fill(false);

  // Detect Clipping: Stable Power + Changing Yield = Clipping
  for (let i = 1; i < entriesWithYield.length - 1; i += 1) {
    const prev = entriesWithYield[i - 1];
    const curr = entriesWithYield[i];
    const next = entriesWithYield[i + 1];

    if (!prev || !curr || !next) continue;

    // Check for flat power (within 1% or 10W)
    const pMin = Math.min(prev.power, curr.power, next.power);
    const pMax = Math.max(prev.power, curr.power, next.power);
    const pAvg = (prev.power + curr.power + next.power) / 3;

    if ((pMax - pMin) < Math.max(10, pAvg * 0.01)) {
      // Power is flat. Check if YieldFactor is changing (indicating radiation change without power change)
      const yMin = Math.min(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yMax = Math.max(prev.yieldFactor, curr.yieldFactor, next.yieldFactor);
      const yAvg = (prev.yieldFactor + curr.yieldFactor + next.yieldFactor) / 3;

      // If YieldFactor varies by more than 3%, assume clipping
      // (A perfect sunny peak has stable Power AND stable Yield)
      if ((yMax - yMin) > (yAvg * 0.03)) {
        isClipped[i] = true;
      }
    }
  }

  logger(`[processHistoricData] Clipping detection: found ${isClipped.filter(Boolean).length} clipped samples.`);

  // Establish a robust "Physical Limit" from the top 25% highest-power samples' median
  // yield, ignoring extreme outliers like cloud lensing.
  let datasetMaxYF = 0;
  const validEntries = [];
  for (let i = 0; i < entriesWithYield.length; i += 1) {
    const entry = entriesWithYield[i];
    if (entry && !isClipped[i] && entry.yieldFactor > 0.05 && entry.yieldFactor < 500) {
      // Apply Strict Clear Sky Filter to the baseline dataset too
      const slotIndex = (entry.timestamp.getUTCHours() * 4) + Math.floor(entry.timestamp.getUTCMinutes() / 15);
      const maxPossible = maxSlotRad[slotIndex] || 0;

      // Use only high confidence samples (> 100 W/m2 AND > 50% of max)
      // to accurately determine the array's peak efficiency.
      if (entry.radiation > 100 && entry.radiation > (maxPossible * 0.5)) {
        validEntries.push(entry);
      }
    }
  }
  logger(`[processHistoricData] High confidence clear-sky samples for global limit: ${validEntries.length}`);
  if (validEntries.length > 0) {
    // 1. Sort by POWER Descending (Ground Truth)
    // We trust the power meter to tell us when the sun was shining.
    validEntries.sort((a, b) => b.power - a.power);

    // 2. Take top 25% of highest power samples
    // Broad enough to catch the True Baseline days alongside any Cloud Lensing days.
    const topPowerCount = Math.ceil(validEntries.length * 0.25);
    const bestPerformingSamples = validEntries.slice(0, topPowerCount);

    // 3. Extract yields
    const yields = bestPerformingSamples.map((e) => e.yieldFactor);
    yields.sort((a, b) => a - b); // Ascending Sort

    // 4. Take Median (Robust against both over and under predictions)
    // We want the typical YF from the high-power group, ignoring both lensing spikes and forecast overpredictions.
    const medianIndex = Math.floor(yields.length * 0.50);
    datasetMaxYF = yields[medianIndex];

    logger(`[processHistoricData] Global Limit Calc: Top 25% Count=${topPowerCount}, Median Index=${medianIndex}, Selected datasetMaxYF=${datasetMaxYF.toFixed(3)}`);
    if (yields.length > 0) {
      logger(`[processHistoricData] Global Limit top 5 max yields: ${yields.slice(-5).map((y) => y.toFixed(3)).join(', ')}`);
      logger(`[processHistoricData] Global Limit bottom 5 min yields: ${yields.slice(0, 5).map((y) => y.toFixed(3)).join(', ')}`);
    }
  }

  // If a robust limit is provided (e.g. from 14-day history), cap the dataset statistic.
  // This prevents short-term datasets (Step 2) from hallucinating high limits due to bad forecasts.
  if (maxYieldFactorLimit && maxYieldFactorLimit > 0) {
    if (datasetMaxYF === 0 || datasetMaxYF > maxYieldFactorLimit) {
      logger(`[processHistoricData] datasetMaxYF capped by external limit: ${datasetMaxYF.toFixed(3)} -> ${maxYieldFactorLimit.toFixed(3)}`);
      datasetMaxYF = maxYieldFactorLimit;
    }
  }

  const slotSamples = new Array(96).fill(0).map(() => []);

  // Pushes one power/radiation sample into slot `idx`, applying the same
  // clear-sky confidence gate used everywhere else in this function (radiation
  // must clear an absolute floor and a fraction of that slot's own historic max).
  const pushSlotSample = (idx, power, radiation) => {
    if (idx < 0 || idx >= 96) return;
    if (!(radiation > 10)) return;
    const maxPossible = maxSlotRad[idx] || 0;
    // Dynamic Threshold based on max radiation (Sun Elevation).
    // Use 20% to capture "Historic Clear Sky" days that have lower absolute radiation than "Today".
    let threshold = 0.20;
    if (maxPossible < 50) threshold = 0.05; // Sunrise/Sunset
    if (!(radiation > (maxPossible * threshold))) return;
    const yieldFactor = power / radiation;
    if (yieldFactor >= 0 && yieldFactor < 500.0) {
      slotSamples[idx].push({ yieldFactor, power, radiation });
    }
  };

  for (let i = 0; i < entriesWithYield.length; i += 1) {
    const item = entriesWithYield[i];
    if (!item) continue;
    if (isClipped[i]) continue;

    const slotIndex = (item.timestamp.getUTCHours() * 4) + Math.floor(item.timestamp.getUTCMinutes() / 15);

    if (resolution !== 'hourly') {
      pushSlotSample(slotIndex, item.power, item.radiation);
      continue;
    }

    // Homey's 'last7Days'/'last14Days' hourly entries for this log are the
    // AVERAGE power over the hour STARTING at the entry's timestamp - confirmed
    // against a real device by matching a 14-day hourly export against its
    // overlapping 24h 5-minute export: the hourly value equals the exact mean of
    // that hour's twelve 5-minute samples, to 5 decimal places. So each entry
    // best represents its hour's MIDPOINT, not its start or a snapshot. Copying
    // it flat across all 4 quarter-hour slots both flattens fast ramps
    // (sunrise/sunset) into steps and mis-centers them by half an hour.
    // Model the curve as piecewise-linear through consecutive hour-midpoints
    // (prev, this, next) and read the 4 quarter-hour slots off that: slot 0
    // (hour start) and slot 1 sit between prev's and this hour's midpoint,
    // slot 2 (half past) IS this hour's own midpoint value, slot 3 sits between
    // this hour's and next's midpoint. Falls back to the flat value on either
    // side when that neighbor is missing, gapped, or clipped.
    const prev = entriesWithYield[i - 1];
    const next = entriesWithYield[i + 1];
    const prevOk = !!prev && !isClipped[i - 1]
      && (item.timestamp.getTime() - prev.timestamp.getTime()) === 3600000;
    const nextOk = !!next && !isClipped[i + 1]
      && (next.timestamp.getTime() - item.timestamp.getTime()) === 3600000;

    const subPowers = [
      prevOk ? (prev.power + item.power) / 2 : item.power, // :00
      prevOk ? (prev.power * 0.25) + (item.power * 0.75) : item.power, // :15
      item.power, // :30 - the hour's own midpoint
      nextOk ? (item.power * 0.75) + (next.power * 0.25) : item.power, // :45
    ];

    for (let k = 0; k < 4; k += 1) {
      const subTime = item.timestamp.getTime() + k * 900000;
      const subRadiation = getInterpolatedRadiation(subTime, weatherMap);
      pushSlotSample(slotIndex + k, subPowers[k], subRadiation);
    }
  }

  // Calculate robust bests from samples
  const slotBests = currentYieldFactors ? [...currentYieldFactors] : new Array(96).fill(null);

  slotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    let bestYields;
    if ((maxSlotRad[idx] || 0) < MIN_RADIATION_FOR_ROBUST_STATS) {
      // Ramp region: radiation (the ratio's denominator) is small, so power/radiation
      // noise (timing mismatch, meter spikes, lensing) is large in relative terms.
      // Ranking by power and keeping only the top 25% amplifies that noise instead of
      // filtering it out (a "winner's curse" on a noisy proxy), unlike at higher radiation
      // where day-to-day spread on a clear day is small relative to the mean. Samples here
      // are already filtered to exclude genuinely cloudy/shaded readings (see the
      // maxPossible * threshold gate above), so just take the median of all of them.
      bestYields = samples.map((s) => s.yieldFactor).sort((a, b) => a - b);
    } else {
      // 1. Sort by POWER Descending (Ground Truth)
      samples.sort((a, b) => b.power - a.power);

      // 2. Keep top 25% of samples
      // Ensures we have a pool of "Sunny" days (True + Lensing).
      const keepCount = Math.max(1, Math.ceil(samples.length * 0.25));
      bestYields = samples.slice(0, keepCount).map((s) => s.yieldFactor);

      // 3. Sort by Yield Factor Ascending
      bestYields.sort((a, b) => a - b);
    }

    // 4. Use median for a stable center, robust against forecast errors.
    const mid = Math.floor(bestYields.length / 2);
    const best = bestYields[mid];

    const bestSample = samples.find((s) => s.yieldFactor === best) || { power: 0, radiation: 0 };

    // Safety Cap: Prevent hallucinating high yields during forecast underestimations.
    // Enforces limits based on Step 1, slot baseline, or Global Array Max.
    let limit = 500.0;
    if (maxYieldFactorLimit > 0) limit = maxYieldFactorLimit * 1.01;
    else if (slotBests[idx] !== null && slotBests[idx] > 0) limit = slotBests[idx] * 1.1;
    else if (globalMaxYF > 0) limit = globalMaxYF * 1.25;
    else if (datasetMaxYF > 0) limit = datasetMaxYF * 1.25;

    if (slotBests[idx] === null) {
      slotBests[idx] = best <= limit ? best : limit;
      logger(`[processHistoricData] Slot ${idx} INIT: -> ${slotBests[idx].toFixed(3)}`);
    } else if (best > slotBests[idx]) {
      if (best <= limit) {
        logger(`[processHistoricData] Slot ${idx} UPDATED UP: ${slotBests[idx].toFixed(3)} -> ${best.toFixed(3)} (Limit was ${limit.toFixed(3)})`);
        slotBests[idx] = best;
      } else {
        logger(`[processHistoricData] Slot ${idx} CAPPED: Best (${best.toFixed(3)}) > Limit (${limit.toFixed(3)}). Setting to Limit.`);
        slotBests[idx] = limit;
      }
    } else if (best < slotBests[idx]) {
      // Downward Adjustment: Carve out shade.
      // Skip if radiation in a 2-hour rolling block is < 50% of recent 14-day max
      // to prevent cloudy days or time-shifted forecasts from ruining the curve.
      // Near sunrise/sunset a slot's own historic max is itself low, so day-to-day
      // radiation naturally swings well below 50% of it without any cloud being
      // involved. Only trust the relative comparison once the slot's max is high
      // enough (well past the low-sun ramp) for it to be meaningful; otherwise
      // ramp-period slots would get flagged "cloudy" almost every day and an
      // inflated morning/evening yield factor could never correct back down.
      let isCloudy = false;
      const windowStart = Math.max(0, idx - 4);
      const windowEnd = Math.min(95, idx + 4);
      for (let w = windowStart; w <= windowEnd; w += 1) {
        const wMaxPossible = maxSlotRad[w] || 0;
        if (wMaxPossible < MIN_RADIATION_FOR_ROBUST_STATS) continue;
        const wSamples = slotSamples[w];
        if (wSamples && wSamples.length > 0) {
          if (wSamples.some((s) => s.radiation > 10 && s.radiation < (wMaxPossible * 0.5))) {
            isCloudy = true;
            break;
          }
        }
      }

      if (resolution === 'high' && isCloudy) {
        logger(`[processHistoricData] Slot ${idx} SKIP DOWN: Cloudy day in 2h time block ignored. YF would have become ${best.toFixed(3)}.`);
      } else {
        // Blend down by 20% to remain resilient against anomalous dark days.
        const blendFactor = 0.2;
        const newBest = (best * blendFactor) + (slotBests[idx] * (1 - blendFactor));
        logger(
          `[processHistoricData] Slot ${idx} ADJUST DOWN: ${slotBests[idx].toFixed(3)} -> ${newBest.toFixed(3)} | `
          + `Lowered by YF=${best.toFixed(3)} (P=${bestSample.power.toFixed(0)}W, R=${bestSample.radiation.toFixed(0)}W/m²) | `
          + `Total samples: ${samples.length}`,
        );
        slotBests[idx] = newBest;
      }
    }
  });

  const newYieldFactors = [...slotBests];
  const updatedSlots = newYieldFactors.filter((y) => y > 0).length;

  // Smooth the curve to remove measurement noise and quantization steps.
  // Yield Factor distribution should be relatively smooth due to fixed array geometry.
  for (let pass = 0; pass < 3; pass += 1) {
    const smoothed = [...newYieldFactors];
    for (let i = 1; i < 95; i += 1) {
      const prev = newYieldFactors[i - 1] !== null ? newYieldFactors[i - 1] : newYieldFactors[i];
      const curr = newYieldFactors[i] !== null ? newYieldFactors[i] : 0;
      const next = newYieldFactors[i + 1] !== null ? newYieldFactors[i + 1] : newYieldFactors[i];
      if (newYieldFactors[i] !== null) {
        smoothed[i] = (prev * 0.25) + (curr * 0.5) + (next * 0.25);
      }
    }
    // Handle edges
    if (newYieldFactors[0] !== null) {
      const next = newYieldFactors[1] !== null ? newYieldFactors[1] : newYieldFactors[0];
      smoothed[0] = (newYieldFactors[0] * 0.75) + (next * 0.25);
    }
    if (newYieldFactors[95] !== null) {
      const prev = newYieldFactors[94] !== null ? newYieldFactors[94] : newYieldFactors[95];
      smoothed[95] = (newYieldFactors[95] * 0.75) + (prev * 0.25);
    }
    for (let i = 0; i < 96; i += 1) newYieldFactors[i] = smoothed[i];
  }

  let rejectReason = '';
  if (updatedSlots === 0) {
    const validYieldCount = entriesWithYield.filter((e) => e !== null).length;
    let maxPowerSeen = 0;
    powerEntries.forEach((e) => {
      const p = e.y !== undefined ? e.y : e.v;
      if (typeof p === 'number' && p > maxPowerSeen) maxPowerSeen = p;
    });
    const sampleKeysCount = slotSamples.filter((s) => s.length > 0).length;
    rejectReason = `No updates derived from data. (Input: ${powerEntries.length} entries, `
      + `Max Power Seen: ${maxPowerSeen.toFixed(1)}W, Valid Sun/Power matches: ${validYieldCount}, `
      + `Slots with samples: ${sampleKeysCount})`;
  } else {
    rejectReason = `Retrained model from best-of-day samples (Power-based). Found ideal yield for ${updatedSlots} slots. (Limit: ${datasetMaxYF.toFixed(2)})`;
  }

  return {
    yieldFactors: newYieldFactors,
    slotAccumulators: null, // No longer used
    updated: updatedSlots > 0,
    limit: datasetMaxYF, // Return the calculated physical limit
    log: rejectReason,
  };
};

const calculateForecast = ({
  forecastData,
  yieldFactors,
  timestamp = new Date(),
  timezone = 'UTC',
}) => {
  const t = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const now = new Date(t);

  // yieldFactors[] is trained and indexed by genuine UTC hour (see solar/device.js
  // updateLearning()), so it must always be read back with getUTCHours()/getUTCMinutes()
  // on a real UTC timestamp — never on a local-time-relabeled-as-UTC ("fake-local") value.
  const forecastRadiation = getInterpolatedRadiation(t, forecastData);
  const slotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = Math.round(forecastRadiation * yieldFactor);

  // Day Total Yield: iterate the local day using real UTC boundaries (DST-safe), matching
  // how forecastData (real UTC keys) and yieldFactors (real UTC hour) are actually indexed.
  let totalYield = 0;

  const dayStart = TimeHelpers.getLocalMidnightUTC(now, timezone);
  const dayEnd = TimeHelpers.getLocalMidnightUTC(new Date(dayStart.getTime() + 26 * 60 * 60 * 1000), timezone);

  for (let slotMs = dayStart.getTime(); slotMs < dayEnd.getTime(); slotMs += 15 * 60 * 1000) {
    const daySlotIndex = (new Date(slotMs).getUTCHours() * 4) + Math.floor(new Date(slotMs).getUTCMinutes() / 15);
    const rad = getInterpolatedRadiation(slotMs, forecastData);
    const yf = yieldFactors[daySlotIndex] !== undefined ? yieldFactors[daySlotIndex] : 0;
    const power = rad * yf;
    totalYield += (power * 0.25) / 1000;
  }

  return {
    expectedPower,
    totalYield: Number(totalYield.toFixed(2)),
  };
};

const getSunBounds = (dateObj, forecastData, timezone = 'UTC') => {
  // DST-safe real UTC midnight via TimeHelpers (two-pass correction)
  // forecastData keys are real UTC timestamps, so we need real UTC midnight here.
  const startOfDay = TimeHelpers.getLocalMidnightUTC(dateObj, timezone);
  const nextDayObj = new Date(startOfDay.getTime() + 26 * 60 * 60 * 1000); // +26h always lands in next local day
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

const mergeYields = ({
  historicYields, liveYields, alpha = 0.7, limit = 0,
}) => {
  const merged = [];
  let updatedSlots = 0;
  for (let i = 0; i < 96; i += 1) {
    const historic = historicYields[i];
    const live = liveYields[i] || 0;
    let newYield;

    if (historic !== null && historic !== undefined && live > 0) {
      // Both have data, merge them.
      newYield = (historic * alpha) + (live * (1 - alpha));
    } else if (historic !== null && historic !== undefined) {
      // Only historic has data, use it.
      newYield = historic;
    } else {
      // No historic data. Keep the live value.
      newYield = live;
    }

    // Hard Cap: Enforce the Physical Limit.
    // This safely limits upwards drift and prevents an old, bloated live model
    // from pulling the newly merged model above physical reality.
    if (limit > 0 && newYield > limit * 1.01) {
      newYield = limit * 1.01;
    }

    if (Math.abs(newYield - live) > 0.001) {
      updatedSlots += 1;
    }
    merged[i] = newYield !== null ? newYield : 0;
  }
  return {
    yieldFactors: merged,
    log: `Merged historic and live models. Alpha=${alpha}. ${updatedSlots} slots updated.`,
  };
};

module.exports = {
  getStrategy, detectCurtailment, processBucket, calculateSmoothedPower, processHistoricData, getInterpolatedRadiation, calculateForecast, getSunBounds, mergeYields,
};
