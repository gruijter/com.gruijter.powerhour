# eslint-config-athom
ESLint config for Athom B.V. JavaScript projects.

## Usage

In your JavaScript project:

```bash
$ npm install --save-dev eslint eslint-config-athom
```

Then create a file `/.eslintrc.json` in your project's root:

```javascript
{
  "extends": "athom"
}
```

Now, edit your project's `/package.json` file to contain the following:

```json
"engines": {
  "node": ">=12.16.1"
}
```

## Homey App config

This package also contains a ESLint config for Homey Apps, you can extend it like this:

```javascript
{
  "extends": "athom/homey-app"
}
```

This config includes some rules that depend on TypeScript typechecking so you need to make sure to have a `tsconfig.json` file in the root of your Homey App.
To make this work as intended you should also have the `node-homey-apps-sdk-v3-types` installed by running:

```bash
$ npm install --save-dev @types/homey@npm:homey-apps-sdk-v3-types
```
