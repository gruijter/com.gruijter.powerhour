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

const getChargeChart = async (strategy, startHour = 0, marketLength = 99, maxChargePower = 2200, maxDischargePower = 1700, interval = 60, exportPrices = []) => {
  try {
    if (!strategy || !strategy.scheme) throw Error('strategy input is invalid');

    // Convert input data to prices, labels and values
    const scheme = JSON.parse(strategy.scheme);
    // const SoCs = Object.keys(scheme).map((hour) => scheme[hour].soc);
    let prices = Object.keys(scheme).map((hour) => scheme[hour].price);
    if (prices.length < 24 * (60 / interval)) prices = prices.concat(Array(24 * (60 / interval) - prices.length).fill(null));

    // Round values to max 3 decimals for display
    prices = prices.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

    let exportPricesData = Object.keys(scheme).map((hour) => (exportPrices && exportPrices[hour] !== undefined ? exportPrices[hour] : null));
    if (exportPricesData.length < 24 * (60 / interval)) exportPricesData = exportPricesData.concat(Array(24 * (60 / interval) - exportPricesData.length).fill(null));
    exportPricesData = exportPricesData.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

    // 1. Find all indices that land on a full hour
    const hourIndices = [];
    prices.forEach((_, index) => {
      const hour = startHour + (index * (interval / 60));
      if (Math.abs(hour % 1) < 1e-8) hourIndices.push(index);
    });

    // 2. Select a subset
    const targetLabels = 12;
    const step = Math.max(1, Math.ceil(hourIndices.length / targetLabels));
    const selectedIndices = new Set(hourIndices.filter((_, i) => i % step === 0));

    const labels = prices.map((value, index) => {
      if (selectedIndices.has(index)) {
        const hour = startHour + (index * (interval / 60));
        return (hour % 24).toString().padStart(2, '0');
      }
      return '';
    });

    const sortedPrices = [...prices].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
    const maxVal = sortedPrices[0];
    const minVal = sortedPrices[sortedPrices.length - 1];
    const maxIndex = prices.indexOf(maxVal);
    const minIndex = prices.lastIndexOf(minVal);
    const displayData = prices.map((_, i) => (i === minIndex || i === maxIndex));

    // --- DYNAMIC LABEL POSITIONING ---
    // Place BOTH labels ABOVE their bars
    const anchorData = 'end';
    const alignData = 'end';

    const offsetData = prices.map((val, i) => {
      if (i === maxIndex) return 15; // Push max label further up
      if (i === minIndex) {
        if (val < 0) return 15; // Negative minimum is already at the bottom, no overlap with neighbors

        // Find highest neighbor in +/- 2 hours range
        const range = Math.ceil(120 / interval); // 2 hours
        const start = Math.max(0, i - range);
        const end = Math.min(prices.length, i + range + 1);
        const neighbors = prices.slice(start, end);
        const maxNeighbor = Math.max(...neighbors);

        const diff = maxNeighbor - val;
        if (diff <= 0) return 15;

        const valueRange = Math.max(maxVal, 0) - Math.min(minVal, 0);
        const relativeDiff = diff / (valueRange || 1);
        const pixelOffset = relativeDiff * 150; // charge chart is shorter (320 height total)

        return pixelOffset + 25;
      }
      return 0;
    });

    // Map color of each bar based on dis/charge power.
    const backgrounds = Object.keys(scheme).map((idx) => {
      const hour = scheme[idx];
      if (hour.power > 0) { // charging
        const chargeEnergy = hour.power * (hour.duration / 60);
        const g = 255 - 100 * (chargeEnergy / maxChargePower);
        return `rgb(0,${Math.round(g)},0)`; // Green (charging)
      }
      if (hour.power < 0) { // discharging
        const dischargeEnergy = -hour.power * (hour.duration / 60);
        const r = 255 - 100 * (dischargeEnergy / maxDischargePower);
        return `rgb(${Math.round(r)},50,20)`; // darkRed (discharging)
      }
      if (hour.isForecast) return 'rgb(210,210,210)'; // light grey (is forecasted price)
      if (idx >= marketLength) return 'rgb(210,210,210)'; // light grey (is forecasted price)
      return 'rgb(140,140,140)'; // dark grey (no dis/charge)
    });

    // Build configuration for the chart
    const height = 320;
    const width = 427; // 540;
    const chart = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Prices',
            backgroundColor: backgrounds,
            data: prices,
            order: 2,
          },
          {
            label: 'Export',
            type: 'line',
            data: exportPricesData,
            borderColor: 'rgba(255, 215, 0, 0.8)', // Gold
            borderWidth: 2,
            backgroundColor: 'transparent',
            pointRadius: 0,
            fill: false,
            stepped: 'middle',
            order: 1,
            datalabels: {
              display: false,
            },
          },
        ],
      },
      options: {
        responsive: true,
        layout: {
          padding: {
            top: 35,
            bottom: 35,
            left: 5,
            right: 5,
          },
        },
        plugins: {
          legend: {
            display: false,
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
              size: 14,
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
            suggestedMin: 0,
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

    return Promise.resolve({
      version: '3',
      backgroundColor: 'black',
      width,
      height,
      chart,
    });
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports = { getChargeChart };
