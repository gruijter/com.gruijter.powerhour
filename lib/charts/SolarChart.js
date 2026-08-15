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
const { getInterpolatedRadiation } = require('../strategies/SolarLearningStrategy');

const getSolarChart = async (forecastData, yieldFactors, startTm, endTm, title, realPowerData = [], timezone = 'UTC', absoluteMaxPower = 0, isToday = false) => {
  // forecastData: { timestamp: radiation } (15 min intervals or hourly)
  // yieldFactors: [96] array of yield factors per 15 min slot

  if (!forecastData || Object.keys(forecastData).length === 0) return null;

  const labels = [];
  const data = [];
  const realData = [];

  const relevantPowerData = realPowerData.filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  // Ensure we align to the hour grid before stepping in 15-minute slots
  let current = new Date(startTm);
  current.setUTCMinutes(0, 0, 0);

  const end = new Date(endTm);

  let maxVal = absoluteMaxPower > 0 ? absoluteMaxPower : 0;

  while (current < end) {
    const time = current.getTime();

    // Calculate daily slot index (0-95)
    const slotIndex = (current.getUTCHours() * 4) + Math.floor(current.getUTCMinutes() / 15);

    // Interpolate radiation
    const rad = getInterpolatedRadiation(time, forecastData);

    const yf = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 1.0;

    let power = Math.round(rad * yf);
    if (absoluteMaxPower > 0 && power > absoluteMaxPower) {
      power = Math.round(absoluteMaxPower);
    }

    if (power > maxVal) maxVal = power;
    data.push(power);

    // Find closest entry within 10 mins
    const realPower = findClosestSample(relevantPowerData, time, 10 * 60 * 1000, 'power');
    if (realPower !== null && realPower > maxVal) maxVal = realPower;
    realData.push(realPower);

    const localDate = new Date(current.toLocaleString('en-US', { timeZone: timezone }));
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

  const targetMax = absoluteMaxPower > 0 ? absoluteMaxPower : maxVal;
  const yMax = Math.round((targetMax * 1.1) / 100) * 100;

  const now = new Date();
  const annotations = {};
  if (isToday) {
    const tz = (timezone && timezone !== 'UTC') ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const currentIdx = Math.floor((nowLocal.getHours() * 60 + nowLocal.getMinutes()) / 15);
    if (currentIdx >= 0 && currentIdx < data.length) {
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
          label: 'Real (W)',
          backgroundColor: 'rgba(20, 60, 140, 0.6)', // Darker blue
          borderColor: 'rgba(100, 200, 255, 1)', // Brighter blue
          borderWidth: 2,
          pointRadius: 0,
          data: realData,
          fill: true,
          type: 'line',
          cubicInterpolationMode: 'monotone',
          spanGaps: true, // Connect points even if there are missing 15m slots (e.g. hourly data)
        },
        {
          // Drawn after (on top of) "Real" so the forecast bars stay visible even where actual
          // production fully covers the chart width (e.g. the Yesterday chart, where real data
          // spans the whole day and would otherwise hide a same-colored bar dataset drawn behind it).
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
        text: title || 'Solar Forecast',
        fontColor: 'white',
        fontSize: 16,
      },
      scales: {
        xAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
            autoSkip: false,
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
            suggestedMax: yMax, // Add 10% headroom based on PV peak, rounded to 100W
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
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

const getDistributionChart = async (yieldFactors, title, timezone = 'UTC', trainingConfidence = null) => {
  if (!yieldFactors || yieldFactors.length === 0) return null;

  const labels = [];
  const data = [];
  const confidenceData = trainingConfidence ? [] : null;

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
    if (confidenceData) confidenceData.push(trainingConfidence[slotIndex]);

    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    if (minute === 0) {
      labels.push(String(hour).padStart(2, '0'));
    } else {
      labels.push('');
    }
  }

  // Post-process labels to target ~12
  const nonEmpties = labels.map((l, i) => (l !== '' ? i : -1)).filter((i) => i !== -1);
  const distStep = Math.max(1, Math.ceil(nonEmpties.length / 12));
  nonEmpties.forEach((originalIndex, i) => {
    if (i % distStep !== 0) labels[originalIndex] = '';
  });

  const height = 480;
  const width = 640;

  const datasets = [
    {
      label: 'Yield Factor',
      backgroundColor: 'rgba(255, 206, 86, 0.2)',
      borderColor: 'rgba(255, 206, 86, 1)',
      borderWidth: 2,
      pointRadius: 0,
      data,
      fill: true,
      yAxisID: 'y-yield',
    },
  ];
  if (confidenceData) {
    // Thin, undashed, no-fill line on its own fixed 0-100% axis, deliberately understated
    // relative to the yield curve - this is a secondary diagnostic overlay, not the main signal.
    datasets.push({
      label: 'Training Confidence (%)',
      borderColor: 'rgba(255, 255, 255, 0.6)',
      backgroundColor: 'rgba(255, 255, 255, 0)',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      data: confidenceData,
      fill: false,
      yAxisID: 'y-confidence',
    });
  }

  const chart = {
    type: 'line',
    data: {
      labels,
      datasets,
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
            autoSkip: false,
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
        yAxes: [
          {
            id: 'y-yield',
            position: 'left',
            ticks: {
              fontSize: 20,
              fontColor: 'white',
              beginAtZero: true,
            },
            gridLines: {
              color: 'rgba(255,255,255,0.2)',
            },
          },
          ...(confidenceData ? [{
            id: 'y-confidence',
            position: 'right',
            ticks: {
              fontSize: 14,
              fontColor: 'rgba(255,255,255,0.6)',
              beginAtZero: true,
              min: 0,
              max: 100,
              callback: (value) => `${value}%`,
            },
            gridLines: {
              display: false,
            },
          }] : []),
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

module.exports = { getSolarChart, getDistributionChart };
