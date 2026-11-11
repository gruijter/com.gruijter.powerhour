'use strict';

const { setTimeoutPromise, getGridPowerFallback } = require('./Util');
const GridConnection = require('./GridConnection');

class EnergyPollingHelper {
  constructor() {
    this.callbacks = new Set();
    this.drivers = new Set(); // started by startFor()
    this.intervalId = null;
    this.isDestroyed = false;
    this.isPolling = false;
    this.homey = null;
    this.logger = console;
    this.intervalSeconds = 5;
  }

  init(homey, logger) {
    if (!this.homey) this.homey = homey;
    if (logger && this.logger === console) this.logger = logger;
  }

  // The poll of a driver with onEnergyReport(report): started with its first device, stopped in
  // its onUninit() (the generic drivers do both).
  async startFor(driver) {
    if (driver.energyPollCallback || typeof driver.onEnergyReport !== 'function') return;
    this.init(driver.homey, { log: driver.log.bind(driver), error: driver.error.bind(driver) });
    driver.energyPollCallback = (report) => driver.onEnergyReport(report);
    this.drivers.add(driver);
    await this.register(driver.energyPollCallback);
  }

  stopFor(driver) {
    this.drivers.delete(driver);
    if (!driver.energyPollCallback) return;
    this.unregister(driver.energyPollCallback);
    driver.energyPollCallback = null;
  }

  // The grid power now (W, + import): the Grid Monitor's, else Homey Energy's from the report.
  // undefined: none, or beyond the plausibility ceiling (GridConnection).
  async gridPowerW(report) {
    const power = getGridPowerFallback(this.homey);
    const gridW = power === null ? report?.totalCumulative?.W : power;
    if (!Number.isFinite(gridW)) return undefined;
    return Math.abs(gridW) > await GridConnection.ceilingW(this.homey) ? undefined : gridW;
  }

  // The live report is a fallback: for the grid power without a Grid Monitor that reads it, and
  // for what a driver asks it for (needsEnergyReport()).
  needsReport() {
    if (getGridPowerFallback(this.homey) === null) return true;
    for (const driver of this.drivers) {
      try {
        if (typeof driver.needsEnergyReport === 'function' && driver.needsEnergyReport()) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  async register(callback) {
    this.callbacks.add(callback);
    if (!this.isPolling) {
      this.startPolling().catch((error) => this.logger.error(error));
    }
  }

  unregister(callback) {
    this.callbacks.delete(callback);
    if (this.callbacks.size === 0) {
      this.stopPolling();
    }
  }

  async startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.isDestroyed = false;

    let retries = 0;
    let api;
    while (!api && retries < 60) {
      try {
        api = this.homey.app.api;
      } catch {}
      if (api) break;
      await setTimeoutPromise(1000, { homey: this.homey });
      retries += 1;
      if (this.isDestroyed) return;
    }

    if (!api) {
      this.logger.log('Homey API not ready, cannot start centralized energy polling');
      this.isPolling = false;
      return;
    }

    const hasEnergyApi = typeof api.energy?.getLiveReport === 'function';
    if (!hasEnergyApi) {
      this.logger.log('Homey Energy getLiveReport API is not available. Will rely exclusively on PbtH Grid device fallback.');
    }

    this.logger.log(`start centralized polling Cumulative Energy @${this.intervalSeconds} seconds interval`);

    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        let report = null;

        if (hasEnergyApi && this.needsReport()) {
          report = await api.energy.getLiveReport().catch((err) => {
            this.logger.error(err);
            return null;
          });
        }

        if (!this.isDestroyed) {
          for (const callback of this.callbacks) {
            try {
              await callback(report);
            } catch (cbErr) {
              this.logger.error('Error in energy poller callback:', cbErr);
            }
          }
        }
      } catch (error) {
        this.logger.error(error);
      } finally {
        if (!this.isDestroyed && this.callbacks.size > 0) {
          this.intervalId = this.homey.setTimeout(() => {
            poll().catch((error) => this.logger.error(error));
          }, 1000 * this.intervalSeconds);
        } else {
          this.isPolling = false;
          this.intervalId = null;
        }
      }
    };
    poll().catch((error) => this.logger.error(error));
  }

  stopPolling() {
    this.isDestroyed = true;
    this.isPolling = false;
    if (this.intervalId && this.homey) {
      this.homey.clearInterval(this.intervalId);
      this.homey.clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }
}

module.exports = new EnergyPollingHelper();
