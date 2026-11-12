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

// Capacity and max. power of a battery proposed at pairing, from the hourly Insights of its source
// device. Hourly averages of the power summed match its kWh meters within 0.5% (Sessy, Dev,
// 2026-11-12), so no meters are needed. Proposals only: the user can change them.

const InsightsHistory = require('./InsightsHistory');

const MIN_RUN_PCT = 30; // a discharge run of at least this much charge level
const SOC_NOISE_PCT = 0.5; // a step back this small does not end a run
const POWER_ROUND_W = 100;

/**
 * { batCapacity, chargePower, dischargePower }, each only when the history shows it.
 * Capacity from discharge runs (charging counts the losses too, ~15% high on a Sessy). Max. power:
 * the highest hour rounded up, a lower limit (an hour average; discharging may follow the home).
 *
 * @param {Array<{t, v}>} soc - hourly charge level (%)
 * @param {Array<{t, v}>} power - hourly power (W), + = charging
 */
const propose = (soc, power) => {
  const pw = new Map(power.map((e) => [e.t, e.v]));
  const pts = soc.filter((e) => pw.has(e.t)).sort((a, b) => a.t - b.t).map((e) => ({ soc: e.v, w: pw.get(e.t) }));
  const out = {};
  if (pts.length < 3) return out;
  // A live log: the charge level moves and the power goes both ways (a frozen log does neither).
  const socs = pts.map((p) => p.soc);
  const ws = pts.map((p) => p.w);
  if (Math.max(...socs) - Math.min(...socs) < MIN_RUN_PCT || !(Math.max(...ws) > 0 && Math.min(...ws) < 0)) return out;

  // Hourly averages: the step between two levels is the energy of the half hours around it.
  const runs = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].soc - pts[j].soc <= SOC_NOISE_PCT) j += 1;
    const drop = pts[i].soc - pts[j].soc;
    if (drop >= MIN_RUN_PCT) {
      let kwh = 0;
      for (let k = i; k < j; k += 1) kwh -= (pts[k].w + pts[k + 1].w) / 2000;
      if (kwh > 0) runs.push((kwh / drop) * 100);
    }
    i = Math.max(j, i + 1);
  }
  if (runs.length) out.batCapacity = Math.round((runs.reduce((a, v) => a + v, 0) / runs.length) * 10) / 10;

  const limit = (values) => {
    const max = Math.max(...values);
    return max > 0 ? Math.ceil(max / POWER_ROUND_W) * POWER_ROUND_W : null;
  };
  const charge = limit(ws);
  const discharge = limit(ws.map((w) => -w));
  if (charge) out.chargePower = charge;
  if (discharge) out.dischargePower = discharge;
  return out;
};

// The Insights log of a capability: Homey logs a bare measure_power as energy_power.
const logIdOf = (sourceId, cap) => InsightsHistory.deviceLogId(sourceId, cap === 'measure_power' ? 'energy_power' : cap);

/**
 * The proposal for a source device from the last 7 days, {} without usable history.
 *
 * @param {object} api - HomeyAPI
 * @param {string} sourceId
 * @param {{ soc, power, invert }} caps - one signed power; invert: + = discharging
 */
const fetchProposal = async (api, sourceId, { soc, power, invert = false }) => {
  if (!api || !sourceId || !soc || !power) return {};
  const hourly = async (cap) => (await InsightsHistory.fetchHistory(api, logIdOf(sourceId, cap), ['last7Days']))
    .filter((e) => !e.coarse);
  const socs = await hourly(soc);
  if (!socs.length) return {};
  const powers = (await hourly(power)).map((e) => ({ t: e.t, v: invert ? -e.v : e.v }));
  return propose(socs, powers);
};

module.exports = {
  propose,
  fetchProposal,
};
