/*
Copyright 2026, SolarBuffer (info@solarbuffer.nl)

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

// Markups of Dutch energy suppliers with a dynamic contract, so users can pick
// their supplier instead of looking up and typing the markups themselves.
//
// Source: the public price service of SolarBuffer (hub.solarbuffer.nl/energieprijzen).
// It combines the open purchase-fee dataset github.com/zhinees/energieprijzen-nl
// (CC BY 4.0) with suppliers that were checked by hand, and the current Dutch
// energy tax and VAT. When a supplier changes its fee or the energy tax changes
// on 1 January, the markups follow without a user action.

const defaultHost = 'hub.solarbuffer.nl';
const defaultTimeout = 30000;
const apiPath = '/v1/energieprijzen';
const cacheTime = 6 * 60 * 60 * 1000; // fees change a few times per year at most

// The dropdown ids in the dap, dap15 and dapg settings are made from these names.
const suppliers = [
  'ANWB Energie', 'Budget Energie', 'Coolblue Energie', 'Delta Energie', 'easyEnergy',
  'Eneco', 'Energie VanOns', 'Energiedirect', 'Energiek', 'EnergyZero', 'Engie', 'Essent',
  'Frank Energie', 'Greenchoice', 'GroeneStroomLokaal', 'Live Energy', 'Mega', 'NextEnergy',
  'OM Nieuwe Energie', 'Oxxio', 'Powerpeers', 'Pure Energie', 'Tibber', 'Vandebron',
  'Vattenfall', 'Vrijopnaam', 'Zonneplan', 'Zonopnaam Energie',
];

const supplierId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

// One fetch for all devices: the response holds every supplier.
let cache = { time: 0, data: null, pending: null };

// Represents a session to the SolarBuffer price service.
class SupplierMarkupsNL {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.lastResponse = undefined;
  }

  static getSuppliers() {
    return suppliers.map((name) => ({ id: supplierId(name), name }));
  }

  /**
  * Get the markups for one supplier, in the form of the dap and dapg settings
  * @param {string} id - supplier id as used in the settings dropdown
  * @param {string} commodity - 'power' (per kWh) or 'gas' (per m3)
  * @returns {Promise<{variableMarkup: number, fixedMarkup: number, estimated: boolean, name: string}>}
  */
  async getMarkups(id, commodity) {
    const data = await this._getData();
    const supplier = data.leveranciers.find((s) => supplierId(s.naam) === id);
    if (!supplier) throw Error(`supplier ${id} not found in price service`);

    const vat = Number(data.btw_pct);
    const gas = commodity === 'gas';
    const fee = Number(gas ? supplier.gas_opslag_ct : supplier.opslag_ct); // ct, excl. VAT
    const tax = Number(gas ? data.energiebelasting_gas_ct : data.energiebelasting_ct); // ct, incl. VAT
    if (![vat, fee, tax].every(Number.isFinite)) throw Error(`incomplete markups for ${id}`);
    const feeInclVat = data.opslag_is_excl_btw === false ? fee : fee * (1 + vat / 100);

    // Consumer price = spot x (1 + VAT) + fee x (1 + VAT) + energy tax incl. VAT
    return {
      name: supplier.naam,
      variableMarkup: vat,
      fixedMarkup: Math.round((feeInclVat + tax) * 10000) / 1000000, // ct -> €, 6 decimals
      estimated: gas ? Boolean(supplier.gas_opslag_geschat) : false,
    };
  }

  async _getData() {
    if (cache.data && Date.now() - cache.time < cacheTime) return cache.data;
    if (!cache.pending) {
      cache.pending = this._makeRequest()
        .then((data) => {
          cache = { time: Date.now(), data, pending: null };
          return data;
        })
        .catch((error) => {
          cache.pending = null;
          throw error;
        });
    }
    return cache.pending;
  }

  async _makeRequest() {
    const url = `https://${this.host}${apiPath}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeout),
    });
    this.lastResponse = res.status;
    if (!res.ok) throw new Error(`HTTP request Failed. Status Code: ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.leveranciers)) throw Error('no supplier info found');
    return data;
  }

}

module.exports = SupplierMarkupsNL;
