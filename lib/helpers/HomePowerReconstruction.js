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

const { smoothTimeSeries } = require('./HistoryLookup');

/**
 * Combines fetched raw Insights entries into one home-power series per 15-minute bucket:
 * home = grid + solar - battery - EV - appliances. No Homey dependency, so offline analysis runs
 * the same logic.
 *
 * @param {Object} params
 * @param {Array<{t:number, v?:number, y?:number}>} params.gridImportEntries - grid import/measure_power
 * @param {Array<{t:number, v?:number, y?:number}>} [params.gridExportEntries] - grid export, if any
 * @param {Array<{devId:string, entries:Array}>} [params.solarEntriesList] - per device
 * @param {Array<{devId:string, entries:Array}>} [params.batteryEntriesList] - per device
 * @param {Array<{devId:string, entries:Array}>} [params.evEntriesList] - per device
 * @param {Array<{devId:string, entries:Array}>} [params.applianceEntriesList] - per device: the
 *   home load to learn is without them
 * @param {boolean} [params.applySmoothing] - smoothTimeSeries() per component first (default true)
 * @param {(msg: string) => void} [params.logger] - optional log sink
 * @returns {Array<{t: string, y: number, grid: number}>} ISO time, home W, grid exchange
 *   (+ import / - export)
 */
const combineComponentsToHomePower = ({
  gridImportEntries,
  gridExportEntries = [],
  solarEntriesList = [],
  batteryEntriesList = [],
  evEntriesList = [],
  applianceEntriesList = [],
  applySmoothing = true,
  logger = () => {},
  // Plausibility clamp (grid passes its connection-derived ceiling, see GridConnection.js).
  maxPowerW = 30000,
}) => {
  const prep = (entries) => (applySmoothing ? smoothTimeSeries(entries) : entries);

  const timeIndex = {};
  const roundTo15Mins = (t) => Math.round(new Date(t).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);

  // Components are kept per devId: averaged per device within a bucket, then summed across devices.
  const addEntries = (entries, type, devId) => {
    entries.forEach((e) => {
      const key = roundTo15Mins(e.t);
      if (!timeIndex[key]) {
        timeIndex[key] = {
          gridImport: [], gridExport: [], solar: {}, battery: {}, ev: {}, appliance: {},
        };
      }
      const val = e.v !== undefined ? e.v : e.y;
      if (type === 'gridImport' || type === 'gridExport') {
        timeIndex[key][type].push(val);
      } else {
        if (!timeIndex[key][type][devId]) timeIndex[key][type][devId] = [];
        timeIndex[key][type][devId].push(val);
      }
    });
  };

  if (gridImportEntries.length > 0) addEntries(prep(gridImportEntries), 'gridImport');
  if (gridExportEntries.length > 0) addEntries(prep(gridExportEntries), 'gridExport');
  solarEntriesList.forEach(({ devId, entries }) => addEntries(prep(entries), 'solar', devId));
  batteryEntriesList.forEach(({ devId, entries }) => addEntries(prep(entries), 'battery', devId));
  evEntriesList.forEach(({ devId, entries }) => addEntries(prep(entries), 'ev', devId));
  applianceEntriesList.forEach(({ devId, entries }) => addEntries(prep(entries), 'appliance', devId));

  const reconstructed = [];
  const timestamps = Object.keys(timeIndex).map(Number).sort((a, b) => a - b);

  timestamps.forEach((t) => {
    const data = timeIndex[t];
    if (data.gridImport.length === 0) return;

    const gridImport = data.gridImport.reduce((a, b) => a + b, 0) / data.gridImport.length;
    const gridExport = data.gridExport.length > 0 ? data.gridExport.reduce((a, b) => a + b, 0) / data.gridExport.length : 0;
    const gridPower = gridImport - gridExport;

    const sumAcrossDevices = (perDevice) => Object.values(perDevice)
      .reduce((total, samples) => total + (samples.reduce((a, b) => a + b, 0) / samples.length), 0);
    const solarPower = sumAcrossDevices(data.solar);
    const batteryPower = sumAcrossDevices(data.battery);
    const evPower = sumAcrossDevices(data.ev);

    const homePower = gridPower + solarPower - batteryPower - evPower;
    const appliancePower = sumAcrossDevices(data.appliance);

    // A large negative residual is an unreliable sample: dropped, not clamped to 0.
    const IMPLAUSIBLE_NEGATIVE_RESIDUAL_W = -150;
    if (homePower < IMPLAUSIBLE_NEGATIVE_RESIDUAL_W) {
      logger(`[Diag] Dropping implausible reconstructed sample at ${new Date(t).toISOString()}: `
        + `gridImport=${Math.round(gridImport)} gridExport=${Math.round(gridExport)} `
        + `solarPower=${Math.round(solarPower)} batteryPower=${Math.round(batteryPower)} evPower=${Math.round(evPower)} `
        + `-> homePower(raw)=${Math.round(homePower)}`);
      return;
    }

    reconstructed.push({
      t: new Date(t).toISOString(),
      y: Math.max(0, Math.min(maxPowerW, Math.round(homePower - appliancePower))),
      grid: Math.round(gridPower),
    });
  });

  logger(`Successfully reconstructed ${reconstructed.length} home power entries from component history.`);
  return reconstructed;
};

module.exports = { combineComponentsToHomePower };
