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

// Slot bookkeeping shared by all chart builders. Everything is derived from real UTC slot
// timestamps rather than from local clock hours, so a chart that does not start at midnight, or
// a 23/25-hour DST day, still lines up.

/**
 * Keep every step-th non-empty label so about `target` remain.
 * @param {string[]} labels
 * @param {number} [target=12]
 * @returns {string[]}
 */
const thinLabels = (labels, target = 12) => {
  const nonEmpty = labels.map((l, i) => (l !== '' ? i : -1)).filter((i) => i !== -1);
  const step = Math.max(1, Math.ceil(nonEmpty.length / target));
  const keep = new Set(nonEmpty.filter((_, i) => i % step === 0));
  return labels.map((l, i) => (keep.has(i) ? l : ''));
};

/**
 * 'HH' label at each full local hour, '' elsewhere, thinned to about `target` labels.
 * @param {number[]} times - slot start timestamps (ms)
 * @param {string} timeZone
 * @param {number} [target=12]
 * @returns {string[]}
 */
const hourLabels = (times, timeZone, target = 12) => thinLabels(times.map((t) => {
  const local = new Date(new Date(t).toLocaleString('en-US', { timeZone }));
  return local.getMinutes() === 0 ? String(local.getHours()).padStart(2, '0') : '';
}), target);

/**
 * Slot start timestamps from startMs, `count` slots of intervalMin minutes.
 * @returns {number[]}
 */
const slotTimes = (startMs, count, intervalMin) => Array.from({ length: count }, (_, i) => startMs + (i * intervalMin * 60 * 1000));

/**
 * Index of the slot that contains now, or -1 if now is outside the chart.
 * @param {number} startMs - start of slot 0
 * @param {number} intervalMin - slot length in minutes
 * @param {number} count - number of slots in the chart
 * @returns {number}
 */
const nowIndex = (startMs, intervalMin, count) => {
  const idx = Math.floor((Date.now() - startMs) / (intervalMin * 60 * 1000));
  return (idx >= 0 && idx < count) ? idx : -1;
};

/**
 * Chart.js annotation set with the dashed "now" line, or {} when now is outside the chart.
 * @returns {object}
 */
const nowLineAnnotation = (startMs, intervalMin, count) => {
  const idx = nowIndex(startMs, intervalMin, count);
  if (idx < 0) return {};
  return {
    nowLine: {
      type: 'line',
      scaleID: 'x',
      value: idx,
      borderColor: 'rgba(255, 255, 255, 0.75)',
      borderWidth: 1.5,
      borderDash: [4, 4],
    },
  };
};

module.exports = {
  thinLabels, hourLabels, slotTimes, nowIndex, nowLineAnnotation,
};
