/* eslint-disable no-console, no-process-exit */

'use strict';

const Entsoe = require('./lib/providers/Entsoe');
const EntsoeGruijter = require('./lib/providers/EntsoeGruijter');
const Stekker = require('./lib/providers/Stekker');
const Easyenergy = require('./lib/providers/Easyenergy');
const EEX = require('./lib/providers/EEX');

const providers = {
  ENTSOE: Entsoe,
  ENTSOE_GRUIJTER: EntsoeGruijter,
  STEKKER: Stekker,
  EASYENERGY: Easyenergy,
  EEX,
};

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node test_provider.js <Provider> <BiddingZone> [ApiKey]');
    console.log('       node test_provider.js <Provider> list');
    console.log('\nAvailable Providers:', Object.keys(providers).join(', '));
    process.exit(0);
  }

  const providerName = args[0];
  const ProviderClass = providers[providerName];

  if (!ProviderClass) {
    console.error(`Error: Provider '${providerName}' not found.`);
    console.log('Available Providers:', Object.keys(providers).join(', '));
    process.exit(1);
  }

  const apiKey = args[2] || process.env.ENTSOE_API_KEY || '';
  const provider = new ProviderClass({ apiKey });
  const zones = provider.getBiddingZones();

  if (args[1] === 'list') {
    console.log(`Available Bidding Zones for ${providerName}:`);
    Object.entries(zones).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
    process.exit(0);
  }

  let zoneCode = args[1];
  if (!zoneCode) {
    console.log('Usage: node test_provider.js <Provider> <BiddingZone> [ApiKey]');
    console.log('       node test_provider.js <Provider> list');
    process.exit(1);
  }

  // Check if the user provided a key (e.g. NL_Netherlands) instead of the code
  if (zones[zoneCode]) {
    zoneCode = zones[zoneCode];
  } else if (!Object.values(zones).includes(zoneCode)) {
    console.warn(`Warning: Zone '${zoneCode}' not found in known list for ${providerName}. Attempting to use it anyway.`);
  }

  console.log(`Fetching prices for ${providerName} - Zone: ${zoneCode}`);
  if (apiKey) console.log('Using provided API Key');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);

  try {
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
    console.error('\nError fetching prices:');
    console.error(error);
  }
}

main();
