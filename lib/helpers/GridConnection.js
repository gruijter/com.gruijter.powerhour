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

// The home's grid connection rating (set on the grid device) and the power plausibility ceiling
// derived from it, for the drivers without such a setting.

// 3x25A @ 230V, the grid driver's default. Used without a (usable) grid device.
const DEFAULT_PHASES = 3;
const DEFAULT_AMPS = 25;
const DEFAULT_VOLTAGE = 230;
const DEFAULT_LIMIT_W = DEFAULT_PHASES * DEFAULT_AMPS * DEFAULT_VOLTAGE; // 17250 W

// How far past the rating a reading is still plausible, for home load (solar and battery add to
// the import) and grid exchange. A sanity bound only: never for load balancing or safety, which
// need limitFromSettings()/limitW().
const PLAUSIBILITY_FACTOR = 2;

// Several grid devices is a configuration mistake checked on every poll: notify every few hours.
const NOTIFY_DEDUPE_MS = 6 * 60 * 60 * 1000;

// Used only when homey.app is not reachable yet - see forApp().
let fallbackInstance = null;

class GridConnection {

  constructor(homey) {
    this.homey = homey;
    this.lastNotified = null;
  }

  // Lazy per-app singleton, as PriceIntervalGroups.forApp().
  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch {
      // app not attached yet
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new GridConnection(homey);
      return fallbackInstance;
    }
    if (!app.gridConnection) app.gridConnection = fallbackInstance || new GridConnection(homey);
    return app.gridConnection;
  }

  // phases x fuse rating x phase voltage; the default on unusable settings (0 would discard all data).
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

  // Every grid device's rating: { limitW, count, detail }; count 0: none paired, the default.
  // Several: the LARGEST wins (the permissive choice for plausibility filters).
  resolve() {
    let devices = [];
    try {
      const driver = this.homey.drivers.getDriver('grid');
      if (driver) devices = driver.getDevices() || [];
    } catch {
      // driver not loaded (no grid devices)
    }

    const found = [];
    devices.forEach((device) => {
      try {
        found.push({ name: device.getName(), limitW: GridConnection.limitFromSettings(device.getSettings()) });
      } catch {
        // a device still initialising does not contribute
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

  // Timeline notification, as PriceIntervalGroups.notifyConflict().
  async notifyMultiple({ detail, limitW, now = Date.now() }) {
    if (this.lastNotified && (now - this.lastNotified) < NOTIFY_DEDUPE_MS) return;
    this.lastNotified = now;
    // Contained: must never fail the plausibility check on a polling path.
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
        // app not reachable
      }
    }
  }

  async apply() {
    const { limitW, count, detail } = this.resolve();
    if (count > 1) await this.notifyMultiple({ detail, limitW });
    else this.lastNotified = null; // conflict gone: a recurrence warns immediately
    return limitW;
  }

  // The real connection rating (W), for anything that needs the physical limit.
  static async limitW(homey) {
    try {
      return await GridConnection.forApp(homey).apply();
    } catch {
      return DEFAULT_LIMIT_W;
    }
  }

  // The plausibility ceiling (PLAUSIBILITY_FACTOR), for filtering power; never a safety limit.
  static async ceilingW(homey) {
    return (await GridConnection.limitW(homey)) * PLAUSIBILITY_FACTOR;
  }

}

module.exports = GridConnection;
