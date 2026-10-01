/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const crypto = require('crypto');
const GenericDriver = require('../../lib/genericDeviceDrivers/generic_bat_driver');
const EvCarCaps = require('../../lib/helpers/EvCarCaps');
const EvHistory = require('../../lib/helpers/EvHistory');
// Dependencies are lazy loaded in methods to save memory

const driverSpecifics = {
  driverId: 'evCharger',
  deviceCapabilities: [
    // Live power and the car first: what the device tile and the device page lead with.
    'measure_watt_avg', 'ev_car_state', 'measure_ev_soc', 'ev_next_departure',
    'ev_tomorrow', 'ev_tomorrow_time', 'ev_charge_mode',
    'meter_kwh_last_hour', 'meter_kwh_this_hour', 'meter_kwh_last_day', 'meter_kwh_this_day',
    'meter_kwh_last_month', 'meter_kwh_this_month', 'meter_kwh_last_year', 'meter_kwh_this_year',
    'meter_target_month_to_date', 'meter_target_year_to_date',
    'meter_money_last_hour', 'meter_money_this_hour', 'meter_money_last_day', 'meter_money_this_day',
    'meter_money_last_month', 'meter_money_this_month', 'meter_money_last_year', 'meter_money_this_year',
    'meter_money_this_month_avg', 'meter_money_this_year_avg',
    'meter_tariff', 'meter_power',
    // Needed by the shared generic_bat_device.js base class (same as drivers/battery/driver.js):
    // meter_power_hidden anchors updateMeterFromMeasure()'s delta baseline and the large-jump
    // anomaly guard in handleUpdateMeter(); without it, updateMeterFromMeasure() silently no-ops
    // on every call for any EV charger paired via the "measure_power only" path (no separate
    // cumulative meter capability on the source device), so kWh/money never accumulate for it.
    'meter_power_hidden', 'meter_kwh_charging', 'meter_kwh_discharging',
    // Lets the user force a re-learn from Insights history, same as solar's own button.retrain.
    'button.retrain',
    // Not plugged in while the next departure needs charge (solar's alarm_power: last, own title).
    'alarm_generic',
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
    // Added later, so last: an image's position is fixed when first registered.
    {
      id: 'evWeeklyChart', prop: 'evWeeklyImage', chartProp: 'chartEvWeekly', titleKey: 'ev_weekly',
    },
  ],
};

class CarChargeDriver extends GenericDriver {
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
  }

  async onUninit() {
    if (this.energyPollCallback) {
      // eslint-disable-next-line global-require
      const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
      EnergyPollingHelper.unregister(this.energyPollCallback);
    }
    await super.onUninit();
  }

  async registerEnergyPoller() {
    if (!this.energyPollCallback) return;
    // eslint-disable-next-line global-require
    const EnergyPollingHelper = require('../../lib/helpers/EnergyPollingHelper');
    await EnergyPollingHelper.register(this.energyPollCallback);
  }

  async startPollingEnergy(interval) {
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

  // ─── Device compatibility checks ────────────────────────────────────────────

  /**
   * Check if a Homey device is a suitable EV charger (wallbox / smart plug used as charger).
   * Returns { found, useMeasureSource } or { found: false }.
   */
  checkDeviceCompatibility(homeyDevice) {
    // Exclude PBTH's own summary devices, same convention as generic_sum_driver.js
    // (used by gas/solar/water): driverId, not the device's own editable name.
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || []; // guard against null capabilities
    const energyData = homeyDevice.energyObj || homeyDevice.energy;
    let isCharger = false;

    if (homeyDevice.class === 'evcharger' || homeyDevice.virtualClass === 'evcharger') {
      isCharger = true;
    } else if (energyData && energyData.isEVCharger === true) {
      // Covers smart plugs/sockets too: Homey's own "This device is an EV charger"
      // energy setting, not a guess based on the device's (user-editable) name.
      isCharger = true;
    }

    if (isCharger) {
      const hasMeter = caps.includes('meter_power');
      const hasMeasure = caps.includes('measure_power');
      const useMeasureSource = !hasMeter && hasMeasure;
      if (hasMeter || hasMeasure) {
        return { found: true, useMeasureSource };
      }
    }

    return { found: false };
  }

  /**
   * Check if a Homey device is a suitable EV car (provides SoC or connection state).
   * Returns { found: true } or { found: false }.
   */
  checkCarCompatibility(homeyDevice) {
    // Exclude PBTH's own summary devices, same convention as generic_sum_driver.js
    // (used by gas/solar/water): driverId, not the device's own editable name.
    if ((homeyDevice.driverId || '').includes('com.gruijter.powerhour')) {
      return { found: false };
    }

    const caps = homeyDevice.capabilities || [];
    // 'vehicle' is Homey's official class for cars/bikes/scooters when 'car' doesn't apply
    // (e.g. this developer's own com.kia_hyundai app uses it); virtualClass is the
    // user's explicit "what type is this" override in Homey's device settings.
    const carClasses = ['car', 'vehicle'];
    if (carClasses.includes(homeyDevice.class) || carClasses.includes(homeyDevice.virtualClass)) {
      return { found: true };
    }
    // Fallback for apps that use a generic class (e.g. 'sensor') for their car driver.
    // Require a charge-state capability together with a SoC reading: measure_battery
    // alone is far too common (any battery-powered sensor has it) to be a reliable signal.
    // 'ev_charging_state' is the car/vehicle-class equivalent of 'evcharger_charging_state'
    // (identical enum, see device.js's addSourceCapGroup() for the full explanation).
    const hasChargeState = caps.includes('evcharger_charging_state') || caps.includes('ev_charging_state') || caps.includes('evcharger_charging');
    const hasSoc = caps.includes('measure_battery');
    if (hasChargeState && hasSoc) return { found: true };
    return { found: false };
  }

  getDeviceSettings(homeyDevice) {
    return {
      homey_device_id: homeyDevice.id,
      homey_device_name: homeyDevice.name,
      ev_device_id: 'none',
      ev_device_name: 'none',
      level: this.homey.app.manifest.version,
      tariff_update_group: 1,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  async _getAllHomeyDevices() {
    let api;
    try {
      api = this.homey.app.api;
    } catch { /* ignore */ }
    if (!api) throw new Error(this.homey.__('error_homey_api_not_ready'));
    const allDevices = await api.devices.getDevices({ $timeout: 15000 }).catch((err) => this.error(err));
    return allDevices || {};
  }

  async _listChargerDevices() {
    try {
      const allDevices = await this._getAllHomeyDevices();
      const listed = [];

      Object.values(allDevices).forEach((homeyDevice) => {
        const compat = this.checkDeviceCompatibility(homeyDevice);
        if (!compat.found) return;

        listed.push({
          id: homeyDevice.id,
          name: homeyDevice.name,
          useMeasureSource: !!compat.useMeasureSource,
        });
      });

      return listed;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async _listCarDevices() {
    try {
      const allDevices = await this._getAllHomeyDevices();
      const listed = [];

      Object.values(allDevices).forEach((homeyDevice) => {
        const compat = this.checkCarCompatibility(homeyDevice);
        if (!compat.found) return;

        listed.push({
          id: homeyDevice.id,
          name: homeyDevice.name,
        });
      });

      return listed;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // ─── Pairing / repairing ─────────────────────────────────────────────────────

  /**
   * Lists one entry per charger (no car linked), plus one entry per
   * charger+car combination, so the user picks both in a single, familiar
   * device-selection list instead of a separate car-picking step.
   */
  async onPairListDevices() {
    const randomId = crypto.randomBytes(3).toString('hex');
    const [chargers, cars] = await Promise.all([this._listChargerDevices(), this._listCarDevices()]);
    const devices = [];

    chargers.forEach((charger) => {
      const baseSettings = this.getDeviceSettings(charger);
      if (charger.useMeasureSource) baseSettings.use_measure_source = true;

      devices.push({
        name: `${charger.name}_Σ`,
        data: { id: `PH_${this.ds.driverId}_${charger.id}_${randomId}` },
        settings: { ...baseSettings },
        capabilities: this.capabilitiesFor(baseSettings),
      });

      cars.forEach((car) => {
        devices.push({
          name: `${charger.name}_Σ (${car.name})`,
          data: { id: `PH_${this.ds.driverId}_${charger.id}_${car.id}_${randomId}` },
          settings: { ...baseSettings, ev_device_id: car.id, ev_device_name: car.name },
          capabilities: this.capabilitiesFor(baseSettings),
        });
      });
    });

    return devices;
  }

  // The capability list for these settings: paired with it, and kept on it by the device's
  // migration (correctCapabilities), so a new device does not migrate right away.
  capabilitiesFor(settings = {}) {
    let caps = [...this.ds.deviceCapabilities];
    // Budget targets only with a budget, discharging only with V2X.
    if (!settings.distribution || settings.distribution === 'NONE') caps = caps.filter((cap) => !cap.includes('meter_target'));
    if (!settings.v2x) caps = caps.filter((cap) => cap !== 'meter_kwh_discharging');
    return caps;
  }

  // Settings asked in the setup view at pair and repair, as defined in the driver settings.
  static SETUP_SETTINGS = ['chargePower', 'batCapacity', 'variableChargePower', 'tariff_update_group', 'chargerControl'];

  // Shown with this value also at repair, whatever the device has now.
  static SETUP_PRESET = { chargerControl: true };

  _settingDefs() {
    const driver = this.homey.app.manifest.drivers.find((d) => d.id === this.ds.driverId) || {};
    const defs = {};
    const walk = (list) => (list || []).forEach((s) => {
      if (s.children) walk(s.children);
      else defs[s.id] = s;
    });
    walk(driver.settings);
    return defs;
  }

  // Tariff update groups with the names of the electricity DAP devices in them.
  _tariffGroupOptions(current) {
    const names = {};
    ['dap', 'dap15'].forEach((driverId) => {
      let devices = [];
      try {
        devices = this.homey.drivers.getDriver(driverId).getDevices();
      } catch {
        return;
      }
      devices.forEach((dap) => {
        const group = Number(dap.getSettings().tariff_update_group);
        if (!group) return;
        (names[group] = names[group] || []).push(dap.getName());
      });
    });
    const groups = Object.keys(names).map(Number);
    if (typeof current === 'number' && !groups.includes(current)) groups.push(current);
    return groups.sort((a, b) => a - b)
      .map((group) => ({ id: group, label: `${group}${names[group] ? `: ${names[group].join(', ')}` : ''}` }));
  }

  // Setup view (pair and repair): the settings above and, with a car, per role the fitting
  // capabilities of that car with the choice stored earlier for it.
  _setSetupGetHandler(session, getSelected, getCurrent) {
    session.setHandler('setup_get', async () => {
      const dev = getSelected();
      if (!dev || !dev.settings) throw Error(this.homey.__('error_device_corrupt'));
      const { settings: current, carCaps: stored } = getCurrent(dev);
      const lang = this.homey.i18n.getLanguage() || 'en';
      const text = (t) => (t ? t[lang] || t.en : '');
      const defs = this._settingDefs();
      const settings = CarChargeDriver.SETUP_SETTINGS.filter((id) => defs[id]).map((id) => {
        const def = defs[id];
        let value = current[id] !== undefined ? current[id] : def.value;
        if (CarChargeDriver.SETUP_PRESET[id] !== undefined) value = CarChargeDriver.SETUP_PRESET[id];
        const setting = {
          id, type: def.type, label: text(def.label), value, min: def.min, max: def.max,
        };
        if (id === 'tariff_update_group') {
          setting.type = 'dropdown';
          setting.options = this._tariffGroupOptions(value);
        }
        return setting;
      });
      // Charge power: 0 uses the measured one, from the charger's history.
      const power = settings.find((setting) => setting.id === 'chargePower');
      if (power) {
        const measured = current.measuredPower || await this._measuredChargePower(dev.settings.homey_device_id);
        power.info = measured
          ? this.homey.__('repair.setup_power_measured', { power: measured })
          : this.homey.__('repair.setup_power_unmeasured', { power: EvHistory.DEFAULT_CHARGE_POWER_W });
      }

      const carId = dev.settings.ev_device_id;
      const car = carId && carId !== 'none' && this.homey.app.api
        ? await this.homey.app.api.devices.getDevice({ id: carId, $cache: false }).catch(() => null) : null;
      if (!car) return { settings, car: null, roles: [] };
      const chosen = stored && stored.carId === carId ? stored.caps : {};
      const roles = EvCarCaps.carCapOptions(car).map((role) => ({ ...role, selected: chosen[role.key] || 'auto' }));
      return {
        settings, car: car.name, carId, roles,
      };
    });
  }

  // Charge power (W) from the charger's Insights power history, or null.
  async _measuredChargePower(chargerId) {
    const { api } = this.homey.app;
    if (!api || !chargerId) return null;
    const allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
    const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 42 * 24 * 60 * 60 * 1000);
    const entries = await EvHistory.fetchPowerLog({
      api, logs, deviceId: chargerId, capNames: ['energy_power', 'meter_power'], startDate, endDate,
    }).catch(() => null);
    return EvHistory.detectChargePower(entries);
  }

  // Values from the setup view, checked against the setting definitions.
  _setupSettings(values = {}) {
    const defs = this._settingDefs();
    const settings = {};
    CarChargeDriver.SETUP_SETTINGS.forEach((id) => {
      const def = defs[id];
      if (!def || values[id] === undefined) return;
      if (def.type === 'checkbox') {
        settings[id] = !!values[id];
        return;
      }
      let num = Number(values[id]);
      if (!Number.isFinite(num)) return;
      if (typeof def.min === 'number') num = Math.max(def.min, num);
      if (typeof def.max === 'number') num = Math.min(def.max, num);
      settings[id] = num;
    });
    return settings;
  }

  // Pairing: charger (+ car) from the list, then the setup view creates the device.
  onPair(session) {
    let selected = null;
    session.setHandler('list_devices', () => this.onPairListDevices());
    session.setHandler('list_devices_selection', (devices) => {
      [selected] = devices;
    });
    this._setSetupGetHandler(session, () => selected, (dev) => ({ settings: dev.settings, carCaps: null }));
    session.setHandler('setup_set', async (data) => {
      if (!selected) throw Error(this.homey.__('error_device_corrupt'));
      const settings = { ...selected.settings, ...this._setupSettings(data && data.settings) };
      // The group's currency right away: else the first prices set it, with a restart during init.
      const currency = this.currencies && this.currencies[settings.tariff_update_group];
      if (currency) settings.currency = currency;
      const store = { ...(selected.store || {}) };
      if (data && data.carId) store.evCarCaps = { carId: data.carId, caps: data.caps || {} };
      return { device: { ...selected, settings, store } }; // the view creates it
    });
  }

  // Same as the generic_bat_driver base version, but also persists the EV car link and the setup.
  async onRepair(session, device) {
    this.log('Repairing of device started', device.getName());
    let selectedDevices = [];
    let setup = null; // {settings, carCaps}: from the setup view
    session.setHandler('list_devices', () => this.onPairListDevices());
    session.setHandler('list_devices_selection', (devices) => {
      selectedDevices = devices;
    });
    this._setSetupGetHandler(session, () => selectedDevices[0], (dev) => ({
      settings: device.getSettings(),
      carCaps: device.getStoreValue('evCarCaps'),
      // Measured by this device, when the charger stays the same.
      measuredPower: dev.settings.homey_device_id === device.getSettings().homey_device_id
        ? device.getStoreValue('detectedMaxPower') : null,
    }));
    session.setHandler('setup_set', async (data) => {
      setup = {
        settings: this._setupSettings(data && data.settings),
        carCaps: data && data.carId ? { carId: data.carId, caps: data.caps || {} } : null,
      };
      return {}; // the view continues to 'loading'
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'loading') {
        const [dev] = selectedDevices;
        if (!dev || !dev.settings) {
          await session.showView('done');
          throw Error(this.homey.__('error_device_corrupt'));
        }
        const newSettings = {
          homey_device_id: dev.settings.homey_device_id,
          homey_device_name: dev.settings.homey_device_name,
          ev_device_id: dev.settings.ev_device_id,
          ev_device_name: dev.settings.ev_device_name,
          ...(setup ? setup.settings : {}),
        };
        this.log('old settings:', device.getSettings());
        if (newSettings.tariff_update_group !== undefined
          && newSettings.tariff_update_group !== device.getSettings().tariff_update_group) {
          device.tariffGroupChanged = true; // prices of the new group after the restart
        }
        await device.setSettings(newSettings).catch((err) => this.error(err));
        if (setup && setup.carCaps) await device.setStoreValue('evCarCaps', setup.carCaps).catch((err) => this.error(err));
        await session.showView('done');
        this.log('new settings:', device.getSettings());
        device.restartDevice().catch((err) => this.error(err));
      }
    });
    session.setHandler('disconnect', () => {
      this.log('Repairing of device ended', device.getName());
    });
  }
}

module.exports = CarChargeDriver;
