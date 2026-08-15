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
  driverId: 'power',
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

  checkDeviceCompatibility(homeyDevice) {
    const result = super.checkDeviceCompatibility(homeyDevice);
    if (!result.found) return result;

    let hasSourceCapGroup = false;
    for (const capGroup of this.ds.sourceCapGroups) {
      if (hasSourceCapGroup) break;
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      const hasAllKeys = requiredKeys.every((k) => homeyDevice.capabilities.includes(k));
      if (hasAllKeys) hasSourceCapGroup = true;
    }

    if (!hasSourceCapGroup && !homeyDevice.capabilities.includes('measure_power')) {
      result.found = false;
    }
    result.useMeasureSource = !hasSourceCapGroup;
    return result;
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    if (homeyDevice.energyObj && homeyDevice.energyObj.cumulative) settings.distribution = 'el_nl_2023';
    return settings;
  }

  getVirtualDevices(randomId, allCaps, reducedCaps) {
    return [
      {
        name: `HOMEY_ENERGY_SMARTMETERS_Σ${this.ds.driverId}`,
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
          distribution: 'linear',
        },
        capabilities: allCaps,
      },
      {
        name: `HOMEY_ENERGY_SOLARPANELS_Σ${this.ds.driverId}`,
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
          distribution: 'NONE',
        },
        capabilities: reducedCaps,
      },
      {
        name: `HOMEY_ENERGY_DEVICES_Σ${this.ds.driverId}`,
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
          distribution: 'NONE',
        },
        capabilities: reducedCaps,
      },
    ];
  }

}

module.exports = PowerDriver;
