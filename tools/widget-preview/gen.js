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

const WIDGETS = { energy_flow: energyFlow };

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
