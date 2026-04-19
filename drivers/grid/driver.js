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

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_sum_driver');
const { setTimeoutPromise } = require('../../lib/Util');

const driverSpecifics = {
  driverId: 'grid',
  deviceCapabilities: ['meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power', 'measure_watt_avg', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max',
    'measure_power.home', 'meter_power.home'],
};

class GridDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

  registerTariffListener() {
    // Listen specifically to 'power' tariffs from DAP for grid pricing
    const eventName = 'set_tariff_power_PBTH';
    if (this.eventListenerTariff) this.homey.removeListener(eventName, this.eventListenerTariff);

    this.eventListenerTariff = (args) => {
      (async () => {
        try {
          const tariff = args.tariff === null ? null : Number(args.tariff);

          if (tariff === null || !Number.isFinite(tariff)) return;

          const group = args.group || 1;
          const exportTariff = args.exportTariff === null ? null : Number(args.exportTariff);
          const { currency } = args;

          this.tariffs = this.tariffs || {};
          this.exportTariffs = this.exportTariffs || {};
          this.currencies = this.currencies || {};

          this.tariffs[group] = tariff;
          this.exportTariffs[group] = exportTariff;
          this.currencies[group] = currency;

          await setTimeoutPromise(2 * 1000, this);

          const devices = this.getDevices();
          for (const device of devices) {
            const s = device.getSettings();
            if (s.tariff_update_group === group) {
              device.updateGridTariffs(new Date());
            }
          }
        } catch (error) {
          this.error(error);
        }
      })().catch(this.error);
    };
    this.homey.on(eventName, this.eventListenerTariff);
  }

  updateDeviceTariff(device, overrideGroup) {
    // Ensure both groups update immediately when changed in settings
    device.updateGridTariffs(new Date());
  }

  checkDeviceCompatibility(homeyDevice) {
    const energyData = homeyDevice.energyObj || homeyDevice.energy;

    // Filter for devices that act as a cumulative main grid meter
    if (energyData && energyData.cumulative === true) {
      const hasMeterPower = homeyDevice.capabilities.some((cap) => cap.startsWith('meter_power'));
      const hasMeasurePower = homeyDevice.capabilities.includes('measure_power');
      if (hasMeterPower || hasMeasurePower) {
        const useMeasureSource = !hasMeterPower && hasMeasurePower;
        return { found: true, useMeasureSource };
      }
    }

    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    settings.distribution = 'el_nl_2023'; // Default to a standard grid budget distribution
    return settings;
  }
}

module.exports = GridDriver;
