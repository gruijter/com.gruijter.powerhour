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

const EasyEnergy = require('../../lib/providers/Easyenergy');
const EEX = require('../../lib/providers/EEX');

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_dap_driver');

const driverSpecifics = {
  driverId: 'dapg',
  deviceCapabilities: [
    'meter_price_this_day_avg',
    'meter_price_next_8h_avg',
    'meter_price_h0',
    'meter_price_h1',
    'meter_price_h2',
    'meter_price_h3',
    'meter_price_h4',
    'meter_price_h5',
    'meter_price_h6',
    'meter_price_h7',
  ],
};

class dapgDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;

    // provide all data providers to the driver in order of presedence
    this.ds.providers = [EasyEnergy, EEX];
    this.ds.biddingZones = {};
    this.ds.providers.forEach((Provider) => {
      const api = new Provider();
      Object.assign(this.ds.biddingZones, api.getBiddingZones());
    });
    await super.onInit().catch(this.error);
  }

}

module.exports = dapgDriver;
