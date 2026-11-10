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

// These hourly logs are stamped at the START of the hour (confirmed on a device); others at the
// end and get the -1h correction.
const START_STAMPED = ['energy_power', 'measure_battery'];

const valueOf = (e) => {
  if (typeof e.v === 'number') return e.v;
  return typeof e.y === 'number' ? e.y : 0;
};

/**
 * Entries {t, v} of one log over [startDate, endDate]: hourly for the older part (the first of
 * coarseResolutions whose data is hourly, whatever its name), ~5-minute for the last 24 hours. A
 * cumulative meter log is turned into power (W). null without data.
 *
 * @param {object} o
 * @param {object} o.api - HomeyAPI
 * @param {object} o.log - from the Insights log listing
 * @param {string} [o.capName] - the log's capability (default: from its id)
 * @param {boolean} [o.signed] - a cumulative meter may go down (a battery's net meter)
 */
const fetchSeries = async ({
  api, log, capName, startDate, endDate, coarseResolutions = ['last7Days', 'last14Days', 'last31Days'], signed = false,
}) => {
  const id = log.id || log.uri;
  const cap = capName || String(id || '').split(':').pop() || '';
  // Homey logs measure_power under 'energy_power': instantaneous W, not cumulative (confirmed).
  const isCumulative = cap.includes('meter') || (cap.includes('energy') && cap !== 'energy_power');

  const convert = (data, hourly = false) => {
    if (!data || !data.values || data.values.length === 0) return null;
    if (isCumulative && data.values.length > 1) {
      const power = [];
      for (let i = 1; i < data.values.length; i += 1) {
        const prevT = toMs(data.values[i - 1].t);
        const dtHours = (toMs(data.values[i].t) - prevT) / HOUR_MS;
        const dKwh = valueOf(data.values[i]) - valueOf(data.values[i - 1]);
        if (dtHours > 0 && (signed || dKwh >= 0) && Math.abs(dKwh) < 500) power.push({ t: prevT, v: (dKwh / dtHours) * 1000 });
      }
      return power;
    }
    const shift = hourly && !START_STAMPED.includes(cap) ? HOUR_MS : 0;
    return data.values.map((e) => ({ t: toMs(e.t) - shift, v: valueOf(e) }));
  };
  const entries = (resolution, start = startDate) => api.insights.getLogEntries({
    id, start: start.toISOString(), end: endDate.toISOString(), resolution,
  }).catch(() => null);

  let coarse = null;
  for (const resolution of coarseResolutions) {
    const data = await entries(resolution);
    if (stepOf(data) === HOUR_MS) coarse = convert(data, true);
    if (coarse) break;
  }
  const fine = convert(await entries('last24Hours', new Date(endDate.getTime() - 24 * HOUR_MS)));
  if (!coarse && !fine) return convert(await entries('today'));
  if (!fine) return coarse;
  if (!coarse) return fine;
  const fineStart = Math.min(...fine.map((e) => e.t));
  return coarse.filter((e) => e.t < fineStart).concat(fine);
};

module.exports = {
  HOUR_MS,
  stepOf,
  fetchHistory,
  fetchSeries,
};
