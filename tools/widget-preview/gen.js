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

const pill = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;

// widgets/energy_flow: five nodes around a hub, two flows lit (solar in, home out); solar value beside its node.
const energyFlow = (t) => {
  const hub = [512, 470];
  const nodes = [
    {
      x: 512, y: 200, lit: SOLAR, side: true,
    },
    { x: 190, y: 470 },
    { x: 834, y: 470, lit: GREEN },
    { x: 320, y: 760 },
    { x: 704, y: 760 },
  ];
  const line = (n) => `<path d="M${n.x} ${n.y}L${hub[0]} ${hub[1]}" stroke="${t.track}" stroke-width="10"/>${
    n.lit ? `<path d="M${n.x} ${n.y}L${hub[0]} ${hub[1]}" stroke="${n.lit}" stroke-width="18" stroke-linecap="round" stroke-dasharray="0 44"/>` : ''}`;
  const node = (n) => `<circle cx="${n.x}" cy="${n.y}" r="78" fill="${t.card}" stroke="${n.lit || t.shape}" stroke-width="10" filter="url(#shadow)"/>`
    + `<circle cx="${n.x}" cy="${n.y}" r="28" fill="${n.lit || t.shape}"/>${
      n.side ? pill(n.x + 104, n.y - 13, 120, 26, t.shape) : pill(n.x - 60, n.y + 104, 120, 26, t.shape)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="190%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="${t.shadow}"/>
    </filter>
  </defs>
  ${nodes.map(line).join('\n  ')}
  <circle cx="${hub[0]}" cy="${hub[1]}" r="16" fill="${t.shape}"/>
  ${nodes.map(node).join('\n  ')}
</svg>`;
};

// widgets/plan: lanes on a shared time axis - price bars (cheap to dear), solar, battery, load.
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
    return v >= 70 ? SOLAR : GREEN;
  };
  const solar = [0, 0, 0, 0, 0, 30, 80, 120, 140, 120, 80, 30, 0, 0, 0, 0];
  const battery = [0, 0, 90, 90, 0, 0, 0, 60, 60, 60, 0, 0, 0, 0, 0, 0];
  const load = [40, 40, 40, 40, 40, 70, 70, 40, 40, 40, 40, 40, 110, 110, 110, 40];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  ${[0, 1, 2, 3].map((i) => `${pill(72, lane(i) + 50, 170, 26, t.shape)}${pill(72, lane(i) + 96, 120, 26, t.track)}
  <rect x="${x0}" y="${lane(i) + 150}" width="${x1 - x0}" height="6" rx="3" fill="${t.track}"/>`).join('\n  ')}
  ${bars(lane(0), price, priceFill)}
  ${bars(lane(1), solar, SOLAR)}
  ${bars(lane(2), battery, GREEN)}
  ${bars(lane(3), load, t.shape)}
  <rect x="${x0 + 238}" y="120" width="8" height="${lane(3) + 186 - 120}" rx="4" fill="${t.shape}"/>
</svg>`;
};

const WIDGETS = { energy_flow: energyFlow, plan };

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
