# Tests

Dev only: `/test/` is in `.homeyignore`, so nothing here ends up in the app package.

```bash
npm test                      # all offline unit tests (same as node test/run.js)
node test/run.js battery      # only cases whose file name contains 'battery'
node test/cases/ev_planner.js # one case directly
```

Exit code is non-zero if anything fails.

## Layout

| Path | What |
| --- | --- |
| `run.js` | Runner: each `cases/*.js` in its own process (with `--expose-gc`) |
| `cases/` | Offline unit tests of `lib/strategies/*` and `lib/PriceFormula.js`, no Homey, no network |
| `fixtures/` | Reference data, e.g. a real `energy.getLiveReport()` result |
| `solar/` | Solar learning regression set; read `solar/README.md` first. `solar/data/` is gitignored (real user data) |
| `provider.js` | Live, interactive check of the price providers (network, some need an API key) |
| `terms.js` | Translation consistency report over all 13 languages; run after UI text changes. Writes `all_terms.json` (gitignored) |

## Cases

| File | Covers |
| --- | --- |
| `battery_control.js` | BatteryControl, BatteryResponse, NomXomStrategy, light planner hooks |
| `battery_efficiency.js` | BatteryEfficiency (learned efficiency curve) |
| `battery_forecast.js` | RoiStrategy (LP) with a per-slot net forecast, group plans |
| `battery_light.js` | RoiLightStrategy against the LP, BatterySplit |
| `ev_planner.js` | EvPlanner, EvPriceProfile, energy modes |
| `ev_presence_soc_control.js` | EvPresence, EvSocEstimator, EvChargerControl, EvEnergyMode |
| `ev_usage_model.js` | EvUsageModel (trip learning) |
| `peak_tariff.js` | PeakTariff (capacity tariff presets and peaks) |
| `price_formula.js` | PriceFormula parser, equal to PriceCalculator |
| `xom_strategy.js` | NomXomStrategy distribution over batteries |

## Adding a case

A case is a plain Node script in `cases/` that requires the code under test with `../../lib/...` and
sets `process.exitCode = 1` (or throws) on failure. The runner picks it up automatically.

Not covered yet: device/driver code (needs a Homey mock), flow cards, settings migration, the grid
driver (settlement schemes, load forecast), solar forecast outside `solar/`.
