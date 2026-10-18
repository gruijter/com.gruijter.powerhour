'use strict';

const assert = require('assert');
const { getStrategy } = require('../../lib/strategies/NomXomStrategy');

class MockDevice {
  constructor(id, soc, {
    max = 2000, eff = null, active = 0, reserve = 0,
  } = {}) {
    this.id = id;
    this.soc = soc;
    this.settings = { chargePower: max, dischargePower: max };
    // Losses as the setting defaults: the efficient speed is the slower one.
    if (eff) {
      Object.assign(this.settings, {
        chargeLoss: 10, chargePowerEff: eff, chargeLossEff: 5, dischargeLoss: 8, dischargePowerEff: eff, dischargeLossEff: 4,
      });
    }
    this.xomTargetPower = active;
    this.reserve = reserve;
  }

  getData() {
    return { id: this.id };
  }

  getName() {
    return this.id;
  }

  getSettings() {
    return this.settings;
  }

  getCapabilityValue() {
    return this.xomTargetPower;
  }

  reservePct() {
    return this.reserve;
  }
}

const run = (devices, cumulativePower, o = {}) => Object.fromEntries(
  getStrategy({ devices, cumulativePower, ...o }).map((s) => [s.id, Math.round(s.target * 100) / 100]),
);
const sum = (r) => Object.values(r).reduce((a, b) => a + b, 0);
const equal3 = () => [new MockDevice('a', 80), new MockDevice('b', 80), new MockDevice('c', 80)];

// Fewest batteries that can take the load
let r = run(equal3(), 1000);
assert.deepStrictEqual(r, { a: -1000, b: 0, c: 0 }, `1000 W on one battery ${JSON.stringify(r)}`);
r = run(equal3(), 120);
assert.deepStrictEqual(r, { a: -120, b: 0, c: 0 }, 'small load on one battery');
r = run(equal3(), 2100);
assert.deepStrictEqual(r, { a: -1050, b: -1050, c: 0 }, 'over one battery max: two, split by SoC');
r = run(equal3(), 5000);
assert.ok(Object.values(r).every((t) => Math.abs(t + 1666.67) < 0.01), `huge load: all three ${JSON.stringify(r)}`);
r = run([new MockDevice('a', 90), new MockDevice('b', 90), new MockDevice('tiny', 90, { max: 100 })], 1000);
assert.deepStrictEqual(r, { a: -1000, b: 0, tiny: 0 }, 'small battery not needed');
console.log('ok   fewest batteries');

// Priority by SoC: discharge the fullest, charge the emptiest
const mixed = () => [new MockDevice('hi', 90), new MockDevice('mid', 50), new MockDevice('lo', 20)];
r = run(mixed(), 1000);
assert.deepStrictEqual(r, { hi: -1000, mid: 0, lo: 0 }, 'discharge: highest SoC');
r = run(mixed(), 3000);
assert.deepStrictEqual(r, { hi: -1928.57, mid: -1071.43, lo: 0 }, 'two batteries weighted by SoC');
r = run(mixed(), -1000);
assert.deepStrictEqual(r, { hi: 0, mid: 0, lo: 1000 }, 'charge: lowest SoC');
console.log('ok   SoC priority');

// Efficient power: more batteries rather than one above it
r = run([new MockDevice('a', 80, { eff: 800 }), new MockDevice('b', 80, { eff: 800 })], 1000);
assert.deepStrictEqual(r, { a: -500, b: -500 }, `above efficient power: split ${JSON.stringify(r)}`);
r = run([new MockDevice('a', 80, { eff: 800 }), new MockDevice('b', 80, { eff: 800 })], 600);
assert.deepStrictEqual(r, { a: -600, b: 0 }, 'within efficient power: one');
console.log('ok   efficient power');

// Hysteresis: the active battery keeps the load against a slightly fuller one (+20% SoC bonus)
r = run([new MockDevice('full', 80), new MockDevice('busy', 70, { active: -500 })], 500);
assert.deepStrictEqual(r, { full: 0, busy: -1000 }, `active battery keeps discharging ${JSON.stringify(r)}`);
r = run([new MockDevice('full', 95), new MockDevice('busy', 70, { active: -500 })], 500);
assert.deepStrictEqual(r, { full: -1000, busy: 0 }, 'beyond the hysteresis: swap');
console.log('ok   hysteresis');

// Target from the last commands: what the batteries were told plus the grid power
r = run([new MockDevice('a', 80, { active: -400 })], 100);
assert.deepStrictEqual(r, { a: -500 }, 'integrates on the last command');
r = run([new MockDevice('a', 80, { active: -400 })], 100, { x: 100 });
assert.deepStrictEqual(r, { a: -400 }, 'x offset: grid target');
console.log('ok   target');

// No action: within tolerance, all full on export, all empty (or at the reserve) on import
r = run(equal3(), 5);
assert.strictEqual(sum(r), 0, 'within 10 W: nothing');
r = run([new MockDevice('a', 100), new MockDevice('b', 100)], -1000);
assert.strictEqual(sum(r), 0, 'all full: no charging');
r = run([new MockDevice('a', 0), new MockDevice('b', 0)], 1000);
assert.strictEqual(sum(r), 0, 'all empty: no discharging');
r = run([new MockDevice('res', 20, { reserve: 20 }), new MockDevice('ok', 50)], 1000);
assert.deepStrictEqual(r, { res: 0, ok: -1000 }, 'at its reserve: counts as empty');
r = run([new MockDevice('res', 20, { reserve: 20 })], 1000);
assert.deepStrictEqual(r, { res: 0 }, 'only one at its reserve: nothing');
console.log('ok   no action');

// Never against the main direction
for (const p of [-3000, -700, 700, 3000]) {
  r = run(mixed(), p);
  assert.ok(Object.values(r).every((t) => (p > 0 ? t <= 0 : t >= 0)), `direction ${p}: ${JSON.stringify(r)}`);
  assert.ok(Math.abs(sum(r) + p) < 10, `meets ${p}: ${sum(r)}`);
}
console.log('ok   direction');

console.log('all passed');
