'use strict';
// Auto-discovers every scenario folder under ../data/ (anything with a meta.json,
// hourly_14d.csv, high_res_24h.csv and weather_cache.json) and runs it through the REAL
// production pipeline (extractSlotSamples x2 + aggregateYieldFactors, exactly as
// drivers/solar/device.js's updateLearning() does it - see that file if this drifts).
//
// This is the regression/unit-test harness for SolarLearningStrategy.js: it doesn't assert
// pass/fail against a fixed "true" value (there IS no ground truth for real device data,
// only plausibility), it compares against a STORED BASELINE (../data/baseline.json) of what
// the algorithm previously produced for each scenario, so a code change that silently shifts
// real-scenario output gets caught even without knowing the "right" answer in advance.
//
// Usage:
//   node run_real_data_regression.js                 - run and diff against baseline.json
//   node run_real_data_regression.js --update-baseline - run and OVERWRITE baseline.json with
//                                                        current results (only do this after
//                                                        confirming a change is intentional and
//                                                        correct, not to silence a diff)
const fs = require('fs');
const path = require('path');
const SolarLearningStrategy = require('../../../lib/strategies/SolarLearningStrategy');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BASELINE_PATH = path.join(DATA_DIR, 'baseline.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const entries = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) entries.push({ t: parts[0], y: parseFloat(parts[1]) });
  }
  return entries;
}

function discoverScenarios() {
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(DATA_DIR, name, 'meta.json')))
    .sort();
}

function runScenario(name) {
  const dir = path.join(DATA_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const weatherEntries = JSON.parse(fs.readFileSync(path.join(dir, 'weather_cache.json'), 'utf8'));
  const hourlyPower = parseCSV(path.join(dir, 'hourly_14d.csv'));
  const highPower = parseCSV(path.join(dir, 'high_res_24h.csv'));

  const r1 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: hourlyPower, weatherEntries, resolution: 'hourly',
    peakPower: meta.peakPower, lat: meta.lat, lon: meta.lon, logger: () => {},
  });
  const r2 = SolarLearningStrategy.extractSlotSamples({
    powerEntries: highPower, weatherEntries, resolution: 'high',
    peakPower: meta.peakPower, lat: meta.lat, lon: meta.lon, logger: () => {},
  });
  const combined = r1.slotSamples.map((s, idx) => [...s, ...r2.slotSamples[idx]]);
  const res = SolarLearningStrategy.aggregateYieldFactors({
    combinedSlotSamples: combined, peakPower: meta.peakPower, logger: () => {},
  });
  const yf = res.yieldFactors.filter((y) => y !== null && y > 0);

  return {
    min: yf.length ? Number(Math.min(...yf).toFixed(3)) : null,
    max: yf.length ? Number(Math.max(...yf).toFixed(3)) : null,
    limit: Number(res.limit.toFixed(3)),
    slots: yf.length,
  };
}

const scenarios = discoverScenarios();
if (scenarios.length === 0) {
  console.log(`No scenarios found under ${DATA_DIR} (expected subfolders with a meta.json in each).`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {};
const results = {};
let anyDiff = false;

console.log(`Running ${scenarios.length} scenario(s) from ${DATA_DIR}\n`);
scenarios.forEach((name) => {
  let result;
  try {
    result = runScenario(name);
  } catch (e) {
    console.log(`[${name}] FAILED TO RUN: ${e.message}`);
    return;
  }
  results[name] = result;
  const prev = baseline[name];
  const line = `min=${result.min} max=${result.max} limit=${result.limit} slots=${result.slots}`;
  if (!prev) {
    console.log(`[${name}] ${line}  (no baseline yet)`);
  } else {
    const changed = prev.min !== result.min || prev.max !== result.max
      || prev.limit !== result.limit || prev.slots !== result.slots;
    if (changed) {
      anyDiff = true;
      console.log(`[${name}] CHANGED vs baseline:`);
      console.log(`    baseline: min=${prev.min} max=${prev.max} limit=${prev.limit} slots=${prev.slots}`);
      console.log(`    now:      ${line}`);
    } else {
      console.log(`[${name}] OK (matches baseline): ${line}`);
    }
  }
});

if (UPDATE_BASELINE) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nBaseline written to ${BASELINE_PATH}`);
} else if (anyDiff) {
  console.log('\nSome scenarios changed vs the stored baseline - investigate before assuming this '
    + 'is correct. If the change is intentional and verified, re-run with --update-baseline.');
  process.exitCode = 1;
} else if (Object.keys(baseline).length === 0) {
  console.log('\nNo baseline.json existed yet - re-run with --update-baseline to create one from '
    + 'these results (only after confirming they look right).');
}
