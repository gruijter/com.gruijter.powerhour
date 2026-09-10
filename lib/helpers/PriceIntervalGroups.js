/* eslint-disable max-len */

'use strict';

// Resolves the price interval (15 or 60 minutes) that applies to a tariff broadcast group.
//
// A group can be fed by more than one source. Every DAP driver exposes `tariff_update_group` as
// a plain 0-10 number (dap, dap15 and dapg all use the identical setting definition), so nothing
// stops a 60-minute `dap` device and a 15-minute `dap15` device from being given the same group
// number - and a flow's "Set Tariff" action card can target any group as well.
//
// Both consuming drivers used to do `priceIntervals[group] = args.priceInterval || 60`, i.e.
// last-write-wins per group. With a 15- and a 60-minute source sharing a group that flips the
// group's interval on every broadcast, and each consuming device copies the value straight onto
// this.priceInterval and persists it to its store. Two user-visible effects:
//  - generic_bat_device.js's updatePrices() re-renders on `intervalChanged`, so the strategy
//    chart alternates between a 15- and a 60-minute view by itself;
//  - generic_bat_driver.js's every15m listener (`device.priceInterval === 15`) and
//    generic_sum_driver.js's handleBoundaryUpdate() (`isQuarterly && interval === 60`) skip the
//    quarterly update whenever the value happens to sit at 60, so 15-minute updates drop out
//    intermittently. That part is not merely cosmetic.
//
// This module keeps, per group, what each SOURCE most recently declared, and resolves the group
// to the FINEST (smallest) declared interval. A source that declares nothing does not vote and
// never counts as a conflict - see resolve() for why that distinction matters.

const FALLBACK_INTERVAL = 60;

// A source that has gone quiet for this long stops voting on its group. Without it, moving a
// dap15 device to another group (or deleting it) would leave a stale 15 pinned on the old group
// forever. Three hours is comfortably longer than any normal broadcast gap: a 60-minute dap
// device broadcasts hourly, so two missed rounds still don't drop its vote.
const STALE_MS = 3 * 60 * 60 * 1000;

// One homey.emit('set_tariff_power_PBTH') fans out to EVERY driver listening on that event -
// power, grid and solar via generic_sum_driver, battery and evCharger via generic_bat_driver -
// so a single conflicting broadcast reaches resolve() five times within milliseconds. Without
// this window one event would produce five identical Timeline notifications. It is deliberately
// far shorter than the shortest real broadcast gap (15 minutes), so every genuine detection
// still gets its own notification.
const NOTIFY_DEDUPE_MS = 30 * 1000;

class PriceIntervalGroups {

  constructor(homey) {
    this.homey = homey;
    this.groups = {};
    this.lastNotified = {};
  }

  // Lazy per-app singleton. Deliberately not created in app.js onInit(): a driver's onInit() can
  // run before the app's has finished, and a resolve() call landing in that window would have to
  // fall back to the old last-write-wins behaviour. Attaching on first use removes that race.
  static forApp(homey) {
    const { app } = homey;
    if (!app.priceIntervalGroups) app.priceIntervalGroups = new PriceIntervalGroups(homey);
    return app.priceIntervalGroups;
  }

  // Records what one source declares for a group, and returns the group's effective interval.
  //
  // `interval` may be null/undefined, and that is NOT the same as 60. A flow's "Set Tariff"
  // action card carries no priceInterval at all (Flows.js passes the card's args straight
  // through), so the old `args.priceInterval || 60` turned "unknown" into an explicit vote for
  // 60 - which is very likely the most common way a dap15's 15 got clobbered, since it only
  // takes one flow on the same group. A non-declaring source now simply inherits whatever the
  // group already resolved to.
  //
  // Returns { interval, conflict, detail }.
  resolve({
    group, sourceId, sourceName, interval, now = Date.now(),
  }) {
    const key = String(group);
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

  // Timeline notification, fired on every detection (deduped only across the single-event
  // fan-out described at NOTIFY_DEDUPE_MS). createNotification({ excerpt }) verified against
  // @types/homey/manager/notifications.d.ts; that it lands in the Timeline feed was confirmed on
  // a real device - see the note in drivers/solar/device.js.
  async notifyConflict({
    group, detail, interval, now = Date.now(),
  }) {
    const key = `${group}|${detail}|${interval}`;
    if (this.lastNotified[key] && (now - this.lastNotified[key]) < NOTIFY_DEDUPE_MS) return;
    this.lastNotified[key] = now;
    const excerpt = this.homey.__('tariff_group_interval_conflict', {
      group: String(group),
      sources: detail,
      interval: String(interval),
    });
    try {
      await this.homey.notifications.createNotification({ excerpt });
    } catch (error) {
      try {
        this.homey.app.error('Failed to create price interval conflict notification:', error);
      } catch (e) {
        // app not reachable - nothing sensible left to do
      }
    }
  }

  // resolve() + notifyConflict(). Returns the effective interval for the group.
  async apply(args) {
    const { interval, conflict, detail } = this.resolve(args);
    if (conflict) await this.notifyConflict({ group: args.group, detail, interval });
    return interval;
  }

}

module.exports = PriceIntervalGroups;
