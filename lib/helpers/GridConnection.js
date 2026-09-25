/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

// The home's physical grid connection rating, and the power plausibility ceiling derived from it.
//
// The rating is configured on the GRID device ('connectionPhases'/'connectionAmps'/
// 'connectionVoltage', see drivers/grid/driver.compose.json). Other drivers have no such setting
// of their own and used to hardcode a flat 30000 W instead - roughly right for the 3x25A default,
// silently lossy above it, and far too permissive below it. They resolve it from the grid device
// through this module rather than each growing a parallel copy of the setting.

// 3x25A @ 230V, the standard Dutch domestic connection and the grid driver's compose-defined
// default. Used when no grid device is paired, or when one has unusable settings.
const DEFAULT_PHASES = 3;
const DEFAULT_AMPS = 25;
const DEFAULT_VOLTAGE = 230;
const DEFAULT_LIMIT_W = DEFAULT_PHASES * DEFAULT_AMPS * DEFAULT_VOLTAGE; // 17250 W

// How far past the connection rating a power reading is still considered plausible. Used for two
// related-but-distinct quantities, deliberately sharing one number rather than splitting into two
// tunables that would drift apart:
//  - reconstructed HOME load, which can legitimately exceed the connection because solar
//    production and battery discharge feed the house on top of whatever is imported;
//  - GRID exchange, which physically cannot exceed the connection for long but can overshoot it
//    briefly before a fuse trips, and will read high for anyone who configured the wrong fuse size.
// In both cases this is a sanity bound whose only job is rejecting absurd values. It is NOT a
// physical constraint and must never be used as one - notably not for load balancing or any
// safety decision, which need the real rating from limitFromSettings()/limitW().
const PLAUSIBILITY_FACTOR = 2;

// Two or more grid devices is a static configuration mistake, not an event: the check below runs
// on every energy poll (the battery driver polls every 5 s), so this dedupe window is hours rather
// than the 30 s used by PriceIntervalGroups, whose notification annotates a per-broadcast event.
// The marker is cleared as soon as the conflict resolves, so a recurrence still warns promptly.
const NOTIFY_DEDUPE_MS = 6 * 60 * 60 * 1000;

// Used only when homey.app is not reachable yet - see forApp().
let fallbackInstance = null;

class GridConnection {

  constructor(homey) {
    this.homey = homey;
    this.lastNotified = null;
  }

  // Lazy per-app singleton, same reasoning as PriceIntervalGroups.forApp(): a driver's onInit()
  // can run before the app's has finished, and reaching homey.app must never throw on a path that
  // only computes a plausibility bound.
  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch {
      // app not attached yet - fall through to the module-level instance
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new GridConnection(homey);
      return fallbackInstance;
    }
    if (!app.gridConnection) app.gridConnection = fallbackInstance || new GridConnection(homey);
    return app.gridConnection;
  }

  // phases x fuse rating x nominal phase voltage. Falls back to the 3x25A default rather than to
  // 0 on unusable settings - a 0 limit would collapse every ceiling derived from it and silently
  // discard all data. Exported so the grid device can apply the identical math to its OWN
  // settings without going through the multi-device resolution below.
  static limitFromSettings(settings) {
    if (!settings) return DEFAULT_LIMIT_W;
    const phases = Number(settings.connectionPhases) === 1 ? 1 : DEFAULT_PHASES;
    const amps = Number(settings.connectionAmps);
    const volts = Number(settings.connectionVoltage);
    if (!(amps > 0) || !(volts > 0)) return DEFAULT_LIMIT_W;
    return phases * amps * volts;
  }

  static get DEFAULT_LIMIT_W() {
    return DEFAULT_LIMIT_W;
  }

  static get PLAUSIBILITY_FACTOR() {
    return PLAUSIBILITY_FACTOR;
  }

  // Every paired grid device's configured rating. Returns { limitW, count, detail }; count 0 means
  // no grid device is paired and limitW is the default.
  //
  // With more than one grid device the LARGEST rating wins. The consumers of this value are
  // plausibility filters, so the permissive choice is the non-destructive one: it keeps real
  // readings from a genuinely larger connection instead of silently discarding them for as long as
  // the misconfiguration lasts. The user is told about it separately (see notifyMultiple()).
  resolve() {
    let devices = [];
    try {
      const driver = this.homey.drivers.getDriver('grid');
      if (driver) devices = driver.getDevices() || [];
    } catch {
      // driver not loaded (no grid devices paired) - same guard as Util.getGridPowerFallback()
    }

    const found = [];
    devices.forEach((device) => {
      try {
        found.push({ name: device.getName(), limitW: GridConnection.limitFromSettings(device.getSettings()) });
      } catch {
        // a device still initialising has no usable settings yet - it simply doesn't contribute
      }
    });

    const usable = found.filter((f) => Number.isFinite(f.limitW) && f.limitW > 0);
    if (!usable.length) return { limitW: DEFAULT_LIMIT_W, count: 0, detail: null };

    const detail = usable
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.name} (${Math.round(f.limitW)} W)`)
      .join(', ');

    return {
      limitW: Math.max(...usable.map((f) => f.limitW)),
      count: usable.length,
      detail,
    };
  }

  // Timeline notification, modelled on PriceIntervalGroups.notifyConflict(). createNotification({
  // excerpt }) is what lands in the Timeline feed - see the note there.
  async notifyMultiple({ detail, limitW, now = Date.now() }) {
    if (this.lastNotified && (now - this.lastNotified) < NOTIFY_DEDUPE_MS) return;
    this.lastNotified = now;
    // Contained exactly like the price-interval one: this annotates a plausibility check that
    // sits on a polling hot path, and must never be able to fail it.
    try {
      const excerpt = this.homey.__('grid_connection_multiple_devices', {
        devices: detail,
        limit: String(Math.round(limitW)),
      });
      await this.homey.notifications.createNotification({ excerpt });
    } catch (error) {
      try {
        this.homey.app.error('Failed to create multiple grid device notification:', error);
      } catch {
        // app not reachable - nothing sensible left to do
      }
    }
  }

  async apply() {
    const { limitW, count, detail } = this.resolve();
    if (count > 1) await this.notifyMultiple({ detail, limitW });
    else this.lastNotified = null; // conflict gone - let a recurrence warn immediately
    return limitW;
  }

  // The real connection rating in Watt, resolved from the paired grid device(s). Use this for
  // anything that needs the physical limit.
  static async limitW(homey) {
    try {
      return await GridConnection.forApp(homey).apply();
    } catch {
      return DEFAULT_LIMIT_W;
    }
  }

  // The plausibility ceiling - see PLAUSIBILITY_FACTOR. Use this for filtering/clamping measured
  // or reconstructed power, never as a safety limit.
  static async ceilingW(homey) {
    return (await GridConnection.limitW(homey)) * PLAUSIBILITY_FACTOR;
  }

}

module.exports = GridConnection;
