/* eslint-disable no-console */

'use strict';

/* Offline unit tests: runs every test/cases/*.js in its own process.
   `node test/run.js` runs all, `node test/run.js battery` only files matching 'battery'. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, 'cases');
const filter = process.argv[2];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && (!filter || f.includes(filter))).sort();

const failures = [];
files.forEach((file) => {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ['--expose-gc', path.join(DIR, file)], { encoding: 'utf8' });
  const ok = res.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file} (${Date.now() - t0} ms)`);
  if (!ok) {
    failures.push(file);
    const tail = `${res.stdout}${res.stderr}`.trim().split('\n').slice(-20);
    console.log(tail.map((l) => `      ${l}`).join('\n'));
  }
});

console.log(`\n${files.length - failures.length}/${files.length} passed${failures.length ? `, failed: ${failures.join(', ')}` : ''}`);
process.exitCode = failures.length ? 1 : 0;
