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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');
const PowerFlows = require('../../lib/flows/PowerFlows');
const ApplianceModel = require('../../lib/strategies/ApplianceModel');
const { getApplianceChart } = require('../../lib/charts/ApplianceChart');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const ChartImages = require('../../lib/helpers/ChartImages');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const EvPlanner = require('../../lib/strategies/EvPlanner');

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_kwh_this_hour',
    last_hour: 'meter_kwh_last_hour',
    this_day: 'meter_kwh_this_day',
    last_day: 'meter_kwh_last_day',
    this_month: 'meter_kwh_this_month',
    last_month: 'meter_kwh_last_month',
    this_year: 'meter_kwh_this_year',
    last_year: 'meter_kwh_last_year',
    meter_source: 'meter_power',
    measure_source: 'measure_watt_avg',
    minMaxPrefix: 'measure_watt',
  },
};
// p1 consumption counter (low/all tariff).
// p2 consumption counter (high tariff).
// n1 returned counter (low/all tariff).
// n2 returned counter (high tariff).
// total energy counter = p1+p2-n1-n2

const APPLIANCE_SAMPLE_MS = 60 * 1000;
const APPLIANCE_SAVE_MS = 15 * 60 * 1000;
const RECENT_MS = 3 * 60 * 60 * 1000; // meter samples kept for getAvgPower()
const SLOT_HISTORY = 200; // measured 15-minute slots kept for the charts (> 2 days)
const { SLOT_MS } = ApplianceModel;
// "Ready by" picker hours (appliance_ready_by), as the EV departure pickers.
const READY_BY_HOURS = [3, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22];

class PowerDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    this.flows = new PowerFlows(this);
    // With forecast (setting forecast_appliance): learned apart from the home load and planned
    // like an EV charge, see lib/strategies/ApplianceModel.js. Its charts are registered before
    // super.onInit(), like the other drivers' charts (lib/helpers/ChartImages.js).
    const settings = this.getSettings();
    this.isAppliance = !!settings.forecast_appliance && settings.source_device_type === 'Homey device';
    if (this.isAppliance) await ChartImages.registerChartImages(this, this.driver.ds.chartImages);
    await super.onInit().catch(this.error);
    await this.initAppliance().catch(this.error);
  }

  // --- Learning ---

  async initAppliance() {
    this.stopAppliance();
    if (!this.isAppliance || this.isDestroyed) {
      this.applianceModel = null;
      this.appliancePlan = null;
      await this.checkApplianceReady();
      return;
    }
    this.applianceModel = (await this.getStoreValue('applianceModel')) || ApplianceModel.initModel();
    this.appliancePlan = (await this.getStoreValue('appliancePlan')) || null;
    this.applianceSlots = (await this.getStoreValue('applianceSlots')) || [];
    this.recentMeter = [];
    this.applianceSaveTm = Date.now();
    if (!this.applianceListeners) {
      this.applianceListeners = true;
      this.registerCapabilityListener('appliance_ready_by', async (value) => {
        await this.setReadyBy(value === 'off' ? null : value);
      });
    }
    this.applianceTimer = this.homey.setInterval(() => {
      this.sampleAppliance().catch(this.error);
    }, APPLIANCE_SAMPLE_MS);
    await this.refreshDapPrices().catch(this.error);
    await this.updateApplianceDisplay();
    await this.updateAppliancePlanDisplay();
  }

  stopAppliance() {
    if (this.applianceTimer) {
      this.homey.clearInterval(this.applianceTimer);
      this.applianceTimer = null;
    }
  }

  async saveAppliance() {
    if (!this.applianceModel) return;
    this.applianceSaveTm = Date.now();
    await this.setStoreValue('applianceModel', this.applianceModel).catch(this.error);
    await this.setStoreValue('applianceSlots', this.applianceSlots).catch(this.error);
  }

  // Measured energy per 15-minute slot, for the charts.
  recordApplianceSlot(t, meterKwh) {
    const last = this.lastSlotMeter;
    this.lastSlotMeter = { t, meter: meterKwh };
    if (!last || meterKwh < last.meter || t - last.t > 10 * APPLIANCE_SAMPLE_MS) return false;
    const slot = Math.floor(last.t / SLOT_MS) * SLOT_MS;
    const entry = this.applianceSlots[this.applianceSlots.length - 1];
    if (entry && entry.t === slot) entry.kwh += meterKwh - last.meter;
    else this.applianceSlots.push({ t: slot, kwh: meterKwh - last.meter });
    if (this.applianceSlots.length > SLOT_HISTORY) this.applianceSlots.shift();
    return !entry || entry.t !== slot; // a new slot
  }

  async sampleAppliance() {
    if (!this.applianceModel || this.isDestroyed || !this.initReady) return;
    const t = Date.now();
    const powerW = this.getCapabilityValue('measure_watt_avg');
    const meterKwh = this.getCapabilityValue('meter_power');
    if (typeof powerW !== 'number' || typeof meterKwh !== 'number') return;
    this.recentMeter.push({ t, meter: meterKwh });
    while (this.recentMeter.length && this.recentMeter[0].t < t - RECENT_MS) this.recentMeter.shift();
    const newSlot = this.recordApplianceSlot(t, meterKwh);

    const { model, event, run } = ApplianceModel.processSample(this.applianceModel, {
      t, powerW, meterKwh, timezone: this.timeZone,
    });
    this.applianceModel = model;
    if (event === 'started') await this.onApplianceStarted(t);
    if (event === 'finished') await this.onApplianceFinished(run);
    await this.checkPlannedStart(t);
    if (event || t - this.applianceSaveTm >= APPLIANCE_SAVE_MS) await this.saveAppliance();
    if (event) this.notifyGrid();
    if (event === 'finished' || this.applianceModel.day !== this.applianceReadyDay) {
      this.applianceReadyDay = this.applianceModel.day;
      await this.checkApplianceReady();
    }
    if (event || newSlot) await this.updateAppliancePlanDisplay();
  }

  isApplianceReady() {
    return ApplianceModel.isReady(this.applianceModel, this.getApplianceProfile());
  }

  // Ready or no longer an appliance: the grid relearns its home load from Insights, with or
  // without this appliance. Else the learned load keeps (or misses) it for weeks.
  async checkApplianceReady() {
    const ready = this.isApplianceReady();
    if (!!(await this.getStoreValue('applianceReady')) === ready) return;
    await this.setStoreValue('applianceReady', ready).catch(this.error);
    this.log(`Appliance ${ready ? 'ready: added to' : 'removed from'} the grid forecast`);
    this.retrainGrid();
  }

  retrainGrid() {
    try {
      this.homey.drivers.getDriver('grid').getDevices().forEach((dev) => {
        if (typeof dev.retrainLoadModel === 'function') dev.retrainLoadModel(true).catch(this.error);
      });
    } catch {
      // no grid device
    }
  }

  getApplianceProfile() {
    const runs = this.applianceModel ? this.applianceModel.runs : [];
    const last = runs[runs.length - 1];
    const key = `${runs.length}|${last ? last.start : ''}`;
    if (!this.applianceProfileCache || this.applianceProfileCache.key !== key) {
      this.applianceProfileCache = { key, profile: ApplianceModel.getProfile(this.applianceModel) };
    }
    return this.applianceProfileCache.profile;
  }

  hhmm(ms) {
    const local = TimeHelpers.toLocalDate(new Date(ms), this.timeZone);
    return `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  }

  // 'Tue 02:15'
  dayHhmm(ms) {
    const lang = this.homey.i18n.getLanguage() || 'en';
    return `${new Date(ms).toLocaleDateString(lang, { weekday: 'short', timeZone: this.timeZone })} ${this.hhmm(ms)}`;
  }

  async onApplianceStarted(t) {
    const profile = this.getApplianceProfile();
    const runStart = this.applianceModel.run ? this.applianceModel.run.start : t;
    this.log(`Appliance program started at ${this.hhmm(runStart)}`);
    // The planned run has started (also when started earlier by hand).
    if (this.appliancePlan) await this.setAppliancePlan(null);
    const tokens = profile
      ? { expected_end: this.hhmm(runStart + profile.durationMin * 60000), expected_kwh: profile.kwh, duration: profile.durationMin }
      : { expected_end: '', expected_kwh: 0, duration: 0 };
    if (this.homey.app.trigger_appliance_started) await this.homey.app.trigger_appliance_started(this, tokens, {});
  }

  async onApplianceFinished(run) {
    const kwh = Math.round(run.kwh.reduce((a, v) => a + v, 0) * 1000) / 1000;
    const duration = Math.round((run.end - run.start) / 60000);
    this.log(`Appliance program finished: ${kwh} kWh, ${duration} min`);
    await this.updateApplianceDisplay();
    if (this.homey.app.trigger_appliance_finished) await this.homey.app.trigger_appliance_finished(this, { kwh, duration }, {});
  }

  // Program chart and the status in the settings.
  async updateApplianceDisplay() {
    const profile = this.getApplianceProfile();
    const { runs } = this.applianceModel;
    const text = profile
      ? this.homey.__('appliance_status', {
        runs: profile.runs,
        kwh: profile.kwh,
        duration: profile.durationMin,
        starts: ApplianceModel.startsPerWeek(this.applianceModel).toFixed(1),
      })
      : this.homey.__('appliance_status_learning', { runs: runs.length, min: ApplianceModel.MIN_RUNS });
    if (this.getSettings().appliance_status !== text) await this.setSettings({ appliance_status: text }).catch(this.error);
    const chart = getApplianceChart(profile, runs[runs.length - 1]);
    if (chart && this.applianceImage) {
      this.chartAppliance = chart;
      await this.applianceImage.update().catch(this.error);
    }
  }

  // The grid forecast includes this appliance: rebuild it after a start, end or new plan.
  notifyGrid() {
    let grid;
    try {
      grid = this.homey.drivers.getDriver('grid').getDevices();
    } catch {
      return;
    }
    grid.forEach((dev) => {
      if (typeof dev.onChargePlanUpdated === 'function') dev.onChargePlanUpdated();
    });
  }

  // Expected power (W) per 15-minute slot from startMs to endMs, for the grid forecast.
  getForecastSeries(startMs, endMs) {
    if (!this.isApplianceReady()) return null;
    return ApplianceModel.getForecastSeries(
      this.applianceModel,
      this.getApplianceProfile(),
      startMs,
      endMs,
      Date.now(),
      this.timeZone,
      this.appliancePlan && this.appliancePlan.startMs ? this.appliancePlan : null,
    );
  }

  // Measured average power (W) from startMs to endMs, or null without samples covering it: the
  // grid learns the home load without this appliance.
  getAvgPower(startMs, endMs) {
    const samples = this.recentMeter || [];
    if (!this.applianceModel || samples.length < 2 || !(endMs > startMs)) return null;
    const meterAt = (ms) => {
      if (ms < samples[0].t - APPLIANCE_SAMPLE_MS || ms > samples[samples.length - 1].t + 2 * APPLIANCE_SAMPLE_MS) return null;
      let i = samples.findIndex((s) => s.t >= ms);
      if (i === -1) return samples[samples.length - 1].meter;
      if (i === 0) return samples[0].meter;
      const a = samples[i - 1];
      const b = samples[i];
      i = (ms - a.t) / (b.t - a.t);
      return a.meter + (b.meter - a.meter) * i;
    };
    const from = meterAt(startMs);
    const to = meterAt(endMs);
    if (from === null || to === null) return null;
    return Math.max(0, ((to - from) * 3600000000) / (endMs - startMs));
  }

  // --- Plan: a run ready by a time, at the cheapest start (like the EV departure) ---

  // Price entry of the tariff group's DAP devices for ms (today, coming days, yesterday) or null.
  priceEntryAt(ms) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;
    return this._findPriceEntryForSlot(this.dapPrices, ms, intervalMs)
      || this._findPriceEntryForSlot(this.dapPriceHistory, ms, intervalMs);
  }

  priceAt(ms) {
    const entry = this.priceEntryAt(ms);
    if (!entry) return null;
    if (typeof entry.muPrice === 'number') return entry.muPrice;
    return typeof entry.price === 'number' ? entry.price : null;
  }

  // Ready by 'HH:MM': the next time it is that time.
  nextLocalTime(hhmm) {
    const now = Date.now();
    const today = TimeHelpers.getLocalMidnightUTC(new Date(now), this.timeZone);
    let at = TimeHelpers.localTimeToUTC(today, hhmm, this.timeZone).getTime();
    if (at <= now) {
      const tomorrow = TimeHelpers.getLocalMidnightUTC(new Date(today.getTime() + 26 * 60 * 60 * 1000), this.timeZone);
      at = TimeHelpers.localTimeToUTC(tomorrow, hhmm, this.timeZone).getTime();
    }
    return at;
  }

  // Picker / flow: a run ready by hhmm ('HH:MM'), or null for no plan.
  async setReadyBy(hhmm) {
    if (!hhmm) return this.setAppliancePlan(null);
    if (!this.getApplianceProfile()) throw Error(this.homey.__('error_appliance_not_learned', { runs: ApplianceModel.MIN_RUNS }));
    return this.setAppliancePlan({ readyBy: this.nextLocalTime(hhmm), notified: false });
  }

  async setAppliancePlan(plan) {
    this.appliancePlan = plan;
    this.replanAppliance();
    if (plan) this.log(`Appliance planned: start ${this.dayHhmm(plan.startMs)}, ready by ${this.dayHhmm(plan.readyBy)}`);
    await this.setStoreValue('appliancePlan', this.appliancePlan).catch(this.error);
    await this.updateAppliancePlanDisplay();
    this.notifyGrid();
    return this.appliancePlan;
  }

  // The cheapest start so the learned program ends by readyBy; without prices the latest start.
  replanAppliance() {
    const plan = this.appliancePlan;
    const profile = this.getApplianceProfile();
    if (!plan || plan.notified || !profile) return;
    const nowMs = Date.now();
    const latestStartMs = plan.readyBy - ApplianceModel.runMs(profile);
    const best = ApplianceModel.bestStart(profile, { priceAt: (ms) => this.priceAt(ms), nowMs, latestStartMs });
    plan.startMs = best ? best.startMs : Math.max(nowMs, latestStartMs);
    plan.cost = best ? best.cost : null;
    plan.costNow = best ? best.costNow : null;
  }

  // The planned start: trigger the flow once; a plan whose ready time passed without a run ends.
  async checkPlannedStart(t) {
    const plan = this.appliancePlan;
    if (!plan) return;
    if (t > plan.readyBy) {
      await this.setAppliancePlan(null);
      return;
    }
    if (plan.notified || t < plan.startMs) return;
    plan.notified = true;
    await this.setStoreValue('appliancePlan', plan).catch(this.error);
    this.log('Appliance planned start reached');
    const tokens = { ready_by: this.hhmm(plan.readyBy), cost: plan.cost === null ? 0 : Math.round(plan.cost * 10000) / 10000 };
    if (this.homey.app.trigger_appliance_planned_start) await this.homey.app.trigger_appliance_planned_start(this, tokens, {});
    await this.updateAppliancePlanDisplay();
  }

  // New prices: a plan not started yet moves to the cheapest start again.
  async updateTariffHistory(...args) {
    await super.updateTariffHistory(...args);
    if (!this.applianceModel) return;
    await this.refreshDapPrices().catch(this.error);
    if (this.appliancePlan && !this.appliancePlan.notified) {
      const before = this.appliancePlan.startMs;
      this.replanAppliance();
      if (this.appliancePlan.startMs !== before) {
        await this.setStoreValue('appliancePlan', this.appliancePlan).catch(this.error);
        this.notifyGrid();
      }
    }
    await this.updateAppliancePlanDisplay();
  }

  // Flow: plan a run ready by a time; tokens of the plan.
  async planAppliance(time) {
    const hhmm = EvPlanner.parseTime(time);
    if (!hhmm) throw Error(this.homey.__('error_invalid_time', { time }));
    const plan = await this.setReadyBy(hhmm);
    const round = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : 0);
    return {
      start_time: this.hhmm(plan.startMs),
      wait: Math.max(0, Math.round((plan.startMs - Date.now()) / 60000)),
      cost: round(plan.cost),
      saving: plan.cost !== null && plan.costNow !== null ? round(plan.costNow - plan.cost) : 0,
    };
  }

  // The run on the charts: running, or planned. { start } or null.
  plannedRunStart() {
    if (this.applianceModel && this.applianceModel.run) return this.applianceModel.run.start;
    return this.appliancePlan && this.appliancePlan.startMs ? this.appliancePlan.startMs : null;
  }

  // Tile: state, next run and the "ready by" picker; then the charts.
  async updateAppliancePlanDisplay() {
    if (!this.applianceModel) return;
    const profile = this.getApplianceProfile();
    const { run, runs } = this.applianceModel;
    const plan = this.appliancePlan;
    const runMs = profile ? profile.durationMin * 60000 : 0;
    const now = Date.now();

    let state;
    if (run) {
      state = profile
        ? this.homey.__('appliance_state_running_end', { end: this.hhmm(run.start + runMs) })
        : this.homey.__('appliance_state_running');
    } else if (!this.isApplianceReady() && !profile) {
      state = this.homey.__('appliance_status_learning', { runs: runs.length, min: ApplianceModel.MIN_RUNS });
    } else {
      state = this.homey.__('appliance_state_idle');
    }

    let next = '-';
    if (run) {
      next = profile ? `${this.homey.__('ev_now')}–${this.hhmm(run.start + runMs)}` : this.homey.__('ev_now');
    } else if (plan && plan.startMs && profile) {
      const start = plan.startMs <= now ? this.homey.__('ev_now') : this.dayHhmm(plan.startMs);
      next = `${start}–${this.hhmm(Math.max(plan.startMs, now) + runMs)}`;
    } else if (this.isApplianceReady()) {
      const expected = ApplianceModel.nextExpectedStart(this.applianceModel, profile, now, this.timeZone);
      if (expected) next = `~${this.dayHhmm(expected)}`;
    }

    let picker = 'off';
    if (plan) {
      const local = TimeHelpers.toLocalDate(new Date(plan.readyBy), this.timeZone);
      const fh = local.getHours() + local.getMinutes() / 60;
      const hour = READY_BY_HOURS.reduce((best, h) => (Math.abs(h - fh) < Math.abs(best - fh) ? h : best));
      picker = `${String(hour).padStart(2, '0')}:00`;
    }

    if (this.hasCapability('appliance_state')) await this.setCapability('appliance_state', state).catch(this.error);
    if (this.hasCapability('appliance_next_run')) await this.setCapability('appliance_next_run', next).catch(this.error);
    if (this.hasCapability('appliance_ready_by')) await this.setCapability('appliance_ready_by', picker).catch(this.error);
    await this.renderAppliancePlanCharts().catch(this.error);
  }

  // Today, tomorrow and next hours, like the EV charger: prices, the planned run (bars) and the
  // measured power (line), per 15 minutes.
  async renderAppliancePlanCharts() {
    const profile = this.getApplianceProfile();
    const periods = TimeHelpers.getUTCPeriods(this.timeZone);
    const now = Date.now();
    const runStart = this.plannedRunStart();
    const measured = new Map((this.applianceSlots || []).map((e) => [e.t, Math.round(e.kwh * 4000)]));
    const currency = this.getSettings().currency || '€';
    const translations = { price: this.homey.__('price'), power: this.homey.__('power'), soc: this.homey.__('soc') };
    const maxW = profile ? Math.max(...profile.curveW) : 2000;

    const render = async (startMs, endMs, isToday, image, chartProp) => {
      if (!image) return;
      const scheme = {};
      const count = Math.round((endMs - startMs) / SLOT_MS);
      for (let i = 0; i < count; i += 1) {
        const t = startMs + i * SLOT_MS;
        const entry = this.priceEntryAt(t);
        const price = this.priceAt(t);
        const idx = runStart === null || !profile ? -1 : Math.floor((t - runStart) / SLOT_MS);
        const power = idx >= 0 && idx < profile.curveW.length ? profile.curveW[idx] : 0;
        const isFuture = t + SLOT_MS > now;
        scheme[i] = {
          price,
          power,
          duration: power > 0 ? 15 : 0,
          actualPower: t <= now ? (measured.get(t) || 0) : null,
          soc: null,
          isForecast: price === null || !!(entry && entry.isForecast),
          isFuture,
        };
      }
      this[chartProp] = await getChargeChart({ scheme: JSON.stringify(scheme) }, startMs, count, maxW, 0, 15, [], currency,
        translations, isToday, this.timeZone, true, false, false);
      await image.update().catch(this.error);
    };

    const todayStart = periods.todayStart.getTime();
    const tomorrowStart = periods.tomorrowStart.getTime();
    await render(todayStart, tomorrowStart, true, this.applianceTodayImage, 'chartApplianceToday');
    await render(tomorrowStart, periods.tomorrowEnd.getTime(), false, this.applianceTomorrowImage, 'chartApplianceTomorrow');
    // Next hours: to the end of the known prices, at least 12 hours.
    const slotStart = Math.floor(now / SLOT_MS) * SLOT_MS;
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;
    const pricesEnd = (this.dapPrices || []).reduce((end, p) => Math.max(end, new Date(p.time).getTime() + intervalMs), 0);
    const nextEnd = Math.min(slotStart + 48 * 3600000, Math.max(slotStart + 12 * 3600000, pricesEnd));
    await render(slotStart, nextEnd, true, this.applianceNextHoursImage, 'chartApplianceNextHours');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('forecast_appliance')) {
      if (newSettings.forecast_appliance) this.driver.checkApplianceSource(newSettings);
      this.migrated = false; // adds or removes the appliance capabilities after the restart
    }
    return super.onSettings({ oldSettings, newSettings, changedKeys });
  }

  // A deleted ready appliance is missing from the learned home load: relearn it.
  onDeleted() {
    const wasReady = this.isApplianceReady();
    this.applianceModel = null;
    super.onDeleted();
    if (wasReady) this.retrainGrid();
  }

  async flushStore() {
    await super.flushStore();
    await this.saveAppliance();
  }

  stopPolling() {
    super.stopPolling();
    if (this.applianceTimer) this.saveAppliance().catch(this.error); // before a restart reloads it
    this.stopAppliance();
  }

}

// Prices of the tariff group's DAP devices, shared with the battery and EV charger.
const {
  _dapDriverOrder, _groupDapDevices, _groupDapDeviceIds, _findGroupPriceLog, refreshDapPrices,
  _fetchInsightsPriceHistory, _fetchDapPriceHistoryFromInsights, _findPriceEntryForSlot,
} = ChargeDeviceHelpers;
Object.assign(PowerDevice.prototype, {
  _dapDriverOrder,
  _groupDapDevices,
  _groupDapDeviceIds,
  _findGroupPriceLog,
  refreshDapPrices,
  _fetchInsightsPriceHistory,
  _fetchDapPriceHistoryFromInsights,
  _findPriceEntryForSlot,
});

module.exports = PowerDevice;
