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
  // Vendor exceptions, used only when a source device does not qualify as a Homey battery (class
  // 'battery' + measure_battery + measure_power). Homey standard: positive = charging
  // (https://apps.developer.homey.app/the-basics/devices/energy#home-batteries).
  //   - `power` + `invertPower`: one signed capability; invertPower when the vendor's sign is opposite.
  //   - `chargePower` + `dischargePower`: two non-negative magnitudes.
  sourceCapGroups: [
    {
      soc: 'measure_battery_soc', power: 'measure_battery_power', invertPower: true, // Solax (unverified)
    },
    {
      soc: 'battery_capacity', power: 'measure_power.battery', invertPower: true, // Victron (unverified)
    },
    {
      // Sessy fallback for older app versions without class 'battery': legacy inverted measure_power.battery.
      soc: 'measure_battery', power: 'measure_power.battery', invertPower: true, // Sessy (legacy fallback)
    },
    {
      soc: 'measure_battery', chargePower: 'measure_power.batt_in', dischargePower: 'measure_power.batt_out', // Sonnen
    },
    {
      soc: 'measure_battery', chargePower: 'to_battery_capability', dischargePower: 'from_battery_capability', // Sonnen Batterie
    },
    {
      soc: 'measure_percentage.bat_soc', power: 'measure_power.battery', invertPower: true, // Blauhoff Afore (unverified)
    },
    {
      soc: 'measure_percentage.battery1', power: 'measure_power.battery1', invertPower: true, // Blauhoff Deye (unverified)
    },
    {
      soc: 'measure_battery', power: 'measure_power', invertPower: true, // SolarEdge Growatt (unverified)
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
    settings: ['tariff_update_group', 'batCapacity', 'chargePower', 'dischargePower', 'roiEnable', 'batteryControl'],
    match: {
      classes: ['battery'],
      energy: (energy) => !!(energy.meterPowerImportedCapability || energy.meterPowerExportedCapability),
    },
  },
  // Chart image order, see lib/helpers/ChartImages.js.
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
    {
      id: 'efficiencyChart', prop: 'efficiencyImage', chartProp: 'chartEfficiency', titleKey: 'chart_eff.title',
    },
  ],
};

class BatteryDriver extends GenericDriver {

  async onInit() {
    this.ds = driverSpecifics;
    await super.onInit().catch(this.error);

    // Polling starts with the first device (checkStartPolling).
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

      // Plausibility bound on the grid exchange for XOM/NOM, see lib/helpers/GridConnection.js.
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
    // Batteries this app controls itself are left out of the XOM flows.
    const flowDevices = devices.filter((d) => !(typeof d.isZeroControlled === 'function' && d.isZeroControlled()));

    // eslint-disable-next-line global-require
    const nomXomStrategy = require('../../lib/strategies/NomXomStrategy');
    const strategy = nomXomStrategy.getStrategy({
      devices: flowDevices,
      cumulativePower,
      x,
      minLoad,
    });

    const promises = flowDevices.map((device) => {
      const strat = strategy.find((info) => info.id === device.getData().id);
      return device.triggerXOMFlow(strat, samples, x, smoothing, minLoad, cumulativePower);
    });
    await Promise.all(promises);
    await this.controlTick(devices, cumulativePower, { x, minLoad, samples });
  }

  // The batteries planned as one, in one mode (setting groupPlan, not 'device'), controlled here
  // or by flows.
  groupDevices() {
    return this.getDevices().filter((d) => typeof d.inGroup === 'function' && d.inGroup());
  }

  // A mode for the whole group (picker, flow), with the same end time of a temporary mode. origin
  // joins too (it can come from 'device').
  async setGroupMode(mode, reason, until, origin) {
    const group = this.groupDevices();
    if (origin && !group.includes(origin)) group.push(origin);
    this.log(`[Bat Control] Group mode ${mode} for ${group.map((d) => d.getName()).join(', ')} (${reason})`);
    for (const d of group) {
      await d.setBatteryMode(mode, reason, 0, { sync: false, until }).catch((err) => d.error(err));
    }
  }

  // Built-in control. Zero on the meter (zero/hold blocks) is split over the batteries by
  // NomXomStrategy, as for the XOM flows, against the grid without the batteries this app forces
  // (charge/discharge/idle), so the batteries do not trade energy with each other.
  async controlTick(devices, gridW, { x = 0, minLoad = 50, samples = 1 } = {}) {
    const now = Date.now();
    const preps = new Map();
    for (const d of devices) {
      if (typeof d.controlPrepare === 'function') {
        const prep = await d.controlPrepare(now).catch((err) => d.error(err));
        if (prep) preps.set(d, prep);
      }
    }
    const active = [...preps.keys()];
    if (!active.length) return;
    const isNom = (d) => ['zero', 'hold'].includes(preps.get(d).block) && !preps.get(d).refill;
    const forcedW = active.filter((d) => !isNom(d)).reduce((a, d) => a + d.controlPowerW(), 0);
    const nomGridW = gridW - forcedW;
    const candidates = active.filter(isNom);
    // Hold batteries only take part when charging.
    const charging = candidates.reduce((a, d) => a + d.controlPowerW(), 0) - (nomGridW - x) > 0;
    const nomDevices = candidates.filter((d) => preps.get(d).block === 'zero' || charging);
    // NomXomStrategy reads xomTargetPower: here the last setpoint of this app.
    const views = nomDevices.map((d) => ({
      getData: () => d.getData(),
      getName: () => d.getName(),
      getSettings: () => d.getSettings(),
      getCapabilityValue: (cap) => d.getCapabilityValue(cap),
      soc: d.soc,
      reservePct: () => d.reservePct(),
      xomTargetPower: d.controlPowerW(),
    }));
    // eslint-disable-next-line global-require
    const nomXomStrategy = require('../../lib/strategies/NomXomStrategy');
    const strategy = views.length ? nomXomStrategy.getStrategy({
      devices: views, cumulativePower: nomGridW, x, minLoad,
    }) : [];
    const weight = (d) => Math.max(1, Number(d.getSettings().chargePower) || 0);
    const total = active.reduce((a, d) => a + weight(d), 0);
    await Promise.all(active.map((d) => {
      // Not in zero on the meter now (forced block, or hold while discharging): no NOM part.
      let nom = { targetW: 0, needW: 0 };
      const strat = nomDevices.includes(d) && strategy.find((info) => info.id === d.getData().id);
      if (strat) {
        // Smoothed as the XOM flow does (setting smoothing).
        const prev = typeof d.nomTargetW === 'number' ? d.nomTargetW : d.controlPowerW();
        d.nomTargetW = (strat.target / samples) + (prev * ((samples - 1) / samples));
        nom = { targetW: d.nomTargetW, needW: strat.target };
      } else {
        d.nomTargetW = null;
      }
      return d.controlApply(preps.get(d), now, gridW, nom, weight(d) / total).catch((err) => d.error(err));
    }));
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
    // 1. The Homey battery standard: measure_power already signed (+ = charging).
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
          setpoint: BatteryDriver.autoSetpoint(sourceDevice),
        },
        invert: false,
      };
    }
    // 2. The vendor exceptions (sourceCapGroups). 'invertPower' is metadata, not a capability.
    const matched = SourceCaps.matchGroup(caps, this.ds.sourceCapGroups, ['invertPower']);
    if (!matched) return null;
    const group = { ...matched, setpoint: BatteryDriver.autoSetpoint(sourceDevice) };
    delete group.invertPower;
    return { group, invert: !!matched.invertPower };
  }

  // Homey's standard battery setpoint (+ = charging), when the app lets it be set.
  static autoSetpoint(sourceDevice) {
    const obj = sourceDevice.capabilitiesObj && sourceDevice.capabilitiesObj.target_power;
    if (obj) return obj.setable === true ? 'target_power' : null;
    return (sourceDevice.capabilities || []).includes('target_power') ? 'target_power' : null;
  }

  // Roles chosen in the setup view, and the kind of capability that fits.
  static CAP_ROLES = ['soc', 'power', 'chargePower', 'dischargePower', 'meterCharging', 'meterDischarging', 'setpoint'];

  static ROLE_KINDS = {
    soc: 'pct', power: 'w', chargePower: 'w', dischargePower: 'w', meterCharging: 'kwh', meterDischarging: 'kwh', setpoint: 'setW',
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

  // The detected capabilities with the choice from the setup view: { group, invert,
  // setpointInvert }, or null without a charge level and a power.
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
    // target_power follows Homey (+ = charging); another setpoint as chosen.
    const setpointInvert = chosen.setpointSign === 'inverted';
    return group.soc && hasPower ? { group, invert, setpointInvert } : null;
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
    items.push({
      key: 'setpointSign',
      label: this.homey.__('repair.setup_role_setpointSign'),
      auto: signLabel(false),
      options: [{ id: 'normal', label: signLabel(false) }, { id: 'inverted', label: signLabel(true) }],
      selected: chosen.setpointSign || 'auto',
      noNone: true,
    });
    // Without Homey's mode capability the battery app must be set to external control by hand.
    const external = (source.capabilities || []).includes('target_power_mode') ? '' : ` ${this.homey.__('repair.setup_bat_external')}`;
    return {
      deviceId: source.id,
      title: this.homey.__('repair.setup_caps_title'),
      text: `${source.name}. ${this.homey.__('repair.setup_caps_text')}${external}`,
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

  // The LP planner (roiEnable) and the control that follows the plan need a Homey Pro (Early 2023);
  // other Homeys plan with the light planner.
  setupSettings() {
    const HP2023 = this.homey.platformVersion === 2;
    return this.ds.setup.settings.filter((id) => HP2023 || !['roiEnable', 'batteryControl'].includes(id));
  }

  // Every battery plans (LP or light planner); the mode picker comes with control, on a Homey Pro
  // (Early 2023).
  capabilitiesFor(settings = {}) {
    const caps = super.capabilitiesFor(settings);
    if (!caps.includes('roi_duration')) caps.push('roi_duration');
    if (this.homey.platformVersion === 2) caps.push('battery_mode');
    return caps;
  }

  getDeviceSettings(homeyDevice) {
    const settings = super.getDeviceSettings(homeyDevice);
    const HP2023 = this.homey.platformVersion === 2;
    settings.roiEnable = HP2023;
    return settings;
  }
}

module.exports = BatteryDriver;
