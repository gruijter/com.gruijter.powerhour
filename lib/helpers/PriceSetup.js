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

// Pairing and repairing a price device with the question view (drivers/price/pair|repair/setup.html):
// energy, market (zone, interval, currency), the import and the export price (with an optional floor),
// then name and tariff group. The view gets the setting definitions from the manifest, so labels are translated once.

const crypto = require('crypto');
const Homey = require('homey');
const PairSetup = require('./PairSetup');
const DapTakeover = require('./DapTakeover');
const PriceDrivers = require('./PriceDrivers');
const PriceZones = require('./PriceZones');
const PriceFormula = require('../PriceFormula');
const PriceCalculator = require('../PriceCalculator');
const PriceFetchStrategy = require('../strategies/PriceFetchStrategy');
const TimeHelpers = require('./TimeHelpers');
const MoneyUnit = require('./MoneyUnit');
const Flows = require('../flows/Flows');

const PRICE_FIELDS = [
  'fixedMarkup', 'fixedMarkupInclVat', 'variableMarkup', 'tax', 'taxInclVat', 'fixedMarkupTOD', 'fixedMarkupTODInclVat',
  'fixedMarkupWeekend', 'fixedMarkupWeekendInclVat', 'vat',
];
const FIELDS = [
  'commodity', 'tariffType', 'biddingZone', 'priceInterval', 'currency', 'fetchExchangeRate', 'moneyDecimals',
  ...PRICE_FIELDS, ...PRICE_FIELDS.map((id) => `export_${id}`),
  'export_floor', 'export_floorMin', 'export_floorPercent', 'export_floorBase',
  'tariff_update_group',
];
const MARKET_CACHE_MS = 15 * 60 * 1000;

// Readable zone name: 'NL_Netherlands' -> 'NL Netherlands'.
const zoneLabel = (description) => String(description).replace(/_/g, ' ');

// The zones of the providers for electricity and gas: { power: [{ id, label }], gas: [...] }.
const zoneLists = (driver) => {
  if (driver.priceZoneLists) return driver.priceZoneLists;
  const list = (settings) => {
    const zones = {};
    driver.providersFor(settings).forEach((factory) => {
      const Provider = factory();
      Object.entries(new Provider().getBiddingZones()).forEach(([description, id]) => {
        if (!zones[id]) zones[id] = zoneLabel(description);
      });
    });
    return Object.entries(zones).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  };
  driver.priceZoneLists = { power: list({ commodity: 'power' }), gas: list({ commodity: 'gas' }) };
  return driver.priceZoneLists;
};

// The setting definitions of the view, translated: { id: { type, label, hint, min, max, options } }.
const fieldDefs = (driver) => {
  const defs = PairSetup.settingDefs(driver);
  const out = {};
  FIELDS.forEach((id) => {
    const def = defs[id];
    if (!def) return;
    out[id] = {
      type: def.type,
      label: PairSetup.text(driver.homey, def.label),
      hint: PairSetup.text(driver.homey, def.hint),
      min: def.min,
      max: def.max,
    };
    if (def.values) out[id].options = def.values.map((v) => ({ id: v.id, label: PairSetup.text(driver.homey, v.label) }));
  });
  return out;
};

const location = (homey) => {
  try {
    const lat = homey.geolocation.getLatitude();
    const lon = homey.geolocation.getLongitude();
    return (Number.isFinite(lat) && Number.isFinite(lon)) ? [lat, lon] : null;
  } catch {
    return null;
  }
};

// The view's starting values: those of the device when repairing, else a proposal for this Homey.
const startValues = (driver, device) => {
  const proposal = PriceZones.propose(driver.homey.clock.getTimezone(), location(driver.homey));
  if (device) {
    const settings = device.getSettings();
    const dynamic = settings.tariffType !== 'fixed';
    return {
      ...settings,
      // Devices from before this setting: from the currency.
      moneyDecimals: MoneyUnit.isDecimals(settings.moneyDecimals) ? Number(settings.moneyDecimals) : MoneyUnit.decimalsOf(settings.fetchExchangeRate),
      powerZone: dynamic && settings.commodity !== 'gas' ? settings.biddingZone : proposal.powerZone,
      gasZone: dynamic && settings.commodity === 'gas' ? settings.biddingZone : proposal.gasZone,
      name: device.getName(),
    };
  }
  const defs = PairSetup.settingDefs(driver);
  const values = {};
  FIELDS.forEach((id) => {
    if (defs[id]) values[id] = defs[id].value;
  });
  return {
    ...values,
    powerZone: proposal.powerZone,
    gasZone: proposal.gasZone,
    currency: proposal.currency,
    fetchExchangeRate: proposal.fetchExchangeRate,
    moneyDecimals: MoneyUnit.decimalsOf(proposal.fetchExchangeRate),
    tariff_update_group: 1,
    name: '',
  };
};

const translateError = (homey, err) => {
  if (err && err.code && String(err.code).startsWith('formula_')) {
    return new Error(homey.__(`error_${err.code}`, { detail: err.detail || '' }));
  }
  return err;
};

// The view's values checked against the setting definitions: the settings of the device.
const parseValues = (driver, data = {}) => {
  const { homey } = driver;
  const defs = PairSetup.settingDefs(driver);
  const settings = {};
  FIELDS.forEach((id) => {
    const def = defs[id];
    const value = data[id];
    if (!def || value === undefined || value === null) return;
    if (def.type === 'checkbox') {
      settings[id] = !!value;
    } else if (def.type === 'dropdown') {
      if ((def.values || []).some((v) => v.id === String(value))) settings[id] = String(value);
    } else if (def.type === 'number') {
      let num = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(num)) throw Error(`${PairSetup.text(homey, def.label)}: ${homey.__('error_value_not_number')}`);
      if (typeof def.min === 'number') num = Math.max(def.min, num);
      if (typeof def.max === 'number') num = Math.min(def.max, num);
      settings[id] = num;
    } else {
      settings[id] = String(value).trim();
    }
  });
  const gas = settings.commodity === 'gas';
  // Water has no market.
  if (settings.commodity === 'water') settings.tariffType = 'fixed';
  if (settings.tariffType === 'fixed') {
    // No market: the amounts are in the currency, slots per hour (time of day markups are hourly).
    settings.biddingZone = 'fixed';
    settings.description = PairSetup.text(homey, (defs.tariffType.values || []).find((v) => v.id === 'fixed').label);
    settings.priceInterval = '60';
    settings.fetchExchangeRate = 'NONE';
  } else {
    if (gas) settings.priceInterval = '60';
    const zones = zoneLists(driver)[gas ? 'gas' : 'power'];
    const zone = zones.find((z) => z.id === String(data.biddingZone));
    if (!zone) throw Error(homey.__('price_setup.error_zone'));
    settings.biddingZone = zone.id;
    settings.description = zone.label;
  }
  if (!settings.currency) settings.currency = '€';
  ['fixedMarkupTOD', 'export_fixedMarkupTOD'].forEach((id) => {
    try {
      PriceCalculator.parseTOD(settings[id]);
    } catch {
      throw Error(`${PairSetup.text(homey, defs[id].label)}: ${homey.__('price_setup.error_tod')}`);
    }
  });
  settings.formulaInUse = PriceFormula.build(settings, 'import');
  settings.export_formulaInUse = PriceFormula.build(settings, 'export');
  return settings;
};

// The market price (per MWh) of the slot holding now, for the preview: from a price device of the
// same zone, else fetched (cached per zone and interval).
const marketNow = async (driver, settings) => {
  const now = Date.now();
  const interval = PriceDrivers.intervalOf('price', settings);
  if (settings.tariffType === 'fixed') return { time: new Date(TimeHelpers.startOfLocalBlock(now, 60, driver.homey.clock.getTimezone())), price: 0 };
  const inSlot = (prices, minutes) => (prices || []).find((p) => {
    const t = new Date(p.time).getTime();
    return t <= now && now < t + minutes * 60 * 1000;
  });
  const sameZone = PriceDrivers.getDevices(driver.homey)
    .filter((d) => d.getSettings().biddingZone === settings.biddingZone && d.priceInterval === interval);
  for (const device of sameZone) {
    const slot = inSlot(device.rawMarketPrices, device.priceInterval);
    if (slot) return slot;
  }

  const key = `${settings.biddingZone}|${interval}`;
  driver.priceMarketCache = driver.priceMarketCache || {};
  const cached = driver.priceMarketCache[key];
  if (cached && now - cached.tm < MARKET_CACHE_MS) return inSlot(cached.prices, cached.minutes) || null;

  const providers = driver.providersFor(settings).map((factory) => factory())
    .filter((Provider) => Object.values(new Provider().getBiddingZones()).includes(settings.biddingZone));
  PriceFetchStrategy.sortProviders(providers, PriceFetchStrategy.isNordpoolZone(settings.biddingZone));
  const periods = TimeHelpers.getUTCPeriods(driver.homey.clock.getTimezone(), interval);
  const gas = PriceDrivers.isGas('price', settings);
  for (const Provider of providers) {
    try {
      const apiKey = Provider.name === 'ENTSOE' ? Homey?.env?.ENTSOE_API_KEY : '';
      const provider = new Provider({ apiKey, biddingZone: settings.biddingZone });
      // eslint-disable-next-line no-await-in-loop
      const prices = await provider.getPrices({
        dateStart: periods.todayStart, dateEnd: periods.tomorrowStart, resolution: `PT${gas ? 60 : interval}M`,
      });
      if (Array.isArray(prices) && prices.length) {
        const minutes = gas ? 24 * 60 : interval;
        driver.priceMarketCache[key] = { tm: now, prices, minutes };
        const slot = inSlot(prices, minutes);
        if (slot) return slot;
      }
    } catch (err) {
      driver.log('price preview: no market price from', Provider.name, err.message);
    }
  }
  return null;
};

// The price now for the view's values: { market, import, export, formula, exportFormula, currency }.
const preview = async (driver, data) => {
  const settings = { exchangeRate: 1, ...parseValues(driver, data) };
  const slot = await marketNow(driver, settings);
  const result = {
    formula: PriceFormula.formulaOf(settings, 'import'),
    exportFormula: PriceFormula.formulaOf(settings, 'export'),
    currency: settings.currency,
    market: null,
    import: null,
    export: null,
  };
  if (!slot) return result;
  // An exchange rate is only known after the first fetch: without one the preview stays in €.
  const rateKnown = !settings.fetchExchangeRate || settings.fetchExchangeRate === 'NONE';
  const [price] = PriceFormula.applyPrices([{ time: new Date(slot.time), price: slot.price }], settings, driver.homey.clock.getTimezone());
  return {
    ...result,
    currency: rateKnown ? settings.currency : '€',
    market: settings.tariffType === 'fixed' ? null : slot.price / 1000,
    import: price.importPrice,
    export: PriceDrivers.commodityOf('price', settings) === 'power' ? price.exportPrice : null,
  };
};

// Currency per electricity zone, for the view to follow a zone change: { zone: { symbol, code, decimals } }.
const zoneCurrencies = (driver) => Object.fromEntries(zoneLists(driver).power.map((z) => {
  const currency = PriceZones.currencyOfZone(z.id);
  return [z.id, { ...currency, decimals: MoneyUnit.decimalsOf(currency.code) }];
}));

// The devices that take the tariff of each group: { power: [{ group, names }], gas: [...], water: [...] }.
const tariffGroups = (driver) => {
  const out = {};
  ['power', 'gas', 'water'].forEach((commodity) => {
    const driverIds = Flows.TARIFF_GROUP_DRIVER_IDS[commodity];
    const groups = {};
    driverIds.forEach((driverId) => {
      let devices = [];
      try {
        devices = driver.homey.drivers.getDriver(driverId).getDevices();
      } catch {
        return; // driver not loaded
      }
      devices.forEach((d) => {
        const group = Number(d.getSettings().tariff_update_group);
        if (group) (groups[group] = groups[group] || []).push(d.getName());
      });
    });
    out[commodity] = Object.keys(groups).map(Number).sort((a, b) => a - b).map((group) => ({ group, names: groups[group] }));
  });
  return out;
};

const setupData = (driver, device) => ({
  daps: device ? [] : DapTakeover.oldDevices(driver),
  groups: tariffGroups(driver),
  repairing: !!device,
  defs: fieldDefs(driver),
  zones: zoneLists(driver),
  currencies: zoneCurrencies(driver),
  currencyList: PriceZones.CURRENCY_LIST.map((c) => ({ ...c, decimals: MoneyUnit.decimalsOf(c.code) })),
  values: startValues(driver, device),
});

const registerPair = (driver, session) => {
  const takeover = DapTakeover.pairSession(driver, session);
  session.setHandler('setup_get', async () => setupData(driver, null));
  session.setHandler('setup_preview', async (data) => preview(driver, data).catch((err) => {
    throw translateError(driver.homey, err);
  }));
  session.setHandler('setup_set', async (data = {}) => {
    takeover.select(data.importFrom);
    const settings = { exchangeRate: 1, ...takeover.settings(), ...parseValues(driver, data) };
    const commodity = PriceDrivers.commodityOf('price', settings);
    const name = String(data.name || '').trim()
      || `${driver.homey.__(`price_setup.name_${commodity}`)} ${settings.description}`;
    takeover.select(data.importFrom, name);
    return {
      device: {
        name,
        data: { id: `${settings.biddingZone}_${crypto.randomBytes(3).toString('hex')}` },
        capabilities: driver.capabilitiesFor(settings),
        settings,
        store: takeover.store(),
      },
    }; // the view creates it
  });
};

const registerRepair = (driver, session, device) => {
  driver.log('Repairing of device started', device.getName());
  session.setHandler('setup_get', async () => setupData(driver, device));
  session.setHandler('setup_preview', async (data) => preview(driver, data).catch((err) => {
    throw translateError(driver.homey, err);
  }));
  session.setHandler('setup_set', async (data = {}) => {
    const settings = parseValues(driver, data);
    await device.applySetup(settings);
    return {}; // the view continues to 'loading'
  });
  session.setHandler('showView', async (viewId) => {
    if (viewId === 'loading') await session.showView('done');
  });
  session.setHandler('disconnect', () => {
    driver.log('Repairing of device ended', device.getName());
  });
};

module.exports = {
  registerPair,
  registerRepair,
  zoneLists,
  translateError,
};
