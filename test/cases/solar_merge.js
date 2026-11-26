/* eslint-disable no-console */

'use strict';

const assert = require('assert');
const { mergeYields } = require('../../lib/strategies/SolarLearningStrategy');

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
};

const fill = (v) => new Array(96).fill(v);

test('merge: slot with samples but zero confidence still moves toward the fresh value', () => {
  const { yieldFactors } = mergeYields({
    historicYields: fill(4), previousYields: fill(2), trainingConfidence: fill(0), sampleCounts: fill(6),
  });
  assert.ok(Math.abs(yieldFactors[40] - 2.6) < 1e-9);
});

test('merge: slot without samples halves, then reaches zero', () => {
  let y = fill(0);
  y[30] = 12;
  const counts = fill(0);
  counts[50] = 4;
  for (let n = 0; n < 12; n += 1) {
    y = mergeYields({
      historicYields: fill(0), previousYields: y, trainingConfidence: fill(0), sampleCounts: counts,
    }).yieldFactors;
    if (n === 0) assert.strictEqual(y[30], 6);
  }
  assert.strictEqual(y[30], 0);
});

test('merge: retrain without any sample keeps all factors', () => {
  const { yieldFactors } = mergeYields({
    historicYields: fill(null), previousYields: fill(5), trainingConfidence: fill(0), sampleCounts: fill(0),
  });
  assert.strictEqual(yieldFactors[30], 5);
});

test('merge: confident slot keeps the confidence-scaled alpha', () => {
  const { yieldFactors } = mergeYields({
    historicYields: fill(4), previousYields: fill(2), trainingConfidence: fill(100), sampleCounts: fill(6),
  });
  assert.ok(Math.abs(yieldFactors[40] - 3.4) < 1e-9);
});

test('merge: without sample counts the old behaviour stays', () => {
  const { yieldFactors } = mergeYields({ historicYields: fill(4), previousYields: fill(2), trainingConfidence: fill(0) });
  assert.strictEqual(yieldFactors[40], 2);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
