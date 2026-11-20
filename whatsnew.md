# ⚡ Power by the Hour v9: test version

v9 turns the app into your own **Energy Management System**: it measures, predicts, plans and controls. **Big rewrite: expect bugs.**

⚠️ **Make a Homey backup first.** There is no way back to v8.
👉 **Install:** https://homey.app/a/com.gruijter.powerhour/test/ (devices, totals, Insights and flows are kept)

## 🆕 New

- **💶 [Energy Price](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.price.md):** one device for power, gas and water, any contract and currency.
- **🔋 [Smart Battery](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.battery.md):** built-in modes and control.
- **🚗 [Smart EV Charger](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.evCharger.md):** charges cheap or on solar, ready on time.
- **🔌 [Grid](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.grid.md):** peak shaving, fuse guard, home load forecast.
- **☀️ [Solar](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.solar.md)** and **⚡ [appliance](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.power.md)** forecasts that learn by themselves.
- **📊 [Widgets](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.widgets.md)** for your dashboard.
- **📱 Setup from your phone**, changes later via **Repair**. Far fewer flow cards.

## ✅ After installing

- **Prices:** add an **Energy Price** device and use **Take over settings** on your old `dap`/`dap15`/`dapg` device. Move your price flows (the timeline lists them), then delete the old device.
- **Meters:** settings are now in **Repair**. Grid: check phases, fuse and capacity tariff. Heat pump or airco: tick **Heating or cooling**. Check your Homey Energy overview.
- **Battery:** either tick **Let the app control the battery**, pick a [mode](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.battery.md#modes) and remove your own (dis)charge flows; or leave it off and use **New planned battery power**. Homey Pro 2019 / Early 2023: leave **Extra precise planning** off.
- **Flows:** old cards still work but are deprecated; move to the new ones.
- **App developers:** `/dap-prices` is now [`GET /prices`](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/manual/README.prices-api.md), event `prices-updated`.

🐞 **Problems?** Send a diagnostic report (app Settings) and post the time and what went wrong here or on [GitHub](https://github.com/gruijter/com.gruijter.powerhour/issues).
