/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const EvChargeStrategy = require('../../lib/strategies/EvChargeStrategy');
const EvDepartureStrategy = require('../../lib/strategies/EvDepartureStrategy');
const EvPresence = require('../../lib/strategies/EvPresence');
const EvSocEstimator = require('../../lib/strategies/EvSocEstimator');
const EvChargerControl = require('../../lib/strategies/EvChargerControl');
const EvFlows = require('../../lib/flows/EvFlows');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const ChartImages = require('../../lib/helpers/ChartImages');
const { setTimeoutPromise } = require('../../lib/helpers/Util');
const MeterHelpers = require('../../lib/helpers/MeterHelpers');

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_kwh_this_hour',
    last_hour: 'meter_kwh_last_hour',
    this_day: 'meter_kwh_this_day',
    last_day: 'meter_kwh_last_day',
    this_month: 'meter_kwh_this_month',
    last_month: 'meter_kwh_last_month',
    this_year: 'meter_kwh_this_year',
    last_year: 'meter_kwh_last_year',
    meter_source: 'meter_power',
    measure_source: 'measure_watt_avg',
  },
};

// Day labels for learned profile settings keys (0=Monday)
const LEARNED_PROFILE_KEYS = [
  'learned_profile_mon', 'learned_profile_tue', 'learned_profile_wed',
  'learned_profile_thu', 'learned_profile_fri', 'learned_profile_sat', 'learned_profile_sun',
];

// Capabilities read from the linked car device, first match wins. Homey standard ids plus ids
// confirmed in specific car apps (com.kia_hyundai: latitude/longitude, measure_odo,
// charge_target_slow, refresh_status). Support for another car app is a matter of adding its ids.
const CAR_CAPS = {
  soc: ['measure_battery'],
  plugState: ['evcharger_charging_state', 'ev_charging_state'],
  plugBool: ['evcharger_charging'],
  latitude: ['latitude'],
  longitude: ['longitude'],
  odometer: ['measure_odo'],
  chargeLimit: ['charge_target_slow'], // AC charge limit (%) set in the car
  refresh: ['refresh_status'], // setable: ask the car app for fresh status
};

// Charger control loop: follows the plan within a price slot and times the "no response" check.
const CONTROL_TICK_MS = 60 * 1000;
// At most one car refresh request per this period.
const CAR_REFRESH_MIN_MS = 3 * 60 * 60 * 1000;
// Direct car read in the control loop, next to the car's own capability events.
const CAR_POLL_MS = 5 * 60 * 1000;
// A charging session below this is not worth waking the car for.
const CAR_REFRESH_MIN_KWH = 1;

class CarChargeDevice extends GenericDevice {

  async initDeviceValues() {
    this.lastKnownSoc = await this.getStoreValue('lastKnownSoc') || 0;
    this.socForecastModel = await this.getStoreValue('socForecastModel') || EvDepartureStrategy.createModel();
    this.socEstimator = await this.getStoreValue('socEstimator') || EvSocEstimator.createState();
    // The pre-estimator SoC stays the starting point until the car reports.
    if (typeof this.socEstimator.baseSoc !== 'number' && this.lastKnownSoc > 0) {
      this.socEstimator.baseSoc = this.lastKnownSoc;
    }
    if (!this.signals) this.signals = {};
    await super.initDeviceValues();
  }

  destroyListeners() {
    super.destroyListeners();
    if (this.controlInterval) this.homey.clearInterval(this.controlInterval);
    this.controlInterval = null;
    if (this.carReportTimeout) this.homey.clearTimeout(this.carReportTimeout);
    this.carReportTimeout = null;
  }

  async onInit() {
    this.ds = deviceSpecifics;
    this.flows = new EvFlows(this);
    this.evDevice = null; // optional secondary car device
    this.sourceCapGroup = {};
    this.carCapGroup = {};

    // Register chart images in canonical order before any periodic update can render into them.
    // Deliberately before super.onInit(): the base class sets initReady = true partway through
    // its own onInit, and onPricesUpdated() (generic_bat_device.js) fires as soon as initReady is
    // true - if that landed before images existed, updateChargeChart() would throw calling
    // .update() on an undefined image property. Only needs device.homey/device.driver, both set
    // by the platform before any onInit runs, so this has no dependency on super.onInit().
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    await super.onInit().catch(this.error);

    for (const cap of ['ev_charge_mode', 'ev_next_departure', 'ev_target_soc', 'ev_departure_time', 'button.retrain']) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability ${cap} to device ${this.getName()}`);
        await this.addCapability(cap).catch(this.error);
        await setTimeoutPromise(2 * 1000, this); // wait a bit for Homey to settle
      }
    }

    this.powerHistory = await this.loadStoredHistory('powerHistory');
    this.socHistory = await this.loadStoredHistory('socHistory');

    await this._updateEfficiencySetting();
    if (this.controlInterval) this.homey.clearInterval(this.controlInterval);
    this.controlInterval = this.homey.setInterval(() => {
      this._controlTick().catch((err) => this.error(err));
    }, CONTROL_TICK_MS);

    if (this.hasCapability('ev_charge_mode')) {
      if (!this.getCapabilityValue('ev_charge_mode')) {
        await this.setCapabilityValue('ev_charge_mode', 'scheduled_price').catch(this.error);
      }
      this.registerCapabilityListener('ev_charge_mode', async (value) => {
        this.log(`EV charge mode set to ${value}`);
        if (this.homey.app.trigger_ev_charge_mode_changed) {
          await this.homey.app.trigger_ev_charge_mode_changed(this, { mode: value }, {}).catch(this.error);
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('ev_target_soc')) {
      this.registerCapabilityListener('ev_target_soc', async (value) => {
        const numVal = Number(value) || 80;
        this.log(`EV target SoC UI picker changed to ${numVal}%`);
        const tripOverride = this.getStoreValue('tripOverride');
        if (tripOverride) {
          tripOverride.targetSoc = numVal;
          await this.setStoreValue('tripOverride', tripOverride);
        } else {
          await this.setSettings({ targetSoc: numVal }).catch(this.error);
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('ev_departure_time')) {
      this.registerCapabilityListener('ev_departure_time', async (value) => {
        this.log(`EV departure time UI picker changed to ${value}`);
        if (value === 'until_next_schedule') {
          await this.setStoreValue('tripOverride', null);
          this.log('Cleared trip override via UI picker');
        } else if (value === 'indefinite') {
          const tripOverride = this.getStoreValue('tripOverride') || {};
          tripOverride.departureTime = 'indefinite';
          await this.setStoreValue('tripOverride', tripOverride);
        } else {
          const tripOverride = this.getStoreValue('tripOverride');
          if (tripOverride) {
            tripOverride.departureTime = value;
            await this.setStoreValue('tripOverride', tripOverride);
          } else {
            await this.setSettings({ departureTime: value }).catch(this.error);
          }
        }
        await this.updateChargeChart().catch(this.error);
      });
    }

    if (this.hasCapability('button.retrain')) {
      this.retrainListener = this.registerCapabilityListener('button.retrain', async () => {
        this.log('[EV Slot] Manual retrain triggered via button.retrain');
        await this.learnDeparturePattern(); // Fully overwrites socForecastModel from scratch
        return true;
      });
    }

    const currentSessionId = this.sessionId;
    const initCharts = async () => {
      await setTimeoutPromise(2000, this);
      if (this.sessionId !== currentSessionId) return;
      if (this.pricesNextHours) {
        await this.updateChargeChart().catch((err) => this.error(err));
      }
      // Bootstrap departure model from Insights history
      await this.attemptInitialBackfill(currentSessionId);
    };
    initCharts().catch((err) => this.error(err));
  }

  // learnDeparturePattern() needs this.homey.app.api to be connected - but app.js can still be
  // mid-connect (up to a 10s timeout, then only a 60s-later retry) when this fires only ~2s
  // after onInit. learnDeparturePattern() itself treats "API not ready" as a logged no-op
  // rather than throwing, so retry here by re-checking API readiness directly instead of
  // catching an error. Unlike grid/solar (see identical fix in those drivers' device.js),
  // there's no nightly retrain safety net for the departure model, so a failed bootstrap here
  // would otherwise stick until the next full app/device restart. Guarded by sessionId (the
  // same guard already used above) rather than an explicit timeout handle, since this file
  // doesn't currently track/clear its init timers on delete.
  async attemptInitialBackfill(sessionId, attempt = 1) {
    if (this.sessionId !== sessionId) return; // superseded by a newer onInit/delete meanwhile
    const maxAttempts = 5;
    const retryDelayMs = 30000;
    let api;
    try {
      api = this.homey.app.api;
    } catch { }
    if (!api) {
      if (attempt >= maxAttempts) {
        this.error(`[attemptInitialBackfill] Homey API still not ready after ${maxAttempts} attempts, `
          + 'giving up. Departure model will stay unlearned until the next app/device restart.');
        return;
      }
      this.log(`[attemptInitialBackfill] Homey API not ready yet (attempt ${attempt}/${maxAttempts}), `
        + `retrying in ${retryDelayMs / 1000}s...`);
      this.homey.setTimeout(() => {
        this.attemptInitialBackfill(sessionId, attempt + 1).catch((err) => this.error(err));
      }, retryDelayMs);
      return;
    }
    await this.learnDeparturePattern().catch((err) => this.error(err));
  }

  // ─── Source device capability group resolution ──────────────────────────────

  async addSourceCapGroup() {
    this.sourceCapGroup = {};

    // --- Charger device (primary source = this.sourceDevice) ---
    if (this.sourceDevice) {
      const caps = this.sourceDevice.capabilities || [];
      const fallbackMeter = this.ds.cmap.meter_source;
      if (caps.includes(fallbackMeter)) {
        this.sourceCapGroup.p1 = fallbackMeter;
      }
      if (caps.includes('measure_power')) {
        this.sourceCapGroup.measure = 'measure_power';
      }
      if (caps.includes('measure_battery')) {
        this.sourceCapGroup.socOnCharger = 'measure_battery';
      }
      // The charger's own plug state (wallbox). evcharger_charging is NOT a plug state: it is
      // Homey's setable start/stop, used below as the switch.
      if (caps.includes('evcharger_charging_state')) {
        this.sourceCapGroup.connState = 'evcharger_charging_state';
      }
      this.sourceCapGroup.switchCap = EvChargerControl.SWITCH_CAPS.find((cap) => caps.includes(cap)
        && this.sourceDevice.capabilitiesObj?.[cap]?.setable !== false) || null;
    }

    // --- Optional EV car device ---
    // No auto-discovery: 'none' means the user did not link a car at pair/repair time.
    // They can attach one later via repair.
    this.carCapGroup = {};
    this.evDevice = null;
    const evDeviceId = this.getSettings().ev_device_id;

    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch { }
      if (api && evDeviceId && evDeviceId !== 'none') {
        const ev = await api.devices.getDevice({ id: evDeviceId, $cache: false }).catch(() => null);

        if (ev && ev.capabilitiesObj) {
          this.evDevice = ev;
          const evCaps = ev.capabilities || [];
          Object.entries(CAR_CAPS).forEach(([key, ids]) => {
            const cap = ids.find((id) => evCaps.includes(id));
            if (cap) this.carCapGroup[key] = cap;
          });
          // Location needs both halves.
          if (!this.carCapGroup.latitude || !this.carCapGroup.longitude) {
            delete this.carCapGroup.latitude;
            delete this.carCapGroup.longitude;
          }
          this.log(`EV car device linked: ${ev.name}`, this.carCapGroup);
        }
      }
    } catch (e) {
      this.log('Could not load EV car device:', e.message);
    }

    // Resolve effective SoC source: prefer car, fall back to charger
    this.sourceCapGroup.soc = this.carCapGroup.soc || this.sourceCapGroup.socOnCharger || null;

    if (!this.sourceCapGroup.p1 && !this.sourceCapGroup.measure) {
      throw Error('Charger device has no compatible meter_power or measure_power');
    }
  }

  // ─── Real-time listeners ────────────────────────────────────────────────────

  async addListeners() {
    let api;
    try {
      api = this.homey.app.api;
    } catch { }
    if (!api) throw new Error('Homey API not ready');
    await this.getSourceDevice();
    await this.addSourceCapGroup();

    this.log(`Registering listeners for charger: ${this.sourceDevice.name}`);

    // kWh meter
    if (this.sourceCapGroup.p1) {
      this.capabilityInstances.p1 = this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.p1,
        async (value) => this.updateMeter(value).catch(this.error),
      );
    }

    // Instantaneous power
    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure) {
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance(
        'measure_power',
        async (value) => {
          if (typeof value === 'number') {
            // measure_power on an EV charger follows Homey's standard (positive = charging the
            // car); updateMeterFromMeasure() internally re-writes measure_watt_avg with whatever
            // sign it's given (overwriting the setCapability above) and also buckets kWh into
            // meter_kwh_charging/discharging based on this same sign, so it must not be negated.
            if (targetMeasureCap) await this.setCapability(targetMeasureCap, value).catch(this.error);
            if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(value).catch(this.error);
            this._onChargerPower(value);
          }
        },
      );
    }

    // Plug state from charger (wallbox)
    if (this.sourceCapGroup.connState) {
      this.signals.chargerPlugged = EvPresence.isPluggedValue(this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.connState]?.value);
      this.capabilityInstances.chargerConnState = await this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.connState,
        async (value) => {
          this.signals.chargerPlugged = EvPresence.isPluggedValue(value);
          await this._updatePresence();
        },
      );
    }

    // Charger switch: its actual state, also when switched by hand or by another flow
    if (this.sourceCapGroup.switchCap) {
      const capObj = this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.switchCap];
      this._setSwitchSignal(capObj?.value, capObj?.lastUpdated);
      this.capabilityInstances.chargerSwitch = await this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.switchCap,
        async (value) => {
          this._setSwitchSignal(value);
          await this._updatePresence();
        },
      );
    }

    // SoC from charger (when no car device)
    if (this.sourceCapGroup.socOnCharger && !this.evDevice) {
      this.capabilityInstances.socRealtime = await this.sourceDevice.makeCapabilityInstance(
        'measure_battery',
        async () => this._scheduleCarReport(),
      );
    }

    await this._registerCarListeners();

    // Initial state from the current snapshot
    await this._processCarReport().catch(this.error);
  }

  // EV car device listeners: every status update of the car app counts as a car report
  async _registerCarListeners() {
    if (!this.evDevice) return;
    this.log(`Registering listeners for EV car: ${this.evDevice.name}`);
    const watched = ['soc', 'plugState', 'plugBool', 'latitude', 'longitude', 'odometer', 'chargeLimit'];
    for (const key of watched) {
      const cap = this.carCapGroup[key];
      const name = `car_${key}`;
      if (this.capabilityInstances[name]) this.capabilityInstances[name].destroy();
      delete this.capabilityInstances[name];
      if (!cap) continue;
      this.capabilityInstances[name] = await this.evDevice.makeCapabilityInstance(
        cap,
        async () => this._scheduleCarReport(),
      );
    }
  }

  // Fallback for missed car events: listeners made while the car app was not running received
  // nothing after it started (seen live, cause not verified). Read the car directly, and
  // re-register on the fresh device object when it has become available since.
  async _pollCar() {
    const { api } = this.homey.app;
    if (!api || !this.evDevice) return;
    const car = await api.devices.getDevice({ id: this.evDevice.id, $cache: false }).catch(() => null);
    if (!car || !car.capabilitiesObj) return;
    if (car.available && !this.evDevice.available) {
      this.log('[EV SoC] Car device became available, re-registering listeners');
      this.evDevice = car;
      await this._registerCarListeners();
    }
    await this._processCarReport(car.capabilitiesObj);
  }

  // ─── Presence ───────────────────────────────────────────────────────────────

  _setSwitchSignal(value, lastUpdated) {
    if (typeof value !== 'boolean') return;
    const was = this.signals.switchOn;
    this.signals.switchOn = value;
    if (!value) {
      this.signals.switchOnSince = null;
    } else if (was !== true) {
      const tm = lastUpdated ? new Date(lastUpdated).getTime() : NaN;
      this.signals.switchOnSince = Number.isFinite(tm) ? tm : Date.now();
    }
  }

  _onChargerPower(power) {
    if (typeof power !== 'number') return;
    this.livePowerW = power;
    if (power > EvPresence.CHARGING_POWER_W) this.signals.lastChargingTm = Date.now();
    const wasCharging = this.presence && this.presence.state === 'charging';
    const isCharging = power > EvPresence.CHARGING_POWER_W;
    if (wasCharging !== isCharging) this._updatePresence().catch(this.error);
  }

  // Legacy for chargers without any other signal (no plug state, no car location) and not
  // switched by this device: long without power counts as departed.
  _usePowerGap() {
    return !this.sourceCapGroup.connState && !this.carCapGroup.latitude && !this.getSettings().chargerControl;
  }

  async _updatePresence() {
    const presence = EvPresence.resolvePresence({
      now: Date.now(),
      powerW: this.livePowerW,
      ...this.signals,
      usePowerGap: this._usePowerGap(),
    });
    const prev = this.presence;
    this.presence = presence;
    this.isCarConnected = presence.chargeable;
    if (this.hasCapability('ev_car_state')) await this.setCapability('ev_car_state', presence.state);
    if (!prev || prev.state === presence.state) return;

    const dist = typeof this.signals.carDistanceKm === 'number' ? `, car ${this.signals.carDistanceKm.toFixed(2)} km from home` : '';
    this.log(`[EV Slot] Car state ${prev.state} -> ${presence.state}${dist}`);
    if (prev.atHome && !presence.atHome) {
      await this._onDeparture();
    } else if (!prev.atHome && presence.atHome) {
      await this._onReturn();
    } else if (prev.chargeable !== presence.chargeable) {
      // Chart shading and the grid forecast follow whether the plan is being executed.
      await this.updateChargeChart().catch(this.error);
    }
  }

  // Departure/return learning needs the moment itself. A car location only arrives after the
  // trip, so a location-based change is too late to learn a time from.
  _presenceIsTimely() {
    return !this.carCapGroup.latitude;
  }

  async _onDeparture() {
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const depFh = EvDepartureStrategy.toLocalFractionalHour(now, tz);
    const depSoc = typeof this.lastKnownSoc === 'number' ? this.lastKnownSoc : null;
    const batCap = this.getSettings().batCapacity || 50;

    this.log(`[EV Slot] Departure recorded at ${EvDepartureStrategy.fractionalHourToHHMM(depFh)} with SoC ${depSoc !== null ? `${depSoc}%` : 'unknown'}`);

    if (this.getSettings().autoDepartureLearning !== false && this._presenceIsTimely()) {
      EvDepartureStrategy.recordDeparture(this.socForecastModel, dow, depFh, depSoc, batCap);
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
    }

    // Suspend: chart preserved but the plan is shown as prediction, and the charger switched off
    await this.updateChargeChart().catch(this.error);
  }

  async _onReturn() {
    const now = new Date();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const retFh = EvDepartureStrategy.toLocalFractionalHour(now, tz);
    const soc = typeof this.lastKnownSoc === 'number' ? this.lastKnownSoc : null;

    this.log(`[EV Slot] Return recorded at ${EvDepartureStrategy.fractionalHourToHHMM(retFh)} with SoC ${soc !== null ? `${soc}%` : 'unknown'}`);

    if (this.getSettings().autoDepartureLearning !== false && this._presenceIsTimely()) {
      EvDepartureStrategy.recordReturn(this.socForecastModel, dow, retFh, soc);
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
    }

    await this.updateChargeChart().catch(this.error);
  }

  // ─── Car reports and SoC estimate ───────────────────────────────────────────

  // One car status update sets several capabilities in a row: handle them as one report.
  _scheduleCarReport() {
    if (this.carReportTimeout) this.homey.clearTimeout(this.carReportTimeout);
    this.carReportTimeout = this.homey.setTimeout(() => {
      this.carReportTimeout = null;
      this._processCarReport().catch(this.error);
    }, 5000);
  }

  // Charger kWh counter: the source meter when there is one, else the integrated charge meter.
  _readChargedKwh() {
    const cap = this.sourceCapGroup.p1 ? 'meter_power_hidden' : 'meter_kwh_charging';
    const val = this.hasCapability(cap) ? this.getCapabilityValue(cap) : null;
    return typeof val === 'number' ? val : null;
  }

  _carLimit(capsObj) {
    const cap = this.carCapGroup.chargeLimit;
    const val = cap && capsObj ? Number(capsObj[cap]?.value) : NaN;
    return Number.isFinite(val) && val > 0 ? val : null;
  }

  /**
   * Read the car's (or the charger's) status and apply it: presence signals, and a SoC rebase
   * when the car reported since the current base.
   *
   * @param {object} [capsObj] - a fresh capabilitiesObj of the car device; defaults to the
   *   listener-maintained this.evDevice.capabilitiesObj
   */
  async _processCarReport(capsObj) {
    const carCaps = capsObj || (this.evDevice && this.evDevice.capabilitiesObj) || null;
    const socCaps = carCaps && this.carCapGroup.soc ? carCaps : this.sourceDevice?.capabilitiesObj;
    const socCap = carCaps && this.carCapGroup.soc ? this.carCapGroup.soc : this.sourceCapGroup.socOnCharger;
    const read = (caps, cap) => (caps && cap && caps[cap] ? caps[cap] : null);
    const tmOf = (entry) => {
      const t = entry && entry.lastUpdated ? new Date(entry.lastUpdated).getTime() : NaN;
      return Number.isFinite(t) ? t : null;
    };

    if (carCaps) {
      const lat = Number(read(carCaps, this.carCapGroup.latitude)?.value);
      const lon = Number(read(carCaps, this.carCapGroup.longitude)?.value);
      let homeLat = null;
      let homeLon = null;
      try {
        homeLat = this.homey.geolocation.getLatitude();
        homeLon = this.homey.geolocation.getLongitude();
      } catch { /* no location permission or not set */ }
      this.signals.carDistanceKm = (this.carCapGroup.latitude && Number.isFinite(lat) && Number.isFinite(lon)
        && typeof homeLat === 'number' && typeof homeLon === 'number')
        ? EvPresence.distanceKm(lat, lon, homeLat, homeLon) : null;

      const plugState = read(carCaps, this.carCapGroup.plugState)?.value;
      const plugBool = read(carCaps, this.carCapGroup.plugBool)?.value;
      if (this.carCapGroup.plugState) {
        this.signals.carPlugged = EvPresence.isPluggedValue(plugState);
      } else if (this.carCapGroup.plugBool) {
        // "Charging" says plugged in; "not charging" says nothing about the cable.
        this.signals.carPlugged = plugBool === true ? true : null;
      }
    }

    const socEntry = read(socCaps, socCap);
    const soc = socEntry && typeof socEntry.value === 'number' ? socEntry.value : null;
    if (soc !== null) {
      // Report time: the newest of the car's status capabilities. An unchanged SoC is not set
      // again by most apps, but a trip still moves the odometer or the location.
      const statusKeys = ['soc', 'odometer', 'latitude', 'longitude'];
      const tms = [tmOf(socEntry)];
      if (carCaps) statusKeys.forEach((key) => tms.push(tmOf(read(carCaps, this.carCapGroup[key]))));
      const valid = tms.filter((t) => t !== null);
      const reportTm = valid.length ? Math.max(...valid) : null;
      const baseTm = this.socEstimator.baseTm || 0;
      const socChanged = soc !== this.socEstimator.baseSoc;
      if ((reportTm !== null && reportTm > baseTm) || (reportTm === null && socChanged)) {
        const odo = Number(read(carCaps, this.carCapGroup.odometer)?.value);
        await this._applySocReport(soc, reportTm || Date.now(), Number.isFinite(odo) ? odo : null);
      }
    }

    this.carLimit = carCaps ? this._carLimit(carCaps) : null;
    await this._updatePresence();
    await this._refreshSocEstimate();
  }

  async _applySocReport(soc, tm, odo = null) {
    const capacity = this.getSettings().batCapacity || 50;
    const { state, sample } = EvSocEstimator.onReport(this.socEstimator, {
      soc, tm, kwhCounter: this._readChargedKwh(), odo,
    }, capacity);
    this.socEstimator = state;
    this.log(`[EV SoC] Car reported ${soc}%${odo !== null ? ` @ ${odo} km` : ''}`
      + `${sample !== null ? `, efficiency sample ${Math.round(sample * 100)}% -> ${Math.round(state.efficiency * 100)}%` : ''}`);
    await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
    if (sample !== null) await this._updateEfficiencySetting();
  }

  // Manual SoC (flow card): a report without odometer.
  async setManualSoc(soc) {
    await this._applySocReport(soc, Date.now(), null);
    await this._refreshSocEstimate(true);
  }

  async _refreshSocEstimate(forceRecalc = false) {
    const capacity = this.getSettings().batCapacity || 50;
    const counter = this._readChargedKwh();
    if (typeof counter === 'number') {
      if (typeof this.socEstimator.baseSoc === 'number' && typeof this.socEstimator.baseKwh !== 'number') {
        this.socEstimator = EvSocEstimator.rebaseCounter(this.socEstimator, counter, this.socEstimator.baseSoc);
        await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
      } else if (EvSocEstimator.counterWentBack(this.socEstimator, counter)) {
        this.log('[EV SoC] Charger kWh counter went back, rebasing estimate');
        this.socEstimator = EvSocEstimator.rebaseCounter(this.socEstimator, counter, this.lastKnownSoc);
        await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
      } else if (this.presence && !this.presence.atHome
        && EvSocEstimator.chargedSinceBase(this.socEstimator, counter) > 0.05) {
        // Our car is away: what this charger delivers now goes into another car.
        this.socEstimator = EvSocEstimator.rebaseCounter(this.socEstimator, counter, this.lastKnownSoc);
        await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
      }
    }
    const est = EvSocEstimator.estimate(this.socEstimator, counter, capacity, this.carLimit);
    if (est === null) return;
    const value = Math.round(est * 10) / 10;
    this.lastKnownSoc = value;
    if (this.hasCapability('measure_ev_soc')) await this.setCapability('measure_ev_soc', Math.round(value));

    // Same dedup/cap approach as powerHistory in handleUpdateMeter(): at most one sample
    // per minute, capped to 2880 entries (48h), so getActualSocForTime() has real data for
    // the yesterday/today charts. Persisted at most every 15 minutes, as the battery does.
    if (this.recordSocSample(value)) {
      this.saveSocHistory({ lastKnownSoc: value }).catch(this.error);
    }

    const referenceSoc = this.lastRecalculatedSoc !== undefined ? this.lastRecalculatedSoc : value;
    if (forceRecalc || Math.abs(value - referenceSoc) >= 2 || this.lastRecalculatedSoc === undefined) {
      this.lastRecalculatedSoc = value;
      if (this.socUpdateTimeout) this.homey.clearTimeout(this.socUpdateTimeout);
      this.socUpdateTimeout = this.homey.setTimeout(() => {
        this.updateChargeChart().catch(this.error);
      }, 5000);
    }
  }

  async _updateEfficiencySetting() {
    const est = this.socEstimator || EvSocEstimator.createState();
    const text = `${Math.round(est.efficiency * 100)}% (n=${est.efficiencySamples || 0})`;
    if (this.getSettings().learned_efficiency !== text) {
      await this.setSettings({ learned_efficiency: text }).catch(this.error);
    }
  }

  // ─── Charger control ────────────────────────────────────────────────────────

  async _controlTick() {
    if (!this.sourceCapGroup || !this.presence) return;
    if (this.evDevice && (!this.lastCarPollTm || (Date.now() - this.lastCarPollTm) >= CAR_POLL_MS)) {
      this.lastCarPollTm = Date.now();
      await this._pollCar().catch(this.error);
    }
    await this._updatePresence();
    this._trackChargeSession();
    await this._applyChargerControl();
  }

  async _applyChargerControl() {
    const capabilityId = this.sourceCapGroup && this.sourceCapGroup.switchCap;
    if (!this.getSettings().chargerControl || !capabilityId || !this.sourceDevice || !this.presence) return;
    const now = Date.now();
    const wanted = EvChargerControl.wantedState({
      plan: this.latestPlan,
      now,
      atHome: this.presence.atHome,
      chargeMode: this.getCapabilityValue('ev_charge_mode') || 'scheduled_price',
    });
    const command = EvChargerControl.nextCommand({
      wanted, lastWanted: this.lastWantedSwitch, lastCommandTm: this.lastSwitchCommandTm, now,
    });
    if (command === null) return;
    this.lastSwitchCommandTm = now;
    try {
      await this.sourceDevice.setCapabilityValue({ capabilityId, value: command });
      this.lastWantedSwitch = command;
      this.log(`[EV Control] Charger ${capabilityId} -> ${command}`);
    } catch (err) {
      this.error(`[EV Control] Switching charger ${capabilityId} to ${command} failed:`, err.message || err);
    }
  }

  // A charging session ends when the car has not taken power for a while. Then optionally ask
  // the car app for a fresh SoC, which also teaches the charge efficiency.
  _trackChargeSession() {
    const now = Date.now();
    const counter = this._readChargedKwh();
    const charging = this.presence && this.presence.state === 'charging';
    if (charging && !this.chargeSession) {
      this.chargeSession = { startKwh: counter, startTm: now };
      return;
    }
    if (!this.chargeSession || charging) return;
    const lastCharging = this.signals.lastChargingTm || this.chargeSession.startTm;
    if (now - lastCharging < EvPresence.NO_RESPONSE_MS) return;
    const kwh = (typeof counter === 'number' && typeof this.chargeSession.startKwh === 'number')
      ? counter - this.chargeSession.startKwh : 0;
    this.chargeSession = null;
    this.log(`[EV SoC] Charging session ended, ${kwh.toFixed(2)} kWh`);
    if (kwh >= CAR_REFRESH_MIN_KWH) this._requestCarRefresh().catch(this.error);
  }

  async _requestCarRefresh() {
    const capabilityId = this.carCapGroup.refresh;
    if (!this.getSettings().carRefreshAfterCharge || !capabilityId || !this.evDevice) return;
    const now = Date.now();
    if (this.lastCarRefreshTm && (now - this.lastCarRefreshTm) < CAR_REFRESH_MIN_MS) return;
    this.lastCarRefreshTm = now;
    try {
      await this.evDevice.setCapabilityValue({ capabilityId, value: true });
      this.log('[EV SoC] Requested car status refresh');
    } catch (err) {
      this.error('[EV SoC] Car refresh request failed:', err.message || err);
    }
  }

  // ─── Poll (hourly) ──────────────────────────────────────────────────────────

  async poll() {
    let api;
    try {
      api = this.homey.app.api;
    } catch {
      return;
    }
    if (!api) return;

    if (!this.sourceCapGroup || Object.keys(this.sourceCapGroup).length === 0) await this.addSourceCapGroup();
    await this.getSourceDevice();

    // kWh meter
    if (this.sourceCapGroup.p1 && this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.p1]) {
      const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup.p1].value;
      await this.updateMeter(val).catch(this.error);
    }

    // Instantaneous power
    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure && this.sourceDevice.capabilitiesObj?.measure_power) {
      const rtValue = this.sourceDevice.capabilitiesObj.measure_power.value;
      if (typeof rtValue === 'number') {
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        // See addListeners() for why this must not be negated (Homey standard: charging = positive).
        if (!this.sourceCapGroup.p1) await this.updateMeterFromMeasure(rtValue).catch(this.error);
        this._onChargerPower(rtValue);
      }
    }

    // Car status: catches a report whose events were missed (e.g. while this app restarted)
    let carCaps = null;
    if (this.evDevice) {
      const car = await api.devices.getDevice({ id: this.evDevice.id, $cache: false }).catch(() => null);
      carCaps = car && car.capabilitiesObj ? car.capabilitiesObj : null;
    }
    await this._processCarReport(carCaps || undefined).catch(this.error);
  }

  // ─── Settings change handler ────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    await super.onSettings({ newSettings, changedKeys });
    const strategyKeys = [
      'chargePower', 'batCapacity', 'targetSoc', 'variableChargePower',
      'departureTime_0', 'departureTime_1', 'departureTime_2', 'departureTime_3',
      'departureTime_4', 'departureTime_5', 'departureTime_6',
    ];
    if (changedKeys.some((k) => strategyKeys.includes(k))) {
      this.updateChargeChart().catch(this.error);
    }
    return true;
  }

  async onPricesUpdated() {
    this.pricesUpdated = true;
    await this.updateChargeChart().catch(this.error);
  }

  async handleUpdateMeter(reading) {
    // This override previously shadowed GenericDevice#handleUpdateMeter entirely (same method
    // name), silently skipping the base class's meter-period bookkeeping (meter_power_hidden,
    // lastReadingHour/Day/Month/Year) and money calculation (meter_money_*) since the "graphs
    // upgrade" commit that introduced this override. Restore the base behaviour.
    await super.handleUpdateMeter(reading);

    // Neither this device nor the HomeyAPI sourceDevice wrapper expose a 'measure_power'
    // capability/method, so that lookup always failed. The device's own live charge
    // power is published on 'measure_watt_avg'.
    let livePower = (reading && typeof reading.measure_power === 'number') ? reading.measure_power : null;
    if (livePower === null && this.hasCapability('measure_watt_avg')) {
      livePower = this.getCapabilityValue('measure_watt_avg');
    }
    if (typeof livePower !== 'number') livePower = 0;

    const currentTimestamp = (reading && reading.meterTm) ? new Date(reading.meterTm).getTime() : Date.now();
    if (!Array.isArray(this.powerHistory)) this.powerHistory = [];
    const lastEntry = this.powerHistory[this.powerHistory.length - 1];
    if (!lastEntry || Math.abs(currentTimestamp - lastEntry.time) >= 60000) {
      this.powerHistory.push({ time: currentTimestamp, power: livePower });
      if (this.powerHistory.length > 2880) this.powerHistory.shift();
      if (!this.lastPowerHistorySaveTm || (currentTimestamp - this.lastPowerHistorySaveTm > 15 * 60 * 1000)) {
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.lastPowerHistorySaveTm = currentTimestamp;
      }
    }

    // Chargers without measure_power only report power through the meter.
    if (!this.sourceCapGroup.measure) this._onChargerPower(livePower);
    await this._refreshSocEstimate();

    if (livePower > 500) {
      const storedMax = (await this.getStoreValue('detectedMaxPower')) || 0;
      if (livePower > storedMax) {
        const roundedMax = Math.round(livePower / 100) * 100;
        await this.setStoreValue('detectedMaxPower', roundedMax);
        this.log(`[EV Power Auto-Detect] New peak power detected! Updated stored peak from ${storedMax} W to ${roundedMax} W`);
        await this.setSettings({ chargePower: roundedMax }).catch(this.error);
        this.updateChargeChart().catch(this.error);
      }
    }

    const currentSlot = MeterHelpers.startOfBlock(reading.meterTm, this.priceInterval || 60, this.timeZone);
    if (this.lastEvTriggerSlot !== currentSlot) {
      this.lastEvTriggerSlot = currentSlot;
      await this.updateChargeChart().catch(this.error);
    }
  }

  // ─── Resolve departure time for today ──────────────────────────────────────

  _getEffectiveDepartureTime() {
    const settings = this.getSettings();
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const now = new Date();
    const dow = EvDepartureStrategy.getDowLocal(now, tz);
    const manualTimes = [0, 1, 2, 3, 4, 5, 6].map((i) => settings[`departureTime_${i}`] || '');
    return EvDepartureStrategy.getEffectiveDepartureTime(
      this.socForecastModel,
      dow,
      manualTimes,
      '08:00',
    );
  }

  // ─── Main charge chart update ───────────────────────────────────────────────

  async updateChargeChart() {
    if (!this.pricesNextHours) return;

    const settings = this.getSettings();
    const detectedPower = (await this.getStoreValue('detectedMaxPower')) || null;
    const manualPower = Number(settings.chargePower) || 0;
    const chargePower = (detectedPower && detectedPower > manualPower) ? detectedPower : (manualPower || 3700);
    this.log(`[EV Slot] Resolved charge power: ${chargePower} W (manual setting=${settings.chargePower}, auto-detected=${detectedPower})`);
    const batCapacity = settings.batCapacity || 50;
    const tz = this.timeZone || this.homey.clock.getTimezone();

    // Determine current SoC:
    // - Car at home: the estimate (last car report plus what was charged since)
    // - Car away: predicted return SoC for today's day-of-week
    let currentSoc;
    if (!this.presence || this.presence.atHome) {
      currentSoc = this.lastKnownSoc || 0;
    } else {
      const dow = EvDepartureStrategy.getDowLocal(new Date(), tz);
      const predicted = EvDepartureStrategy.getPredictedReturnSoc(this.socForecastModel, dow);
      currentSoc = predicted !== null ? predicted : (this.lastKnownSoc || 0);
      this.log(`[EV Slot] Car absent — using predicted return SoC: ${currentSoc}%`);
    }

    const tripOverride = this.getStoreValue('tripOverride') || null;
    const effectiveDepartureTime = tripOverride ? tripOverride.departureTime : this._getEffectiveDepartureTime();
    const effectiveTargetSoc = tripOverride ? tripOverride.targetSoc : (settings.targetSoc || 100);
    const chargeMode = this.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    this.log(`[EV Slot] Effective departure time: ${effectiveDepartureTime}, target SoC: ${effectiveTargetSoc}%, mode: ${chargeMode}`);

    if (this.hasCapability('ev_departure_time')) {
      await this.setCapabilityValue('ev_departure_time', String(effectiveDepartureTime)).catch(this.error);
    }
    if (this.hasCapability('ev_target_soc')) {
      await this.setCapabilityValue('ev_target_soc', String(effectiveTargetSoc)).catch(this.error);
    }
    if (this.hasCapability('ev_next_departure')) {
      let displayStr;
      if (effectiveDepartureTime === 'indefinite') {
        displayStr = `Onbepaald (${effectiveTargetSoc}%)`;
      } else {
        const tag = tripOverride ? 'Override' : 'Schedule';
        displayStr = `${tag}: ${effectiveDepartureTime} (${effectiveTargetSoc}%)`;
      }
      await this.setCapabilityValue('ev_next_departure', displayStr).catch(this.error);
    }

    const strategy = EvChargeStrategy.getStrategy({
      prices: this.pricesNextHours,
      exportPrices: this.exportPricesNextHours,
      priceInterval: this.priceInterval,
      chargePower,
      currentSoc,
      targetSoc: settings.targetSoc || 100,
      batCapacity,
      departureTime: effectiveDepartureTime,
      timezone: tz,
      variableChargePower: settings.variableChargePower || false,
      chargeMode,
      tripOverrideTime: tripOverride ? tripOverride.departureTime : null,
      tripOverrideSoc: tripOverride ? tripOverride.targetSoc : null,
    });

    if (strategy) {
      if (typeof this.flows.triggerNewEvStrategyFlow === 'function') {
        await this.flows.triggerNewEvStrategyFlow(strategy).catch(this.error);
      }

      Object.keys(strategy).forEach((k) => {
        if (this.pricesNextHoursIsForecast && this.pricesNextHoursIsForecast[k]) strategy[k].isForecast = true;
      });

      // If car is not connected, mark all strategy slots as forecast (grey)
      if (!this.isCarConnected) {
        Object.keys(strategy).forEach((k) => {
          if (strategy[k] && typeof strategy[k] === 'object') strategy[k].isForecast = true;
        });
      }

      await this.refreshDapPrices().catch(() => { });

      // Force-disabled when neither the connected car nor the charger itself reports a real SoC
      // (this.sourceCapGroup.soc is resolved once per device start in addSourceCapGroup()) -
      // otherwise the chart would show a purely predicted/guessed SoC line with no way to tell.
      const showSoc = this.getSettings().chartShowSoc !== false && !!(this.sourceCapGroup && this.sourceCapGroup.soc);

      await this.renderChargeCharts({
        scheme: strategy,
        chargePower,
        dischargePower: 0, // EVs don't discharge back
        socFallback: currentSoc,
        showPower: !!this.getSettings().chartShowPower,
        showSoc,
        showExportPrice: this.getSettings().chartShowExportPrice !== false,
      });
      await this._applyChargerControl().catch(this.error);
    }
  }

  // ─── Batch departure pattern learning from Insights ────────────────────────

  async learnDeparturePattern() {
    this.log('[EV Slot] Starting departure pattern learning from Insights...');
    try {
      let api;
      try {
        api = this.homey.app.api;
      } catch { }
      if (!api) {
        this.log('[EV Slot] Homey API not ready for Insights learning.');
        return;
      }

      const allLogs = await this.homey.app.getInsightsLogs().catch(() => []);
      const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs);

      const chargerId = this.getSettings().homey_device_id;
      const evId = this.getSettings().ev_device_id;
      const batCap = this.getSettings().batCapacity || 50;
      const tz = this.timeZone || this.homey.clock.getTimezone();

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 42 * 24 * 60 * 60 * 1000); // 6 weeks

      const fetchLog = async (deviceId, capNames) => {
        if (!deviceId || deviceId === 'none') return null;
        for (const capName of capNames) {
          const log = logs.find((l) => {
            const id = l.id || l.uri || '';
            return id.includes(deviceId) && (id.endsWith(`:${capName}`) || l.name === capName);
          });
          if (!log) continue;

          // On devices with energy-class registration, Homey stores the Insights log for
          // 'measure_power' itself under the internal log id 'energy_power' - same signal,
          // different log name, NOT a separate derived value and NOT cumulative despite the
          // name (confirmed empirically: same scale/sign as live measure_power).
          const isCumulative = capName.includes('meter') || (capName.includes('energy') && capName !== 'energy_power');

          const convert = (data, resStr) => {
            if (!data || !data.values || data.values.length === 0) return null;
            if (isCumulative && data.values.length > 1) {
              const powerWatts = [];
              for (let i = 1; i < data.values.length; i++) {
                const prev = data.values[i - 1];
                const curr = data.values[i];
                const getVal = (item) => {
                  if (typeof item.v === 'number') return item.v;
                  if (typeof item.y === 'number') return item.y;
                  return 0;
                };
                const prevV = getVal(prev);
                const currV = getVal(curr);
                const prevT = new Date(prev.t).getTime();
                const currT = new Date(curr.t).getTime();
                const dtHours = (currT - prevT) / (3600 * 1000);
                const dKwh = currV - prevV;
                if (dtHours > 0 && dKwh >= 0 && dKwh < 500) {
                  const watts = (dKwh / dtHours) * 1000;
                  powerWatts.push({ t: prevT, v: watts });
                }
              }
              return powerWatts;
            }

            // 'energy_power' AND 'measure_battery' (used here for the car's SoC) hourly entries
            // are already stamped at the START of the hour they represent (confirmed
            // empirically against a real device: both logs' raw hourly entry lined up exactly
            // with the real transition seen in Homey's own Insights graph, at the same raw
            // timestamp) - unlike other hourly logs, which are END-of-interval stamped and need
            // the -1h correction below.
            const startStampedCaps = ['energy_power', 'measure_battery'];
            const isHourly = (resStr === 'last7Days' || resStr === 'last14Days' || resStr === 'last31Days') && !startStampedCaps.includes(capName);
            return data.values.map((e) => {
              let val = 0;
              if (typeof e.v === 'number') val = e.v;
              else if (typeof e.y === 'number') val = e.y;
              const rawT = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
              const t = isHourly ? rawT - 3600000 : rawT;
              return { t, v: val };
            });
          };

          // Two-stage fetch, mirroring solar's approach (drivers/solar/device.js): a single
          // 'last7Days'/'last14Days'/'last31Days' fetch only ever returns HOURLY points, and since
          // the old code stopped at the first resolution with any data, it locked onto hourly and
          // never tried a finer one - this is why the evCharger chart stepped hourly even when the
          // price source (e.g. dap15) is 15-minute resolution. 'last24Hours' gives ~5-minute
          // resolution for the most recent day; merge it over the coarse hourly data so the last
          // 24h is fine-grained and older-than-24h stays hourly (that's all Insights offers there).
          let coarse = null;
          for (const resStr of ['last7Days', 'last14Days', 'last31Days']) {
            const data = await api.insights.getLogEntries({
              id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: resStr,
            }).catch(() => null);
            coarse = convert(data, resStr);
            if (coarse) break;
          }

          const fineStart = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
          const fineData = await api.insights.getLogEntries({
            id: log.id, start: fineStart.toISOString(), end: endDate.toISOString(), resolution: 'last24Hours',
          }).catch(() => null);
          const fine = convert(fineData, 'last24Hours');

          if (!coarse && !fine) {
            const todayData = await api.insights.getLogEntries({
              id: log.id, start: startDate.toISOString(), end: endDate.toISOString(), resolution: 'today',
            }).catch(() => null);
            const today = convert(todayData, 'today');
            if (today) return today;
            continue;
          }
          if (!fine) return coarse;
          if (!coarse) return fine;

          const fineMinTime = Math.min(...fine.map((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime())));
          const merged = coarse.filter((e) => (typeof e.t === 'number' ? e.t : new Date(e.t).getTime()) < fineMinTime).concat(fine);
          return merged;
        }
        return null;
      };

      // Fetch charger power entries for session boundary detection. Never search for a log
      // literally named 'measure_power' - Homey always logs that capability's own Insights
      // history under the internal log id 'energy_power' instead (see isCumulative comment
      // above, and homey-app-development skill Section 3). A literal 'measure_power' log CAN
      // exist in the log listing but with zero real samples (confirmed on grid's SmartMeter,
      // 2026-08-10), so it's not even tried here; fall back to cumulative meter_power only if
      // energy_power itself has no history.
      const powerEntries = await fetchLog(chargerId, ['energy_power', 'meter_power']);

      let socEntries = null;
      if (evId && evId !== 'none') {
        socEntries = await fetchLog(evId, ['measure_battery']);
      }

      if (!powerEntries || powerEntries.length < 2) {
        this.log('[EV Slot] No power history found in Insights for charger.');
        return;
      }

      if (powerEntries && powerEntries.length > 0) {
        const newHistoryMap = new Map();
        if (Array.isArray(this.powerHistory)) {
          this.powerHistory.forEach((e) => newHistoryMap.set(e.time, e.power));
        }
        powerEntries.forEach((e) => {
          const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
          newHistoryMap.set(t, Math.round(e.v || 0));
        });
        this.powerHistory = Array.from(newHistoryMap.entries())
          .map(([time, power]) => ({ time, power }))
          .sort((a, b) => a.time - b.time);
        if (this.powerHistory.length > 2880) this.powerHistory = this.powerHistory.slice(-2880);
        await this.setStoreValue('powerHistory', this.powerHistory).catch(this.error);
        this.log(`[EV Slot] Populated ${this.powerHistory.length} spot power history entries from Insights.`);
      }

      if (socEntries && socEntries.length > 0) {
        const newSocHistoryMap = new Map();
        if (Array.isArray(this.socHistory)) {
          this.socHistory.forEach((e) => newSocHistoryMap.set(e.time, e.soc));
        }
        socEntries.forEach((e) => {
          const t = typeof e.t === 'number' ? e.t : new Date(e.t).getTime();
          if (typeof e.v === 'number') newSocHistoryMap.set(t, e.v);
        });
        this.socHistory = Array.from(newSocHistoryMap.entries())
          .map(([time, soc]) => ({ time, soc }))
          .sort((a, b) => a.time - b.time);
        if (this.socHistory.length > 2880) this.socHistory = this.socHistory.slice(-2880);
        await this.setStoreValue('socHistory', this.socHistory).catch(this.error);
        this.log(`[EV Slot] Populated ${this.socHistory.length} spot SoC history entries from Insights.`);
      }

      const chargingPowers = powerEntries
        .map((e) => e.v)
        .filter((p) => typeof p === 'number' && p > 500)
        .sort((a, b) => a - b);

      this.log(`[EV Power Auto-Detect] Found ${chargingPowers.length} active charging entries (>500W) in history.`);
      if (chargingPowers.length > 0) {
        const minP = Math.round(chargingPowers[0]);
        const p50P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.50)]);
        const p90P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.90)]);
        const p95P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.95)]);
        const p99P = Math.round(chargingPowers[Math.floor(chargingPowers.length * 0.99)]);
        const maxP = Math.round(chargingPowers[chargingPowers.length - 1]);
        this.log(`[EV Power Auto-Detect] History Percentiles (Watts) -> min: ${minP}W, 50th: ${p50P}W, 90th: ${p90P}W, 95th: ${p95P}W, 99th: ${p99P}W, max: ${maxP}W`);

        const detectedMax = Math.round(p99P / 100) * 100;
        this.log(`[EV Power Auto-Detect] Selected peak power estimate (99th percentile): ${detectedMax} W`);
        if (detectedMax >= 1000) {
          await this.setStoreValue('detectedMaxPower', detectedMax);
          const currentSetting = this.getSettings().chargePower;
          if (!currentSetting || currentSetting === 11000) {
            await this.setSettings({ chargePower: detectedMax }).catch(this.error);
            this.log(`[EV Power Auto-Detect] Automatically updated chargePower setting from default to detected ${detectedMax} W`);
          }
        }
      }

      this.socForecastModel = EvDepartureStrategy.bootstrapFromHistory(
        powerEntries, socEntries, tz, batCap,
      );
      await this.setStoreValue('socForecastModel', this.socForecastModel).catch(this.error);
      await this._updateLearnedProfileSettings();
      this.log('[EV Slot] Departure learning complete. Model updated from history.');
      await this.updateChargeChart().catch((err) => this.error(err));
    } catch (err) {
      this.error('[EV Slot] learnDeparturePattern failed:', err);
    }
  }

  // ─── Update learned profile display in settings ─────────────────────────────

  async _updateLearnedProfileSettings() {
    try {
      const profileUpdate = {};
      for (let dow = 0; dow < 7; dow++) {
        const day = this.socForecastModel[dow];
        const key = LEARNED_PROFILE_KEYS[dow];
        if (!day || day.sessionCount === 0) {
          profileUpdate[key] = 'not yet learned';
        } else {
          const dep = day.learnedDepartureTime || '?';
          const ret = day.learnedReturnTime || '?';
          const depSoc = day.learnedDepartureSoc !== null ? `${day.learnedDepartureSoc}%` : '?';
          const retSoc = day.learnedReturnSoc !== null ? `${day.learnedReturnSoc}%` : '?';
          const trip = day.learnedTripKwh !== null ? `${day.learnedTripKwh}kWh` : '?';
          profileUpdate[key] = `dep ${dep} SoC${depSoc} / ret ${ret} SoC${retSoc} trip${trip} (n=${day.sessionCount})`;
        }
      }
      await this.setSettings(profileUpdate).catch(this.error);
    } catch (e) {
      this.error('_updateLearnedProfileSettings failed:', e);
    }
  }
}

Object.assign(CarChargeDevice.prototype, ChargeDeviceHelpers);

module.exports = CarChargeDevice;
