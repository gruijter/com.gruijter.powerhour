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
const PairSetup = require('../../lib/helpers/PairSetup');
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'power',
  fallbackMeter: 'meter_power', // a source device's primary meter, when nothing else is detected
  originDeviceCapabilities: ['measure_power', 'meter_power', 'meter_power.peak', 'meter_power.consumed', 'meter_power.delivered',
    'meter_power.import', 'meter_power.total_power', 'meter_power.t1', 'meter_power.consumedL1', 'measure_energy_consumption_today'],
  sourceCapGroups: [
    {
      p1: 'meter_power.total_power', p2: null, n1: null, n2: null, // huawei solar
    },
    {
      p1: 'meter_power.t1', p2: 'meter_power.t2', n1: 'meter_power.rt1', n2: 'meter_power.rt2', // iungo
    },
    {
      p1: 'meter_power', p2: null, n1: null, n2: null, // youless
    },
    {
      p1: 'meter_power.peak', p2: 'meter_power.offPeak', n1: null, n2: null,
    },
    {
      p1: 'meter_power.consumedL1', p2: 'meter_power.consumedL2', n1: null, n2: null, // ztaz P1
    },
    {
      p1: 'meter_power.consumed', p2: null, n1: 'meter_power.generated', n2: null,
    },
    {
      p1: 'meter_power.consumed', p2: null, n1: 'meter_power.returned', n2: null,
    },
    {
      p1: 'meter_power.delivered', p2: null, n1: 'meter_power.returned', n2: null,
    },
    {
      p1: 'meter_power.import', p2: null, n1: 'meter_power.export', n2: null, // qubino
    },
    {
      p1: 'measure_energy_consumption_today', p2: null, n1: null, n2: null, // toshiba
    },
  ],
  deviceCapabilities: ['meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power', 'measure_watt_avg',
    // Min/max (day, month, year - independently auto-resetting)
    'measure_watt_min.day', 'measure_watt_max.day',
    'measure_watt_min.month', 'measure_watt_max.month',
    'measure_watt_min.year', 'measure_watt_max.year'],
  // Asked at pair and repair (lib/helpers/PairSetup.js).
  setup: {
    settings: ['use_measure_source', 'homey_device_daily_reset', 'forecast_appliance', 'tariff_update_group'],
    // Low (or single) and normal tariff registers of a smart meter; the extra ones only show when
    // the source has them (optional: see generic_sum_driver.setupRoles()).
    roles: [{ key: 'p1', kind: 'kwh', label: 'p1_low' }, {
      key: 'p2', kind: 'kwh', label: 'p2_normal', optional: true,
    }, {
      key: 'n1', kind: 'kwh', label: 'n1_low', optional: true,
    }, {
      key: 'n2', kind: 'kwh', label: 'n2_normal', optional: true,
    },
    {
      key: 'watt', kind: 'w', label: 'power', watt: true, // Use Watt as source
    }],
    match: { energy: (energy) => energy.cumulative === true }, // a smart meter
    requirePrice: true,
  },
  // Only registered with forecast (setting forecast_appliance) - see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'applianceToday', prop: 'applianceTodayImage', chartProp: 'chartApplianceToday', titleKey: 'today',
    },
    {
      id: 'applianceTomorrow', prop: 'applianceTomorrowImage', chartProp: 'chartApplianceTomorrow', titleKey: 'tomorrow',
    },
    {
      id: 'applianceNextHours', prop: 'applianceNextHoursImage', chartProp: 'chartApplianceNextHours', titleKey: 'nextHours',
    },
    {
      id: 'applianceWeekly', prop: 'applianceWeeklyImage', chartProp: 'chartApplianceWeekly', titleKey: 'appliance_weekly',
    },
    {
      id: 'applianceProgram', prop: 'applianceProgramImage', chartProp: 'chartApplianceProgram', titleKey: 'appliance_program',
    },
  ],
};

class PowerDriver extends GenericDriver {

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
      // eslint-disable-next-line global-require
      const { getGridPowerFallback } = require('../../lib/helpers/Util');
      let cumulativePower = getGridPowerFallback(this.homey);
      if (cumulativePower === null) cumulativePower = report?.totalCumulative?.W;

      if (Number.isFinite(cumulativePower)) {
        const devices = this.getDevices();
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;
        });
      }
    };
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  // Forecast: the appliance is taken out of the home load. Only for a Homey device as source; the
  // source of an EV charger device is out of it already: as an appliance it would count twice.
  checkApplianceSource(settings) {
    if (!settings.forecast_appliance) return;
    // Homey Energy and flow sources are totals, no single appliance.
    if (settings.source_device_type !== 'Homey device') throw Error(this.homey.__('error_appliance_homey_device'));
    let chargers = [];
    try {
      chargers = this.homey.drivers.getDriver('evCharger').getDevices();
    } catch {
      return;
    }
    if (chargers.some((dev) => dev.getSettings().homey_device_id === settings.homey_device_id)) {
      throw Error(this.homey.__('error_appliance_ev_charger'));
    }
  }

  // With forecast: next run and the day pickers. appliance_next_run also shows the
  // appliance flow cards (their filter).
  capabilitiesFor(settings = {}) {
    const caps = super.capabilitiesFor(settings);
    if (settings.forecast_appliance && settings.source_device_type === 'Homey device') {
      caps.push('appliance_next_run', 'appliance_today', 'appliance_tomorrow', 'button.retrain');
    }
    return caps;
  }

  // Setup view: what the forecast checkbox does.
  async setupInfo(setting, def) {
    if (setting.id === 'forecast_appliance') return PairSetup.text(this.homey, def.hint);
    return undefined;
  }

  async setupValidate(settings, caps, dev) {
    await super.setupValidate(settings, caps, dev);
    this.checkApplianceSource(settings);
  }

  checkDeviceCompatibility(homeyDevice) {
    const result = super.checkDeviceCompatibility(homeyDevice);
    const hasSourceCapGroup = !!SourceCaps.matchGroup(homeyDevice.capabilities || [], this.ds.sourceCapGroups);
    if (result.found && (hasSourceCapGroup || homeyDevice.capabilities.includes('measure_power'))) {
      result.useMeasureSource = !hasSourceCapGroup;
      return result;
    }
    // Other meters: their capabilities are mapped in the setup view.
    if (SourceCaps.hasKind(homeyDevice, 'kwh')) return { found: true, useMeasureSource: false, needsMapping: true };
    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    if (homeyDevice.energyObj && homeyDevice.energyObj.cumulative) settings.distribution = 'el_nl_2023';
    return settings;
  }

  getVirtualDevices(randomId, allCaps, reducedCaps) {
    return [
      {
        name: 'HOMEY_ENERGY_SMARTMETERS',
        data: {
          id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
        },
        settings: {
          homey_device_id: `PH_${this.ds.driverId}_HE_CUMULATIVE_${randomId}`,
          homey_device_name: `HOMEY_ENERGY_CUMULATIVE_${randomId}`,
          level: this.homey.app.manifest.version,
          homey_energy: 'totalCumulative',
          interval: 1,
          source_device_type: 'Homey Energy Smart Meters',
          tariff_update_group: 1,
          distribution: 'el_nl_2023',
        },
        capabilities: allCaps,
      },
      {
        name: 'HOMEY_ENERGY_SOLARPANELS',
        data: {
          id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
        },
        settings: {
          homey_device_id: `PH_${this.ds.driverId}_HE_GENERATED_${randomId}`,
          homey_device_name: `HOMEY_ENERGY_GENERATED_${randomId}`,
          level: this.homey.app.manifest.version,
          homey_energy: 'totalGenerated',
          interval: 1,
          source_device_type: 'Homey Energy Solar Panels',
          tariff_update_group: 1,
          distribution: 'pv_52n_t40s',
        },
        capabilities: reducedCaps,
      },
      {
        name: 'HOMEY_ENERGY_DEVICES',
        data: {
          id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
        },
        settings: {
          homey_device_id: `PH_${this.ds.driverId}_HE_CONSUMED_${randomId}`,
          homey_device_name: `HOMEY_ENERGY_DEVICES_${randomId}`,
          level: this.homey.app.manifest.version,
          homey_energy: 'totalConsumed',
          interval: 1,
          source_device_type: 'Homey Energy Devices',
          tariff_update_group: 1,
        },
        capabilities: reducedCaps,
      },
    ];
  }

}

module.exports = PowerDriver;
