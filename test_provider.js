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

    const providerIndex = await askQuestion('Select a provider (number): ');
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

    const prices = await provider.getPrices({
      biddingZone: zoneCode,
      dateStart: today,
      dateEnd: tomorrow,
    });

    console.log(`\nSuccess! Received ${prices.length} price entries.`);

    if (prices.length > 0) {
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
