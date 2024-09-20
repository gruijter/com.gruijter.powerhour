"use strict";

module.exports = {
  "extends": [
    "./index.js",
    "plugin:@typescript-eslint/recommended",
    "plugin:homey-app/recommended",
  ],

  "parserOptions": {
    "sourceType": "script",
    "project": "./tsconfig.json",
  },

  "rules": {
    "node/no-missing-import": ["error", { "allowModules": ["homey"] }],
    "node/no-unsupported-features/es-syntax": ["error", { "ignores": ["modules"] }],

    "@typescript-eslint/no-var-requires": "off",
    "@typescript-eslint/no-floating-promises": ["error", { "ignoreVoid": false }],
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { "vars": "all", "args": "none", "ignoreRestSiblings": true }
    ],
  },
};
