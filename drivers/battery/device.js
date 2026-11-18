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

const EnergyExclude = require('../../lib/helpers/EnergyExclude');
const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const ChartImages = require('../../lib/helpers/ChartImages');
const GridConnection = require('../../lib/helpers/GridConnection');
const InsightsHistory = require('../../lib/helpers/InsightsHistory');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const BatteryCalibration = require('../../lib/strategies/BatteryCalibration');
const BatteryControl = require('../../lib/strategies/BatteryControl');
const BatteryEfficiency = require('../../lib/strategies/BatteryEfficiency');
const BatteryResponse = require('../../lib/strategies/BatteryResponse');
const BatterySplit = require('../../lib/strategies/BatterySplit');
const BatteryPlan = require('../../lib/helpers/BatteryPlan');
const BatteryUse = require('../../lib/strategies/BatteryUse');
const BatteryTaper = require('../../lib/strategies/BatteryTaper');
const PhaseLearning = require('../../lib/strategies/PhaseLearning');
const SettingsView = require('../../lib/helpers/SettingsView');
const { getEfficiencyChart } = require('../../lib/charts/EfficiencyChart');
const { setTimeoutPromise } = require('../../lib/helpers/Util');
const BatteryDayLog = require('../../lib/helpers/BatteryDayLog');

const OWN_WRITE_ECHO_MS = 60 * 1000;
const SOC_REPLAN_PCT = 3;
const SOC_REPLAN_MS = 10 * 60 * 1000;
const SETUP_CHECK_MS = 60 * 1000;
const RELEASE_RETRY_MS = 60 * 1000;
const RELEASE_FAST_MS = 15 * 60 * 1000;
const RELEASE_NIGHT = '03:00';
const PLAN_WAIT_MS = 10 * 60 * 1000;
const FUSE_YIELD_MS = 2 * 60 * 1000;
const PHASE_STEP_W = 600;
const HOME_USE_W = 300;
const PLAN_HOURS = 48;
const EFFICIENCY_LOG_MS = 60 * 60 * 1000;
const LEARN_APPLY_MS = 24 * 60 * 60 * 1000;
const CAL_RETRY_MS = 15 * 60 * 1000;
const CAL_MODES = ['smart', 'self_consumption'];
const CAL_DAYS = 7;
const GRID_WARN_AFTER_MS = 2 * 60 * 1000;
const CAL_REFRESH_MS = 5 * 60 * 1000;
const CAL_LEAD_MS = 60 * 60 * 1000;
const TAPER_SAVE_MS = 15 * 60 * 1000;
const USE_SAVE_CYCLES = 0.02;

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
    this.lastPlanTm = null;
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

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
    if (this.efficiency) this.efficiency.win = null;
    this.controlError = null;
    this.warningShown = undefined;
    this.controlState = {};
    await super.onInit().catch(this.error);

    if (this.hasCapability('battery_mode')) {
      if (!this.getCapabilityValue('battery_mode')) await this.setCapabilityValue('battery_mode', 'smart').catch(this.error);
      if (!this.batteryModeListener) {
        this.batteryModeListener = true;
        this.registerCapabilityListener('battery_mode', (mode) => this.setBatteryMode(mode, 'set by user'));
      }
    }

    const currentSessionId = this.sessionId;
    this.populateHistoryFromInsights().catch((err) => this.error('Error populating battery insights:', err));
    await BatteryDayLog.start(this);

    const initStrategy = async () => {
      await setTimeoutPromise(10000 + (Math.random() * 60000), this);
      if (this.sessionId !== currentSessionId) return;
      await this.bootstrapEfficiency().catch((err) => this.error(err));
      await this.applyAutoMinProfit().catch((err) => this.error(err));
      await this.updatePriceProfile().catch((err) => this.error(err));
      await this.applyLearnedProps().catch((err) => this.error(err));
      await this.updateLearnedInfo().catch((err) => this.error(err));
      await this.updateCalibrationInfo().catch((err) => this.error(err));
      if (this.pricesNextHours) {
        await this.flows.triggerNewPlanFlow().catch((err) => this.error(err));
        await this.updatePlan().catch((err) => this.error(err));
      }
    };
    initStrategy().catch((err) => this.error(err));
  }

  async onPricesUpdated() {
    this.pricesUpdatedTm = Date.now();
    this.pricesUpdated = true;
    await this.applyAutoMinProfit().catch((err) => this.error(err));
    await this.updatePriceProfile().catch((err) => this.error(err));
    await this.flows.triggerNewPlanFlow();
    await this.updatePlan();
  }

  async applyAutoMinProfit() {
    if (!this.getStoreValue('minProfitAuto')) return;
    const settings = this.getSettings();
    if (Number(settings.minProfit) === 0) {
      const minProfit = this.driver.defaultMinProfit(Number(settings.tariff_update_group));
      if (minProfit === null) return;
      this.log(`${this.getName()}: minimum profit ${minProfit} from the prices`);
      await this.setSettings({ minProfit });
    }
    await this.setStoreValue('minProfitAuto', false);
  }

  async updatePriceProfile() {
    if (!this.pricesNextHours) return;
    await this.bootstrapPriceProfile();
    const now = Date.now();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const priceMin = this.priceInterval || 60;
    const known = await this.learnPriceProfile(this.pricesFromNow(now), TimeHelpers.startOfLocalBlock(now, priceMin, tz), priceMin, tz);
    this.expectedPrice = this.expectedPriceFn(known, tz, now);
  }

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

  roleUsed(role) {
    return this.sourceCapGroup ? !!this.sourceCapGroup[role] : null;
  }

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
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
      const obj = this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.target_power_mode;
      this.sourceModeValue = obj ? obj.value : null;
      this.capabilityInstances.sourceMode = this.sourceDevice.makeCapabilityInstance('target_power_mode', (value) => {
        this.onSourceModeChanged(value).catch((err) => this.error(err));
      });
    }
  }

  onDayEnded() {
    return BatteryDayLog.logYesterday(this);
  }

  async onUninit() {
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
    const replan = planned(mode) !== planned(current) ? this.replan('mode', { quick: true }) : Promise.resolve();
    replan.catch((err) => this.error(err)).then(() => this.driver.replanEvChargers()).catch((err) => this.error(err));
  }

  async endTempModeIfDue(now) {
    if (!this.tempMode || now < this.tempMode.until) return;
    await this.setBatteryMode(this.tempMode.previousMode, 'temporary mode ended', 0, { sync: false });
  }

  inGroup() {
    const settings = this.getSettings();
    return settings.groupPlan !== false && this.getBatteryMode() !== 'device';
  }

  async stopPrecisePlanning() {
    await this.setSettings({ precisePlanning: false });
    this.groupPlans = null;
    this.lastPlanTm = null;
    this.lastPlanKey = null;
    this.lastPlanTokens = null;
    await SettingsView.update(this).catch((err) => this.error(err));
  }

  async joinGroup() {
    if (this.groupJoined) return;
    this.groupJoined = true;
    const group = this.driver.groupDevices();
    const ref = group.sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1))[0];
    if (!ref || ref === this) return;
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

  isControlConfigured() {
    return !!(this.getSettings().batteryControl && this.sourceCapGroup && this.sourceCapGroup.setpoint
      && this.sourceDevice && this.hasCapability('battery_mode'));
  }

  isXomControlled() {
    return this.isControlConfigured() && this.getBatteryMode() !== 'device';
  }

  controlPowerW() {
    return typeof this.lastSetpointW === 'number' && this.getStoreValue('controlTakeover')
      ? this.lastSetpointW : (Number(this.getCapabilityValue('measure_watt_avg')) || 0);
  }

  controlCommandW() {
    return typeof this.decidedW === 'number' && this.getStoreValue('controlTakeover') ? this.decidedW : this.controlPowerW();
  }

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

  async controlPrepare(now) {
    if (!this.initReady || this.isDestroyed) return null;
    await this.updateWarning(now, true);
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
      if (!this.fuseAtRisk()) return null;
      return {
        mode: 'idle', slot: null, block: 'idle', noCharge: false, refill: false,
      };
    }
    await this.updateCalibration(now);
    await this.learnTaper(now);
    const calibrate = this.calibrationActive() ? BatteryCalibration.tail(this.calibration, this.soc) : null;
    const refill = typeof this.soc === 'number' && this.soc < this.reservePct() && BatteryControl.refillsReserve(mode);
    const plan = BatteryControl.blockFor(mode, slot, calibrate);
    return {
      mode, slot, calibrate, block: plan.block, noCharge: !!plan.noCharge, homeCapW: plan.homeCapW || null, refill,
    };
  }

  async controlApply(prep, now, gridW, xom, share = 1, phaseShare = share) {
    if (this.controlRun) return;
    this.controlRun = this.applyControl(prep, now, gridW, xom, share, phaseShare).finally(() => {
      this.controlRun = null;
    });
    await this.controlRun;
  }

  async applyControl(prep, now, gridW, xom, share, phaseShare = share) {
    const settings = this.batterySettings();
    const batteryW = this.controlPowerW();
    const rawW = this.getCapabilityValue('measure_watt_avg');
    const fresh = typeof rawW === 'number' && this.lastReportTm && now - this.lastReportTm <= BatteryControl.FAST_REPORT_MS;
    const importBaseW = fresh ? Math.min(batteryW, rawW) : batteryW;
    const exportBaseW = fresh ? Math.max(batteryW, rawW) : batteryW;
    if (xom) {
      this.xomAvgW = BatteryControl.average(this.xomAvgW, xom.needW, now - (this.xomAvgTm || now));
      this.xomAvgTm = now;
    }
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

  pulseParams(settings) {
    const res = this.response && this.response.standstill;
    const key = JSON.stringify([BatterySplit.speedsFromSettings(settings), res && res.n >= 3 ? Math.round(res.ms / 1000) : null]);
    if (this.pulseKey !== key) {
      this.pulseKey = key;
      this.pulse = BatteryControl.pulseParams(settings, this.response);
    }
    return this.pulse;
  }

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

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (EnergyExclude.onlyHomeyEnergy(changedKeys)) return undefined;
    if (changedKeys.includes('xomTarget')) this.driver.setXomTargetFromSetting(newSettings.xomTarget, this);
    if (changedKeys.every((key) => key === 'xomTarget')) return true;
    const result = await super.onSettings({ newSettings, changedKeys });
    if (changedKeys.includes('batCapacity')) await this.rescaleEfficiency(oldSettings.batCapacity, newSettings.batCapacity);
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

  async setAction(action) {
    if (!this.hasCapability('battery_action') || this.getCapabilityValue('battery_action') === action) return;
    await this.setCapabilityValue('battery_action', action).catch(this.error);
  }

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

  fusePhases(trustLearned = true) {
    const s = this.getSettings();
    const spec = PhaseLearning.specOf(s.batteryPhase, this.getStoreValue('phaseVotes'), trustLearned);
    if (spec) return spec;
    return {
      n: null, set: null, powerW: Math.max(Number(s.chargePower) || 0, Number(s.dischargePower) || 0), known: false,
    };
  }

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

  fuseAtRisk() {
    if (this.getSettings().fuseProtection === false) return false;
    const grid = GridConnection.gridDevice(this.homey);
    if (!grid) return false;
    const spec = this.fusePhases(typeof grid.trustsLearnedPhases !== 'function' || grid.trustsLearnedPhases());
    const rooms = [grid.getImportHeadroomW({ tariff: false, hard: true }), grid.getExportHeadroomW()];
    if (typeof grid.getPhaseRoomW === 'function') rooms.push(grid.getPhaseRoomW(spec), grid.getPhaseExportRoomW(spec));
    return rooms.some((w) => typeof w === 'number' && w < 0);
  }

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

  async onSourceModeChanged(value) {
    this.sourceModeValue = value;
    if (!this.getStoreValue('controlTakeover') || value === 'homey') return;
    if (this.ownModeWriteTm && Date.now() - this.ownModeWriteTm < OWN_WRITE_ECHO_MS) return;
    await this.setStoreValue('controlTakeover', null);
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
    const writtenW = this.setpointInvert ? -value : value;
    if (typeof this.writtenW !== 'number' || Math.abs(writtenW - this.writtenW) >= 100) this.setChangeTm = now;
    this.writtenW = writtenW;
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
      this.controlError = this.homey.__('bat_control_failed', { error: err.message || String(err) });
      await this.updateWarning(now);
    }
  }

  async clearControlWarning() {
    if (!this.controlError) return;
    this.controlError = null;
    await this.updateWarning();
  }

  deviceWarning(now = Date.now(), tick = false) {
    if (this.controlError) return this.controlError;
    if (!tick || !(now - (this.setupCheckTm || 0) < SETUP_CHECK_MS)) {
      this.setupWarning = this.sourceWarning() || this.priceWarning();
      this.setupCheckTm = now;
    }
    const setup = this.setupWarning;
    if (setup) return setup;
    if (now - this.initTm < GRID_WARN_AFTER_MS) return this.warningShown === undefined ? undefined : null;
    if (!this.isControlConfigured() || !CAL_MODES.includes(this.getBatteryMode())
      || GridConnection.gridDevice(this.homey)) return null;
    return this.homey.__('warning_no_grid_monitor');
  }

  async updateWarning(now = Date.now(), tick = false) {
    const warning = this.deviceWarning(now, tick);
    if (warning === undefined || warning === this.warningShown) return;
    this.warningShown = warning;
    if (warning) await this.setWarning(warning).catch(this.error);
    else await this.unsetWarning().catch(this.error);
  }

  checkSocDeviation(slot, now) {
    if (!slot || !(slot.index >= 0) || typeof this.soc !== 'number') return;
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
    this.lastPlanTm = null;
    this.lastPlanKey = null;
    const group = this.planGroup ? this.planGroup() : null;
    if (group) group[0].groupPlans = null;
    this.replan('SoC').catch((err) => this.error(err));
  }

  async replan(reason, { quick = false } = {}) {
    if (!this.pricesNextHours) return;
    this.log(`[Plan] Plan again (${reason})`);
    await this.flows.triggerNewPlanFlow({ quick });
    await this.updatePlan();
  }

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
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 48 * 60 * 60 * 1000);

      const fetchEntries = async (log) => {
        if (!log) return null;
        const series = await InsightsHistory.fetchSeries({
          api, log, startDate, endDate, coarseResolutions: ['last7Days', 'last14Days'], signed: true,
        });
        return series ? series.map((e) => ({ time: e.t, value: Math.round(e.v) })) : null;
      };

      const resolvedPowerCap = (this.sourceCapGroup && (this.sourceCapGroup.newMeasurePower || this.sourceCapGroup.power)) || null;
      const resolvedPowerInvert = !!this.sourcePowerInvert;

      const powerCandidates = [];
      if (resolvedPowerCap && resolvedPowerCap !== 'measure_power') {
        powerCandidates.push({ cap: resolvedPowerCap, invert: resolvedPowerInvert });
      }
      powerCandidates.push({ cap: 'energy_power', invert: false });
      if (!resolvedPowerCap) {
        ['measure_power.battery', 'measure_power.sessy', 'meter_power'].forEach((cap) => powerCandidates.push({ cap, invert: false }));
      }

      const guessed = resolvedPowerCap ? [] : (this.sourceDevice.capabilities || []).filter((c) => c.startsWith('measure_power.'));
      const socCaps = [...new Set([this.sourceCapGroup && this.sourceCapGroup.soc, 'measure_battery', 'soc'].filter(Boolean))];
      const devLogs = await InsightsHistory.deviceLogs(api, sourceId, [
        ...powerCandidates.map((c) => c.cap), ...guessed, ...socCaps,
      ]);

      let powerLog = null;
      let powerLogInvert = false;
      for (const candidate of powerCandidates) {
        const found = devLogs.find((l) => {
          const id = l.id || l.uri || l.ownerUri || '';
          const cap = id.split(':').pop() || '';
          return cap === candidate.cap;
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
        if (result && result.length > 0) {
          const powerMap = new Map();
          if (Array.isArray(this.powerHistory)) {
            this.powerHistory.forEach((e) => powerMap.set(e.time, e.power));
          }
          result.forEach((e) => powerMap.set(e.time, powerLogInvert ? -e.value : e.value));
          this.powerHistory = Array.from(powerMap.entries())
            .map(([time, power]) => ({ time, power }))
            .sort((a, b) => a.time - b.time);
          if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
          this.fileStore.set('powerHistory', this.powerHistory);
        }
      }

      const socLog = socCaps.map((c) => devLogs.find((l) => (l.id || l.uri || l.ownerUri || '').split(':').pop() === c)).find(Boolean);

      if (socLog) {
        const result = await fetchEntries(socLog);
        if (result && result.length > 0) {
          const socMap = new Map();
          if (Array.isArray(this.socHistory)) {
            this.socHistory.forEach((e) => socMap.set(e.time, e.soc));
          }
          result.forEach((e) => socMap.set(e.time, e.value));
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

  toPlanSlots(list, now = Date.now()) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const priceMin = this.priceInterval || 60;
    const planMin = this.planIntervalMin();
    return TimeHelpers.toFinerSlots(list, TimeHelpers.startOfLocalBlock(now, priceMin, tz), priceMin,
      TimeHelpers.startOfLocalBlock(now, planMin, tz), planMin);
  }

  planGroup() {
    if (!this.inGroup() || this.calibrationActive() || !this.getAvailable()) return null;
    const group = this.driver.groupDevices().filter((d) => !d.calibrationActive() && d.getAvailable())
      .sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1));
    return group.length > 1 && group.includes(this) ? group : null;
  }

  reservePct() {
    if (this.calibrationActive()) return 0;
    return Math.min(90, Math.max(0, Number(this.getSettings().peakReservePct) || 0));
  }

  planSocToReal(socPct) {
    const r = this.reservePct();
    return r ? Math.round(r + ((socPct * (100 - r)) / 100)) : socPct;
  }

  planBattery() {
    const settings = this.batterySettings();
    const r = this.reservePct();
    const soc = Number(this.soc) || 0;
    return {
      soc: r ? (Math.max(0, soc - r) * 100) / (100 - r) : this.soc,
      batCapacity: settings.batCapacity * (1 - (r / 100)),
      ...BatterySplit.speedsFromSettings(settings),
      ...BatteryTaper.planLimits(this.taper, { capKwh: Number(settings.batCapacity) || 0, reservePct: r }),
    };
  }

  async initUse() {
    let state = this.getStoreValue('batteryUse');
    if (!state) {
      const others = this.driver.getDevices().map((d) => d !== this && d.getStoreValue('batteryUse')).filter(Boolean);
      state = BatteryUse.createState(others.length ? others.reduce((a, u) => a + u.cycles, 0) / others.length : 0);
      await this.setStoreValue('batteryUse', state).catch(this.error);
    }
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

  useInfo() {
    return {
      wear: Number(this.getSettings().wearCost) || 0,
      cycles: Math.round((this.use ? this.use.cycles : 0) * 100) / 100,
    };
  }

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
    const nowLearned = !BatteryTaper.learned(before, sample.dir) && BatteryTaper.learned(this.taper, sample.dir);
    if (!nowLearned && this.taperSaveTm && now - this.taperSaveTm < TAPER_SAVE_MS) return;
    this.taperSaveTm = now;
    this.log(`[Bat Taper] ${sample.dir} ${Math.round(sample.w)} W at SoC ${sample.socPct}%: ${BatteryTaper.describe(this.taper)}`);
    await this.setStoreValue('batteryTaper', this.taper).catch(this.error);
  }

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
      startMinute: TimeHelpers.toLocalDate(new Date(now), tz).getMinutes(),
      priceInterval: planMin,
      homePowerUsage: HOME_USE_W,
      net: forecast ? forecast.net : null,
      peakWindowMin: forecast ? forecast.peakWindowMin : 15,
      ...BatteryControl.planOptionsFor(this.getBatteryMode()),
      ...(socBounds ? { socBounds, allowGridCharge: true } : {}),
    };
  }

  calibrationDays() {
    const days = this.getSettings().calibrateDays;
    return typeof days === 'number' ? Math.max(0, days) : CAL_DAYS;
  }

  calibrationActive() {
    return !!(this.calibration && this.calibration.phase) && this.isControlConfigured() && CAL_MODES.includes(this.getBatteryMode());
  }

  calibrationReady() {
    return this.isControlConfigured() && CAL_MODES.includes(this.getBatteryMode()) && !!this.pricesNextHours;
  }

  calibrationDue(now) {
    return BatteryCalibration.isDue(this.calibration, this.calibrationDays(), now);
  }

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

  async saveCalibration(replan) {
    await this.setStoreValue('batteryCalibration', this.calibration).catch(this.error);
    await this.updateCalibrationInfo().catch((err) => this.error(err));
    if (replan) this.driver.replanAll('calibration').catch((err) => this.error(err));
  }

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

  wearCostFor(members) {
    const cap = (d) => d.capacityKwh();
    const total = members.reduce((a, d) => a + cap(d), 0);
    if (!(total > 0)) return 0;
    return members.reduce((a, d) => a + (cap(d) * (Number(d.getSettings().wearCost) || 0)), 0) / total;
  }

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
    const accuracy = typeof grid.getForecastAccuracy === 'function' ? grid.getForecastAccuracy() : null;
    const marginW = (accuracy && accuracy.maeW) || 0;
    const minChargeW = Math.min(...members.map((d) => Number(d.batterySettings().minChargeW) || 0));
    const minDischargeW = Math.min(...members.map((d) => Number(d.batterySettings().minDischargeW) || 0));
    const toEv = members.every((d) => d.getSettings().dischargeToEv !== false);
    const shave = members.every((d) => d.getSettings().peakShaving === true);
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
      const peakSlots = peak && Array.isArray(peak.slots) ? qs.map((q) => peak.slots[q]).filter(Boolean) : [];
      const tariffLimits = peak && peak.active && shave
        ? peakSlots.map((p) => p.limitW).filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
      const tariffW = tariffLimits.length ? Math.min(...tariffLimits) : Infinity;
      const hardW = protect && peak && peak.hardLimitW > 0 ? peak.hardLimitW : Infinity;
      if (Math.min(tariffW, hardW) < Infinity) {
        slot.limitW = Math.round(Math.min(tariffW, hardW));
        const first = peakSlots[0] || {};
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
    if (!api) return;
    const entries = async (cap) => {
      const data = await api.insights.getLogEntries({ id: InsightsHistory.deviceLogId(this.getId(), cap), resolution: 'last24Hours' })
        .catch(() => null);
      return new Map(((data && data.values) || []).filter((e) => typeof e.v === 'number').map((e) => [e.t, e.v]));
    };
    const stored = await entries('meter_kwh_stored');
    const charged = await entries('meter_kwh_charging');
    const discharged = await entries('meter_kwh_discharging');
    const capacityKwh = this.getSettings().batCapacity;
    const usableKwh = this.capacityKwh();
    const maxW = this.maxPowerW();
    let state = BatteryEfficiency.createState();
    let samples = 0;
    for (const [t, kwh] of stored) {
      if (charged.has(t) && discharged.has(t)) {
        const res = BatteryEfficiency.onSoc(state, {
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

  async learnEfficiency(soc) {
    const now = Date.now();
    const { state, sample, reason } = BatteryEfficiency.onSoc(this.efficiency, {
      now,
      soc: Number(soc),
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

  batterySettings(settings = this.getSettings()) {
    return BatteryEfficiency.withProps(settings, this.batteryProps);
  }

  capacityKwh() {
    return Number(this.batterySettings().batCapacity) || 0;
  }

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

  async updateLearnedInfo() {
    const p = BatteryEfficiency.progress(this.efficiency);
    const b = this.batterySettings();
    const pct = (loss) => 1 - ((Number(loss) || 0) / 100);
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

  async onRepairAction(id) {
    if (id !== 'learnReset') return;
    this.efficiency = BatteryEfficiency.createState();
    this.batteryProps = {};
    this.learnAppliedTm = null;
    this.taper = BatteryTaper.createState();
    await this.setStoreValue('batteryTaper', this.taper).catch(this.error);
    await this.setStoreValue('batteryEfficiency', this.efficiency).catch(this.error);
    await this.setStoreValue('batteryProps', this.batteryProps).catch(this.error);
    await this.setStoreValue('batteryEfficiencyBootstrapTm', Date.now()).catch(this.error);
    this.log('[Bat Eff] learned values reset (repair)');
  }

  async rescaleEfficiency(oldKwh, newKwh) {
    if (!this.efficiency || !(oldKwh > 0) || !(newKwh > 0) || oldKwh === newKwh) return;
    this.efficiency = BatteryEfficiency.rescale(this.efficiency, newKwh / oldKwh);
    await this.setStoreValue('batteryEfficiency', this.efficiency).catch(this.error);
  }

  async handleUpdateMeter(reading) {
    await super.handleUpdateMeter(reading);

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

  checkPlanSlot(now) {
    const slotStart = TimeHelpers.startOfLocalBlock(now, this.planIntervalMin(), this.timeZone || this.homey.clock.getTimezone());
    if (this.lastPlanSlotStart && slotStart !== this.lastPlanSlotStart) this.onPlanSlot(slotStart).catch((err) => this.error(err));
    this.lastPlanSlotStart = slotStart;
  }

  async onPlanSlot() {
    await this.updateWarning();
    if (!this.pricesNextHours) return;
    await this.flows.triggerNewPlanFlow();
    await this.updatePlan();
  }

  async updatePlan() {
    if (!this.pricesNextHours || !this.getAvailable()) return;
    await this.refreshGroupPrices().catch(() => {});
    const minPriceDelta = this.getSettings().minProfit;
    const slotMs = this.planIntervalMin() * 60 * 1000;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const localSlot = (ms) => Math.floor(TimeHelpers.toLocalDate(new Date(ms), tz).getTime() / slotMs);
    const sameSlot = this.lastPlanTm && localSlot(this.lastPlanTm) === localSlot(Date.now());
    const afterPrices = this.lastPlanTm && this.lastPlanTm >= (this.pricesUpdatedTm || 0);
    const tokens = (sameSlot && afterPrices && this.lastPlanMinPriceDelta === minPriceDelta && this.lastPlanTokens)
      ? BatteryPlan.cachedTokens(this)
      : await BatteryPlan.tokens(this, { minPriceDelta }).catch((err) => this.error(err));
    if (!tokens) return;

    await this.setCapability('roi_duration', tokens.duration).catch((err) => this.error(err));

    const scheme = JSON.parse(tokens.scheme);
    const isForecast = this.toPlanSlots(this.pricesFromNow().isForecast) || [];
    Object.keys(scheme).forEach((k) => {
      if (isForecast[k] || Number(k) >= isForecast.length) scheme[k].isForecast = true;
    });

    const periods = await this.applyPlan({ scheme, planTm: this.lastPlanTm || Date.now() });
    await this.renderChargeCharts({
      scheme,
      periods,
      chargePower: this.getSettings().chargePower || 2200,
      dischargePower: this.getSettings().dischargePower || 1700,
      socFallback: typeof this.soc === 'number' ? this.soc : null,
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
