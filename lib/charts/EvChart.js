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

// Weekly driving pattern of an EV: per weekday the SoC the planner wants at departure, as the
// reserve plus that day's (safe) trip energy. Same Chart.js v2 style as the grid weekly chart.
// Plain JSON only: the spec is posted to quickchart.io, so no formatter functions.

const EvUsageModel = require('../strategies/EvUsageModel');

const COLORS = {
  reserve: 'rgba(160, 160, 160, 0.5)',
  regular: 'rgba(75, 192, 192, 0.85)',
  sometimes: 'rgba(255, 165, 0, 0.7)',
  assumed: 'rgba(170, 140, 255, 0.55)',
};

/**
 * @param {Array} profile - EvUsageModel.getProfile()
 * @param {object} o
 * @param {number} o.capacityKwh
 * @param {number} o.reserveSoc
 * @param {number} o.minObserved - observations before a weekday counts as learned
 * @param {number} o.defaultNeedPct - assumed need of a weekday not learned yet
 * @param {Array<string>} o.dayNames - Monday first
 * @param {object} o.labels - { reserve, regular, sometimes, assumed }
 */
const getEvWeeklyChart = (profile, o) => {
  if (!Array.isArray(profile) || profile.length !== 7) return null;
  const pct = (kwh) => (typeof kwh === 'number' && o.capacityKwh > 0 ? Math.round((kwh / o.capacityKwh) * 1000) / 10 : 0);
  const reserve = [];
  const regular = [];
  const sometimes = [];
  const assumed = [];
  const labels = [];
  profile.forEach((day, dow) => {
    const learned = day.observed >= o.minObserved;
    const need = pct(day.safeKwh);
    const unused = learned && !day.used;
    reserve.push(o.reserveSoc);
    regular.push(learned && day.regular ? need : 0);
    sometimes.push(learned && !day.regular && !unused ? need : 0);
    assumed.push(learned ? 0 : (need || o.defaultNeedPct));
    labels.push([
      o.dayNames[dow],
      typeof day.departFh === 'number' && day.used ? EvUsageModel.fractionalHourToHHMM(day.departFh) : '-',
      `${day.used || 0}/${day.observed || 0}`,
    ]);
  });
  const top = Math.max(...profile.map((_, i) => reserve[i] + regular[i] + sometimes[i] + assumed[i]));
  const yMax = Math.min(100, Math.ceil((top + 10) / 10) * 10);
  const bar = (label, data, color) => ({
    label, data, backgroundColor: color, borderWidth: 0, barPercentage: 0.8, categoryPercentage: 0.9,
  });

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        bar(o.labels.reserve, reserve, COLORS.reserve),
        bar(o.labels.regular, regular, COLORS.regular),
        bar(o.labels.sometimes, sometimes, COLORS.sometimes),
        bar(o.labels.assumed, assumed, COLORS.assumed),
      ],
    },
    options: {
      legend: { display: true, labels: { fontColor: 'white', fontSize: 16 } },
      layout: {
        padding: {
          top: 10, bottom: 0, left: 0, right: 10,
        },
      },
      scales: {
        xAxes: [{
          stacked: true,
          ticks: { fontSize: 18, fontColor: 'white', autoSkip: false },
          gridLines: { color: 'rgba(255, 255, 255, 0.2)' },
        }],
        yAxes: [{
          stacked: true,
          ticks: {
            fontSize: 18, fontColor: 'white', beginAtZero: true, max: yMax, stepSize: 10,
          },
          scaleLabel: {
            display: true, labelString: 'SoC %', fontColor: 'white', fontSize: 16,
          },
          gridLines: { color: 'rgba(255, 255, 255, 0.2)' },
        }],
      },
    },
  };

  return {
    backgroundColor: 'black',
    width: 640,
    height: 480,
    chart,
  };
};

module.exports = { getEvWeeklyChart };
