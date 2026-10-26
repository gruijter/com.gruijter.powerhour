'use strict';

const assert = require('assert');
const B = require('../../lib/Budget');

const m = (d) => require(`../../drivers/${d}/driver.compose.json`).settings;
assert.strictEqual(B.isActive('linear', '0'), false);
assert.strictEqual(B.isActive('linear', '2900'), true);
assert.strictEqual(B.isActive('NONE', '2900'), false);
assert.strictEqual(B.isActive('CUSTOM', '0;0;0;0;0;0;0;0;0;0;0;0'), false);
assert.strictEqual(B.isActive('CUSTOM', '1;0;0;0;0;0;0;0;0;0;0;0'), true);
assert.strictEqual(B.isActive('CUSTOM', '2900'), false);
assert.deepStrictEqual(B.migrateSettings({ distribution: 'NONE', budget: '2900' }, m('grid')), { budget: '0', distribution: 'el_nl_2023' });
assert.deepStrictEqual(B.migrateSettings({ distribution: 'pv_52n_t40s', budget: '2900' }, m('grid')), { distribution: 'el_nl_2023' });
assert.deepStrictEqual(B.migrateSettings({ distribution: 'el_nl_2023', budget: '2900' }, m('solar')), { distribution: 'pv_52n_t40s' });
assert.strictEqual(B.migrateSettings({ distribution: 'pv_52n_t40s', budget: '2900' }, m('power')), null);
assert.strictEqual(B.migrateSettings({ distribution: 'gas_nl_2023', budget: '1200' }, m('gas')), null);
assert.strictEqual(B.migrateSettings({ distribution: 'linear' }, m('battery')), null);
assert.strictEqual(B.getBudgetsToDate({ distribution: 'linear', budget: '0', timeZone: 'Europe/Amsterdam' }), null);
