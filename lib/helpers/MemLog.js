'use strict';

// Memory log, only on a Homey where app setting memLog exists (set by hand; unset to stop):
// memLog = { limit, boots[], rows[], spikes[], crashes[] }.
// row = [UTC MM-DDTHH:MM, heapUsedMax MB, heapTotalMax MB, maxRSS MB (high-water), cpu %, lagMs max,
//        maxRSS MB, V8 external MB, V8 malloced MB (now)]
// Sampled every 10 s, one row per 15 min (last 300). An extra boot without an install = restart/crash.
// boot = [UTC ISO, last sample of the run before]: the last sample is written to a file every 10 s.
// last sample = [UTC MM-DDTHH:MM:SS, heapUsed, heapTotal, maxRSS, external, malloced MB, lagMs]
// spike = [UTC MM-DDTHH:MM:SS, heapUsed MB before, after]: a rise of over SPIKE_MB in one sample (last 100).
// crash = [UTC ISO, crashedCount before, after, marker of the work then running] (CrashNotice).

const fs = require('fs');
const crypto = require('crypto');
const v8 = require('v8');

const SAMPLE_MS = 10 * 1000;
const ROW_MS = 15 * 60 * 1000;
const MAX_ROWS = 300;
const SPIKE_MB = 2;
const MAX_SPIKES = 100;
const MAX_CRASHES = 50;
const FILE_KEY = 'memLogFile';
const MB = 1024 * 1024;

const round1 = (v) => Math.round(v * 10) / 10;
const stamp = (d = new Date(), len = 16) => d.toISOString().slice(5, len);

class MemLog {

  constructor(app) {
    this.app = app;
    this.homey = app.homey;
  }

  start() {
    const log = this.homey.settings.get('memLog');
    if (!log) return;
    this.data = {
      limit: round1(v8.getHeapStatistics().heap_size_limit / MB),
      boots: [...(log.boots || []), [new Date().toISOString(), this.readLast()]].slice(-50),
      rows: log.rows || [],
      spikes: log.spikes || [],
      crashes: log.crashes || [],
    };
    this.resetWindow();
    try {
      this.lastCpu = process.cpuUsage();
    } catch { /* not in this sandbox */ }
    this.lastCpuTm = Date.now();
    this.writeRow(); // boot row

    this.expected = Date.now() + SAMPLE_MS;
    this.sampleId = this.homey.setInterval(() => this.sample(), SAMPLE_MS);
    this.rowId = this.homey.setInterval(() => this.writeRow(), ROW_MS);
  }

  stop() {
    if (this.sampleId) this.homey.clearInterval(this.sampleId);
    if (this.rowId) this.homey.clearInterval(this.rowId);
  }

  lastPath() {
    if (this.path) return this.path;
    let id = this.homey.settings.get(FILE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      this.homey.settings.set(FILE_KEY, id);
    }
    this.path = `/userdata/${id}.json`;
    return this.path;
  }

  readLast() {
    try {
      return JSON.parse(fs.readFileSync(this.lastPath(), 'utf8'));
    } catch {
      return null;
    }
  }

  // maxRSS (high-water), V8 external and malloced MB (process.memoryUsage() is not in the sandbox).
  static processMem() {
    const h = v8.getHeapStatistics();
    let rss = null;
    try {
      rss = Math.round(process.resourceUsage().maxRSS / 1024);
    } catch { /* not in this sandbox */ }
    const ext = typeof h.external_memory === 'number' ? round1(h.external_memory / MB) : null;
    return [rss, ext, round1(h.malloced_memory / MB)];
  }

  // From CrashNotice: a crash before this start.
  noteCrash(before, after, busy) {
    if (!this.data) return;
    this.data.crashes = [...this.data.crashes, [new Date().toISOString(), before, after, busy || null]].slice(-MAX_CRASHES);
    try {
      this.homey.settings.set('memLog', this.data);
    } catch (err) {
      this.app.log('[MemLog]', err && err.message);
    }
  }

  resetWindow() {
    this.heapMax = 0;
    this.totalMax = 0;
    this.lagMax = 0;
  }

  sample() {
    const now = Date.now();
    const lag = Math.max(0, now - this.expected);
    this.lagMax = Math.max(this.lagMax, lag);
    this.expected = now + SAMPLE_MS;
    const used = this.sampleHeap();
    try {
      const h = v8.getHeapStatistics();
      const last = [stamp(new Date(now), 19), round1(used), round1(h.total_heap_size / MB), ...MemLog.processMem(), lag];
      fs.writeFileSync(this.lastPath(), JSON.stringify(last));
    } catch { /* next sample */ }
    if (this.lastUsed && used - this.lastUsed > SPIKE_MB) {
      this.data.spikes = [...this.data.spikes, [stamp(new Date(now), 19), round1(this.lastUsed), round1(used)]].slice(-MAX_SPIKES);
    }
    this.lastUsed = used;
  }

  sampleHeap() {
    const h = v8.getHeapStatistics();
    this.heapMax = Math.max(this.heapMax, h.used_heap_size / MB);
    this.totalMax = Math.max(this.totalMax, h.total_heap_size / MB);
    return h.used_heap_size / MB;
  }

  writeRow() {
    try {
      this.sampleHeap();
      const now = Date.now();
      let cpuPct = null;
      let rss = null;
      try {
        const cpu = process.cpuUsage(this.lastCpu);
        cpuPct = Math.round(((cpu.user + cpu.system) / 1000 / Math.max(1, now - this.lastCpuTm)) * 100);
        this.lastCpu = process.cpuUsage();
        this.lastCpuTm = now;
      } catch { /* not in this sandbox */ }
      try {
        rss = Math.round(process.resourceUsage().maxRSS / 1024);
      } catch { /* not in this sandbox */ }
      const row = [stamp(), round1(this.heapMax), round1(this.totalMax), rss, cpuPct, Math.max(0, Math.round(this.lagMax)), ...MemLog.processMem()];
      this.data.rows = [...this.data.rows, row].slice(-MAX_ROWS);
      this.homey.settings.set('memLog', this.data);
      this.resetWindow();
    } catch (err) {
      this.app.log('[MemLog]', err && err.message);
    }
  }

}

module.exports = MemLog;
