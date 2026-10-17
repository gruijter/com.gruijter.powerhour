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

const solver = require('javascript-lp-solver');
const {
  gridKwhPenalty, cycleCostFor, solarMinWFor, solarFields, zeroPowerBlock,
} = require('./RoiLightStrategy');
const BatterySplit = require('./BatterySplit');

// Battery plan as an LP over the coming slots. Charging takes the solar surplus first (export
// price), discharging covers the home deficit first (import price); export > import is valued
// conservatively. Each slot gets a block type for the controller:
//   zero      zero on the meter: charge surplus / cover deficit only
//   hold      no discharging (keep energy for later), surplus may charge
//   idle      nothing: surplus to the grid, deficit from the grid
//   charge    charge from the grid too, to the slot's SoC
//   discharge discharge to the grid too, to the slot's SoC

const BLOCKS = ['zero', 'hold', 'idle', 'charge', 'discharge'];
const EPS_KWH = 0.001;
const MAX_LP_STEPS = 72;
// Tie-break: with export = import, surplus and home deficit are taken before the grid.
const TIE_KWH = 0.0001;
const round4 = (v) => Math.round(v * 10000) / 10000;

// Batteries with the same speeds and efficiencies cost the LP the same, so its split of a step
// over them is arbitrary: per such set the step's power and stored energy again by BatterySplit
// (the set's totals, and so the cost, stay). A set keeps the LP's split when one of them charges
// while another discharges, or when a battery's room or charge does not allow the split.
// flows[b][t]: { avgKw, energyChange (kWh stored) }.
const rebalance = (bats, flows) => {
  const sig = (b) => JSON.stringify(['chargeSpeeds', 'dischargeSpeeds']
    .map((k) => b[k].map((sp) => [sp.power, Math.round(sp.eff * 100)]).sort((x, y) => x[0] - y[0])));
  const sets = new Map();
  bats.forEach((b, i) => sets.set(sig(b), [...(sets.get(sig(b)) || []), i]));
  sets.forEach((set) => {
    if (set.length < 2) return;
    const steps = flows[set[0]].length;
    for (let t = 0; t < steps; t += 1) {
      if (set.some((i) => flows[i][t].avgKw > 0.01) && set.some((i) => flows[i][t].avgKw < -0.01)) return;
    }
    const speeds = set.map((i) => ({
      maxC: Math.max(0, ...bats[i].chargeSpeeds.map((sp) => sp.power)),
      maxD: Math.max(0, ...bats[i].dischargeSpeeds.map((sp) => sp.power)),
      effC: BatterySplit.efficientSpeed(bats[i].chargeSpeeds),
      effD: BatterySplit.efficientSpeed(bats[i].dischargeSpeeds),
    }));
    const stored = set.map((i) => bats[i].startSoC);
    const lastKw = set.map(() => 0);
    const out = set.map(() => []);
    for (let t = 0; t < steps; t += 1) {
      const kw = set.reduce((a, i) => a + flows[i][t].avgKw, 0);
      const dc = set.reduce((a, i) => a + flows[i][t].energyChange, 0);
      const totalW = Math.abs(kw) * 1000;
      const charging = kw > 0;
      const share = totalW >= 10 && Math.abs(dc) > 1e-9 ? BatterySplit.split(set.map((i, j) => {
        const energy = charging ? bats[i].batCapacity - stored[j] : stored[j];
        return {
          socPct: (100 * stored[j]) / bats[i].batCapacity,
          speed: charging ? speeds[j].effC : speeds[j].effD,
          maxW: Math.min(charging ? speeds[j].maxC : speeds[j].maxD, (Math.max(0, energy) / Math.abs(dc)) * totalW),
          active: charging ? lastKw[j] > 0.01 : lastKw[j] < -0.01,
        };
      }), totalW, charging) : null;
      if (share && share.reduce((a, v) => a + v, 0) < totalW * 0.999 - 1) return;
      set.forEach((i, j) => {
        out[j][t] = share
          ? { avgKw: (Math.sign(kw) * share[j]) / 1000, energyChange: (share[j] / totalW) * dc }
          : flows[i][t];
        stored[j] += out[j][t].energyChange;
        lastKw[j] = out[j][t].avgKw;
      });
    }
    set.forEach((i, j) => {
      flows[i] = out[j];
    });
  });
};

/**
 * One battery, or with `batteries` several planned together: per battery its own SoC, capacity,
 * speeds and efficiencies; the surplus, the deficit and the import limit are shared. Each battery
 * gets its own strategy (getGroupStrategy()).
 *
 * @param {object} o
 * @param {number[]} o.prices - import price per slot
 * @param {number[]} [o.exportPrices] - export price per slot; prices when missing
 * @param {number} [o.priceInterval] - slot length in minutes
 * @param {number} [o.minPriceDelta] - minimum profit per kWh for a charge/discharge cycle, on top
 *   of losses and wear; not with minimizeGrid
 * @param {number} [o.wearCost] - wear per kWh cycled (charged and discharged again).
 *   Surplus is stored only where it pays the losses at its power and the cycle cost (noCharge,
 *   minSolarW slots); with minimizeGrid only when there is wear.
 * @param {number} [o.soc] - SoC (%) now
 * @param {number} [o.startMinute] - local minute now (the first slot is partial)
 * @param {number} [o.batCapacity] - kWh
 * @param {number} [o.homePowerUsage] - W, fixed home use when `net` is missing
 * @param {Array<object>} [o.net] - per slot, averages in W over the slot: { surplusW, deficitW,
 *   usableSurplusW (surplus the battery may take: 0 below the charge threshold), usableDeficitW
 *   (deficit it may cover: 0 below the discharge threshold, EV excluded when not allowed),
 *   limitW (max. grid import, null: none), penaltyPerKw (cost of one kW above limitW) }
 * @param {number} [o.peakWindowMin] - window of limitW, for the penalty per kWh
 * @param {boolean} [o.allowGridCharge] - false: charge from surplus only
 * @param {boolean} [o.allowExport] - false: discharge into the home only
 * @param {boolean} [o.minimizeGrid] - least import and export first, cost second (gridKwhPenalty())
 * @param {Array<{power:number, eff:number}>} [o.chargeSpeeds] - AC power (W), efficiency
 * @param {Array<{power:number, eff:number}>} [o.dischargeSpeeds]
 * @param {Array<{soc, batCapacity, chargeSpeeds, dischargeSpeeds}>} [o.batteries] - several
 *   batteries; replaces soc, batCapacity, chargeSpeeds and dischargeSpeeds
 * @returns {object[]} per battery, per slot index: { power (W, + charge), duration (min), soc (%
 *   at slot end), price, exportPrice, block, noCharge (true: no surplus storing), minSolarW (surplus
 *   stored only above) }
 */
const solve = ({
  prices,
  exportPrices = null,
  priceInterval = 60,
  minPriceDelta = 0.1,
  soc = 0,
  startMinute = 0,
  batCapacity = 5.05, // Sessy
  homePowerUsage = 300,
  net = null,
  peakWindowMin = 15,
  allowGridCharge = true,
  allowExport = true,
  minimizeGrid = false,
  wearCost = 0,
  chargeSpeeds = [{ power: 2200, eff: 0.9 }, { power: 1050, eff: 0.95 }], // Sessy
  dischargeSpeeds = [{ power: 1550, eff: 0.92 }, { power: 765, eff: 0.96 }], // Sessy
  batteries = null,
}) => {
  const cycleCost = cycleCostFor({ minPriceDelta, wearCost, minimizeGrid });
  const fc = cycleCost * 0.5; // per kWh charged and per kWh discharged
  const bats = (batteries || [{
    soc, batCapacity, chargeSpeeds, dischargeSpeeds,
  }]).map((b) => ({ ...b, startSoC: round4(((Number(b.soc) || 0) / 100) * b.batCapacity) }));
  const anyStored = bats.some((b) => b.startSoC > 0.0001);

  const intervalsPerHour = 60 / priceInterval;
  const maxInputSlots = Math.ceil(48 * intervalsPerHour);
  const calcPrices = prices.slice(0, maxInputSlots);
  const calcExportPrices = (exportPrices && exportPrices.length > 0) ? exportPrices.slice(0, maxInputSlots) : calcPrices;
  const exportAt = (t) => (calcExportPrices[t] !== undefined ? calcExportPrices[t] : calcPrices[t]);

  // Home without battery per slot (W). Without a forecast: the fixed home use.
  const fixedNet = {
    surplusW: Math.max(0, -homePowerUsage),
    deficitW: Math.max(0, homePowerUsage),
    usableSurplusW: Math.max(0, -homePowerUsage),
    usableDeficitW: Math.max(0, homePowerUsage),
    limitW: null,
    penaltyPerKw: null,
  };
  const netAt = (t) => ({ ...fixedNet, ...((Array.isArray(net) && net[t]) || {}) });

  const maxChargeEff = Math.max(...bats.flatMap((b) => b.chargeSpeeds.map((sp) => sp.eff)));
  const maxDischargeEff = Math.max(...bats.flatMap((b) => b.dischargeSpeeds.map((sp) => sp.eff)));
  const pen = minimizeGrid ? gridKwhPenalty(calcPrices, exportPrices && exportPrices.length > 0 ? calcExportPrices : null) : 0;
  const meanPrice = calcPrices.reduce((a, b) => a + b, 0) / calcPrices.length + pen;
  // Value per kWh still stored at the end of the horizon.
  const terminalValuePerKwh = Math.max(0, (meanPrice * maxDischargeEff) - fc);
  const solarMin = solarMinWFor({
    bats, prices: calcPrices, exportPrices: calcExportPrices, netAt, cycleCost, minimizeGrid, allowExport,
  });
  const minSolarAt = (t) => (solarMin ? solarMin[t] : 0);
  // A (merged) step: the highest of its slots (plan and control then agree on every slot of it).
  const stepMinSolarW = (s) => Math.max(...s.originalIndices.map(minSolarAt));
  const stepNoCharge = (s) => stepMinSolarW(s) === Infinity;

  // 1. Steps: one per slot, energies in kWh over the (partial first) slot.
  const steps = calcPrices.map((price, t) => {
    const n = netAt(t);
    const part = t !== 0 ? 1 : (priceInterval - (startMinute % priceInterval)) / priceInterval;
    const durationHours = part * (priceInterval / 60);
    const kwh = (w) => (Math.max(0, Number(w) || 0) * durationHours) / 1000;
    const hasLimit = Number.isFinite(n.limitW) && n.limitW !== null;
    return {
      price: price + pen,
      exportPrice: exportAt(t) - pen,
      durationHours,
      surplusKwh: kwh(n.surplusW),
      deficitKwh: kwh(n.deficitW),
      // Surplus below what pays its storing is left to the grid.
      usableSurplusKwh: (Number(n.usableSurplusW) || 0) >= minSolarAt(t) ? Math.min(kwh(n.usableSurplusW), kwh(n.surplusW)) : 0,
      usableDeficitKwh: Math.min(kwh(n.usableDeficitW), kwh(n.deficitW)),
      limitKwh: hasLimit ? kwh(n.limitW) : Infinity,
      penaltyPerKw: hasLimit && Number.isFinite(n.penaltyPerKw) ? n.penaltyPerKw : 0,
      originalIndices: [t],
    };
  });

  const merge = (s1, s2) => {
    const totalDur = s1.durationHours + s2.durationHours;
    return {
      price: (s1.price * s1.durationHours + s2.price * s2.durationHours) / totalDur,
      exportPrice: (s1.exportPrice * s1.durationHours + s2.exportPrice * s2.durationHours) / totalDur,
      durationHours: totalDur,
      surplusKwh: s1.surplusKwh + s2.surplusKwh,
      deficitKwh: s1.deficitKwh + s2.deficitKwh,
      usableSurplusKwh: s1.usableSurplusKwh + s2.usableSurplusKwh,
      usableDeficitKwh: s1.usableDeficitKwh + s2.usableDeficitKwh,
      limitKwh: s1.limitKwh + s2.limitKwh,
      penaltyPerKw: Math.max(s1.penaltyPerKw, s2.penaltyPerKw),
      originalIndices: [...s1.originalIndices, ...s2.originalIndices],
    };
  };

  // What a kWh costs to store in a step, and is worth taken out (null: not possible).
  const buyPrice = (s) => {
    const fromSurplus = s.usableSurplusKwh > EPS_KWH ? Math.min(s.price, s.exportPrice) : null;
    const fromGrid = allowGridCharge ? s.price : null;
    if (fromSurplus === null) return fromGrid;
    return fromGrid === null ? fromSurplus : Math.min(fromSurplus, fromGrid);
  };
  const sellPrice = (s) => {
    const toHome = s.usableDeficitKwh > EPS_KWH ? Math.max(s.price, s.exportPrice) : null;
    const toGrid = allowExport ? s.exportPrice : null;
    if (toHome === null) return toGrid;
    return toGrid === null ? toHome : Math.max(toHome, toGrid);
  };
  const profitable = (buy, sell, delta) => buy !== null && sell !== null
    && (sell * maxDischargeEff) - (buy / maxChargeEff) >= delta;

  // 2. Early exit: empty batteries and no cycle can pay off.
  if (!anyStored) {
    const buys = steps.map(buyPrice).filter((v) => v !== null);
    const sells = steps.map(sellPrice).filter((v) => v !== null);
    const minBuy = buys.length ? Math.min(...buys) : null;
    const maxSell = sells.length ? Math.max(...sells) : null;
    const anyPeak = steps.some((s) => s.limitKwh < s.deficitKwh); // a peak to charge for
    if (!anyPeak && !profitable(minBuy, maxSell, cycleCost)
      && !(minBuy !== null && (terminalValuePerKwh - (minBuy / maxChargeEff)) >= cycleCost)) {
      return bats.map(() => {
        const empty = {};
        calcPrices.forEach((price, t) => {
          empty[t] = {
            power: 0,
            duration: 0,
            soc: 0,
            price,
            exportPrice: exportAt(t),
            ...zeroPowerBlock(netAt(t), 0, minimizeGrid || minSolarAt(t) !== Infinity),
            ...solarFields(minSolarAt(t)),
          };
        });
        return empty;
      });
    }
  }

  // 3. Merge neighbours with the same prices and the same direction of net (flat stretches). A
  // slot over its import limit stays apart: merged, the limits of the others would hide it.
  const overLimit = (s) => s.limitKwh < s.deficitKwh;
  // Merged with a step without a limit, a limit is lost (the sum is Infinity).
  const sameLimit = (a, b) => (a.limitKwh === Infinity) === (b.limitKwh === Infinity);
  const sameNet = (a, b) => (a.surplusKwh > EPS_KWH) === (b.surplusKwh > EPS_KWH)
    && (a.deficitKwh > EPS_KWH) === (b.deficitKwh > EPS_KWH)
    && (a.usableSurplusKwh > EPS_KWH) === (b.usableSurplusKwh > EPS_KWH)
    && (a.usableDeficitKwh > EPS_KWH) === (b.usableDeficitKwh > EPS_KWH)
    && sameLimit(a, b)
    && !overLimit(a) && !overLimit(b);
  let m = 1;
  while (m < steps.length - 1) {
    const s1 = steps[m];
    const s2 = steps[m + 1];
    if (Math.abs(s1.price - s2.price) <= 0.0001 && Math.abs(s1.exportPrice - s2.exportPrice) <= 0.0001 && sameNet(s1, s2)) {
      steps.splice(m, 2, merge(s1, s2));
    } else {
      m += 1;
    }
  }

  // 4. Merge dead zones: no profitable buy (against later sells or the terminal value) and no
  // profitable sell (against earlier buys) possible.
  const canBuyAt = (i) => {
    const buy = buyPrice(steps[i]);
    if (buy === null) return false;
    if ((terminalValuePerKwh - (buy / maxChargeEff)) >= cycleCost) return true;
    for (let j = i + 1; j < steps.length; j += 1) {
      if (profitable(buy, sellPrice(steps[j]), cycleCost)) return true;
    }
    return false;
  };
  const canSellAt = (i) => {
    const sell = sellPrice(steps[i]);
    if (sell === null) return false;
    for (let j = 0; j < i; j += 1) {
      if (profitable(buyPrice(steps[j]), sell, cycleCost)) return true;
    }
    return false;
  };
  const half = cycleCost * 0.5;
  // Energy stored now: worth taking out where that beats keeping it to the end, or where it makes
  // room for a profitable charge later.
  const sellsStored = (i) => {
    const sell = sellPrice(steps[i]);
    if (sell === null) return false;
    if ((sell - fc) * maxDischargeEff >= terminalValuePerKwh) return true;
    for (let j = i + 1; j < steps.length; j += 1) {
      if (profitable(buyPrice(steps[j]), sell, half)) return true;
    }
    return false;
  };
  const isDeadZone = (i) => {
    if (anyStored && sellsStored(i)) return false;
    if (overLimit(steps[i])) return false; // a peak to shave
    return !canBuyAt(i) && !canSellAt(i);
  };
  let dz = 1;
  while (dz < steps.length - 1) {
    if (sameLimit(steps[dz], steps[dz + 1]) && isDeadZone(dz) && isDeadZone(dz + 1)) {
      steps.splice(dz, 2, merge(steps[dz], steps[dz + 1]));
    } else {
      dz += 1;
    }
  }

  // 5. At most MAX_LP_STEPS: merge the most alike neighbours.
  while (steps.length > MAX_LP_STEPS) {
    let minDiff = Infinity;
    let mergeIdx = -1;
    for (let i = 1; i < steps.length - 1; i += 1) {
      const a = steps[i];
      const b = steps[i + 1];
      const diff = Math.abs(a.price - b.price) + Math.abs(a.exportPrice - b.exportPrice) + (sameNet(a, b) ? 0 : 1)
        + (overLimit(a) || overLimit(b) || !sameLimit(a, b) ? 10 : 0) + (stepNoCharge(a) !== stepNoCharge(b) ? 1 : 0);
      if (diff < minDiff) {
        minDiff = diff;
        mergeIdx = i;
      }
    }
    steps.splice(mergeIdx, 2, merge(steps[mergeIdx], steps[mergeIdx + 1]));
  }

  // 6. Which steps get charge/discharge variables.
  const stepCanCharge = steps.map((s, t) => {
    const buy = buyPrice(s);
    if (buy === null) return false;
    if ((terminalValuePerKwh - (buy / maxChargeEff)) >= half) return true;
    for (let j = t + 1; j < steps.length; j += 1) {
      if (profitable(buy, sellPrice(steps[j]), half)) return true;
      if (overLimit(steps[j])) return true; // energy for a later peak
    }
    return false;
  });
  const stepCanDischarge = steps.map((s, t) => {
    const sell = sellPrice(s);
    if (sell === null) return false;
    if (s.price <= 0 && s.exportPrice <= 0) return false; // never discharge into a zero or negative price
    if (overLimit(s)) return true;
    if (anyStored && sellsStored(t)) return true;
    for (let j = 0; j < t; j += 1) {
      if (profitable(buyPrice(steps[j]), sell, half)) return true;
    }
    return false;
  });

  // 7. The LP.
  const model = {
    optimize: 'totalCost', opType: 'min', constraints: {}, variables: {},
  };
  const lastStepIdx = steps.length - 1;
  const bigPenalty = 10 * (Math.max(...calcPrices.map((p) => Math.abs(p)), 0.1) + pen);
  const windowHours = Math.max(0.25, peakWindowMin / 60);

  steps.forEach((step, t) => {
    // Export above import: the surplus (deficit) part is valued conservatively, as the grid part.
    const hi = step.usableSurplusKwh > EPS_KWH ? Math.max(step.price, step.exportPrice) : step.price;
    const lo = step.usableDeficitKwh > EPS_KWH ? Math.min(step.price, step.exportPrice) : step.exportPrice;
    const C = model.constraints;
    const V = model.variables;

    bats.forEach((bat, b) => {
      C[`time_${b}_${t}`] = { max: 1 };
      C[`bal_${b}_${t}`] = { equal: (t === 0 ? bat.startSoC : 0) };
      C[`cap_${b}_${t}`] = { min: 0, max: bat.batCapacity };
      V[`soc_${b}_${t}`] = { [`bal_${b}_${t}`]: 1, [`cap_${b}_${t}`]: 1 };
      if (t < lastStepIdx) V[`soc_${b}_${t}`][`bal_${b}_${t + 1}`] = -1;
      else V[`soc_${b}_${t}`].totalCost = -round4(terminalValuePerKwh);
    });

    const peak = step.limitKwh < Infinity;
    if (peak) {
      // import = deficit - home + chargeAC - sur <= limit + excess (all batteries)
      C[`peak_${t}`] = { max: round4(step.limitKwh - step.deficitKwh) };
      V[`ex_${t}`] = { [`peak_${t}`]: -1, totalCost: round4((step.penaltyPerKw || bigPenalty) / windowHours) };
    }

    if (stepCanCharge[t]) {
      C[`surCap_${t}`] = { max: round4(step.usableSurplusKwh) };
      C[`surAc_${t}`] = { max: 0 };
      if (!allowGridCharge) C[`gridC_${t}`] = { max: 0 };
      bats.forEach((bat, b) => bat.chargeSpeeds.forEach((speed, k) => {
        const acKwh = (speed.power / 1000) * step.durationHours;
        const v = {
          totalCost: round4(acKwh * (hi + fc)),
          [`time_${b}_${t}`]: 1,
          [`bal_${b}_${t}`]: -round4(acKwh * speed.eff),
          [`surAc_${t}`]: -round4(acKwh),
        };
        if (!allowGridCharge) v[`gridC_${t}`] = round4(acKwh);
        if (peak) v[`peak_${t}`] = round4(acKwh);
        V[`c${k}_${b}_${t}`] = v;
      }));
      const sur = { totalCost: -round4(hi - step.exportPrice) - TIE_KWH, [`surCap_${t}`]: 1, [`surAc_${t}`]: 1 };
      if (!allowGridCharge) sur[`gridC_${t}`] = -1;
      if (peak) sur[`peak_${t}`] = -1;
      V[`sur_${t}`] = sur;
    }

    if (stepCanDischarge[t]) {
      C[`homeCap_${t}`] = { max: round4(step.usableDeficitKwh) };
      C[`homeAc_${t}`] = { max: 0 };
      if (!allowExport) C[`gridE_${t}`] = { max: 0 };
      bats.forEach((bat, b) => bat.dischargeSpeeds.forEach((speed, k) => {
        const acKwh = (speed.power / 1000) * step.durationHours;
        const v = {
          totalCost: -round4(acKwh * (lo - fc)),
          [`time_${b}_${t}`]: 1,
          [`bal_${b}_${t}`]: round4(acKwh / speed.eff),
          [`homeAc_${t}`]: -round4(acKwh),
        };
        if (!allowExport) v[`gridE_${t}`] = round4(acKwh);
        V[`d${k}_${b}_${t}`] = v;
      }));
      const home = { totalCost: -round4(step.price - lo) - TIE_KWH, [`homeCap_${t}`]: 1, [`homeAc_${t}`]: 1 };
      if (!allowExport) home[`gridE_${t}`] = -1;
      if (peak) home[`peak_${t}`] = -1;
      V[`home_${t}`] = home;
    }
  });

  const solved = solver.Solve(model);
  const val = (name) => (Number.isFinite(solved[name]) ? solved[name] : 0);

  // 8. Back to the original slots, per battery. The grid part (charge/discharge block) is the
  // step's, over all batteries.
  const stepFlows = steps.map((step, t) => {
    let chargeAc = 0;
    let dischargeAc = 0;
    bats.forEach((bat, b) => {
      bat.chargeSpeeds.forEach((speed, k) => {
        chargeAc += val(`c${k}_${b}_${t}`) * (speed.power / 1000) * step.durationHours;
      });
      bat.dischargeSpeeds.forEach((speed, k) => {
        dischargeAc += val(`d${k}_${b}_${t}`) * (speed.power / 1000) * step.durationHours;
      });
    });
    return {
      gridCharge: chargeAc - val(`sur_${t}`) > EPS_KWH,
      gridExport: dischargeAc - val(`home_${t}`) > EPS_KWH,
    };
  });

  // Per battery and step: average AC power and stored energy, as the LP split them.
  const flows = bats.map((bat, b) => steps.map((step, t) => {
    let avgKw = 0;
    let energyChange = 0;
    bat.chargeSpeeds.forEach((speed, k) => {
      const f = val(`c${k}_${b}_${t}`);
      avgKw += f * (speed.power / 1000);
      energyChange += f * (speed.power / 1000) * speed.eff * step.durationHours;
    });
    bat.dischargeSpeeds.forEach((speed, k) => {
      const f = val(`d${k}_${b}_${t}`);
      avgKw -= f * (speed.power / 1000);
      energyChange -= ((f * (speed.power / 1000)) / speed.eff) * step.durationHours;
    });
    return { avgKw, energyChange };
  }));
  rebalance(bats, flows);

  // Each slot of a (merged) step gets the step's average power over the whole slot and its block:
  // the energy then follows the LP exactly and the SoC stays within 0-100 %. Zero on the meter
  // covers a deficit continuously anyway, not in short runs at full power.
  return bats.map((bat, b) => {
    const strategy = {};
    let storedEnergy = bat.startSoC;
    steps.forEach((step, t) => {
      const { avgKw, energyChange } = flows[b][t];
      const { gridCharge, gridExport } = stepFlows[t];
      // Below 10 W: nothing (the energy is a few Wh).
      const power = Math.abs(avgKw) < 0.01 ? 0 : Math.round(avgKw * 1000);
      const minSolarW = stepMinSolarW(step);

      step.originalIndices.forEach((origIdx) => {
        const origDurMins = origIdx === 0 ? (priceInterval - (startMinute % priceInterval)) : priceInterval;
        storedEnergy += energyChange * ((origDurMins / 60) / step.durationHours);
        const socPct = Math.min(100, Math.max(0, Math.round(100 * (storedEnergy / bat.batCapacity))));

        const n = netAt(origIdx);
        let block;
        let quiet = false;
        if (power > 0) block = gridCharge ? 'charge' : 'zero';
        else if (power < 0) block = gridExport ? 'discharge' : 'zero';
        else ({ block, quiet = false } = zeroPowerBlock(n, storedEnergy, minimizeGrid || minSolarW !== Infinity));

        strategy[origIdx] = {
          power,
          duration: power ? origDurMins : 0,
          soc: socPct,
          price: calcPrices[origIdx],
          exportPrice: exportAt(origIdx),
          block,
          ...(quiet ? { quiet: true } : {}),
          ...solarFields(minSolarW),
        };
      });
    });
    return strategy;
  });
};

// One battery: its strategy.
const getStrategy = (options) => solve({ ...options, batteries: null })[0];

// Several batteries (options.batteries): a strategy per battery, in that order.
const getGroupStrategy = (options) => solve(options);

module.exports = {
  getStrategy,
  getGroupStrategy,
  BLOCKS,
};
