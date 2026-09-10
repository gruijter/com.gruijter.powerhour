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

// Used only when homey.app is not reachable yet - see forApp().
let fallbackInstance = null;

class PriceIntervalGroups {

  constructor(homey) {
    this.homey = homey;
    this.groups = {};
    this.lastNotified = {};
  }

  // Lazy per-app singleton. Deliberately not created in app.js onInit(): a driver's onInit() can
  // run before the app's has finished, and a resolve() call landing in that window would have to
  // fall back to the old last-write-wins behaviour. Attaching on first use removes that race.
  //
  // `homey.app` is reached defensively: the rest of this codebase try/catches it (see
  // generic_dap_device.js's onPricesUpdated() and generic_bat_driver.js's onPairListDevices()),
  // and this now sits on the critical path of every tariff broadcast - a throw here must not cost
  // a group its tariff write. When the app instance is not reachable yet, fall back to a
  // module-level instance so resolving still works; it is adopted by the app on the next call.
  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch (e) {
      // app not attached yet - fall through to the module-level instance
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new PriceIntervalGroups(homey);
      return fallbackInstance;
    }
    if (!app.priceIntervalGroups) app.priceIntervalGroups = fallbackInstance || new PriceIntervalGroups(homey);
    return app.priceIntervalGroups;
  }

  // resolve() + notifyConflict(), with every failure contained. Interval resolution is an
  // optimisation on top of the broadcast, never a preconditon for it: if anything in here throws,
  // the caller still gets a usable interval and the tariff write goes ahead.
  static async applyFor(homey, args) {
    try {
      return await this.forApp(homey).apply(args);
    } catch (error) {
      const declared = Number(args && args.interval);
      try {
        homey.app.error('Price interval group resolution failed:', error);
      } catch (e) {
        // app not reachable - nothing sensible left to do
      }
      return Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_INTERVAL;
    }
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
  // `channel` is the broadcast event a source declares on ('set_tariff_power_PBTH',
  // '..._gas_PBTH', '..._water_PBTH'). It is part of the registry key because `tariff_update_group`
  // is an independent 0-10 number PER COMMODITY: a gas dapg and an electricity dap15 both left on
  // group 1 are a perfectly normal setup, not a conflict, and they never shared state before this
  // module existed (priceIntervals lived on each Driver instance). Keying on the group alone would
  // merge them - resolving gas to the electricity source's 15, which generic_sum_device.js persists
  // to the device store, and firing a Timeline warning about a conflict the user cannot act on.
  // Everything listening on one channel DOES share a registry, which is what we want: power, grid
  // and solar (generic_sum_driver) plus battery and evCharger (generic_bat_driver) all consume
  // set_tariff_power_PBTH and must agree on the group's interval.
  //
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

  // Timeline notification, fired on every detection (deduped only across the single-event
  // fan-out described at NOTIFY_DEDUPE_MS). createNotification({ excerpt }) verified against
  // @types/homey/manager/notifications.d.ts; that it lands in the Timeline feed was confirmed on
  // a real device - see the note in drivers/solar/device.js.
  async notifyConflict({
    channel, group, detail, interval, now = Date.now(),
  }) {
    const key = `${channel}|${group}|${detail}|${interval}`;
    if (this.lastNotified[key] && (now - this.lastNotified[key]) < NOTIFY_DEDUPE_MS) return;
    this.lastNotified[key] = now;
    // The __() lookup is inside the guard on purpose: this notification annotates a tariff
    // broadcast, it must never be able to fail one. apply() is awaited before the group's
    // interval is assigned and before either driver's device loop, so a throw escaping here
    // would cost every device in the group its tariff for that period.
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
      } catch (e) {
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
