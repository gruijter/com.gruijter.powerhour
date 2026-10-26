/* eslint-disable camelcase */
/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_bat_device');
const EvPlanner = require('../../lib/strategies/EvPlanner');
const EvPriceProfile = require('../../lib/strategies/EvPriceProfile');
const TimeHelpers = require('../../lib/helpers/TimeHelpers');
const { getEvWeeklyChart } = require('../../lib/charts/EvChart');
const EvUsageModel = require('../../lib/strategies/EvUsageModel');
const EvPresence = require('../../lib/strategies/EvPresence');
const EvSocEstimator = require('../../lib/strategies/EvSocEstimator');
const EvEnergyMode = require('../../lib/strategies/EvEnergyMode');
const EvChargerControl = require('../../lib/strategies/EvChargerControl');
const FuseGuard = require('../../lib/strategies/FuseGuard');
const GridConnection = require('../../lib/helpers/GridConnection');
const EvFlows = require('../../lib/flows/EvFlows');
const ChargeDeviceHelpers = require('../../lib/helpers/ChargeDeviceHelpers');
const ChartImages = require('../../lib/helpers/ChartImages');
const { setTimeoutPromise } = require('../../lib/helpers/Util');
const MeterHelpers = require('../../lib/helpers/MeterHelpers');
const EvCarCaps = require('../../lib/helpers/EvCarCaps');
const EvChargerCaps = require('../../lib/helpers/EvChargerCaps');
const EvHistory = require('../../lib/helpers/EvHistory');
const PriceDrivers = require('../../lib/helpers/PriceDrivers');

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
  // Planned in quarters also with hourly prices: departures and returns are rarely on the hour.
  planIntervalMin: 15,
};

const UNPLUG_AFTER_SWITCH_MS = 2 * 60 * 1000; // a power drop this soon after switching off is ours
const PLAN_LOG_ENTRIES = 12; // plan_log label: last plan changes

// Day labels for learned profile settings keys (0=Monday)
const LEARNED_PROFILE_KEYS = [
  'learned_profile_mon', 'learned_profile_tue', 'learned_profile_wed',
  'learned_profile_thu', 'learned_profile_fri', 'learned_profile_sat', 'learned_profile_sun',
];

// Charger control loop: follows the plan within a price slot and times the "no response" check.
const CONTROL_TICK_MS = 60 * 1000;
// Plan requests within this window are merged into one run.
const PLAN_COALESCE_MS = 500;
// Measured solar surplus: averaged over this window.
const SURPLUS_WINDOW_MS = 3 * 60 * 1000;
// A variable charger's power is only changed by at least this much.
const TARGET_POWER_STEP_W = 200;

// An unchanged power or current is sent again after this long (a charger that reset it).
const SETPOINT_RESEND_MS = 15 * 60 * 1000;

// Above this SoC a car may taper: no W/A sample.
const AMP_SAMPLE_MAX_SOC = 80;
// Charging on solar always needs at least this much measured surplus.
const MIN_SOLAR_NEED_W = 100;
// At most one restart per this period when the charger's capabilities changed under us.
const CAP_RESTART_MIN_MS = 10 * 60 * 1000;
// Direct car read in the control loop, next to the car's own capability events.
const CAR_POLL_MS = 5 * 60 * 1000;
// Departure hours in the "departure today/tomorrow" pickers (ev_today_time, ev_tomorrow_time).
const DAY_PICKER_HOURS = [3, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22];
// Chargers with only a kWh meter: power averaged over at least this long, and no meter change
// for this long counts as no power.
const METER_POWER_MIN_MS = 119 * 1000;
const METER_IDLE_MS = 5 * 60 * 1000;
// Bump to rebuild stored price profiles from Insights (2: only the electricity prices of the own tariff group).
const PRICE_BOOTSTRAP_VERSION = 2;

class CarChargeDevice extends GenericDevice {

  async initDeviceValues() {
    this.lastKnownSoc = await this.getStoreValue('lastKnownSoc') || 0;
    this.usageModel = EvUsageModel.fromStore(await this.getStoreValue('evUsageModel')); // null: bootstrap from Insights first
    if (this.getStoreValue('socForecastModel')) await this.unsetStoreValue('socForecastModel').catch(this.error); // pre-v9 model
    this.socEstimator = await this.getStoreValue('socEstimator') || EvSocEstimator.createState();
    // The pre-estimator SoC stays the starting point until the car reports.
    if (typeof this.socEstimator.baseSoc !== 'number' && this.lastKnownSoc > 0) {
      this.socEstimator.baseSoc = this.lastKnownSoc;
    }
    if (!this.signals) this.signals = {};
    // The state of the charger when its switch state is not reported yet.
    const lastWanted = await this.getStoreValue('evLastWantedSwitch');
    if (typeof lastWanted === 'boolean') this.lastWantedSwitch = lastWanted;
    this.tempMode = (await this.getStoreValue('evTempMode')) || null; // {since, previousMode}: a temporary mode
    this.lastAwayTm = (await this.getStoreValue('evLastAwayTm')) || 0;
    this.signals.flowAwaySince = (await this.getStoreValue('evFlowAwaySince')) || null;
    this.energyState = (await this.getStoreValue('evEnergyState')) || EvEnergyMode.createState();
    this.departTm = (await this.getStoreValue('evDepartTm')) || null;
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
    this.measureAddsToMeter = true; // consumption only: see generic_bat_device.updateMeterFromMeasure()
    this.flows = new EvFlows(this);
    this.evDevice = null; // optional secondary car device
    this.sourceCapGroup = {};
    this.carCapGroup = {};

    // Before super.onInit(): it sets initReady partway, and onPricesUpdated() then renders charts.
    await ChartImages.registerChartImages(this, this.driver.ds.chartImages);

    // Before super.onInit(): its first samples would otherwise overwrite the stored history.
    this.powerHistory = await this.loadStoredHistory('powerHistory');
    this.socHistory = await this.loadStoredHistory('socHistory');

    await super.onInit().catch(this.error);

    await this._updateEfficiencySetting();
    if (this.controlInterval) this.homey.clearInterval(this.controlInterval);
    this.controlInterval = this.homey.setInterval(() => {
      this._controlTick().catch((err) => this.error(err));
    }, CONTROL_TICK_MS);

    // A temporary mode without its start (store lost): back to Smart.
    const mode = this.getCapabilityValue('ev_charge_mode');
    if (!mode || (EvChargerControl.isTempMode(mode) && !this.tempMode)) {
      await this.setChargeMode('scheduled_price', 'init').catch(this.error);
    } else {
      await this._updateResumeText();
    }

    // Capability listeners survive restartDevice() (same instance): register them once.
    if (!this.uiListenersRegistered) {
      this.uiListenersRegistered = true;
      this.registerCapabilityListener('ev_charge_mode', async (value) => {
        await this.setChargeMode(value, 'set by user');
      });
      for (const day of ['today', 'tomorrow']) {
        this.registerCapabilityListener(`ev_${day}`, async (value) => {
          this.log(`EV plan for ${day} set to ${value}`);
          await this.setDayPlan(day, value);
        });
        this.registerCapabilityListener(`ev_${day}_time`, async (value) => {
          this.log(`EV departure ${day} set to ${value}`);
          // Refused (a time already past): the picker shows the day's setting again.
          await this.setDayTime(day, value).catch((err) => {
            this.updateChargeChart().catch(this.error);
            throw err;
          });
        });
      }
      this.registerCapabilityListener('button.retrain', async () => {
        this.log('[EV Slot] Manual retrain triggered via button.retrain');
        await this.learnDeparturePattern({ retrain: true }); // keeps what was learned live
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
      await this.attemptInitialBackfill(currentSessionId);
    };
    initCharts().catch((err) => this.error(err));
  }

  // The app API may still be connecting, and learnDeparturePattern() swallows "API not ready":
  // retry. No nightly retrain here to catch a failed bootstrap.
  async attemptInitialBackfill(sessionId, attempt = 1) {
    if (this.sessionId !== sessionId) return; // superseded by a newer onInit/delete
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
      // A meter without a value yet (after a reboot): used when there is no power to integrate,
      // else taken over once it reports (pollMeter).
      const meter = EvChargerControl.meterCap(this.sourceDevice);
      const declared = EvChargerControl.meterCap(this.sourceDevice, true);
      if (caps.includes('measure_power')) {
        this.sourceCapGroup.measure = 'measure_power';
      }
      this.sourceCapGroup.p1 = meter || (this.sourceCapGroup.measure ? null : declared);
      this.pendingMeterCap = this.sourceCapGroup.p1 ? null : declared;
      if (caps.includes('measure_battery')) {
        this.sourceCapGroup.socOnCharger = 'measure_battery';
      }
      // Switch, plug state, setable power or current: automatic, or the user's choice at repair.
      // evcharger_charging is NOT a plug state: it is Homey's setable start/stop (the switch).
      const chosen = this.getStoreValue('evChargerCaps');
      const roles = EvChargerCaps.resolveChargerCaps(this.sourceDevice,
        chosen && chosen.chargerId === this.sourceDevice.id ? chosen.caps : {});
      Object.assign(this.sourceCapGroup, {
        connState: null, switchCap: null, powerCap: null, currentCap: null, ...roles,
      });
    }

    // Optional car device, linked at pair/repair only ('none': no car).
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
          this.carAvailable = ev.available;
          // The user's choice at repair, when made for this car.
          const chosen = this.getStoreValue('evCarCaps');
          this.carCapGroup = EvCarCaps.resolveCarCaps(ev, chosen && chosen.carId === ev.id ? chosen.caps : {});
          this.log(`EV car device linked: ${ev.name}, chosen:`, (chosen && chosen.caps) || 'none', 'used:', this.carCapGroup);
        }
      }
    } catch (e) {
      this.log('Could not load EV car device:', e.message);
    }

    // SoC: car first, else charger
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
    await this._migrateMeterDirection();
    await this._seedChargingTotal();

    // kWh meter
    if (this.sourceCapGroup.p1) {
      this.capabilityInstances.p1 = this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.p1,
        async (value) => this.updateMeter(value).catch(this.error),
      );
    }

    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure) {
      this.capabilityInstances.measurePowerRealtime = await this.sourceDevice.makeCapabilityInstance(
        'measure_power',
        async (raw) => {
          if (typeof raw === 'number') {
            const value = this._chargePower(raw);
            // Homey standard: positive = charging the car. Not negated: updateMeterFromMeasure() also
            // splits kWh by this sign.
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
          const plugged = EvPresence.isPluggedValue(value);
          if (plugged !== this.signals.chargerPlugged) this.plugChangeTm = Date.now();
          this.signals.chargerPlugged = plugged;
          if (plugged === true) await this._endFlowAway('plugged in at the charger');
          await this._updatePresence();
        },
      );
    }

    await this._syncStandby();

    // The charger's power or current setpoint: also changed by the charger app or the user.
    const setpointCap = this.sourceCapGroup.powerCap || this.sourceCapGroup.currentCap;
    if (setpointCap) {
      this.chargerSetpoint = this.sourceDevice.capabilitiesObj?.[setpointCap]?.value;
      this.capabilityInstances.chargerSetpoint = await this.sourceDevice.makeCapabilityInstance(setpointCap, (value) => {
        this.chargerSetpoint = value;
      });
    }

    // Charger switch: its actual state, also when switched by hand or by another flow
    if (this.sourceCapGroup.switchCap) {
      const capObj = this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.switchCap];
      this._setSwitchSignal(capObj?.value, capObj?.lastUpdated);
      this.capabilityInstances.chargerSwitch = await this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.switchCap,
        async (value) => {
          const was = this.signals.switchOn;
          this._setSwitchSignal(value);
          await this._onChargerSwitched(value, was);
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

    await this._processCarReport().catch(this.error);
  }

  // EV car device listeners: every status update of the car app counts as a car report
  async _registerCarListeners() {
    if (!this.evDevice) return;
    this.log(`Registering listeners for EV car: ${this.evDevice.name}`);
    const watched = ['soc', 'plugState', 'plugBool', 'latitude', 'longitude', 'homeDistance', 'atHome', 'odometer', 'chargeLimit'];
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
    if (!car.available && this.usageModel) {
      EvUsageModel.markCurrentUnobserved(this.usageModel);
      await this._saveUsageModel();
    }
    if (car.available !== this.carAvailable) {
      this.log(`[EV SoC] Car device ${car.available ? 'available' : 'unavailable: its location and plug state are not used'}`);
      this.carAvailabilityChanged = typeof this.carAvailable === 'boolean';
      this.carAvailable = car.available;
    }
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
    const tm = lastUpdated ? new Date(lastUpdated).getTime() : NaN;
    const since = Number.isFinite(tm) ? tm : Date.now();
    if (!value) {
      this.signals.switchOnSince = null;
      if (was !== false) this.signals.switchOffSince = since;
    } else if (was !== true) {
      this.signals.switchOffSince = null;
      this.signals.switchOnSince = since;
      // Power from the meter: from the switch-on, not averaged over the time it was off.
      const start = this.meterPowerStart;
      if (!this.sourceCapGroup.measure && start) this.meterPowerStart = { tm: Math.max(since, start.tm), meterValue: start.meterValue };
    }
  }

  // Without V2X the car only takes power: a small negative idle reading of the charger (e.g. a
  // smart plug's -0.1 W) is 0, also for the energy integrated from it.
  _chargePower(power) {
    return this.getSettings().v2x ? power : Math.max(0, power);
  }

  _onChargerPower(power) {
    if (typeof power !== 'number') return;
    const wasPowerOn = typeof this.livePowerW === 'number' && this.livePowerW > EvPresence.CHARGING_POWER_W;
    this.livePowerW = power;
    if (!wasPowerOn && power > EvPresence.CHARGING_POWER_W) this._endFlowAway('charging').catch(this.error);
    if (power > EvPresence.CHARGING_POWER_W) this.signals.lastChargingTm = Date.now();
    this._sampleWattsPerAmp(power);
    const wasCharging = this.presence && this.presence.state === 'charging';
    const isCharging = power > EvPresence.CHARGING_POWER_W;
    // Power gone while the charger stays on and we did not just switch it off: the cable was
    // pulled, or the car is full. A trip report shortly after tells which (EvUsageModel.recordTrip).
    if (wasCharging && !isCharging && this.signals.switchOn !== false
      && !(this.lastWantedSwitch === false && Date.now() - (this.lastSwitchCommandTm || 0) < UNPLUG_AFTER_SWITCH_MS)) {
      this.lastUnplugTm = new Date();
    }
    if (wasCharging !== isCharging) this._updatePresence().catch(this.error);
    if (isCharging) this._detectPlug().catch(this.error);
  }

  // Standby (setting standbyOn): a charger with a switch but without plug state stays on while no
  // car is detected. Detected from power: signals.detectedPlugged, weaker than a charger's own.
  _standby() {
    return !!this.getSettings().standbyOn && this._controlsCharger() && !this.sourceCapGroup.connState;
  }

  async _syncStandby() {
    const stored = this.getStoreValue('evPlugDetected');
    if (this._standby()) {
      this.signals.detectedPlugged = stored && typeof stored.plugged === 'boolean' ? stored.plugged : null;
      this.detectedTm = (stored && stored.tm) || 0;
      return;
    }
    this.signals.detectedPlugged = null;
    this.probeSince = null;
    if (stored) await this.setStoreValue('evPlugDetected', null).catch(this.error);
  }

  async _setDetectedPlugged(plugged, reason) {
    if (plugged === this.signals.detectedPlugged) return;
    this.signals.detectedPlugged = plugged;
    this.detectedTm = Date.now();
    this.plugChangeTm = this.detectedTm;
    await this.setStoreValue('evPlugDetected', { plugged, tm: this.detectedTm }).catch(this.error);
    const text = { true: 'connected', false: 'not connected', null: 'connection unknown' }[plugged];
    this.log(`[EV Control] Car ${text} (${reason})`);
    if (plugged) await this._endFlowAway('power at the charger');
    await this._updatePresence();
  }

  async _detectPlug() {
    if (!this._standby()) return;
    const was = this.signals.detectedPlugged;
    const plugged = EvChargerControl.detectPlugged({
      now: Date.now(), plugged: was, powerW: this.livePowerW, ...this.signals,
    });
    if (plugged !== was) await this._setDetectedPlugged(plugged, plugged ? 'power at the charger' : 'no power at the charger');
  }

  // Legacy for chargers without any other signal (no plug state, no car location) and not
  // switched by this device: long without power counts as departed.
  _usePowerGap() {
    return !this.sourceCapGroup.connState && !this.carCapGroup.latitude && !this._controlsCharger();
  }

  // The chargerControl setting is on (default) and the charger has a switch.
  _controlsCharger() {
    return !!this.getSettings().chargerControl && !!(this.sourceCapGroup && this.sourceCapGroup.switchCap);
  }

  async _updatePresence() {
    const presence = EvPresence.resolvePresence({
      now: Date.now(),
      powerW: this.livePowerW,
      ...this.signals,
      usePowerGap: this._usePowerGap(),
      ownCharger: !this.getSettings().sharedCharger,
    });
    const prev = this.presence;
    this.presence = presence;
    this.isCarConnected = presence.chargeable;
    await this._trackSession();
    // The car device went (un)available: its location appears or disappears, the car did not move.
    const quiet = this.carAvailabilityChanged;
    this.carAvailabilityChanged = false;
    if (!quiet && !presence.atHome && (!prev || prev.atHome)) {
      this.lastAwayTm = Date.now(); // a trip due at a later time is then not still waiting (buildTrips)
      await this.setStoreValue('evLastAwayTm', this.lastAwayTm).catch(this.error);
    }
    if (this.hasCapability('ev_car_state')) await this.setCapability('ev_car_state', presence.state);
    if (!prev || (prev.state === presence.state && prev.unplugged === presence.unplugged)) return;

    if (prev.state !== presence.state) {
      let dist = typeof this.signals.carDistanceKm === 'number' ? `, car ${this.signals.carDistanceKm.toFixed(2)} km from home` : '';
      if (this.carDistanceSource === 'home') dist = `, car says ${this.signals.carDistanceKm ? 'not ' : ''}at home`;
      this.log(`[EV Slot] Car state ${prev.state} -> ${presence.state}${presence.unplugged ? ' (not plugged in)' : ''}${dist}`);
    }
    if (!quiet && prev.atHome && !presence.atHome) {
      await this._onDeparture();
    } else if (!quiet && !prev.atHome && presence.atHome) {
      await this._onReturn();
    } else if (prev.chargeable !== presence.chargeable || prev.unplugged !== presence.unplugged) {
      // Not plugged in shifts the plan; chart shading follows whether the plan is being executed.
      await this.updateChargeChart().catch(this.error);
    }
  }

  // Live departure/return feeds the usage model only for cars without odometer, and only when the
  // signal is timely (charger plug state or power gap): a car location arrives after the trip.
  async _recordPresenceEvent(kind) {
    if (!this.usageModel || this.carCapGroup.odometer || this.carCapGroup.latitude) return;
    if (this.getSettings().autoDepartureLearning === false) return;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const now = new Date();
    EvUsageModel.recordAway(this.usageModel, kind === 'departure' ? { departTm: now } : { returnTm: now }, tz);
    await this._saveUsageModel();
  }

  async _onDeparture() {
    this.log(`[EV Slot] Departure, SoC ${this.lastKnownSoc}%`);
    this.departTm = Date.now();
    await this.setStoreValue('evDepartTm', this.departTm).catch(this.error);
    await this._recordPresenceEvent('departure');
    // The plan is now shown as prediction, and the charger switched off
    await this.updateChargeChart().catch(this.error);
  }

  async _onReturn() {
    this.log(`[EV Slot] Return, SoC ${this.lastKnownSoc}%`);
    await this._socAfterTrip();
    await this._recordPresenceEvent('return');
    await this.updateChargeChart().catch(this.error);
  }

  // Back home without a SoC report since leaving: the SoC less the trip's learned need.
  async _socAfterTrip() {
    const { departTm } = this;
    this.departTm = null;
    await this.setStoreValue('evDepartTm', null).catch(this.error);
    if (!departTm || !this.usageModel || this._energyMode() || typeof this.socEstimator.baseSoc !== 'number') return;
    if ((this.socEstimator.baseTm || 0) >= departTm) return;
    const capacity = this.getSettings().batCapacity || 50;
    const kwh = this._tripNeedKwh(departTm, capacity);
    const soc = EvSocEstimator.socLess(this.lastKnownSoc, kwh, capacity);
    this.socEstimator = EvSocEstimator.rebaseCounter(this.socEstimator, this._readChargedKwh(), soc);
    await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
    this.log(`[EV SoC] No car report since departure: SoC ${this.lastKnownSoc}% less ${kwh} kWh for the trip -> ${soc}%`);
    await this._refreshSocEstimate(true);
  }

  // Battery kWh of the learned trip at this departure, else of its weekday, else a default.
  _tripNeedKwh(departTm, capacity) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const day = this._profile()[EvUsageModel.getDowLocal(new Date(departTm), tz)] || {};
    const trips = (day.trips || []).filter((t) => typeof t.needKwh === 'number');
    const i = EvUsageModel.nearestTrip(trips, EvUsageModel.toLocalFractionalHour(new Date(departTm), tz));
    if (i >= 0) return trips[i].needKwh;
    if (day.regular && typeof day.needKwh === 'number') return day.needKwh;
    return Math.round(capacity * EvPlanner.DEFAULT_NEED_PCT) / 100;
  }

  // ─── Energy mode ────────────────────────────────────────────────────────────

  // No SoC report (car, charger or flow), or an old one while the car was used since: plan on energy.
  // A parked car's app does not report an unchanged SoC: old alone is not stale.
  _energyMode() {
    const est = this.socEstimator || {};
    const reportTm = est.baseTm;
    const usedSinceReport = (this.lastAwayTm || 0) > (reportTm || 0)
      || EvSocEstimator.chargedSinceBase(est, this._readChargedKwh()) >= EvEnergyMode.MIN_SESSION_KWH;
    return EvEnergyMode.isActive({ reportTm, usedSinceReport, now: Date.now() });
  }

  // Is the car connected, for its charging sessions? null: no signal tells (a plain switched plug).
  _sessionConnected() {
    const { signals: s, presence: p } = this;
    if (!p) return null;
    if (p.state === 'away') return false; // also another car at a shared charger
    if (typeof s.chargerPlugged === 'boolean') return s.chargerPlugged;
    if (this._standby()) return s.detectedPlugged === true;
    if (typeof s.carDistanceKm === 'number') return !p.unplugged;
    if (typeof s.carPlugged === 'boolean') return s.carPlugged;
    return null;
  }

  // Charging sessions: plugged in to unplugged.
  async _trackSession() {
    const connected = this._sessionConnected();
    if (connected === null || !this.energyState || connected === !!this.energyState.session) return;
    const counter = this._readChargedKwh();
    if (typeof counter !== 'number') return;
    const now = Date.now();
    if (connected) {
      this.energyState = EvEnergyMode.startSession(this.energyState, now, counter);
    } else {
      const kwh = counter - this.energyState.session.startKwh;
      this.energyState = EvEnergyMode.endSession(this.energyState, now, counter);
      this.log(`[EV Usage] Charging session ended: ${kwh.toFixed(2)} kWh`);
    }
    await this.setStoreValue('evEnergyState', this.energyState).catch(this.error);
  }

  // ─── Usage model ────────────────────────────────────────────────────────────

  async _saveUsageModel() {
    await this.setStoreValue('evUsageModel', this.usageModel).catch(this.error);
  }

  // Trips end with a car report that shows a higher odometer.
  async _checkTrip(odo, reportSoc, reportTm, prevDistanceKm) {
    if (!this.usageModel || typeof odo !== 'number') return;
    const last = this.usageModel.lastOdo;
    this.usageModel.lastOdo = odo;
    if (typeof last !== 'number' || odo - last < 0.1 || odo - last > 2000) {
      if (last !== odo) await this._saveUsageModel();
      return;
    }
    const km = Math.round((odo - last) * 10) / 10;
    const capacity = this.getSettings().batCapacity || 50;
    if (km > EvUsageModel.maxTripKm(capacity)) {
      // More than a full battery: the car app missed reports, the km of several days are merged.
      this.log(`[EV Usage] Odometer jump of ${km} km: car app missed reports, day not used for learning`);
      EvUsageModel.markCurrentUnobserved(this.usageModel);
      await this._saveUsageModel();
      return;
    }
    const socBefore = this.lastKnownSoc;
    const kwh = (typeof reportSoc === 'number' && typeof socBefore === 'number')
      ? Math.max(0, ((socBefore - reportSoc) / 100) * capacity) : null;
    const radius = EvPresence.HOME_RADIUS_KM;
    const dist = this.signals.carDistanceKm;
    const trip = {
      km,
      kwh,
      reportTm: new Date(reportTm),
      fromHome: typeof prevDistanceKm === 'number' ? prevDistanceKm <= radius : null,
      toHome: typeof dist === 'number' ? dist <= radius : null,
      unplugTm: this.lastUnplugTm || null,
    };
    const tz = this.timeZone || this.homey.clock.getTimezone();
    let roundTrip = null;
    if (this.getSettings().autoDepartureLearning !== false) {
      roundTrip = EvUsageModel.recordTrip(this.usageModel, trip, tz);
      if (this.usageModel.current && typeof this.usageModel.current.departFh === 'number') this.lastUnplugTm = null;
    }
    this.log(`[EV Usage] Trip ${km} km, ${kwh === null ? '?' : kwh.toFixed(1)} kWh by SoC, `
      + `from home: ${trip.fromHome}, to home: ${trip.toHome}`);
    if (roundTrip) {
      const kwhPerKm = EvUsageModel.effectiveKwhPerKm(this.usageModel);
      const used = EvUsageModel.dayKwh(roundTrip, kwhPerKm);
      const counts = used >= this._minTripKwh();
      this.log(`[EV Usage] Round trip ${roundTrip.km} km, ${used.toFixed(1)} kWh: ${counts ? 'driving' : 'errand, not learned'}`);
    }
    if (trip.toHome && reportTm > (this.signals.flowAwaySince || Infinity)) await this._endFlowAway('trip ended at home');
    await this._saveUsageModel();
    await this._updateLearnedProfileSettings();
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
    // After pairing meter_power_hidden is 0 until the first meter reading: no counter yet.
    if (this.sourceCapGroup.p1 && !this.lastReadingYear) return null;
    const cap = this.sourceCapGroup.p1 ? 'meter_power_hidden' : 'meter_kwh_charging';
    const val = this.hasCapability(cap) ? this.getCapabilityValue(cap) : null;
    return typeof val === 'number' ? val : null;
  }

  _carLimit(capsObj) {
    const cap = this.carCapGroup.chargeLimit;
    const val = cap && capsObj ? Number(capsObj[cap]?.value) : NaN;
    return Number.isFinite(val) && val > 0 ? val : null;
  }

  // Homey's location { lat, lon }, empty without location permission or when not set.
  _homeLocation() {
    try {
      return { lat: this.homey.geolocation.getLatitude(), lon: this.homey.geolocation.getLongitude() };
    } catch {
      return {};
    }
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

    const prevDistanceKm = this.signals.carDistanceKm;
    if (carCaps && this.carAvailable === false) {
      this.signals.carDistanceKm = null;
      this.signals.carPlugged = null;
    } else if (carCaps) {
      const where = EvCarCaps.carDistance(carCaps, this.carCapGroup, this._homeLocation());
      this.signals.carDistanceKm = where.km;
      this.carDistanceSource = where.source;
      // A location away reported after the car was detected at the charger: it left.
      if (this.signals.detectedPlugged === true && this.signals.carDistanceKm > EvPresence.HOME_RADIUS_KM
        && (where.tm || 0) > (this.detectedTm || 0)) {
        await this._setDetectedPlugged(null, 'car reports a location away');
      }

      const plugState = read(carCaps, this.carCapGroup.plugState)?.value;
      const plugBool = read(carCaps, this.carCapGroup.plugBool)?.value;
      const carPluggedWas = this.signals.carPlugged;
      if (this.carCapGroup.plugState) {
        this.signals.carPlugged = EvPresence.isPluggedValue(plugState);
      } else if (this.carCapGroup.plugBool) {
        // "Charging" says plugged in; "not charging" says nothing about the cable.
        this.signals.carPlugged = plugBool === true ? true : null;
      }
      if (typeof carPluggedWas === 'boolean' && typeof this.signals.carPlugged === 'boolean'
        && carPluggedWas !== this.signals.carPlugged) {
        this.plugChangeTm = Date.now();
        if (this.signals.carPlugged) await this._endFlowAway('car reports plugged in');
      }
    }

    const socEntry = read(socCaps, socCap);
    const soc = socEntry && typeof socEntry.value === 'number' ? socEntry.value : null;
    const odoEntry = read(carCaps, this.carCapGroup.odometer);
    if (odoEntry && typeof odoEntry.value === 'number') {
      await this._checkTrip(odoEntry.value, soc, tmOf(odoEntry) || Date.now(), prevDistanceKm);
    }
    if (soc !== null) {
      // Report time: the newest of the car's status capabilities. An unchanged SoC is not set
      // again by most apps, but a trip still moves the odometer or the location.
      const statusKeys = ['soc', 'odometer', 'latitude', 'longitude', 'homeDistance', 'atHome'];
      const tms = [tmOf(socEntry)];
      if (carCaps) statusKeys.forEach((key) => tms.push(tmOf(read(carCaps, this.carCapGroup[key]))));
      const valid = tms.filter((t) => t !== null);
      const reportTm = valid.length ? Math.max(...valid) : null;
      const baseTm = Math.max(this.socEstimator.baseTm || 0, this.socEstimator.ignoredTm || 0);
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
    const {
      state, sample, ignored, repeat,
    } = EvSocEstimator.onReport(this.socEstimator, {
      soc, tm, kwhCounter: this._readChargedKwh(), odo, v2x: !!this.getSettings().v2x,
    }, capacity);
    this.socEstimator = state;
    if (ignored) {
      await this.setStoreValue('socEstimator', this.socEstimator).catch(this.error);
      if (repeat) return;
      this.log(`[EV SoC] Car reported ${soc}%, under ${state.baseSoc}% while parked and charging: stale, ignored`);
      await this._appendPlanLog(`stale car SoC ${soc}% ignored (base ${state.baseSoc}%)`).catch(this.error);
      return;
    }
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
      } else if (EvSocEstimator.counterJumped(this.socEstimator, counter, capacity)) {
        this.log('[EV SoC] Charger kWh counter jumped, rebasing estimate');
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

    // At most one sample per minute, 2880 entries (48 h), for the charts. Stored at most every 15 min.
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
    const tz = this.timeZone || this.homey.clock.getTimezone();
    if (this.usageModel && EvUsageModel.rollover(this.usageModel, new Date(), tz)) {
      const ov = (this.getStoreValue('evOverrides') || {})[this.usageModel.current.date];
      if (ov) EvUsageModel.setOverride(this.usageModel, ov.type);
      // A car out of reach (unavailable) still has its last report.
      let km = this.signals.carDistanceKm;
      if (typeof km !== 'number' && this.evDevice) {
        const where = EvCarCaps.carDistance(this.evDevice.capabilitiesObj, this.carCapGroup, this._homeLocation());
        km = where.km;
        this.carDistanceSource = where.source;
      }
      if (Number.isFinite(km) && km > EvUsageModel.AWAY_NIGHT_KM) {
        EvUsageModel.markAwayNight(this.usageModel);
        const where = this.carDistanceSource === 'home' ? 'car says not at home' : `${Math.round(km)} km`;
        this.log(`[EV Usage] Car away at the day change (${where}): ${this.usageModel.current.date} and the day before are not learned`);
      }
      await this._saveUsageModel();
      await this._updateLearnedProfileSettings();
      await this.updateChargeChart().catch(this.error); // the picker shows the new "tomorrow"
    }
    if (!this.sourceCapGroup || !this.presence) return;
    if (this.evDevice && (!this.lastCarPollTm || (Date.now() - this.lastCarPollTm) >= CAR_POLL_MS)) {
      this.lastCarPollTm = Date.now();
      await this._pollCar().catch(this.error);
    }
    await this._meterPowerIdleCheck();
    await this._detectPlug();
    await this._updatePresence();
    // A new plan slot: plan again, also without meter readings (handleUpdateMeter does it on those).
    const planSlot = MeterHelpers.startOfBlock(Date.now(), this.planIntervalMin(), tz);
    if (this.lastEvTriggerSlot !== planSlot) {
      this.lastEvTriggerSlot = planSlot;
      await this.updateChargeChart().catch(this.error);
    }
    await this._endTempModeIfDue(); // also without charger control
    await this._updateNextChargeText(); // 'now' starts and ends with the clock
    this._sampleSurplus();
    await this._applyChargerControl();
    await this._startCarIfIdle();
  }

  // Chargers without measure_power: power from the kWh meter over at least 2 minutes, as
  // generic_sum_device.updateMeasureMinMax() does. Published on measure_watt_avg.
  async _updatePowerFromMeter(reading) {
    const tm = new Date(reading.meterTm).getTime();
    const start = this.meterPowerStart;
    if (!start || reading.meterValue < start.meterValue) {
      this.meterPowerStart = { tm, meterValue: reading.meterValue };
      return;
    }
    if (reading.meterValue > start.meterValue) this.lastMeterChangeTm = tm;
    const deltaTm = tm - start.tm;
    if (deltaTm < METER_POWER_MIN_MS) return;
    const power = Math.round((3600000000 / deltaTm) * (reading.meterValue - start.meterValue));
    this.meterPowerStart = { tm, meterValue: reading.meterValue };
    await this.setCapability('measure_watt_avg', power).catch(this.error);
  }

  // The meter only reports a change: no change for a while is no power.
  async _meterPowerIdleCheck() {
    if (this.sourceCapGroup.measure || !this.meterPowerStart || !this.livePowerW) return;
    const now = Date.now();
    if (now - (this.lastMeterChangeTm || this.meterPowerStart.tm) < METER_IDLE_MS) return;
    this.meterPowerStart = { tm: now, meterValue: this.meterPowerStart.meterValue };
    await this.setCapability('measure_watt_avg', 0).catch(this.error);
    this._onChargerPower(0);
  }

  // The charger is on but the car does not take power: tell the car itself to start charging.
  async _startCarIfIdle() {
    const capabilityId = this.carCapGroup.startCharge;
    if (!this.getSettings().carStartCharge || !capabilityId || !this.evDevice || !this.presence) return;
    if (this.getCapabilityValue('ev_charge_mode') === 'off_temp') return;
    if (this.standbyOnly) return; // on only to detect the car, not to charge
    const now = Date.now();
    const soc = typeof this.lastKnownSoc === 'number' && this.lastKnownSoc > 0 ? this.lastKnownSoc : null;
    const carLimit = this._carLimit(this.evDevice.capabilitiesObj);
    const start = EvChargerControl.shouldStartCar({
      now,
      ...this.signals,
      powerW: this.livePowerW,
      atHome: this.presence.atHome,
      soc,
      carLimit,
      tries: this.carStartTries,
    });
    if (!start) return;
    const since = this.signals.switchOnSince;
    const count = this.carStartTries && this.carStartTries.since === since ? this.carStartTries.count + 1 : 1;
    this.carStartTries = { since, count, lastTm: now };
    this.log(`[EV Control] Charger on for ${Math.round((now - since) / 1000)} s, car takes `
      + `${Math.round(this.livePowerW || 0)} W at SoC ${Math.round(soc)}% (car limit ${carLimit || 100}%): `
      + `starting charge in the car (${count})`);
    await this._appendPlanLog(`startCar ${count} (on ${Math.round((now - since) / 60000)} min)`).catch(this.error);
    await this.evDevice.setCapabilityValue({ capabilityId, value: true })
      .catch((err) => this.error('[EV Control] Starting charge in the car failed:', err.message || err));
  }

  // A switch of the charger that was not our command: the temporary mode with that state, so the
  // plan does not switch it back. Judged after PLUG_WINDOW_MS: the charger switches itself on a
  // plug change (evcharger_charging is a command and a status), and that report can come later.
  async _onChargerSwitched(value, was) {
    if (!this._controlsCharger()) return;
    const sw = { value, was, now: Date.now() };
    if (!EvChargerControl.isManualSwitch({ ...sw, command: this.lastCommand })) return;
    this.pendingSwitch = sw;
    this.homey.setTimeout(() => {
      this._judgeSwitch(sw).catch(this.error);
    }, EvChargerControl.PLUG_WINDOW_MS);
  }

  async _judgeSwitch(sw) {
    if (this.pendingSwitch !== sw) return; // superseded by a newer switch
    this.pendingSwitch = null;
    if (this.isDestroyed || this.signals.switchOn !== sw.value) return; // switched back meanwhile
    const soc = this.lastKnownSoc;
    if (!EvChargerControl.isManualSwitch({
      ...sw,
      command: this.lastCommand,
      plugChangeTm: this.plugChangeTm,
      carFull: typeof this.carLimit === 'number' && typeof soc === 'number' && soc >= this.carLimit - 1,
    })) return;
    await this.setChargeMode(sw.value ? 'charge_temp' : 'off_temp', `charger switched ${sw.value ? 'on' : 'off'} outside this app`);
  }

  // Charge mode from the picker, a flow or a switch of the charger outside this app. A temporary
  // mode (charge_temp, off_temp) lasts overrideMaxHours; then the mode before it returns.
  async setChargeMode(mode, reason) {
    const current = this.getCapabilityValue('ev_charge_mode');
    if (EvChargerControl.isTempMode(mode)) {
      // From one temporary mode to the other: the mode to return to stays.
      const previousMode = EvChargerControl.isTempMode(current)
        ? (this.tempMode && this.tempMode.previousMode) || 'scheduled_price'
        : current || 'scheduled_price';
      this.tempMode = { since: Date.now(), previousMode };
    } else {
      this.tempMode = null;
    }
    await this.setStoreValue('evTempMode', this.tempMode).catch(this.error);
    await this.setCapabilityValue('ev_charge_mode', mode).catch(this.error);
    await this._updateResumeText();
    this.log(`EV charge mode ${mode} (${reason})`);
    // Not awaited: this also runs from the charger control inside a plan run, which would wait on itself.
    this.updateChargeChart().catch(this.error);
  }

  // A temporary mode that has run its maximum time: back to the mode before it.
  async _endTempModeIfDue() {
    if (!this.tempMode) return false;
    const maxHours = this.getSettings().overrideMaxHours;
    if (!EvChargerControl.overrideExpired({ override: this.tempMode, maxHours, now: Date.now() })) return false;
    await this.setChargeMode(this.tempMode.previousMode, `temporary mode for the maximum of ${maxHours} h`);
    return true;
  }

  // "Next charge": the plan's next charging period, e.g. 'Thu 23:00–02:30', 'now–02:30' or
  // 'Fri 12:45–14:45 · 49 min' with gaps, else '-'.
  async _updateNextChargeText() {
    if (!this.hasCapability('ev_next_charge')) return;
    const now = Date.now();
    const window = EvChargerControl.nextChargeWindow(this.latestPlan, now);
    let text = '-';
    if (window) {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const lang = this.homey.i18n.getLanguage() || 'en';
      const hhmm = (ms) => EvUsageModel.fractionalHourToHHMM(EvUsageModel.toLocalFractionalHour(new Date(ms), tz));
      const day = (ms) => new Date(ms).toLocaleDateString(lang, { weekday: 'short', timeZone: tz });
      const start = window.startMs <= now ? this.homey.__('ev_now') : `${day(window.startMs)} ${hhmm(window.startMs)}`;
      text = `${start}–${hhmm(window.endMs)}`;
      // With gaps (e.g. on solar surplus): the charging time in it.
      const spanMin = (window.endMs - Math.max(window.startMs, now)) / 60000;
      if (window.minutes < spanMin - 1) text += ` · ${window.minutes} min`;
    }
    await this.setCapability('ev_next_charge', text).catch(this.error);
  }

  // "Resumes": when a temporary mode ends and the mode it returns to, else '-'.
  async _updateResumeText() {
    if (!this.hasCapability('ev_resume')) return;
    let text = '-';
    if (this.tempMode) {
      const tz = this.timeZone || this.homey.clock.getTimezone();
      const endMs = EvChargerControl.tempModeEnd(this.tempMode, this.getSettings().overrideMaxHours);
      const lang = this.homey.i18n.getLanguage() || 'en';
      const cap = this.homey.app.manifest.capabilities.ev_charge_mode;
      const value = (cap.values || []).find((v) => v.id === this.tempMode.previousMode);
      const title = value ? value.title[lang] || value.title.en : this.tempMode.previousMode;
      text = `${EvUsageModel.fractionalHourToHHMM(EvUsageModel.toLocalFractionalHour(new Date(endMs), tz))} · ${title}`;
    }
    await this.setCapability('ev_resume', text).catch(this.error);
  }

  // Surplus needed to charge on solar: the full charge power (a variable charger, with its own power
  // control or set by the user's flows: its lowest power), less the grid power allowed for it.
  _solarNeedW() {
    const settings = this.getSettings();
    const need = settings.variableChargePower ? this._variableMinW() : this._chargePowerW();
    return Math.max(MIN_SOLAR_NEED_W, need - (Number(settings.solarGridPower) || 0));
  }

  // Charge power (W): the setting as maximum, 0 for the measured one.
  _chargePowerW() {
    const manual = Number(this.getSettings().chargePower) || 0;
    return manual > 0 ? manual : (this.getStoreValue('detectedMaxPower') || EvHistory.DEFAULT_CHARGE_POWER_W);
  }

  // The charger's setable power (Homey target_power, W) or else current (A), used with the
  // variableChargePower setting. null: not variable.
  _variablePowerCap() {
    if (!this.getSettings().variableChargePower || !this.sourceCapGroup) return null;
    const { powerCap, currentCap } = this.sourceCapGroup;
    if (powerCap) return { cap: powerCap, unit: 'W' };
    return currentCap ? { cap: currentCap, unit: 'A' } : null;
  }

  // low: the unlearned phases as 1 (the lowest power), else as 3 (the fewest amps for a power).
  _wattsPerAmp(low = false) {
    return EvChargerControl.wattsPerAmp(this.getStoreValue('evWattsPerAmp'), low);
  }

  _ampLimits() {
    return EvChargerControl.ampLimits(this.sourceDevice?.capabilitiesObj?.[this.sourceCapGroup.currentCap]);
  }

  /**
   * The lowest power a variable charger charges at: a current charger's minimum at the phases.
   * Unlearned phases: 1 phase, so a 1-phase car can start on solar (its power teaches the phases),
   * but 3 phases for a fuse cut (safe: below it the charger switches off).
   */
  _variableMinW(safe = false) {
    const variable = this._variablePowerCap();
    if (!variable || variable.unit !== 'A') return EvPlanner.MIN_VARIABLE_POWER_W;
    return Math.max(EvPlanner.MIN_VARIABLE_POWER_W, this._ampLimits().minA * this._wattsPerAmp(!safe));
  }

  // The value (W, or whole A rounded down) for a power, and the power it sets (W).
  _variableSetpoint(variable, power) {
    if (variable.unit !== 'A') return { value: power, setW: power };
    const wpa = this._wattsPerAmp();
    const value = EvChargerControl.toCurrent({ powerW: power, wpa, ...this._ampLimits() });
    return { value, setW: value * wpa };
  }

  /**
   * Set the charger's power, or the current for it. Unchanged values are not sent again, unless
   * the charger reports another setpoint or the last command is old.
   * @param {boolean} [force] - always send (a fuse cut)
   * @returns {Promise<number|null>} the power set (W), null unchanged
   */
  async _sendVariablePower(variable, power, logTag, force = false) {
    const { value, setW } = this._variableSetpoint(variable, power);
    const actual = this.chargerSetpoint;
    const recent = Date.now() - (this.lastSetpointTm || 0) < SETPOINT_RESEND_MS;
    const same = variable.unit === 'A' ? value === this.lastTargetCurrent
      : typeof this.lastTargetPower === 'number' && Math.abs(power - this.lastTargetPower) < TARGET_POWER_STEP_W;
    const confirmed = typeof actual === 'number' && typeof this.lastSentSetpoint === 'number'
      ? Math.abs(actual - this.lastSentSetpoint) < (variable.unit === 'A' ? 0.5 : TARGET_POWER_STEP_W) : recent;
    if (!force && same && confirmed) return null;
    await this.sourceDevice.setCapabilityValue({ capabilityId: variable.cap, value });
    this.lastTargetPower = setW;
    this.lastSentSetpoint = value;
    this.lastSetpointTm = Date.now();
    if (variable.unit === 'A') {
      this.lastTargetCurrent = value;
      this.lastCurrentCommandTm = Date.now();
    }
    this.log(`${logTag} Charger ${variable.cap} -> ${value} ${variable.unit}${variable.unit === 'A' ? ` (${setW} W)` : ''}`);
    return setW;
  }

  // A W/A sample of a current charger: the measured power some time after the last command, not
  // near full (a tapering car takes less than the current allows).
  _sampleWattsPerAmp(power) {
    const variable = this._variablePowerCap();
    const currentA = typeof this.chargerSetpoint === 'number' ? this.chargerSetpoint : this.lastTargetCurrent;
    if (!variable || variable.unit !== 'A' || !(currentA > 0) || !(power > EvPresence.CHARGING_POWER_W)) return;
    if (this.lastKnownSoc >= AMP_SAMPLE_MAX_SOC) return;
    const now = Date.now();
    if (now - (this.lastCurrentCommandTm || 0) < EvChargerControl.AMP_SETTLE_MS || now - (this.lastAmpSampleTm || 0) < 10 * 60 * 1000) return;
    this.lastAmpSampleTm = now;
    const before = this._wattsPerAmp();
    const samples = EvChargerControl.addAmpSample(this.getStoreValue('evWattsPerAmp'), { powerW: power, currentA });
    this.setStoreValue('evWattsPerAmp', samples).catch(this.error);
    const after = EvChargerControl.wattsPerAmp(samples);
    if (after !== before) this.log(`[EV Control] Car charges on ${after / 230} phase(s): ${after} W per A`);
  }

  // Solar surplus (W) now: export plus what this charger itself takes, averaged over the last
  // minutes (one sample per control tick), so a passing cloud does not count. null unmeasured.
  _sampleSurplus() {
    const grid = this.currentGridPower; // + import, - export
    if (typeof grid !== 'number') return;
    const own = this.signals.switchOn === true && typeof this.livePowerW === 'number' ? Math.max(0, this.livePowerW) : 0;
    const now = Date.now();
    this.surplusSamples = (this.surplusSamples || []).filter((e) => now - e.tm < SURPLUS_WINDOW_MS);
    this.surplusSamples.push({ tm: now, w: Math.max(0, own - grid) });
  }

  _measuredSurplusW() {
    const samples = (this.surplusSamples || []).filter((e) => Date.now() - e.tm < SURPLUS_WINDOW_MS);
    if (samples.length < 2) return null;
    return samples.reduce((a, e) => a + e.w, 0) / samples.length;
  }

  // Start on surplus the plan did not expect: Smart (when the export price is under the solar
  // threshold) or Solar only, the car home and plugged in, under the maximum SoC.
  _mayChargeOnSurplus() {
    const mode = this.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    if (mode !== 'scheduled_price' && mode !== 'solar_only') return false;
    if (!this.presence || !this.presence.atHome || !this.presence.chargeable) return false;
    const maxSoc = Number(this.getSettings().maxSoc) || 80;
    const limit = typeof this.carLimit === 'number' ? Math.min(maxSoc, this.carLimit) : maxSoc;
    if (!(this.lastKnownSoc < limit)) return false;
    if (mode === 'solar_only') return true;
    const { exportPrices } = this.pricesFromNow();
    const exportPrice = exportPrices && exportPrices[0];
    return !!this.cheapThreshold && typeof exportPrice === 'number' && exportPrice <= this.cheapThreshold.solar;
  }

  // Charger power for a variable charger: the surplus when following it, else the plan's power.
  async _setTargetPower(variable, solar, surplusW, slot) {
    // On solar: the surplus plus the grid power allowed for it.
    const allowedW = Number(this.getSettings().solarGridPower) || 0;
    const power = EvChargerControl.targetPower({
      solar,
      surplusW: typeof surplusW === 'number' ? surplusW + allowedW : surplusW,
      slot,
      minW: this._variableMinW(),
      maxW: this.fuseCapW ? Math.min(this.fuseCapW, this._chargePowerW()) : this._chargePowerW(),
    });
    try {
      await this._sendVariablePower(variable, power, '[EV Control]');
    } catch (err) {
      this.error(`[EV Control] Setting charger ${variable.cap} for ${power} W failed:`, err.message || err);
    }
  }

  // Main fuse overload the batteries did not solve (grid FuseGuard): a variable charger is cut by
  // the overload (fuseCapW, raised again by _fuseCapStep()), else and below its minimum it is
  // switched off now, without the minimum switch interval, until FuseGuard.mayRelease().
  // Returns { name, capW } (cut) or { name, off: true }; null: not charging or not controlled.
  // uncertain: also a charger switched on that does not measure charging (its power report can
  // lag or come only on change); the grid tries those after the measured ones.
  fuseShed(now, importW, limitW, uncertain = false) {
    const capabilityId = this.sourceCapGroup && this.sourceCapGroup.switchCap;
    if (!this.getSettings().chargerControl || !capabilityId || !this.sourceDevice || this.fuseShedTm) return null;
    // Charging: measured, or switched on without a power reading. A switch state not (yet) reported
    // does not stop it.
    const measured = typeof this.livePowerW === 'number';
    if (this.signals.switchOn === false) return null;
    const charging = measured ? this.livePowerW > EvPresence.CHARGING_POWER_W : this.signals.switchOn === true;
    if (!charging && !(uncertain && this.signals.switchOn === true)) return null;
    const variable = this._variablePowerCap();
    if (variable) {
      // The lowest known: a charger's power report can lag its last cut, which must never go up.
      const known = [measured ? this.livePowerW : null, this.fuseCapW, this.lastTargetPower]
        .filter((w) => typeof w === 'number' && w > 0);
      const currentW = known.length ? Math.min(...known) : this._chargePowerW();
      const reduceW = FuseGuard.reduceTo({ currentW, overW: importW - limitW, minW: this._variableMinW(true) });
      if (reduceW !== null) {
        const capW = this._variableSetpoint(variable, reduceW).setW;
        this.fuseCapW = capW;
        this.fuseCapTm = now;
        this.log(`[Fuse] import ${Math.round(importW)} W above ${limitW} W: charger limit ${capW} W`);
        this._sendVariablePower(variable, reduceW, '[Fuse]', true)
          .catch((err) => this.error(`[Fuse] Setting charger ${variable.cap} for ${reduceW} W failed:`, err.message || err));
        return { name: this.getName(), capW };
      }
    }
    this.fuseShedTm = now;
    this.fuseCapW = null;
    this.lastSwitchCommandTm = now;
    this.lastCommand = { value: false, tm: now }; // before sending: the switch report can come first
    this.log(`[Fuse] import ${Math.round(importW)} W above ${limitW} W: charger ${capabilityId} -> false`);
    this.sourceDevice.setCapabilityValue({ capabilityId, value: false })
      .then(() => {
        this.lastWantedSwitch = false;
        return this.setStoreValue('evLastWantedSwitch', false);
      })
      .catch((err) => {
        this.lastSwitchCommandTm = null; // the control tick tries again
        this.error(`[Fuse] Switching charger ${capabilityId} off failed:`, err.message || err);
      });
    return { name: this.getName(), off: true };
  }

  // Room under the hard limit for this charger: the grid charging of the protected batteries counts
  // (they give way). null: no limit.
  _fuseRoomW(grid) {
    const headroomW = grid.getImportHeadroomW({ tariff: false, hard: true });
    return headroomW === null ? null : headroomW + grid.getYieldingBatteryW();
  }

  // A cut variable charger: its limit raised with the room under the fuse, no sooner than
  // FuseGuard.RAISE_AFTER_MS after the last cut or raise.
  _fuseCapStep(now, wanted) {
    if (!this.fuseCapW || now - this.fuseCapTm < FuseGuard.RAISE_AFTER_MS) return;
    const grid = GridConnection.gridDevice(this.homey);
    if (grid && grid.isGridPowerStale(now)) return;
    const headroomW = grid ? this._fuseRoomW(grid) : null;
    const capW = headroomW === null ? null : FuseGuard.raiseCap({ capW: this.fuseCapW, headroomW, maxW: this._chargePowerW() });
    if (capW === this.fuseCapW) return;
    if (grid && wanted && this.signals.switchOn !== false) grid.reserveImport(this, (capW === null ? this._chargePowerW() : capW) - this.fuseCapW, now);
    this.fuseCapTm = now;
    this.fuseCapW = capW;
    this.log(`[Fuse] room under the main fuse: charger limit ${capW === null ? 'released' : `${capW} W`}`);
  }

  async _applyChargerControl() {
    const capabilityId = this.sourceCapGroup && this.sourceCapGroup.switchCap;
    if (!this.getSettings().chargerControl || !capabilityId || !this.sourceDevice || !this.presence) return;
    const now = Date.now();
    // Plans again, and switches from that new plan.
    if (await this._endTempModeIfDue()) return;
    const planWanted = EvChargerControl.wantedState({
      plan: this.latestPlan,
      now,
      atHome: this.presence.atHome,
      chargeMode: this.getCapabilityValue('ev_charge_mode') || 'scheduled_price',
    });
    // Charging on solar surplus follows the measured surplus, not only the forecast.
    const slot = EvChargerControl.slotAt(this.latestPlan, now);
    const variable = this._variablePowerCap();
    const surplusW = this._measuredSurplusW();
    const gate = EvChargerControl.solarGate({
      wanted: planWanted,
      slot,
      surplusW,
      needW: this._solarNeedW(),
      isOn: !!this.solarCharging && this.signals.switchOn === true,
      opportunistic: this._mayChargeOnSurplus(),
    });
    if (gate.solar !== !!this.solarCharging) {
      this.log(`[EV Control] Solar surplus ${Math.round(surplusW || 0)} W: ${gate.solar ? 'charging on it' : 'not enough'}`);
    }
    this.solarCharging = gate.solar;
    let { wanted } = gate;
    let { lastSwitchCommandTm } = this;
    this.standbyOnly = false;
    const mode = this.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    if (this._standby() && mode !== 'off' && mode !== 'off_temp') {
      const sb = EvChargerControl.standbyState({
        ...this.signals, wanted, plugged: this.signals.detectedPlugged, now, probeSince: this.probeSince,
      });
      if (sb.probeSince && sb.probeSince !== this.probeSince) this.log('[EV Control] Probe: is the car still connected?');
      if (sb.probeEnded) lastSwitchCommandTm = null;
      this.probeSince = sb.probeSince;
      this.standbyOnly = sb.wanted && !wanted;
      ({ wanted } = sb);
    }
    if (this.fuseShedTm) {
      const grid = GridConnection.gridDevice(this.homey);
      const headroomW = grid ? this._fuseRoomW(grid) : null;
      const release = !grid || FuseGuard.mayRelease({
        shedTm: this.fuseShedTm,
        now,
        headroomW: headroomW === null ? Infinity : headroomW,
        needW: this._chargePowerW(),
        stale: grid.isGridPowerStale(now),
      });
      if (release) {
        this.fuseShedTm = null;
        this.fuseCapW = null;
        this.log('[Fuse] room under the main fuse again: charger released');
        // The batteries make room first (only when it is to charge now): on after RELEASE_LEAD_MS.
        if (grid && wanted) {
          grid.reserveImport(this, this._chargePowerW(), now);
          this.fuseReleaseTm = now + FuseGuard.RELEASE_LEAD_MS;
          this.homey.setTimeout(() => {
            if (!this.isDestroyed) this._applyChargerControl().catch((err) => this.error(err));
          }, FuseGuard.RELEASE_LEAD_MS);
        }
      } else wanted = false;
    }
    if (this.fuseReleaseTm && now < this.fuseReleaseTm) wanted = false;
    this._fuseCapStep(now, wanted);
    if (wanted && variable) await this._setTargetPower(variable, gate.solar, surplusW, slot);
    // A switch outside this app is still being judged (_judgeSwitch): do not switch it back.
    if (this.pendingSwitch) return;
    const command = EvChargerControl.nextCommand({
      wanted,
      actual: this.signals.switchOn,
      lastWanted: this.lastWantedSwitch,
      lastCommandTm: lastSwitchCommandTm,
      now,
    });
    if (command === null) return;
    this.lastSwitchCommandTm = now;
    this.lastCommand = { value: command, tm: now }; // before sending: the switch report can come first
    try {
      await this.sourceDevice.setCapabilityValue({ capabilityId, value: command });
      this.lastWantedSwitch = command;
      await this.setStoreValue('evLastWantedSwitch', command).catch(this.error);
      this.log(`[EV Control] Charger ${capabilityId} -> ${command}`);
    } catch (err) {
      this.error(`[EV Control] Switching charger ${capabilityId} to ${command} failed:`, err.message || err);
      // The charger's capabilities changed (e.g. its app replaced onoff by evcharger_charging):
      // resolve switch and listeners again.
      const { api } = this.homey.app;
      const fresh = api ? await api.devices.getDevice({ id: this.getSettings().homey_device_id, $cache: false }).catch(() => null) : null;
      const caps = (fresh && fresh.capabilities) || [];
      if (!caps.includes(capabilityId) && (!this.lastCapRestartTm || now - this.lastCapRestartTm > CAP_RESTART_MIN_MS)) {
        this.lastCapRestartTm = now;
        this.log(`[EV Control] Charger no longer has ${capabilityId}, restarting device`);
        this.restartDevice(2000).catch(this.error);
      }
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
    if (this.pendingMeterCap && typeof this.sourceDevice.capabilitiesObj?.[this.pendingMeterCap]?.value === 'number') {
      this.sourceCapGroup.p1 = this.pendingMeterCap;
      this.pendingMeterCap = null;
      this.log(`[EV Meter] ${this.sourceCapGroup.p1} reports now: used instead of the power`);
      this.capabilityInstances.p1 = this.sourceDevice.makeCapabilityInstance(
        this.sourceCapGroup.p1,
        async (value) => this.updateMeter(value).catch(this.error),
      );
    }
    if (this.sourceCapGroup.p1 && this.sourceDevice.capabilitiesObj?.[this.sourceCapGroup.p1]) {
      const val = this.sourceDevice.capabilitiesObj[this.sourceCapGroup.p1].value;
      await this.updateMeter(val).catch(this.error);
    }

    const targetMeasureCap = this.ds.cmap.measure_source;
    if (this.sourceCapGroup.measure && this.sourceDevice.capabilitiesObj?.measure_power) {
      const rawValue = this.sourceDevice.capabilitiesObj.measure_power.value;
      if (typeof rawValue === 'number') {
        const rtValue = this._chargePower(rawValue);
        if (targetMeasureCap) await this.setCapability(targetMeasureCap, rtValue).catch(this.error);
        // Not negated (see addListeners())
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
      'chargePower', 'batCapacity', 'variableChargePower', 'maxPrice',
      'departureTime_0', 'departureTime_1', 'departureTime_2', 'departureTime_3',
      'departureTime_4', 'departureTime_5', 'departureTime_6',
    ];
    if (changedKeys.includes('awayPeriods') && !EvUsageModel.parsePeriods(newSettings.awayPeriods)) {
      throw Error(this.homey.__('error_invalid_periods', { periods: newSettings.awayPeriods }));
    }
    if (changedKeys.includes('awayPeriods') || changedKeys.includes('minTripSoc')) {
      // After the new settings are stored: the learned profile shows in settings too.
      this.homey.setTimeout(() => {
        this._updateLearnedProfileSettings().catch(this.error);
        this.updateChargeChart().catch(this.error);
      }, 1000);
    }
    if (changedKeys.some((k) => strategyKeys.includes(k))) {
      this.updateChargeChart().catch(this.error);
    }
    if (changedKeys.includes('standbyOn') || changedKeys.includes('sharedCharger') || changedKeys.includes('chargerControl')) {
      // After the new settings are stored.
      this.homey.setTimeout(() => {
        this._syncStandby()
          .then(() => this._updatePresence())
          .then(() => this._applyChargerControl())
          .catch(this.error);
      }, 1000);
    }
    return true;
  }

  // Flow: add an away period (dates DD-MM-YYYY or YYYY-MM-DD). Periods that ended before the
  // learned history (EvUsageModel.MAX_DAYS) are dropped.
  async addAwayPeriod(from, to) {
    const [period] = EvUsageModel.parsePeriods(`${from}/${to || from}`) || [];
    if (!period) throw Error(this.homey.__('error_invalid_periods', { periods: `${from} - ${to}` }));
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const oldest = EvUsageModel.localDateStr(new Date(Date.now() - EvUsageModel.MAX_DAYS * 24 * 3600 * 1000), tz);
    const periods = this._awayPeriods().filter((p) => p.to >= oldest && !(p.from === period.from && p.to === period.to));
    periods.push(period);
    periods.sort((a, b) => a.from.localeCompare(b.from));
    const text = periods.map((p) => (p.from === p.to ? p.from : `${p.from}/${p.to}`)).join(', ');
    await this.setSettings({ awayPeriods: text });
    this.log(`[EV Plan] Away period ${period.from} - ${period.to} added via flow`);
    await this._updateLearnedProfileSettings();
    await this.updateChargeChart().catch(this.error);
  }

  // A flow says the car left: away now, as car apps often only report after the trip. Lasts until
  // the car is back (charging, plugged in, a trip ending at home) or a flow says it is home.
  async setFlowPresence(presence) {
    if (presence === 'home') {
      await this._endFlowAway('flow');
      return;
    }
    this.signals.flowAwaySince = Date.now();
    await this.setStoreValue('evFlowAwaySince', this.signals.flowAwaySince).catch(this.error);
    this.log('[EV Slot] Car left (flow)');
    if (this.signals.detectedPlugged === true) await this._setDetectedPlugged(null, 'flow');
    await this._updatePresence();
    await this._applyChargerControl();
  }

  async _endFlowAway(reason) {
    if (!this.signals.flowAwaySince) return;
    this.signals.flowAwaySince = null;
    await this.setStoreValue('evFlowAwaySince', null).catch(this.error);
    this.log(`[EV Slot] Car back (${reason})`);
    await this._updatePresence();
  }

  async onPricesUpdated() {
    this.pricesUpdated = true;
    await this.updateChargeChart().catch(this.error);
  }

  // The source meter as an own counter that only restarts with this device (see meterTotal).
  // Without a source meter, val is the counter integrated from power (updateMeterFromMeasure).
  async updateMeter(val) {
    if (!this.sourceCapGroup || !this.sourceCapGroup.p1) {
      await super.updateMeter(val);
      return;
    }
    if (typeof val !== 'number') return;
    const hidden = this.getCapabilityValue('meter_power_hidden');
    const stored = this.sourceMeterAnchor || this.getStoreValue('evSourceMeter');
    const res = EvChargerControl.meterTotal({
      anchor: stored,
      id: this.sourceDevice && this.sourceDevice.id,
      cap: this.sourceCapGroup.p1,
      value: val,
      last: this.sourceMeterAnchor ? this.sourceMeterLast : null,
      hidden: typeof hidden === 'number' ? hidden : 0,
      v2x: !!this.getSettings().v2x,
    });
    this.sourceMeterAnchor = res.anchor;
    this.sourceMeterLast = res.last;
    if (res.restarted) this.log(`[EV Meter] ${res.anchor.cap} restarted (-> ${val} kWh): counted from 0`);
    if (res.changed) await this.setStoreValue('evSourceMeter', res.anchor).catch(this.error);
    await super.updateMeter(res.total);
  }

  async handleUpdateMeter(reading) {
    // Must call the base, or meter periods and money are skipped.
    const meterBefore = this.getCapabilityValue('meter_power_hidden');
    await super.handleUpdateMeter(reading);
    await this._updateChargeTotals(meterBefore);

    // The live charge power is on 'measure_watt_avg'.
    if (!this.sourceCapGroup.measure && reading) await this._updatePowerFromMeter(reading);
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
        this.log(`[EV Power Auto-Detect] New peak power: ${storedMax} W -> ${roundedMax} W`);
        await this._setDetectedPower(roundedMax);
        this.updateChargeChart().catch(this.error);
      }
    }

    const currentSlot = MeterHelpers.startOfBlock(reading.meterTm, this.planIntervalMin(), this.timeZone);
    if (this.lastEvTriggerSlot !== currentSlot) {
      this.lastEvTriggerSlot = currentSlot;
      await this.updateChargeChart().catch(this.error);
    }
  }

  // Charging/discharging totals for chargers with their own kWh meter. Chargers that only report
  // power get them from generic_bat_device.updateMeterFromMeasure(). A meter jump is skipped: the
  // base class only re-anchors its baselines on it, meter_power_hidden still takes the new reading.
  async _updateChargeTotals(meterBefore) {
    if (!this.sourceCapGroup.p1 || typeof meterBefore !== 'number') return;
    const delta = this.getCapabilityValue('meter_power_hidden') - meterBefore;
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > GenericDevice.MAX_METER_JUMP_KWH) return;
    const cap = delta > 0 ? 'meter_kwh_charging' : 'meter_kwh_discharging';
    if (!this.hasCapability(cap)) return; // discharging only with V2X
    const total = (this.getCapabilityValue(cap) || 0) + Math.abs(delta);
    await this.setCapability(cap, Math.round(total * 10000) / 10000);
  }

  // Up to v8.20 a charger without its own kWh meter counted charging down on meter_power_hidden
  // (the battery convention), so its baselines and money went negative. Flip them once.
  async _migrateMeterDirection() {
    if (this.getStoreValue('meterAddsToMeter')) return;
    const meter = this.getCapabilityValue('meter_power_hidden');
    if (!this.sourceCapGroup.p1 && typeof meter === 'number' && meter < 0) {
      const neg = (v) => (typeof v === 'number' ? -v : v);
      for (const key of ['lastReadingHour', 'lastReadingDay', 'lastReadingMonth', 'lastReadingYear']) {
        if (this[key] && typeof this[key].meterValue === 'number') {
          this[key] = { ...this[key], meterValue: -this[key].meterValue };
          await this.setStoreValue(key, this[key]).catch(this.error);
        }
      }
      await this.setCapability('meter_power_hidden', -meter);
      if (this.meterMoney) {
        this.meterMoney = Object.fromEntries(Object.entries(this.meterMoney).map(([k, v]) => [k, neg(v)]));
        for (const period of ['hour', 'day', 'month', 'year']) {
          const cap = period[0].toUpperCase() + period.slice(1);
          await this.setCapability(`meter_money_this_${period}`, this.meterMoney[period]);
          await this.setCapability(`meter_money_last_${period}`, this.meterMoney[`last${cap}`]);
        }
      }
      this.log(`[EV Meter] Charging now counts up: meter ${meter.toFixed(3)} -> ${(-meter).toFixed(3)} kWh, baselines and money flipped`);
    }
    await this.setStoreValue('meterAddsToMeter', true).catch(this.error);
  }

  // Repair fix_values: money only. The charged counter feeds the SoC estimate and session energy
  // (_readChargedKwh()): a correction there would show up as charged kWh.
  fixMeterCaps() {
    return [];
  }

  // Devices paired before the charging total existed for kWh-meter chargers: start from the kWh
  // counted since pairing (the period meters start at pairing).
  async _seedChargingTotal() {
    if (!this.sourceCapGroup.p1 || !this.hasCapability('meter_kwh_charging')) return;
    if (typeof this.getCapabilityValue('meter_kwh_charging') === 'number') return;
    const kwh = (this.getCapabilityValue('meter_kwh_this_year') || 0) + (this.getCapabilityValue('meter_kwh_last_year') || 0);
    this.log(`Charging total started at ${kwh.toFixed(2)} kWh (counted since pairing)`);
    await this.setCapability('meter_kwh_charging', Math.round(kwh * 10000) / 10000);
  }

  // ─── Resolve departure time for today ──────────────────────────────────────

  // SoC expected on return: today's typical need minus what today's trips already used.
  _predictReturnSoc() {
    if (!this.usageModel || typeof this.lastKnownSoc !== 'number') return null;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const day = this._profile()[EvUsageModel.getDowLocal(new Date(), tz)];
    if (!day || typeof day.needKwh !== 'number') return null;
    const kwhPerKm = EvUsageModel.effectiveKwhPerKm(this.usageModel);
    const usedToday = this.usageModel.current ? EvUsageModel.dayKwh(this.usageModel.current, kwhPerKm) : 0;
    const remaining = Math.max(0, day.needKwh - usedToday);
    return EvSocEstimator.socLess(this.lastKnownSoc, remaining, this.getSettings().batCapacity || 50);
  }

  // ─── Planner inputs ─────────────────────────────────────────────────────────

  // The away periods setting: [{from, to}] by local date.
  _awayPeriods() {
    return EvUsageModel.parsePeriods(this.getSettings().awayPeriods) || [];
  }

  // The learned weekly profile, without the days that were not normal.
  _profile() {
    return EvUsageModel.getProfile(this.usageModel, this._awayPeriods(), this._minTripKwh());
  }

  // Energy a round trip must use to count as driving (kWh).
  _minTripKwh() {
    const settings = this.getSettings();
    return EvUsageModel.minTripKwh(settings.minTripSoc, settings.batCapacity || 50);
  }

  // Day overrides by local date (pickers / flows), from today on. A day in an away period is
  // "not used", unless the user set something else for it.
  _overrides(tz, now) {
    const today = EvUsageModel.localDateStr(new Date(now), tz);
    const stored = this.getStoreValue('evOverrides') || {};
    const overrides = {};
    const periods = this._awayPeriods();
    if (periods.length) {
      for (let d = 0; d <= EvPlanner.HORIZON_DAYS; d += 1) {
        const date = EvUsageModel.localDateStr(new Date(now + d * 24 * 3600 * 1000), tz);
        if (EvUsageModel.inPeriods(date, periods)) overrides[date] = { type: 'unused', away: true };
      }
    }
    let kept = 0;
    Object.entries(stored).forEach(([date, ov]) => {
      if (date < today) return;
      overrides[date] = ov;
      kept += 1;
    });
    if (kept !== Object.keys(stored).length) {
      this.setStoreValue('evOverrides', Object.fromEntries(Object.entries(stored).filter(([date]) => date >= today))).catch(this.error);
    }
    return overrides;
  }

  // The calendar day after today.
  _tomorrowDate(tz, now = Date.now()) {
    const midnight = TimeHelpers.getLocalMidnightUTC(new Date(now), tz).getTime();
    return EvUsageModel.localDateStr(new Date(midnight + 36 * 3600 * 1000), tz);
  }

  async _setOverride(date, override) {
    const overrides = { ...(this.getStoreValue('evOverrides') || {}) };
    if (override) overrides[date] = override;
    else delete overrides[date];
    await this.setStoreValue('evOverrides', overrides);
    // A day with an override is not a normal day: keep it out of the learned pattern.
    if (this.usageModel && this.usageModel.current && this.usageModel.current.date === date) {
      EvUsageModel.setOverride(this.usageModel, override ? override.type : null);
      await this._saveUsageModel();
    }
    this.log(`[EV Plan] Override for ${date}: ${override ? JSON.stringify(override) : 'none'}`);
    await this.updateChargeChart().catch(this.error);
  }

  // The date a picker or flow for 'today' or 'tomorrow' sets.
  _dayDate(day, tz) {
    return day === 'today' ? EvUsageModel.localDateStr(new Date(), tz) : this._tomorrowDate(tz);
  }

  // Picker ('auto' or 'min_<soc>'); flow: 'auto'.
  async setDayPlan(day, value) {
    const min = /^min_(\d+)$/.exec(value || '');
    if (min) {
      await this.setDayMinSoc(day, Number(min[1]));
      return;
    }
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const date = this._dayDate(day, tz);
    // "Automatic" ends only the minimum SoC: a departure time or "not used" for that day stays.
    const existing = (this.getStoreValue('evOverrides') || {})[date];
    let override = null;
    if (existing && existing.type === 'unused') override = existing;
    else if (existing && existing.time) override = { type: 'departure', time: existing.time };
    await this._setOverride(date, override);
  }

  // Departure picker / flow: 'auto', 'unused' or a time (HH:MM).
  async setDayTime(day, value) {
    if (value === 'unused') await this.setDayUnused(day);
    else await this.setDayDeparture(day, value === 'auto' ? null : value);
  }

  // The car is not used that day, once.
  async setDayUnused(day) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    await this._setOverride(this._dayDate(day, tz), { type: 'unused' });
  }

  // Picker / flow: at least soc % at that day's departure, once; keeps a departure time set.
  async setDayMinSoc(day, soc) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const date = this._dayDate(day, tz);
    const existing = (this.getStoreValue('evOverrides') || {})[date];
    const time = (existing && existing.time) || null;
    await this._setOverride(date, { type: 'min', soc: Math.max(30, Math.min(100, Math.round(soc))), time });
  }

  // Picker / flow: that day's departure at another time (HH:MM), once; null = as learned. Keeps a
  // minimum SoC set; both a time and null end "not used". Today, a time already past is an error.
  async setDayDeparture(day, time) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const date = this._dayDate(day, tz);
    if (time && date === EvUsageModel.localDateStr(new Date(), tz)
      && EvPlanner.hhmmToFh(time) <= EvUsageModel.toLocalFractionalHour(new Date(), tz)) {
      throw Error(this.homey.__('error_departure_past', { time }));
    }
    const existing = (this.getStoreValue('evOverrides') || {})[date];
    let override = null;
    if (existing && existing.type === 'min') override = { ...existing, time };
    else if (time) override = { type: 'departure', time };
    await this._setOverride(date, override);
  }

  // Departure time picker: 'unused', the day's set time (nearest picker hour), else 'auto'.
  _dayTimePickerValue(day, overrides, tz) {
    const ov = overrides[this._dayDate(day, tz)];
    if (ov && ov.type === 'unused') return 'unused';
    const fh = ov ? EvPlanner.hhmmToFh(ov.time) : null;
    if (fh === null) return 'auto';
    // A time from the flow with free time: the nearest picker hour (the earlier one on a tie).
    const hour = DAY_PICKER_HOURS.reduce((best, h) => (Math.abs(h - fh) < Math.abs(best - fh) ? h : best));
    return `${String(hour).padStart(2, '0')}:00`;
  }

  _dayPickerValue(day, overrides, tz) {
    const ov = overrides[this._dayDate(day, tz)];
    if (!ov) return 'auto';
    if (ov.type === 'min') {
      return `min_${Math.max(30, Math.min(100, Math.round(ov.soc / 10) * 10))}`; // nearest picker step
    }
    return 'auto';
  }

  // Expected solar surplus (kWh, grid side) per price slot, from the grid device's forecast of home
  // load and PbtH solar. null without a grid device.
  _solarSurplusKwh(startMs, n, intervalMin) {
    const grid = GridConnection.gridDevice(this.homey);
    if (!grid) return null;
    let f;
    try {
      f = grid.getNetForecast(startMs, startMs + n * intervalMin * 60 * 1000);
    } catch (err) {
      this.error(err);
      return null;
    }
    if (!f || !Array.isArray(f.solar)) return null;
    const perSlot = Math.max(1, Math.round(intervalMin / 15));
    const out = new Array(n).fill(0);
    f.solar.forEach((solarW, k) => {
      const surplusW = Math.max(0, (solarW || 0) - ((f.load && f.load[k]) || 0));
      const i = Math.floor(k / perSlot);
      if (i < n) out[i] += (surplusW * 0.25) / 1000;
    });
    return out;
  }

  // Learn the expected-price profile from the published prices (not forecasts).
  async _learnPrices(fromNow, slotStartMs, intervalMin, tz) {
    if (!this.priceProfile) {
      this.priceProfile = (await this.getStoreValue('evPriceProfile')) || EvPriceProfile.createProfile();
    }
    const entries = [];
    (fromNow.prices || []).forEach((price, i) => {
      if (fromNow.isForecast && fromNow.isForecast[i]) return;
      entries.push({
        time: slotStartMs + i * intervalMin * 60 * 1000,
        price,
        exportPrice: fromNow.exportPrices ? fromNow.exportPrices[i] : undefined,
      });
    });
    const before = `${this.priceProfile.lastLearnedMs}|${JSON.stringify(this.priceProfile.dailyMin || {})}`;
    EvPriceProfile.learn(this.priceProfile, entries, tz);
    const after = `${this.priceProfile.lastLearnedMs}|${JSON.stringify(this.priceProfile.dailyMin || {})}`;
    if (after !== before) await this.setStoreValue('evPriceProfile', this.priceProfile).catch(this.error);
    return entries;
  }

  _awayUntilMs(profile, tz, now) {
    const day = profile[EvUsageModel.getDowLocal(new Date(now), tz)];
    // With several trips a day: the first return still to come.
    const nowFh = EvUsageModel.toLocalFractionalHour(new Date(now), tz);
    const next = ((day && day.trips) || []).find((t) => typeof t.returnFh === 'number' && t.returnFh > nowFh);
    const returnFh = next ? next.returnFh : day && day.returnFh;
    if (typeof returnFh === 'number') {
      const t = EvPlanner.localTimeMs(TimeHelpers.getLocalMidnightUTC(new Date(now), tz).getTime(), returnFh, tz);
      if (t > now) return t;
    }
    return now + 3600 * 1000;
  }

  // Temporarily off plans the mode it returns to, without charging until it ends
  // (_offUntilMs): the plan and charts show what comes after. The control keeps it off.
  _plannerMode(chargeMode) {
    if (chargeMode === 'off_temp') return this._plannerMode((this.tempMode && this.tempMode.previousMode) || 'scheduled_price');
    if (chargeMode === 'off') return 'off';
    if (chargeMode === 'fast_charge' || chargeMode === 'charge_temp') return 'fast';
    if (chargeMode === 'solar_only') return 'solar_only';
    return 'smart'; // scheduled_price
  }

  // End of a temporary "off" (ms), else 0.
  _offUntilMs(chargeMode) {
    if (chargeMode !== 'off_temp' || !this.tempMode) return 0;
    return EvChargerControl.tempModeEnd(this.tempMode, this.getSettings().overrideMaxHours);
  }

  // Measured charge power: used when the chargePower setting is 0, shown as a label setting.
  async _setDetectedPower(power) {
    await this.setStoreValue('detectedMaxPower', power).catch(this.error);
    await this.setSettings({ learned_power: `${power} W` }).catch(this.error);
  }

  // ─── Main plan and chart update ─────────────────────────────────────────────

  // Plans and renders. Calls close together (at start-up prices, car report, history learning and
  // listeners all ask) become one run; a call during a run gets one run after it.
  updateChargeChart() {
    if (!this.planQueued) {
      this.planQueued = (this.planRunning || Promise.resolve())
        .catch(() => null)
        .then(() => setTimeoutPromise(PLAN_COALESCE_MS, this))
        .then(() => {
          this.planQueued = null;
          this.planRunning = this._planAndRender();
          return this.planRunning;
        });
    }
    return this.planQueued;
  }

  async _planAndRender() {
    if (!this.pricesNextHours) return;

    const settings = this.getSettings();
    // A set charge power is the maximum; 0 uses the measured one.
    const chargePower = this._chargePowerW();
    const batCapacity = settings.batCapacity || 50;
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const now = Date.now();
    const priceIntervalMin = this.priceInterval || 60;
    const priceSlotStartMs = TimeHelpers.startOfLocalBlock(now, priceIntervalMin, tz);
    const intervalMin = this.planIntervalMin();
    const slotStartMs = TimeHelpers.startOfLocalBlock(now, intervalMin, tz);
    const toPlan = (list) => TimeHelpers.toFinerSlots(list, priceSlotStartMs, priceIntervalMin, slotStartMs, intervalMin);
    const fromNow = this.pricesFromNow(now);
    const prices = toPlan(fromNow.prices);
    const isForecast = toPlan(fromNow.isForecast) || [];
    const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : dflt);

    const atHome = !this.presence || this.presence.atHome;
    // Home but not plugged in: no charging in the next hour, as when away. Plugging in replans.
    const unplugged = atHome && !!(this.presence && this.presence.unplugged);
    // Only when the charger itself says so. The car's plug state can be stale, and then only power
    // shows the cable going in: a charger kept off by the plan (or a flow) would never show it.
    const blockNow = unplugged && this.signals.chargerPlugged === false;
    const reserveSoc = num(settings.reserveSoc, 30);
    const maxSoc = num(settings.maxSoc, 80);
    const efficiency = (this.socEstimator && this.socEstimator.efficiency) || EvSocEstimator.DEFAULT_EFFICIENCY;
    const energyMode = this._energyMode();
    let energyKwh = null;
    let currentSoc = this.lastKnownSoc || 0;
    if (energyMode) {
      // From the reserve to the maximum until sessions are learned; at most an empty battery.
      const need = EvEnergyMode.sessionNeedKwh(
        this.energyState,
        (batCapacity * Math.max(0, maxSoc - reserveSoc)) / 100 / efficiency,
        (batCapacity * maxSoc) / 100 / efficiency,
      );
      // A session only counts while a signal tells when it ends.
      energyKwh = atHome && this._sessionConnected() !== null
        ? EvEnergyMode.remainingKwh(this.energyState, this._readChargedKwh(), need) : need;
    } else if (!atHome) {
      const predicted = this._predictReturnSoc();
      if (predicted !== null) currentSoc = predicted;
    }

    const known = await this._learnPrices(fromNow, priceSlotStartMs, priceIntervalMin, tz);
    const level = EvPriceProfile.level(this.priceProfile, known, tz, now);
    const profile = this.usageModel ? this._profile() : [];
    const awayUntilMs = atHome ? null : this._awayUntilMs(profile, tz, now);
    const overrides = this._overrides(tz, now);
    const trips = EvPlanner.buildTrips({
      now,
      timezone: tz,
      profile,
      capacityKwh: batCapacity,
      reserveSoc,
      manualTimes: [0, 1, 2, 3, 4, 5, 6].map((i) => settings[`departureTime_${i}`] || ''),
      overrides,
      // Still home after the planned departure: keep charging for that trip until the car leaves.
      stillHome: this.presence && this.presence.atHome && this.presence.chargeable
        ? { lastAwayMs: this.lastAwayTm || 0, stepMs: intervalMin * 60 * 1000 } : null,
      tripsToday: EvUsageModel.tripsToday(this.usageModel, this._minTripKwh()),
    });
    const n = Math.ceil((EvPlanner.HORIZON_DAYS * 24 * 60) / intervalMin);
    const chargeMode = this.getCapabilityValue('ev_charge_mode') || 'scheduled_price';
    const offUntilMs = this._offUntilMs(chargeMode);

    // Cheap enough to charge beyond the needs: under the usual lowest price of a day, learned from
    // the published prices over the last 14 days, or the user's fixed price.
    const cheap = EvPlanner.cheapThreshold({
      mode: settings.cheapCharge || 'auto', price: settings.cheapPrice, dailyMin: EvPriceProfile.typicalDailyMin(this.priceProfile),
    });
    this.cheapThreshold = cheap; // for charging on surplus the plan did not expect
    const firstForecast = isForecast.findIndex(Boolean);

    const planStart = Date.now();
    const result = EvPlanner.plan({
      now,
      slotStartMs,
      intervalMin,
      prices,
      exportPrices: toPlan(fromNow.exportPrices),
      expectedPrice: EvPriceProfile.isEmpty(this.priceProfile) ? null : (ms) => EvPriceProfile.expected(this.priceProfile, ms, tz, level),
      solarKwh: this._solarSurplusKwh(slotStartMs, n, intervalMin),
      soc: currentSoc,
      energyKwh,
      capacityKwh: batCapacity,
      chargePowerW: chargePower,
      efficiency,
      atHome: atHome && !blockNow,
      awayUntilMs: blockNow ? now + 3600 * 1000 : awayUntilMs,
      trips,
      reserveSoc,
      reserveHours: num(settings.reserveHours, 8),
      floorSoc: num(settings.floorSoc, 15),
      maxSoc,
      mode: this._plannerMode(chargeMode),
      blockedUntilMs: offUntilMs,
      cheapThreshold: cheap,
      maxPrice: Number(settings.maxPrice) > 0 ? Number(settings.maxPrice) : null,
      certainSlots: firstForecast >= 0 ? firstForecast : undefined,
      variablePower: !!settings.variableChargePower,
      minVariablePowerW: this._variableMinW(),
      solarGridW: Number(settings.solarGridPower) || 0,
      outlookUntilMs: TimeHelpers.getUTCPeriods(tz).tomorrowEnd.getTime(), // shown up to the end of tomorrow
    });
    const strategy = result.scheme;
    const planMs = Date.now() - planStart;
    currentSoc = result.startSoc;

    const { next } = result;
    let nextText = '-';
    if (next) {
      const short = next.plannedSoc < next.requiredSoc - 1;
      // Not enough time to reach the needed SoC: '⚠ reachable/needed'. Without SoC: the energy to charge.
      const need = energyMode
        ? `${short ? '⚠ ' : ''}${energyKwh.toFixed(1)} kWh`
        : `${short ? `⚠ ${next.plannedSoc}/` : ''}${next.requiredSoc}%`;
      nextText = `${new Date(next.departMs).toLocaleDateString(this.homey.i18n.getLanguage() || 'en', { weekday: 'short', timeZone: tz })} `
        + `${EvUsageModel.fractionalHourToHHMM(EvUsageModel.toLocalFractionalHour(new Date(next.departMs), tz))} · ${need}`;
    }
    if (this.hasCapability('ev_next_departure')) await this.setCapability('ev_next_departure', nextText);
    for (const day of ['today', 'tomorrow']) {
      if (this.hasCapability(`ev_${day}`)) await this.setCapability(`ev_${day}`, this._dayPickerValue(day, overrides, tz));
      if (this.hasCapability(`ev_${day}_time`)) await this.setCapability(`ev_${day}_time`, this._dayTimePickerValue(day, overrides, tz));
    }
    await this._updateUnpluggedAlarm(unplugged && this._plannerMode(chargeMode) !== 'off' && chargeMode !== 'off_temp' ? next : null, currentSoc, now, nextText);
    const nowSlot = strategy[0] || {};
    const socText = energyMode ? `no SoC, ${energyKwh.toFixed(1)} kWh to charge` : `SoC ${Math.round(currentSoc)}%`;
    this.log(`[EV Plan] ${chargeMode}, ${socText}${atHome ? '' : ' (predicted return)'}${unplugged ? ', not plugged in' : ''}, next: ${nextText}, `
      + `now: ${nowSlot.duration ? `${nowSlot.duration} min${nowSlot.solar ? ' solar' : ''}` : 'no'}, price level ${level.import >= 0 ? '+' : ''}${level.import.toFixed(3)}`
      + `, cheap ${cheap ? `<= ${cheap.grid.toFixed(3)} (solar ${cheap.solar.toFixed(3)}, ${EvPriceProfile.dailyMinDays(this.priceProfile)} days)` : 'off'}`
      + `${result.shortfalls.length ? `, short: ${result.shortfalls.map((sf) => `${sf.what} ${sf.missing}%`).join(', ')}` : ''}`
      + `, ${planMs} ms`);
    await this._logPlanDiag({
      now, tz, slotStartMs, intervalMin, strategy, next, currentSoc, energyMode, energyKwh, blockNow, awayUntilMs, offUntilMs, unavailable: result.unavailable,
    }).catch(this.error);

    if (Object.keys(strategy).length) {
      // Only when the decision for the current slot changed: the plan is recalculated on every SoC
      // step, presence change, price update and override, which would flood users' flows.
      const slotKey = `${slotStartMs}|${nowSlot.power || 0}|${Math.round((nowSlot.duration || 0) / 5)}`;
      if (slotKey !== this.lastStrategyTriggerKey && typeof this.flows.triggerNewEvStrategyFlow === 'function') {
        this.lastStrategyTriggerKey = slotKey;
        await this.flows.triggerNewEvStrategyFlow(strategy).catch(this.error);
      }

      Object.keys(strategy).forEach((k) => {
        if (isForecast[k]) strategy[k].isForecast = true;
      });

      // Car not connected: all strategy slots shown as forecast (grey)
      if (!this.isCarConnected) {
        Object.keys(strategy).forEach((k) => {
          if (strategy[k] && typeof strategy[k] === 'object') strategy[k].isForecast = true;
        });
      }

      await this.refreshDapPrices().catch(() => { });

      // Off without a reported SoC (car or charger) and in energy mode: the line would only be a guess.
      const showSoc = this.getSettings().chartShowSoc !== false && !!(this.sourceCapGroup && this.sourceCapGroup.soc) && !energyMode;

      // The plan on expected prices after the published ones: shown pale, not executed.
      const chartScheme = { ...strategy };
      Object.entries(result.outlook).forEach(([k, slot]) => {
        chartScheme[k] = { ...slot, isForecast: true };
      });

      await this.renderChargeCharts({
        scheme: chartScheme,
        planSlots: Object.keys(strategy).length,
        chargePower,
        dischargePower: 0, // no V2X discharge
        socFallback: currentSoc,
        showPower: !!this.getSettings().chartShowPower,
        showSoc,
        showExportPrice: this.getSettings().chartShowExportPrice !== false,
        showLegend: this.getSettings().chartShowLegend !== false,
        planTm: now,
      });
      await this._updateNextChargeText();
      await this._applyChargerControl().catch(this.error);
    }
  }

  // Diagnostics without app logs (Prod): the plan_log label keeps the last plan changes and
  // commands to the car. A plan is written only when the presence, a block or the future charge
  // slots change, not on every replan.
  async _appendPlanLog(text) {
    const tz = this.timeZone || this.homey.clock.getTimezone();
    const now = new Date();
    const stamp = `${now.toLocaleDateString('en', { weekday: 'short', timeZone: tz })} `
      + `${EvUsageModel.fractionalHourToHHMM(EvUsageModel.toLocalFractionalHour(now, tz))}`;
    const log = [`${stamp} ${text}`, ...(this.getStoreValue('evPlanLog') || [])].slice(0, PLAN_LOG_ENTRIES);
    await this.setStoreValue('evPlanLog', log).catch(this.error);
    await this.setSettings({ plan_log: log.join(' ‖ ') }).catch(this.error);
  }

  async _logPlanDiag({
    now, tz, slotStartMs, intervalMin, strategy, next, currentSoc, energyMode, energyKwh, blockNow, awayUntilMs, offUntilMs,
    unavailable = [],
  }) {
    const intervalMs = intervalMin * 60 * 1000;
    const hhmm = (ms) => EvUsageModel.fractionalHourToHHMM(EvUsageModel.toLocalFractionalHour(new Date(ms), tz));
    const starts = Object.keys(strategy)
      .filter((k) => strategy[k] && strategy[k].power > 0 && strategy[k].duration > 0)
      .map((k) => slotStartMs + Number(k) * intervalMs);
    // Consecutive slots as ranges; with a key, a range per key.
    const toRanges = (list, keyOf = () => '') => {
      const out = [];
      list.forEach((item) => {
        const ms = typeof item === 'number' ? item : item.startMs;
        const key = keyOf(item);
        const last = out[out.length - 1];
        if (last && last.end === ms && last.key === key) last.end = ms + intervalMs;
        else out.push({ start: ms, end: ms + intervalMs, key });
      });
      return out.slice(0, 3).map((r) => `${r.key ? `${r.key} ` : ''}${hhmm(r.start)}-${hhmm(r.end)}`).join(',')
        + (out.length > 3 ? ` +${out.length - 3}` : '');
    };
    const p = this.presence || {};
    const status = [
      p.state || '?',
      p.unplugged ? 'unplugged' : '',
      typeof this.signals.carPlugged === 'boolean' ? `carPlug ${this.signals.carPlugged}` : '',
      p.noResponse ? 'noResponse' : '',
      p.chargeable === false ? 'notChargeable' : '',
      this._standby() ? `det ${this.signals.detectedPlugged}` : '',
      blockNow ? 'blockNow' : '',
      awayUntilMs ? `away→${hhmm(awayUntilMs)}` : '',
      offUntilMs > now ? `off→${hhmm(offUntilMs)}` : '',
      next ? `trip ${hhmm(next.departMs)} ${next.requiredSoc}%` : '',
      unavailable.length ? `no ${toRanges(unavailable, (u) => u.why)}` : '',
    ].filter(Boolean).join(' ');
    // Slots added or dropped after the current one: slots that only passed are no change.
    const prev = this.planDiagPrev;
    const future = (list) => list.filter((ms) => ms > slotStartMs).join(',');
    const changed = !prev || prev.status !== status || future(prev.starts) !== future(starts);
    this.planDiagPrev = { status, starts };
    if (!changed) return;
    const soc = energyMode ? `${energyKwh.toFixed(1)}kWh` : `${Math.round(currentSoc)}%`;
    await this._appendPlanLog(`${soc} ${status} | ${starts.length ? toRanges(starts) : 'none'}`);
  }

  // Alarm and trigger: not plugged in while the next departure, within a day, needs more charge.
  async _updateUnpluggedAlarm(next, currentSoc, now, nextText) {
    if (!this.hasCapability('alarm_generic')) return;
    const alarm = !!next && next.departMs - now <= 24 * 3600 * 1000 && next.requiredSoc > Math.round(currentSoc);
    if (this.getCapabilityValue('alarm_generic') === alarm) return;
    await this.setCapability('alarm_generic', alarm);
    if (!alarm) return;
    this.log(`[EV Slot] Not plugged in, next departure ${nextText} needs ${next.requiredSoc}% (now ${Math.round(currentSoc)}%)`);
    if (this.homey.app.trigger_ev_not_plugged_in) {
      this.homey.app.trigger_ev_not_plugged_in(this, { departure: nextText, required_soc: next.requiredSoc }, {}).catch(this.error);
    }
  }

  // ─── Batch departure pattern learning from Insights ────────────────────────

  async learnDeparturePattern({ retrain = false } = {}) {
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

      const fetchLog = (deviceId, capNames) => EvHistory.fetchPowerLog({
        api, logs, deviceId, capNames, startDate, endDate,
      });

      // Odometer history for the usage model. Checked live on a Kia odometer log (2026-09-26):
      // last14Days gives hourly points, last31Days 6-hour points, longer resolutions nothing useful.
      // So: hourly for the last 14 days, 6-hourly (marked coarse) before that.
      const fetchOdometer = async (deviceId, capName) => {
        const log = logs.find((l) => {
          const id = l.id || l.uri || '';
          return id.includes(deviceId) && (id.endsWith(`:${capName}`) || l.name === capName);
        });
        if (!log) return null;
        const get = async (resolution, coarse) => {
          const data = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
          return ((data && data.values) || [])
            .filter((e) => typeof e.v === 'number')
            .map((e) => ({ t: new Date(e.t).getTime(), v: e.v, coarse }));
        };
        const fine = await get('last14Days', false);
        const coarse = await get('last31Days', true);
        const firstFine = fine.length ? fine[0].t : Infinity;
        return coarse.filter((e) => e.t < firstFine).concat(fine);
      };

      // Homey logs measure_power under 'energy_power'; a 'measure_power' log can exist but is empty
      // (skill section 3). meter_power only without energy_power history.
      const powerEntries = await fetchLog(chargerId, ['energy_power', 'meter_power']);

      let socEntries = null;
      let odoEntries = null;
      if (evId && evId !== 'none') {
        socEntries = await fetchLog(evId, ['measure_battery']);
        if (this.carCapGroup && this.carCapGroup.odometer) odoEntries = await fetchOdometer(evId, this.carCapGroup.odometer);
      }
      // Distance from home from the car's history (its own distance to home, else its location):
      // nights away are not learned.
      let distEntries = null;
      if (odoEntries && this.carCapGroup.homeDistance) {
        const units = this.evDevice?.capabilitiesObj?.[this.carCapGroup.homeDistance]?.units;
        distEntries = ((await fetchOdometer(evId, this.carCapGroup.homeDistance)) || []).map((e) => ({ t: e.t, km: EvCarCaps.toKm(e.v, units) }));
      }
      if (odoEntries && !(distEntries && distEntries.length) && this.carCapGroup.latitude && this.carCapGroup.longitude) {
        let home = null;
        try {
          home = { lat: this.homey.geolocation.getLatitude(), lon: this.homey.geolocation.getLongitude() };
        } catch { /* no location */ }
        const lats = await fetchOdometer(evId, this.carCapGroup.latitude);
        const lons = new Map(((await fetchOdometer(evId, this.carCapGroup.longitude)) || []).map((e) => [e.t, e.v]));
        if (home && typeof home.lat === 'number' && lats && lats.length) {
          distEntries = lats.filter((e) => lons.has(e.t))
            .map((e) => ({ t: e.t, km: EvPresence.distanceKm(e.v, lons.get(e.t), home.lat, home.lon) }));
        }
      }
      if (odoEntries && !(distEntries && distEntries.length)) {
        distEntries = null;
        this.log('[EV Usage] No distance to home or location history in Insights: nights away are only seen live');
      }

      // Expected-price profile from the DAP price history (hourly, 14 days), once. Built fresh:
      // live learning only takes prices newer than the last learned one, so history must go first.
      if (!this.priceProfile) this.priceProfile = (await this.getStoreValue('evPriceProfile')) || EvPriceProfile.createProfile();
      if (retrain || this.priceProfile.bootstrapped !== PRICE_BOOTSTRAP_VERSION) {
        // The electricity DAP devices (not gas) that feed this device's tariff group.
        const dapIds = await this._groupDapDeviceIds();
        // The longest history of those devices (a new price device next to an old one has little).
        const hourly = async (capName) => {
          let best = [];
          for (const log of this._findGroupPriceLogs(logs, dapIds, capName)) {
            const data = await api.insights.getLogEntries({ id: log.id, resolution: 'last14Days' }).catch(() => null);
            const values = ((data && data.values) || []).filter((e) => typeof e.v === 'number')
              .map((e) => ({ t: new Date(e.t).getTime(), v: e.v }));
            if (values.length > best.length) best = values;
          }
          return best;
        };
        const imp = await hourly(PriceDrivers.PRICE_LOG_CAPS.import);
        // A retrain without price history keeps what was learned live.
        if (imp.length || !retrain) {
          const exp = new Map((await hourly(PriceDrivers.PRICE_LOG_CAPS.export)).map((e) => [e.t, e.v]));
          const fresh = EvPriceProfile.createProfile();
          EvPriceProfile.learn(fresh, imp.map((e) => ({ time: e.t, price: e.v, exportPrice: exp.get(e.t) })), tz);
          fresh.bootstrapped = PRICE_BOOTSTRAP_VERSION;
          this.priceProfile = fresh;
          await this.setStoreValue('evPriceProfile', this.priceProfile).catch(this.error);
          this.log(`[EV Plan] Price profile bootstrapped from ${imp.length} hourly prices`);
        }
      }

      // Usage model from the car's odometer history, merged under what was learned live.
      if (odoEntries && odoEntries.length > 1) {
        const boot = EvUsageModel.bootstrapFromHistory(odoEntries, socEntries, batCap, tz, new Date(), distEntries);
        this.usageModel = EvUsageModel.mergeBootstrap(this.usageModel, boot);
        if (typeof this.usageModel.lastOdo !== 'number') {
          const liveOdo = this.evDevice?.capabilitiesObj?.[this.carCapGroup.odometer]?.value;
          if (typeof liveOdo === 'number') this.usageModel.lastOdo = liveOdo;
        }
        const awayDays = boot.days.filter((d) => d.awayNight).map((d) => d.date.slice(5));
        this.log(`[EV Usage] Bootstrapped ${boot.days.length} days from Insights, model has ${this.usageModel.days.length}`
          + `${distEntries ? `, away overnight: ${awayDays.length ? awayDays.join(' ') : 'none'}` : ''}`);
      } else if (!this.usageModel) {
        this.usageModel = EvUsageModel.createModel();
      }
      EvUsageModel.rollover(this.usageModel, new Date(), tz);
      await this._saveUsageModel();
      await this._updateLearnedProfileSettings();

      const hasPowerHistory = Array.isArray(powerEntries) && powerEntries.length >= 2;
      if (!hasPowerHistory) this.log('[EV Slot] No power history found in Insights for charger.');

      if (hasPowerHistory) {
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

      const detected = hasPowerHistory && EvHistory.detectChargePower(powerEntries);
      if (detected) {
        this.log(`[EV Power Auto-Detect] Charge power from history (99th percentile): ${detected} W`);
        await this._setDetectedPower(detected);
      }

      this.log('[EV Slot] History learning complete.');
      await this.updateChargeChart().catch((err) => this.error(err));
    } catch (err) {
      this.error('[EV Slot] learnDeparturePattern failed:', err);
    }
  }

  // ─── Update learned profile display in settings ─────────────────────────────

  async _updateLearnedProfileSettings() {
    if (!this.usageModel) return;
    try {
      const capacity = this.getSettings().batCapacity || 50;
      const profile = this._profile();
      const update = {};
      profile.forEach((day) => {
        const key = LEARNED_PROFILE_KEYS[day.dow];
        if (!day.observed) {
          update[key] = this.homey.__('ev_profile_not_learned');
          return;
        }
        const count = `${day.used}/${day.observed}`;
        if (!day.used) {
          update[key] = `${this.homey.__('ev_profile_unused')} · ${count}`;
          return;
        }
        const parts = [this.homey.__(day.regular ? 'ev_profile_regular' : 'ev_profile_sometimes')];
        if (day.trips.length) parts.push(day.trips.map((t) => EvUsageModel.fractionalHourToHHMM(t.departFh)).join(' + '));
        else if (typeof day.departFh === 'number') parts.push(EvUsageModel.fractionalHourToHHMM(day.departFh));
        if (typeof day.safeKwh === 'number') parts.push(`${day.safeKwh} kWh (${Math.round((day.safeKwh / capacity) * 100)}%)`);
        parts.push(count);
        update[key] = parts.join(' · ');
      });
      const kwhPerKm = EvUsageModel.effectiveKwhPerKm(this.usageModel);
      update.learned_consumption = kwhPerKm
        ? `${(kwhPerKm * 100).toFixed(1)} kWh/100 km (n=${this.usageModel.kwhPerKmSamples})`
        : `- (n=${this.usageModel.kwhPerKmSamples || 0})`;
      await this.setSettings(update).catch(this.error);
      await this._updateWeeklyChart(profile);
    } catch (e) {
      this.error('_updateLearnedProfileSettings failed:', e);
    }
  }

  async _updateWeeklyChart(profile) {
    if (!this.evWeeklyImage) return;
    const settings = this.getSettings();
    const lang = this.homey.i18n.getLanguage() || 'en';
    // 2026-09-28 is a Monday: its week gives the localized day names, Monday first.
    const dayNames = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(Date.UTC(2026, 8, 28 + i, 12))
      .toLocaleDateString(lang, { weekday: 'short', timeZone: 'UTC' }));
    const chart = getEvWeeklyChart(profile, {
      capacityKwh: settings.batCapacity || 50,
      reserveSoc: Number.isFinite(Number(settings.reserveSoc)) ? Number(settings.reserveSoc) : 30,
      minObserved: EvPlanner.MIN_OBSERVED,
      defaultNeedPct: EvPlanner.DEFAULT_NEED_PCT,
      dayNames,
      labels: {
        reserve: this.homey.__('ev_chart_reserve'),
        regular: this.homey.__('ev_profile_regular'),
        sometimes: this.homey.__('ev_profile_sometimes'),
        assumed: this.homey.__('ev_chart_assumed'),
      },
    });
    if (!chart) return;
    const key = JSON.stringify(chart);
    if (key === this.lastEvWeeklyKey) return; // unchanged: no new render at quickchart.io
    this.lastEvWeeklyKey = key;
    this.chartEvWeekly = chart;
    await this.evWeeklyImage.update().catch(this.error);
  }
}

Object.assign(CarChargeDevice.prototype, ChargeDeviceHelpers);

module.exports = CarChargeDevice;
