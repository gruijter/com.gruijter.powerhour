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

const { effAt } = require('../strategies/BatteryEfficiency');
const { LEGEND_FILTER, withLegendFilter } = require('./ChartHelpers');

const CHARGE_RGB = '0, 180, 0';
const DISCHARGE_RGB = '255, 130, 0';
const CURVE_POINTS = 24;

/**
 * The learned efficiency per AC power: measured bins as points, the loss fit as a line.
 *
 * @param {object} summary - BatteryEfficiency.summary()
 * @param {object} o
 * @param {number} o.maxW - x axis end (the battery's max power)
 * @param {object} o.labels - { charge, discharge, idle, capacity, learning }
 * @returns {object} QuickChart request
 */
const getEfficiencyChart = (summary, { maxW = 2500, labels = {} } = {}) => {
  const pct = (v) => Math.round(v * 1000) / 10;
  const xMax = Math.max(maxW, ...summary.charge.map((r) => r.powerW), ...summary.discharge.map((r) => r.powerW));
  const curve = (fit, dir) => (fit ? Array.from({ length: CURVE_POINTS + 1 }, (_, i) => {
    const x = Math.round(50 + (((xMax - 50) * i) / CURVE_POINTS));
    return { x, y: pct(effAt(fit, x, dir)) };
  }) : []);
  const points = (rows) => rows.map((r) => ({ x: Math.round(r.powerW), y: pct(r.eff) }));
  // Bigger points for bins with more samples.
  const radius = (rows) => rows.map((r) => Math.min(8, 3 + r.n));
  const line = (label, data, rgb) => ({
    type: 'line', label, data, borderColor: `rgb(${rgb})`, backgroundColor: `rgb(${rgb})`, borderWidth: 2, pointRadius: 0, fill: false,
  });
  const dots = (data, rows, rgb) => ({
    type: 'scatter', label: '', data, backgroundColor: `rgb(${rgb})`, pointRadius: radius(rows),
  });
  const notes = [];
  if (!summary.charge.length && !summary.discharge.length) notes.push(labels.learning || 'learning…');
  if (summary.capacityFactor) notes.push(`${labels.capacity || 'capacity'} x${summary.capacityFactor.toFixed(2)}`);
  if (summary.idleW !== null) notes.push(`${labels.idle || 'idle'} ${Math.round(summary.idleW)} W`);
  const chart = {
    type: 'scatter',
    data: {
      datasets: [
        line(labels.charge || 'charge', curve(summary.chargeFit, 'charge'), CHARGE_RGB),
        line(labels.discharge || 'discharge', curve(summary.dischargeFit, 'discharge'), DISCHARGE_RGB),
        dots(points(summary.charge), summary.charge, CHARGE_RGB),
        dots(points(summary.discharge), summary.discharge, DISCHARGE_RGB),
      ],
    },
    options: {
      layout: {
        padding: {
          top: 10, bottom: 10, left: 0, right: 10,
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            color: 'white', font: { size: 13 }, boxWidth: 14, filter: LEGEND_FILTER,
          },
        },
        title: {
          display: notes.length > 0, text: notes.join('   '), color: 'white', font: { size: 13 },
        },
        datalabels: { display: false },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: Math.ceil(xMax / 500) * 500,
          title: {
            display: true, text: 'W', color: 'white', font: { size: 13 },
          },
          ticks: { color: 'white', font: { size: 14 } },
          grid: { color: 'rgba(255,255,255,0.2)' },
        },
        y: {
          min: 0,
          max: 100,
          title: {
            display: true, text: '%', color: 'white', font: { size: 13 },
          },
          ticks: { color: 'white', font: { size: 14 } },
          grid: { color: 'rgba(255,255,255,0.2)' },
        },
      },
    },
  };
  return {
    version: '3',
    backgroundColor: 'black',
    width: 427,
    height: 320,
    chart: withLegendFilter(chart),
  };
};

module.exports = { getEfficiencyChart };
