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

const { powerAlpha } = require('../charts/Palette');

const DEFAULT_HOURS = 4;
const FLAT = 0.1;

const hoursOf = (dev) => {
  const h = Number(dev && dev.getSettings().priceLevelHours);
  return Number.isFinite(h) && h >= 0 ? h : DEFAULT_HOURS;
};

const levels = (entries, intervalMin, hours, timeZone) => {
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const days = new Map();
  entries.forEach((e) => {
    if (!e || typeof e.price !== 'number' || !Number.isFinite(e.price)) return;
    const key = dayFmt.format(e.t);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  });
  const out = new Map();
  days.forEach((list) => {
    const sorted = list.map((e) => e.price).sort((a, b) => a - b);
    const mean = sorted.reduce((a, v) => a + v, 0) / sorted.length;
    const flat = sorted[sorted.length - 1] - sorted[0] < FLAT * Math.abs(mean);
    const n = Math.min(Math.round((hours * 60) / intervalMin), Math.floor(sorted.length / 2));
    const cheapMax = n > 0 && !flat ? sorted[n - 1] : -Infinity;
    const dearMin = n > 0 && !flat ? sorted[sorted.length - n] : Infinity;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const share = (part, whole) => (whole > 0 ? part / whole : 1);
    list.forEach((e) => {
      let level = 'normal';
      let alpha = 1;
      if (e.price <= 0) level = 'free';
      else if (e.price <= cheapMax) {
        level = 'cheap';
        alpha = powerAlpha(share(cheapMax - e.price, cheapMax - Math.max(min, 0)));
      } else if (e.price >= dearMin) {
        level = 'dear';
        alpha = powerAlpha(share(e.price - dearMin, max - dearMin));
      }
      out.set(e.t, { level, alpha: Math.round(alpha * 100) / 100 });
    });
  });
  return out;
};

const ofDevice = (dev) => {
  const list = (Array.isArray(dev.prices) ? dev.prices : []).filter((p) => p && p.time)
    .map((p) => ({ t: new Date(p.time).getTime(), price: typeof p.muPrice === 'number' ? p.muPrice : p.price }));
  return levels(list, dev.priceInterval || 60, hoursOf(dev), dev.timeZone || dev.homey.clock.getTimezone());
};

module.exports = {
  DEFAULT_HOURS, hoursOf, levels, ofDevice,
};
