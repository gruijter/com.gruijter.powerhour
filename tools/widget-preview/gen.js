'use strict';

const fs = require('fs');
const path = require('path');

// Guideline 1.10: transparent background, simple shapes, no text, few colours.
const THEMES = {
  light: {
    card: '#FFFFFF', shape: '#D6DAE2', track: '#E4E7EC', shadow: 'rgba(17,24,39,0.13)',
  },
  dark: {
    card: '#3A3A3C', shape: '#6B6B70', track: '#4E4E51', shadow: 'rgba(0,0,0,0.55)',
  },
};

const SOLAR = '#F2A900';
const GREEN = '#34C759';
const CHEAP = '#4C6EF5';

const pill = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;

// widgets/energy: the widget's node layout (tools/widget-shared/flow.js) at 2.8x with the tabs,
// two flows lit (solar in, home out).
const flowPreview = (t) => {
  const k = 2.8;
  const at = (x, y) => [64 + x * k, 120 + y * k];
  const hub = at(160, 150);
  const climate = at(280, 150);
  // Top row: text above; gas: its own line straight to climate.
  const nodes = [
    { p: at(40, 72), top: true },
    { p: at(160, 72), lit: SOLAR, top: true },
    { p: at(280, 72), top: true, to: climate },
    { p: at(40, 150) },
    { p: climate },
    { p: at(80, 250) },
    { p: at(240, 250), lit: GREEN },
  ];
  const line = ({ p, lit, to = hub }) => `<path d="M${p[0]} ${p[1]}L${to[0]} ${to[1]}" stroke="${t.track}" stroke-width="9"/>${
    lit ? `<path d="M${p[0]} ${p[1]}L${to[0]} ${to[1]}" stroke="${lit}" stroke-width="16" stroke-linecap="round" stroke-dasharray="0 40"/>` : ''}`;
  const label = (p, top) => pill(p[0] - 50, top ? p[1] - 100 : p[1] + 78, 100, 22, t.shape);
  const node = ({ p, lit, top }) => `<circle cx="${p[0]}" cy="${p[1]}" r="58" fill="${t.card}" stroke="${lit || t.shape}" stroke-width="9" filter="url(#shadow)"/>`
    + `<circle cx="${p[0]}" cy="${p[1]}" r="21" fill="${lit || t.shape}"/>${label(p, top)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="190%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="${t.shadow}"/>
    </filter>
  </defs>
  ${pill(40, 40, 944, 60, t.track)}${pill(46, 46, 150, 48, t.card)}
  ${nodes.map(line).join('\n  ')}
  <circle cx="${hub[0]}" cy="${hub[1]}" r="12" fill="${t.shape}"/>
  ${nodes.map(node).join('\n  ')}
</svg>`;
};

// widgets/plan: lanes on a shared time axis - price levels, solar, battery SoC, grid.
const plan = (t) => {
  const x0 = 300;
  const x1 = 952;
  const lane = (i) => 150 + i * 190;
  const bars = (y, values, fill) => {
    const w = (x1 - x0) / values.length;
    const color = (i, v) => (typeof fill === 'function' ? fill(i, v) : fill);
    return values.map((v, i) => `<rect x="${(x0 + i * w).toFixed(1)}" y="${y + 150 - v}" width="${(w + 0.5).toFixed(1)}" height="${v}" fill="${color(i, v)}"/>`).join('');
  };
  const price = [70, 60, 45, 40, 50, 80, 110, 95, 75, 60, 55, 70, 120, 140, 115, 85];
  const priceFill = (i, v) => {
    if (v >= 110) return '#E5484D';
    return v >= 70 ? t.shape : CHEAP;
  };
  const solar = [0, 0, 0, 0, 0, 30, 80, 120, 140, 120, 80, 30, 0, 0, 0, 0];
  // Battery: planned SoC line with the charging slots as a band below.
  const soc = [30, 30, 30, 60, 80, 80, 80, 80, 95, 110, 110, 110, 90, 70, 60, 60];
  const socLine = (y) => soc.map((v, i) => `${(x0 + (i + 0.5) * 40.75).toFixed(1)},${y + 112 - v * 0.8}`).join(' ');
  const load = [40, 40, 40, 40, 40, 70, 70, 40, 40, 40, 40, 40, 110, 110, 110, 40];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${[0, 1, 2, 3].map((i) => `${pill(72, lane(i) + 50, 170, 26, t.shape)}${pill(72, lane(i) + 96, 120, 26, t.track)}
  <rect x="${x0}" y="${lane(i) + 150}" width="${x1 - x0}" height="6" rx="3" fill="${t.track}"/>`).join('\n  ')}
  ${bars(lane(0), price, priceFill)}
  ${bars(lane(1), solar, SOLAR)}
  <polyline points="${socLine(lane(2))}" fill="none" stroke="${GREEN}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>
  ${[[2, 4], [7, 10]].map(([a, b]) => `<rect x="${x0 + a * 40.75}" y="${lane(2) + 128}" width="${(b - a) * 40.75}" height="22" rx="11" fill="${GREEN}"/>`).join('')}
  ${bars(lane(3), load, t.shape)}
  <rect x="${x0 + 238}" y="120" width="8" height="${lane(3) + 186 - 120}" rx="4" fill="${t.shape}"/>
</svg>`;
};

// widgets/flows: sources left, the home in the middle, users right, joined by bands.
const flowsPreview = (t) => {
  const bar = (x, y, h, fill) => `<rect x="${x}" y="${y}" width="22" height="${h}" rx="8" fill="${fill}"/>`;
  const bandPath = (x0, a0, b0, x1, a1, b1) => {
    const xm = (x0 + x1) / 2;
    return `M${x0} ${a0}C${xm} ${a0} ${xm} ${a1} ${x1} ${a1}L${x1} ${b1}C${xm} ${b1} ${xm} ${b0} ${x0} ${b0}Z`;
  };
  const b = (x0, a0, b0, x1, a1, b1, fill) => `<path d="${bandPath(x0, a0, b0, x1, a1, b1)}" fill="${fill}" opacity="0.45"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${b(102, 170, 600, 490, 300, 730, SOLAR)}
  ${b(102, 640, 840, 490, 730, 930, t.shape)}
  ${b(512, 300, 480, 900, 170, 350, CHEAP)}
  ${b(512, 480, 600, 900, 390, 510, GREEN)}
  ${b(512, 600, 930, 900, 550, 880, t.shape)}
  ${bar(80, 170, 430, SOLAR)}${bar(80, 640, 200, t.shape)}
  ${bar(490, 300, 630, CHEAP)}
  ${bar(900, 170, 180, CHEAP)}${bar(900, 390, 120, GREEN)}${bar(900, 550, 330, t.shape)}
</svg>`;
};

const WIDGETS = { energy: flowPreview, plan, flows: flowsPreview };

for (const [widget, render] of Object.entries(WIDGETS)) {
  for (const [mode, t] of Object.entries(THEMES)) {
    const svg = render(t);
    fs.writeFileSync(path.join(__dirname, `${widget}-preview-${mode}.svg`), svg);
    fs.writeFileSync(path.join(__dirname, `${widget}-preview-${mode}.html`),
      `<style>html,body{margin:0;background:transparent}</style>${svg}`);
  }
}
// eslint-disable-next-line no-console
console.log('wrote svg + html for', Object.keys(WIDGETS).join(', '));
