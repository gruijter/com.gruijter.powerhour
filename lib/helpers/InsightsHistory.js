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

// A device capability's log id; a bare measure_power is logged as energy_power. Looked up directly,
// not in api.insights.getLogs(): that lists every log on the Homey (~2000 objects, ~13 MB passing
// through memory). Same result: on Dev (2026-11-12) every device log id was
// homey:device:<id>:<capability>, and logs have no name field.
const deviceLogId = (deviceId, cap) => `homey:device:${deviceId}:${cap}`;

/**
 * The logs { id, uri, ownerUri } that exist of these capabilities of a device, in their order.
 *
 * @param {object} api - HomeyAPI
 * @param {string} deviceId
 * @param {Array<string>} caps - Insights capability names (energy_power, not measure_power)
 */
const deviceLogs = async (api, deviceId, caps) => {
  if (!api || !deviceId) return [];
  const found = await Promise.all([...new Set(caps)].map((cap) => api.insights.getLog({ id: deviceLogId(deviceId, cap) })
    .then((log) => (log ? { id: log.id, uri: log.uri, ownerUri: log.ownerUri } : null))
    .catch(() => null)));
  return found.filter(Boolean);
};

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

// null: a gap in the log.
const valueOf = (e) => {
  if (typeof e.v === 'number') return e.v;
  return typeof e.y === 'number' ? e.y : null;
};

// Every Insights entry, at every resolution, is the MEAN of its bucket [t, t + step): measured on
// Dev and Prod 2026-11-14 for 16 logs of 7 apps (power, energy_power, SoC, prices, temperatures,
// meters). No time shift. A meter is a mean too: the step between two entries is the energy of
// [t + step/2, t + 3 step/2].

/**
 * Power (W) {t, v} of a cumulative meter (kWh) log, per entry: the central difference over the
 * entries around it, which covers [t, t + step) (one-sided at the ends and next to a gap).
 * signed: a meter that may go down (a battery's net meter); else a drop is a reset and skipped.
 *
 * @param {Array<{t, v|y}>} entries - ascending, null values skipped
 * @param {object} [o]
 * @param {boolean} [o.signed]
 * @param {number} [o.maxW] - plausibility ceiling
 * @param {number} [o.minGapMs] - shorter steps are skipped
 * @param {number} [o.maxGapMs] - longer steps are skipped
 */
const meterToPower = (entries, {
  signed = false, maxW = Infinity, minGapMs = 0, maxGapMs = Infinity,
} = {}) => {
  const pts = (entries || []).map((e) => ({ t: toMs(e.t), v: valueOf(e) })).filter((e) => e.v !== null && Number.isFinite(e.t));
  // segs[i]: the step from pts[i] to pts[i + 1], null when not usable
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const dt = pts[i + 1].t - pts[i].t;
    let dKwh = pts[i + 1].v - pts[i].v;
    if (!signed && dKwh < 0 && dKwh > -1e-4) dKwh = 0; // float noise
    const w = (dKwh / (dt / HOUR_MS)) * 1000;
    const ok = dt > minGapMs && dt < maxGapMs && (signed || dKwh >= 0) && Math.abs(dKwh) < 500 && Math.abs(w) <= maxW;
    segs.push(ok ? { dt, dKwh } : null);
  }
  const out = [];
  pts.forEach((p, i) => {
    const used = [segs[i - 1], segs[i]].filter(Boolean);
    if (!used.length) return;
    const dt = used.reduce((a, s) => a + s.dt, 0);
    out.push({ t: p.t, v: (used.reduce((a, s) => a + s.dKwh, 0) / (dt / HOUR_MS)) * 1000 });
  });
  return out;
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

  // Gaps skipped: a meter's power over a gap is its average between the points around it.
  const convert = (data) => {
    const values = ((data && data.values) || []).filter((e) => valueOf(e) !== null);
    if (values.length === 0) return null;
    if (isCumulative) {
      const power = meterToPower(values, { signed });
      return power.length ? power : null;
    }
    return values.map((e) => ({ t: toMs(e.t), v: valueOf(e) }));
  };
  const entries = (resolution, start = startDate) => api.insights.getLogEntries({
    id, start: start.toISOString(), end: endDate.toISOString(), resolution,
  }).catch(() => null);

  let coarse = null;
  for (const resolution of coarseResolutions) {
    const data = await entries(resolution);
    if (stepOf(data) === HOUR_MS) coarse = convert(data);
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
  deviceLogId,
  deviceLogs,
  stepOf,
  fetchHistory,
  fetchSeries,
  meterToPower,
};
