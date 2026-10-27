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

// Insights history by the step the data has, not by the resolution's name. Live on HomeyProd26:
// 2026-09-26 'last14Days' gave hourly points, 2026-10-27 6-hour points ('last7Days' hourly).

const HOUR_MS = 3600 * 1000;

const toMs = (t) => (typeof t === 'number' ? t : new Date(t).getTime());

/**
 * Step between the points of getLogEntries() data (ms): its `step`, else the median gap.
 */
const stepOf = (data) => {
  if (data && Number.isFinite(data.step)) return data.step;
  const t = ((data && data.values) || []).map((e) => toMs(e.t)).sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
};

/**
 * Numeric entries {t, v, coarse} of a log, the finest of the resolutions for each period (try
 * the finest first). coarse: points further apart than an hour.
 *
 * @param {object} api - HomeyAPI
 * @param {string} logId
 * @param {Array<string>} [resolutions]
 */
const fetchHistory = async (api, logId, resolutions = ['last7Days', 'last14Days', 'last31Days']) => {
  let out = [];
  for (const resolution of resolutions) {
    const data = await api.insights.getLogEntries({ id: logId, resolution }).catch(() => null);
    const coarse = !(stepOf(data) <= HOUR_MS);
    const values = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => ({ t: toMs(e.t), v: e.v, coarse }));
    const first = out.length ? out[0].t : Infinity;
    out = values.filter((e) => e.t < first).concat(out);
  }
  return out;
};

module.exports = {
  HOUR_MS,
  stepOf,
  fetchHistory,
};
