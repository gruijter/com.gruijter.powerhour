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
const SourceCaps = require('../../lib/helpers/SourceCaps');
const PriceZones = require('../../lib/helpers/PriceZones');
const PeakTariff = require('../../lib/strategies/PeakTariff');

const PEAK_IDS = ['peakPreset', 'peakLoadIntervalMinutes', 'peakSelection', 'peakCount', 'peakDistinctDays', 'peakHours',
  'peakWeekdaysOnly', 'peakMonths', 'peakWeightOutside', 'peakMinimumW', 'peakPrice', 'peakSteps', 'peakHardLimitW'];
const MARKUP_IDS = ['markup_month', 'markup_day', 'markup_hour'];

const STEPS = [
  { id: 'meter', ids: ['use_measure_source'], roles: true },
  { id: 'price', ids: ['tariff_update_group', 'tariff', 'tariff_export', 'currency', ...MARKUP_IDS, 'start_date'] },
  { id: 'connection', ids: ['connectionPhases', 'connectionAmps', 'connectionVoltage', 'fuseMarginPct'] },
  { id: 'peak', ids: PEAK_IDS },
  { id: 'year', ids: [], optional: 'pair' },
  { id: 'advanced', ids: ['tariff_type', 'directionalNettingScheme', 'directionalBlockMinutes', 'decimals_meter'], repairOnly: true },
];

const driverSpecifics = {
  driverId: 'grid',
  deviceCapabilities: [
    'meter_tariff',
    'measure_watt_grid', 'meter_power_hidden.grid',
    'measure_watt_home', 'meter_power_hidden.home',
    'measure_watt_solar', 'measure_watt_battery', 'measure_watt_evcharger',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_kwh_last_contract', 'meter_kwh_this_contract',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_last_contract', 'meter_money_this_contract',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_kwh_last_day.imported', 'meter_kwh_this_day.imported',
    'meter_kwh_last_month.imported', 'meter_kwh_this_month.imported',
    'meter_kwh_last_year.imported', 'meter_kwh_this_year.imported',
    'meter_money_last_day.imported', 'meter_money_this_day.imported',
    'meter_money_last_month.imported', 'meter_money_this_month.imported',
    'meter_money_last_year.imported', 'meter_money_this_year.imported',
    'meter_kwh_last_day.exported', 'meter_kwh_this_day.exported',
    'meter_kwh_last_month.exported', 'meter_kwh_this_month.exported',
    'meter_kwh_last_year.exported', 'meter_kwh_this_year.exported',
    'meter_kwh_last_contract.imported', 'meter_kwh_this_contract.imported',
    'meter_kwh_last_contract.exported', 'meter_kwh_this_contract.exported',
    'meter_money_last_day.exported', 'meter_money_this_day.exported',
    'meter_money_last_month.exported', 'meter_money_this_month.exported',
    'meter_money_last_year.exported', 'meter_money_this_year.exported',
    'measure_watt_min.day', 'measure_watt_max.day',
    'measure_watt_min.month', 'measure_watt_max.month',
    'measure_watt_min.year', 'measure_watt_max.year',
    'measure_watt_peak.day', 'measure_watt_peak_export.day',
    'measure_watt_peak.month', 'measure_watt_peak_export.month',
    'measure_watt_peak.year', 'measure_watt_peak_export.year',
    'measure_watt_peak.projected', 'measure_watt_peak.headroom', 'measure_watt_peak.billed',
    'measure_watt_forecast.h0', 'measure_watt_forecast.m15', 'measure_watt_forecast.m30',
    'measure_watt_forecast.m45', 'measure_watt_forecast.h1', 'measure_watt_forecast.h2',
    'measure_watt_forecast.h3', 'meter_kwh_forecast.h0', 'meter_kwh_forecast.this_day',
    'meter_kwh_forecast.tomorrow', 'measure_watt_forecast.tomorrow_peak',
    'measure_watt_forecast.net_h0', 'measure_watt_forecast.net_h1',
    'button.retrain_load',
    'meter_kwh_last_day.home', 'meter_kwh_this_day.home', 'meter_kwh_last_month.home', 'meter_kwh_this_month.home',
    'meter_kwh_last_year.home', 'meter_kwh_this_year.home',
    'meter_kwh_this_hour.imported', 'meter_kwh_this_hour.exported', 'meter_kwh_this_hour.home'],
  setup: {
    settings: STEPS.flatMap((st) => st.ids),
    steps: STEPS,
    roles: [{ key: 'p1', kind: 'kwh' }, { key: 'n1', kind: 'kwh' },
      {
        key: 'watt', kind: 'w', label: 'power', watt: true,
      }],
    match: { energy: (energy) => energy.cumulative === true },
    requirePrice: true,
  },
  chartImages: [
    {
      id: 'netToday', prop: 'netTodayImage', chartProp: 'chartNetToday', titleKey: 'grid_today',
    },
    {
      id: 'netTomorrow', prop: 'netTomorrowImage', chartProp: 'chartNetTomorrow', titleKey: 'grid_tomorrow',
    },
    {
      id: 'netYesterday', prop: 'netYesterdayImage', chartProp: 'chartNetYesterday', titleKey: 'grid_yesterday',
    },
    {
      id: 'gridWeekly', prop: 'gridWeeklyImage', chartProp: 'chartGridWeekly', titleKey: 'home_weekly',
    },
  ],
};

class GridDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
  }

  async onEnergyReport(report) {
    this.lastEnergyReport = report;
  }

  needsEnergyReport() {
    try {
      return !(this.homey.drivers.getDriver('solar').getDevices().length > 0);
    } catch {
      return true;
    }
  }

  checkDeviceCompatibility(homeyDevice) {
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    const caps = homeyDevice.capabilities || [];
    const hasMeterPower = caps.some((cap) => cap.startsWith('meter_power'));
    const hasMeasurePower = caps.includes('measure_power');

    if (energyData && energyData.cumulative === true) {
      if (hasMeterPower) return { found: true, useMeasureSource: false };
      if (hasMeasurePower) return { found: true, useMeasureSource: true };
    }

    if (SourceCaps.hasKind(homeyDevice, 'kwh')) return { found: true, useMeasureSource: false, needsMapping: true };
    if (hasMeasurePower) return { found: true, useMeasureSource: true, needsMapping: true };
    return { found: false };
  }

  autoSourceCapGroup(sourceDevice) {
    const energyData = sourceDevice.energyObj || sourceDevice.energy;
    if (!energyData || energyData.cumulative !== true) return null;
    const caps = sourceDevice.capabilities || [];
    const importedCap = energyData.cumulativeImportedCapability || 'meter_power';
    const exportedCap = energyData.cumulativeExportedCapability;
    const group = {
      p1: caps.includes(importedCap) ? importedCap : null,
      p2: null,
      n1: exportedCap && caps.includes(exportedCap) ? exportedCap : null,
      n2: null,
    };
    return group.p1 || group.n1 ? group : null;
  }

  setupValue(id, value, dev, current) {
    if (id !== 'peakPreset') return value;
    if (!current.device) {
      const lat = this.homey.geolocation.getLatitude();
      const lon = this.homey.geolocation.getLongitude();
      const { country } = PriceZones.propose(this.homey.clock.getTimezone(), Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null);
      return country === 'NO' ? 'norway' : value;
    }
    if (value === 'custom' && !PeakTariff.isActive(PeakTariff.configFromSettings(current.settings))) return 'none';
    return value;
  }

  setupParsed(settings) {
    const preset = settings.peakPreset;
    if (preset === 'none') Object.assign(settings, { peakPrice: 0, peakSteps: '' });
    else if (PeakTariff.PRESETS[preset]) Object.assign(settings, PeakTariff.PRESETS[preset]);
  }

  async setupValidate(settings, caps, dev) {
    const peakReason = PeakTariff.invalidReason(settings);
    if (peakReason) throw Error(this.homey.__(peakReason));
    return super.setupValidate(settings, caps, dev);
  }
}

module.exports = GridDriver;
