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
const PHASE_FUSE_W = 25 * 230; // 5750, 3x25A
const PHASE_LIMIT_W = 5462; // 5 % margin
const THREE_PHASE = { connectionPhases: '3', connectionAmps: 25 };

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

// realPrepare: the device's own controlPrepare() (smart, no plan yet) instead of a fixed block.
// gridSettings: overrides of the 1x35A connection, e.g. 3x25A.
const build = ({
  batteries = 2, block = 'charge', mode = 'charge', ev = null, solarW = 0, plant = {}, stuck = [], realPrepare = false, gridSettings: gridOver = {},
  batteryPhase = [], batteryVotes = [],
} = {}) => {
  const notifications = [];
  const logs = [];
  const timers = [];
  const homey = {
    setTimeout: (fn, ms) => timers.push({ at: T + ms, fn }),
    timers,
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
  const gridStore = {};
  const gridSettings = {
    connectionPhases: '1', connectionAmps: 35, connectionVoltage: 230, fuseMarginPct: 5, ...gridOver,
  };
  Object.assign(grid, logger('grid'), {
    homey,
    peakConfig: PeakTariff.configFromSettings(gridSettings),
    capabilityInstances: { measurePowerRealtime: {} },
    getSettings: () => gridSettings,
    getStoreValue: (k) => gridStore[k],
    setStoreValue: async (k, v) => {
      gridStore[k] = v;
    },
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
      batteryPhase: batteryPhase[i],
    };
    const store = { controlTakeover: true, phaseVotes: batteryVotes[i] };
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
      ...(realPrepare ? {
        initReady: true,
        initTm: T,
        latestPlan: null,
        checkPlanSlot: () => {},
        endTempModeIfDue: async () => {},
        inGroup: () => false,
        isControlConfigured: () => true,
        getBatteryMode: () => 'smart',
      } : {
        controlPrepare: async () => ({
          mode, slot: null, block, noCharge: false, refill: false,
        }),
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
      chargerControl: true, variableChargePower: !!ev.variable, chargePower: ev.maxW, maxSoc: 80, solarGridPower: 0, chargerPhase: ev.chargerPhase, chargerBalancing: !!ev.balancing,
    };
    const store = { phaseVotes: ev.votes };
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
// phaseLoadW(t): home use per phase [L1, L2, L3] (3-phase runs); evPhases: the phases the car
// takes from; batOn: per battery the phases it is on.
const run = async (sim, {
  seconds, loadW, solarW = () => 0, p1Down = () => false, p1EveryS = 1, phaseLoadW = null, evPhases = [0, 1, 2], batOn = [],
}) => {
  const t0 = T;
  const stats = {
    maxImportW: 0, maxExportW: 0, sAboveFuse: 0, sAboveLimit: 0, sExportAboveFuse: 0, trace: [],
  };
  let lastEvReport = -Infinity;
  for (let s = 0; s < seconds; s += 1) {
    const tNow = t0 + (s * 1000);
    T = tNow;
    const due = sim.grid.homey.timers.filter((x) => x.at <= tNow);
    due.forEach((x) => sim.grid.homey.timers.splice(sim.grid.homey.timers.indexOf(x), 1));
    for (const x of due) await x.fn();
    sim.batPlants.forEach((p, i) => {
      p.step();
      if (p.lastReport === tNow) sim.bats[i].lastReportTm = tNow;
    });
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
    let gridW;
    let tracePhaseW = null;
    if (phaseLoadW) {
      const phaseW = phaseLoadW(s).map((w, i) => Math.round(w + (evPhases.includes(i) ? evW / evPhases.length : 0)
        + sim.batPlants.reduce((a, p, k) => {
          const on = batOn[k] || [0, 1, 2];
          return a + (on.includes(i) ? p.actW / on.length : 0);
        }, 0)));
      gridW = phaseW.reduce((a, w) => a + w, 0);
      stats.maxPhaseW = Math.max(stats.maxPhaseW || 0, ...phaseW);
      tracePhaseW = phaseW;
      if (Math.max(...phaseW) > PHASE_FUSE_W) stats.sAbovePhaseFuse = (stats.sAbovePhaseFuse || 0) + 1;
      if (!p1Down(s) && s % p1EveryS === 0) {
        sim.grid.phaseW = phaseW;
        sim.grid.phaseSeen = [true, true, true];
      }
    } else gridW = Math.round(loadW(s) - solarW(s) + batW + evW);
    stats.maxImportW = Math.max(stats.maxImportW, gridW);
    stats.maxExportW = Math.max(stats.maxExportW, -gridW);
    if (gridW > FUSE_W) stats.sAboveFuse += 1;
    if (gridW > LIMIT_W) stats.sAboveLimit += 1;
    if (-gridW > FUSE_W) stats.sExportAboveFuse += 1;
    stats.trace.push({
      s, gridW, batW: Math.round(batW), evW, phaseW: tracePhaseW, batsW: sim.batPlants.map((p) => Math.round(p.actW)),
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

  // 9. Release: the batteries make room before the car starts, and do not keep discharging after.
  {
    const sim = build({ ev: { maxW: 3680 } });
    const loadW = (s) => 1500 + (s >= 100 && s < 300 ? 6700 : 0);
    const st = await run(sim, { seconds: 1200, loadW });
    show('release with grid-charging batteries', st, sim);
    test('9: release without a fuse spike or a long forced discharge', () => {
      const on = st.trace.findIndex((x, i) => i > 300 && x.evW > 0);
      assert.ok(on > 0, 'EV not released');
      const after = st.trace.slice(on, on + 120);
      assert.ok(after.every((x) => x.gridW <= FUSE_W), `above the fuse after release: ${Math.max(...after.map((x) => x.gridW))}`);
      const discharging = after.filter((x) => x.batW < -500).length;
      assert.ok(discharging <= 15, `${discharging} s forced discharge after the release`);
    });
  }

  // 10. Smart without a plan yet (first minutes after a start): left alone, unless overloaded.
  {
    const sim = build({ realPrepare: true, batteries: 1 });
    sim.batPlants[0].setW = 2200;
    sim.batPlants[0].actW = 2200;
    const st = await run(sim, { seconds: 300, loadW: (s) => (s >= 100 ? 7000 : 2000) });
    show('no plan yet', st, sim);
    test('10: no plan: untouched below the limit, protected above it', () => {
      assert.ok(st.trace[90].batW > 2100, `touched without overload: ${st.trace[90].batW}`);
      assert.ok(st.trace[200].gridW <= LIMIT_W, `not protected: ${st.trace[200].gridW}`);
    });
  }

  // 11. A realtime grid source reporting every 60 s: not stale between its readings.
  {
    const sim = build({ batteries: 1, block: 'zero', mode: 'smart' });
    await run(sim, {
      seconds: 900, loadW: () => 1000, solarW: () => 2000, p1EveryS: 60,
    });
    test('11: a 60 s meter is not stale once its interval is learned', () => {
      const stale = sim.logs.filter((l) => /no recent grid reading/.test(l)).length;
      assert.ok(stale <= 1, `${stale} stale episodes`);
    });
  }

  // 12. 3x25A, 1-phase EV on L1 and an oven on L1: the total is far under the main fuse, L1 is not.
  {
    const sim = build({ batteries: 0, ev: { maxW: 3680, chargerPhase: 'l1' }, gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 400 ? 3000 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 1500, loadW: () => 0, phaseLoadW, evPhases: [0],
    });
    show('3-phase, 1-phase EV + oven on L1', st, sim);
    test('12: EV on the overloaded phase switched off, back on later', () => {
      const off = st.trace.findIndex((x, i) => i > 100 && x.evW === 0);
      assert.ok(off > 0 && off <= 100 + 40, `EV off at ${off}`);
      assert.ok(st.sAbovePhaseFuse <= 40, `${st.sAbovePhaseFuse} s above the phase fuse`);
      assert.ok(/fuse_phase_import_ev_off .*"phase":"L1"/.test((sim.notifications[0] || {}).excerpt || ''), JSON.stringify(sim.notifications));
      assert.strictEqual(st.trace[1499].evW, 3680, 'EV not back on');
    });
  }

  // 13. 1-phase EV on L2, overload on L1: the EV is left alone, notified.
  {
    const sim = build({ batteries: 0, ev: { maxW: 3680, chargerPhase: 'l2' }, gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 300 ? 5500 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 400, loadW: () => 0, phaseLoadW, evPhases: [1],
    });
    show('3-phase, EV on L2, overload on L1', st, sim);
    test('13: EV on another phase not cut', () => {
      assert.ok(st.trace.every((x) => x.evW === 3680), 'EV cut');
      assert.ok(/fuse_phase_import .*"phase":"L1"/.test((sim.notifications[0] || {}).excerpt || ''), JSON.stringify(sim.notifications));
    });
  }

  // 14. Variable 3-phase EV 11 kW (phases not learned), oven on L1: cut by 3x the L1 overload.
  {
    const sim = build({ batteries: 0, ev: { maxW: 11000, variable: true }, gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 400 ? 3000 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 1500, loadW: () => 0, phaseLoadW,
    });
    show('3-phase, variable 11 kW EV + oven on L1', st, sim);
    test('14: variable EV cut to fit L1, raised again', () => {
      const cut = st.trace.slice(100, 400).map((x) => x.evW);
      assert.ok(cut.some((w) => w > 1400 && w < 11000), `no cut: ${[...new Set(cut)].join(',')}`);
      assert.ok(st.sAbovePhaseFuse <= 40, `${st.sAbovePhaseFuse} s above the phase fuse`);
      const l1 = st.trace.slice(160, 400).map((x) => 3300 + x.evW / 3);
      assert.ok(Math.max(...l1) <= PHASE_LIMIT_W, `L1 ${Math.max(...l1)} after the cut`);
      assert.strictEqual(st.trace[1499].evW, 11000, 'not raised again');
    });
  }

  // 15. 3x25A, Sessy's on L1 and L2 charging from the grid, a big load on L1: the L1 battery
  //     discharges for L1, the L2 battery keeps charging.
  {
    const sim = build({ gridSettings: THREE_PHASE, batteryPhase: ['l1', 'l2'] });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 400 ? 5500 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 500, loadW: () => 0, phaseLoadW, batOn: [[0], [1]],
    });
    show('3-phase, batteries on L1/L2, load on L1', st, sim);
    test('15: battery on the overloaded phase covers it, the other keeps charging', () => {
      const x = st.trace[300];
      assert.ok(x.phaseW[0] <= PHASE_LIMIT_W, `L1 ${x.phaseW[0]}`);
      assert.ok(x.batsW[0] < -300, `L1 battery ${x.batsW[0]}`);
      assert.ok(x.batsW[1] > 2000, `L2 battery ${x.batsW[1]}`);
      assert.ok(st.sAbovePhaseFuse <= 20, `${st.sAbovePhaseFuse} s above the phase fuse`);
      assert.strictEqual(sim.notifications.length, 0);
      assert.ok(st.trace[499].batsW.every((w) => w > 2000), `not charging again: ${st.trace[499].batsW}`);
    });
  }

  // 16. Same, phases unknown: charging stops, no forced discharge (they may be on L2), notified.
  {
    const sim = build({ gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 400 ? 5500 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 500, loadW: () => 0, phaseLoadW, batOn: [[0], [1]],
    });
    show('3-phase, batteries unknown phase, load on L1', st, sim);
    test('16: unknown phase: limited to 0, not discharged', () => {
      const x = st.trace[300];
      assert.ok(x.batsW.every((w) => Math.abs(w) < 100), `batteries ${x.batsW}`);
      assert.ok(/fuse_phase_import .*"phase":"L1"/.test((sim.notifications[0] || {}).excerpt || ''), JSON.stringify(sim.notifications));
    });
  }

  // 17. 1-phase EV and a grid-charging battery on L1, load on L1: the battery gives way, the EV
  //     charges on.
  {
    const sim = build({
      batteries: 1, gridSettings: THREE_PHASE, batteryPhase: ['l1'], ev: { maxW: 3680, chargerPhase: 'l1' },
    });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 600 ? 2500 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 700, loadW: () => 0, phaseLoadW, evPhases: [0], batOn: [[0]],
    });
    show('3-phase, EV + battery on L1', st, sim);
    test('17: battery yields on L1, EV not cut', () => {
      assert.ok(st.trace.every((x) => x.evW === 3680), 'EV cut');
      assert.ok(st.trace[300].phaseW[0] <= PHASE_LIMIT_W, `L1 ${st.trace[300].phaseW[0]}`);
      assert.ok(st.sAbovePhaseFuse <= 20, `${st.sAbovePhaseFuse} s above the phase fuse`);
    });
  }

  // 18. EV learned on L2, really on L1 (a wrong lesson), oven on L1: cut once the overload lasts.
  {
    const sim = build({ batteries: 0, ev: { maxW: 3680, votes: Array(10).fill('l2') }, gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 400 ? 3000 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 1500, loadW: () => 0, phaseLoadW, evPhases: [0],
    });
    show('3-phase, EV wrongly learned on L2, oven on L1', st, sim);
    test('18: wrongly learned EV still switched off, not back on into the overload', () => {
      const off = st.trace.findIndex((x, i) => i > 100 && x.evW === 0);
      assert.ok(off > 0 && off <= 100 + 75, `EV off at ${off}`);
      assert.ok(st.trace.slice(off, 400).every((x) => x.evW === 0), 'back on during the overload');
      assert.ok(sim.logs.some((l) => /learned phases not trusted/.test(l)), 'no distrust log');
      assert.strictEqual(st.trace[1499].evW, 3680, 'EV not back on');
    });
  }

  // 19. Battery learned on L2, really on L1, grid charging, load on L1: it stops charging.
  {
    const sim = build({ batteries: 1, gridSettings: THREE_PHASE, batteryVotes: [Array(10).fill('l2')] });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 500 ? 3500 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 600, loadW: () => 0, phaseLoadW, batOn: [[0]],
    });
    show('3-phase, battery wrongly learned on L2, load on L1', st, sim);
    test('19: wrongly learned battery stops charging on the overloaded phase', () => {
      assert.ok(st.trace[100].batsW[0] > 2000, `not charging before: ${st.trace[100].batsW[0]}`);
      assert.ok(st.trace.slice(200, 500).every((x) => x.phaseW[0] <= PHASE_LIMIT_W), `L1 ${Math.max(...st.trace.slice(200, 500).map((x) => x.phaseW[0]))}`);
    });
  }

  // 20. A charger that guards the fuse itself: never cut by the app.
  {
    const sim = build({ batteries: 0, ev: { maxW: 3680, chargerPhase: 'l1', balancing: true }, gridSettings: THREE_PHASE });
    const phaseLoadW = (s) => [300 + (s >= 100 && s < 300 ? 3000 : 0), 300, 300];
    const st = await run(sim, {
      seconds: 400, loadW: () => 0, phaseLoadW, evPhases: [0],
    });
    test('20: charger guarding the fuse itself is left alone', () => {
      assert.ok(st.trace.every((x) => x.evW === 3680), 'EV cut');
      assert.ok(/fuse_phase_import /.test((sim.notifications[0] || {}).excerpt || ''), JSON.stringify(sim.notifications));
    });
  }

  // 21. The connection setting against the meter: notified once, cleared when they match.
  {
    const sim = build({ batteries: 0, gridSettings: THREE_PHASE });
    const { grid } = sim;
    grid.phaseW = [500, 0, 0];
    grid.phaseSeen = [true, false, false];
    grid.phaseListenTm = T;
    grid.checkPhaseSetup(T + 30 * 60 * 1000);
    grid.checkPhaseSetup(T + 61 * 60 * 1000);
    grid.checkPhaseSetup(T + 62 * 60 * 1000);
    const one = sim.notifications.filter((n) => /phase_setup_one/.test(n.excerpt)).length;
    grid.getSettings().connectionPhases = '1';
    grid.phaseSeen = [true, true, true];
    grid.checkPhaseSetup(T + 63 * 60 * 1000);
    test('21: 1-phase meter on a 3-phase setting and the reverse, each notified once', () => {
      assert.strictEqual(one, 1);
      assert.strictEqual(sim.notifications.filter((n) => /phase_setup_three/.test(n.excerpt)).length, 1);
      assert.strictEqual(grid.getStoreValue('phaseSetupNotified'), 'phase_setup_three');
    });
  }

  if (errorCount) console.log(`${errorCount} errors logged by the devices`);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed || errorCount ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
