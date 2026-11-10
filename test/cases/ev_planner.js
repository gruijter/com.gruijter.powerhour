'use strict';

const assert = require('assert');
const P = require('../../lib/strategies/EvPlanner');
const PP = require('../../lib/strategies/PriceProfile');
const M = require('../../lib/strategies/EvUsageModel');

const tz = 'Europe/Amsterdam';
const H = 3600 * 1000;
const at = (y, mo, d, h, mi = 0) => {
  for (const off of [2, 1]) {
    const dt = new Date(Date.UTC(y, mo - 1, d, h - off, mi));
    if (M.localDateStr(dt, tz) === `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      && Math.abs(M.toLocalFractionalHour(dt, tz) - (h + mi / 60)) < 1e-6) return dt.getTime();
  }
  throw new Error('bad time');
};
const base = {
  intervalMin: 60,
  capacityKwh: 64,
  chargePowerW: 2560,
  efficiency: 1,
  atHome: true,
  reserveSoc: 30,
  reserveHours: 8,
  floorSoc: 15,
  maxSoc: 80,
  mode: 'smart',
  horizonDays: 1,
};
// 2.56 kW x 1 h x eff 1 / 64 kWh = 4 pct per hourly slot
const costOf = (r) => Object.values(r.scheme).reduce((a, s) => a + (s.duration / 60) * 2.56 * s.price, 0);
const chargedSlots = (r) => Object.entries(r.scheme).filter(([, s]) => s.duration > 0).map(([i]) => Number(i));

// --- 1. Optimality against brute force (nested deadlines, no ceiling, whole slots)
let rnd = 7;
const rand = () => {
  rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647;
};
for (let run = 0; run < 200; run += 1) {
  const now = at(2026, 10, 5, 0);
  const prices = Array.from({ length: 12 }, () => Math.round(rand() * 100) / 100);
  const d1 = 3 + Math.floor(rand() * 5); // deadline slot index 1
  const d2 = d1 + 1 + Math.floor(rand() * (11 - d1));
  const k1 = 1 + Math.floor(rand() * Math.min(3, d1)); // slots needed by d1
  const k2 = k1 + Math.floor(rand() * Math.min(3, d2 - k1)); // cumulative by d2
  const trips = [
    {
      departMs: now + d1 * H, returnMs: now + d1 * H, needPct: 0, minSoc: 40 + 4 * k1, boost: false,
    },
    {
      departMs: now + d2 * H, returnMs: now + d2 * H, needPct: 0, minSoc: 40 + 4 * k2, boost: false,
    },
  ];
  const r = P.plan({
    ...base, now, slotStartMs: now, prices, soc: 40, trips, maxSoc: 100, reserveSoc: 0, mode: 'smart_no_extra',
  });
  // brute force
  let best = Infinity;
  for (let mask = 0; mask < 4096; mask += 1) {
    let c1 = 0; let c2 = 0; let cost = 0;
    for (let i = 0; i < 12; i += 1) {
      if (mask & (1 << i)) {
        cost += prices[i]; if (i < d1) c1 += 1; if (i < d2) c2 += 1;
      }
    }
    if (c1 >= k1 && c2 >= k2 && cost < best) best = cost;
  }
  const got = costOf(r) / 2.56;
  assert.ok(Math.abs(got - best) < 1e-6, `run ${run}: planner ${got} vs optimum ${best} (prices ${prices}, d ${d1}/${d2}, k ${k1}/${k2})`);
}
console.log('optimal on 200 random nested-deadline instances');

// --- 2. Weekend charging for the work week
{
  const now = at(2026, 10, 3, 12); // Saturday noon
  const profile = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dow, observed: 6, used: dow < 5 ? 6 : 0, regular: dow < 5, safeKwh: dow < 5 ? 3.2 : null, departFh: 7.75, returnFh: 17.5,
  }));
  const trips = P.buildTrips({
    now, timezone: tz, profile, capacityKwh: 64, reserveSoc: 30,
  });
  assert.strictEqual(trips.length, 5, 'Mon-Fri within the 7-day horizon');
  assert.strictEqual(new Date(trips[0].departMs).toISOString(), new Date(at(2026, 10, 5, 7, 45)).toISOString());
  // Known prices: Sat 12:00 - Sun 24:00 cheap (0.10), expected weekdays 0.30, weekend nights 0.08
  const knownHours = 36;
  const prices = Array.from({ length: knownHours }, () => 0.10);
  const expectedPrice = () => ({ price: 0.30, exportPrice: 0.30 });
  // Usual daily lowest 0.12 -> cheap at or under 0.108; the weekend at 0.10 is
  const cheap = P.cheapThreshold({ dailyMin: 0.12 });
  const r = P.plan({
    ...base, horizonDays: 7, now, slotStartMs: now, prices, expectedPrice, soc: 40, trips, cheapThreshold: cheap,
  });
  const lastKnownSoc = r.scheme[knownHours - 1].soc;
  console.log('weekend: SoC at end of Sunday', lastKnownSoc, 'next', r.next);
  assert.ok(lastKnownSoc >= 79, 'fills to the ceiling in the cheap weekend');
  // Same week, flat prices: only what Monday needs (reserve + 5%) by Monday
  const flat = P.plan({
    ...base, horizonDays: 7, now, slotStartMs: now, prices: prices.map(() => 0.30), expectedPrice, soc: 40, trips,
  });
  assert.strictEqual(flat.scheme[knownHours - 1].soc, 40, 'flat prices: no need to charge before Monday night');
}

// --- 3. Reserve: below 30% -> back to 30% within 8 h, even if later is cheaper
{
  const now = at(2026, 10, 5, 12);
  const prices = Array.from({ length: 24 }, (_, i) => (i < 8 ? 0.30 - i * 0.01 : 0.05));
  const r = P.plan({
    ...base, now, slotStartMs: now, prices, soc: 22, trips: [],
  });
  const soc8 = r.scheme[7].soc;
  assert.ok(soc8 >= 30, `reserve reached within 8 h (${soc8})`);
  assert.deepStrictEqual(chargedSlots(r).filter((i) => i < 8), [6, 7], 'cheapest two slots of the window');
}

// --- 4. Floor: charge now
{
  const now = at(2026, 10, 5, 12);
  const prices = Array.from({ length: 24 }, (_, i) => (i === 0 ? 0.50 : 0.05));
  const r = P.plan({
    ...base, now, slotStartMs: now, prices, soc: 10, trips: [],
  });
  assert.strictEqual(r.scheme[0].duration, 60, 'charges in the expensive first slot');
}

// --- 5. Min. SoC tomorrow 90%: ceiling raised, target reached
{
  const now = at(2026, 10, 5, 12);
  const overrides = { '2026-10-06': { type: 'min', soc: 90, time: '09:00' } };
  const trips = P.buildTrips({
    now, timezone: tz, profile: [], capacityKwh: 64, reserveSoc: 30, overrides,
  });
  assert.ok(trips[0].explicit && trips[0].date === '2026-10-06', 'min SoC replaces the assumed day');
  assert.ok(trips.slice(1).every((t) => !t.explicit), 'other days: assumed driving days');
  const r = P.plan({
    ...base, horizonDays: 2, now, slotStartMs: now, prices: Array.from({ length: 36 }, () => 0.2), soc: 60, trips,
  });
  assert.strictEqual(r.next.requiredSoc, 90);
  assert.ok(r.next.plannedSoc >= 90, `min SoC planned ${r.next.plannedSoc}`);
}
// --- 5b. Min. SoC tomorrow lower than planned: less charging
{
  const now = at(2026, 10, 5, 12);
  const prof = Array.from({ length: 7 }, () => ({
    regular: true, departFh: 8, safeKwh: 19.2, returnFh: 17, observed: 10,
  }));
  const auto = P.buildTrips({
    now, timezone: tz, profile: prof, capacityKwh: 64, reserveSoc: 30,
  });
  const low = P.buildTrips({
    now, timezone: tz, profile: prof, capacityKwh: 64, reserveSoc: 30, overrides: { '2026-10-06': { type: 'min', soc: 40 } },
  });
  assert.strictEqual(auto[0].minSoc, 60, 'auto: reserve + learned need');
  assert.strictEqual(low[0].minSoc, 40, 'min SoC below the planned target');
  assert.strictEqual(low[0].needPct, auto[0].needPct, 'usage of the day stays as learned');
  assert.strictEqual(low[0].departMs, auto[0].departMs, 'learned departure time kept');
}

// --- 6. Solar surplus at the export price
{
  const now = at(2026, 10, 5, 8);
  const prices = Array.from({ length: 24 }, () => 0.25);
  const exportPrices = Array.from({ length: 24 }, () => 0.05);
  const solarKwh = Array.from({ length: 24 }, (_, i) => (i >= 3 && i <= 6 ? 3 : 0));
  const trips = [{
    departMs: now + 23 * H, returnMs: now + 23 * H, needPct: 0, minSoc: 48, boost: false,
  }];
  // Flat import tariff: nothing extra from the grid, but solar at 0.05 is well under 0.25
  const cheap = P.cheapThreshold({ dailyMin: 0.25 });
  assert.deepStrictEqual(cheap, { grid: 0.225, solar: 0.25, coming: true });
  const r = P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh, soc: 40, trips, cheapThreshold: cheap,
  });
  assert.deepStrictEqual(chargedSlots(r), [3, 4, 5, 6], 'requirement and cheap extra from solar hours only');
  assert.ok([3, 4, 5, 6].every((i) => r.scheme[i].solar));
  // Without solar the requirement (+8%) comes from the grid, nothing extra at a flat price
  const noSun = P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, soc: 40, trips,
  });
  assert.deepStrictEqual(chargedSlots(noSun), [21, 22], 'latest slots before the deadline at equal price');
}

// --- 6b. Solar surplus is power: a fixed-power charger takes the rest from the grid
{
  const now = at(2026, 10, 5, 8);
  const prices = Array.from({ length: 24 }, () => 0.25);
  const exportPrices = Array.from({ length: 24 }, () => 0.05);
  const weak = Array.from({ length: 24 }, (_, i) => (i >= 3 && i <= 6 ? 0.5 : 0)); // 500 W
  const strong = Array.from({ length: 24 }, (_, i) => (i >= 3 && i <= 6 ? 3 : 0)); // 3000 W
  const trips = [{
    departMs: now + 23 * H, returnMs: now + 23 * H, needPct: 0, minSoc: 48,
  }];
  const mixPrice = (500 / 2560) * 0.05 + (1 - 500 / 2560) * 0.25;
  // Weak sun, cheap grid only at 0.10: no extra; the requirement in the (mixed) cheapest slots
  const a = P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh: weak, soc: 40, trips, cheapThreshold: { grid: 0.1, solar: 0.25 },
  });
  assert.deepStrictEqual(chargedSlots(a), [5, 6], 'weak sun: requirement in the mixed slots, no extra');
  assert.ok(Math.abs(a.scheme[6].duration - 60) < 1 && !a.scheme[6].solarExtra, 'whole slot, needed');
  assert.ok(Math.abs(costOf(a) - 2 * 2.56 * 0.25) < 1e-6 && mixPrice < 0.25, 'cost counted at import (test helper)');
  // Solar only: a fixed-power charger cannot charge on 500 W without the grid
  const b = P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh: weak, soc: 40, trips: [], mode: 'solar_only',
  });
  assert.deepStrictEqual(chargedSlots(b), [], 'solar only, weak sun: nothing');
  const c = P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh: strong, soc: 40, trips: [], mode: 'solar_only',
  });
  assert.deepStrictEqual(chargedSlots(c), [3, 4, 5, 6], 'solar only, strong sun: the sunny slots');
  assert.ok([3, 4, 5, 6].every((i) => c.scheme[i].solarExtra && c.scheme[i].duration === 60), 'whole slots, solar extra');
  // Variable power: follows a surplus above its minimum, not below
  const v = (solarKwh) => P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh, soc: 40, trips: [], mode: 'solar_only', variablePower: true,
  });
  assert.deepStrictEqual(chargedSlots(v(weak)), [], 'variable, 500 W: under the minimum');
  const two = Array.from({ length: 24 }, (_, i) => (i >= 3 && i <= 6 ? 2 : 0)); // 2000 W
  const vr = v(two);
  assert.deepStrictEqual(chargedSlots(vr), [3, 4, 5, 6], 'variable, 2000 W');
  assert.ok([3, 4, 5, 6].every((i) => vr.scheme[i].power === 2000), 'power = surplus');
  // Allowed grid power while charging on solar (Solar only)
  const so = (extra) => P.plan({
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh: weak, soc: 40, trips: [], mode: 'solar_only', ...extra,
  });
  assert.deepStrictEqual(chargedSlots(so({ solarGridW: 1300 })), [], 'fixed: 500 W + 1300 W allowed < 2560 W');
  assert.deepStrictEqual(chargedSlots(so({ solarGridW: 2100 })), [3, 4, 5, 6], 'fixed: 500 W + 2100 W allowed >= 2560 W');
  const va = so({ solarGridW: 1000, variablePower: true });
  assert.deepStrictEqual(chargedSlots(va), [3, 4, 5, 6], 'variable: 500 W + 1000 W allowed >= 1400 W');
  assert.ok([3, 4, 5, 6].every((i) => va.scheme[i].power === 1500), `variable: surplus + allowed grid, got ${va.scheme[3].power}`);
}

// --- 7. Away until 17:00: nothing before
{
  const now = at(2026, 10, 5, 9);
  const prices = Array.from({ length: 24 }, (_, i) => (i < 8 ? 0.01 : 0.2));
  const r = P.plan({
    ...base, now, slotStartMs: now, prices, soc: 20, trips: [], atHome: false, awayUntilMs: at(2026, 10, 5, 17),
  });
  assert.ok(chargedSlots(r).every((i) => i >= 8), 'no charging while away');
}

// --- 8. Unused override and nothing-learned fallback
{
  const now = at(2026, 10, 5, 12);
  const profile = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dow, observed: 4, used: 4, regular: true, safeKwh: 3, departFh: 8, returnFh: 17,
  }));
  const t1 = P.buildTrips({
    now, timezone: tz, profile, capacityKwh: 64, reserveSoc: 30, overrides: { '2026-10-06': { type: 'unused' } },
  });
  assert.ok(!t1.some((t) => t.date === '2026-10-06'), 'unused day has no trip');
  const t2 = P.buildTrips({
    now, timezone: tz, profile: [], capacityKwh: 64, reserveSoc: 30,
  });
  assert.strictEqual(t2[0].minSoc, 35, 'not learned: reserve + default need');
  assert.strictEqual(t2[0].date, '2026-10-06', 'next 08:00');
  assert.strictEqual(t2[0].returnMs, t2[0].departMs, 'not learned: no absence assumed');
}

// --- 9. Price profile
{
  const prof = PP.createProfile();
  const entries = [];
  for (let d = 0; d < 14; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      const t = at(2026, 9, 7 + d, h);
      const dow = d % 7;
      entries.push({ time: t, price: dow >= 5 ? 0.10 : 0.30, exportPrice: 0.05 });
    }
  }
  PP.learn(prof, entries, tz);
  const sat = PP.expected(prof, at(2026, 10, 3, 12), tz);
  const mon = PP.expected(prof, at(2026, 10, 5, 12), tz);
  assert.ok(Math.abs(sat.price - 0.10) < 1e-9 && Math.abs(mon.price - 0.30) < 1e-9, `${sat.price} ${mon.price}`);
  PP.learn(prof, entries, tz); // same entries again: ignored
  assert.ok(Math.abs(PP.expected(prof, at(2026, 10, 5, 12), tz).price - 0.30) < 1e-9);
  // Level: known Monday noon 6 ct above the profile, fading out over 3 days
  const nowMs = at(2026, 10, 5, 12);
  const lvl = PP.level(prof, [{ time: nowMs, price: 0.36, exportPrice: 0.05 }], tz, nowMs);
  assert.ok(Math.abs(lvl.import - 0.06) < 1e-9 && Math.abs(lvl.export) < 1e-9, JSON.stringify(lvl));
  const shiftAt = (d) => PP.expected(prof, nowMs + d * 24 * H, tz, lvl).price - PP.expected(prof, nowMs + d * 24 * H, tz).price;
  assert.ok(Math.abs(shiftAt(0) - 0.06) < 1e-9 && Math.abs(shiftAt(1.5) - 0.03) < 1e-9 && Math.abs(shiftAt(3)) < 1e-9 && Math.abs(shiftAt(5)) < 1e-9, 'fades out');
  assert.ok(Math.abs(PP.expected(prof, at(2026, 10, 3, 12), tz, { import: 0.06, export: 0, nowMs: at(2026, 10, 3, 12) }).price - 0.16) < 1e-9, 'additive: weekend spread kept');
}

{
  const now = at(2026, 10, 5, 12);
  const thin = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dow, observed: 1, used: 1, regular: false, safeKwh: 3,
  }));
  const t = P.buildTrips({
    now, timezone: tz, profile: thin, capacityKwh: 64, reserveSoc: 30,
  });
  assert.strictEqual(t.length, 7, 'thin profile: assumed driving day every day');
  assert.ok(Math.abs(t[0].minSoc - (30 + (3 / 64) * 100)) < 1e-9, 'uses the little that was learned');
}
{
  const now = at(2026, 10, 5, 12);
  const t = P.buildTrips({
    now, timezone: tz, profile: [], capacityKwh: 64, reserveSoc: 30, overrides: { '2026-10-06': { type: 'min', soc: 100, time: '08:00' } },
  });
  const r = P.plan({
    ...base, horizonDays: 7, now, slotStartMs: now, prices: Array.from({ length: 36 }, () => 0.2), soc: 75, trips: t,
  });
  assert.ok(r.next.plannedSoc >= 100, 'min SoC above the daily maximum is reached');
  assert.ok(Math.max(...r.socTrajectory.filter((x) => x.t >= r.next.departMs + 24 * 3600 * 1000).map((x) => x.soc)) <= 100 - t[0].needPct + 0.5, 'no charging above what the trip leaves');
}
// --- 9. Cheap charging to the maximum, per situation (no trips: only the cheap extra)
{
  // Real daily lowest prices, BudgetThuis NL all-in, 2026-09-12..26 (15 days; the last 14 are kept)
  const real = [0.345, 0.31, 0.322, 0.17, 0.245, 0.16, 0.128, 0.126, 0.124, 0.178, 0.27, 0.191, 0.175, 0.17, 0.15];
  const prof = PP.createProfile();
  real.forEach((v, k) => PP.addDailyMins(prof, [{ time: at(2026, 9, 12 + k, 13), price: v }, { time: at(2026, 9, 12 + k, 19), price: v + 0.2 }], tz));
  assert.strictEqual(PP.dailyMinDays(prof), 14, 'keeps 14 days');
  const typ = PP.typicalDailyMin(prof);
  assert.ok(Math.abs(typ - 0.1725) < 1e-9, `usual daily lowest ${typ}`);
  const nl = P.cheapThreshold({ dailyMin: typ });
  assert.ok(Math.abs(nl.grid - 0.15525) < 1e-9 && nl.solar === typ, `NL threshold ${JSON.stringify(nl)}`);
  assert.strictEqual(PP.typicalDailyMin({
    dailyMin: {
      a: 0.1, b: 0.2, c: 0.3, d: 0.4,
    },
  }), null, 'fewer than 5 days: not yet');
  // learn() builds it from the published prices; quarter hours averaged per hour first
  const lp = PP.createProfile();
  const q0 = at(2026, 9, 20, 0);
  const quarters = Array.from({ length: 96 }, (_, k) => {
    if (k >= 52 && k < 56) return k % 2 ? 0.20 : 0.10; // 13:00 hour: 0.10/0.20 quarters
    return 0.30;
  });
  PP.learn(lp, quarters.map((price, k) => ({ time: q0 + k * 15 * 60 * 1000, price })), tz);
  assert.deepStrictEqual(Object.keys(lp.dailyMin), ['2026-09-20']);
  assert.ok(Math.abs(lp.dailyMin['2026-09-20'] - 0.15) < 1e-9, 'hour average, not the lowest quarter');
  // Prices already learned into the profile still give their day's lowest (no double learning)
  const old = PP.createProfile();
  const e1 = Array.from({ length: 24 }, (_, h) => ({ time: at(2026, 9, 21, h), price: h === 13 ? 0.12 : 0.3 }));
  PP.learn(old, e1, tz);
  const ewaBefore = JSON.stringify(old.import);
  old.dailyMin = {};
  PP.learn(old, e1, tz);
  assert.ok(Math.abs(old.dailyMin['2026-09-21'] - 0.12) < 1e-9, 'daily lowest from already learned prices');
  assert.strictEqual(JSON.stringify(old.import), ewaBefore, 'profile not learned twice');
  // Only the rest of a day known: does not count
  const part = PP.createProfile();
  PP.learn(part, Array.from({ length: 5 }, (_, h) => ({ time: at(2026, 9, 22, 19 + h), price: 0.4 })), tz);
  assert.deepStrictEqual(part.dailyMin, {}, 'partial day skipped');
  assert.deepStrictEqual(P.cheapThreshold({ dailyMin: null }), { grid: 0, solar: 0, coming: true }, 'not learned: only free energy');

  const now = at(2026, 10, 3, 0); // Saturday
  const pct = (r) => Object.values(r.scheme).reduce((a, s) => a + (s.duration / 60) * 4, 0); // 4%/h
  const run = (o) => P.plan({
    ...base, horizonDays: 3, now, slotStartMs: now, soc: 50, trips: [], ...o,
  });
  const dear = () => ({ price: 0.30, exportPrice: 0.30 });

  // NL sunny day at 15 ct, nothing cheaper coming: fill to the max now
  let r = run({ prices: Array(24).fill(0.15), expectedPrice: dear, cheapThreshold: nl });
  assert.ok(pct(r) >= 29.9, `NL 15 ct: to the max now (${pct(r)}%)`);
  r = run({ prices: Array(24).fill(0.17), expectedPrice: () => ({ price: 0.17, exportPrice: 0.17 }), cheapThreshold: nl });
  assert.strictEqual(pct(r), 0, 'NL 17 ct: around the usual daily lowest, not extra');
  r = run({
    prices: Array(24).fill(0.17), expectedPrice: dear, cheapThreshold: nl, horizonDays: 7,
  });
  assert.ok(pct(r) >= 29.9, `NL 17 ct, coming days 30 ct: clearly cheaper than later (${pct(r)}%)`);

  // Saturday 14 ct, Sunday afternoon 9 ct known: wait for Sunday
  const satSun = Array.from({ length: 48 }, (_, i) => (i >= 36 && i < 44 ? 0.09 : 0.14));
  r = run({ prices: satSun, cheapThreshold: nl });
  assert.ok(pct(r) >= 29.9 && chargedSlots(r).every((i) => i >= 36 && i < 44), `waits for the cheaper Sunday: ${chargedSlots(r)}`);

  // Unknown days expected a bit cheaper (13 ct vs 15 ct now): not clearly cheaper with 20% margin
  r = run({ prices: Array(24).fill(0.15), expectedPrice: () => ({ price: 0.13, exportPrice: 0.13 }), cheapThreshold: nl });
  assert.ok(pct(r) >= 29.9, `expected 13 ct: charge now (${pct(r)}%)`);
  r = run({ prices: Array(24).fill(0.15), expectedPrice: () => ({ price: 0.10, exportPrice: 0.10 }), cheapThreshold: nl });
  assert.strictEqual(pct(r), 0, 'expected 10 ct: waits');

  // DAP forecast (10% margin): 14 ct forecast vs 15 ct published -> now; 12 ct forecast -> wait
  const fc = (p) => [...Array(12).fill(0.15), ...Array(12).fill(p)];
  r = run({
    prices: fc(0.14), certainSlots: 12, expectedPrice: dear, cheapThreshold: nl,
  });
  assert.ok(chargedSlots(r).some((i) => i < 12), `forecast 14 ct: charges in the published hours ${chargedSlots(r)}`);
  r = run({
    prices: fc(0.12), certainSlots: 12, expectedPrice: dear, cheapThreshold: nl,
  });
  assert.ok(chargedSlots(r).every((i) => i >= 12), `forecast 12 ct: waits for it ${chargedSlots(r)}`);

  // Flat tariff: the daily lowest is the tariff: nothing extra
  const flat = P.cheapThreshold({ dailyMin: 0.25 });
  r = run({ prices: Array(24).fill(0.25), expectedPrice: () => ({ price: 0.25, exportPrice: 0.25 }), cheapThreshold: flat });
  assert.strictEqual(pct(r), 0, 'flat tariff: no extra');

  // Day/night tariff: the night is the daily lowest: nothing extra (trips charge at night anyway)
  const dn = P.cheapThreshold({ dailyMin: 0.20 });
  const dnPrice = (i) => (i % 24 < 7 || i % 24 >= 23 ? 0.20 : 0.30);
  const dnExpected = (ms) => ({ price: dnPrice(Math.round((ms - now) / H)), exportPrice: 0.05 });
  r = run({ prices: Array.from({ length: 24 }, (_, i) => dnPrice(i)), expectedPrice: dnExpected, cheapThreshold: dn });
  assert.strictEqual(pct(r), 0, 'day/night: no extra');

  // Fixed price setting, and off
  r = run({ prices: Array(24).fill(0.16), expectedPrice: () => ({ price: 0.25, exportPrice: 0.25 }), cheapThreshold: P.cheapThreshold({ mode: 'fixed', price: 0.16, dailyMin: 0.25 }) });
  assert.ok(pct(r) >= 29.9, 'fixed 16 ct');
  r = run({ prices: Array(24).fill(-0.05), cheapThreshold: P.cheapThreshold({ mode: 'off' }) });
  assert.strictEqual(pct(r), 0, 'off: not even negative prices');

  // Negative price: always cheap, even with a flat tariff
  r = run({ prices: Array.from({ length: 24 }, (_, i) => (i === 5 ? -0.02 : 0.25)), cheapThreshold: flat });
  assert.deepStrictEqual(chargedSlots(r), [5], 'negative price hour');

  // Coming days: the current slot is judged against the same days as the rest (Prod 2026-10-22:
  // a dear 6th day made only the current slot cheap enough, so it charged slot after slot)
  const sixth = (ms) => ({ price: ms - now >= 6 * 24 * H ? 0.60 : 0.21, exportPrice: 0.21 });
  r = run({
    prices: Array(24).fill(0.20), expectedPrice: sixth, cheapThreshold: nl, horizonDays: 7,
  });
  assert.deepStrictEqual(chargedSlots(r), [], 'current slot not cheap through one more day');

  // Cheap extra not for a few percent under the maximum (a car report lower than estimated)
  r = run({ prices: Array(24).fill(0.10), cheapThreshold: nl, soc: 78 });
  assert.strictEqual(pct(r), 0, '2% under the maximum: no top-up');
  r = run({ prices: Array(24).fill(0.10), cheapThreshold: nl, soc: 76 });
  assert.ok(pct(r) >= 3.9, `4% under the maximum: to the max (${pct(r)}%)`);

  // Coming days cheap only while the car is away (trips 08-18): not what charging later costs
  const awayDays = [1, 2, 3, 4, 5, 6].map((d) => ({
    departMs: now + (d * 24 + 8) * H, returnMs: now + (d * 24 + 18) * H, needPct: 2, minSoc: 32,
  }));
  const dayCheap = (ms) => {
    const h = Math.round((ms - now) / H) % 24;
    return { price: h >= 9 && h < 17 ? 0.10 : 0.30, exportPrice: 0.05 };
  };
  r = run({
    prices: Array(24).fill(0.20), expectedPrice: dayCheap, cheapThreshold: nl, horizonDays: 7, trips: awayDays,
  });
  assert.ok(chargedSlots(r).some((i) => i < 24), `cheap hours away do not count: charges today ${chargedSlots(r)}`);

  // Coming days with one sunny hour (5 ct export price), enough for a day's small trip: charging
  // later costs 5 ct, not 30 ct, so no grid extra now at 20 ct
  const sunHour = Array.from({ length: 7 * 24 }, (_, i) => (i >= 24 && i % 24 === 12 ? 3 : 0));
  const afternoon = [1, 2, 3, 4, 5, 6].map((d) => ({
    departMs: now + (d * 24 + 16) * H, returnMs: now + (d * 24 + 16) * H, needPct: 3, minSoc: 33,
  }));
  r = run({
    prices: Array(24).fill(0.20), expectedPrice: () => ({ price: 0.30, exportPrice: 0.05 }), solarKwh: sunHour, cheapThreshold: nl, horizonDays: 7, trips: afternoon,
  });
  assert.ok(chargedSlots(r).every((i) => i >= 24), `solar counts in what charging later costs: ${chargedSlots(r)}`);
}
// Days driven only sometimes: their expected energy leaves, no requirement, no absence
{
  const now = at(2026, 10, 5, 0); // Monday
  const some = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dow, observed: 3, used: dow === 3 ? 2 : 0, share: dow === 3 ? 2 / 3 : 0, regular: false, needKwh: 19.2, safeKwh: 25.6,
  }));
  const t = P.buildTrips({
    now, timezone: tz, profile: some, capacityKwh: 64, reserveSoc: 30,
  });
  assert.strictEqual(t.length, 1, `one soft trip (Thursday): ${JSON.stringify(t)}`);
  assert.ok(t[0].soft && t[0].returnMs === t[0].departMs && Math.abs(t[0].needPct - 20) < 1e-9, 'share x typical need');
  const r = P.plan({
    ...base, horizonDays: 7, now, slotStartMs: now, prices: Array(24).fill(0.3), soc: 60, trips: t,
  });
  assert.strictEqual(r.next, null, 'not a departure');
  assert.deepStrictEqual(r.trips, [], 'not returned as a trip');
  assert.deepStrictEqual(chargedSlots(r), [], 'no requirement');
  const after = r.socTrajectory.find((x) => x.t > t[0].departMs);
  assert.ok(Math.abs(after.soc - 40) < 1e-9, `expected energy leaves: ${after.soc}`);
}
console.log('all phase 3 tests passed');

// --- Energy mode: grid kWh to charge, full at the departure, no floor or reserve
{
  const now = at(2026, 10, 5, 0);
  const prices = Array.from({ length: 12 }, (_, i) => (i === 3 || i === 4 ? 0.1 : 0.3));
  const trip = {
    departMs: now + 8 * H, returnMs: now + 8 * H, needPct: 5, minSoc: 35,
  };
  const run = (energyKwh) => P.plan({
    ...base, now, slotStartMs: now, prices, soc: 0, energyKwh, trips: [trip], mode: 'smart_no_extra',
  });
  let r = run(5.12); // 2 slots of 2.56 kWh
  assert.strictEqual(r.startSoc, 72, 'virtual SoC: maxSoc less the energy');
  assert.deepStrictEqual(chargedSlots(r), [3, 4], 'energy in the cheapest slots, no floor right away');
  assert.strictEqual(r.next.requiredSoc, 80, 'full at the departure');
  r = run(0);
  assert.deepStrictEqual(chargedSlots(r), [], 'nothing left to charge');
  assert.strictEqual(trip.minSoc, 35, 'input trips not changed');
  console.log('energy mode planner tests passed');
}

// --- Ceiling after a trip, covered days, typical day cost, bridged gaps
{
  const now = at(2026, 10, 27, 0);
  // Above maxSoc now: may stay, not be topped up again after a trip.
  const prices = Array.from({ length: 24 }, (_, h) => (h >= 4 && h < 9 ? 0.1 : 0.3));
  let r = P.plan({
    ...base,
    now,
    slotStartMs: now,
    prices,
    soc: 96,
    maxSoc: 90,
    trips: [{
      departMs: now + 2 * H, returnMs: now + 2 * H, needPct: 13, minSoc: 0, soft: true,
    }],
    cheapThreshold: { grid: 0.2, solar: 0.2, coming: false },
  });
  const after = r.socTrajectory.slice(3).map((s) => s.soc);
  assert.ok(Math.max(...after) <= 90 + 1e-6, `topped up to ${Math.max(...after)} after the trip`);
  assert.ok(Math.max(...after) > 89, 'cheap extra up to maxSoc');

  // Enough for the coming days: nothing charged ahead on the coming prices.
  const day = Array.from({ length: 24 }, (_, h) => (h >= 11 && h < 14 ? 0.19 : 0.3));
  const ahead = (extra) => P.plan({
    ...base,
    now,
    slotStartMs: now,
    prices: day,
    soc: 83,
    maxSoc: 90,
    horizonDays: 5,
    expectedPrice: () => ({ price: 0.3, exportPrice: 0.1 }),
    trips: [{
      departMs: now + 34 * H, returnMs: now + 34 * H, needPct: 6, minSoc: 36,
    }],
    cheapThreshold: { grid: 0.1, solar: 0.1, coming: true },
    ...extra,
  });
  assert.ok(chargedSlots(ahead({})).length > 0, 'charged ahead without cover');
  assert.deepStrictEqual(chargedSlots(ahead({ coverUntilMs: now + 72 * H })), [], 'covered: not charged ahead');
  r = ahead({
    coverUntilMs: now + 72 * H,
    soc: 40,
    trips: [{
      departMs: now + 34 * H, returnMs: now + 34 * H, needPct: 20, minSoc: 50,
    }],
  });
  assert.ok(chargedSlots(r).length > 0, 'not covered: charged ahead');
  assert.deepStrictEqual(chargedSlots(ahead({ typicalDayCost: () => 0.2 })), [], 'coming days usually cost 0.20: 0.19 not cheap enough');

  // Hourly prices on quarters: no gap at the start of a partly used hour.
  const q = Array.from({ length: 96 }, (_, i) => {
    if (i >= 8 && i < 12) return 0.18;
    return i >= 12 && i < 16 ? 0.2 : 0.3;
  });
  const quarters = (gapPrice) => P.plan({
    ...base,
    intervalMin: 15,
    now,
    slotStartMs: now,
    prices: q.map((p, i) => (i === 12 ? gapPrice : p)),
    soc: 40,
    trips: [{
      departMs: now + 10 * H, returnMs: now + 10 * H, needPct: 0, minSoc: 47,
    }],
    cheapThreshold: null,
  });
  assert.deepStrictEqual(chargedSlots(quarters(0.2)), [8, 9, 10, 11, 12, 13, 14], 'session bridged');
  assert.deepStrictEqual(chargedSlots(quarters(0.6)), [8, 9, 10, 11, 13, 14, 15], 'dear gap: not bridged');
  console.log('ceiling, cover, typical day cost and gap tests passed');
}

// --- Typical day cost from the daily lows
{
  const prof = PP.createProfile();
  const entries = [];
  for (let d = 0; d < 6; d += 1) {
    const mid = at(2026, 10, 10 + d, 0);
    for (let h = 0; h < 24; h += 1) entries.push({ time: mid + h * H, price: h < 2 ? 0.1 + d * 0.01 : 0.3 });
  }
  PP.learn(prof, entries, tz);
  assert.strictEqual(Object.keys(prof.dailyLows).length, 6);
  assert.ok(Math.abs(PP.typicalDayCost(prof, 2) - 0.125) < 1e-9, `2 h: ${PP.typicalDayCost(prof, 2)}`);
  assert.ok(Math.abs(PP.typicalDayCost(prof, 4) - 0.2125) < 1e-9, `4 h: ${PP.typicalDayCost(prof, 4)}`);
  assert.strictEqual(PP.typicalDayCost(PP.createProfile(), 2), null, 'too few days');
  console.log('typical day cost tests passed');
}

// --- Trips: a day on expected prices has its usual dips
{
  const now = at(2026, 10, 27, 0);
  const day = Array.from({ length: 24 }, (_, h) => (h >= 11 && h < 14 ? 0.19 : 0.3));
  const trip = (extra) => P.plan({
    ...base,
    now,
    slotStartMs: now,
    prices: day,
    soc: 40,
    maxSoc: 90,
    horizonDays: 3,
    expectedPrice: () => ({ price: 0.3, exportPrice: 0.1 }),
    trips: [{
      departMs: now + 34 * H, returnMs: now + 34 * H, needPct: 10, minSoc: 48,
    }],
    cheapThreshold: null,
    ...extra,
  });
  assert.ok(chargedSlots(trip({})).length > 0, 'flat expected prices: charged today at 0.19');
  assert.deepStrictEqual(chargedSlots(trip({ typicalDayCost: () => 0.15 })), [], 'tomorrow usually has 0.15: not today');
  assert.ok(chargedSlots(trip({ typicalDayCost: () => 0.25 })).length > 0, 'tomorrow usually 0.25: today');
  console.log('trip typical day cost tests passed');
}

// --- A minimum SoC set by hand that the max. price blocks: a shortfall for that trip, gone without
// the max. price (checkDayReachable() then names the max. price as the reason).
{
  const now = at(2026, 11, 5, 0);
  const prices = [0.365, 0.385, 0.385, 0.385, 0.385, 0.35, 0.40, 0.47, 0.48];
  const trips = [{
    departMs: now + 7.5 * H, returnMs: now + 7.5 * H, needPct: 10, minSoc: 80, explicit: true, date: '2026-11-05',
  }];
  const o = {
    ...base, now, slotStartMs: now, prices, soc: 59, trips, maxSoc: 90,
  };
  const short = (r) => r.shortfalls.find((sf) => sf.what === 'trip' && sf.tm === trips[0].departMs);
  const capped = P.plan({ ...o, maxPrice: 0.38 });
  assert.deepStrictEqual(chargedSlots(capped), [0, 5], 'only under the max. price');
  assert.strictEqual(short(capped).missing, 13, 'short by 80 - (59 + 2 x 4)');
  assert.strictEqual(short(P.plan(o)), undefined, 'reachable without the max. price');
  console.log('min SoC above max. price tests passed');
}

// --- Solar surplus a home battery would store: the car takes only what the battery has no room
// for, and charges the rest at night when that is cheaper than the battery's value of the surplus.
{
  const now = at(2026, 11, 5, 10);
  const hourOf = (i) => (10 + i) % 24;
  const prices = Array.from({ length: 24 }, (_, i) => {
    const h = hourOf(i);
    if (h >= 17 && h < 21) return 0.40;
    return h < 7 ? 0.22 : 0.30;
  });
  const exportPrices = prices.map(() => 0.05);
  const solarKwh = prices.map((_, i) => (i >= 1 && i <= 3 ? 2.56 : 0)); // 11-14 h, full charging power
  const deficitKwh = prices.map((_, i) => (hourOf(i) >= 17 && hourOf(i) < 21 ? 2 : 0.3));
  const trips = [{
    departMs: now + 21 * H, returnMs: now + 21 * H, needPct: 12, minSoc: 62,
  }];
  const o = {
    ...base, now, slotStartMs: now, prices, exportPrices, solarKwh, deficitKwh, soc: 50, trips, variablePower: true,
  };
  const battery = (roomKwh) => ({
    capKwh: 5, effC: 0.95, effD: 0.95, cycleCost: 0, room: prices.map(() => roomKwh), store: prices.map(() => true),
  });
  const solarKwhUsed = (r) => [1, 2, 3].reduce((a, i) => a + ((r.scheme[i].power / 1000) * r.scheme[i].duration) / 60, 0);
  const none = P.plan(o);
  assert.ok(Math.abs(solarKwhUsed(none) - 7.68) < 0.05, `no battery: all from solar (${solarKwhUsed(none)})`);
  const empty = P.plan({ ...o, homeBattery: battery(5 / 0.95) });
  assert.ok(Math.abs(solarKwhUsed(empty) - (7.68 - 5 / 0.95)) < 0.05, `empty battery: only its spare surplus (${solarKwhUsed(empty)})`);
  assert.strictEqual(empty.shortfalls.length, 0, 'the trip is met at night');
  const full = P.plan({ ...o, homeBattery: battery(0) });
  assert.ok(Math.abs(solarKwhUsed(full) - 7.68) < 0.05, `full battery: all from solar (${solarKwhUsed(full)})`);
  const capped = P.plan({ ...o, homeBattery: battery(5 / 0.95), maxPrice: 0.25 });
  assert.strictEqual(capped.shortfalls.length, 0, 'the battery value is no cash price for the max. price');
  console.log('home battery solar value tests passed');
}
