/* eslint-disable no-console, max-classes-per-file */

'use strict';

// Closed-loop simulation of the main fuse guard with the real grid, battery (driver tick) and EV
// charger code: Homey stubbed, a fake clock, P1 every second, batteries with dead time and lag, an
// EV charger with a delayed response and a lagging power report. Run: node test/cases/fuse_guard_sim.js

const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') {
    class Base {}
    return {
      Device: Base, Driver: Base, App: Base, SimpleClass: Base,
    };
  }
  return origLoad.call(this, request, ...rest);
};

let T = Date.UTC(2026, 9, 19, 18, 0, 0);
Date.now = () => T;

const GridDevice = require('../../drivers/grid/device');
const BatDevice = require('../../drivers/battery/device');
const BatDriver = require('../../drivers/battery/driver');
const EvDevice = require('../../drivers/evCharger/device');
const PeakTariff = require('../../lib/strategies/PeakTariff');

const FUSE_W = 35 * 230; // 8050
const LIMIT_W = 7648; // 5 % margin

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`);
  }
};

let errorCount = 0;
const quiet = process.argv.includes('-v') ? console.log : () => {};

// ─── Plant ──────────────────────────────────────────────────────────────────

// deadS: dead time, tauS: first-order lag, reportS: how often its power is reported, stuck: ignores
// its setpoint.
const makeBatteryPlant = ({
  deadS = 2, tauS = 3, reportS = 1, stuck = false,
} = {}) => ({
  setW: 0,
  actW: 0,
  reportW: 0,
  lastReport: -Infinity,
  queue: [], // [{ at, w }]: dead time
  write(w) {
    if (!stuck) this.queue.push({ at: T + (deadS * 1000), w });
  },
  step() {
    while (this.queue.length && this.queue[0].at <= T) this.setW = this.queue.shift().w;
    this.actW += (this.setW - this.actW) * (1 - Math.exp(-1 / tauS)); // 1 s steps
    if (T - this.lastReport >= reportS * 1000) {
      this.lastReport = T;
      this.reportW = this.actW;
    }
  },
});

const makeEvPlant = ({ maxW, variable }) => ({
  on: true,
  targetW: maxW,
  actW: maxW,
  maxW,
  variable,
  queue: [],
  write(cap, v) {
    this.queue.push({ at: T + 5000, cap, v });
  },
  step() {
    while (this.queue.length && this.queue[0].at <= T) {
      const { cap, v } = this.queue.shift();
      if (cap === 'target_power') this.targetW = v;
      else this.on = v;
    }
    this.actW = this.on ? Math.min(this.maxW, this.targetW) : 0;
  },
});

// ─── Devices ────────────────────────────────────────────────────────────────

const build = ({
  batteries = 2, block = 'charge', mode = 'charge', ev = null, solarW = 0, plant = {}, stuck = [],
} = {}) => {
  const notifications = [];
  const logs = [];
  const homey = {
    drivers: { getDriver: (id) => drivers[id] }, // eslint-disable-line no-use-before-define
    notifications: {
      createNotification: async ({ excerpt }) => {
        notifications.push({ t: T, excerpt });
      },
    },
    __: (key, tokens) => `${key} ${JSON.stringify(tokens || {})}`,
    app: { xomSettings: { x: 0 } },
    settings: { get: () => null },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
  };
  const logger = (name) => ({
    log: (...a) => {
      logs.push(`${name} ${a.join(' ')}`); quiet(`${(T % 1e6) / 1000}s ${name}`, ...a);
    },
    error: (...a) => {
      errorCount += 1;
      logs.push(`${name} ERROR ${a.join(' ')}`); console.log(`ERROR ${name}`, ...a);
    },
  });

  // Grid
  const grid = Object.create(GridDevice.prototype);
  const gridCaps = { measure_watt_grid: 0 };
  const gridSettings = {
    connectionPhases: '1', connectionAmps: 35, connectionVoltage: 230, fuseMarginPct: 5,
  };
  Object.assign(grid, logger('grid'), {
    homey,
    peakConfig: PeakTariff.configFromSettings(gridSettings),
    capabilityInstances: { measurePowerRealtime: {} },
    getSettings: () => gridSettings,
    getCapabilityValue: (c) => gridCaps[c],
    hasCapability: () => true,
    setCapabilityValue: async (c, v) => {
      gridCaps[c] = v;
    },
    calculateHomePower: async () => {},
    getName: () => 'Grid',
  });

  // Batteries
  const batPlants = [];
  const plant0 = plant;
  const bats = [];
  for (let i = 0; i < batteries; i += 1) {
    const plant = makeBatteryPlant({ ...plant0, stuck: stuck.includes(i) }); // eslint-disable-line no-use-before-define
    batPlants.push(plant);
    const settings = {
      chargePower: 2200,
      dischargePower: 1700,
      batCapacity: 5,
      minChargeW: 0,
      minDischargeW: 0,
      peakShaving: false,
      fuseProtection: true,
      xomTarget: 0,
      dischargeToEv: true,
    };
    const store = { controlTakeover: true };
    const b = Object.create(BatDevice.prototype);
    Object.assign(b, logger(`bat${i}`), {
      homey,
      driver: null,
      soc: 50,
      sourceCapGroup: { setpoint: 'target_power' },
      sourceDevice: { capabilitiesObj: {}, setCapabilityValue: async ({ value }) => plant.write(value) },
      getSettings: () => settings,
      batterySettings: () => settings,
      getStoreValue: (k) => store[k],
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      getCapabilityValue: (c) => (c === 'measure_watt_avg' ? Math.round(plant.reportW) : null),
      getData: () => ({ id: `bat${i}` }),
      getName: () => `Sessy${i}`,
      reservePct: () => 10,
      isZeroControlled: () => true,
      pulseParams: () => null,
      takeControl: async () => {},
      setAction: async () => {},
      clearControlWarning: async () => {},
      checkSocDeviation: () => {},
      controlPrepare: async () => ({
        mode, slot: null, block, noCharge: false, refill: false,
      }),
    });
    bats.push(b);
  }
  const batDriver = Object.create(BatDriver.prototype);
  Object.assign(batDriver, logger('batDriver'), { homey, getDevices: () => bats });
  bats.forEach((b) => {
    b.driver = batDriver;
  });

  // EV charger
  let evPlant = null;
  const evs = [];
  if (ev) {
    evPlant = makeEvPlant(ev);
    const settings = {
      chargerControl: true, variableChargePower: !!ev.variable, chargePower: ev.maxW, maxSoc: 80, solarGridPower: 0,
    };
    const store = {};
    const e = Object.create(EvDevice.prototype);
    Object.assign(e, logger('ev'), {
      homey,
      signals: { switchOn: true },
      livePowerW: ev.maxW,
      presence: { atHome: true, chargeable: true },
      sourceCapGroup: { switchCap: 'onoff', powerCap: ev.variable ? 'target_power' : null },
      sourceDevice: { setCapabilityValue: async ({ capabilityId, value }) => evPlant.write(capabilityId, value) },
      getSettings: () => settings,
      getStoreValue: (k) => store[k],
      setStoreValue: async (k, v) => {
        store[k] = v;
      },
      getCapabilityValue: (c) => (c === 'ev_charge_mode' ? 'charge_temp' : null),
      getName: () => 'Laadpaal',
      _endTempModeIfDue: async () => false,
      _standby: () => false,
      _measuredSurplusW: () => null,
      _mayChargeOnSurplus: () => false,
      _solarNeedW: () => 1400,
    });
    evs.push(e);
  }

  const drivers = {
    grid: { getDevices: () => [grid] },
    battery: batDriver,
    evCharger: { getDevices: () => evs },
  };

  return {
    grid, gridCaps, bats, batPlants, batDriver, evs, evPlant, notifications, logs, solarW,
  };
};

// ─── Run ────────────────────────────────────────────────────────────────────

// loadW(t): home use without batteries and EV (s since start). p1Down(t): no P1 reading.
const run = async (sim, {
  seconds, loadW, solarW = () => 0, p1Down = () => false, p1EveryS = 1,
}) => {
  const t0 = T;
  const stats = {
    maxImportW: 0, maxExportW: 0, sAboveFuse: 0, sAboveLimit: 0, sExportAboveFuse: 0, trace: [],
  };
  let lastEvReport = -Infinity;
  for (let s = 0; s < seconds; s += 1) {
    T = t0 + (s * 1000);
    sim.batPlants.forEach((p) => p.step());
    if (sim.evPlant) {
      sim.evPlant.step();
      const [e] = sim.evs;
      // Charger reports: switch 2 s after a change, power every 10 s.
      if (e.signals.switchOn !== sim.evPlant.on && !e.switchReportAt) e.switchReportAt = T + 2000;
      if (e.switchReportAt && T >= e.switchReportAt) {
        e._setSwitchSignal(sim.evPlant.on);
        e.switchReportAt = null;
      }
      if (T - lastEvReport >= 10000) {
        lastEvReport = T;
        e.livePowerW = sim.evPlant.actW;
      }
    }
    const batW = sim.batPlants.reduce((a, p) => a + p.actW, 0);
    const evW = sim.evPlant ? sim.evPlant.actW : 0;
    const gridW = Math.round(loadW(s) - solarW(s) + batW + evW);
    stats.maxImportW = Math.max(stats.maxImportW, gridW);
    stats.maxExportW = Math.max(stats.maxExportW, -gridW);
    if (gridW > FUSE_W) stats.sAboveFuse += 1;
    if (gridW > LIMIT_W) stats.sAboveLimit += 1;
    if (-gridW > FUSE_W) stats.sExportAboveFuse += 1;
    stats.trace.push({
      s, gridW, batW: Math.round(batW), evW,
    });
    if (!p1Down(s) && s % p1EveryS === 0) await sim.grid.setCapability('measure_watt_grid', gridW);
    // Battery driver: every 5 s (EnergyPollingHelper), on the grid device's value.
    if (s % 5 === 0) await sim.batDriver.controlTick(sim.bats, sim.gridCaps.measure_watt_grid);
    // EV control tick: every 60 s.
    if (sim.evs.length && s % 60 === 59) await sim.evs[0]._applyChargerControl();
  }
  return stats;
};

const timeline = (st) => {
  const pts = [];
  let prev = null;
  st.trace.forEach((x) => {
    const key = `${Math.round(x.gridW / 250)}|${Math.round(x.batW / 250)}|${x.evW}`;
    if (key !== prev) pts.push(`${x.s}:${x.gridW}/${x.batW}/${x.evW}`);
    prev = key;
  });
  quiet(`     s:grid/bat/ev ${pts.join(' ')}`);
};

const show = (name, st, sim) => {
  timeline(st);
  console.log(`     ${name}: max import ${st.maxImportW} W, >fuse ${st.sAboveFuse} s, >limit ${st.sAboveLimit} s, max export ${st.maxExportW} W, `
    + `notifications ${sim.notifications.length}`);
};

(async () => {
  // 1. The user's case: 2 Sessy's charging at full power, EV on/off 3680 W, washer + dryer, then
  //    the washer's heater and the Quooker.
  {
    const sim = build({ ev: { maxW: 3680 } });
    // + dryer heater 2500 W: 8200 W home, 11880 W with the EV, 3400 W from the batteries.
    const loadW = (s) => 1500 + (s >= 120 ? 2000 : 0) + (s >= 150 && s < 210 ? 2200 : 0) + (s >= 150 && s < 400 ? 2500 : 0);
    const st = await run(sim, { seconds: 1500, loadW });
    show('charge + EV on/off + heater + Quooker + dryer', st, sim);
    test('1: batteries stop charging and discharge, EV off after 30 s, back on later', () => {
      const atS = (s) => st.trace[s];
      assert.ok(atS(60).gridW <= LIMIT_W + 100, `t=60 grid ${atS(60).gridW}`);
      assert.ok(atS(60).batW < 4400 - 1500, `batteries did not back off: ${atS(60).batW}`);
      // Heater + Quooker: 1500+2000+2200+3680 = 9380 W without batteries: EV must go.
      // Overload from s=150: EV off by the shed delay plus the charger's response.
      const off = st.trace.findIndex((x, i) => i > 150 && x.evW === 0);
      assert.ok(off > 0 && off <= 150 + 40, `EV off at ${off}`);
      const over = st.trace.slice(150).filter((x) => x.gridW > FUSE_W).length;
      assert.ok(over <= 40, `${over} s above the fuse after s=150`);
      assert.ok(sim.notifications.length === 1, `${sim.notifications.length} notifications`);
      assert.ok(/fuse_import_ev_off/.test(sim.notifications[0].excerpt), sim.notifications[0].excerpt);
      assert.ok(st.trace[1499].evW === 3680, `EV not back on: ${st.trace[1499].evW}`);
      assert.ok(st.trace.slice(1300).every((x) => x.gridW <= LIMIT_W), 'over the limit after the release');
    });
  }

  // 2. Variable EV charger 7360 W (assume a bigger connection share): cut, not off.
  {
    const sim = build({ ev: { maxW: 3680, variable: true } });
    const loadW = (s) => 1500 + (s >= 120 ? 2000 : 0) + (s >= 150 && s < 400 ? 4700 : 0);
    const st = await run(sim, { seconds: 1200, loadW });
    show('variable EV', st, sim);
    test('2: variable EV cut by the overload (not off), raised again', () => {
      const cut = st.trace.slice(150, 400).map((x) => x.evW);
      assert.ok(cut.some((w) => w > 0 && w < 3680), `no cut: ${[...new Set(cut)].join(',')}`);
      assert.ok(/fuse_import_ev_limited/.test((sim.notifications[0] || {}).excerpt || ''), JSON.stringify(sim.notifications));
      const over = st.trace.slice(150).filter((x) => x.gridW > FUSE_W).length;
      assert.ok(over <= 40, `${over} s above the fuse after s=150`);
      assert.strictEqual(st.trace[1199].evW, 3680);
      assert.ok(st.trace.slice(1000).every((x) => x.gridW <= LIMIT_W), 'over the limit after the raise');
    });
  }

  // 3. Export: 9 kW solar, batteries in a full discharge block.
  {
    const sim = build({ block: 'discharge', mode: 'discharge' });
    const st = await run(sim, { seconds: 300, loadW: () => 300, solarW: () => 9000 });
    show('export, discharge block', st, sim);
    test('3: export kept under the limit: batteries charge instead of discharge', () => {
      assert.ok(st.trace[120].gridW >= -LIMIT_W - 100, `t=120 grid ${st.trace[120].gridW}`);
      assert.ok(st.sExportAboveFuse <= 15, `${st.sExportAboveFuse} s export above the fuse`);
      assert.ok(st.trace[120].batW > 0, `batteries ${st.trace[120].batW}`);
    });
  }

  // 4. P1 down for 2 min while charging: power kept, not raised; back to normal after.
  {
    const sim = build({ block: 'charge', mode: 'charge', batteries: 1 });
    const st = await run(sim, {
      seconds: 400, loadW: () => 6000, p1Down: (s) => s >= 100 && s < 220,
    });
    show('P1 down', st, sim);
    test('4: stale P1 freezes the batteries', () => {
      const during = st.trace.slice(140, 220).map((x) => x.batW);
      assert.ok(Math.max(...during) <= st.trace[100].batW + 50, `raised while stale: ${Math.max(...during)} > ${st.trace[100].batW}`);
      assert.ok(sim.logs.some((l) => /no recent grid reading/.test(l)), 'no stale log');
      assert.ok(sim.logs.some((l) => /grid reading back/.test(l)), 'no recovery log');
    });
  }

  // 5. Zero on the meter (smart), big load, no EV: batteries cover what they can, one notification.
  {
    const sim = build({ block: 'zero', mode: 'smart' });
    const st = await run(sim, { seconds: 600, loadW: (s) => (s >= 60 ? 12000 : 2000) });
    show('zero, 12 kW load', st, sim);
    test('5: zero block discharges at full power, notified once', () => {
      assert.ok(st.trace[300].batW <= -3300, `batteries ${st.trace[300].batW}`);
      assert.strictEqual(sim.notifications.length, 1);
      assert.ok(/fuse_import /.test(sim.notifications[0].excerpt), sim.notifications[0].excerpt);
    });
  }

  // 6. Slow batteries (5 s dead time, tau 8 s, power reported every 10 s) and a DSMR4 meter
  //    (every 10 s): stable, no lasting overshoot.
  {
    const sim = build({ plant: { deadS: 5, tauS: 8, reportS: 10 } });
    const loadW = (s) => 2000 + (s >= 200 && s < 500 ? 4000 : 0);
    const st = await run(sim, { seconds: 900, loadW, p1EveryS: 10 });
    show('slow batteries, DSMR4', st, sim);
    test('6: slow batteries and P1: no stale, settles under the limit, no oscillation', () => {
      assert.ok(!sim.logs.some((l) => /no recent grid reading/.test(l)), 'stale with a 10 s meter');
      // A +4 kW step: one 10 s P1 interval plus the batteries' 5 s dead time and lag.
      assert.ok(st.sAboveFuse <= 20, `${st.sAboveFuse} s above the fuse`);
      assert.ok(st.sAboveLimit <= 40, `${st.sAboveLimit} s above the limit`);
      const tail = st.trace.slice(400, 500).map((x) => x.batW);
      assert.ok(Math.max(...tail) - Math.min(...tail) < 300, `oscillates: ${Math.min(...tail)}..${Math.max(...tail)}`);
      assert.strictEqual(sim.notifications.length, 0);
    });
  }

  // 7. One battery does not follow its setpoint (stuck at 0): the other takes the correction.
  {
    const sim = build({ stuck: [0] });
    const st = await run(sim, { seconds: 400, loadW: (s) => (s >= 100 ? 9000 : 3000) });
    show('one battery stuck', st, sim);
    test('7: the other battery takes the whole correction', () => {
      assert.ok(st.trace.slice(150).every((x) => x.gridW <= LIMIT_W), `grid ${st.trace[150].gridW}`);
      assert.ok(st.trace[200].batW < -1400, `batteries ${st.trace[200].batW}`);
    });
  }

  // 8. EV switch state never reported, charging measured: still switched off.
  {
    const sim = build({ ev: { maxW: 3680 }, block: 'zero', mode: 'smart' });
    sim.evs[0].signals.switchOn = undefined;
    sim.evs[0]._setSwitchSignal = () => {};
    const st = await run(sim, { seconds: 200, loadW: (s) => (s >= 20 ? 9000 : 2000) });
    show('EV switch unknown', st, sim);
    test('8: EV off without a reported switch state', () => {
      assert.ok(st.trace.slice(50, 80).some((x) => x.evW === 0), 'EV not switched off');
    });
  }

  if (errorCount) console.log(`${errorCount} errors logged by the devices`);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed || errorCount ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
