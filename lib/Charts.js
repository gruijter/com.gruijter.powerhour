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

const querystring = require('querystring');

const defaultHost = 'image-charts.com';
const chartEP = '/chart.js/2.8.0?';

const getPriceChart = async (prices, startHour = 0, marketLength = 999, interval = 60) => {
  if (!Array.isArray(prices)) throw Error('not an array');
  // Convert input data to prices, labels and values
  let values = [];
  let isForecastList = [];
  if (prices.length > 0 && typeof prices[0] === 'object' && prices[0] !== null && 'price' in prices[0]) {
    values = prices.map((p) => p.price);
    isForecastList = prices.map((p) => p.isForecast);
  } else {
    values = [...prices];
  }
  if (values.length < 24 * (60 / interval)) values = values.concat(Array(24 * (60 / interval) - values.length).fill(null));
  const labels = values.map((value, index) => {
    const hour = startHour + (index * (interval / 60));
    // Check if this is a full hour (minute part is 0)
    if (Math.abs(hour % 1) < 1e-8) {
      return (hour % 24).toString().padStart(2, '0');
    }
    return '';
  });

  // Map color of each bar based on value.
  const sortedPrices = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
  const peaks = [...sortedPrices].slice(0, 4 / (interval / 60));
  const troughs = [...sortedPrices].reverse().slice(0, 4 / (interval / 60));
  const backgrounds = values.map((value, idx) => {
    if (isForecastList.length > 0) {
      if (isForecastList[idx]) return 'rgb(210,210,210)';
    } else if (idx >= marketLength) return 'rgb(210,210,210)'; // light grey (is forecasted price)

    if (value <= 0) {
      return 'rgb(189,44,188)'; // Purple (free energy)
    }
    if (troughs.includes(value)) {
      return 'rgb(0,170,101)'; // Green (relatively cheap)
    }
    if (peaks.includes(value)) {
      return 'rgb(237,95,23)'; // Orange (high price)
    }
    return 'rgb(53,86,81)'; // Dark green (normal price)
  });

  // Add a data label to the cheapest and most expensive hour
  const cheapestIndex = values.indexOf(troughs[0]);
  const expensiveIndex = values.indexOf(peaks[0]);
  const datalabels = values.map((value, index) => {
    if (index === cheapestIndex || index === expensiveIndex) {
      return [`${value.toFixed(2)}`];
    }
    return [];
  });

  // Build configuration for the chart
  const height = 480; // 320;
  const width = 640; // 427; // 540;
  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Prices',
          backgroundColor: backgrounds,
          data: values,
        },
      ],
    },
    options: {
      responsive: true,
      legend: {
        position: 'none',
        labels: {
          fontColor: 'white',
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
      rectangleRadius: 6,
      plugins: {
        datalabels: {
          anchor: 'end',
          align: 'start',
          offset: -40,
          padding: 5,
          backgroundColor: backgrounds,
          color: 'white',
          borderWidth: 2,
          borderColor: 'white',
          borderRadius: 100,
          font: {
            size: 18,
          },
        },
      },
      datalabels,
      scales: {
        xAxes: [{
          ticks: {
            fontSize: 20,
            fontColor: 'white',
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

  const query = {
    bkg: 'black', // 'white',
    height,
    width,
    c: JSON.stringify(chart),
  };
  const path = chartEP + querystring.stringify(query);
  const url = `https://${defaultHost}${path}`;
  return url;
};

const getChargeChart = async (strategy, startHour = 0, marketLength = 99, maxChargePower = 2200, maxDischargePower = 1700, interval = 60) => {
  try {
    if (!strategy || !strategy.scheme) throw Error('strategy input is invalid');

    // Convert input data to prices, labels and values
    const scheme = JSON.parse(strategy.scheme);
    // const SoCs = Object.keys(scheme).map((hour) => scheme[hour].soc);
    let prices = Object.keys(scheme).map((hour) => scheme[hour].price);
    if (prices.length < 24 * (60 / interval)) prices = prices.concat(Array(24 * (60 / interval) - prices.length).fill(null));
    const labels = prices.map((value, index) => {
      const hour = startHour + (index * (interval / 60));
      // Check if this is a full hour (minute part is 0)
      if (Math.abs(hour % 1) < 1e-8) {
        return (hour % 24).toString().padStart(2, '0');
      }
      return '';
    });

    // Map color of each bar based on dis/charge power.
    const backgrounds = Object.keys(scheme).map((idx) => {
      const hour = scheme[idx];
      if (hour.power < 0) { // charging
        const chargeEnergy = -hour.power * (hour.duration / 60);
        const g = 255 - 100 * (chargeEnergy / maxChargePower);
        return `rgb(0,${Math.round(g)},0)`; // Green (charging)
      }
      if (hour.power > 0) { // discharging
        const dischargeEnergy = hour.power * (hour.duration / 60);
        const r = 255 - 100 * (dischargeEnergy / maxDischargePower);
        return `rgb(${Math.round(r)},50,20)`; // darkRed (discharging)
      }
      if (hour.isForecast) return 'rgb(210,210,210)'; // light grey (is forecasted price)
      if (idx >= marketLength) return 'rgb(210,210,210)'; // light grey (is forecasted price)
      return 'rgb(140,140,140)'; // dark grey (no dis/charge)
    });

    // Add a data label to the cheapest and most expensive hour
    const sortedPrices = [...prices].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
    const cheapestIndex = prices.indexOf(sortedPrices[0]);
    const expensiveIndex = prices.indexOf(sortedPrices[sortedPrices.length - 1]);
    const datalabels = prices.map((value, index) => {
      if (index === cheapestIndex || index === expensiveIndex) {
        return [`${value.toFixed(2)}`];
      }
      return [];
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
          },
        ],
      },
      options: {
        responsive: true,
        legend: {
          position: 'none',
          labels: {
            fontColor: 'white',
          },
        },
        layout: {
          padding: {
            top: 35,
            bottom: 0,
            left: 5,
            right: 5,
          },
        },
        rectangleRadius: 6,
        plugins: {
          datalabels: {
            anchor: 'end',
            align: 'start',
            offset: -40,
            padding: 5,
            backgroundColor: backgrounds,
            color: 'white',
            borderWidth: 2,
            borderColor: 'white',
            borderRadius: 100,
            font: {
              size: 14,
            },
          },
        },
        datalabels,
        scales: {
          xAxes: [{
            ticks: {
              fontSize: 20,
              fontColor: 'white',
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

    const query = {
      bkg: 'black',
      height,
      width,
      c: JSON.stringify(chart),
    };
    const path = chartEP + querystring.stringify(query);
    const url = `https://${defaultHost}${path}`;
    return Promise.resolve(url);
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports = { getPriceChart, getChargeChart };
