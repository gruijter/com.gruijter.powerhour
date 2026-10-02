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

// Charger history from Insights, shared by the evCharger device (learning) and driver (setup view).

/**
 * Power (W) entries {t, v} of a device's first available log among capNames, over
 * [startDate, endDate]: hourly for older history, ~5-minute for the last 24 hours. Cumulative
 * meter logs are turned into power. null without data.
 *
 * @param {object} o
 * @param {object} o.api - HomeyAPI
 * @param {Array} o.logs - Insights log listing
 */
const fetchPowerLog = async ({
  api, logs, deviceId, capNames, startDate, endDate,
}) => {
  if (!deviceId || deviceId === 'none') return null;
  for (const capName of capNames) {
    const log = logs.find((l) => {
      const id = l.id || l.uri || '';
      return id.includes(deviceId) && (id.endsWith(`:${capName}`) || l.name === capName);
    });
    if (!log) continue;

    // On devices with energy-class registration, Homey stores the Insights log for
    // 'measure_power' itself under the internal log id 'energy_power' - same signal,
    // different log name, NOT a separate derived value and NOT cumulative despite the
    // name (confirmed empirically: same scale/sign as live measure_power).
    const isCumulative = capName.includes('meter') || (capName.includes('energy') && capName !== 'energy_power');

    const convert = (data, resStr) => {
      if (!data || !data.values || data.values.length === 0) return null;
      if (isCumulative && data.values.length > 1) {
        const powerWatts = [];
        for (let i = 1; i < data.values.length; i++) {
          const prev = data.values[i - 1];
          const curr = data.values[i];
          const getVal = (item) => {
            if (typeof item.v === 'number') return item.v;
            if (typeof item.y === 'number') return item.y;
            return 0;
          };
          const prevV = getVal(prev);
          const currV = getVal(curr);
          const prevT = new Date(prev.t).getTime();
          const currT = new Date(curr.t).getTime();
          const dtHours = (currT - prevT) / (3600 * 1000);
          const dKwh = currV - prevV;
          if (dtHours > 0 && dKwh >= 0 && dKwh < 500) {
            const watts = (dKwh / dtHours) * 1000;
            powerWatts.push({ t: prevT, v: watts });
          }
        }
        return powerWatts;
      }

      // 'energy_power' AND 'measure_battery' (used here for the car's SoC) hourly entries
      // are already stamped at the START of the hour they represent (confirmed
      // empirically against a real device: both logs' raw hourly entry lined up exactly
      // with the real transition seen in Homey's own Insights graph, at the same raw
      // timestamp) - unlike other hourly logs, which are END-of-interval stamped and need
      // the -1h correction below.
      const startStampedCaps = ['energy_power', 'measure_battery'];
      const isHourly = (resStr === 'last7Days' || resStr === 'last14Days' || resStr === 'last31Days') && !startStampedCaps.includes(capName);
      return data.values.map((e) => {
        let val = 0;
        if (typeof e.v === 'number') val = e.v;
        else if (typeof e.y === 'number') val = e.y;
        const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
        const t = isHourly ? rawT - 3600000 : rawT;
        return { t, v: val };
      });
    };

    // Two-stage fetch, mirroring solar's approach (drivers/solar/device.js): a single
    // 'last7Days'/'last14Days'/'last31Days' fetch only ever returns HOURLY points, and since
    // the old code stopped at the first resolution with any data, it locked onto hourly and
    // never tried a finer one - this is why the evCharger chart stepped hourly even when the
    // price source (e.g. dap15) is 15-minute resolution. 'last24Hours' gives ~5-minute
    // resolution for the most recent day; merge it over the coarse hourly data so the last
    // 24h is fine-grained and older-than-24h stays hourly (that's all Insights offers there).
    let coarse = null;
    for (const resStr of ['last7Days', 'last14Days', 'last31Days']) {
      const data = await api.insights.getLogEntries({
        id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: resStr,
      }).catch(() => null);
      coarse = convert(data, resStr);
      if (coarse) break;
    }

    const fineStart = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    const fineData = await api.insights.getLogEntries({
      id: log.id, start: fineStart.toISOString(), end: endDate.toISOString(), resolution: 'last24Hours',
    }).catch(() => null);
    const fine = convert(fineData, 'last24Hours');

    if (!coarse && !fine) {
      const todayData = await api.insights.getLogEntries({
        id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: 'today',
      }).catch(() => null);
      const today = convert(todayData, 'today');
      if (today) return today;
      continue;
    }
    if (!fine) return coarse;
    if (!coarse) return fine;

    const fineMinTime = Math.min(...fine.map((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime())));
    const merged = coarse.filter((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime()) < fineMinTime).concat(fine);
    return merged;
  }
  return null;
};

/**
 * Charge power (W) from power history: the 99th percentile of the readings above 500 W, rounded
 * to 100 W. null below 1000 W or without charging in the history.
 */
const detectChargePower = (entries) => {
  const powers = (entries || []).map((e) => e.v).filter((p) => typeof p === 'number' && p > 500).sort((a, b) => a - b);
  if (!powers.length) return null;
  const detected = Math.round(powers[Math.floor(powers.length * 0.99)] / 100) * 100;
  return detected >= 1000 ? detected : null;
};

// Charge power without a setting and without measurements: a 16 A single phase charger.
const DEFAULT_CHARGE_POWER_W = 3700;

module.exports = {
  DEFAULT_CHARGE_POWER_W,
  fetchPowerLog,
  detectChargePower,
};
