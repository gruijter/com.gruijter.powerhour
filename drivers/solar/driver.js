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
const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
// Dependencies are lazy loaded in methods to save memory

// The screens of the setup view, in order (lib/helpers/PairSetup.js).
const STEPS = [
  { id: 'meter', ids: ['use_measure_source', 'homey_device_daily_reset'], roles: true },
  { id: 'panels', ids: ['peakPower'] },
  { id: 'price', ids: ['tariff_update_group', 'tariff', 'tariff_export', 'currency'] },
  { id: 'year', ids: [], optional: 'pair' },
  { id: 'advanced', ids: ['tariff_type', 'lat', 'lon', 'decimals_meter'], repairOnly: true },
];

const driverSpecifics = {
  driverId: 'solar',
  fallbackMeter: 'meter_power', // a source device's primary meter, when nothing else is detected
  requiredClass: 'solarpanel',
  deviceCapabilities: ['measure_power', 'measure_watt_forecast.h0',
    'measure_watt_forecast.m15', 'measure_watt_forecast.m30',
    'measure_watt_forecast.m45', 'measure_watt_forecast.h1',
    'measure_watt_forecast.h2', 'measure_watt_forecast.h3',
    'meter_kwh_this_hour', 'meter_kwh_forecast.h0',
    'meter_kwh_this_day', 'meter_kwh_forecast.this_day',
    'measure_watt_forecast.tomorrow_peak', 'meter_kwh_forecast.tomorrow',
    'meter_kwh_last_hour', 'meter_kwh_last_day',
    'meter_kwh_last_month', 'meter_kwh_this_month',
    'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour',
    'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month',
    'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'measure_solar_use.this_hour', 'measure_solar_use.this_day',
    'measure_solar_use.this_month', 'measure_solar_use.this_year',
    'meter_tariff', 'meter_power',
    // Max (day, month, year - independently auto-resetting). No min: solar's production floor
    // is trivially ~0 at night, deliberately not tracked (see grid's driver.js for the
    // symmetric min+max version used by drivers where min is meaningful).
    'measure_watt_max.day', 'measure_watt_max.month', 'measure_watt_max.year',
    'button.retrain', 'button.export_diagnostics', 'alarm_power'],
  // Asked at pair and repair (lib/helpers/PairSetup.js).
  setup: {
    settings: STEPS.flatMap((st) => st.ids),
    steps: STEPS,
    roles: [{ key: 'p1', kind: 'kwh', label: 'production' },
      {
        key: 'watt', kind: 'w', label: 'power', watt: true, // Use Watt as source
      }],
    match: { classes: ['solarpanel'], energy: (energy) => !!energy.meterPowerExportedCapability },
    requirePrice: true,
  },
  // Canonical display order for this driver's chart images - see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'solarToday', prop: 'solarTodayImage', chartProp: 'chartSolarToday', titleKey: 'today',
    },
    {
      id: 'solarTomorrow', prop: 'solarTomorrowImage', chartProp: 'chartSolarTomorrow', titleKey: 'tomorrow',
    },
    {
      id: 'solarYesterday', prop: 'solarYesterdayImage', chartProp: 'chartSolarYesterday', titleKey: 'yesterday',
    },
    {
      id: 'solarDistribution', prop: 'solarDistributionImage', chartProp: 'chartSolarDistribution', titleKey: 'distribution',
    },
  ],
};

class SolarDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

  // The grid power, and per device the part of its production used at home (export shared by
  // production).
  async onEnergyReport(report) {
    const gridW = await EnergyPollingHelper.gridPowerW(report);
    if (!Number.isFinite(gridW)) return;
    const devices = this.getDevices();
    const powerOf = (device) => device.getCapabilityValue('measure_power') || 0;
    const totalSolarW = devices.reduce((a, device) => a + Math.max(0, powerOf(device)), 0);
    devices.forEach((device) => {
      device.currentGridPower = gridW;
      const power = powerOf(device);
      if (power <= 0) device.currentSelfConsumedPower = 0;
      else if (gridW >= 0) device.currentSelfConsumedPower = power;
      else device.currentSelfConsumedPower = Math.max(0, power - (Math.abs(gridW) * (power / totalSolarW)));
    });
  }

}

module.exports = SolarDriver;
