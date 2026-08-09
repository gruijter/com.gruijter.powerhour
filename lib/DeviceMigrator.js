/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const { setTimeoutPromise } = require('./Util');

module.exports = {
  async migrateCapabilities(device, correctCaps) {
    const currentSessionId = device.sessionId;
    device.log(`checking device migration for ${device.getName()}`);

    // store the capability states before migration
    const sym = Object.getOwnPropertySymbols(device).find((s) => String(s) === 'Symbol(state)');
    const state = { ...device[sym] };

    // Snapshot the real capability list ONCE, rather than re-querying device.getCapabilities()
    // on every step (as an earlier version of this loop did). That call does not reflect this
    // method's own removeCapability()/addCapability() calls as they happen, so re-fetching it
    // every iteration made the code think the full original mismatch was still present after
    // every single change - it re-removed the entire trailing tail (mostly already-gone
    // capabilities, 404ing harmlessly) once per capability added, turning an O(n) migration
    // into O(n^2) round trips (confirmed empirically: inserting 3 new grid capabilities before
    // measure_power.home took 85+ seconds per capability and never actually converged, in both
    // --remote and local Docker runs). Comparing against one snapshot and doing a single
    // removal pass + single addition pass avoids that.
    const caps = device.getCapabilities();
    const maxLen = Math.max(caps.length, correctCaps.length);
    let firstMismatch = -1;
    for (let index = 0; index < maxLen; index += 1) {
      if (caps[index] !== correctCaps[index]) {
        firstMismatch = index;
        break;
      }
    }
    if (firstMismatch === -1) return true;

    device.setUnavailable(device.homey.__('device_migrating')).catch((err) => device.error(err));

    // remove all caps from the first mismatch onward (also covers extra trailing caps not in
    // correctCaps at all, e.g. the 'distribution NONE' case where correctCaps is shorter)
    for (let i = firstMismatch; i < caps.length; i += 1) {
      if (device.sessionId !== currentSessionId) return false;
      if (device.hasCapability(caps[i])) {
        device.log(`removing capability ${caps[i]} for ${device.getName()}`);
        await device.removeCapability(caps[i]).catch((err) => device.error(err));
        await setTimeoutPromise(2 * 1000, device); // wait a bit for Homey to settle
      }
    }

    for (let index = firstMismatch; index < correctCaps.length; index += 1) {
      if (device.sessionId !== currentSessionId) return false;
      const newCap = correctCaps[index];
      if (!device.hasCapability(newCap)) {
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap).catch((err) => device.error(err));
      }

      if (state[newCap] !== undefined) {
        device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        await device.setCapability(newCap, state[newCap]).catch((err) => device.error(err));
      } else {
        device.log(`${device.getName()} no value to restore for new capability ${newCap}`);
      }
      await setTimeoutPromise(2 * 1000, device); // wait a bit for Homey to settle
      device.currencyChanged = true;
    }
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
    } catch (e) {
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
