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

const TimeHelpers = require('../helpers/TimeHelpers');

const thinLabels = (labels, target = 12) => {
  const nonEmpty = labels.map((l, i) => (l !== '' ? i : -1)).filter((i) => i !== -1);
  const step = Math.max(1, Math.ceil(nonEmpty.length / target));
  const keep = new Set(nonEmpty.filter((_, i) => i % step === 0));
  return labels.map((l, i) => (keep.has(i) ? l : ''));
};

const hourLabels = (times, timeZone, target = 12) => thinLabels(times.map((t) => {
  const local = TimeHelpers.toLocalDate(new Date(t), timeZone);
  return local.getMinutes() === 0 ? String(local.getHours()).padStart(2, '0') : '';
}), target);

const slotTimes = (startMs, count, intervalMin) => Array.from({ length: count }, (_, i) => startMs + (i * intervalMin * 60 * 1000));

const nowIndex = (startMs, intervalMin, count) => {
  const idx = Math.floor((Date.now() - startMs) / (intervalMin * 60 * 1000));
  return (idx >= 0 && idx < count) ? idx : -1;
};

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

const LEGEND_FILTER = '__legendFilter__';
const withLegendFilter = (chart) => JSON.stringify(chart)
  .replace(`"${LEGEND_FILTER}"`, 'function (item) { return !!item.text; }');

const fillGaps = (values) => {
  const known = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  const out = values.slice();
  for (let k = 1; k < known.length; k += 1) {
    const [i0, i1] = [known[k - 1], known[k]];
    for (let i = i0 + 1; i < i1; i += 1) out[i] = values[i0] + ((values[i1] - values[i0]) * (i - i0)) / (i1 - i0);
  }
  return out;
};

const splitBySign = (values) => {
  const v = fillGaps(values);
  const side = (keep) => v.map((x, i) => {
    if (x === null) return null;
    if (keep(x)) return x;
    const near = [v[i - 1], v[i + 1]].some((n) => typeof n === 'number' && keep(n));
    return near ? 0 : null;
  });
  return [[side((x) => x > 0), 'use'], [side((x) => x < 0), 'export']];
};

const splitBySignXY = (values) => {
  const v = fillGaps(values);
  const pts = [];
  v.forEach((y, x) => {
    const prev = v[x - 1];
    if (typeof prev === 'number' && typeof y === 'number' && prev * y < 0) pts.push({ x: x - 1 + prev / (prev - y), y: 0 });
    pts.push({ x, y });
  });
  const side = (keep) => pts.map((p) => ({ x: p.x, y: p.y !== null && keep(p.y) ? p.y : null }));
  return [[side((y) => y >= 0), 'use'], [side((y) => y <= 0), 'export']];
};

module.exports = {
  splitBySign, splitBySignXY, thinLabels, hourLabels, slotTimes, nowIndex, nowLineAnnotation, LEGEND_FILTER, withLegendFilter,
};
