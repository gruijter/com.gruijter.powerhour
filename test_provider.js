/* eslint-disable no-console */

'use strict';

/**
 * TIME HANDLING DOCUMENTATION
 *
 * Homey Environment (Intended Runtime):
 * - Homey runs its internal clock in UTC.
 * - `new Date()` returns the current time in UTC.
 * - Local time calculations (e.g. start of day) depend on the Homey's configured location/timezone.
 * - The app uses `TimeHelpers.getUTCPeriods(timeZone)` to calculate the UTC start/end timestamps
 *   for "Today", "Tomorrow", etc., from the Homey's location based local timezone.
 *
 * Test Environment (Laptop/PC):
 * - This script simulates the Homey environment.
 * - Since the laptop might be in a different timezone than the bidding zone being tested,
 *   we explicitly define the timezone for each bidding zone (`zoneTimezones`).
 * - We use `TimeHelpers.getUTCPeriods(zoneTimeZone)` to calculate the correct UTC query parameters
 *   for the APIs, ensuring that "Today" corresponds to the local day of the bidding zone,
 *   regardless of the laptop's system time.
 * - This ensures consistent testing of day boundaries and DST transitions across different regions.
 */

const readline = require('readline');
const fs = require('fs');
const Entsoe = require('./lib/providers/Entsoe');
const EntsoeGruijter = require('./lib/providers/EntsoeGruijter');
const Nordpool = require('./lib/providers/Nordpool');
const Stekker = require('./lib/providers/Stekker');
const Easyenergy = require('./lib/providers/Easyenergy');
const EEX = require('./lib/providers/EEX');
const TimeHelpers = require('./lib/TimeHelpers');

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

const zoneTimezones = {
  // WET / WEST
  '10YIE-1001A00010': 'Europe/Dublin',
  '10Y1001A1001A92E': 'Europe/London',
  '10YGB----------A': 'Europe/London',
  '10Y1001A1001A016': 'Europe/London',
  '10YPT-REN------W': 'Europe/Lisbon',

  // EET / EEST
  '10YFI-1--------U': 'Europe/Helsinki',
  '10Y1001A1001A39I': 'Europe/Tallinn',
  '10YLV-1001A00074': 'Europe/Riga',
  '10YLT-1001A0008Q': 'Europe/Vilnius',
  '10YRO-TEL------P': 'Europe/Bucharest',
  '10YCA-BULGARIA-R': 'Europe/Sofia',
  '10YGR-HTSO-----Y': 'Europe/Athens',
  '10YUA-WEPS-----0': 'Europe/Kiev',
  '10Y1001C--00003F': 'Europe/Kiev',
  '10Y1001C--000182': 'Europe/Kiev',
  '10Y1001A1001A869': 'Europe/Kiev',

  // Turkey
  '10YTR-TEIAS----W': 'Europe/Istanbul',

  // Gas
  NBP_EOD: 'Europe/London',
  NBP_EGSI: 'Europe/London',
  PVB_EOD: 'Europe/Madrid',
  PVB_EGSI: 'Europe/Madrid',
};

function getTimeZone(zoneCode) {
  return zoneTimezones[zoneCode] || 'Europe/Paris';
}

const printTable = (data) => {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const widths = headers.map((h) => Math.max(h.length, ...data.map((r) => String((r[h] !== undefined && r[h] !== null) ? r[h] : '').length)));
  const rowToString = (row) => headers.map((h, i) => String((row[h] !== undefined && row[h] !== null) ? row[h] : '').padEnd(widths[i])).join(' | ');
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  data.forEach((row) => console.log(rowToString(row)));
};

async function main() {
  try {
    // 1. Select Provider
    console.log('Available Providers:');
    const providerKeys = Object.keys(providers);
    providerKeys.forEach((key, index) => {
      console.log(`  ${index + 1}: ${key}`);
    });
    console.log(`  ${providerKeys.length + 1}: ALL POWER`);
    console.log(`  ${providerKeys.length + 2}: ALL GAS`);
    console.log(`  ${providerKeys.length + 3}: ALL POWER (Single Zone)`);

    const providerIndex = await askQuestion('Select a provider (number): ');
    const selection = parseInt(providerIndex, 10);

    if (selection === providerKeys.length + 1 || selection === providerKeys.length + 2) {
      const isGasTest = selection === providerKeys.length + 2;
      const providersToTest = isGasTest ? ['EASYENERGY', 'EEX'] : ['NORDPOOL', 'ENTSOE', 'ENTSOE_GRUIJTER', 'STEKKER'];

      if (!isGasTest) {
        // --- ALL POWER TEST (Per Bidding Zone) ---
        const allZones = {};
        // Collect all unique bidding zones from all power providers
        for (const name of providersToTest) {
          const ProviderClass = providers[name];
          if (ProviderClass) {
            const p = new ProviderClass({});
            Object.assign(allZones, p.getBiddingZones());
          }
        }

        const zoneKeys = Object.keys(allZones).sort();

        // eslint-disable-next-line no-restricted-syntax
        for (const zoneKey of zoneKeys) {
          const zoneCode = allZones[zoneKey];
          console.log(`\n--- Zone: ${zoneKey} (${zoneCode}) ---`);
          const results = [];
          const validData = [];

          // eslint-disable-next-line no-restricted-syntax
          for (const name of providersToTest) {
            // eslint-disable-next-line no-restricted-syntax
            for (const resolution of ['PT60M', 'PT15M']) {
              const ProviderClass = providers[name];
              if (!ProviderClass) continue;

              const resultRow = {
                Provider: name,
                Res: resolution,
                Pass: '?',
                Count: '-',
                First: '-',
                Last: '-',
                Interval: '-',
                Error: '',
              };

              try {
                // Check if provider supports this zone
                const tempProvider = new ProviderClass({});
                const supportedZones = tempProvider.getBiddingZones();
                if (!supportedZones[zoneKey]) {
                  resultRow.Pass = '-';
                  resultRow.Error = 'Not supported';
                  results.push(resultRow);
                  continue;
                }

                let apiKey = '';
                if (name === 'ENTSOE') apiKey = process.env.ENTSOE_API_KEY || '';
                if (name === 'ENTSOE_GRUIJTER') apiKey = process.env.ENTSOE_GRUIJTER_API_KEY || '';

                const provider = new ProviderClass({ apiKey });
                const timeZone = getTimeZone(zoneCode);
                const periods = TimeHelpers.getUTCPeriods(timeZone);
                const period = {
                  start: periods.todayStart,
                  end: new Date(periods.tomorrowStart.getTime() - 1),
                };

                // eslint-disable-next-line no-await-in-loop
                const prices = await provider.getPrices({
                  biddingZone: zoneCode,
                  dateStart: period.start,
                  dateEnd: period.end,
                  resolution,
                });

                if (!prices || prices.length === 0) {
                  resultRow.Pass = 'No';
                  resultRow.Error = 'No prices';
                  resultRow.Count = 0;
                } else {
                  prices.sort((a, b) => new Date(a.time) - new Date(b.time));
                  // Validity check
                  let consecutive = true;
                  const startTime = new Date(prices[0].time);
                  let intervalMs = 0;
                  let intervalMin = 0;
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
                      resultRow.Error = `Gap: ${previousTime.toISOString()} -> ${currentTime.toISOString()} (${diff / 60000}m)`;
                      break;
                    }
                    previousTime = currentTime;
                  }

                  resultRow.Pass = consecutive ? 'Yes' : 'No';
                  if (!consecutive && !resultRow.Error) resultRow.Error = 'Non-consecutive';

                  resultRow.Count = prices.length;
                  resultRow.First = `${prices[0].time.toISOString()} (${prices[0].price})`;
                  resultRow.Last = `${prices[prices.length - 1].time.toISOString()} (${prices[prices.length - 1].price})`;
                  resultRow.Interval = `${intervalMin}m`;

                  if (consecutive) {
                    validData.push({
                      name,
                      resolution,
                      prices,
                      firstTime: prices[0].time.getTime(),
                      firstPrice: prices[0].price,
                      lastTime: prices[prices.length - 1].time.getTime(),
                      lastPrice: prices[prices.length - 1].price,
                    });
                  }
                }
              } catch (err) {
                resultRow.Pass = 'No';
                resultRow.Error = err.message;
              }
              results.push(resultRow);
            }
          }

          // Compare results against reference (ENTSOE or first valid) per resolution
          for (const resolution of ['PT60M', 'PT15M']) {
            const validDataRes = validData.filter((d) => d.resolution === resolution);
            if (validDataRes.length > 1) {
              let ref = validDataRes.find((d) => d.name === 'ENTSOE');
              if (!ref) [ref] = validDataRes;

              for (const d of validDataRes) {
                if (d === ref) continue;
                const diffs = [];
                if (d.firstTime !== ref.firstTime) diffs.push('FirstTime');
                if (Math.abs(d.firstPrice - ref.firstPrice) > 0.01) diffs.push('FirstPrice');
                if (d.lastTime !== ref.lastTime) diffs.push('LastTime');
                if (Math.abs(d.lastPrice - ref.lastPrice) > 0.01) diffs.push('LastPrice');

                if (d.prices.length !== ref.prices.length) {
                  diffs.push(`Count(${d.prices.length}!=${ref.prices.length})`);
                } else {
                  let mismatches = 0;
                  for (let i = 0; i < d.prices.length; i += 1) {
                    if (Math.abs(d.prices[i].price - ref.prices[i].price) > 0.01) mismatches += 1;
                  }
                  if (mismatches > 0) diffs.push(`Mismatches(${mismatches})`);
                }

                if (diffs.length > 0) {
                  const row = results.find((r) => r.Provider === d.name && r.Res === d.resolution);
                  if (row) {
                    if (row.Error) row.Error += '; ';
                    row.Error += `Diff vs ${ref.name}: ${diffs.join(', ')}`;
                  }
                }
              }
            }
          }

          printTable(results);
        }
        return;
      }

      // --- ALL GAS TEST (Original Logic) ---
      const results = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const name of providersToTest) {
        const ProviderClass = providers[name];
        if (!ProviderClass) continue;
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

          const timeZone = getTimeZone(zoneCode);
          const periods = TimeHelpers.getUTCPeriods(timeZone);
          const period = {
            start: periods.todayStart,
            end: new Date(periods.tomorrowStart.getTime() - 1),
          };

          const isGas = name === 'EASYENERGY' || name === 'EEX';
          const resolution = isGas ? 'PT60M' : 'PT15M';

          // eslint-disable-next-line no-await-in-loop
          const prices = await provider.getPrices({
            biddingZone: zoneCode,
            dateStart: period.start,
            dateEnd: period.end,
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
                errorMsg = `Gap: ${previousTime.toISOString()} -> ${currentTime.toISOString()} (${diff / 60000}m)`;
                break;
              }
              previousTime = currentTime;
            }
            if (!consecutive && !errorMsg) {
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
      printTable(results);
      return;
    }

    if (selection === providerKeys.length + 3) {
      const providersToTest = ['NORDPOOL', 'ENTSOE', 'ENTSOE_GRUIJTER', 'STEKKER'];
      const allZones = {};
      // eslint-disable-next-line no-restricted-syntax
      for (const name of providersToTest) {
        const ProviderClass = providers[name];
        if (ProviderClass) {
          const p = new ProviderClass({});
          Object.assign(allZones, p.getBiddingZones());
        }
      }
      const zoneKeys = Object.keys(allZones).sort();
      zoneKeys.forEach((key, index) => {
        console.log(`  ${index + 1}: ${key}`);
      });

      const zoneIndex = await askQuestion('Select a zone (number): ');
      const zoneKey = zoneKeys[parseInt(zoneIndex, 10) - 1];

      if (!zoneKey) {
        console.error('Invalid zone selection');
        return;
      }

      const results = [];
      const validData = [];

      console.log(`\n--- Zone: ${zoneKey} ---`);

      // eslint-disable-next-line no-restricted-syntax
      for (const name of providersToTest) {
        // eslint-disable-next-line no-restricted-syntax
        for (const resolution of ['PT60M', 'PT15M']) {
          const ProviderClass = providers[name];
          if (!ProviderClass) continue;

          const resultRow = {
            Provider: name,
            Res: resolution,
            Pass: '?',
            Count: '-',
            First: '-',
            Last: '-',
            Interval: '-',
            Error: '',
          };

          try {
            const tempProvider = new ProviderClass({});
            const supportedZones = tempProvider.getBiddingZones();
            if (!supportedZones[zoneKey]) {
              resultRow.Pass = '-';
              resultRow.Error = 'Not supported';
              results.push(resultRow);
              continue;
            }
            const zoneCode = supportedZones[zoneKey];

            let apiKey = '';
            if (name === 'ENTSOE') apiKey = process.env.ENTSOE_API_KEY || '';
            if (name === 'ENTSOE_GRUIJTER') apiKey = process.env.ENTSOE_GRUIJTER_API_KEY || '';

            const provider = new ProviderClass({ apiKey });
            const timeZone = getTimeZone(zoneCode);
            const periods = TimeHelpers.getUTCPeriods(timeZone);
            const period = {
              start: periods.todayStart,
              end: new Date(periods.tomorrowStart.getTime() - 1),
            };

            // eslint-disable-next-line no-await-in-loop
            const prices = await provider.getPrices({
              biddingZone: zoneCode,
              dateStart: period.start,
              dateEnd: period.end,
              resolution,
            });

            if (!prices || prices.length === 0) {
              resultRow.Pass = 'No';
              resultRow.Error = 'No prices';
              resultRow.Count = 0;
            } else {
              prices.sort((a, b) => new Date(a.time) - new Date(b.time));
              let consecutive = true;
              const startTime = new Date(prices[0].time);
              let intervalMs = 0;
              let intervalMin = 0;
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
                  resultRow.Error = `Gap: ${previousTime.toISOString()} -> ${currentTime.toISOString()} (${diff / 60000}m)`;
                  break;
                }
                previousTime = currentTime;
              }

              resultRow.Pass = consecutive ? 'Yes' : 'No';
              if (!consecutive && !resultRow.Error) resultRow.Error = 'Non-consecutive';

              resultRow.Count = prices.length;
              resultRow.First = `${prices[0].time.toISOString()} (${prices[0].price})`;
              resultRow.Last = `${prices[prices.length - 1].time.toISOString()} (${prices[prices.length - 1].price})`;
              resultRow.Interval = `${intervalMin}m`;

              if (consecutive) {
                validData.push({
                  name,
                  resolution,
                  prices,
                  firstTime: prices[0].time.getTime(),
                  firstPrice: prices[0].price,
                  lastTime: prices[prices.length - 1].time.getTime(),
                  lastPrice: prices[prices.length - 1].price,
                });
              }
            }
          } catch (err) {
            resultRow.Pass = 'No';
            resultRow.Error = err.message;
          }
          results.push(resultRow);
        }
      }

      // Compare results against reference (ENTSOE or first valid) per resolution
      // eslint-disable-next-line no-restricted-syntax
      for (const resolution of ['PT60M', 'PT15M']) {
        const validDataRes = validData.filter((d) => d.resolution === resolution);
        if (validDataRes.length > 1) {
          let ref = validDataRes.find((d) => d.name === 'ENTSOE');
          if (!ref) [ref] = validDataRes;

          // eslint-disable-next-line no-restricted-syntax
          for (const d of validDataRes) {
            if (d === ref) continue;
            const diffs = [];
            if (d.firstTime !== ref.firstTime) diffs.push('FirstTime');
            if (Math.abs(d.firstPrice - ref.firstPrice) > 0.01) diffs.push('FirstPrice');
            if (d.lastTime !== ref.lastTime) diffs.push('LastTime');
            if (Math.abs(d.lastPrice - ref.lastPrice) > 0.01) diffs.push('LastPrice');

            if (d.prices.length !== ref.prices.length) {
              diffs.push(`Count(${d.prices.length}!=${ref.prices.length})`);
            } else {
              let mismatches = 0;
              for (let i = 0; i < d.prices.length; i += 1) {
                if (Math.abs(d.prices[i].price - ref.prices[i].price) > 0.01) mismatches += 1;
              }
              if (mismatches > 0) diffs.push(`Mismatches(${mismatches})`);
            }

            if (diffs.length > 0) {
              const row = results.find((r) => r.Provider === d.name && r.Res === d.resolution);
              if (row) {
                if (row.Error) row.Error += '; ';
                row.Error += `Diff vs ${ref.name}: ${diffs.join(', ')}`;
              }
            }
          }
        }
      }

      printTable(results);
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

    // 3. Loop through all zones, resolutions, days
    console.log(`\nTesting all zones for ${providerName}...`);
    const results = [];
    const zoneKeys = Object.keys(zones).sort();
    const resolutions = ['PT60M', 'PT30M', 'PT15M'];
    const days = ['Today', 'Tomorrow'];

    // eslint-disable-next-line no-restricted-syntax
    for (const zoneKey of zoneKeys) {
      const zoneCode = zones[zoneKey];
      // eslint-disable-next-line no-restricted-syntax
      for (const resolution of resolutions) {
        // eslint-disable-next-line no-restricted-syntax
        for (const day of days) {
          const resultRow = {
            Zone: zoneKey,
            Res: resolution,
            Day: day,
            Pass: '?',
            Count: '-',
            First: '-',
            Last: '-',
            Error: '',
          };

          try {
            const timeZone = getTimeZone(zoneCode);
            const periods = TimeHelpers.getUTCPeriods(timeZone);
            const period = {
              start: day === 'Tomorrow' ? periods.tomorrowStart : periods.todayStart,
              end: day === 'Tomorrow' ? new Date(periods.tomorrowEnd.getTime() - 1) : new Date(periods.tomorrowStart.getTime() - 1),
            };

            // eslint-disable-next-line no-await-in-loop
            const prices = await provider.getPrices({
              biddingZone: zoneCode,
              dateStart: period.start,
              dateEnd: period.end,
              resolution,
            });

            if (!prices || prices.length === 0) {
              resultRow.Pass = 'No';
              resultRow.Error = 'No prices';
            } else {
              prices.sort((a, b) => new Date(a.time) - new Date(b.time));
              let consecutive = true;
              const startTime = new Date(prices[0].time);
              let intervalMs = 0;
              if (prices.length > 1) {
                intervalMs = new Date(prices[1].time) - startTime;
              }

              let previousTime = startTime;
              for (let i = 1; i < prices.length; i += 1) {
                const currentTime = new Date(prices[i].time);
                const diff = currentTime - previousTime;
                if (diff !== intervalMs) {
                  consecutive = false;
                  resultRow.Error = `Gap: ${previousTime.toISOString()} -> ${currentTime.toISOString()} (${diff / 60000}m)`;
                  break;
                }
                previousTime = currentTime;
              }

              resultRow.Pass = consecutive ? 'Yes' : 'No';
              if (!consecutive && !resultRow.Error) resultRow.Error = 'Non-consecutive';

              resultRow.Count = prices.length;
              resultRow.First = `${prices[0].time.toISOString().split('T')[1].slice(0, 5)} (${prices[0].price})`;
              resultRow.Last = `${prices[prices.length - 1].time.toISOString().split('T')[1].slice(0, 5)} (${prices[prices.length - 1].price})`;
            }
          } catch (err) {
            resultRow.Pass = 'No';
            resultRow.Error = err.message;
          }
          results.push(resultRow);

          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    printTable(results);
  } catch (error) {
    console.error('\nError:');
    console.error(error);
  } finally {
    rl.close();
  }
}

main();
