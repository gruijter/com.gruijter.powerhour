'use strict';

/* eslint-disable global-require, import/no-dynamic-require, @typescript-eslint/no-this-alias, no-underscore-dangle */

// TEMP crash recorder (remove after the test). Everything goes to app settings: readable over the API
// on Prod and kept across a crash. process.memoryUsage() crashes in the Homey sandbox
// (homey-realtime-profiling skill); v8 heap statistics and process.resourceUsage() do not.
//
//   memBoots     app starts (an extra one = a crash or restart)
//   memLast      every 5 s, and around heavy calls: the last 2 min of samples, calls running,
//                calls ended, API requests, fetches, error lines; copied to memCrashes at the next boot
//   memCrashes   memLast of the runs before (last 10)
//   memProfile   per UTC minute [time, used max, total max, large max, cpu %, lag ms, ext max,
//                maxRSS MB, realtime item updates, API requests, fetches] (last 1800)
//   memFine      1-s samples xx:59:50 - xx:02 (last 400); memCalls: calls in that window (last 1000)
//   memApi       homey-api requests (last 600); memFetch: fetch() calls (last 300); memLp: LP solves
//   memErrors    uncaught exceptions / unhandled rejections with stack; memErrLines: error() lines
//   memLpRun / memHeavyRun   set before an LP solve / a call that took >= HEAVY_MS before

const v8 = require('v8');
const { performance } = require('perf_hooks');

const mb = (b) => Number((b / 1024 / 1024).toFixed(2));
const usedMb = () => v8.getHeapStatistics().used_heap_size / 1024 / 1024;
const iso = (ms) => new Date(ms).toISOString().slice(5, 19);
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
const HEAVY_MS = 1000;
const FLOW_MODULES = ['BatFlows', 'DapFlows', 'EvFlows', 'Flows', 'GridFlows', 'PowerFlows', 'PriceFlows', 'SolarFlows', 'SumFlows'];
// Light: only these methods are timed (wrapping all methods pushed the process memory over the limit
// at startup, 2026-10-28).
const WRAP = new Set(['onInit', 'initDevice', 'handleUpdateMeter', 'updateMeters', 'updateMoney', 'updateTargets',
  'updateTariffHistory', 'pollMeter', 'poll', 'refreshDapPrices', 'onPriceSlot', 'applySlotTariff', 'onPlanSlot',
  'updateChargeChart', 'renderChargeCharts', 'updateForecastDisplay', 'updateLearning', 'retrainLoadModel',
  'reconstructHomePowerHistory', 'recordForecastError', 'updatePeakProjection', 'updateApplianceDisplay',
  'renderAppliancePlanCharts', 'checkDayPlans', 'updatePriceCharts', 'renderPriceCharts', 'setPriceCapabilities',
  'runPriceTriggers', 'storePrices', 'fetchPrices', 'onHourlyEvent', 'setState', 'updateWarning',
  'applyTariffFromEvent', 'setPricesDeviceExclusive', 'checkAndPollDevice', 'priceSlotTickExclusive',
  'planTokens', 'triggerNewRoiStrategyFlow', 'solve', 'check', 'fetchHistory', 'retrain', 'runLearning',
  'getInsightsLogs', 'replan', 'planEv', 'updatePlan']);

const push = (list, item, max) => {
  list.push(item);
  while (list.length > max) list.shift();
};

// file:line of the first app frames of the caller.
const callerOf = (skip = 3, n = 3) => (new Error().stack || '').split('\n').slice(skip)
  .filter((l) => !l.includes('MemProfiler') && !l.includes('node_modules') && !l.includes('node:'))
  .slice(0, n)
  .map((l) => (l.match(/([^/(\s]+:\d+):\d+\)?$/) || [])[1])
  .filter(Boolean)
  .join(' < ');

const whoOf = (obj) => {
  try {
    if (obj && typeof obj.getName === 'function') return obj.getName();
    if (obj && obj.id) return String(obj.id);
    if (obj && obj.device && typeof obj.device.getName === 'function') return obj.device.getName();
  } catch {
    // no name
  }
  return '';
};

class MemProfiler {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this.last = [];
    this.recent = [];
    this.api = [];
    this.fetches = [];
    this.errLines = [];
    this.lp = [];
    this.calls = [];
    this.fine = [];
    this.inflight = new Map();
    this.maxDur = new Map();
    this.counts = { upd: 0, api: 0, fetch: 0 };
  }

  set(key, value) {
    try {
      this.homey.settings.set(key, value);
    } catch (err) {
      this.app.error('[MEM] store failed', key, err.message);
    }
  }

  start() {
    const { settings } = this.homey;
    this.set('memBoots', [...(settings.get('memBoots') || []), new Date().toISOString()].slice(-50));
    const last = settings.get('memLast');
    if (last) {
      this.set('memCrashes', [...(settings.get('memCrashes') || []), { boot: new Date().toISOString(), ...last }].slice(-10));
      settings.unset('memLast');
    }
    const lpRun = settings.get('memLpRun');
    const heavyRun = settings.get('memHeavyRun');
    if (lpRun || heavyRun) {
      this.set('memLeftRunning', [...(settings.get('memLeftRunning') || []), { boot: new Date().toISOString(), lpRun, heavyRun }].slice(-10));
      settings.unset('memLpRun');
      settings.unset('memHeavyRun');
    }
    // Parts on/off for a bisect (app setting memFeatures, all on by default).
    const features = settings.get('memFeatures') || {};
    const on = (k) => features[k] !== false;
    this.on = on;
    this.set('memFeaturesUsed', features);
    try {
      this.rssOk = on('rss') && Number.isFinite(process.resourceUsage().maxRSS);
    } catch {
      this.rssOk = false;
    }
    this.lastCpu = process.cpuUsage();
    this.lastElu = performance.eventLoopUtilization();
    this.lastTm = Date.now();
    this.maxLag = 0;
    if (on('errors')) this.watchErrors();
    if (on('lp')) this.wrapSolver();
    if (on('api') || on('item')) this.wrapHomeyApi();
    if (on('fetch')) this.wrapFetch();
    if (on('errlines')) this.wrapErrorLines();
    if (on('classes')) this.wrapClasses();
    // Test on command: app setting memBurst {n, kb, driver} writes n times a pad of kb KB into the
    // store of the first device of that driver, as fast as possible; log in memBurstLog.
    this.onSettingSet = (key) => {
      if (key === 'memBurst') this.burst(this.homey.settings.get('memBurst')).catch((err) => this.app.error('[MEM] burst', err.message));
    };
    this.homey.settings.on('set', this.onSettingSet);
    if (on('stores')) {
      this.wrapStoreWrites();
      this.storeScanTimer = this.homey.setTimeout(() => this.scanStores(), 3 * 60 * 1000);
    }
    this.schedule();
  }

  stop() {
    if (this.timer) this.homey.clearTimeout(this.timer);
    if (this.storeScanTimer) this.homey.clearTimeout(this.storeScanTimer);
    if (this.onSettingSet) this.homey.settings.removeListener('set', this.onSettingSet);
    if (this.onException) process.removeListener('uncaughtException', this.onException);
    if (this.onRejection) process.removeListener('unhandledRejection', this.onRejection);
    this.timer = null;
  }

  static inPeakWindow(now = new Date()) {
    const m = now.getMinutes();
    const s = now.getSeconds();
    return (m === 59 && s >= 50) || m < 2;
  }

  // Every 2 s; every second around the full hour.
  schedule() {
    const now = new Date();
    const delay = MemProfiler.inPeakWindow(now) || (now.getMinutes() === 59 && now.getSeconds() >= 45) ? 1000 : 5000;
    const due = Date.now() + delay;
    this.timer = this.homey.setTimeout(() => {
      this.maxLag = Math.max(this.maxLag, Date.now() - due);
      try {
        this.sample();
      } catch (err) {
        this.app.error('[MEM] sample failed', err.message);
      }
      this.schedule();
    }, delay);
  }

  sample() {
    const now = Date.now();
    const h = v8.getHeapStatistics();
    const large = (v8.getHeapSpaceStatistics().find((s) => s.space_name === 'large_object_space') || {}).space_used_size || 0;
    const cpu = process.cpuUsage(this.lastCpu);
    const dt = Math.max(1, now - this.lastTm);
    let rss = null;
    if (this.rssOk) {
      try {
        rss = Math.round(process.resourceUsage().maxRSS / 1024);
      } catch {
        this.rssOk = false;
      }
    }
    const s = {
      t: now,
      u: mb(h.used_heap_size),
      tot: mb(h.total_heap_size),
      large: mb(large),
      ext: mb(h.external_memory || 0),
      malloc: mb(h.malloced_memory),
      cpu: Math.round(((cpu.user + cpu.system) / 1000 / dt) * 100),
      lag: this.maxLag,
      rss,
    };
    this.lastCpu = process.cpuUsage();
    this.lastTm = now;
    this.maxLag = 0;
    this.addMinute(s);
    if (MemProfiler.inPeakWindow(new Date(now))) push(this.fine, [iso(now), s.u, s.tot], 400);
    push(this.last, [hms(now), s.u, s.tot, s.ext, s.malloc, s.cpu, s.lag, rss], 30);
    if (this.on('store') && (!this.lastStoreTm || now - this.lastStoreTm >= 4500)) {
      this.lastStoreTm = now;
      this.storeLast(now);
    }
  }

  addMinute(s) {
    const minute = new Date(s.t).toISOString().slice(5, 16);
    if (this.minute && this.minute.m !== minute) this.flush();
    if (!this.minute || this.minute.m !== minute) {
      this.minute = {
        m: minute, u: 0, t: 0, large: 0, cpu: 0, lag: 0, ext: 0, rss: null, lim: mb(v8.getHeapStatistics().heap_size_limit),
      };
      this.counts = { upd: 0, api: 0, fetch: 0 };
    }
    const x = this.minute;
    x.u = Math.max(x.u, s.u);
    x.t = Math.max(x.t, s.tot);
    x.large = Math.max(x.large, s.large);
    x.cpu = Math.max(x.cpu, s.cpu);
    x.lag = Math.max(x.lag, s.lag);
    x.ext = Math.max(x.ext, s.ext);
    if (s.rss !== null) x.rss = s.rss;
  }

  flush() {
    const { settings } = this.homey;
    const x = this.minute;
    const c = this.counts;
    const mins = settings.get('memProfile') || [];
    push(mins, [x.m, x.u, x.t, x.large, x.cpu, x.lag, x.ext, x.rss, c.upd, c.api, c.fetch], 1800);
    this.set('memProfile', mins);
    if (settings.get('memLimit') !== x.lim) this.set('memLimit', x.lim);
    if (this.fine.length) this.set('memFine', this.fine);
    if (this.calls.length) this.set('memCalls', this.calls);
    if (this.api.length) this.set('memApi', this.api);
    if (this.fetches.length) this.set('memFetch', this.fetches);
    if (this.lp.length) this.set('memLp', this.lp);
    if (this.errLines.length) this.set('memErrLines', this.errLines);
    if (this.writes) {
      // [key, writes, bytes written, last size, total ms, max ms, whole store KB] per store key /
      // app setting, most bytes first
      const rows = Object.entries(this.writes).map(([k, w]) => [k, w.n, w.bytes, w.size, w.ms, w.maxMs, w.storeKb])
        .sort((a, b) => b[2] - a[2]).slice(0, 80);
      this.set('memWrites', { since: this.writesSince, rows });
    }
  }

  storeLast(now) {
    this.set('memLast', {
      t: new Date(now).toISOString(),
      // [time, used, total, external, malloced, cpu %, lag ms, maxRSS MB]
      s: this.last,
      // still running: [start, name, who, ms so far]
      run: [...this.inflight.values()].map(([t0, name, who]) => [hms(t0), name, who, now - t0]),
      // ended (>= 20 ms or >= 0.3 MB): [start, name, who, ms, used before, used after]
      c: this.recent,
      api: this.api.slice(-20),
      fetch: this.fetches.slice(-10),
      lp: this.lp.slice(-5),
      err: this.errLines.slice(-20),
    });
  }

  // Our listeners go first: Homey's own one may end the process.
  watchErrors() {
    const keep = (kind, err) => {
      try {
        const errs = this.homey.settings.get('memErrors') || [];
        push(errs, [new Date().toISOString(), kind, String((err && err.stack) || err).slice(0, 2000)], 30);
        this.set('memErrors', errs);
        this.storeLast(Date.now());
      } catch {
        // nothing to do
      }
    };
    const others = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    };
    this.set('memListeners', others);
    // Without other listeners Node would end the process: then still so, after the store.
    this.onException = (err) => {
      keep('exception', err);
      if (others.uncaughtException) return;
      process.removeListener('uncaughtException', this.onException);
      setImmediate(() => {
        throw err;
      });
    };
    this.onRejection = (err) => {
      keep('rejection', err);
      if (others.unhandledRejection) return;
      setImmediate(() => {
        throw err;
      });
    };
    process.prependListener('uncaughtException', this.onException);
    process.prependListener('unhandledRejection', this.onRejection);
  }

  // The function at obj[name], timed: running calls in memLast.run, ended ones in memLast.c, calls
  // in the hour window in memCalls. A call that took >= HEAVY_MS before stores memLast (and
  // memHeavyRun) before it starts: a synchronous one blocks the 2-s sampler.
  wrapFn(obj, name, label) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (!desc || typeof desc.value !== 'function' || !desc.writable || desc.value.memProfiled) return;
    const orig = desc.value;
    if (/^class\b/.test(Function.prototype.toString.call(orig))) return;
    const prof = this;
    const key = `${label}.${name}`;
    const wrapped = function profiled(...args) {
      const t0 = Date.now();
      const m0 = usedMb();
      const who = whoOf(this);
      const id = Symbol(key);
      prof.inflight.set(id, [t0, key, who]);
      const heavy = (prof.maxDur.get(key) || 0) >= HEAVY_MS;
      if (heavy) {
        prof.set('memHeavyRun', [new Date(t0).toISOString(), key, who, prof.maxDur.get(key)]);
        prof.storeLast(t0);
      }
      const done = () => {
        prof.inflight.delete(id);
        const t1 = Date.now();
        const dur = t1 - t0;
        if (dur > (prof.maxDur.get(key) || 0)) prof.maxDur.set(key, dur);
        if (heavy) {
          try {
            prof.homey.settings.unset('memHeavyRun');
          } catch {
            // nothing to do
          }
        }
        const m1 = usedMb();
        if (dur < 20 && Math.abs(m1 - m0) < 0.3) return;
        const rec = [hms(t0), key, who, dur, Number(m0.toFixed(1)), Number(m1.toFixed(1))];
        push(prof.recent, rec, 40);
        if (MemProfiler.inPeakWindow(new Date(t0))) push(prof.calls, [iso(t0), ...rec.slice(1)], 1000);
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
    wrapped.memProfiled = true;
    Object.defineProperty(obj, name, { ...desc, value: wrapped });
  }

  // All own methods (and statics) of the app's classes, up to the Homey SDK classes. Before any
  // device exists: listener references taken later are the wrapped ones.
  wrapClass(Cls, label) {
    if (typeof Cls !== 'function') return;
    const Homey = require('homey');
    const stop = new Set([Homey.App, Homey.Driver, Homey.Device, Object].filter(Boolean).map((c) => c.prototype));
    let proto = Cls.prototype;
    let C = Cls;
    while (proto && !stop.has(proto)) {
      const l = (C && C.name) || label;
      const p = proto;
      const c = C;
      Object.getOwnPropertyNames(p).filter((n) => WRAP.has(n)).forEach((n) => this.wrapFn(p, n, l));
      if (c) Object.getOwnPropertyNames(c).filter((n) => WRAP.has(n)).forEach((n) => this.wrapFn(c, n, l));
      proto = Object.getPrototypeOf(proto);
      C = proto && proto.constructor;
    }
  }

  wrapClasses() {
    try {
      const drivers = (this.homey.manifest.drivers || []).map((d) => d.id);
      drivers.forEach((id) => {
        ['device', 'driver'].forEach((kind) => {
          try {
            this.wrapClass(require(`../../drivers/${id}/${kind}.js`), `${id}.${kind}`);
          } catch (err) {
            this.app.error('[MEM] wrap failed', id, kind, err.message);
          }
        });
      });
      FLOW_MODULES.forEach((m) => this.wrapClass(require(`../flows/${m}`), m));
      this.wrapClass(require('./MigrationNotice'), 'MigrationNotice');
      // The app instance exists already: its own methods on its prototype.
      this.wrapClass(this.app.constructor, 'app');
      this.app.log(`[MEM] classes wrapped (${drivers.length} drivers)`);
    } catch (err) {
      this.app.error('[MEM] wrapClasses failed', err.message);
    }
  }

  // Every LP solve (RoiStrategy): model size, duration, used and total heap before -> after (total
  // grows with the peak inside the synchronous solve). memLpRun is set before and cleared after.
  wrapSolver() {
    const solver = require('javascript-lp-solver');
    if (solver.Solve.memProfiled) return;
    const orig = solver.Solve;
    const prof = this;
    const wrapped = function profiledSolve(model, ...rest) {
      const t0 = Date.now();
      const h0 = v8.getHeapStatistics();
      const vars = Object.keys((model && model.variables) || {}).length;
      const cons = Object.keys((model && model.constraints) || {}).length;
      const where = callerOf(2, 4);
      const entry = [iso(t0), vars, cons, mb(h0.used_heap_size), mb(h0.total_heap_size), where];
      prof.set('memLpRun', entry);
      try {
        return orig.call(this, model, ...rest);
      } finally {
        const h1 = v8.getHeapStatistics();
        push(prof.lp, [...entry.slice(0, 5), Date.now() - t0, mb(h1.used_heap_size), mb(h1.total_heap_size), where], 400);
        try {
          prof.homey.settings.unset('memLpRun');
        } catch {
          // nothing to do
        }
      }
    };
    wrapped.memProfiled = true;
    solver.Solve = wrapped;
  }

  // Every homey-api request (all managers): operation, duration, size of the result (items or
  // values), used heap before -> after, caller. Plus the realtime item updates per minute.
  wrapHomeyApi() {
    try {
      const Manager = require('homey-api/lib/HomeyAPI/HomeyAPIV3/Manager');
      const Item = require('homey-api/lib/HomeyAPI/HomeyAPIV3/Item');
      const prof = this;
      const req = Manager.prototype.__request;
      if (this.on('api') && req && !req.memProfiled) {
        const wrapped = function profiledRequest(opts = {}, ...rest) {
          const t0 = Date.now();
          const m0 = usedMb();
          const op = `${opts.operationId || '?'}${opts.$cache === false || opts.$updateCache === false ? '!' : ''}`;
          const arg = String(opts.id || opts.uri || '').split(':').slice(-2).join(':')
            .slice(0, 50);
          const res = opts.resolution || '';
          const where = callerOf(2, 3);
          const id = Symbol(op);
          prof.inflight.set(id, [t0, `api.${op}`, `${arg} ${res} ${where}`]);
          prof.counts.api += 1;
          const done = (result) => {
            prof.inflight.delete(id);
            let n = null;
            if (result && Array.isArray(result.values)) n = result.values.length;
            else if (Array.isArray(result)) n = result.length;
            else if (result && typeof result === 'object') n = Object.keys(result).length;
            const m1 = usedMb();
            push(prof.api, [iso(t0), op, arg, res, Date.now() - t0, n, Number(m0.toFixed(1)), Number(m1.toFixed(1)), where], 600);
            return result;
          };
          return req.call(this, opts, ...rest).then(done, (err) => {
            done(null);
            throw err;
          });
        };
        wrapped.memProfiled = true;
        Manager.prototype.__request = wrapped;
      }
      const upd = Item.prototype.__update;
      if (this.on('item') && upd && !upd.memProfiled) {
        const wrapped = function countedUpdate(...args) {
          prof.counts.upd += 1;
          return upd.apply(this, args);
        };
        wrapped.memProfiled = true;
        Item.prototype.__update = wrapped;
      }
    } catch (err) {
      this.app.error('[MEM] homey-api wrap failed', err.message);
    }
  }

  wrapFetch() {
    const orig = global.fetch;
    if (typeof orig !== 'function' || orig.memProfiled) return;
    const prof = this;
    const wrapped = function profiledFetch(input, init = {}, ...rest) {
      const t0 = Date.now();
      const m0 = usedMb();
      let url = '';
      try {
        const u = new URL(typeof input === 'string' ? input : input.url);
        url = `${u.host}${u.pathname}`.slice(0, 80);
      } catch {
        url = '?';
      }
      const where = callerOf(2, 3);
      const id = Symbol(url);
      prof.inflight.set(id, [t0, 'fetch', `${url} ${where}`]);
      prof.counts.fetch += 1;
      const done = (res) => {
        prof.inflight.delete(id);
        const len = res && res.headers ? res.headers.get('content-length') : null;
        push(prof.fetches, [iso(t0), url, (init && init.method) || 'GET', res ? res.status : 'ERR', Date.now() - t0, len,
          Number(m0.toFixed(1)), Number(usedMb().toFixed(1)), where], 300);
        return res;
      };
      return orig.call(this, input, init, ...rest).then(done, (err) => {
        done(null);
        throw err;
      });
    };
    wrapped.memProfiled = true;
    global.fetch = wrapped;
  }

  // Every error() line of the app, drivers and devices (the SDK classes' shared method).
  async burst(raw) {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!cfg || !cfg.n) return;
    const device = this.homey.drivers.getDriver(cfg.driver || 'battery').getDevices()[0];
    const log = (msg) => {
      const l = this.homey.settings.get('memBurstLog') || [];
      l.push([new Date().toISOString(), msg]);
      this.set('memBurstLog', l.slice(-40));
    };
    log(`start n ${cfg.n} kb ${cfg.kb} on ${device.getName()} parallel ${!!cfg.parallel}`);
    const pad = (i) => Array.from({ length: Math.round((cfg.kb * 1024) / 20) }, (_, j) => [i, j, 1.5]);
    const t0 = Date.now();
    if (cfg.parallel) {
      await Promise.all(Array.from({ length: cfg.n }, (_, i) => device.setStoreValue(`memBurstPad${i % 4}`, pad(i))));
    } else {
      for (let i = 0; i < cfg.n; i += 1) await device.setStoreValue('memBurstPad0', pad(i));
    }
    log(`done in ${Date.now() - t0} ms, maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
    for (let i = 0; i < 4; i += 1) await device.unsetStoreValue(`memBurstPad${i}`).catch(() => {});
    log('pad removed');
  }

  // Size of every device store key and app setting (JSON characters), once.
  scanStores() {
    try {
      const rows = [];
      Object.values(this.homey.drivers.getDrivers()).forEach((driver) => {
        driver.getDevices().forEach((device) => {
          const store = device.getStore() || {};
          Object.entries(store).forEach(([k, v]) => rows.push([device.getName(), k, JSON.stringify(v === undefined ? null : v).length]));
        });
      });
      const settings = this.homey.settings.getKeys().map((k) => ['(app settings)', k, JSON.stringify(this.homey.settings.get(k)).length]);
      const all = [...rows, ...settings].sort((a, b) => b[2] - a[2]);
      this.set('memStores', { t: new Date().toISOString(), total: all.reduce((a, r) => a + r[2], 0), top: all.slice(0, 60) });
    } catch (err) {
      this.app.error('[MEM] store scan failed', err.message);
    }
  }

  // Writes per device store key (driver id + key) and per app setting: count and bytes. The size is
  // measured on the first write and every 10th after (JSON.stringify of a big value costs too).
  wrapStoreWrites() {
    const Homey = require('homey');
    const prof = this;
    this.writes = {};
    this.writesSince = new Date().toISOString();
    const count = (key, value) => {
      const w = prof.writes[key] || {
        n: 0, bytes: 0, size: 0, ms: 0, maxMs: 0, storeKb: 0,
      };
      if (w.n % 10 === 0) {
        try {
          w.size = JSON.stringify(value === undefined ? null : value).length;
        } catch {
          w.size = -1;
        }
      }
      w.n += 1;
      w.bytes += w.size;
      prof.writes[key] = w;
      return w;
    };
    const proto = Homey.Device && Homey.Device.prototype;
    if (proto && typeof proto.setStoreValue === 'function' && !proto.setStoreValue.memProfiled) {
      const orig = proto.setStoreValue;
      const wrapped = function countedSetStoreValue(key, value, ...rest) {
        let driverId = '';
        try {
          driverId = this.driver.id;
        } catch {
          // no driver
        }
        const k = `${driverId}.${key}`;
        if (String(key).startsWith('mem')) return orig.call(this, key, value, ...rest);
        const w = count(k, value);
        if (w.n % 10 === 1) {
          try {
            w.storeKb = Math.round(JSON.stringify(this.getStore() || {}).length / 1024);
          } catch {
            // no store
          }
        }
        const t0 = Date.now();
        const timed = (res) => {
          const ms = Date.now() - t0;
          w.ms += ms;
          w.maxMs = Math.max(w.maxMs, ms);
          return res;
        };
        return orig.call(this, key, value, ...rest).then(timed, (err) => {
          timed();
          throw err;
        });
      };
      wrapped.memProfiled = true;
      proto.setStoreValue = wrapped;
    }
    const { settings } = this.homey;
    const { set } = settings;
    if (typeof set === 'function' && !set.memProfiled) {
      const wrapped = function countedSet(key, value, ...rest) {
        if (String(key).startsWith('mem')) return set.call(this, key, value, ...rest);
        const w = count(`settings.${key}`, value);
        const t0 = Date.now();
        const res = set.call(this, key, value, ...rest);
        const ms = Date.now() - t0;
        w.ms += ms;
        w.maxMs = Math.max(w.maxMs, ms);
        return res;
      };
      wrapped.memProfiled = true;
      settings.set = wrapped;
    }
  }

  wrapErrorLines() {
    try {
      const Homey = require('homey');
      const prof = this;
      [Homey.App, Homey.Driver, Homey.Device].forEach((Cls) => {
        let proto = Cls && Cls.prototype;
        while (proto && !Object.prototype.hasOwnProperty.call(proto, 'error')) proto = Object.getPrototypeOf(proto);
        if (!proto || proto.error.memProfiled) return;
        const orig = proto.error;
        const wrapped = function profiledError(...args) {
          try {
            const text = args.map((a) => (a && a.message ? a.message : String(a))).join(' ').slice(0, 300);
            push(prof.errLines, [iso(Date.now()), whoOf(this), text], 100);
          } catch {
            // nothing to do
          }
          return orig.apply(this, args);
        };
        wrapped.memProfiled = true;
        proto.error = wrapped;
      });
    } catch (err) {
      this.app.error('[MEM] error wrap failed', err.message);
    }
  }
}

module.exports = MemProfiler;
