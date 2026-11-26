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

const defaultHost = 'epexpredictor.batzill.com';
const defaultTimeout = 30000;

const biddingZones = {
  AT_Austria: '10YAT-APG------L',
  BE_Belgium: '10YBE----------2',
  DE_Germany_DE_LU: '10Y1001A1001A82H',
  DK_Denmark_1: '10YDK-1--------W',
  DK_Denmark_2: '10YDK-2--------M',
  ES_Spain: '10YES-REE------0',
  FR_France: '10YFR-RTE------C',
  NL_Netherlands: '10YNL----------L',
  PT_Portugal: '10YPT-REN------W',
  SE_Sweden_1: '10Y1001A1001A44P',
  SE_Sweden_2: '10Y1001A1001A45N',
  SE_Sweden_3: '10Y1001A1001A46L',
  SE_Sweden_4: '10Y1001A1001A47J',
};

const regions = {
  '10YAT-APG------L': 'AT',
  '10YBE----------2': 'BE',
  '10Y1001A1001A82H': 'DE',
  '10YDK-1--------W': 'DK1',
  '10YDK-2--------M': 'DK2',
  '10YES-REE------0': 'ES',
  '10YFR-RTE------C': 'FR',
  '10YNL----------L': 'NL',
  '10YPT-REN------W': 'PT',
  '10Y1001A1001A44P': 'SE1',
  '10Y1001A1001A45N': 'SE2',
  '10Y1001A1001A46L': 'SE3',
  '10Y1001A1001A47J': 'SE4',
};

class EpexPredictor extends PriceProvider {

  constructor(opts) {
    super(opts);
    const options = opts || {};
    this.host = options.host || defaultHost;
    this.timeout = options.timeout || defaultTimeout;
    this.biddingZone = options.biddingZone;
  }

  getBiddingZones() {
    return biddingZones;
  }

  async getPrices(options) {
    const opts = options || {};
    const region = regions[opts.biddingZone || this.biddingZone];
    if (!region) throw Error('biddingZone not supported by EpexPredictor');
    const hourly = opts.resolution === 'PT60M' ? '&hourly=true' : '';
    const url = `https://${this.host}/prices?region=${region}&unit=EUR_PER_MWH&timezone=UTC${hourly}`;
    const res = await fetch(url, { headers: { 'User-Agent': PriceProvider.USER_AGENT }, signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw Error(`EpexPredictor HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.prices)) throw Error('EpexPredictor: no price data found');
    return body.prices
      .map((p) => ({ time: new Date(p.startsAt), price: Number(p.total) }))
      .filter((p) => !Number.isNaN(p.time.getTime()) && Number.isFinite(p.price))
      .sort((a, b) => a.time - b.time);
  }
}

module.exports = EpexPredictor;
