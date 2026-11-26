/* eslint-disable no-console */

'use strict';

// Run: node test/tools/forecastCompare.js collect [NL,BE,...]   (twice a day, e.g. cron 10:30 and 18:00)
//      node test/tools/forecastCompare.js report [NL] [hours]
// Data: test/zzz_forecasts/<zone>/snap_*.json and actuals.json (not in git or the app).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EpexPredictor = require(path.join(ROOT, 'lib/providers/EpexPredictor'));
const EnergyPriceForecast = require(path.join(ROOT, 'lib/providers/EnergyPriceForecast'));
const EnergyForecast = require(path.join(ROOT, 'lib/providers/EnergyForecast'));
const Stekker = require(path.join(ROOT, 'lib/providers/Stekker'));
const EntsoeGruijter = require(path.join(ROOT, 'lib/providers/EntsoeGruijter'));
const PriceProvider = require(path.join(ROOT, 'lib/providers/PriceProvider'));

const DATA = path.join(ROOT, 'test', 'zzz_forecasts');
const ZONES = {
  NL: { eic: '10YNL----------L', tz: 'Europe/Amsterdam' },
  BE: { eic: '10YBE----------2', tz: 'Europe/Brussels' },
  DE: { eic: '10Y1001A1001A82H', tz: 'Europe/Berlin' },
  FR: { eic: '10YFR-RTE------C', tz: 'Europe/Paris' },
  AT: { eic: '10YAT-APG------L', tz: 'Europe/Vienna' },
  DK1: { eic: '10YDK-1--------W', tz: 'Europe/Copenhagen' },
  SE3: { eic: '10Y1001A1001A46L', tz: 'Europe/Stockholm' },
};
const PROVIDERS = {
  EpexPredictor, EnergyPriceForecast, EnergyForecast, Stekker,
};
const HOUR = 3600000;

try {
  fs.readFileSync(path.join(ROOT, 'test', 'zzz_energyforecast.env'), 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  });
} catch {
  // no key: energyforecast.de is skipped
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const hourly = (prices) => PriceProvider.aggregateTo(prices.map((p) => ({ time: new Date(p.time), price: p.price })), 60);

async function collect(zoneNames) {
  const tm = new Date();
  for (const name of zoneNames) {
    const zone = ZONES[name];
    if (!zone) {
      console.log(`unknown zone ${name}`);
      continue;
    }
    const dir = path.join(DATA, name);
    fs.mkdirSync(dir, { recursive: true });

    const actualsFile = path.join(dir, 'actuals.json');
    const actuals = readJson(actualsFile, {});
    const market = await new EntsoeGruijter({}).getPrices({
      biddingZone: zone.eic, dateStart: new Date(tm - 3 * 24 * HOUR), dateEnd: new Date(+tm + 2 * 24 * HOUR), resolution: 'PT60M',
    }).catch(() => null)
      || await new Stekker({ biddingZone: zone.eic }).getPrices({ resolution: 'PT60M' }).catch(() => []);
    hourly(market).forEach((p) => {
      actuals[p.time.toISOString()] = Math.round(p.price * 100) / 100;
    });
    fs.writeFileSync(actualsFile, JSON.stringify(actuals));
    const knownUntil = Math.max(0, ...Object.keys(actuals).map((t) => Date.parse(t))) + HOUR;

    const snap = { tm: tm.toISOString(), knownUntil: new Date(knownUntil).toISOString(), forecasts: {} };
    for (const [pName, P] of Object.entries(PROVIDERS)) {
      const apiKey = pName === 'EnergyForecast' ? process.env.ENERGYFORECAST_API_KEY : '';
      if (pName === 'EnergyForecast' && !apiKey) continue;
      const provider = new P({ biddingZone: zone.eic, apiKey });
      if (!Object.values(provider.getBiddingZones()).includes(zone.eic)) continue;
      try {
        const prices = await provider.getPrices({ forecast: true, resolution: 'PT15M' });
        snap.forecasts[pName] = hourly(prices).filter((p) => p.time >= knownUntil)
          .map((p) => [p.time.toISOString(), Math.round(p.price * 100) / 100]);
      } catch (err) {
        snap.forecasts[pName] = { error: err.message };
      }
    }
    const file = path.join(dir, `snap_${tm.toISOString().slice(0, 16).replace(/[-:]/g, '')}.json`);
    fs.writeFileSync(file, JSON.stringify(snap));
    const counts = Object.entries(snap.forecasts).map(([n, f]) => `${n} ${Array.isArray(f) ? f.length : f.error}`).join(', ');
    console.log(`${name} ${tm.toISOString()} known until ${snap.knownUntil}: ${counts}`);
  }
}

const localDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));

function bestWindow(times, values, hours) {
  let best = null;
  for (let i = 0; i + hours <= times.length; i += 1) {
    if (times[i + hours - 1] - times[i] !== (hours - 1) * HOUR) continue;
    const avg = values.slice(i, i + hours).reduce((a, v) => a + v, 0) / hours;
    if (!best || avg < best.avg) best = { start: times[i], avg };
  }
  return best;
}

function report(name, windowHours) {
  const zone = ZONES[name];
  const dir = path.join(DATA, name);
  const actuals = readJson(path.join(dir, 'actuals.json'), {});
  const snaps = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('snap_')).sort()
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean) : [];
  const stats = {};
  const add = (pName, lead, key, value) => {
    const id = `${pName}|${lead}`;
    if (!stats[id]) {
      stats[id] = {
        pName, lead, abs: [], err: [], days: 0, extra: [], hits: 0,
      };
    }
    stats[id][key].push(value);
  };

  snaps.forEach((snap) => {
    const snapDay = localDay(Date.parse(snap.tm), zone.tz);
    Object.entries(snap.forecasts).forEach(([pName, f]) => {
      if (!Array.isArray(f)) return;
      const byDay = new Map();
      f.forEach(([t, v]) => {
        const ms = Date.parse(t);
        if (actuals[t] === undefined) return;
        const day = localDay(ms, zone.tz);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push({ ms, f: v, a: actuals[t] });
      });
      byDay.forEach((rows, day) => {
        if (rows.length < 23) return;
        const lead = `D+${Math.round((Date.parse(day) - Date.parse(snapDay)) / (24 * HOUR))}`;
        rows.forEach((r) => {
          add(pName, lead, 'abs', Math.abs(r.f - r.a));
          add(pName, lead, 'err', r.f - r.a);
        });
        const times = rows.map((r) => r.ms);
        const fBest = bestWindow(times, rows.map((r) => r.f), windowHours);
        const aBest = bestWindow(times, rows.map((r) => r.a), windowHours);
        if (!fBest || !aBest) return;
        const i = times.indexOf(fBest.start);
        const aInF = rows.slice(i, i + windowHours).reduce((a, r) => a + r.a, 0) / windowHours;
        stats[`${pName}|${lead}`].days += 1;
        add(pName, lead, 'extra', aInF - aBest.avg);
        if (fBest.start === aBest.start) stats[`${pName}|${lead}`].hits += 1;
      });
    });
  });

  const mean = (a) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : NaN);
  const rows = Object.values(stats).filter((s) => s.days > 0)
    .sort((a, b) => a.lead.localeCompare(b.lead) || mean(a.abs) - mean(b.abs))
    .map((s) => ({
      Lead: s.lead,
      Provider: s.pName,
      Days: s.days,
      'MAE ct/kWh': (mean(s.abs) / 10).toFixed(2),
      'Bias ct/kWh': (mean(s.err) / 10).toFixed(2),
      [`${windowHours}h window extra ct/kWh`]: (mean(s.extra) / 10).toFixed(2),
      'Exact window': `${s.hits}/${s.days}`,
    }));
  console.log(`${name}: ${snaps.length} snapshots, ${Object.keys(actuals).length} actual hours; whole days only, hourly averages`);
  if (!rows.length) {
    console.log('No forecast day has published prices yet.');
    return;
  }
  console.table(rows);
}

const [, , cmd, arg, arg2] = process.argv;
if (cmd === 'collect') {
  collect((arg || 'NL').split(',')).catch((err) => console.log(err));
} else if (cmd === 'report') {
  report(arg || 'NL', Number(arg2) || 4);
} else {
  console.log('Usage: node test/tools/forecastCompare.js collect [NL,BE] | report [NL] [hours]');
}
