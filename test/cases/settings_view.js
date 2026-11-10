/* eslint-disable no-console */

'use strict';

// Unit cases for the read-only setup settings on the settings page (lib/helpers/SettingsView.js) and
// the manifest made from them (test/tools/settingsView.js).
// Run: node test/cases/settings_view.js

const assert = require('assert');
const SettingsView = require('../../lib/helpers/SettingsView');
const manifest = require('../../app.json');
const en = require('../../locales/en.json');

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

const homey = {
  __: (k) => k.split('.').reduce((o, p) => (o ? o[p] : undefined), en) || k,
  i18n: { getLanguage: () => 'en' },
};
const device = (driverId, settings, store = {}) => {
  let s = { ...settings };
  return {
    homey,
    driver: { ds: { driverId, setup: { steps: [] } } },
    getSettings: () => s,
    getStoreValue: (k) => store[k],
    setSettings: async (x) => {
      s = { ...s, ...x };
    },
  };
};

const defs = {
  markup_day: { type: 'number', value: 0 },
  peakPreset: {
    type: 'dropdown', value: 'none', values: [{ id: 'none', label: { en: 'None' } }, { id: 'custom', label: { en: 'Custom' } }],
  },
  peakCount: { type: 'number', value: 1, showIf: { id: 'peakSelection', not: 'max' } },
  peakSelection: { type: 'dropdown', value: 'max', showIf: { id: 'peakPreset', value: 'custom' } },
  peakWeekdaysOnly: { type: 'checkbox', value: false, showIf: { id: 'peakPreset', value: 'custom' } },
  connectionAmps: { type: 'number', value: 25 },
  fixedMarkup: { type: 'number', value: 0 },
  fixedMarkupInclVat: { type: 'checkbox', value: true },
  entsoeApiKey: { type: 'text', value: '' },
};

(async () => {
  await test('values: money with currency, dropdown label, unit, on/off, VAT', () => {
    const d = device('grid', {
      markup_day: 0.5, peakPreset: 'custom', peakSelection: 'mean', peakCount: 3, peakWeekdaysOnly: true, currency: '€',
    });
    const s = d.getSettings();
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'markup_day'), '€ 0.5');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'peakPreset'), 'Custom');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'peakCount'), '3');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'peakWeekdaysOnly'), 'On');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'connectionAmps'), '25 A');
    const p = device('price', { fixedMarkup: 0.11, fixedMarkupInclVat: true, entsoeApiKey: 'abcdef123456' });
    assert.strictEqual(SettingsView.textOf(p, defs, p.getSettings(), 'fixedMarkup'), '€ 0.11 (incl. VAT)');
    assert.strictEqual(SettingsView.textOf(p, defs, p.getSettings(), 'entsoeApiKey'), '••••3456');
  });

  await test('not used: "-", also when a parent is not used', () => {
    const d = device('grid', { peakPreset: 'none', peakSelection: 'mean', peakCount: 3 });
    const s = d.getSettings();
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'peakSelection'), '-');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'peakCount'), '-', 'its parent peakSelection is not used');
    assert.strictEqual(SettingsView.textOf(d, defs, s, 'entsoeApiKey'), '-');
  });

  await test('groups: price settings as price_info, year as budget_info', () => {
    const steps = [
      { id: 'meter', ids: ['use_measure_source'], roles: true },
      { id: 'price', ids: ['tariff_update_group', 'tariff', 'currency', 'markup_day'] },
      { id: 'year', ids: [] },
    ];
    const g = SettingsView.groupsFor('gas', steps);
    assert.deepStrictEqual(g.map((x) => x.id), ['meter', 'price', 'year']);
    assert.deepStrictEqual(g[1].ids, ['price_info', 'markup_day']);
    assert.deepStrictEqual(g[2].ids, ['budget_info']);
    assert.strictEqual(SettingsView.viewId('markup_day'), 'view_markup_day');
    assert.strictEqual(SettingsView.viewId('price_info'), 'price_info');
  });

  await test('manifest: every driver with a setup has its view labels, editable settings first', () => {
    manifest.drivers.filter((d) => ['grid', 'power', 'solar', 'gas', 'water', 'battery', 'evCharger', 'price'].includes(d.id)).forEach((d) => {
      const items = d.settings.flatMap((g) => g.children || []);
      assert.ok(items.some((i) => i.id.startsWith(SettingsView.PREFIX)), `${d.id}: no view labels`);
      assert.ok(!items.some((i) => i.id === 'fix_values_info'), `${d.id}: fix_values_info`);
      const firstLabel = items.findIndex((i) => i.type === 'label');
      const lastEditable = items.map((i) => i.type !== 'label').lastIndexOf(true);
      assert.ok(lastEditable < firstLabel, `${d.id}: an editable setting below a label`);
      items.filter((i) => i.id.startsWith(SettingsView.PREFIX)).forEach((i) => assert.ok(i.hint && i.hint.en, `${d.id}.${i.id}: no hint`));
    });
  });

  await test('update(): writes only changed labels', async () => {
    const d = device('gas', { markup_day: 1.25 }, {});
    d.driver.ds.setup.steps = [{ id: 'price', ids: ['markup_day'] }];
    d.driver.settingsViewDefs = defs;
    let writes = 0;
    const set = d.setSettings;
    d.setSettings = async (x) => {
      writes += 1;
      await set(x);
    };
    await SettingsView.update(d);
    assert.strictEqual(d.getSettings().view_markup_day, '1.25', 'no currency without a store or setting');
    await SettingsView.update(d);
    assert.strictEqual(writes, 1);
  });

  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
