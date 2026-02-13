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
    meter_source: 'meter_gas',
    measure_source: 'measure_gas',
  },
};

class sumDriver extends GenericDevice {

  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  // driver specific stuff below

  async addListeners() {
    if (!this.homey.app.api) throw new Error('Homey API not ready');
    this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false }) // , $timeout: 15000
      .catch(this.error);
    const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
    && Object.keys(this.sourceDevice.capabilitiesObj).length > 0; // && (this.sourceDevice.available !== null);
    if (!sourceDeviceExists) throw Error('Source device is missing.');
    // make listener for meter_gas
    if (this.sourceDevice.capabilities.includes('meter_gas')) {
      this.log(`registering meter_gas capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.meterGas = this.sourceDevice.makeCapabilityInstance('meter_gas', async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }
    // make listener for meter_gas.reading
    if (this.sourceDevice.capabilities.includes('meter_gas.reading')) {
      this.log(`registering meter_gas.reading capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.meterGas = this.sourceDevice.makeCapabilityInstance('meter_gas.reading', async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }
    // make listener for meter_gas.consumed
    if (this.sourceDevice.capabilities.includes('meter_gas.consumed')) {
      this.log(`registering meter_gas.consumed capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.meterGas = this.sourceDevice.makeCapabilityInstance('meter_gas.consumed', async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }
    // make listener for meter_gas.current (ZTAZ P1)
    if (this.sourceDevice.capabilities.includes('meter_gas.current')) {
      this.log(`registering meter_gas.current capability listener for ${this.sourceDevice.name}`);
      this.capabilityInstances.meterGas = this.sourceDevice.makeCapabilityInstance('meter_gas.current', async (value) => {
        await this.updateMeter(value).catch(this.error);
      });
    }
  }

  async pollMeter() {
    if (!this.homey.app.api) return;
    this.sourceDevice = await this.homey.app.api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false }) // , $timeout: 15000
      .catch(this.error);
    const sourceDeviceExists = this.sourceDevice && this.sourceDevice.capabilitiesObj
    && Object.keys(this.sourceDevice.capabilitiesObj).length > 0; // && (this.sourceDevice.available !== null);
    if (!sourceDeviceExists) throw Error('Source device is missing.');

    let pollValue;
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.meter_gas) {
      pollValue = this.sourceDevice.capabilitiesObj.meter_gas.value;
    }
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.meter_gas && this.sourceDevice.capabilitiesObj.meter_gas.reading) {
      pollValue = this.sourceDevice.capabilitiesObj.meter_gas.reading.value;
    }
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.meter_gas
      && this.sourceDevice.capabilitiesObj.meter_gas.consumed) {
      pollValue = this.sourceDevice.capabilitiesObj.meter_gas.consumed.value;
    }
    if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.meter_gas
    && this.sourceDevice.capabilitiesObj.meter_gas.current) {
      pollValue = this.sourceDevice.capabilitiesObj.meter_gas.current.value;
    }
    await this.updateMeter(pollValue);
  }

}

module.exports = sumDriver;
