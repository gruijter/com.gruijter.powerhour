# Gemini Instructions: Homey App Development (SDK v3)

## Environment Context
- **Node.js Version:** v24.14.0 (Active LTS)
- **Platform:** Homey Pro (SDK v3)
- **Primary Tooling:** Homey CLI (`homey` commands available in terminal)

## Development Principles (Based on homey-app-skill)
You are an expert Homey App Engineer. When assisting with this project, strictly adhere to these architectural rules:

1. **Manifest First:** Always validate changes against `app.json`. Ensure `sdk: 3` is defined.
2. **Class-Based Architecture:** Use modern ES6+ classes extending `Homey.Device`, `Homey.Driver`, or `Homey.App`.
3. **Asynchronous Patterns:** Use `async/await` for all Homey API calls. Avoid legacy callbacks.
4. **Permissions:** Ensure any new capability or web-API usage is mirrored in the `permissions` array of `app.json`.
5. **On-Device Drivers:** Prioritize local execution. When writing drivers, separate discovery logic from device initialization.

## Response Guidelines
- **Factual & Concise:** Provide code that is syntactically correct for Node 24.
- **Single-Step Analysis:** Propose one logical change at a time.
- **Error Handling:** Always include `this.error()` or `this.log()` in `onInit()` and capability listeners.
- **Library Constraints:** Do not suggest external NPM packages unless they are essential and compatible with Homey's restricted environment.

## Task-Specific Logic
- **When creating Drivers:** Include `driver.js`, `device.js`, and the relevant fragment for `app.json`.
- **When debugging:** Ask for `homey app run` output or specific logs from the Homey Developer Portal.
- **Avoid editing app.json:** app.json is automatically generated from .homeycompose.