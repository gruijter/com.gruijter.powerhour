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
 * Pure combination step of grid device.js's reconstructHomePowerHistory(): given already-FETCHED
 * raw Insights entries for grid import/export and each solar/battery/EV component device, combine
 * them into a single home-power time series (homePower = grid + solar - battery - EV per matched
 * 15-minute bucket). Deliberately has no Homey/API/`this` dependency, so it can be unit-tested or
 * run offline against previously-fetched Insights JSON, independent of a live Homey - and so the
 * app device method and any offline analysis script are guaranteed to run the exact same logic,
 * not two independently-maintained copies that can silently drift apart.
 *
 * @param {Object} params
 * @param {Array<{t:number, v?:number, y?:number}>} params.gridImportEntries - raw grid import/measure_power entries
 * @param {Array<{t:number, v?:number, y?:number}>} [params.gridExportEntries] - raw grid export entries, if any
 * @param {Array<{devId:string, entries:Array}>} [params.solarEntriesList] - raw per-device solar entries
 * @param {Array<{devId:string, entries:Array}>} [params.batteryEntriesList] - raw per-device battery entries
 * @param {Array<{devId:string, entries:Array}>} [params.evEntriesList] - raw per-device EV charger entries
 * @param {boolean} [params.applySmoothing] - apply smoothTimeSeries() to each component before
 *   combining (see HistoryLookup.js's smoothTimeSeries doc for why). Default true; exposed as a
 *   flag specifically so offline analysis can A/B compare with/without it against real data.
 * @param {(msg: string) => void} [params.logger] - optional log sink, defaults to no-op
 * @returns {Array<{t: string, y: number}>} reconstructed home-power samples, ISO timestamp + Watts
 */
const combineComponentsToHomePower = ({
  gridImportEntries,
  gridExportEntries = [],
  solarEntriesList = [],
  batteryEntriesList = [],
  evEntriesList = [],
  applySmoothing = true,
  logger = () => {},
}) => {
  const prep = (entries) => (applySmoothing ? smoothTimeSeries(entries) : entries);

  const timeIndex = {};
  const roundTo15Mins = (t) => Math.round(new Date(t).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);

  // For 'gridImport'/'gridExport' (a single source device, never multiple), entries is a flat
  // array. For 'solar'/'battery'/'ev', entries is grouped per devId so the combination step below
  // can average each device's own samples within the bucket (handling that device's own polling
  // jitter) and then SUM across devices - not average across them.
  const addEntries = (entries, type, devId) => {
    entries.forEach((e) => {
      const key = roundTo15Mins(e.t);
      if (!timeIndex[key]) {
        timeIndex[key] = {
          gridImport: [], gridExport: [], solar: {}, battery: {}, ev: {},
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

    // Home load can never be physically negative - a large negative residual means this
    // sample's components weren't reliable enough to combine (see grid/device.js's identical
    // comment at the call site for the full reasoning). Dropped rather than clamped to 0, so a
    // measurement artifact doesn't get trained into the weekly profile as a fake "no load".
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
      y: Math.max(0, Math.min(30000, Math.round(homePower))),
    });
  });

  logger(`Successfully reconstructed ${reconstructed.length} home power entries from component history.`);
  return reconstructed;
};

module.exports = { combineComponentsToHomePower };
