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

const { findClosestSample, averageSamplesInWindow, mergeStoredHistory } = require('./HistoryLookup');
const { getChargeChart } = require('../charts/ChargeChart');
const TimeHelpers = require('./TimeHelpers');
const PriceDrivers = require('./PriceDrivers');
const MoneyUnit = require('./MoneyUnit');
const LoadSpread = require('./LoadSpread');
const FileStore = require('./FileStore');
const InsightsHistory = require('./InsightsHistory');
const PriceProfile = require('../strategies/PriceProfile');
const PriceDeviceProfile = require('./PriceDeviceProfile');

const priceIndexes = new WeakMap();
const NEAR_MS = 55 * 60 * 1000;

const priceIndex = (list) => {
  const known = priceIndexes.get(list);
  if (known && known.length === list.length) return known;
  const order = [];
  list.forEach((p, i) => {
    const time = typeof p.time === 'number' ? p.time : new Date(p.time).getTime();
    if (!Number.isNaN(time)) order.push([time, i]);
  });
  order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const index = {
    length: list.length,
    times: Float64Array.from(order, (o) => o[0]),
    idx: Int32Array.from(order, (o) => o[1]),
  };
  priceIndexes.set(list, index);
  return index;
};

const lowerBound = (times, ms) => {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBound = (times, ms) => {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const PRICE_PROFILE_KEY = 'priceProfile';
const PLANNED_SCHEDULE_KEY = 'plannedScheduleStore';
const PRICE_BOOTSTRAP_VERSION = 2;
const PRICE_BOOTSTRAP_RETRY_MS = 6 * 60 * 60 * 1000;

module.exports = {

  _priceDeviceProfile() {
    const dev = this._profilePriceDevice();
    return dev ? dev.priceProfile : null;
  },

  _profilePriceDevice() {
    return this._groupPriceDevices().find((d) => d.driver.id === 'price' && PriceDeviceProfile.isReady(d.priceProfile)) || null;
  },

  async loadPriceProfile() {
    if (!this.ownPriceProfile) {
      const files = await FileStore.open(this, [PRICE_PROFILE_KEY]);
      this.ownPriceProfile = files.get(PRICE_PROFILE_KEY) || PriceProfile.createProfile();
    }
    this.priceProfile = this._priceDeviceProfile() || this.ownPriceProfile;
    return this.priceProfile;
  },

  async savePriceProfile() {
    (await FileStore.open(this)).set(PRICE_PROFILE_KEY, this.ownPriceProfile);
  },

  async bootstrapPriceProfile({ retrain = false } = {}) {
    await this.loadPriceProfile();
    const priceDevice = this._profilePriceDevice();
    if (priceDevice) {
      if (retrain) await PriceDeviceProfile.bootstrap(priceDevice, { force: true });
      await this.loadPriceProfile();
      return;
    }
    if (!retrain && this.ownPriceProfile.bootstrapped === PRICE_BOOTSTRAP_VERSION) return;
    if (!retrain && Date.now() - (this.priceBootstrapTm || 0) < PRICE_BOOTSTRAP_RETRY_MS) return;
    const { api } = this.homey.app;
    if (!api) return;
    this.priceBootstrapTm = Date.now();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const hourly = async (capName) => {
      let best = [];
      for (const logId of this._groupPriceLogIds(capName)) {
        const values = (await InsightsHistory.fetchHistory(api, logId, ['last7Days', 'last14Days'])).filter((e) => !e.coarse);
        if (values.length > best.length) best = values;
      }
      return best;
    };
    const imp = await hourly(PriceDrivers.PRICE_LOG_CAPS.import);
    if (!imp.length) return;
    const exp = new Map((await hourly(PriceDrivers.PRICE_LOG_CAPS.export)).map((e) => [e.t, e.v]));
    const fresh = PriceProfile.createProfile();
    PriceProfile.learn(fresh, imp.map((e) => ({ time: e.t, price: e.v, exportPrice: exp.get(e.t) })), tz);
    fresh.bootstrapped = PRICE_BOOTSTRAP_VERSION;
    this.ownPriceProfile = fresh;
    this.priceProfile = fresh;
    await this.savePriceProfile();
    this.log(`[Price Profile] bootstrapped from ${imp.length} hourly prices`);
  },

  async learnPriceProfile(fromNow, slotStartMs, intervalMin, tz) {
    await this.loadPriceProfile();
    const entries = [];
    (fromNow.prices || []).forEach((price, i) => {
      if (fromNow.isForecast && fromNow.isForecast[i]) return;
      entries.push({
        time: slotStartMs + i * intervalMin * 60 * 1000,
        price,
        exportPrice: fromNow.exportPrices ? fromNow.exportPrices[i] : undefined,
      });
    });
    if (this.priceProfile !== this.ownPriceProfile) return entries;
    const own = this.ownPriceProfile;
    const before = `${own.lastLearnedMs}|${JSON.stringify(own.dailyMin || {})}`;
    PriceProfile.learn(own, entries, tz);
    const after = `${own.lastLearnedMs}|${JSON.stringify(own.dailyMin || {})}`;
    if (after !== before) await this.savePriceProfile();
    return entries;
  },

  expectedPriceFn(known, tz, now) {
    if (PriceProfile.isEmpty(this.priceProfile)) return null;
    const level = PriceProfile.level(this.priceProfile, known, tz, now);
    return (ms) => PriceProfile.expected(this.priceProfile, ms, tz, level);
  },

  _priceOrderKey(driverId, settings) {
    return PriceDrivers.intervalOf(driverId, settings) === (this.priceInterval || 60) ? 0 : 1;
  },

  _groupPriceDevices() {
    const group = this.getSettings().tariff_update_group;
    return PriceDrivers.getDevices(this.homey, { commodity: 'power' })
      .filter((d) => d.getSettings().tariff_update_group === group)
      .map((d, i) => ({ d, i, k: this._priceOrderKey(d.driver.id, d.getSettings()) }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map(({ d }) => d);
  },

  _groupPriceLogIds(capNames) {
    const group = this.getSettings().tariff_update_group;
    const names = [].concat(capNames);
    return PriceDrivers.getDevices(this.homey, { commodity: 'power' })
      .filter((d) => d.getSettings().tariff_update_group === group || d.getStoreValue(PriceDrivers.TAKEN_OVER_GROUP_KEY) === group)
      .map((d, i) => ({ d, i, k: this._priceOrderKey(d.driver.id, d.getSettings()) }))
      .sort((a, b) => (a.k - b.k) || (a.i - b.i))
      .map(({ d }) => {
        const cap = names.find((name) => d.hasCapability(name));
        return cap ? `homey:device:${d.getId()}:${cap}` : null;
      })
      .filter(Boolean);
  },

  async refreshGroupPrices() {
    const priceDev = this._groupPriceDevices().find((d) => Array.isArray(d.prices) && d.prices.length > 0);
    this.groupPrices = priceDev ? priceDev.prices : null;

    if (this.homey && this.homey.app && this.homey.app.api) {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const today = TimeHelpers.toLocalDate(new Date(), tz).toDateString();
      const attempt = this.groupPriceHistoryAttempt || {};
      const yesterdayStartMs = TimeHelpers.getUTCPeriods(tz).yesterdayStart.getTime();
      const haveHistory = !this.groupPriceHistoryPartial && Array.isArray(this.groupPriceHistory)
        && this.groupPriceHistory.some((e) => new Date(e.time).getTime() >= yesterdayStartMs);
      const retryDue = !attempt.tm || (Date.now() - attempt.tm) > 60 * 60 * 1000;
      if (attempt.day !== today || (!haveHistory && retryDue)) {
        this.groupPriceHistoryAttempt = { day: today, tm: Date.now() };
        const before = this.groupPriceHistory;
        await this._fetchGroupPriceHistory().catch(() => {});
        if (this.groupPriceHistory !== before) this.groupPriceHistoryRefreshed = true;
      }
    }
  },

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
      this.log(`[PriceHistory] No ${capName} Insights log found (price device may be too new or not logging)`);
      return null;
    }

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

  async _fetchGroupPriceHistory() {
    const { app } = this.homey;
    if (!app || !app.api) return;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const day = TimeHelpers.getUTCPeriods(tz).yesterdayStart.getTime();
    const shared = await app.getSharedDaily(`priceHistory|${this.getSettings().tariff_update_group}`, day, async () => {
      const imp = await this._fetchInsightsPriceHistory(PriceDrivers.PRICE_LOG_CAPS.import);
      const exp = await this._fetchInsightsPriceHistory(PriceDrivers.PRICE_LOG_CAPS.export);
      if (!imp && !exp) return null;
      const expected = (cap) => this._groupPriceLogIds(cap).length > 0;
      const partial = (!imp && expected(PriceDrivers.PRICE_LOG_CAPS.import)) || (!exp && expected(PriceDrivers.PRICE_LOG_CAPS.export));
      return { imp, exp, partial };
    });
    if (shared) this.groupPriceHistoryPartial = !!shared.partial;
    const importHistory = shared && shared.imp;
    const exportHistory = shared && shared.exp;
    if (importHistory) {
      this.groupPriceHistory = importHistory.map((e) => ({ time: e.time, muPrice: e.value, price: e.value }));
    }

    if (exportHistory) {
      this.groupExportPriceHistory = exportHistory.map((e) => ({ time: e.time, exportPrice: e.value }));
    }
  },

  _findPriceEntryForSlot(list, slotMs, intervalMs) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const { times, idx } = priceIndex(list);

    let best = -1;
    const end = upperBound(times, slotMs);
    for (let j = upperBound(times, slotMs - intervalMs); j < end; j += 1) {
      if (best < 0 || idx[j] < best) best = idx[j];
    }
    if (best >= 0) return list[best];

    let bestDiff = Infinity;
    const stop = lowerBound(times, slotMs + intervalMs + NEAR_MS);
    for (let j = upperBound(times, slotMs - NEAR_MS); j < stop; j += 1) {
      const t = times[j];
      const diff = Math.min(Math.abs(t - slotMs), Math.abs(t - (slotMs + intervalMs)), Math.abs(t - (slotMs + intervalMs / 2)));
      if (diff < NEAR_MS && (diff < bestDiff || (diff === bestDiff && idx[j] < best))) {
        bestDiff = diff;
        best = idx[j];
      }
    }
    return best >= 0 ? list[best] : null;
  },

  getPriceForTimestamp(slotMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;

    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.groupPrices;
    const liveMatch = this._findPriceEntryForSlot(liveList, slotMs, intervalMs);
    if (liveMatch) {
      if (typeof liveMatch.muPrice === 'number') return liveMatch.muPrice;
      if (typeof liveMatch.price === 'number') return liveMatch.price;
    }

    const histMatch = this._findPriceEntryForSlot(this.groupPriceHistory, slotMs, intervalMs);
    if (histMatch) {
      if (typeof histMatch.muPrice === 'number') return histMatch.muPrice;
      if (typeof histMatch.price === 'number') return histMatch.price;
    }

    const { prices } = this.pricesFromNow();
    return (prices && prices[0]) || 0.25;
  },

  getExportPriceForTimestamp(slotMs) {
    const intervalMs = (this.priceInterval || 60) * 60 * 1000;

    const liveList = (this.sourceDevice && Array.isArray(this.sourceDevice.prices) && this.sourceDevice.prices.length > 0)
      ? this.sourceDevice.prices
      : this.groupPrices;
    const liveMatch = this._findPriceEntryForSlot(liveList, slotMs, intervalMs);
    if (liveMatch && typeof liveMatch.exportPrice === 'number') return liveMatch.exportPrice;

    const histMatch = this._findPriceEntryForSlot(this.groupExportPriceHistory, slotMs, intervalMs);
    if (histMatch && typeof histMatch.exportPrice === 'number') return histMatch.exportPrice;

    return null;
  },

  getActualPowerForTime(timeMs) {
    const intervalMs = this.planIntervalMin() * 60 * 1000;
    const avg = averageSamplesInWindow(this.powerHistory, timeMs, timeMs + intervalMs, 'power');
    if (avg !== null) return avg;
    return findClosestSample(this.powerHistory, timeMs, 60 * 60 * 1000, 'power');
  },

  notifyChargePlanUpdated() {
    try {
      this.homey.drivers.getDriver('grid').getDevices().forEach((dev) => {
        if (typeof dev.onChargePlanUpdated === 'function') dev.onChargePlanUpdated();
      });
    } catch {
    }
  },

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

  async loadStoredHistory(key) {
    const files = await FileStore.open(this, [key]);
    return mergeStoredHistory(files.get(key), this[key], 2880);
  },

  getActualSocForTime(timeMs) {
    return findClosestSample(this.socHistory, timeMs, 60 * 60 * 1000, 'soc');
  },

  async recordPlannedSchedule(planScheme, currentSlotInDay, totalDaySlots, dateStr) {
    const intervalMin = this.planIntervalMin();
    if (!this.plannedScheduleStore || this.plannedScheduleStore.todayDateStr !== dateStr
      || this.plannedScheduleStore.intervalMin !== intervalMin) {
      const stored = (await FileStore.open(this, [PLANNED_SCHEDULE_KEY])).get(PLANNED_SCHEDULE_KEY) || null;
      if (stored) {
        [stored.todaySchedule, stored.yesterdaySchedule].forEach((sched) => Object.values(sched || {}).forEach((slot) => {
          if (slot && slot.block === 'zero') slot.block = 'xom';
        }));
      }

      const fits = stored && (stored.intervalMin || this.priceInterval || 60) === intervalMin;
      if (fits && stored.todayDateStr === dateStr) {
        this.plannedScheduleStore = stored;
      } else if (fits && stored.todaySchedule) {
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

    if (planScheme) {
      for (let i = currentSlotInDay; i < totalDaySlots; i += 1) {
        const planIdx = i - currentSlotInDay;
        const slotData = planScheme[planIdx];
        if (slotData) {
          this.plannedScheduleStore.todaySchedule[i] = {
            power: slotData.power || 0,
            duration: slotData.duration || 0,
            ...(slotData.block ? { block: slotData.block } : {}),
          };
        }
      }
      (await FileStore.open(this)).set(PLANNED_SCHEDULE_KEY, this.plannedScheduleStore);
    }
  },

  getPlannedScheduleForSlot(slotIndex, isYesterday = false) {
    const store = this.plannedScheduleStore;
    if (!store) return { power: 0, duration: 0 };
    const sched = isYesterday ? store.yesterdaySchedule : store.todaySchedule;
    if (sched && sched[slotIndex]) {
      return sched[slotIndex];
    }
    return { power: 0, duration: 0 };
  },

  async applyPlan({ scheme, planTm = Date.now(), planSlots }) {
    const periods = TimeHelpers.getUTCPeriods(this.timeZone || this.homey.clock.getTimezone());
    const { now, nowLocal } = periods;
    const intervalMs = this.planIntervalMin() * 60 * 1000;
    const todayStartMs = periods.todayStart.getTime();
    const currentSlotInDay = Math.floor((now.getTime() - todayStartMs) / intervalMs);
    const totalDaySlots = Math.round((periods.tomorrowStart.getTime() - todayStartMs) / intervalMs);
    const currentSlotStartMs = todayStartMs + (currentSlotInDay * intervalMs);

    this.latestPlan = {
      startMs: currentSlotStartMs,
      planTm,
      startSoc: typeof this.soc === 'number' ? this.soc : null,
      intervalMs,
      firstSlotMinutes: Math.max(1, (currentSlotStartMs + intervalMs - Math.max(planTm, currentSlotStartMs)) / 60000),
      slots: Object.keys(scheme).slice(0, planSlots).map((k) => ({
        power: Number(scheme[k] && scheme[k].power) || 0,
        duration: Number(scheme[k] && scheme[k].duration) || 0,
        solarExtra: !!(scheme[k] && scheme[k].solarExtra),
        block: (scheme[k] && scheme[k].block) || null,
        noCharge: !!(scheme[k] && scheme[k].noCharge),
        minSolarW: (scheme[k] && scheme[k].minSolarW) || 0,
        quiet: !!(scheme[k] && scheme[k].quiet),
        soc: scheme[k] && typeof scheme[k].soc === 'number' ? scheme[k].soc : null,
      })),
    };
    this.notifyChargePlanUpdated();
    await this.recordPlannedSchedule(scheme, currentSlotInDay, totalDaySlots, nowLocal.toDateString());
    return periods;
  },

  async renderChargeCharts({
    scheme, periods = null, chargePower, dischargePower, socFallback, showPower, showSoc, showExportPrice, showLegend = false,
  }) {
    Object.keys(scheme).forEach((k) => {
      if (scheme[k] && typeof scheme[k] === 'object') scheme[k].isFuture = true;
    });

    const tz = this.timeZone || this.homey.clock.getTimezone();
    const { now, nowLocal, ...at } = periods || TimeHelpers.getUTCPeriods(tz);
    const intervalMs = this.planIntervalMin() * 60 * 1000;
    const todayStartMs = at.todayStart.getTime();
    const tomorrowStartMs = at.tomorrowStart.getTime();
    const yesterdayStartMs = at.yesterdayStart.getTime();
    const slotsBetween = (fromMs, toMs) => Math.round((toMs - fromMs) / intervalMs);
    const currentSlotInDay = Math.floor((now.getTime() - todayStartMs) / intervalMs);
    const totalDaySlots = slotsBetween(todayStartMs, tomorrowStartMs);
    const currentSlotStartMs = todayStartMs + (currentSlotInDay * intervalMs);
    const todayDateStr = nowLocal.toDateString();

    const chartDevice = this.driver.id === 'evCharger' ? 'ev' : 'battery';
    const draw = async () => {
      const { currency } = MoneyUnit.get(this);
      if (!this.chartDays) this.chartDays = {};
      const keep = (day, plan, startMs, marketLength, exportPrices) => {
        this.chartDays[day] = {
          startMs,
          intervalMin: this.planIntervalMin(),
          marketLength,
          maxChargePower: chargePower,
          maxDischargePower: dischargePower,
          slots: Object.keys(plan).map((k) => plan[k]),
          exportPrices: exportPrices || [],
        };
      };
      const translations = {
        price: this.homey.__('price') || 'Prijs',
        power: this.homey.__('power') || 'Vermogen',
        soc: this.homey.__('soc') || 'SoC',
        legend: Object.fromEntries(['xom', 'hold', 'charge', 'discharge'].map((key) => [key, this.homey.__(`chart_legend.${key}`)])),
      };

      const chartDisplaySettingsKey = `${showPower}|${showSoc}|${showExportPrice}|${showLegend}`;
      const chartDisplaySettingsChanged = this.lastChartDisplaySettingsKey !== chartDisplaySettingsKey;
      this.lastChartDisplaySettingsKey = chartDisplaySettingsKey;

      const todayPlan = {};
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
          todayPlan[i] = {
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
          const planIdx = i - currentSlotInDay;
          if (scheme && scheme[planIdx]) {
            todayPlan[i] = {
              ...scheme[planIdx],
              actualPower: isPastOrPresent ? actualP : (scheme[planIdx].actualPower || null),
              soc: isPastOrPresent && actualSoc !== null ? actualSoc : (scheme[planIdx].soc || null),
              isForecast: !!scheme[planIdx].isForecast,
              isFuture: !isPastOrPresent,
            };
          } else {
            todayPlan[i] = {
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
        { scheme: JSON.stringify(todayPlan) },
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
        chartDevice,
      );

      this.chartTodayCharge = chartToday;
      keep('today', todayPlan, todayStartMs, totalDaySlots, todayExportPrices);
      await this.todayChargeImage.update().catch((err) => this.error(err));

      const dateRolledOver = !this.lastRenderedDateStr || (this.lastRenderedDateStr !== todayDateStr);
      this.lastRenderedDateStr = todayDateStr;

      if (dateRolledOver || this.pricesUpdated || chartDisplaySettingsChanged || !this.chartTomorrowCharge) {
        const tomorrowPlan = {};
        const remainingTodaySlots = totalDaySlots - currentSlotInDay;
        const tomorrowSlots = slotsBetween(tomorrowStartMs, at.tomorrowEnd.getTime());
        const tomorrowExportPrices = [];

        for (let i = 0; i < tomorrowSlots; i += 1) {
          const planIdx = remainingTodaySlots + i;
          if (scheme && scheme[planIdx]) {
            tomorrowPlan[i] = { ...scheme[planIdx], isFuture: true };
          } else {
            tomorrowPlan[i] = {
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
          { scheme: JSON.stringify(tomorrowPlan) },
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
          chartDevice,
        );

        this.chartTomorrowCharge = chartTomorrow;
        keep('tomorrow', tomorrowPlan, tomorrowStartMs, tomorrowSlots, tomorrowExportPrices);
        await this.tomorrowChargeImage.update().catch((err) => this.error(err));
      }

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
        chartDevice,
      );
      this.chartNextHoursCharge = chartNextHours;
      keep('next', scheme, currentSlotStartMs, marketLength, toPlanSlots(fromNow.exportPrices));
      await this.nextHoursChargeImage.update().catch((err) => this.error(err));

      if (dateRolledOver || chartDisplaySettingsChanged || this.groupPriceHistoryRefreshed || !this.chartYesterdayCharge) {
        this.groupPriceHistoryRefreshed = false;
        const yesterdaySlots = slotsBetween(yesterdayStartMs, todayStartMs);
        const yesterdayPlan = {};
        const yesterdayExportPrices = [];

        for (let i = 0; i < yesterdaySlots; i += 1) {
          const slotStartMs = yesterdayStartMs + (i * intervalMs);
          let actualP = this.getActualPowerForTime(slotStartMs);
          if (actualP === null) actualP = 0;
          const actualSocYesterday = this.getActualSocForTime(slotStartMs);
          const slotPrice = this.getPriceForTimestamp(slotStartMs);
          const planned = this.getPlannedScheduleForSlot(i, true);
          yesterdayExportPrices[i] = this.getExportPriceForTimestamp(slotStartMs);

          yesterdayPlan[i] = {
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
          { scheme: JSON.stringify(yesterdayPlan) },
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
          chartDevice,
        );

        this.chartYesterdayCharge = chartYesterday;
        keep('yesterday', yesterdayPlan, yesterdayStartMs, yesterdaySlots, yesterdayExportPrices);
        await this.yesterdayChargeImage.update().catch((err) => this.error(err));
      }

      this.pricesUpdated = false;
    };
    return LoadSpread.run(this, 'chargeCharts', draw);
  },

};
