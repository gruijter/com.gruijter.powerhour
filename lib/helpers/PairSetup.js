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

const Budget = require('../Budget');
const BudgetSetup = require('./BudgetSetup');
const PriceDrivers = require('./PriceDrivers');
const MoneyUnit = require('./MoneyUnit');
const PriceZones = require('./PriceZones');
const SETUP_SETTINGS = require('./SetupSettings.json');
const DRIVER_SETUP_SETTINGS = require('./DriverSetupSettings.json');

const text = (homey, t) => {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t[homey.i18n.getLanguage() || 'en'] || t.en || '';
};

const intro = (homey, stepId) => {
  const key = `repair.step_${stepId}_text`;
  const t = homey.__(key);
  return t && t !== key ? t : '';
};

const APP_SETTINGS = {
  use_measure_source: {
    type: 'checkbox', value: false, labelKey: 'repair.setup_use_watt', infoKey: 'repair.setup_use_watt_info',
  },
  homey_device_daily_reset: {
    type: 'checkbox', value: false, labelKey: 'repair.setup_daily_reset', infoKey: 'repair.setup_daily_reset_info',
  },
  currency: { type: 'text', value: '', labelKey: 'repair.setup_currency' },
};

const settingDefs = (driver) => {
  const manifest = driver.homey.app.manifest.drivers.find((d) => d.id === driver.ds.driverId) || {};
  const defs = {};
  const walk = (list) => (list || []).forEach((s) => {
    if (s.children) walk(s.children);
    else defs[s.id] = s;
  });
  walk(manifest.settings);
  Object.entries(DRIVER_SETUP_SETTINGS[driver.ds.driverId] || {}).forEach(([id, def]) => {
    if (!defs[id]) defs[id] = def;
  });
  Object.entries(APP_SETTINGS).forEach(([id, def]) => {
    if (!defs[id]) {
      defs[id] = {
        ...def, id, label: driver.homey.__(def.labelKey), info: def.infoKey ? driver.homey.__(def.infoKey) : undefined,
      };
    }
  });
  Object.entries(SETUP_SETTINGS).forEach(([id, def]) => {
    if (!defs[id]) defs[id] = def;
  });
  Object.entries(BudgetSetup.defs(driver.homey, driver.ds.driverId)).forEach(([id, def]) => {
    if (!defs[id]) defs[id] = def;
  });
  return defs;
};

const priceKind = (driver) => (driver.ds.setup.prices === undefined ? 'power' : driver.ds.setup.prices);
const priceGroups = (driver) => {
  const names = {};
  const kind = priceKind(driver);
  if (!kind) return names;
  PriceDrivers.getDevices(driver.homey, { commodity: kind }).forEach((priceDevice) => {
    const group = Number(priceDevice.getSettings().tariff_update_group);
    if (!group) return;
    (names[group] = names[group] || []).push(priceDevice.getName());
  });
  return names;
};

const tariffGroupOptions = (names, current, fixedLabel, groupLabel = (n) => `${n}`) => {
  const groups = Object.keys(names).map(Number);
  if (typeof current === 'number' && !(fixedLabel && current === 0) && !groups.includes(current)) groups.push(current);
  if (!groups.length && !fixedLabel) groups.push(1);
  const options = groups.sort((a, b) => a - b)
    .map((group) => ({ id: group, label: names[group] ? `${names[group].join(', ')} (${groupLabel(group)})` : groupLabel(group) }));
  if (fixedLabel) options.push({ id: 0, label: fixedLabel });
  return options;
};

const FIXED_IDS = ['tariff', 'tariff_export', 'currency'];
const hasFixed = (ids) => ids.includes('tariff');

const proposedUnit = (driver) => {
  const known = Object.values(driver.moneyUnits || {}).find((unit) => unit && unit.currency);
  if (known) return known;
  const { homey } = driver;
  const lat = homey.geolocation.getLatitude();
  const lon = homey.geolocation.getLongitude();
  const proposal = PriceZones.propose(homey.clock.getTimezone(), Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null);
  return { currency: proposal.currency, decimals: MoneyUnit.decimalsOf(proposal.fetchExchangeRate) };
};

const fixedUnit = (driver, currency) => {
  const proposed = proposedUnit(driver);
  if (!currency || currency === proposed.currency) return proposed;
  return { currency, decimals: 2 };
};

const listScore = (driver, homeyDevice, compat = {}) => {
  const match = (driver.ds.setup && driver.ds.setup.match) || {};
  const energy = homeyDevice.energyObj || homeyDevice.energy || {};
  let score = 0;
  if ((match.classes || []).some((c) => c === homeyDevice.class || c === homeyDevice.virtualClass)) score += 4;
  if (match.energy && match.energy(energy)) score += 2;
  if (compat.found && !compat.needsMapping) score += 1;
  return score;
};

const sortByScore = (entries) => entries
  .map((entry, i) => ({ ...entry, i }))
  .sort((a, b) => (b.score - a.score) || (a.i - b.i))
  .map(({ device }) => device);

const setupGroup = (settings, names, repairing, fixed) => {
  const group = Number(settings.tariff_update_group);
  const groups = Object.keys(names).map(Number);
  if (repairing || names[group]) return group;
  if (!groups.length) return fixed ? 0 : group;
  return Math.min(...groups);
};

const priceInfo = (device) => {
  const { driver, homey } = device;
  const settings = device.getSettings();
  const group = Number(settings.tariff_update_group);
  if (group || !hasFixed(driver.ds.setup.settings)) {
    const names = priceGroups(driver)[group];
    return names ? homey.__('repair.price_info_group', { group, names: names.join(', ') })
      : homey.__('repair.price_info_group_none', { group });
  }
  const { currency } = MoneyUnit.get(device, '');
  const unit = device.getCurrencyUnit ? device.getCurrencyUnit() : 'kWh';
  const money = (value) => `${currency} ${Number(value) || 0}/${unit}`.trim();
  if (!driver.ds.setup.settings.includes('tariff_export')) return homey.__('repair.price_info_fixed', { tariff: money(settings.tariff) });
  return homey.__('repair.price_info_fixed_export', { tariff: money(settings.tariff), export: money(settings.tariff_export) });
};

const updatePriceInfo = async (device) => {
  const { setup } = device.driver.ds;
  if (!setup || !setup.settings.includes('tariff_update_group') || setup.prices === null) return;
  const info = priceInfo(device);
  if (device.getSettings().price_info !== info) await device.setSettings({ price_info: info });
};

const setupIds = (driver, dev) => (driver.setupSettings ? driver.setupSettings(dev) : driver.ds.setup.settings);

const BUDGET_IDS = ['distribution', 'budget', 'budget_heating', 'budget_cooling'];
const CLIMATE_WAIT_MS = 15000;
const budgetIds = (defs) => (defs.distribution ? BUDGET_IDS.filter((id) => defs[id]) : []);
const budgetShowIf = (id) => {
  if (id === 'budget') return { id: 'distribution', not: 'CUSTOM' };
  return id === 'budget_heating' || id === 'budget_cooling' ? { id: 'distribution', value: 'local' } : { id: 'use_budget', value: true };
};

const budgetSection = (homey, defs, s, preset = null) => {
  const ids = budgetIds(defs);
  if (!ids.length) return [];
  const cur = preset ? { ...s, ...preset } : s;
  const out = [];
  ids.forEach((id) => {
    const def = defs[id];
    let value = cur[id] !== undefined ? cur[id] : def.value;
    if (id === 'budget' && (String(value).trim() === '0' || String(value).includes(';'))) value = '';
    const setting = {
      id, type: def.type, step: 'year', showIf: budgetShowIf(id), label: text(homey, def.label), value, info: def.info, months: def.months,
    };
    if (def.type === 'dropdown') setting.options = (def.values || []).map((v) => ({ id: v.id, label: text(homey, v.label) }));
    out.push(setting);
  });
  out.unshift({
    id: 'use_budget', type: 'checkbox', step: 'year', label: homey.__('repair.setup_use_budget'), value: !!preset || Budget.isActive(cur.distribution, cur.budget),
  });
  return out;
};

const wantsCustom = (data, settings) => (data.settings || {}).use_budget === true && settings.distribution === 'CUSTOM';

const customView = async (driver, settings, title) => {
  const { homey } = driver;
  const id = driver.ds.driverId;
  const present = settings.distribution === 'CUSTOM' && !Budget.invalidReason('CUSTOM', settings.budget)
    ? String(settings.budget).split(';').map(Number) : null;
  const total = present ? present.reduce((a, v) => a + v, 0) : Number(settings.budget) || '';
  const shares = await BudgetSetup.spreadShares(homey, id, settings, CLIMATE_WAIT_MS).catch(() => null);
  return {
    title, unit: BudgetSetup.unit(id), months: BudgetSetup.months(homey), values: present, total, shares,
  };
};
const parseCustom = (homey, data = {}) => {
  const budget = BudgetSetup.customBudget(data.values);
  if (!budget) throw Error(homey.__('error_budget_months'));
  return budget;
};

const parseValues = (defs, ids, values) => {
  const settings = {};
  ids.forEach((id) => {
    const def = defs[id];
    if (!def || values[id] === undefined) return;
    if (def.type === 'checkbox') {
      settings[id] = !!values[id];
    } else if (def.type === 'dropdown') {
      if ((def.values || []).some((v) => v.id === String(values[id]))) settings[id] = String(values[id]);
    } else if (def.type === 'number') {
      let num = Number(values[id]);
      if (!Number.isFinite(num)) return;
      if (typeof def.min === 'number') num = Math.max(def.min, num);
      if (typeof def.max === 'number') num = Math.min(def.max, num);
      settings[id] = num;
    } else {
      settings[id] = String(values[id]).trim();
    }
  });
  return settings;
};

const checkBudget = async (driver, defs, values, settings, all) => {
  const { homey } = driver;
  if (!budgetIds(defs).length) return;
  if (values.use_budget === false) {
    settings.budget = '0';
    if (all.distribution === 'CUSTOM') settings.distribution = 'linear';
    return;
  }
  if (values.use_budget === true && all.distribution === 'CUSTOM') return;
  if (values.use_budget === true && driver.ds.driverId === 'solar' && !String(all.budget || '').trim()) {
    const estimate = await BudgetSetup.solarEstimate(homey, all, CLIMATE_WAIT_MS).catch(() => null);
    if (estimate) {
      settings.budget = String(estimate);
      all.budget = settings.budget;
    }
  }
  const reason = Budget.invalidReason(all.distribution, all.budget);
  if (reason) throw Error(homey.__(reason));
  if (values.use_budget === true && !Budget.isActive(all.distribution, all.budget)) throw Error(homey.__('error_budget_needed'));
};

const mapHint = (homey) => ` (${homey.__('repair.setup_map_manually')})`;
const listName = (driver, name, compat = {}) => (compat.needsMapping ? `${name}${mapHint(driver.homey)}` : name);
const pairName = (driver, name = '') => {
  const hint = mapHint(driver.homey);
  return name.endsWith(hint) ? name.slice(0, -hint.length) : name;
};
const sourceName = (driver, dev) => (driver.sourceName ? driver.sourceName(dev) : pairName(driver, dev.name));

const apiDevice = async (driver, id) => {
  const { api } = driver.homey.app;
  if (!api || !id) return null;
  return api.devices.getDevice({ id, $cache: false }).catch(() => null);
};

const storedRoles = (driver, device) => (driver.setupStored
  ? driver.setupStored(device) : device.getStoreValue('sourceCaps'));

const storeRoles = (driver, deviceId, caps, dev) => [].concat(driver.setupStore
  ? driver.setupStore(deviceId, caps, dev) : { key: 'sourceCaps', value: { sourceId: deviceId, caps } });

const pick = (obj, ids) => ids.reduce((out, id) => {
  if (obj && obj[id] !== undefined) out[id] = obj[id];
  return out;
}, {});

const repairPart = (driver, st) => (st.roles ? 'source' : st.id);

const stepsFor = (driver, dev) => {
  const defs = settingDefs(driver);
  const ids = setupIds(driver, dev);
  return (driver.ds.setup.steps || []).filter((st) => st.roles || (st.id === 'year' && budgetIds(defs).length)
    || st.ids.some((id) => ids.includes(id) && defs[id]));
};

const getSetup = async (driver, dev, current) => {
  const { homey } = driver;
  const defs = settingDefs(driver);
  const preset = driver.ds.setup.preset || {};
  const settings = [];
  const names = priceGroups(driver);
  const repairing = !!current.device;
  const ids = setupIds(driver, dev);
  const fixed = hasFixed(ids);
  const steps = stepsFor(driver, dev);
  const stepOf = (id) => steps.find((st) => (st.ids || []).includes(id)) || steps.find((st) => !st.roles);
  const proposed = !repairing && driver.setupProposals ? await driver.setupProposals(dev).catch(() => ({})) : {};
  const valueOf = (id) => {
    const def = defs[id];
    let value = current.settings[id] !== undefined ? current.settings[id] : def.value;
    if (!repairing && preset[id] !== undefined) value = preset[id];
    if (!repairing && proposed[id] !== undefined) value = proposed[id];
    return driver.setupValue ? driver.setupValue(id, value, dev, current) : value;
  };
  for (const id of ids.filter((i) => defs[i])) {
    const def = defs[id];
    let value = valueOf(id);
    if (id === 'currency') value = (repairing ? MoneyUnit.get(current.device, '') : proposedUnit(driver)).currency || proposedUnit(driver).currency;
    if (value === undefined && def.type === 'number') value = '';
    const setting = {
      id, type: def.type, label: text(homey, def.label), value, min: def.min, max: def.max, info: text(homey, def.info) || undefined, showIf: def.showIf, months: def.months,
    };
    const step = stepOf(id);
    if (step) setting.step = step.id;
    if (FIXED_IDS.includes(id)) setting.showIf = { id: 'tariff_update_group', value: '0' };
    if (def.type === 'dropdown') setting.options = (def.values || []).map((v) => ({ id: v.id, label: text(homey, v.label) }));
    if (id === 'tariff_update_group' && priceKind(driver)) {
      setting.type = 'dropdown';
      const groupLabel = (n) => homey.__('price_setup.group_option', { n });
      setting.options = tariffGroupOptions(names, repairing ? value : undefined, fixed ? homey.__('repair.setup_fixed_tariff') : null, groupLabel);
      setting.value = setupGroup({ tariff_update_group: value }, names, repairing, fixed);
      if (!setting.options.some((opt) => opt.id === setting.value)) setting.value = setting.options[0].id;
      if (!Object.keys(names).length) {
        const ungrouped = PriceDrivers.ungroupedDevice(homey, priceKind(driver));
        if (ungrouped) setting.info = homey.__('repair.setup_price_no_group', { name: ungrouped.getName() });
        else setting.info = homey.__(driver.ds.setup.requirePrice ? 'repair.setup_no_price' : 'repair.setup_no_dap_plan');
      }
    }
    if (driver.setupInfo) setting.info = (await driver.setupInfo(setting, def, dev, current)) || setting.info;
    settings.push(setting);
  }
  settings.push(...budgetSection(homey, defs, current.settings, repairing ? null : BudgetSetup.pairPreset(driver.ds.driverId)));
  const firstStep = steps.find((st) => !st.roles);
  if (repairing && driver.repairActions) {
    driver.repairActions(current.device).forEach((a) => settings.push({
      ...a, type: 'checkbox', value: false, step: a.step || (firstStep && firstStep.id),
    }));
  }
  const roles = driver.setupRoles ? await driver.setupRoles(dev, current.stored) : null;
  if (!repairing && roles && roles.detected) {
    roles.items = roles.items.filter((item) => steps.some((st) => st.id === item.step && !st.roles));
  }
  const rolesHidden = repairing && !current.fromList;
  const shownSteps = steps.filter((st) => (st.roles && roles) || settings.some((x) => x.step === st.id));
  const only = current.only === 'source' && !shownSteps.some((st) => st.roles) ? null : current.only;
  const outside = (st) => !!only && repairPart(driver, st) !== only;
  const repairOnly = (st) => (typeof st.repairOnly === 'function' ? !!st.repairOnly(driver) : !!st.repairOnly);
  const hidden = (st) => !!(st.roles && rolesHidden) || outside(st) || (repairOnly(st) && !repairing);
  const optional = (st) => st.optional === true || (st.optional === 'pair' && !repairing);
  ((roles && roles.items) || []).forEach((item) => {
    const st = item.step && steps.find((x) => x.id === item.step);
    if (st && hidden(st)) delete item.step;
  });
  const toggled = new Set();
  shownSteps.forEach((st, i) => {
    const before = shownSteps.slice(0, i).filter((x) => !hidden(x) && !optional(x)).pop();
    if (!optional(st) || !before || hidden(st)) return;
    const changed = st.id === 'year' ? settings.some((x) => x.id === 'use_budget' && x.value)
      : st.ids.some((x) => defs[x] && ids.includes(x) && String(valueOf(x)) !== String(defs[x].value));
    const toggle = {
      id: `show_${st.id}`, type: 'checkbox', step: before.id, label: homey.__(`repair.setup_show_${st.id}`), value: changed,
    };
    const last = settings.map((x) => x.step).lastIndexOf(before.id);
    settings.splice(last + 1, 0, toggle);
    toggled.add(st.id);
  });
  return {
    steps: shownSteps.map((st) => ({
      id: st.id,
      title: homey.__(`repair.step_${st.id}`),
      text: intro(homey, st.id),
      roles: !!st.roles,
      hidden: hidden(st) || undefined,
      showIf: toggled.has(st.id) ? { id: `show_${st.id}`, value: true } : undefined,
    })),
    back: rolesHidden ? 'repair_start' : 'list_devices',
    calc: driver.setupCalc ? driver.ds.setup.calcInputs : undefined,
    settings,
    roles,
  };
};

const parseSetup = async (driver, dev, base, data = {}, repairing = false, { budget = true } = {}) => {
  const defs = settingDefs(driver);
  const values = { ...(data.settings || {}) };
  if (values.show_year === false) values.use_budget = false;
  const settings = parseValues(defs, [...setupIds(driver, dev), ...(budget ? budgetIds(defs) : [])], values);
  if (settings.start_date !== undefined) {
    settings.start_date = BudgetSetup.validStartDate(settings.start_date);
    if (!settings.start_date) throw Error(driver.homey.__('error_start_date'));
  }
  if (driver.setupParsed) driver.setupParsed(settings, repairing);
  const all = { ...base, ...settings };
  const group = Number(all.tariff_update_group);
  const fixed = hasFixed(setupIds(driver, dev)) && !group;
  if (!repairing && driver.ds.setup.requirePrice && !fixed && !priceGroups(driver)[group]) {
    throw Error(driver.homey.__('error_setup_no_price'));
  }
  if (fixed) settings.currency = fixedUnit(driver, settings.currency).currency;
  else delete settings.currency;
  if (budget) await checkBudget(driver, defs, values, settings, all);
  if (driver.setupValidate) await driver.setupValidate(all, data.caps || {}, dev);
  return settings;
};

const registerCalc = (driver, session) => {
  session.setHandler('setup_calc', async (data = {}) => (driver.setupCalc ? driver.setupCalc(data.settings || {}) : {}));
};

const registerPair = (driver, session, listDevices) => {
  let selected = null;
  let pending = null;
  session.setHandler('list_devices', listDevices);
  session.setHandler('list_devices_selection', (devices) => {
    [selected] = devices;
  });
  registerCalc(driver, session);
  session.setHandler('setup_get', async () => {
    if (!selected || !selected.settings) throw Error(driver.homey.__('error_device_corrupt'));
    return getSetup(driver, selected, { settings: selected.settings, stored: null });
  });
  session.setHandler('setup_set', async (data = {}) => {
    if (!selected || !selected.settings) throw Error(driver.homey.__('error_device_corrupt'));
    const settings = { ...selected.settings, ...await parseSetup(driver, selected, selected.settings, data) };
    const store = { ...(selected.store || {}) };
    const group = Number(settings.tariff_update_group);
    const moneyUnit = group ? driver.moneyUnits && driver.moneyUnits[group] : settings.currency && fixedUnit(driver, settings.currency);
    if (moneyUnit) store[MoneyUnit.STORE_KEY] = moneyUnit;
    if (setupIds(driver, selected).includes('tariff_export')) store.fixedExport = true;
    if (driver.setupNewStore) Object.assign(store, driver.setupNewStore(settings));
    if (data.roleDeviceId) {
      storeRoles(driver, data.roleDeviceId, data.caps || {}, selected).forEach(({ key, value }) => {
        store[key] = value;
      });
    }
    const capabilities = driver.capabilitiesFor ? driver.capabilitiesFor(settings) : selected.capabilities;
    const device = {
      ...selected, name: sourceName(driver, selected), settings, store, capabilities,
    };
    if (wantsCustom(data, settings)) {
      pending = device;
      return { next: 'custom_budget' };
    }
    return { device };
  });
  session.setHandler('custom_get', async () => {
    if (!pending) throw Error(driver.homey.__('error_device_corrupt'));
    return customView(driver, pending.settings, pending.name);
  });
  session.setHandler('custom_set', async (data = {}) => {
    if (!pending) throw Error(driver.homey.__('error_device_corrupt'));
    const settings = { ...pending.settings, budget: parseCustom(driver.homey, data) };
    const capabilities = driver.capabilitiesFor ? driver.capabilitiesFor(settings) : pending.capabilities;
    return { device: { ...pending, settings, capabilities } };
  });
};

const registerRepair = (driver, session, device, listDevices, sourceIds) => {
  driver.log('Repairing of device started', device.getName());
  let selectedDevices = [];
  let setup = null;
  const own = device.getSettings();
  const rank = (dev) => {
    const s = dev.settings || {};
    let score = 0;
    if (s.homey_device_id === own.homey_device_id) score = 2;
    else if (s.source_device_type && s.source_device_type !== 'Homey device'
      && s.source_device_type === own.source_device_type && s.homey_energy === own.homey_energy) score = 2;
    if (score && s.ev_device_id !== undefined && s.ev_device_id === own.ev_device_id) score += 1;
    return score;
  };
  session.setHandler('list_devices', async () => {
    const devices = await listDevices();
    return devices.map((dev, i) => ({ dev, i, r: rank(dev) }))
      .sort((a, b) => (b.r - a.r) || (a.i - b.i))
      .map(({ dev }) => dev);
  });
  let fromList = false;
  let only = null;
  let yearHidden = false;
  let startChoices = null;
  let saved = false;
  session.setHandler('list_devices_selection', (devices) => {
    selectedDevices = devices;
    fromList = true;
  });
  registerCalc(driver, session);
  const currentSettings = (dev) => ({ ...device.getSettings(), ...pick(dev.settings, sourceIds) });
  const selected = () => {
    if (!selectedDevices.length) selectedDevices = [{ name: device.getName(), settings: device.getSettings() }];
    return selectedDevices;
  };
  session.setHandler('setup_get', async () => {
    const [dev] = selected();
    if (!dev || !dev.settings) throw Error(driver.homey.__('error_device_corrupt'));
    const view = await getSetup(driver, dev, {
      settings: currentSettings(dev), stored: storedRoles(driver, device), device, fromList, only: fromList ? 'source' : only,
    });
    yearHidden = view.steps.some((st) => st.id === 'year' && st.hidden);
    return view;
  });
  session.setHandler('setup_set', async (data = {}) => {
    const [dev] = selected();
    if (!dev || !dev.settings) throw Error(driver.homey.__('error_device_corrupt'));
    const actionIds = driver.repairActions ? driver.repairActions(device).map((a) => a.id) : [];
    setup = {
      settings: await parseSetup(driver, dev, currentSettings(dev), data, true, { budget: !yearHidden }),
      roles: data.roleDeviceId ? { deviceId: data.roleDeviceId, caps: data.caps || {} } : null,
      actions: actionIds.filter((id) => (data.settings || {})[id] === true),
    };
    if (!yearHidden && wantsCustom(data, setup.settings)) return { next: 'custom_budget' };
    return {};
  });
  session.setHandler('start_get', async () => {
    selectedDevices = [];
    fromList = false;
    setup = null;
    only = null;
    yearHidden = false;
    const choice = (view, key, part = null) => ({
      id: key, view, part, label: driver.homey.__(`repair.start_${key}`), info: driver.homey.__(`repair.start_${key}_info`),
    });
    const stepChoice = (st) => ({
      id: `step_${st.id}`, view: 'setup', part: st.id, label: driver.homey.__(`repair.step_${st.id}`), info: '',
    });
    const choices = [choice('list_devices', 'source')];
    if (driver.ds.setup) {
      stepsFor(driver, { name: device.getName(), settings: device.getSettings() })
        .filter((st) => !st.roles && st.id !== 'year').forEach((st) => choices.push(stepChoice(st)));
    }
    if (typeof device.fixValues === 'function') choices.push(choice('fix_values', 'fix'));
    if (budgetIds(settingDefs(driver)).length) choices.push({ ...stepChoice({ id: 'year' }), view: 'budget', part: null });
    startChoices = choices;
    const wasSaved = saved;
    saved = false;
    return { choices, saved: wasSaved };
  });
  session.setHandler('start_set', async (id) => {
    const c = (startChoices || []).find((x) => x.id === id);
    if (!c) throw Error(driver.homey.__('error_device_corrupt'));
    only = c.part;
    return c.view;
  });
  session.setHandler('budget_get', async () => ({
    steps: [{ id: 'year', title: driver.homey.__('repair.step_year'), text: intro(driver.homey, 'year') }],
    settings: budgetSection(driver.homey, settingDefs(driver), device.getSettings()),
  }));
  session.setHandler('budget_set', async (data = {}) => {
    const defs = settingDefs(driver);
    const values = data.settings || {};
    const settings = parseValues(defs, budgetIds(defs), values);
    await checkBudget(driver, defs, values, settings, { ...device.getSettings(), ...settings });
    setup = {
      settings, roles: null, actions: [], budgetOnly: true,
    };
    if (wantsCustom(data, settings)) return { next: 'custom_budget' };
    return {};
  });
  session.setHandler('custom_get', async () => {
    if (!setup) throw Error(driver.homey.__('error_device_corrupt'));
    const settings = { ...device.getSettings(), ...setup.settings };
    if (!String(setup.settings.budget || '').trim()) settings.budget = device.getSettings().budget;
    return customView(driver, settings, device.getName());
  });
  session.setHandler('custom_set', async (data = {}) => {
    if (!setup) throw Error(driver.homey.__('error_device_corrupt'));
    setup.settings.budget = parseCustom(driver.homey, data);
    return {};
  });
  session.setHandler('showView', async (viewId) => {
    if (viewId !== 'loading') return;
    const budgetOnly = !!(setup && setup.budgetOnly);
    const [dev] = selectedDevices;
    if (!budgetOnly && (!dev || !dev.settings)) {
      await session.showView('done');
      throw Error(driver.homey.__('error_device_corrupt'));
    }
    const oldSettings = device.getSettings();
    const newSettings = budgetOnly ? setup.settings : { ...pick(dev.settings, sourceIds), ...(setup ? setup.settings : {}) };
    driver.log('old settings:', oldSettings);
    const changedKeys = Object.keys(newSettings)
      .filter((id) => !sourceIds.includes(id) && newSettings[id] !== oldSettings[id]);
    try {
      if (changedKeys.length) {
        await device.onSettings({ oldSettings, newSettings: { ...oldSettings, ...newSettings }, changedKeys });
      }
      await device.setSettings(newSettings);
      if (!budgetOnly && newSettings.currency && !Number(device.getSettings().tariff_update_group)) {
        await device.setStoreValue(MoneyUnit.STORE_KEY, fixedUnit(driver, newSettings.currency));
        await require('./SettingsView').update(device).catch((err) => driver.error(err)); // eslint-disable-line global-require
      }
      if (!budgetOnly && newSettings.homey_device_id !== oldSettings.homey_device_id && device.onSourceChanged) await device.onSourceChanged();
      const moved = ['homey_device_id', 'ev_device_id'].some((key) => key in newSettings && newSettings[key] !== oldSettings[key]);
      if (!budgetOnly && moved && device.refreshDriverWarnings) {
        device.refreshDriverWarnings();
        await device.updateWarning().catch((err) => driver.error(err));
      }
    } catch (err) {
      driver.error(err);
      await session.showView('done');
      throw err;
    }
    if (setup && setup.roles) {
      for (const { key, value } of storeRoles(driver, setup.roles.deviceId, setup.roles.caps, selectedDevices[0])) {
        await device.setStoreValue(key, value).catch((err) => driver.error(err));
      }
    }
    for (const id of (setup && setup.actions) || []) {
      await device.onRepairAction(id).catch((err) => driver.error(err));
    }
    saved = true;
    await session.showView('repair_start');
    driver.log('new settings:', device.getSettings());
    device.restartDevice().catch((err) => driver.error(err));
  });
  if (typeof device.fixValues === 'function') {
    session.setHandler('fix_get', async () => device.fixValues());
    session.setHandler('fix_set', async (data = {}) => {
      const result = await device.applyFixValues(data);
      saved = true;
      return result;
    });
  }
  session.setHandler('disconnect', () => {
    driver.log('Repairing of device ended', device.getName());
  });
};

module.exports = {
  text,
  settingDefs,
  updatePriceInfo,
  listName,
  apiDevice,
  listScore,
  sortByScore,
  registerPair,
  registerRepair,
};
