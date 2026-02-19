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

const { Driver } = require('homey');
const crypto = require('crypto');
const { setTimeoutPromise } = require('../Util');

class MyDriver extends Driver {

  async onInit() {
    this.log('onInit');
    await super.onInit().catch(this.error);

    this.registerHourlyListener();
    if (this.ds.driverId === 'dap15') {
      this.register15mListener();
    }
  }

  async onUninit() {
    this.log('dap driver onUninit called');
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);
    await setTimeoutPromise(3000, this);
  }

  registerHourlyListener() {
    if (this.eventListenerHour) this.homey.removeListener('everyhour_PBTH', this.eventListenerHour);
    this.eventListenerHour = () => {
      const devices = this.getDevices();
      devices.forEach((device) => {
        if (device.onHourlyEvent) device.onHourlyEvent().catch((err) => this.error(err));
      });
    };
    this.homey.on('everyhour_PBTH', this.eventListenerHour);
  }

  register15mListener() {
    if (this.eventListener15m) this.homey.removeListener('every15m_PBTH', this.eventListener15m);
    this.eventListener15m = () => {
      const devices = this.getDevices();
      devices.forEach((device) => {
        if (device.on15mEvent) device.on15mEvent().catch((err) => this.error(err));
      });
    };
    this.homey.on('every15m_PBTH', this.eventListener15m);
  }

  async onPairListDevices() {
    const randomId = crypto.randomBytes(3).toString('hex');
    const devices = [];
    Object.entries(this.ds.biddingZones).forEach((entry) => {
      const [description, biddingZone] = entry;
      devices.push({
        name: `${description}`,
        data: {
          id: `${biddingZone}_${randomId}`,
        },
        capabilities: this.ds.deviceCapabilities,
        settings: {
          biddingZone,
          description,
          variableMarkup: 0,
          fixedMarkup: 0,
          exchangeRate: 1,
          tariff_update_group: 0,
        },
      });
    });
    return devices;
  }

}

module.exports = MyDriver;
