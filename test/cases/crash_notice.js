/* eslint-disable no-console */

'use strict';

// Unit cases for the crash notification (CrashNotice): crashedCount up = crash; with Extra precise
// planning on it is turned off and notified, otherwise no notification; none at the first start.
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
  const batteries = lpBatteries.map((name) => {
    const set = { precisePlanning: true };
    return {
      getName: () => name,
      getSettings: () => set,
      stopPrecisePlanning: async () => {
        set.precisePlanning = false;
      },
    };
  });
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
        getDevices: () => batteries,
      }),
    },
  };
  const app = {
    homey, log: () => {}, error: () => {}, api: { apps: { getApp: async () => ({ crashedCount: count }) } },
  };
  return {
    app, notes, settings, batteries,
  };
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

  await test('crash in the LP: LP off for its batteries, notified', async () => {
    const shared = {};
    const before = makeApp({ settings: shared, count: 1 });
    const c1 = new CrashNotice(before.app, dir);
    c1.start();
    await c1.check();
    // The LP is killed: the marker stays.
    c1.writeMarker({ kind: 'lp', names: ['Sessy1', 'Sessy2'], tm: Date.now() });
    const after = makeApp({ settings: shared, count: 2, lpBatteries: ['Sessy1', 'Sessy2'] });
    const c2 = new CrashNotice(after.app, dir);
    c2.start();
    assert.strictEqual(c2.readMarker(), null);
    assert.strictEqual(c2.lpKilled, true); // no LP until check() turned it off
    await c2.check();
    assert.deepStrictEqual(after.notes, ['crash_notice_lp_off']);
    assert.ok(after.batteries.every((b) => b.getSettings().precisePlanning === false));
    assert.strictEqual(c2.lpKilled, false);
  });

  await test('killed in the LP, not counted as a crash: LP off too', async () => {
    const shared = { crashedCount: 3 };
    const before = makeApp({ settings: shared, count: 3 });
    new CrashNotice(before.app, dir).writeMarker({ kind: 'lp', names: ['Brik'], tm: Date.now() });
    const after = makeApp({ settings: shared, count: 3, lpBatteries: ['Brik'] });
    const c = new CrashNotice(after.app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(after.notes, ['crash_notice_lp_off']);
    assert.ok(after.batteries.every((b) => b.getSettings().precisePlanning === false));
  });

  await test('every crash with the LP on notified, also right after the previous one', async () => {
    const { app, notes, settings } = makeApp({ settings: { crashedCount: 2 }, count: 3, lpBatteries: ['Brik'] });
    const c = new CrashNotice(app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(notes, ['crash_notice_lp_off']);
    assert.strictEqual(settings.crashedCount, 3);
  });

  await test('crash outside the LP, LP on: turned off too', async () => {
    const { app, notes } = makeApp({ settings: { crashedCount: 0 }, count: 1, lpBatteries: ['Brik'] });
    const c = new CrashNotice(app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(notes, ['crash_notice_lp_off']);
  });

  await test('crash without LP: no notification; count reset (update): none', async () => {
    const a = makeApp({ settings: { crashedCount: 4 }, count: 5 });
    const c = new CrashNotice(a.app, dir);
    c.start();
    await c.check();
    assert.deepStrictEqual(a.notes, []);
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
