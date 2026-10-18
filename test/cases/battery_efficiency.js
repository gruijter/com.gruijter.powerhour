'use strict';

// node test/cases/battery_efficiency.js
const assert = require('assert');
const eff = require('../../lib/strategies/BatteryEfficiency');

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

// A battery: losses fixedW + k x P^2 per direction, true capacity, SoC reported in whole %.
const simulate = ({
  trueKwh = 5.4, settingKwh = 5.05, fixedW = 50, k = 1e-5, profile, stepS = 10, meterLagS = 0,
}) => {
  let state = eff.createState();
  let cellsKwh = trueKwh * 0.5;
  let inKwh = 100;
  let outKwh = 50;
  let t = Date.UTC(2026, 9, 12);
  const history = [];
  const samples = [];
  for (const [powerW, minutes] of profile) {
    for (let s = 0; s < minutes * 60; s += stepS) {
      const h = stepS / 3600;
      const loss = powerW === 0 ? 0 : fixedW + (k * powerW * powerW);
      if (powerW > 0) {
        inKwh += (powerW * h) / 1000;
        cellsKwh += ((powerW - loss) * h) / 1000;
      } else if (powerW < 0) {
        outKwh += (-powerW * h) / 1000;
        cellsKwh -= ((-powerW + loss) * h) / 1000;
      }
      cellsKwh = Math.max(0, Math.min(trueKwh, cellsKwh));
      t += stepS * 1000;
      history.push({ t, inKwh, outKwh });
      const lagged = history[Math.max(0, history.length - 1 - Math.round(meterLagS / stepS))];
      const res = eff.onSoc(state, {
        now: t, soc: Math.round((cellsKwh / trueKwh) * 100), inKwh: lagged.inKwh, outKwh: lagged.outKwh, capacityKwh: settingKwh,
      });
      ({ state } = res);
      if (res.sample) samples.push(res.sample);
    }
  }
  return { state, samples };
};

const cycle = (levels, minutes) => levels.flatMap((p) => [[p, minutes], [-p, minutes]]);

test('learns efficiency per power level, both directions', () => {
  const { state } = simulate({ profile: cycle([150, 300, 700, 1500, 2200], 90) });
  const sm = eff.summary(state);
  const at = (rows, w) => rows.reduce((best, r) => (Math.abs(r.powerW - w) < Math.abs(best.powerW - w) ? r : best));
  // True round trip at 300 W: (300-51)/300 x 300/(300+51) = 0.71; at 1500 W: (1500-72.5)/1500 x 1500/1572.5 = 0.91.
  const rte = (w) => at(sm.charge, w).eff * at(sm.discharge, w).eff;
  assert.ok(Math.abs(rte(300) - 0.71) < 0.04, `RTE at 300 W ${rte(300).toFixed(3)}`);
  assert.ok(Math.abs(rte(1500) - 0.91) < 0.03, `RTE at 1500 W ${rte(1500).toFixed(3)}`);
  console.log(`     ${eff.describe(state)}`);
});

test('capacity factor finds the true capacity', () => {
  const { state } = simulate({ profile: cycle([700, 1500], 60) });
  const { capacityFactor } = eff.summary(state);
  assert.ok(Math.abs(capacityFactor - (5.4 / 5.05)) < 0.03, `factor ${capacityFactor}`);
});

test('loss fit finds the fixed own use', () => {
  const { state } = simulate({ settingKwh: 5.4, profile: cycle([150, 300, 700, 1500, 2200], 90) });
  const { chargeFit, dischargeFit } = eff.summary(state);
  assert.ok(Math.abs(chargeFit.fixedW - 50) < 12, `charge fixed ${chargeFit.fixedW}`);
  assert.ok(Math.abs(dischargeFit.fixedW - 50) < 12, `discharge fixed ${dischargeFit.fixedW}`);
  assert.ok(eff.effAt(dischargeFit, 150, 'discharge') < 0.8, 'low power is lossy');
});

test('a meter lag of 10 s keeps the error small', () => {
  const { state } = simulate({ settingKwh: 5.4, meterLagS: 10, profile: cycle([2200], 60) });
  const row = eff.summary(state).charge[0];
  const truth = (2200 - (50 + (1e-5 * 2200 * 2200))) / 2200;
  assert.ok(Math.abs(row.eff - truth) < 0.02, `charge ${row.eff.toFixed(3)} vs ${truth.toFixed(3)}`);
});

test('zero on the meter swinging both ways is not learned', () => {
  const profile = [];
  for (let i = 0; i < 60; i += 1) profile.push([400, 1], [-400, 1]);
  const { samples } = simulate({ profile });
  assert.strictEqual(samples.filter((s) => s.dir !== 'idle').length, 0);
});

test('idle: own use from the cells', () => {
  let state = eff.createState();
  const base = Date.UTC(2026, 9, 12);
  [50, 49, 48, 47].forEach((soc, i) => {
    ({ state } = eff.onSoc(state, {
      now: base + (i * 2 * 3600000), soc, inKwh: 10, outKwh: 5, capacityKwh: 5,
    }));
  });
  const { idleW } = eff.summary(state);
  assert.ok(Math.abs(idleW - 25) < 1, `idle ${idleW} W`); // 1 % of 5 kWh per 2 h
});

test('a meter reset starts over', () => {
  let state = eff.createState();
  const base = Date.UTC(2026, 9, 12);
  let res;
  [[50, 10], [51, 10.2], [55, 0.1]].forEach(([soc, inKwh], i) => {
    res = eff.onSoc(state, {
      now: base + (i * 20 * 60000), soc, inKwh, outKwh: 5, capacityKwh: 5,
    });
    ({ state } = res);
  });
  assert.strictEqual(res.reason, 'reset');
  assert.strictEqual(eff.summary(state).charge.length, 0);
});

test('settings from what was learned: capacity, loss values, efficient and min. power', () => {
  const { state } = simulate({ fixedW: 35, k: 4e-5, profile: cycle([150, 300, 700, 1100, 1500, 2200], 90) });
  const settings = {
    batCapacity: 5.05, chargePower: 2200, dischargePower: 1650, chargePowerEff: 1050, dischargePowerEff: 765,
  };
  const ch = eff.toSettings(state, settings);
  assert.ok(Math.abs(ch.batCapacity - 5.4) < 0.15, `capacity ${ch.batCapacity}`);
  // True: best charge efficiency at sqrt(35/4e-5) = 935 W (92.5 %); within 0.5 point up to ~1344 W.
  assert.ok(ch.chargePowerEff > 935 && ch.chargePowerEff < 1350, `eff power ${ch.chargePowerEff}`);
  assert.ok(Math.abs(ch.chargeLoss - (((35 + (4e-5 * 2200 * 2200)) / 2200) * 100)) < 1.5, `loss at max ${ch.chargeLoss}`);
  assert.ok(ch.chargePower3 > ch.chargePowerEff && ch.chargePower3 < 2200);
  assert.ok(ch.dischargePower3 > ch.dischargePowerEff && ch.dischargePower3 < 1650);
  // True: 77.5 % (15 points below the best) at ~155 W.
  assert.ok(ch.minChargeW >= 110 && ch.minChargeW <= 200, `min charge ${ch.minChargeW}`);
  assert.ok(ch.minDischargeW >= 110 && ch.minDischargeW <= 200, `min discharge ${ch.minDischargeW}`);
  console.log(`     ${JSON.stringify(ch)}`);
  // Written and rescaled: the capacity factor is gone, nothing left to change.
  eff.rescale(state, ch.batCapacity / settings.batCapacity);
  assert.ok(Math.abs(eff.summary(state).capacityFactor - 1) < 0.02);
  assert.strictEqual(eff.toSettings(state, { ...settings, ...ch }), null);
});

test('no settings before both directions are learned', () => {
  const { state } = simulate({ profile: [[700, 600], [1500, 300]] });
  assert.strictEqual(eff.toSettings(state, { batCapacity: 5.05, chargePower: 2200, dischargePower: 1650 }), null);
});

test('state stays small', () => {
  const { state } = simulate({ profile: cycle([150, 300, 700, 1500, 2200, 3000], 60) });
  const bytes = JSON.stringify(state).length;
  assert.ok(bytes < 2000, `${bytes} bytes`);
  console.log(`     ${bytes} bytes`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
