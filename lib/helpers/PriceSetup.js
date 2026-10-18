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
// energy, market (zone, interval, currency), the import and the export price, then name and tariff
// group. The view gets the setting definitions from the manifest, so labels are translated once.

const crypto = require('crypto');
const Homey = require('homey');
const PairSetup = require('./PairSetup');
const PriceDrivers = require('./PriceDrivers');
const PriceZones = require('./PriceZones');
const PriceFormula = require('../PriceFormula');
const PriceCalculator = require('../PriceCalculator');
const PriceFetchStrategy = require('../strategies/PriceFetchStrategy');
const TimeHelpers = require('./TimeHelpers');

const PRICE_FIELDS = [
  'fixedMarkup', 'fixedMarkupInclVat', 'variableMarkup', 'tax', 'taxInclVat', 'fixedMarkupTOD', 'fixedMarkupTODInclVat',
  'fixedMarkupWeekend', 'fixedMarkupWeekendInclVat', 'vat',
];
const FIELDS = [
  'commodity', 'tariffType', 'biddingZone', 'priceInterval', 'currency', 'fetchExchangeRate',
  ...PRICE_FIELDS, ...PRICE_FIELDS.map((id) => `export_${id}`),
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
  if (settings.tariffType === 'fixed') {
    // No market: the amounts are in the currency, slots per hour (time of day markups are hourly).
    settings.biddingZone = 'fixed';
    settings.description = PairSetup.text(homey, (defs.tariffType.values || []).find((v) => v.id === 'fixed').label);
    settings.priceInterval = '60';
    settings.fetchExchangeRate = 'NONE';
  } else {
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
    export: PriceDrivers.isGas('price', settings) ? null : price.exportPrice,
  };
};

// Currency per electricity zone, for the view to follow a zone change: { zone: { symbol, code } }.
const zoneCurrencies = (driver) => Object.fromEntries(zoneLists(driver).power.map((z) => [z.id, PriceZones.currencyOfZone(z.id)]));

// The devices that take the tariff of each group: { power: [{ group, names }], gas: [...] }.
const GROUP_DRIVERS = { power: ['power', 'grid', 'solar', 'battery', 'evCharger'], gas: ['gas'] };
const tariffGroups = (driver) => {
  const out = {};
  Object.entries(GROUP_DRIVERS).forEach(([commodity, driverIds]) => {
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

// Taking over a deprecated dap / dap15 / dapg device: '<driverId>|<data id>'.
const OLD_DRIVERS = ['dap', 'dap15', 'dapg'];
const oldDevice = (driver, key) => {
  const [driverId, id] = String(key || '').split('|');
  if (!OLD_DRIVERS.includes(driverId)) return null;
  try {
    return driver.homey.drivers.getDriver(driverId).getDevices().find((d) => d.getData().id === id) || null;
  } catch {
    return null;
  }
};

// Energy and tariff type of an old device: a fixed tariff ignores the market price (import and export).
const oldType = (driverId, s) => {
  const gas = driverId === 'dapg';
  const fixed = gas ? !!s.ignore_market_price : !!(s.ignore_market_price && s.export_ignore_market_price);
  return { commodity: gas ? 'gas' : 'power', tariffType: fixed ? 'fixed' : 'dynamic' };
};

const oldDevices = (driver) => OLD_DRIVERS.flatMap((driverId) => {
  try {
    return driver.homey.drivers.getDriver(driverId).getDevices()
      .map((d) => ({ key: `${driverId}|${d.getData().id}`, name: d.getName(), ...oldType(driverId, d.getSettings()) }));
  } catch {
    return [];
  }
});

/**
 * The view's values from an old device, giving the same prices: its amounts included VAT (the old
 * hint), so VAT 0 and all amounts 'incl. VAT'. An ignored market price becomes a -100% markup on it
 * (none for a fixed tariff, where the % applies to the supply price).
 */
const importValues = (dap) => {
  const driverId = dap.driver.id;
  const s = dap.getSettings();
  const type = oldType(driverId, s);
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const values = {
    ...type,
    biddingZone: s.biddingZone,
    priceInterval: driverId === 'dap15' ? '15' : '60',
    currency: s.currency || '€',
    fetchExchangeRate: s.fetchExchangeRate || 'NONE',
    tariff_update_group: num(s.tariff_update_group),
    name: dap.getName(),
  };
  (type.commodity === 'gas' ? [''] : ['', 'export_']).forEach((prefix) => {
    let percent = num(s[`${prefix}variableMarkup`]);
    if (s[`${prefix}ignore_market_price`]) percent = type.tariffType === 'fixed' ? 0 : -100;
    Object.assign(values, {
      [`${prefix}vat`]: 0,
      [`${prefix}tax`]: 0,
      [`${prefix}variableMarkup`]: percent,
      [`${prefix}fixedMarkup`]: num(s[`${prefix}fixedMarkup`]),
      [`${prefix}fixedMarkupInclVat`]: true,
      [`${prefix}fixedMarkupTOD`]: s[`${prefix}fixedMarkupTOD`] || '',
      [`${prefix}fixedMarkupTODInclVat`]: true,
      [`${prefix}fixedMarkupWeekend`]: num(s[`${prefix}fixedMarkupWeekend`]),
      [`${prefix}fixedMarkupWeekendInclVat`]: true,
    });
  });
  return values;
};

// Settings of an old device that the view does not ask, for the new device.
const importExtras = (driver, dap) => {
  const s = dap.getSettings();
  const defs = PairSetup.settingDefs(driver);
  const extras = {};
  ['decimals', 'exchangeRate', 'entsoeApiKey', 'forecastEnable', 'export_show_chart_line'].forEach((id) => {
    if (s[id] !== undefined && defs[id]) extras[id] = s[id];
  });
  ['', 'export_'].forEach((prefix) => {
    const id = `${prefix}variableMarkupAbsPrice`;
    if (s[id] !== undefined && !s[`${prefix}ignore_market_price`]) extras[id] = s[id];
  });
  if ((defs.priceProvider.values || []).some((v) => v.id === s.priceProvider)) extras.priceProvider = s.priceProvider;
  return extras;
};

// The month averages of an old device, for the new device's first init (PriceDevice). With the
// day and month they were last updated, so the rolling average continues instead of restarting.
const importStore = (dap) => {
  const thisMonth = dap.getCapabilityValue('meter_price_this_month_avg');
  if (!Number.isFinite(thisMonth)) return {};
  const lastMonth = dap.getCapabilityValue('meter_price_last_month_avg');
  return {
    takeoverMonthAvg: { thisMonth, lastMonth: Number.isFinite(lastMonth) ? lastMonth : null },
    lastDayNumber: dap.getStoreValue('lastDayNumber'),
    lastMonthNumber: dap.getStoreValue('lastMonthNumber'),
  };
};

const setupData = (driver, device) => ({
  daps: device ? [] : oldDevices(driver),
  groups: tariffGroups(driver),
  repairing: !!device,
  defs: fieldDefs(driver),
  zones: zoneLists(driver),
  currencies: zoneCurrencies(driver),
  currencyList: PriceZones.CURRENCY_LIST,
  values: startValues(driver, device),
});

const registerPair = (driver, session) => {
  let imported = null; // the old device taken over
  let newName = '';
  session.setHandler('setup_get', async () => setupData(driver, null));
  session.setHandler('setup_import', async (key) => {
    const dap = oldDevice(driver, key);
    if (!dap) throw Error(driver.homey.__('error_device_not_found'));
    return importValues(dap);
  });
  // After the new device is created: the old one no longer sends its price to the group.
  session.setHandler('setup_imported', async () => {
    if (!imported) return;
    driver.log(`${imported.getName()} taken over: tariff group set to 0`);
    await imported.setSettings({ tariff_update_group: 0 });
    imported.settings = imported.getSettings();
    const notice = driver.homey.app.migrationNotice;
    if (notice) await notice.takenOver(imported, newName).catch((err) => driver.error(err));
  });
  session.setHandler('setup_preview', async (data) => preview(driver, data).catch((err) => {
    throw translateError(driver.homey, err);
  }));
  session.setHandler('setup_set', async (data = {}) => {
    imported = data.importFrom ? oldDevice(driver, data.importFrom) : null;
    const settings = { exchangeRate: 1, ...(imported ? importExtras(driver, imported) : {}), ...parseValues(driver, data) };
    const gas = settings.commodity === 'gas';
    const name = String(data.name || '').trim()
      || `${driver.homey.__(gas ? 'price_setup.name_gas' : 'price_setup.name_power')} ${settings.description}`;
    newName = name;
    return {
      device: {
        name,
        data: { id: `${settings.biddingZone}_${crypto.randomBytes(3).toString('hex')}` },
        capabilities: driver.capabilitiesFor(settings),
        settings,
        store: imported ? importStore(imported) : {},
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
