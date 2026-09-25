/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./helpers/Util');

// Capability-list repair, ported from com.foxess's lib/DeviceMigrator.js (the most complete of the
// gruijter apps' versions).

// Homey needs a moment between capability changes.
const SETTLE_MS = 2 * 1000;

// One migration per device at a time. A second request while one is still settling would have both
// remove and re-add each other's capabilities.
const running = new WeakMap();

const migrate = async (device, correctCaps, {
  settleMs, unavailableMessage, restoreAvailable, shouldAbort,
}) => {
  if (!Array.isArray(correctCaps)) throw Error(`No capability list to migrate ${device.getName()} to`);
  const wanted = [...new Set(correctCaps.filter(Boolean))];

  // Snapshot the capability list ONCE and do a single removal pass + single addition pass.
  // Re-querying device.getCapabilities() after every change does not reflect this function's own
  // removeCapability()/addCapability() calls as they happen, which turned an O(n) migration into
  // O(n^2) round trips that never converged (confirmed empirically on the grid device).
  const caps = device.getCapabilities();
  const maxLen = Math.max(caps.length, wanted.length);
  let firstMismatch = -1;
  for (let index = 0; index < maxLen; index += 1) {
    if (caps[index] !== wanted[index]) {
      firstMismatch = index;
      break;
    }
  }
  if (firstMismatch === -1) return false;

  device.log(`migrating capabilities for ${device.getName()} from index ${firstMismatch}:`, caps.slice(firstMismatch), '->', wanted.slice(firstMismatch));

  // Snapshot values via the documented getter. An earlier version read the SDK-internal
  // Symbol(state), which no longer exists: every migration restored nothing and blanked all
  // re-added capabilities (confirmed live 2026-09-25, grid device).
  const state = {};
  caps.forEach((cap) => {
    state[cap] = device.getCapabilityValue(cap);
  });

  const wasAvailable = typeof device.getAvailable === 'function' ? device.getAvailable() : true;
  if (wasAvailable && unavailableMessage) device.setUnavailable(unavailableMessage).catch(() => null);

  try {
    // remove all caps from the first mismatch onward - also covers extra trailing caps not in
    // wanted at all, e.g. the 'distribution NONE' case where the list is shorter
    for (let i = firstMismatch; i < caps.length; i += 1) {
      if (shouldAbort && shouldAbort()) return true;
      if (device.hasCapability(caps[i])) {
        device.log(`removing capability ${caps[i]} for ${device.getName()}`);
        await device.removeCapability(caps[i]).catch((err) => device.error(err));
        await setTimeoutPromise(settleMs, device);
      }
    }

    for (let index = firstMismatch; index < wanted.length; index += 1) {
      if (shouldAbort && shouldAbort()) return true;
      const newCap = wanted[index];
      if (!device.hasCapability(newCap)) {
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap).catch((err) => device.error(err));
      }
      // null means no value yet, and restoring it is a no-op, so skip it. setCapabilityValue, not
      // the device's setCapability() wrapper: the stored value is restored as-is, without the
      // wrapper's conversions (e.g. re-parsing an already formatted last_minmax_reset string).
      if (state[newCap] !== undefined && state[newCap] !== null) {
        device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        await device.setCapabilityValue(newCap, state[newCap]).catch((err) => device.error(err));
      }
      await setTimeoutPromise(settleMs, device);
    }
  } finally {
    if (wasAvailable && unavailableMessage && restoreAvailable) await device.setAvailable().catch((err) => device.error(err));
  }
  return true;
};

/**
 * Repairs a device's capability list (existence AND order) against `correctCaps`, restoring each
 * re-added capability's previous value. Everything before the first mismatch is left alone.
 * Removing and re-adding a capability keeps its Insights history (confirmed live 2026-09-25).
 * @param {Homey.Device} device
 * @param {string[]} correctCaps the capability ids, in the order the device should have them
 * @param {object} [options]
 * @param {string} [options.unavailableMessage] shown while migrating; omit to leave availability alone
 * @param {boolean} [options.restoreAvailable] make the device available again afterwards (when it was)
 * @param {function(): boolean} [options.shouldAbort] stop early, e.g. when the device re-initialised
 * @param {number} [options.settleMs] pause after each capability change
 * @returns {Promise<boolean>} whether the capability list was touched
 */
const migrateCapabilityList = async (device, correctCaps, {
  settleMs = SETTLE_MS, unavailableMessage, restoreAvailable = true, shouldAbort,
} = {}) => {
  const previous = running.get(device) || Promise.resolve();
  const job = previous.catch(() => null).then(() => migrate(device, correctCaps, {
    settleMs, unavailableMessage, restoreAvailable, shouldAbort,
  }));
  running.set(device, job);
  try {
    return await job;
  } finally {
    if (running.get(device) === job) running.delete(device);
  }
};

module.exports = {
  migrateCapabilityList,

  // Returns false when the device re-initialised meanwhile (the caller must stop), true otherwise.
  async migrateCapabilities(device, correctCaps) {
    const currentSessionId = device.sessionId;
    device.log(`checking device migration for ${device.getName()}`);
    const changed = await migrateCapabilityList(device, correctCaps, {
      unavailableMessage: device.homey.__('device_migrating'),
      restoreAvailable: false, // onInit() makes the device available after its currency migration
      shouldAbort: () => device.sessionId !== currentSessionId,
    });
    if (device.sessionId !== currentSessionId) return false;
    // re-added money capabilities come back with the manifest's units: re-apply the currency
    if (changed) device.currencyChanged = true;
    return true;
  },

  async checkCurrencyMismatch(device, targetCurrency, defaultCurrency = '¤', targetCapability = 'meter_tariff') {
    try {
      if (!device.currencyChanged && device.hasCapability(targetCapability)) {
        const opts = device.getCapabilityOptions(targetCapability);
        let currency = targetCurrency;
        if (!currency || currency === '') currency = defaultCurrency;
        if (opts && opts.units && opts.units.en !== currency) {
          device.log(`Currency mismatch detected at boot (is: ${opts.units.en}, should be: ${currency}). Forcing migration.`);
          device.currencyChanged = true;
        }
      }
    } catch {
      // ignore
    }
  },

  // Looks up a driver's compose-declared capabilitiesOptions from the app manifest - the
  // authoritative source for things like a per-instance title override (e.g. the "(imported)"/
  // "(exported)" suffix on a dot-suffixed capability). device.getCapabilityOptions() instead
  // reflects the device's own current (possibly already-corrupted, see below) runtime state, not
  // the manifest, so it's not a safe merge base.
  getManifestCapabilitiesOptions(device) {
    const driverId = device.driver?.ds?.driverId;
    const driverManifest = device.homey.app.manifest.drivers.find((d) => d.id === driverId);
    return (driverManifest && driverManifest.capabilitiesOptions) || {};
  },

  async migrateCurrencyOptions(device, currency, decimals, defaultCurrency = '¤', currencyUnit = null) {
    device.log('migrating money capability options via DeviceMigrator');
    device.migrating = true;
    device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

    let curr = currency;
    let dec = decimals;
    if (!currency || currency === '') curr = defaultCurrency;
    if (!Number.isInteger(decimals)) dec = 2;

    const allCaps = device.driver.ds.deviceCapabilities || [];
    const manifestOptions = this.getManifestCapabilitiesOptions(device);

    // 1. Standard money/price caps
    let standardCaps = [];
    if (currencyUnit) {
      standardCaps = allCaps.filter((name) => name.includes('money') && !name.includes('_avg'));
    } else if (allCaps.some((name) => name.includes('meter_price'))) {
      standardCaps = allCaps.filter((name) => name.includes('meter_price'));
    } else {
      standardCaps = allCaps.filter((name) => name.includes('meter_money'));
    }

    for (let i = 0; i < standardCaps.length; i += 1) {
      if (device.hasCapability(standardCaps[i])) {
        device.log(`migrating ${standardCaps[i]} to use ${curr} and ${dec} decimals`);
        // Merge onto the manifest-declared options (title, insights, etc.) - passing only
        // {units, decimals} here would otherwise overwrite the whole options object and silently
        // drop a per-instance title override, falling back to the base capability type's generic
        // title. Invisible for capabilities without such an override, which is why this went
        // unnoticed until per-instance titles were added.
        const baseOptions = manifestOptions[standardCaps[i]] || {};
        await device.setCapabilityOptions(standardCaps[i], { ...baseOptions, units: { en: curr }, decimals: dec }).catch((err) => device.error(err));
        await setTimeoutPromise(1000, device);
      }
    }

    // 2. Tariff cap
    if (device.hasCapability('meter_tariff')) {
      device.log('migrating meter_tariff units and decimals');
      const baseTariffOptions = manifestOptions.meter_tariff || {};
      await device.setCapabilityOptions('meter_tariff', { ...baseTariffOptions, units: { en: curr }, decimals: 4 }).catch((err) => device.error(err));
      await setTimeoutPromise(1000, device);
    }

    // 3. Avg caps
    if (currencyUnit) {
      const avgCaps = allCaps.filter((name) => name.includes('money') && name.includes('_avg'));
      for (let i = 0; i < avgCaps.length; i += 1) {
        if (device.hasCapability(avgCaps[i])) {
          device.log(`migrating avg units and decimals for ${avgCaps[i]}`);
          const baseAvgOptions = manifestOptions[avgCaps[i]] || {};
          await device.setCapabilityOptions(avgCaps[i], { ...baseAvgOptions, units: { en: `${curr}/${currencyUnit}` }, decimals: 4 }).catch((err) => device.error(err));
          await setTimeoutPromise(1000, device);
        }
      }
    }

    device.currencyChanged = false;
    device.migrating = false;
  },

  async migrateMeterOptions(device, decimals) {
    device.log('migrating meter capability options via DeviceMigrator');
    device.migrating = true;
    device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

    let dec = decimals;
    if (!Number.isInteger(decimals)) dec = 4;

    const allCaps = device.driver.ds.deviceCapabilities || [];
    const manifestOptions = this.getManifestCapabilitiesOptions(device);

    const processCaps = async (caps, opts) => {
      for (let i = 0; i < caps.length; i += 1) {
        if (device.hasCapability(caps[i])) {
          device.log(`migrating decimals for ${caps[i]}`);
          // Merge onto manifest-declared options - see the identical comment in
          // migrateCurrencyOptions() above for why a partial {units, decimals} object can't be
          // passed directly.
          const baseOptions = manifestOptions[caps[i]] || {};
          await device.setCapabilityOptions(caps[i], { ...baseOptions, ...opts }).catch((err) => device.error(err));
          await setTimeoutPromise(1000, device);
        }
      }
    };

    const capsKWh = allCaps.filter((name) => name.includes('meter_kwh') || name.startsWith('meter_power'));
    const capsM3 = allCaps.filter((name) => name.includes('meter_m3') || name.startsWith('meter_gas') || name.startsWith('meter_water'));

    await processCaps(capsKWh, { units: { en: 'kWh' }, decimals: dec });
    await processCaps(capsM3, { units: { en: 'm³' }, decimals: dec });

    device.meterDecimalsChanged = false;
    device.migrating = false;
    device.log('meter capability options migration ready');
  },
};
