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
// T": each expected departure (reserve plus that day's energy, or a minimum the user set), getting back to
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
// Charging beyond the requirements, up to the maximum SoC, when the price is cheap. Automatic:
// at least CHEAP_BELOW under the usual lowest price of a day (median of the daily lowest prices
// of the last 14 days). Charging for the trips already happens around that price, so extra is
// only worth it when clearly cheaper. Only a ratio within the own price series: works whatever
// the taxes and price level of a country; with a flat or day/night tariff nothing is extra
// cheap. At or below zero is always cheap.
const CHEAP_BELOW = 0.1;
// Automatic also: CHEAP_BELOW under what charging on the coming days is expected to cost (the
// average over the full days after a slot, at least this many). Energy charged now saves charging
// later at about that price, so a cheap weekend fills up for the work week.
const MIN_VALUE_DAYS = 2;
// What charging a day costs: its cheapest hours, as many as a typical driving day takes to charge,
// within these bounds.
const VALUE_HOURS = [1, 8];
// A cheap extra only where the SoC is at least this far under the ceiling: a car report a percent
// lower than estimated is not worth switching the charger for.
const MIN_EXTRA_PCT = 3;
// Prices not yet published are less certain: when choosing when to charge beyond the needs, they
// count this much dearer, so a certain cheap price now is only passed over for a clearly cheaper
// one later. (For the needs themselves equal prices stay equal: charging later keeps options open.)
const FORECAST_MARGIN = 0.1; // DAP forecast
const PROFILE_MARGIN = 0.2; // learned weekday-hour profile
const DEFAULT_TRIP_HOURS = 9; // away time when no return time is learned
// Car still home after its planned departure: keep that trip due this long after it.
const LATE_DEPARTURE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_NEED_PCT = 5; // energy of a planned trip when none is learned
// Lowest power of a variable charger (6 A single phase): below it, surplus cannot charge alone.
const MIN_VARIABLE_POWER_W = 1400;
// A weekday seen fewer times than this is not learned yet: the fallback target applies to it.
const MIN_OBSERVED = 3;

// ─── Trips from the usage profile ─────────────────────────────────────────────

const { localTimeMs } = TimeHelpers;

const hhmmToFh = (hhmm) => {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm.trim())) return null;
  const [h, m] = hhmm.trim().split(':').map(Number);
  return h + m / 60;
};

// User input (flow tag, text field) to 'HH:MM' (TimeHelpers.parseClock: '7:30', or decimal hours
// 7.5). null if invalid.
const parseTime = (input) => {
  const hours = TimeHelpers.parseClock(input);
  if (hours === null || hours >= 24) return null;
  const hhmm = TimeHelpers.formatClock(hours);
  return hhmm.startsWith('24') ? null : hhmm;
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
 * @param {object} [o.overrides] - by local date YYYY-MM-DD, once: {type:'unused'} | {type:'min', soc, time}:
 *   at least soc % at departure | {type:'departure', time}: another time
 * @param {object|null} [o.stillHome] - the car is home and takes power: {lastAwayMs, stepMs}. A trip
 *   whose departure passed, without the car having left since, then leaves stepMs from now (for up
 *   to LATE_DEPARTURE_MS): what it needs is due right away. plannedMs keeps the planned departure.
 * @param {Array<{departFh}>} [o.tripsToday] - driving done today (EvUsageModel.tripsToday): those learned trips are done
 * @returns {Array<{departMs, returnMs, needPct, minSoc, explicit, plannedMs, soft}>} soft: a day driven only
 *   sometimes: its expected energy (share x typical need) leaves, without a requirement or absence
 */
const buildTrips = ({
  now, timezone, profile, capacityKwh, reserveSoc, manualTimes = [], overrides = {}, stillHome = null, tripsToday = [],
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

    let departFh = 8;
    if (manualFh !== null) departFh = manualFh;
    else if (typeof day.departFh === 'number') ({ departFh } = day);
    const pctOf = (kwh) => (typeof kwh === 'number' && capacityKwh > 0 ? (kwh / capacityKwh) * 100 : DEFAULT_NEED_PCT);
    const needPct = pctOf(day.safeKwh);
    const learned = Array.isArray(day.trips) ? day.trips : [];
    let dayList = [];
    if (override && override.type === 'min') {
      // The user's minimum at departure, higher or lower than planned; the day's usage as learned.
      const fh = hhmmToFh(override.time) !== null ? hhmmToFh(override.time) : departFh;
      const soc = Math.min(100, Number(override.soc) || 100);
      dayList = [{
        departFh: fh, needPct, minSoc: soc, explicit: true,
      }];
    } else if (override && override.type === 'departure') {
      // The user says the car leaves at this time: a normal trip.
      const fh = hhmmToFh(override.time) !== null ? hhmmToFh(override.time) : departFh;
      dayList = [{ departFh: fh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (manualFh !== null) {
      dayList = [{ departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (learned.length) {
      // Each regular trip on its own; one driven today (the nearest within SAME_TRIP_HOURS) is done.
      const done = new Set();
      if (d === 0) {
        tripsToday.forEach((t) => {
          if (typeof t.departFh !== 'number') return;
          const best = EvUsageModel.nearestTrip(learned, t.departFh);
          if (best >= 0) done.add(best);
        });
      }
      dayList = learned.filter((_, i) => !done.has(i)).map((l) => {
        const pct = pctOf(l.safeKwh);
        return {
          departFh: l.departFh, returnFh: l.returnFh, needPct: pct, minSoc: Math.min(100, reserveSoc + pct),
        };
      });
    } else if (day.regular) {
      // A driving day whose trips are not learned yet: the day as one trip, done once driven today.
      if (!(d === 0 && tripsToday.length)) dayList = [{ departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (!(day.observed >= MIN_OBSERVED)) {
      // Not learned yet: assume a driving day, ready rather than short. Each part from what was
      // observed (earliest departure, high need, latest return), else a safe default; seen only
      // home, no absence.
      dayList = [{
        departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct), assumed: true,
      }];
    } else if (day.share > 0 && typeof day.needKwh === 'number' && !(d === 0 && tripsToday.length)) {
      dayList = [{
        departFh, needPct: day.share * pctOf(day.needKwh), minSoc: 0, soft: true,
      }];
    }
    for (const trip of dayList) {
      let departMs = localTimeMs(midnight, trip.departFh, timezone);
      const plannedMs = departMs;
      if (departMs <= now) {
        if (trip.soft || !stillHome || now - departMs > LATE_DEPARTURE_MS || (stillHome.lastAwayMs || 0) >= departMs) continue;
        departMs = now + stillHome.stepMs;
      }
      const returnFh = 'returnFh' in trip ? trip.returnFh : day.returnFh;
      let returnMs;
      if (typeof returnFh === 'number' && returnFh > trip.departFh) {
        returnMs = localTimeMs(midnight, returnFh, timezone);
      } else {
        returnMs = departMs + DEFAULT_TRIP_HOURS * 3600 * 1000;
      }
      if ((trip.assumed && !(day.used > 0)) || trip.soft || returnMs < departMs) returnMs = departMs;
      trips.push({
        departMs, returnMs, needPct: trip.needPct, minSoc: trip.minSoc, explicit: !!trip.explicit, date, plannedMs, soft: !!trip.soft,
      });
    }
  }
  // Home again before the next trip leaves.
  trips.sort((a, b) => a.departMs - b.departMs);
  const real = trips.filter((t) => !t.soft);
  real.forEach((t, i) => {
    const next = real[i + 1];
    if (next && t.returnMs > next.departMs) t.returnMs = Math.max(t.departMs, next.departMs);
  });
  return trips;
};

// ─── Planner ──────────────────────────────────────────────────────────────────

/**
 * Prices at or below which charging beyond the requirements is worth it: from the grid, and from
 * solar surplus (costs the export price; worth it when under the usual lowest price of a day,
 * which it saves buying).
 * @param {object} o
 * @param {string} [o.mode] - 'auto' | 'fixed' | 'off'
 * @param {number} [o.price] - for 'fixed'
 * @param {number|null} [o.dailyMin] - usual lowest price of a day (EvPriceProfile.typicalDailyMin)
 * @returns {{grid: number, solar: number, coming: boolean}|null} null: never. coming: also when
 *   clearly under the lowest prices of the coming days (automatic)
 */
const cheapThreshold = ({ mode = 'auto', price, dailyMin = null } = {}) => {
  if (mode === 'off') return null;
  const typical = Number.isFinite(dailyMin) ? dailyMin : null;
  let grid = 0; // not enough known yet: only free energy
  if (mode === 'fixed') grid = Number.isFinite(Number(price)) ? Math.max(0, Number(price)) : 0;
  else if (typical !== null) grid = Math.max(0, typical * (1 - CHEAP_BELOW));
  const solar = typical !== null ? Math.max(grid, typical) : grid;
  return { grid, solar, coming: mode !== 'fixed' };
};

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
 * @param {number|null} [o.energyKwh] - no usable SoC (EvEnergyMode): grid kWh still to charge. Then
 *   planned as the SoC that far under maxSoc, full at every departure, without floor or reserve.
 * @param {number} o.capacityKwh
 * @param {number} o.chargePowerW
 * @param {number} o.efficiency - grid kWh to battery kWh
 * @param {boolean} o.atHome
 * @param {number|null} [o.awayUntilMs] - when away: expected return
 * @param {number} [o.blockedUntilMs] - no charging in slots starting before this (temporarily off)
 * @param {Array} o.trips - buildTrips()
 * @param {number} o.reserveSoc
 * @param {number} o.reserveHours
 * @param {number} o.floorSoc
 * @param {number} o.maxSoc
 * @param {string} o.mode - 'smart' | 'solar_only' | 'fast' | 'off'
 * @param {object|null} [o.cheapThreshold] - cheapThreshold(); null: no charging beyond the needs
 * @param {number|null} [o.maxPrice] - no charging above this price (charging elsewhere is cheaper),
 *   also not for trips or reserve; not for the floor or in 'fast'. null: no maximum
 * @param {number} [o.certainSlots] - prices that are published; the rest of o.prices is a forecast
 * @param {boolean} [o.variablePower]
 * @param {number} [o.minVariablePowerW] - lowest power of a variable charger (default MIN_VARIABLE_POWER_W)
 * @param {number} [o.solarGridW] - grid power allowed while charging on solar (Solar only)
 * @param {number} [o.horizonDays]
 * @param {number} [o.outlookUntilMs] - return the plan on expected prices until then as outlook
 * @returns {object} {scheme, outlook, trips, shortfalls, next, socTrajectory, startSoc}
 */
const plan = (input) => {
  const intervalMs = input.intervalMin * 60 * 1000;
  const horizonDays = input.horizonDays || HORIZON_DAYS;
  const n = Math.ceil((horizonDays * 24 * 60) / input.intervalMin);
  const cap = input.capacityKwh > 0 ? input.capacityKwh : 50;
  const eff = input.efficiency > 0 ? input.efficiency : 0.88;
  const pctPerGridKwh = (eff / cap) * 100;
  const o = typeof input.energyKwh !== 'number' ? input : {
    ...input,
    soc: Math.max(0, input.maxSoc - input.energyKwh * pctPerGridKwh),
    floorSoc: 0,
    reserveSoc: 0,
    trips: (input.trips || []).map((t) => (t.explicit ? t : { ...t, minSoc: Math.max(t.minSoc, input.maxSoc) })),
  };
  const known = o.prices.length;
  const exportPrices = o.exportPrices || [];
  const trips = (o.trips || []).filter((t) => t.departMs > o.now);
  const realTrips = trips.filter((t) => !t.soft); // the car leaves (soft: only its expected energy)

  // Price fallback beyond the known horizon when nothing is learned: the known average.
  const knownAvg = known ? o.prices.reduce((a, b) => a + b, 0) / known : 0.25;
  const knownExportAvg = exportPrices.length ? exportPrices.reduce((a, b) => a + b, 0) / exportPrices.length : knownAvg;

  // --- Slots
  const slots = [];
  for (let i = 0; i < n; i += 1) {
    const startMs = o.slotStartMs + i * intervalMs;
    const endMs = startMs + intervalMs;
    // Away at the slot start: not usable. Leaving during the slot: usable until then (a slot runs
    // from its start, EvChargerControl.planWantsPower).
    let away = false;
    let usableEndMs = endMs;
    realTrips.forEach((t) => {
      if (startMs >= t.departMs && startMs < t.returnMs) away = true;
      else if (t.departMs > startMs && t.departMs < usableEndMs) usableEndMs = t.departMs;
    });
    const from = Math.max(startMs, o.now);
    const hours = Math.max(0, (usableEndMs - from) / 3600000);
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
    let available = hours > 0 && !away;
    const awayUntil = typeof o.awayUntilMs === 'number' ? o.awayUntilMs : o.now + 3600 * 1000;
    if (!o.atHome && startMs < awayUntil) available = false;
    if (startMs < (o.blockedUntilMs || 0)) available = false;
    const maxPct = available ? (o.chargePowerW / 1000) * hours * pctPerGridKwh : 0;
    // Solar surplus is power, not energy to collect: average surplus (W) over the slot.
    const surplusW = Math.max(0, (o.solarKwh && o.solarKwh[i]) || 0) * (1000 / (o.intervalMin / 60));
    // Fixed power: charging always takes the full power, of which the surplus covers solarShare.
    // Variable: the charger can follow the surplus, down to its lowest power.
    const solarShare = o.chargePowerW > 0 ? Math.min(1, surplusW / o.chargePowerW) : 0;
    const solarGridW = Math.max(0, o.solarGridW || 0);
    // Variable: the surplus with the allowed grid power must reach the lowest charging power.
    const solarPct = o.variablePower && surplusW > 0 && surplusW + solarGridW >= (o.minVariablePowerW || MIN_VARIABLE_POWER_W)
      ? (Math.min(surplusW, o.chargePowerW) / 1000) * hours * pctPerGridKwh : 0;
    // Solar only: the grid part allowed next to the surplus.
    const solarGridPct = (solarPct > 0 || (!o.variablePower && surplusW > 0 && surplusW + solarGridW >= o.chargePowerW))
      ? (Math.min(solarGridW, o.chargePowerW) / 1000) * hours * pctPerGridKwh : 0;
    slots.push({
      i,
      startMs,
      endMs,
      usableEndMs,
      hours,
      price,
      exportPrice,
      maxPct,
      solarPct,
      solarShare,
      solarGridPct,
      known: i < known,
      solarUsed: 0,
      gridUsed: 0,
      neededPct: 0, // part of the charge needed for trips, reserve or floor (not a cheap extra)
    });
  }

  // --- Consumption: each trip's energy leaves at its departure
  const consumedAfterSlot = new Array(n).fill(0); // consumption that happened by the end of slot i
  trips.forEach((t) => {
    for (let i = 0; i < n; i += 1) if (slots[i].endMs > t.departMs) consumedAfterSlot[i] += t.needPct;
  });

  // Consumption by trips that left before tm (not the one leaving at tm).
  const consumedBefore = (tm) => trips.filter((t) => t.departMs < tm).reduce((a, t) => a + t.needPct, 0);

  // SoC ceiling per slot: raised to a minimum the user set until that trip leaves, and after it to
  // what this and later trips leave of it, until that is under maxSoc again.
  const ceiling = slots.map((s, i) => {
    let c = o.maxSoc;
    trips.forEach((t) => {
      if (t.explicit) {
        c = Math.max(c, s.endMs <= t.departMs ? t.minSoc : t.minSoc - (consumedAfterSlot[i] - consumedBefore(t.departMs)));
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

  const certain = typeof o.certainSlots === 'number' ? Math.min(o.certainSlots, known) : known;
  const marginOf = (s) => {
    if (s.i >= known) return PROFILE_MARGIN;
    return s.i >= certain ? FORECAST_MARGIN : 0;
  };
  // 'mix' (fixed power): the solar share at the export price, the rest from the grid.
  const priceOf = (s, part) => {
    if (part === 'solar') return s.exportPrice;
    if (part === 'mix') return s.solarShare * s.exportPrice + (1 - s.solarShare) * s.price;
    return s.price;
  };
  // per battery kWh; with margin: an uncertain price counted dearer
  const costOf = (s, part, margin = false) => {
    const p = priceOf(s, part);
    return (p + (margin ? marginOf(s) * Math.abs(p) : 0)) / eff;
  };
  const allowGrid = o.mode !== 'solar_only';
  const maxPrice = Number.isFinite(o.maxPrice) && o.mode !== 'fast' ? o.maxPrice : null;

  // Last slot whose usable part ends by tm (-1: none).
  const lastSlotBy = (tm) => {
    let idx = -1;
    for (let i = 0; i < n && slots[i].usableEndMs <= tm; i += 1) idx = i;
    return idx;
  };

  // The parts of a slot that can still take charge: [part, free pct].
  const partsOf = (s, gridAllowed) => {
    if (!o.variablePower) {
      // Without the grid only when the surplus, with the allowed grid power, covers the full
      // charging power.
      if (!gridAllowed && s.solarShare < 1 && !(s.solarGridPct > 0)) return [];
      return [['mix', s.maxPct - s.solarUsed - s.gridUsed]];
    }
    const parts = [['solar', s.solarPct - s.solarUsed]];
    const gridRoom = gridAllowed ? s.maxPct - s.solarPct : Math.min(s.solarGridPct, s.maxPct - s.solarPct);
    if (gridRoom > 0) parts.push(['grid', gridRoom - s.gridUsed]);
    return parts;
  };

  // Add up to `amount` pct at the cheapest usable capacity in slots ending by deadlineMs.
  // needed: for trips, reserve or floor, not a cheap extra.
  const fill = (amount, deadlineMs, {
    earliestFirst = false, gridAllowed = allowGrid, eligible = () => true, margin = false, needed = false, capped = true,
  } = {}) => {
    let left = amount;
    const blocked = new Set();
    while (left > 1e-6) {
      const soc = socAfter();
      let best = null;
      for (const s of slots) {
        if (s.usableEndMs > deadlineMs) break;
        for (const [part, free] of partsOf(s, gridAllowed)) {
          if (free > 1e-6 && !blocked.has(`${s.i}${part}`)) {
            const cost = costOf(s, part, margin);
            if (eligible(s, part) && (!capped || maxPrice === null || priceOf(s, part) <= maxPrice)) {
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
      else if (best.part === 'mix') {
        best.s.solarUsed += add * best.s.solarShare;
        best.s.gridUsed += add * (1 - best.s.solarShare);
      } else best.s.gridUsed += add;
      if (needed) best.s.neededPct += add;
      left -= add;
    }
    return amount - left; // added
  };

  // Per slot: what charging costs on the full days (24 h) after its own, on average; undefined with
  // fewer than MIN_VALUE_DAYS. Its own day is left out: the cheap hours around a slot are not what
  // it saves. A day's cost: the average of its cheapest hours, as many as a typical driving day
  // (the median trip) takes to charge; a single cheapest hour would undervalue charging ahead.
  // At most the days every slot of the first day has: else the current slot alone gets one more
  // day than the rest, and is judged against another value.
  const comingValues = () => {
    const daySlots = Math.round((24 * 60) / o.intervalMin);
    const hourSlots = 60 / o.intervalMin;
    const pctPerSlot = (o.chargePowerW / 1000) * (o.intervalMin / 60) * pctPerGridKwh;
    const needs = realTrips.map((t) => t.needPct).sort((a, b) => a - b);
    const typicalNeed = needs.length ? needs[Math.floor((needs.length - 1) / 2)] : 0;
    const needSlots = pctPerSlot > 0 ? Math.ceil(typicalNeed / pctPerSlot) : 0;
    const valueSlots = Math.max(1, Math.round(Math.min(Math.max(needSlots, VALUE_HOURS[0] * hourSlots), VALUE_HOURS[1] * hourSlots)));
    // Only slots the car can charge in, under the maximum price; solar surplus at the export price.
    const usable = slots.map((s) => {
      if (!(s.maxPct > 0)) return null;
      const solar = o.variablePower ? Math.min(1, s.solarPct / s.maxPct) : s.solarShare;
      const p = solar * s.exportPrice + (1 - solar) * s.price;
      return maxPrice !== null && p > maxPrice ? null : p;
    });
    const dayCost = [];
    for (let j = 0; j + daySlots <= n; j += 1) {
      const cheapest = usable.slice(j, j + daySlots).filter((p) => p !== null).sort((a, b) => a - b).slice(0, valueSlots);
      if (cheapest.length) dayCost[j] = cheapest.reduce((a, b) => a + b, 0) / cheapest.length;
    }
    const maxDays = Math.floor(n / daySlots) - 2;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      let days = 0;
      for (let k = 1, j = i + daySlots; k <= maxDays && j + daySlots <= n; k += 1, j += daySlots) {
        if (typeof dayCost[j] === 'number') {
          sum += dayCost[j];
          days += 1;
        }
      }
      if (days >= MIN_VALUE_DAYS) out[i] = sum / days;
    }
    return out;
  };

  const shortfalls = [];
  const lastMs = o.slotStartMs + n * intervalMs;

  if (o.mode === 'off') {
    // nothing
  } else if (o.mode === 'fast') {
    fill(Math.max(...ceiling) - o.soc, lastMs, { earliestFirst: true, gridAllowed: true, needed: true });
  } else {
    // Floor: straight away, whatever the price.
    if (o.soc < o.floorSoc) {
      fill(o.floorSoc - o.soc, lastMs, {
        earliestFirst: true, gridAllowed: true, needed: true, capped: false,
      });
    }

    // Requirements, earliest first.
    const reqs = realTrips.map((t) => ({ tm: t.departMs, soc: t.minSoc, what: 'trip' }));
    if (o.soc < o.reserveSoc) reqs.push({ tm: o.now + o.reserveHours * 3600 * 1000, soc: o.reserveSoc, what: 'reserve' });
    reqs.sort((a, b) => a.tm - b.tm);
    reqs.forEach((r) => {
      const soc = socAfter();
      // SoC just before tm: after the last slot that ends by then
      const idx = lastSlotBy(r.tm);
      const before = idx >= 0 ? soc[idx] + (consumedAfterSlot[idx] - consumedBefore(r.tm)) : o.soc;
      const need = r.soc - before;
      if (need > 1e-6) {
        const added = fill(need, r.tm, { needed: true });
        if (added < need - 0.5) shortfalls.push({ ...r, missing: Math.round(need - added) });
      }
    });

    // Cheap energy on top, up to the ceiling. Cheapest first, so a slot is only used when the
    // ceiling cannot be reached at cheaper (margin-weighted) prices later.
    if (o.mode === 'smart') {
      const cheap = o.cheapThreshold === undefined ? { grid: 0, solar: 0 } : o.cheapThreshold;
      // Fixed power: the threshold mixed like the price.
      const thresholdOf = (s, part) => (part === 'mix' ? s.solarShare * cheap.solar + (1 - s.solarShare) * cheap.grid : cheap[part]);
      const coming = cheap && cheap.coming ? comingValues() : [];
      // Room under the ceiling from each slot on, before the extra.
      const room = new Array(n);
      const soc = socAfter();
      for (let i = n - 1, min = Infinity; i >= 0; i -= 1) {
        min = Math.min(min, ceiling[i] - soc[i]);
        room[i] = min;
      }
      const eligible = (s, part) => room[s.i] >= MIN_EXTRA_PCT && (priceOf(s, part) <= thresholdOf(s, part)
        || (typeof coming[s.i] === 'number' && costOf(s, part, true) * eff <= coming[s.i] * (1 - CHEAP_BELOW)));
      if (cheap) fill(Infinity, lastMs, { eligible, margin: true });
    } else if (o.mode === 'solar_only') {
      fill(Infinity, lastMs, { gridAllowed: false });
    }
  }

  // --- Output: the executable part (known prices), and the part on expected prices after it until
  // outlookUntilMs, for display only.
  const soc = socAfter();
  const scheme = {};
  const outlook = {};
  for (let i = 0; i < n && (i < known || slots[i].startMs < (o.outlookUntilMs || 0)); i += 1) {
    const s = slots[i];
    const pct = s.solarUsed + s.gridUsed;
    const gridKwh = pct / pctPerGridKwh;
    const minutes = s.hours * 60;
    // Only a cheap extra on solar surplus: the charger control may follow the measured surplus.
    const solarExtra = pct > 1e-6 && s.neededPct < 1e-6 && s.solarUsed > 1e-6;
    let duration = 0;
    let power = 0;
    if (gridKwh > 1e-4 && minutes > 0) {
      duration = Math.min(minutes, (gridKwh / (o.chargePowerW / 1000)) * 60);
      if (o.variablePower) {
        // Spread over the slot, but not under the charger's lowest power: below it, the lowest
        // power for part of the slot (the control would raise it for the whole slot). Solar
        // extras follow the measured surplus for the whole slot.
        const minW = Math.min(o.chargePowerW, o.minVariablePowerW || MIN_VARIABLE_POWER_W);
        power = Math.round((gridKwh / s.hours) * 1000);
        duration = minutes;
        if (power < minW && !solarExtra) {
          power = minW;
          duration = (gridKwh / (minW / 1000)) * 60;
        }
      } else {
        power = o.chargePowerW;
      }
      duration = Math.max(1, Math.round(duration));
    }
    (i < known ? scheme : outlook)[i] = {
      power,
      duration,
      soc: Math.max(0, Math.min(100, Math.round(soc[i]))),
      price: s.price,
      exportPrice: s.exportPrice,
      solar: s.solarUsed > 1e-6,
      solarExtra,
      surplusW: Math.round(s.solarShare * o.chargePowerW),
    };
  }

  const next = realTrips[0] || null;
  let plannedAtNext = null;
  if (next) {
    const idx = lastSlotBy(next.departMs);
    plannedAtNext = idx >= 0 ? soc[idx] + (consumedAfterSlot[idx] - consumedBefore(next.departMs)) : o.soc;
  }
  return {
    scheme,
    outlook,
    trips: realTrips,
    shortfalls,
    next: next ? {
      departMs: next.plannedMs || next.departMs, requiredSoc: Math.round(next.minSoc), plannedSoc: Math.round(plannedAtNext),
    } : null,
    socTrajectory: soc.map((v, i) => ({ t: slots[i].startMs, soc: v })),
    startSoc: o.soc,
  };
};

module.exports = {
  plan,
  buildTrips,
  hhmmToFh,
  parseTime,
  cheapThreshold,
  localTimeMs,
  HORIZON_DAYS,
  LATE_DEPARTURE_MS,
  MIN_OBSERVED,
  DEFAULT_NEED_PCT,
  MIN_VARIABLE_POWER_W,
};
