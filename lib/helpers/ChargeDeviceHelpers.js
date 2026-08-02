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
   * Fetch yesterday's hourly prices from Homey Insights.
   * Searches all Insights logs for one ending with ':meter_price_h0' —
   * this capability is unique to DAP devices so no device-ID filter is needed.
   * The Insights log ID uses the Homey UUID, not the driver's getData().id
   * (biddingzone), so we cannot reliably filter by device ID here.
   */
  async _fetchDapPriceHistoryFromInsights() {
    const { api } = this.homey.app;
    if (!api) return;

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

    // Find the meter_price_h0 log entry for this DAP device in Insights
    const allLogs = await api.insights.getLogs().catch(() => []);
    const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);

    // DEBUG: log a sample of log IDs to understand the format
    this.log(`[PriceHistory] Total Insights logs: ${logs.length}`);
    const sampleIds = logs.slice(0, 5).map((l) => `id=${l.id} uri=${l.uri} name=${l.name}`);
    this.log(`[PriceHistory] Sample log entries: ${JSON.stringify(sampleIds)}`);
    const priceRelated = logs.filter((l) => {
      const id = l.id || l.uri || '';
      return id.includes('price') || (l.name && l.name.includes('price'));
    });
    this.log(`[PriceHistory] Price-related logs: ${JSON.stringify(priceRelated.map((l) => ({ id: l.id, uri: l.uri, name: l.name })))}`);

    // Find any Insights log ending with ':meter_price_h0' or containing 'meter_price_h0'
    const priceLog = logs.find((l) => {
      const id = l.id || l.uri || '';
      return id.endsWith(':meter_price_h0') || id.includes('meter_price_h0') || l.name === 'meter_price_h0';
    });

    if (!priceLog) {
      this.log('[PriceHistory] No meter_price_h0 Insights log found (DAP device may be too new or not logging)');
      return;
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

        this.log(`[PriceHistory] Resolution '${resStr}' returned ${data.values.length} total entries (${yesterdayCount} for yesterday)`);

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
      this.log('[PriceHistory] No meter_price_h0 data found in Insights for requested window');
      return;
    }

    // Convert Insights entries to price objects, filter to yesterday's window
    const priceHistory = [];
    for (const entry of entries) {
      const t = typeof entry.t === 'number' ? entry.t : new Date(entry.t).getTime();
      let v = null;
      if (typeof entry.v === 'number') v = entry.v;
      else if (typeof entry.y === 'number') v = entry.y;
      if (v === null || !Number.isFinite(t) || !Number.isFinite(v)) continue;
      if (t >= yesterdayStartMs - 30 * 60 * 1000 && t < todayStartMs + 30 * 60 * 1000) {
        priceHistory.push({ time: new Date(t), muPrice: v, price: v });
      }
    }

    if (priceHistory.length > 0) {
      priceHistory.sort((a, b) => a.time - b.time);
      this.dapPriceHistory = priceHistory;
      this.log(`[PriceHistory] Built ${priceHistory.length} yesterday price entries from Insights`);
    } else {
      this.log('[PriceHistory] Insights data found but none fell in yesterday window');
    }
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

    const findInList = (list) => {
      if (!Array.isArray(list) || list.length === 0) return null;

      // 1. Try exact slot interval match (pTime <= slotMs && pTime + intervalMs > slotMs)
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
      return match;
    };

    // 1. Try live prices (today / future)
    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.dapPrices;
    const liveMatch = findInList(liveList);
    if (liveMatch) {
      if (typeof liveMatch.muPrice === 'number') return liveMatch.muPrice;
      if (typeof liveMatch.price === 'number') return liveMatch.price;
    }

    // 2. Try yesterday prices from Insights
    const histMatch = findInList(this.dapPriceHistory);
    if (histMatch) {
      if (typeof histMatch.muPrice === 'number') return histMatch.muPrice;
      if (typeof histMatch.price === 'number') return histMatch.price;
    }

    // 3. Fallback
    return (this.pricesNextHours && this.pricesNextHours[0]) || 0.25;
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
