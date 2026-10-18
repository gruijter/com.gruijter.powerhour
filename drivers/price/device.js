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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_dap_device');
const PriceFlows = require('../../lib/flows/PriceFlows');
const PriceFormula = require('../../lib/PriceFormula');
const PriceCalculator = require('../../lib/PriceCalculator');
const PriceSetup = require('../../lib/helpers/PriceSetup');

const FORMULA_KEYS = ['formula', 'export_formula'];
// Changing these needs new market prices (repair).
const MARKET_KEYS = ['commodity', 'tariffType', 'biddingZone', 'priceInterval'];
const PRICE_KEYS = [
  'tax', 'vat', 'fixedMarkupInclVat', 'taxInclVat', 'fixedMarkupTODInclVat', 'fixedMarkupWeekendInclVat', 'formula',
].flatMap((id) => [id, `export_${id}`]);
const STORED_PRICES = ['prices', 'marketPrices', 'rawCombinedPrices', 'rawMarketPrices', 'rawForecastPrices', 'priceHistory'];

// Price cards per price period; gas has one price per day: no cheapest or most expensive cards.
const POWER_TRIGGERS = ['price_cheapest_next', 'price_cheapest_between', 'price_block_next', 'price_block_between', 'price_vs_avg'];
const GAS_TRIGGERS = ['price_vs_avg'];

class PriceDevice extends GenericDevice {

  async onInit() {
    await this.syncFormulaLabels().catch((err) => this.error(err));
    await super.onInit();
  }

  createFlows() {
    return new PriceFlows(this);
  }

  usesMarketPrices() {
    return this.getSettings().tariffType !== 'fixed';
  }

  // Fixed tariff: price slots from yesterday to the end of tomorrow with market price 0; the price
  // comes from the price settings (markup, tax, time of day, weekend).
  async fetchPrices() {
    if (this.usesMarketPrices()) return super.fetchPrices();
    try {
      const periods = this.getUTCPeriods();
      const step = this.priceInterval * 60 * 1000;
      const slots = [];
      for (let t = periods.yesterdayStart.getTime(); t < periods.tomorrowEnd.getTime(); t += step) {
        slots.push({ time: new Date(t), price: 0, provider: 'Fixed' });
      }
      slots.provider = 'Fixed';
      await this.processMarketPrices(slots, this.pricesProvider);
    } catch (error) {
      this.error(error);
    }
    return undefined;
  }

  // The rank capabilities count the slots of this interval.
  capabilityOptions() {
    const options = super.capabilityOptions();
    const perDay = (24 * 60) / this.priceInterval;
    const units = (n) => ({ units: { en: `/${n}` } });
    if (this.hasCapability('meter_rank_price_h0_this_day')) options.meter_rank_price_h0_this_day = units(perDay);
    if (this.hasCapability('meter_rank_price_h0_next_8h')) options.meter_rank_price_h0_next_8h = units(perDay / 3);
    return options;
  }

  priceSettingKeys() {
    return [...super.priceSettingKeys(), ...PRICE_KEYS];
  }

  markupPrices(marketPrices) {
    return PriceFormula.applyPrices(marketPrices, this.settings, this.timeZone);
  }

  monthAvgCaps() {
    return { thisMonth: 'measure_monetary.month_avg', lastMonth: 'measure_monetary.last_month_avg' };
  }

  priceTriggerIds() {
    return this.isGas ? GAS_TRIGGERS : POWER_TRIGGERS;
  }

  async triggerNewPeriod() {
    const { app } = this.homey;
    if (!app || !app.trigger_price_new_period) return;
    const exportPrice = Number.isFinite(this.state.exportPriceNow) ? this.state.exportPriceNow : 0;
    await app.trigger_price_new_period(this, { import: this.state.priceNow, export: this.isGas ? 0 : exportPrice });
  }

  async triggerNewPrices(tokens, state) {
    const { app } = this.homey;
    if (!app || !app.trigger_price_new_prices) return;
    await app.trigger_price_new_prices(this, { ...tokens, export_prices: this.exportPricesJson(state.period) }, state);
  }

  // Export prices of a period as JSON ('[]' for gas).
  exportPricesJson(period) {
    if (this.isGas) return '[]';
    let prices;
    if (period === 'next_hours') {
      prices = this.state && this.state.exportPricesNextHours;
    } else {
      const { start, end } = PriceCalculator.getPeriodRange(this.getUTCPeriods(), period);
      prices = PriceCalculator.selectExportPrices(this.prices, start, end);
    }
    return JSON.stringify((prices || []).map((p) => Math.round(p * 10000) / 10000));
  }

  async setPriceCapabilities() {
    const s = this.state;
    const next = s.pricesNextHours && s.pricesNextHours.length > 1 ? s.pricesNextHours[1] : null;
    await this.setCapability('measure_monetary.import', s.priceNow);
    await this.setCapability('measure_monetary.export', s.exportPriceNow);
    await this.setCapability('measure_monetary.next', next);
    await this.setCapability('measure_monetary.today_avg', s.priceThisDayAvg);
    await this.setCapability('measure_monetary.today_low', s.priceThisDayLowest);
    await this.setCapability('measure_monetary.today_high', s.priceThisDayHighest);
    await this.setCapability('measure_monetary.tomorrow_avg', s.priceNextDayAvg);
    await this.setCapability('measure_monetary.tomorrow_low', s.priceNextDayLowest);
    await this.setCapability('measure_monetary.tomorrow_high', s.priceNextDayHighest);
    await this.setCapability('measure_monetary.month_avg', s.priceThisMonthAvg);
    await this.setCapability('measure_monetary.last_month_avg', s.priceLastMonthAvg);
    await this.setCapability('hour_this_day_lowest', s.hourThisDayLowest);
    await this.setCapability('hour_this_day_highest', s.hourThisDayHighest);
    await this.setCapability('hour_next_day_lowest', s.hourNextDayLowest);
    await this.setCapability('hour_next_day_highest', s.hourNextDayHighest);
    const rank = (prices) => [...prices].sort((a, b) => a - b).findIndex((val) => val === s.priceNow) + 1;
    await this.setCapability('meter_rank_price_h0_this_day', rank(s.pricesThisDay));
    await this.setCapability('meter_rank_price_h0_next_8h', rank(s.pricesNext8h));
  }

  // The formula labels in the settings: the formula in use.
  async syncFormulaLabels() {
    const settings = this.getSettings();
    const labels = {
      formulaInUse: PriceFormula.formulaOf(settings, 'import'),
      export_formulaInUse: PriceFormula.formulaOf(settings, 'export'),
    };
    if (Object.keys(labels).some((id) => labels[id] !== settings[id])) await this.setSettings(labels);
  }

  // Throws a translated error when a formula or time of day markup in settings is invalid.
  validatePriceSettings(settings) {
    FORMULA_KEYS.forEach((id) => {
      const formula = String(settings[id] || '').trim();
      if (!formula) return;
      try {
        PriceFormula.validate(formula, id === 'export_formula' ? 'export' : 'import');
      } catch (err) {
        throw PriceSetup.translateError(this.homey, err);
      }
    });
    ['fixedMarkupTOD', 'export_fixedMarkupTOD'].forEach((id) => {
      try {
        PriceCalculator.parseTOD(settings[id]);
      } catch {
        throw Error(this.homey.__('price_setup.error_tod'));
      }
    });
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (['commodity', 'tariffType', 'biddingZone'].some((id) => changedKeys.includes(id))) {
      throw Error(this.homey.__('price_setup.error_use_repair'));
    }
    this.validatePriceSettings(newSettings);
    if (changedKeys.includes('priceInterval')) await this.resetPrices();
    return super.onSettings({ oldSettings, newSettings, changedKeys });
  }

  // Stored prices are of one zone and interval: cleared when either changes.
  async resetPrices() {
    this.prices = [{ time: null, price: null, muPrice: null }];
    this.marketPrices = [];
    this.rawCombinedPrices = [];
    this.rawMarketPrices = [];
    this.rawForecastPrices = [];
    this.priceHistory = [];
    for (const key of STORED_PRICES) await this.setStoreValue(key, []).catch((err) => this.error(err));
  }

  // New settings from the repair view (PriceSetup). A new market clears the prices; a new energy
  // type also changes the capabilities (migrate() at the restart).
  async applySetup(settings) {
    const old = this.getSettings();
    this.validatePriceSettings({ ...old, ...settings });
    const marketChanged = MARKET_KEYS.some((id) => settings[id] !== undefined && settings[id] !== old[id]);
    await this.setSettings(settings);
    this.settings = this.getSettings();
    if (marketChanged) {
      await this.resetPrices();
      this.migrated = false;
    }
    this.restartDevice(1000).catch((err) => this.error(err));
  }

  // Price settings changed by flow: recalculated right away, no restart.
  async updatePriceSettings(values) {
    const settings = { ...this.getSettings(), ...values };
    this.validatePriceSettings(settings);
    await this.setSettings({
      ...values,
      formulaInUse: PriceFormula.formulaOf(settings, 'import'),
      export_formulaInUse: PriceFormula.formulaOf(settings, 'export'),
    });
    this.settings = this.getSettings();
    if (this.rawCombinedPrices && this.rawCombinedPrices.length) {
      await this.storePrices(this.rawCombinedPrices, this.rawMarketPrices, this.rawForecastPrices);
      await this.setCapabilitiesAndFlows({ noTriggers: true });
    }
  }

}

module.exports = PriceDevice;
