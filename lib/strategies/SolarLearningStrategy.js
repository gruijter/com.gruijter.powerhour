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

  // Round to nearest hour for forecast lookup (Open-Meteo is hourly)
  const hourTime = new Date(timestamp);
  hourTime.setMinutes(0, 0, 0);
  const forecastRadiation = forecastData[hourTime.getTime()];

  if (forecastRadiation === undefined || forecastRadiation < 50) {
    // Ignore low radiation or missing data
    return result;
  }

  // Ensure positive power (PV generation)
  const power = Math.max(0, currentPower);

  const yieldFactor = power / forecastRadiation;

  if (!Number.isFinite(yieldFactor)) return result;

  // Update EMA
  const slotIndex = (timestamp.getHours() * 4) + Math.floor(timestamp.getMinutes() / 15);
  const oldYield = result.yieldFactors[slotIndex] !== undefined ? result.yieldFactors[slotIndex] : 1.0;
  const alpha = 0.2; // Learning rate
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

  const hourTime = new Date(timestamp);
  hourTime.setMinutes(0, 0, 0);
  const forecastRadiation = forecastData[hourTime.getTime()] || 0;
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

module.exports = {
  getStrategy, detectCurtailment, processBucket, calculateSmoothedPower,
};
