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

const getDayName = (dayOfWeek) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayOfWeek];
};

const getLocalTimeDetails = (timestamp, timezone) => {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const dayOfWeek = localDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const slotIndex = (localDate.getHours() * 4) + Math.floor(localDate.getMinutes() / 15);
  return { dayOfWeek, slotIndex };
};

const initializeProfile = () => {
  return new Array(7).fill(null).map(() => new Array(96).fill(0));
};

const getForecastAtOffset = (weeklyProfile, timestamp, offsetMinutes, timezone) => {
  const targetTime = new Date(timestamp.getTime() + offsetMinutes * 60 * 1000);
  const { dayOfWeek, slotIndex } = getLocalTimeDetails(targetTime, timezone);
  const profile = weeklyProfile || initializeProfile();
  return profile[dayOfWeek][slotIndex] || 0;
};

const getStrategy = ({
  currentPower,
  weeklyProfile,
  timestamp = new Date(),
  timezone = 'UTC',
  alpha = 0.1,
}) => {
  const result = {
    weeklyProfile: weeklyProfile ? weeklyProfile.map((dayArr) => [...dayArr]) : initializeProfile(),
    updated: false,
    log: null,
  };

  if (typeof currentPower !== 'number' || Number.isNaN(currentPower) || currentPower < 0) {
    return result;
  }

  const { dayOfWeek, slotIndex } = getLocalTimeDetails(timestamp, timezone);

  const oldPower = result.weeklyProfile[dayOfWeek][slotIndex] !== undefined && result.weeklyProfile[dayOfWeek][slotIndex] !== null
    ? result.weeklyProfile[dayOfWeek][slotIndex]
    : null;

  let newPower;
  if (oldPower === null || oldPower === 0) {
    newPower = currentPower;
  } else {
    newPower = (alpha * currentPower) + ((1 - alpha) * oldPower);
  }

  result.weeklyProfile[dayOfWeek][slotIndex] = Math.round(newPower);
  result.updated = true;
  const oldPowerStr = oldPower !== null ? Math.round(oldPower) : 'INIT';
  result.log = `Updated load forecast for ${getDayName(dayOfWeek)} slot ${slotIndex}: `
    + `${oldPowerStr}W -> ${Math.round(newPower)}W (Inst=${Math.round(currentPower)}W)`;

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
        if (!(dEnergy === 0 && samplesAvg > 10)) {
          bucketAvgPower = (dEnergy / (dTime / 3600000)) * 1000;
          valid = true;
          log = `Load Bucket ${result.bucket.index} finished. Avg (Energy): ${Math.round(bucketAvgPower)}W`;
        }
      }
    }

    if (!valid && result.bucket.samples.length > 0) {
      bucketAvgPower = samplesAvg;
      valid = true;
      log = `Load Bucket ${result.bucket.index} finished. Avg (Samples): ${Math.round(bucketAvgPower)}W`;
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
    if ((typeof currentPower !== 'number' || Number.isNaN(currentPower)) && dTime > 50000 && dEnergy > 0) {
      smoothedPower = (dEnergy / (dTime / 3600000)) * 1000;
    }
  }
  return { smoothedPower, newEnergyState };
};

const processHistoricData = ({
  powerEntries,
  currentWeeklyProfile,
  timezone = 'UTC',
  logger = () => {},
}) => {
  logger(`[processHistoricData] Start. Input Samples P=${powerEntries.length}`);

  const slotSamples = new Array(7).fill(null).map(() => new Array(96).fill(null).map(() => []));

  powerEntries.forEach((entry) => {
    const power = entry.y !== undefined ? entry.y : entry.v;
    if (typeof power !== 'number' || Number.isNaN(power) || power < 0 || power > 30000) return;

    const timestamp = new Date(entry.t);
    const { dayOfWeek, slotIndex } = getLocalTimeDetails(timestamp, timezone);

    slotSamples[dayOfWeek][slotIndex].push(power);
  });

  const newWeeklyProfile = currentWeeklyProfile
    ? currentWeeklyProfile.map((dayArr) => [...dayArr])
    : initializeProfile();

  let updatedSlots = 0;

  for (let day = 0; day < 7; day++) {
    for (let slot = 0; slot < 96; slot++) {
      const samples = slotSamples[day][slot];
      if (samples.length === 0) continue;

      samples.sort((a, b) => a - b);
      const mid = Math.floor(samples.length / 2);
      const median = samples[mid];

      newWeeklyProfile[day][slot] = Math.round(median);
      updatedSlots++;
    }
  }

  for (let day = 0; day < 7; day++) {
    for (let pass = 0; pass < 3; pass += 1) {
      const smoothed = [...newWeeklyProfile[day]];
      for (let i = 1; i < 95; i += 1) {
        const prev = smoothed[i - 1] !== null ? smoothed[i - 1] : smoothed[i];
        const curr = smoothed[i] !== null ? smoothed[i] : 0;
        const next = smoothed[i + 1] !== null ? smoothed[i + 1] : smoothed[i];
        smoothed[i] = Math.round((prev * 0.25) + (curr * 0.5) + (next * 0.25));
      }
      const nextVal = smoothed[1] !== null ? smoothed[1] : smoothed[0];
      smoothed[0] = Math.round((smoothed[0] * 0.75) + (nextVal * 0.25));
      const prevVal = smoothed[94] !== null ? smoothed[94] : smoothed[95];
      smoothed[95] = Math.round((smoothed[95] * 0.75) + (prevVal * 0.25));

      newWeeklyProfile[day] = smoothed;
    }
  }

  const logMessage = `Retrained load model from Insights. Initialized/updated ${updatedSlots} slots.`;
  logger(`[processHistoricData] Complete. ${logMessage}`);

  return {
    weeklyProfile: newWeeklyProfile,
    updated: updatedSlots > 0,
    log: logMessage,
  };
};

const calculateForecast = ({
  weeklyProfile,
  timestamp = new Date(),
  timezone = 'UTC',
}) => {
  const now = new Date(timestamp.getTime());
  const profile = weeklyProfile || initializeProfile();

  const expectedPower = getForecastAtOffset(profile, now, 0, timezone);
  const forecastM15 = getForecastAtOffset(profile, now, 15, timezone);
  const forecastM30 = getForecastAtOffset(profile, now, 30, timezone);
  const forecastM45 = getForecastAtOffset(profile, now, 45, timezone);
  const forecastH1 = getForecastAtOffset(profile, now, 60, timezone);
  const forecastH2 = getForecastAtOffset(profile, now, 120, timezone);
  const forecastH3 = getForecastAtOffset(profile, now, 180, timezone);

  const getLocalMidnightUTC = (d) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
    const offset = local.getTime() - d.getTime();
    const midnightLocal = new Date(local);
    midnightLocal.setHours(0, 0, 0, 0);
    return midnightLocal.getTime() - offset;
  };

  let totalTodayKwh = 0;
  const startOfTodayTime = getLocalMidnightUTC(now);
  const endOfTodayTime = startOfTodayTime + 24 * 60 * 60 * 1000;

  for (let slotTime = startOfTodayTime; slotTime < endOfTodayTime; slotTime += 15 * 60 * 1000) {
    const power = getForecastAtOffset(profile, new Date(slotTime), 0, timezone);
    totalTodayKwh += (power * 0.25) / 1000;
  }

  let totalTomorrowKwh = 0;
  let tomorrowPeakW = 0;
  const startOfTomorrowTime = endOfTodayTime;
  const endOfTomorrowTime = startOfTomorrowTime + 24 * 60 * 60 * 1000;

  for (let slotTime = startOfTomorrowTime; slotTime < endOfTomorrowTime; slotTime += 15 * 60 * 1000) {
    const power = getForecastAtOffset(profile, new Date(slotTime), 0, timezone);
    if (power > tomorrowPeakW) tomorrowPeakW = power;
    totalTomorrowKwh += (power * 0.25) / 1000;
  }

  let forecastH0Kwh = 0;
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const t = startOfHour.getTime() + i * 15 * 60 * 1000;
    const power = getForecastAtOffset(profile, new Date(t), 0, timezone);
    forecastH0Kwh += (power * 0.25) / 1000;
  }

  return {
    expectedPower,
    forecastM15,
    forecastM30,
    forecastM45,
    forecastH1,
    forecastH2,
    forecastH3,
    forecastH0Kwh: Number(forecastH0Kwh.toFixed(2)),
    totalTodayKwh: Number(totalTodayKwh.toFixed(2)),
    totalTomorrowKwh: Number(totalTomorrowKwh.toFixed(2)),
    tomorrowPeakW,
  };
};

module.exports = {
  getStrategy,
  processBucket,
  calculateSmoothedPower,
  processHistoricData,
  calculateForecast,
  getLocalTimeDetails,
  initializeProfile,
};
