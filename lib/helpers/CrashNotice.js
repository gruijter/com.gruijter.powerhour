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

// Timeline notification after a crash. Homey counts the app's crashes (crashedCount, Web API) and
// restarts the app right after one: a count above the one stored at the last start is a crash
// just before this start. Heavy work (the LP) writes a small marker file before it starts and
// clears it after: a marker found at the start tells what ran when the app was killed. Written
// synchronously, as the LP blocks the process until it is done.

const fs = require('fs');
const crypto = require('crypto');

const COUNT_KEY = 'crashedCount';
const FILE_KEY = 'crashNoticeFile';
const CHECK_MS = 60 * 1000;
const MAX_CHECKS = 10;

class CrashNotice {

  constructor(app, dir = '/userdata') {
    this.app = app;
    this.homey = app.homey;
    this.dir = dir;
  }

  // Reads and clears the marker of the last run, then checks the count once the Homey API is up.
  start() {
    this.lastBusy = this.readMarker();
    if (this.lastBusy) this.writeMarker(null);
    this.checks = 0;
    this.scheduleCheck();
  }

  stop() {
    if (this.checkId) this.homey.clearTimeout(this.checkId);
  }

  scheduleCheck() {
    this.checkId = this.homey.setTimeout(() => this.check().catch((err) => this.app.error('[CrashNotice]', err)), CHECK_MS);
  }

  path() {
    let id = this.homey.settings.get(FILE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      this.homey.settings.set(FILE_KEY, id);
    }
    return `${this.dir}/${id}.json`;
  }

  readMarker() {
    try {
      return JSON.parse(fs.readFileSync(this.path(), 'utf8'));
    } catch {
      return null;
    }
  }

  writeMarker(value) {
    try {
      if (value) fs.writeFileSync(this.path(), JSON.stringify(value));
      else fs.rmSync(this.path(), { force: true });
    } catch (err) {
      this.app.error('[CrashNotice] marker', err.message);
    }
  }

  // fn() runs with a marker; kind 'lp': the LP for the batteries named.
  run(kind, names, fn) {
    this.writeMarker({ kind, names, tm: Date.now() });
    try {
      return fn();
    } finally {
      this.writeMarker(null);
    }
  }

  async check() {
    const { api } = this.app;
    if (!api) {
      this.checks += 1;
      if (this.checks < MAX_CHECKS) this.scheduleCheck();
      return;
    }
    const info = await api.apps.getApp({ id: 'com.gruijter.powerhour' });
    const count = Number(info && info.crashedCount) || 0;
    const stored = this.homey.settings.get(COUNT_KEY);
    if (stored !== count) this.homey.settings.set(COUNT_KEY, count);
    // First start with this code, or the count was reset (update): nothing to compare.
    if (typeof stored !== 'number' || count <= stored) return;
    const excerpt = this.excerpt();
    this.app.log('Crash notification:', excerpt);
    await this.homey.notifications.createNotification({ excerpt });
  }

  excerpt() {
    const busy = this.lastBusy;
    if (busy && busy.kind === 'lp') return this.homey.__('crash_notice_lp', { name: (busy.names || []).join(', ') });
    const driver = this.homey.drivers.getDriver('battery');
    const lp = driver ? driver.getDevices().filter((d) => d.getSettings().precisePlanning).map((d) => d.getName()) : [];
    if (lp.length) return this.homey.__('crash_notice_lp_on', { name: lp.join(', ') });
    return this.homey.__('crash_notice');
  }

}

module.exports = CrashNotice;
