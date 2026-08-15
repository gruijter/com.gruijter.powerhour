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

// returns the best trading strategy for the first hour: sell = -1 | hold = 0 | buy = 1
const getStrategy = ({
  prices, // array of hourly prices, e.g. [0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
  exportPrices = null, // array of hourly feed-in prices. Falls back to prices if missing
  priceInterval = 60, // price interval in minutes
  minPriceDelta = 0.1, // minimum price difference from highest or lowest price to sell/buy
  soc = 0, // Battery State of Charge at start of first hour in %
  batCapacity = 5.05, // in kWh
  chargePower = 2000, // in Watt
  dischargePower = 1700, // in Watt
}) => {
  if (!prices || prices.length === 0) return 0;

  // Support up to 48 hours of future price lookahead
  const intervalsPerHour = 60 / priceInterval;
  const maxInputSlots = Math.ceil(48 * intervalsPerHour);
  const prcs = prices.slice(0, maxInputSlots);
  const expPrcs = (exportPrices && exportPrices.length > 0) ? exportPrices.slice(0, maxInputSlots) : prcs;

  // 1. Zero-Delta Early Exit:
  const minBuyPrice = Math.min(...prcs);
  const maxExportPrice = Math.max(...expPrcs);
  if (soc <= 0.1 && (maxExportPrice - minBuyPrice) < minPriceDelta) {
    return 0;
  }

  // 2. Find peaks and troughs (top/bottom third of prices)
  const sortedPrices = [...prcs].sort((a, b) => b - a);
  const peaks = sortedPrices.slice(0, Math.ceil(prcs.length / 3)).reverse();
  const troughs = [...sortedPrices].reverse().slice(0, Math.ceil(prcs.length / 3)).reverse();

  // 3. Limit search to the first 10 peaks/troughs that have minimum delta
  const candidates = [];
  prcs.forEach((price, idx) => {
    const futureMin = Math.min(...prcs.slice(idx));
    const futureMax = Math.max(...expPrcs.slice(idx));
    const isPeak = price >= peaks[0] && (price - futureMin) > minPriceDelta * 0.5; // promiscuous selling
    const isTrough = price <= troughs[0] && (futureMax - price) > minPriceDelta;
    if (isPeak || isTrough) {
      candidates.push({
        idx,
        price,
        exportPrice: expPrcs[idx] !== undefined ? expPrcs[idx] : price,
        isPeak,
        isTrough,
      });
    }
  });

  const peakCandidates = candidates.slice(0, 10);
  if (peakCandidates.length === 0 || peakCandidates[0].idx !== 0) return 0; // return Hold if first period is not a peak/trough candidate

  const durationHours = priceInterval / 60;
  const chargeSpeed = (chargePower / (batCapacity * 10)) * durationHours; // % per period
  const dischargeSpeed = (dischargePower / (batCapacity * 10)) * durationHours; // % per period
  const batCapPerc = batCapacity / 100;
  const avgPrice = prcs.reduce((a, b) => a + b, 0) / prcs.length;

  let bestProfit = -Infinity;
  let bestFirstAction = 0;

  // 4. Directionally-pruned recursive search without JSON clone overhead
  const search = (candIdx, currentSoc, currentProfit, firstAction) => {
    if (candIdx >= peakCandidates.length) {
      const socValue = currentSoc * batCapPerc * avgPrice;
      const totalScore = currentProfit + socValue;
      if (totalScore > bestProfit) {
        bestProfit = totalScore;
        bestFirstAction = firstAction;
      }
      return;
    }

    const cand = peakCandidates[candIdx];
    const isFirst = candIdx === 0;

    // Standard strategy: Hold (0)
    search(candIdx + 1, currentSoc, currentProfit, isFirst ? 0 : firstAction);

    // Sell (-1): Only if candidate is a peak and battery has SoC
    if (cand.isPeak && currentSoc > 0.1) {
      const sellingPercent = Math.min(currentSoc, dischargeSpeed);
      const profitGain = sellingPercent * batCapPerc * cand.exportPrice;
      search(candIdx + 1, currentSoc - sellingPercent, currentProfit + profitGain, isFirst ? -1 : firstAction);
    }

    // Buy (1): Only if candidate is a trough and battery has room
    if (cand.isTrough && currentSoc < 99.9) {
      const buyingPercent = Math.min(100 - currentSoc, chargeSpeed);
      const profitCost = buyingPercent * batCapPerc * cand.price;
      search(candIdx + 1, currentSoc + buyingPercent, currentProfit - profitCost, isFirst ? 1 : firstAction);
    }
  };

  search(0, soc, 0, 0);
  return bestFirstAction;
};

module.exports = {
  getStrategy,
};
