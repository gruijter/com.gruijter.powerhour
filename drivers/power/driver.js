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
const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');

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
    'meter_tariff', 'meter_power', 'measure_watt_avg', 'last_minmax_reset', 'measure_watt_min', 'measure_watt_max'],
};

class PowerDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) EnergyPollingHelper.unregister(this.energyPollCallback);
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    this.energyPollCallback = async (report) => {
      const cumulativePower = report?.totalCumulative?.W;
      if (Number.isFinite(cumulativePower)) {
        const devices = this.getDevices();
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;
        });
      }
    };
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  checkDeviceCompatibility(homeyDevice) {
    const result = super.checkDeviceCompatibility(homeyDevice);
    if (!result.found) return result;

    let hasSourceCapGroup = false;
    for (const capGroup of this.ds.sourceCapGroups) {
      if (hasSourceCapGroup) continue; // stop at the first match
      const requiredKeys = Object.values(capGroup).filter((v) => v);
      const hasAllKeys = requiredKeys.every((k) => homeyDevice.capabilities.includes(k));
      if (hasAllKeys) hasSourceCapGroup = true; // all relevant capabilities were found in the source device
    }

    if (!hasSourceCapGroup && !homeyDevice.capabilities.includes('measure_power')) {
      // this.log('incompatible source caps', homeyDevice.driverId, homeyDevice.capabilities);
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
