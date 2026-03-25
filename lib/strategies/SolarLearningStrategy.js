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

  // Ensure positive power (PV generation)
  const power = Math.max(0, currentPower);

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

  // Outlier Rejection for Live Data:
  // We reject sudden drops greater than 80% compared to the learned model.
  // This allows structural shading (e.g. morning trees) to be learned live,
  // while still rejecting near-total drops caused by extreme transient anomalies (e.g. severe dark clouds/dirt).
  // Legitimate total drops will be learned safely by the nightly batch process.
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

  // Detect drop to near zero while expecting significant power
  // Use generic thresholds based on expected power to support any array size
  const minExpected = 100; // W - Minimum expected power to check for curtailment
  const offThreshold = 20; // W - Power below this is considered 'off'
  const wasRunningThreshold = Math.min(100, expectedPower * 0.1); // W - Threshold to detect if it was running/starting
  const recoveryThreshold = Math.max(50, expectedPower * 0.4); // W - Threshold to consider curtailment ended

  if (expectedPower > minExpected && currentPower < offThreshold && lastPower > wasRunningThreshold) {
    if (!isCurtailmentActive) {
      result.isActive = true;
      result.changed = true;
      result.log = `Curtailment detected: Expected ${Math.round(expectedPower)}W, Actual ${Math.round(currentPower)}W`;
    }
  } else if (isCurtailmentActive) {
    // Reset if power returns to significant levels or if expected power drops (end of day)
    if (expectedPower < minExpected) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Low expected power (${Math.round(expectedPower)}W)`;
    } else if (currentPower > recoveryThreshold) {
      result.isActive = false;
      result.changed = true;
      result.log = `Curtailment ended: Power restored to ${Math.round(currentPower)}W (${Math.round((currentPower / expectedPower) * 100)}%)`;
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

  // Add sample
  if (typeof currentPower === 'number') {
    result.bucket.samples.push(currentPower);
  }

  // Check if bucket is finished
  if (currentSlotIndex !== result.bucket.index) {
    let bucketAvgPower = 0;
    let valid = false;
    let log = null;

    const samplesAvg = result.bucket.samples.length > 0
      ? result.bucket.samples.reduce((a, b) => a + b, 0) / result.bucket.samples.length
      : 0;

    // Calculate average based on energy diff if available
    if (typeof currentEnergy === 'number' && typeof result.bucket.startEnergy === 'number') {
      const dEnergy = currentEnergy - result.bucket.startEnergy;
      const dTime = currentTimestamp - result.bucket.startTime;
      // Ensure bucket duration is significant (e.g. > 10 mins)
      if (dTime > 10 * 60 * 1000 && dEnergy >= 0) {
        // If energy difference is 0 but samples show power, the meter has low resolution. Skip to fallback.
        if (!(dEnergy === 0 && samplesAvg > 10)) {
          bucketAvgPower = (dEnergy / (dTime / 3600000)) * 1000;
          valid = true;
          log = `Bucket ${result.bucket.index} finished. Avg (Energy): ${Math.round(bucketAvgPower)}W`;
        }
      }
    }

    // Fallback to samples average
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

    // Start new bucket
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
  logger = () => {},
}) => {
  // Create a map for fast weather lookup (rounded to hour)
  const weatherMap = new Map();
  const maxSlotRad = new Array(96).fill(0);

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

  // Interpolate hourly maxes to get smooth maxSlotRad (96 slots) envelope.
  // This prevents false rejections on the falling edge (afternoon) where real radiation
  // drops below the hourly "step" of a staircase envelope.
  for (let i = 0; i < 96; i++) {
    const hour = Math.floor(i / 4);
    const frac = (i % 4) / 4.0; // 0, 0.25, 0.5, 0.75
    const val1 = maxHourlyRad[hour];
    const val2 = maxHourlyRad[(hour + 1) % 24]; // Wrap around
    maxSlotRad[i] = val1 + (val2 - val1) * frac;
  }

  // Pre-calculate yield factors and detect clipping
  const entriesWithYield = powerEntries.map((entry) => {
    const power = entry.y !== undefined ? entry.y : entry.v;
    if (typeof power !== 'number' || power < 0 || power > 100000) return null;

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

  // Self-Calibration: Calculate the 90th percentile of yields from the input dataset.
  // This provides a robust "Physical Limit" baseline for Step 1, filtering out the top 10% of
  // extreme outliers (Cloud Lensing spikes) without needing hardcoded limits.
  let datasetMaxYF = 0;
  const validEntries = [];
  for (let i = 0; i < entriesWithYield.length; i += 1) {
    const entry = entriesWithYield[i];
    if (entry && !isClipped[i] && entry.yieldFactor > 0.05 && entry.yieldFactor < 500) {
      // Apply Strict Clear Sky Filter to the baseline dataset too
      const slotIndex = (entry.timestamp.getUTCHours() * 4) + Math.floor(entry.timestamp.getUTCMinutes() / 15);
      const maxPossible = maxSlotRad[slotIndex] || 0;

      // FOR GLOBAL LIMIT CALCULATION:
      // We only want High Confidence samples (High Sun).
      // We filter strictly here (> 100 W/m2 AND > 50% of max) to ensure the Global Limit (datasetMaxYF)
      // represents the array's peak efficiency (Noon) and isn't diluted by morning/evening physics.
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

  for (let i = 0; i < entriesWithYield.length; i += 1) {
    const item = entriesWithYield[i];
    if (!item) continue;
    if (isClipped[i]) continue;

    const slotIndex = (item.timestamp.getUTCHours() * 4) + Math.floor(item.timestamp.getUTCMinutes() / 15);
    const maxPossible = maxSlotRad[slotIndex] || 0;

    // Dynamic Threshold based on max radiation (Sun Elevation).
    // Use 20% to capture "Historic Clear Sky" days that have lower absolute radiation than "Today".
    let threshold = 0.20;
    if (maxPossible < 50) threshold = 0.05; // Sunrise/Sunset

    // 1. Radiation must be > 10 (absolute floor to avoid low-light sensor noise)
    // 2. Radiation must be > threshold of the historic max for this slot.
    if (item.radiation > 10 && item.radiation > (maxPossible * threshold)) {
      const { yieldFactor } = item;

      // Include valid yields (including near-zero for shading)
      if (yieldFactor >= 0 && yieldFactor < 500.0) {
        // If hourly resolution, fill the whole hour (4 slots)
        const slotsToFill = resolution === 'hourly' ? 4 : 1;
        for (let k = 0; k < slotsToFill; k += 1) {
          const idx = slotIndex + k;
          if (idx < 96) {
            slotSamples[idx].push({ yieldFactor, power: item.power, radiation: item.radiation });
          }
        }
      }
    }
  }

  // Calculate robust bests from samples
  const slotBests = currentYieldFactors ? [...currentYieldFactors] : new Array(96).fill(null);

  slotSamples.forEach((samples, idx) => {
    if (samples.length === 0) return;

    // 1. Sort by POWER Descending (Ground Truth)
    samples.sort((a, b) => b.power - a.power);

    // 2. Keep top 25% of samples
    // Ensures we have a pool of "Sunny" days (True + Lensing).
    const keepCount = Math.max(1, Math.ceil(samples.length * 0.25));
    const bestYields = samples.slice(0, keepCount).map((s) => s.yieldFactor);

    // 3. Sort by Yield Factor Ascending
    bestYields.sort((a, b) => a - b);

    // 4. Robust Statistic
    // Use Median to find the stable center. This is robust against both forecast underestimations (lensing spikes)
    // and forecast overestimations (which would pull the yield artificially low).
    const mid = Math.floor(bestYields.length / 2);
    const best = bestYields[mid];

    // Safety Cap Logic - To prevent hallucinating high yields during forecast underestimations:
    // 1. If we have a robust external limit (Step 1), strictly enforce it (+1% temp margin).
    // 2. If we have a slot baseline, do not allow growth > 10% per iteration (seasonality).
    // 3. If no baseline, do not exceed the Global Array Max by > 25%.
    // 4. Fallback: use the dataset's own Median max + 25%.
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
      // Downward Adjustment (Shading & Seasonality):
      // We allow the model to learn downwards to carve out shade (especially in high-res Step 2)
      // and to adapt to seasonal changes (e.g. leaves growing on trees).
      // We blend it down by 50% rather than instantly replacing it, to remain resilient
      // against an anomalous dark day where forecast expected full sun but reality was dark.
      const newBest = (best * 0.5) + (slotBests[idx] * 0.5);
      logger(`[processHistoricData] Slot ${idx} ADJUST DOWN: ${slotBests[idx].toFixed(3)} -> ${newBest.toFixed(3)}`);
      slotBests[idx] = newBest;
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

  // Instantaneous Power
  const forecastRadiation = getInterpolatedRadiation(t, forecastData);
  const slotIndex = (now.getUTCHours() * 4) + Math.floor(now.getUTCMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 0;
  const expectedPower = Math.round(forecastRadiation * yieldFactor);

  // Day Total Yield
  let totalYield = 0;

  // Helper to get UTC timestamp of Local Midnight
  const getLocalMidnightUTC = (d) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
    const offset = local.getTime() - d.getTime();
    const midnightLocal = new Date(local);
    midnightLocal.setHours(0, 0, 0, 0);
    return midnightLocal.getTime() - offset;
  };

  const startOfDayTime = getLocalMidnightUTC(now);
  const nextDay = new Date(now);
  nextDay.setDate(nextDay.getDate() + 1);
  const endOfDayTime = getLocalMidnightUTC(nextDay);

  for (let slotTime = startOfDayTime; slotTime < endOfDayTime; slotTime += 15 * 60 * 1000) {
    const slotDate = new Date(slotTime);
    const currentSlotIndex = (slotDate.getUTCHours() * 4) + Math.floor(slotDate.getUTCMinutes() / 15);
    const rad = getInterpolatedRadiation(slotTime, forecastData);
    const yf = yieldFactors[currentSlotIndex] !== undefined ? yieldFactors[currentSlotIndex] : 0;
    const power = rad * yf;
    totalYield += (power * 0.25) / 1000;
  }

  return {
    expectedPower,
    totalYield: Number(totalYield.toFixed(2)),
  };
};

const getSunBounds = (dateObj, forecastData, timezone = 'UTC') => {
  // Helper to get UTC timestamp of Local Midnight
  const getLocalMidnightUTC = (d) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
    const offset = local.getTime() - d.getTime();
    const midnightLocal = new Date(local);
    midnightLocal.setHours(0, 0, 0, 0);
    return new Date(midnightLocal.getTime() - offset);
  };

  const startOfDay = getLocalMidnightUTC(dateObj);
  const nextDay = new Date(dateObj);
  nextDay.setDate(nextDay.getDate() + 1);
  const endOfDay = getLocalMidnightUTC(nextDay);

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
