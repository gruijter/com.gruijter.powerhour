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

const GenericDevice = require('../../lib/generic_sum_device');
const SourceDeviceHelper = require('../../lib/SourceDeviceHelper');

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
  },
};
// p1 consumption counter (low/all tariff).
// p2 consumption counter (high tariff).
// n1 returned counter (low/all tariff).
// n2 returned counter (high tariff).
// total energy counter = p1+p2-n1-n2

class PowerDevice extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  // device specific stuff below
  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async addSourceCapGroup() {
    // setup if/how a HOMEY-API source device fits to a defined capability group
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters
    this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible meter_power capabilities ${this.sourceDevice.capabilities}`);
    }
  }

  async addListeners() {
    if (!this.homey.app.api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    // start listener for METER_VIA_WATT device
    if (this.getSettings().use_measure_source) {
      if (this.sourceDevice.capabilities.includes('measure_power')) {
        this.log(`registering measure_power capability listener for ${this.sourceDevice.name}`);
        this.capabilityInstances.measurePower = await this.sourceDevice.makeCapabilityInstance('measure_power', async (value) => {
          await this.updateMeterFromMeasure(value).catch(this.error);
        });
        return;
      }
      throw Error(`${this.sourceDevice.name} has no measure_power capability ${this.sourceDevice.capabilities}`);
    }

    // start listeners for HOMEY-API device
    await this.addSourceCapGroup();
    this.log(`registering meter_power capability listener for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          this.lastGroupMeter[key] = value;
          await this.updateGroupMeter(value, key).catch(this.error);
        });
      }
    });
    // get the init values for this.lastGroupMeter
    // this.pollMeter(); is done from device init
  }

  // Setup how to poll the meter
  async pollMeter() {
    if (!this.homey.app.api) return;
    // poll a Homey Energy device
    if (this.getSettings().source_device_type.includes('Homey Energy')) {
      const report = await this.homey.app.api.energy.getLiveReport().catch(this.error);
      // console.log(this.getName(), this.settings.homey_energy);
      // console.dir(report, { depth: null, colors: true });
      const value = report[this.settings.homey_energy].W;
      await this.updateMeterFromMeasure(value).catch(this.error);
      return;
    }

    // check if HOMEY-API source device has a defined capability group setup
    if (!this.sourceCapGroup) await this.addSourceCapGroup();

    // get all values for this.lastGroupMeter
    await this.getSourceDevice();
    Object.keys(this.sourceCapGroup)
      .filter((k) => this.sourceCapGroup[k])
      .forEach((k) => {
        this.lastGroupMeter[k] = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[k]].value;
      });
    this.lastGroupMeterReady = true;
    await this.updateGroupMeter().catch(this.error);
  }

  async updateGroupMeter() {
    // check if all GroupCaps have received their first value.
    if (!this.lastGroupMeterReady) {
      this.log(this.getName(), 'Ignoring value update. updateGroupMeter is waiting to be filled.');
      return;
    }
    // calculate the sum, and update meter
    let total = 0;
    total = Number.isFinite(this.lastGroupMeter.p1) ? total += this.lastGroupMeter.p1 : total;
    total = Number.isFinite(this.lastGroupMeter.p2) ? total += this.lastGroupMeter.p2 : total;
    total = Number.isFinite(this.lastGroupMeter.n1) ? total -= this.lastGroupMeter.n1 : total;
    total = Number.isFinite(this.lastGroupMeter.n2) ? total -= this.lastGroupMeter.n2 : total;
    await this.updateMeter(total).catch(this.error);
  }

}

module.exports = PowerDevice;

/*
capabilitiesObj:
{
  measure_power: {
    value: 430,
    lastUpdated: '2022-01-27T15:59:52.519Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power',
    desc: 'Power in watt (W)',
    units: 'W',
    decimals: 2,
    chartType: 'stepLine',
    id: 'measure_power',
    options: {}
  },
  meter_power: {
    value: 33744.268,
    lastUpdated: '2022-01-27T15:59:52.519Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter total',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power',
    options: { title: [Object], decimals: 4 }
  },
  meter_offPeak: {
    value: false,
    lastUpdated: '2022-01-27T06:00:35.274Z',
    type: 'boolean',
    getable: true,
    setable: false,
    title: 'Off peak',
    desc: 'Is off-peak tarriff active?',
    units: null,
    iconObj: {
      id: 'b4084ca4a885c7f194378c9792b56d1e',
      url: '/icon/b4084ca4a885c7f194378c9792b56d1e/icon.svg'
    },
    id: 'meter_offPeak',
    options: {}
  },
  'meter_power.peak': {
    value: 15856.372,
    lastUpdated: '2022-01-27T15:59:52.520Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.peak',
    options: { title: [Object], decimals: 4 }
  },
  'meter_power.offPeak': {
    value: 26309.979,
    lastUpdated: '2022-01-27T06:00:15.250Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Power meter off-peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.offPeak',
    options: { meter_power: [Object], title: [Object], decimals: 4 }
  },
  'meter_power.producedPeak': {
    value: 6128.784,
    lastUpdated: '2022-01-21T12:04:45.551Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Production peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.producedPeak',
    options: { title: [Object], decimals: 4 }
  },
  'meter_power.producedOffPeak': {
    value: 2293.299,
    lastUpdated: '2022-01-09T14:42:54.559Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Production off-peak',
    desc: 'Energy usage in kilowatt-hour (kWh)',
    units: 'kWh',
    decimals: 4,
    chartType: 'spline',
    id: 'meter_power.producedOffPeak',
    options: { title: [Object], decimals: 4 }
  },
  measure_gas: {
    value: 0.463,
    lastUpdated: '2022-01-27T15:03:50.934Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Gas',
    desc: 'Gas usage',
    units: 'm³ /hr',
    decimals: 4,
    iconObj: {
      id: '802e0ad3d838346f6bc6e5e3d580e53d',
      url: '/icon/802e0ad3d838346f6bc6e5e3d580e53d/icon.svg'
    },
    id: 'measure_gas',
    options: {}
  },
  meter_gas: {
    value: 9308.75,
    lastUpdated: '2022-01-27T15:03:50.935Z',
    type: 'number',
    getable: true,
    setable: false,
    title: 'Gas meter',
    desc: 'Gas usage in cubic meter (m³)',
    units: 'm³',
    decimals: 2,
    min: 0,
    chartType: 'spline',
    id: 'meter_gas',
    options: {}
  }
}

*/
