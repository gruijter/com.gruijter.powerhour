const { getStrategy } = require('./lib/strategies/NomXomStrategy');

// Mock Device class
class MockDevice {
  constructor(id, name, soc, maxCharge, maxDischarge, actualPower = 0) {
    this.id = id;
    this.name = name;
    this.soc = soc;
    this.maxCharge = maxCharge;
    this.maxDischarge = maxDischarge;
    this.actualPower = actualPower;
    this.xomTargetPower = 0;
  }

  getData() { return { id: this.id }; }
  getName() { return this.name; }
  getSettings() { return { chargePower: this.maxCharge, dischargePower: this.maxDischarge }; }
  getCapabilityValue(cap) { return this.actualPower; }
}

// Scenario: 3 Batteries, need to discharge
// Total Grid Power (cumulativePower) = 1000W (Import). We want to reduce it.
// Batteries are idle (0W).
// Total Target = 0 - (1000 - 0) = -1000W.

const devices = [
  new MockDevice('bat1', 'Battery 1', 80, 2000, 2000, 0),
  new MockDevice('bat2', 'Battery 2', 80, 2000, 2000, 0),
  new MockDevice('bat3', 'Battery 3', 80, 2000, 2000, 0),
];

console.log('--- Scenario 1: Even Split, No MinLoad issues ---');
let strategy = getStrategy({
  devices,
  cumulativePower: 1000,
  minLoad: 50
});
console.log('Target -1000. Expect ~ -333 each.');
strategy.forEach(s => console.log(`${s.name}: Target ${s.target.toFixed(2)}, Headroom ${s.headroom}`));

// Scenario 2: High Discharge Requirement causing 'clamping' logic to trigger?
// Let's force a scenario where proportional distribution creates a delta, or where sorting pass is used.
// Suppose we have a small battery that clamps in the first phase.

const devices2 = [
  new MockDevice('bat1', 'Big Bat', 90, 2000, 2000, 0),
  new MockDevice('bat2', 'Big Bat 2', 90, 2000, 2000, 0),
  new MockDevice('bat3', 'Tiny Bat', 90, 100, 100, 0), // Max discharge 100
];
// Target -1000.
// Proportional: Bigs take ~450 each? Tiny takes ~100.
// Let's see. Total SoC = 270. Fraction 1/3 each.
// Target per bat = -333.
// Tiny Bat clamped to -100.
// Sum = -333 -333 -100 = -766.
// Delta = -1000 - (-766) = -234.
// This -234 needs to be distributed to Big Bats.
// Big Bats have headroom ~1667. Tiny has 0.
// Pass 1: Big Bats share -234.
// Expected: Bigs take extra -117 each. Total Big = -450.
// BUG PREDICTION: If logic is flawed, Big Bats might get POSITIVE headroom added.

console.log('\n--- Scenario 2: Mixed Battery Sizes (Triggering Distribution) ---');
strategy = getStrategy({
  devices: devices2,
  cumulativePower: 1000,
  minLoad: 50
});
console.log('Target -1000. Expect Bigs ~ -450, Tiny -100.');
strategy.forEach(s => console.log(`${s.name}: Target ${s.target.toFixed(2)}, Headroom ${s.headroom}`));

// Scenario 3: MinLoad causing Dropouts
// Target -120. MinLoad 50. 3 Batteries.
// -40 each. All drop to 0.
// Delta -120.
// Pass 2 (Sort) should pick one.
console.log('\n--- Scenario 3: MinLoad Dropouts ---');
strategy = getStrategy({
  devices, // 3 equal bats
  cumulativePower: 120, // Target -120
  minLoad: 50
});
console.log('Target -120. Expect one battery taking -120 (or max possible).');
strategy.forEach(s => console.log(`${s.name}: Target ${s.target.toFixed(2)}, Headroom ${s.headroom}`));

