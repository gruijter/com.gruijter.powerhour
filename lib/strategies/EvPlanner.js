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

// EV charge planning over several days. Every need is a requirement "SoC at least X before time
// T": each expected departure (reserve plus that day's energy, or a boost target), getting back to
// the reserve within some hours when below it, and a floor that charges right away. The cheapest
// charging that meets all of them is chosen, earliest requirement first, never above the SoC
// ceiling. Beyond the published prices the expected prices are used, so a cheap weekend is used
// for the work week. Only the slots with published prices are executed; the rest of the plan only
// decides how much to charge now.
//
// Solar surplus is charged at the export price (what it would earn exported), the grid part of a
// slot at the import price: from 2027 the export price in NL drops well below import, and the
// DAP device already delivers both.
//
// Pure. Units inside: SoC percentage points of the battery ("pct"), battery side.

const TimeHelpers = require('../helpers/TimeHelpers');
const EvUsageModel = require('./EvUsageModel');

const HORIZON_DAYS = 7;
// Charge beyond the requirements only when clearly cheap: at or below zero, or below this share
// of the median cost of charging in the horizon.
const OPPORTUNISTIC_SHARE = 0.5;
const DEFAULT_TRIP_HOURS = 9; // away time when no return time is learned
const DEFAULT_NEED_PCT = 5; // energy of a planned trip when none is learned
// A weekday seen fewer times than this is not learned yet: the fallback target applies to it.
const MIN_OBSERVED = 3;

// ─── Trips from the usage profile ─────────────────────────────────────────────

// UTC ms of a local fractional hour on the local day that starts at midnightMs.
const localTimeMs = (midnightMs, fh, timezone) => {
  let t = midnightMs + fh * 3600 * 1000;
  // Correct once for a DST change between midnight and fh.
  const got = EvUsageModel.toLocalFractionalHour(new Date(t), timezone);
  t += (fh - got) * 3600 * 1000;
  return Math.round(t);
};

const hhmmToFh = (hhmm) => {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm.trim())) return null;
  const [h, m] = hhmm.trim().split(':').map(Number);
  return h + m / 60;
};

/**
 * Expected trips for today and the coming days.
 *
 * @param {object} o
 * @param {number} o.now - ms
 * @param {string} o.timezone
 * @param {Array} o.profile - EvUsageModel.getProfile()
 * @param {number} o.capacityKwh
 * @param {number} o.reserveSoc
 * @param {Array<string>} [o.manualTimes] - HH:MM per weekday (0=Monday), '' = learned
 * @param {object} [o.overrides] - by local date YYYY-MM-DD: {type:'unused'} | {type:'boost', soc, time}
 * @param {number|null} [o.fallbackTargetSoc] - for weekdays not learned yet: charge to this by 08:00
 * @returns {Array<{departMs, returnMs, needPct, minSoc, boost}>}
 */
const buildTrips = ({
  now, timezone, profile, capacityKwh, reserveSoc, manualTimes = [], overrides = {}, fallbackTargetSoc = null,
}) => {
  const trips = [];
  let midnight = TimeHelpers.getLocalMidnightUTC(new Date(now), timezone).getTime();
  for (let d = 0; d <= HORIZON_DAYS; d += 1) {
    if (d > 0) midnight = TimeHelpers.getLocalMidnightUTC(new Date(midnight + 36 * 3600 * 1000), timezone).getTime();
    const date = EvUsageModel.localDateStr(new Date(midnight + 12 * 3600 * 1000), timezone);
    const dow = EvUsageModel.getDowLocal(new Date(midnight + 12 * 3600 * 1000), timezone);
    const day = (profile && profile[dow]) || {};
    const override = overrides[date] || null;
    const manualFh = hhmmToFh(manualTimes[dow]);
    if (override && override.type === 'unused') continue;

    let trip = null;
    let departFh = 8;
    if (manualFh !== null) departFh = manualFh;
    else if (typeof day.departFh === 'number') ({ departFh } = day);
    const needPct = typeof day.safeKwh === 'number' && capacityKwh > 0 ? (day.safeKwh / capacityKwh) * 100 : DEFAULT_NEED_PCT;
    if (override && override.type === 'boost') {
      const fh = hhmmToFh(override.time) !== null ? hhmmToFh(override.time) : departFh;
      const soc = Math.min(100, Number(override.soc) || 100);
      // A long trip: assume it uses the battery down to the reserve.
      trip = {
        departFh: fh, needPct: Math.max(0, soc - reserveSoc), minSoc: soc, boost: true, explicit: true,
      };
    } else if (day.regular || manualFh !== null) {
      trip = {
        departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct), boost: false,
      };
    } else if (!(day.observed >= MIN_OBSERVED) && typeof fallbackTargetSoc === 'number') {
      // This weekday is not learned yet: a target by 08:00, as before learning existed.
      trip = {
        departFh: 8, needPct: 0, minSoc: fallbackTargetSoc, boost: false, explicit: true,
      };
    }
    if (!trip) continue;
    const departMs = localTimeMs(midnight, trip.departFh, timezone);
    if (departMs <= now) continue;
    let returnMs;
    if (typeof day.returnFh === 'number' && day.returnFh > trip.departFh && !trip.boost) {
      returnMs = localTimeMs(midnight, day.returnFh, timezone);
    } else {
      returnMs = departMs + DEFAULT_TRIP_HOURS * 3600 * 1000;
    }
    if (trip.needPct === 0) returnMs = departMs; // fallback target: no absence assumed
    trips.push({
      departMs, returnMs, needPct: trip.needPct, minSoc: trip.minSoc, boost: trip.boost, explicit: !!trip.explicit, date,
    });
  }
  return trips;
};

// ─── Planner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {number} o.now - ms
 * @param {number} o.slotStartMs - start of the current price slot
 * @param {number} o.intervalMin - price slot length
 * @param {Array<number>} o.prices - known import prices from the current slot on
 * @param {Array<number>} [o.exportPrices]
 * @param {function(number):{price:number|null, exportPrice:number|null}} [o.expectedPrice] - beyond known
 * @param {Array<number>} [o.solarKwh] - expected surplus (grid side, kWh) per slot
 * @param {number} o.soc - current SoC (%)
 * @param {number} o.capacityKwh
 * @param {number} o.chargePowerW
 * @param {number} o.efficiency - grid kWh to battery kWh
 * @param {boolean} o.atHome
 * @param {number|null} [o.awayUntilMs] - when away: expected return
 * @param {Array} o.trips - buildTrips()
 * @param {number} o.reserveSoc
 * @param {number} o.reserveHours
 * @param {number} o.floorSoc
 * @param {number} o.maxSoc
 * @param {string} o.mode - 'smart' | 'solar_only' | 'fast' | 'off'
 * @param {boolean} [o.variablePower]
 * @param {number} [o.horizonDays]
 */
const plan = (o) => {
  const intervalMs = o.intervalMin * 60 * 1000;
  const horizonDays = o.horizonDays || HORIZON_DAYS;
  const n = Math.ceil((horizonDays * 24 * 60) / o.intervalMin);
  const cap = o.capacityKwh > 0 ? o.capacityKwh : 50;
  const eff = o.efficiency > 0 ? o.efficiency : 0.88;
  const pctPerGridKwh = (eff / cap) * 100;
  const known = o.prices.length;
  const exportPrices = o.exportPrices || [];
  const trips = (o.trips || []).filter((t) => t.departMs > o.now);

  // Price fallback beyond the known horizon when nothing is learned: the known average.
  const knownAvg = known ? o.prices.reduce((a, b) => a + b, 0) / known : 0.25;
  const knownExportAvg = exportPrices.length ? exportPrices.reduce((a, b) => a + b, 0) / exportPrices.length : knownAvg;

  // --- Slots
  const slots = [];
  for (let i = 0; i < n; i += 1) {
    const startMs = o.slotStartMs + i * intervalMs;
    const endMs = startMs + intervalMs;
    const from = Math.max(startMs, o.now);
    const hours = Math.max(0, (endMs - from) / 3600000);
    let price;
    let exportPrice;
    if (i < known) {
      price = o.prices[i];
      exportPrice = typeof exportPrices[i] === 'number' ? exportPrices[i] : price;
    } else {
      const e = o.expectedPrice ? o.expectedPrice(startMs) : null;
      price = e && typeof e.price === 'number' ? e.price : knownAvg;
      exportPrice = e && typeof e.exportPrice === 'number' ? e.exportPrice : knownExportAvg;
    }
    let available = hours > 0;
    const awayUntil = typeof o.awayUntilMs === 'number' ? o.awayUntilMs : o.now + 3600 * 1000;
    if (!o.atHome && startMs < awayUntil) available = false;
    trips.forEach((t) => {
      if (endMs > t.departMs && startMs < t.returnMs) available = false;
    });
    const maxPct = available ? (o.chargePowerW / 1000) * hours * pctPerGridKwh : 0;
    const solarPct = Math.min(maxPct, Math.max(0, (o.solarKwh && o.solarKwh[i]) || 0) * pctPerGridKwh);
    slots.push({
      i,
      startMs,
      endMs,
      hours,
      price,
      exportPrice,
      maxPct,
      solarPct,
      known: i < known,
      solarUsed: 0,
      gridUsed: 0,
    });
  }

  // --- Consumption: each trip's energy leaves at its departure
  const consumedAfterSlot = new Array(n).fill(0); // consumption that happened by the end of slot i
  trips.forEach((t) => {
    for (let i = 0; i < n; i += 1) if (slots[i].endMs > t.departMs) consumedAfterSlot[i] += t.needPct;
  });

  // Consumption by trips that left before tm (not the one leaving at tm).
  const consumedBefore = (tm) => trips.filter((t) => t.departMs < tm).reduce((a, t) => a + t.needPct, 0);

  // SoC ceiling per slot: raised to a target the user set (boost, or the target SoC while a weekday
  // is not learned yet) until that trip leaves, and after it to what the trip leaves of it.
  const ceiling = slots.map((s) => {
    let c = o.maxSoc;
    trips.forEach((t) => {
      if (t.boost || t.explicit) {
        // up to the target before it leaves, and what is left of it after
        c = Math.max(c, s.endMs <= t.departMs ? t.minSoc : t.minSoc - t.needPct);
      }
    });
    return Math.max(c, o.soc); // never force a discharge
  });

  const socAfter = () => {
    const out = new Array(n);
    let charged = 0;
    for (let i = 0; i < n; i += 1) {
      charged += slots[i].solarUsed + slots[i].gridUsed;
      out[i] = o.soc + charged - consumedAfterSlot[i];
    }
    return out;
  };

  // Room to add in slot i without the SoC passing the ceiling later on (until the next trip
  // takes energy out, it only goes up).
  const headroom = (i, soc) => {
    let room = Infinity;
    for (let j = i; j < n; j += 1) room = Math.min(room, ceiling[j] - soc[j]);
    return Math.max(0, room);
  };

  const costOf = (s, part) => (part === 'solar' ? s.exportPrice : s.price) / eff; // per grid kWh -> per battery kWh
  const allowGrid = o.mode !== 'solar_only';

  // Add up to `amount` pct at the cheapest usable capacity in slots ending by deadlineMs.
  const fill = (amount, deadlineMs, { earliestFirst = false, gridAllowed = allowGrid, maxCost = Infinity } = {}) => {
    let left = amount;
    const blocked = new Set();
    while (left > 1e-6) {
      const soc = socAfter();
      let best = null;
      for (const s of slots) {
        if (s.endMs > deadlineMs) break;
        const parts = [['solar', s.solarPct - s.solarUsed]];
        if (gridAllowed) parts.push(['grid', s.maxPct - s.solarPct - s.gridUsed]);
        for (const [part, free] of parts) {
          if (free > 1e-6 && !blocked.has(`${s.i}${part}`)) {
            const cost = costOf(s, part);
            if (cost <= maxCost) {
              const key = earliestFirst ? s.i : cost;
              // Equal cost: the latest slot, so the battery sits less long at a high SoC and
              // later price updates can still move it (earliest-first: the earliest).
              const later = earliestFirst ? s.i < best?.s.i : s.i > best?.s.i;
              if (!best || key < best.key || (key === best.key && later)) {
                best = {
                  s, part, free, key,
                };
              }
            }
          }
        }
      }
      if (!best) break;
      const room = headroom(best.s.i, soc);
      const add = Math.min(left, best.free, room);
      if (add <= 1e-6) {
        blocked.add(`${best.s.i}${best.part}`);
        continue;
      }
      if (best.part === 'solar') best.s.solarUsed += add;
      else best.s.gridUsed += add;
      left -= add;
    }
    return amount - left; // added
  };

  const shortfalls = [];
  const lastMs = o.slotStartMs + n * intervalMs;

  if (o.mode === 'off') {
    // nothing
  } else if (o.mode === 'fast') {
    fill(Math.max(...ceiling) - o.soc, lastMs, { earliestFirst: true, gridAllowed: true });
  } else {
    // Floor: straight away, whatever the price.
    if (o.soc < o.floorSoc) fill(o.floorSoc - o.soc, lastMs, { earliestFirst: true, gridAllowed: true });

    // Requirements, earliest first.
    const reqs = trips.map((t) => ({ tm: t.departMs, soc: t.minSoc, what: 'trip' }));
    if (o.soc < o.reserveSoc) reqs.push({ tm: o.now + o.reserveHours * 3600 * 1000, soc: o.reserveSoc, what: 'reserve' });
    reqs.sort((a, b) => a.tm - b.tm);
    reqs.forEach((r) => {
      const soc = socAfter();
      // SoC just before tm: after the last slot that ends by then
      let idx = -1;
      for (let i = 0; i < n && slots[i].endMs <= r.tm; i += 1) idx = i;
      const before = idx >= 0 ? soc[idx] + (consumedAfterSlot[idx] - consumedBefore(r.tm)) : o.soc;
      const need = r.soc - before;
      if (need > 1e-6) {
        const added = fill(need, r.tm);
        if (added < need - 0.5) shortfalls.push({ ...r, missing: Math.round(need - added) });
      }
    });

    // Clearly cheap energy on top, up to the ceiling.
    if (o.mode === 'smart') {
      const costs = slots.filter((s) => s.maxPct > 0).map((s) => costOf(s, 'grid')).sort((a, b) => a - b);
      const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
      const threshold = Math.max(0, median * OPPORTUNISTIC_SHARE);
      fill(Infinity, lastMs, { maxCost: threshold });
    } else if (o.mode === 'solar_only') {
      fill(Infinity, lastMs, { gridAllowed: false });
    }
  }

  // --- Output: the executable part (known prices)
  const soc = socAfter();
  const scheme = {};
  for (let i = 0; i < known; i += 1) {
    const s = slots[i];
    const pct = s.solarUsed + s.gridUsed;
    const gridKwh = pct / pctPerGridKwh;
    const minutes = s.hours * 60;
    let duration = 0;
    let power = 0;
    if (gridKwh > 1e-4 && minutes > 0) {
      duration = Math.min(minutes, (gridKwh / (o.chargePowerW / 1000)) * 60);
      power = o.variablePower ? Math.round((gridKwh / s.hours) * 1000) : o.chargePowerW;
      if (o.variablePower) duration = minutes;
      duration = Math.max(1, Math.round(duration));
    }
    scheme[i] = {
      power,
      duration,
      soc: Math.max(0, Math.min(100, Math.round(soc[i]))),
      price: s.price,
      exportPrice: s.exportPrice,
      solar: s.solarUsed > 1e-6,
    };
  }

  const next = trips[0] || null;
  let plannedAtNext = null;
  if (next) {
    let idx = -1;
    for (let i = 0; i < n && slots[i].endMs <= next.departMs; i += 1) idx = i;
    plannedAtNext = idx >= 0 ? soc[idx] + (consumedAfterSlot[idx] - consumedBefore(next.departMs)) : o.soc;
  }
  return {
    scheme,
    trips,
    shortfalls,
    next: next ? {
      departMs: next.departMs, requiredSoc: Math.round(next.minSoc), plannedSoc: Math.round(plannedAtNext), boost: next.boost,
    } : null,
    socTrajectory: soc.map((v, i) => ({ t: slots[i].startMs, soc: v })),
  };
};

module.exports = {
  plan,
  buildTrips,
  hhmmToFh,
  localTimeMs,
  HORIZON_DAYS,
};
