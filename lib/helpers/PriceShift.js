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

// A price list from a broadcast (prices from pricesStartTm, one per interval) gives the price of
// every coming slot: at a slot change the receivers move on in it themselves, and a price device
// only broadcasts a list with news.

const TimeHelpers = require('./TimeHelpers');

/**
 * Slots passed since the list's start (0 when it starts now or later, or has no start).
 * @param {number} startTm - epoch ms of the list's first slot
 * @param {number} intervalMin
 * @param {string} timeZone
 * @param {number} [now]
 */
const passedSlots = (startTm, intervalMin, timeZone, now = Date.now()) => {
  if (!Number.isFinite(startTm)) return 0;
  const intervalMs = (intervalMin || 60) * 60 * 1000;
  return Math.max(0, Math.round((TimeHelpers.startOfLocalBlock(now, intervalMin || 60, timeZone) - startTm) / intervalMs));
};

/**
 * The price and export price now from a list; past its end the last ones (as for a flow tariff).
 * @param {object} list - { prices, exportPrices, startTm, interval }
 * @returns {{ tariff, exportTariff }|null} null without prices or start
 */
const priceNow = (list, timeZone, now = Date.now()) => {
  if (!list || !Array.isArray(list.prices) || !list.prices.length || !Number.isFinite(list.startTm)) return null;
  const i = Math.min(passedSlots(list.startTm, list.interval, timeZone, now), list.prices.length - 1);
  const exp = Array.isArray(list.exportPrices) && list.exportPrices.length ? list.exportPrices : list.prices;
  return { tariff: list.prices[i], exportTariff: exp[Math.min(i, exp.length - 1)] };
};

const sameList = (a, b) => (a || []).length === (b || []).length && (a || []).every((v, i) => v === b[i]);

/**
 * Whether the next broadcast only moves on in the previous one: the same prices, a later start.
 * @param {object} prev - broadcast payload (pricesNextHours, exportPricesNextHours,
 *   pricesNextHoursIsForecast, pricesNextHoursMarketLength, pricesStartTm, priceInterval, group,
 *   currency, exchangeRate)
 * @param {object} next
 */
const isShiftOnly = (prev, next) => {
  if (!prev || !next || !Number.isFinite(prev.pricesStartTm) || !Number.isFinite(next.pricesStartTm)) return false;
  if (['priceInterval', 'group', 'currency', 'exchangeRate'].some((key) => prev[key] !== next[key])) return false;
  const intervalMs = (next.priceInterval || 60) * 60 * 1000;
  const k = (next.pricesStartTm - prev.pricesStartTm) / intervalMs;
  if (!Number.isInteger(k) || k < 0) return false;
  const cut = (list) => (Array.isArray(list) ? list.slice(k) : list);
  return sameList(cut(prev.pricesNextHours), next.pricesNextHours)
    && sameList(cut(prev.exportPricesNextHours), next.exportPricesNextHours)
    && sameList(cut(prev.pricesNextHoursIsForecast), next.pricesNextHoursIsForecast)
    && Math.max(0, (prev.pricesNextHoursMarketLength || 0) - k) === (next.pricesNextHoursMarketLength || 0);
};

// A later price slot than the one of prevTm (ms or Date).
const isNewSlot = (prevTm, intervalMin, timeZone, now = Date.now()) => {
  const slot = (tm) => TimeHelpers.startOfLocalBlock(new Date(tm).getTime(), intervalMin || 60, timeZone);
  return slot(now) > slot(prevTm);
};

module.exports = {
  passedSlots, priceNow, isShiftOnly, isNewSlot,
};
