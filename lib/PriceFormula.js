/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const PriceCalculator = require('./PriceCalculator');
const TimeHelpers = require('./helpers/TimeHelpers');

const IMPORT_VARS = ['market', 'tod', 'weekend', 'markup', 'tax', 'vat', 'percent', 'abspercent'];
const EXPORT_VARS = [...IMPORT_VARS, 'import', 'supply'];

const FUNCTIONS = {
  min: { min: 1, fn: (...a) => Math.min(...a) },
  max: { min: 1, fn: (...a) => Math.max(...a) },
  abs: { min: 1, max: 1, fn: (a) => Math.abs(a) },
};

const formulaError = (code, detail = '') => {
  const err = new Error(`${code}${detail ? `: ${detail}` : ''}`);
  err.code = code;
  err.detail = String(detail);
  return err;
};

const tokenize = (str) => {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(str.slice(i));
      if (!m) throw formulaError('formula_syntax', str.slice(i, i + 10));
      tokens.push({ t: 'num', v: Number(m[1]) });
      i += m[1].length;
    } else if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(str.slice(i));
      tokens.push({ t: 'id', v: m[0].toLowerCase() });
      i += m[0].length;
    } else if ('+-*/(),;'.includes(c)) {
      tokens.push({ t: c === ';' ? ',' : c });
      i += 1;
    } else {
      throw formulaError('formula_syntax', c);
    }
  }
  return tokens;
};

const compile = (str, allowed) => {
  const tokens = tokenize(String(str || ''));
  if (!tokens.length) throw formulaError('formula_empty');
  let pos = 0;
  const peek = () => tokens[pos] || { t: 'end' };
  const take = (t) => {
    if (peek().t !== t) throw formulaError('formula_syntax', t === 'end' ? peek().t : t);
    pos += 1;
  };

  let expr;
  const primary = () => {
    const tok = peek();
    if (tok.t === 'num') {
      pos += 1;
      return () => tok.v;
    }
    if (tok.t === '(') {
      pos += 1;
      const inner = expr();
      take(')');
      return inner;
    }
    if (tok.t === 'id') {
      pos += 1;
      if (peek().t === '(') {
        const fun = FUNCTIONS[tok.v];
        if (!fun) throw formulaError('formula_unknown_name', tok.v);
        pos += 1;
        const args = [];
        if (peek().t !== ')') {
          args.push(expr());
          while (peek().t === ',') {
            pos += 1;
            args.push(expr());
          }
        }
        take(')');
        if (args.length < fun.min || (fun.max && args.length > fun.max)) throw formulaError('formula_syntax', tok.v);
        return (v) => fun.fn(...args.map((a) => a(v)));
      }
      if (!allowed.includes(tok.v)) throw formulaError('formula_unknown_name', tok.v);
      return (v) => v[tok.v];
    }
    throw formulaError('formula_syntax', tok.t === 'end' ? '' : (tok.v ?? tok.t));
  };
  const unary = () => {
    if (peek().t === '-') {
      pos += 1;
      const a = unary();
      return (v) => -a(v);
    }
    if (peek().t === '+') {
      pos += 1;
      return unary();
    }
    return primary();
  };
  const term = () => {
    let left = unary();
    while (peek().t === '*' || peek().t === '/') {
      const op = peek().t;
      pos += 1;
      const l = left;
      const r = unary();
      left = op === '*' ? (v) => l(v) * r(v) : (v) => l(v) / r(v);
    }
    return left;
  };
  expr = () => {
    let left = term();
    while (peek().t === '+' || peek().t === '-') {
      const op = peek().t;
      pos += 1;
      const l = left;
      const r = term();
      left = op === '+' ? (v) => l(v) + r(v) : (v) => l(v) - r(v);
    }
    return left;
  };

  const fn = expr();
  take('end');
  return fn;
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const lit = (value) => String(Number(Number(value).toPrecision(10)));

const settingVars = (settings, prefix) => ({
  markup: num(settings[`${prefix}fixedMarkup`]),
  tax: num(settings[`${prefix}tax`]),
  vat: num(settings[`${prefix}vat`]),
  percent: num(settings[`${prefix}variableMarkup`]),
  abspercent: num(settings[`${prefix}variableMarkupAbsPrice`]),
});

const build = (settings, kind = 'import') => {
  const prefix = kind === 'export' ? 'export_' : '';
  const v = settingVars(settings, prefix);
  const fixed = settings.tariffType === 'fixed';
  const factor = 1 + v.percent / 100;
  const excl = [];
  const incl = [];
  const add = (term, id) => (settings[`${prefix}${id}InclVat`] ? incl : excl).push(term);

  if (!fixed) {
    const floored = kind !== 'export' && settings.marketFloor;
    const m = floored ? 'max(market, 0)' : 'market';
    if (factor !== 0) excl.push(factor === 1 ? m : `${m} * ${lit(factor)}`);
    if (v.abspercent) excl.push(floored ? `${m} * ${lit(v.abspercent / 100)}` : `abs(market) * ${lit(v.abspercent / 100)}`);
  }
  const markup = fixed ? v.markup * factor : v.markup;
  if (markup) add(lit(markup), 'fixedMarkup');
  if (v.tax) add(lit(v.tax), 'tax');
  if (PriceCalculator.parseTOD(settings[`${prefix}fixedMarkupTOD`])) add('tod', 'fixedMarkupTOD');
  if (num(settings[`${prefix}fixedMarkupWeekend`])) add('weekend', 'fixedMarkupWeekend');

  const join = (terms) => terms.join(' + ').replace(/\+ -/g, '- ');
  const vatFactor = 1 + v.vat / 100;
  let formula;
  if (vatFactor === 1) {
    formula = join([...excl, ...incl]) || '0';
  } else {
    const group = (terms) => (terms.length > 1 ? `(${join(terms)})` : join(terms));
    const exclPart = excl.length ? `${group(excl)} * ${lit(vatFactor)}` : '';
    formula = join([exclPart, ...incl].filter(Boolean)) || '0';
  }
  if (kind !== 'export' || !settings.export_floor) return formula;
  const floors = [lit(num(settings.export_floorMin) * vatFactor)];
  const pct = num(settings.export_floorPercent);
  if (pct) floors.push(`${settings.export_floorBase === 'import' ? 'import' : 'supply'} * ${lit((pct / 100) * vatFactor)}`);
  return `max(${formula}, ${floors.join(', ')})`;
};

const supplyPrice = (settings, market) => {
  const v = settingVars(settings, '');
  const factor = 1 + v.percent / 100;
  const markup = settings.fixedMarkupInclVat ? v.markup / (1 + v.vat / 100) : v.markup;
  if (settings.tariffType === 'fixed') return markup * factor;
  const m = settings.marketFloor ? Math.max(market, 0) : market;
  return m * factor + Math.abs(m) * (v.abspercent / 100) + markup;
};

const formulaOf = (settings, kind) => {
  const own = String(settings[kind === 'export' ? 'export_formula' : 'formula'] || '').trim();
  return own || build(settings, kind);
};

const validate = (str, kind = 'import') => {
  const fn = compile(str, kind === 'export' ? EXPORT_VARS : IMPORT_VARS);
  const sample = {
    market: 0.1, tod: 0, weekend: 0, markup: 0.02, tax: 0.1, vat: 21, percent: 0, abspercent: 0, import: 0.3, supply: 0.12,
  };
  if (!Number.isFinite(fn(sample))) throw formulaError('formula_not_a_number');
};

const applyPrices = (marketPrices, settings, timeZone) => {
  if (!marketPrices || marketPrices.length === 0) return [];
  const importFn = compile(formulaOf(settings, 'import'), IMPORT_VARS);
  const exportFn = compile(formulaOf(settings, 'export'), EXPORT_VARS);
  const importVars = settingVars(settings, '');
  const exportVars = settingVars(settings, 'export_');
  const tod = {
    import: PriceCalculator.parseTOD(settings.fixedMarkupTOD),
    export: PriceCalculator.parseTOD(settings.export_fixedMarkupTOD),
  };
  const weekend = { import: num(settings.fixedMarkupWeekend), export: num(settings.export_fixedMarkupWeekend) };
  const exchangeRate = Number.isFinite(Number(settings.exchangeRate)) ? Number(settings.exchangeRate) : 1;
  const finite = (value) => (Number.isFinite(value) ? value : null);

  return marketPrices.map((marketPrice) => {
    const market = (num(marketPrice.price) * exchangeRate) / 1000;
    const local = TimeHelpers.toLocalDate(new Date(marketPrice.time), timeZone || 'UTC');
    const isWeekend = local.getDay() === 0 || local.getDay() === 6;
    const timeMarkups = (kind) => {
      if (weekend[kind] && isWeekend) return { tod: 0, weekend: weekend[kind] };
      return { tod: PriceCalculator.todAt(tod[kind], local), weekend: 0 };
    };
    const importPrice = finite(PriceCalculator.roundPrice(importFn({ ...importVars, market, ...timeMarkups('import') })));
    const exportPrice = finite(PriceCalculator.roundPrice(exportFn({
      ...exportVars, market, ...timeMarkups('export'), import: importPrice ?? 0, supply: supplyPrice(settings, market),
    })));
    return {
      time: marketPrice.time,
      price: marketPrice.price,
      muPrice: importPrice,
      importPrice,
      exportPrice,
      isForecast: marketPrice.isForecast,
    };
  });
};

module.exports = {
  IMPORT_VARS,
  EXPORT_VARS,
  compile,
  build,
  formulaOf,
  validate,
  applyPrices,
};
