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

const { findClosestSample } = require('../helpers/HistoryLookup');

const getGridForecastChart = async (weeklyProfile, startTm, endTm, title, realPowerData = [], timezone = 'UTC', isToday = false) => {
  if (!weeklyProfile) return null;

  const labels = [];
  const forecastData = [];
  const realData = [];

  const relevantPowerData = realPowerData.filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  let current = new Date(startTm);
  const end = new Date(endTm);

  let maxVal = 0;

  while (current < end) {
    const time = current.getTime();

    // Get forecast power at this local slot
    const localDate = new Date(current.toLocaleString('en-US', { timeZone: timezone }));
    const dayOfWeek = localDate.getDay();
    const slotIndex = (localDate.getHours() * 4) + Math.floor(localDate.getMinutes() / 15);
    const power = weeklyProfile[dayOfWeek] ? weeklyProfile[dayOfWeek][slotIndex] || 0 : 0;

    if (power > maxVal) maxVal = power;
    forecastData.push(power);

    // Find closest entry within 10 mins
    const realPower = findClosestSample(relevantPowerData, time, 10 * 60 * 1000, 'power');
    if (realPower !== null && realPower > maxVal) maxVal = realPower;
    realData.push(realPower);

    const hours = localDate.getHours();
    const minutes = localDate.getMinutes();

    if (minutes === 0) {
      labels.push(String(hours).padStart(2, '0'));
    } else {
      labels.push('');
    }

    current = new Date(current.getTime() + 15 * 60 * 1000);
  }

  // Post-process labels to target ~12
  const nonEmpties = labels.map((l, i) => (l !== '' ? i : -1)).filter((i) => i !== -1);
  const step = Math.max(1, Math.ceil(nonEmpties.length / 12));
  nonEmpties.forEach((originalIndex, i) => {
    if (i % step !== 0) labels[originalIndex] = '';
  });

  const height = 480;
  const width = 640;

  const yMax = Math.round((maxVal * 1.1) / 100) * 100 || 100;

  const now = new Date();
  const annotations = {};
  if (isToday) {
    const tz = (timezone && timezone !== 'UTC') ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const currentIdx = Math.floor((nowLocal.getHours() * 60 + nowLocal.getMinutes()) / 15);
    if (currentIdx >= 0 && currentIdx < forecastData.length) {
      annotations.nowLine = {
        type: 'line',
        scaleID: 'x',
        value: currentIdx,
        borderColor: 'rgba(255, 255, 255, 0.75)',
        borderWidth: 1.5,
        borderDash: [4, 4],
      };
    }
  }

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Forecast (W)',
          backgroundColor: 'rgba(135, 206, 250, 0.4)', // Washed out blue (same as solar)
          borderColor: 'rgba(135, 206, 250, 0.4)',
          borderWidth: 0,
          pointRadius: 0,
          data: forecastData,
          type: 'bar',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
        {
          label: 'Real (W)',
          backgroundColor: 'rgba(20, 60, 140, 0.6)', // Darker blue (same as solar)
          borderColor: 'rgba(100, 200, 255, 1)', // Brighter blue (same as solar)
          borderWidth: 2,
          pointRadius: 0,
          data: realData,
          fill: true,
          type: 'line',
          cubicInterpolationMode: 'monotone',
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      legend: {
        display: false,
      },
      plugins: {
        annotation: {
          annotations,
        },
      },
      layout: {
        padding: {
          top: 35,
          bottom: 0,
          left: 0,
          right: 10,
        },
      },
      title: {
        display: false,
        text: title || 'Grid Forecast',
        fontColor: 'white',
        fontSize: 16,
      },
      scales: {
        xAxes: [
          {
            ticks: {
              fontSize: 20,
              fontColor: 'white',
              autoSkip: false,
            },
            gridLines: {
              color: 'rgba(255, 255, 255, 0.2)',
            },
          },
        ],
        yAxes: [
          {
            ticks: {
              fontSize: 20,
              fontColor: 'white',
              beginAtZero: true,
              suggestedMax: yMax,
            },
            gridLines: {
              color: 'rgba(255, 255, 255, 0.2)',
            },
          },
        ],
      },
      backgroundColor: 'black',
    },
  };

  return {
    backgroundColor: 'black',
    width,
    height,
    chart,
  };
};

const getGridWeeklyChart = async (weeklyProfile, title) => {
  if (!weeklyProfile) return null;

  const labels = [];
  const data = [];
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let maxVal = 0;

  for (let d = 0; d < 7; d++) {
    const dayOfWeek = (d + 1) % 7; // Mon=1, Tue=2, ..., Sat=6, Sun=0
    const dayProfile = weeklyProfile[dayOfWeek] || new Array(96).fill(0);

    for (let h = 0; h < 24; h++) {
      const sum = (dayProfile[h * 4] || 0)
        + (dayProfile[h * 4 + 1] || 0)
        + (dayProfile[h * 4 + 2] || 0)
        + (dayProfile[h * 4 + 3] || 0);
      const power = Math.round(sum / 4);
      if (power > maxVal) maxVal = power;
      data.push(power);

      // Show day label in the middle of each day (hour 12)
      if (h === 12) {
        labels.push(dayNames[d]);
      } else {
        labels.push('');
      }
    }
  }

  const height = 480;
  const width = 640;
  const yMax = Math.round((maxVal * 1.1) / 100) * 100 || 100;

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Weekly Baseline (W)',
          backgroundColor: 'rgba(135, 206, 250, 0.4)', // Washed out blue (same as solar)
          borderColor: 'rgba(135, 206, 250, 0.4)',
          borderWidth: 0,
          pointRadius: 0,
          data,
          type: 'bar',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
      ],
    },
    options: {
      responsive: true,
      legend: {
        display: false,
      },
      layout: {
        padding: {
          top: 35,
          bottom: 0,
          left: 0,
          right: 10,
        },
      },
      title: {
        display: false,
        text: title || 'Weekly Baseline Profile',
        fontColor: 'white',
        fontSize: 16,
      },
      scales: {
        xAxes: [
          {
            ticks: {
              fontSize: 20,
              fontColor: 'white',
              autoSkip: false,
            },
            gridLines: {
              color: 'rgba(255, 255, 255, 0.2)',
            },
          },
        ],
        yAxes: [
          {
            ticks: {
              fontSize: 20,
              fontColor: 'white',
              beginAtZero: true,
              suggestedMax: yMax,
            },
            gridLines: {
              color: 'rgba(255, 255, 255, 0.2)',
            },
          },
        ],
      },
      backgroundColor: 'black',
    },
  };

  return {
    backgroundColor: 'black',
    width,
    height,
    chart,
  };
};

module.exports = {
  getGridForecastChart,
  getGridWeeklyChart,
};
