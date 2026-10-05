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

// Weekly pattern of an appliance, like the EV driving pattern (EvChart.js): per weekday the
// expected runs, labelled with the typical start time and runs / observed days. A weekday seen
// too few times shows the mean of the others as assumed. Plain JSON only (posted to quickchart.io).

const COLORS = {
  learned: 'rgba(75, 192, 192, 0.85)',
  assumed: 'rgba(170, 140, 255, 0.55)',
};

/**
 * @param {Array} weekly - ApplianceModel.getWeekly(), Sunday first
 * @param {object} o - { dayNames (Monday first), labels: { learned, assumed, axis } }
 */
const getApplianceWeeklyChart = (weekly, o) => {
  if (!Array.isArray(weekly) || weekly.length !== 7) return null;
  const learned = [];
  const assumed = [];
  const labels = [];
  for (let i = 0; i < 7; i += 1) {
    const day = weekly[(i + 1) % 7]; // Monday first
    const value = Math.round(day.expected * 100) / 100;
    learned.push(day.learned ? value : 0);
    assumed.push(day.learned ? 0 : value);
    labels.push([o.dayNames[i], day.start || '-', `${day.starts}/${day.days}`]);
  }
  const top = Math.max(...learned, ...assumed, 0);
  const bar = (label, data, color) => ({
    label, data, backgroundColor: color, borderWidth: 0, barPercentage: 0.8, categoryPercentage: 0.9,
  });

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        bar(o.labels.learned, learned, COLORS.learned),
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
            fontSize: 18, fontColor: 'white', beginAtZero: true, suggestedMax: Math.max(1, Math.ceil(top * 2) / 2),
          },
          scaleLabel: {
            display: true, labelString: o.labels.axis, fontColor: 'white', fontSize: 16,
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

/**
 * Program of an appliance: power since the start per 15 minutes, the typical run (bars, median
 * of the runs) and the last run (line).
 * @param {object} profile - ApplianceModel.getProfile()
 * @param {object|null} lastRun - { kwh: [per 15 minutes] }
 * @param {object} labels - { typical, last }
 */
const getApplianceProgramChart = (profile, lastRun, labels) => {
  if (!profile) return null;
  const last = lastRun ? lastRun.kwh.map((v) => Math.round(v * 4000)) : [];
  const count = Math.max(profile.curveW.length, last.length);
  const xLabels = Array.from({ length: count }, (_, i) => (i % 2 === 0
    ? `${Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, '0')}` : ''));
  const top = Math.max(...profile.curveW, ...last, 0);
  const axis = (extra = {}) => [{
    ticks: {
      fontSize: 18, fontColor: 'white', autoSkip: false, ...extra,
    },
    gridLines: { color: 'rgba(255, 255, 255, 0.2)' },
  }];

  const chart = {
    type: 'bar',
    data: {
      labels: xLabels,
      datasets: [
        {
          label: labels.typical,
          backgroundColor: 'rgba(75, 192, 192, 0.85)', // as the weekly chart
          borderWidth: 0,
          data: profile.curveW,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
        {
          label: labels.last,
          borderColor: 'rgba(255, 165, 0, 1)',
          backgroundColor: 'rgba(255, 165, 0, 1)',
          borderWidth: 2,
          pointRadius: 0,
          data: last,
          fill: false,
          type: 'line',
          steppedLine: true,
        },
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
        xAxes: axis(),
        yAxes: [{
          ...axis({ beginAtZero: true, suggestedMax: Math.round((top * 1.1) / 100) * 100 || 100, autoSkip: true })[0],
          scaleLabel: {
            display: true, labelString: 'W', fontColor: 'white', fontSize: 16,
          },
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

module.exports = { getApplianceWeeklyChart, getApplianceProgramChart };
