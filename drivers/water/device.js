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
const SourceDeviceHelper = require('../../lib/SourceDeviceHelper');

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_m3_this_hour',
    last_hour: 'meter_m3_last_hour',
    this_day: 'meter_m3_this_day',
    last_day: 'meter_m3_last_day',
    this_month: 'meter_m3_this_month',
    last_month: 'meter_m3_last_month',
    this_year: 'meter_m3_this_year',
    last_year: 'meter_m3_last_year',
    meter_source: 'meter_water',
    measure_source: 'measure_water',
  },
};

class sumDriver extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  // driver specific stuff below

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async addListeners() {
    if (!this.homey.app.api) throw new Error('Homey API not ready');
    await this.getSourceDevice();
    // make listener for meter_water
    if (this.sourceDevice.capabilities.includes('meter_water')) {
      this.log(`registering meter_water capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.meterWater = this.sourceDevice.makeCapabilityInstance('meter_water', async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }
  }

  async pollMeter() {
    if (!this.homey.app.api) return;
    await this.getSourceDevice();
    const pollValue = this.sourceDevice.capabilitiesObj.meter_water.value;
    await this.updateMeter(pollValue).catch(this.error);
  }

}

module.exports = sumDriver;
