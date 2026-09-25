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
const { hourLabels, nowLineAnnotation } = require('./ChartHelpers');
const TimeHelpers = require('../helpers/TimeHelpers');

// Forecast (bars) vs real (line) per 15-minute slot, for home load or grid exchange.
// opts.forecast: forecast W per slot from startTm; when omitted it is read from weeklyProfile.
// opts.realKey: sample field of realPowerData to plot ('power' = home load, 'grid' = grid exchange).
// opts.signed: grid exchange (+ import / - export): negative axis, import/export bar colors.
const getGridForecastChart = async (weeklyProfile, startTm, endTm, title, realPowerData = [], timezone = 'UTC', isToday = false, opts = {}) => {
  const { forecast = null, realKey = 'power', signed = false } = opts;
  if (!weeklyProfile && !Array.isArray(forecast)) return null;

  const times = [];
  const forecastData = [];
  const realData = [];

  const relevantPowerData = realPowerData.filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  let current = new Date(startTm);
  const end = new Date(endTm);

  let maxVal = 0;
  let minVal = 0;

  while (current < end) {
    const time = current.getTime();

    let power;
    if (Array.isArray(forecast)) {
      power = typeof forecast[times.length] === 'number' ? forecast[times.length] : null;
    } else {
      // Get forecast power at this local slot
      const localDate = TimeHelpers.toLocalDate(current, timezone);
      const dayOfWeek = localDate.getDay();
      const slotIndex = (localDate.getHours() * 4) + Math.floor(localDate.getMinutes() / 15);
      power = weeklyProfile[dayOfWeek] ? weeklyProfile[dayOfWeek][slotIndex] || 0 : 0;
    }

    if (power !== null) {
      maxVal = Math.max(maxVal, power);
      minVal = Math.min(minVal, power);
    }
    forecastData.push(power);

    // Find closest entry within 10 mins
    const realPower = findClosestSample(relevantPowerData, time, 10 * 60 * 1000, realKey);
    if (realPower !== null) {
      maxVal = Math.max(maxVal, realPower);
      minVal = Math.min(minVal, realPower);
    }
    realData.push(realPower);

    times.push(time);

    current = new Date(current.getTime() + 15 * 60 * 1000);
  }

  const labels = hourLabels(times, timezone);

  const height = 480;
  const width = 640;

  const yMax = Math.round((maxVal * 1.1) / 100) * 100 || 100;
  const yMin = Math.floor((minVal * 1.1) / 100) * 100;

  const annotations = (isToday && times.length > 0) ? nowLineAnnotation(times[0], 15, forecastData.length) : {};

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Forecast (W)',
          backgroundColor: signed
            ? forecastData.map((v) => (v < 0 ? 'rgba(80, 200, 120, 0.4)' : 'rgba(255, 170, 60, 0.4)')) // export green, import orange
            : 'rgba(135, 206, 250, 0.4)', // Washed out blue (same as solar)
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
              ...(yMin < 0 ? { suggestedMin: yMin } : {}),
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
