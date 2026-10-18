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
const PriceSetup = require('../../lib/helpers/PriceSetup');
const PriceDrivers = require('../../lib/helpers/PriceDrivers');

/* eslint-disable global-require */
const POWER_PROVIDERS = [
  () => require('../../lib/providers/Omie'),
  () => require('../../lib/providers/EntsoeGruijter'),
  () => require('../../lib/providers/Smard'),
  () => require('../../lib/providers/Nordpool'),
  () => require('../../lib/providers/Entsoe'),
  () => require('../../lib/providers/Stekker'),
];
const GAS_PROVIDERS = [
  () => require('../../lib/providers/Easyenergy'),
  () => require('../../lib/providers/EEX'),
];
/* eslint-enable global-require */

const POWER_CAPABILITIES = [
  'measure_monetary.import',
  'measure_monetary.export',
  'measure_monetary.next',
  'measure_monetary.today_avg',
  'measure_monetary.today_low',
  'measure_monetary.today_high',
  'measure_monetary.tomorrow_avg',
  'measure_monetary.tomorrow_low',
  'measure_monetary.tomorrow_high',
  'measure_monetary.month_avg',
  'measure_monetary.last_month_avg',
  'hour_this_day_lowest',
  'hour_this_day_highest',
  'hour_next_day_lowest',
  'hour_next_day_highest',
  'meter_rank_price_h0_this_day',
  'meter_rank_price_h0_next_8h',
];

// Gas has one price per day: no export, no cheapest or most expensive times.
const GAS_CAPABILITIES = [
  'measure_monetary.import',
  'measure_monetary.next',
  'measure_monetary.today_avg',
  'measure_monetary.tomorrow_avg',
  'measure_monetary.month_avg',
  'measure_monetary.last_month_avg',
];

const driverSpecifics = {
  driverId: 'price',
  deviceCapabilities: POWER_CAPABILITIES,
};

class PriceDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    this.ds.providers = POWER_PROVIDERS;
    await super.onInit().catch(this.error);
  }

  providersFor(settings) {
    return PriceDrivers.isGas('price', settings) ? GAS_PROVIDERS : POWER_PROVIDERS;
  }

  capabilitiesFor(settings) {
    return PriceDrivers.isGas('price', settings) ? GAS_CAPABILITIES : POWER_CAPABILITIES;
  }

  onPair(session) {
    PriceSetup.registerPair(this, session);
  }

  onRepair(session, device) {
    PriceSetup.registerRepair(this, session, device);
  }

}

module.exports = PriceDriver;
