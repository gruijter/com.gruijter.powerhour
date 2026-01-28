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

const https = require('https');

const defaultHost = 'api.energidataservice.dk';
const defaultTimeout = 30000;

// Common Danish grid company GLNs
const gridCompanyGLNs = {
  radius: '5790000705689',        // Radius Elnet (København, Nordsjælland)
  n1: '5790001089030',            // N1 (Nordjylland, Midtjylland)
  trefor: '5790000706686',        // TREFOR El-net (Trekantområdet)
  vores_elnet: '5790000610976',   // Vores Elnet (Fyn)
  konstant: '5790000704842',      // Konstant (Vestjylland)
  dinel: '5790000681075',         // Dinel (Sønderjylland)
  energinet: '5790000432752',     // Energinet (system operator)
};

// Energinet tariff codes
const energinetTariffCodes = {
  systemTariff: '41000',          // Systemtarif
  transmissionTariff: '40000',    // Transmissions nettarif
  electricityTax: 'EA-001',       // Elafgift
};

class EnergiDataService {

  constructor(opts) {
    this.host = opts.host || defaultHost;
    this.timeout = opts.timeout || defaultTimeout;
    this.gridCompanyGLN = opts.gridCompanyGLN || gridCompanyGLNs.radius;
    this.lastResponse = undefined;
  }

  async _makeRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        path,
        method: 'GET',
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            this.lastResponse = json;
            resolve(json);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => reject(error));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }

  /**
   * Fetch grid tariffs (Nettarif C) for a specific grid company
   * Returns time-of-use tariffs with Price1-Price24 for each hour
   */
  async getGridTariffs() {
    const filter = encodeURIComponent(JSON.stringify({
      GLN_Number: this.gridCompanyGLN,
      Note: 'Nettarif C',
    }));
    const path = `/dataset/DatahubPricelist?filter=${filter}&sort=ValidFrom%20desc&limit=5`;

    const response = await this._makeRequest(path);

    if (!response.records || response.records.length === 0) {
      return null;
    }

    // Find currently valid tariff
    const now = new Date();
    const validTariff = response.records.find((r) => {
      const validFrom = new Date(r.ValidFrom);
      const validTo = r.ValidTo ? new Date(r.ValidTo) : new Date('2099-12-31');
      return now >= validFrom && now <= validTo;
    });

    return validTariff || response.records[0];
  }

  /**
   * Fetch system tariff from Energinet (ChargeTypeCode 41000)
   */
  async getSystemTariff() {
    const filter = encodeURIComponent(JSON.stringify({
      GLN_Number: gridCompanyGLNs.energinet,
      ChargeTypeCode: energinetTariffCodes.systemTariff,
    }));
    const path = `/dataset/DatahubPricelist?filter=${filter}&sort=ValidFrom%20desc&limit=1`;

    const response = await this._makeRequest(path);

    if (!response.records || response.records.length === 0) {
      return 0.054; // Fallback value
    }

    return response.records[0].Price1 || 0.054;
  }

  /**
   * Fetch transmission tariff from Energinet (ChargeTypeCode 40000)
   */
  async getTransmissionTariff() {
    const filter = encodeURIComponent(JSON.stringify({
      GLN_Number: gridCompanyGLNs.energinet,
      ChargeTypeCode: energinetTariffCodes.transmissionTariff,
    }));
    const path = `/dataset/DatahubPricelist?filter=${filter}&sort=ValidFrom%20desc&limit=1`;

    const response = await this._makeRequest(path);

    if (!response.records || response.records.length === 0) {
      return 0.049; // Fallback value
    }

    return response.records[0].Price1 || 0.049;
  }

  /**
   * Fetch electricity tax from Energinet (ChargeTypeCode EA-001)
   */
  async getElectricityTax() {
    const filter = encodeURIComponent(JSON.stringify({
      GLN_Number: gridCompanyGLNs.energinet,
      ChargeTypeCode: energinetTariffCodes.electricityTax,
    }));
    const path = `/dataset/DatahubPricelist?filter=${filter}&sort=ValidFrom%20desc&limit=1`;

    const response = await this._makeRequest(path);

    if (!response.records || response.records.length === 0) {
      return 0.761; // Fallback value (2024 rate)
    }

    return response.records[0].Price1 || 0.761;
  }

  /**
   * Fetch all Danish tariffs at once
   * Returns an object with all tariff components
   */
  async getAllTariffs() {
    const [gridTariff, systemTariff, transmissionTariff, electricityTax] = await Promise.all([
      this.getGridTariffs(),
      this.getSystemTariff(),
      this.getTransmissionTariff(),
      this.getElectricityTax(),
    ]);

    return {
      gridTariff,
      systemTariff,
      transmissionTariff,
      electricityTax,
      // Helper to get grid tariff for a specific hour (0-23)
      getGridTariffForHour: (hour) => {
        if (!gridTariff) return 0.5; // Fallback
        const priceKey = `Price${hour + 1}`;
        return gridTariff[priceKey] || gridTariff.Price1 || 0.5;
      },
      // Calculate fixed tariffs total (non-time-varying)
      fixedTariffsTotal: systemTariff + transmissionTariff + electricityTax,
    };
  }

  /**
   * Calculate total price for a given spot price and hour
   * @param {number} spotPrice - Spot price in currency/kWh
   * @param {number} hour - Hour of day (0-23)
   * @param {object} tariffs - Tariffs object from getAllTariffs()
   * @param {number} vatRate - VAT rate (e.g., 0.25 for 25%)
   * @returns {object} Price breakdown
   */
  calculateTotalPrice(spotPrice, hour, tariffs, vatRate = 0.25) {
    const gridTariff = tariffs.getGridTariffForHour(hour);
    const fixedTariffs = tariffs.fixedTariffsTotal;

    const totalBeforeVat = spotPrice + gridTariff + fixedTariffs;
    const vatAmount = totalBeforeVat * vatRate;
    const totalWithVat = totalBeforeVat + vatAmount;

    return {
      spotPrice,
      gridTariff,
      systemTariff: tariffs.systemTariff,
      transmissionTariff: tariffs.transmissionTariff,
      electricityTax: tariffs.electricityTax,
      fixedTariffs,
      totalBeforeVat,
      vatAmount,
      totalWithVat,
    };
  }
}

module.exports = EnergiDataService;
module.exports.gridCompanyGLNs = gridCompanyGLNs;
module.exports.energinetTariffCodes = energinetTariffCodes;
