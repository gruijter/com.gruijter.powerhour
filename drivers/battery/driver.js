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
const PairSetup = require('../../lib/helpers/PairSetup');
const SourceCaps = require('../../lib/helpers/SourceCaps');
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'battery',
  // Exceptions list, used only when a source device does NOT already qualify for the official
  // Homey battery-energy-class detection in autoSourceCapGroup() (class 'battery' + 'measure_battery'
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
      // and are matched via the official Homey battery-class check in autoSourceCapGroup() instead.
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
  // Asked at pair and repair (lib/helpers/PairSetup.js).
  setup: {
    settings: ['tariff_update_group', 'batCapacity', 'chargePower', 'dischargePower', 'roiEnable'],
    match: {
      classes: ['battery'],
      energy: (energy) => !!(energy.meterPowerImportedCapability || energy.meterPowerExportedCapability),
    },
  },
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

      // Plausibility bound on the GRID exchange feeding the XOM/NOM logic. Was a flat 30000 W;
      // now derived from the grid device's configured connection rating, so it scales with the
      // actual connection instead of silently discarding real readings above 30 kW and accepting
      // absurd ones on a small connection. Falls back to the 3x25A default when no grid device is
      // paired, which is exactly the old behaviour's ballpark. See lib/helpers/GridConnection.js.
      // eslint-disable-next-line global-require
      const GridConnection = require('../../lib/helpers/GridConnection');
      const ceilingW = await GridConnection.ceilingW(this.homey);

      if (Number.isFinite(cumulativePower) && Math.abs(cumulativePower) <= ceilingW) {
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
    } catch {
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
    if (this.autoSourceCapGroup(homeyDevice)) return { found: true, useMeasureSource: false };

    // A charge level and a power: their capabilities are mapped in the setup view.
    if (!(homeyDevice.driverId || '').includes('com.gruijter.powerhour')
      && SourceCaps.hasKind(homeyDevice, 'pct') && SourceCaps.hasKind(homeyDevice, 'w')) {
      return { found: true, useMeasureSource: false, needsMapping: true };
    }
    return { found: false };
  }

  // The capabilities of a source device, as detected: { group, invert } or null.
  autoSourceCapGroup(sourceDevice) {
    const caps = sourceDevice.capabilities || [];
    const hasCapability = (capability) => caps.includes(capability);
    // 1. Prefer the official Homey battery-energy-class standard: class 'battery' with
    // 'measure_battery' + 'measure_power', where measure_power already follows the Homey
    // convention (positive = charging, negative = discharging) - no sign correction needed.
    if ((sourceDevice.class === 'battery' || sourceDevice.virtualClass === 'battery')
      && hasCapability('measure_battery') && hasCapability('measure_power')) {
      const energyData = sourceDevice.energyObj || sourceDevice.energy;
      const imported = energyData && energyData.meterPowerImportedCapability;
      const exported = energyData && energyData.meterPowerExportedCapability;
      return {
        group: {
          soc: 'measure_battery',
          newMeasurePower: 'measure_power',
          chargingState: hasCapability('battery_charging_state') ? 'battery_charging_state' : null,
          meterCharging: imported && hasCapability(imported) ? imported : null,
          meterDischarging: exported && hasCapability(exported) ? exported : null,
        },
        invert: false,
      };
    }
    // 2. Fall back to the documented vendor exceptions list (see sourceCapGroups) for source
    // devices that don't (yet) comply with the official Homey battery energy standard.
    // 'invertPower' is metadata, not a capability name, so it must not be used as a required
    // capability nor registered as a listener target.
    const matched = SourceCaps.matchGroup(caps, this.ds.sourceCapGroups, ['invertPower']);
    if (!matched) return null;
    const group = { ...matched };
    delete group.invertPower;
    return { group, invert: !!matched.invertPower };
  }

  // Roles chosen in the setup view, and the kind of capability that fits.
  static CAP_ROLES = ['soc', 'power', 'chargePower', 'dischargePower', 'meterCharging', 'meterDischarging'];

  static ROLE_KINDS = {
    soc: 'pct', power: 'w', chargePower: 'w', dischargePower: 'w', meterCharging: 'kwh', meterDischarging: 'kwh',
  };

  // A detected group by role: the Homey standard power is the 'power' role too.
  static roleView(group) {
    const view = {};
    BatteryDriver.CAP_ROLES.forEach((role) => {
      view[role] = group[role] || null;
    });
    if (group.newMeasurePower) view.power = group.newMeasurePower;
    return view;
  }

  // The detected capabilities with the choice from the setup view: { group, invert }, or null
  // without a charge level and a power.
  sourceCapGroupFor(sourceDevice, stored) {
    const auto = this.autoSourceCapGroup(sourceDevice) || { group: {}, invert: false };
    const chosen = SourceCaps.chosenFor(stored, sourceDevice.id);
    const picked = SourceCaps.applyChoice(sourceDevice, BatteryDriver.roleView(auto.group), BatteryDriver.CAP_ROLES, chosen);
    const group = { ...auto.group, ...picked };
    let { invert } = auto;
    // A Homey standard battery: its power is signed by the charging state.
    if (auto.group.newMeasurePower) {
      group.newMeasurePower = picked.power;
      delete group.power;
    }
    if (chosen.sign === 'normal') invert = false;
    if (chosen.sign === 'inverted') {
      invert = true;
      if (group.newMeasurePower) {
        group.power = group.newMeasurePower;
        delete group.newMeasurePower;
        delete group.chargingState;
      }
    }
    Object.keys(group).forEach((key) => {
      if (!group[key]) delete group[key];
    });
    const hasPower = group.power || group.newMeasurePower || group.chargePower || group.dischargePower;
    return group.soc && hasPower ? { group, invert } : null;
  }

  // A signed power and a charge or discharge power would both count the same energy.
  static mixedPower(group) {
    return !!((group.power || group.newMeasurePower) && (group.chargePower || group.dischargePower));
  }

  async _setupSourceDevice(settings) {
    return PairSetup.apiDevice(this, settings.homey_device_id);
  }

  // Setup view: per role the capabilities of the battery, and the sign of its power.
  async setupRoles(dev, stored) {
    const source = await this._setupSourceDevice(dev.settings);
    if (!source) return null;
    const auto = this.autoSourceCapGroup(source) || { group: {}, invert: false };
    const chosen = SourceCaps.chosenFor(stored, source.id);
    const roles = BatteryDriver.CAP_ROLES.map((key) => ({
      key, kind: BatteryDriver.ROLE_KINDS[key], label: this.homey.__(`repair.setup_role_${key}`),
    }));
    const signLabel = (inverted) => this.homey.__(inverted ? 'repair.setup_sign_inverted' : 'repair.setup_sign_normal');
    const items = SourceCaps.roleItems(source, roles, BatteryDriver.roleView(auto.group), chosen);
    items.push({
      key: 'sign',
      label: this.homey.__('repair.setup_role_sign'),
      auto: signLabel(auto.invert),
      options: [{ id: 'normal', label: signLabel(false) }, { id: 'inverted', label: signLabel(true) }],
      selected: chosen.sign || 'auto',
      noNone: true,
    });
    return {
      deviceId: source.id,
      title: this.homey.__('repair.setup_caps_title'),
      text: `${source.name}. ${this.homey.__('repair.setup_caps_text')}`,
      items,
    };
  }

  async setupValidate(settings, caps) {
    const source = await this._setupSourceDevice(settings);
    if (!source) return;
    const resolved = this.sourceCapGroupFor(source, { sourceId: source.id, caps });
    if (!resolved) throw Error(this.homey.__('error_setup_bat_caps_missing'));
    if (BatteryDriver.mixedPower(resolved.group)) throw Error(this.homey.__('error_setup_bat_power_mixed'));
  }

  // Advanced ROI needs a Homey Pro (Early 2023).
  setupSettings() {
    const HP2023 = this.homey.platformVersion === 2;
    return this.ds.setup.settings.filter((id) => HP2023 || id !== 'roiEnable');
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    const HP2023 = this.homey.platformVersion === 2;
    settings.roiEnable = HP2023;
    return settings;
  }
}

module.exports = BatteryDriver;
