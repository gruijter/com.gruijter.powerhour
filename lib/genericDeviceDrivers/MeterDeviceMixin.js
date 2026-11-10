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
const SourceDeviceHelper = require('../helpers/SourceDeviceHelper');
const { setTimeoutPromise } = require('../helpers/Util');

// What the meter devices (generic_sum_device.js) and the charge devices (generic_bat_device.js)
// share, mixed into both prototypes (a subclass can still override and call super).
// No super calls in here: these are not class methods.

const MONEY_PERIODS = ['hour', 'day', 'month', 'year'];
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

  // The start of the year (setting start_date, 'ddmm') as this.startDay and this.startMonth
  // (January is month 0); 1 January on anything else.
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
