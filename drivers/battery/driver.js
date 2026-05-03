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

const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const nomXomStrategy = require('../../lib/strategies/NomXomStrategy');
const EnergyPollingHelper = require('../../lib/EnergyPollingHelper');
const { getGridPowerFallback } = require('../../lib/Util');

const driverSpecifics = {
  driverId: 'battery',
  originDeviceCapabilities: ['measure_battery', 'measure_power.battery', 'measure_power.battery1'],
  sourceCapGroups: [
    {
      soc: 'measure_battery_soc', usagePower: 'measure_battery_power', // Solax
    },
    {
      soc: 'battery_capacity', usagePower: 'measure_power.battery', // Victron
    },
    {
      soc: 'measure_battery', productionPower: 'measure_power.batt_in', usagePower: 'measure_power.batt_out', // Sonnen
    },
    {
      soc: 'measure_battery', productionPower: 'from_battery_capability', usagePower: 'to_battery_capability', // Sonnen Batterie
    },
    {
      soc: 'measure_percentage.bat_soc', productionPower: 'measure_power.battery', // Blauhoff Afore
    },
    {
      soc: 'measure_percentage.battery1', productionPower: 'measure_power.battery1', // Blauhoff Deye
    },
    {
      soc: 'measure_battery', usagePower: 'measure_power', // SolarEdge Growatt
    },
  ],
  deviceCapabilities: [
    'measure_watt_avg', 'meter_kwh_stored',
    'meter_kwh_charging', 'meter_kwh_discharging',
    'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month',
    'meter_money_last_year', 'meter_money_this_year',
    'meter_tariff',
    'meter_power_hidden',
    // 'roi_duration', // added only for advanced ROI
  ],
};

class BatteryDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    await this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) EnergyPollingHelper.unregister(this.energyPollCallback);
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    const int = interval || 5;
    let lastCumulativePower = null;
    let lastProcessTime = 0;

    this.energyPollCallback = async (report) => {
      let cumulativePower = getGridPowerFallback(this.homey);
      if (cumulativePower === null) cumulativePower = report?.totalCumulative?.W;

      if (Number.isFinite(cumulativePower) && Math.abs(cumulativePower) <= 30000) {
        const devices = this.getDevices();
        devices.forEach((device) => {
          device.currentGridPower = cumulativePower;
        });

        const now = Date.now();
        if (cumulativePower !== lastCumulativePower || (now - lastProcessTime) > 10000) {
          const timeDelta = lastProcessTime > 0 ? (now - lastProcessTime) / 1000 : int;
          lastCumulativePower = cumulativePower;
          lastProcessTime = now;
          await this.processEnergyLogic(cumulativePower, timeDelta);
        }
      }
    };
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  async processEnergyLogic(cumulativePower, interval) {
    let app;
    try {
      app = this.homey.app;
    } catch (e) {
      return;
    }
    const xomSettings = app.xomSettings || this.homey.settings.get('xomSettings') || {};
    const { smoothing = 50, x = 0, minLoad = 50 } = xomSettings;
    const samples = Math.max(1, Math.round((smoothing / 100) * (120 / Math.max(1, interval))));

    const devices = this.getDevices();

    const strategy = nomXomStrategy.getStrategy({
      devices,
      cumulativePower,
      x,
      minLoad,
    });

    const promises = devices.map((device) => {
      const strat = strategy.find((info) => info.id === device.getData().id);
      return device.triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
    });
    await Promise.all(promises);
  }

  checkDeviceCompatibility(homeyDevice) {
    const hasCapability = (capability) => homeyDevice.capabilities.includes(capability);
    let found = false;

    if (homeyDevice.class === 'battery' || homeyDevice.virtualClass === 'battery') {
      if (hasCapability('measure_battery') && hasCapability('measure_power')) {
        found = true;
      }
    }

    if (!found) {
      found = this.ds.originDeviceCapabilities.some(hasCapability);
      if (found) {
        found = this.ds.sourceCapGroups.some((capGroup) => {
          const requiredKeys = Object.values(capGroup).filter((v) => v);
          return requiredKeys.every((k) => homeyDevice.capabilities.includes(k));
        });
      }
    }
    return { found, useMeasureSource: false };
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    const HP2023 = this.homey.platformVersion === 2;
    settings.roiEnable = HP2023;
    return settings;
  }

  getDeviceCapabilities() {
    const caps = [...this.ds.deviceCapabilities];
    const HP2023 = this.homey.platformVersion === 2;
    if (HP2023) caps.push('roi_duration');
    return caps;
  }

}

module.exports = BatteryDriver;
