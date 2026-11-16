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

// A newly paired meter: its day, month and year (this and last) from the source's Insights history.

const ContractYear = require('./ContractYear');
const InsightsHistory = require('./InsightsHistory');
const MeterHelpers = require('./MeterHelpers');

const DAY_MS = 24 * 3600 * 1000;
const SIGNS = {
  p1: 1, p2: 1, n1: -1, n2: -1,
};

// Per period [start of the last one, start of this one] in UTC ms, on the contract start.
const periodStarts = (nowLocal, startDay, startMonth, timeZone) => {
  const local = (d) => ContractYear.localStartMs(d, timeZone);
  const day = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate());
  const prevDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  const cur = MeterHelpers.periodStarts(nowLocal, startDay, startMonth);
  const before = (d) => MeterHelpers.periodStarts(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1), startDay, startMonth);
  return {
    day: [local(prevDay), local(day)],
    month: [local(before(cur.month).month), local(cur.month)],
    year: [local(before(cur.year).year), local(cur.year)],
  };
};

// The source meter p1 + p2 - n1 - n2 at ms; null when one of them has no data then.
const sourceAt = async (api, sourceId, capGroup, ms, cache) => {
  let total = 0;
  for (const [role, sign] of Object.entries(SIGNS)) {
    const cap = capGroup[role];
    if (!cap) continue;
    const v = await ContractYear.meterAt(api, sourceId, [cap], ms, { cache });
    if (typeof v !== 'number') return null;
    total += sign * v;
  }
  return total;
};

// Buckets { t, end, w } of a power log (bucket means, W), the finest resolution per stretch, back
// to oldestMs where the log reaches.
const powerBuckets = async (api, sourceId, oldestMs) => {
  const [log] = await InsightsHistory.deviceLogs(api, sourceId, ['energy_power']);
  if (!log) return [];
  let covered = Date.now();
  const out = [];
  for (const resolution of ['last24Hours', 'last14Days', 'thisYear', 'lastYear']) {
    const data = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
    const step = InsightsHistory.stepOf(data);
    if (!step) continue;
    const until = covered;
    const buckets = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
      .map((e) => ({ t: new Date(e.t).getTime(), w: e.v })).filter((e) => e.t < until)
      .map((e) => ({ ...e, end: Math.min(e.t + step, until) }));
    if (!buckets.length) continue;
    out.push(...buckets);
    covered = buckets[0].t;
    if (covered <= oldestMs) break;
  }
  return out;
};

// kWh from ms till now; null when the buckets do not reach back to ms.
const energySince = (buckets, ms) => {
  if (!buckets.length || Math.min(...buckets.map((b) => b.t)) > ms) return null;
  return buckets.reduce((kwh, b) => {
    const from = Math.max(b.t, ms);
    return b.end > from ? kwh + (b.w * (b.end - from)) / 3600000 / 1000 : kwh;
  }, 0);
};

module.exports = {
  DAY_MS,
  periodStarts,
  sourceAt,
  powerBuckets,
  energySince,
};
