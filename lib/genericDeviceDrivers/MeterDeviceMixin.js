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

const MeterHelpers = require('../helpers/MeterHelpers');
const BudgetSetup = require('../helpers/BudgetSetup');
const ContractYear = require('../helpers/ContractYear');
const HistoryRestore = require('../helpers/HistoryRestore');
const TimeHelpers = require('../helpers/TimeHelpers');
const SourceDeviceHelper = require('../helpers/SourceDeviceHelper');
const { setTimeoutPromise } = require('../helpers/Util');

// What the meter devices (generic_sum_device.js) and the charge devices (generic_bat_device.js)
// share, mixed into both prototypes (a subclass can still override and call super).
// No super calls in here: these are not class methods.

// contract: only on a main meter with a contract start (capability meter_money_this_contract).
const MONEY_PERIODS = ['hour', 'day', 'month', 'year', 'contract'];
const capitalize = (name) => name[0].toUpperCase() + name.slice(1);

module.exports = {

  // A restart waits for a running init, so two inits never run at the same time. stopPolling() and
  // flushStore() of the devices that have them.
  async restartDevice(delay) {
    if (this.restarting) return;
    this.restarting = true;
    if (typeof this.stopPolling === 'function') this.stopPolling();
    this.destroyListeners();
    const dly = delay || 2000;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly, this);
    if (this.initRunning) await this.initRunning.catch(() => null);
    // onInit() reads the store again: throttled state not yet written would be lost.
    if (!this.isDestroyed && typeof this.flushStore === 'function') await this.flushStore().catch((err) => this.error(err));
    if (!this.isDestroyed) await this.onInit().catch((err) => this.error(err));
  },

  destroyListeners() {
    if (this.capabilityInstances && Object.entries(this.capabilityInstances).length > 0) {
      Object.entries(this.capabilityInstances).forEach((entry) => {
        this.log(`Destroying capability listener ${entry[0]}`);
        entry[1].destroy();
      });
    }
    this.capabilityInstances = {};
  },

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      if (value !== this.getCapabilityValue(capability)) {
        return this.setCapabilityValue(capability, value)
          .catch((error) => {
            this.error(error, capability, value);
          });
      }
    }
    return Promise.resolve();
  },

  async runFlowAction(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Action ${id} not implemented`);
  },

  async runFlowCondition(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Condition ${id} not implemented`);
  },

  async runFlowTrigger(id, args) {
    if (this.flows[id]) return this.flows[id](args);
    throw new Error(`Trigger ${id} not implemented`);
  },

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  },

  async getReadingObject(value) {
    const date = new Date();
    return MeterHelpers.getReadingObject(value, date, this.timeZone);
  },

  // Calendar months and years (this.startDay 1, this.startMonth 0), and the contract start of a
  // main meter (this.contractStart, ContractYear). A device that counted from another year start
  // (setting start_date or store contractStart, up to v9.0.3) moves once: month and year to the
  // calendar starts (Insights); a main meter with that start as contract keeps its year as contract year.
  async followPeriodStarts() {
    if (!this.timeZone) this.timeZone = this.homey.clock.getTimezone();
    if (!this.lastReadingMonth) this.lastReadingMonth = this.getStoreValue('lastReadingMonth');
    if (!this.lastReadingYear) this.lastReadingYear = this.getStoreValue('lastReadingYear');
    this.readStartDate(ContractYear.DEFAULT);
    this.contractStart = ContractYear.contractStart(this.driver.id, this.getSettings());
    if (this.getStoreValue('periodStart') !== ContractYear.DEFAULT) {
      const previous = this.getStoreValue('contractStart')
        || BudgetSetup.validStartDate(this.getSettings().start_date) || ContractYear.DEFAULT;
      if (previous !== ContractYear.DEFAULT && this.lastReadingMonth && this.lastReadingYear) {
        this.log(`${this.getName()}: year start ${previous} -> 1 January`);
        if (this.contractStart === previous && typeof this.keepYearAsContract === 'function') await this.keepYearAsContract();
        await ContractYear.serial(() => this.rebasePeriods());
        if (typeof this.onPeriodsRebased === 'function') await this.onPeriodsRebased().catch((err) => this.error(err));
      }
      await this.setStoreValue('periodStart', ContractYear.DEFAULT);
      if (this.getStoreValue('contractStart')) await this.unsetStoreValue('contractStart');
    }
    if (typeof this.followContract === 'function') await this.followContract();
  },

  // The own meter's capabilities in Insights (also from before a rename).
  ownMeterCaps() {
    const own = (this.ds && this.ds.cmap && this.ds.cmap.meter_source) || 'meter_power_hidden';
    const renamed = Object.entries((this.driver.ds && this.driver.ds.energyCaps) || {}).flat().filter((cap) => cap.startsWith('meter'));
    return [...new Set([own, ...renamed])];
  },

  async rebasePeriods() {
    const old = { month: this.lastReadingMonth, year: this.lastReadingYear };
    const nowLocal = TimeHelpers.toLocalDate(new Date(), this.timeZone);
    const kept = MeterHelpers.keepPeriods(this.lastReadingMonth, this.lastReadingYear, nowLocal);
    const starts = HistoryRestore.periodStarts(nowLocal, this.startDay, this.startMonth, this.timeZone);
    let api = null;
    try {
      api = this.homey.app.api;
    } catch {
      // not ready
    }
    const caps = this.ownMeterCaps();
    const cache = new Map();
    const at = (ms) => (api ? ContractYear.meterAt(api, this.getId(), caps, ms, { cache }).catch(() => null) : null);
    const lastKwh = {};
    for (const period of ['month', 'year']) {
      const [prevMs, ms] = starts[period];
      const value = await at(ms);
      const reading = typeof value === 'number' ? MeterHelpers.getReadingObject(value, new Date(ms), this.timeZone) : kept[period];
      this.log(`${this.getName()}: ${period} from ${new Date(ms).toISOString()}: ${typeof value === 'number' ? value.toFixed(3) : 'kept'}`);
      if (period === 'month') this.lastReadingMonth = reading;
      else this.lastReadingYear = reading;
      const prev = typeof value === 'number' ? await at(prevMs) : null;
      if (typeof prev === 'number') lastKwh[period] = value - prev;
    }
    await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
    await this.setStoreValue('lastReadingYear', this.lastReadingYear);
    await this.rebaseMoney(old).catch((err) => this.error(err));
    await this.rebaseLastPeriods(lastKwh).catch((err) => this.error(err));
  },

  // The last month and year after a move to other starts: kWh from Insights, the money scaled with it.
  async rebaseLastPeriods(lastKwh) {
    const cmap = (this.ds && this.ds.cmap) || {};
    const oldKwh = {};
    for (const period of ['month', 'year']) {
      const cap = cmap[`last_${period}`];
      if (!cap || typeof lastKwh[period] !== 'number') continue;
      oldKwh[period] = this.getCapabilityValue(cap);
      await this.setCapability(cap, Math.round(lastKwh[period] * 10000) / 10000);
    }
    await this.rebaseLastMoney(oldKwh, lastKwh);
  },

  // The last month and year money: the energy part scaled with the kWh (same average price), the
  // markups of a full period kept. Not for a net meter (battery; grid: rebaseSplitLastMoney()).
  async rebaseLastMoney(oldKwh, newKwh, { energyDelta = null } = {}) {
    if (this.driver.id === 'battery' || !this.hasCapability('meter_money_last_month')) return;
    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities((this.ds && this.ds.cmap && this.ds.cmap.meter_source) || 'meter_power_hidden');
    const fixed = this.fullPeriodFixedMoney();
    for (const period of ['month', 'year']) {
      const key = `last${capitalize(period)}`;
      const money = this.meterMoney[key];
      if (typeof money !== 'number') continue;
      let next;
      if (energyDelta) {
        if (typeof energyDelta[period] !== 'number') continue;
        next = money + energyDelta[period];
      } else {
        const ratio = newKwh[period] / oldKwh[period];
        if (!Number.isFinite(ratio) || ratio < 0) continue;
        next = ((money - fixed[period]) * ratio) + fixed[period];
      }
      this.meterMoney[key] = next;
      await this.setCapability(`meter_money_last_${period}`, next);
    }
  },

  // The markups of the last full calendar month and year.
  fullPeriodFixedMoney() {
    const { markup_hour: hour = 0, markup_day: day = 0, markup_month: month = 0 } = this.getSettings();
    const nowLocal = TimeHelpers.toLocalDate(new Date(), this.timeZone);
    const monthDays = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 0).getDate();
    const year = nowLocal.getFullYear() - 1;
    const yearDays = (new Date(year + 1, 0, 1) - new Date(year, 0, 1)) / (24 * 3600 * 1000);
    return {
      month: month + (monthDays * (day + (24 * hour))),
      year: (12 * month) + (yearDays * (day + (24 * hour))),
    };
  },

  // The month and year money after a rebase from old (the readings before): the energy part scaled
  // with the kWh (same average price), the fixed costs booked since the new start. Not for a net
  // meter, where the kWh says nothing about the money (battery; grid: rebaseSplitMoney()).
  async rebaseMoney(old, { energyDelta = null } = {}) {
    if (this.driver.id === 'battery' || !this.hasCapability('meter_money_this_month')) return;
    // A rebase at init runs before these are loaded.
    if (!this.meterMoney) this.meterMoney = this.meterMoneyFromCapabilities((this.ds && this.ds.cmap && this.ds.cmap.meter_source) || 'meter_power_hidden');
    if (!this.fixedMoney && this.getStoreValue('fixedMoney')) this.fixedMoney = this.getStoreValue('fixedMoney');
    const now = this.meterMoney.meterValue;
    if (typeof now !== 'number') return;
    const since = this.getStoreValue('moneySince');
    const kwh = (base) => (typeof since === 'number' && base.meterValue < since ? now - since : now - base.meterValue);
    const fixed = { month: 0, year: 0, ...(this.fixedMoney || {}) };
    const newFixed = this.fixedMoney && typeof this.estimateFixedMoney === 'function' ? this.estimateFixedMoney() : fixed;
    const money = { ...this.meterMoney };
    const bases = { month: this.lastReadingMonth, year: this.lastReadingYear };
    for (const period of ['month', 'year']) {
      const before = old[period];
      const after = bases[period];
      if (!before || !after || typeof before.meterValue !== 'number' || before.meterValue === after.meterValue) continue;
      let energy = money[period] - (fixed[period] || 0);
      if (energyDelta) {
        energy += energyDelta[period] || 0;
      } else {
        const ratio = kwh(after) / kwh(before);
        if (!Number.isFinite(ratio) || ratio < 0) continue;
        energy *= ratio;
      }
      money[period] = energy + (newFixed[period] || 0);
      fixed[period] = newFixed[period] || 0;
      await this.setCapability(`meter_money_this_${period}`, money[period]);
    }
    this.meterMoney = money;
    if (this.fixedMoney) {
      this.fixedMoney = fixed;
      await this.setStoreValue('fixedMoney', fixed);
    }
    if (typeof this.updateAvgMoney === 'function') await this.updateAvgMoney();
    this.log(`${this.getName()}: money rebased`, { month: money.month, year: money.year });
  },

  // 'ddmm' as this.startDay and this.startMonth (January is month 0); 1 January on anything else.
  readStartDate(ddmm) {
    const text = ddmm && ddmm.length === 4 ? ddmm : '0101';
    this.startDay = Number(text.slice(0, 2));
    this.startMonth = Number(text.slice(2, 4));
    if (!this.startDay || (this.startDay > 31)) this.startDay = 1;
    if (!this.startMonth || (this.startMonth > 12)) this.startMonth = 1;
    this.startMonth -= 1;
  },

  // The money totals as the capabilities hold them, with the meter value they were counted to.
  meterMoneyFromCapabilities(meterCap) {
    const money = { meterValue: this.getCapabilityValue(meterCap) };
    MONEY_PERIODS.forEach((name) => {
      money[name] = this.getCapabilityValue(`meter_money_this_${name}`);
      money[`last${capitalize(name)}`] = this.getCapabilityValue(`meter_money_last_${name}`);
    });
    return money;
  },

  // A new hour, day, month or year: its money so far becomes the last one's (capability
  // meter_money_last_*), the running total starts at 0. Returns the periods rolled.
  async rollMoneyPeriods(meterMoney, periods) {
    const rolled = MONEY_PERIODS.filter((name) => periods[`new${capitalize(name)}`]);
    for (const name of rolled) {
      meterMoney[`last${capitalize(name)}`] = meterMoney[name];
      meterMoney[name] = 0;
      await this.setCapability(`meter_money_last_${name}`, meterMoney[`last${capitalize(name)}`]);
    }
    return rolled;
  },

};
