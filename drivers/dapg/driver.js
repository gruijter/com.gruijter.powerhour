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

// Providers are lazy loaded below to save memory

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

class DapGDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;

    this.ds.providers = [
      // eslint-disable-next-line global-require
      () => require('../../lib/providers/Easyenergy'),
      // eslint-disable-next-line global-require
      () => require('../../lib/providers/EEX'),
    ];
    this.ds.biddingZones = {}; // Populated dynamically in onPairListDevices
    await super.onInit().catch(this.error);
  }

}

module.exports = DapGDriver;
