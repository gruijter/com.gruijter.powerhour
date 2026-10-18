'use strict';

const assert = require('assert');

const root = '../../lib/strategies/';
const P = require(`${root}EvPresence`);
const S = require(`${root}EvSocEstimator`);
const C = require(`${root}EvChargerControl`);

const now = 1_800_000_000_000;
const min = 60000;
const st = (s) => P.resolvePresence({ now, ...s }).state;

// --- Presence: Kia + socket (location, stale plug state) ---
assert.strictEqual(st({ carDistanceKm: 0.05, carPlugged: false }), 'home', 'stale plugged_out at home = home');
assert.strictEqual(st({ carDistanceKm: 12, carPlugged: true }), 'away', 'far away = away');
assert.strictEqual(st({ carDistanceKm: 0.05, carPlugged: true }), 'plugged_in');
assert.strictEqual(st({ carDistanceKm: 0.05, powerW: 2300, carPlugged: false }), 'charging', 'power wins over stale plug');
assert.strictEqual(st({ carDistanceKm: 12, powerW: 2300 }), 'away', 'other car at charger while ours is away');
// Switch on without response
const nr = P.resolvePresence({
  now, carDistanceKm: 0.05, switchOn: true, switchOnSince: now - 11 * min, powerW: 0,
});
assert.deepStrictEqual([nr.state, nr.atHome, nr.chargeable], ['home', true, false], 'no response -> not chargeable');
const nr2 = P.resolvePresence({
  now, carDistanceKm: 0.05, switchOn: true, switchOnSince: now - 5 * min, powerW: 0,
});
assert.strictEqual(nr2.chargeable, true, 'within no-response window still chargeable');
const nr3 = P.resolvePresence({
  now, carDistanceKm: 0.05, switchOn: true, switchOnSince: now - 30 * min, lastChargingTm: now - 2 * min, powerW: 0,
});
assert.strictEqual(nr3.chargeable, true, 'charged since switch-on -> still chargeable');

// --- Presence: wallbox ---
assert.strictEqual(st({ chargerPlugged: true }), 'plugged_in');
assert.strictEqual(st({ chargerPlugged: false }), 'away', 'wallbox unplugged without location = away');
assert.strictEqual(st({ chargerPlugged: false, carDistanceKm: 0.1 }), 'home', 'wallbox unplugged but car home = home');
const pr = (s) => {
  const r = P.resolvePresence({ now, ...s }); return [r.state, r.unplugged, r.chargeable];
};
assert.deepStrictEqual(pr({ chargerPlugged: false, carDistanceKm: 0.1 }), ['home', true, false], 'wallbox unplugged at home = unplugged');
assert.deepStrictEqual(pr({ chargerPlugged: false, carDistanceKm: 0.1, carPlugged: true }), ['home', true, false], 'wallbox wins over car plug');
assert.deepStrictEqual(pr({ carDistanceKm: 0.1, carPlugged: false }), ['home', true, false], 'no wallbox: car plugged_out at home = unplugged');
assert.deepStrictEqual(pr({ carDistanceKm: 0.1 }), ['home', false, true], 'no plug state at home: not known unplugged');
assert.deepStrictEqual(pr({ carDistanceKm: 12, carPlugged: false }), ['away', false, false], 'away is not unplugged');
assert.deepStrictEqual(pr({ carDistanceKm: 0.1, carPlugged: false, powerW: 2300 }), ['charging', false, true], 'power wins');
assert.strictEqual(P.resolvePresence({
  now, carDistanceKm: 0.05, switchOn: true, switchOnSince: now - 11 * min, powerW: 0,
}).noResponse, true);

// --- Presence: legacy plain socket ---
assert.strictEqual(st({ usePowerGap: true, lastChargingTm: now - 3 * 60 * min }), 'away');
assert.strictEqual(st({ usePowerGap: true, lastChargingTm: now - 30 * min }), 'plugged_in');
assert.strictEqual(st({}), 'unknown');
assert.strictEqual(P.resolvePresence({ now }).atHome, true, 'unknown counts as home');
assert.strictEqual(P.isPluggedValue('plugged_in_paused'), true);
assert.strictEqual(P.isPluggedValue('plugged_out'), false);
assert.strictEqual(P.isPluggedValue(undefined), null);
assert.ok(Math.abs(P.distanceKm(52, 5, 52.009, 5) - 1.0) < 0.01, 'distance ~1 km');

// --- SoC estimator ---
const cap = 64;
let s = S.createState();
assert.strictEqual(S.estimate(s, 100, cap), null);
({ state: s } = S.onReport(s, {
  soc: 50, tm: now, kwhCounter: 100, odo: 20000,
}, cap));
assert.strictEqual(S.estimate(s, 100, cap), 50);
// 10 kWh from grid at 0.88 -> 8.8 kWh -> 13.75%
assert.ok(Math.abs(S.estimate(s, 110, cap) - 63.75) < 1e-9);
assert.strictEqual(S.estimate(s, 200, cap, 80), 80, 'capped at car limit');
assert.strictEqual(S.estimate(s, 200, cap), 100, 'capped at 100');
// Kia reports every 10% while charging, same odometer: 10 kWh -> +14% => eff 0.896
let r = S.onReport(s, {
  soc: 64, tm: now + 1, kwhCounter: 110, odo: 20000,
}, cap);
assert.ok(Math.abs(r.sample - 0.896) < 1e-9, `sample ${r.sample}`);
assert.ok(Math.abs(r.state.efficiency - 0.896) < 1e-9, 'first sample seeds');
s = r.state;
// 1% steps accumulate: no sample until +8 points
r = S.onReport(s, {
  soc: 65, tm: now + 2, kwhCounter: 110.8, odo: 20000,
}, cap);
assert.strictEqual(r.sample, null, '1% step: no sample yet');
r = S.onReport(r.state, {
  soc: 72, tm: now + 3, kwhCounter: 116.4, odo: 20000,
}, cap);
assert.ok(Math.abs(r.sample - (0.08 * 64) / 6.4) < 1e-9, `accumulated sample ${r.sample}`);
assert.strictEqual(r.state.efficiencySamples, 2);
// Trip in between: anchor resets, no sample
r = S.onReport(r.state, {
  soc: 60, tm: now + 4, kwhCounter: 116.4, odo: 20030,
}, cap);
assert.strictEqual(r.sample, null, 'odometer moved -> no sample');
r = S.onReport(r.state, {
  soc: 70, tm: now + 5, kwhCounter: 123.6, odo: 20030,
}, cap);
assert.ok(r.sample !== null, 'new anchor after trip gives sample');
// Implausible: rejected
r = S.onReport(r.state, {
  soc: 99, tm: now + 6, kwhCounter: 125, odo: 20030,
}, cap);
assert.strictEqual(r.sample, null, 'efficiency > 1 rejected');
// Rebase clears anchor
assert.strictEqual(S.rebaseCounter(r.state, 5, 99).effAnchor, null);
// Counter went back
assert.strictEqual(S.counterWentBack(r.state, 5), true);
const rb = S.rebaseCounter(r.state, 5, 99);
assert.strictEqual(S.estimate(rb, 5, cap), 99);

// --- Control ---
const interval = 15 * min;
const slotStart = now - 5 * min;
const plan = {
  startMs: slotStart,
  planTm: now - 5 * min,
  intervalMs: interval,
  slots: [{ power: 2300, duration: 10 }, { power: 0, duration: 0 }, { power: 2300, duration: 15 }],
};
assert.strictEqual(C.planWantsPower(plan, now), true, 'within first 10 min of slot 0');
assert.strictEqual(C.planWantsPower(plan, now + 6 * min), false, 'past duration in slot 0');
assert.strictEqual(C.planWantsPower(plan, now + 12 * min), false, 'slot 1 idle');
assert.strictEqual(C.planWantsPower(plan, now + 26 * min), true, 'slot 2 charging');
assert.strictEqual(C.planWantsPower(plan, now + 60 * min), false, 'beyond plan');
assert.strictEqual(C.wantedState({
  plan, now, atHome: false, chargeMode: 'scheduled_price',
}), false);
assert.strictEqual(C.wantedState({
  plan, now, atHome: true, chargeMode: 'off',
}), false);
assert.strictEqual(C.nextCommand({
  wanted: true, lastWanted: undefined, lastCommandTm: undefined, now,
}), true);
assert.strictEqual(C.nextCommand({
  wanted: true, lastWanted: true, lastCommandTm: 0, now,
}), null);
assert.strictEqual(C.nextCommand({
  wanted: false, lastWanted: true, lastCommandTm: now - min, now,
}), null, 'min switch interval');
assert.strictEqual(C.nextCommand({
  wanted: false, lastWanted: true, lastCommandTm: now - 6 * min, now,
}), false);
// Actual state wins over the last wanted state: out of sync is corrected.
assert.strictEqual(C.nextCommand({
  wanted: true, actual: false, lastWanted: true, lastCommandTm: now - 6 * min, now,
}), true, 'resync');
assert.strictEqual(C.nextCommand({
  wanted: true, actual: true, lastWanted: false, lastCommandTm: 0, now,
}), null, 'already on');
assert.strictEqual(C.nextCommand({
  wanted: true, actual: null, lastWanted: true, lastCommandTm: 0, now,
}), null, 'unknown: last wanted');
// Manual switch detection
assert.strictEqual(C.isManualSwitch({
  value: true, was: false, command: { value: true, tm: now - min }, now,
}), false, 'echo');
assert.strictEqual(C.isManualSwitch({
  value: false, was: true, command: { value: true, tm: now - min }, now,
}), true, 'opposite of command');
assert.strictEqual(C.isManualSwitch({
  value: true, was: false, command: { value: true, tm: now - 10 * min }, now,
}), true, 'late: not an echo');
assert.strictEqual(C.isManualSwitch({ value: true, was: true, now }), false, 'no change');
assert.strictEqual(C.isManualSwitch({ value: true, was: null, now }), false, 'first report');
// Override maximum time
assert.strictEqual(C.overrideExpired({ override: null, maxHours: 4, now }), false);
assert.strictEqual(C.overrideExpired({ override: { since: now - 3.9 * 60 * min }, maxHours: 4, now }), false);
assert.strictEqual(C.overrideExpired({ override: { since: now - 4 * 60 * min }, maxHours: 4, now }), true);
assert.strictEqual(C.overrideExpired({ override: { since: now - 4 * 60 * min }, maxHours: undefined, now }), true, 'default 4 h');
assert.strictEqual(C.overrideExpired({ override: { since: now - 60 * min }, maxHours: 0.5, now }), true);

// Counter jump (first meter reading after pairing): not charging
{
  const st = { ...S.createState(), baseSoc: 36, baseKwh: 0 };
  assert.strictEqual(S.counterJumped(st, 6618, 64), true, 'jump');
  assert.strictEqual(S.counterJumped(st, 60, 64), false, 'a full charge is not a jump');
  assert.strictEqual(S.estimate(S.rebaseCounter(st, 6618, 36), 6618, 64), 36, 'rebased keeps reported SoC');
}
// Temporary modes
assert.strictEqual(C.wantedState({
  plan: null, now, atHome: true, chargeMode: 'charge_temp',
}), true, 'charge_temp: on without plan');
assert.strictEqual(C.wantedState({
  plan, now, atHome: true, chargeMode: 'off_temp',
}), false, 'off_temp: off');
assert.strictEqual(C.wantedState({
  plan: null, now, atHome: false, chargeMode: 'charge_temp',
}), false, 'away: off');
assert.strictEqual(C.isTempMode('off_temp') && !C.isTempMode('off'), true);
assert.strictEqual(C.tempModeEnd({ since: now }, 2), now + 2 * 60 * min);
// Next charge window
{
  const H = 60 * min;
  const p2 = {
    startMs: now, planTm: now, intervalMs: H, slots: [{ power: 0, duration: 0 }, { power: 2600, duration: 60 }, { power: 2600, duration: 30 }, { power: 0, duration: 0 }, { power: 2600, duration: 60 }],
  };
  assert.deepStrictEqual(C.nextChargeWindow(p2, now), { startMs: now + H, endMs: now + 2.5 * H, minutes: 90 }, 'joined slots, partial last; gap of 1.5 slot ends it');
  assert.deepStrictEqual(C.nextChargeWindow(p2, now + 1.5 * H), { startMs: now + H, endMs: now + 2.5 * H, minutes: 60 }, 'running now: minutes from now');
  const p4 = { ...p2, slots: [{ power: 2600, duration: 10 }, { power: 2600, duration: 10 }, { power: 0, duration: 0 }, { power: 2600, duration: 5 }] };
  assert.deepStrictEqual(C.nextChargeWindow(p4, now), { startMs: now, endMs: now + H + 10 * min, minutes: 20 }, 'short runs in consecutive slots: one session');
  const p3 = { ...p2, slots: [{ power: 2600, duration: 30 }, { power: 0, duration: 0 }, { power: 0, duration: 0 }, { power: 2600, duration: 60 }] };
  assert.deepStrictEqual(C.nextChargeWindow(p3, now), { startMs: now, endMs: now + 0.5 * H, minutes: 30 }, 'gap of two slots: separate');
  assert.deepStrictEqual(C.nextChargeWindow(p3, now + 0.6 * H), { startMs: now + 3 * H, endMs: now + 4 * H, minutes: 60 }, 'after first window');
  assert.strictEqual(C.nextChargeWindow(p2, now + 6 * H), null, 'none');
}
// Solar gate
{
  const sol = { power: 2600, duration: 15, solarExtra: true };
  const need = { power: 2600, duration: 15, solarExtra: false };
  const g = (o) => C.solarGate({
    needW: 2600, isOn: false, opportunistic: false, ...o,
  });
  assert.deepStrictEqual(g({ wanted: true, slot: sol, surplusW: 2500 }), { wanted: true, solar: true }, 'enough surplus');
  assert.deepStrictEqual(g({ wanted: true, slot: sol, surplusW: 2000 }), { wanted: false, solar: false }, 'too little to start');
  assert.deepStrictEqual(g({
    wanted: true, slot: sol, surplusW: 2000, isOn: true,
  }), { wanted: true, solar: true }, 'keeps on through a dip');
  assert.deepStrictEqual(g({
    wanted: true, slot: sol, surplusW: 1800, isOn: true,
  }), { wanted: false, solar: false }, 'stops on a lasting shortfall');
  assert.deepStrictEqual(g({ wanted: true, slot: need, surplusW: 0 }), { wanted: true, solar: false }, 'needed charging: never gated');
  assert.deepStrictEqual(g({ wanted: false, slot: null, surplusW: 3000 }), { wanted: false, solar: false }, 'no opportunistic start unless allowed');
  assert.deepStrictEqual(g({
    wanted: false, slot: null, surplusW: 3000, opportunistic: true,
  }), { wanted: true, solar: true }, 'unexpected surplus');
  assert.deepStrictEqual(g({ wanted: true, slot: sol, surplusW: null }), { wanted: true, solar: true }, 'no meter: plan');
  assert.strictEqual(C.targetPower({
    solar: true, surplusW: 1830, slot: sol, minW: 1400, maxW: 3700,
  }), 1800);
  assert.strictEqual(C.targetPower({
    solar: true, surplusW: 900, slot: sol, minW: 1400, maxW: 3700,
  }), 1400);
  assert.strictEqual(C.targetPower({
    solar: false, surplusW: 900, slot: { power: 2250 }, minW: 1400, maxW: 3700,
  }), 2300);
}
// --- Presence: ownCharger ---
assert.strictEqual(st({ carDistanceKm: 12, powerW: 2300, ownCharger: true }), 'charging', 'own charger: power is this car');
assert.strictEqual(st({ carDistanceKm: 12, chargerPlugged: true, ownCharger: true }), 'plugged_in', 'own charger: plug is this car');
assert.strictEqual(st({ carDistanceKm: 12, chargerPlugged: true }), 'away', 'shared charger: stale location wins');
assert.strictEqual(st({ powerW: 2300, carPlugged: false, ownCharger: true }), 'charging', 'own charger: stale car plug ignored');

// --- Standby plug detection ---
const H = 3600 * 1000;
const dp = (x) => C.detectPlugged({ now, plugged: null, ...x });
assert.strictEqual(dp({ powerW: 2300 }), true, 'power = connected');
assert.strictEqual(dp({ switchOn: true, switchOnSince: now - 6 * min, powerW: 0 }), false, 'on 6 min without power = not connected');
assert.strictEqual(dp({ switchOn: true, switchOnSince: now - 3 * min, powerW: 0 }), null, 'too early to tell');
assert.strictEqual(dp({
  plugged: true, switchOn: true, switchOnSince: now - 60 * min, lastChargingTm: now - 2 * min, powerW: 0,
}), true, 'just stopped');
assert.strictEqual(dp({
  plugged: true, switchOn: true, switchOnSince: now - 60 * min, lastChargingTm: now - 10 * min, powerW: 0,
}), false, 'stopped long ago');
assert.strictEqual(dp({ plugged: true, switchOn: false, powerW: 0 }), true, 'off: keeps state');
const sb = (x) => C.standbyState({ now, wanted: false, ...x });
const sbr = (wanted, probeSince, probeEnded = false) => ({ wanted, probeSince, probeEnded });
assert.deepStrictEqual(sb({ plugged: false }), sbr(true, null), 'no car: on');
assert.deepStrictEqual(sb({ plugged: null }), sbr(true, null), 'unknown: on');
assert.deepStrictEqual(sb({ plugged: true, switchOn: false, switchOffSince: now - H }), sbr(false, null), 'car, off: plan');
assert.deepStrictEqual(sb({
  plugged: true, wanted: true, switchOn: false, switchOffSince: now - 4 * H,
}), sbr(true, null), 'plan on');
assert.deepStrictEqual(sb({ plugged: true, switchOn: false, switchOffSince: now - 3 * H }), sbr(true, now), 'probe after 3 h');
assert.deepStrictEqual(sb({ plugged: true, switchOn: true, probeSince: now - 2 * min }), sbr(true, now - 2 * min), 'probe runs');
assert.deepStrictEqual(sb({
  plugged: true, switchOn: true, probeSince: now - 2 * min, lastChargingTm: now - min,
}), sbr(false, null, true), 'probe: car there, back to plan at once');

// --- Presence: detected plug state (standby) is weaker than a charger's own ---
assert.strictEqual(st({ detectedPlugged: true }), 'plugged_in', 'detected: plugged in');
assert.strictEqual(st({ detectedPlugged: false }), 'unknown', 'no power can be a full car: not away');
assert.strictEqual(st({ detectedPlugged: false, carDistanceKm: 0.05 }), 'home', 'location decides');
assert.strictEqual(P.resolvePresence({ now, detectedPlugged: false, carDistanceKm: 0.05 }).unplugged, false, 'no unplugged alarm from no power');
assert.strictEqual(st({ detectedPlugged: true, carDistanceKm: 12, ownCharger: true }), 'plugged_in', 'own charger: detection newer than location');
assert.strictEqual(st({ detectedPlugged: true, carDistanceKm: 12 }), 'away', 'shared charger: location wins');
const fullCar = P.resolvePresence({
  now, detectedPlugged: false, switchOn: true, switchOnSince: now - 20 * min, powerW: 0,
});
assert.deepStrictEqual([fullCar.atHome, fullCar.chargeable], [true, false], 'standby, no power: home, not chargeable');

console.log('all phase 1 tests passed');

// --- Energy mode ---
{
  const Em = require('../../lib/strategies/EvEnergyMode');
  const H = 3600 * 1000;
  assert.strictEqual(Em.isActive({ reportTm: null, now }), true, 'never reported');
  assert.strictEqual(Em.isActive({ reportTm: now, usedSinceReport: true, now }), false, 'manual or car report');
  assert.strictEqual(Em.isActive({ reportTm: now - 47 * H, usedSinceReport: true, now }), false, 'recent report');
  assert.strictEqual(Em.isActive({ reportTm: now - 49 * H, usedSinceReport: true, now }), true, 'stale report, car used since');
  assert.strictEqual(Em.isActive({ reportTm: now - 99 * H, usedSinceReport: false, now }), false, 'parked: old report still right');
  let e = Em.createState();
  assert.strictEqual(Em.sessionNeedKwh(e, 30, 50), 30, 'default until learned');
  assert.strictEqual(Em.remainingKwh(e, 100, 30), 30, 'no session: whole need');
  e = Em.startSession(e, now, 100);
  assert.strictEqual(Em.remainingKwh(e, 108, 30), 22, 'charged in session');
  assert.strictEqual(Em.remainingKwh(e, 140, 30), 0);
  e = Em.endSession(e, now, 110);
  e = Em.endSession(Em.startSession(e, now, 110), now, 110.2); // too small: not learned
  [12, 8, 10].forEach((k) => {
    e = Em.endSession(Em.startSession(e, now, 0), now, k);
  });
  assert.deepStrictEqual(e.sessions.map((x) => x.kwh), [10, 12, 8, 10]);
  assert.ok(Math.abs(Em.sessionNeedKwh(e, 30, 50) - 10 * 1.2) < 1e-9, 'p75 x margin');
  assert.strictEqual(Em.sessionNeedKwh(e, 30, 10), 10, 'capped');
  assert.strictEqual(S.socLess(60, 6, 60), 50);
  assert.strictEqual(S.socLess(5, 6, 60), 0);
  const U = require('../../lib/strategies/EvUsageModel');
  const tr = [{ departFh: 7.5 }, { departFh: 17 }];
  assert.strictEqual(U.nearestTrip(tr, 8), 0);
  assert.strictEqual(U.nearestTrip(tr, 15), 1);
  assert.strictEqual(U.nearestTrip(tr, 12.3), -1, 'none within SAME_TRIP_HOURS');
  console.log('energy mode tests passed');
}
