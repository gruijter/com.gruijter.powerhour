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

const { meterToPower } = require('./InsightsHistory');

const findClosestSample = (history, timeMs, windowMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  let closest = null;
  let bestDist = windowMs;
  for (let i = 0; i < history.length; i += 1) {
    const dist = Math.abs(history[i].time - timeMs);
    if (dist < bestDist) {
      bestDist = dist;
      closest = history[i];
    }
  }
  if (!closest) return null;
  return typeof closest[valueKey] === 'number' ? closest[valueKey] : null;
};

const fetchYesterdayAndToday = async (api, logId) => {
  const fetchRes = async (resolution) => api.insights.getLogEntries({ id: logId, resolution }).catch(() => null);
  const [yesterday, today] = await Promise.all([fetchRes('yesterday'), fetchRes('today')]);
  const values = [
    ...(yesterday && yesterday.values ? yesterday.values : []),
    ...(today && today.values ? today.values : []),
  ];
  return { values };
};

const STEP_MS = 5 * 60 * 1000;
const convertCumulativeToPower = (entries, maxPowerW = 30000) => {
  const power = meterToPower(entries, { maxW: maxPowerW, minGapMs: 36 * 1000, maxGapMs: 24 * 3600 * 1000 });
  const out = [];
  power.forEach((p, i) => {
    const next = power[i + 1];
    const steps = next && next.t - p.t < 24 * 3600 * 1000 ? Math.max(1, Math.floor((next.t - p.t) / STEP_MS)) : 1;
    for (let k = 0; k < steps; k += 1) out.push({ t: p.t + k * STEP_MS, y: p.v });
  });
  return out;
};

const smoothTimeSeries = (entries) => {
  if (!Array.isArray(entries) || entries.length < 3) return entries;
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  return sorted.map((e, i) => {
    if (i === 0 || i === sorted.length - 1) return e;
    const prevVal = sorted[i - 1].y !== undefined ? sorted[i - 1].y : sorted[i - 1].v;
    const currVal = e.y !== undefined ? e.y : e.v;
    const nextVal = sorted[i + 1].y !== undefined ? sorted[i + 1].y : sorted[i + 1].v;
    if (typeof prevVal !== 'number' || typeof currVal !== 'number' || typeof nextVal !== 'number') return e;
    const smoothedVal = (prevVal * 0.25) + (currVal * 0.5) + (nextVal * 0.25);
    return { ...e, [e.y !== undefined ? 'y' : 'v']: smoothedVal };
  });
};

const averageSamplesInWindow = (history, startMs, endMs, valueKey) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  let sum = 0;
  let count = 0;
  history.forEach((d) => {
    if (d && d.time >= startMs && d.time < endMs && typeof d[valueKey] === 'number') {
      sum += d[valueKey];
      count += 1;
    }
  });
  return count > 0 ? sum / count : null;
};

const mergeStoredHistory = (stored, current, max) => {
  const base = Array.isArray(stored) ? stored : [];
  if (!Array.isArray(current) || current.length === 0) return base.slice(-max);
  const firstTm = current[0].time;
  return base.filter((e) => e.time < firstTm).concat(current).slice(-max);
};

module.exports = {
  findClosestSample,
  averageSamplesInWindow,
  fetchYesterdayAndToday,
  convertCumulativeToPower,
  smoothTimeSeries,
  mergeStoredHistory,
};
