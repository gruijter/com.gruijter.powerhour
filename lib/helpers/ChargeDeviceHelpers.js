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
 * Shared helpers for charge-scheduling devices (battery, evCharger).
 * Mixed into the device prototype so methods run with the device as `this`.
 *
 * Usage in device class:
 *   const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
 *   Object.assign(MyDevice.prototype, ChargeDeviceHelpers);
 */

const { findClosestSample, averageSamplesInWindow } = require('./HistoryLookup');
const { getChargeChart } = require('../charts/ChargeChart');
const TimeHelpers = require('./TimeHelpers');

const DAP_DRIVER_IDS = ['dap', 'dap15', 'dapg'];

module.exports = {

  /**
   * Refresh this.dapPrices (current/future) and this.dapPriceHistory (yesterday).
   *
   * Searches all DAP driver instances for live prices.
   * Then fetches yesterday's price history from Homey Insights (meter_price_h0).
   * The Insights approach works after a fresh install since Insights data persists
   * independently across app restarts.
   */
  async refreshDapPrices() {

    // First: check if sourceDevice IS a DAP instance (direct in-process reference)
    if (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0) {
      this.dapPrices = this.sourceDevice.prices;
    }

    // Otherwise: find from driver instances
    if (!this.dapPrices || this.dapPrices.length === 0) {
      try {
        for (const driverId of DAP_DRIVER_IDS) {
          let dapDriver;
          try {
            dapDriver = this.homey.drivers.getDriver(driverId);
          } catch {
            // driver not installed, skip
          }
          if (!dapDriver) continue;
          const devices = dapDriver.getDevices();
          if (!devices || devices.length === 0) continue;
          const dapDev = devices.find((d) => Array.isArray(d.prices) && d.prices.length > 0);
          if (dapDev) {
            this.dapPrices = dapDev.prices;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Fetch yesterday price history from Homey Insights
    // meter_price_h0 is unique to DAP devices so no device ID filtering needed
    // Yesterday only changes at midnight, and this lists every Insights log on the Homey plus
    // several log fetches - so once per local day, retried at most hourly while it finds nothing.
    if (this.homey && this.homey.app && this.homey.app.api) {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const today = TimeHelpers.toLocalDate(new Date(), tz).toDateString();
      const attempt = this.dapPriceHistoryAttempt || {};
      const haveHistory = Array.isArray(this.dapPriceHistory) && this.dapPriceHistory.length > 0;
      const retryDue = !attempt.tm || (Date.now() - attempt.tm) > 60 * 60 * 1000;
      if (attempt.day !== today || (!haveHistory && retryDue)) {
        this.dapPriceHistoryAttempt = { day: today, tm: Date.now() };
        await this._fetchDapPriceHistoryFromInsights().catch(() => {});
      }
    }
  },

  /**
   * Fetch yesterday's hourly values for a given price capability from Homey Insights.
   * Searches all Insights logs for one ending with `:${capName}` — DAP price capabilities
   * (meter_price_h0, meter_price_h0_export) are unique to DAP devices so no device-ID filter
   * is needed. The Insights log ID uses the Homey UUID, not the driver's getData().id
   * (biddingzone), so we cannot reliably filter by device ID here.
   * Returns an array of { time: Date, value: number }, sorted by time, or null if nothing found.
   */
  async _fetchInsightsPriceHistory(capName, cachedLogs = null) {
    const { api } = this.homey.app;
    if (!api) return null;

    // Calculate yesterday window in local time
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const { yesterdayStart, todayStart } = TimeHelpers.getUTCPeriods(tz);
    const yesterdayStartMs = yesterdayStart.getTime();
    const todayStartMs = todayStart.getTime();

    const allLogs = cachedLogs || await this.homey.app.getInsightsLogs().catch(() => []);
    const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);

    const priceLog = logs.find((l) => {
      const id = l.id || l.uri || '';
      return id.endsWith(`:${capName}`) || id.includes(capName) || l.name === capName;
    });

    if (!priceLog) {
      this.log(`[PriceHistory] No ${capName} Insights log found (DAP device may be too new or not logging)`);
      return null;
    }

    // Fetch log entries for yesterday. Note: 'today' resolution only returns points for today.
    // We try 'last7Days' and 'last14Days' first to get hourly points for yesterday.
    const startDate = new Date(yesterdayStartMs - 3600000); // 1h buffer
    let bestEntries = null;
    let bestYesterdayCount = -1;

    for (const resStr of ['last7Days', 'last14Days', 'today']) {
      const data = await api.insights.getLogEntries({
        id: priceLog.id,
        start: startDate.toISOString(),
        end: now.toISOString(),
        resolution: resStr,
      }).catch(() => null);

      if (data && Array.isArray(data.values) && data.values.length > 0) {
        const yesterdayCount = data.values.filter((e) => {
          const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
          return t >= yesterdayStartMs && t < todayStartMs;
        }).length;
        if (yesterdayCount > bestYesterdayCount) {
          bestYesterdayCount = yesterdayCount;
          bestEntries = data.values;
        }

        // If we found at least 20 entries for yesterday, this is high quality hourly data
        if (yesterdayCount >= 20) break;
      }
    }

    const entries = bestEntries;
    if (!entries || entries.length === 0) {
      this.log(`[PriceHistory] No ${capName} data found in Insights for requested window`);
      return null;
    }

    // Convert Insights entries to { time, value }, filter to yesterday's window
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
   * from Homey Insights (meter_price_h0 / meter_price_h0_export).
   */
  async _fetchDapPriceHistoryFromInsights() {
    const { api } = this.homey.app || {};
    const allLogs = api ? await this.homey.app.getInsightsLogs().catch(() => []) : [];
    const importHistory = await this._fetchInsightsPriceHistory('meter_price_h0', allLogs);
    if (importHistory) {
      this.dapPriceHistory = importHistory.map((e) => ({ time: e.time, muPrice: e.value, price: e.value }));
    }

    const exportHistory = await this._fetchInsightsPriceHistory('meter_price_h0_export', allLogs);
    if (exportHistory) {
      this.dapExportPriceHistory = exportHistory.map((e) => ({ time: e.time, exportPrice: e.value }));
    }
  },

  /**
   * Find the price-list entry (from this.dapPrices/sourceDevice.prices/dapPriceHistory-style
   * arrays) whose interval covers slotMs, or - failing that - the closest entry within 55
   * minutes. Shared by getPriceForTimestamp and getExportPriceForTimestamp so both use
   * identical slot-matching semantics.
   *
   * @param {Array} list
   * @param {number} slotMs
   * @param {number} intervalMs
   * @returns {object|null}
   */
  _findPriceEntryForSlot(list, slotMs, intervalMs) {
    if (!Array.isArray(list) || list.length === 0) return null;

    // 1. Try exact slot interval match
    let match = list.find((p) => {
      const pTime = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
      return pTime <= slotMs && pTime + intervalMs > slotMs;
    });

    // 2. If no exact match (e.g. Insights timestamps at end of hour or slightly offset),
    // find the entry closest to slotMs
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
   * Look up the muPrice for a given timestamp (ms).
   * Searches this.dapPrices first (current/future), then this.dapPriceHistory (yesterday).
   * Falls back to first known price or 0.25 if nothing matches.
   *
   * @param {number} slotMs - Unix timestamp in milliseconds
   * @returns {number} price
   */
  getPriceForTimestamp(slotMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;

    // 1. Try live prices (today / future)
    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.dapPrices;
    const liveMatch = this._findPriceEntryForSlot(liveList, slotMs, intervalMs);
    if (liveMatch) {
      if (typeof liveMatch.muPrice === 'number') return liveMatch.muPrice;
      if (typeof liveMatch.price === 'number') return liveMatch.price;
    }

    // 2. Try yesterday prices from Insights
    const histMatch = this._findPriceEntryForSlot(this.dapPriceHistory, slotMs, intervalMs);
    if (histMatch) {
      if (typeof histMatch.muPrice === 'number') return histMatch.muPrice;
      if (typeof histMatch.price === 'number') return histMatch.price;
    }

    // 3. Fallback
    return (this.pricesNextHours && this.pricesNextHours[0]) || 0.25;
  },

  /**
   * Look up the export price for a given timestamp (ms), mirroring getPriceForTimestamp.
   * Searches live prices first (each entry carries its own exportPrice, set by the DAP
   * device), then this.dapExportPriceHistory (yesterday, fetched from the meter_price_h0_export
   * Insights log). Unlike getPriceForTimestamp there is no synthetic fallback - if no export
   * price is known for a slot, return null so the chart simply shows a gap there.
   *
   * @param {number} slotMs - Unix timestamp in milliseconds
   * @returns {number|null} export price, or null if unknown
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
   * Average power in this.powerHistory over the price slot starting at timeMs. Falls back to the
   * closest reading within 1 hour when the slot holds no samples at all.
   *
   * @param {number} timeMs - slot start, Unix timestamp in milliseconds
   * @returns {number|null} power in watts, or null if no data
   */
  getActualPowerForTime(timeMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;
    const avg = averageSamplesInWindow(this.powerHistory, timeMs, timeMs + intervalMs, 'power');
    if (avg !== null) return avg;
    return findClosestSample(this.powerHistory, timeMs, 60 * 60 * 1000, 'power');
  },

  /**
   * Planned battery power (W, + charge / - discharge) per 15-minute slot from startMs to endMs,
   * from the latest ROI plan. A price slot's power runs for `duration` minutes; where within the
   * slot is not planned, so every 15 minutes of it gets the slot average (the first slot: over the
   * part still to come when the plan was made). null where no plan
   * covers the slot. Discharge power in the plan is DC side, so this slightly overstates what
   * reaches the house.
   *
   * @param {number} startMs
   * @param {number} endMs
   * @returns {Array<number|null>}
   */
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
   * Append a live SoC reading to this.socHistory: at most one sample per minute, capped to 2880
   * entries (48h). Without it the history only holds the Insights backfill from onInit(), and every
   * slot after that falls back to the current SoC in the charts.
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
   * Find the closest SoC reading in this.socHistory for a given time.
   * Only considers entries within 1 hour of the requested time. Mirrors
   * getActualPowerForTime() above - see that method's/this.socHistory's population in device.js
   * (_handleSocUpdate, live sampling) and learnDeparturePattern() (Insights backfill).
   *
   * @param {number} timeMs - Unix timestamp in milliseconds
   * @returns {number|null} SoC in percent, or null if no data
   */
  getActualSocForTime(timeMs) {
    return findClosestSample(this.socHistory, timeMs, 60 * 60 * 1000, 'soc');
  },

  /**
   * Record planned schedule for today's slots (i >= currentSlotInDay).
   * Preserves historical planned schedule for today's past slots AND yesterday's slots
   * so both 'today' and 'yesterday' charts display historical planned schedule vs actual performance.
   */
  async recordPlannedSchedule(strategyScheme, currentSlotInDay, totalDaySlots, dateStr) {
    if (!this.plannedScheduleStore || this.plannedScheduleStore.todayDateStr !== dateStr) {
      let stored = null;
      try {
        if (typeof this.getStoreValue === 'function') {
          stored = this.getStoreValue('plannedScheduleStore');
        }
      } catch {
        stored = null;
      }

      if (stored && stored.todayDateStr === dateStr) {
        this.plannedScheduleStore = stored;
      } else if (stored && stored.todaySchedule) {
        // Day rolled over: shift todaySchedule -> yesterdaySchedule
        this.plannedScheduleStore = {
          todayDateStr: dateStr,
          todaySchedule: {},
          yesterdaySchedule: stored.todaySchedule || {},
        };
      } else {
        this.plannedScheduleStore = { todayDateStr: dateStr, todaySchedule: {}, yesterdaySchedule: {} };
      }
    }

    if (strategyScheme) {
      for (let i = currentSlotInDay; i < totalDaySlots; i += 1) {
        const stratIdx = i - currentSlotInDay;
        const slotData = strategyScheme[stratIdx];
        if (slotData) {
          this.plannedScheduleStore.todaySchedule[i] = {
            power: slotData.power || 0,
            duration: slotData.duration || 0,
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
   * Shared charge-chart rendering pipeline for battery/evCharger devices. Builds the Today,
   * Tomorrow, Next Hours and Yesterday charge-chart images from a per-slot strategy scheme.
   *
   * Both drivers converge on this exact shape after computing their own device-specific
   * strategy (RoiStrategy for battery, EvChargeStrategy for evCharger) - only the strategy
   * engine itself, chargePower/dischargePower, and the live-SoC fallback for the current
   * partial slot differ between them. Everything below (slot index math, the four per-image
   * loops, the getChargeChart calls, and the display-settings-change rebuild gate) used to be
   * duplicated near-verbatim in both drivers' device.js - fix bugs here once, not per-driver.
   *
   * @param {object} scheme - dense per-slot object {0: {power,duration,soc,price,exportPrice,
   *   isForecast}, ...}, indexed relative to "now" (index 0 = current partial slot), covering
   *   at least the rest of today plus all of tomorrow. `isForecast` must already be set
   *   correctly per-slot by the caller (price-forecast flag, plus any driver-specific override
   *   such as evCharger's "car not connected" case) - this method only adds `isFuture`.
   * @param {number} chargePower
   * @param {number} dischargePower - 0 for evCharger (EVs don't discharge back)
   * @param {number|null} socFallback - live current SoC, overlaid onto the present slot when
   *   no historical sample exists yet (this.soc for battery, currentSoc for evCharger)
   * @param {boolean} showPower
   * @param {boolean} showSoc
   * @param {boolean} showExportPrice
   */
  async renderChargeCharts({
    scheme, chargePower, dischargePower, socFallback, showPower, showSoc, showExportPrice,
  }) {
    Object.keys(scheme).forEach((k) => {
      // The strategy is a forward-looking plan: none of it has executed yet, regardless of
      // whether the underlying price itself is a genuine forecast (isForecast).
      if (scheme[k] && typeof scheme[k] === 'object') scheme[k].isFuture = true;
    });

    // Day boundaries and slot counts come from real UTC midnights, so a 23/25-hour DST day gets
    // its true number of slots and every slot keeps its own timestamp.
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const periods = TimeHelpers.getUTCPeriods(tz);
    const { now, nowLocal } = periods;
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;
    const todayStartMs = periods.todayStart.getTime();
    const tomorrowStartMs = periods.tomorrowStart.getTime();
    const yesterdayStartMs = periods.yesterdayStart.getTime();
    const slotsBetween = (fromMs, toMs) => Math.round((toMs - fromMs) / intervalMs);
    const currentSlotInDay = Math.floor((now.getTime() - todayStartMs) / intervalMs);
    const totalDaySlots = slotsBetween(todayStartMs, tomorrowStartMs);
    const currentSlotStartMs = todayStartMs + (currentSlotInDay * intervalMs);

    // Keep the plan for getPlannedPowerSeries(): scheme[0] is the current price slot.
    // The ROI plan's first slot only runs from "now" (its startMinute) to the end of the slot, so its
    // duration must be spread over those minutes, not over the whole slot.
    this.latestPlan = {
      startMs: currentSlotStartMs,
      intervalMs,
      firstSlotMinutes: Math.max(1, (currentSlotStartMs + intervalMs - now.getTime()) / 60000),
      slots: Object.keys(scheme).map((k) => ({
        power: Number(scheme[k] && scheme[k].power) || 0,
        duration: Number(scheme[k] && scheme[k].duration) || 0,
      })),
    };

    const currency = (this.getSettings() && this.getSettings().currency) || this.currency || (this.settings && this.settings.currency) || '€';
    const translations = {
      price: this.homey.__('price') || 'Prijs',
      power: this.homey.__('power') || 'Vermogen',
      soc: this.homey.__('soc') || 'SoC',
    };

    // Today and Next Hours rebuild on every call, so they always reflect these settings
    // immediately. Tomorrow and Yesterday are cached (only rebuilt on date rollover / new
    // prices) and would otherwise keep showing a stale image - built with the old
    // showPower/showSoc/showExportPrice - until one of those unrelated triggers happens to
    // fire, which could be hours. Force a rebuild when the display settings themselves change.
    const chartDisplaySettingsKey = `${showPower}|${showSoc}|${showExportPrice}`;
    const chartDisplaySettingsChanged = this.lastChartDisplaySettingsKey !== chartDisplaySettingsKey;
    this.lastChartDisplaySettingsKey = chartDisplaySettingsKey;

    // 1. Image 1: Today (00:00 to 23:59 Today)
    const todayStrategy = {};
    const todayDateStr = nowLocal.toDateString();
    const todayExportPrices = [];
    await this.recordPlannedSchedule(scheme, currentSlotInDay, totalDaySlots, todayDateStr);

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
            // isForecast reflects whether the *price* for this slot is a genuine forecast (not
            // yet published market data) - independent of whether the slot has happened yet.
            isForecast: !!scheme[stratIdx].isForecast,
            // isFuture reflects whether the slot's plan has actually executed - drives the
            // SoC/power wash, unrelated to price origin. A slot that hasn't occurred is future.
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
      this.priceInterval,
      todayExportPrices,
      currency,
      translations,
      true,
      this.timeZone,
      showPower,
      showSoc,
      showExportPrice,
    );

    this.chartTodayCharge = chartToday;
    await this.todayChargeImage.update().catch((err) => this.error(err));

    // 2. Image 2: Tomorrow (00:00 to 23:59 Tomorrow) - only rebuild on date rollover, price
    // change, display-settings change, or initial render
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
          // Tomorrow is entirely a forward plan - never executed yet, regardless of the
          // slot's own isFuture (already true from the strategy scheme, kept explicit here).
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
        this.priceInterval,
        tomorrowExportPrices,
        currency,
        translations,
        false,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
      );

      this.chartTomorrowCharge = chartTomorrow;
      await this.tomorrowChargeImage.update().catch((err) => this.error(err));
    }

    // 3. Image 3: Next Hours (Rolling Window starting from the current slot)
    const chartNextHours = await getChargeChart(
      { scheme: JSON.stringify(scheme) },
      currentSlotStartMs,
      this.pricesNextHoursMarketLength,
      chargePower,
      dischargePower,
      this.priceInterval,
      this.exportPricesNextHours,
      currency,
      translations,
      false,
      this.timeZone,
      showPower,
      showSoc,
      showExportPrice,
    );
    this.chartNextHoursCharge = chartNextHours;
    await this.nextHoursChargeImage.update().catch((err) => this.error(err));

    // 4. Image 4: Yesterday (00:00 to 23:59 Yesterday) - only rebuild on date rollover,
    // display-settings change, or initial render
    if (dateRolledOver || chartDisplaySettingsChanged || !this.chartYesterdayCharge) {
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
        this.priceInterval,
        yesterdayExportPrices,
        currency,
        translations,
        false,
        this.timeZone,
        showPower,
        showSoc,
        showExportPrice,
      );

      this.chartYesterdayCharge = chartYesterday;
      await this.yesterdayChargeImage.update().catch((err) => this.error(err));
    }

    this.pricesUpdated = false;
  },

};
