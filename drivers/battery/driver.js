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
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'battery',
  originDeviceCapabilities: ['measure_battery', 'measure_power.battery', 'measure_power.battery1'],
  // Exceptions list, used only when a source device does NOT already qualify for the official
  // Homey battery-energy-class detection in addSourceCapGroup() (class 'battery' + 'measure_battery'
  // + 'measure_power'). Per https://apps.developer.homey.app/the-basics/devices/energy#home-batteries
  // the Homey standard for measure_power/target_power is: positive = charging, negative = discharging.
  // Every entry here must resolve to that same convention:
  //   - `power` + `invertPower`: a single already-signed capability. Set invertPower: true when the
  //     vendor's own native sign convention is the opposite of the Homey standard.
  //   - `chargePower` + `dischargePower`: a pair of non-negative MAGNITUDE capabilities (no sign of
  //     their own, direction is implied by which one is reporting). No invert flag needed since the
  //     direction is unambiguous from which capability fired.
  sourceCapGroups: [
    {
      soc: 'measure_battery_soc', power: 'measure_battery_power', invertPower: true, // Solax (pre-existing behaviour, unverified against Solax's own docs)
    },
    {
      soc: 'battery_capacity', power: 'measure_power.battery', invertPower: true, // Victron (pre-existing behaviour, unverified against Victron's own docs)
    },
    {
      // Sessy fallback: current Sessy versions expose a Homey-standard-compliant 'measure_power'
      // and are matched via the official Homey battery-class check in addSourceCapGroup() instead.
      // This entry only applies as a fallback (e.g. an older Sessy app without class 'battery').
      // Sessy's legacy 'measure_power.battery' capability still uses the old, inverted convention.
      soc: 'measure_battery', power: 'measure_power.battery', invertPower: true, // Sessy (legacy fallback)
    },
    {
      // 'in'/'out' unambiguously indicate direction: batt_in = charging, batt_out = discharging.
      soc: 'measure_battery', chargePower: 'measure_power.batt_in', dischargePower: 'measure_power.batt_out', // Sonnen
    },
    {
      // 'from'/'to' the battery unambiguously indicate direction: from = discharging, to = charging.
      soc: 'measure_battery', chargePower: 'to_battery_capability', dischargePower: 'from_battery_capability', // Sonnen Batterie
    },
    {
      soc: 'measure_percentage.bat_soc', power: 'measure_power.battery', invertPower: true, // Blauhoff Afore (pre-existing behaviour, unverified against Blauhoff's own docs)
    },
    {
      soc: 'measure_percentage.battery1', power: 'measure_power.battery1', invertPower: true, // Blauhoff Deye (pre-existing behaviour, unverified against Blauhoff's own docs)
    },
    {
      soc: 'measure_battery', power: 'measure_power', invertPower: true, // SolarEdge Growatt (pre-existing behaviour, unverified against SolarEdge/Growatt's own docs)
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
  // Canonical display order for this driver's chart images - see lib/helpers/ChartImages.js.
  chartImages: [
    {
      id: 'todayChargeChart', prop: 'todayChargeImage', chartProp: 'chartTodayCharge', titleKey: 'today',
    },
    {
      id: 'tomorrowChargeChart', prop: 'tomorrowChargeImage', chartProp: 'chartTomorrowCharge', titleKey: 'tomorrow',
    },
    {
      id: 'nextHoursChargeChart', prop: 'nextHoursChargeImage', chartProp: 'chartNextHoursCharge', titleKey: 'nextHours',
    },
    {
      id: 'yesterdayChargeChart', prop: 'yesterdayChargeImage', chartProp: 'chartYesterdayCharge', titleKey: 'yesterday',
    },
  ],
};

class BatteryDriver extends GenericDriver {

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
    if (this.energyPollCallback) return;
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    EnergyPollingHelper.init(this.homey, { log: this.log.bind(this), error: this.error.bind(this) });
    await this.startPollingEnergy(5).catch((err) => this.error(err));
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async startPollingEnergy(interval) {
    const int = interval || 5;
    let lastCumulativePower = null;
    let lastProcessTime = 0;

    this.energyPollCallback = async (report) => {
      // eslint-disable-next-line global-require
      const { getGridPowerFallback } = require('../../lib/helpers/Util');
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
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
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

    // eslint-disable-next-line global-require
    const nomXomStrategy = require('../../lib/strategies/NomXomStrategy');
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
