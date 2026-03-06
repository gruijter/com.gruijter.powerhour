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
}) => {
  const result = {
    yieldFactors: [...yieldFactors],
    updated: false,
    log: null,
  };

  // Use interpolated radiation for the center of the bucket (approx +7.5 mins if timestamp is start)
  const forecastRadiation = getInterpolatedRadiation(timestamp.getTime() + 450000, forecastData);

  if (forecastRadiation === undefined || forecastRadiation < 50) {
    // Ignore low radiation or missing data
    return result;
  }

  // Ensure positive power (PV generation)
  const power = Math.max(0, currentPower);

  const yieldFactor = power / forecastRadiation;

  if (!Number.isFinite(yieldFactor)) return result;
  // Sanity check: Max 500.0 allows for arrays up to ~500kWp (Large farms/commercial)
  if (yieldFactor < 0.05 || yieldFactor > 500.0) return result;

  // Update EMA
  const slotIndex = (timestamp.getUTCHours() * 4) + Math.floor(timestamp.getUTCMinutes() / 15);
  const oldYield = result.yieldFactors[slotIndex] !== undefined ? result.yieldFactors[slotIndex] : 0;

  // Dynamic learning rate: higher radiation = higher confidence/relevance.
  // Asymmetric learning: Learn fast from peaks (sunny), slow from troughs (clouds).
  let alpha = Math.min(0.2, Math.max(0.05, 0.1 * (forecastRadiation / 1000)));

  if (yieldFactor > oldYield) {
    // Better than model
    // Threshold 300: Prevents "bright cloudy" days (diffuse light, no shadows) from erasing learned shadow dips.
    if (forecastRadiation > 300) {
      alpha = 0.5; // Fast learn up (Trust the sun)
    } else {
      alpha = 0.1;
    }
  } else {
    // Worse than model (Clouds, Shadow, Curtailment)
    alpha = 0.05; // Slow learn down
  }

  const newYield = (alpha * yieldFactor) + ((1 - alpha) * oldYield);

  result.yieldFactors[slotIndex] = newYield;
  result.updated = true;
  result.log = `Updated yield factor for slot ${slotIndex}: ${oldYield.toFixed(2)} -> ${newYield.toFixed(2)} (Inst=${yieldFactor.toFixed(2)}, P=${power}, R=${forecastRadiation})`;

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

    // Calculate average based on energy diff if available
    if (typeof currentEnergy === 'number' && typeof result.bucket.startEnergy === 'number') {
      const dEnergy = currentEnergy - result.bucket.startEnergy;
      const dTime = currentTimestamp - result.bucket.startTime;
      // Ensure bucket duration is significant (e.g. > 10 mins)
      if (dTime > 10 * 60 * 1000 && dEnergy >= 0) {
        bucketAvgPower = (dEnergy / (dTime / 3600000)) * 1000;
        valid = true;
        log = `Bucket ${result.bucket.index} finished. Avg (Energy): ${Math.round(bucketAvgPower)}W`;
      }
    }

    // Fallback to samples average
    if (!valid && result.bucket.samples.length > 0) {
      const sum = result.bucket.samples.reduce((a, b) => a + b, 0);
      bucketAvgPower = sum / result.bucket.samples.length;
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
    // Only use average if time diff is significant (> 1 min) and energy valid
    if (dTime > 50000 && dEnergy > 0) {
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
  resolution = 'hourly', // Ignored in sequential logic
  previousAccumulators = null, // Ignored in sequential logic
}) => {
  // 1. Sort power entries by time to ensure sequential learning (crucial for EMA)
  powerEntries.sort((a, b) => new Date(a.t) - new Date(b.t));

  const newYieldFactors = [...currentYieldFactors];

  // Create a map for fast weather lookup (rounded to hour)
  const weatherMap = new Map();
  weatherEntries.forEach((w) => {
    const date = new Date(w.time);
    date.setUTCMinutes(0, 0, 0);
    weatherMap.set(date.getTime(), w.radiation);
  });

  const uniqueUpdatedSlots = new Set();
  let boostedSlots = 0;
  let skippedSlots = 0;

  for (const entry of powerEntries) {
    const power = entry.y !== undefined ? entry.y : entry.v;
    // Skip invalid, low power (noise/night), or extremely high power (glitch > 100kW)
    if (typeof power !== 'number' || power < 10 || power > 100000) continue;

    const timestamp = new Date(entry.t);
    // Align timestamp to center of 15m slot (like in getStrategy) to match average power with average radiation
    const radiation = getInterpolatedRadiation(timestamp.getTime() + 450000, weatherMap);

    // Only train if we have significant radiation
    if (radiation && radiation > 50) {
      const yieldFactor = power / radiation;

      // Sanity check for yield factor
      if (yieldFactor > 0.05 && yieldFactor < 500.0) {
        const entrySlot = (timestamp.getUTCHours() * 4) + Math.floor(timestamp.getUTCMinutes() / 15);
        const oldYield = newYieldFactors[entrySlot];

        // Dynamic learning rate (Sequential EMA)
        let alpha = Math.min(0.2, Math.max(0.05, 0.1 * (radiation / 1000)));

        if (yieldFactor > oldYield) {
          // Better than model
          if (radiation > 300) {
            alpha = 0.5; // Fast learn up (Trust the sun)
            boostedSlots++;
          } else {
            alpha = 0.1;
          }
        } else {
          // Worse than model (Clouds, Shadow, Curtailment)
          alpha = 0.05; // Slow learn down
        }

        // Apply EMA
        // If oldYield is 0 (uninitialized), take the new value directly
        if (oldYield === 0) {
          newYieldFactors[entrySlot] = yieldFactor;
        } else {
          newYieldFactors[entrySlot] = (alpha * yieldFactor) + ((1 - alpha) * oldYield);
        }
        uniqueUpdatedSlots.add(entrySlot);
      } else {
        skippedSlots++;
      }
    }
  }

  // Smooth the curve to remove steps from hourly data (2 passes of 3-point moving average)
  // Reduced to 2 to preserve sharp features like shadow dips.
  for (let pass = 0; pass < 2; pass += 1) {
    const smoothed = [...newYieldFactors];
    for (let i = 1; i < 95; i += 1) {
      smoothed[i] = (newYieldFactors[i - 1] + newYieldFactors[i] + newYieldFactors[i + 1]) / 3;
    }
    // Handle edges
    smoothed[0] = (newYieldFactors[0] + newYieldFactors[1]) / 2;
    smoothed[95] = (newYieldFactors[94] + newYieldFactors[95]) / 2;
    for (let i = 0; i < 96; i += 1) newYieldFactors[i] = smoothed[i];
  }

  return {
    yieldFactors: newYieldFactors,
    slotAccumulators: null,
    updated: uniqueUpdatedSlots.size > 0,
    updatedSlots: uniqueUpdatedSlots.size,
    log: `Retrained model. Updated ${uniqueUpdatedSlots.size} slots based on historic data. (Boosted ${boostedSlots} sunny samples, Skipped ${skippedSlots} outliers)`,
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

module.exports = {
  getStrategy, detectCurtailment, processBucket, calculateSmoothedPower, processHistoricData, getInterpolatedRadiation, calculateForecast, getSunBounds,
};
