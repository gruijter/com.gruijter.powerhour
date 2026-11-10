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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const ChartImages = require('../../lib/helpers/ChartImages');
const GridConnection = require('../../lib/helpers/GridConnection');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const BatteryCalibration = require('../../lib/strategies/BatteryCalibration');
const BatteryControl = require('../../lib/strategies/BatteryControl');
const BatteryEfficiency = require('../../lib/strategies/BatteryEfficiency');
const BatteryResponse = require('../../lib/strategies/BatteryResponse');
const BatterySplit = require('../../lib/strategies/BatterySplit');
const BatteryUse = require('../../lib/strategies/BatteryUse');
const BatteryTaper = require('../../lib/strategies/BatteryTaper');
const PhaseLearning = require('../../lib/strategies/PhaseLearning');
const SettingsView = require('../../lib/helpers/SettingsView');
const { getEfficiencyChart } = require('../../lib/charts/EfficiencyChart');
const { setTimeoutPromise } = require('../../lib/helpers/Util');

// A mode write of our own reported back within this time is no change by the battery app.
const OWN_WRITE_ECHO_MS = 60 * 1000;
// Plan again when the SoC is this far (%) from the plan, at most every SOC_REPLAN_MS. 3: above the
// 1 % steps most batteries report.
const SOC_REPLAN_PCT = 3;
const SOC_REPLAN_MS = 10 * 60 * 1000;
const RELEASE_RETRY_MS = 60 * 1000;
const RELEASE_FAST_MS = 15 * 60 * 1000; // refused this long: then once a night (RELEASE_NIGHT)
const RELEASE_NIGHT = '03:00';
// After a start, smart leaves the batteries as they are until the first plan, at most this long.
const PLAN_WAIT_MS = 10 * 60 * 1000;
// A setpoint at least this recent: the battery is under control (keepalive every 60 s).
const FUSE_YIELD_MS = 2 * 60 * 1000;
// Smallest power step (W) PhaseLearning learns the phase from.
const PHASE_STEP_W = 600;
// Home use the planner assumes without a grid forecast (no grid device).
const HOME_USE_W = 300;
// The planners look this far ahead (48 h): beyond the published prices on expected ones.
const PLAN_HOURS = 48;
const EFFICIENCY_LOG_MS = 60 * 60 * 1000;
const LEARN_APPLY_MS = 24 * 60 * 60 * 1000;
// Calibration (setting calibrateDays): new targets tried at most this often; only in the modes that
// follow the plan.
const CAL_RETRY_MS = 15 * 60 * 1000;
const CAL_MODES = ['smart', 'self_consumption'];
const CAL_DAYS = 7;
// Targets again at most this often; not from this long before the battery has to start.
const CAL_REFRESH_MS = 5 * 60 * 1000;
const CAL_LEAD_MS = 60 * 60 * 1000;
// The learned taper (BatteryTaper) is stored at most this often.
const TAPER_SAVE_MS = 15 * 60 * 1000;
const USE_SAVE_CYCLES = 0.02; // store write at most every 4 % SoC moved

// Plans in 15-minute slots, as the grid forecast and capacity tariffs; prices per price slot.
// The tighter of two bounds, null: none.
const bound = (pick) => (a, b) => {
  if (typeof a !== 'number') return typeof b === 'number' ? b : null;
  return typeof b === 'number' ? pick(a, b) : a;
};
const lowest = bound(Math.min);
const highest = bound(Math.max);

const deviceSpecifics = { planIntervalMin: 15 };

class BatDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    this.initTm = Date.now();
    // A (re)init can follow a settings change: never let the chart reuse a plan from before it.
    this.lastPlanTm = null;
    // Before super.onInit(): it sets initReady partway, and onPricesUpdated() then renders charts.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    // Before super.onInit(): its first samples would otherwise overwrite the stored history.
    this.powerHistory = await this.loadStoredHistory('powerHistory');
    this.socHistory = await this.loadStoredHistory('socHistory');
    this.tempMode = this.getStoreValue('batTempMode') || null;
    this.efficiency = this.getStoreValue('batteryEfficiency') || null;
    this.batteryProps = this.getStoreValue('batteryProps') || this.takeOverProps();
    this.response = { ...(this.getStoreValue('batteryResponse') || BatteryResponse.createState()), step: null };
    this.taper = this.getStoreValue('batteryTaper') || BatteryTaper.createState();
    await this.initUse();
    this.calibration = this.getStoreValue('batteryCalibration');
    if (!this.calibration) {
      this.calibration = BatteryCalibration.createState(Date.now());
      await this.setStoreValue('batteryCalibration', this.calibration).catch(this.error);
    }
    // A sample over a restart misses energy when the meters are integrated from power: start anew.
    if (this.efficiency) this.efficiency.win = null;
    // Homey keeps a warning over a restart: clear one from before at the next chance.
    this.controlWarning = true;
    this.controlState = {};
    await super.onInit().catch(this.error);

    if (this.hasCapability('battery_mode')) {
      if (!this.getCapabilityValue('battery_mode')) await this.setCapabilityValue('battery_mode', 'smart').catch(this.error);
      // Once: onInit() runs again on every restart of the device.
      if (!this.batteryModeListener) {
        this.batteryModeListener = true;
        this.registerCapabilityListener('battery_mode', (mode) => this.setBatteryMode(mode, 'set by user'));
      }
    }

    const currentSessionId = this.sessionId;
    this.populateHistoryFromInsights().catch((err) => this.error('Error populating battery insights:', err));

    const initStrategy = async () => {
      await setTimeoutPromise(10000 + (Math.random() * 60000), this);
      if (this.sessionId !== currentSessionId) return;
      await this.bootstrapEfficiency().catch((err) => this.error(err));
      await this.updatePriceProfile().catch((err) => this.error(err));
      await this.applyLearnedProps().catch((err) => this.error(err));
      await this.updateLearnedInfo().catch((err) => this.error(err));
      await this.updateCalibrationInfo().catch((err) => this.error(err));
      if (this.pricesNextHours) {
        await this.flows.triggerNewPlanFlow().catch((err) => this.error(err));
        await this.updateChargeChart().catch((err) => this.error(err));
      }
    };
    initStrategy().catch((err) => this.error(err));
  }

  async onPricesUpdated() {
    this.pricesUpdatedTm = Date.now(); // see updateChargeChart(): only reuse plans made after this
    this.pricesUpdated = true;
    await this.updatePriceProfile().catch((err) => this.error(err));
    await this.flows.triggerNewPlanFlow();
    await this.updateChargeChart();
  }

  // The expected prices beyond the published ones (PriceProfile), learned from the published ones.
  async updatePriceProfile() {
    if (!this.pricesNextHours) return;
    await this.bootstrapPriceProfile();
    const now = Date.now();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const priceMin = this.priceInterval || 60;
    const known = await this.learnPriceProfile(this.pricesFromNow(now), TimeHelpers.startOfLocalBlock(now, priceMin, tz), priceMin, tz);
    this.expectedPrice = this.expectedPriceFn(known, tz, now);
  }

  // Plan prices up to PLAN_HOURS: after the published (and forecast) prices the expected ones.
  extendPlanPrices(prices, exportPrices, startMs, planMin) {
    const n = Math.round((PLAN_HOURS * 60) / planMin);
    const imp = [...(prices || [])];
    const exp = exportPrices ? [...exportPrices] : null;
    if (!this.expectedPrice) return { prices: imp, exportPrices: exp };
    for (let i = imp.length; i < n; i += 1) {
      const e = this.expectedPrice(startMs + i * planMin * 60 * 1000);
      if (typeof e.price !== 'number') break;
      imp.push(e.price);
      if (exp) exp.push(typeof e.exportPrice === 'number' ? e.exportPrice : e.price);
    }
    return { prices: imp, exportPrices: exp };
  }

  // Detected by the driver, with the choice from the setup view (store 'sourceCaps').
  async addSourceCapGroup() {
    const resolved = this.driver.sourceCapGroupFor(this.sourceDevice, this.getStoreValue('sourceCaps'));
    if (!resolved) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
    this.sourceCapGroup = resolved.group;
    this.sourcePowerInvert = resolved.invert;
    this.setpointInvert = !!resolved.setpointInvert;
    this.log(`${this.sourceDevice.name} source capability group:`, JSON.stringify(resolved));
    await SettingsView.update(this).catch((err) => this.error(err));
  }

  // SettingsView: a capability role in use (null: not known yet).
  roleUsed(role) {
    return this.sourceCapGroup ? !!this.sourceCapGroup[role] : null;
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      // ignore
    }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    await this.addSourceCapGroup();
    this.log(`registering capability listeners for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          await this.updateValue(value, key).catch(this.error);
        });
      }
    });
    if ((this.sourceDevice.capabilities || []).includes('target_power_mode')) {
      // Followed from the events: the source device object keeps the value of when it was fetched.
      const obj = this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.target_power_mode;
      this.sourceModeValue = obj ? obj.value : null;
      this.capabilityInstances.sourceMode = this.sourceDevice.makeCapabilityInstance('target_power_mode', (value) => {
        this.onSourceModeChanged(value).catch((err) => this.error(err));
      });
    }
  }

  async onUninit() {
    // Never leave the battery on a last setpoint while this app is not running. isDestroyed first:
    // a driver tick during the release must not take control again.
    this.isDestroyed = true;
    await this.releaseControl('app stopped').catch((err) => this.error(err));
    if (this.use) await this.setStoreValue('batteryUse', this.use).catch(this.error);
    return super.onUninit();
  }

  onDeleted() {
    this.isDestroyed = true;
    this.releaseControl('device deleted').catch((err) => this.error(err));
    super.onDeleted();
  }

  getBatteryMode() {
    return (this.hasCapability('battery_mode') && this.getCapabilityValue('battery_mode')) || 'smart';
  }

  // The single entry for the picker, the flow and the battery app taking over. durationMin > 0:
  // back to the mode before after that time. Batteries in the group share one mode: the driver
  // passes a change to all of them (sync), except 'device', which is per battery.
  async setBatteryMode(mode, reason, durationMin = 0, { sync = true, until = null } = {}) {
    if (!BatteryControl.MODES.includes(mode)) throw Error(`Unknown battery mode ${mode}`);
    const end = until || (durationMin > 0 ? Date.now() + (durationMin * 60 * 1000) : null);
    const settings = this.getSettings();
    if (sync && mode !== 'device' && settings.groupPlan !== false) {
      await this.driver.setGroupMode(mode, reason, end, this);
      return;
    }
    const current = this.getBatteryMode();
    this.tempMode = end ? { previousMode: this.tempMode ? this.tempMode.previousMode : current, until: end } : null;
    await this.setStoreValue('batTempMode', this.tempMode).catch(this.error);
    if (mode === current) return;
    await this.setCapabilityValue('battery_mode', mode).catch(this.error);
    const left = end ? `, until ${new Date(end).toISOString()}` : '';
    this.log(`[Bat Control] Mode ${current} -> ${mode} (${reason}${left})`);
    if (mode === 'device' && this.driver.groupDevices().some((d) => d !== this)) {
      this.log('[Bat Control] Out of the group: if this battery does zero on the meter itself, two controls act on one meter');
    }
    const planned = (m) => JSON.stringify(BatteryControl.planOptionsFor(m));
    if (planned(mode) !== planned(current)) this.replan('mode').catch((err) => this.error(err));
  }

  // Each battery of the group has the same temporary mode: each ends it by itself.
  async endTempModeIfDue(now) {
    if (!this.tempMode || now < this.tempMode.until) return;
    await this.setBatteryMode(this.tempMode.previousMode, 'temporary mode ended', 0, { sync: false });
  }

  // Planned as one with the other batteries of the group (setting groupPlan), whether this app or
  // flows control it. 'device' leaves the group.
  inGroup() {
    const settings = this.getSettings();
    return settings.groupPlan !== false && this.getBatteryMode() !== 'device';
  }

  // Once on entering the group: take the group's mode and planner (of the battery with the lowest id).
  async joinGroup() {
    if (this.groupJoined) return;
    this.groupJoined = true;
    const group = this.driver.groupDevices();
    const ref = group.sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1))[0];
    if (!ref || ref === this) return;
    // Not yet migrated (still starting): no planner to take.
    const { precisePlanning } = ref.getSettings();
    if (typeof precisePlanning === 'boolean' && !!this.getSettings().precisePlanning !== precisePlanning) {
      await this.setSettings({ precisePlanning }).catch((err) => this.error(err));
      this.lastPlanKey = null;
      this.lastPlanTokens = null;
    }
    const mode = ref.getBatteryMode();
    const until = ref.tempMode ? ref.tempMode.until : null;
    if (mode === this.getBatteryMode() && until === (this.tempMode ? this.tempMode.until : null)) return;
    if (until) this.tempMode = { previousMode: ref.tempMode.previousMode, until };
    await this.setBatteryMode(mode, `group of ${ref.getName()}`, 0, { sync: false, until });
  }

  // Control is set up: the setting, a setpoint capability and the mode picker.
  isControlConfigured() {
    return !!(this.getSettings().batteryControl && this.sourceCapGroup && this.sourceCapGroup.setpoint
      && this.sourceDevice && this.hasCapability('battery_mode'));
  }

  // Controlled by this app now (the driver splits zero on the meter among those).
  isXomControlled() {
    return this.isControlConfigured() && this.getBatteryMode() !== 'device';
  }

  // The power this battery adds to the grid: the last setpoint while controlling (the measured
  // power lags it), else the measured power (set on every measurement).
  controlPowerW() {
    return typeof this.lastSetpointW === 'number' && this.getStoreValue('controlTakeover')
      ? this.lastSetpointW : (Number(this.getCapabilityValue('measure_watt_avg')) || 0);
  }

  // What control decided last (not rounded to the write steps): zero on the meter integrates on
  // it, as the XOM flow on its smoothed power.
  controlCommandW() {
    return typeof this.decidedW === 'number' && this.getStoreValue('controlTakeover') ? this.decidedW : this.controlPowerW();
  }

  // controlCommandW() within the lead of the measured power (BatteryControl.leadLimitW()).
  integratorW() {
    const settings = this.getSettings();
    return BatteryControl.leadLimitW({
      cmdW: this.controlCommandW(),
      actW: Number(this.getCapabilityValue('measure_watt_avg')),
      maxChargeW: Number(settings.chargePower),
      maxDischargeW: Number(settings.dischargePower),
      reportMs: this.reportIntervalMs,
    });
  }

  // How often the source reports its power while running (average ms); idle sources often report
  // only on change.
  async updateMeterFromMeasure(val) {
    const now = Date.now();
    if (this.lastReportTm && typeof val === 'number' && Math.abs(val) > 50 && Math.abs(this.lastReportW || 0) > 50) {
      const ms = Math.min(5 * 60 * 1000, now - this.lastReportTm);
      this.reportIntervalMs = this.reportIntervalMs ? (0.8 * this.reportIntervalMs) + (0.2 * ms) : ms;
    }
    this.lastReportTm = now;
    this.lastReportW = val;
    if (typeof val === 'number') {
      if (!this.phaseLearner) this.phaseLearner = new PhaseLearning.Learner(this, { minStepW: PHASE_STEP_W });
      this.phaseLearner.onPower(val, now);
    }
    if (typeof val === 'number' && Math.abs(val) >= 50) this.lastActiveTm = now;
    if (this.response && typeof val === 'number') {
      const { state, sample } = BatteryResponse.onReport(this.response, { now, actW: val });
      this.response = state;
      if (sample) {
        const idle = typeof sample.idleMs === 'number' ? ` (idle ${Math.round(sample.idleMs / 60000)} min)` : '';
        this.log(`[Bat Resp] ${sample.kind}${idle} ${Math.round(sample.fromW)} -> ${Math.round(sample.toW)} W in ${(sample.ms / 1000).toFixed(1)} s; `
          + `${BatteryResponse.describe(state)}`);
        await this.setStoreValue('batteryResponse', { ...state, step: null }).catch(this.error);
      }
    }
    return super.updateMeterFromMeasure(val);
  }

  // Driver tick, step 1: housekeeping, and what this battery does now. null: not controlled.
  async controlPrepare(now) {
    if (!this.initReady || this.isDestroyed) return null;
    this.checkPlanSlot(now);
    await this.endTempModeIfDue(now);
    if (this.inGroup()) await this.joinGroup();
    else this.groupJoined = false;
    if (!this.isControlConfigured() || this.getBatteryMode() === 'device') {
      await this.setAction(BatteryControl.actionFor());
      await this.clearControlWarning();
      if (this.getStoreValue('controlTakeover') && now >= (this.releaseRetryTm || 0)) {
        await this.releaseControl(this.isControlConfigured() ? 'mode device' : 'control off');
      }
      return null;
    }
    const mode = this.getBatteryMode();
    const slot = BatteryControl.slotAt(this.latestPlan, now);
    if (mode === 'smart' && !this.latestPlan && now - this.initTm < PLAN_WAIT_MS) {
      // Waiting for the first plan the battery is left alone, unless the connection is overloaded.
      if (!this.fuseAtRisk()) return null;
      return {
        mode: 'idle', slot: null, block: 'idle', noCharge: false, refill: false,
      };
    }
    await this.updateCalibration(now);
    await this.learnTaper(now);
    const calibrate = this.calibrationActive() ? BatteryCalibration.tail(this.calibration, this.soc) : null;
    // Below the reserve it recharges (BatteryControl): no zero on the meter then.
    const refill = typeof this.soc === 'number' && this.soc < this.reservePct() && BatteryControl.refillsReserve(mode);
    const plan = BatteryControl.blockFor(mode, slot, calibrate);
    return {
      mode, slot, calibrate, block: plan.block, noCharge: !!plan.noCharge, homeCapW: plan.homeCapW || null, refill,
    };
  }

  // Driver tick, step 2. xom: { targetW, needW } from XomSplit in a xom/hold block.
  // share: this battery's part of the import headroom.
  // share: this battery's part of the correction; phaseShare: of a phase correction (the batteries
  // that may be on its phases).
  async controlApply(prep, now, gridW, xom, share = 1, phaseShare = share) {
    if (this.controlRun) return;
    // Kept so that releaseControl() can wait for a write in progress.
    this.controlRun = this.applyControl(prep, now, gridW, xom, share, phaseShare).finally(() => {
      this.controlRun = null;
    });
    await this.controlRun;
  }

  async applyControl(prep, now, gridW, xom, share, phaseShare = share) {
    const settings = this.batterySettings();
    const batteryW = this.controlPowerW();
    // Limits from the base the grid reading holds: while ramping the measured power lags the
    // setpoint, so the side with less room (import: the lower, export: the higher) counts.
    // Only a recent report counts (an idle source reports seldom).
    const rawW = this.getCapabilityValue('measure_watt_avg');
    const fresh = typeof rawW === 'number' && this.lastReportTm && now - this.lastReportTm <= BatteryControl.FAST_REPORT_MS;
    const importBaseW = fresh ? Math.min(batteryW, rawW) : batteryW;
    const exportBaseW = fresh ? Math.max(batteryW, rawW) : batteryW;
    if (xom) {
      this.xomAvgW = BatteryControl.average(this.xomAvgW, xom.needW, now - (this.xomAvgTm || now));
      this.xomAvgTm = now;
    }
    // Idle: nothing, only the main fuse (hard limit) still protected.
    const shave = settings.peakShaving === true && prep.mode !== 'idle';
    const protect = settings.fuseProtection !== false;
    const grid = GridConnection.gridDevice(this.homey);
    const headroomW = grid ? grid.getImportHeadroomW({ tariff: shave, hard: protect }) : null;
    const hardHeadroomW = grid && protect ? grid.getImportHeadroomW({ tariff: false, hard: true }) : null;
    const exportHeadroomW = grid && protect ? grid.getExportHeadroomW() : null;
    const phase = grid && protect ? this.phaseBounds(grid, now, importBaseW, exportBaseW, phaseShare) : {};
    const stale = !!grid && protect && grid.isGridPowerStale(now);
    if (stale !== !!this.gridStale) {
      this.gridStale = stale;
      this.log(`[Bat Control] ${stale ? 'no recent grid reading: power kept, not raised' : 'grid reading back'}`);
    }
    const r = BatteryControl.decide({
      mode: prep.mode,
      slot: prep.slot,
      calibrate: prep.calibrate,
      now,
      gridW,
      batteryW,
      xomStepW: xom ? xom.targetW : null,
      xomNeedW: xom ? xom.needW : null,
      avgXomW: xom ? this.xomAvgW : undefined,
      socPct: this.soc,
      capacityKwh: settings.batCapacity,
      maxChargeW: settings.chargePower,
      maxDischargeW: settings.dischargePower,
      minChargeW: Number(settings.minChargeW) || 0,
      minDischargeW: Number(settings.minDischargeW) || 0,
      maxW: lowest(headroomW === null ? null : importBaseW + (headroomW * share), phase.maxW),
      minSocPct: this.reservePct(),
      reserveForPeak: shave,
      hardMaxW: lowest(hardHeadroomW === null ? null : importBaseW + (hardHeadroomW * share), phase.maxW),
      minW: highest(exportHeadroomW === null ? null : exportBaseW - (exportHeadroomW * share), phase.minW),
      stale,
      pulse: this.pulseParams(settings),
      state: this.controlState,
    });
    if ((r.state.pulseOn || false) !== ((this.controlState && this.controlState.pulseOn) || false)) this.logPulse(r, prep, now);
    this.controlState = r.state;
    this.decidedW = r.powerW;
    this.updateFollowCap(r.block, now, settings);
    if (this.isDestroyed) return;
    if (!this.getStoreValue('controlTakeover')) await this.takeControl();
    if (!!prep.refill !== !!this.lastRefill) {
      this.lastRefill = !!prep.refill;
      this.log(`[Bat Control] ${prep.refill ? `SoC ${this.soc}% below the reserve: recharging` : 'reserve filled'}`);
    }
    if (r.block !== this.lastControlBlock) {
      this.log(`[Bat Control] ${prep.mode}: block ${r.block}, ${r.powerW} W`);
      this.lastControlBlock = r.block;
    }
    await this.setAction(BatteryControl.actionFor({ block: r.block, refill: prep.refill, calibrate: prep.calibrate }));
    if (this.isDestroyed) return;
    if (BatteryControl.shouldWrite({
      powerW: r.powerW, lastW: this.lastSetpointW, lastTm: this.lastSetpointTm, now, block: r.block,
    })) await this.writeSetpoint(r.powerW, now);
    this.checkSocDeviation(prep.slot, now);
  }

  // BatteryControl.pulseParams(), rebuilt when the speeds or the learned start change.
  pulseParams(settings) {
    const res = this.response && this.response.standstill;
    const key = JSON.stringify([BatterySplit.speedsFromSettings(settings), res && res.n >= 3 ? Math.round(res.ms / 1000) : null]);
    if (this.pulseKey !== key) {
      this.pulseKey = key;
      this.pulse = BatteryControl.pulseParams(settings, this.response);
    }
    return this.pulse;
  }

  // Pulse start and end, for tuning the assumed fans, start and run-out (BatteryControl).
  logPulse(r, prep, now) {
    const p = this.pulse;
    if (r.state.pulseOn) {
      const charging = r.state.pulseOn === 'charge';
      const effAt = charging ? p.chargeEffAt : p.dischargeEffAt;
      const w = charging ? p.chargeW : p.dischargeW;
      this.pulseStart = { tm: now, soc: this.soc };
      this.log(`[Bat Pulse] ${r.state.pulseOn} at ${r.powerW} W (efficient ${w} W, eff ${effAt(w).toFixed(3)}), SoC ${this.soc}% -> `
        + `${prep.slot && prep.slot.soc}%, start ${Math.round(p.startS)} s, overhead ${p.overheadWh.toFixed(1)} Wh`);
      return;
    }
    const start = this.pulseStart || {};
    this.log(`[Bat Pulse] end after ${start.tm ? Math.round((now - start.tm) / 1000) : '?'} s, SoC ${start.soc}% -> ${this.soc}%`);
    this.pulseStart = null;
  }

  // xomTarget is the XOM target of all batteries, used every control tick: no restart for it.
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('xomTarget')) this.driver.setXomTargetFromSetting(newSettings.xomTarget, this);
    if (changedKeys.every((key) => key === 'xomTarget')) return true;
    // After the base: it can still reject the change.
    const result = await super.onSettings({ newSettings, changedKeys });
    if (changedKeys.includes('batCapacity')) await this.rescaleEfficiency(oldSettings.batCapacity, newSettings.batCapacity);
    // No plan of the other planner kept. The group plans as one: one planner (precisePlanning) for
    // all. newSettings: groupPlan can change in the same repair (getSettings() is still the old).
    if (changedKeys.includes('precisePlanning')) {
      const inGroup = newSettings.groupPlan !== false && this.getBatteryMode() !== 'device';
      const members = inGroup ? [this, ...this.driver.groupDevices().filter((d) => d !== this)] : [this];
      for (const d of members) {
        d.groupPlans = null;
        d.lastPlanTm = null;
        d.lastPlanKey = null;
        d.lastPlanTokens = null;
        if (d !== this && !!d.getSettings().precisePlanning !== !!newSettings.precisePlanning) {
          await d.setSettings({ precisePlanning: !!newSettings.precisePlanning }).catch((err) => d.error(err));
        }
      }
    }
    return result;
  }

  // The battery_action capability, on a change only.
  async setAction(action) {
    if (!this.hasCapability('battery_action') || this.getCapabilityValue('battery_action') === action) return;
    await this.setCapabilityValue('battery_action', action).catch(this.error);
  }

  // In zero on the meter: the most this battery does while it does not do its setpoint
  // (BatteryControl.followCap()); the driver gives the rest to the other batteries.
  updateFollowCap(block, now, settings) {
    const prev = this.followCapW || null;
    if (block !== 'xom') {
      this.followCapW = null;
      this.followLagSince = null;
    } else {
      const f = BatteryControl.followCap({
        cap: prev,
        lagSince: this.followLagSince,
        setW: this.lastSetpointW,
        setTm: this.lastSetpointTm,
        actW: Number(this.getCapabilityValue('measure_watt_avg')),
        maxW: (this.lastSetpointW > 0 ? Number(settings.chargePower) : Number(settings.dischargePower)) || 0,
        now,
      });
      this.followCapW = f.cap;
      this.followLagSince = f.lagSince;
    }
    if (!prev !== !this.followCapW) {
      this.log(`[Bat Control] ${this.followCapW ? `does not follow its setpoint: at most ${this.followCapW.w} W` : 'follows its setpoint again'}`);
    }
  }

  // The phases of the battery (setting batteryPhase, on auto learned), a FuseGuard spec. known:
  // set or learned (trustLearned).
  fusePhases(trustLearned = true) {
    const s = this.getSettings();
    const spec = PhaseLearning.specOf(s.batteryPhase, this.getStoreValue('phaseVotes'), trustLearned);
    if (spec) return spec;
    return {
      n: null, set: null, powerW: Math.max(Number(s.chargePower) || 0, Number(s.dischargePower) || 0), known: false,
    };
  }

  // Bounds on the setpoint (W) from the phase fuses: { maxW, minW }, null none. Unknown phases
  // only limit the power (down to 0), never force the other way: the battery may be on another phase.
  phaseBounds(grid, now, importBaseW, exportBaseW, phaseShare) {
    if (typeof grid.getPhaseRoomW !== 'function') return {};
    const spec = this.fusePhases(grid.trustsLearnedPhases(now));
    const inW = grid.getPhaseRoomW(spec, now);
    const outW = grid.getPhaseExportRoomW(spec, now);
    let maxW = inW === null ? null : importBaseW + (inW * phaseShare);
    let minW = outW === null ? null : exportBaseW - (outW * phaseShare);
    if (!spec.known) {
      if (maxW !== null) maxW = Math.max(0, maxW);
      if (minW !== null) minW = Math.min(0, minW);
    }
    return { maxW, minW };
  }

  // The grid is over the hard import limit or the export limit now, in total or on a phase of this
  // battery (setting fuseProtection).
  fuseAtRisk() {
    if (this.getSettings().fuseProtection === false) return false;
    const grid = GridConnection.gridDevice(this.homey);
    if (!grid) return false;
    const spec = this.fusePhases(typeof grid.trustsLearnedPhases !== 'function' || grid.trustsLearnedPhases());
    const rooms = [grid.getImportHeadroomW({ tariff: false, hard: true }), grid.getExportHeadroomW()];
    if (typeof grid.getPhaseRoomW === 'function') rooms.push(grid.getPhaseRoomW(spec), grid.getPhaseExportRoomW(spec));
    return rooms.some((w) => typeof w === 'number' && w < 0);
  }

  // Grid charging (W) this battery gives way with under the hard limit: only while this app
  // controls it (a setpoint written within FUSE_YIELD_MS). At most the measured power: a full
  // battery still asked to charge (BatteryControl, planned 100 %) takes nothing.
  fuseYieldW(now = Date.now()) {
    if (this.getSettings().fuseProtection === false || !this.getStoreValue('controlTakeover')) return 0;
    if (typeof this.lastSetpointW !== 'number' || !this.lastSetpointTm || now - this.lastSetpointTm > FUSE_YIELD_MS) return 0;
    const measuredW = this.getCapabilityValue('measure_watt_avg');
    return Math.max(0, typeof measuredW === 'number' ? Math.min(this.lastSetpointW, measuredW) : this.lastSetpointW);
  }

  async takeControl() {
    const caps = this.sourceDevice.capabilities || [];
    let prevMode = null;
    if (caps.includes('target_power_mode')) {
      if (this.sourceModeValue && this.sourceModeValue !== 'homey') prevMode = this.sourceModeValue;
      this.ownModeWriteTm = Date.now();
      await this.writeSourceCap('target_power_mode', 'homey').catch((err) => this.error(err));
    }
    await this.setStoreValue('controlTakeover', { prevMode, tm: Date.now() });
    this.log(`[Bat Control] Taking control of ${this.sourceDevice.name}${prevMode ? ` (its mode was ${prevMode})` : ''}`);
  }

  // Back to the battery: its mode from before, or (without a mode capability) setpoint 0.
  // The takeover is cleared only once the battery has it back: a failed write is tried again
  // (controlPrepare()), every RELEASE_RETRY_MS; refused for RELEASE_FAST_MS, once a night.
  async releaseControl(reason) {
    if (this.controlRun) await this.controlRun.catch(() => {});
    const takeover = this.getStoreValue('controlTakeover');
    if (!takeover) return;
    this.lastSetpointW = null;
    if (this.response) this.response.step = null;
    this.decidedW = null;
    this.followCapW = null;
    this.followLagSince = null;
    this.lastControlBlock = null;
    this.controlState = {};
    if (this.sourceDevice && this.sourceCapGroup) {
      try {
        const caps = this.sourceDevice.capabilities || [];
        if (caps.includes('target_power_mode') && takeover.prevMode) {
          this.ownModeWriteTm = Date.now();
          await this.writeSourceCap('target_power_mode', takeover.prevMode);
        } else if (this.sourceCapGroup.setpoint) {
          await this.writeSourceCap(this.sourceCapGroup.setpoint, 0);
        }
        this.log(`[Bat Control] Control back to ${this.sourceDevice.name} (${reason})`);
      } catch (err) {
        const now = Date.now();
        if (!this.releaseFailSince) this.releaseFailSince = now;
        const night = now - this.releaseFailSince >= RELEASE_FAST_MS;
        this.releaseRetryTm = night
          ? TimeHelpers.nextLocalTime(RELEASE_NIGHT, this.timeZone || this.homey.clock.getTimezone(), now)
          : now + RELEASE_RETRY_MS;
        this.error(`[Bat Control] Giving control back failed (${reason})${night ? ', next try tonight' : ''}:`, err.message || err);
        return;
      }
    }
    this.releaseFailSince = null;
    this.releaseRetryTm = null;
    await this.setStoreValue('controlTakeover', null);
  }

  // The battery app switched its own mode: it takes over, this app stops controlling.
  async onSourceModeChanged(value) {
    this.sourceModeValue = value;
    if (!this.getStoreValue('controlTakeover') || value === 'homey') return;
    if (this.ownModeWriteTm && Date.now() - this.ownModeWriteTm < OWN_WRITE_ECHO_MS) return;
    await this.setStoreValue('controlTakeover', null); // keep the battery app's choice
    await this.setBatteryMode('device', `battery app switched to ${value}`, 0, { sync: false });
  }

  async writeSourceCap(capabilityId, value) {
    await this.sourceDevice.setCapabilityValue({ capabilityId, value });
  }

  async writeSetpoint(powerW, now) {
    const cap = this.sourceCapGroup.setpoint;
    let value = this.setpointInvert ? -powerW : powerW;
    const obj = (this.sourceDevice.capabilitiesObj || {})[cap] || {};
    if (typeof obj.min === 'number') value = Math.max(obj.min, value);
    if (typeof obj.max === 'number') value = Math.min(obj.max, value);
    // For BatteryTaper: what the battery was asked, and since when.
    const writtenW = this.setpointInvert ? -value : value;
    if (typeof this.writtenW !== 'number' || Math.abs(writtenW - this.writtenW) >= 100) this.setChangeTm = now;
    this.writtenW = writtenW;
    // Also on failure: the next try comes with the keepalive, not every tick.
    if (this.response) {
      this.response = BatteryResponse.onWrite(this.response, {
        now, setW: powerW, actW: Number(this.getCapabilityValue('measure_watt_avg')), idleMs: this.lastActiveTm ? now - this.lastActiveTm : null,
      });
    }
    this.lastSetpointW = powerW;
    this.lastSetpointTm = now;
    try {
      await this.writeSourceCap(cap, value);
      await this.clearControlWarning();
    } catch (err) {
      this.error(`[Bat Control] Setting ${cap} to ${value} W failed:`, err.message || err);
      this.controlWarning = true;
      await this.setWarning(this.homey.__('bat_control_failed', { error: err.message || String(err) })).catch(this.error);
    }
  }

  async clearControlWarning() {
    if (!this.controlWarning) return;
    this.controlWarning = false;
    await this.unsetWarning().catch(this.error);
  }

  // The SoC is far from the plan (forecast off, a large load): plan again.
  checkSocDeviation(slot, now) {
    if (!slot || !(slot.index >= 0) || typeof this.soc !== 'number') return;
    // The plan's SoC now: from the end of the previous slot (the first slot: the SoC when planned)
    // toward the end of this one. Below the reserve the plan starts at the reserve (planBattery()).
    const plan = this.latestPlan;
    const reserve = this.reservePct();
    const slotStartMs = slot.endMs - plan.intervalMs;
    const first = slot.index === 0;
    const fromMs = first ? Math.max(slotStartMs, plan.planTm || slotStartMs) : slotStartMs;
    let from = plan.slots[slot.index - 1] ? plan.slots[slot.index - 1].soc : null;
    if (first) from = typeof plan.startSoc === 'number' ? Math.max(plan.startSoc, reserve) : null;
    if (typeof from !== 'number' || typeof slot.soc !== 'number' || !(slot.endMs > fromMs)) return;
    const part = Math.min(1, Math.max(0, (now - fromMs) / (slot.endMs - fromMs)));
    const planned = Math.round(from + ((slot.soc - from) * part));
    if (Math.abs(Math.max(this.soc, reserve) - planned) <= SOC_REPLAN_PCT) return;
    if (this.lastSocReplanTm && now - this.lastSocReplanTm < SOC_REPLAN_MS) return;
    this.lastSocReplanTm = now;
    this.log(`[Bat Control] SoC ${this.soc}% vs planned ${planned}%: plan again`);
    this.replan('SoC').catch((err) => this.error(err));
  }

  async replan(reason) {
    if (!this.pricesNextHours) return;
    this.log(`[Plan] Plan again (${reason})`);
    await this.flows.triggerNewPlanFlow();
    await this.updateChargeChart();
  }

  // A plan input that the plan caches do not see (the costs): no cached plan, the whole group again.
  async replanGroup(reason) {
    const members = this.planGroup() || [this];
    members.forEach((d) => {
      d.lastPlanTm = null;
      d.lastPlanKey = null;
      d.groupPlans = null;
    });
    for (const d of members) await d.replan(reason).catch((err) => d.error(err));
  }

  async poll() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;
    await this.getSourceDevice();

    if (!this.sourceCapGroup) await this.addSourceCapGroup();
    const promises = Object.keys(this.sourceCapGroup).map(async (key) => {
      if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]]) {
        const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]].value;
        await this.updateValue(val, key).catch(this.error);
      }
    });
    await Promise.all(promises);
  }

  async populateHistoryFromInsights() {
    try {
      if (!this.sourceDevice) {
        await this.getSourceDevice().catch(() => null);
      }
      if (!this.sourceDevice || !this.homey || !this.homey.app || !this.homey.app.api) {
        this.log('[Insights] Cannot populate history: sourceDevice or API not ready');
        return;
      }
      const sourceId = this.sourceDevice.id;
      const { api } = this.homey.app;
      const rawLogs = await this.homey.app.getInsightsLogs().catch((err) => this.error('getLogs error:', err));
      if (!rawLogs) return;

      const logs = Array.isArray(rawLogs) ? rawLogs : Object.values(rawLogs);
      const devLogs = logs.filter((l) => {
        const id = l.id || l.uri || l.ownerUri || '';
        return id.includes(sourceId);
      });
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 48 * 60 * 60 * 1000);

      const fetchEntries = async (log) => {
        if (!log) return null;
        const id = log.id || log.uri || '';
        const cap = id.split(':').pop() || '';
        // Homey logs measure_power under 'energy_power': instantaneous W, not cumulative (confirmed).
        const isCumulative = cap.includes('meter') || (cap.includes('energy') && cap !== 'energy_power');

        const convert = (data, resStr) => {
          if (!data || !data.values || data.values.length === 0) return null;
          if (isCumulative && data.values.length > 1) {
            const powerWatts = [];
            for (let i = 1; i < data.values.length; i++) {
              const prev = data.values[i - 1];
              const curr = data.values[i];
              const getVal = (item) => {
                if (typeof item.v === 'number') return item.v;
                if (typeof item.y === 'number') return item.y;
                return 0;
              };
              const prevV = getVal(prev);
              const currV = getVal(curr);
              const prevT = typeof prev.t === 'number' ? prev.t : new Date(prev.t).getTime();
              const currT = typeof curr.t === 'number' ? curr.t : new Date(curr.t).getTime();
              const dtHours = (currT - prevT) / 3600000;
              const dKwh = currV - prevV;
              if (dtHours > 0 && Math.abs(dKwh) < 500) {
                const watts = (dKwh / dtHours) * 1000;
                powerWatts.push({ time: prevT, power: Math.round(watts) });
              }
            }
            return { entries: powerWatts, isWatts: true };
          }
          // These hourly logs are stamped at the START of the hour (confirmed on a device); others at the
          // end and get the -1h correction.
          const startStampedCaps = ['energy_power', 'measure_battery'];
          const isHourly = (resStr === 'last7Days' || resStr === 'last14Days') && !startStampedCaps.includes(cap);
          const entries = data.values.map((e) => {
            const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
            const t = isHourly ? rawT - 3600000 : rawT;
            let v = 0;
            if (typeof e.v === 'number') v = e.v;
            else if (typeof e.y === 'number') v = e.y;
            return { time: t, value: Math.round(v) };
          });
          return { entries, isWatts: false };
        };

        // Hourly (last7Days/last14Days) plus 'last24Hours' (~5-minute) merged over it.
        let coarse = null;
        for (const resStr of ['last7Days', 'last14Days']) {
          const data = await api.insights.getLogEntries({
            id: log.id || log.uri,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: resStr,
          }).catch(() => null);
          coarse = convert(data, resStr);
          if (coarse) break;
        }

        const fineStart = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        const fineData = await api.insights.getLogEntries({
          id: log.id || log.uri,
          start: fineStart.toISOString(),
          end: endDate.toISOString(),
          resolution: 'last24Hours',
        }).catch(() => null);
        const fine = convert(fineData, 'last24Hours');

        if (!coarse && !fine) {
          const todayData = await api.insights.getLogEntries({
            id: log.id || log.uri,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            resolution: 'today',
          }).catch(() => null);
          return convert(todayData, 'today');
        }
        if (!fine) return coarse;
        if (!coarse) return fine;

        const fineMinTime = Math.min(...fine.entries.map((e) => e.time));
        const merged = coarse.entries.filter((e) => e.time < fineMinTime).concat(fine.entries);
        return { entries: merged, isWatts: fine.isWatts };
      };

      // 1. Power history: the capability addSourceCapGroup() resolved, with its sign. A bare
      // 'measure_power' is read from 'energy_power' (a 'measure_power' log can exist but is empty,
      // skill section 3); suffixed variants under their own name.
      const resolvedPowerCap = (this.sourceCapGroup && (this.sourceCapGroup.newMeasurePower || this.sourceCapGroup.power)) || null;
      const resolvedPowerInvert = !!this.sourcePowerInvert;

      const powerCandidates = [];
      if (resolvedPowerCap && resolvedPowerCap !== 'measure_power') {
        powerCandidates.push({ cap: resolvedPowerCap, invert: resolvedPowerInvert });
      }
      powerCandidates.push({ cap: 'energy_power', invert: false });
      if (!resolvedPowerCap) {
        // No signed power capability resolved: broad guess as a last resort.
        ['measure_power.battery', 'measure_power.sessy', 'meter_power'].forEach((cap) => powerCandidates.push({ cap, invert: false }));
      }

      let powerLog = null;
      let powerLogInvert = false;
      for (const candidate of powerCandidates) {
        const found = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap === candidate.cap || l.name === candidate.cap;
        });
        if (found) {
          powerLog = found;
          powerLogInvert = candidate.invert;
          break;
        }
      }
      if (!powerLog && !resolvedPowerCap) {
        powerLog = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap.startsWith('measure_power.');
        });
      }
      if (!powerLog) this.log(`[Insights] No power log found for source device ${sourceId} (tried: ${powerCandidates.map((c) => c.cap).join(', ')})`);

      if (powerLog) {
        const result = await fetchEntries(powerLog);
        if (result && result.entries.length > 0) {
          const powerMap = new Map();
          if (Array.isArray(this.powerHistory)) {
            this.powerHistory.forEach((e) => powerMap.set(e.time, e.power));
          }
          result.entries.forEach((e) => {
            let val = result.isWatts ? e.power : e.value;
            if (powerLogInvert) val = -val;
            powerMap.set(e.time, val);
          });
          this.powerHistory = Array.from(powerMap.entries())
            .map(([time, power]) => ({ time, power }))
            .sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
          this.fileStore.set('powerHistory', this.powerHistory);
        }
      }

      const socLog = devLogs.find((l) => {
        const id = l.id || l.uri || l.ownerUri || '';
        const cap = id.split(':').pop() || '';
        return cap === 'measure_battery' || cap === 'soc' || ['measure_battery', 'soc'].includes(l.name);
      });

      if (socLog) {
        const result = await fetchEntries(socLog);
        if (result && result.entries.length > 0) {
          const socMap = new Map();
          if (Array.isArray(this.socHistory)) {
            this.socHistory.forEach((e) => socMap.set(e.time, e.soc));
          }
          result.entries.forEach((e) => socMap.set(e.time, e.value));
          this.socHistory = Array.from(socMap.entries())
            .map(([time, soc]) => ({ time, soc }))
            .sort((a, b) => a.time - b.time);
          if (this.socHistory.length > 2880) this.socHistory = this.socHistory.slice(-2880);
          this.fileStore.set('socHistory', this.socHistory);
          this.log(`[Insights] Stored ${this.socHistory.length} SoC entries (source: ${socLog.id || socLog.name})`);
        }
      } else {
        this.log(`[Insights] No SoC log found for source device ${sourceId}`);
      }
    } catch (err) {
      this.error('Error populating battery insights:', err);
    }
  }

  // A price-slot list (from the current price slot) per plan slot (from the current plan slot).
  toPlanSlots(list, now = Date.now()) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const priceMin = this.priceInterval || 60;
    const planMin = this.planIntervalMin();
    return TimeHelpers.toFinerSlots(list, TimeHelpers.startOfLocalBlock(now, priceMin, tz), priceMin,
      TimeHelpers.startOfLocalBlock(now, planMin, tz), planMin);
  }

  // The batteries planned as one with this one (sorted by id, the first plans), or null. A battery
  // that calibrates plans alone: its targets are its own.
  planGroup() {
    if (!this.inGroup() || this.calibrationActive()) return null;
    const group = this.driver.groupDevices().filter((d) => !d.calibrationActive())
      .sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1));
    return group.length > 1 && group.includes(this) ? group : null;
  }

  // The reserve (%): kept always, recharged as soon as possible; only peak shaving may use it. Not
  // while calibrating: the other batteries keep theirs (driver.calibrationTick()).
  reservePct() {
    if (this.calibrationActive()) return 0;
    return Math.min(90, Math.max(0, Number(this.getSettings().peakReservePct) || 0));
  }

  // A plan SoC (%) back to the battery's: the planner only sees the part above the reserve.
  planSocToReal(socPct) {
    const r = this.reservePct();
    return r ? Math.round(r + ((socPct * (100 - r)) / 100)) : socPct;
  }

  // A battery for PrecisePlanner: its SoC, capacity, charge/discharge speeds with efficiency, and the
  // learned taper near full and empty.
  planBattery() {
    const settings = this.batterySettings();
    // The planner works above the reserve: that part of the capacity, the SoC within it.
    const r = this.reservePct();
    const soc = Number(this.soc) || 0;
    return {
      soc: r ? (Math.max(0, soc - r) * 100) / (100 - r) : this.soc,
      batCapacity: settings.batCapacity * (1 - (r / 100)),
      ...BatterySplit.speedsFromSettings(settings),
      ...BatteryTaper.planLimits(this.taper, { capKwh: Number(settings.batCapacity) || 0, reservePct: r }),
    };
  }

  // Use (BatteryUse) from the SoC. A new battery starts at the mean of the others: it does not take
  // all the work until it has caught up.
  async initUse() {
    let state = this.getStoreValue('batteryUse');
    if (!state) {
      const others = this.driver.getDevices().map((d) => d !== this && d.getStoreValue('batteryUse')).filter(Boolean);
      state = BatteryUse.createState(others.length ? others.reduce((a, u) => a + u.cycles, 0) / others.length : 0);
      await this.setStoreValue('batteryUse', state).catch(this.error);
    }
    // The stored anchor: use while restarting counts too.
    this.use = { anchor: null, ...state };
    this.useSavedCycles = this.use.cycles;
  }

  async trackUse(soc) {
    if (!this.use) return;
    this.use = BatteryUse.onSoc(this.use, soc);
    if (this.use.cycles - this.useSavedCycles < USE_SAVE_CYCLES) return;
    this.useSavedCycles = this.use.cycles;
    await this.setStoreValue('batteryUse', this.use).catch(this.error);
  }

  // For the split over a group: wear per kWh and use.
  useInfo() {
    return {
      wear: Number(this.getSettings().wearCost) || 0,
      cycles: Math.round((this.use ? this.use.cycles : 0) * 100) / 100,
    };
  }

  // Every control tick: the power the battery still does near full and empty while asked more.
  async learnTaper(now) {
    const controlled = !!this.getStoreValue('controlTakeover') && now - (this.lastSetpointTm || 0) <= FUSE_YIELD_MS;
    const before = this.taper;
    const { state, sample } = BatteryTaper.onTick(this.taper, {
      now,
      socPct: this.soc,
      setW: controlled ? this.writtenW : null,
      actW: Number(this.getCapabilityValue('measure_watt_avg')),
      setChangeTm: this.setChangeTm,
      capped: !!(this.followCapW && Math.sign(this.writtenW) === this.followCapW.dir),
    });
    this.taper = state;
    if (!sample) return;
    // Stored (and logged) when it gets learned, else at most every TAPER_SAVE_MS.
    const nowLearned = !BatteryTaper.learned(before, sample.dir) && BatteryTaper.learned(this.taper, sample.dir);
    if (!nowLearned && this.taperSaveTm && now - this.taperSaveTm < TAPER_SAVE_MS) return;
    this.taperSaveTm = now;
    this.log(`[Bat Taper] ${sample.dir} ${Math.round(sample.w)} W at SoC ${sample.socPct}%: ${BatteryTaper.describe(this.taper)}`);
    await this.setStoreValue('batteryTaper', this.taper).catch(this.error);
  }

  // Input for PrecisePlanner: plan() for this battery, or with a group planEach() with
  // each battery of the group as it is.
  buildPlanOptions(minPriceDelta, group = null) {
    const members = group || [this];
    const now = Date.now();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const planMin = this.planIntervalMin();
    const fromNow = this.pricesFromNow(now);
    const startMs = TimeHelpers.startOfLocalBlock(now, planMin, tz);
    const { prices: planPrices, exportPrices } = this.extendPlanPrices(this.toPlanSlots(fromNow.prices, now),
      fromNow.exportPrices ? this.toPlanSlots(fromNow.exportPrices, now) : null, startMs, planMin);
    const forecast = this.planNetForecast(startMs, planPrices.length, planMin, members);
    if (!group && this.calibrationActive()) this.refreshCalibrationTargets(now);
    const socBounds = !group && this.calibrationActive()
      ? BatteryCalibration.socBounds(this.calibration, { startMs, slotMin: planMin, slots: planPrices.length }) : null;
    return {
      prices: planPrices,
      exportPrices,
      minPriceDelta,
      wearCost: this.wearCostFor(members),
      ...(group ? { batteries: members.map((d) => ({ ...d.planBattery(), ...d.useInfo() })) } : this.planBattery()),
      // Local minute: slots follow local time (half-hour-offset zones differ from UTC).
      startMinute: TimeHelpers.toLocalDate(new Date(now), tz).getMinutes(),
      priceInterval: planMin,
      homePowerUsage: HOME_USE_W,
      net: forecast ? forecast.net : null,
      peakWindowMin: forecast ? forecast.peakWindowMin : 15,
      ...BatteryControl.planOptionsFor(this.getBatteryMode()),
      // Calibrating: full from the grid too, whatever the mode.
      ...(socBounds ? { socBounds, allowGridCharge: true } : {}),
    };
  }

  calibrationDays() {
    const days = this.getSettings().calibrateDays;
    return typeof days === 'number' ? Math.max(0, days) : CAL_DAYS;
  }

  // Follows its targets: under this app's control, in a mode that follows the plan.
  calibrationActive() {
    return !!(this.calibration && this.calibration.phase) && this.isControlConfigured() && CAL_MODES.includes(this.getBatteryMode());
  }

  // May start one now (driver.calibrationTick()).
  calibrationReady() {
    return this.isControlConfigured() && CAL_MODES.includes(this.getBatteryMode()) && !!this.pricesNextHours;
  }

  calibrationDue(now) {
    return BatteryCalibration.isDue(this.calibration, this.calibrationDays(), now);
  }

  // When to be empty, then full, from the prices and the forecast; null: not far enough ahead.
  calibrationTargets(phase, now) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const planMin = this.planIntervalMin();
    const startMs = TimeHelpers.startOfLocalBlock(now, planMin, tz);
    const { prices, exportPrices } = this.pricesFromNow(now);
    const planPrices = this.toPlanSlots(prices, now);
    const forecast = this.planNetForecast(startMs, planPrices.length, planMin);
    const settings = this.batterySettings();
    return BatteryCalibration.chooseTargets({
      phase,
      startMs,
      slotMin: planMin,
      prices: planPrices,
      exportPrices: exportPrices ? this.toPlanSlots(exportPrices, now) : null,
      net: forecast ? forecast.net : null,
      socPct: Number(this.soc) || 0,
      capKwh: Number(settings.batCapacity) || 0,
      maxChargeW: Number(settings.chargePower) || 0,
      maxDischargeW: Number(settings.dischargePower) || 0,
      limitW: (dir, pct) => BatteryTaper.limitW(this.taper, dir, pct),
    });
  }

  async startCalibration(now) {
    if (now - (this.calTryTm || 0) < CAL_RETRY_MS) return false;
    this.calTryTm = now;
    const targets = this.calibrationTargets('empty', now);
    if (!targets) return false;
    this.calibration = BatteryCalibration.start(this.calibration, now, targets);
    this.log(`[Bat Cal] start: empty by ${new Date(targets.emptyByMs).toISOString()}, full by ${new Date(targets.fullByMs).toISOString()}`);
    await this.saveCalibration(true);
    return true;
  }

  // Flow: start as soon as the other batteries allow (driver.calibrationTick()), or stop.
  async requestCalibration() {
    if (!this.isControlConfigured()) throw Error(this.homey.__('battery_calibration.no_control'));
    if (this.calibration.phase || this.calibration.requested) return;
    this.calibration = { ...this.calibration, requested: true };
    this.calTryTm = null;
    this.log('[Bat Cal] requested');
    await this.saveCalibration(false);
  }

  async stopCalibration(reason) {
    if (!this.calibration.phase && !this.calibration.requested) return;
    const running = !!this.calibration.phase;
    this.calibration = BatteryCalibration.end(this.calibration, Date.now());
    this.log(`[Bat Cal] stopped (${reason})`);
    await this.saveCalibration(running);
  }

  // Every control tick: a stop at empty or full, and new targets when the current one passed.
  async updateCalibration(now) {
    const r = BatteryCalibration.onTick(this.calibration, {
      now,
      socPct: this.soc,
      setW: this.getStoreValue('controlTakeover') ? this.lastSetpointW : null,
      actW: Number(this.getCapabilityValue('measure_watt_avg')),
    });
    const { phase } = this.calibration;
    this.calibration = r.state;
    if (r.changed) {
      this.log(`[Bat Cal] ${r.event}${r.timeout ? ' (time limit)' : ''} at SoC ${this.soc}%${r.done ? ': calibration done' : ''}`);
      await this.saveCalibration(this.calibration.phase !== phase);
    }
    if (BatteryCalibration.isExpired(this.calibration, now)) {
      await this.stopCalibration('time limit');
      return;
    }
    if (!this.calibrationActive() || !BatteryCalibration.isLate(this.calibration, now)) return;
    if (now - (this.calTryTm || 0) < CAL_RETRY_MS) return;
    this.calTryTm = now;
    const targets = this.calibrationTargets(this.calibration.phase, now);
    if (!targets) return;
    this.calibration = { ...this.calibration, ...targets };
    this.log(`[Bat Cal] ${this.calibration.phase}: new targets, full by ${new Date(targets.fullByMs).toISOString()}`);
    await this.saveCalibration(true);
  }

  // Each plan: targets again from the SoC and prices now (the SoC can have changed by another mode,
  // new prices can be better), until the battery is on its way: then they stay. Never later: the
  // battery would undo its progress, and the calibration runs out of time.
  refreshCalibrationTargets(now) {
    const c = this.calibration;
    if (now - (this.calRefreshTm || 0) < CAL_REFRESH_MS) return;
    const settings = this.batterySettings();
    const soc = Number(this.soc) || 0;
    const capKwh = Number(settings.batCapacity) || 0;
    const kw = (Number(c.phase === 'empty' ? settings.dischargePower : settings.chargePower) || 0) / 1000;
    const target = c.phase === 'empty' ? c.emptyByMs : c.fullByMs;
    const leftKwh = ((c.phase === 'empty' ? soc : 100 - soc) / 100) * capKwh;
    if (!(kw > 0) || (target && now >= target - ((leftKwh / kw) * 3600000) - CAL_LEAD_MS)) return;
    this.calRefreshTm = now;
    const targets = this.calibrationTargets(c.phase, now);
    if (!targets || (targets.emptyByMs === c.emptyByMs && targets.fullByMs === c.fullByMs)) return;
    if (target && targets[c.phase === 'empty' ? 'emptyByMs' : 'fullByMs'] > target) return;
    this.calibration = { ...c, ...targets };
    this.log(`[Bat Cal] ${c.phase}: targets now ${targets.emptyByMs ? `empty by ${new Date(targets.emptyByMs).toISOString()}, ` : ''}full by ${new Date(targets.fullByMs).toISOString()}`);
    this.saveCalibration(false).catch((err) => this.error(err));
  }

  // replan: the targets or the group changed, all batteries plan again.
  async saveCalibration(replan) {
    await this.setStoreValue('batteryCalibration', this.calibration).catch(this.error);
    await this.updateCalibrationInfo().catch((err) => this.error(err));
    if (replan) this.driver.replanAll('calibration').catch((err) => this.error(err));
  }

  // The label 'Calibration' in the settings.
  async updateCalibrationInfo() {
    const c = this.calibration;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const lang = this.homey.i18n.getLanguage() || 'en';
    const at = (ms) => new Date(ms).toLocaleString(lang, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
    });
    const days = this.calibrationDays();
    let text;
    if (c.phase === 'empty') text = this.homey.__('battery_calibration.empty', { empty: at(c.emptyByMs), full: at(c.fullByMs) });
    else if (c.phase === 'full') text = this.homey.__('battery_calibration.full', { full: at(c.fullByMs) });
    else if (c.requested) text = this.homey.__('battery_calibration.requested');
    else if (!days) text = this.homey.__('battery_calibration.off');
    else text = this.homey.__('battery_calibration.next', { next: at(c.lastTm + (days * 24 * 60 * 60 * 1000)) });
    if (this.getSettings().calibrationInfo !== text) await this.setSettings({ calibrationInfo: text });
  }

  // Wear per kWh cycled; a group: weighted by capacity.
  wearCostFor(members) {
    const cap = (d) => d.capacityKwh();
    const total = members.reduce((a, d) => a + cap(d), 0);
    if (!(total > 0)) return 0;
    return members.reduce((a, d) => a + (cap(d) * (Number(d.getSettings().wearCost) || 0)), 0) / total;
  }

  // The home's net per plan slot from the grid forecast, for the planner: without batteries, plus
  // the plans of the batteries before this one (device id), so they do not plan on the same
  // surplus. Never the grid's netPlanned (it holds this battery's own plan). members: the batteries
  // planned as one (a group). null without a grid.
  planNetForecast(startMs, n, planMin, members = [this]) {
    const grid = GridConnection.gridDevice(this.homey);
    if (!grid || !(n > 0)) return null;
    const endMs = startMs + (n * planMin * 60 * 1000);
    let f;
    let peak = null;
    try {
      f = grid.getNetForecast(startMs, endMs);
      if (typeof grid.getPeakLimitSeries === 'function') peak = grid.getPeakLimitSeries(startMs, endMs);
    } catch (err) {
      this.error(err);
      return null;
    }
    if (!f || !Array.isArray(f.netNoBattery) || !f.netNoBattery.length) return null;

    const myId = this.getData().id;
    const earlier = this.driver.getDevices().filter((d) => !members.includes(d) && d.getData().id < myId
      && typeof d.getPlannedPowerSeries === 'function');
    const others = earlier.map((d) => {
      try {
        return d.getPlannedPowerSeries(startMs, endMs);
      } catch {
        return null;
      }
    });
    // Surplus kept low by the measured forecast error: relying on solar that does not come costs
    // more than leaving some unused.
    const accuracy = typeof grid.getForecastAccuracy === 'function' ? grid.getForecastAccuracy() : null;
    const marginW = (accuracy && accuracy.maeW) || 0;
    // A group: one battery can run alone (XomSplit), so the lowest threshold counts.
    const minChargeW = Math.min(...members.map((d) => Number(d.batterySettings().minChargeW) || 0));
    const minDischargeW = Math.min(...members.map((d) => Number(d.batterySettings().minDischargeW) || 0));
    const toEv = members.every((d) => d.getSettings().dischargeToEv !== false);
    const shave = members.every((d) => d.getSettings().peakShaving === true);
    // Protection when one battery of the group protects: the limit is shared.
    const protect = members.some((d) => d.getSettings().fuseProtection !== false);
    const perSlot = Math.max(1, Math.round(planMin / 15));
    const mean = (vals) => vals.reduce((a, v) => a + v, 0) / vals.length;
    const net = [];
    for (let i = 0; i < n; i += 1) {
      const qs = [];
      for (let k = i * perSlot; k < (i + 1) * perSlot && k < f.netNoBattery.length; k += 1) qs.push(k);
      if (!qs.length) break;
      const netW = qs.map((q) => f.netNoBattery[q] + others.reduce((a, o) => a + ((o && o[q]) || 0), 0));
      const surplusW = Math.max(0, mean(netW.map((v) => Math.max(0, -v))) - marginW);
      const deficitW = mean(netW.map((v) => Math.max(0, v)));
      const homeW = toEv ? deficitW : mean(qs.map((q, j) => Math.max(0, netW[j] - ((f.ev && f.ev[q]) || 0))));
      const slot = {
        surplusW: Math.round(surplusW),
        deficitW: Math.round(deficitW),
        usableSurplusW: surplusW >= minChargeW ? Math.round(surplusW) : 0,
        usableDeficitW: homeW >= minDischargeW ? Math.round(homeW) : 0,
        limitW: null,
        penaltyPerKw: null,
        exportLimitW: protect && peak && peak.exportLimitW > 0 ? peak.exportLimitW : null,
      };
      // Capacity tariff limit (when one is set and the batteries shave peaks) and the hard limit
      // (contract or main fuse, when the connection is protected).
      const peakSlots = peak && Array.isArray(peak.slots) ? qs.map((q) => peak.slots[q]).filter(Boolean) : [];
      const tariffLimits = peak && peak.active && shave
        ? peakSlots.map((p) => p.limitW).filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
      const tariffW = tariffLimits.length ? Math.min(...tariffLimits) : Infinity;
      const hardW = protect && peak && peak.hardLimitW > 0 ? peak.hardLimitW : Infinity;
      if (Math.min(tariffW, hardW) < Infinity) {
        slot.limitW = Math.round(Math.min(tariffW, hardW));
        const first = peakSlots[0] || {};
        // null: no price known (as low as possible), or the hard limit: the planner uses a large penalty.
        // stepJump is a one-off monthly increase, used as a price per kW: a linear approximation.
        slot.penaltyPerKw = hardW < tariffW ? null : (first.penaltyPerKw ?? first.stepJump ?? null);
      }
      net.push(slot);
    }
    return { net, peakWindowMin: (peak && peak.windowMin) || 15 };
  }

  async updateValue(val, cap) {
    await super.updateValue(val, cap);
    if (cap !== 'soc') return;
    await this.trackUse(val);
    await this.learnEfficiency(val);
    if (!this.recordSocSample(val)) return;
    await this.saveSocHistory();
  }

  maxPowerW() {
    const settings = this.getSettings();
    return Math.max(Number(settings.chargePower) || 0, Number(settings.dischargePower) || 0) || null;
  }

  // The learned efficiency chart, built only when the image is opened (ChartImages reads it then).
  get chartEfficiency() {
    return getEfficiencyChart(BatteryEfficiency.summary(this.efficiency), {
      maxW: this.maxPowerW() || 2500,
      labels: {
        charge: this.homey.__('chart_legend.charge'),
        discharge: this.homey.__('chart_legend.discharge'),
        capacity: this.homey.__('chart_eff.capacity'),
        idle: this.homey.__('chart_eff.idle'),
        learning: this.homey.__('chart_eff.learning'),
      },
    });
  }

  // With nothing learned yet (at most once a day): the last 24 h of this device's own Insights
  // (5-minute values, any battery), so the efficiency chart does not start empty. Live samples
  // take over as old ones fade.
  async bootstrapEfficiency() {
    const learned = (state) => {
      const sm = BatteryEfficiency.summary(state);
      return sm.charge.length > 0 || sm.discharge.length > 0;
    };
    if (learned(this.efficiency)) return;
    const lastTm = this.getStoreValue('batteryEfficiencyBootstrapTm');
    if (lastTm && Date.now() - lastTm < 24 * 60 * 60 * 1000) return;
    await this.setStoreValue('batteryEfficiencyBootstrapTm', Date.now()).catch(this.error);
    const { api } = this.homey.app;
    const logs = api ? await this.homey.app.getInsightsLogs().catch(() => null) : null;
    if (!logs) return;
    const list = Array.isArray(logs) ? logs : Object.values(logs);
    const myId = this.getId();
    const entries = async (cap) => {
      const log = list.find((l) => (l.ownerUri || '').endsWith(myId) && (l.id || '').endsWith(`:${cap}`));
      const data = log ? await api.insights.getLogEntries({ id: log.id, resolution: 'last24Hours' }).catch(() => null) : null;
      return new Map(((data && data.values) || []).filter((e) => typeof e.v === 'number').map((e) => [e.t, e.v]));
    };
    const stored = await entries('meter_kwh_stored');
    const charged = await entries('meter_kwh_charging');
    const discharged = await entries('meter_kwh_discharging');
    // meter_kwh_stored is on the usable capacity; the samples are on the capacity setting.
    const capacityKwh = this.getSettings().batCapacity;
    const usableKwh = this.capacityKwh();
    const maxW = this.maxPowerW();
    let state = BatteryEfficiency.createState();
    let samples = 0;
    for (const [t, kwh] of stored) {
      if (charged.has(t) && discharged.has(t)) {
        const res = BatteryEfficiency.onSoc(state, {
          // 5-minute means blur the SoC: samples of at least 3 %, and a quarter of a live sample's weight.
          now: Date.parse(t), soc: (kwh / usableKwh) * 100, inKwh: charged.get(t), outKwh: discharged.get(t), capacityKwh, maxW, minSocStep: 3, weight: 0.25,
        });
        ({ state } = res);
        if (res.sample) samples += 1;
      }
    }
    if (!samples || learned(this.efficiency)) return;
    state.win = null;
    state.lastSoc = null;
    this.efficiency = state;
    this.log(`[Bat Eff] from Insights (24 h), ${samples} samples: ${BatteryEfficiency.describe(state)}`);
    await this.setStoreValue('batteryEfficiency', state).catch(this.error);
  }

  // The efficiency per power level, learned from each SoC change and the AC meters.
  async learnEfficiency(soc) {
    const now = Date.now();
    const { state, sample, reason } = BatteryEfficiency.onSoc(this.efficiency, {
      now,
      soc: Number(soc),
      // The source's own meters when it has them: Homey keeps capability meters in 10 Wh steps.
      inKwh: typeof this.lastMeterCharging === 'number' ? this.lastMeterCharging : this.getCapabilityValue('meter_kwh_charging'),
      outKwh: typeof this.lastMeterDischarging === 'number' ? this.lastMeterDischarging : this.getCapabilityValue('meter_kwh_discharging'),
      capacityKwh: this.getSettings().batCapacity,
      maxW: this.maxPowerW(),
    });
    this.efficiency = state;
    if (reason && reason !== 'input') this.log(`[Bat Eff] sample skipped: ${reason}`);
    if (!sample) return;
    const eff = sample.eff ? `, raw ${Math.round(sample.eff * 100)}%` : '';
    this.log(`[Bat Eff] ${sample.dir} ${sample.powerW ? `${Math.round(sample.powerW)} W, ` : ''}${(sample.h * 60).toFixed(0)} min${eff}`);
    if (!this.lastEfficiencyLogTm || now - this.lastEfficiencyLogTm >= EFFICIENCY_LOG_MS) {
      this.lastEfficiencyLogTm = now;
      this.log(`[Bat Eff] ${BatteryEfficiency.describe(this.efficiency)}`);
    }
    await this.setStoreValue('batteryEfficiency', this.efficiency).catch(this.error);
    await this.applyLearnedProps(now).catch((err) => this.error(err));
    await this.updateLearnedInfo().catch((err) => this.error(err));
  }

  // The settings with the battery properties: learned (store batteryProps), else start values.
  batterySettings(settings = this.getSettings()) {
    return BatteryEfficiency.withProps(settings, this.batteryProps);
  }

  capacityKwh() {
    return Number(this.batterySettings().batCapacity) || 0;
  }

  // For the EV planner (driver.solarStorage()): per 15 min from the plan the AC energy this battery
  // can still take at the start (null: no plan) and whether storing surplus pays there.
  solarStorageSeries(startMs, endMs) {
    const plan = this.latestPlan;
    const capKwh = this.capacityKwh();
    const { chargeSpeeds, dischargeSpeeds } = BatterySplit.speedsFromSettings(this.batterySettings());
    const effC = Math.max(0.5, ...chargeSpeeds.map((sp) => sp.eff));
    const effD = Math.max(0.5, ...dischargeSpeeds.map((sp) => sp.eff));
    const settings = this.getSettings();
    const room = [];
    const store = [];
    for (let t = startMs; t < endMs; t += 15 * 60 * 1000) {
      const idx = plan ? Math.floor((t - plan.startMs) / plan.intervalMs) : -1;
      const slot = idx >= 0 ? plan.slots[idx] : null;
      const soc = idx > 0 && plan.slots[idx - 1] ? plan.slots[idx - 1].soc : plan && plan.startSoc;
      room.push(slot && typeof soc === 'number' ? (Math.max(0, 100 - soc) / 100) * (capKwh / effC) : null);
      store.push(!!slot && !slot.noCharge);
    }
    return {
      capKwh, effC, effD, cycleCost: (Number(settings.minProfit) || 0) + (Number(settings.wearCost) || 0), room, store,
    };
  }

  // Once, from before the properties were learned only: the values in the old settings are the start
  // (Homey keeps the values of settings removed from the manifest, skill section 22).
  takeOverProps() {
    const settings = this.getSettings();
    const props = {};
    BatteryEfficiency.LEARNED_KEYS.forEach((key) => {
      if (typeof settings[key] === 'number') props[key] = settings[key];
    });
    if (!Object.keys(props).length) return null;
    this.setStoreValue('batteryProps', props).catch(this.error);
    return props;
  }

  // The learned capacity, loss values and min. power into the properties, at most once a day.
  async applyLearnedProps(now = Date.now()) {
    if (!BatteryEfficiency.progress(this.efficiency).learned) return;
    if (this.learnAppliedTm && now - this.learnAppliedTm < LEARN_APPLY_MS) return;
    this.learnAppliedTm = now;
    const settings = this.getSettings();
    const current = this.batterySettings(settings);
    const changes = BatteryEfficiency.toSettings(this.efficiency, current, settings.batCapacity);
    if (!changes) return;
    this.batteryProps = { ...(this.batteryProps || {}), ...changes };
    await this.setStoreValue('batteryProps', this.batteryProps).catch(this.error);
    this.log(`[Bat Eff] learned: ${Object.entries(changes).map(([key, value]) => `${key} ${current[key]} -> ${value}`).join(', ')}`);
  }

  // The label 'Learned' in the settings: progress, or the learned values.
  async updateLearnedInfo() {
    const p = BatteryEfficiency.progress(this.efficiency);
    const b = this.batterySettings();
    const pct = (loss) => 1 - ((Number(loss) || 0) / 100);
    // Learned: applied by applyLearnedProps() just before (no changes: the values match).
    const text = p.learned
      ? this.homey.__('battery_learned.learned', {
        kwh: (Number(b.batCapacity) || 0).toFixed(2),
        roundtrip: Math.round(100 * pct(b.chargeLossEff) * pct(b.dischargeLossEff)),
        minCharge: b.minChargeW,
        minDischarge: b.minDischargeW,
      })
      : this.homey.__('battery_learned.learning', {
        charge: Math.floor(p.charge), discharge: Math.floor(p.discharge), needed: p.needed,
      });
    if (this.getSettings().learnedInfo !== text) await this.setSettings({ learnedInfo: text });
  }

  // Repair option: forget what was learned (another battery, or learned wrong). No Insights
  // bootstrap for a day: those still hold the old battery.
  async onRepairAction(id) {
    if (id !== 'learnReset') return;
    this.efficiency = BatteryEfficiency.createState();
    this.batteryProps = {}; // not null: takeOverProps() would take the old settings again
    this.learnAppliedTm = null;
    this.taper = BatteryTaper.createState();
    await this.setStoreValue('batteryTaper', this.taper).catch(this.error);
    await this.setStoreValue('batteryEfficiency', this.efficiency).catch(this.error);
    await this.setStoreValue('batteryProps', this.batteryProps).catch(this.error);
    await this.setStoreValue('batteryEfficiencyBootstrapTm', Date.now()).catch(this.error);
    this.log('[Bat Eff] learned values reset (repair)');
  }

  // The learned SoC energy belongs to the capacity it was measured with.
  async rescaleEfficiency(oldKwh, newKwh) {
    if (!this.efficiency || !(oldKwh > 0) || !(newKwh > 0) || oldKwh === newKwh) return;
    this.efficiency = BatteryEfficiency.rescale(this.efficiency, newKwh / oldKwh);
    await this.setStoreValue('batteryEfficiency', this.efficiency).catch(this.error);
  }

  async handleUpdateMeter(reading) {
    // Must call the base, or meter periods and money are skipped.
    await super.handleUpdateMeter(reading);

    // The live signed power is on 'measure_watt_avg'.
    let livePower = (reading && typeof reading.measure_power === 'number') ? reading.measure_power : null;
    if (livePower === null && this.hasCapability('measure_watt_avg')) {
      livePower = this.getCapabilityValue('measure_watt_avg');
    }
    if (typeof livePower !== 'number') livePower = 0;

    const currentTimestamp = (reading && reading.meterTm) ? new Date(reading.meterTm).getTime() : Date.now();
    this.checkPlanSlot(currentTimestamp);
    if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
    const lastEntry = this.powerHistory[this.powerHistory.length - 1];
    if (!lastEntry || Math.abs(currentTimestamp - lastEntry.time) >= 60000) {
      this.powerHistory.push({ time: currentTimestamp, power: livePower });
      if (this.powerHistory.length > 2880) this.powerHistory.shift();
      if (!this.lastPowerHistorySaveTm || (currentTimestamp - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
        this.fileStore.set('powerHistory', this.powerHistory);
        this.lastPowerHistorySaveTm = currentTimestamp;
      }
    }
  }

  // From the driver's energy tick and each meter reading: a source that reports rarely must not
  // delay the plan.
  checkPlanSlot(now) {
    const slotStart = TimeHelpers.startOfLocalBlock(now, this.planIntervalMin(), this.timeZone || this.homey.clock.getTimezone());
    if (this.lastPlanSlotStart && slotStart !== this.lastPlanSlotStart) this.onPlanSlot(slotStart).catch((err) => this.error(err));
    this.lastPlanSlotStart = slotStart;
  }

  // A new plan slot: plan again. A price slot needs no broadcast: the list has its prices.
  async onPlanSlot() {
    if (!this.pricesNextHours) return;
    await this.flows.triggerNewPlanFlow();
    await this.updateChargeChart();
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    await this.refreshGroupPrices().catch(() => {});
    const minPriceDelta = this.getSettings().minProfit;
    // Reuse a plan from the same price slot and minPriceDelta (a flow trigger usually computed it
    // seconds ago), if made after the latest price update and the last (re)init.
    const slotMs = this.planIntervalMin() * 60 * 1000;
    // Price slots follow local time: bucket on local (offset-shifted) timestamps, not UTC epoch.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const localSlot = (ms) => Math.floor(TimeHelpers.toLocalDate(new Date(ms), tz).getTime() / slotMs);
    const sameSlot = this.lastPlanTm && localSlot(this.lastPlanTm) === localSlot(Date.now());
    const afterPrices = this.lastPlanTm && this.lastPlanTm >= (this.pricesUpdatedTm || 0);
    const tokens = (sameSlot && afterPrices && this.lastPlanMinPriceDelta === minPriceDelta && this.lastPlanTokens)
      ? { ...this.lastPlanTokens }
      : await this.flows.planTokens({ minPriceDelta }).catch((err) => this.error(err));
    if (!tokens) return;

    await this.setCapability('roi_duration', tokens.duration).catch((err) => this.error(err));

    const scheme = JSON.parse(tokens.scheme);
    // Forecast prices, and the expected ones after the list.
    const isForecast = this.toPlanSlots(this.pricesFromNow().isForecast) || [];
    Object.keys(scheme).forEach((k) => {
      if (isForecast[k] || Number(k) >= isForecast.length) scheme[k].isForecast = true;
    });

    await this.renderChargeCharts({
      scheme,
      chargePower: this.getSettings().chargePower || 2200,
      dischargePower: this.getSettings().dischargePower || 1700,
      socFallback: typeof this.soc === 'number' ? this.soc : null,
      planTm: this.lastPlanTm || Date.now(),
      showPower: !!this.getSettings().chartShowPower,
      showSoc: this.getSettings().chartShowSoc !== false,
      showExportPrice: this.getSettings().chartShowExportPrice !== false,
      showLegend: this.getSettings().chartShowLegend !== false,
    });
  }

  triggerXOMFlow(split, samples, x, smoothing, minLoad, cumulativePower) {
    if (!this.flows) return Promise.resolve(false);
    return this.flows.triggerXomFlow(split, samples, x, smoothing, minLoad, cumulativePower);
  }
}

Object.assign(BatDevice.prototype, ChargeDeviceHelpers);

module.exports = BatDevice;
