/* eslint-disable no-console */

'use strict';

// Unit cases for the crash notification (CrashNotice): crashedCount up = crash, the LP marker names
// the batteries, every crash notified, none at the first start.
// Run: node test/cases/crash_notice.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CrashNotice = require('../../lib/helpers/CrashNotice');

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));

const makeApp = ({ settings = {}, count = 0, lpBatteries = [] } = {}) => {
  const notes = [];
  const homey = {
    settings: {
      get: (k) => settings[k],
      set: (k, v) => {
        settings[k] = v;
      },
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    notifications: { createNotification: async ({ excerpt }) => notes.push(excerpt) },
    __: (key, t) => `${key}${t ? `:${t.name}` : ''}`,
    drivers: {
      getDriver: () => ({
        getDevices: () => lpBatteries.map((name) => ({ getName: () => name, getSettings: () => ({ precisePlanning: true }) })),
      }),
    },
  };
  const app = {
    homey, log: () => {}, error: () => {}, api: { apps: { getApp: async () => ({ crashedCount: count }) } },
  };
  return { app, notes, settings };
};

(async () => {
  await test('first start: count stored, no notification', async () => {
    const { app, notes, settings } = makeApp({ count: 2 });
    const c = new CrashNotice(app, dir);
    c.start();
    await c.check();
    assert.strictEqual(settings.crashedCount, 2);
    assert.deepStrictEqual(notes, []);
  });

  await test('count up after a crash in the LP: names the batteries', async () => {
    const shared = {};
    const before = makeApp({ settings: shared, count: 1 });
    const c1 = new CrashNotice(before.app, dir);
    c1.start();
    await c1.check();
    // The LP is killed: the marker stays.
    c1.writeMarker({ kind: 'lp', names: ['Sessy1', 'Sessy2'], tm: Date.now() });
    const after = makeApp({ settings: shared, count: 2 });
    const c2 = new CrashNotice(after.app, dir);
    c2.start();
    assert.strictEqual(c2.readMarker(), null);
    await c2.check();
    assert.deepStrictEqual(after.notes, ['crash_notice_lp:Sessy1, Sessy2']);
  });

  await test('every crash notified, also right after the previous one', async () => {
    const { app, notes, settings } = makeApp({ settings: { crashedCount: 2 }, count: 3 });
    const c = new CrashNotice(app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(notes, ['crash_notice']);
    assert.strictEqual(settings.crashedCount, 3);
  });

  await test('crash outside the LP, LP on: advice for those batteries', async () => {
    const { app, notes } = makeApp({ settings: { crashedCount: 0 }, count: 1, lpBatteries: ['Brik'] });
    const c = new CrashNotice(app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(notes, ['crash_notice_lp_on:Brik']);
  });

  await test('crash without LP: plain notification; count reset (update): none', async () => {
    const a = makeApp({ settings: { crashedCount: 4 }, count: 5 });
    const c = new CrashNotice(a.app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(a.notes, ['crash_notice']);
    const b = makeApp({ settings: { crashedCount: 5 }, count: 0 });
    const d = new CrashNotice(b.app, dir);
    d.start();
    await d.check();
    assert.deepStrictEqual(b.notes, []);
  });

  await test('run(): marker during fn, cleared after, also on throw', async () => {
    const { app } = makeApp();
    const c = new CrashNotice(app, dir);
    let seen = null;
    c.run('lp', ['X'], () => {
      seen = c.readMarker();
    });
    assert.strictEqual(seen.kind, 'lp');
    assert.strictEqual(c.readMarker(), null);
    assert.throws(() => c.run('lp', ['X'], () => {
      throw new Error('boom');
    }));
    assert.strictEqual(c.readMarker(), null);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.log(`${failed} failed`);
    process.exit(1);
  }
  console.log('all ok');
})().catch((err) => {
  console.log(err);
  process.exit(1);
});
