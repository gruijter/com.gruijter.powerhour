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

// const ENTSOE_GRUIJTER = require('../../lib/providers/EntsoeGruijter');
const ENTSOE = require('../../lib/providers/Entsoe');
// const NP = require('../../nordpool');
const STEKKER = require('../../lib/providers/Stekker');

const GenericDriver = require('../generic_dap_driver');

const driverSpecifics = {
  driverId: 'dap',
  deviceCapabilities: [
    'meter_price_h0',
    'meter_price_h1',
    'meter_price_h2',
    'meter_price_h3',
    'meter_price_h4',
    'meter_price_h5',
    'meter_price_h6',
    'meter_price_h7',
    'meter_price_last_month_avg',
    'meter_price_this_month_avg',
    'meter_price_this_day_avg',
    'meter_price_next_8h_avg',
    'meter_price_next_8h_lowest',
    'hour_next_8h_lowest',
    'meter_price_this_day_lowest',
    'hour_this_day_lowest',
    'meter_price_this_day_highest',
    'hour_this_day_highest',
    'meter_price_next_8h_highest',
    'hour_next_8h_highest',
    'meter_price_next_day_lowest',
    'hour_next_day_lowest',
    'meter_price_next_day_highest',
    'hour_next_day_highest',
    'meter_price_next_day_avg',
    'meter_rank_price_h0_this_day',
    'meter_rank_price_h0_next_8h',
  ],
};

class dapDriver extends GenericDriver {

  async onInit() {
    // this.log('driver onInit');
    this.ds = driverSpecifics;

    // provide all data providers to the driver in order of presedence
    this.ds.providers = [ENTSOE, STEKKER]; // [ENTSOE_GRUIJTER, ENTSOE, NP, STEKKER];
    this.ds.biddingZones = {};
    this.ds.providers.forEach((Provider) => {
      const api = new Provider();
      Object.assign(this.ds.biddingZones, api.getBiddingZones());
    });
    await this.onDriverInit().catch(this.error);
  }

}

module.exports = dapDriver;
