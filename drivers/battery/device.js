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
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.s
*/

'use strict';

const GenericDevice = require('../../lib/generic_bat_device');
const SourceDeviceHelper = require('../../lib/SourceDeviceHelper');

class BatDevice extends GenericDevice {

  async onInit() {
    await super.onInit().catch(this.error);
  }

  async addSourceCapGroup() {
    // setup if/how a HOMEY-API source device fits to a defined capability group
    this.sourceCapGroup = this.driver.ds.sourceCapGroups.find((capGroup) => {
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      return requiredKeys.every((k) => this.sourceDevice.capabilities.includes(k));
    });
    if (!this.sourceCapGroup) {
      throw Error(`${this.sourceDevice.name} has no compatible capabilities ${this.sourceDevice.capabilities}`);
    }
  }

  async getSourceDevice() {
    this.sourceDevice = await SourceDeviceHelper.getSourceDevice(this);
    return this.sourceDevice;
  }

  async addListeners() {
    // check if source device exists
    if (!this.homey.app.api) throw new Error('Homey API not ready');
    await this.getSourceDevice();

    // start listeners for all caps
    await this.addSourceCapGroup();
    this.log(`registering capability listeners for ${this.sourceDevice.name}`);
    Object.keys(this.sourceCapGroup).forEach((key) => {
      if (this.sourceCapGroup[key]) {
        this.capabilityInstances[key] = this.sourceDevice.makeCapabilityInstance(this.sourceCapGroup[key], async (value) => {
          await this.updateValue(value, key).catch(this.error);
        });
      }
    });
  }

  async poll() {
    // check if source device exists
    if (!this.homey.app.api) return;
    await this.getSourceDevice();

    // start polling all caps
    if (!this.sourceCapGroup) await this.addSourceCapGroup();
    this.log(`polling ${this.sourceDevice.name}`);
    const promises = Object.keys(this.sourceCapGroup).map(async (key) => {
      if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]]) {
        const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup[key]].value;
        await this.updateValue(val, key).catch(this.error);
      }
    });
    await Promise.all(promises);
  }

}

module.exports = BatDevice;
