/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const Entsoe = require('./lib/providers/Entsoe');

// Load env.json if available
try {
  const env = JSON.parse(fs.readFileSync('./env.json'));
  Object.assign(process.env, env);
} catch (err) {
  // ignore
}

async function run() {
  const apiKey = process.env.ENTSOE_API_KEY;
  if (!apiKey) {
    console.error('Please set ENTSOE_API_KEY in env.json or environment variables.');
    return;
  }

  const provider = new Entsoe({ apiKey });
  const zone = '10Y1001C--000182'; // UA_Ukaine_IPS

  // Define "Today" in local time (as the app does)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);

  console.log(`\n--- Debugging Ukraine (${zone}) ---`);
  console.log(`Local Request Start: ${today.toString()}`);
  console.log(`Local Request End:   ${tomorrow.toString()}`);
  console.log(`UTC Request Start:   ${today.toISOString()}`);
  console.log(`UTC Request End:     ${tomorrow.toISOString()}`);

  try {
    // 1. Fetch prices using the standard method
    const prices = await provider.getPrices({
      biddingZone: zone,
      dateStart: today,
      dateEnd: tomorrow,
      resolution: 'PT60M',
    });

    console.log(`\nFetched ${prices.length} prices.`);
    if (prices.length > 0) {
      console.log(`First: ${prices[0].time.toISOString()} (${prices[0].price})`);
      console.log(`Last:  ${prices[prices.length - 1].time.toISOString()} (${prices[prices.length - 1].price})`);
      
      // Check for gaps
      let missing = 0;
      for (let i = 1; i < prices.length; i++) {
        const diff = prices[i].time - prices[i-1].time;
        if (diff > 3600000) {
            console.log(`GAP detected between ${prices[i-1].time.toISOString()} and ${prices[i].time.toISOString()}`);
            missing++;
        }
      }
      if (missing === 0) console.log('No internal gaps detected.');
    }

    // 2. Analyze the "Missing Hour" hypothesis
    const lastTime = prices[prices.length - 1].time;
    const expectedEnd = new Date(tomorrow);
    // The app requests until end of day, so we expect data up to the last hour
    // If request is 23:00 UTC -> 23:00 UTC, last hour starts at 22:00 UTC.
    
    console.log('\nAnalysis:');
    if (prices.length === 23) {
        console.log('Result: 23 items found.');
        const lastHourUTC = lastTime.getUTCHours();
        console.log(`Last data point is at ${lastHourUTC}:00 UTC.`);
        
        if (lastHourUTC === 21) {
            console.log('CONFIRMED: Data ends at 21:00 UTC (22:00 UTC end of interval).');
            console.log('This corresponds to 00:00 EET (Ukraine midnight).');
            console.log('The requested 22:00-23:00 UTC interval (00:00-01:00 EET next day) is missing.');
            console.log('Cause: "Tomorrow" prices for Ukraine are likely not yet published.');
        }
    }

  } catch (err) {
    console.error('Error:', err.message);
    if (provider.lastResponse) {
        console.log('Last Response (partial):', String(provider.lastResponse).slice(0, 500));
    }
  }
}

run();
