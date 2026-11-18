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

const EVERY_MS = 24 * 60 * 60 * 1000;

const stateOf = (homey) => {
  let app = null;
  try {
    app = homey.app;
  } catch {
  }
  const holder = app || homey;
  if (!holder.setupNotices) holder.setupNotices = {};
  return holder.setupNotices;
};

const notify = async (homey, key, detail, excerpt, now = Date.now()) => {
  try {
    const notices = stateOf(homey);
    const last = notices[key];
    if (last && last.detail === detail && now - last.at < EVERY_MS) return false;
    notices[key] = { detail, at: now };
    await homey.notifications.createNotification({ excerpt });
    return true;
  } catch (error) {
    try {
      homey.app.error('Setup notification failed:', error);
    } catch {
    }
    return false;
  }
};

const clear = (homey, key) => {
  try {
    delete stateOf(homey)[key];
  } catch {
  }
};

module.exports = { notify, clear, EVERY_MS };
