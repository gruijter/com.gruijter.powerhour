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

const TimeHelpers = require('./TimeHelpers');

class MeterHelpers {
  static monthStartDay(startDay, year, month) {
    return Math.min(startDay, new Date(year, month + 1, 0).getDate());
  }

  static periodStarts(dateLocal, startDay, startMonth) {
    const y = dateLocal.getFullYear();
    const m = dateLocal.getMonth();
    const start = (year, month) => new Date(year, month, MeterHelpers.monthStartDay(startDay, year, month));
    const month = dateLocal >= start(y, m) ? start(y, m) : start(m === 0 ? y - 1 : y, (m + 11) % 12);
    const year = dateLocal >= start(y, startMonth) ? start(y, startMonth) : start(y - 1, startMonth);
    return { month, year };
  }

  static getPeriods(currentReading, lastReadingHour, lastReadingDay, lastReadingMonth, lastReadingYear, startDay, startMonth) {
    const newHour = currentReading.hour !== lastReadingHour.hour;
    const newDay = (currentReading.day !== lastReadingDay.day);

    const ym = (year, month) => year * 12 + month;
    const starts = MeterHelpers.periodStarts(new Date(currentReading.year, currentReading.month, currentReading.day), startDay, startMonth);
    const day = MeterHelpers.monthStartDay(startDay, currentReading.year, currentReading.month);
    const newMonth = (newDay && (currentReading.day === day))
      || ym(starts.month.getFullYear(), starts.month.getMonth()) > ym(lastReadingMonth.year, lastReadingMonth.month);

    const newYear = (newMonth && starts.month.getTime() === starts.year.getTime())
      || ym(starts.year.getFullYear(), starts.year.getMonth()) > ym(lastReadingYear.year, lastReadingYear.month);

    return {
      newHour, newDay, newMonth, newYear,
    };
  }

  static keepPeriods(lastReadingMonth, lastReadingYear, dateLocal) {
    const now = { month: dateLocal.getMonth(), year: dateLocal.getFullYear() };
    return { month: { ...lastReadingMonth, ...now }, year: { ...lastReadingYear, ...now } };
  }

  static getReadingObject(value, date, timeZone) {
    const dateLocal = TimeHelpers.toLocalDate(date, timeZone);
    return {
      hour: dateLocal.getHours(),
      day: dateLocal.getDate(),
      month: dateLocal.getMonth(),
      year: dateLocal.getFullYear(),
      meterValue: value,
      meterTm: date,
    };
  }

  static calculateMoney(currentMoney, currentReading, tariff, deltaMoneyOverride) {
    let deltaMoney = 0;
    if (typeof deltaMoneyOverride === 'number') {
      deltaMoney = deltaMoneyOverride;
    } else if (typeof currentMoney.meterValue === 'number' && typeof currentReading.meterValue === 'number' && typeof tariff === 'number') {
      deltaMoney = (currentReading.meterValue - currentMoney.meterValue) * tariff;
    }

    const newMoney = {
      day: MeterHelpers.safeAdd(currentMoney.day, deltaMoney),
      month: MeterHelpers.safeAdd(currentMoney.month, deltaMoney),
      year: MeterHelpers.safeAdd(currentMoney.year, deltaMoney),
      meterValue: currentReading.meterValue,
      lastDay: currentMoney.lastDay,
      lastMonth: currentMoney.lastMonth,
      lastYear: currentMoney.lastYear,
    };
    if (currentMoney.hour !== undefined) {
      newMoney.hour = MeterHelpers.safeAdd(currentMoney.hour, deltaMoney);
      newMoney.lastHour = currentMoney.lastHour;
    }
    if (typeof currentMoney.contract === 'number') {
      newMoney.contract = MeterHelpers.safeAdd(currentMoney.contract, deltaMoney);
      newMoney.lastContract = currentMoney.lastContract;
    }
    return newMoney;
  }

  static getActiveTariff(settings, currentGridPower, tariff, exportTariff, deltaMeter) {
    const tariffType = settings?.tariff_type || 'dynamic';

    if (tariffType === 'import') return tariff;
    if (tariffType === 'export') return exportTariff;

    if (typeof deltaMeter === 'number' && deltaMeter < 0) return exportTariff;

    if (typeof currentGridPower === 'number') {
      return currentGridPower < 0 ? exportTariff : tariff;
    }
    return tariff;
  }

  static cumulativeReading(state, val, nowMs, holdMs = 15 * 60 * 1000) {
    const last = state && Number.isFinite(state.value) ? state.value : null;
    if (!Number.isFinite(val)) return { state, use: false, rebase: false };
    if (last === null || val >= last) return { state: { value: val, lowerSince: null }, use: true, rebase: false };
    const lowerSince = state && Number.isFinite(state.lowerSince) ? state.lowerSince : nowMs;
    if (nowMs - lowerSince >= holdMs) return { state: { value: val, lowerSince: null }, use: true, rebase: true };
    return { state: { value: last, lowerSince }, use: false, rebase: false };
  }

  static safeAdd(base, delta) {
    const b = (typeof base === 'number' && !Number.isNaN(base)) ? base : 0;
    return b + delta;
  }

  static getPeriodTariff(tariffHistory, priceInterval, currentTm, lastTm, defaultTariff, timeZone) {
    let tariff = defaultTariff ? defaultTariff.tariff : tariffHistory.current;
    let exportTariff = tariff;
    if (defaultTariff) {
      exportTariff = defaultTariff.exportTariff;
    } else if (typeof tariffHistory.currentExport === 'number') {
      exportTariff = tariffHistory.currentExport;
    }

    const startOfInterval = (tm) => TimeHelpers.startOfLocalBlock(tm, priceInterval, timeZone);
    const startOfCurrent = startOfInterval(currentTm);
    const newPricePeriod = startOfCurrent > startOfInterval(lastTm);

    if (newPricePeriod && tariffHistory.currentTm) {
      const tariffSetTm = new Date(tariffHistory.currentTm).getTime();
      if (tariffSetTm >= startOfCurrent) {
        tariff = typeof tariffHistory.previous === 'number' ? tariffHistory.previous : tariff;
        exportTariff = typeof tariffHistory.previousExport === 'number' ? tariffHistory.previousExport : exportTariff;
      }
    }
    return { tariff, exportTariff };
  }

  static startOfBlock(tm, minutes, timeZone) {
    return TimeHelpers.startOfLocalBlock(tm, minutes, timeZone);
  }

  static async sourceSwitched(device, storeKeys) {
    const s = device.getSettings();
    const key = JSON.stringify([s.source_device_type, s.homey_device_id, s.use_measure_source,
      ...storeKeys.map((k) => device.getStoreValue(k) || null)]);
    const bound = device.getStoreValue('meterSourceKey');
    if (bound === key) return false;
    await device.setStoreValue('meterSourceKey', key).catch((err) => device.error(err));
    return typeof bound === 'string';
  }

  static async shiftBaselines(device, delta) {
    for (const key of MeterHelpers.READING_KEYS) {
      if (device[key] && typeof device[key].meterValue === 'number') {
        device[key] = { ...device[key], meterValue: device[key].meterValue + delta };
        await device.setStoreValue(key, device[key]).catch((err) => device.error(err));
      }
    }
    if (device.meterMoney && typeof device.meterMoney.meterValue === 'number') device.meterMoney.meterValue += delta;
  }

}

MeterHelpers.READING_KEYS = ['lastReadingHour', 'lastReadingDay', 'lastReadingMonth', 'lastReadingYear', 'lastReadingContract'];

module.exports = MeterHelpers;
