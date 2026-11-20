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

const HOUR_MS = 3600 * 1000;

const toMs = (t) => (typeof t === 'number' ? t : new Date(t).getTime());

const deviceLogId = (deviceId, cap) => `homey:device:${deviceId}:${cap}`;

const deviceLogs = async (api, deviceId, caps) => {
  if (!api || !deviceId) return [];
  const found = await Promise.all([...new Set(caps)].map((cap) => api.insights.getLog({ id: deviceLogId(deviceId, cap) })
    .then((log) => (log ? { id: log.id, uri: log.uri, ownerUri: log.ownerUri } : null))
    .catch(() => null)));
  return found.filter(Boolean);
};

const stepOf = (data) => {
  if (data && Number.isFinite(data.step)) return data.step;
  const t = ((data && data.values) || []).map((e) => toMs(e.t)).sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
};

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

const valueOf = (e) => {
  if (typeof e.v === 'number') return e.v;
  return typeof e.y === 'number' ? e.y : null;
};

const meterToPower = (entries, {
  signed = false, maxW = Infinity, minGapMs = 0, maxGapMs = Infinity,
} = {}) => {
  const pts = (entries || []).map((e) => ({ t: toMs(e.t), v: valueOf(e) })).filter((e) => e.v !== null && Number.isFinite(e.t));
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const dt = pts[i + 1].t - pts[i].t;
    let dKwh = pts[i + 1].v - pts[i].v;
    if (!signed && dKwh < 0 && dKwh > -1e-4) dKwh = 0;
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

const fetchSeries = async ({
  api, log, capName, startDate, endDate, coarseResolutions = ['last7Days', 'last14Days', 'last31Days'], signed = false,
}) => {
  const id = log.id || log.uri;
  const cap = capName || String(id || '').split(':').pop() || '';
  const isCumulative = cap.includes('meter') || (cap.includes('energy') && cap !== 'energy_power');

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

const tracked = (api) => {
  const { insights } = api;
  const out = Object.create(api);
  const own = Object.create(insights);
  Object.defineProperty(own, 'getLog', {
    value: (args) => insights.getLog(args).catch((err) => {
      if (!(err && (err.statusCode === 404 || /not found/i.test(err.message)))) out.failed += 1;
      throw err;
    }),
  });
  Object.defineProperty(own, 'getLogEntries', {
    value: (args) => insights.getLogEntries(args).catch((err) => {
      out.failed += 1;
      throw err;
    }),
  });
  Object.defineProperty(out, 'insights', { value: own });
  Object.defineProperty(out, 'failed', { value: 0, writable: true });
  return out;
};

module.exports = {
  HOUR_MS,
  tracked,
  deviceLogId,
  deviceLogs,
  stepOf,
  fetchHistory,
  fetchSeries,
  meterToPower,
};
