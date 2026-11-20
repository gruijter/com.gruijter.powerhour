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

const { color, PALE } = require('./Palette');

const COLORS = {
  learned: color('appliance'),
  assumed: color('appliance', PALE),
};

const getApplianceWeeklyChart = (weekly, o) => {
  if (!Array.isArray(weekly) || weekly.length !== 7) return null;
  const learned = [];
  const assumed = [];
  const labels = [];
  for (let i = 0; i < 7; i += 1) {
    const day = weekly[(i + 1) % 7];
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

const getApplianceProgramChart = (profile, lastRun, labels) => {
  const typical = profile ? profile.curveW : [];
  const coarse = !!(profile && profile.coarse);
  const last = lastRun ? lastRun.kwh.map((v) => Math.round(v * 4000)) : [];
  if (!typical.length && !last.length) return null;
  const count = Math.max(typical.length, last.length);
  const xLabels = Array.from({ length: count }, (_, i) => (i % 2 === 0
    ? `${Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, '0')}` : ''));
  const top = Math.max(...typical, ...last, 0);
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
        last.length && {
          label: labels.last,
          borderColor: color('use'),
          backgroundColor: color('use'),
          borderWidth: 2,
          pointRadius: 0,
          data: last,
          fill: false,
          type: 'line',
          steppedLine: 'middle',
        },
        {
          label: coarse ? labels.estimate : labels.typical,
          backgroundColor: coarse ? COLORS.assumed : COLORS.learned,
          borderWidth: 0,
          data: typical,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
      ].filter(Boolean),
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
