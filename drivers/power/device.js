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
const { getApplianceWeeklyChart, getApplianceProgramChart } = require('../../lib/charts/ApplianceChart');
const { getChargeChart } = require('../../lib/charts/ChargeChart');
const ChartImages = require('../../lib/helpers/ChartImages');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const EvHistory = require('../../lib/helpers/EvHistory');
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
const PLANNED_START_MS = 30 * 60 * 1000; // a run this close to the planned start is the planned run

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
      if (!this.isDestroyed && this.getSettings().appliance_status !== '-') await this.setSettings({ appliance_status: '-' }).catch(this.error);
      return;
    }
    this.applianceModel = (await this.getStoreValue('applianceModel')) || ApplianceModel.initModel();
    this.appliancePlan = (await this.getStoreValue('appliancePlan')) || null;
    for (const key of ['applianceReadyBy', 'applianceAdvice']) {
      if (this.getStoreKeys().includes(key)) await this.unsetStoreValue(key).catch(this.error);
    }
    this.applianceSlots = (await this.getStoreValue('applianceSlots')) || [];
    if (this.migrateApplianceDeadlines()) {
      await this.saveAppliance();
      await this.setStoreValue('appliancePlan', this.appliancePlan).catch(this.error);
    }
    if (this.applianceModel.bootstrapped !== ApplianceModel.BOOTSTRAP_VERSION) await this.bootstrapAppliance().catch(this.error);
    this.recentMeter = [];
    this.applianceSaveTm = Date.now();
    if (!this.applianceListeners) {
      this.applianceListeners = true;
      this.registerCapabilityListener('button.retrain', async () => {
        this.log('Appliance retrain via button.retrain');
        await this.bootstrapAppliance();
        await this.checkApplianceReady();
        await this.updateApplianceDisplay();
        await this.updateAppliancePlanDisplay();
        this.notifyGrid();
      });
      for (const day of ['today', 'tomorrow']) {
        this.registerCapabilityListener(`appliance_${day}`, async (value) => {
          // Refused (a time already past): the picker shows the day's setting again.
          await this.setApplianceDay(day, value).catch((err) => {
            this.updateAppliancePlanDisplay().catch(this.error);
            throw err;
          });
        });
      }
    }
    this.applianceTimer = this.homey.setInterval(() => {
      this.sampleAppliance().catch(this.error);
    }, APPLIANCE_SAMPLE_MS);
    await this.refreshDapPrices().catch(this.error);
    await this.updateApplianceDisplay();
    await this.updateAppliancePlanDisplay();
  }

  // First time, and on the retrain button: learn the runs and start times of the last 14 days from
  // the source device's Insights (hourly, the last 24 hours per 5 minutes), like the EV charger
  // learns its history. Runs measured live before that history are kept.
  async bootstrapAppliance() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      // not ready
    }
    if (!api) return; // tried again at the next start
    const allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
    const endDate = new Date();
    const entries = await EvHistory.fetchPowerLog({
      api,
      logs: Array.isArray(allLogs) ? allLogs : Object.values(allLogs),
      deviceId: this.getSettings().homey_device_id,
      capNames: ['energy_power', 'meter_power'],
      startDate: new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000),
      endDate,
      coarseResolutions: ['last14Days'],
    }) || [];
    const model = ApplianceModel.learnHistory(ApplianceModel.initModel(), entries, {
      timezone: this.timeZone,
      meterNowKwh: this.getCapabilityValue('meter_power') || 0,
      planned: ((this.applianceModel && this.applianceModel.runs) || []).filter((r) => r.deadline),
    });
    model.bootstrapped = ApplianceModel.BOOTSTRAP_VERSION;
    model.runs = ApplianceModel.mergeRuns(model.runs, this.applianceModel && this.applianceModel.runs);
    this.applianceModel = model;
    await this.saveAppliance();
    this.log(`Appliance learned from history: ${entries.length} entries, ${model.runs.length} runs`);
  }

  // Planned runs and the plan had a ready-by time; now the latest start (deadline).
  migrateApplianceDeadlines() {
    const items = [...this.applianceModel.runs, this.applianceModel.run, this.appliancePlan].filter((x) => x && x.readyBy);
    items.forEach((x) => {
      x.deadline = x.readyBy;
      delete x.readyBy;
    });
    return items.length > 0;
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
    await this.setStoreValue('applianceSlots', this.applianceSlots || []).catch(this.error);
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

    // A start at the planned start (by the flow of "Planned start") is a planned run.
    const plan = this.appliancePlan;
    const profile = this.getApplianceProfile();
    const deadlineFor = (start) => (plan && plan.startMs && Math.abs(start - plan.startMs) <= PLANNED_START_MS ? plan.deadline : null);
    const skipToday = !!this.applianceDays()[ApplianceModel.localDay(t, this.timeZone).date];
    const { model, event, run } = ApplianceModel.processSample(this.applianceModel, {
      t, powerW, meterKwh, timezone: this.timeZone, deadlineFor, fullMin: profile ? profile.fullMin : null, skipToday,
    });
    this.applianceModel = model;
    if (event === 'started') await this.onApplianceStarted(t);
    if (event === 'finished') await this.onApplianceFinished(run);
    await this.checkPlannedStart(t);
    await this.checkDayPlans(t);
    await this.checkExpectedStart(t);
    await this.checkStartTriggers(t);
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
    const planned = this.applianceModel.run && this.applianceModel.run.deadline;
    this.log(`Appliance program started at ${this.hhmm(runStart)}${planned ? `, planned, start by ${this.hhmm(planned)}` : ''}`);
    // The planned run has started (also when started earlier by hand).
    if (this.appliancePlan) await this.setAppliancePlan(null);
    const { date } = ApplianceModel.localDay(runStart, this.timeZone);
    const day = this.applianceDays()[date];
    if (day && !day.done && day.value !== 'unused') await this.saveApplianceDay(date, { ...day, done: true });
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

  // Weekly chart and the status in the settings.
  async updateApplianceDisplay() {
    const profile = this.getApplianceProfile();
    const { runs } = this.applianceModel;
    const text = profile
      ? this.homey.__('appliance_status', {
        runs: profile.runs,
        kwh: profile.kwh,
        duration: profile.durationMin,
        peak: profile.peakW,
        starts: ApplianceModel.startsPerWeek(this.applianceModel).toFixed(1),
      })
      : this.homey.__('appliance_status_learning', { runs: runs.length, min: ApplianceModel.MIN_RUNS });
    if (this.getSettings().appliance_status !== text) await this.setSettings({ appliance_status: text }).catch(this.error);
    const lang = this.homey.i18n.getLanguage() || 'en';
    const dayNames = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(Date.UTC(2026, 8, 28 + i, 12))
      .toLocaleDateString(lang, { weekday: 'short', timeZone: 'UTC' })); // Monday first
    const chart = getApplianceWeeklyChart(ApplianceModel.getWeekly(this.applianceModel, this.timeZone), {
      dayNames,
      labels: {
        learned: this.homey.__('appliance_chart_learned'),
        assumed: this.homey.__('ev_chart_assumed'),
        axis: this.homey.__('appliance_chart_runs'),
      },
    });
    if (chart && this.applianceWeeklyImage) {
      this.chartApplianceWeekly = chart;
      await this.applianceWeeklyImage.update().catch(this.error);
    }
    // The typical run and last run only from runs measured per minute (or 5 minutes).
    const program = getApplianceProgramChart(profile, runs.filter((r) => !r.coarse).pop() || null, {
      typical: this.homey.__('appliance_chart_typical'),
      estimate: this.homey.__('appliance_chart_estimate'),
      last: this.homey.__('appliance_chart_last'),
    });
    if (program && this.applianceProgramImage) {
      this.chartApplianceProgram = program;
      await this.applianceProgramImage.update().catch(this.error);
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
      (ms) => this.priceAt(ms),
      this.forecastDays(),
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
  // Memoized per minute and price list: the plan searches call it for the same times many times.
  priceEntryAt(ms) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;
    const minute = Math.floor(Date.now() / 60000);
    let memo = this.priceEntryMemo;
    if (!memo || memo.minute !== minute || memo.prices !== this.dapPrices
      || memo.history !== this.dapPriceHistory || memo.intervalMs !== intervalMs) {
      memo = {
        minute, prices: this.dapPrices, history: this.dapPriceHistory, intervalMs, entries: new Map(),
      };
      this.priceEntryMemo = memo;
    }
    if (memo.entries.has(ms)) return memo.entries.get(ms);
    const entry = this._findPriceEntryForSlot(this.dapPrices, ms, intervalMs)
      || this._findPriceEntryForSlot(this.dapPriceHistory, ms, intervalMs);
    memo.entries.set(ms, entry);
    return entry;
  }

  priceAt(ms) {
    const entry = this.priceEntryAt(ms);
    if (!entry) return null;
    if (typeof entry.muPrice === 'number') return entry.muPrice;
    return typeof entry.price === 'number' ? entry.price : null;
  }

  // 'HH:MM': the next time it is that time.
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

  // Flow: a run that starts by deadline (ms), once.
  async planStartBy(deadline) {
    if (!this.getApplianceProfile()) throw Error(this.homey.__('error_appliance_not_learned', { runs: ApplianceModel.MIN_RUNS }));
    return this.setAppliancePlan({ deadline, notified: false });
  }

  async setAppliancePlan(plan) {
    this.appliancePlan = plan;
    this.replanAppliance();
    if (plan) this.log(`Appliance planned: start ${this.dayHhmm(plan.startMs)}, start by ${this.dayHhmm(plan.deadline)}`);
    await this.setStoreValue('appliancePlan', this.appliancePlan).catch(this.error);
    await this.updateAppliancePlanDisplay();
    this.notifyGrid();
    return this.appliancePlan;
  }

  // The cheapest start from now to the deadline; without prices at the deadline.
  replanAppliance() {
    const plan = this.appliancePlan;
    const profile = this.getApplianceProfile();
    if (!plan || plan.notified || !profile) return;
    const nowMs = Date.now();
    const best = ApplianceModel.bestStart(profile, { priceAt: (ms) => this.priceAt(ms), nowMs, latestStartMs: plan.deadline });
    plan.startMs = best ? best.startMs : Math.max(nowMs, plan.deadline);
    plan.cost = best ? best.cost : null;
    plan.costNow = best ? best.costNow : null;
  }

  // The planned start: trigger the flow once; a plan without a run soon after its deadline ends.
  async checkPlannedStart(t) {
    const plan = this.appliancePlan;
    if (!plan) return;
    if (t > plan.deadline + PLANNED_START_MS) {
      await this.setAppliancePlan(null);
      return;
    }
    if (plan.notified || t < plan.startMs) return;
    plan.notified = true;
    await this.setStoreValue('appliancePlan', plan).catch(this.error);
    this.log('Appliance planned start reached');
    const { expected_end: expectedEnd, cost } = this.planTokens(plan);
    if (this.homey.app.trigger_appliance_planned_start) await this.homey.app.trigger_appliance_planned_start(this, { expected_end: expectedEnd, cost }, {});
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

  // Cheapest start cards (like the DAP price cards): checked once per 15-minute slot, at its
  // first sample; not while a program runs. A restart later in the slot does not trigger again.
  async checkStartTriggers(t) {
    const slot = Math.floor(t / SLOT_MS) * SLOT_MS;
    if (slot === this.startTriggerSlot || t - slot > 3 * APPLIANCE_SAMPLE_MS) return;
    this.startTriggerSlot = slot;
    const profile = this.getApplianceProfile();
    if (!profile || this.applianceModel.run) return;
    const cost = ApplianceModel.runCost(profile, (ms) => this.priceAt(ms), slot);
    const tokens = {
      expected_end: this.hhmm(t + ApplianceModel.runMs(profile)),
      cost: cost === null ? 0 : Math.round(cost * 10000) / 10000,
    };
    const { app } = this.homey;
    if (app.trigger_appliance_cheapest_start_before) await app.trigger_appliance_cheapest_start_before(this, tokens, {});
    if (app.trigger_appliance_cheapest_start_until) await app.trigger_appliance_cheapest_start_until(this, tokens, {});
    if (app.trigger_appliance_cheapest_start_next_hours) await app.trigger_appliance_cheapest_start_next_hours(this, tokens, {});
  }

  // Flow: this 15-minute slot is the cheapest start from fromMs to toMs (excl.).
  isCheapestStart(fromMs, toMs) {
    const profile = this.getApplianceProfile();
    if (!profile) throw Error(this.homey.__('error_appliance_not_learned', { runs: ApplianceModel.MIN_RUNS }));
    const slot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    if (!(slot >= fromMs && slot < toMs)) return false;
    const best = ApplianceModel.cheapestSlotStart(profile, { priceAt: (ms) => this.priceAt(ms), fromMs, toMs });
    return !!best && best.startMs === slot;
  }

  // Flow: starts in the period hours before time (07:45, or decimal hours 7.75); like the DAP card, today's
  // window, or tomorrow's when that time has passed.
  isCheapestStartBefore(period, time) {
    const hours = TimeHelpers.parseClock(time);
    if (hours === null) throw Error(this.homey.__('error_invalid_time', { time }));
    const minutes = Math.round(hours * 4) * 15;
    const slot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    const nextDay = (day) => TimeHelpers.getLocalMidnightUTC(new Date(day.getTime() + 26 * 3600000), this.timeZone);
    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const endOf = (day) => (minutes === 1440 ? nextDay(day).getTime() : TimeHelpers.localTimeToUTC(day, hhmm, this.timeZone).getTime());
    const today = TimeHelpers.getLocalMidnightUTC(new Date(slot), this.timeZone);
    let end = endOf(today);
    if (end <= slot) end = endOf(nextDay(today));
    return this.isCheapestStart(end - TimeHelpers.parseHours(period) * 3600000, end);
  }

  // Flow: starts from now to period hours ahead.
  isCheapestStartNextHours(period) {
    const slot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    return this.isCheapestStart(slot, slot + Number(period) * 3600000);
  }

  // --- Day pickers "Start today/tomorrow": per local date 'unused', 'cheapest' or 'HH:MM', once ---

  // { [date]: { value, done } } from today on; done: started, or its start passed.
  applianceDays() {
    const today = ApplianceModel.localDay(Date.now(), this.timeZone).date;
    const stored = this.getStoreValue('applianceDays') || {};
    const days = Object.fromEntries(Object.entries(stored).filter(([date]) => date >= today));
    if (Object.keys(days).length !== Object.keys(stored).length) this.setStoreValue('applianceDays', days).catch(this.error);
    return days;
  }

  async saveApplianceDay(date, entry) {
    const days = { ...this.applianceDays() };
    if (entry) days[date] = entry;
    else delete days[date];
    await this.setStoreValue('applianceDays', days).catch(this.error);
  }

  // Local midnight (ms) of a date 'YYYY-MM-DD' and of the day after.
  dayBounds(date) {
    const [y, m, d] = date.split('-').map(Number);
    const start = TimeHelpers.getLocalMidnightUTC(new Date(Date.UTC(y, m - 1, d, 12)), this.timeZone);
    const end = TimeHelpers.getLocalMidnightUTC(new Date(start.getTime() + 36 * 3600000), this.timeZone);
    return { start, end };
  }

  pickerDate(day) {
    const now = Date.now();
    if (day === 'today') return ApplianceModel.localDay(now, this.timeZone).date;
    const { end } = this.dayBounds(ApplianceModel.localDay(now, this.timeZone).date);
    return ApplianceModel.localDay(end.getTime(), this.timeZone).date;
  }

  async setApplianceDay(day, value) {
    const date = this.pickerDate(day);
    if (/^\d\d:\d\d$/.test(value)
      && TimeHelpers.localTimeToUTC(this.dayBounds(date).start, value, this.timeZone).getTime() <= Date.now()) {
      throw Error(this.homey.__('error_appliance_start_past', { time: value }));
    }
    this.log(`Appliance ${day} (${date}) set to ${value}`);
    await this.saveApplianceDay(date, value === 'auto' ? null : { value, done: false });
    await this.updateAppliancePlanDisplay();
    this.notifyGrid();
  }

  // Days with a start not done yet: [{ date, startMs, cost }] by start. 'cheapest': the cheapest
  // start left that day; none yet without prices.
  dayPlans(now = Date.now()) {
    const profile = this.getApplianceProfile();
    const priceAt = (ms) => this.priceAt(ms);
    const out = [];
    Object.entries(this.applianceDays()).forEach(([date, { value, done }]) => {
      if (done || value === 'unused') return;
      const { start, end } = this.dayBounds(date);
      if (value === 'cheapest') {
        const fromMs = Math.max(start.getTime(), Math.floor(now / SLOT_MS) * SLOT_MS);
        const best = ApplianceModel.cheapestSlotStart(profile, { priceAt, fromMs, toMs: end.getTime() });
        if (best) out.push({ date, startMs: best.startMs, cost: best.cost });
        return;
      }
      const startMs = TimeHelpers.localTimeToUTC(start, value, this.timeZone).getTime();
      out.push({ date, startMs, cost: profile ? ApplianceModel.runCost(profile, priceAt, startMs) : null });
    });
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  // For the forecast: the days set by hand and their starts not done yet.
  forecastDays() {
    return { dates: Object.keys(this.applianceDays()), starts: this.dayPlans().map((p) => p.startMs) };
  }

  // A day's start reached: "Planned start" once (not when it passed long ago, e.g. Homey was off).
  async checkDayPlans(t) {
    const due = this.dayPlans(t).filter((p) => p.startMs <= t);
    if (!due.length) return;
    const days = this.applianceDays();
    for (const p of due) {
      await this.saveApplianceDay(p.date, { ...days[p.date], done: true });
      if (t - p.startMs <= PLANNED_START_MS) {
        this.log(`Appliance start of ${p.date} reached`);
        const { expected_end: expectedEnd, cost } = this.planTokens({ ...p, costNow: null });
        if (this.homey.app.trigger_appliance_planned_start) await this.homey.app.trigger_appliance_planned_start(this, { expected_end: expectedEnd, cost }, {});
      }
    }
    await this.updateAppliancePlanDisplay();
  }

  planTokens(plan) {
    const round = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : 0);
    const profile = this.getApplianceProfile();
    const now = Date.now();
    return {
      start_time: this.hhmm(plan.startMs),
      expected_end: this.hhmm(Math.max(plan.startMs, now) + (profile ? profile.durationMin * 60000 : 0)),
      wait: Math.max(0, Math.round((plan.startMs - now) / 60000)),
      cost: round(plan.cost),
      saving: plan.cost !== null && plan.costNow !== null ? round(plan.costNow - plan.cost) : 0,
    };
  }

  // Flow: plan the cheapest start from now to a time; tokens of the plan.
  async planAppliance(time) {
    const hhmm = EvPlanner.parseTime(time);
    if (!hhmm) throw Error(this.homey.__('error_invalid_time', { time }));
    return this.planTokens(await this.planStartBy(this.nextLocalTime(hhmm)));
  }

  // The next run: running, the flow's plan, else the earlier of a day picker's start and the
  // expected start from the learned starts. { startMs, source: 'run'|'plan'|'day'|'expected' } or
  // null. The tile "Next run", the charts and "Planned start" follow it.
  nextRun(now = Date.now()) {
    if (this.applianceModel && this.applianceModel.run) return { startMs: this.applianceModel.run.start, source: 'run' };
    if (this.appliancePlan && this.appliancePlan.startMs) return { startMs: this.appliancePlan.startMs, source: 'plan' };
    const dayPlan = this.dayPlans(now)[0];
    const expected = this.isApplianceReady()
      ? ApplianceModel.nextExpectedStart(this.applianceModel, this.getApplianceProfile(), now, this.timeZone, (ms) => this.priceAt(ms), this.forecastDays())
      : null;
    if (dayPlan && (expected === null || dayPlan.startMs <= expected)) return { startMs: dayPlan.startMs, source: 'day' };
    return expected === null ? null : { startMs: expected, source: 'expected' };
  }

  // The expected start reached: "Planned start" once, also when it is expected again later (the
  // flow's plan and the day pickers trigger their own). Not after a restart later in that quarter.
  async checkExpectedStart(t) {
    const next = this.nextRun(t);
    if (!next || next.source !== 'expected' || next.startMs > t || next.startMs === this.expectedStartFired) return;
    this.expectedStartFired = next.startMs;
    if (t - next.startMs > 3 * APPLIANCE_SAMPLE_MS) return;
    this.log(`Appliance expected start ${this.hhmm(next.startMs)} reached`);
    const profile = this.getApplianceProfile();
    const cost = ApplianceModel.runCost(profile, (ms) => this.priceAt(ms), next.startMs);
    const { expected_end: expectedEnd } = this.planTokens({ startMs: next.startMs, cost, costNow: null });
    const tokens = { expected_end: expectedEnd, cost: cost === null ? 0 : Math.round(cost * 10000) / 10000 };
    if (this.homey.app.trigger_appliance_planned_start) await this.homey.app.trigger_appliance_planned_start(this, tokens, {});
  }

  // Tiles: next run and the day pickers; then the charts.
  async updateAppliancePlanDisplay() {
    if (!this.applianceModel) return;
    const profile = this.getApplianceProfile();
    const { run } = this.applianceModel;
    const runMs = profile ? profile.durationMin * 60000 : 0;
    const now = Date.now();

    const nextRun = this.nextRun(now);
    let next = '-';
    if (nextRun) {
      const start = nextRun.startMs <= now ? this.homey.__('ev_now') : this.dayHhmm(nextRun.startMs);
      const end = (run ? run.start : Math.max(nextRun.startMs, now)) + runMs;
      next = profile ? `${start}–${this.hhmm(end)}` : start;
    }

    if (this.hasCapability('appliance_next_run')) await this.setCapability('appliance_next_run', next).catch(this.error);
    const days = this.applianceDays();
    for (const day of ['today', 'tomorrow']) {
      const entry = days[this.pickerDate(day)];
      if (this.hasCapability(`appliance_${day}`)) await this.setCapability(`appliance_${day}`, entry ? entry.value : 'auto').catch(this.error);
    }
    await this.renderAppliancePlanCharts().catch(this.error);
  }

  // Today, tomorrow and next hours, like the EV charger: prices, the planned run (bars) and the
  // measured power (line), per 15 minutes.
  async renderAppliancePlanCharts() {
    const profile = this.getApplianceProfile();
    const periods = TimeHelpers.getUTCPeriods(this.timeZone);
    const now = Date.now();
    const nextRun = this.nextRun(now);
    const runStart = nextRun ? nextRun.startMs : null;
    const measured = new Map((this.applianceSlots || []).map((e) => [e.t, Math.round(e.kwh * 4000)]));
    const currency = this.getSettings().currency || '€';
    const translations = { price: this.homey.__('price'), power: this.homey.__('power'), soc: this.homey.__('soc') };
    // A running program: the curve of the earlier runs that started most like it.
    const curveW = this.applianceModel.run
      ? ApplianceModel.runningCurveW(this.applianceModel, profile, now) : profile && profile.curveW;
    const maxW = curveW ? Math.max(...curveW) : 2000;

    const render = async (startMs, endMs, isToday, image, chartProp) => {
      if (!image) return;
      const scheme = {};
      const count = Math.round((endMs - startMs) / SLOT_MS);
      for (let i = 0; i < count; i += 1) {
        const t = startMs + i * SLOT_MS;
        const entry = this.priceEntryAt(t);
        const price = this.priceAt(t);
        const idx = runStart === null || !curveW ? -1 : Math.floor((t - runStart) / SLOT_MS);
        const power = idx >= 0 && idx < curveW.length ? curveW[idx] : 0;
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
  _dapOrderKey, _groupDapDevices, _groupDapDeviceIds, _findGroupPriceLogs, refreshDapPrices,
  _fetchInsightsPriceHistory, _fetchDapPriceHistoryFromInsights, _findPriceEntryForSlot,
} = ChargeDeviceHelpers;
Object.assign(PowerDevice.prototype, {
  _dapOrderKey,
  _groupDapDevices,
  _groupDapDeviceIds,
  _findGroupPriceLogs,
  refreshDapPrices,
  _fetchInsightsPriceHistory,
  _fetchDapPriceHistoryFromInsights,
  _findPriceEntryForSlot,
});

module.exports = PowerDevice;
