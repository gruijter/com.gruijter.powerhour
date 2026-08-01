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
    const targetLength = Math.max(24 * (60 / interval), Object.keys(scheme).length);
    for (let i = 0; i < targetLength; i += 1) {
      if (!scheme[i]) {
        scheme[i] = {
          power: 0, duration: 0, soc: null, price: null, isForecast: true,
        };
      }
    }

    let prices = Object.keys(scheme).map((hour) => scheme[hour].price);
    prices = prices.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

    const socData = Object.keys(scheme).map((hour) => (typeof scheme[hour].soc === 'number' ? scheme[hour].soc : null));

    let exportPricesData = Object.keys(scheme).map((hour) => (exportPrices && exportPrices[hour] !== undefined ? exportPrices[hour] : null));
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
    const maxVal = sortedPrices[0] || 0;
    const minVal = sortedPrices[sortedPrices.length - 1] || 0;
    const valueRange = Math.max(maxVal, 0) - Math.min(minVal, 0);

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

    const plannedPowerData = Object.keys(scheme).map((hour) => {
      const p = scheme[hour].power;
      return typeof p === 'number' && p > 0 ? parseFloat((p / 1000).toFixed(2)) : 0;
    });

    const actualPowerData = Object.keys(scheme).map((hour) => {
      const p = scheme[hour].actualPower;
      return typeof p === 'number' && p >= 0 ? parseFloat((p / 1000).toFixed(2)) : null;
    });

    const height = 320;
    const width = 427;
    const chart = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Prices',
            backgroundColor: backgrounds,
            data: prices,
            order: 4,
          },
          {
            label: 'Planned (kW)',
            type: 'line',
            data: plannedPowerData,
            borderColor: 'rgba(75, 192, 192, 0.8)',
            borderWidth: 2,
            backgroundColor: 'rgba(75, 192, 192, 0.25)',
            pointRadius: 0,
            fill: true,
            stepped: 'middle',
            yAxisID: 'yPower',
            order: 2,
            datalabels: {
              display: false,
            },
          },
          {
            label: 'Actual (kW)',
            type: 'line',
            data: actualPowerData,
            borderColor: 'rgb(255, 159, 64)',
            borderWidth: 3,
            backgroundColor: 'transparent',
            pointRadius: 2,
            fill: false,
            stepped: 'middle',
            spanGaps: true,
            yAxisID: 'yPower',
            order: 0,
            datalabels: {
              display: false,
            },
          },
          {
            label: 'SoC (%)',
            type: 'line',
            data: socData,
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 3,
            backgroundColor: 'transparent',
            pointRadius: 1,
            yAxisID: 'y1',
            order: 1,
            datalabels: {
              display: false,
            },
          },
          {
            label: 'Export',
            type: 'line',
            data: exportPricesData,
            borderColor: 'rgba(255, 215, 0, 0.8)',
            borderWidth: 2,
            backgroundColor: 'transparent',
            pointRadius: 0,
            fill: false,
            stepped: 'middle',
            order: 4,
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
            display: false,
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
          y1: {
            position: 'right',
            min: 0,
            max: 100,
            ticks: {
              font: { size: 16 },
              color: 'rgb(54, 162, 235)',
              callback: (val) => `${val}%`,
            },
            grid: {
              drawOnChartArea: false,
            },
          },
          yPower: {
            position: 'right',
            min: 0,
            suggestedMax: (() => {
              const validActual = actualPowerData.filter((v) => typeof v === 'number' && Number.isFinite(v));
              const maxActual = validActual.length > 0 ? Math.max(...validActual) : 0;
              const validPlanned = plannedPowerData.filter((v) => typeof v === 'number' && Number.isFinite(v));
              const maxPlanned = validPlanned.length > 0 ? Math.max(...validPlanned) : 0;
              const basePower = (typeof maxChargePower === 'number' && maxChargePower > 0) ? maxChargePower / 1000 : 3.7;
              return parseFloat((Math.max(1.0, basePower, maxPlanned, maxActual) * 1.15).toFixed(2));
            })(),
            ticks: {
              font: { size: 14 },
              color: 'rgb(255, 159, 64)',
              callback: (val) => `${val} kW`,
            },
            grid: {
              drawOnChartArea: false,
            },
          },
        },
        backgroundColor: 'black',
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

const getWeeklyEvChart = async (model, targetSoc = 80, defaultDepartureTime = '08:00', batCapacity = 50) => {
  try {
    const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
    const tripData = [];
    const datalabelsText = [];

    dayLabels.forEach((label, dow) => {
      const day = (model && model[dow]) || {};
      const depTime = day.learnedDepartureTime || defaultDepartureTime;
      const tripKwh = typeof day.learnedTripKwh === 'number' ? day.learnedTripKwh : Math.round(((targetSoc * 0.4) / 100) * batCapacity * 10) / 10;
      tripData.push(tripKwh);
      datalabelsText.push(`${depTime}\n${tripKwh}kWh`);
    });

    const chart = {
      type: 'bar',
      data: {
        labels: dayLabels,
        datasets: [
          {
            label: 'Trip kWh',
            backgroundColor: 'rgba(75, 192, 192, 0.85)',
            borderColor: 'rgb(75, 192, 192)',
            borderWidth: 1,
            data: tripData,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end',
            align: 'end',
            color: 'white',
            font: { size: 14, weight: 'bold' },
            formatter: (val, ctx) => datalabelsText[ctx.dataIndex] || '',
          },
        },
        scales: {
          x: {
            ticks: { font: { size: 18 }, color: 'white' },
            grid: { color: 'rgba(255,255,255,0.2)' },
          },
          y: {
            beginAtZero: true,
            suggestedMax: Math.max(...tripData, 10) * 1.3,
            ticks: { font: { size: 18 }, color: 'white', callback: (v) => `${v} kWh` },
            grid: { color: 'rgba(255,255,255,0.2)' },
          },
        },
      },
    };

    return Promise.resolve({
      version: '3',
      backgroundColor: 'black',
      width: 427,
      height: 320,
      chart,
    });
  } catch (err) {
    return Promise.reject(err);
  }
};

module.exports = { getChargeChart, getWeeklyEvChart };
