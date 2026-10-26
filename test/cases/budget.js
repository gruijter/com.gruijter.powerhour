'use strict';

const assert = require('assert');
const B = require('../../lib/Budget');
const BS = require('../../lib/helpers/BudgetSetup');

const en = require('../../locales/en.json');

const homey = { __: (key) => key.split('.').reduce((o, k) => o && o[k], en) || key };
assert.strictEqual(B.isActive('linear', '0'), false);
assert.strictEqual(B.isActive('linear', '2900'), true);
assert.strictEqual(B.isActive('NONE', '2900'), false);
assert.strictEqual(B.isActive('CUSTOM', '0;0;0;0;0;0;0;0;0;0;0;0'), false);
assert.strictEqual(B.isActive('CUSTOM', '1;0;0;0;0;0;0;0;0;0;0;0'), true);
assert.strictEqual(B.isActive('CUSTOM', '2900'), false);
assert.deepStrictEqual(BS.migrate({ distribution: 'NONE', budget: '2900' }, 'grid'), { budget: '0', distribution: 'linear' });
assert.deepStrictEqual(BS.migrate({ distribution: 'pv_52n_t40s', budget: '2900' }, 'grid'), { distribution: 'local' });
assert.deepStrictEqual(BS.migrate({ distribution: 'el_nl_2023', budget: '2900' }, 'solar'), { distribution: 'local' });
assert.deepStrictEqual(BS.migrate({ distribution: 'gas_nl_2023', budget: '1200' }, 'gas'), { distribution: 'local' });
assert.deepStrictEqual(BS.migrate({ distribution: 'el_nl_2023', budget: '1200' }, 'water'), { distribution: 'linear' }, 'no local: default');
assert.strictEqual(BS.migrate({ distribution: 'CUSTOM', budget: '1;1;1;1;1;1;1;1;1;1;1;1' }, 'power'), null);
assert.strictEqual(BS.migrate({ distribution: 'linear' }, 'battery'), null);
assert.strictEqual(B.getBudgetsToDate({ distribution: 'linear', budget: '0', timeZone: 'Europe/Amsterdam' }), null);

// Settings outside the manifest: per driver, summary label, start date.
assert.deepStrictEqual(BS.defs(homey, 'water').distribution.values.map((v) => v.id), ['linear', 'CUSTOM']);
assert.deepStrictEqual(BS.defs(homey, 'gas').budget_heating.values.map((v) => v.id), ['boiler', 'hybrid', 'none']);
assert.strictEqual(BS.defs(homey, 'gas').budget_cooling, undefined);
assert.strictEqual(BS.defs(homey, 'solar').budget_heating, undefined);
assert.deepStrictEqual(BS.defs(homey, 'battery'), {});
assert.strictEqual(BS.summary(homey, { budget: '0', distribution: 'linear' }, 'grid'), 'No budget · start 1 January');
assert.strictEqual(BS.summary(homey, {
  budget: '4500', distribution: 'local', budget_heating: 'heat_pump', budget_cooling: true, start_date: '0107',
}, 'grid'), '4500 kWh · Local climate · Heat pump · Air conditioning · start 1 July');
assert.strictEqual(BS.summary(homey, { budget: '1;1;1;1;1;1;1;1;1;1;1;1', distribution: 'CUSTOM' }, 'gas'), '12 m³ · Custom · start 1 January');
assert.strictEqual(BS.validStartDate(' 0101 '), '0101');
assert.strictEqual(BS.validStartDate('3213'), null);
assert.strictEqual(BS.validStartDate('101'), null);
assert.strictEqual(BS.customBudget(['1', '2,5', 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]), '1;2.5;3;0;0;0;0;0;0;0;0;0');
assert.strictEqual(BS.customBudget(new Array(12).fill(0)), null, 'total 0');
assert.strictEqual(BS.customBudget(['1', '-1', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), null, 'negative');
assert.strictEqual(BS.customBudget([1, 2]), null);
assert.deepStrictEqual(BS.pairPreset('grid'), { budget: '2500', distribution: 'local' });
assert.strictEqual(BS.pairPreset('power'), null);
assert.strictEqual(BS.defs(homey, 'grid').start_date.months.length, 12);

// Start day 29-31: a shorter month starts on its last day.
const MH = require('../../lib/helpers/MeterHelpers');

assert.strictEqual(MH.monthStartDay(31, 2026, 1), 28);
assert.strictEqual(MH.monthStartDay(31, 2028, 1), 29, 'leap year');
assert.strictEqual(MH.monthStartDay(31, 2026, 3), 30);
assert.strictEqual(MH.monthStartDay(15, 2026, 1), 15);
const rd = (year, month, day, hour = 0) => ({
  year, month, day, hour,
});
const p = (cur, last, startDay, startMonth = 0) => MH.getPeriods(cur, last, last, last, last, startDay, startMonth);
assert.strictEqual(p(rd(2026, 1, 28), rd(2026, 1, 27, 23), 31).newMonth, true, '28 Feb starts the month for day 31');
assert.strictEqual(p(rd(2026, 2, 1), rd(2026, 1, 28, 23), 31).newMonth, false, 'not again on 1 March');
assert.strictEqual(p(rd(2026, 2, 31), rd(2026, 2, 30, 23), 31).newMonth, true, '31 March');
const ps = MH.periodStarts(new Date(2026, 2, 5), 31, 0);
assert.deepStrictEqual([ps.month.getMonth(), ps.month.getDate(), ps.year.getFullYear(), ps.year.getMonth(), ps.year.getDate()], [1, 28, 2026, 0, 31]);
const ps2 = MH.periodStarts(new Date(2026, 0, 5), 15, 0);
assert.deepStrictEqual([ps2.month.getFullYear(), ps2.month.getMonth(), ps2.year.getFullYear()], [2025, 11, 2025], 'before the start day: previous month and year');

// Budget before the start day of this month: from the start of the previous month, not a year wrap.
const mid = B.getBudgetsToDate({
  distribution: 'linear', budget: '3650', timeZone: 'UTC', startDay: 15, startMonth: 0, date: new Date(Date.UTC(2026, 5, 5, 12)),
});
assert.ok(Math.abs(mid.monthToDate - 220) < 0.5, `15 May-5 Jun ${mid.monthToDate}`);
assert.ok(Math.abs(mid.yearToDate - 1420) < 0.5, `15 Jan-5 Jun ${mid.yearToDate}`);
