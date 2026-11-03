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

/**
 * Shared helpers for charge-scheduling devices (battery, evCharger), mixed into the device
 * prototype: Object.assign(MyDevice.prototype, ChargeDeviceHelpers).
 */

const { findClosestSample, averageSamplesInWindow, mergeStoredHistory } = require('./HistoryLookup');
const { getChargeChart } = require('../charts/ChargeChart');
const TimeHelpers = require('./TimeHelpers');
const PriceDrivers = require('./PriceDrivers');
const MoneyUnit = require('./MoneyUnit');
const LoadSpread = require('./LoadSpread');
const FileStore = require('./FileStore');

module.exports = {

  // Sort key of an electricity price device: the ones with this device's price interval first.
  _dapOrderKey(driverId, settings) {
    return PriceDrivers.intervalOf(driverId, settings) === (this.priceInterval || 60) ? 0 : 1;
  },

  // The electricity price devices of this app that feed this device's tariff group, by _dapOrderKey().
  _groupDapDevices() {
    const group = this.getSettings().tariff_update_group;
    return PriceDrivers.getDevices(this.homey, { commodity: 'power' })
      .filter((d) => d.getSettings().tariff_update_group === group)
      .map((d, i) => ({ d, i, k: this._dapOrderKey(d.driver.id, d.getSettings()) }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map(({ d }) => d);
  },

  // Insights log ids of those price devices for the first of capNames (a name or a list) each has,
  // in the same order, and of the old ones taken over from this group (their history). From the
  // SDK: api.devices.getDevices() and api.insights.getLogs() are large.
  _groupPriceLogIds(capNames) {
    const group = this.getSettings().tariff_update_group;
    const names = [].concat(capNames);
    return PriceDrivers.getDevices(this.homey, { commodity: 'power' })
      .filter((d) => d.getSettings().tariff_update_group === group || d.getStoreValue(PriceDrivers.TAKEN_OVER_GROUP_KEY) === group)
      .map((d, i) => ({ d, i, k: this._dapOrderKey(d.driver.id, d.getSettings()) }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map(({ d }) => {
        const cap = names.find((name) => d.hasCapability(name));
        return cap ? `homey:device:${d.getId()}:${cap}` : null;
      })
      .filter(Boolean);
  },

  /**
   * Refresh this.dapPrices (current/future) and this.dapPriceHistory (yesterday, from Insights
   * meter_price_h0) from the DAP devices of this device's tariff group.
   */
  async refreshDapPrices() {
    // A DAP device can be replaced, or move to another group: pick it every time.
    const dapDev = this._groupDapDevices().find((d) => Array.isArray(d.prices) && d.prices.length > 0);
    this.dapPrices = dapDev ? dapDev.prices : null;

    // Yesterday from Insights: once per local day, retried at most hourly while it finds nothing
    // (it lists every Insights log on the Homey).
    if (this.homey && this.homey.app && this.homey.app.api) {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const today = TimeHelpers.toLocalDate(new Date(), tz).toDateString();
      const attempt = this.dapPriceHistoryAttempt || {};
      // A failed fetch after midnight leaves the day before yesterday in place: that is no history.
      const yesterdayStartMs = TimeHelpers.getUTCPeriods(tz).yesterdayStart.getTime();
      const haveHistory = !this.dapPriceHistoryPartial && Array.isArray(this.dapPriceHistory)
        && this.dapPriceHistory.some((e) => new Date(e.time).getTime() >= yesterdayStartMs);
      const retryDue = !attempt.tm || (Date.now() - attempt.tm) > 60 * 60 * 1000;
      if (attempt.day !== today || (!haveHistory && retryDue)) {
        this.dapPriceHistoryAttempt = { day: today, tm: Date.now() };
        const before = this.dapPriceHistory;
        await this._fetchDapPriceHistoryFromInsights().catch(() => {});
        // A retry that succeeds after the yesterday chart was drawn with fallback prices: redraw it.
        if (this.dapPriceHistory !== before) this.dapPriceHistoryRefreshed = true;
      }
    }
  },

  /**
   * Fetch yesterday's hourly values for a given price capability from Homey Insights, from the
   * DAP devices of this device's tariff group (_groupPriceLogIds()).
   * Returns an array of { time: Date, value: number }, sorted by time, or null if nothing found.
   */
  async _fetchInsightsPriceHistory(capName) {
    const { api } = this.homey.app;
    if (!api) return null;

    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const { yesterdayStart, todayStart } = TimeHelpers.getUTCPeriods(tz);
    const yesterdayStartMs = yesterdayStart.getTime();
    const todayStartMs = todayStart.getTime();

    const logIds = this._groupPriceLogIds(capName);

    if (!logIds.length) {
      this.log(`[PriceHistory] No ${capName} Insights log found (DAP device may be too new or not logging)`);
      return null;
    }

    // 'today' only returns today: try 'last7Days'/'last14Days' for hourly points of yesterday.
    // Insights pads the window with nulls: count values only.
    const startDate = new Date(yesterdayStartMs - 3600000);
    let bestEntries = null;
    let bestYesterdayCount = -1;

    for (const logId of logIds) {
      for (const resStr of ['last7Days', 'last14Days', 'today']) {
        const data = await api.insights.getLogEntries({
          id: logId,
          start: startDate.toISOString(),
          end: now.toISOString(),
          resolution: resStr,
        }).catch(() => null);

        if (data && Array.isArray(data.values) && data.values.length > 0) {
          const yesterdayCount = data.values.filter((e) => {
            const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
            return typeof e.v === 'number' && t >= yesterdayStartMs && t < todayStartMs;
          }).length;
          if (yesterdayCount > bestYesterdayCount) {
            bestYesterdayCount = yesterdayCount;
            bestEntries = data.values;
          }

          // 20+ entries for yesterday: hourly data
          if (yesterdayCount >= 20) break;
        }
      }
      if (bestYesterdayCount >= 20) break;
    }

    const entries = bestEntries;
    if (!entries || entries.length === 0) {
      this.log(`[PriceHistory] No ${capName} data found in Insights for requested window`);
      return null;
    }

    const history = [];
    for (const entry of entries) {
      const t = typeof entry.t === 'number' ? entry.t : new Date(entry.t).getTime();
      let v = null;
      if (typeof entry.v === 'number') v = entry.v;
      else if (typeof entry.y === 'number') v = entry.y;
      if (v === null || !Number.isFinite(t) || !Number.isFinite(v)) continue;
      if (t >= yesterdayStartMs - 30 * 60 * 1000 && t < todayStartMs + 30 * 60 * 1000) {
        history.push({ time: new Date(t), value: v });
      }
    }

    if (history.length === 0) {
      this.log(`[PriceHistory] Insights data found for ${capName} but none fell in yesterday window`);
      return null;
    }
    history.sort((a, b) => a.time - b.time);
    return history;
  },

  /**
   * Refresh this.dapPriceHistory (import) and this.dapExportPriceHistory (export) for yesterday,
   * from Homey Insights (PriceDrivers.PRICE_LOG_CAPS).
   */
  async _fetchDapPriceHistoryFromInsights() {
    const { app } = this.homey;
    if (!app || !app.api) return;
    // Every device of a tariff group needs the same history, all at local midnight: fetch it once.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const day = TimeHelpers.getUTCPeriods(tz).yesterdayStart.getTime();
    const shared = await app.getSharedDaily(`priceHistory|${this.getSettings().tariff_update_group}`, day, async () => {
      const imp = await this._fetchInsightsPriceHistory(PriceDrivers.PRICE_LOG_CAPS.import);
      const exp = await this._fetchInsightsPriceHistory(PriceDrivers.PRICE_LOG_CAPS.export);
      if (!imp && !exp) return null;
      // Partial (a price capability there without data): used, not kept for the day, retried.
      const expected = (cap) => this._groupPriceLogIds(cap).length > 0;
      const partial = (!imp && expected(PriceDrivers.PRICE_LOG_CAPS.import)) || (!exp && expected(PriceDrivers.PRICE_LOG_CAPS.export));
      return { imp, exp, partial };
    });
    if (shared) this.dapPriceHistoryPartial = !!shared.partial;
    const importHistory = shared && shared.imp;
    const exportHistory = shared && shared.exp;
    if (importHistory) {
      this.dapPriceHistory = importHistory.map((e) => ({ time: e.time, muPrice: e.value, price: e.value }));
    }

    if (exportHistory) {
      this.dapExportPriceHistory = exportHistory.map((e) => ({ time: e.time, exportPrice: e.value }));
    }
  },

  /**
   * The price entry whose interval covers slotMs, else the closest one within 55 minutes.
   *
   * @param {Array} list
   * @param {number} slotMs
   * @param {number} intervalMs
   * @returns {object|null}
   */
  _findPriceEntryForSlot(list, slotMs, intervalMs) {
    if (!Array.isArray(list) || list.length === 0) return null;

    let match = list.find((p) => {
      const pTime = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
      return pTime <= slotMs && pTime + intervalMs > slotMs;
    });

    // Closest entry (Insights timestamps can be at the end of the hour or offset)
    if (!match) {
      const candidates = list.map((p) => {
        const pTime = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
        const diff = Math.min(
          Math.abs(pTime - slotMs),
          Math.abs(pTime - (slotMs + intervalMs)),
          Math.abs(pTime - (slotMs + intervalMs / 2)),
        );
        return { p, diff };
      }).filter((item) => item.diff < 55 * 60 * 1000);

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.diff - b.diff);
        match = candidates[0].p;
      }
    }
    return match || null;
  },

  /**
   * Price for a timestamp (ms): live prices, then yesterday's history, else the first known
   * price or 0.25.
   *
   * @param {number} slotMs
   * @returns {number} price
   */
  getPriceForTimestamp(slotMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;

    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.dapPrices;
    const liveMatch = this._findPriceEntryForSlot(liveList, slotMs, intervalMs);
    if (liveMatch) {
      if (typeof liveMatch.muPrice === 'number') return liveMatch.muPrice;
      if (typeof liveMatch.price === 'number') return liveMatch.price;
    }

    const histMatch = this._findPriceEntryForSlot(this.dapPriceHistory, slotMs, intervalMs);
    if (histMatch) {
      if (typeof histMatch.muPrice === 'number') return histMatch.muPrice;
      if (typeof histMatch.price === 'number') return histMatch.price;
    }

    const { prices } = this.pricesFromNow();
    return (prices && prices[0]) || 0.25;
  },

  /**
   * Export price for a timestamp (ms): live prices, then yesterday's export history. null when
   * unknown (the chart shows a gap).
   *
   * @param {number} slotMs
   * @returns {number|null}
   */
  getExportPriceForTimestamp(slotMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;

    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.dapPrices;
    const liveMatch = this._findPriceEntryForSlot(liveList, slotMs, intervalMs);
    if (liveMatch && typeof liveMatch.exportPrice === 'number') return liveMatch.exportPrice;

    const histMatch = this._findPriceEntryForSlot(this.dapExportPriceHistory, slotMs, intervalMs);
    if (histMatch && typeof histMatch.exportPrice === 'number') return histMatch.exportPrice;

    return null;
  },

  /**
   * Average power in this.powerHistory over the price slot starting at timeMs, else the closest
   * reading within 1 hour.
   *
   * @param {number} timeMs
   * @returns {number|null} W, or null without data
   */
  getActualPowerForTime(timeMs) {
    const intervalMs = this.planIntervalMin() * 60 * 1000;
    const avg = averageSamplesInWindow(this.powerHistory, timeMs, timeMs + intervalMs, 'power');
    if (avg !== null) return avg;
    return findClosestSample(this.powerHistory, timeMs, 60 * 60 * 1000, 'power');
  },

  /**
   * Tell the grid device(s) that this device's plan changed: their grid forecast includes it.
   */
  notifyChargePlanUpdated() {
    try {
      this.homey.drivers.getDriver('grid').getDevices().forEach((dev) => {
        if (typeof dev.onChargePlanUpdated === 'function') dev.onChargePlanUpdated();
      });
    } catch {
      // no grid driver/devices: nothing to notify
    }
  },

  /**
   * Slot length (minutes) of the charge plan and its charts: the price interval, or finer when
   * the driver plans finer (ds.planIntervalMin, evCharger). Prices are still looked up per price slot.
   *
   * @returns {number}
   */
  planIntervalMin() {
    const price = this.priceInterval || 60;
    const plan = this.ds && this.ds.planIntervalMin;
    return plan && plan < price ? plan : price;
  },

  getPlannedPowerSeries(startMs, endMs) {
    const plan = this.latestPlan;
    const values = [];
    for (let t = startMs; t < endMs; t += 15 * 60 * 1000) {
      if (!plan) {
        values.push(null);
        continue;
      }
      const idx = Math.floor((t - plan.startMs) / plan.intervalMs);
      const slot = idx >= 0 ? plan.slots[idx] : null;
      const slotMinutes = idx === 0 ? plan.firstSlotMinutes : plan.intervalMs / 60000;
      values.push(slot ? Math.round(slot.power * Math.min(1, slot.duration / slotMinutes)) : null);
    }
    return values;
  },

  /**
   * Append a live SoC reading to this.socHistory: at most one per minute, max 2880 entries (48h).
   *
   * @param {number} value - SoC in percent
   * @returns {boolean} true when a sample was appended
   */
  recordSocSample(value) {
    if (typeof value !== 'number') return false;
    const now = Date.now();
    if (!Array.isArray(this.socHistory)) this.socHistory = [];
    const last = this.socHistory[this.socHistory.length - 1];
    if (last && Math.abs(now - last.time) < 60000) return false;
    this.socHistory.push({ time: now, soc: value });
    if (this.socHistory.length > 2880) this.socHistory.shift();
    return true;
  },

  /**
   * Save this.socHistory (file store) and extra store values at most once per 15 minutes. The gate is
   * checked before the first await, so an unawaited call is safe.
   *
   * @param {object} [extra] - more store values, e.g. { lastKnownSoc }
   * @returns {Promise<boolean>} true when saved
   */
  async saveSocHistory(extra = {}) {
    const now = Date.now();
    if (this.lastSocHistorySaveTm && (now - this.lastSocHistorySaveTm <= 15 * 60 * 1000)) return false;
    this.lastSocHistorySaveTm = now;
    this.fileStore.set('socHistory', this.socHistory);
    for (const [key, value] of Object.entries(extra)) {
      await this.setStoreValue(key, value).catch(this.error);
    }
    return true;
  },

  /**
   * History array (powerHistory/socHistory) from the file store, merged with the samples in memory
   * (HistoryLookup.mergeStoredHistory).
   *
   * @param {string} key - file store key, same as the property name
   * @returns {Promise<Array>}
   */
  async loadStoredHistory(key) {
    const files = await FileStore.open(this, [key]);
    return mergeStoredHistory(files.get(key), this[key], 2880);
  },

  /**
   * Closest SoC reading in this.socHistory within 1 hour of timeMs.
   *
   * @param {number} timeMs
   * @returns {number|null} SoC in percent, or null without data
   */
  getActualSocForTime(timeMs) {
    return findClosestSample(this.socHistory, timeMs, 60 * 60 * 1000, 'soc');
  },

  /**
   * Record the planned schedule for today's slots from currentSlotInDay on, keeping today's past
   * and yesterday's slots for the charts.
   */
  async recordPlannedSchedule(strategyScheme, currentSlotInDay, totalDaySlots, dateStr) {
    const intervalMin = this.planIntervalMin();
    if (!this.plannedScheduleStore || this.plannedScheduleStore.todayDateStr !== dateStr
      || this.plannedScheduleStore.intervalMin !== intervalMin) {
      let stored = null;
      try {
        if (typeof this.getStoreValue === 'function') {
          stored = this.getStoreValue('plannedScheduleStore');
        }
      } catch {
        stored = null;
      }

      // Slot indexes of another slot length do not fit (stores without intervalMin: price slots).
      const fits = stored && (stored.intervalMin || this.priceInterval || 60) === intervalMin;
      if (fits && stored.todayDateStr === dateStr) {
        this.plannedScheduleStore = stored;
      } else if (fits && stored.todaySchedule) {
        // Day rolled over: shift todaySchedule -> yesterdaySchedule
        this.plannedScheduleStore = {
          todayDateStr: dateStr,
          todaySchedule: {},
          yesterdaySchedule: stored.todaySchedule || {},
        };
      } else {
        this.plannedScheduleStore = { todayDateStr: dateStr, todaySchedule: {}, yesterdaySchedule: {} };
      }
      this.plannedScheduleStore.intervalMin = intervalMin;
    }

    if (strategyScheme) {
      for (let i = currentSlotInDay; i < totalDaySlots; i += 1) {
        const stratIdx = i - currentSlotInDay;
        const slotData = strategyScheme[stratIdx];
        if (slotData) {
          this.plannedScheduleStore.todaySchedule[i] = {
            power: slotData.power || 0,
            duration: slotData.duration || 0,
            ...(slotData.block ? { block: slotData.block } : {}),
          };
        }
      }
      try {
        if (typeof this.setStoreValue === 'function') {
          await this.setStoreValue('plannedScheduleStore', this.plannedScheduleStore);
        }
      } catch {
        // ignore
      }
    }
  },

  /**
   * Get recorded planned schedule for a specific slot.
   * @param {number} slotIndex - Slot index (0..totalDaySlots-1)
   * @param {boolean} [isYesterday=false] - If true, look up yesterday's schedule
   * @returns {{ power: number, duration: number }}
   */
  getPlannedScheduleForSlot(slotIndex, isYesterday = false) {
    const store = this.plannedScheduleStore;
    if (!store) return { power: 0, duration: 0 };
    const sched = isYesterday ? store.yesterdaySchedule : store.todaySchedule;
    if (sched && sched[slotIndex]) {
      return sched[slotIndex];
    }
    return { power: 0, duration: 0 };
  },

  /**
   * Charge-chart rendering for battery/evCharger: Today, Tomorrow, Next Hours and Yesterday.
   *
   * @param {object} scheme - per-slot {0: {power,duration,soc,price,exportPrice,isForecast}, ...},
   *   index 0 = current partial slot, covering at least the rest of today and all of tomorrow.
   *   `isForecast` is set by the caller; this method adds `isFuture`.
   * @param {number} chargePower
   * @param {number} dischargePower - 0 for evCharger
   * @param {number|null} socFallback - live SoC for the current slot without a history sample
   * @param {boolean} showPower
   * @param {boolean} showSoc
   * @param {boolean} showExportPrice
   * @param {boolean} [showLegend]
   * @param {number} [planSlots] - the slots of the scheme that are executed; the rest is only shown
   */
  async renderChargeCharts({
    scheme, chargePower, dischargePower, socFallback, showPower, showSoc, showExportPrice, showLegend = false, planTm = Date.now(),
    planSlots,
  }) {
    Object.keys(scheme).forEach((k) => {
      // The plan has not executed yet, whether or not the price is a forecast.
      if (scheme[k] && typeof scheme[k] === 'object') scheme[k].isFuture = true;
    });

    // Real UTC midnights, so a 23/25-hour DST day gets its true number of slots.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const periods = TimeHelpers.getUTCPeriods(tz);
    const { now, nowLocal } = periods;
    const intervalMs = this.planIntervalMin() * 60 * 1000;
    const todayStartMs = periods.todayStart.getTime();
    const tomorrowStartMs = periods.tomorrowStart.getTime();
    const yesterdayStartMs = periods.yesterdayStart.getTime();
    const slotsBetween = (fromMs, toMs) => Math.round((toMs - fromMs) / intervalMs);
    const currentSlotInDay = Math.floor((now.getTime() - todayStartMs) / intervalMs);
    const totalDaySlots = slotsBetween(todayStartMs, tomorrowStartMs);
    const currentSlotStartMs = todayStartMs + (currentSlotInDay * intervalMs);

    // For getPlannedPowerSeries(): scheme[0] is the current price slot, which the plan covers only
    // from planTm to its end.
    this.latestPlan = {
      startMs: currentSlotStartMs,
      planTm,
      startSoc: typeof this.soc === 'number' ? this.soc : null, // at planTm
      intervalMs,
      firstSlotMinutes: Math.max(1, (currentSlotStartMs + intervalMs - Math.max(planTm, currentSlotStartMs)) / 60000),
      slots: Object.keys(scheme).slice(0, planSlots).map((k) => ({
        power: Number(scheme[k] && scheme[k].power) || 0,
        duration: Number(scheme[k] && scheme[k].duration) || 0,
        solarExtra: !!(scheme[k] && scheme[k].solarExtra), // EV: only a cheap extra on solar surplus
        block: (scheme[k] && scheme[k].block) || null, // battery: RoiStrategy block type
        noCharge: !!(scheme[k] && scheme[k].noCharge), // battery: surplus not worth storing
        minSolarW: (scheme[k] && scheme[k].minSolarW) || 0, // battery: surplus stored only above
        quiet: !!(scheme[k] && scheme[k].quiet), // battery: hold with no surplus or deficit expected
        soc: scheme[k] && typeof scheme[k].soc === 'number' ? scheme[k].soc : null,
      })),
    };
    this.notifyChargePlanUpdated();

    const todayDateStr = nowLocal.toDateString();
    await this.recordPlannedSchedule(scheme, currentSlotInDay, totalDaySlots, todayDateStr);

    // The charts are not time-critical: after a slot boundary's burst (LoadSpread).
    const draw = async () => {
      const { currency } = MoneyUnit.get(this);
      const translations = {
        price: this.homey.__('price') || 'Prijs',
        power: this.homey.__('power') || 'Vermogen',
        soc: this.homey.__('soc') || 'SoC',
        legend: Object.fromEntries(['nom', 'save', 'charge', 'discharge'].map((key) => [key, this.homey.__(`chart_legend.${key}`)])),
      };

      // Tomorrow and Yesterday are cached: rebuild them when the display settings change.
      const chartDisplaySettingsKey = `${showPower}|${showSoc}|${showExportPrice}|${showLegend}`;
      const chartDisplaySettingsChanged = this.lastChartDisplaySettingsKey !== chartDisplaySettingsKey;
      this.lastChartDisplaySettingsKey = chartDisplaySettingsKey;

      // 1. Today
      const todayStrategy = {};
      const todayExportPrices = [];

      for (let i = 0; i < totalDaySlots; i += 1) {
        const slotStartMs = todayStartMs + (i * intervalMs);
        const isPastOrPresent = slotStartMs <= now.getTime();
        let actualP = this.getActualPowerForTime(slotStartMs);
        if (isPastOrPresent && actualP === null) actualP = 0;
        let actualSoc = this.getActualSocForTime(slotStartMs);
        if (isPastOrPresent && actualSoc === null && i <= currentSlotInDay) {
          actualSoc = typeof socFallback === 'number' ? socFallback : null;
        }
        const slotPrice = this.getPriceForTimestamp(slotStartMs);
        todayExportPrices[i] = this.getExportPriceForTimestamp(slotStartMs);

        if (i < currentSlotInDay) {
          const planned = this.getPlannedScheduleForSlot(i);
          todayStrategy[i] = {
            power: planned.power,
            block: planned.block,
            actualPower: actualP,
            duration: planned.duration,
            soc: actualSoc,
            price: slotPrice,
            isForecast: false,
            isFuture: false,
          };
        } else {
          const stratIdx = i - currentSlotInDay;
          if (scheme && scheme[stratIdx]) {
            todayStrategy[i] = {
              ...scheme[stratIdx],
              actualPower: isPastOrPresent ? actualP : (scheme[stratIdx].actualPower || null),
              soc: isPastOrPresent && actualSoc !== null ? actualSoc : (scheme[stratIdx].soc || null),
              // the price is a forecast
              isForecast: !!scheme[stratIdx].isForecast,
              // the slot has not happened yet
              isFuture: !isPastOrPresent,
            };
          } else {
            todayStrategy[i] = {
              power: 0,
              actualPower: isPastOrPresent ? actualP : null,
              duration: 0,
              soc: isPastOrPresent ? actualSoc : null,
              price: slotPrice,
              isForecast: true,
              isFuture: !isPastOrPresent,
            };
          }
        }
      }

      const chartToday = await getChargeChart(
        { scheme: JSON.stringify(todayStrategy) },
        todayStartMs,
        totalDaySlots,
        chargePower,
        dischargePower,
        this.planIntervalMin(),
        todayExportPrices,
        currency,
        translations,
        true,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
        showLegend,
      );

      this.chartTodayCharge = chartToday;
      await this.todayChargeImage.update().catch((err) => this.error(err));

      // 2. Tomorrow: only on date rollover, new prices, display settings change or first render
      const dateRolledOver = !this.lastRenderedDateStr || (this.lastRenderedDateStr !== todayDateStr);
      this.lastRenderedDateStr = todayDateStr;

      if (dateRolledOver || this.pricesUpdated || chartDisplaySettingsChanged || !this.chartTomorrowCharge) {
        const tomorrowStrategy = {};
        const remainingTodaySlots = totalDaySlots - currentSlotInDay;
        const tomorrowSlots = slotsBetween(tomorrowStartMs, periods.tomorrowEnd.getTime());
        const tomorrowExportPrices = [];

        for (let i = 0; i < tomorrowSlots; i += 1) {
          const stratIdx = remainingTodaySlots + i;
          if (scheme && scheme[stratIdx]) {
            tomorrowStrategy[i] = { ...scheme[stratIdx], isFuture: true };
          } else {
            tomorrowStrategy[i] = {
              power: 0,
              duration: 0,
              soc: null,
              price: null,
              isForecast: true,
              isFuture: true,
            };
          }
          tomorrowExportPrices[i] = this.getExportPriceForTimestamp(tomorrowStartMs + (i * intervalMs));
        }

        const chartTomorrow = await getChargeChart(
          { scheme: JSON.stringify(tomorrowStrategy) },
          tomorrowStartMs,
          tomorrowSlots,
          chargePower,
          dischargePower,
          this.planIntervalMin(),
          tomorrowExportPrices,
          currency,
          translations,
          false,
          this.timeZone,
          showPower,
          showSoc,
          showExportPrice,
          showLegend,
        );

        this.chartTomorrowCharge = chartTomorrow;
        await this.tomorrowChargeImage.update().catch((err) => this.error(err));
      }

      // 3. Next Hours from the current slot. Market length and export prices per price slot.
      const priceMin = this.priceInterval || 60;
      const toPlanSlots = (list) => TimeHelpers.toFinerSlots(
        list,
        TimeHelpers.startOfLocalBlock(currentSlotStartMs, priceMin, tz),
        priceMin,
        currentSlotStartMs,
        this.planIntervalMin(),
      );
      const fromNow = this.pricesFromNow();
      const marketLength = typeof fromNow.marketLength === 'number'
        ? toPlanSlots(new Array(fromNow.marketLength).fill(0)).length : fromNow.marketLength;
      const chartNextHours = await getChargeChart(
        { scheme: JSON.stringify(scheme) },
        currentSlotStartMs,
        marketLength,
        chargePower,
        dischargePower,
        this.planIntervalMin(),
        toPlanSlots(fromNow.exportPrices),
        currency,
        translations,
        false,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
        showLegend,
      );
      this.chartNextHoursCharge = chartNextHours;
      await this.nextHoursChargeImage.update().catch((err) => this.error(err));

      // 4. Yesterday: only on date rollover, display settings change, new price history or first render
      if (dateRolledOver || chartDisplaySettingsChanged || this.dapPriceHistoryRefreshed || !this.chartYesterdayCharge) {
        this.dapPriceHistoryRefreshed = false;
        const yesterdaySlots = slotsBetween(yesterdayStartMs, todayStartMs);
        const yesterdayStrategy = {};
        const yesterdayExportPrices = [];

        for (let i = 0; i < yesterdaySlots; i += 1) {
          const slotStartMs = yesterdayStartMs + (i * intervalMs);
          let actualP = this.getActualPowerForTime(slotStartMs);
          if (actualP === null) actualP = 0;
          const actualSocYesterday = this.getActualSocForTime(slotStartMs);
          const slotPrice = this.getPriceForTimestamp(slotStartMs);
          const planned = this.getPlannedScheduleForSlot(i, true);
          yesterdayExportPrices[i] = this.getExportPriceForTimestamp(slotStartMs);

          yesterdayStrategy[i] = {
            power: planned.power,
            actualPower: actualP,
            duration: planned.duration,
            soc: actualSocYesterday,
            price: slotPrice,
            isForecast: false,
            isFuture: false,
          };
        }

        const chartYesterday = await getChargeChart(
          { scheme: JSON.stringify(yesterdayStrategy) },
          yesterdayStartMs,
          yesterdaySlots,
          chargePower,
          dischargePower,
          this.planIntervalMin(),
          yesterdayExportPrices,
          currency,
          translations,
          false,
          this.timeZone,
          showPower,
          showSoc,
          showExportPrice,
          showLegend,
        );

        this.chartYesterdayCharge = chartYesterday;
        await this.yesterdayChargeImage.update().catch((err) => this.error(err));
      }

      this.pricesUpdated = false;
    };
    return LoadSpread.run(this, 'chargeCharts', draw);
  },

};
