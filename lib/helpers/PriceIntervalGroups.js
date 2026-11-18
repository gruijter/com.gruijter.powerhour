/* eslint-disable max-len */

'use strict';

const PriceDrivers = require('./PriceDrivers');
const SetupNotice = require('./SetupNotice');

const FALLBACK_INTERVAL = 60;

const STALE_MS = 3 * 60 * 60 * 1000;

let fallbackInstance = null;

class PriceIntervalGroups {

  constructor(homey) {
    this.homey = homey;
    this.groups = {};
  }

  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch {
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new PriceIntervalGroups(homey);
      return fallbackInstance;
    }
    if (!app.priceIntervalGroups) app.priceIntervalGroups = fallbackInstance || new PriceIntervalGroups(homey);
    return app.priceIntervalGroups;
  }

  static async applyFor(homey, args) {
    try {
      return await this.forApp(homey).apply(args);
    } catch (error) {
      const declared = Number(args && args.interval);
      try {
        homey.app.error('Price interval group resolution failed:', error);
      } catch {
      }
      return Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_INTERVAL;
    }
  }

  resolve({
    channel, group, sourceId, sourceName, interval, now = Date.now(),
  }) {
    const key = `${channel || 'set_tariff_power_PBTH'}|${String(group)}`;
    const sources = this.groups[key] || (this.groups[key] = {});

    const declared = Number(interval);
    if (sourceId && Number.isFinite(declared) && declared > 0) {
      sources[String(sourceId)] = {
        interval: declared,
        name: sourceName || String(sourceId),
        lastSeen: now,
      };
    }
    const moved = this.movedSources(channel, group);
    Object.keys(sources).forEach((id) => {
      if ((now - sources[id].lastSeen) > STALE_MS || moved.has(id)) delete sources[id];
    });

    const live = Object.values(sources);
    if (!live.length) return { interval: FALLBACK_INTERVAL, conflict: false, detail: null };

    const distinct = [...new Set(live.map((s) => s.interval))].sort((a, b) => a - b);
    const detail = live
      .slice()
      .sort((a, b) => (a.interval - b.interval) || a.name.localeCompare(b.name))
      .map((s) => s.name)
      .join(', ');

    return { interval: distinct[0], conflict: live.length > 1, detail };
  }

  movedSources(channel, group) {
    const out = new Set();
    try {
      const commodity = String(channel || '').replace(/^set_tariff_/, '').replace(/_PBTH$/, '') || 'power';
      PriceDrivers.getDevices(this.homey).forEach((d) => {
        const sending = PriceDrivers.commodityOf(d.driver.id, d.getSettings()) === commodity
          && String(d.getSettings().tariff_update_group) === String(group);
        if (!sending) out.add(String(d.getData().id));
      });
    } catch {
    }
    return out;
  }

  notifyConflict({
    channel, group, detail, now = Date.now(),
  }) {
    const excerpt = this.homey.__('tariff_group_conflict', { group: String(group), sources: detail });
    return SetupNotice.notify(this.homey, `tariff|${channel}|${group}`, detail, excerpt, now);
  }

  async apply(args) {
    const { interval, conflict, detail } = this.resolve(args);
    if (conflict) {
      await this.notifyConflict({
        channel: args.channel, group: args.group, detail, now: args.now,
      });
    } else SetupNotice.clear(this.homey, `tariff|${args.channel}|${args.group}`);
    return interval;
  }

}

module.exports = PriceIntervalGroups;
