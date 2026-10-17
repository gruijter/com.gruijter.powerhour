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

// Battery plan with little memory and CPU, for Homeys without the LP (RoiStrategy): the same input
// and output, by dynamic programming over the stored energy in small steps. Backwards per slot, for
// each energy level the cheapest move to a level of the next slot; the cost of a move depends only
// on the energy moved, so it is computed once per slot. Memory: one byte pair per level per slot.
//
// The costs are those of RoiStrategy: charging takes the surplus first (export price), the grid
// for the rest (import price); discharging covers the deficit first (import price), the grid for
// the rest (export price); wear per kWh each way; the import limit's penalty; stored energy at the
// end is worth the mean price.
//
// A group plans as one battery (total capacity and power) and splits each slot's energy over the
// batteries with BatterySplit.

const BatterySplit = require('./BatterySplit');

const EPS_KWH = 0.001;

// The block of a slot without planned power. idle: usable surplus the plan did not store, or empty
// with a usable deficit. Else hold (save: no discharge, surplus may charge): the charge is kept, and
// surplus that comes unexpected is stored; quiet: neither a usable surplus nor deficit expected.
const zeroPowerBlock = ({ usableSurplusW = 0, usableDeficitW = 0 }, storedKwh) => {
  if (usableSurplusW > 0) return { block: 'idle' };
  if (usableDeficitW > 0) return { block: storedKwh > EPS_KWH ? 'hold' : 'idle' };
  return { block: 'hold', quiet: true };
};
const LEVEL_KWH = 0.05; // energy step: 200 W over 15 min; finer costs CPU for little gain
const MIN_LEVELS = 100; // at least 1 % steps
const MAX_LEVELS = 200;

// Efficiency at an AC power from the speeds ({power, eff}): one speed for part of the slot keeps
// its efficiency; between two speeds the best mix of them.
const effCurve = (speeds) => {
  const list = speeds.filter((s) => s.power > 0 && s.eff > 0).sort((a, b) => a.power - b.power);
  return (powerW) => {
    let best = 0;
    list.forEach((s, k) => {
      if (s.power >= powerW) best = Math.max(best, s.eff);
      const next = list[k + 1];
      if (next && powerW > s.power && powerW < next.power) {
        const f = (powerW - s.power) / (next.power - s.power); // time share of the faster speed
        best = Math.max(best, (((1 - f) * s.power * s.eff) + (f * next.power * next.eff)) / powerW);
      }
    });
    return best;
  };
};

// AC energy for a DC energy in a slot of `hours` (bisection on the AC power), or null when the
// battery cannot do it.
const acFor = (dcKwh, hours, maxW, eff, charging) => {
  const dcAt = (w) => {
    const e = eff(w);
    if (!(e > 0)) return 0;
    return charging ? (w * hours * e) / 1000 : (w * hours) / e / 1000;
  };
  if (dcKwh <= 0) return 0;
  if (dcAt(maxW) < dcKwh - 1e-9) return null;
  let lo = 0;
  let hi = maxW;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (dcAt(mid) < dcKwh) lo = mid;
    else hi = mid;
  }
  return (hi * hours) / 1000;
};

// minimizeGrid (self-consumption): a cost per kWh imported and exported far above any price, so
// the plan first takes the least from and gives the least to the grid, then the cheapest way.
const gridKwhPenalty = (prices, exportPrices) => 10 * Math.max(0.1, ...prices.map(Math.abs), ...(exportPrices || []).map(Math.abs));

// What a charge/discharge cycle must pay per kWh on top of the losses: the wear, and the minimum
// profit (not with minimizeGrid).
const cycleCostFor = ({ minPriceDelta = 0, wearCost = 0, minimizeGrid = false }) => (minimizeGrid ? 0 : minPriceDelta) + wearCost;

// A slot over its import limit (net: the planner's net of that slot).
const overLimitNet = (n) => Number.isFinite(n.limitW) && n.limitW !== null && (Number(n.deficitW) || 0) > n.limitW;

// Self-consumption with wear: per slot whether a kWh of surplus is worth storing on the real prices
// (the penalty left out): a later price, or the mean at the end, must pay the losses and the wear.
// Before a slot over the import limit always (the energy shaves the peak). A later export price
// counts only with allowExport. netAt: the net per slot.
const surplusWorthStoring = ({
  prices, exportPrices, netAt = () => ({}), wearCost, chargeEff, dischargeEff, allowExport = true,
}) => {
  const exp = (t) => (exportPrices && exportPrices[t] !== undefined ? exportPrices[t] : prices[t]);
  let bestSell = prices.reduce((a, b) => a + b, 0) / prices.length;
  let peakLater = false;
  const worth = new Array(prices.length);
  for (let t = prices.length - 1; t >= 0; t -= 1) {
    worth[t] = peakLater || (bestSell * dischargeEff) - (Math.min(prices[t], exp(t)) / chargeEff) >= wearCost;
    bestSell = Math.max(bestSell, prices[t], allowExport ? exp(t) : -Infinity);
    if (overLimitNet(netAt(t))) peakLater = true;
  }
  return worth;
};

/**
 * Same options and result as RoiStrategy.solve().
 *
 * @returns {object[]} per battery, per slot index: { power, duration, soc, price, exportPrice, block }
 */
const solve = ({
  prices,
  exportPrices = null,
  priceInterval = 60,
  minPriceDelta = 0.1,
  soc = 0,
  startMinute = 0,
  batCapacity = 5.05,
  homePowerUsage = 300,
  net = null,
  peakWindowMin = 15,
  allowGridCharge = true,
  allowExport = true,
  minimizeGrid = false,
  wearCost = 0,
  chargeSpeeds = [{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }],
  dischargeSpeeds = [{ power: 1550, eff: 0.92 }, { power: 765, eff: 0.96 }],
  batteries = null,
}) => {
  // Per kWh charged and per kWh discharged: half the wear and half the minimum profit of a cycle.
  const fc = cycleCostFor({ minPriceDelta, wearCost, minimizeGrid }) * 0.5;
  const bats = (batteries || [{
    soc, batCapacity, chargeSpeeds, dischargeSpeeds,
  }]).map((b) => ({
    ...b,
    startKwh: ((Number(b.soc) || 0) / 100) * b.batCapacity,
    maxChargeW: Math.max(0, ...b.chargeSpeeds.map((s) => s.power)),
    maxDischargeW: Math.max(0, ...b.dischargeSpeeds.map((s) => s.power)),
    effCharge: BatterySplit.efficientSpeed(b.chargeSpeeds),
    effDischarge: BatterySplit.efficientSpeed(b.dischargeSpeeds),
  }));

  // The group as one battery: speeds summed per rank, efficiency weighted by power.
  const sumSpeeds = (key) => {
    const ranked = bats.map((b) => [...b[key]].sort((x, y) => y.power - x.power));
    const n = Math.max(...ranked.map((r) => r.length));
    return Array.from({ length: n }, (_, k) => {
      const at = ranked.map((r) => r[Math.min(k, r.length - 1)]).filter(Boolean);
      const power = at.reduce((a, s) => a + s.power, 0);
      return { power, eff: at.reduce((a, s) => a + (s.power * s.eff), 0) / power };
    });
  };
  const capKwh = bats.reduce((a, b) => a + b.batCapacity, 0);
  const startKwh = bats.reduce((a, b) => a + b.startKwh, 0);
  const vChargeSpeeds = sumSpeeds('chargeSpeeds');
  const vDischargeSpeeds = sumSpeeds('dischargeSpeeds');
  const maxChargeW = Math.max(0, ...vChargeSpeeds.map((s) => s.power));
  const maxDischargeW = Math.max(0, ...vDischargeSpeeds.map((s) => s.power));
  const chargeEff = effCurve(vChargeSpeeds);
  const dischargeEff = effCurve(vDischargeSpeeds);

  const intervalsPerHour = 60 / priceInterval;
  const calcPrices = prices.slice(0, Math.ceil(48 * intervalsPerHour));
  const calcExport = (exportPrices && exportPrices.length > 0) ? exportPrices.slice(0, calcPrices.length) : calcPrices;
  const exportAt = (t) => (calcExport[t] !== undefined ? calcExport[t] : calcPrices[t]);
  const fixedNet = {
    surplusW: Math.max(0, -homePowerUsage),
    deficitW: Math.max(0, homePowerUsage),
    usableSurplusW: Math.max(0, -homePowerUsage),
    usableDeficitW: Math.max(0, homePowerUsage),
    limitW: null,
    penaltyPerKw: null,
  };
  const netAt = (t) => ({ ...fixedNet, ...((Array.isArray(net) && net[t]) || {}) });
  const maxDischargeEffAll = Math.max(...vDischargeSpeeds.map((s) => s.eff), 0);
  const pen = minimizeGrid ? gridKwhPenalty(calcPrices, calcExport) : 0;
  const meanPrice = calcPrices.reduce((a, b) => a + b, 0) / calcPrices.length + pen;
  const terminalValuePerKwh = Math.max(0, (meanPrice * maxDischargeEffAll) - fc);
  const bigPenalty = 10 * (Math.max(...calcPrices.map((p) => Math.abs(p)), 0.1) + pen);
  const windowHours = Math.max(0.25, peakWindowMin / 60);
  const worth = minimizeGrid && wearCost > 0 ? surplusWorthStoring({
    prices: calcPrices,
    exportPrices: calcExport,
    netAt,
    wearCost,
    chargeEff: Math.max(...vChargeSpeeds.map((s) => s.eff), 0),
    dischargeEff: maxDischargeEffAll,
    allowExport,
  }) : null;

  const levels = Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, Math.round(capKwh / LEVEL_KWH)));
  const step = capKwh / levels;
  const startLevel = Math.min(levels, Math.max(0, Math.round(startKwh / step)));
  const T = calcPrices.length;

  // Per slot: its data, and per level move k (-down..+up) the cost and the AC energy.
  const slots = calcPrices.map((price, t) => {
    const n = netAt(t);
    const part = t !== 0 ? 1 : (priceInterval - (startMinute % priceInterval)) / priceInterval;
    const hours = part * (priceInterval / 60);
    const kwh = (w) => (Math.max(0, Number(w) || 0) * hours) / 1000;
    const hasLimit = Number.isFinite(n.limitW) && n.limitW !== null;
    return {
      price: price + pen,
      exportPrice: exportAt(t) - pen,
      hours,
      deficitKwh: kwh(n.deficitW),
      usableSurplusKwh: Math.min(kwh(n.usableSurplusW), kwh(n.surplusW)),
      usableDeficitKwh: Math.min(kwh(n.usableDeficitW), kwh(n.deficitW)),
      limitKwh: hasLimit ? kwh(n.limitW) : Infinity,
      penaltyPerKwh: hasLimit ? ((Number.isFinite(n.penaltyPerKw) && n.penaltyPerKw) || bigPenalty) / windowHours : 0,
      usableSurplusW: Number(n.usableSurplusW) || 0,
      usableDeficitW: Number(n.usableDeficitW) || 0,
      noCharge: !!worth && !worth[t],
    };
  });

  // AC energy per level move, cached per slot length (only the first slot differs).
  const acCache = new Map();
  const movesFor = (hours) => {
    if (acCache.has(hours)) return acCache.get(hours);
    const up = [];
    for (let k = 1; k <= levels; k += 1) {
      const ac = acFor(k * step, hours, maxChargeW, chargeEff, true);
      if (ac === null) break;
      up.push(ac);
    }
    const down = [];
    for (let k = 1; k <= levels; k += 1) {
      const ac = acFor(k * step, hours, maxDischargeW, dischargeEff, false);
      if (ac === null) break;
      down.push(ac);
    }
    const moves = { up, down };
    acCache.set(hours, moves);
    return moves;
  };

  // Cost of a slot with AC charge a or AC discharge d (kWh): grid cost minus what the home without
  // battery pays anyway, plus wear and the import limit penalty. null: not allowed.
  const slotCost = (s, a, d) => {
    // Export above import: valued conservatively, as RoiStrategy.
    const gridBuy = s.usableSurplusKwh > EPS_KWH ? Math.max(s.price, s.exportPrice) : s.price;
    const gridSell = s.usableDeficitKwh > EPS_KWH ? Math.min(s.price, s.exportPrice) : s.exportPrice;
    let cost = 0;
    let importKwh = s.deficitKwh;
    if (a > 0) {
      if (s.noCharge) return null;
      const fromSurplus = Math.min(a, s.usableSurplusKwh);
      const fromGrid = a - fromSurplus;
      if (fromGrid > EPS_KWH && !allowGridCharge) return null;
      cost += (fromSurplus * s.exportPrice) + (fromGrid * gridBuy) + (a * fc);
      importKwh += fromGrid;
    }
    if (d > 0) {
      const toHome = Math.min(d, s.usableDeficitKwh);
      const toGrid = d - toHome;
      if (toGrid > EPS_KWH && !allowExport) return null;
      cost -= (toHome * s.price) + (toGrid * gridSell) - (d * fc);
      importKwh -= toHome;
    }
    if (importKwh > s.limitKwh) cost += (importKwh - s.limitKwh) * s.penaltyPerKwh;
    return cost;
  };

  // Backwards: value[l] = cheapest cost from slot t at level l to the end. policy[t][l] = level at
  // the end of slot t.
  let value = new Float64Array(levels + 1);
  for (let l = 0; l <= levels; l += 1) value[l] = -terminalValuePerKwh * l * step;
  const policy = Array.from({ length: T }, () => new Uint16Array(levels + 1));
  for (let t = T - 1; t >= 0; t -= 1) {
    const s = slots[t];
    const { up, down } = movesFor(s.hours);
    const base = slotCost(s, 0, 0);
    const costUp = up.map((a) => slotCost(s, a, 0));
    const costDown = down.map((d) => slotCost(s, 0, d));
    const next = new Float64Array(levels + 1);
    const pol = policy[t];
    for (let l = 0; l <= levels; l += 1) {
      let best = base + value[l];
      let bestTo = l;
      for (let k = 1; k <= costUp.length && l + k <= levels; k += 1) {
        if (costUp[k - 1] !== null) {
          const c = costUp[k - 1] + value[l + k];
          if (c < best - 1e-12) {
            best = c;
            bestTo = l + k;
          }
        }
      }
      for (let k = 1; k <= costDown.length && l - k >= 0; k += 1) {
        if (costDown[k - 1] !== null) {
          const c = costDown[k - 1] + value[l - k];
          if (c < best - 1e-12) {
            best = c;
            bestTo = l - k;
          }
        }
      }
      next[l] = best;
      pol[l] = bestTo;
    }
    value = next;
  }

  // Forwards: the group's AC energy per slot, then per battery.
  const stored = bats.map((b) => b.startKwh);
  const results = bats.map(() => ({}));
  const lastW = bats.map(() => 0);
  let level = startLevel;
  for (let t = 0; t < T; t += 1) {
    const s = slots[t];
    const to = policy[t][level];
    const { up, down } = movesFor(s.hours);
    const a = to > level ? up[to - level - 1] : 0;
    const d = to < level ? down[level - to - 1] : 0;
    const dcKwh = (to - level) * step;
    level = to;
    const gridCharge = a - Math.min(a, s.usableSurplusKwh) > EPS_KWH;
    const gridExport = d - Math.min(d, s.usableDeficitKwh) > EPS_KWH;
    // Split over the batteries in AC W; a battery's room or charge caps its share.
    const groupAc = a || d;
    const totalW = (groupAc * 1000) / s.hours;
    const charging = dcKwh > 0;
    const share = Math.abs(dcKwh) > 0 && totalW > 0 ? BatterySplit.split(bats.map((b, i) => {
      const energy = charging ? b.batCapacity - stored[i] : stored[i];
      return {
        socPct: (100 * stored[i]) / b.batCapacity,
        speed: charging ? b.effCharge : b.effDischarge,
        maxW: Math.min(charging ? b.maxChargeW : b.maxDischargeW, (energy / Math.abs(dcKwh)) * totalW),
        active: charging ? lastW[i] > 0 : lastW[i] < 0,
      };
    }), totalW, charging) : bats.map(() => 0);
    const totalShare = share.reduce((acc, v) => acc + v, 0) || 1;
    const sign = dcKwh > 0 ? 1 : -1;
    bats.forEach((b, i) => {
      const part = Math.abs(dcKwh) > 0 ? share[i] / totalShare : 0;
      stored[i] = Math.min(b.batCapacity, Math.max(0, stored[i] + (sign * part * Math.abs(dcKwh))));
      const acKwh = part * groupAc;
      const power = (acKwh * 1000) / s.hours < 10 ? 0 : Math.round(sign * ((acKwh * 1000) / s.hours));
      let block;
      let quiet = false;
      if (power > 0) block = gridCharge ? 'charge' : 'zero';
      else if (power < 0) block = gridExport ? 'discharge' : 'zero';
      else ({ block, quiet = false } = zeroPowerBlock(s, stored[i]));
      const durationMin = Math.round(s.hours * 60);
      results[i][t] = {
        power,
        duration: power ? durationMin : 0,
        soc: Math.min(100, Math.max(0, Math.round(100 * (stored[i] / b.batCapacity)))),
        price: calcPrices[t],
        exportPrice: exportAt(t),
        block,
        ...(quiet ? { quiet: true } : {}),
        ...(s.noCharge ? { noCharge: true } : {}),
      };
      lastW[i] = power;
    });
  }
  return results;
};

const getStrategy = (options) => solve({ ...options, batteries: null })[0];
const getGroupStrategy = (options) => solve(options);

// Mode idle: nothing planned, per battery (options.batteries) or one; same result shape.
const idleStrategy = ({
  prices, exportPrices = null, priceInterval = 60, soc = 0, batteries = null,
}) => {
  const n = Math.min(prices.length, Math.ceil(48 * (60 / priceInterval)));
  const plan = (pct) => Object.fromEntries(Array.from({ length: n }, (_, t) => [t, {
    power: 0,
    duration: 0,
    soc: Math.round(Number(pct) || 0),
    price: prices[t],
    exportPrice: exportPrices && exportPrices[t] !== undefined ? exportPrices[t] : prices[t],
    block: 'idle',
  }]));
  return batteries ? batteries.map((b) => plan(b.soc)) : plan(soc);
};

module.exports = {
  getStrategy,
  getGroupStrategy,
  idleStrategy,
  effCurve,
  gridKwhPenalty,
  cycleCostFor,
  surplusWorthStoring,
  zeroPowerBlock,
};
