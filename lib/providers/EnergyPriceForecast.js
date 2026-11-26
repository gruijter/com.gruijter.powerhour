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

const defaultHost = 'api.energypriceforecast.eu';
const defaultTimeout = 30000;

const zones = [
  ['AT_Austria', '10YAT-APG------L', 'AT'],
  ['BE_Belgium', '10YBE----------2', 'BE'],
  ['BG_Bulgaria', '10YCA-BULGARIA-R', 'BG'],
  ['CH_Switzerland', '10YCH-SWISSGRIDZ', 'CH'],
  ['CZ_Czech_Republic_CEPS', '10YCZ-CEPS-----N', 'CZ'],
  ['DE_Germany_DE_LU', '10Y1001A1001A82H', 'DE'],
  ['DK_Denmark_1', '10YDK-1--------W', 'DK1'],
  ['DK_Denmark_2', '10YDK-2--------M', 'DK2'],
  ['ES_Spain', '10YES-REE------0', 'ES'],
  ['FI_Finland', '10YFI-1--------U', 'FI'],
  ['FR_France', '10YFR-RTE------C', 'FR'],
  ['GR_Greece', '10YGR-HTSO-----Y', 'GR'],
  ['IT_Italy_Calabria', '10Y1001C--00096J', 'IT_CALA'],
  ['IT_Italy_Center_South', '10Y1001A1001A71M', 'IT_CSUD'],
  ['IT_Italy_Centre_North', '10Y1001A1001A70O', 'IT_CNOR'],
  ['IT_Italy_North', '10Y1001A1001A73I', 'ITN'],
  ['IT_Italy_Sardinia', '10Y1001A1001A74G', 'IT_SARD'],
  ['IT_Italy_Sicily', '10Y1001A1001A75E', 'IT_SICI'],
  ['IT_Italy_South', '10Y1001A1001A788', 'IT_SUD'],
  ['NL_Netherlands', '10YNL----------L', 'NL'],
  ['NO_Norway_1', '10YNO-1--------2', 'NO1'],
  ['NO_Norway_2', '10YNO-2--------T', 'NO2'],
  ['NO_Norway_3', '10YNO-3--------J', 'NO3'],
  ['NO_Norway_4', '10YNO-4--------9', 'NO4'],
  ['NO_Norway_5', '10Y1001A1001A48H', 'NO5'],
  ['PL_Poland_PSE', '10YPL-AREA-----S', 'PL'],
  ['PT_Portugal', '10YPT-REN------W', 'PT'],
  ['RO_Romania', '10YRO-TEL------P', 'RO'],
  ['SE_Sweden_1', '10Y1001A1001A44P', 'SE1'],
  ['SE_Sweden_2', '10Y1001A1001A45N', 'SE2'],
  ['SE_Sweden_3', '10Y1001A1001A46L', 'SE3'],
  ['SE_Sweden_4', '10Y1001A1001A47J', 'SE4'],
  ['SK_Slovakia_SEPS', '10YSK-SEPS-----K', 'SK'],
];
const biddingZones = Object.fromEntries(zones.map(([name, eic]) => [name, eic]));
const countries = Object.fromEntries(zones.map(([, eic, country]) => [eic, country]));

class EnergyPriceForecast extends PriceProvider {

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

  getMinFetchInterval() {
    return 55 * 60 * 1000;
  }

  async getPrices(options) {
    const opts = options || {};
    const country = countries[opts.biddingZone || this.biddingZone];
    if (!country) throw Error('biddingZone not supported by EnergyPriceForecast');
    const hourly = opts.resolution === 'PT60M' ? '&resolution=hourly' : '';
    const url = `https://${this.host}/api/v1/evcc/tariff?country=${country}&type=grid&currency=EUR&hours=48${hourly}`;
    const res = await fetch(url, { headers: { 'User-Agent': PriceProvider.USER_AGENT }, signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw Error(`EnergyPriceForecast HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw Error('EnergyPriceForecast: no price data found');
    return body
      .map((p) => ({ time: new Date(p.start), price: PriceProvider.toNumber(p.value) * 1000 }))
      .filter((p) => !Number.isNaN(p.time.getTime()) && Number.isFinite(p.price))
      .sort((a, b) => a.time - b.time);
  }
}

module.exports = EnergyPriceForecast;
