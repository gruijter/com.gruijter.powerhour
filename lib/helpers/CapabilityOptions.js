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

// The unit and decimals options a device's capabilities should have, from its settings, for
// DeviceMigrator.syncCapabilityOptions() at every start: { capability: options }.

/**
 * Money, price and tariff capabilities in the currency.
 * @param {string[]} caps - the device's capabilities
 * @param {object} o
 * @param {string} [o.currency] - '' or missing: defaultCurrency
 * @param {number} [o.decimals] - of the money values (default 2)
 * @param {string} o.defaultCurrency
 * @param {string} [o.perUnit] - meters and batteries: money caps, and averages per this unit
 *   (e.g. €/kWh); without it the price caps of a DAP device
 */
const currency = (caps, {
  currency: cur, decimals, defaultCurrency, perUnit = null,
}) => {
  const unit = cur || defaultCurrency;
  const dec = Number.isInteger(decimals) ? decimals : 2;
  const out = {};
  let money = caps.filter((cap) => cap.includes('meter_money'));
  if (perUnit) money = caps.filter((cap) => cap.includes('money') && !cap.includes('_avg'));
  else if (caps.some((cap) => cap.includes('meter_price'))) money = caps.filter((cap) => cap.includes('meter_price'));
  money.forEach((cap) => {
    out[cap] = { units: { en: unit }, decimals: dec };
  });
  if (caps.includes('meter_tariff')) out.meter_tariff = { units: { en: unit }, decimals: 4 };
  if (perUnit) {
    caps.filter((cap) => cap.includes('money') && cap.includes('_avg')).forEach((cap) => {
      out[cap] = { units: { en: `${unit}/${perUnit}` }, decimals: 4 };
    });
  }
  return out;
};

// Energy and volume meters with the meter decimals (default 4); not the forecasts.
const meterDecimals = (caps, decimals) => {
  const dec = Number.isInteger(decimals) ? decimals : 4;
  const out = {};
  caps.filter((cap) => !cap.includes('forecast') && (cap.includes('meter_kwh') || cap.startsWith('meter_power')
    || cap.includes('meter_m3') || cap.startsWith('meter_gas') || cap.startsWith('meter_water')))
    .forEach((cap) => {
      out[cap] = { decimals: dec };
    });
  return out;
};

module.exports = { currency, meterDecimals };
