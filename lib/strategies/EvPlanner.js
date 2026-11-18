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

const TimeHelpers = require('../helpers/TimeHelpers');
const EvUsageModel = require('./EvUsageModel');

const HORIZON_DAYS = 7;
const CHEAP_BELOW = 0.1;
const MIN_VALUE_DAYS = 2;
const VALUE_HOURS = [1, 8];
const MIN_EXTRA_PCT = 3;
const FORECAST_MARGIN = 0.1;
const PROFILE_MARGIN = 0.2;
const DEFAULT_TRIP_HOURS = 9;
const LATE_DEPARTURE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_NEED_PCT = 5;
const MIN_VARIABLE_POWER_W = 1400;
const MIN_OBSERVED = 3;
const MIN_CHARGE_MINUTES = 30;

const { localTimeMs } = TimeHelpers;

const hhmmToFh = (hhmm) => {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm.trim())) return null;
  const [h, m] = hhmm.trim().split(':').map(Number);
  return h + m / 60;
};

const parseTime = (input) => {
  const hours = TimeHelpers.parseClock(input);
  if (hours === null || hours >= 24) return null;
  const hhmm = TimeHelpers.formatClock(hours);
  return hhmm.startsWith('24') ? null : hhmm;
};

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
      const fh = hhmmToFh(override.time) !== null ? hhmmToFh(override.time) : departFh;
      const soc = Math.min(100, Number(override.soc) || 100);
      dayList = [{
        departFh: fh, needPct, minSoc: soc, explicit: true,
      }];
    } else if (override && override.type === 'departure') {
      const fh = hhmmToFh(override.time) !== null ? hhmmToFh(override.time) : departFh;
      dayList = [{ departFh: fh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (manualFh !== null) {
      dayList = [{ departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (learned.length) {
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
      if (!(d === 0 && tripsToday.length)) dayList = [{ departFh, needPct, minSoc: Math.min(100, reserveSoc + needPct) }];
    } else if (!(day.observed >= MIN_OBSERVED)) {
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
  trips.sort((a, b) => a.departMs - b.departMs);
  const real = trips.filter((t) => !t.soft);
  real.forEach((t, i) => {
    const next = real[i + 1];
    if (next && t.returnMs > next.departMs) t.returnMs = Math.max(t.departMs, next.departMs);
  });
  return trips;
};

const cheapThreshold = ({ mode = 'auto', price, dailyMin = null } = {}) => {
  if (mode === 'off') return null;
  const typical = Number.isFinite(dailyMin) ? dailyMin : null;
  let grid = 0;
  if (mode === 'fixed') grid = Number.isFinite(Number(price)) ? Math.max(0, Number(price)) : 0;
  else if (typical !== null) grid = Math.max(0, typical * (1 - CHEAP_BELOW));
  const solar = typical !== null ? Math.max(grid, typical) : grid;
  return { grid, solar, coming: mode !== 'fixed' };
};

const SURPLUS_EPS_KWH = 0.01;
const homeBatteryTiers = (slots, o, pctPerGridKwh) => {
  const bat = o.homeBattery;
  if (!bat || !(bat.capKwh > 0) || !Array.isArray(bat.room)) return;
  const solar = o.solarKwh || [];
  const deficit = o.deficitKwh || [];
  const n = slots.length;
  const surplusAt = (i) => (solar[i] || 0) > SURPLUS_EPS_KWH;
  const planned = (i) => typeof bat.room[i] === 'number';
  const rt = bat.effC * bat.effD;
  let i = 0;
  while (i < n) {
    if (!surplusAt(i) || !planned(i)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < n && surplusAt(end + 1)) end += 1;
    const later = [];
    for (let j = end + 1; j < n && !surplusAt(j) && planned(j); j += 1) {
      if ((deficit[j] || 0) > 0) later.push({ price: slots[j].price, kwh: deficit[j] });
    }
    later.sort((a, b) => b.price - a.price);
    let left = bat.capKwh * bat.effD;
    let marginal = null;
    for (const d of later) {
      left -= d.kwh;
      if (left <= 0) {
        marginal = d.price;
        break;
      }
    }
    const stretch = slots.slice(i, end + 1);
    if (marginal !== null && stretch.some((s) => bat.store[s.i])) {
      const surplusKwh = stretch.reduce((a, s) => a + (solar[s.i] || 0), 0);
      const tier = {
        freePct: Math.max(0, surplusKwh - bat.room[i]) * pctPerGridKwh,
        value: marginal * rt - (bat.cycleCost / 2) * (1 + rt),
      };
      stretch.forEach((s) => {
        s.tier = tier;
      });
    }
    i = end + 1;
  }
};

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
  const realTrips = trips.filter((t) => !t.soft);

  const knownAvg = known ? o.prices.reduce((a, b) => a + b, 0) / known : 0.25;
  const knownExportAvg = exportPrices.length ? exportPrices.reduce((a, b) => a + b, 0) / exportPrices.length : knownAvg;

  const slots = [];
  for (let i = 0; i < n; i += 1) {
    const startMs = o.slotStartMs + i * intervalMs;
    const endMs = startMs + intervalMs;
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
    let unavailable = null;
    if (away) unavailable = 'trip';
    else if (!(hours > 0)) unavailable = 'leaving';
    const awayUntil = typeof o.awayUntilMs === 'number' ? o.awayUntilMs : o.now + 3600 * 1000;
    if (!unavailable && !o.atHome && startMs < awayUntil) unavailable = 'notHome';
    if (!unavailable && startMs < (o.blockedUntilMs || 0)) unavailable = 'off';
    const available = !unavailable;
    const maxPct = available ? (o.chargePowerW / 1000) * hours * pctPerGridKwh : 0;
    const surplusW = Math.max(0, (o.solarKwh && o.solarKwh[i]) || 0) * (1000 / (o.intervalMin / 60));
    const solarShare = o.chargePowerW > 0 ? Math.min(1, surplusW / o.chargePowerW) : 0;
    const solarGridW = Math.max(0, o.solarGridW || 0);
    const solarPct = o.variablePower && surplusW > 0 && surplusW + solarGridW >= (o.minVariablePowerW || MIN_VARIABLE_POWER_W)
      ? (Math.min(surplusW, o.chargePowerW) / 1000) * hours * pctPerGridKwh : 0;
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
      unavailable,
      solarUsed: 0,
      gridUsed: 0,
      neededPct: 0,
    });
  }

  const daySlots = Math.round((24 * 60) / o.intervalMin);
  const hourSlots = 60 / o.intervalMin;
  const pctPerSlot = (o.chargePowerW / 1000) * (o.intervalMin / 60) * pctPerGridKwh;
  const needs = realTrips.map((t) => t.needPct).sort((a, b) => a - b);
  const typicalNeed = needs.length ? needs[Math.floor((needs.length - 1) / 2)] : 0;
  const needSlots = pctPerSlot > 0 ? Math.ceil(typicalNeed / pctPerSlot) : 0;
  const valueSlots = Math.max(1, Math.round(Math.min(Math.max(needSlots, VALUE_HOURS[0] * hourSlots), VALUE_HOURS[1] * hourSlots)));

  const typical = o.typicalDayCost ? o.typicalDayCost((valueSlots * o.intervalMin) / 60) : null;
  if (Number.isFinite(typical)) {
    for (let j = known; j + daySlots <= n; j += daySlots) {
      const cheapest = slots.slice(j, j + daySlots).sort((a, b) => a.price - b.price).slice(0, valueSlots);
      const excess = cheapest.reduce((a, s) => a + s.price, 0) / cheapest.length - typical;
      if (excess > 0) {
        cheapest.forEach((s) => {
          s.price -= excess;
        });
      }
    }
  }
  homeBatteryTiers(slots, o, pctPerGridKwh);

  const consumedAfterSlot = new Array(n).fill(0);
  trips.forEach((t) => {
    for (let i = 0; i < n; i += 1) if (slots[i].endMs > t.departMs) consumedAfterSlot[i] += t.needPct;
  });

  const consumedBefore = (tm) => trips.filter((t) => t.departMs < tm).reduce((a, t) => a + t.needPct, 0);

  const ceiling = slots.map((s, i) => {
    let c = o.maxSoc;
    trips.forEach((t) => {
      if (t.explicit) {
        c = Math.max(c, s.endMs <= t.departMs ? t.minSoc : t.minSoc - (consumedAfterSlot[i] - consumedBefore(t.departMs)));
      }
    });
    return Math.max(c, o.soc - consumedAfterSlot[i]);
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
  const solarPrice = (s, cash = false) => (!cash && s.tier && s.tier.freePct <= 1e-6 ? Math.max(s.exportPrice, s.tier.value) : s.exportPrice);
  const priceOf = (s, part, cash = false) => {
    if (part === 'solar') return solarPrice(s, cash);
    if (part === 'mix') return s.solarShare * solarPrice(s, cash) + (1 - s.solarShare) * s.price;
    return s.price;
  };
  const costOf = (s, part, margin = false) => {
    const p = priceOf(s, part);
    return (p + (margin ? marginOf(s) * Math.abs(p) : 0)) / eff;
  };
  const allowGrid = o.mode !== 'solar_only';
  const maxPrice = Number.isFinite(o.maxPrice) && o.mode !== 'fast' ? o.maxPrice : null;

  const lastSlotBy = (tm) => {
    let idx = -1;
    for (let i = 0; i < n && slots[i].usableEndMs <= tm; i += 1) idx = i;
    return idx;
  };

  const partCount = (s, gridAllowed) => {
    if (!o.variablePower) {
      return !gridAllowed && s.solarShare < 1 && !(s.solarGridPct > 0) ? 0 : 1;
    }
    const gridRoom = gridAllowed ? s.maxPct - s.solarPct : Math.min(s.solarGridPct, s.maxPct - s.solarPct);
    return gridRoom > 0 ? 2 : 1;
  };
  const partName = (k) => {
    if (!o.variablePower) return 'mix';
    return k === 0 ? 'solar' : 'grid';
  };
  const partFree = (s, gridAllowed, k) => {
    if (!o.variablePower) {
      const free = s.maxPct - s.solarUsed - s.gridUsed;
      return s.tier && s.tier.freePct > 1e-6 && s.solarShare > 0 ? Math.min(free, s.tier.freePct / s.solarShare) : free;
    }
    if (k === 0) {
      const solarFree = s.solarPct - s.solarUsed;
      return s.tier && s.tier.freePct > 1e-6 ? Math.min(solarFree, s.tier.freePct) : solarFree;
    }
    const gridRoom = gridAllowed ? s.maxPct - s.solarPct : Math.min(s.solarGridPct, s.maxPct - s.solarPct);
    return gridRoom - s.gridUsed;
  };

  const fill = (amount, deadlineMs, {
    earliestFirst = false, gridAllowed = allowGrid, eligible = () => true, margin = false, needed = false, capped = true,
  } = {}) => {
    let left = amount;
    const blocked = new Set();
    while (left > 1e-6) {
      const soc = socAfter();
      let bestS = null;
      let bestK = 0;
      let bestFree = 0;
      let bestKey = 0;
      for (let si = 0; si < slots.length; si += 1) {
        const s = slots[si];
        if (s.usableEndMs > deadlineMs) break;
        const count = partCount(s, gridAllowed);
        for (let k = 0; k < count; k += 1) {
          const free = partFree(s, gridAllowed, k);
          if (free > 1e-6 && !blocked.has((s.i * 2) + k)) {
            const part = partName(k);
            const cost = costOf(s, part, margin);
            if (eligible(s, part) && (!capped || maxPrice === null || priceOf(s, part, true) <= maxPrice)) {
              const key = earliestFirst ? s.i : cost;
              const later = bestS !== null && (earliestFirst ? s.i < bestS.i : s.i > bestS.i);
              if (bestS === null || key < bestKey || (key === bestKey && later)) {
                bestS = s;
                bestK = k;
                bestFree = free;
                bestKey = key;
              }
            }
          }
        }
      }
      if (bestS === null) break;
      const bestPart = partName(bestK);
      const room = headroom(bestS.i, soc);
      const add = Math.min(left, bestFree, room);
      if (add <= 1e-6) {
        blocked.add((bestS.i * 2) + bestK);
        continue;
      }
      const { tier } = bestS;
      if (tier && tier.freePct > 1e-6) {
        tier.freePct = Math.max(0, tier.freePct - (bestPart === 'solar' ? add : 0) - (bestPart === 'mix' ? add * bestS.solarShare : 0));
      }
      if (bestPart === 'solar') bestS.solarUsed += add;
      else if (bestPart === 'mix') {
        bestS.solarUsed += add * bestS.solarShare;
        bestS.gridUsed += add * (1 - bestS.solarShare);
      } else bestS.gridUsed += add;
      if (needed) bestS.neededPct += add;
      left -= add;
    }
    return amount - left;
  };

  const comingValues = () => {
    const usable = slots.map((s) => {
      if (!(s.maxPct > 0)) return null;
      const solar = o.variablePower ? Math.min(1, s.solarPct / s.maxPct) : s.solarShare;
      const mixOf = (sp) => solar * sp + (1 - solar) * s.price;
      return maxPrice !== null && mixOf(solarPrice(s, true)) > maxPrice ? null : mixOf(solarPrice(s));
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

  const covered = (tm) => {
    if (!(tm > o.now) || o.soc < Math.max(o.reserveSoc, o.floorSoc)) return false;
    if (realTrips.some((t) => t.departMs < tm && o.soc - consumedBefore(t.departMs) < t.minSoc)) return false;
    return o.soc - consumedBefore(tm) >= o.reserveSoc;
  };

  const minChargeMin = Number.isFinite(o.minChargeMinutes) ? Math.max(0, o.minChargeMinutes) : MIN_CHARGE_MINUTES;
  const usedPct = (s) => s.solarUsed + s.gridUsed;
  const minW = Math.min(o.chargePowerW, o.minVariablePowerW || MIN_VARIABLE_POWER_W);
  const isSolarExtra = (s) => usedPct(s) > 1e-6 && s.neededPct < 1e-6 && s.solarUsed > 1e-6;
  const pctPerMinute = (s) => (o.variablePower ? (minW / 60000) * pctPerGridKwh : s.maxPct / (s.hours * 60));
  const fullPct = (s) => (s.maxPct > 0 ? Math.min(s.maxPct, pctPerMinute(s) * s.hours * 60) : 0);
  const minutesOf = (s) => {
    const used = usedPct(s);
    if (!(s.maxPct > 0) || used < 1e-6) return 0;
    if (o.variablePower && isSolarExtra(s)) return s.hours * 60;
    return Math.min(s.hours * 60, used / pctPerMinute(s));
  };
  const addCharge = (s, amt) => {
    const solar = o.variablePower ? Math.min(amt, Math.max(0, s.solarPct - s.solarUsed)) : amt * s.solarShare;
    s.solarUsed += solar;
    s.gridUsed += amt - solar;
  };
  const hasNeeded = (a, b) => {
    for (let k = a; k <= b; k += 1) if (slots[k].neededPct > 1e-6) return true;
    return false;
  };
  const worthIt = (a, b, worthOf) => {
    let cost = 0;
    let worth = 0;
    for (let k = a; k <= b; k += 1) {
      const s = slots[k];
      if (s.neededPct > 1e-6) continue;
      if (s.solarUsed > 1e-9) {
        cost += s.solarUsed * priceOf(s, 'solar');
        worth += s.solarUsed * worthOf(s, 'solar');
      }
      if (s.gridUsed > 1e-9) {
        cost += s.gridUsed * priceOf(s, 'grid');
        worth += s.gridUsed * worthOf(s, 'grid');
      }
    }
    return cost <= worth + 1e-9;
  };
  const usableSlot = (s) => s && s.maxPct > 0 && !(maxPrice !== null && priceOf(s, 'mix', true) > maxPrice);

  const bridgeGaps = (worthOf) => {
    if (!(minChargeMin > 0)) return;
    const maxGap = Math.max(1, Math.round((minChargeMin * 60000) / intervalMs));
    let i = 0;
    while (i < n) {
      if (usedPct(slots[i]) < 1e-6) {
        i += 1;
        continue;
      }
      let last = i;
      for (let j = i + 1; j < n && j - last <= maxGap + 1; j += 1) {
        const s = slots[j];
        if (usedPct(s) > 1e-6) last = j;
        else if (!usableSlot(s)) break;
      }
      const saved = slots.slice(i, last + 1).map((s) => ({ solarUsed: s.solarUsed, gridUsed: s.gridUsed, neededPct: s.neededPct }));
      let ok = true;
      let g = i;
      let d = last;
      while (g < d) {
        const free = fullPct(slots[g]) - usedPct(slots[g]);
        const avail = usedPct(slots[d]);
        if (free < 1e-6) g += 1;
        else if (avail < 1e-6) d -= 1;
        else {
          const soc = socAfter();
          let room = Infinity;
          for (let j = g; j < d; j += 1) room = Math.min(room, ceiling[j] - soc[j]);
          const amt = Math.min(free, avail, room);
          if (amt < 1e-6) {
            ok = false;
            break;
          }
          const from = slots[d];
          const to = slots[g];
          from.solarUsed -= amt * (from.solarUsed / avail);
          from.gridUsed -= amt * (from.gridUsed / avail);
          addCharge(to, amt);
          const needed = Math.min(from.neededPct, amt);
          from.neededPct -= needed;
          to.neededPct += needed;
        }
      }
      const start = i;
      if (ok && !hasNeeded(i, last) && !worthIt(i, last, worthOf)) ok = false;
      if (!ok) saved.forEach((v, k) => Object.assign(slots[start + k], v));
      i = last + 1;
    }
  };

  const extendShortRuns = (worthOf) => {
    if (!(minChargeMin > 0)) return;
    const runEnd = (a) => {
      let b = a;
      while (b + 1 < n && usedPct(slots[b + 1]) > 1e-6) b += 1;
      return b;
    };
    const minutesBefore = Math.max(0, Number(o.chargingMinutes) || 0);
    let i = 0;
    while (i < n) {
      if (usedPct(slots[i]) < 1e-6) {
        i += 1;
        continue;
      }
      const start = i;
      let a = i;
      let b = runEnd(a);
      const sessionMinutes = () => {
        let m = a === 0 ? minutesBefore : 0;
        for (let k = a; k <= b; k += 1) m += minutesOf(slots[k]);
        return m;
      };
      if (sessionMinutes() >= minChargeMin - 0.5) {
        i = b + 1;
        continue;
      }
      const extraOnly = !hasNeeded(a, b);
      const saved = new Map();
      let stuck = false;
      while (sessionMinutes() < minChargeMin - 0.5) {
        const inside = [];
        for (let k = a; k <= b; k += 1) if (fullPct(slots[k]) - usedPct(slots[k]) > 1e-6 && usableSlot(slots[k])) inside.push(slots[k]);
        const side = [slots[a - 1], slots[b + 1]].filter(usableSlot);
        const pool = inside.length ? inside : side;
        if (!pool.length) {
          stuck = true;
          break;
        }
        const to = pool.sort((x, y) => priceOf(x, 'mix') - priceOf(y, 'mix'))[0];
        const amt = Math.min(fullPct(to) - usedPct(to), headroom(to.i, socAfter()),
          (minChargeMin - sessionMinutes()) * pctPerMinute(to) + 1e-9);
        if (!(amt > 1e-6)) {
          stuck = true;
          break;
        }
        if (!saved.has(to.i)) saved.set(to.i, { solarUsed: to.solarUsed, gridUsed: to.gridUsed });
        addCharge(to, amt);
        if (to.i < a) a = to.i;
        while (a > 0 && usedPct(slots[a - 1]) > 1e-6) a -= 1;
        b = runEnd(a);
      }
      if (!stuck && extraOnly && !worthIt(a, b, worthOf)) stuck = true;
      if (stuck) {
        saved.forEach((v, k) => Object.assign(slots[k], v));
        a = start;
        b = runEnd(start);
        if (extraOnly) {
          for (let k = a; k <= b; k += 1) {
            slots[k].solarUsed = 0;
            slots[k].gridUsed = 0;
          }
        }
      }
      i = b + 1;
    }
  };

  const shortfalls = [];
  const lastMs = o.slotStartMs + n * intervalMs;

  if (o.mode === 'fast') {
    fill(Math.max(...ceiling) - o.soc, lastMs, { earliestFirst: true, gridAllowed: true, needed: true });
  } else if (o.mode !== 'off') {
    if (o.soc < o.floorSoc) {
      fill(o.floorSoc - o.soc, lastMs, {
        earliestFirst: true, gridAllowed: true, needed: true, capped: false,
      });
    }

    const reqs = realTrips.map((t) => ({ tm: t.departMs, soc: t.minSoc, what: 'trip' }));
    if (o.soc < o.reserveSoc) reqs.push({ tm: o.now + o.reserveHours * 3600 * 1000, soc: o.reserveSoc, what: 'reserve' });
    reqs.sort((a, b) => a.tm - b.tm);
    reqs.forEach((r) => {
      const soc = socAfter();
      const idx = lastSlotBy(r.tm);
      const before = idx >= 0 ? soc[idx] + (consumedAfterSlot[idx] - consumedBefore(r.tm)) : o.soc;
      const need = r.soc - before;
      if (need > 1e-6) {
        const added = fill(need, r.tm, { needed: true });
        if (added < need - 0.5) shortfalls.push({ ...r, missing: Math.round(need - added) });
      }
    });

    if (o.mode === 'smart') {
      const cheap = o.cheapThreshold === undefined ? { grid: 0, solar: 0 } : o.cheapThreshold;
      const thresholdOf = (s, part) => (part === 'mix' ? s.solarShare * cheap.solar + (1 - s.solarShare) * cheap.grid : cheap[part]);
      const coming = cheap && cheap.coming && !covered(o.coverUntilMs) ? comingValues() : [];
      const room = new Array(n);
      const soc = socAfter();
      for (let i = n - 1, min = Infinity; i >= 0; i -= 1) {
        min = Math.min(min, ceiling[i] - soc[i]);
        room[i] = min;
      }
      const eligible = (s, part) => room[s.i] >= MIN_EXTRA_PCT && (priceOf(s, part) <= thresholdOf(s, part)
        || (typeof coming[s.i] === 'number' && costOf(s, part, true) * eff <= coming[s.i] * (1 - CHEAP_BELOW)));
      if (cheap) fill(Infinity, lastMs, { eligible, margin: true });
      const worthOf = (s, part) => Math.max(cheap ? cheap[part] : -Infinity, typeof coming[s.i] === 'number'
        ? coming[s.i] * (1 - CHEAP_BELOW) - marginOf(s) * Math.abs(priceOf(s, part)) : -Infinity);
      bridgeGaps(worthOf);
      extendShortRuns(worthOf);
    } else if (o.mode === 'solar_only') {
      fill(Infinity, lastMs, { gridAllowed: false });
    }
  }

  const soc = socAfter();
  const scheme = {};
  const outlook = {};
  for (let i = 0; i < n && (i < known || slots[i].startMs < (o.outlookUntilMs || 0)); i += 1) {
    const s = slots[i];
    const pct = s.solarUsed + s.gridUsed;
    const gridKwh = pct / pctPerGridKwh;
    const minutes = s.hours * 60;
    const solarExtra = isSolarExtra(s);
    let duration = 0;
    let power = 0;
    if (gridKwh > 1e-4 && minutes > 0) {
      duration = Math.min(minutes, (gridKwh / (o.chargePowerW / 1000)) * 60);
      if (o.variablePower) {
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
    unavailable: slots.filter((s) => s.known && s.unavailable).map((s) => ({ startMs: s.startMs, why: s.unavailable })),
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
  MIN_CHARGE_MINUTES,
};
