'use strict';

(function pbthPeriodCache() {
  const MAX_AGE = {
    hour: 300000, day: 900000, month: 3600000, year: 3600000,
  };

  function periodKey(p) {
    const d = new Date();
    if (p === 'hour') return `${d.toDateString()} ${d.getHours()}`;
    if (p === 'day') return d.toDateString();
    if (p === 'month') return `${d.getFullYear()}-${d.getMonth()}`;
    return String(d.getFullYear());
  }

  window.PbthPeriodCache = function create() {
    let cache = {};
    return {
      pending: {},
      get(p) {
        return cache[p] ? cache[p].data : null;
      },
      fresh(p) {
        const c = cache[p];
        return !!c && p !== 'now' && c.key === periodKey(p) && Date.now() - c.ms <= MAX_AGE[p];
      },
      put(p, data) {
        cache[p] = { data, ms: Date.now(), key: periodKey(p) };
      },
      clear() {
        cache = {};
      },
    };
  };
}());
