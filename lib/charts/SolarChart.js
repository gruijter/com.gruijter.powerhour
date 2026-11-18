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
const { hourLabels, thinLabels, nowLineAnnotation } = require('./ChartHelpers');
const { getInterpolatedRadiation } = require('../strategies/SolarLearningStrategy');
const TimeHelpers = require('../helpers/TimeHelpers');
const { color, PALE } = require('./Palette');

const getSolarSeries = (forecastData, yieldFactors, startTm, endTm, realPowerData = [], absoluteMaxPower = 0, adjust = null) => {
  if (!forecastData || Object.keys(forecastData).length === 0) return null;

  const times = [];
  const data = [];
  const realData = [];

  const relevantPowerData = (realPowerData || []).filter((d) => d.time >= startTm.getTime() - 900000 && d.time <= endTm.getTime() + 900000);

  let current = new Date(startTm);
  current.setUTCMinutes(0, 0, 0);

  const end = new Date(endTm);

  let maxVal = absoluteMaxPower > 0 ? absoluteMaxPower : 0;

  while (current < end) {
    const time = current.getTime();

    const slotIndex = (current.getUTCHours() * 4) + Math.floor(current.getUTCMinutes() / 15);

    const rad = getInterpolatedRadiation(time, forecastData);

    const yf = yieldFactors[slotIndex] !== undefined ? yieldFactors[slotIndex] : 1.0;

    let power = Math.round(rad * yf * (adjust ? adjust(time) : 1));
    if (absoluteMaxPower > 0 && power > absoluteMaxPower) {
      power = Math.round(absoluteMaxPower);
    }

    if (power > maxVal) maxVal = power;
    data.push(power);

    const realPower = findClosestSample(relevantPowerData, time, 10 * 60 * 1000, 'power');
    if (realPower !== null && realPower > maxVal) maxVal = realPower;
    realData.push(realPower);

    times.push(time);

    current = new Date(current.getTime() + 15 * 60 * 1000);
  }
  return {
    times, forecast: data, real: realData, maxVal,
  };
};

const getSolarChart = async (series, title, timezone = 'UTC', absoluteMaxPower = 0, isToday = false) => {
  if (!series) return null;
  const {
    times, forecast: data, real: realData, maxVal,
  } = series;

  const labels = hourLabels(times, timezone);

  const height = 480;
  const width = 640;

  const targetMax = absoluteMaxPower > 0 ? absoluteMaxPower : maxVal;
  const yMax = Math.round((targetMax * 1.1) / 100) * 100;

  const annotations = (isToday && times.length > 0) ? nowLineAnnotation(times[0], 15, data.length) : {};

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Real (W)',
          backgroundColor: 'transparent',
          borderColor: color('solar'),
          borderWidth: 2,
          pointRadius: 0,
          data: realData,
          fill: false,
          type: 'line',
          cubicInterpolationMode: 'monotone',
          spanGaps: true,
        },
        {
          label: 'Forecast (W)',
          backgroundColor: color('solar', PALE),
          borderColor: color('solar', PALE),
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
            suggestedMax: yMax,
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

const localDayOrder = (values, timezone = 'UTC') => {
  const now = new Date();
  const offset = TimeHelpers.toLocalDate(now, timezone).getTime() - now.getTime();
  const out = [];
  for (let i = 0; i < 96; i++) {
    const dateUTC = new Date((i * 15 * 60 * 1000) - offset);
    out.push(values[(dateUTC.getUTCHours() * 4) + Math.floor(dateUTC.getUTCMinutes() / 15)]);
  }
  return out;
};

const getDistributionChart = async (yieldFactors, title, timezone = 'UTC', trainingConfidence = null, datasetLabels = {}) => {
  const yieldFactorLabel = datasetLabels.yieldFactor || 'Yield Factor';
  const modelFitLabel = datasetLabels.modelFit || 'Model Fit (%)';
  if (!yieldFactors || yieldFactors.length === 0) return null;

  const hasConfidence = Array.isArray(trainingConfidence) && trainingConfidence.some((v) => v > 0);

  const data = localDayOrder(yieldFactors, timezone);
  const confidenceData = hasConfidence ? localDayOrder(trainingConfidence, timezone) : null;
  const labels = data.map((v, i) => (i % 4 === 0 ? String(Math.floor(i / 4)).padStart(2, '0') : ''));

  const thinnedLabels = thinLabels(labels);

  const height = 480;
  const width = 640;

  const datasets = [
    {
      label: yieldFactorLabel,
      backgroundColor: color('solar', 0.2),
      borderColor: color('solar'),
      borderWidth: 2,
      pointRadius: 0,
      data,
      fill: true,
      yAxisID: 'y-yield',
    },
  ];
  if (confidenceData) {
    datasets.push({
      label: modelFitLabel,
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
      labels: thinnedLabels,
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
            ...(confidenceData ? {
              scaleLabel: {
                display: true,
                labelString: yieldFactorLabel,
                fontColor: color('solar'),
                fontSize: 14,
              },
            } : {}),
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
            scaleLabel: {
              display: true,
              labelString: modelFitLabel,
              fontColor: 'rgba(255, 255, 255, 0.6)',
              fontSize: 14,
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

module.exports = {
  getSolarSeries, getSolarChart, localDayOrder, getDistributionChart,
};
