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

// A group's planned power over its batteries: efficiency first, then SoC. The fewest batteries
// that stay within their efficient power (low power is lossy too), the most efficient first, of
// equals by SoC (charging: the emptiest first, discharging: the fullest), a battery already busy
// that way keeps its turn within HYSTERESIS_PCT. Within them a share by room (charging) or charge (discharging), up to the
// efficient power first, then up to the max.

const HYSTERESIS_PCT = 10; // SoC; a plan has no meter noise (NomXomStrategy: 20)
// One battery a little above its efficient power loses less than two at half of it (as NomXomStrategy).
const EFF_MARGIN = 1.1;

// The most efficient speed ({power, eff}); the fastest of equals.
const efficientSpeed = (speeds) => speeds
  .filter((s) => s.power > 0 && s.eff > 0)
  .reduce((best, s) => (s.eff > best.eff || (s.eff === best.eff && s.power > best.power) ? s : best), { power: 0, eff: 0 });

/**
 * @param {Array<{socPct:number, speed:{power, eff}, maxW:number, active:boolean}>} bats - speed:
 *   efficientSpeed(); maxW: also within the battery's room or charge this slot; active: busy the
 *   same way the slot before
 * @param {number} totalW - the group's power, > 0
 * @param {boolean} charging
 * @returns {number[]} W per battery (>= 0); their sum is below totalW when the batteries cannot
 */
const split = (bats, totalW, charging) => {
  const effPct = (b) => Math.round(100 * b.speed.eff);
  const score = (b) => (charging ? b.socPct - (b.active ? HYSTERESIS_PCT : 0) : -(b.socPct + (b.active ? HYSTERESIS_PCT : 0)));
  const order = bats.map((b, i) => i).filter((i) => bats[i].maxW > 0)
    .sort((i, j) => (effPct(bats[j]) - effPct(bats[i])) || (score(bats[i]) - score(bats[j])));
  const effCap = (i) => Math.min(bats[i].speed.power || bats[i].maxW, bats[i].maxW);
  let n = order.length;
  let sum = 0;
  for (let k = 0; k < order.length; k += 1) {
    sum += effCap(order[k]) * EFF_MARGIN;
    if (sum >= totalW - 1e-6) {
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

module.exports = { efficientSpeed, split, HYSTERESIS_PCT };
