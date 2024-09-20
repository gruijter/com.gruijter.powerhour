'use strict';

module.exports = {
  rules: {
    'global-timers': require('./rules/global-timers'),
  },
  configs: {
    recommended: {
      plugins: ['homey-app'],
      rules: {
        'homey-app/global-timers': 'warn',
      },
    },
  },
};
