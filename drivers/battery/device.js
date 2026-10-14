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
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const BatteryControl = require('../../lib/strategies/BatteryControl');
const BatteryEfficiency = require('../../lib/strategies/BatteryEfficiency');
const { getEfficiencyChart } = require('../../lib/charts/EfficiencyChart');
const { setTimeoutPromise } = require('../../lib/helpers/Util');

// A mode write of our own reported back within this time is no change by the battery app.
const OWN_WRITE_ECHO_MS = 60 * 1000;
// Plan again when the SoC is this far (%) from the plan, at most every SOC_REPLAN_MS. 3: above the
// 1 % steps most batteries report.
const SOC_REPLAN_PCT = 3;
const SOC_REPLAN_MS = 10 * 60 * 1000;
const RELEASE_RETRY_MS = 60 * 1000;
const EFFICIENCY_LOG_MS = 60 * 60 * 1000;

// Plans in 15-minute slots, as the grid forecast and capacity tariffs; prices per price slot.
const deviceSpecifics = { planIntervalMin: 15 };

class BatDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    // A (re)init can follow a settings change: never let the chart reuse a plan from before it.
    this.lastStratTm = null;
    // Before super.onInit(): it sets initReady partway, and onPricesUpdated() then renders charts.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    // Before super.onInit(): its first samples would otherwise overwrite the stored history.
    this.powerHistory = await this.loadStoredHistory('powerHistory');
    this.socHistory = await this.loadStoredHistory('socHistory');
    this.tempMode = this.getStoreValue('batTempMode') || null;
    this.efficiency = this.getStoreValue('batteryEfficiency') || null;
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
      if (this.pricesNextHours) {
        await this.flows.triggerNewRoiStrategyFlow().catch((err) => this.error(err));
        await this.updateChargeChart().catch((err) => this.error(err));
      }
    };
    initStrategy().catch((err) => this.error(err));
  }

  async onPricesUpdated() {
    this.pricesUpdatedTm = Date.now(); // see updateChargeChart(): only reuse plans made after this
    this.pricesUpdated = true;
    await this.flows.triggerNewRoiStrategyFlow();
    await this.updateChargeChart();
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
    return super.onUninit();
  }

  onDeleted() {
    this.isDestroyed = true;
    this.releaseControl('device deleted').catch((err) => this.error(err));
    super.onDeleted();
  }

  // --- Built-in control (setting batteryControl, capability battery_mode) ---

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
    // Self-consumption plans differently.
    if ((mode === 'self_consumption') !== (current === 'self_consumption')) this.replan('mode').catch((err) => this.error(err));
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

  // Once on entering the group: take the group's mode (of the battery with the lowest id).
  async joinGroup() {
    if (this.groupJoined) return;
    this.groupJoined = true;
    const group = this.driver.groupDevices();
    const ref = group.sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1))[0];
    if (!ref || ref === this) return;
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
  isZeroControlled() {
    return this.isControlConfigured() && this.getBatteryMode() !== 'device';
  }

  // The power this battery adds to the grid: the last setpoint while controlling (the measured
  // power lags it), else the measured power (set on every measurement).
  controlPowerW() {
    return typeof this.lastSetpointW === 'number' && this.getStoreValue('controlTakeover')
      ? this.lastSetpointW : (Number(this.getCapabilityValue('measure_watt_avg')) || 0);
  }

  // Driver tick, step 1: housekeeping, and what this battery does now. null: not controlled.
  async controlPrepare(now) {
    if (!this.initReady || this.isDestroyed) return null;
    this.checkPlanSlot(now);
    await this.endTempModeIfDue(now);
    if (this.inGroup()) await this.joinGroup();
    else this.groupJoined = false;
    if (!this.isControlConfigured() || this.getBatteryMode() === 'device') {
      await this.clearControlWarning();
      if (this.getStoreValue('controlTakeover') && now - (this.releaseFailTm || 0) >= RELEASE_RETRY_MS) {
        await this.releaseControl(this.isControlConfigured() ? 'mode device' : 'control off');
      }
      return null;
    }
    const mode = this.getBatteryMode();
    const slot = BatteryControl.slotAt(this.latestPlan, now);
    // Below the reserve it recharges (BatteryControl): no zero on the meter then.
    const refill = typeof this.soc === 'number' && this.soc < this.reservePct() && BatteryControl.refillsReserve(mode);
    const plan = BatteryControl.blockFor(mode, slot);
    return {
      mode, slot, block: plan.block, noCharge: !!plan.noCharge, refill,
    };
  }

  // Driver tick, step 2. nom: { targetW, needW } from NomXomStrategy in a zero/hold block.
  // share: this battery's part of the import headroom.
  async controlApply(prep, now, gridW, nom, share = 1) {
    if (this.controlRun) return;
    // Kept so that releaseControl() can wait for a write in progress.
    this.controlRun = this.applyControl(prep, now, gridW, nom, share).finally(() => {
      this.controlRun = null;
    });
    await this.controlRun;
  }

  async applyControl(prep, now, gridW, nom, share) {
    const settings = this.getSettings();
    const batteryW = this.controlPowerW();
    if (nom) {
      this.zeroAvgW = BatteryControl.average(this.zeroAvgW, nom.needW, now - (this.zeroAvgTm || now));
      this.zeroAvgTm = now;
    }
    const shave = settings.peakShaving === true;
    const protect = settings.fuseProtection !== false;
    const headroomW = this.gridImportHeadroomW({ tariff: shave, hard: protect });
    const hardHeadroomW = protect ? this.gridImportHeadroomW({ tariff: false, hard: true }) : null;
    const r = BatteryControl.decide({
      mode: prep.mode,
      slot: prep.slot,
      now,
      gridW,
      batteryW,
      nomW: nom ? nom.targetW : null,
      nomNeedW: nom ? nom.needW : null,
      avgZeroW: nom ? this.zeroAvgW : undefined,
      socPct: this.soc,
      capacityKwh: settings.batCapacity,
      maxChargeW: settings.chargePower,
      maxDischargeW: settings.dischargePower,
      minChargeW: Number(settings.minChargeW) || 0,
      minDischargeW: Number(settings.minDischargeW) || 0,
      maxW: headroomW === null ? null : batteryW + (headroomW * share),
      minSocPct: this.reservePct(),
      reserveForPeak: shave,
      hardMaxW: hardHeadroomW === null ? null : batteryW + (hardHeadroomW * share),
      state: this.controlState,
    });
    this.controlState = r.state;
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
    if (this.isDestroyed) return;
    if (BatteryControl.shouldWrite({
      powerW: r.powerW, lastW: this.lastSetpointW, lastTm: this.lastSetpointTm, now,
    })) await this.writeSetpoint(r.powerW, now);
    this.checkSocDeviation(prep.slot, now);
  }

  // tariff: the capacity tariff (setting peakShaving); hard: the main fuse and contracted power
  // (setting fuseProtection).
  gridImportHeadroomW({ tariff = true, hard = true } = {}) {
    try {
      const grid = this.homey.drivers.getDriver('grid').getDevices().find((d) => typeof d.getImportHeadroomW === 'function');
      return grid ? grid.getImportHeadroomW({ tariff, hard }) : null;
    } catch {
      return null;
    }
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
  // (controlPrepare(), every RELEASE_RETRY_MS).
  async releaseControl(reason) {
    if (this.controlRun) await this.controlRun.catch(() => {});
    const takeover = this.getStoreValue('controlTakeover');
    if (!takeover) return;
    this.lastSetpointW = null;
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
        this.releaseFailTm = Date.now();
        this.error(`[Bat Control] Giving control back failed (${reason}):`, err.message || err);
        return;
      }
    }
    this.releaseFailTm = null;
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
    // Also on failure: the next try comes with the keepalive, not every tick.
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
    // toward the end of this one. Below the reserve the plan starts at the reserve (roiBattery()).
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
    this.log(`[ROI Plan] Plan again (${reason})`);
    await this.flows.triggerNewRoiStrategyFlow();
    await this.updateChargeChart();
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
          await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        }
      }

      // 2. SoC history: measure_battery (or soc)
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
          await this.setStoreValue('socHistory', this.socHistory).catch(this.error);
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

  // The batteries planned as one with this one (sorted by id, the first plans), or null.
  planGroup() {
    if (!this.inGroup()) return null;
    const group = this.driver.groupDevices().sort((a, b) => (a.getData().id < b.getData().id ? -1 : 1));
    return group.length > 1 && group.includes(this) ? group : null;
  }

  // The reserve (%): kept always, recharged as soon as possible; only peak shaving may use it.
  reservePct() {
    return Math.min(90, Math.max(0, Number(this.getSettings().peakReservePct) || 0));
  }

  // A plan SoC (%) back to the battery's: the planner only sees the part above the reserve.
  planSocToReal(socPct) {
    const r = this.reservePct();
    return r ? Math.round(r + ((socPct * (100 - r)) / 100)) : socPct;
  }

  // A battery for RoiStrategy: its SoC, capacity, and charge/discharge speeds with efficiency.
  roiBattery() {
    const settings = this.getSettings();
    const speeds = (list) => list
      .map(([power, loss]) => ({ power: Number(settings[power]) || 0, eff: 1 - (settings[loss] / 100) }))
      .filter((speed) => speed.power);
    // The planner works above the reserve: that part of the capacity, the SoC within it.
    const r = this.reservePct();
    const soc = Number(this.soc) || 0;
    return {
      soc: r ? (Math.max(0, soc - r) * 100) / (100 - r) : this.soc,
      batCapacity: settings.batCapacity * (1 - (r / 100)),
      chargeSpeeds: speeds([['chargePower', 'chargeLoss'], ['chargePowerEff', 'chargeLossEff'], ['chargePower3', 'chargeLoss3']]),
      dischargeSpeeds: speeds([['dischargePower', 'dischargeLoss'], ['dischargePowerEff', 'dischargeLossEff'], ['dischargePower3', 'dischargeLoss3']]),
    };
  }

  // Input for RoiStrategy: getStrategy() for this battery, or with a group getGroupStrategy() with
  // each battery of the group as it is.
  buildRoiOptions(minPriceDelta, group = null) {
    const members = group || [this];
    const now = Date.now();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const planMin = this.planIntervalMin();
    const { prices, exportPrices } = this.pricesFromNow(now);
    const planPrices = this.toPlanSlots(prices, now);
    const forecast = this.roiNetForecast(TimeHelpers.startOfLocalBlock(now, planMin, tz), planPrices.length, planMin, members);
    return {
      prices: [...planPrices],
      exportPrices: exportPrices ? [...this.toPlanSlots(exportPrices, now)] : null,
      minPriceDelta,
      wearCost: this.wearCostFor(members),
      ...(group ? { batteries: members.map((d) => d.roiBattery()) } : this.roiBattery()),
      // Local minute: slots follow local time (half-hour-offset zones differ from UTC).
      startMinute: TimeHelpers.toLocalDate(new Date(now), tz).getMinutes(),
      priceInterval: planMin,
      homePowerUsage: this.getSettings().roiHomePowerUsage ?? 300,
      net: forecast ? forecast.net : null,
      peakWindowMin: forecast ? forecast.peakWindowMin : 15,
      ...BatteryControl.planOptionsFor(this.getBatteryMode()),
    };
  }

  // Wear per kWh cycled; a group: weighted by capacity.
  wearCostFor(members) {
    const cap = (d) => Number(d.getSettings().batCapacity) || 0;
    const total = members.reduce((a, d) => a + cap(d), 0);
    if (!(total > 0)) return 0;
    return members.reduce((a, d) => a + (cap(d) * (Number(d.getSettings().roiWearCost) || 0)), 0) / total;
  }

  // The home's net per plan slot from the grid forecast, for the planner: without batteries, plus
  // the plans of the batteries before this one (device id), so they do not plan on the same
  // surplus. Never the grid's netPlanned (it holds this battery's own plan). members: the batteries
  // planned as one (a group). null without a grid.
  roiNetForecast(startMs, n, planMin, members = [this]) {
    let grid = null;
    try {
      grid = this.homey.drivers.getDriver('grid').getDevices().find((d) => typeof d.getNetForecast === 'function');
    } catch {
      return null;
    }
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
    // A group: one battery can run alone (NomXomStrategy), so the lowest threshold counts.
    const minChargeW = Math.min(...members.map((d) => Number(d.getSettings().minChargeW) || 0));
    const minDischargeW = Math.min(...members.map((d) => Number(d.getSettings().minDischargeW) || 0));
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
        slot.penaltyPerKw = hardW < tariffW ? null : (first.penaltyPerKw ?? first.stepJump ?? null);
      }
      net.push(slot);
    }
    return { net, peakWindowMin: (peak && peak.windowMin) || 15 };
  }

  async updateValue(val, cap) {
    await super.updateValue(val, cap);
    if (cap !== 'soc') return;
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
    const capacityKwh = this.getSettings().batCapacity;
    const maxW = this.maxPowerW();
    let state = BatteryEfficiency.createState();
    let samples = 0;
    for (const [t, kwh] of stored) {
      if (charged.has(t) && discharged.has(t)) {
        const res = BatteryEfficiency.onSoc(state, {
          // 5-minute means blur the SoC: samples of at least 3 %, and a quarter of a live sample's weight.
          now: Date.parse(t), soc: (kwh / capacityKwh) * 100, inKwh: charged.get(t), outKwh: discharged.get(t), capacityKwh, maxW, minSocStep: 3, weight: 0.25,
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
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
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

  // A new plan slot inside a price slot: plan again (a price-slot start gets new prices anyway,
  // and onPricesUpdated() plans then).
  async onPlanSlot(slotStartMs) {
    if (!this.pricesNextHours) return;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    if (TimeHelpers.startOfLocalBlock(slotStartMs, this.priceInterval || 60, tz) === slotStartMs) return;
    await this.flows.triggerNewRoiStrategyFlow();
    await this.updateChargeChart();
  }

  async updateChargeChart() {
    if (!this.pricesNextHours) return;
    await this.refreshDapPrices().catch(() => {});
    const minPriceDelta = this.getSettings().roiMinProfit;
    // Reuse a plan from the same price slot and minPriceDelta (a flow trigger usually computed it
    // seconds ago), if made after the latest price update and the last (re)init.
    const slotMs = this.planIntervalMin() * 60 * 1000;
    // Price slots follow local time: bucket on local (offset-shifted) timestamps, not UTC epoch.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const localSlot = (ms) => Math.floor(TimeHelpers.toLocalDate(new Date(ms), tz).getTime() / slotMs);
    const sameSlot = this.lastStratTm && localSlot(this.lastStratTm) === localSlot(Date.now());
    const afterPrices = this.lastStratTm && this.lastStratTm >= (this.pricesUpdatedTm || 0);
    const strategy = (sameSlot && afterPrices && this.lastStratMinPriceDelta === minPriceDelta && this.lastStratTokens)
      ? { ...this.lastStratTokens }
      : await this.flows.find_roi_strategy({ minPriceDelta }).catch((err) => this.error(err));
    if (!strategy) return;

    await this.setCapability('roi_duration', strategy.duration).catch((err) => this.error(err));

    const scheme = JSON.parse(strategy.scheme);
    const isForecast = this.toPlanSlots(this.pricesFromNow().isForecast);
    Object.keys(scheme).forEach((k) => {
      if (isForecast && isForecast[k]) scheme[k].isForecast = true;
    });

    await this.renderChargeCharts({
      scheme,
      chargePower: this.getSettings().chargePower || 2200,
      dischargePower: this.getSettings().dischargePower || 1700,
      socFallback: typeof this.soc === 'number' ? this.soc : null,
      planTm: this.lastStratTm || Date.now(),
      showPower: !!this.getSettings().chartShowPower,
      showSoc: this.getSettings().chartShowSoc !== false,
      showExportPrice: this.getSettings().chartShowExportPrice !== false,
      showLegend: this.getSettings().chartShowLegend !== false,
    });
  }

  triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower) {
    if (!this.flows) return Promise.resolve(false);
    return this.flows.triggerXomFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
  }
}

Object.assign(BatDevice.prototype, ChargeDeviceHelpers);

module.exports = BatDevice;
