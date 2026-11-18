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

const { hourLabels, slotTimes, nowLineAnnotation } = require('./ChartHelpers');
const TimeHelpers = require('../helpers/TimeHelpers');
const { color, PALE } = require('./Palette');

const getPriceChart = async (prices, startTime, marketLength = 999, interval = 60, timezone = 'UTC', showExportLine = false, isToday = false) => {
  if (!Array.isArray(prices)) throw Error('not an array');
  let values = [];
  let exportValues = [];
  let isForecastList = [];
  if (prices.length > 0 && typeof prices[0] === 'object' && prices[0] !== null && 'price' in prices[0]) {
    values = prices.map((p) => p.price);
    exportValues = prices.map((p) => (p.exportPrice !== undefined ? p.exportPrice : null));
    isForecastList = prices.map((p) => p.isForecast);
  } else {
    values = [...prices];
    exportValues = Array(values.length).fill(null);
  }
  if (values.length < 24 * (60 / interval)) values = values.concat(Array(24 * (60 / interval) - values.length).fill(null));
  if (exportValues.length < 24 * (60 / interval)) exportValues = exportValues.concat(Array(24 * (60 / interval) - exportValues.length).fill(null));

  values = values.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));
  exportValues = exportValues.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

  const startTimestamp = startTime instanceof Date ? startTime.getTime() : new Date().getTime();

  const labels = hourLabels(slotTimes(startTimestamp, values.length, interval), timezone);

  const sortedPrices = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
  const maxVal = sortedPrices.length > 0 ? sortedPrices[0] : 0;
  const minVal = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1] : 0;
  const maxIndex = values.indexOf(maxVal);
  const minIndex = values.lastIndexOf(minVal);
  const displayData = values.map((_, i) => (i === minIndex || i === maxIndex));

  const valueRange = Math.max(maxVal, 0) - Math.min(minVal, 0);

  const anchorData = 'end';
  const alignData = 'end';

  // Calculate dynamic offset to avoid covering adjacent bars
  const offsetData = values.map((val, i) => {
    if (i === maxIndex) return 15; // Push max label further up
    if (i === minIndex) {
      if (val < 0) return 15; // Negative minimum is already at the bottom, no overlap with neighbors

      // Find highest neighbor in +/- 2 hours range
      const range = Math.ceil(120 / interval); // 2 hours in indices
      const start = Math.max(0, i - range);
      const end = Math.min(values.length, i + range + 1);
      const neighbors = values.slice(start, end);
      const maxNeighbor = Math.max(...neighbors);

      const diff = maxNeighbor - val;
      if (diff <= 0) return 15; // It is the highest in range anyway

      // Approximate pixel offset needed to clear the highest neighbor; exact chart pixel
      // height isn't known here (rendered externally), so assume a ~250px plotting area
      const relativeDiff = diff / (valueRange || 1);
      const pixelOffset = relativeDiff * 250;

      return pixelOffset + 25;
    }
    return 0;
  });

  const levels = prices.map((p) => (p && typeof p === 'object' && p.level) || 'normal');
  const levelAlphas = prices.map((p) => (p && typeof p === 'object' && Number.isFinite(p.levelAlpha) ? p.levelAlpha : 1));
  const backgrounds = values.map((value, idx) => {
    const isForecast = (isForecastList.length > 0 && isForecastList[idx]) || (isForecastList.length === 0 && idx >= marketLength);
    let alpha = (isForecast ? PALE : 1) * (levelAlphas[idx] ?? 1);
    // Visually group 15m bars by dimming odd hours
    if (interval === 15) {
      const localDate = TimeHelpers.toLocalDate(new Date(startTimestamp + (idx * interval * 60 * 1000)), timezone);
      if (localDate.getHours() % 2 !== 0) alpha *= 0.8;
    }
    return color(levels[idx], alpha);
  });

  const datasets = [
    {
      label: 'Prices',
      backgroundColor: backgrounds,
      data: values,
      order: 2,
    },
  ];

  if (showExportLine) {
    datasets.push({
      label: 'Export',
      type: 'line',
      data: exportValues,
      borderColor: color('export'),
      borderWidth: 2,
      backgroundColor: 'transparent',
      pointRadius: 0,
      fill: false,
      stepped: 'middle',
      order: 1,
      datalabels: {
        display: false,
      },
    });
  }

  const annotations = isToday ? nowLineAnnotation(startTimestamp, interval, values.length) : {};

  const height = 480;
  const width = 640;
  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      layout: {
        padding: {
          top: 35,
          bottom: 35,
          left: 0,
          right: 10,
        },
      },
      plugins: {
        legend: {
          display: false,
        },
        annotation: {
          annotations,
        },
        datalabels: {
          anchor: anchorData,
          clamp: true,
          align: alignData,
          offset: offsetData,
          padding: 5,
          backgroundColor: backgrounds,
          color: 'white',
          borderWidth: 2,
          borderColor: 'white',
          borderRadius: 100,
          font: {
            size: 18,
          },
          display: displayData,
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 20 },
            color: 'white',
            autoSkip: false,
          },
          grid: {
            color: 'rgba(255,255,255,0.2)',
          },
        },
        y: {
          beginAtZero: true,
          suggestedMin: minVal < 0 ? minVal - (valueRange * 0.15) : 0,
          suggestedMax: maxVal + (valueRange * 0.15),
          ticks: {
            font: { size: 20 },
            color: 'white',
          },
          grid: {
            color: 'rgba(255,255,255,0.2)',
          },
        },
      },
      backgroundColor: 'black', // for some chart.js plugins
    },
  };

  return {
    version: '3',
    backgroundColor: 'black',
    width,
    height,
    chart,
  };
};

module.exports = { getPriceChart };
