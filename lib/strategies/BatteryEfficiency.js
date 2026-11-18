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

const BIN_EDGES = [100, 200, 300, 450, 650, 900, 1250, 1750, 2500, 3500, 5000, 7500, Infinity];
const MIN_SAMPLE_MS = 10 * 60 * 1000;
const MIN_SAMPLE_KWH = 0.15;
const MAX_SAMPLE_MS = 12 * 60 * 60 * 1000;
const MIN_POWER_W = 50;
const MAX_POWER_FACTOR = 1.3;
const CAPACITY_FACTOR_RANGE = [0.8, 1.25];
const MIXED_SHARE = 0.03;
const IDLE_KWH = 0.002;
const DECAY = 0.97;
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

const onSoc = (state, {
  now, soc, inKwh, outKwh, capacityKwh, maxW = null, minSocStep = 1, weight = 1,
}) => {
  const s = state || createState();
  const result = (sample = null, reason = null) => ({ state: s, sample, reason });
  if (![now, soc, inKwh, outKwh].every(Number.isFinite) || !(capacityKwh > 0)) return result(null, 'input');
  const changed = s.lastSoc !== null && soc !== s.lastSoc;
  s.lastSoc = soc;
  if (!changed) return result();
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

const binTable = (bins) => bins.map((b, i) => (b.n > 0 && b.ac > 0 && b.dc > 0 ? {
  bin: i, powerW: (b.ac / b.h) * 1000, n: b.n, ac: b.ac, dc: b.dc,
} : null)).filter(Boolean);

const fitLoss = (rows, dir) => {
  const pts = rows.filter((r) => r.eff > MIN_EFF && r.eff < 1).map((r) => {
    const lossKwh = dir === 'charge' ? r.ac - r.dc : r.dc - r.ac;
    return { x: r.powerW ** 2, y: (lossKwh * r.powerW) / r.ac, w: r.n };
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

const effAt = (fit, powerW, dir) => {
  if (!fit || !(powerW > 0)) return null;
  const loss = fit.fixedW + ((fit.linear || 0) * powerW) + (fit.k * (powerW ** 2));
  return dir === 'charge' ? Math.max(0, (powerW - loss) / powerW) : powerW / (powerW + loss);
};

const solveLinear = (m, v) => {
  const n = v.length;
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-12) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    for (let r = 0; r < n; r += 1) {
      if (r !== c) {
        const f = a[r][c] / a[c][c];
        for (let k = c; k <= n; k += 1) a[r][k] -= f * a[c][k];
      }
    }
  }
  return a.map((row, i) => row[n] / row[i]);
};
const fitSpeeds = (speeds, dir) => {
  const pts = speeds.filter((s) => s.power > 0 && s.eff > 0)
    .map((s) => [s.power / 1000, dir === 'charge' ? s.power * (1 - s.eff) : s.power * ((1 / s.eff) - 1)]);
  if (pts.length < 3) return null;
  const basis = [() => 1, (x) => x, (x) => x * x];
  let best = null;
  for (let mask = 1; mask < 8; mask += 1) {
    const use = [0, 1, 2].filter((i) => mask & (1 << i));
    const m = use.map((i) => use.map((j) => pts.reduce((acc, [x]) => acc + (basis[i](x) * basis[j](x)), 0)));
    const v = use.map((i) => pts.reduce((acc, [x, y]) => acc + (basis[i](x) * y), 0));
    const sol = solveLinear(m, v);
    if (sol && sol.every((c) => c >= -1e-9)) {
      const coef = [0, 0, 0];
      use.forEach((i, j) => {
        coef[i] = Math.max(0, sol[j]);
      });
      const sse = pts.reduce((acc, [x, y]) => acc + ((coef[0] + (coef[1] * x) + (coef[2] * x * x) - y) ** 2), 0);
      if (!best || sse < best.sse - 1e-9) best = { sse, coef };
    }
  }
  if (!best) return null;
  const [fixedW, perKw, perKw2] = best.coef;
  return { fixedW, linear: perKw / 1000, k: perKw2 / 1e6 };
};

const saneFit = (fit, rows, dir) => {
  if (!fit || !rows.length) return null;
  return effAt(fit, Math.max(...rows.map((r) => r.powerW)), dir) > 0.5 ? fit : null;
};

const summary = (state) => {
  const s = state || createState();
  const rawC = binTable(s.charge);
  const rawD = binTable(s.discharge);
  const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);
  const effC = rawC.length ? sum(rawC, 'dc') / sum(rawC, 'ac') : null;
  const effD = rawD.length ? sum(rawD, 'ac') / sum(rawD, 'dc') : null;
  const factor = effC && effD ? Math.sqrt(effD / effC) : null;
  const capacityFactor = factor >= CAPACITY_FACTOR_RANGE[0] && factor <= CAPACITY_FACTOR_RANGE[1] ? factor : null;
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

const MIN_LEARNED_N = 10;
const EFF_TOP_MARGIN = 0.005;
const MIN_POWER_MARGIN = 0.15;
const MAX_LOSS_PCT = 30;
const SETTING_STEPS = {
  power: 50, loss: 0.5, min: 25, capacity: 0.02,
};
const SETTING_KEYS = {
  charge: {
    max: ['chargePower', 'chargeLoss'], eff: ['chargePowerEff', 'chargeLossEff'], mid: ['chargePower3', 'chargeLoss3'], min: 'minChargeW',
  },
  discharge: {
    max: ['dischargePower', 'dischargeLoss'], eff: ['dischargePowerEff', 'dischargeLossEff'], mid: ['dischargePower3', 'dischargeLoss3'], min: 'minDischargeW',
  },
};

const round10 = (w) => Math.round(w / 10) * 10;

const toSettings = (state, settings, nominalKwh = settings.batCapacity) => {
  const sm = summary(state);
  const weight = (rows) => rows.reduce((a, r) => a + r.n, 0);
  if (!sm.capacityFactor || !sm.chargeFit || !sm.dischargeFit) return null;
  if (weight(sm.charge) < MIN_LEARNED_N || weight(sm.discharge) < MIN_LEARNED_N) return null;
  const want = {};
  const capacity = Math.round(Number(nominalKwh) * sm.capacityFactor * 100) / 100;
  if (Math.abs(capacity - Number(settings.batCapacity)) >= SETTING_STEPS.capacity * Number(nominalKwh)) want.batCapacity = capacity;
  const steps = {};
  [['charge', sm.chargeFit], ['discharge', sm.dischargeFit]].forEach(([dir, fit]) => {
    const keys = SETTING_KEYS[dir];
    const maxW = Number(settings[keys.max[0]]);
    if (!(maxW > 0)) return;
    const eff = (w) => effAt(fit, w, dir);
    const lossPct = (w) => Math.min(MAX_LOSS_PCT, Math.max(0, Math.round((1 - eff(w)) * 1000) / 10));
    let bestW = 10;
    for (let w = 20; w <= maxW; w += 10) if (eff(w) > eff(bestW)) bestW = w;
    const best = eff(bestW);
    let effW = bestW;
    while (effW + 10 <= maxW && eff(effW + 10) >= best - EFF_TOP_MARGIN) effW += 10;
    let minW = 10;
    while (minW < bestW && eff(minW) < best - MIN_POWER_MARGIN) minW += 10;
    const midW = round10((effW + maxW) / 2);
    Object.assign(want, {
      [keys.max[1]]: lossPct(maxW),
      [keys.eff[0]]: effW,
      [keys.eff[1]]: lossPct(effW),
      [keys.mid[0]]: midW,
      [keys.mid[1]]: lossPct(midW),
      [keys.min]: minW,
    });
    [keys.eff[0], keys.mid[0]].forEach((key) => {
      steps[key] = SETTING_STEPS.power;
    });
    [keys.max[1], keys.eff[1], keys.mid[1]].forEach((key) => {
      steps[key] = SETTING_STEPS.loss;
    });
    steps[keys.min] = SETTING_STEPS.min;
  });
  const changes = {};
  Object.entries(want).forEach(([key, value]) => {
    if (key === 'batCapacity' || !(Math.abs(value - (Number(settings[key]) || 0)) < steps[key])) changes[key] = value;
  });
  return Object.keys(changes).length ? changes : null;
};

const LEARNED_KEYS = Object.values(SETTING_KEYS).flatMap((k) => [k.max[1], ...k.eff, ...k.mid, k.min]);
const START_LOSS = { charge: [10, 5, 7], discharge: [8, 4, 6] };

const startProps = (settings) => {
  const out = {};
  Object.entries(SETTING_KEYS).forEach(([dir, keys]) => {
    const maxW = Number(settings[keys.max[0]]) || 0;
    const [atMax, atEff, atMid] = START_LOSS[dir];
    Object.assign(out, {
      [keys.max[1]]: atMax,
      [keys.eff[0]]: round10(maxW / 2),
      [keys.eff[1]]: atEff,
      [keys.mid[0]]: round10((maxW * 3) / 4),
      [keys.mid[1]]: atMid,
      [keys.min]: 0,
    });
  });
  return out;
};

const withProps = (settings, props) => {
  const out = { ...settings, ...startProps(settings), ...(props || {}) };
  Object.values(SETTING_KEYS).forEach((keys) => {
    const maxW = Number(out[keys.max[0]]) || 0;
    [keys.eff[0], keys.mid[0]].forEach((key) => {
      out[key] = Math.min(Number(out[key]) || 0, maxW);
    });
  });
  return out;
};

const progress = (state) => {
  const sm = summary(state);
  const weight = (rows) => Math.min(MIN_LEARNED_N, rows.reduce((a, r) => a + r.n, 0));
  const charge = weight(sm.charge);
  const discharge = weight(sm.discharge);
  const learned = !!(sm.capacityFactor && sm.chargeFit && sm.dischargeFit) && charge >= MIN_LEARNED_N && discharge >= MIN_LEARNED_N;
  return {
    charge, discharge, needed: MIN_LEARNED_N, learned,
  };
};

const rescale = (state, ratio) => {
  if (!state || !(ratio > 0)) return state;
  [...state.charge, ...state.discharge, state.idle].forEach((bin) => {
    bin.dc *= ratio;
  });
  return state;
};

const describe = (state) => {
  const sm = summary(state);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const rows = (list) => list.map((r) => `${Math.round(r.powerW)}W ${pct(r.eff)} (${r.n.toFixed(1)})`).join(', ') || '-';
  const fit = (f, dir) => (f ? `fixed ${Math.round(f.fixedW)} W, ${[200, 500, 1000, 2000].map((p) => `${p}W ${pct(effAt(f, p, dir))}`).join(' ')}` : '-');
  return `charge: ${rows(sm.charge)} | fit ${fit(sm.chargeFit, 'charge')} || discharge: ${rows(sm.discharge)} | fit ${fit(sm.dischargeFit, 'discharge')}`
    + ` || idle ${sm.idleW === null ? '-' : `${Math.round(sm.idleW)} W`} || capacity x${sm.capacityFactor ? sm.capacityFactor.toFixed(2) : '-'}`;
};

module.exports = {
  LEARNED_KEYS,
  startProps,
  withProps,
  progress,
  createState,
  onSoc,
  summary,
  effAt,
  fitSpeeds,
  describe,
  toSettings,
  rescale,
  BIN_EDGES,
};
