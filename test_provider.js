/* eslint-disable no-console */

'use strict';

const readline = require('readline');
const fs = require('fs');
const Entsoe = require('./lib/providers/Entsoe');
const EntsoeGruijter = require('./lib/providers/EntsoeGruijter');
const Nordpool = require('./lib/providers/Nordpool');
const Stekker = require('./lib/providers/Stekker');
const Easyenergy = require('./lib/providers/Easyenergy');
const EEX = require('./lib/providers/EEX');

const providers = {
  ENTSOE: Entsoe,
  ENTSOE_GRUIJTER: EntsoeGruijter,
  NORDPOOL: Nordpool,
  STEKKER: Stekker,
  EASYENERGY: Easyenergy,
  EEX,
};

// Load env.json if available
try {
  const env = JSON.parse(fs.readFileSync('./env.json'));
  Object.assign(process.env, env);
} catch (err) {
  // ignore
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, (ans) => {
    resolve(ans);
  }));
}

async function main() {
  try {
    // 1. Select Provider
    console.log('Available Providers:');
    const providerKeys = Object.keys(providers);
    providerKeys.forEach((key, index) => {
      console.log(`  ${index + 1}: ${key}`);
    });
    console.log(`  ${providerKeys.length + 1}: ALL`);

    const providerIndex = await askQuestion('Select a provider (number): ');

    if (parseInt(providerIndex, 10) === providerKeys.length + 1) {
      const results = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const [name, ProviderClass] of Object.entries(providers)) {
        try {
          let apiKey = '';
          if (name === 'ENTSOE') apiKey = process.env.ENTSOE_API_KEY || '';
          if (name === 'ENTSOE_GRUIJTER') apiKey = process.env.ENTSOE_GRUIJTER_API_KEY || '';

          const provider = new ProviderClass({ apiKey });
          const zones = provider.getBiddingZones();
          const zoneKeys = Object.keys(zones);
          // prefer NL, else first
          let selectedZoneKey = zoneKeys.find((k) => k.includes('NL'));
          if (!selectedZoneKey) [selectedZoneKey] = zoneKeys;
          const zoneCode = zones[selectedZoneKey];

          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const tomorrow = new Date(today);
          tomorrow.setDate(today.getDate() + 1);
          tomorrow.setHours(23, 59, 59, 999);

          const isGas = name === 'EASYENERGY' || name === 'EEX';
          const resolution = isGas ? 'PT60M' : 'PT15M';

          // eslint-disable-next-line no-await-in-loop
          const prices = await provider.getPrices({
            biddingZone: zoneCode,
            dateStart: today,
            dateEnd: tomorrow,
            resolution,
          });

          let pass = 'Yes';
          let errorMsg = '';
          let intervalMin = '-';

          if (!prices || prices.length === 0) {
            pass = 'No';
            errorMsg = 'No prices';
          } else {
            // Validity check
            let consecutive = true;
            const startTime = new Date(prices[0].time);
            let intervalMs = 0;
            if (prices.length > 1) {
              intervalMs = new Date(prices[1].time) - startTime;
              intervalMin = intervalMs / 60000;
            }
            let previousTime = startTime;
            for (let i = 1; i < prices.length; i += 1) {
              const currentTime = new Date(prices[i].time);
              const diff = currentTime - previousTime;
              if (diff !== intervalMs) {
                consecutive = false;
                break;
              }
              previousTime = currentTime;
            }
            if (!consecutive) {
              pass = 'No';
              errorMsg = 'Non-consecutive';
            }
          }

          results.push({
            Provider: name,
            Pass: pass,
            First: prices && prices.length > 0 ? `${prices[0].time.toISOString()} (${prices[0].price})` : '-',
            Last: prices && prices.length > 0 ? `${prices[prices.length - 1].time.toISOString()} (${prices[prices.length - 1].price})` : '-',
            Interval: `${intervalMin}m`,
            Error: errorMsg,
          });
        } catch (err) {
          console.error(`Error testing ${name}:`, err.message);
          results.push({
            Provider: name,
            Pass: 'No',
            First: '-',
            Last: '-',
            Interval: '-',
            Error: err.message,
          });
        }
      }
      console.table(results);
      return;
    }

    const providerName = providerKeys[parseInt(providerIndex, 10) - 1];

    if (!providerName) {
      console.error('Invalid provider selection.');
      return;
    }

    const ProviderClass = providers[providerName];
    console.log(`You selected: ${providerName}`);

    // 2. Potentially ask for API key
    let apiKey = '';
    if (providerName === 'ENTSOE') {
      apiKey = await askQuestion(`Enter API Key for ${providerName} (or press Enter to use environment variable ENTSOE_API_KEY): `);
      if (!apiKey) apiKey = process.env.ENTSOE_API_KEY || '';
      if (!apiKey) throw new Error('API Key is required for ENTSOE');
    } else if (providerName === 'ENTSOE_GRUIJTER') {
      apiKey = await askQuestion(`Enter API Key for ${providerName} (or press Enter to use environment variable ENTSOE_GRUIJTER_API_KEY): `);
      if (!apiKey) apiKey = process.env.ENTSOE_GRUIJTER_API_KEY || '';
    }

    const provider = new ProviderClass({ apiKey });
    const zones = provider.getBiddingZones();

    // 3. Select Bidding Zone
    console.log(`\nAvailable Bidding Zones for ${providerName}:`);
    const zoneKeys = Object.keys(zones);
    zoneKeys.forEach((key, index) => {
      console.log(`  ${index + 1}: ${key} (${zones[key]})`);
    });

    const zoneIndex = await askQuestion('Select a bidding zone (number): ');
    const selectedZoneKey = zoneKeys[parseInt(zoneIndex, 10) - 1];

    if (!selectedZoneKey) {
      console.error('Invalid zone selection.');
      return;
    }

    const zoneCode = zones[selectedZoneKey];
    console.log(`You selected: ${selectedZoneKey}`);

    // 4. Fetch prices
    console.log(`\nFetching prices for ${providerName} - Zone: ${zoneCode}`);
    if (apiKey) console.log('Using provided API Key');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);

    const isGas = providerName === 'EASYENERGY' || providerName === 'EEX';
    const resolution = isGas ? 'PT60M' : 'PT15M';

    const prices = await provider.getPrices({
      biddingZone: zoneCode,
      dateStart: today,
      dateEnd: tomorrow,
      resolution,
    });

    console.log(`\nSuccess! Received ${prices.length} price entries.`);

    if (prices.length > 0) {
      // Validity check similar to generic_dap_device
      let consecutive = true;
      const startTime = new Date(prices[0].time);
      let intervalMs = 0;

      if (prices.length > 1) {
        intervalMs = new Date(prices[1].time) - startTime;
        console.log(`Detected interval: ${intervalMs / 60000} minutes`);
      }

      let previousTime = startTime;
      for (let i = 1; i < prices.length; i += 1) {
        const currentTime = new Date(prices[i].time);
        const diff = currentTime - previousTime;
        if (diff !== intervalMs) {
          consecutive = false;
          console.error(`Validity Error: Non-consecutive prices at index ${i}`);
          console.error(`  Previous: ${previousTime.toISOString()}`);
          console.error(`  Current:  ${currentTime.toISOString()}`);
          console.error(`  Diff:     ${diff / 60000} min (Expected: ${intervalMs / 60000} min)`);
          break;
        }
        previousTime = currentTime;
      }

      if (consecutive) {
        console.log('Validity Check: PASSED (Prices are consecutive)');
      } else {
        console.log('Validity Check: FAILED');
      }

      console.log('\nFirst 3 entries:');
      prices.slice(0, 3).forEach((p) => console.log(`  ${p.time.toISOString()}: ${p.price}`));

      console.log('\nLast 3 entries:');
      prices.slice(-3).forEach((p) => console.log(`  ${p.time.toISOString()}: ${p.price}`));
    } else {
      console.log('No prices returned for this period.');
    }
  } catch (error) {
    console.error('\nError:');
    console.error(error);
  } finally {
    rl.close();
  }
}

main();
