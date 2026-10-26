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

// The currency and money decimals of a meter, battery or EV charger: those of the price device of
// its tariff group (sent with its prices), kept in the store as { currency, decimals }. An older
// device that has none yet uses its removed currency/decimals settings (still in getSettings(),
// skill section 22).

const STORE_KEY = 'moneyUnit';

// Money decimals per ISO 4217 code (fetchExchangeRate setting); HUF in whole forints.
const ZERO_DECIMALS = ['ISK', 'HUF'];
const decimalsOf = (code) => (ZERO_DECIMALS.includes(code) ? 0 : 2);

const isDecimals = (value) => value !== undefined && value !== null && value !== '' && Number.isInteger(Number(value));

/**
 * The unit a price broadcast carries, or null without a currency.
 * @param {{ currency?: string, moneyDecimals?: number }} args
 */
const fromPrices = (args = {}) => (args.currency
  ? { currency: args.currency, decimals: isDecimals(args.moneyDecimals) ? Number(args.moneyDecimals) : 2 }
  : null);

/** @returns {{ currency: string, decimals: number }} */
const get = (device, defaultCurrency = '€') => {
  const stored = device.getStoreValue(STORE_KEY);
  if (stored && stored.currency) return stored;
  const { currency, decimals } = device.getSettings();
  return { currency: currency || defaultCurrency, decimals: isDecimals(decimals) ? Number(decimals) : 2 };
};

/**
 * Keeps the unit of a price broadcast.
 * @param {string} defaultCurrency - as given to get() by this device
 * @returns {Promise<boolean>} true when currency or decimals changed (the capability options follow)
 */
const take = async (device, unit, defaultCurrency = '€') => {
  if (!unit) return false;
  const before = get(device, defaultCurrency);
  if (device.getStoreValue(STORE_KEY) && before.currency === unit.currency && before.decimals === unit.decimals) return false;
  await device.setStoreValue(STORE_KEY, unit);
  return before.currency !== unit.currency || before.decimals !== unit.decimals;
};

module.exports = {
  STORE_KEY,
  decimalsOf,
  isDecimals,
  fromPrices,
  get,
  take,
};
