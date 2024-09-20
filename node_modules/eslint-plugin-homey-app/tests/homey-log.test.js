'use strict';

const rule = require('../rules/homey-log');
const RuleTester = require('eslint').RuleTester;
const ruleTester = new RuleTester();

ruleTester.run('homey-log', rule, {
  valid: [
    `test(a, b)`,
    `this.log('message')`,
    `this.error('message')`,
    `this.console.log('message')`,
    `this.console.error('message')`,
  ],

  invalid: [
    {
      code: `console.log('message')`,
      errors: [
        {
          messageId: 'unexpected',
          suggestions: [
            {
              messageId: 'homeyLogFix',
              data: { propertyName: 'log' },
              output: `this.log('message')`,
            },
          ],
        },
      ],
    },

    {
      code: `console.error('message')`,
      errors: [
        {
          messageId: 'unexpected',
          suggestions: [
            {
              messageId: 'homeyLogFix',
              data: { propertyName: 'error' },
              output: `this.error('message')`,
            },
          ],
        },
      ],
    },
  ],
});
