/* The node diagram of the Power flow and Energy widgets: nodes around a hub that every flow runs
   through. Icons from icons.js (window.PBTH_ICONS). */

'use strict';

(function pbthFlow() {
  const NS = 'http://www.w3.org/2000/svg';
  const HUB = { x: 160, y: 118 };
  // 320 wide; `into` is the arrow from the node toward the hub, `out` the reverse.
  const NODES = [
    {
      id: 'gas', x: 40, y: 34, color: '--c-gas', into: '↘', out: '↖',
    },
    {
      id: 'solar', x: 160, y: 34, color: '--c-solar', textX: 192, textY: 30, anchor: 'start', into: '↓', out: '↑',
    },
    {
      id: 'grid', x: 40, y: 118, color: '--c-grid', into: '→', out: '←',
    },
    {
      id: 'home', x: 280, y: 118, color: '--c-home', into: '←', out: '→',
    },
    {
      id: 'battery', x: 104, y: 200, color: '--c-battery', into: '↗', out: '↙',
    },
    {
      id: 'ev', x: 216, y: 200, color: '--c-ev', into: '↖', out: '↘',
    },
  ];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach((k) => {
      e.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(e);
    return e;
  }

  // Draws every node (hidden until set()) and returns them by id.
  function build(svg) {
    const lines = el('g', {}, svg);
    const layer = el('g', {}, svg);
    const icons = window.PBTH_ICONS || {};
    const byId = {};
    el('circle', {
      cx: HUB.x, cy: HUB.y, r: 4, fill: 'var(--line)',
    }, lines);
    NODES.forEach((def) => {
      const n = { ...def };
      const d = `M${n.x} ${n.y}L${HUB.x} ${HUB.y}`;
      const color = `var(${n.color})`;
      n.base = el('path', { d, class: 'base hidden' }, lines);
      n.flow = el('path', { d, class: 'flow hidden', stroke: color }, lines);
      n.group = el('g', { class: 'hidden' }, layer);
      el('circle', {
        cx: n.x, cy: n.y, r: 22, class: 'ring', stroke: color,
      }, n.group);
      const icon = el('g', { transform: `translate(${n.x - 15} ${n.y - 15}) scale(0.3)`, style: `color:${color}` }, n.group);
      icon.innerHTML = icons[n.id] || '';
      const tx = n.textX || n.x;
      const ty = n.textY || n.y + 38;
      const anchor = n.anchor || 'middle';
      n.values = [0, 1].map((i) => {
        return el('text', {
          x: tx, y: ty + i * 14, 'text-anchor': anchor, class: 'value',
        }, n.group);
      });
      n.label = el('text', {
        x: tx, y: ty + 14, 'text-anchor': anchor, class: 'label',
      }, n.group);
      n.textY = ty;
      byId[n.id] = n;
    });
    return byId;
  }

  // s: null hides the node; else { values: [text, text?], label, flow: { into: bool, dur: s } | null }.
  function set(n, s) {
    [n.group, n.base, n.flow].forEach((e) => {
      e.classList.toggle('hidden', !s);
    });
    if (!s) return;
    const values = s.values || [];
    n.values.forEach((e, i) => {
      e.textContent = values[i] || '';
    });
    n.label.setAttribute('y', n.textY + Math.max(1, values.length) * 14);
    n.label.textContent = s.label;
    const on = !!s.flow;
    n.flow.classList.toggle('on', on);
    n.flow.classList.toggle('out', on && !s.flow.into);
    if (on) n.flow.style.animationDuration = `${s.flow.dur.toFixed(2)}s`;
  }

  window.PbthFlow = { build, set };
}());
