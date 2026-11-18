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

// The colours of the device graphs and the widgets (tools/widget-shared/gen.js writes them into the
// widget css as --c-<name>): one energy flow, price level or plan action has the same colour everywhere.
const COLORS = {
  grid: '#7a86a0',
  solar: '#f2a900',
  battery: '#2eb872',
  ev: '#8e6cef',
  home: '#3d8bfd',
  gas: '#e8590c',
  water: '#0ea5e9',
  climate: '#e64980',
  appliance: '#14b8a6',
  zone: '#34c77b',
  export: '#22b8cf',
  price: '#8e8e93',
  free: '#2b3fa8',
  cheap: '#4c6ef5',
  normal: ['#8e8e93', 0.45],
  dear: '#e5484d',
  hold: '#7a86a0',
  idle: ['#8e8e93', 0.45],
  average: '#b08968', // long-term average price line
};
const PALE = 0.4; // expected / not yet known
// Opacity of power without a height of its own (plan bars, appliance rows): more power, more solid.
const powerAlpha = (ratio) => 0.35 + 0.65 * Math.max(0, Math.min(1, ratio || 0));

const parts = (name) => {
  const c = COLORS[name] || COLORS.price;
  const [hex, alpha] = Array.isArray(c) ? c : [c, 1];
  const n = parseInt(hex.slice(1), 16);
  return { rgb: `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`, alpha };
};

// css colour of name, its own alpha times alpha.
const color = (name, alpha = 1) => {
  const p = parts(name);
  const a = Math.round(p.alpha * alpha * 1000) / 1000;
  return a === 1 ? `rgb(${p.rgb})` : `rgba(${p.rgb}, ${a})`;
};

module.exports = {
  COLORS, PALE, color, powerAlpha,
};
