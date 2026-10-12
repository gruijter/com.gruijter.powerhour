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

// Learns a battery's efficiency per power level from its SoC and its AC charge/discharge meters,
// for any battery. Pure: the device passes readings and stores the state (a few hundred bytes).
//
// A sample runs from one SoC change to a later one: the SoC difference times the capacity is the
// energy in the cells (DC), the meters give the AC energy. Charging: efficiency = DC / AC,
// discharging: AC / DC. Per direction the efficiency depends on the capacity setting (a capacity
// off by x% moves both directions x% apart); their product, the round trip, does not.

// Power bins (AC W, upper edges).
const BIN_EDGES = [100, 200, 300, 450, 650, 900, 1250, 1750, 2500, 3500, 5000, 7500, Infinity];
// Close a sample after at least 10 minutes and MIN_SAMPLE_KWH of AC energy: Homey keeps meters in
// 10 Wh steps and they lag the SoC a few seconds, so short samples would be noisy.
const MIN_SAMPLE_MS = 10 * 60 * 1000;
const MIN_SAMPLE_KWH = 0.15;
const MAX_SAMPLE_MS = 12 * 60 * 60 * 1000;
// Below this mean power a sample is mostly the battery's own use; above maxW x MAX_POWER_FACTOR a
// meter jumped.
const MIN_POWER_W = 50;
const MAX_POWER_FACTOR = 1.3;
// The capacity factor only within this range (a wider one is noise or a wrong setting).
const CAPACITY_FACTOR_RANGE = [0.8, 1.25];
// Energy the other way of at most this share: still one direction (zero on the meter swings).
const MIXED_SHARE = 0.03;
// Below this AC energy (kWh) in a sample: idle, the SoC change is the battery's own use.
const IDLE_KWH = 0.002;
// Each new sample in a bin first scales the bin's sums down: old samples fade out.
const DECAY = 0.97;
// Plausible range for one sample; outside it a meter jumped or the SoC was reset.
const MIN_EFF = 0.3;
const MAX_EFF = 1.1;

const binOf = (powerW) => BIN_EDGES.findIndex((edge) => powerW < edge);

const emptyBins = () => BIN_EDGES.map(() => ({
  ac: 0, dc: 0, h: 0, n: 0,
}));

const createState = () => ({
  charge: emptyBins(), discharge: emptyBins(), idle: { dc: 0, h: 0, n: 0 }, win: null, lastSoc: null,
});

const addTo = (bin, ac, dc, h, weight) => {
  bin.ac = (bin.ac * DECAY) + (ac * weight);
  bin.dc = (bin.dc * DECAY) + (dc * weight);
  bin.h = (bin.h * DECAY) + (h * weight);
  bin.n = (bin.n * DECAY) + weight;
};

/**
 * A new SoC reading. Returns the state and what happened.
 *
 * @param {object} state - createState(), or the stored state
 * @param {object} r
 * @param {number} r.now - ms
 * @param {number} r.soc - %
 * @param {number} r.inKwh - AC charge meter
 * @param {number} r.outKwh - AC discharge meter
 * @param {number} r.capacityKwh
 * @param {number} [r.maxW] - the battery's max power: faster is a meter jump
 * @param {number} [r.minSocStep] - SoC change (%) a sample needs at least (more for averaged SoC)
 * @param {number} [r.weight] - of a sample (less for history from averaged values)
 * @returns {{state: object, sample: object|null, reason: string|null}}
 */
const onSoc = (state, {
  now, soc, inKwh, outKwh, capacityKwh, maxW = null, minSocStep = 1, weight = 1,
}) => {
  const s = state || createState();
  const result = (sample = null, reason = null) => ({ state: s, sample, reason });
  if (![now, soc, inKwh, outKwh].every(Number.isFinite) || !(capacityKwh > 0)) return result(null, 'input');
  const changed = s.lastSoc !== null && soc !== s.lastSoc;
  s.lastSoc = soc;
  if (!changed) return result();
  // A sample starts at a SoC change, so it holds whole SoC steps.
  const start = () => {
    s.win = {
      t: now, soc, inKwh, outKwh,
    };
  };
  const w = s.win;
  if (!w) {
    start();
    return result();
  }
  const ms = now - w.t;
  const dSoc = soc - w.soc;
  const dIn = inKwh - w.inKwh;
  const dOut = outKwh - w.outKwh;
  if (ms > MAX_SAMPLE_MS || dIn < 0 || dOut < 0) {
    start();
    return result(null, 'reset');
  }
  const idle = dIn + dOut < IDLE_KWH;
  if (Math.abs(dSoc) < minSocStep || ms < MIN_SAMPLE_MS || (!idle && Math.max(dIn, dOut) < MIN_SAMPLE_KWH)) return result();
  start();
  const h = ms / 3600000;
  const dc = (Math.abs(dSoc) / 100) * capacityKwh;
  if (idle) {
    if (dSoc > 0) return result(null, 'soc rose while idle');
    s.idle.dc = (s.idle.dc * DECAY) + dc;
    s.idle.h = (s.idle.h * DECAY) + h;
    s.idle.n = (s.idle.n * DECAY) + 1;
    return result({ dir: 'idle', dc, h });
  }
  const dir = dIn >= dOut ? 'charge' : 'discharge';
  const ac = dir === 'charge' ? dIn : dOut;
  const other = dir === 'charge' ? dOut : dIn;
  if (other > ac * MIXED_SHARE) return result(null, 'mixed');
  if ((dir === 'charge') !== (dSoc > 0)) return result(null, 'soc against meters');
  const eff = dir === 'charge' ? dc / ac : ac / dc;
  if (eff < MIN_EFF || eff > MAX_EFF) return result(null, `implausible ${Math.round(eff * 100)}%`);
  const powerW = (ac / h) * 1000;
  if (powerW < MIN_POWER_W) return result(null, `${Math.round(powerW)} W: mostly own use`);
  if (maxW > 0 && powerW > maxW * MAX_POWER_FACTOR) return result(null, `${Math.round(powerW)} W: meter jump`);
  addTo(s[dir][binOf(powerW)], ac, dc, h, weight);
  return result({
    dir, ac, dc, h, powerW, eff,
  });
};

// Per bin with data: the mean AC power and the efficiency.
const binTable = (bins) => bins.map((b, i) => (b.n > 0 && b.ac > 0 && b.dc > 0 ? {
  bin: i, powerW: (b.ac / b.h) * 1000, n: b.n, ac: b.ac, dc: b.dc,
} : null)).filter(Boolean);

// Losses in W against AC power: loss = fixedW + k x power^2 (own use of inverter, fans, BMS, and
// conversion losses that grow with the current). Weighted least squares over the bins.
const fitLoss = (rows, dir) => {
  const pts = rows.filter((r) => r.eff > MIN_EFF && r.eff < 1).map((r) => {
    const lossKwh = dir === 'charge' ? r.ac - r.dc : r.dc - r.ac;
    return { x: r.powerW ** 2, y: (lossKwh * r.powerW) / r.ac, w: r.n }; // loss in W
  });
  if (pts.length < 3) return null;
  const sw = pts.reduce((a, p) => a + p.w, 0);
  const mx = pts.reduce((a, p) => a + (p.w * p.x), 0) / sw;
  const my = pts.reduce((a, p) => a + (p.w * p.y), 0) / sw;
  const sxx = pts.reduce((a, p) => a + (p.w * ((p.x - mx) ** 2)), 0);
  if (!(sxx > 0)) return null;
  const k = Math.max(0, pts.reduce((a, p) => a + (p.w * (p.x - mx) * (p.y - my)), 0) / sxx);
  const fixedW = Math.max(0, my - (k * mx));
  return { fixedW, k };
};

// Efficiency at an AC power from a fit.
const effAt = (fit, powerW, dir) => {
  if (!fit || !(powerW > 0)) return null;
  const loss = fit.fixedW + (fit.k * (powerW ** 2));
  return dir === 'charge' ? Math.max(0, (powerW - loss) / powerW) : powerW / (powerW + loss);
};

// A fit that gives a plausible efficiency at the highest measured power, else none.
const saneFit = (fit, rows, dir) => {
  if (!fit || !rows.length) return null;
  return effAt(fit, Math.max(...rows.map((r) => r.powerW)), dir) > 0.5 ? fit : null;
};

/**
 * What was learned: the capacity factor that makes both directions alike (true capacity = factor x
 * setting), per direction the bins and a loss fit on that capacity, and the own use while idle.
 *
 * @param {object} state
 * @returns {{charge: object[], discharge: object[], chargeFit: object|null, dischargeFit: object|null,
 *   idleW: number|null, capacityFactor: number|null}}
 */
const summary = (state) => {
  const s = state || createState();
  const rawC = binTable(s.charge);
  const rawD = binTable(s.discharge);
  // Overall raw efficiencies: their ratio is the capacity error squared (true = factor x setting).
  const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
  const effC = rawC.length ? sum(rawC, 'dc') / sum(rawC, 'ac') : null;
  const effD = rawD.length ? sum(rawD, 'ac') / sum(rawD, 'dc') : null;
  const factor = effC && effD ? Math.sqrt(effD / effC) : null;
  const capacityFactor = factor >= CAPACITY_FACTOR_RANGE[0] && factor <= CAPACITY_FACTOR_RANGE[1] ? factor : null;
  // DC energy on the true capacity, once both directions have data.
  const withEff = (rows, dir) => rows.map((r) => {
    const dc = r.dc * (capacityFactor || 1);
    return { ...r, dc, eff: dir === 'charge' ? dc / r.ac : r.ac / dc };
  });
  const charge = withEff(rawC, 'charge');
  const discharge = withEff(rawD, 'discharge');
  return {
    charge,
    discharge,
    chargeFit: saneFit(fitLoss(charge, 'charge'), charge, 'charge'),
    dischargeFit: saneFit(fitLoss(discharge, 'discharge'), discharge, 'discharge'),
    idleW: s.idle.h > 0 ? (s.idle.dc / s.idle.h) * 1000 : null,
    capacityFactor,
  };
};

// One log line.
const describe = (state) => {
  const sm = summary(state);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const rows = (list) => list.map((r) => `${Math.round(r.powerW)}W ${pct(r.eff)} (${r.n.toFixed(1)})`).join(', ') || '-';
  const fit = (f, dir) => (f ? `fixed ${Math.round(f.fixedW)} W, ${[200, 500, 1000, 2000].map((p) => `${p}W ${pct(effAt(f, p, dir))}`).join(' ')}` : '-');
  return `charge: ${rows(sm.charge)} | fit ${fit(sm.chargeFit, 'charge')} || discharge: ${rows(sm.discharge)} | fit ${fit(sm.dischargeFit, 'discharge')}`
    + ` || idle ${sm.idleW === null ? '-' : `${Math.round(sm.idleW)} W`} || capacity x${sm.capacityFactor ? sm.capacityFactor.toFixed(2) : '-'}`;
};

module.exports = {
  createState,
  onSoc,
  summary,
  effAt,
  describe,
  BIN_EDGES,
};
