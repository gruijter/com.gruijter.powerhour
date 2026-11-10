'use strict';

// Writes the settings of each driver.compose.json: the editable settings first, then the setup view's
// settings read-only (lib/helpers/SettingsView.js) per setup step, then what the device learned.
// Run: node test/tools/settingsView.js [--check]   then: homey app build
// --check: only report missing hints and translations, write nothing.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const LANGS = ['en', 'nl', 'de', 'fr', 'it', 'sv', 'no', 'es', 'da', 'pl', 'ru', 'ar', 'ko'];
const HINTS = require(path.join(__dirname, 'SettingsViewHints.json'));

// Load the drivers outside Homey.
const origLoad = Module._load;
Module._load = function load(req, ...rest) {
  if (req === 'homey') {
    class X {}
    return {
      Driver: X, Device: X, App: X, SimpleClass: X,
    };
  }
  return origLoad.call(this, req, ...rest);
};
const PairSetup = require(path.join(ROOT, 'lib/helpers/PairSetup.js'));
const SettingsView = require(path.join(ROOT, 'lib/helpers/SettingsView.js'));

const locales = Object.fromEntries(LANGS.map((l) => [l, require(path.join(ROOT, `locales/${l}.json`))]));
const key = (lang, k) => k.split('.').reduce((o, p) => (o ? o[p] : undefined), locales[lang]);

const missing = [];
// A translation object in all languages from an object or a locale key.
const tr = (t, where, vars = {}) => {
  const out = {};
  LANGS.forEach((l) => {
    let s = typeof t === 'string' ? key(l, t) : t && t[l];
    if (typeof s !== 'string') {
      missing.push(`${where} [${l}]`);
      s = typeof t === 'string' ? key('en', t) : (t && t.en) || '';
    }
    Object.entries(vars).forEach(([k, v]) => {
      s = s.replace(`__${k}__`, typeof v === 'object' ? v[l] : v);
    });
    out[l] = s;
  });
  return out;
};

// Per driver: editable groups (top), the learned/status groups (bottom), and the source device
// labels (in the group of the setup step that picks the source). Groups by their present English label.
const LAYOUT = {
  battery: {
    editable: [{ group: 'Planning and control', ids: ['xomTarget'] }],
    status: [{ group: 'Battery properties', ids: ['learnedInfo', 'calibrationInfo'] }],
    source: ['homey_device_id', 'homey_device_name'],
  },
  evCharger: {
    editable: [{ group: 'Charging', ids: ['awayPeriods'] }],
    status: [{
      group: 'Learned driving pattern',
      ids: ['learned_power', 'learned_profile_mon', 'learned_profile_tue', 'learned_profile_wed', 'learned_profile_thu',
        'learned_profile_fri', 'learned_profile_sat', 'learned_profile_sun', 'learned_efficiency', 'learned_consumption'],
    }],
    source: ['homey_device_id', 'homey_device_name', 'ev_device_id', 'ev_device_name'],
  },
  grid: { status: [{ group: 'Home load forecast', ids: ['forecast_accuracy'] }], source: ['homey_device_id', 'homey_device_name', 'source_capability'] },
  power: { status: [{ group: 'Forecast and planner', ids: ['appliance_status'] }], source: ['homey_device_id', 'homey_device_name', 'source_capability'] },
  solar: { status: [{ group: 'Solar panels', ids: ['training_status', 'peakPowerAllTime'] }], source: ['homey_device_id', 'homey_device_name', 'source_capability'] },
  gas: { source: ['homey_device_id', 'homey_device_name', 'source_capability'] },
  water: { source: ['homey_device_id', 'homey_device_name', 'source_capability'] },
  price: {},
};
// Group titles of the Energy Price device's steps.
const PRICE_TITLES = {
  price_type: 'settings_view.step_price_type', import: 'settings_view.step_import', export: 'settings_view.step_export', advanced: 'repair.step_advanced',
};

const homey = {
  app: { manifest: require(path.join(ROOT, 'app.json')), api: null },
  __: (k) => k,
  i18n: { getLanguage: () => 'en' },
  drivers: { getDrivers: () => ({}), getDriver: () => ({ getDevices: () => [] }) },
  clock: { getTimezone: () => 'Europe/Amsterdam' },
  geolocation: { getLatitude: () => 52, getLongitude: () => 5 },
};

const loadDriver = async (id) => {
  if (id === 'price') return { homey, ds: { driverId: 'price' } };
  const Drv = require(path.join(ROOT, `drivers/${id}/driver.js`));
  const drv = new Drv();
  drv.homey = homey;
  drv.getDevices = () => [];
  try {
    await drv.onInit();
  } catch {
    // only ds is needed
  }
  return drv;
};

const flatten = (settings) => {
  const out = {};
  const groups = {};
  (settings || []).forEach((s) => {
    if (s.type === 'group') {
      groups[s.label.en] = s;
      (s.children || []).forEach((c) => {
        out[c.id] = c;
      });
    } else out[s.id] = s;
  });
  return { items: out, groups };
};

const dump = process.argv.includes('--dump');
// The label says it all: no hint.
const NO_HINT = ['chartShowPower', 'chartShowSoc', 'chartShowExportPrice', 'chartShowLegend', 'dischargeToEv', 'wearCalc',
  'markup_hour', 'peakDistinctDays', 'peakWeekdaysOnly', 'battery.chargePower', 'battery.dischargePower'];
const DRIVER_DEFS = require(path.join(ROOT, 'lib/helpers/DriverSetupSettings.json'));
const hintFor = (driverId, id, def) => {
  const h = HINTS[`${driverId}.${id}`] || HINTS[id] || HINTS[id.replace(/_\d$/, '')];
  if (h) return tr(h, `hint ${driverId}.${id}`);
  if (NO_HINT.includes(id) || NO_HINT.includes(`${driverId}.${id}`)) return null;
  // A locale key (app-managed settings in PairSetup) or a translation object.
  if (def && def.info && typeof def.info === 'string') return tr(def.info, `info ${driverId}.${id}`);
  if (def && def.info && typeof def.info === 'object') {
    if (dump) console.log(`  ${driverId}.${id}: ${def.info.en}`);
    return tr(def.info, `info ${driverId}.${id}`);
  }
  // The same setting of another driver.
  const other = Object.values(DRIVER_DEFS).find((d) => d[id] && d[id].info && typeof d[id].info === 'object');
  if (other) return tr(other[id].info, `info ${driverId}.${id}`);
  missing.push(`hint ${driverId}.${id} [all]`);
  return null;
};

const run = async () => {
  const check = process.argv.includes('--check');
  for (const driverId of Object.keys(LAYOUT)) {
    const file = path.join(ROOT, `drivers/${driverId}/driver.compose.json`);
    const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { items, groups } = flatten(compose.settings);
    const layout = LAYOUT[driverId];
    const drv = await loadDriver(driverId);
    const defs = PairSetup.settingDefs(drv);
    const label = (id) => {
      if (items[id] && items[id].type === 'label' && SettingsView.OWN_LABELS.includes(id)) return items[id].label;
      return defs[id] && defs[id].label;
    };
    const viewItem = (id) => {
      if (SettingsView.OWN_LABELS.includes(id) && items[id]) {
        const own = { ...items[id] };
        const hint = hintFor(driverId, id, null);
        if (hint) own.hint = hint;
        return own;
      }
      const item = {
        id: SettingsView.viewId(id), type: 'label', label: tr(label(id), `label ${driverId}.${id}`), value: '-',
      };
      const hint = hintFor(driverId, id, defs[id]);
      if (hint) item.hint = hint;
      return item;
    };
    const keep = (id) => {
      const item = { ...items[id] };
      if (!items[id]) throw Error(`${driverId}: no setting ${id}`);
      const hint = HINTS[`${driverId}.${id}`] || HINTS[id];
      if (hint) item.hint = tr(hint, `hint ${driverId}.${id}`);
      else if (dump && item.hint) console.log(`  ${driverId}.${id} (kept): ${item.hint.en}`);
      return item;
    };
    const group = (labelObj, children) => ({ type: 'group', label: labelObj, children });
    const existing = (name) => {
      if (!groups[name]) throw Error(`${driverId}: no group ${name}`);
      return groups[name].label;
    };
    const note = {
      id: 'repair_note', type: 'label', label: tr('settings_view.repair_note', `note ${driverId}`), value: '',
    };

    const settings = [];
    (layout.editable || []).forEach((g) => settings.push(group(existing(g.group), g.ids.map(keep))));
    const steps = drv.ds.setup ? drv.ds.setup.steps : null;
    let sourceShown = false;
    let noteShown = false;
    SettingsView.groupsFor(driverId, steps).forEach((g) => {
      const children = [];
      if (g.roles && !sourceShown) {
        children.push(...(layout.source || []).map(keep));
        sourceShown = true;
      }
      children.push(...g.ids.map(viewItem));
      if (!children.length) return;
      // One line above the settings that change via Repair.
      if (!noteShown) {
        children.unshift(note);
        noteShown = true;
      }
      const title = driverId === 'price' ? PRICE_TITLES[g.id] : `repair.step_${g.id}`;
      settings.push(group(tr(title, `title ${driverId}`), children));
    });
    (layout.status || []).forEach((g) => settings.push(group(existing(g.group), g.ids.map(keep))));
    const count = settings.reduce((a, g) => a + g.children.length, 0);
    console.log(`${driverId}: ${settings.length} groups, ${count} settings`);
    if (!check) {
      compose.settings = settings;
      fs.writeFileSync(file, `${JSON.stringify(compose, null, 2)}\n`);
    }
  }
  const unique = [...new Set(missing)];
  if (unique.length) console.log(`missing (${unique.length}):\n${unique.join('\n')}`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
