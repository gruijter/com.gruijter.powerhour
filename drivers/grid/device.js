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

const GenericDevice = require('../../lib/genericDeviceDrivers/generic_sum_device');

const deviceSpecifics = {
  cmap: {
    this_hour: 'meter_kwh_this_hour',
    last_hour: 'meter_kwh_last_hour',
    this_day: 'meter_kwh_this_day',
    last_day: 'meter_kwh_last_day',
    this_month: 'meter_kwh_this_month',
    last_month: 'meter_kwh_last_month',
    this_year: 'meter_kwh_this_year',
    last_year: 'meter_kwh_last_year',
    meter_source: 'meter_power',
    measure_source: 'measure_watt_avg',
  },
};

class GridDevice extends GenericDevice {
  async onInit() {
    this.ds = deviceSpecifics;
    await super.onInit().catch(this.error);
  }

  async onSettings(opts) {
    if (opts.changedKeys.includes('export_tariff_update_group')) {
      this.driver.updateDeviceTariff(this);
    }
    return super.onSettings(opts);
  }

  async updateGridTariffs(currentTm) {
    try {
      if (!this.migrated || !this.tariffHistory) return;

      const s = this.getSettings();
      const purchaseGroup = s.tariff_update_group;
      const exportGroup = s.export_tariff_update_group || 0;

      const driverTariffs = this.driver.tariffs || {};
      let purchaseTariff = driverTariffs[purchaseGroup];
      if (purchaseTariff === undefined) purchaseTariff = this.tariffHistory.current;

      let exportTariff = driverTariffs[exportGroup];
      if (exportGroup === 0 || exportTariff === undefined) exportTariff = purchaseTariff;

      const tariffHistory = {
        previous: this.tariffHistory.current,
        previousExport: this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : this.tariffHistory.current,
        previousTm: this.tariffHistory.currentTm,
        current: purchaseTariff,
        currentExport: exportTariff,
        currentTm,
      };

      this.tariffHistory = tariffHistory;
      await this.setCapability('meter_tariff', purchaseTariff).catch(this.error);
      this.setSettings({ tariff: purchaseTariff }).catch(this.error);
      await this.setStoreValue('tariffHistory', tariffHistory);
    } catch (error) {
      this.error(error);
    }
  }

  async updateMoney({ ...reading }, { ...periods }) {
    let tariff = this.tariffHistory.current;
    let exportTariff = this.tariffHistory.currentExport !== undefined ? this.tariffHistory.currentExport : tariff;

    if (tariff !== this.getCapabilityValue('meter_tariff')) {
      await this.setCapability('meter_tariff', tariff).catch(this.error);
    }

    // Use previous hour tariff just after newHour if previous tariff is less than an hour old
    if (periods.newHour && this.tariffHistory && this.tariffHistory.previousTm
      && (new Date(reading.meterTm) - new Date(this.tariffHistory.previousTm))
      < (61 + (this.getSettings().wait_for_update || 0)) * 60 * 1000) {
      tariff = this.tariffHistory.previous;
      exportTariff = this.tariffHistory.previousExport !== undefined ? this.tariffHistory.previousExport : tariff;
    }

    // Decide which tariff to use based on live power or meter delta
    let activeTariff = tariff;
    const livePower = this.getCapabilityValue(this.ds.cmap.measure_source);

    if (typeof livePower === 'number') {
      activeTariff = livePower >= 0 ? tariff : exportTariff;
    } else {
      // fallback: check meter delta
      const deltaMeter = reading.meterValue - this.meterMoney.meterValue;
      activeTariff = deltaMeter >= 0 ? tariff : exportTariff;
    }

    // Calculate money
    const deltaMoney = (reading.meterValue - this.meterMoney.meterValue) * activeTariff;
    const meterMoney = {
      hour: this.meterMoney.hour + deltaMoney,
      day: this.meterMoney.day + deltaMoney,
      month: this.meterMoney.month + deltaMoney,
      year: this.meterMoney.year + deltaMoney,
      meterValue: reading.meterValue,
      lastHour: this.meterMoney.lastHour,
      lastDay: this.meterMoney.lastDay,
      lastMonth: this.meterMoney.lastMonth,
      lastYear: this.meterMoney.lastYear,
    };

    let fixedMarkup = 0;
    if (periods.newHour) {
      meterMoney.lastHour = meterMoney.hour;
      meterMoney.hour = 0;
      fixedMarkup += (this.getSettings().markup_hour || 0);
      await this.setCapability('meter_money_last_hour', meterMoney.lastHour);
      await this.setSettings({ meter_money_last_hour: meterMoney.lastHour }).catch(this.error);
    }
    if (periods.newDay) {
      meterMoney.lastDay = meterMoney.day;
      meterMoney.day = 0;
      fixedMarkup += (this.getSettings().markup_day || 0);
      await this.setCapability('meter_money_last_day', meterMoney.lastDay);
      await this.setSettings({ meter_money_last_day: meterMoney.lastDay }).catch(this.error);
    }
    if (periods.newMonth) {
      meterMoney.lastMonth = meterMoney.month;
      meterMoney.month = 0;
      fixedMarkup += (this.getSettings().markup_month || 0);
      await this.setCapability('meter_money_last_month', meterMoney.lastMonth);
      await this.setSettings({ meter_money_last_month: meterMoney.lastMonth }).catch(this.error);
    }
    if (periods.newYear) {
      meterMoney.lastYear = meterMoney.year;
      meterMoney.year = 0;
      await this.setCapability('meter_money_last_year', meterMoney.lastYear);
      await this.setSettings({ meter_money_last_year: meterMoney.lastYear }).catch(this.error);
    }

    // add fixed markups
    meterMoney.hour += fixedMarkup;
    meterMoney.day += fixedMarkup;
    meterMoney.month += fixedMarkup;
    meterMoney.year += fixedMarkup;

    // update money_this_x capabilities
    await this.setCapability('meter_money_this_hour', meterMoney.hour);
    await this.setCapability('meter_money_this_day', meterMoney.day);
    await this.setCapability('meter_money_this_month', meterMoney.month);
    await this.setCapability('meter_money_this_year', meterMoney.year);
    this.meterMoney = meterMoney;

    // Update settings every hour
    if (periods.newHour) {
      await this.setSettings({ meter_money_this_day: meterMoney.day }).catch(this.error);
      await this.setSettings({ meter_money_this_month: meterMoney.month }).catch(this.error);
      await this.setSettings({ meter_money_this_year: meterMoney.year }).catch(this.error);
    }
  }

  async addSourceCapGroup() {
    this.lastGroupMeterReady = false;
    this.lastGroupMeter = {}; // last values of capability meters

    const energyData = this.sourceDevice.energyObj || this.sourceDevice.energy;

    if (energyData && energyData.cumulative === true) {
      const importedCap = energyData.cumulativeImportedCapability || 'meter_power';
      const exportedCap = energyData.cumulativeExportedCapability;

      const group = {
        p1: null, p2: null, n1: null, n2: null,
      };

      if (this.sourceDevice.capabilities.includes(importedCap)) {
        group.p1 = importedCap;
      }

      if (exportedCap && this.sourceDevice.capabilities.includes(exportedCap)) {
        group.n1 = exportedCap;
      }

      if (group.p1 || group.n1) {
        this.sourceCapGroup = group;
        return;
      }
    }

    throw Error(`${this.sourceDevice.name} has no compatible grid capabilities defined in the energy object.`);
  }
}

module.exports = GridDevice;
