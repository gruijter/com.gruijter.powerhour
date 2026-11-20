/* eslint-disable no-console */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SNAP = path.join(__dirname, 'snap');
const LOG = path.join(__dirname, 'calls.log');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'));
const NAMES = fs.existsSync(path.join(__dirname, 'names.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'names.json'), 'utf8')) : {};
const { TOKEN, ADDRESS } = process.env;
const PORT = Number(process.env.PORT || 8765);

const defaults = (w) => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, `widgets/${w}/widget.compose.json`), 'utf8'));
  return Object.fromEntries((c.settings || []).map((s) => [s.id, s.value]));
};

const mock = (w, extra) => `<script>
(function () {
  var EN = ${JSON.stringify(EN)};
  var S = ${JSON.stringify({ ...defaults(w), ...extra })};
  window.Homey = {
    __: function (k) { var v = k.split('.').reduce(function (o, p) { return o && o[p]; }, EN); return typeof v === 'string' ? v : k; },
    api: function (m, p) { return fetch('/api/${w}' + p).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); },
    getSettings: function () { return S; },
    onSettings: function () {},
    ready: function () { window.__ready = true; },
    setHeight: function () {},
    hapticFeedback: function () {},
    getWidgetInstanceId: function () { return 'manual-${w}'; },
    getDeviceIds: function () { return []; },
  };
})();
</script>`;

const rename = (json) => {
  let s = json;
  Object.entries(NAMES).sort((a, b) => b[0].length - a[0].length).forEach(([from, to]) => {
    s = s.split(JSON.stringify(from)).join(JSON.stringify(to));
  });
  return s;
};

const snapFile = (w, p) => path.join(SNAP, `${w}_${Buffer.from(p).toString('base64url')}.json`);

const handle = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const api = url.pathname.match(/^\/api\/([a-z]+)(\/.*)?$/);
    if (api) {
      const w = api[1];
      const p = (api[2] || '/') + url.search;
      fs.appendFileSync(LOG, `${w} ${p}\n`);
      const file = snapFile(w, p);
      let body;
      if (fs.existsSync(file)) body = fs.readFileSync(file, 'utf8');
      else if (process.env.LIVE === '1') {
        const r = await fetch(`${ADDRESS}/api/app/com.gruijter.powerhour/widget/${w}/api${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        body = await r.text();
      } else {
        res.writeHead(404);
        res.end('no snapshot');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(rename(body));
      return;
    }
    const m = url.pathname.match(/^\/w\/([a-z]+)\/(.*)$/);
    if (!m) {
      res.writeHead(404);
      res.end();
      return;
    }
    const [, w, rest] = m;
    const file = path.join(ROOT, 'widgets', w, 'public', rest || 'index.html');
    let data = fs.readFileSync(file);
    if ((rest || 'index.html') === 'index.html') {
      const extra = JSON.parse(url.searchParams.get('s') || '{}');
      const style = '<style>html,body{background:#fff;margin:0}</style>';
      data = String(data).replace('<head>', `<head>${style}${mock(w, extra)}`);
    }
    const TYPES = { css: 'text/css', js: 'text/javascript' };
    const type = TYPES[file.split('.').pop()] || 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
};

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500);
    res.end(String(err));
  });
}).listen(PORT, () => console.log(`listening ${PORT}`));
