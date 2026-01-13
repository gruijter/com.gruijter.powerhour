/*
Copyright 2019 - 2025, Robin de Gruijter (gruijter@hotmail.com)

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

const defaultHost = 'www.ecb.europa.eu';
const defaultTimeout = 30000;
const exchangeRatesPath = '/stats/eurofxref/eurofxref-daily.xml';

const regexRates = /<Cube>(.*)<\/Cube>/s;
const regexTime = /<Cube time='(.*)'/s;
const regexCurrency = /<Cube currency='(.*)' /s;
const regexRate = /rate='(.*)'/s;

// Represents a session to the Easyenergy API.
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
      const raw = regexRates.exec(xml.replace(/\t/gi, ''))[1];
      const entries = raw
        .split('\n')
        .filter((entry) => (entry.includes('rate') || entry.includes('time')));
      const rates = entries.reduce((result, entry) => {
        const accu = result;
        if (entry.includes('time')) {
          const date = regexTime.exec(entry)[1];
          accu.date = new Date(date);
        } else {
          const currency = regexCurrency.exec(entry)[1];
          const rate = Number(regexRate.exec(entry)[1]);
          accu[currency] = rate;
        }
        return accu;
      }, {});
      return Promise.resolve(rates);
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

// START TEST HERE
// const ecb = new ECB();

// ecb.getRates()
//  .then((result) => console.dir(result, { depth: null }))
//  .catch((error) => console.log(error));

/*
{
  date: 2022-07-08T00:00:00.000Z,
  USD: 1.0163,
  JPY: 138.05,
  BGN: 1.9558,
  CZK: 24.614,
  DKK: 7.4424,
  GBP: 0.84585,
  HUF: 402.45,
  PLN: 4.763,
  RON: 4.9431,
  SEK: 10.6665,
  CHF: 0.9913,
  ISK: 139.5,
  NOK: 10.263,
  HRK: 7.519,
  TRY: 17.6026,
  AUD: 1.4871,
  BRL: 5.4345,
  CAD: 1.3201,
  CNY: 6.8095,
  HKD: 7.9769,
  IDR: 15210.73,
  ILS: 3.5325,
  INR: 80.528,
  KRW: 1321.61,
  MXN: 20.8477,
  MYR: 4.4992,
  NZD: 1.6464,
  PHP: 56.882,
  SGD: 1.4228,
  THB: 36.602,
  ZAR: 17.1922
}
*/

/*
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<gesmes:subject>Reference rates</gesmes:subject>
<gesmes:Sender>
<gesmes:name>European Central Bank</gesmes:name>
</gesmes:Sender>
<Cube>
<Cube time="2022-07-07">
<Cube currency="USD" rate="1.0180"/>
<Cube currency="JPY" rate="138.11"/>
<Cube currency="BGN" rate="1.9558"/>
<Cube currency="CZK" rate="24.779"/>
<Cube currency="DKK" rate="7.4405"/>
<Cube currency="GBP" rate="0.85105"/>
<Cube currency="HUF" rate="410.04"/>
<Cube currency="PLN" rate="4.7721"/>
<Cube currency="RON" rate="4.9448"/>
<Cube currency="SEK" rate="10.7230"/>
<Cube currency="CHF" rate="0.9906"/>
<Cube currency="ISK" rate="139.30"/>
<Cube currency="NOK" rate="10.2910"/>
<Cube currency="HRK" rate="7.5193"/>
<Cube currency="TRY" rate="17.5551"/>
<Cube currency="AUD" rate="1.4883"/>
<Cube currency="BRL" rate="5.4983"/>
<Cube currency="CAD" rate="1.3227"/>
<Cube currency="CNY" rate="6.8230"/>
<Cube currency="HKD" rate="7.9893"/>
<Cube currency="IDR" rate="15265.27"/>
<Cube currency="ILS" rate="3.5548"/>
<Cube currency="INR" rate="80.6000"/>
<Cube currency="KRW" rate="1324.66"/>
<Cube currency="MXN" rate="20.9675"/>
<Cube currency="MYR" rate="4.5077"/>
<Cube currency="NZD" rate="1.6461"/>
<Cube currency="PHP" rate="56.939"/>
<Cube currency="SGD" rate="1.4255"/>
<Cube currency="THB" rate="36.740"/>
<Cube currency="ZAR" rate="17.0372"/>
</Cube>
</Cube>
</gesmes:Envelope>
*/
