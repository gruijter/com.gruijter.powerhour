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

const combineComponentsToHomePower = ({
  gridImportEntries,
  gridExportEntries = [],
  solarEntriesList = [],
  batteryEntriesList = [],
  evEntriesList = [],
  applianceEntriesList = [],
  applySmoothing = true,
  logger = () => {},
  maxPowerW = 30000,
}) => {
  const prep = (entries) => (applySmoothing ? smoothTimeSeries(entries) : entries);

  const timeIndex = {};
  const roundTo15Mins = (t) => Math.round(new Date(t).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);

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
