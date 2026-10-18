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

// The bidding zone (and gas hub, currency) to propose when pairing a price device: the country
// from Homey's time zone, then within a country with several zones the zone whose centre is
// nearest to Homey's location. Centres are rough (for choosing within one country only).

// Electricity bidding zones (EIC) by country, with an approximate centre [lat, lon].
const POWER_ZONES = {
  AL: { '10YAL-KESH-----5': [41.2, 20.2] },
  AT: { '10YAT-APG------L': [47.5, 14.6] },
  BE: { '10YBE----------2': [50.5, 4.5] },
  BG: { '10YCA-BULGARIA-R': [42.7, 25.5] },
  CH: { '10YCH-SWISSGRIDZ': [46.8, 8.2] },
  CZ: { '10YCZ-CEPS-----N': [49.8, 15.5] },
  DE: { '10Y1001A1001A82H': [51.2, 10.5] },
  DK: { '10YDK-1--------W': [56.0, 9.2], '10YDK-2--------M': [55.5, 11.9] },
  EE: { '10Y1001A1001A39I': [58.6, 25.0] },
  ES: { '10YES-REE------0': [40.0, -3.7] },
  FI: { '10YFI-1--------U': [64.0, 26.0] },
  FR: { '10YFR-RTE------C': [46.6, 2.2] },
  GR: { '10YGR-HTSO-----Y': [39.1, 21.8] },
  HR: { '10YHR-HEP------M': [45.1, 15.2] },
  HU: { '10YHU-MAVIR----U': [47.2, 19.5] },
  IE: { '10Y1001A1001A59C': [53.4, -7.7] },
  IT: {
    '10Y1001A1001A73I': [45.5, 9.5], // North
    '10Y1001A1001A70O': [43.5, 11.5], // Centre North
    '10Y1001A1001A71M': [41.9, 13.5], // Centre South
    '10Y1001A1001A788': [40.8, 15.8], // South
    '10Y1001C--00096J': [39.0, 16.5], // Calabria
    '10Y1001A1001A75E': [37.6, 14.0], // Sicily
    '10Y1001A1001A74G': [40.1, 9.0], // Sardinia
  },
  LT: { '10YLT-1001A0008Q': [55.2, 23.9] },
  LV: { '10YLV-1001A00074': [56.9, 24.6] },
  ME: { '10YCS-CG-TSO---S': [42.7, 19.4] },
  MK: { '10YMK-MEPSO----8': [41.6, 21.7] },
  NL: { '10YNL----------L': [52.1, 5.3] },
  NO: {
    '10YNO-1--------2': [60.0, 10.8],
    '10YNO-2--------T': [58.9, 7.0],
    '10YNO-3--------J': [63.4, 10.4],
    '10YNO-4--------9': [68.5, 16.0],
    '10Y1001A1001A48H': [60.6, 6.0],
  },
  PL: { '10YPL-AREA-----S': [52.0, 19.1] },
  PT: { '10YPT-REN------W': [39.5, -8.0] },
  RO: { '10YRO-TEL------P': [45.9, 25.0] },
  RS: { '10YCS-SERBIATSOV': [44.0, 20.9] },
  SE: {
    '10Y1001A1001A44P': [66.5, 20.5],
    '10Y1001A1001A45N': [63.0, 16.5],
    '10Y1001A1001A46L': [59.3, 15.5],
    '10Y1001A1001A47J': [56.0, 13.5],
  },
  SI: { '10YSI-ELES-----O': [46.2, 15.0] },
  SK: { '10YSK-SEPS-----K': [48.7, 19.7] },
  UA: { '10Y1001C--000182': [49.0, 31.0] },
  XK: { '10Y1001C--00100H': [42.6, 20.9] },
};

// Gas hub (zone id of the gas providers) by country; others use TTF.
const GAS_HUBS = {
  NL: 'TTF_LEBA_EasyEnergy',
  BE: 'ZTP_EOD',
  DE: 'THE_EOD',
  LU: 'THE_EOD',
  FR: 'PEG_EOD',
  AT: 'CEGH_VTP_EOD',
  CZ: 'CZ_VTP_EOD',
  SK: 'CZ_VTP_EOD',
  ES: 'PVB_EOD',
  PT: 'PVB_EOD',
  DK: 'ETF_EOD',
  SE: 'ETF_EOD',
  FI: 'FIN_EOD',
  LT: 'LTU_EOD',
  LV: 'LVA_EST_EOD',
  EE: 'LVA_EST_EOD',
  IE: 'NBP_EOD',
  GB: 'NBP_EOD',
};
const DEFAULT_GAS_HUB = 'TTF_EOD';

// Currency (symbol, ECB code for fetchExchangeRate) by country; others use €.
const CURRENCIES = {
  NO: { symbol: 'kr', code: 'NOK' },
  SE: { symbol: 'kr', code: 'SEK' },
  DK: { symbol: 'kr', code: 'DKK' },
  PL: { symbol: 'zł', code: 'PLN' },
  CZ: { symbol: 'Kč', code: 'CZK' },
  HU: { symbol: 'Ft', code: 'HUF' },
  RO: { symbol: 'lei', code: 'RON' },
  CH: { symbol: 'CHF', code: 'CHF' },
  GB: { symbol: '£', code: 'GBP' },
};
const EURO = { symbol: '€', code: 'NONE' };

// Currencies to choose from when pairing (code: fetchExchangeRate setting, NONE = euro).
const CURRENCY_LIST = [
  EURO, CURRENCIES.NO, CURRENCIES.SE, CURRENCIES.DK, CURRENCIES.PL, CURRENCIES.CZ, CURRENCIES.HU, CURRENCIES.RO,
  CURRENCIES.CH, CURRENCIES.GB,
  { symbol: 'лв', code: 'BGN' }, { symbol: 'kr', code: 'ISK' }, { symbol: '₺', code: 'TRY' },
  { symbol: '$', code: 'USD' }, { symbol: 'A$', code: 'AUD' },
];

// IANA time zone to country.
const TIME_ZONES = {
  'Europe/Tirane': 'AL',
  'Europe/Vienna': 'AT',
  'Europe/Brussels': 'BE',
  'Europe/Sofia': 'BG',
  'Europe/Zurich': 'CH',
  'Europe/Prague': 'CZ',
  'Europe/Berlin': 'DE',
  'Europe/Busingen': 'DE',
  'Europe/Luxembourg': 'LU',
  'Europe/Copenhagen': 'DK',
  'Europe/Tallinn': 'EE',
  'Europe/Madrid': 'ES',
  'Atlantic/Canary': 'ES',
  'Europe/Helsinki': 'FI',
  'Europe/Mariehamn': 'FI',
  'Europe/Paris': 'FR',
  'Europe/Monaco': 'FR',
  'Europe/Athens': 'GR',
  'Europe/Zagreb': 'HR',
  'Europe/Budapest': 'HU',
  'Europe/Dublin': 'IE',
  'Europe/Belfast': 'IE',
  'Europe/Rome': 'IT',
  'Europe/Vatican': 'IT',
  'Europe/San_Marino': 'IT',
  'Europe/Vilnius': 'LT',
  'Europe/Riga': 'LV',
  'Europe/Podgorica': 'ME',
  'Europe/Skopje': 'MK',
  'Europe/Amsterdam': 'NL',
  'Europe/Oslo': 'NO',
  'Europe/Warsaw': 'PL',
  'Europe/Lisbon': 'PT',
  'Atlantic/Madeira': 'PT',
  'Atlantic/Azores': 'PT',
  'Europe/Bucharest': 'RO',
  'Europe/Belgrade': 'RS',
  'Europe/Stockholm': 'SE',
  'Europe/Ljubljana': 'SI',
  'Europe/Bratislava': 'SK',
  'Europe/Kiev': 'UA',
  'Europe/Kyiv': 'UA',
  'Europe/London': 'GB',
};

const distance = ([lat1, lon1], [lat2, lon2]) => {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y);
};

// Electricity zones in Luxembourg are those of Germany (DE-LU).
const powerCountry = (country) => (country === 'LU' ? 'DE' : country);

const nearest = (zones, location) => {
  const ids = Object.keys(zones);
  if (!location || ids.length === 1) return ids[0] || null;
  return ids.reduce((best, id) => (distance(zones[id], location) < distance(zones[best], location) ? id : best));
};

/**
 * The country of Homey: from the time zone, else the country of the nearest zone centre.
 * @param {string} timeZone
 * @param {number[]|null} location - [lat, lon]
 * @returns {string|null}
 */
const countryOf = (timeZone, location) => {
  if (TIME_ZONES[timeZone]) return TIME_ZONES[timeZone];
  if (!location) return null;
  let best = null;
  Object.entries(POWER_ZONES).forEach(([country, zones]) => {
    Object.values(zones).forEach((centre) => {
      const d = distance(centre, location);
      if (!best || d < best.d) best = { country, d };
    });
  });
  return best && best.country;
};

/**
 * Proposal for a new price device.
 * @param {string} timeZone
 * @param {number[]|null} location - [lat, lon]
 * @returns {{ country, powerZone, gasZone, currency, fetchExchangeRate }}
 */
const propose = (timeZone, location) => {
  const country = countryOf(timeZone, location);
  const zones = POWER_ZONES[powerCountry(country)] || POWER_ZONES.NL;
  const currency = CURRENCIES[country] || EURO;
  return {
    country,
    powerZone: nearest(zones, location),
    gasZone: GAS_HUBS[country] || DEFAULT_GAS_HUB,
    currency: currency.symbol,
    fetchExchangeRate: currency.code,
  };
};

// The country of an electricity zone, or null.
const countryOfZone = (zone) => Object.keys(POWER_ZONES).find((country) => POWER_ZONES[country][zone]) || null;

// Currency for an electricity zone: { symbol, code }.
const currencyOfZone = (zone) => CURRENCIES[countryOfZone(zone)] || EURO;

module.exports = {
  CURRENCY_LIST,
  propose,
  countryOf,
  countryOfZone,
  currencyOfZone,
};
