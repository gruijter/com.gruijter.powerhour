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
  variableChargePower = false,
  chargeMode = 'scheduled_price', // scheduled_price, solar_only, solar_and_grid, fast_charge, off
  tripOverrideDate = null, // YYYY-MM-DD
  tripOverrideTime = null, // HH:MM
  tripOverrideSoc = null, // %
}) => {
  const strategy = {};
  if (!prices || prices.length === 0) return strategy;

  const effectiveTargetSoc = typeof tripOverrideSoc === 'number' ? tripOverrideSoc : targetSoc;
  const kwhNeeded = Math.max(0, (effectiveTargetSoc - currentSoc) * (batCapacity / 100));
  const chargePerInterval = (chargePower / 1000) * (priceInterval / 60);

  // If off mode or no charge needed
  if (chargeMode === 'off' || kwhNeeded <= 0.01) {
    const accumulatedKwh = (currentSoc / 100) * batCapacity;
    prices.forEach((price, origIdx) => {
      const soc = Math.min(100, Math.round((accumulatedKwh / batCapacity) * 100));
      strategy[origIdx] = {
        power: 0,
        duration: 0,
        soc,
        price,
        exportPrice: price,
      };
    });
    return strategy;
  }

  // Fast charge mode: charge immediately at max power until target SoC is reached
  if (chargeMode === 'fast_charge') {
    let accumulatedKwh = (currentSoc / 100) * batCapacity;
    let kwhRemaining = kwhNeeded;

    prices.forEach((price, origIdx) => {
      let power = 0;
      let duration = 0;

      if (kwhRemaining > 0.01) {
        if (kwhRemaining < chargePerInterval) {
          const fraction = kwhRemaining / chargePerInterval;
          duration = Math.round(priceInterval * fraction);
          power = variableChargePower ? Math.round((kwhRemaining * 1000) / (priceInterval / 60)) : chargePower;
          accumulatedKwh += kwhRemaining;
          kwhRemaining = 0;
        } else {
          duration = priceInterval;
          power = chargePower;
          accumulatedKwh += chargePerInterval;
          kwhRemaining -= chargePerInterval;
        }
      }

      const soc = Math.min(100, Math.round((accumulatedKwh / batCapacity) * 100));
      strategy[origIdx] = {
        power,
        duration,
        soc,
        price,
        exportPrice: price,
      };
    });
    return strategy;
  }

  // Determine departure date and deadline
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  const effectiveDep = tripOverrideTime || departureTime;
  let hoursUntilDeparture;

  if (effectiveDep === 'indefinite') {
    // Indefinite: use maximum available price horizon (including forecasts)
    hoursUntilDeparture = Math.max(1, (prices.length * priceInterval) / 60);
  } else if (tripOverrideDate && tripOverrideTime) {
    const [depH, depM] = tripOverrideTime.split(':').map(Number);
    const depDate = new Date(`${tripOverrideDate}T${String(depH).padStart(2, '0')}:${String(depM).padStart(2, '0')}:00`);
    if (Number.isNaN(depDate.getTime())) {
      const fallbackDate = new Date(nowLocal);
      fallbackDate.setHours(depH, depM, 0, 0);
      if (fallbackDate <= nowLocal) fallbackDate.setDate(fallbackDate.getDate() + 1);
      hoursUntilDeparture = Math.max(0.1, (fallbackDate - nowLocal) / 3600000);
    } else {
      hoursUntilDeparture = Math.max(0.1, (depDate - nowLocal) / 3600000);
    }
  } else {
    const timeString = (effectiveDep && effectiveDep.includes(':')) ? effectiveDep : '08:00';
    const [depH, depM] = timeString.split(':').map(Number);
    const depDate = new Date(nowLocal);
    depDate.setHours(depH, depM, 0, 0);
    if (depDate <= nowLocal) {
      depDate.setDate(depDate.getDate() + 1);
    }
    hoursUntilDeparture = Math.max(0.1, (depDate - nowLocal) / 3600000);
  }

  const intervalsUntilDeparture = Math.ceil(hoursUntilDeparture * (60 / priceInterval));

  // Check if deadline is urgent (required charging time exceeds or equals hours remaining)
  const hoursNeeded = kwhNeeded / (chargePower / 1000);
  const isDeadlineUrgent = hoursNeeded >= hoursUntilDeparture;

  // If deadline is urgent, escalate to fast charge
  if (isDeadlineUrgent) {
    let accumulatedKwh = (currentSoc / 100) * batCapacity;
    let kwhRemaining = kwhNeeded;

    prices.forEach((price, origIdx) => {
      let power = 0;
      let duration = 0;

      if (kwhRemaining > 0.01) {
        if (kwhRemaining < chargePerInterval) {
          const fraction = kwhRemaining / chargePerInterval;
          duration = Math.round(priceInterval * fraction);
          power = variableChargePower ? Math.round((kwhRemaining * 1000) / (priceInterval / 60)) : chargePower;
          accumulatedKwh += kwhRemaining;
          kwhRemaining = 0;
        } else {
          duration = priceInterval;
          power = chargePower;
          accumulatedKwh += chargePerInterval;
          kwhRemaining -= chargePerInterval;
        }
      }

      const soc = Math.min(100, Math.round((accumulatedKwh / batCapacity) * 100));
      strategy[origIdx] = {
        power,
        duration,
        soc,
        price,
        exportPrice: price,
        urgent: true,
      };
    });
    return strategy;
  }

  // Standard Scheduled Price Slots or Solar+Grid strategy
  const maxIntervals = Math.min(prices.length, intervalsUntilDeparture);
  const validPrices = prices.slice(0, maxIntervals).map((price, idx) => ({ price, idx })).sort((a, b) => a.price - b.price);

  let kwhRemaining = kwhNeeded;
  const selectedIntervals = {};

  for (const slot of validPrices) {
    if (kwhRemaining <= 0.01) break;
    let duration = priceInterval;
    let kwhAdded = chargePerInterval;

    if (kwhRemaining < chargePerInterval) {
      kwhAdded = kwhRemaining;
      if (variableChargePower) {
        duration = priceInterval;
      } else {
        const fraction = kwhRemaining / chargePerInterval;
        duration = Math.round(priceInterval * fraction);
      }
    }

    selectedIntervals[slot.idx] = { duration, kwhAdded };
    kwhRemaining -= kwhAdded;
  }

  let accumulatedKwh = (currentSoc / 100) * batCapacity;

  prices.forEach((price, origIdx) => {
    let power = 0;
    let duration = 0;

    if (selectedIntervals[origIdx] && chargeMode !== 'solar_only') {
      if (variableChargePower) {
        power = Math.round((selectedIntervals[origIdx].kwhAdded * 1000) / (priceInterval / 60));
      } else {
        power = chargePower;
      }
      duration = selectedIntervals[origIdx].duration;
      accumulatedKwh += selectedIntervals[origIdx].kwhAdded;
    }

    const soc = Math.min(100, Math.round((accumulatedKwh / batCapacity) * 100));
    strategy[origIdx] = {
      power,
      duration,
      soc,
      price,
      exportPrice: price,
    };
  });

  return strategy;
};

module.exports = { getStrategy };
