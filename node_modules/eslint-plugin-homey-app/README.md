# ESLint Plugin for Homey Apps

This module adds ESLint rules that enforce best practices for Homey Apps.

## Installation

To use this module you also need to install ESLint:

```bash
$ npm install --save-dev eslint eslint-plugin-homey-app
```

## Usage

After installation can extend the recommended rules from your ESLint configuration file:

```json
{
  "extends": ["plugin:homey-app/recommended"]
}
```