/*
Terminology check (dev tool, not in the app package: /test/ is in .homeyignore).

  node test/terms.js            report to the console, all terms to test/all_terms.json
  node test/terms.js --max 40   only terms whose English text is at most 40 characters

Collects every translation object ({ en, nl, ... }) from .homeycompose/, the driver manifests
and locales/*.json, and reports:
  1. translation objects missing one of the 13 languages;
  2. texts still in English in another language;
  3. the same English text translated differently in a language.
*/

/* eslint-disable no-console */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];
const OUT = path.join(__dirname, 'all_terms.json');
// Different on purpose: gender (car vs appliance), case, or another meaning. 'English|lang'.
const ACCEPTED = new Set([
  'Not used|fr', 'Not used|it', 'Not used|pl', 'Not used|ar', // the car (fem.) vs an appliance
  'Hour|de', 'Hour|ko', // clock time (units) vs a duration (token)
  'Start time|fr', 'Start time|it', 'Start time|pl', 'Start time|ru', // program start vs period start
  'this day|de', 'next 8H|de', // genitive vs accusative
  // 'Charging': a car status ('is charging') vs a settings group ('charging').
  ...['de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'ru', 'ar', 'ko'].map((l) => `Charging|${l}`),
  // A time ('from 07:00') vs a date or a range.
  'From|nl', 'From|de', 'From|fr', 'From|it', 'From|ko',
  // A block (singular) vs among the cheapest slots (plural); after a number vs a title.
  ...['de', 'fr', 'es', 'it', 'pl', 'ru'].flatMap((l) => [`cheapest|${l}`, `most expensive|${l}`]),
  'hours|pl', 'hours|ru',
  // A preset (masc.) vs a capability choice; a choice vs a state.
  'None|de', 'None|fr', 'None|es', 'Off|ko',
]);
// The same word as in English on purpose (loanword, abbreviation). 'English|lang'.
const SAME_AS_EN = new Set([
  'SoC', 'Min.', 'Gas', 'Gas (m³)', 'Maximum', 'Minimum', 'Smart', 'Start', 'Plan', 'Status', 'Program', 'Reserve',
  'Water (m³)|nl', 'period|sv', 'Mode|fr', 'Description|fr', 'Linear|de', 'Tariff|sv', 'Tariff|no', 'Phases|fr',
  '1 phase|fr', '3 phases|fr', '15 minutes|fr', '30 minutes|fr', '45 minutes|fr', '60 minutes|fr', 'Latitude|fr',
  'Longitude|fr', 'Distribution|fr', 'Minutes|fr',
  'Plan JSON', 'Min. SoC [[day]] [[soc]]%', 'Reserve (%)', 'Peak shaving|nl', 'Meter|nl', 'Action|fr', 'Charge|fr',
  'Period|sv', 'Type|fr', 'Type|da', 'Type|no', 'minutes|fr', 'import', 'export', 'gas', 'water|nl', 'Name|de',
  'Formula|it', 'VAT (%)|pl', 'Planning|nl', 'Control|es', 'Water|nl', 'Import: VAT (%)|pl', 'Per kWh (gas: per m³).', 'Minimum per kWh', 'per __unit__',
]);

const maxArg = process.argv.indexOf('--max');
const maxLen = maxArg > -1 ? Number(process.argv[maxArg + 1]) : Infinity;

const walk = (dir, filter) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return walk(p, filter);
  return filter(p) ? [p] : [];
});

const isTranslation = (o) => o && typeof o === 'object' && !Array.isArray(o) && typeof o.en === 'string'
  && Object.keys(o).every((k) => LANGS.includes(k) && typeof o[k] === 'string');

const terms = [];
const collect = (node, file, at) => {
  if (!node || typeof node !== 'object') return;
  if (isTranslation(node)) {
    terms.push({ file, path: at, ...node });
    return;
  }
  Object.entries(node).forEach(([k, v]) => {
    let next = at ? `${at}.${k}` : k;
    if (Array.isArray(node)) next = `${at}[${k}]`;
    collect(v, file, next);
  });
};

// Compose files and driver manifests.
const composeFiles = [
  ...walk(path.join(ROOT, '.homeycompose'), (p) => p.endsWith('.json')),
  ...walk(path.join(ROOT, 'drivers'), (p) => /driver[^/]*\.json$/.test(p)),
  // Settings moved out of the manifests to the setup view.
  path.join(ROOT, 'lib/helpers/SetupSettings.json'),
  path.join(ROOT, 'lib/helpers/DriverSetupSettings.json'),
];
// Deprecated flow cards are hidden: their texts do not count.
composeFiles.forEach((file) => {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.deprecated && file.includes(`${path.sep}flow${path.sep}`)) return;
  collect(json, path.relative(ROOT, file), '');
});

// Locale files: one file per language, merged into translation objects per key.
const locales = {};
const flatten = (node, prefix, lang) => Object.entries(node).forEach(([k, v]) => {
  const key = prefix ? `${prefix}.${k}` : k;
  if (v && typeof v === 'object') flatten(v, key, lang);
  else {
    if (!locales[key]) locales[key] = {};
    locales[key][lang] = String(v);
  }
});
LANGS.forEach((lang) => {
  const file = path.join(ROOT, 'locales', `${lang}.json`);
  if (fs.existsSync(file)) flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', lang);
});
Object.entries(locales).forEach(([key, t]) => {
  if (typeof t.en === 'string') terms.push({ file: 'locales/*.json', path: key, ...t });
});

const list = terms.filter((t) => t.en.length <= maxLen);
fs.writeFileSync(OUT, `${JSON.stringify(list, null, 2)}\n`);

// 1. Missing languages.
const missing = list.filter((t) => LANGS.some((l) => typeof t[l] !== 'string'));
console.log(`\n${list.length} terms, written to ${path.relative(ROOT, OUT)}\n`);
console.log(`== Missing languages: ${missing.length}`);
missing.forEach((t) => console.log(`  ${t.file} ${t.path}: ${LANGS.filter((l) => typeof t[l] !== 'string').join(', ')}`));

// 2. Not translated: the English text in another language.
const untranslated = [];
list.forEach((t) => {
  if (!/[a-z]{3}/i.test(t.en)) return;
  const langs = LANGS.slice(1).filter((l) => t[l] === t.en && !SAME_AS_EN.has(t.en) && !SAME_AS_EN.has(`${t.en}|${l}`));
  // In every language the same (a unit, a code, a name): on purpose.
  if (langs.length && langs.length < LANGS.length - 1) untranslated.push(`  ${t.file} ${t.path} "${t.en}": ${langs.join(', ')}`);
});
console.log(`\n== Not translated: ${untranslated.length}`);
untranslated.forEach((line) => console.log(line));

// 3. The same English text, translated differently.
const byEn = new Map();
list.forEach((t) => {
  if (!byEn.has(t.en)) byEn.set(t.en, []);
  byEn.get(t.en).push(t);
});
const conflicts = [];
byEn.forEach((group, en) => {
  if (group.length < 2) return;
  LANGS.slice(1).forEach((lang) => {
    const variants = new Map();
    group.forEach((t) => {
      if (typeof t[lang] !== 'string') return;
      if (!variants.has(t[lang])) variants.set(t[lang], []);
      variants.get(t[lang]).push(`${t.file} ${t.path}`);
    });
    if (variants.size > 1 && !ACCEPTED.has(`${en}|${lang}`)) conflicts.push({ en, lang, variants });
  });
});
console.log(`\n== Same English, different translation: ${conflicts.length}`);
conflicts.forEach(({ en, lang, variants }) => {
  console.log(`  "${en}" [${lang}]`);
  variants.forEach((where, text) => console.log(`    "${text}" (${where.length}x) e.g. ${where[0]}`));
});
