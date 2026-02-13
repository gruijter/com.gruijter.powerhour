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

const parseXml = require('xml-js');

const defaultHost = 'www.ecb.europa.eu';
const defaultTimeout = 30000;
const exchangeRatesPath = '/stats/eurofxref/eurofxref-daily.xml';

// Represents a session to the ECB API.
class ECB {

  constructor(opts) {
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.lastResponse = undefined;
  }

  /**
  * Get the rates
  * @returns {Promise(exchangeRates)}
  */

  async getRates() {
    try {
      const xml = await this._makeRequest(exchangeRatesPath);
      const options = {
        compact: true, nativeType: true, ignoreDeclaration: true, ignoreAttributes: false,
      };
      const result = parseXml.xml2js(xml, options);
      const timeCube = result['gesmes:Envelope'].Cube.Cube;
      const date = new Date(timeCube._attributes.time);
      const rates = { date };

      const cubes = Array.isArray(timeCube.Cube) ? timeCube.Cube : [timeCube.Cube];
      cubes.forEach((c) => {
        rates[c._attributes.currency] = Number(c._attributes.rate);
      });

      return rates;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(path, postMessage, timeout) {
    try {
      const url = `https://${this.host}${path}`;
      const options = {
        method: 'GET',
        timeout: timeout || this.timeout,
      };

      const result = await fetch(url, options);
      this.lastResponse = result.status;

      if (!result.ok) {
        throw new Error(`HTTP request Failed. Status Code: ${result.status}`);
      }

      const contentType = result.headers.get('content-type');
      if (!/text\/xml/.test(contentType)) {
        const text = await result.text();
        throw new Error(`Expected xml but received ${contentType}: ${text.slice(0, 100)}`);
      }
      return result.text();
    } catch (error) {
      this.lastResponse = error;
      return Promise.reject(error);
    }
  }
}

module.exports = ECB;
