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

const TimeHelpers = require('./TimeHelpers');

const passedSlots = (startTm, intervalMin, timeZone, now = Date.now()) => {
  if (!Number.isFinite(startTm)) return 0;
  const intervalMs = (intervalMin || 60) * 60 * 1000;
  return Math.max(0, Math.round((TimeHelpers.startOfLocalBlock(now, intervalMin || 60, timeZone) - startTm) / intervalMs));
};

const priceNow = (list, timeZone, now = Date.now()) => {
  if (!list || !Array.isArray(list.prices) || !list.prices.length || !Number.isFinite(list.startTm)) return null;
  const i = Math.min(passedSlots(list.startTm, list.interval, timeZone, now), list.prices.length - 1);
  const exp = Array.isArray(list.exportPrices) && list.exportPrices.length ? list.exportPrices : list.prices;
  return { tariff: list.prices[i], exportTariff: exp[Math.min(i, exp.length - 1)] };
};

const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((v, i) => v === b[i]);

const isShiftOnly = (prev, next) => {
  if (!prev || !next || !Number.isFinite(prev.pricesStartTm) || !Number.isFinite(next.pricesStartTm)) return false;
  if (['priceInterval', 'group', 'currency', 'moneyDecimals', 'exchangeRate'].some((key) => prev[key] !== next[key])) return false;
  const intervalMs = (next.priceInterval || 60) * 60 * 1000;
  const k = (next.pricesStartTm - prev.pricesStartTm) / intervalMs;
  if (!Number.isInteger(k) || k < 0) return false;
  const cut = (list) => (Array.isArray(list) ? list.slice(k) : list);
  return sameList(cut(prev.pricesNextHours), next.pricesNextHours)
    && sameList(cut(prev.exportPricesNextHours), next.exportPricesNextHours)
    && sameList(cut(prev.pricesNextHoursIsForecast), next.pricesNextHoursIsForecast)
    && Math.max(0, (prev.pricesNextHoursMarketLength || 0) - k) === (next.pricesNextHoursMarketLength || 0);
};

const isNewSlot = (prevTm, intervalMin, timeZone, now = Date.now()) => {
  const slot = (tm) => TimeHelpers.startOfLocalBlock(new Date(tm).getTime(), intervalMin || 60, timeZone);
  return slot(now) > slot(prevTm);
};

module.exports = {
  passedSlots, priceNow, isShiftOnly, isNewSlot,
};
