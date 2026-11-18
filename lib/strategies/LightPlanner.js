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

const BatterySplit = require('./BatterySplit');
const BatteryEfficiency = require('./BatteryEfficiency');
const BatteryUse = require('./BatteryUse');
const { boundMissKwh } = require('./BatteryCalibration');

const EPS_KWH = 0.001;

const zeroPowerBlock = ({ usableSurplusW = 0, usableDeficitW = 0 }, storedKwh, solarPays = true) => {
  if (usableSurplusW > 0) return { block: 'idle' };
  if (usableDeficitW > 0) return { block: storedKwh > EPS_KWH && solarPays ? 'hold' : 'idle' };
  return solarPays ? { block: 'hold', quiet: true } : { block: 'idle' };
};
const MAX_GAP_MIN = 30;
const BRIDGE_MAX_SHARE = 0.03;

const bridgeGaps = (strategies, { priceInterval = 60, limited = () => false } = {}) => {
  const maxGap = Math.floor(MAX_GAP_MIN / priceInterval);
  if (maxGap < 1) return strategies;
  strategies.forEach((st) => {
    const n = Object.keys(st).length;
    let i = 0;
    while (i < n) {
      const { block } = st[i] || {};
      if (block !== 'charge' && block !== 'discharge') {
        i += 1;
        continue;
      }
      let last = i;
      for (let j = i + 1; j < n && j - last <= maxGap + 1; j += 1) {
        if (st[j].block === block) last = j;
        else if (st[j].power !== 0 || limited(j)) break;
      }
      const run = [];
      for (let j = i; j <= last; j += 1) run.push(j);
      if (run.some((j) => st[j].block !== block)) {
        const dur = (j) => (st[j].block === block ? st[j].duration : priceInterval);
        const totalMin = run.reduce((a, j) => a + dur(j), 0);
        const wh = run.reduce((a, j) => a + st[j].power * dur(j), 0);
        const power = Math.round(wh / totalMin);
        const priceOf = (j) => (block === 'charge' ? st[j].price : st[j].exportPrice);
        const cost = (pw) => run.reduce((a, j) => a + ((pw(j) * dur(j)) / 60000) * priceOf(j), 0);
        const extra = cost(() => power) - cost((j) => (st[j].block === block ? st[j].power : 0));
        const base = run.reduce((a, j) => a + Math.abs((st[j].block === block ? st[j].power * dur(j) : 0) / 60000) * Math.abs(priceOf(j)), 0);
        if (extra <= BRIDGE_MAX_SHARE * base) {
          const socBefore = i > 0 ? st[i - 1].soc : st[i].soc;
          const socEnd = st[last].soc;
          let done = 0;
          run.forEach((j) => {
            done += dur(j);
            const { quiet, homeCapW, ...rest } = st[j];
            st[j] = {
              ...rest, power, duration: dur(j), block, soc: Math.round(socBefore + ((socEnd - socBefore) * done) / totalMin),
            };
          });
        }
      }
      i = last + 1;
    }
  });
  return strategies;
};

const LEVEL_KWH = 0.025;
const PART_SHARE = 0.03;
const MIN_LEVELS = 100;
const MAX_LEVELS = 400;

const effCurve = (speeds) => {
  const list = speeds.filter((s) => s.power > 0 && s.eff > 0).sort((a, b) => a.power - b.power);
  return (powerW) => {
    let best = 0;
    list.forEach((s, k) => {
      if (s.power >= powerW) best = Math.max(best, s.eff);
      const next = list[k + 1];
      if (next && powerW > s.power && powerW < next.power) {
        const f = (powerW - s.power) / (next.power - s.power);
        best = Math.max(best, (((1 - f) * s.power * s.eff) + (f * next.power * next.eff)) / powerW);
      }
    });
    return best;
  };
};

const steadyEffCurve = (speeds, dir) => {
  const curve = effCurve(speeds);
  const list = speeds.filter((s) => s.power > 0 && s.eff > 0);
  const lowW = Math.min(...list.map((s) => s.power));
  const fit = BatteryEfficiency.fitSpeeds(list, dir);
  return (powerW) => (powerW >= lowW || !fit ? curve(powerW) : Math.min(curve(powerW), BatteryEfficiency.effAt(fit, powerW, dir)));
};

const steadyOf = (b) => ({
  charge: { eff: steadyEffCurve(b.chargeSpeeds, 'charge'), maxW: Math.max(0, ...b.chargeSpeeds.map((sp) => sp.power)) },
  discharge: { eff: steadyEffCurve(b.dischargeSpeeds, 'discharge'), maxW: Math.max(0, ...b.dischargeSpeeds.map((sp) => sp.power)) },
});

const MIN_FOLLOW_EFF = 0.05;
const followEff = (curve, needW) => (needW > 0 ? Math.max(MIN_FOLLOW_EFF, curve.eff(Math.min(needW, curve.maxW))) : null);

const gridPays = ({
  prices, exportPrices, buy, sell, overLimit, allowGridCharge, allowExport, chargeEff, dischargeEff, fc, terminal,
}) => {
  const n = prices.length;
  const gridCharge = new Array(n).fill(false);
  const exportTo = new Array(n).fill(false);
  if (allowGridCharge) {
    let bestSell = -Infinity;
    let peakLater = false;
    for (let t = n - 1; t >= 0; t -= 1) {
      const cost = prices[t] / chargeEff;
      gridCharge[t] = peakLater || terminal - cost >= fc || (bestSell * dischargeEff) - cost >= fc;
      if (sell[t] !== null) bestSell = Math.max(bestSell, sell[t]);
      if (overLimit[t]) peakLater = true;
    }
  }
  if (allowExport) {
    let minBuy = Infinity;
    for (let t = 0; t < n; t += 1) {
      exportTo[t] = (exportPrices[t] - fc) * dischargeEff >= terminal || (exportPrices[t] * dischargeEff) - (minBuy / chargeEff) >= fc;
      if (buy[t] !== null) minBuy = Math.min(minBuy, buy[t]);
    }
  }
  return { gridCharge, exportTo };
};

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

const gridKwhPenalty = (prices, exportPrices) => 10 * Math.max(0.1, ...prices.map(Math.abs), ...(exportPrices || []).map(Math.abs));

const solarFields = (minW) => {
  if (minW === Infinity) return { noCharge: true };
  return minW > 0 ? { minSolarW: minW } : {};
};

const cycleCostFor = ({ minPriceDelta = 0, wearCost = 0, minimizeGrid = false }) => (minimizeGrid ? 0 : minPriceDelta) + wearCost;

const overLimitNet = (n) => Number.isFinite(n.limitW) && n.limitW !== null && (Number(n.deficitW) || 0) > n.limitW;

const SOLAR_STEP_W = 10;
const solarMinW = ({
  prices, exportPrices, netAt = () => ({}), cycleCost, chargeEffAt, maxChargeW, dischargeEff, allowExport = true,
}) => {
  const exp = (t) => (exportPrices && exportPrices[t] !== undefined ? exportPrices[t] : prices[t]);
  const effs = [];
  for (let w = SOLAR_STEP_W; w <= Math.max(SOLAR_STEP_W, maxChargeW); w += SOLAR_STEP_W) effs.push([w, chargeEffAt(w)]);
  let bestSell = prices.reduce((a, b) => a + b, 0) / prices.length;
  let peakLater = false;
  const minW = new Array(prices.length);
  for (let t = prices.length - 1; t >= 0; t -= 1) {
    const buy = Math.min(prices[t], exp(t));
    const sellValue = bestSell * dischargeEff;
    const hit = peakLater ? effs[0] : effs.find(([, eff]) => eff > 0 && sellValue - (buy / eff) >= cycleCost);
    if (!hit) minW[t] = Infinity;
    else minW[t] = hit === effs[0] ? 0 : hit[0];
    bestSell = Math.max(bestSell, prices[t], allowExport ? exp(t) : -Infinity);
    if (overLimitNet(netAt(t))) peakLater = true;
  }
  return minW;
};

const solarMinWFor = ({
  bats, prices, exportPrices, netAt, cycleCost, minimizeGrid, allowExport,
}) => {
  if (minimizeGrid && !(cycleCost > 0)) return null;
  const curves = bats.map((b) => steadyOf(b).charge);
  return solarMinW({
    prices,
    exportPrices,
    netAt,
    cycleCost,
    chargeEffAt: (w) => Math.max(0, ...curves.filter((c) => w <= c.maxW).map((c) => c.eff(w))),
    maxChargeW: Math.max(0, ...curves.map((c) => c.maxW)),
    dischargeEff: Math.max(...bats.flatMap((b) => b.dischargeSpeeds.map((sp) => sp.eff))),
    allowExport,
  });
};

const dpSlot = (value, next, pol, levels, base, up, costUp, down, costDown, lim) => {
  const {
    hours, step, cA, cB, dA, dB,
  } = lim;
  const limC = !Number.isNaN(cA);
  const limD = !Number.isNaN(dA);
  for (let l = 0; l <= levels; l += 1) {
    let best = base + value[l];
    let bestTo = l;
    for (let k = 1; k <= costUp.length && l + k <= levels; k += 1) {
      if (limC && k > 1 && up[k - 1] * 1000 > hours * (cA - (cB * (l + (k / 2)) * step))) break;
      const cost = costUp[k - 1];
      if (!Number.isNaN(cost)) {
        const c = cost + value[l + k];
        if (c < best - 1e-12) {
          best = c;
          bestTo = l + k;
        }
      }
    }
    for (let k = 1; k <= costDown.length && l - k >= 0; k += 1) {
      if (limD && k > 1 && down[k - 1] * 1000 > hours * (dA + (dB * (l - (k / 2)) * step))) break;
      const cost = costDown[k - 1];
      if (!Number.isNaN(cost)) {
        const c = cost + value[l - k];
        if (c < best - 1e-12) {
          best = c;
          bestTo = l - k;
        }
      }
    }
    next[l] = best;
    pol[l] = bestTo;
  }
};

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
  socBounds = null,
  chargeLimit = null,
  dischargeLimit = null,
  batteries = null,
}) => {
  const cycleCost = cycleCostFor({ minPriceDelta, wearCost, minimizeGrid });
  const fc = cycleCost * 0.5;
  const bats = (batteries || [{
    soc, batCapacity, chargeSpeeds, dischargeSpeeds, socBounds, chargeLimit, dischargeLimit,
  }]).map((b) => ({
    ...b,
    startKwh: ((Number(b.soc) || 0) / 100) * b.batCapacity,
    maxChargeW: Math.max(0, ...b.chargeSpeeds.map((s) => s.power)),
    maxDischargeW: Math.max(0, ...b.dischargeSpeeds.map((s) => s.power)),
    effCharge: BatterySplit.efficientSpeed(b.chargeSpeeds),
    effDischarge: BatterySplit.efficientSpeed(b.dischargeSpeeds),
  }));

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
  const groupLimit = (key) => {
    if (!bats.some((b) => b[key])) return null;
    if (bats.some((b) => !b[key])) return null;
    return {
      a: bats.reduce((acc, b) => acc + b[key].a, 0),
      b: bats.reduce((acc, b) => acc + ((b[key].b * b.batCapacity) / capKwh), 0),
    };
  };
  const limC = groupLimit('chargeLimit');
  const limD = groupLimit('dischargeLimit');

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
  const solarMin = solarMinWFor({
    bats, prices: calcPrices, exportPrices: calcExport, netAt, cycleCost, minimizeGrid, allowExport,
  });

  const levels = Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, Math.round(capKwh / LEVEL_KWH)));
  const step = capKwh / levels;
  const startLevel = Math.min(levels, Math.max(0, Math.round(startKwh / step)));
  const T = calcPrices.length;

  const slots = calcPrices.map((price, t) => {
    const n = netAt(t);
    const part = t !== 0 ? 1 : (priceInterval - (startMinute % priceInterval)) / priceInterval;
    const hours = part * (priceInterval / 60);
    const kwh = (w) => (Math.max(0, Number(w) || 0) * hours) / 1000;
    const hasLimit = Number.isFinite(n.limitW) && n.limitW !== null;
    const minSolarW = solarMin ? solarMin[t] : 0;
    return {
      price: price + pen,
      exportPrice: exportAt(t) - pen,
      hours,
      deficitKwh: kwh(n.deficitW),
      usableSurplusKwh: (Number(n.usableSurplusW) || 0) >= minSolarW ? Math.min(kwh(n.usableSurplusW), kwh(n.surplusW)) : 0,
      usableDeficitKwh: Math.min(kwh(n.usableDeficitW), kwh(n.deficitW)),
      limitKwh: hasLimit ? kwh(n.limitW) : Infinity,
      penaltyPerKwh: hasLimit ? ((Number.isFinite(n.penaltyPerKw) && n.penaltyPerKw) || bigPenalty) / windowHours : 0,
      usableSurplusW: Number(n.usableSurplusW) || 0,
      usableDeficitW: Number(n.usableDeficitW) || 0,
      noCharge: minSolarW === Infinity,
      minSolarW,
    };
  });

  const best = (a, b) => {
    if (a === null) return b;
    return b === null ? a : Math.min(a, b);
  };
  const buyOf = (s) => best(s.usableSurplusKwh > EPS_KWH ? Math.min(s.price, s.exportPrice) : null, allowGridCharge ? s.price : null);
  const sellOf = (s) => {
    const home = s.usableDeficitKwh > EPS_KWH ? Math.max(s.price, s.exportPrice) : null;
    const grid = allowExport ? s.exportPrice : null;
    if (home === null) return grid;
    return grid === null ? home : Math.max(home, grid);
  };
  const pays = gridPays({
    prices: slots.map((s) => s.price),
    exportPrices: slots.map((s) => s.exportPrice),
    buy: slots.map(buyOf),
    sell: slots.map(sellOf),
    overLimit: slots.map((s) => s.deficitKwh > s.limitKwh),
    allowGridCharge,
    allowExport,
    chargeEff: Math.max(...vChargeSpeeds.map((sp) => sp.eff), 0),
    dischargeEff: maxDischargeEffAll,
    fc,
    terminal: terminalValuePerKwh,
  });
  const steady = bats.map(steadyOf);
  const groupFollow = (dir, kwhIn, hours) => {
    const effs = steady.map((c) => followEff(c[dir], (kwhIn * 1000) / hours)).filter((e) => e !== null);
    return effs.length ? Math.round(Math.max(...effs) * 100) / 100 : null;
  };
  slots.forEach((s, t) => {
    s.followC = pays.gridCharge[t] ? null : groupFollow('charge', s.usableSurplusKwh, s.hours);
    s.followD = pays.exportTo[t] ? null : groupFollow('discharge', s.usableDeficitKwh, s.hours);
  });

  const acCache = new Map();
  const movesDir = (hours, follow, charging) => {
    const key = `${charging ? 'c' : 'd'}|${hours}|${follow}`;
    if (acCache.has(key)) return acCache.get(key);
    const base = charging ? chargeEff : dischargeEff;
    const eff = follow === null ? base : (w) => Math.min(base(w), follow);
    const list = [];
    for (let k = 1; k <= levels; k += 1) {
      const ac = acFor(k * step, hours, charging ? maxChargeW : maxDischargeW, eff, charging);
      if (ac === null) break;
      list.push(ac);
    }
    const moves = Float64Array.from(list);
    acCache.set(key, moves);
    return moves;
  };
  const movesFor = (s) => ({ up: movesDir(s.hours, s.followC, true), down: movesDir(s.hours, s.followD, false) });

  const slotCost = (s, a, d) => {
    const gridBuy = s.usableSurplusKwh > EPS_KWH ? Math.max(s.price, s.exportPrice) : s.price;
    const gridSell = s.usableDeficitKwh > EPS_KWH ? Math.min(s.price, s.exportPrice) : s.exportPrice;
    let cost = 0;
    let importKwh = s.deficitKwh;
    if (a > 0) {
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

  let value = new Float64Array(levels + 1);
  for (let l = 0; l <= levels; l += 1) value[l] = -terminalValuePerKwh * l * step;
  let next = new Float64Array(levels + 1);
  const policy = Array.from({ length: T }, () => new Uint16Array(levels + 1));
  const bounds = bats.length === 1 ? bats[0].socBounds || null : null;
  const costsOf = (s, moves, charging) => {
    const costs = new Float64Array(moves.length);
    for (let k = 0; k < moves.length; k += 1) {
      const c = charging ? slotCost(s, moves[k], 0) : slotCost(s, 0, moves[k]);
      costs[k] = c === null ? NaN : c;
    }
    return costs;
  };
  const lim = {
    hours: 0,
    step,
    cA: limC ? limC.a : NaN,
    cB: limC ? limC.b : NaN,
    dA: limD ? limD.a : NaN,
    dB: limD ? limD.b : NaN,
  };
  for (let t = T - 1; t >= 0; t -= 1) {
    const s = slots[t];
    if (bounds && bounds[t]) {
      for (let l = 0; l <= levels; l += 1) value[l] += bigPenalty * boundMissKwh(bounds[t], l * step, capKwh);
    }
    const { up, down } = movesFor(s);
    lim.hours = s.hours;
    dpSlot(value, next, policy[t], levels, slotCost(s, 0, 0), up, costsOf(s, up, true), down, costsOf(s, down, false), lim);
    [value, next] = [next, value];
  }

  const stored = bats.map((b) => b.startKwh);
  const used = bats.map((b) => Number(b.cycles) || 0);
  const costClass = BatteryUse.costClasses(bats.map((b) => ({
    wear: b.wear ?? wearCost, effC: b.effCharge.eff, effD: b.effDischarge.eff,
  })), BatteryUse.refPrice(calcPrices));
  const results = bats.map(() => ({}));
  const lastW = bats.map(() => 0);
  let level = startLevel;
  for (let t = 0; t < T; t += 1) {
    const s = slots[t];
    const to = policy[t][level];
    const { up, down } = movesFor(s);
    const a = to > level ? up[to - level - 1] : 0;
    const d = to < level ? down[level - to - 1] : 0;
    const dcKwh = (to - level) * step;
    level = to;
    const gridCharge = a - Math.min(a, s.usableSurplusKwh) > (s.usableSurplusKwh > EPS_KWH ? step : EPS_KWH);
    const gridExport = d - Math.min(d, s.usableDeficitKwh) > (s.usableDeficitKwh > EPS_KWH ? step : EPS_KWH);
    const homePart = d > 0 && s.usableDeficitKwh - d > Math.max(step, PART_SHARE * s.usableDeficitKwh);
    const groupAc = a || d;
    const totalW = (groupAc * 1000) / s.hours;
    const charging = dcKwh > 0;
    const share = Math.abs(dcKwh) > 0 && totalW > 0 ? BatterySplit.split(bats.map((b, i) => {
      const energy = charging ? b.batCapacity - stored[i] : stored[i];
      const lim = charging ? b.chargeLimit : b.dischargeLimit;
      const taperW = lim ? Math.max(0, lim.a + ((charging ? -1 : 1) * lim.b * stored[i])) : Infinity;
      return {
        socPct: (100 * stored[i]) / b.batCapacity,
        speed: charging ? b.effCharge : b.effDischarge,
        maxW: Math.min(charging ? b.maxChargeW : b.maxDischargeW, (energy / Math.abs(dcKwh)) * totalW, taperW),
        active: charging ? lastW[i] > 0 : lastW[i] < 0,
        costClass: costClass[i],
        cycles: used[i],
      };
    }), totalW, charging) : bats.map(() => 0);
    const totalShare = share.reduce((acc, v) => acc + v, 0) || 1;
    const sign = dcKwh > 0 ? 1 : -1;
    bats.forEach((b, i) => {
      const part = Math.abs(dcKwh) > 0 ? share[i] / totalShare : 0;
      stored[i] = Math.min(b.batCapacity, Math.max(0, stored[i] + (sign * part * Math.abs(dcKwh))));
      used[i] += (part * Math.abs(dcKwh)) / (2 * b.batCapacity);
      const acKwh = part * groupAc;
      const power = (acKwh * 1000) / s.hours < 10 ? 0 : Math.round(sign * ((acKwh * 1000) / s.hours));
      let block;
      let quiet = false;
      if (power > 0) block = gridCharge ? 'charge' : 'hold';
      else if (power < 0) block = gridExport ? 'discharge' : 'xom';
      else ({ block, quiet = false } = zeroPowerBlock(s, stored[i], minimizeGrid || !s.noCharge));
      const durationMin = Math.round(s.hours * 60);
      results[i][t] = {
        power,
        duration: power ? durationMin : 0,
        soc: Math.min(100, Math.max(0, Math.round(100 * (stored[i] / b.batCapacity)))),
        price: calcPrices[t],
        exportPrice: exportAt(t),
        block,
        ...(quiet ? { quiet: true } : {}),
        ...(block === 'xom' && homePart ? { homeCapW: -power } : {}),
        ...solarFields(s.minSolarW),
      };
      lastW[i] = power;
    });
  }
  return bridgeGaps(results, { priceInterval, limited: (t) => Number.isFinite(netAt(t).limitW) });
};

const plan = (options) => solve({ ...options, batteries: null })[0];
const planEach = (options) => solve(options);

const idlePlan = ({
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
  plan,
  planEach,
  idlePlan,
  effCurve,
  gridKwhPenalty,
  cycleCostFor,
  solarMinW,
  solarMinWFor,
  steadyOf,
  followEff,
  gridPays,
  solarFields,
  steadyEffCurve,
  zeroPowerBlock,
  bridgeGaps,
  PART_SHARE,
};
