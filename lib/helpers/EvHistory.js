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

const { fetchSeries } = require('./InsightsHistory');

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
// coarseResolutions: the resolutions to try for older history, the first with hourly data is used
// (coarser data, whatever the resolution's name, is skipped: InsightsHistory).
const fetchPowerLog = async ({
  api, logs, deviceId, capNames, startDate, endDate, coarseResolutions = ['last7Days', 'last14Days', 'last31Days'],
}) => {
  if (!deviceId || deviceId === 'none') return null;
  for (const capName of capNames) {
    const log = logs.find((l) => {
      const id = l.id || l.uri || '';
      return id.includes(deviceId) && (id.endsWith(`:${capName}`) || l.name === capName);
    });
    if (!log) continue;

    const entries = await fetchSeries({
      api, log, capName, startDate, endDate, coarseResolutions,
    });
    if (entries) return entries;
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
