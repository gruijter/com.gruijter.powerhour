'use strict';

// Memory log, only on a Homey where app setting memLog exists (set by hand; unset to stop):
// memLog = { limit, boots[], rows[], spikes[] }.
// row = [UTC MM-DDTHH:MM, heapUsedMax MB, heapTotalMax MB, maxRSS MB (high-water), cpu %, lagMs max]
// Sampled every 10 s, one row per 15 min (last 300). An extra boot without an install = restart/crash.
// spike = [UTC MM-DDTHH:MM:SS, heapUsed MB before, after]: a rise of over SPIKE_MB in one sample (last 100).

const v8 = require('v8');

const SAMPLE_MS = 10 * 1000;
const ROW_MS = 15 * 60 * 1000;
const MAX_ROWS = 300;
const SPIKE_MB = 2;
const MAX_SPIKES = 100;
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
      boots: [...(log.boots || []), new Date().toISOString()].slice(-50),
      rows: log.rows || [],
      spikes: log.spikes || [],
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

  resetWindow() {
    this.heapMax = 0;
    this.totalMax = 0;
    this.lagMax = 0;
  }

  sample() {
    const now = Date.now();
    this.lagMax = Math.max(this.lagMax, now - this.expected);
    this.expected = now + SAMPLE_MS;
    const used = this.sampleHeap();
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
      const row = [stamp(), round1(this.heapMax), round1(this.totalMax), rss, cpuPct, Math.max(0, Math.round(this.lagMax))];
      this.data.rows = [...this.data.rows, row].slice(-MAX_ROWS);
      this.homey.settings.set('memLog', this.data);
      this.resetWindow();
    } catch (err) {
      this.app.log('[MemLog]', err && err.message);
    }
  }

}

module.exports = MemLog;
