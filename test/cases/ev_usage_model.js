'use strict';

const assert = require('assert');
const M = require('../../lib/strategies/EvUsageModel');

const tz = 'Europe/Amsterdam';
// local time -> Date (CEST/CET handled by searching the UTC offset)
const at = (y, mo, d, h, mi = 0) => {
  for (const off of [2, 1]) {
    const dt = new Date(Date.UTC(y, mo - 1, d, h - off, mi));
    if (M.localDateStr(dt, tz) === `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      && Math.abs(M.toLocalFractionalHour(dt, tz) - (h + mi / 60)) < 1e-6) return dt;
  }
  throw new Error('bad time');
};

// --- Live: 6 weeks from Mon 2026-08-03. Commute Mon/Tue/Thu (20 km, 3.4 kWh), Sat 150 km every
// other week, rest unused. Ticks at 00:01 every day.
const model = M.createModel();
M.rollover(model, at(2026, 8, 3, 0, 1), tz);
assert.strictEqual(model.current.partial, false, 'started at midnight: full day');
for (let day = 0; day < 42; day += 1) {
  const date = new Date(Date.UTC(2026, 7, 3 + day, 12));
  const y = 2026;
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  M.rollover(model, at(y, mo, d, 0, 1), tz);
  const dow = day % 7;
  if ([0, 1, 3].includes(dow)) {
    // leaves ~07:45 (cable pulled), report at work 08:15, back 17:30
    M.recordTrip(model, {
      km: 10, kwh: 1.7, reportTm: at(y, mo, d, 8, 15), fromHome: true, toHome: false, unplugTm: at(y, mo, d, 7, 45 + (day % 3)),
    }, tz);
    M.recordTrip(model, {
      km: 10, kwh: 1.7, reportTm: at(y, mo, d, 17, 30), fromHome: false, toHome: true,
    }, tz);
  }
  if (dow === 5 && day % 14 === 5) {
    M.recordTrip(model, {
      km: 75, kwh: 12, reportTm: at(y, mo, d, 11, 0), fromHome: true, toHome: false,
    }, tz);
    M.recordTrip(model, {
      km: 75, kwh: 12.5, reportTm: at(y, mo, d, 18, 0), fromHome: false, toHome: true,
    }, tz);
  }
}
M.rollover(model, at(2026, 9, 14, 0, 1), tz);
assert.strictEqual(model.days.length, 42);
const prof = M.getProfile(model);
const fmt = (p) => `${M.DAY_NAMES[p.dow].slice(0, 3)} n=${p.observed} used=${p.used} regular=${p.regular} need=${p.needKwh} safe=${p.safeKwh} dep=${p.departFh === null ? '-' : M.fractionalHourToHHMM(p.departFh)} ret=${p.returnFh === null ? '-' : M.fractionalHourToHHMM(p.returnFh)}`;
prof.forEach((p) => console.log(fmt(p)));
assert.deepStrictEqual(prof.map((p) => p.regular), [true, true, false, true, false, false, false]);
assert.ok(Math.abs(prof[0].needKwh - 3.4) < 0.05, 'Mon need ~3.4 kWh (20 km x 0.17)');
assert.ok(Math.abs(prof[0].departFh - 7.75) < 0.05, 'Mon departure ~07:45 from unplug');
assert.strictEqual(M.fractionalHourToHHMM(prof[0].returnFh), '17:30');
assert.strictEqual(prof[5].used, 3, 'Sat: 3 of 6 long trips');
// Sat departure estimated from report: 11:00 - 75 km / 40 km/h = 09:07:30
assert.strictEqual(M.fractionalHourToHHMM(prof[5].departFh), '09:08');
assert.ok(Math.abs(model.kwhPerKm - 0.16) < 0.01, `kWh/km learned from long trips ${model.kwhPerKm}`);

// Override days are left out
M.setOverride(model, 'unused');
M.rollover(model, at(2026, 9, 15, 0, 1), tz);
assert.strictEqual(M.getProfile(model)[0].observed, 6, 'override Monday not counted');

// Restart mid-day: partial
const m2 = M.createModel();
M.rollover(m2, at(2026, 9, 14, 13, 0), tz);
assert.strictEqual(m2.current.partial, true);

// Trip reported after midnight started yesterday: no departure today
const m3 = M.createModel();
M.rollover(m3, at(2026, 9, 14, 0, 1), tz);
M.recordTrip(m3, {
  km: 40, kwh: 6, reportTm: at(2026, 9, 14, 0, 30), fromHome: true, toHome: false,
}, tz);
assert.strictEqual(m3.current.departFh, null);

// --- Bootstrap: hourly odometer, commute Mon-Fri with split steps, idle weekends, a gap day
const odo = [];
const soc = [];
let km = 1000;
let s = 80;
for (let day = 0; day < 21; day += 1) {
  const date = new Date(Date.UTC(2026, 7, 3 + day, 12));
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  if (day === 10) continue; // Insights gap
  for (let h = 0; h < 24; h += 1) {
    const t = at(2026, mo, d, h).getTime();
    const workday = (day % 7) < 5;
    if (workday && h === 8) km += 5; // half of the step (hour average)
    if (workday && h === 9) km += 5;
    if (workday && h === 9) s -= 3;
    odo.push({ t, v: km });
    soc.push({ t, v: s });
  }
}
const b = M.bootstrapFromHistory(odo, soc, 64, tz, at(2026, 8, 24, 10));
const bp = M.getProfile(b);
bp.forEach((p) => console.log('boot', fmt(p)));
assert.strictEqual(bp[0].used, 2, 'Mondays in history (first day partial)');
assert.strictEqual(bp[0].regular, false, 'only 2 observations');
assert.strictEqual(bp[1].used, 3, 'Tuesdays');
assert.strictEqual(bp[1].regular, true, '3 of 3 Tuesdays');
assert.strictEqual(bp[5].observed, 2, 'weekend idle days (2 in a row) trusted; the last weekend runs into now and is not yet');
assert.strictEqual(bp[5].used, 0);
assert.strictEqual(b.days.find((x) => x.date === '2026-08-13').partial, true, 'gap day partial');
assert.strictEqual(b.days.find((x) => x.date === '2026-08-10').km, 10, 'split step merged');

assert.strictEqual(b.lastOdo, null, 'no start odometer from hour averages');
assert.ok(M.maxTripKm(64) > 370 && M.maxTripKm(64) < 380);
console.log('all phase 2 tests passed');
