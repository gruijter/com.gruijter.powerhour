'use strict';

(function pbthChart() {
  function monoPath(pts, move) {
    const n = pts.length;
    const f = (v) => v.toFixed(2);
    if (!n) return '';
    let p = `${move === false ? 'L' : 'M'}${f(pts[0][0])} ${f(pts[0][1])}`;
    if (n === 1) return p;
    const dx = [];
    const m = [];
    const tg = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = pts[i + 1][0] - pts[i][0];
      m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
    }
    tg[0] = m[0];
    tg[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i += 1) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i += 1) {
      if (m[i] === 0) {
        tg[i] = 0;
        tg[i + 1] = 0;
      } else {
        const a = tg[i] / m[i];
        const b = tg[i + 1] / m[i];
        const s = a * a + b * b;
        if (s > 9) {
          tg[i] = (3 / Math.sqrt(s)) * a * m[i];
          tg[i + 1] = (3 / Math.sqrt(s)) * b * m[i];
        }
      }
    }
    for (let i = 0; i < n - 1; i += 1) {
      const h = dx[i] / 3;
      p += `C${f(pts[i][0] + h)} ${f(pts[i][1] + tg[i] * h)} ${f(pts[i + 1][0] - h)} ${f(pts[i + 1][1] - tg[i + 1] * h)}`
        + ` ${f(pts[i + 1][0])} ${f(pts[i + 1][1])}`;
    }
    return p;
  }

  window.PbthMonoPath = monoPath;
}());
