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

const SetupNotice = require('./SetupNotice');

const DEFAULT_PHASES = 3;
const DEFAULT_AMPS = 25;
const DEFAULT_VOLTAGE = 230;
const DEFAULT_LIMIT_W = DEFAULT_PHASES * DEFAULT_AMPS * DEFAULT_VOLTAGE;

const PLAUSIBILITY_FACTOR = 2;

let fallbackInstance = null;

class GridConnection {

  constructor(homey) {
    this.homey = homey;
  }

  static forApp(homey) {
    let app = null;
    try {
      app = homey.app;
    } catch {
    }
    if (!app) {
      if (!fallbackInstance) fallbackInstance = new GridConnection(homey);
      return fallbackInstance;
    }
    if (!app.gridConnection) app.gridConnection = fallbackInstance || new GridConnection(homey);
    return app.gridConnection;
  }

  static limitFromSettings(settings) {
    const phaseW = GridConnection.phaseLimitFromSettings(settings);
    if (!phaseW) return DEFAULT_LIMIT_W;
    return (Number(settings.connectionPhases) === 1 ? 1 : DEFAULT_PHASES) * phaseW;
  }

  static phaseLimitFromSettings(settings) {
    const amps = Number(settings && settings.connectionAmps);
    const volts = Number(settings && settings.connectionVoltage);
    return amps > 0 && volts > 0 ? amps * volts : null;
  }

  static get DEFAULT_LIMIT_W() {
    return DEFAULT_LIMIT_W;
  }

  static get PLAUSIBILITY_FACTOR() {
    return PLAUSIBILITY_FACTOR;
  }

  resolve() {
    let devices = [];
    try {
      const driver = this.homey.drivers.getDriver('grid');
      if (driver) devices = driver.getDevices() || [];
    } catch {
    }

    const found = [];
    devices.forEach((device) => {
      try {
        found.push({ name: device.getName(), limitW: GridConnection.limitFromSettings(device.getSettings()) });
      } catch {
      }
    });

    const usable = found.filter((f) => Number.isFinite(f.limitW) && f.limitW > 0);
    if (!usable.length) return { limitW: DEFAULT_LIMIT_W, count: 0, detail: null };

    const detail = usable
      .map((f) => f.name)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');

    return {
      limitW: Math.max(...usable.map((f) => f.limitW)),
      count: usable.length,
      detail,
    };
  }

  async apply() {
    const { limitW, count, detail } = this.resolve();
    if (count > 1) await SetupNotice.notify(this.homey, 'grid_multiple', detail, GridConnection.multipleText(this.homey, detail));
    else SetupNotice.clear(this.homey, 'grid_multiple');
    return limitW;
  }

  static async limitW(homey) {
    try {
      return await GridConnection.forApp(homey).apply();
    } catch {
      return DEFAULT_LIMIT_W;
    }
  }

  static multipleText(homey, devices) {
    return homey.__('grid_connection_multiple_devices', { devices });
  }

  static multipleWarning(homey) {
    try {
      const devices = homey.drivers.getDriver('grid').getDevices().filter((d) => !d.isDeleted);
      if (devices.length < 2) return null;
      return GridConnection.multipleText(homey, devices.map((d) => d.getName()).sort().join(', '));
    } catch {
      return null;
    }
  }

  static gridDevice(homey) {
    try {
      const driver = homey.drivers.getDriver('grid');
      return (driver && driver.getDevices().find((d) => typeof d.getImportHeadroomW === 'function')) || null;
    } catch {
      return null;
    }
  }

  static async ceilingW(homey) {
    return (await GridConnection.limitW(homey)) * PLAUSIBILITY_FACTOR;
  }

}

module.exports = GridConnection;
