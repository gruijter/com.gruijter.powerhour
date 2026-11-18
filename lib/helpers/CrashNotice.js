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

  start() {
    this.lastBusy = this.readMarker();
    if (this.lastBusy) this.writeMarker(null);
    this.lpKilled = !!(this.lastBusy && this.lastBusy.kind === 'lp');
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
      else if (this.lpKilled) await this.lpOff();
      return;
    }
    const info = await api.apps.getApp({ id: 'com.gruijter.powerhour' }).catch((err) => {
      this.app.error('[CrashNotice]', err.message);
      return null;
    });
    if (info) {
      const count = Number(info.crashedCount) || 0;
      const stored = this.homey.settings.get(COUNT_KEY);
      if (stored !== count) this.homey.settings.set(COUNT_KEY, count);
      const crashed = typeof stored === 'number' && count > stored;
      if (crashed && this.app.memLog) this.app.memLog.noteCrash(stored, count, this.lastBusy);
      if (crashed || this.lpKilled) await this.lpOff();
    } else if (this.lpKilled) await this.lpOff();
  }

  async lpOff() {
    let driver = null;
    try {
      driver = this.homey.drivers.getDriver('battery');
    } catch {
    }
    const lp = driver ? driver.getDevices().filter((d) => d.getSettings().precisePlanning) : [];
    if (!lp.length) {
      this.app.log('[CrashNotice] crash, Extra precise planning off: no notification');
      return;
    }
    for (const device of lp) await device.stopPrecisePlanning().catch((err) => this.app.error('[CrashNotice]', err));
    this.lpKilled = false;
    const excerpt = this.homey.__('crash_notice_lp_off');
    this.app.log('Crash notification:', excerpt, lp.map((d) => d.getName()).join(', '));
    await this.homey.notifications.createNotification({ excerpt });
  }

}

module.exports = CrashNotice;
