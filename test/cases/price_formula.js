'use strict';

// node test/cases/price_formula.js — PriceFormula against PriceCalculator, and the parser.

const assert = require('assert');
const PriceFormula = require('../../lib/PriceFormula');
const PriceCalculator = require('../../lib/PriceCalculator');

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log('ok  ', name);
  } catch (err) {
    failures += 1;
    console.log('FAIL', name, '\n    ', err.message);
  }
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

const start = Date.UTC(2026, 9, 16, 22, 0); // Saturday 00:00 Amsterdam
const market = Array.from({ length: 72 }, (_, i) => ({
  time: new Date(start + i * 3600000), price: [-30, 0, 45.5, 120, 260][i % 5],
}));

const base = {
  exchangeRate: 1,
  variableMarkup: 0,
  variableMarkupAbsPrice: 0,
  fixedMarkup: 0,
  fixedMarkupTOD: '',
  fixedMarkupWeekend: 0,
  export_variableMarkup: 0,
  export_variableMarkupAbsPrice: 0,
  export_fixedMarkup: 0,
  export_fixedMarkupTOD: '',
  export_fixedMarkupWeekend: 0,
  ignore_market_price: false,
  export_ignore_market_price: false,
};

const cases = {
  plain: {},
  markups: {
    fixedMarkup: 0.0248, variableMarkup: 10, export_fixedMarkup: -0.02, export_variableMarkup: -5,
  },
  absPercent: { variableMarkup: 5, variableMarkupAbsPrice: 3, export_variableMarkupAbsPrice: -2 },
  tod: { fixedMarkupTOD: '0:0.01;7:0.05;23:0.01', export_fixedMarkupTOD: '8:0.02;20:0' },
  weekend: { fixedMarkupTOD: '0:0.01;7:0.05', fixedMarkupWeekend: 0.03, export_fixedMarkupWeekend: -0.01 },
  exchange: { exchangeRate: 11.3, fixedMarkup: 0.5 },
};

Object.entries(cases).forEach(([name, extra]) => {
  test(`equals PriceCalculator without vat: ${name}`, () => {
    const settings = { ...base, ...extra };
    const oldPrices = PriceCalculator.calculateMarkupPrices(market, settings, 'Europe/Amsterdam');
    const newPrices = PriceFormula.applyPrices(market, settings, 'Europe/Amsterdam');
    oldPrices.forEach((p, i) => {
      near(newPrices[i].muPrice, p.muPrice, `import ${i}`);
      near(newPrices[i].exportPrice, p.exportPrice, `export ${i}`);
    });
  });
});

test('take over of an old dap (incl. VAT, VAT 0, ignored export market = -100%) equals PriceCalculator', () => {
  const old = {
    ...base, ...cases.weekend, variableMarkup: 21, fixedMarkup: 0.15, export_ignore_market_price: true, export_fixedMarkup: 0.07,
  };
  const taken = {
    ...base,
    ...cases.weekend,
    tariffType: 'dynamic',
    variableMarkup: 21,
    fixedMarkup: 0.15,
    fixedMarkupInclVat: true,
    fixedMarkupTODInclVat: true,
    fixedMarkupWeekendInclVat: true,
    export_variableMarkup: -100,
    export_fixedMarkup: 0.07,
    export_fixedMarkupInclVat: true,
    export_fixedMarkupTODInclVat: true,
    export_fixedMarkupWeekendInclVat: true,
  };
  const a = PriceCalculator.calculateMarkupPrices(market, old, 'Europe/Amsterdam');
  const b = PriceFormula.applyPrices(market, taken, 'Europe/Amsterdam');
  a.forEach((p, i) => {
    near(b[i].muPrice, p.muPrice, `import ${i}`);
    near(b[i].exportPrice, p.exportPrice, `export ${i}`);
  });
});

test('build: Homey Energy example', () => {
  const s = {
    ...base, fixedMarkup: 0.0248, tax: 0.12635, vat: 21,
  };
  assert.strictEqual(PriceFormula.build(s), '(market + 0.0248 + 0.12635) * 1.21');
  const [p] = PriceFormula.applyPrices([{ time: new Date(start), price: 100 }], s, 'UTC');
  near(p.muPrice, (0.1 + 0.0248 + 0.12635) * 1.21, 'price');
});

test('build: per amount incl. vat', () => {
  const s = {
    ...base,
    fixedMarkup: 0.03,
    fixedMarkupInclVat: true,
    tax: 0.15,
    vat: 21,
    fixedMarkupTOD: '7:0.01',
    fixedMarkupWeekend: 0.02,
    fixedMarkupWeekendInclVat: true,
  };
  assert.strictEqual(PriceFormula.build(s), '(market + 0.15 + tod) * 1.21 + 0.03 + weekend');
  const [sat] = PriceFormula.applyPrices([{ time: new Date(start + 9 * 3600000), price: 100 }], s, 'UTC');
  near(sat.muPrice, (0.1 + 0.15) * 1.21 + 0.03 + 0.02, 'saturday: weekend replaces tod');
  const [mon] = PriceFormula.applyPrices([{ time: new Date(start + 57 * 3600000), price: 100 }], s, 'UTC');
  near(mon.muPrice, (0.1 + 0.15 + 0.01) * 1.21 + 0.03, 'monday: tod');
});

test('build: nothing set', () => {
  assert.strictEqual(PriceFormula.build(base), 'market');
  assert.strictEqual(PriceFormula.build({ ...base, variableMarkup: -100 }), '0');
});

test('build: fixed tariff has no market part', () => {
  const s = {
    ...base, tariffType: 'fixed', fixedMarkup: 0.25, variableMarkup: 10, tax: 0.1, vat: 21, fixedMarkupTOD: '7:0.02;23:0',
  };
  assert.strictEqual(PriceFormula.build(s), '(0.275 + 0.1 + tod) * 1.21');
  const [p] = PriceFormula.applyPrices([{ time: new Date(start + 9 * 3600000), price: 0 }], s, 'UTC');
  near(p.muPrice, (0.275 + 0.1 + 0.02) * 1.21, 'price');
});

test('own formula overrides, with import in export', () => {
  const s = { ...base, formula: '(market * 1.19) + 0.21624', export_formula: 'max(market - 0.02; 0.5 * import)' };
  const [p] = PriceFormula.applyPrices([{ time: new Date(start), price: 10 }], s, 'UTC');
  near(p.muPrice, 0.01 * 1.19 + 0.21624, 'import');
  near(p.exportPrice, Math.max(0.01 - 0.02, 0.5 * p.muPrice), 'export');
});

test('parser: precedence, unary minus, functions', () => {
  const f = PriceFormula.compile('-2 + 3 * 4 / (1 + 1) - abs(-1) + min(5, 2, 9)', []);
  assert.strictEqual(f({}), -2 + 6 - 1 + 2);
});

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};
test('parser: errors', () => {
  assert.strictEqual(code(() => PriceFormula.validate('market +')), 'formula_syntax');
  assert.strictEqual(code(() => PriceFormula.validate('price * 2')), 'formula_unknown_name');
  assert.strictEqual(code(() => PriceFormula.validate('import * 2')), 'formula_unknown_name');
  assert.strictEqual(code(() => PriceFormula.validate('import * 2', 'export')), null);
  assert.strictEqual(code(() => PriceFormula.validate('market / 0')), 'formula_not_a_number');
  assert.strictEqual(code(() => PriceFormula.validate('')), 'formula_empty');
  assert.strictEqual(code(() => PriceFormula.validate('foo(1)')), 'formula_unknown_name');
  assert.strictEqual(code(() => PriceFormula.validate('market $ 2')), 'formula_syntax');
  assert.strictEqual(code(() => PriceFormula.validate('(market')), 'formula_syntax');
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
