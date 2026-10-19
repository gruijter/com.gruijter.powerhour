'use strict';

// TEMP memory profiler (remove after the test): V8 heap, CPU, event loop, and per method around the
// hour (xx:59:50 - xx:02:00) its duration and heap change.
// process.memoryUsage() crashes in the Homey sandbox (homey-realtime-profiling skill); these do not.
const v8 = require('v8');
const { performance } = require('perf_hooks');

const mb = (b) => (b / 1024 / 1024).toFixed(2);
const usedMb = () => v8.getHeapStatistics().used_heap_size / 1024 / 1024;

const DEVICE_METHODS = ['handleUpdateMeter', 'updateMeters', 'updateMoney', 'updateAvgMoney', 'updateTargets',
  'updateTariffHistory', 'updatePrices', 'onPricesUpdated', 'onPlanSlot', 'updateChargeChart', '_planAndRender',
  '_updateWeeklyChart', 'updateForecastDisplay', 'updateLearning', 'retrainLoadModel', 'updatePeakProjection',
  'recordForecastError', 'updateForecastAccuracyStatus', 'onHourlyEvent', 'setState', 'updatePriceCharts',
  'setPriceCapabilities', 'setCapabilitiesAndFlows', 'runPriceTriggers', 'storePrices', 'updateApplianceDisplay',
  'checkDayPlans', 'renderAppliancePlanCharts', 'drawAppliancePlanCharts', 'renderPriceCharts', 'pollMeter', 'poll',
  'refreshDapPrices', 'onPriceSlot', 'applySlotTariff', 'renderChargeCharts'];
const DRIVER_METHODS = ['applyTariffFromEvent', 'setPricesDeviceExclusive', 'checkAndPollDevice', 'updateDeviceTariff',
  'priceSlotTickExclusive'];

class MemProfiler {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this.wrapped = new WeakSet();
  }

  start() {
    this.lastCpu = process.cpuUsage();
    this.lastElu = performance.eventLoopUtilization();
    this.lastTm = Date.now();
    this.maxLag = 0;
    this.schedule();
    // Drivers and devices start after the app.
    this.wrapTimer = this.homey.setTimeout(() => this.wrapAll(), 3 * 60 * 1000);
  }

  stop() {
    if (this.timer) this.homey.clearTimeout(this.timer);
    if (this.wrapTimer) this.homey.clearTimeout(this.wrapTimer);
    this.timer = null;
  }

  static inPeakWindow(now = new Date()) {
    const m = now.getMinutes();
    const s = now.getSeconds();
    return (m === 59 && s >= 50) || m < 2;
  }

  // Every second in the peak window, every 5 s from xx:58 to xx:03, else every 60 s.
  schedule() {
    const now = new Date();
    const min = now.getMinutes();
    let delay = (min >= 58 || min < 4) ? 5000 : 60000;
    if (MemProfiler.inPeakWindow(now) || (min === 59 && now.getSeconds() >= 45)) delay = 1000;
    const due = Date.now() + delay;
    this.timer = this.homey.setTimeout(() => {
      this.maxLag = Math.max(this.maxLag, Date.now() - due);
      try {
        this.sample(delay < 60000);
      } catch (err) {
        this.app.error('[MEM] sample failed', err.message);
      }
      this.schedule();
    }, delay);
  }

  sample(fine) {
    const now = Date.now();
    const h = v8.getHeapStatistics();
    const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, s.space_used_size]));
    const cpu = process.cpuUsage(this.lastCpu);
    const elu = performance.eventLoopUtilization(this.lastElu);
    const dt = Math.max(1, now - this.lastTm);
    let devices = 0;
    try {
      Object.values(this.homey.drivers.getDrivers()).forEach((d) => {
        devices += d.getDevices().length;
      });
    } catch {
      devices = -1;
    }
    this.app.log(`[MEM] ${fine ? 'F' : 'M'} used ${mb(h.used_heap_size)} total ${mb(h.total_heap_size)}`
      + ` limit ${mb(h.heap_size_limit)} ext ${mb(h.external_memory || 0)} malloc ${mb(h.malloced_memory)}`
      + ` old ${mb(spaces.old_space || 0)} large ${mb(spaces.large_object_space || 0)} code ${mb(spaces.code_space || 0)}`
      + ` ctx ${h.number_of_native_contexts} detached ${h.number_of_detached_contexts}`
      + ` cpu ${(((cpu.user + cpu.system) / 1000 / dt) * 100).toFixed(1)}% elu ${(elu.utilization * 100).toFixed(1)}%`
      + ` lag ${this.maxLag} dev ${devices}`);
    this.lastCpu = process.cpuUsage();
    this.lastElu = performance.eventLoopUtilization();
    this.lastTm = now;
    this.maxLag = 0;
  }

  // Logs a call in the peak window: duration and used heap before -> after (GC can make it drop).
  wrap(target, name, label) {
    const orig = target[name];
    if (typeof orig !== 'function') return;
    const log = (msg) => this.app.log(msg);
    target[name] = function profiled(...args) {
      if (!MemProfiler.inPeakWindow()) return orig.apply(this, args);
      const t0 = Date.now();
      const m0 = usedMb();
      const who = typeof this.getName === 'function' ? this.getName() : '';
      const done = () => {
        const dur = Date.now() - t0;
        const m1 = usedMb();
        if (dur >= 20 || Math.abs(m1 - m0) >= 0.3) {
          log(`[MEMT] ${label}.${name} ${who} ${dur} ms used ${m0.toFixed(2)} -> ${m1.toFixed(2)} (${(m1 - m0 >= 0 ? '+' : '')}${(m1 - m0).toFixed(2)})`);
        }
      };
      let result;
      try {
        result = orig.apply(this, args);
      } catch (err) {
        done();
        throw err;
      }
      if (result && typeof result.then === 'function') return result.finally(done);
      done();
      return result;
    };
  }

  wrapAll() {
    try {
      Object.entries(this.homey.drivers.getDrivers()).forEach(([id, driver]) => {
        const dproto = Object.getPrototypeOf(driver);
        if (!this.wrapped.has(dproto)) {
          this.wrapped.add(dproto);
          DRIVER_METHODS.forEach((name) => this.wrap(dproto, name, `${id}Driver`));
        }
        driver.getDevices().forEach((device) => {
          const proto = Object.getPrototypeOf(device);
          if (this.wrapped.has(proto)) return;
          this.wrapped.add(proto);
          DEVICE_METHODS.forEach((name) => this.wrap(proto, name, id));
          if (device.flows) {
            const fproto = Object.getPrototypeOf(device.flows);
            if (!this.wrapped.has(fproto)) {
              this.wrapped.add(fproto);
              ['planTokens', 'triggerNewRoiStrategyFlow'].forEach((name) => this.wrap(fproto, name, `${id}Flows`));
            }
          }
        });
      });
      if (typeof this.app.getInsightsLogs === 'function') this.wrap(this.app, 'getInsightsLogs', 'app');
      this.app.log('[MEM] methods wrapped for the peak window');
    } catch (err) {
      this.app.error('[MEM] wrap failed', err.message);
    }
  }
}

module.exports = MemProfiler;
