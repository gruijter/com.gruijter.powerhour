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
const { runExclusive } = require('./Util');

const ID_KEY = 'fileStoreId';
const WRITE_DELAY_MS = 5 * 60 * 1000;

class FileStore {
  constructor(device, dir, delayMs) {
    this.device = device;
    this.dir = dir;
    this.delayMs = delayMs;
    this.lastHash = null;
    this.data = {};
    this.timer = null;
    this.writing = Promise.resolve();
  }

  static async open(device, keys = [], { dir = '/userdata', delayMs = WRITE_DELAY_MS } = {}) {
    if (!device.fileStoreOpening) {
      device.fileStoreOpening = (async () => {
        const store = new FileStore(device, dir, delayMs);
        await store.load();
        device.fileStore = store;
        return store;
      })();
    }
    const store = await device.fileStoreOpening;
    await store.migrate(keys);
    return store;
  }

  static async close(device) {
    if (device.fileStore) await device.fileStore.flush();
  }

  static async remove(device) {
    const store = device.fileStore;
    if (!store) return;
    store.removed = true;
    if (store.timer) store.device.homey.clearTimeout(store.timer);
    store.timer = null;
    await store.writing;
    await fs.promises.rm(store.path(), { force: true }).catch((err) => store.device.error('[FileStore] remove failed', err.message));
    await fs.promises.rm(`${store.path()}.tmp`, { force: true }).catch(() => {});
  }

  path() {
    return `${this.dir}/${this.id}.json`;
  }

  async load() {
    this.id = this.device.getStoreValue(ID_KEY);
    if (!this.id) {
      this.id = crypto.randomUUID();
      await this.device.setStoreValue(ID_KEY, this.id).catch((err) => this.device.error('[FileStore]', err.message));
    }
    try {
      const json = await fs.promises.readFile(this.path(), 'utf8');
      this.data = JSON.parse(json) || {};
      this.lastHash = FileStore.hash(json);
    } catch (err) {
      if (err.code !== 'ENOENT') this.device.error('[FileStore] unreadable, starting empty:', err.message);
      this.data = {};
    }
  }

  async migrate(keys) {
    const moved = keys.filter((key) => this.device.getStoreKeys().includes(key));
    if (moved.length === 0) return;
    await runExclusive('FileStore.migrate', async () => {
      moved.forEach((key) => {
        if (this.data[key] === undefined) this.data[key] = this.device.getStoreValue(key);
      });
      await this.flush();
      for (const key of moved) {
        await this.device.unsetStoreValue(key).catch((err) => this.device.error('[FileStore]', err.message));
      }
      this.device.log(`[FileStore] moved from the store to a file: ${moved.join(', ')}`);
    });
  }

  static hash(json) {
    return crypto.createHash('sha1').update(json).digest('hex');
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.removed) return;
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    if (!this.timer) {
      this.timer = this.device.homey.setTimeout(() => {
        this.timer = null;
        this.flush().catch(() => {});
      }, this.delayMs);
    }
  }

  flush() {
    if (this.timer) this.device.homey.clearTimeout(this.timer);
    this.timer = null;
    this.writing = this.writing.then(async () => {
      if (this.removed) return;
      const json = JSON.stringify(this.data);
      const hash = FileStore.hash(json);
      if (hash === this.lastHash) return;
      const file = this.path();
      await fs.promises.writeFile(`${file}.tmp`, json);
      await fs.promises.rename(`${file}.tmp`, file);
      this.lastHash = hash;
    }).catch((err) => this.device.error('[FileStore] write failed:', err.message));
    return this.writing;
  }
}

module.exports = FileStore;
