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

// Which battery of a group first (BatterySplit, PrecisePlanner): the cheapest per kWh cycled (wear
// and losses), and of about equally cheap ones the least used, so over time those are used alike.
// Use: equivalent full cycles (100 % SoC down and up is one), from the SoC.

const STEP_PCT = 2; // SoC jitter below this is no use
const MAX_STEP_PCT = 30; // a bigger jump is a correction (or a gap), not use
const RANK_CYCLES = 0.5; // used alike within this
const COST_SHARE = 0.05; // about equally cheap: within this share of the price
const TIE_SHARE = 0.002; // of the price: the least used first, at about no cost

const createState = (cycles = 0) => ({ cycles, anchor: null });

const onSoc = (state, soc) => {
  const s = Number(soc);
  const st = state || createState();
  if (!Number.isFinite(s)) return st;
  if (st.anchor === null) return { ...st, anchor: s };
  const d = Math.abs(s - st.anchor);
  if (d < STEP_PCT) return st;
  return { cycles: st.cycles + (d <= MAX_STEP_PCT ? d / 200 : 0), anchor: s };
};

const rank = (cycles) => Math.floor((Number(cycles) || 0) / RANK_CYCLES);
// Wear per kWh as entered or computed: equal to 3 digits.
const wearKey = (wear) => Number((Number(wear) || 0).toPrecision(3));

// Cost per kWh cycled at a reference price: wear plus the round trip's losses.
const cycleCost = ({
  wear = 0, effC = 1, effD = 1, price = 0,
}) => {
  const ref = Math.abs(Number(price) || 0);
  const losses = effC > 0 && effD > 0 ? ref * ((1 / (effC * effD)) - 1) : 0;
  return (Number(wear) || 0) + losses;
};

// Cost class per battery of a group ([{wear, effC, effD}]): 0 for the cheapest, one up per share of
// the price above it. Lower first.
const costClasses = (items, price) => {
  const ref = Math.abs(Number(price) || 0);
  if (!(ref > 0) || !items.length) return items.map(() => 0);
  const costs = items.map((it) => cycleCost({ ...it, price: ref }));
  const min = Math.min(...costs);
  return costs.map((c) => Math.floor((c - min) / (COST_SHARE * ref) + 1e-9));
};

// Mean of the prices: the reference of cost classes.
const refPrice = (prices) => {
  const p = Array.isArray(prices) ? prices.filter(Number.isFinite) : [];
  return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0;
};

module.exports = {
  createState, onSoc, rank, wearKey, cycleCost, costClasses, refPrice, RANK_CYCLES, COST_SHARE, TIE_SHARE,
};
