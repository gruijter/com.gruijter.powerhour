/* eslint-disable no-console */

'use strict';

// Unit cases for lib/helpers/FileStore.js. Run: node test/cases/file_store.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileStore = require('../../lib/helpers/FileStore');

let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-'));

// A device with a store that counts whole-store writes (each one is an IPC message to Homey).
const fakeDevice = (store = {}) => {
  const d = {
    store: { ...store },
    storeWrites: 0,
    errors: [],
    homey: { setTimeout, clearTimeout },
    getStoreValue: (k) => (d.store[k] === undefined ? null : d.store[k]),
    getStoreKeys: () => Object.keys(d.store),
    setStoreValue: async (k, v) => {
      d.store[k] = v;
      d.storeWrites += 1;
    },
    unsetStoreValue: async (k) => {
      delete d.store[k];
      d.storeWrites += 1;
    },
    log: () => {},
    error: (...a) => d.errors.push(a.join(' ')),
  };
  return d;
};
const fileOf = (d) => JSON.parse(fs.readFileSync(path.join(dir, `${d.getStoreValue('fileStoreId')}.json`), 'utf8'));

(async () => {
  await test('store keys move to the file, once', async () => {
    const d = fakeDevice({ powerHistory: [{ time: 1, power: 2 }], batteryProps: { cap: 5 } });
    const files = await FileStore.open(d, ['powerHistory', 'socHistory'], { dir });
    assert.deepStrictEqual(files.get('powerHistory'), [{ time: 1, power: 2 }]);
    assert.strictEqual(d.getStoreValue('powerHistory'), null);
    assert.deepStrictEqual(d.getStoreValue('batteryProps'), { cap: 5 }); // not listed: stays
    assert.deepStrictEqual(fileOf(d).powerHistory, [{ time: 1, power: 2 }]);
    const writes = d.storeWrites;
    await FileStore.open(d, ['powerHistory'], { dir });
    assert.strictEqual(d.storeWrites, writes);
    assert.strictEqual(d.fileStore, files);
  });

  await test('sets in a row: one file write, no store write', async () => {
    const d = fakeDevice();
    const files = await FileStore.open(d, [], { dir, delayMs: 300 });
    const writes = d.storeWrites;
    let fileWrites = 0;
    const orig = fs.promises.rename;
    fs.promises.rename = async (...a) => {
      fileWrites += 1;
      return orig(...a);
    };
    files.set('a', [1]);
    files.set('b', 2);
    files.set('a', [3]);
    await new Promise((r) => {
      setTimeout(r, 600);
    });
    files.set('a', [3]); // same content: no write
    await files.flush();
    fs.promises.rename = orig;
    assert.strictEqual(fileWrites, 1);
    assert.strictEqual(d.storeWrites, writes);
    assert.deepStrictEqual(fileOf(d), { a: [3], b: 2 });
  });

  await test('reloads after a restart; close() writes what is pending', async () => {
    const d = fakeDevice();
    const files = await FileStore.open(d, [], { dir });
    files.set('socHistory', [{ time: 5, soc: 50 }]);
    await FileStore.close(d);
    const restarted = fakeDevice(d.store); // same store, new process
    const again = await FileStore.open(restarted, ['socHistory'], { dir });
    assert.deepStrictEqual(again.get('socHistory'), [{ time: 5, soc: 50 }]);
  });

  await test('a key in both file and store (crash mid-move): the file wins', async () => {
    const d = fakeDevice();
    const files = await FileStore.open(d, [], { dir });
    files.set('prices', ['new']);
    await files.flush();
    const restarted = fakeDevice({ ...d.store, prices: ['old'] });
    const again = await FileStore.open(restarted, ['prices'], { dir });
    assert.deepStrictEqual(again.get('prices'), ['new']);
    assert.strictEqual(restarted.getStoreValue('prices'), null);
  });

  await test('unreadable file: empty, logged', async () => {
    const d = fakeDevice({ fileStoreId: 'broken' });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"a":');
    const files = await FileStore.open(d, [], { dir });
    assert.strictEqual(files.get('a'), undefined);
    assert.strictEqual(d.errors.length, 1);
  });

  await test('remove: file gone, later sets ignored', async () => {
    const d = fakeDevice();
    const files = await FileStore.open(d, [], { dir });
    files.set('x', 1);
    await files.flush();
    const file = path.join(dir, `${d.getStoreValue('fileStoreId')}.json`);
    assert.ok(fs.existsSync(file));
    await FileStore.remove(d);
    files.set('x', 2);
    await files.flush();
    assert.ok(!fs.existsSync(file));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.log(err);
  process.exitCode = 1;
});
