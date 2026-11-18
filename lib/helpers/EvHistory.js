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

const { fetchSeries, deviceLogs } = require('./InsightsHistory');

const fetchPowerLog = async ({
  api, deviceId, capNames, startDate, endDate, coarseResolutions = ['last7Days', 'last14Days', 'last31Days'],
}) => {
  if (!deviceId || deviceId === 'none') return null;
  const logs = await deviceLogs(api, deviceId, capNames);
  for (const capName of capNames) {
    const log = logs.find((l) => l.id.endsWith(`:${capName}`));
    if (!log) continue;

    const entries = await fetchSeries({
      api, log, capName, startDate, endDate, coarseResolutions,
    });
    if (entries) return entries;
  }
  return null;
};

const detectChargePower = (entries) => {
  const powers = (entries || []).map((e) => e.v).filter((p) => typeof p === 'number' && p > 500).sort((a, b) => a - b);
  if (!powers.length) return null;
  const detected = Math.round(powers[Math.floor(powers.length * 0.99)] / 100) * 100;
  return detected >= 1000 ? detected : null;
};

const DEFAULT_CHARGE_POWER_W = 3700;

module.exports = {
  DEFAULT_CHARGE_POWER_W,
  fetchPowerLog,
  detectChargePower,
};
