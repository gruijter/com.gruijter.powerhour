/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)
*/

'use strict';

const getStrategy = ({
  prices,
  priceInterval = 60,
  chargePower = 11000, // W
  currentSoc = 0, // %
  targetSoc = 100, // %
  batCapacity = 50, // kWh
  departureTime = '08:00', // HH:MM
  timezone = 'UTC',
}) => {
  const strategy = {};
  if (!prices || prices.length === 0) return strategy;

  // Calculate kWh needed
  const kwhNeeded = Math.max(0, (targetSoc - currentSoc) * (batCapacity / 100));
  const chargePerInterval = (chargePower / 1000) * (priceInterval / 60); // kWh per slot

  // Determine deadline index
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  const [depH, depM] = departureTime.split(':').map(Number);
  const depDate = new Date(nowLocal);
  depDate.setHours(depH, depM, 0, 0);
  if (depDate <= nowLocal) {
    depDate.setDate(depDate.getDate() + 1);
  }

  const hoursUntilDeparture = (depDate - nowLocal) / 3600000;
  const intervalsUntilDeparture = Math.ceil(hoursUntilDeparture * (60 / priceInterval));

  // Only consider prices before departure
  const maxIntervals = Math.min(prices.length, intervalsUntilDeparture);
  const validPrices = prices.slice(0, maxIntervals).map((price, idx) => ({ price, idx })).sort((a, b) => a.price - b.price);

  let kwhRemaining = kwhNeeded;
  const selectedIntervals = {};

  for (const slot of validPrices) {
    if (kwhRemaining <= 0.01) break;
    let duration = priceInterval;
    let kwhAdded = chargePerInterval;

    if (kwhRemaining < chargePerInterval) {
      const fraction = kwhRemaining / chargePerInterval;
      duration = Math.round(priceInterval * fraction);
      kwhAdded = kwhRemaining;
    }

    selectedIntervals[slot.idx] = { duration, kwhAdded };
    kwhRemaining -= kwhAdded;
  }

  let accumulatedKwh = (currentSoc / 100) * batCapacity;

  prices.forEach((price, origIdx) => {
    let power = 0;
    let duration = 0;

    if (selectedIntervals[origIdx]) {
      power = chargePower;
      duration = selectedIntervals[origIdx].duration;
      accumulatedKwh += selectedIntervals[origIdx].kwhAdded;
    }

    const soc = Math.min(100, Math.round((accumulatedKwh / batCapacity) * 100));
    strategy[origIdx] = {
      power, duration, soc, price, exportPrice: price,
    };
  });

  return strategy;
};

module.exports = { getStrategy };
