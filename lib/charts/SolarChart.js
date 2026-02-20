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

const defaultHost = 'image-charts.com';
const chartEP = '/chart.js/2.8.0?';

const getSolarChart = async (forecastData, yieldFactors, startTm, endTm, title, realPowerData = [], timezone = 'UTC') => {
  // Generate a chart showing forecasted power generation for the specified period
  // forecastData: { timestamp: radiation } (15 min intervals or hourly)
  // yieldFactors: [96] array of yield factors per 15 min slot
  // startTm: Date object for start
  // endTm: Date object for end

  if (!forecastData || Object.keys(forecastData).length === 0) return null;

  const labels = [];
  const data = [];
  const realData = [];

  // Optimization: Filter realPowerData once
  const relevantPowerData = realPowerData.filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  // Create 15-minute slots from startTm to endTm
  // Ensure we align to hour grid
  let current = new Date(startTm);
  current.setUTCMinutes(0, 0, 0);

  const end = new Date(endTm);
  const totalHours = Math.ceil((end.getTime() - current.getTime()) / 3600000);

  let maxVal = 0;

  while (current < end) {
    const time = current.getTime();

    // Calculate daily slot index (0-95)
    const slotIndex = (current.getUTCHours() * 4) + Math.floor(current.getUTCMinutes() / 15);

    // Interpolate radiation
    const t = current.getTime();
    const date = new Date(t);
    date.setUTCMinutes(0, 0, 0, 0);
    const t1 = date.getTime();
    const t2 = t1 + 3600000;
    const r1 = forecastData[t1];
    const r2 = forecastData[t2];
    const rad = (r1 === undefined && r2 === undefined) ? 0 : ((r1 || r2) + ((r2 || r1) - (r1 || r2)) * ((t - t1) / 3600000));

    const yf = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 1.0;

    const power = Math.round(rad * yf);
    if (power > maxVal) maxVal = power;
    data.push(power);

    // Find closest entry within 10 mins
    let entry = null;
    const candidates = relevantPowerData.filter((d) => Math.abs(d.time - time) < 10 * 60 * 1000);
    if (candidates.length > 0) {
      entry = candidates.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
    }
    const realPower = entry ? entry.power : null;
    if (realPower !== null && realPower > maxVal) maxVal = realPower;
    realData.push(realPower);

    // Label logic
    const localDate = new Date(current.toLocaleString('en-US', { timeZone: timezone }));
    const hours = localDate.getHours();
    const minutes = localDate.getMinutes();

    // Show label if on the hour
    if (minutes === 0) {
      labels.push(String(hours).padStart(2, '0'));
    } else {
      labels.push('');
    }

    // Increment 15 mins
    current = new Date(current.getTime() + 15 * 60 * 1000);
  }

  const height = 480;
  const width = 640;

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Forecast (W)',
          backgroundColor: 'rgba(135, 206, 250, 0.4)', // Washed out blue
          borderColor: 'rgba(135, 206, 250, 0.4)',
          borderWidth: 0,
          pointRadius: 0,
          data,
          type: 'bar',
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        },
        {
          label: 'Real (W)',
          backgroundColor: 'rgba(20, 60, 140, 0.6)', // Darker blue
          borderColor: 'rgba(100, 200, 255, 1)', // Brighter blue
          borderWidth: 2,
          pointRadius: 0,
          data: realData,
          fill: true,
          type: 'line',
          cubicInterpolationMode: 'monotone',
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
        text: title || 'Solar Forecast',
        fontColor: 'white',
        fontSize: 16,
      },
      scales: {
        xAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
            maxTicksLimit: totalHours + 1,
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
        yAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
            beginAtZero: true,
            suggestedMax: maxVal * 1.1, // Add some headroom
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
      },
      backgroundColor: 'black',
    },
  };

  const query = {
    bkg: 'black',
    height,
    width,
    c: JSON.stringify(chart),
    _t: Date.now(),
  };
  const path = chartEP + new URLSearchParams(query).toString();
  const url = `https://${defaultHost}${path}`;
  return url;
};

const getDistributionChart = async (yieldFactors, title, timezone = 'UTC') => {
  if (!yieldFactors || yieldFactors.length === 0) return null;

  const labels = [];
  const data = [];

  // Calculate offset to align graph to Local Midnight
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const offset = nowLocal.getTime() - now.getTime();

  // Iterate 0..95 representing the Local Day slots (00:00 - 23:45)
  for (let i = 0; i < 96; i++) {
    const utcSlotTime = (i * 15 * 60 * 1000) - offset;
    const dateUTC = new Date(utcSlotTime);
    const slotIndex = (dateUTC.getUTCHours() * 4) + Math.floor(dateUTC.getUTCMinutes() / 15);
    data.push(yieldFactors[slotIndex]);

    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    if (minute === 0) {
      labels.push(String(hour).padStart(2, '0'));
    } else {
      labels.push('');
    }
  }

  const height = 480;
  const width = 640;

  const chart = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Yield Factor',
          backgroundColor: 'rgba(255, 206, 86, 0.2)',
          borderColor: 'rgba(255, 206, 86, 1)',
          borderWidth: 2,
          pointRadius: 0,
          data,
          fill: true,
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
        text: title || 'Yield Distribution',
        fontColor: 'white',
        fontSize: 16,
      },
      scales: {
        xAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
            maxTicksLimit: 25,
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
        yAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
            beginAtZero: true,
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
      },
      backgroundColor: 'black',
    },
  };

  const query = {
    bkg: 'black',
    height,
    width,
    c: JSON.stringify(chart),
    _t: Date.now(),
  };
  const path = chartEP + new URLSearchParams(query).toString();
  const url = `https://${defaultHost}${path}`;
  return url;
};

module.exports = { getSolarChart, getDistributionChart };
