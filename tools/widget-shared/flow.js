'use strict';

(function pbthFlow() {
  const NS = 'http://www.w3.org/2000/svg';
  const BASE_W = 320;
  let W = BASE_W;
  const ROWS = { top: 72, mid: 150, bottom: 250 };
  const hub = () => ({ x: W / 2, y: ROWS.mid });
  const HEIGHT = 322;
  const NODES = [
    { id: 'grid', row: 'top', color: '--c-grid' },
    { id: 'solar', row: 'top', color: '--c-solar' },
    { id: 'water', row: 'top', color: '--c-water' },
    {
      id: 'gas', row: 'top', color: '--c-gas', to: 'climate',
    },
    {
      id: 'battery', row: 'mid', x: 40, color: '--c-battery',
    },
    {
      id: 'climate', row: 'mid', x: 280, color: '--c-climate',
    },
    { id: 'ev', row: 'bottom', color: '--c-ev' },
    {
      id: 'ev2', icon: 'ev', row: 'bottom', color: '--c-ev',
    },
    { id: 'home', row: 'bottom', color: '--c-home' },
  ];
  const SPREAD = {
    1: [160], 2: [80, 240], 3: [40, 160, 280], 4: [40, 120, 200, 280],
  };
  const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach((k) => {
      e.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(e);
    return e;
  }

  function arrow(from, to) {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    return ARROWS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
  }

  function layout(ids) {
    const pos = {};
    Object.keys(ROWS).forEach((row) => {
      const defs = NODES.filter((d) => d.row === row && ids.includes(d.id));
      defs.forEach((d, i) => {
        pos[d.id] = { x: (d.x || SPREAD[defs.length][i]) * (W / BASE_W), y: ROWS[row] };
      });
    });
    return pos;
  }

  function build(svg, ids) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${W} ${HEIGHT}`);
    const lines = el('g', {}, svg);
    const layer = el('g', {}, svg);
    const pos = layout(ids);
    const byId = {};
    el('circle', {
      cx: hub().x, cy: hub().y, r: 4, fill: 'var(--line)',
    }, lines);
    NODES.filter((d) => ids.includes(d.id)).forEach((def) => {
      const p = pos[def.id];
      const end = (def.to && pos[def.to]) || hub();
      const color = `var(${def.color})`;
      const d = `M${p.x} ${p.y}L${end.x} ${end.y}`;
      const n = {
        id: def.id, above: def.row === 'top', x: p.x, y: p.y, into: arrow(p, end), out: arrow(end, p),
      };
      n.base = el('path', { d, class: 'base' }, lines);
      n.flow = el('path', { d, class: 'flow', stroke: color }, lines);
      n.group = el('g', {}, layer);
      n.ring = el('circle', {
        cx: p.x, cy: p.y, r: 22, class: 'ring', stroke: color,
      }, n.group);
      n.icon = window.PBTH_PLACE_ICON(n.group, def.icon || def.id, p.x, p.y, 28, color);
      n.values = [0, 1].map(() => el('text', { x: p.x, 'text-anchor': 'middle', class: 'value' }, n.group));
      n.label = el('text', { x: p.x, 'text-anchor': 'middle', class: 'label' }, n.group);
      byId[def.id] = n;
    });
    return byId;
  }

  function setText(n, s) {
    const values = s.values || [];
    const colors = s.colors || [];
    const lines = values.length + 1;
    const first = n.above ? n.y - 30 - (lines - 1) * 14 : n.y + 38;
    n.values.forEach((e, i) => {
      const v = values[i];
      const text = v && typeof v === 'object' ? `${n[v.dir]} ${v.text}` : v;
      e.textContent = text || '';
      e.setAttribute('y', first + i * 14);
      e.style.fill = colors[i] || '';
    });
    n.label.setAttribute('y', first + values.length * 14);
    n.label.textContent = s.label;
    n.values.concat(n.label).forEach((e) => {
      const half = e.getComputedTextLength() / 2;
      e.setAttribute('x', Math.min(Math.max(n.x, half + 2), W - half - 2));
    });
  }

  function set(n, s) {
    n.ring.classList.toggle('dashed', !!s.dashed);
    n.ring.classList.toggle('dim', !!s.dim);
    n.icon.classList.toggle('dim', !!s.dim);
    [n.base, n.flow].forEach((e) => {
      e.classList.toggle('hidden', s.line === false);
    });
    setText(n, s);
    const on = !!s.flow;
    n.flow.classList.toggle('on', on);
    n.flow.classList.toggle('out', on && !s.flow.into);
    if (on) n.flow.style.animationDuration = `${s.flow.dur.toFixed(2)}s`;
  }

  function draw(svg, states, opts) {
    W = opts && opts.wide ? 480 : BASE_W;
    const ids = NODES.map((d) => d.id).filter((id) => states[id]);
    const key = `${W}:${ids.join(',')}`;
    if (!svg.pbthNodes || svg.pbthKey !== key) {
      svg.pbthNodes = build(svg, ids);
      svg.pbthKey = key;
    }
    ids.forEach((id) => set(svg.pbthNodes[id], states[id]));
  }

  function contentHeight() {
    let bottom = 0;
    Array.prototype.forEach.call(document.body.children, (e) => {
      const r = e.getBoundingClientRect();
      if (r.height) bottom = Math.max(bottom, r.bottom + window.scrollY);
    });
    return Math.ceil(bottom) + 2;
  }

  function fit(Homey) {
    const h = contentHeight();
    if (!fit.ready) {
      fit.ready = true;
      fit.last = h;
      Homey.ready({ height: h });
      return;
    }
    if (h === fit.last || typeof Homey.setHeight !== 'function') return;
    fit.last = h;
    Homey.setHeight(h).catch(() => {});
  }

  window.PbthFlow = {
    draw, fit, contentHeight,
  };
}());
