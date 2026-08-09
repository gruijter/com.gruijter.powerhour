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
          } catch (e) {
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
      } catch (err) {
        // ignore
      }
    }

    // Fetch yesterday price history from Homey Insights
    // meter_price_h0 is unique to DAP devices so no device ID filtering needed
    if (this.homey && this.homey.app && this.homey.app.api) {
      await this._fetchDapPriceHistoryFromInsights().catch(() => {});
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
  async _fetchInsightsPriceHistory(capName) {
    const { api } = this.homey.app;
    if (!api) return null;

    // Calculate yesterday window in local time
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const todayStartMs = now.getTime()
      - (nowLocal.getHours() * 3600000)
      - (nowLocal.getMinutes() * 60000)
      - (nowLocal.getSeconds() * 1000)
      - nowLocal.getMilliseconds();
    const yesterdayStartMs = todayStartMs - (24 * 60 * 60 * 1000);

    const allLogs = await api.insights.getLogs().catch(() => []);
    const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);

    const priceLog = logs.find((l) => {
      const id = l.id || l.uri || '';
      return id.endsWith(`:${capName}`) || id.includes(capName) || l.name === capName;
    });

    if (!priceLog) {
      this.log(`[PriceHistory] No ${capName} Insights log found (DAP device may be too new or not logging)`);
      return null;
    }
    this.log(`[PriceHistory] Found Insights log: id=${priceLog.id} uri=${priceLog.uri} name=${priceLog.name}`);

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
    const importHistory = await this._fetchInsightsPriceHistory('meter_price_h0');
    if (importHistory) {
      this.dapPriceHistory = importHistory.map((e) => ({ time: e.time, muPrice: e.value, price: e.value }));
      this.log(`[PriceHistory] Built ${this.dapPriceHistory.length} yesterday price entries from Insights`);
    }

    const exportHistory = await this._fetchInsightsPriceHistory('meter_price_h0_export');
    if (exportHistory) {
      this.dapExportPriceHistory = exportHistory.map((e) => ({ time: e.time, exportPrice: e.value }));
      this.log(`[PriceHistory] Built ${this.dapExportPriceHistory.length} yesterday export price entries from Insights`);
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
   * Find the closest power reading in this.powerHistory for a given time.
   * Only considers entries within 1 hour of the requested time.
   *
   * @param {number} timeMs - Unix timestamp in milliseconds
   * @returns {number|null} power in watts, or null if no data
   */
  getActualPowerForTime(timeMs) {
    if (!Array.isArray(this.powerHistory) || this.powerHistory.length === 0) {
      return null;
    }
    const candidates = this.powerHistory.filter((d) => Math.abs(d.time - timeMs) < 60 * 60 * 1000);
    if (candidates.length === 0) return null;
    const closest = candidates.sort((a, b) => Math.abs(a.time - timeMs) - Math.abs(b.time - timeMs))[0];
    return typeof closest.power === 'number' ? closest.power : null;
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
      } catch (e) {
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
      } catch (e) {
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

};
