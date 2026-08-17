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
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'grid',
  deviceCapabilities: [
    // Active tariff + live power (meter_power_hidden.* are internal accounting anchors only -
    // uiComponent: null, no visible tile, no Insights, no flow cards - see drivers/grid/device.js)
    'meter_tariff',
    'measure_power.grid', 'meter_power_hidden.grid',
    'measure_power.home', 'meter_power_hidden.home',
    'measure_power.solar', 'measure_power.battery', 'measure_power.evcharger',
    // kWh (net)
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    // Budget
    'meter_target_month_to_date', 'meter_target_year_to_date',
    // Money (net)
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    // Money avg
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    // Imported (kWh, then money)
    'meter_kwh_last_month.imported', 'meter_kwh_this_month.imported',
    'meter_kwh_last_year.imported', 'meter_kwh_this_year.imported',
    'meter_money_last_month.imported', 'meter_money_this_month.imported',
    'meter_money_last_year.imported', 'meter_money_this_year.imported',
    // Exported (kWh, then money)
    'meter_kwh_last_month.exported', 'meter_kwh_this_month.exported',
    'meter_kwh_last_year.exported', 'meter_kwh_this_year.exported',
    'meter_money_last_month.exported', 'meter_money_this_month.exported',
    'meter_money_last_year.exported', 'meter_money_this_year.exported',
    // Min/max (day, month, year - independently auto-resetting)
    'measure_watt_min.day', 'measure_watt_max.day',
    'measure_watt_min.month', 'measure_watt_max.month',
    'measure_watt_min.year', 'measure_watt_max.year',
    // Peak average load (day, month, year - independently auto-resetting, fixed-slot average)
    'measure_watt_peak.day', 'measure_watt_peak_export.day',
    'measure_watt_peak.month', 'measure_watt_peak_export.month',
    'measure_watt_peak.year', 'measure_watt_peak_export.year',
    // Forecast (home load)
    'measure_watt_forecast.h0', 'measure_watt_forecast.m15', 'measure_watt_forecast.m30',
    'measure_watt_forecast.m45', 'measure_watt_forecast.h1', 'measure_watt_forecast.h2',
    'measure_watt_forecast.h3', 'meter_kwh_forecast.h0', 'meter_kwh_forecast.this_day',
    'meter_kwh_forecast.tomorrow', 'measure_watt_forecast.tomorrow_peak', 'button.retrain_load'],
  // Canonical display order for this driver's chart images - see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'gridToday', prop: 'gridTodayImage', chartProp: 'chartGridToday', titleKey: 'today',
    },
    {
      id: 'gridTomorrow', prop: 'gridTomorrowImage', chartProp: 'chartGridTomorrow', titleKey: 'tomorrow',
    },
    {
      id: 'gridYesterday', prop: 'gridYesterdayImage', chartProp: 'chartGridYesterday', titleKey: 'yesterday',
    },
    {
      id: 'gridWeekly', prop: 'gridWeeklyImage', chartProp: 'chartGridWeekly', titleKey: 'weekly',
    },
  ],
};

class GridDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Only initialize polling if there are devices.
    // If a device is paired later, checkStartPolling will handle it.
    if (this.getDevices().length > 0) {
      await this.checkStartPolling();
    }
  }

  async checkStartPolling() {
    if (this.energyPollCallback) return; // Already polling
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    await this.startPollingEnergy().catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async startPollingEnergy() {
    this.energyPollCallback = async (report) => {
      this.lastEnergyReport = report;
    };
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  checkDeviceCompatibility(homeyDevice) {
    const energyData = homeyDevice.energyObj || homeyDevice.energy;

    // Require the device to be flagged as a cumulative energy source in Homey's own energy
    // object first. Without this, the measure_power-only fallback below matched almost any
    // power-metering device (smart plugs, appliance monitors, EV chargers, ...) since
    // measure_power is extremely common - not just actual main-meter/CT-clamp candidates.
    if (!energyData || energyData.cumulative !== true) return { found: false };

    // Filter for devices that act as a cumulative main grid meter
    const hasMeterPower = homeyDevice.capabilities.some((cap) => cap.startsWith('meter_power'));
    const hasMeasurePower = homeyDevice.capabilities.includes('measure_power');
    if (hasMeterPower && hasMeasurePower) {
      return { found: true, useMeasureSource: false };
    }

    // Fallback: clamp/CT-style devices with no cumulative kWh register capability at all,
    // only a signed measure_power (positive = import, negative = export, Homey standard),
    // but still flagged cumulative in Homey's own energy object. Paired with the
    // 'use_measure_source' setting, the shared base class self-integrates this into a
    // meter total (see generic_sum_device.js#addListeners()/updateMeterFromMeasure).
    if (hasMeasurePower) {
      return { found: true, useMeasureSource: true };
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
