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

/* eslint-disable camelcase */

'use strict';

// Flow cards of the price driver. Each trigger and condition of the same id runs the same method
// (a trigger fires when it becomes true at the start of a price period).
// Amounts are a number with a unit; they are ranked per price slot and rounded up to whole slots.
// Windows: the next H hours (0 = all known prices), or between two clock times (equal = 24 hours).

const DapFlows = require('./DapFlows');
const PriceCalculator = require('../PriceCalculator');
const TimeHelpers = require('../helpers/TimeHelpers');

const UNIT_MINUTES = {
  quarters: 15, half_hours: 30, hours: 60, minutes: 1,
};

// Settings a flow can change, by component id: the number cards and the text cards.
const NUMBER_SETTINGS = [
  'fixedMarkup', 'tax', 'variableMarkup', 'vat', 'fixedMarkupWeekend', 'exchangeRate',
  'export_fixedMarkup', 'export_tax', 'export_variableMarkup', 'export_vat', 'export_fixedMarkupWeekend',
];
const TEXT_SETTINGS = ['fixedMarkupTOD', 'export_fixedMarkupTOD', 'formula', 'export_formula'];

class PriceFlows extends DapFlows {

  get homey() {
    return this.device.homey;
  }

  requireState() {
    if (!this.device.state || !this.device.state.pricesNextHours) throw Error(this.homey.__('error_no_prices'));
  }

  // Slots for an amount: number in unit (quarters, half_hours, hours, minutes), at least 1.
  slotsFor(number, unit) {
    const minutes = Number(TimeHelpers.parseHours(number)) * (UNIT_MINUTES[unit] || 60);
    if (!Number.isFinite(minutes) || minutes <= 0) throw Error(this.homey.__('error_price_amount', { value: String(number) }));
    return Math.max(1, Math.ceil(minutes / this.device.priceInterval - 1e-9));
  }

  // Prices of the next H hours (0 = all known), from the slot holding now (index 0).
  windowNext(hours) {
    const h = Number(TimeHelpers.parseHours(hours));
    if (!Number.isFinite(h) || h < 0) throw Error(this.homey.__('error_price_amount', { value: String(hours) }));
    const prices = [...this.device.state.pricesNextHours];
    return { prices: h > 0 ? prices.slice(0, Math.round((h * 60) / this.device.priceInterval)) : prices, currentIndex: 0 };
  }

  // Prices between two clock times (text or number args, TimeHelpers.parseClock): the slots that
  // overlap them, so the window starts on a slot and currentIndex is the slot of now.
  windowBetween(time1, time2) {
    const t1 = TimeHelpers.parseClock(time1);
    const t2 = TimeHelpers.parseClock(time2);
    if (t1 === null) throw Error(this.homey.__('error_price_time', { time: String(time1) }));
    if (t2 === null) throw Error(this.homey.__('error_price_time', { time: String(time2) }));
    const slotH = this.device.priceInterval / 60;
    const start = Math.floor(t1 / slotH + 1e-9) * slotH;
    let end = Math.ceil(t2 / slotH - 1e-9) * slotH;
    if (t2 <= t1 && end > start) end = start; // overnight or 24 hours, also after rounding
    const { prices, isNowInWindow, currentIndex } = this.getPricesInWindow({
      time1: TimeHelpers.formatClock(start % 24), time2: TimeHelpers.formatClock(end % 24),
    });
    return isNowInWindow ? { prices, currentIndex } : null;
  }

  // Is the price now among the N cheapest (or most expensive) slots of the window?
  inRank(window, args) {
    if (!window || !window.prices.length) return false;
    const n = this.slotsFor(args.number, args.unit);
    const now = this.device.state.priceNow;
    if (args.type === 'highest') return now >= Math.min(...[...window.prices].sort((a, b) => b - a).slice(0, n));
    return now <= Math.max(...[...window.prices].sort((a, b) => a - b).slice(0, n));
  }

  inBlock(window, args) {
    if (!window || !window.prices.length) return false;
    const slots = this.slotsFor(args.duration, args.duration_unit);
    return this.checkAvgRank(window.prices, slots, window.currentIndex, args.type === 'highest' ? 'max' : 'min');
  }

  // A trigger result (now): true only in the first period it is true, per card and args. Unknown
  // before (restart without a priming run, state.prime): no fire. Flows with the same args in one
  // period share the result.
  triggerEdge(id, args, state, now) {
    const { device, ...rest } = args;
    const key = `${id}|${JSON.stringify(rest)}`;
    if (!this.device.triggerEdges) this.device.triggerEdges = new Map();
    const tm = state && state.pricesStartTm;
    let edge = this.device.triggerEdges.get(key);
    if (!edge || edge.tm !== tm) {
      edge = { tm, was: edge ? edge.now : null, now: !!now };
      this.device.triggerEdges.set(key, edge);
    }
    return !(state && state.prime) && edge.now && edge.was === false;
  }

  async price_cheapest_next(args) {
    this.requireState();
    return this.inRank(this.windowNext(args.hours), args);
  }

  async price_cheapest_between(args) {
    this.requireState();
    return this.inRank(this.windowBetween(args.time1, args.time2), args);
  }

  async price_block_next(args) {
    this.requireState();
    return this.inBlock(this.windowNext(args.hours), args);
  }

  async price_block_between(args) {
    this.requireState();
    return this.inBlock(this.windowBetween(args.time1, args.time2), args);
  }

  async price_vs_avg(args) {
    this.requireState();
    const avg = this.device.state[args.period];
    if (typeof avg !== 'number' || avg === 0) return false;
    // Relative to |avg|: a negative average keeps above and below the right way round.
    const diff = this.device.state.priceNow - avg;
    const percent = (100 * (args.direction === 'above' ? diff : -diff)) / Math.abs(avg);
    return percent >= Number(TimeHelpers.parseHours(args.percent));
  }

  async price_find_block(args) {
    this.requireState();
    const slots = this.slotsFor(args.duration, args.duration_unit);
    let { prices } = this.windowNext(args.hours);
    const before = String(args.time ?? '').trim();
    const { periodStart, nowLocal } = this.device.getUTCPeriods();
    const intervalMs = this.device.priceInterval * 60 * 1000;
    if (before !== '') {
      const end = TimeHelpers.parseClock(before);
      if (end === null) throw Error(this.homey.__('error_price_time', { time: before }));
      const nowHours = nowLocal.getHours() + nowLocal.getMinutes() / 60;
      let hoursUntil = end - nowHours;
      if (hoursUntil <= 0) hoursUntil += 24;
      const untilMs = Date.now() + hoursUntil * 3600000;
      prices = prices.slice(0, Math.floor((untilMs - periodStart.getTime()) / intervalMs));
    }
    if (prices.length < slots) throw Error(this.homey.__('error_no_prices'));
    const best = this.findBestAvgWindow(prices, slots, args.type === 'highest' ? 'max' : 'min');
    if (!best) throw Error(this.homey.__('error_no_prices'));

    const startMs = periodStart.getTime() + best.idxMin * intervalMs;
    const endMs = startMs + slots * intervalMs;
    const clock = (ms) => {
      const local = TimeHelpers.toLocalDate(new Date(ms), this.device.timeZone);
      return TimeHelpers.formatClock(local.getHours() + local.getMinutes() / 60);
    };
    return {
      minutesUntil: Math.max(0, Math.round((startMs - Date.now()) / 60000)),
      startTime: clock(startMs),
      endTime: clock(endMs),
      avgPrice: Math.round(best.avgPrice * 10000) / 10000,
    };
  }

  async price_json(args) {
    this.requireState();
    const period = args.period || 'next_hours';
    if (args.kind === 'export') {
      return { prices: this.device.exportPricesJson(period), provider: this.device.getProviderForPeriod(period) };
    }
    let prices = this.device.state.pricesNextHours;
    if (period !== 'next_hours') {
      const { start, end } = PriceCalculator.getPeriodRange(this.device.getUTCPeriods(), period);
      prices = PriceCalculator.selectPrices(this.device.prices, start, end);
    }
    return {
      prices: JSON.stringify((prices || []).map((p) => Math.round(p * 10000) / 10000)),
      provider: this.device.getProviderForPeriod(period),
    };
  }

  async price_set_component(args) {
    if (!NUMBER_SETTINGS.includes(args.component)) throw Error(`unknown component ${args.component}`);
    const value = Number(TimeHelpers.parseHours(args.value));
    if (!Number.isFinite(value)) throw Error(this.homey.__('error_value_not_number'));
    this.device.log('price setting changed by flow', this.device.getName(), args.component, value);
    await this.device.updatePriceSettings({ [args.component]: value });
  }

  async price_set_text(args) {
    if (!TEXT_SETTINGS.includes(args.field)) throw Error(`unknown setting ${args.field}`);
    const value = String(args.value ?? '').trim();
    this.device.log('price setting changed by flow', this.device.getName(), args.field, value);
    await this.device.updatePriceSettings({ [args.field]: value });
  }
}

module.exports = PriceFlows;
