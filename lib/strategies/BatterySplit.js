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

const BatteryUse = require('./BatteryUse');

// A group's power over its batteries (plan and real time). The fewest batteries that stay within
// their efficient power (low power is lossy too): the cheapest per kWh cycled first, of about
// equally cheap ones the least used (BatteryUse), then the most efficient, of equals by SoC
// (charging: the emptiest first, discharging: the fullest); a battery already busy that way keeps
// its turn within the SoC hysteresis. Within them a share by room (charging) or charge
// (discharging), up to the efficient power first, then up to the max.

const HYSTERESIS_PCT = 10; // SoC, plan; real time more (meter noise)
// One battery a little above its efficient power loses less than two at half of it. Fewer busy
// batteries again only as far below it (no flip-flopping in between).
const EFF_MARGIN = 1.1;

// The most efficient speed ({power, eff}); the fastest of equals.
const efficientSpeed = (speeds) => speeds
  .filter((s) => s.power > 0 && s.eff > 0)
  .reduce((best, s) => (s.eff > best.eff || (s.eff === best.eff && s.power > best.power) ? s : best), { power: 0, eff: 0 });

// Charge and discharge speeds ({power (W), eff}) from the battery settings.
const speedsFromSettings = (settings) => {
  const speeds = (list) => list
    .map(([power, loss]) => ({ power: Number(settings[power]) || 0, eff: 1 - ((Number(settings[loss]) || 0) / 100) }))
    .filter((speed) => speed.power);
  return {
    chargeSpeeds: speeds([['chargePower', 'chargeLoss'], ['chargePowerEff', 'chargeLossEff'], ['chargePower3', 'chargeLoss3']]),
    dischargeSpeeds: speeds([['dischargePower', 'dischargeLoss'], ['dischargePowerEff', 'dischargeLossEff'], ['dischargePower3', 'dischargeLoss3']]),
  };
};

/**
 * @param {Array<{socPct:number, speed:{power, eff}, maxW:number, active:boolean,
 *   costClass?:number, cycles?:number}>} bats - speed: efficientSpeed(); maxW: also within the
 *   battery's room or charge this slot; active: busy the same way now; costClass, cycles: BatteryUse
 * @param {number} totalW - the group's power, > 0
 * @param {boolean} charging
 * @param {number} [hysteresisPct] - SoC
 * @returns {number[]} W per battery (>= 0); their sum is below totalW when the batteries cannot
 */
const split = (bats, totalW, charging, hysteresisPct = HYSTERESIS_PCT) => {
  const effPct = (b) => Math.round(100 * b.speed.eff);
  const bonus = (b) => (b.active ? hysteresisPct : 0);
  const score = (b) => (charging ? b.socPct - bonus(b) : -(b.socPct + bonus(b)));
  const order = bats.map((b, i) => i).filter((i) => bats[i].maxW > 0)
    .sort((i, j) => ((bats[i].costClass || 0) - (bats[j].costClass || 0))
      || (BatteryUse.rank(bats[i].cycles) - BatteryUse.rank(bats[j].cycles))
      || (effPct(bats[j]) - effPct(bats[i])) || (score(bats[i]) - score(bats[j])));
  const effCap = (i) => Math.min(bats[i].speed.power || bats[i].maxW, bats[i].maxW);
  const busy = order.filter((i) => bats[i].active).length;
  let n = order.length;
  for (let k = 0; k < order.length; k += 1) {
    const margin = k + 1 < busy ? 1 / EFF_MARGIN : EFF_MARGIN;
    const fits = order.slice(0, k + 1).reduce((a, i) => a + Math.min(effCap(i) * margin, bats[i].maxW), 0);
    if (fits >= totalW - 1e-6) {
      n = k + 1;
      break;
    }
  }
  const used = order.slice(0, n);
  const weight = (i) => Math.max(0.1, charging ? 100 - bats[i].socPct : bats[i].socPct);
  const share = bats.map(() => 0);
  let rest = totalW;
  for (const limit of [effCap, (i) => bats[i].maxW]) {
    for (let round = 0; round < used.length && rest > 1e-6; round += 1) {
      const open = used.filter((i) => share[i] < limit(i) - 1e-6);
      const w = open.reduce((a, i) => a + weight(i), 0);
      if (!(w > 0)) break;
      let added = 0;
      for (const i of open) {
        const add = Math.min(limit(i) - share[i], (rest * weight(i)) / w);
        share[i] += add;
        added += add;
      }
      rest -= added;
    }
  }
  return share;
};

module.exports = {
  efficientSpeed, speedsFromSettings, split, HYSTERESIS_PCT,
};
