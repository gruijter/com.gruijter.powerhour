'use strict';

const { setTimeoutPromise } = require('./Util');

class EnergyPollingHelper {
  constructor(homey, logger) {
    this.homey = homey;
    this.logger = logger;
    this.intervalId = null;
    this.isDestroyed = false;
  }

  async startPolling(intervalSeconds, callback) {
    this.stopPolling();
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
      this.logger.log('Homey API not ready, cannot start energy polling');
      return;
    }

    this.logger.log(`start polling Cumulative Energy @${intervalSeconds} seconds interval`);

    const poll = async () => {
      if (this.isDestroyed) return;
      try {
        const report = await api.energy.getLiveReport().catch((err) => this.logger.error(err));
        if (report && !this.isDestroyed) {
          await callback(report);
        }
      } catch (error) {
        this.logger.error(error);
      } finally {
        if (!this.isDestroyed) {
          this.intervalId = this.homey.setTimeout(poll, 1000 * intervalSeconds);
        }
      }
    };
    poll();
  }

  stopPolling() {
    this.isDestroyed = true;
    if (this.intervalId) {
      this.homey.clearInterval(this.intervalId);
      this.homey.clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }
}

module.exports = EnergyPollingHelper;
