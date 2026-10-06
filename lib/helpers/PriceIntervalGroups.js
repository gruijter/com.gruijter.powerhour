/* eslint-disable max-len */

'use strict';

// Price interval (15 or 60 minutes) of a tariff broadcast group. A group can have several sources
// (a dap and a dap15 on the same group number, or a flow): last-write-wins flipped the interval
// on every broadcast and dropped quarterly updates. Per group the latest declaration of each
// source is kept, and the FINEST interval wins. A source that declares nothing does not vote.

const FALLBACK_INTERVAL = 60;

// A source silent this long stops voting (moved or deleted). Longer than two missed hourly rounds.
const STALE_MS = 3 * 60 * 60 * 1000;

// One broadcast reaches resolve() once per listening driver (5x): dedupe the notification.
// Far shorter than the shortest real broadcast gap (15 minutes).
const NOTIFY_DEDUPE_MS = 30 * 1000;

// Used only when homey.app is not reachable yet - see forApp().
let fallbackInstance = null;

class PriceIntervalGroups {

  constructor(homey) {
    this.homey = homey;
    this.groups = {};
    this.lastNotified = {};
  }

  // Lazy per-app singleton (a driver's onInit() can run before the app's). homey.app is reached
  // defensively: this is on the path of every tariff broadcast. Without it a module-level instance
  // is used and adopted later.
  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch {
      // app not attached yet
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new PriceIntervalGroups(homey);
      return fallbackInstance;
    }
    if (!app.priceIntervalGroups) app.priceIntervalGroups = fallbackInstance || new PriceIntervalGroups(homey);
    return app.priceIntervalGroups;
  }

  // Never a precondition for the broadcast: on any failure the caller still gets an interval.
  static async applyFor(homey, args) {
    try {
      return await this.forApp(homey).apply(args);
    } catch (error) {
      const declared = Number(args && args.interval);
      try {
        homey.app.error('Price interval group resolution failed:', error);
      } catch {
        // app not reachable - nothing sensible left to do
      }
      return Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_INTERVAL;
    }
  }

  // Records what one source declares for a group; returns the group's effective interval.
  // `interval` null/undefined is not 60: a flow's "Set Tariff" card has none, and inherits.
  // Keyed per `channel` (power/gas/water) too: group numbers are independent per commodity.
  // Returns { interval, conflict, detail }.
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
    Object.keys(sources).forEach((id) => {
      if ((now - sources[id].lastSeen) > STALE_MS) delete sources[id];
    });

    const live = Object.values(sources);
    if (!live.length) return { interval: FALLBACK_INTERVAL, conflict: false, detail: null };

    const distinct = [...new Set(live.map((s) => s.interval))].sort((a, b) => a - b);
    const detail = live
      .slice()
      .sort((a, b) => (a.interval - b.interval) || a.name.localeCompare(b.name))
      .map((s) => `${s.name} (${s.interval}m)`)
      .join(', ');

    return { interval: distinct[0], conflict: distinct.length > 1, detail };
  }

  // Timeline notification on every detection (deduped per broadcast, NOTIFY_DEDUPE_MS).
  async notifyConflict({
    channel, group, detail, interval, now = Date.now(),
  }) {
    const key = `${channel}|${group}|${detail}|${interval}`;
    if (this.lastNotified[key] && (now - this.lastNotified[key]) < NOTIFY_DEDUPE_MS) return;
    this.lastNotified[key] = now;
    // Inside the guard: this may never fail a tariff broadcast.
    try {
      const excerpt = this.homey.__('tariff_group_interval_conflict', {
        group: String(group),
        sources: detail,
        interval: String(interval),
      });
      await this.homey.notifications.createNotification({ excerpt });
    } catch (error) {
      try {
        this.homey.app.error('Failed to create price interval conflict notification:', error);
      } catch {
        // app not reachable - nothing sensible left to do
      }
    }
  }

  // resolve() + notifyConflict(). Returns the effective interval for the group.
  async apply(args) {
    const { interval, conflict, detail } = this.resolve(args);
    if (conflict) {
      await this.notifyConflict({
        channel: args.channel, group: args.group, detail, interval,
      });
    }
    return interval;
  }

}

module.exports = PriceIntervalGroups;
