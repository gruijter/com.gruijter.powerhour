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

// Program of an appliance: the learned curve (bars) and the last run (line), W per 15 minutes
// since the start. Same look as the grid weekly chart.
const getApplianceChart = (profile, lastRun) => {
  if (!profile) return null;
  const last = lastRun ? lastRun.kwh.map((v) => Math.round(v * 4000)) : [];
  const count = Math.max(profile.curveW.length, last.length);
  const labels = Array.from({ length: count }, (_, i) => (i % 2 === 0
    ? `${Math.floor(i / 4)}:${String((i % 4) * 15).padStart(2, '0')}` : ''));
  const maxVal = Math.max(...profile.curveW, ...last, 0);
  const yMax = Math.round((maxVal * 1.1) / 100) * 100 || 100;
  const axis = (extra = {}) => [{
    ticks: {
      fontSize: 20, fontColor: 'white', autoSkip: false, ...extra,
    },
    gridLines: { color: 'rgba(255, 255, 255, 0.2)' },
  }];

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Program (W)',
          backgroundColor: 'rgba(135, 206, 250, 0.4)', // washed out blue (same as grid)
          borderWidth: 0,
          data: profile.curveW,
          type: 'bar',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
        {
          label: 'Last run (W)',
          borderColor: 'rgba(100, 200, 255, 1)', // brighter blue (same as grid)
          backgroundColor: 'rgba(20, 60, 140, 0.6)',
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
      responsive: true,
      legend: { display: false },
      layout: {
        padding: {
          top: 35, bottom: 0, left: 0, right: 10,
        },
      },
      scales: {
        xAxes: axis(),
        yAxes: axis({ beginAtZero: true, suggestedMax: yMax, autoSkip: true }),
      },
      backgroundColor: 'black',
    },
  };

  return {
    backgroundColor: 'black',
    width: 640,
    height: 480,
    chart,
  };
};

module.exports = { getApplianceChart };
