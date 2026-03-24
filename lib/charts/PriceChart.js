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

const getPriceChart = async (prices, startTime, marketLength = 999, interval = 60, timezone = 'UTC', showExportLine = false) => {
  if (!Array.isArray(prices)) throw Error('not an array');
  // Convert input data to prices, labels and values
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

  // Round values to max 3 decimals for display
  values = values.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));
  exportValues = exportValues.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

  const startTimestamp = startTime instanceof Date ? startTime.getTime() : new Date().getTime();

  // 1. Find all indices that land on a full hour
  const hourIndices = [];
  values.forEach((_, index) => {
    const currentTimestamp = startTimestamp + (index * interval * 60 * 1000);
    const date = new Date(currentTimestamp);
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    if (localDate.getMinutes() === 0) {
      hourIndices.push(index);
    }
  });

  // 2. Select a subset of these indices to target ~12 labels
  const targetLabels = 12;
  const step = Math.max(1, Math.ceil(hourIndices.length / targetLabels));
  const selectedIndices = new Set(hourIndices.filter((_, i) => i % step === 0));

  const labels = values.map((value, index) => {
    if (selectedIndices.has(index)) {
      const currentTimestamp = startTimestamp + (index * interval * 60 * 1000);
      const date = new Date(currentTimestamp);
      const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      const hours = localDate.getHours();
      return String(hours).padStart(2, '0');
    }
    return '';
  });

  // Map color of each bar based on value.
  const sortedPrices = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
  const maxVal = sortedPrices[0];
  const minVal = sortedPrices[sortedPrices.length - 1];
  const maxIndex = values.indexOf(maxVal);
  const minIndex = values.lastIndexOf(minVal);
  const displayData = values.map((_, i) => (i === minIndex || i === maxIndex));

  // --- DYNAMIC LABEL POSITIONING ---
  // Place BOTH labels ABOVE their bars
  const anchorData = 'end';
  const alignData = 'end';

  // Calculate dynamic offset to avoid covering adjacent bars
  const offsetData = values.map((val, i) => {
    if (i === maxIndex) return 15; // Push max label further up
    if (i === minIndex) {
      // Find highest neighbor in +/- 2 hours range
      const range = Math.ceil(120 / interval); // 2 hours in indices
      const start = Math.max(0, i - range);
      const end = Math.min(values.length, i + range + 1);
      const neighbors = values.slice(start, end);
      const maxNeighbor = Math.max(...neighbors);

      // Calculate offset needed to clear the highest neighbor
      // We estimate pixels per unit value based on chart height (approx)
      // Since we can't know exact pixels, we use a generous multiplier or relative calculation
      // Chart height ~320-480px. Data range ~maxVal.
      // Pixel diff ~= (maxNeighbor - val) / maxVal * chartHeight
      // Let's assume height is roughly 250px for the plotting area.
      const diff = maxNeighbor - val;
      if (diff <= 0) return 15; // It is the highest in range anyway

      // Heuristic: scale diff relative to maxVal
      const relativeDiff = diff / (maxVal || 1);
      const pixelOffset = relativeDiff * 250;

      return pixelOffset + 25; // Base offset + diff + buffer
    }
    return 0;
  });

  const peaks = [...sortedPrices].slice(0, 4 / (interval / 60));
  const troughs = [...sortedPrices].reverse().slice(0, 4 / (interval / 60));
  const backgrounds = values.map((value, idx) => {
    const isForecast = (isForecastList.length > 0 && isForecastList[idx]) || (isForecastList.length === 0 && idx >= marketLength);
    let rgb;

    if (value <= 0) {
      rgb = isForecast ? '219,144,218' : '189,44,188'; // Purple (free energy)
    } else if (troughs.includes(value)) {
      rgb = isForecast ? '100,200,161' : '0,170,101'; // Green (relatively cheap)
    } else if (peaks.includes(value)) {
      rgb = isForecast ? '247,155,123' : '237,95,23'; // Orange (high price)
    } else {
      rgb = isForecast ? '123,146,141' : '53,86,81'; // Dark green (normal price)
    }

    // Visually group 15m bars by dimming odd hours
    if (interval === 15) {
      const currentTimestamp = startTimestamp + (idx * interval * 60 * 1000);
      const date = new Date(currentTimestamp);
      const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      if (localDate.getHours() % 2 !== 0) {
        return `rgba(${rgb},0.8)`;
      }
    }
    return `rgb(${rgb})`;
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
      borderColor: 'rgba(255, 215, 0, 0.8)', // Gold
      borderWidth: 2,
      backgroundColor: 'transparent',
      pointRadius: 0,
      fill: false,
      order: 1,
      datalabels: {
        display: false,
      },
    });
  }

  // Build configuration for the chart
  const height = 480; // 320;
  const width = 640; // 427; // 540;
  const chart = {
    type: 'bar',
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
      plugins: {
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
            suggestedMin: 0,
          },
          gridLines: {
            color: 'rgba(255,255,255,0.2)',
          },
        }],
      },
      backgroundColor: 'black', // for some chart.js plugins
    },
  };

  return {
    backgroundColor: 'black',
    width,
    height,
    chart,
  };
};

module.exports = { getPriceChart };
