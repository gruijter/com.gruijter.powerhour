/* eslint-disable camelcase */

'use strict';

class SumFlows {
  constructor(device) {
    this.device = device;
  }

  async set_tariff_group(args) {
    const { group } = args;
    this.device.log('changing tariff update group via flow', this.device.getName(), group);
    await this.device.setSettings({ tariff_update_group: group }).catch((err) => this.device.error(err));
    this.device.restartDevice(60 * 1000).catch((error) => this.device.error(error));
  }

  async set_daily_fixed_cost(args) {
    const v = Number(args.value);
    await this.device.setSettings({ markup_day: Number.isFinite(v) ? v : 0 });
    return true;
  }

  async minmax_reset(args) {
    if (!this.device.lastMinMax || !this.device.lastMinMax.reading) {
      this.device.error('minMax could not be reset (nothing to reset yet)');
      return;
    }
    let reset = true;
    let source = 'flow';
    if (args && args.reset !== undefined) reset = args.reset;
    if (args && args.source !== undefined) source = args.source;

    if (reset) {
      this.device.log(`Resetting Min/Max via ${source}`);
      this.device.lastMinMax = {
        reading: { ...this.device.lastMinMax.reading }, // contains last meter reading object used for min/max
        wattMax: null,
        lpmMax: null,
        wattMin: null,
        lpmMin: null,
        reset: new Date(), // time at wich the min/max was reset
      };
    }
    const date = this.device.lastMinMax.reset.toLocaleString('nl-NL', {
      timeZone: this.device.timeZone, hour12: false, day: '2-digit', month: '2-digit',
    });
    const time = this.device.lastMinMax.reset.toLocaleString('nl-NL', {
      timeZone: this.device.timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
    });
    await this.device.setCapability('measure_watt_max', this.device.lastMinMax.wattMax).catch((err) => this.device.error(err));
    await this.device.setCapability('measure_lpm_max', this.device.lastMinMax.lpmMax).catch((err) => this.device.error(err));
    await this.device.setCapability('measure_watt_min', this.device.lastMinMax.wattMin).catch((err) => this.device.error(err));
    await this.device.setCapability('measure_lpm_min', this.device.lastMinMax.lpmMin).catch((err) => this.device.error(err));
    await this.device.setCapability('last_minmax_reset', `${date} ${time}`).catch((err) => this.device.error(err));
    await this.device.setStoreValue('lastMinMax', this.device.lastMinMax).catch((err) => this.device.error(err));
  }
}

module.exports = SumFlows;
