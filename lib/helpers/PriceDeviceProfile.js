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

// The expected-price profile (PriceProfile) of a price device: learned from its own prices, started
// from its own Insights. One source for the widget (and later the planners).
const FileStore = require('./FileStore');
const InsightsHistory = require('./InsightsHistory');
const PriceDrivers = require('./PriceDrivers');
const TimeHelpers = require('./TimeHelpers');
const PriceProfile = require('../strategies/PriceProfile');

const KEY = 'priceProfile';
const BOOTSTRAP_VERSION = 3; // 3: daily sums for the average
const BOOTSTRAP_RETRY_MS = 6 * 60 * 60 * 1000;

const tzOf = (dev) => dev.timeZone || dev.homey.clock.getTimezone();

const load = async (dev) => {
  if (!dev.priceProfile) {
    const files = await FileStore.open(dev, [KEY]);
    dev.priceProfile = files.get(KEY) || PriceProfile.createProfile();
  }
  return dev.priceProfile;
};

const save = async (dev) => (await FileStore.open(dev)).set(KEY, dev.priceProfile);

// The device's prices ({ time, price, exportPrice, isForecast }), per hour (mean of its slots).
const hourly = (dev) => {
  const hours = new Map();
  (Array.isArray(dev.prices) ? dev.prices : []).forEach((p) => {
    if (!p || !p.time || typeof p.muPrice !== 'number') return;
    const hourMs = TimeHelpers.startOfLocalBlock(new Date(p.time).getTime(), 60, tzOf(dev));
    const h = hours.get(hourMs) || {
      sum: 0, exp: 0, n: 0, expN: 0, forecast: false,
    };
    h.sum += p.muPrice;
    h.n += 1;
    if (typeof p.exportPrice === 'number') {
      h.exp += p.exportPrice;
      h.expN += 1;
    }
    h.forecast = h.forecast || !!p.isForecast;
    hours.set(hourMs, h);
  });
  return [...hours.entries()].map(([time, h]) => ({
    time, price: h.sum / h.n, exportPrice: h.expN ? h.exp / h.expN : undefined, isForecast: h.forecast,
  }));
};

// The device and the old price devices it took over in its tariff group (DapTakeover): their history.
const historyDevices = (dev) => {
  const group = Number(dev.getSettings().tariff_update_group);
  const commodity = PriceDrivers.commodityOf(dev.driver.id, dev.getSettings());
  const old = group ? PriceDrivers.getDevices(dev.homey, { commodity, driverIds: PriceDrivers.OLD_DRIVER_IDS })
    .filter((d) => Number(d.getStoreValue(PriceDrivers.TAKEN_OVER_GROUP_KEY)) === group) : [];
  return [dev, ...old];
};

// A profile the group's planners can use instead of their own: learned from the history once.
const isReady = (profile) => !!profile && profile.bootstrapped === BOOTSTRAP_VERSION;

// Hourly prices of the longest price log (14 days) of the device and the old ones it took over, once;
// force: again.
const bootstrap = async (dev, { force = false } = {}) => {
  const profile = await load(dev);
  if (!force && isReady(profile)) return;
  if (!force && Date.now() - (dev.priceProfileBootstrapTm || 0) < BOOTSTRAP_RETRY_MS) return;
  const { api } = dev.homey.app;
  if (!api) return;
  dev.priceProfileBootstrapTm = Date.now();
  const history = async (d, caps) => {
    const cap = caps.find((c) => d.hasCapability(c));
    if (!cap) return [];
    return (await InsightsHistory.fetchHistory(api, `homey:device:${d.getId()}:${cap}`, ['last7Days', 'last14Days']))
      .filter((e) => !e.coarse);
  };
  let imp = [];
  let source = dev;
  for (const d of historyDevices(dev)) {
    const values = await history(d, PriceDrivers.PRICE_LOG_CAPS.import);
    if (values.length > imp.length) {
      imp = values;
      source = d;
    }
  }
  const exp = new Map((await history(source, PriceDrivers.PRICE_LOG_CAPS.export)).map((e) => [e.t, e.v]));
  const fresh = PriceProfile.createProfile();
  const entries = imp.map((e) => ({ time: e.t, price: e.v, exportPrice: exp.get(e.t) }));
  PriceProfile.learn(fresh, entries, tzOf(dev));
  PriceProfile.addDailySums(fresh, entries, tzOf(dev));
  fresh.bootstrapped = BOOTSTRAP_VERSION;
  dev.priceProfile = fresh;
  await save(dev);
  dev.log(`[Price Profile] bootstrapped from ${imp.length} hourly prices`);
};

// Learn the known prices: the profile from the published ones, the average from all (forecasts too).
// Before every broadcast (no Insights reads): the planners of the group plan with them.
const learnKnown = async (dev) => {
  const profile = await load(dev);
  const before = JSON.stringify([profile.lastLearnedMs, profile.dailySums]);
  const hours = hourly(dev);
  PriceProfile.learn(profile, hours.filter((h) => !h.isForecast), tzOf(dev));
  PriceProfile.addDailySums(profile, hours, tzOf(dev));
  if (JSON.stringify([profile.lastLearnedMs, profile.dailySums]) !== before) await save(dev);
};

// The history first (once), then the known prices.
const learn = async (dev) => {
  await bootstrap(dev).catch((err) => dev.error(err));
  await learnKnown(dev);
};

// A new market (zone, energy, tariff type) or currency: start over, without the old history.
const reset = async (dev) => {
  dev.priceProfile = { ...PriceProfile.createProfile(), bootstrapped: BOOTSTRAP_VERSION };
  await save(dev);
};

module.exports = {
  KEY, load, learn, learnKnown, reset, bootstrap, isReady,
};
