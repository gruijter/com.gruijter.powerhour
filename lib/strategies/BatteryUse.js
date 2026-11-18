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

const STEP_PCT = 2;
const MAX_STEP_PCT = 30;
const RANK_CYCLES = 0.5;
const COST_SHARE = 0.05;
const TIE_SHARE = 0.002;

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
const wearKey = (wear) => Number((Number(wear) || 0).toPrecision(3));

const cycleCost = ({
  wear = 0, effC = 1, effD = 1, price = 0,
}) => {
  const ref = Math.abs(Number(price) || 0);
  const losses = effC > 0 && effD > 0 ? ref * ((1 / (effC * effD)) - 1) : 0;
  return (Number(wear) || 0) + losses;
};

const costClasses = (items, price) => {
  const ref = Math.abs(Number(price) || 0);
  if (!(ref > 0) || !items.length) return items.map(() => 0);
  const costs = items.map((it) => cycleCost({ ...it, price: ref }));
  const min = Math.min(...costs);
  return costs.map((c) => Math.floor((c - min) / (COST_SHARE * ref) + 1e-9));
};

const refPrice = (prices) => {
  const p = Array.isArray(prices) ? prices.filter(Number.isFinite) : [];
  return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 0;
};

module.exports = {
  createState, onSoc, rank, wearKey, cycleCost, costClasses, refPrice, RANK_CYCLES, COST_SHARE, TIE_SHARE,
};
