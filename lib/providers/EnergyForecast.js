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

const PriceProvider = require('./PriceProvider');

const defaultHost = 'www.energyforecast.de';
const defaultTimeout = 30000;

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  CH_Switzerland: '10YCH-SWISSGRIDZ',
  CZ_Czech_Republic_CEPS: '10YCZ-CEPS-----N',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  FR_France: '10YFR-RTE------C',
  HU_Hungary: '10YHU-MAVIR----U',
  IT_Italy_North: '10Y1001A1001A73I',
  NL_Netherlands: '10YNL----------L',
  NO_Norway_2: '10YNO-2--------T',
  PL_Poland_PSE: '10YPL-AREA-----S',
  SE_Sweden_4: '10Y1001A1001A47J',
  SI_Slovenia: '10YSI-ELES-----O',
};

const marketZones = {
  '10YAT-APG------L': 'AT',
  '10YBE----------2': 'BE',
  '10YCH-SWISSGRIDZ': 'CH',
  '10YCZ-CEPS-----N': 'CZ',
  '10Y1001A1001A82H': 'DE-LU',
  '10YDK-1--------W': 'DK1',
  '10YDK-2--------M': 'DK2',
  '10YFR-RTE------C': 'FR',
  '10YHU-MAVIR----U': 'HU',
  '10Y1001A1001A73I': 'IT-North',
  '10YNL----------L': 'NL',
  '10YNO-2--------T': 'NO2',
  '10YPL-AREA-----S': 'PL',
  '10Y1001A1001A47J': 'SE4',
  '10YSI-ELES-----O': 'SI',
};

class EnergyForecast extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.biddingZone = options.biddingZone;
    this.apiKey = (options.apiKey || '').trim();
  }

  getBiddingZones() {
    return biddingZones;
  }

  getMinFetchInterval() {
    return 55 * 60 * 1000;
  }

  async getPrices(options) {
    const opts = options || {};
    const zone = marketZones[opts.biddingZone || this.biddingZone];
    if (!zone) throw Error('biddingZone not supported by EnergyForecast');
    if (!this.apiKey) throw Error('EnergyForecast: no API key');
    const url = `https://${this.host}/api/v2/forecast?token=${encodeURIComponent(this.apiKey)}&market_zone=${encodeURIComponent(zone)}`;
    const res = await fetch(url, { headers: { 'User-Agent': PriceProvider.USER_AGENT }, signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw Error(`EnergyForecast HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) throw Error('EnergyForecast: no price data found');
    return body.data
      .map((p) => ({ time: new Date(p.start), price: PriceProvider.toNumber(p.price_ct_kwh) * 10 }))
      .filter((p) => !Number.isNaN(p.time.getTime()) && Number.isFinite(p.price))
      .sort((a, b) => a.time - b.time);
  }
}

module.exports = EnergyForecast;
