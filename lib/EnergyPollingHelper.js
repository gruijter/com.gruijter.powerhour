'use strict';

const { setTimeoutPromise } = require('./Util');

class EnergyPollingHelper {
  constructor() {
    this.callbacks = new Set();
    this.intervalId = null;
    this.isDestroyed = false;
    this.isPolling = false;
    this.homey = null;
    this.logger = console;
    this.intervalSeconds = 5;
  }

  init(homey, logger) {
    if (!this.homey) {
      this.homey = homey;
      if (this.homey.platformVersion === 1) {
        (logger || this.logger).log('Warning: On Homey 2016/2019 it is not possible to manually enable/disable what is the main grid meter.');
      }
    }
    if (!this.logger && logger) this.logger = logger;
  }

  async register(callback) {
    this.callbacks.add(callback);
    if (!this.isPolling) {
      this.startPolling();
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
      } catch (e) {}
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

        if (hasEnergyApi) {
          report = await api.energy.getLiveReport().catch((err) => {
            this.logger.error(err);
            return null;
          });
          // console.dir(report, { depth: null });
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
          this.intervalId = this.homey.setTimeout(poll, 1000 * this.intervalSeconds);
        } else {
          this.isPolling = false;
          this.intervalId = null;
        }
      }
    };
    poll();
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
