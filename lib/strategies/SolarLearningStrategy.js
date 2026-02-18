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
  date.setMinutes(0, 0, 0, 0);
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
  if (yieldFactor < 0.05 || yieldFactor > 100.0) return result; // Sanity check

  // Update EMA
  const slotIndex = (timestamp.getHours() * 4) + Math.floor(timestamp.getMinutes() / 15);
  const oldYield = result.yieldFactors[slotIndex] !== undefined ? result.yieldFactors[slotIndex] : 1.0;
  const alpha = 0.1; // Learning rate (10% weight for new data, aligns with historic decay)
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
  const slotIndex = (timestamp.getHours() * 4) + Math.floor(timestamp.getMinutes() / 15);
  const yieldFactor = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 1.0;
  const expectedPower = forecastRadiation * yieldFactor;

  // Detect drop to near zero while expecting significant power
  if (expectedPower > 300 && currentPower < 20 && lastPower > 300) {
    if (!isCurtailmentActive) {
      result.isActive = true;
      result.changed = true;
      result.log = `Curtailment detected: Expected ${Math.round(expectedPower)}W, Actual ${Math.round(currentPower)}W`;
    }
  } else if (isCurtailmentActive && currentPower > 50) {
    // Reset if power returns
    result.isActive = false;
    result.changed = true;
    result.log = `Curtailment ended: Power restored to ${Math.round(currentPower)}W`;
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
    if (dTime > 50000 && dEnergy >= 0) {
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
  resolution = 'hourly', // 'hourly' or 'high'
}) => {
  const newYieldFactors = [...currentYieldFactors];
  const slotAccumulators = new Array(96).fill(null).map(() => ({ weightedSum: 0, totalWeight: 0, count: 0 }));

  // Create a map for fast weather lookup (rounded to hour)
  const weatherMap = new Map();
  weatherEntries.forEach((w) => {
    const date = new Date(w.time);
    date.setMinutes(0, 0, 0);
    weatherMap.set(date.getTime(), w.radiation);
  });

  let updatedSlots = 0;
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  for (const entry of powerEntries) {
    const power = entry.y;
    // Skip invalid, low power (noise/night), or extremely high power (glitch > 100kW)
    if (typeof power !== 'number' || power < 10 || power > 100000) continue;

    const timestamp = new Date(entry.t);
    const radiation = getInterpolatedRadiation(timestamp, weatherMap);

    // Only train if we have significant radiation
    if (radiation && radiation > 50) {
      const yieldFactor = power / radiation;

      // Sanity check for yield factor (e.g. 0.05 to 100.0)
      if (yieldFactor > 0.05 && yieldFactor < 100.0) {
        // Weight recent data higher (exponential decay ~8% per day)
        const daysOld = Math.max(0, (now - timestamp.getTime()) / oneDay);
        const weight = Math.pow(0.92, daysOld);

        if (resolution === 'hourly') {
          // Apply to all 4 slots in this hour since historic data is hourly
          const startSlot = timestamp.getHours() * 4;
          for (let i = 0; i < 4; i++) {
            const slotIndex = startSlot + i;
            slotAccumulators[slotIndex].weightedSum += yieldFactor * weight;
            slotAccumulators[slotIndex].totalWeight += weight;
            slotAccumulators[slotIndex].count += 1;
          }
        } else {
          // Apply to specific slot
          const slotIndex = (timestamp.getHours() * 4) + Math.floor(timestamp.getMinutes() / 15);
          slotAccumulators[slotIndex].weightedSum += yieldFactor * weight;
          slotAccumulators[slotIndex].totalWeight += weight;
          slotAccumulators[slotIndex].count += 1;
        }
      }
    }
  }

  // Update yield factors where we have enough data
  for (let i = 0; i < 96; i++) {
    const acc = slotAccumulators[i];
    if (acc.count >= 5) { // Minimum 5 samples per slot to be statistically relevant
      const avgYield = acc.weightedSum / acc.totalWeight;
      // Since this is a specific "retrain" action with historic data, we overwrite the old factor
      newYieldFactors[i] = avgYield;
      updatedSlots++;
    }
  }

  return {
    yieldFactors: newYieldFactors,
    updated: updatedSlots > 0,
    updatedSlots,
    log: `Retrained model. Updated ${updatedSlots} slots based on historic data.`,
  };
};

module.exports = {
  getStrategy, detectCurtailment, processBucket, calculateSmoothedPower, processHistoricData,
};
