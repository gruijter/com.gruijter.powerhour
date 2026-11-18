/*
Copyright 2019 - 2026, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const BAND_PCT = 20;
const OFFSET_PCT = 1;
const RUN_W = 50;
const LAG_W = 150;
const LAG_SHARE = 0.1;
const SETTLE_MS = 90 * 1000;
const SAMPLE_MS = 60 * 1000;
const ALPHA = 0.1;
const MIN_N = 10;

const createState = () => ({ charge: null, discharge: null });

const roomPct = (dir, socPct) => (dir === 'charge' ? 100 - socPct : socPct) + OFFSET_PCT;

const onTick = (state, {
  now, socPct, setW, actW, setChangeTm, capped = false,
}) => {
  const s = state || createState();
  if (typeof setW !== 'number' || typeof socPct !== 'number' || !Number.isFinite(actW) || Math.abs(setW) < RUN_W) {
    return { state: s, sample: null };
  }
  const dir = setW > 0 ? 'charge' : 'discharge';
  const sign = setW > 0 ? 1 : -1;
  const doneW = sign * actW;
  const room = roomPct(dir, socPct);
  if (room - OFFSET_PCT > BAND_PCT || doneW < RUN_W) return { state: s, sample: null };
  const lag = Math.abs(setW) - doneW >= Math.max(LAG_W, LAG_SHARE * Math.abs(setW));
  const settled = capped || (typeof setChangeTm === 'number' && now - setChangeTm >= SETTLE_MS);
  const prev = s[dir];
  if (!lag || !settled || (prev && now - prev.tm < SAMPLE_MS)) return { state: s, sample: null };
  const k = doneW / room;
  const next = prev ? { k: prev.k + (ALPHA * (k - prev.k)), n: prev.n + 1, tm: now } : { k, n: 1, tm: now };
  return {
    state: { ...s, [dir]: next },
    sample: {
      dir, socPct, w: doneW, k,
    },
  };
};

const learned = (state, dir) => !!(state && state[dir] && state[dir].n >= MIN_N && state[dir].k > 0);

const limitW = (state, dir, socPct) => (learned(state, dir) ? state[dir].k * Math.max(0, roomPct(dir, socPct)) : Infinity);

const planLimits = (state, { capKwh, reservePct = 0 }) => {
  if (!(capKwh > 0)) return {};
  const out = {};
  if (learned(state, 'charge')) {
    const { k } = state.charge;
    out.chargeLimit = { a: k * (100 - reservePct + OFFSET_PCT), b: (100 * k) / capKwh };
  }
  if (learned(state, 'discharge')) {
    const { k } = state.discharge;
    out.dischargeLimit = { a: k * (reservePct + OFFSET_PCT), b: (100 * k) / capKwh };
  }
  return out;
};

const describe = (state) => ['charge', 'discharge'].map((dir) => {
  const d = state && state[dir];
  if (!d) return `${dir} -`;
  const at = (pct) => Math.round(d.k * (pct + OFFSET_PCT));
  return `${dir} ${at(5)} W at 5 % room, ${at(10)} W at 10 % (${d.n} samples${learned(state, dir) ? '' : ', learning'})`;
}).join('; ');

module.exports = {
  createState,
  describe,
  learned,
  limitW,
  onTick,
  planLimits,
};
