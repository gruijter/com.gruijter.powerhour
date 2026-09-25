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
const { hourLabels, slotTimes, nowLineAnnotation } = require('./ChartHelpers');
const TimeHelpers = require('../helpers/TimeHelpers');

const getGridForecastChart = async (weeklyProfile, startTm, endTm, title, realPowerData = [], timezone = 'UTC', isToday = false) => {
  if (!weeklyProfile) return null;

  const times = [];
  const forecastData = [];
  const realData = [];

  const relevantPowerData = realPowerData.filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  let current = new Date(startTm);
  const end = new Date(endTm);

  let maxVal = 0;

  while (current < end) {
    const time = current.getTime();

    // Get forecast power at this local slot
    const localDate = TimeHelpers.toLocalDate(current, timezone);
    const dayOfWeek = localDate.getDay();
    const slotIndex = (localDate.getHours() * 4) + Math.floor(localDate.getMinutes() / 15);
    const power = weeklyProfile[dayOfWeek] ? weeklyProfile[dayOfWeek][slotIndex] || 0 : 0;

    if (power > maxVal) maxVal = power;
    forecastData.push(power);

    // Find closest entry within 10 mins
    const realPower = findClosestSample(relevantPowerData, time, 10 * 60 * 1000, 'power');
    if (realPower !== null && realPower > maxVal) maxVal = realPower;
    realData.push(realPower);

    times.push(time);

    current = new Date(current.getTime() + 15 * 60 * 1000);
  }

  const labels = hourLabels(times, timezone);

  const height = 480;
  const width = 640;

  const yMax = Math.round((maxVal * 1.1) / 100) * 100 || 100;

  const annotations = (isToday && times.length > 0) ? nowLineAnnotation(times[0], 15, forecastData.length) : {};

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

// Forecast grid exchange (+ import / - export) per 15-minute slot from startMs.
// netPlanned: incl. the battery plan (bars). netNoBattery: without it (dashed line), only drawn
// when the battery plan actually changes something.
const getGridNetChart = async (netPlanned, netNoBattery, startMs, title, timezone = 'UTC') => {
  if (!Array.isArray(netPlanned) || netPlanned.length === 0) return null;

  const times = slotTimes(startMs, netPlanned.length, 15);
  const labels = hourLabels(times, timezone);
  const showNoBattery = Array.isArray(netNoBattery) && netNoBattery.some((v, i) => v !== netPlanned[i]);
  const values = showNoBattery ? [...netPlanned, ...netNoBattery] : netPlanned;
  const yMax = Math.round((Math.max(0, ...values) * 1.1) / 100) * 100 || 100;
  const yMin = Math.floor((Math.min(0, ...values) * 1.1) / 100) * 100;

  const height = 480;
  const width = 640;

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Grid forecast (W)',
          backgroundColor: netPlanned.map((v) => (v < 0 ? 'rgba(80, 200, 120, 0.6)' : 'rgba(255, 170, 60, 0.6)')),
          borderWidth: 0,
          pointRadius: 0,
          data: netPlanned,
          type: 'bar',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
        ...(showNoBattery ? [{
          label: 'Grid forecast excl. battery (W)',
          borderColor: 'rgba(255, 255, 255, 0.6)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          data: netNoBattery,
          fill: false,
          type: 'line',
          spanGaps: false,
        }] : []),
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
              suggestedMax: yMax,
              suggestedMin: yMin,
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
  getGridNetChart,
  getGridWeeklyChart,
};
