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

const {
  hourLabels, slotTimes, nowLineAnnotation, LEGEND_FILTER, withLegendFilter,
} = require('./ChartHelpers');
const { color, PALE, powerAlpha } = require('./Palette');

// Plan actions (PrecisePlanner blocks, as the battery_action capability), in palette colours: charging
// the device colour, discharging export, XOM home (covers the home), saving (hold) hold; rest idle.
// The device's own power: neutral, the device colour is its SoC.
const POWER_LINE = 'rgba(255, 255, 255, 0.8)';
const POWER_LINE_PLANNED = 'rgba(255, 255, 255, 0.5)';
const POWER_FILL = 'rgba(255, 255, 255, 0.08)';
const actionColor = (key, device, alpha = 1) => {
  if (key === 'charge' || key === 'chargeEv') return color(device, alpha);
  if (key === 'discharge' || key === 'dischargeEv') return color('export', alpha);
  if (key === 'xom') return color('home', alpha);
  if (key === 'hold') return color('hold', alpha);
  return color('idle', alpha);
};

// Legend entries for the bar colors, in this order: [key, translation key]. Without a block (EV) a bar
// is charging or discharging. Idle needs no entry.
const LEGEND_BARS = [
  ['xom', 'xom'],
  ['hold', 'hold'],
  ['charge', 'charge'],
  ['discharge', 'discharge'],
  ['chargeEv', 'charge'],
  ['dischargeEv', 'discharge'],
];

const BLOCKS = ['xom', 'hold', 'charge', 'discharge'];
const legendBarKey = (slot) => {
  if (slot.block) return BLOCKS.includes(slot.block) ? slot.block : 'idle';
  if (slot.power > 0) return 'chargeEv';
  return slot.power < 0 ? 'dischargeEv' : 'idle';
};

const getChargeChart = async (
  plan,
  startMs = Date.now(),
  marketLength = 99,
  maxChargePower = 2200,
  maxDischargePower = 1700,
  interval = 60,
  exportPrices = [],
  currency = '€',
  translations = {},
  isToday = false,
  timeZone = 'Europe/Amsterdam',
  showPower = false,
  showSoc = true,
  showExportPrice = true,
  showLegend = false,
  device = 'battery', // palette colour of the device: battery, ev or appliance
) => {
  try {
    if (!plan || !plan.scheme) throw Error('plan input is invalid');

    const scheme = JSON.parse(plan.scheme);
    const targetLength = Math.max(marketLength, Object.keys(scheme).length);
    for (let i = 0; i < targetLength; i += 1) {
      if (!scheme[i]) {
        scheme[i] = {
          power: 0, duration: 0, soc: null, price: null, isForecast: true, isFuture: true,
        };
      }
    }

    let prices = Object.keys(scheme).map((hour) => scheme[hour].price);
    prices = prices.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

    const realSocData = [];
    const forecastSocData = [];
    let lastRealSocIdx = -1;

    Object.keys(scheme).forEach((idx, index) => {
      const hour = scheme[idx];
      // isFuture (the slot has not happened) is independent of isForecast (price not published);
      // isForecast is the fallback for callers without isFuture.
      const isFuture = (typeof hour.isFuture === 'boolean' ? hour.isFuture : hour.isForecast) || index >= marketLength;
      const val = typeof hour.soc === 'number' ? hour.soc : null;

      if (!isFuture && val !== null) {
        realSocData[index] = val;
        forecastSocData[index] = null;
        lastRealSocIdx = index;
      } else {
        realSocData[index] = null;
        forecastSocData[index] = val;
      }
    });

    if (lastRealSocIdx >= 0 && forecastSocData[lastRealSocIdx + 1] !== undefined) {
      forecastSocData[lastRealSocIdx] = realSocData[lastRealSocIdx];
    }

    let exportPricesData = Object.keys(scheme).map((hour) => (exportPrices && exportPrices[hour] !== undefined ? exportPrices[hour] : null));
    exportPricesData = exportPricesData.map((v) => (typeof v === 'number' ? parseFloat(v.toFixed(3)) : v));

    const startTimestamp = startMs instanceof Date ? startMs.getTime() : startMs;
    const labels = hourLabels(slotTimes(startTimestamp, prices.length, interval), timeZone);

    const sortedPrices = [...prices].filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
    const maxVal = sortedPrices[0] || 0;
    const minVal = sortedPrices[sortedPrices.length - 1] || 0;
    const valueRange = Math.max(maxVal, 0) - Math.min(minVal, 0);

    // Bar colors: the action, more solid at more (dis)charge power; pale on a price not yet published.
    const backgrounds = Object.keys(scheme).map((idx, index) => {
      const hour = scheme[idx];
      const key = legendBarKey(hour);
      let alpha = hour.isForecast || index >= marketLength ? PALE : 1;
      if (['charge', 'discharge', 'chargeEv', 'dischargeEv'].includes(key) && typeof hour.power === 'number') {
        const max = hour.power > 0 ? maxChargePower : maxDischargePower;
        const share = typeof hour.duration === 'number' && interval > 0 ? Math.min(1, hour.duration / interval) : 1;
        alpha *= max > 0 ? powerAlpha((Math.abs(hour.power) * share) / max) : 1;
      }
      return actionColor(key, device, alpha);
    });

    const plannedPowerData = Object.keys(scheme).map((hour) => {
      const p = scheme[hour].power;
      return typeof p === 'number' && p !== 0 ? parseFloat((p / 1000).toFixed(2)) : 0;
    });

    const actualPowerData = Object.keys(scheme).map((hour) => {
      const p = scheme[hour].actualPower;
      return typeof p === 'number' && Number.isFinite(p) ? parseFloat((p / 1000).toFixed(2)) : null;
    });

    const validActual = actualPowerData.filter((v) => typeof v === 'number' && Number.isFinite(v));
    const validPlanned = plannedPowerData.filter((v) => typeof v === 'number' && Number.isFinite(v));
    const allPowerValues = [...validActual, ...validPlanned];

    const maxPowerVal = allPowerValues.length > 0 ? Math.max(...allPowerValues) : 0;
    const minPowerVal = allPowerValues.length > 0 ? Math.min(...allPowerValues) : 0;

    const baseChargeKW = (typeof maxChargePower === 'number' && maxChargePower > 0) ? maxChargePower / 1000 : 3.7;
    const baseDischargeKW = (typeof maxDischargePower === 'number' && maxDischargePower > 0) ? -maxDischargePower / 1000 : -baseChargeKW;

    const suggestedMaxPower = parseFloat((Math.max(1.0, baseChargeKW, maxPowerVal) * 1.15).toFixed(2));
    const hasNegativePower = minPowerVal < 0 || (typeof maxDischargePower === 'number' && maxDischargePower > 0);
    const suggestedMinPower = hasNegativePower
      ? parseFloat((Math.min(-1.0, baseDischargeKW, minPowerVal) * 1.15).toFixed(2))
      : 0;
    // Legend texts (translations.legend, keys of chart_legend in the locales): the bar colors only (the
    // lines have their own axis). An empty label is left out of the legend.
    const legend = translations.legend || {};
    const barKeys = new Set(Object.keys(scheme).filter((k) => typeof scheme[k].price === 'number').map((k) => legendBarKey(scheme[k])));
    const shown = new Set();
    const legendDatasets = showLegend ? LEGEND_BARS.filter(([key, textKey]) => {
      if (!barKeys.has(key) || shown.has(textKey)) return false;
      shown.add(textKey);
      return true;
    }).map(([key, textKey]) => ({
      label: legend[textKey] || textKey,
      type: 'line',
      data: [],
      backgroundColor: actionColor(key, device),
      borderColor: actionColor(key, device),
      borderWidth: 0,
      datalabels: {
        display: false,
      },
    })) : [];
    const height = 320;
    const width = 427;
    const powerDatasets = showPower ? [
      {
        label: '',
        type: 'line',
        data: plannedPowerData,
        borderColor: POWER_LINE_PLANNED,
        borderDash: [5, 5],
        borderWidth: 2,
        backgroundColor: POWER_FILL,
        pointRadius: 0,
        fill: true,
        stepped: 'middle',
        yAxisID: 'yPower',
        order: 3,
        datalabels: {
          display: false,
        },
      },
      {
        label: '',
        type: 'line',
        data: actualPowerData,
        borderColor: POWER_LINE,
        borderWidth: 3,
        backgroundColor: 'transparent',
        pointRadius: 0,
        fill: false,
        stepped: 'middle',
        spanGaps: true,
        yAxisID: 'yPower',
        order: 1,
        datalabels: {
          display: false,
        },
      },
    ] : [];
    const socDatasets = showSoc ? [
      {
        label: '',
        type: 'line',
        data: realSocData,
        borderColor: color(device),
        borderWidth: 3,
        backgroundColor: 'transparent',
        pointRadius: 0,
        yAxisID: 'y1',
        order: 0,
        datalabels: {
          display: false,
        },
      },
      {
        label: '',
        type: 'line',
        data: forecastSocData,
        borderColor: color(device, 0.6),
        borderDash: [5, 5],
        borderWidth: 2,
        backgroundColor: 'transparent',
        pointRadius: 0,
        spanGaps: true,
        yAxisID: 'y1',
        order: 2,
        datalabels: {
          display: false,
        },
      },
    ] : [];
    const chart = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '',
            backgroundColor: backgrounds,
            data: prices,
            order: 5,
          },
          ...legendDatasets,
          ...powerDatasets,
          ...socDatasets,
          // The export price line with a dark edge: it stays visible on discharge (export) bars.
          ...(showExportPrice ? [['rgb(0, 0, 0)', 4, 4.5], [color('export'), 2, 4]].map(([lineColor, width, order]) => ({
            label: '',
            type: 'line',
            data: exportPricesData,
            borderColor: lineColor,
            borderWidth: width,
            backgroundColor: 'transparent',
            pointRadius: 0,
            fill: false,
            stepped: 'middle',
            order,
            datalabels: {
              display: false,
            },
          })) : []),
        ],
      },
      options: {
        responsive: true,
        layout: {
          padding: {
            top: 35,
            bottom: showLegend ? 0 : 35,
            left: 0,
            right: 0,
          },
        },
        plugins: {
          legend: {
            display: showLegend,
            position: 'bottom',
            labels: {
              color: 'white',
              font: { size: 13 },
              boxWidth: 14,
              padding: 6,
              // only with withLegendFilter(): QuickChart calls a filter even with the legend hidden
              ...(showLegend && { filter: LEGEND_FILTER }),
            },
          },
          datalabels: {
            display: false,
          },
          annotation: {
            annotations: isToday ? nowLineAnnotation(startTimestamp, interval, prices.length) : {},
          },
          title: {
            display: true,
            text: (() => {
              let rightLabel = '';
              if (showSoc) rightLabel += '%';
              if (showPower) rightLabel += rightLabel ? '   kW' : 'kW';
              return rightLabel ? `  ${currency}${' '.repeat(100)}${rightLabel}` : `  ${currency}`;
            })(),
            color: 'white',
            font: { size: 14, weight: 'bold' },
            align: 'start',
            padding: { bottom: 5 },
          },
        },
        scales: {
          x: {
            ticks: {
              font: { size: 18 },
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
              font: { size: 14 },
              color: 'white',
              padding: 2,
              format: { minimumFractionDigits: 2, maximumFractionDigits: 3 },
            },
            title: {
              display: false,
            },
            grid: {
              color: 'rgba(255,255,255,0.2)',
            },
          },
          y1: {
            display: showSoc,
            position: 'right',
            min: 0,
            max: 100,
            ticks: {
              font: { size: 14 },
              color: color(device),
              padding: 2,
            },
            title: {
              display: false,
            },
            grid: {
              drawOnChartArea: false,
            },
          },
          yPower: {
            display: showPower,
            position: 'right',
            suggestedMin: suggestedMinPower,
            suggestedMax: suggestedMaxPower,
            ticks: {
              font: { size: 14 },
              color: POWER_LINE,
              padding: 2,
            },
            title: {
              display: false,
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
      chart: showLegend ? withLegendFilter(chart) : chart,
    });
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports = { getChargeChart };
