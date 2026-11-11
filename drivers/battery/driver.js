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

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
const PairSetup = require('../../lib/helpers/PairSetup');
const SourceCaps = require('../../lib/helpers/SourceCaps');
const BatteryControl = require('../../lib/strategies/BatteryControl');
const FuseGuard = require('../../lib/strategies/FuseGuard');

// A flow's XOM target is written to the battery setting once it did not change for this long.
const XOM_MIRROR_MS = 15 * 60 * 1000;
// Built-in control: below this a small total stays on the grid (the per-battery thresholds apply on
// top); the XOM flows use their own minLoad (flow card 'Set XOM').
const BUILTIN_MIN_LOAD_W = 50;
const EV_REPLAN_DELAY_MS = 2000;
// Modes whose plan stores solar surplus.
const SURPLUS_MODES = ['smart', 'self_consumption', 'xom'];
// Wear helper: the rated cycles run until the battery has this share of its capacity left (end of
// life, typically 70%); on average it then holds (1 + share) / 2 of its capacity per cycle.
const WEAR_END_OF_LIFE = 0.7;
// A new battery's minimum profit: this share of the mean price of its tariff group (any currency).
const MIN_PROFIT_SHARE = 0.1;
// Pairing with a capacity tariff: the reserve its hint advises.
const PEAK_RESERVE_PCT = 10;
// Dependencies are lazy loaded in methods to save memory

// The screens of the setup view, in order (lib/helpers/PairSetup.js). Pairing asks the battery, its
// control and the price; the rest starts at its default and is changed in repair.
const STEPS = [
  { id: 'device', ids: [], roles: true },
  { id: 'device_meters', ids: [], roles: true },
  { id: 'battery', ids: ['batCapacity', 'chargePower', 'dischargePower', 'batteryPhase'] },
  { id: 'control', ids: ['batteryControl', 'calibrateDays'] },
  { id: 'wear', ids: ['wearCalc', 'wearPurchasePrice', 'wearCycles', 'wearCost', 'minProfit'], repairOnly: true },
  { id: 'price', ids: ['tariff_update_group'] },
  { id: 'plan', ids: ['dischargeToEv', 'groupPlan'], repairOnly: true },
  // When pairing only with a capacity tariff on the grid device: else there is nothing to choose.
  { id: 'grid_limits', ids: ['fuseProtection', 'peakShaving', 'peakReservePct'], repairOnly: (driver) => !driver.hasPeakTariff() },
  {
    id: 'advanced',
    ids: ['tariff_type', 'precisePlanning', 'chartShowPower', 'chartShowSoc', 'chartShowExportPrice', 'chartShowLegend'],
    repairOnly: true,
  },
];

const driverSpecifics = {
  driverId: 'battery',
  // Vendor exceptions, used only when a source device does not qualify as a Homey battery (class
  // 'battery' + measure_battery + measure_power). Homey standard: positive = charging
  // (https://apps.developer.homey.app/the-basics/devices/energy#home-batteries).
  //   - `power` + `invertPower`: one signed capability; invertPower when the vendor's sign is opposite.
  //   - `chargePower` + `dischargePower`: two non-negative magnitudes.
  sourceCapGroups: [
    {
      soc: 'measure_battery_soc', power: 'measure_battery_power', invertPower: true, // Solax (unverified)
    },
    {
      soc: 'battery_capacity', power: 'measure_power.battery', invertPower: true, // Victron (unverified)
    },
    {
      // Sessy fallback for older app versions without class 'battery': legacy inverted measure_power.battery.
      soc: 'measure_battery', power: 'measure_power.battery', invertPower: true, // Sessy (legacy fallback)
    },
    {
      soc: 'measure_battery', chargePower: 'measure_power.batt_in', dischargePower: 'measure_power.batt_out', // Sonnen
    },
    {
      soc: 'measure_battery', chargePower: 'to_battery_capability', dischargePower: 'from_battery_capability', // Sonnen Batterie
    },
    {
      soc: 'measure_percentage.bat_soc', power: 'measure_power.battery', invertPower: true, // Blauhoff Afore (unverified)
    },
    {
      soc: 'measure_percentage.battery1', power: 'measure_power.battery1', invertPower: true, // Blauhoff Deye (unverified)
    },
    {
      soc: 'measure_battery', power: 'measure_power', invertPower: true, // SolarEdge Growatt (unverified)
    },
  ],
  deviceCapabilities: [
    'measure_watt_avg', 'meter_kwh_stored',
    'meter_kwh_charging', 'meter_kwh_discharging',
    'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month',
    'meter_money_last_year', 'meter_money_this_year',
    'meter_tariff',
    'meter_power_hidden',
  ],
  // Asked at pair and repair (lib/helpers/PairSetup.js), not on the settings page.
  setup: {
    settings: STEPS.flatMap((st) => st.ids),
    steps: STEPS,
    calcInputs: ['wearCalc', 'batCapacity', 'wearPurchasePrice', 'wearCycles'],
    match: {
      classes: ['battery'],
      energy: (energy) => !!(energy.meterPowerImportedCapability || energy.meterPowerExportedCapability),
    },
  },
  // Chart image order, see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'todayChargeChart', prop: 'todayChargeImage', chartProp: 'chartTodayCharge', titleKey: 'today',
    },
    {
      id: 'tomorrowChargeChart', prop: 'tomorrowChargeImage', chartProp: 'chartTomorrowCharge', titleKey: 'tomorrow',
    },
    {
      id: 'nextHoursChargeChart', prop: 'nextHoursChargeImage', chartProp: 'chartNextHoursCharge', titleKey: 'nextHours',
    },
    {
      id: 'yesterdayChargeChart', prop: 'yesterdayChargeImage', chartProp: 'chartYesterdayCharge', titleKey: 'yesterday',
    },
    {
      id: 'efficiencyChart', prop: 'efficiencyImage', chartProp: 'chartEfficiency', titleKey: 'chart_eff.title',
    },
  ],
};

class BatteryDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

  // The grid power: XOM and the built-in control, on a change or at least every 10 s.
  async onEnergyReport(report) {
    const gridW = await EnergyPollingHelper.gridPowerW(report);
    if (!Number.isFinite(gridW)) return;
    this.getDevices().forEach((device) => {
      device.currentGridPower = gridW;
    });
    const now = Date.now();
    const last = this.energyTick || { gridW: null, tm: 0 };
    if (gridW === last.gridW && (now - last.tm) <= 10000) return;
    this.energyTick = { gridW, tm: now };
    await this.processEnergyLogic(gridW, last.tm > 0 ? (now - last.tm) / 1000 : EnergyPollingHelper.intervalSeconds);
  }

  async processEnergyLogic(cumulativePower, interval) {
    let app;
    try {
      app = this.homey.app;
    } catch {
      return;
    }
    const xomSettings = app.xomSettings || this.homey.settings.get('xomSettings') || {};
    const { smoothing = 50, minLoad = 50 } = xomSettings;
    const samples = Math.max(1, Math.round((smoothing / 100) * (120 / Math.max(1, interval))));
    this.mirrorXomTarget(Date.now());

    const devices = this.getDevices();
    // Batteries this app controls itself are left out of the XOM flows.
    const flowDevices = devices.filter((d) => !(typeof d.isXomControlled === 'function' && d.isXomControlled()));
    const x = this.xomAimW(flowDevices, cumulativePower, (d) => d.xomTargetPower || 0);

    // eslint-disable-next-line global-require
    const XomSplit = require('../../lib/strategies/XomSplit');
    const splits = XomSplit.split({
      devices: flowDevices,
      cumulativePower,
      x,
      minLoad,
    });

    const promises = flowDevices.map((device) => {
      const split = splits.find((info) => info.id === device.getData().id);
      return device.triggerXOMFlow(split, samples, x, smoothing, minLoad, cumulativePower);
    });
    await Promise.all(promises);
    await this.controlTick(devices, cumulativePower);
  }

  // The batteries planned as one, in one mode (setting groupPlan, not 'device'), controlled here
  // or by flows.
  // The batteries that plan on solar surplus, for the EV planner (null: none): per 15 min their
  // room (AC kWh, null without a plan) and whether storing pays; capacity, efficiencies (weighted by
  // capacity) and the lowest cycle cost.
  solarStorage(startMs, endMs) {
    const list = this.getDevices().filter((d) => SURPLUS_MODES.includes(d.getBatteryMode()) && d.latestPlan)
      .map((d) => d.solarStorageSeries(startMs, endMs)).filter((b) => b.capKwh > 0);
    if (!list.length) return null;
    const capKwh = list.reduce((a, b) => a + b.capKwh, 0);
    const weighted = (k) => list.reduce((a, b) => a + b.capKwh * b[k], 0) / capKwh;
    return {
      capKwh,
      effC: weighted('effC'),
      effD: weighted('effD'),
      cycleCost: Math.min(...list.map((b) => b.cycleCost)),
      room: list[0].room.map((_, q) => {
        const vals = list.map((b) => b.room[q]).filter((v) => typeof v === 'number');
        return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
      }),
      store: list[0].store.map((_, q) => list.some((b) => b.store[q])),
    };
  }

  // After a mode change: the EV chargers plan again, once for a group's changes in a row.
  replanEvChargers() {
    this.homey.clearTimeout(this.evReplanTimer);
    this.evReplanTimer = this.homey.setTimeout(() => {
      try {
        this.homey.drivers.getDriver('evCharger').getDevices()
          .forEach((d) => d.updatePlan && d.updatePlan().catch((err) => d.error(err)));
      } catch {
        // no EV driver or devices
      }
    }, EV_REPLAN_DELAY_MS);
  }

  groupDevices() {
    return this.getDevices().filter((d) => typeof d.inGroup === 'function' && d.inGroup());
  }

  // A mode for the whole group (picker, flow), with the same end time of a temporary mode. origin
  // joins too (it can come from 'device').
  async setGroupMode(mode, reason, until, origin) {
    const group = this.groupDevices();
    if (origin && !group.includes(origin)) group.push(origin);
    this.log(`[Bat Control] Group mode ${mode} for ${group.map((d) => d.getName()).join(', ')} (${reason})`);
    for (const d of group) {
      await d.setBatteryMode(mode, reason, 0, { sync: false, until }).catch((err) => d.error(err));
    }
  }

  // Built-in control. XOM (xom/hold blocks) is split over the batteries by
  // XomSplit, as for the XOM flows, against the grid without the batteries this app forces
  // (charge/discharge/idle), so the batteries do not trade energy with each other.
  // The XOM target (W): the app setting xomSettings.x, set by the flow card 'Set XOM' and by the
  // battery setting xomTarget. That setting shows it: a flow's value is written there only once
  // stable for XOM_MIRROR_MS (a device setting is not for frequent writes).
  xomW() {
    const xs = this.homey.app.xomSettings || this.homey.settings.get('xomSettings') || {};
    if (xs.x !== undefined && xs.x !== null && Number.isFinite(Number(xs.x))) return Number(xs.x);
    const first = this.getDevices()[0];
    return first ? Number(first.getSettings().xomTarget) || 0 : 0;
  }

  // The aim for these batteries: with 'Discharge into EV' off on any of them (as the plan) the aim
  // moves up by the EV chargers' power, on the discharge side only: the batteries never discharge
  // into the EV, charging from surplus stays as it is. powerOf: what XOM integrates on per battery.
  xomAimW(devices, gridW, powerOf) {
    const baseW = this.xomW();
    if (!devices.length || devices.every((d) => d.getSettings().dischargeToEv !== false)) return baseW;
    let evW = 0;
    try {
      evW = this.homey.drivers.getDriver('evCharger').getDevices()
        .reduce((a, d) => a + Math.max(0, Number(d.getCapabilityValue('measure_watt_avg')) || 0), 0);
    } catch {
      return baseW;
    }
    const needW = devices.reduce((a, d) => a + powerOf(d), 0) - (gridW - baseW);
    return needW >= 0 ? baseW : baseW + Math.min(evW, -needW);
  }

  // The battery setting xomTarget changed by the user: the XOM target now, on all batteries.
  setXomTargetFromSetting(value, origin) {
    const x = Number(value) || 0;
    const xs = { ...(this.homey.app.xomSettings || this.homey.settings.get('xomSettings') || {}), x };
    this.homey.settings.set('xomSettings', xs);
    this.homey.app.xomSettings = xs;
    this.xomFlowTm = null;
    this.getDevices().filter((d) => d !== origin && Number(d.getSettings().xomTarget) !== x).forEach((d) => {
      d.setSettings({ xomTarget: x }).catch((err) => d.error(err));
    });
  }

  // The flow card 'Set XOM' set the target: shown in the battery setting once stable.
  onXomFlow() {
    this.xomFlowTm = Date.now();
  }

  mirrorXomTarget(now) {
    if (!this.xomFlowTm || now - this.xomFlowTm < XOM_MIRROR_MS) return;
    this.xomFlowTm = null;
    const x = this.xomW();
    this.getDevices().filter((d) => Number(d.getSettings().xomTarget) !== x).forEach((d) => {
      d.setSettings({ xomTarget: x }).catch((err) => d.error(err));
    });
  }

  // Calibration (BatteryCalibration): at most half of the batteries that may calibrate at once (at
  // least one), so the others keep their reserve; the longest waiting first.
  async calibrationTick(devices, now) {
    const ready = devices.filter((d) => typeof d.calibrationReady === 'function' && d.initReady && d.calibrationReady());
    if (!ready.length) return;
    const limit = Math.max(1, Math.floor(ready.length / 2));
    let running = ready.filter((d) => d.calibration && d.calibration.phase).length;
    const due = ready.filter((d) => d.calibrationDue(now))
      .sort((a, b) => Number(b.calibration.requested) - Number(a.calibration.requested) || a.calibration.lastTm - b.calibration.lastTm);
    for (const d of due) {
      if (running >= limit) return;
      if (await d.startCalibration(now).catch((err) => d.error(err))) running += 1;
    }
  }

  // Something all plans depend on changed (a calibration): every battery plans again, no cache.
  async replanAll(reason) {
    const devices = this.getDevices().filter((d) => typeof d.replan === 'function');
    devices.forEach((d) => {
      d.lastPlanTm = null;
      d.lastPlanKey = null;
      d.groupPlans = null;
    });
    for (const d of devices) await d.replan(reason).catch((err) => d.error(err));
  }

  async controlTick(devices, gridW) {
    const now = Date.now();
    await this.calibrationTick(devices, now);
    const preps = new Map();
    for (const d of devices) {
      if (typeof d.controlPrepare === 'function') {
        const prep = await d.controlPrepare(now).catch((err) => d.error(err));
        if (prep) preps.set(d, prep);
      }
    }
    const active = [...preps.keys()];
    if (!active.length) return;
    const isXom = (d) => ['xom', 'hold'].includes(preps.get(d).block) && !preps.get(d).refill;
    const forcedW = active.filter((d) => !isXom(d)).reduce((a, d) => a + d.controlCommandW(), 0);
    const xomGridW = gridW - forcedW;
    const candidates = active.filter(isXom);
    // Hold batteries only take part when charging, noCharge batteries (surplus not worth storing)
    // only when discharging: else XomSplit gives them a share they do not take.
    const xomW = this.xomAimW(candidates, xomGridW, (d) => d.integratorW());
    const charging = candidates.reduce((a, d) => a + d.controlCommandW(), 0) - (xomGridW - xomW) > 0;
    const xomDevices = candidates.filter((d) => (charging ? !preps.get(d).noCharge : preps.get(d).block === 'xom'));
    // XomSplit reads xomTargetPower: here what control decided last, within the lead of the
    // measured power; capW: a battery not doing its setpoint, or (discharging) the plan's power
    // where it covers the deficit in part, so the others do not take that part over.
    const capOf = (d) => {
      const follow = d.followCapW || null;
      const planW = !charging && preps.get(d).homeCapW;
      if (!planW || (follow && follow.dir === -1 && follow.w <= planW)) return follow;
      return { dir: -1, w: planW };
    };
    const views = xomDevices.map((d) => ({
      getData: () => d.getData(),
      getName: () => d.getName(),
      getSettings: () => d.getSettings(),
      batterySettings: () => d.batterySettings(),
      getCapabilityValue: (cap) => d.getCapabilityValue(cap),
      soc: d.soc,
      reservePct: () => d.reservePct(),
      xomTargetPower: d.integratorW(),
      capW: capOf(d),
    }));
    // eslint-disable-next-line global-require
    const XomSplit = require('../../lib/strategies/XomSplit');
    const splits = views.length ? XomSplit.split({
      devices: views, cumulativePower: xomGridW, x: xomW, minLoad: BUILTIN_MIN_LOAD_W,
    }) : [];
    const weight = (d) => Math.max(1, Number(d.getSettings().chargePower) || 0);
    const total = active.reduce((a, d) => a + weight(d), 0);
    // A phase correction: shared by the batteries that may be on the same phases (as phaseBounds() sees them).
    // eslint-disable-next-line global-require
    const grid = require('../../lib/helpers/GridConnection').gridDevice(this.homey);
    const trust = !grid || typeof grid.trustsLearnedPhases !== 'function' || grid.trustsLearnedPhases(now);
    const specs = new Map(active.map((d) => [d, typeof d.fusePhases === 'function' ? d.fusePhases(trust) : {}]));
    const phaseShare = (d) => weight(d) / active
      .filter((e) => FuseGuard.phasesOverlap(specs.get(d), specs.get(e))).reduce((a, e) => a + weight(e), 0);
    const before = new Map(active.map((d) => [d, {
      actW: Number(d.getCapabilityValue('measure_watt_avg')), idleMs: d.lastActiveTm ? now - d.lastActiveTm : null,
    }]));
    await Promise.all(active.map((d) => {
      // Not in zero on the meter now (forced block, or hold while discharging): no XOM part.
      let xom = { targetW: 0, needW: 0 };
      const split = xomDevices.includes(d) && splits.find((info) => info.id === d.getData().id);
      if (split) {
        // BatteryControl.xomStep(): short spikes left to the grid, less at once. The battery's max
        // (or its cap) at once.
        const step = BatteryControl.xomStep({
          prevW: d.xomTargetW, targetW: split.target, riseSince: d.xomRiseSince, now,
        });
        d.xomRiseSince = step.riseSince;
        d.xomTargetW = Math.max(-split.maxDischarge, Math.min(split.maxCharge, step.w));
        xom = { targetW: d.xomTargetW, needW: split.target };
      } else {
        d.xomTargetW = null;
        d.xomRiseSince = null;
      }
      return d.controlApply(preps.get(d), now, gridW, xom, weight(d) / total, phaseShare(d)).catch((err) => d.error(err));
    }));
    this.trackGridResponse(active, before, gridW, now);
  }

  // The batteries' response as the grid meter sees it (their own report may be an estimate): from
  // the setpoint steps written this tick to 90 % of their sum on the meter. Noisy when the home's
  // use changes meanwhile. Logged only.
  trackGridResponse(active, before, gridW, now) {
    if (!Number.isFinite(gridW)) return;
    // eslint-disable-next-line global-require
    const BatteryResponse = require('../../lib/strategies/BatteryResponse');
    if (!this.gridResponse) this.gridResponse = BatteryResponse.createState();
    const stepping = active.filter((d) => d.lastSetpointTm === now && typeof d.lastSetpointW === 'number');
    // The expected change on the meter: the new setpoint against what the battery did.
    const stepW = stepping.reduce((a, d) => a + (d.lastSetpointW - (Number(before.get(d).actW) || 0)), 0);
    if (Math.abs(stepW) >= 200) {
      const { step } = this.gridResponse;
      const sameWay = step && Math.sign(stepW) === Math.sign(step.toW - step.fromW);
      const idle = stepping.map((d) => before.get(d)).filter((b) => Math.abs(b.actW || 0) < 50);
      this.gridResponse = BatteryResponse.onWrite(this.gridResponse, {
        now,
        setW: (sameWay ? step.toW : gridW) + stepW,
        actW: gridW,
        standstill: idle.length === stepping.length,
        idleMs: idle.length === stepping.length ? Math.min(...idle.map((b) => b.idleMs ?? 0)) : null,
      });
      return;
    }
    const { state, sample } = BatteryResponse.onReport(this.gridResponse, { now, actW: gridW });
    this.gridResponse = state;
    if (sample) {
      const idle = typeof sample.idleMs === 'number' ? ` (idle ${Math.round(sample.idleMs / 60000)} min)` : '';
      this.log(`[Bat Resp] grid meter: ${sample.kind}${idle} step ${Math.round(sample.toW - sample.fromW)} W in ${(sample.ms / 1000).toFixed(1)} s; `
        + `${BatteryResponse.describe(state)}`);
    }
  }

  checkDeviceCompatibility(homeyDevice) {
    if (this.autoSourceCapGroup(homeyDevice)) return { found: true, useMeasureSource: false };

    // A charge level and a power: their capabilities are mapped in the setup view.
    if (!(homeyDevice.driverId || '').includes('com.gruijter.powerhour')
      && SourceCaps.hasKind(homeyDevice, 'pct') && SourceCaps.hasKind(homeyDevice, 'w')) {
      return { found: true, useMeasureSource: false, needsMapping: true };
    }
    return { found: false };
  }

  // The capabilities of a source device, as detected: { group, invert } or null.
  autoSourceCapGroup(sourceDevice) {
    const caps = sourceDevice.capabilities || [];
    const hasCapability = (capability) => caps.includes(capability);
    // 1. The Homey battery standard: measure_power already signed (+ = charging).
    if ((sourceDevice.class === 'battery' || sourceDevice.virtualClass === 'battery')
      && hasCapability('measure_battery') && hasCapability('measure_power')) {
      const energyData = sourceDevice.energyObj || sourceDevice.energy;
      const imported = energyData && energyData.meterPowerImportedCapability;
      const exported = energyData && energyData.meterPowerExportedCapability;
      return {
        group: {
          soc: 'measure_battery',
          newMeasurePower: 'measure_power',
          chargingState: hasCapability('battery_charging_state') ? 'battery_charging_state' : null,
          meterCharging: imported && hasCapability(imported) ? imported : null,
          meterDischarging: exported && hasCapability(exported) ? exported : null,
          setpoint: BatteryDriver.autoSetpoint(sourceDevice),
        },
        invert: false,
      };
    }
    // 2. The vendor exceptions (sourceCapGroups). 'invertPower' is metadata, not a capability.
    const matched = SourceCaps.matchGroup(caps, this.ds.sourceCapGroups, ['invertPower']);
    if (!matched) return null;
    const group = { ...matched, setpoint: BatteryDriver.autoSetpoint(sourceDevice) };
    delete group.invertPower;
    return { group, invert: !!matched.invertPower };
  }

  // Homey's standard battery setpoint (+ = charging), when the app lets it be set.
  static autoSetpoint(sourceDevice) {
    const obj = sourceDevice.capabilitiesObj && sourceDevice.capabilitiesObj.target_power;
    if (obj) return obj.setable === true ? 'target_power' : null;
    return (sourceDevice.capabilities || []).includes('target_power') ? 'target_power' : null;
  }

  // Roles chosen in the setup view, and the kind of capability that fits.
  static CAP_ROLES = ['soc', 'power', 'chargePower', 'dischargePower', 'meterCharging', 'meterDischarging', 'setpoint'];

  static ROLE_KINDS = {
    soc: 'pct', power: 'w', chargePower: 'w', dischargePower: 'w', meterCharging: 'kwh', meterDischarging: 'kwh', setpoint: 'setW',
  };

  // A detected group by role: the Homey standard power is the 'power' role too.
  static roleView(group) {
    const view = {};
    BatteryDriver.CAP_ROLES.forEach((role) => {
      view[role] = group[role] || null;
    });
    if (group.newMeasurePower) view.power = group.newMeasurePower;
    return view;
  }

  // The detected capabilities with the choice from the setup view: { group, invert,
  // setpointInvert }, or null without a charge level and a power.
  sourceCapGroupFor(sourceDevice, stored) {
    const auto = this.autoSourceCapGroup(sourceDevice) || { group: {}, invert: false };
    const chosen = SourceCaps.chosenFor(stored, sourceDevice.id);
    const picked = SourceCaps.applyChoice(sourceDevice, BatteryDriver.roleView(auto.group), BatteryDriver.CAP_ROLES, chosen);
    const group = { ...auto.group, ...picked };
    let { invert } = auto;
    // A Homey standard battery: its power is signed by the charging state.
    if (auto.group.newMeasurePower) {
      group.newMeasurePower = picked.power;
      delete group.power;
    }
    if (chosen.sign === 'normal') invert = false;
    if (chosen.sign === 'inverted') {
      invert = true;
      if (group.newMeasurePower) {
        group.power = group.newMeasurePower;
        delete group.newMeasurePower;
        delete group.chargingState;
      }
    }
    Object.keys(group).forEach((key) => {
      if (!group[key]) delete group[key];
    });
    const hasPower = group.power || group.newMeasurePower || group.chargePower || group.dischargePower;
    // target_power follows Homey (+ = charging); another setpoint as chosen.
    const setpointInvert = chosen.setpointSign === 'inverted';
    return group.soc && hasPower ? { group, invert, setpointInvert } : null;
  }

  // A signed power and a charge or discharge power would both count the same energy.
  static mixedPower(group) {
    return !!((group.power || group.newMeasurePower) && (group.chargePower || group.dischargePower));
  }

  async _setupSourceDevice(settings) {
    return PairSetup.apiDevice(this, settings.homey_device_id);
  }

  // Repair: forget the learned battery properties (BatDevice.onRepairAction()).
  repairActions() {
    return [{
      id: 'learnReset', step: 'battery', label: this.homey.__('battery_learned.reset'), info: this.homey.__('battery_learned.reset_hint'),
    }];
  }

  // Setup view: per role the capabilities of the battery, and the sign of its power.
  async setupRoles(dev, stored) {
    const source = await this._setupSourceDevice(dev.settings);
    if (!source) return null;
    const auto = this.autoSourceCapGroup(source) || { group: {}, invert: false };
    const chosen = SourceCaps.chosenFor(stored, source.id);
    const roles = BatteryDriver.CAP_ROLES.map((key) => ({
      key, kind: BatteryDriver.ROLE_KINDS[key], label: this.homey.__(`repair.setup_role_${key}`),
    }));
    const signLabel = (inverted) => this.homey.__(inverted ? 'repair.setup_sign_inverted' : 'repair.setup_sign_normal');
    // One signed power; a charge and a discharge power only without it. A sign only with its value.
    const items = SourceCaps.roleItems(source, roles, BatteryDriver.roleView(auto.group), chosen)
      .map((item) => (['chargePower', 'dischargePower'].includes(item.key) ? { ...item, alt: 'power' } : item));
    items.push({
      needs: 'power',
      key: 'sign',
      label: this.homey.__('repair.setup_role_sign'),
      auto: signLabel(auto.invert),
      options: [{ id: 'normal', label: signLabel(false) }, { id: 'inverted', label: signLabel(true) }],
      selected: chosen.sign || 'auto',
      noNone: true,
    });
    items.push({
      needs: 'setpoint',
      key: 'setpointSign',
      label: this.homey.__('repair.setup_role_setpointSign'),
      auto: signLabel(false),
      options: [{ id: 'normal', label: signLabel(false) }, { id: 'inverted', label: signLabel(true) }],
      selected: chosen.setpointSign || 'auto',
      noNone: true,
    });
    // Each sign right below its power.
    const at = (key) => items.findIndex((item) => item.key === key);
    items.splice(at('power') + 1, 0, ...items.splice(at('sign'), 1));
    items.splice(at('setpoint') + 1, 0, ...items.splice(at('setpointSign'), 1));
    // The meters on their own screen; the setpoint is only for control, so on that screen.
    const STEP_OF = {
      meterCharging: 'device_meters', meterDischarging: 'device_meters', setpoint: 'control', setpointSign: 'control',
    };
    items.forEach((item) => {
      if (STEP_OF[item.key]) item.step = STEP_OF[item.key];
    });
    return {
      deviceId: source.id,
      title: this.homey.__('repair.setup_caps_title'),
      text: `${source.name}. ${this.homey.__('repair.setup_caps_text')}`,
      // Homey's battery standard (signed power, no vendor guess): pairing asks only the setpoint.
      detected: !!auto.group.newMeasurePower,
      items,
    };
  }

  // Setup view: without Homey's mode capability the battery app must be set to external control by
  // hand, said with the control setting.
  async setupInfo(setting, def, dev) {
    if (setting.id !== 'batteryControl') return null;
    const source = await this._setupSourceDevice(dev.settings);
    if (!source || (source.capabilities || []).includes('target_power_mode')) return null;
    return `${setting.info || ''} ${this.homey.__('repair.setup_bat_external')}`.trim();
  }

  // The grid device has a capacity tariff to limit peaks for.
  hasPeakTariff() {
    // eslint-disable-next-line global-require
    const grid = require('../../lib/helpers/GridConnection').gridDevice(this.homey);
    // eslint-disable-next-line global-require
    return !!(grid && grid.peakConfig && require('../../lib/strategies/PeakTariff').isActive(grid.peakConfig));
  }

  // Pairing with a capacity tariff: its peaks limited, with the advised reserve.
  setupValue(id, value, dev, current) {
    if (current.device || !this.hasPeakTariff()) return value;
    if (id === 'peakShaving') return true;
    return id === 'peakReservePct' ? PEAK_RESERVE_PCT : value;
  }

  // The minimum profit of a new battery (MIN_PROFIT_SHARE), from the prices of its tariff group.
  // null: no prices yet.
  defaultMinProfit(group) {
    const prices = ((this.pricesNextHours && this.pricesNextHours[group]) || []).filter((p) => Number.isFinite(p));
    const mean = prices.length ? prices.reduce((a, p) => a + p, 0) / prices.length : 0;
    return mean > 0 ? Number((MIN_PROFIT_SHARE * mean).toPrecision(2)) : null;
  }

  // A new battery: its minimum profit from the prices, or (store minProfitAuto) from its first ones
  // (BatDevice.applyAutoMinProfit(); without prices nothing is planned).
  setupParsed(settings, repairing) {
    if (repairing) return;
    const minProfit = this.defaultMinProfit(Number(settings.tariff_update_group));
    settings.minProfit = minProfit === null ? 0 : minProfit;
  }

  setupNewStore(settings) {
    return this.defaultMinProfit(Number(settings.tariff_update_group)) === null ? { minProfitAuto: true } : {};
  }

  // Setup view: into an EV only with an EV charger, planning together only with another battery.
  setupSettings(dev) {
    let evChargers = 0;
    try {
      evChargers = this.homey.drivers.getDriver('evCharger').getDevices().length;
    } catch {
      // driver not loaded
    }
    const otherBattery = this.getDevices().some((d) => d.getSettings().homey_device_id !== dev.settings.homey_device_id);
    return this.ds.setup.settings.filter((id) => (id !== 'dischargeToEv' || evChargers) && (id !== 'groupPlan' || otherBattery));
  }

  // Wear helper on: the wear per kWh from the purchase price, capacity and rated cycles, filled in
  // while typing (the field itself stays editable).
  setupCalc(values) {
    const wear = values.wearCalc ? BatteryDriver.wearCost(values) : 0;
    return wear > 0 ? { wearCost: wear } : {};
  }

  static wearCost({ wearPurchasePrice, batCapacity, wearCycles }) {
    const throughput = Number(batCapacity) * Number(wearCycles) * ((1 + WEAR_END_OF_LIFE) / 2);
    const price = Number(wearPurchasePrice);
    if (!(throughput > 0) || !(price > 0)) return 0;
    return Math.round((price / throughput) * 10000) / 10000;
  }

  async setupValidate(settings, caps) {
    const source = await this._setupSourceDevice(settings);
    if (!source) return;
    const resolved = this.sourceCapGroupFor(source, { sourceId: source.id, caps });
    if (!resolved) throw Error(this.homey.__('error_setup_bat_caps_missing'));
    if (BatteryDriver.mixedPower(resolved.group)) throw Error(this.homey.__('error_setup_bat_power_mixed'));
  }

  // Every battery plans (LP or light planner) and has the mode picker and the action.
  capabilitiesFor(settings = {}) {
    const caps = super.capabilitiesFor(settings);
    if (!caps.includes('roi_duration')) caps.push('roi_duration');
    caps.push('battery_mode', 'battery_action');
    return caps;
  }
}

module.exports = BatteryDriver;
