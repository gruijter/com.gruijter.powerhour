# ⚡ Power by the Hour v9: test version available

v9 turns Power by the Hour into your own **Energy Management System** on Homey: it measures, predicts, plans and controls.

**This is a huge rewrite of the app. Expect bugs!** In return you get:
- Much simpler setup and configuration.
- Far fewer flow cards, that still do all you need and more.

⚠️ **Make a Homey backup first.** After migration there is no way back to v8.

👉 **Install the test version:** https://homey.app/a/com.gruijter.powerhour/test/
Your v8 devices, totals, Insights and flows are kept.

---

## 🆕 What's new

- **💶 Energy Price:** one new price device for power, gas and water. Almost any contract in the EU and worldwide: dynamic or fixed, with all markups and taxes, any currency. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.price.md)
- **🔋 Smart Battery:** fully automatic, built-in modes and control. Plans on prices, solar and home load, and learns its own losses. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.battery.md)
- **🚗 Smart EV Charger:** learns when you leave, charges cheap or on solar, ready on time. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.evCharger.md)
- **🔌 Grid Monitor:** peak shaving for capacity tariffs, main fuse and per-phase guard, self-learning home load forecast. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.grid.md)
- **☀️ Solar:** self-learning forecast, no panel data needed. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.solar.md)
- **⚡ Appliances:** learns programs, plans the cheapest start. [Guide](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.power.md)
- **📱 Setup from your phone:** a wizard at pairing, and **Repair** to change source, price, budget or totals later.
- **📈 Year budget:** spread over the year by your local climate.

---

## ✅ After installing: what to do

**Prices**
- Add an **Energy Price** device and use **Take over settings** to copy your old `dap`, `dap15` or `dapg` device. [How](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.price.md#from-the-old-day-ahead-price-drivers)
- The new device takes over the tariff group.
- Move your price flows to the new cards (the timeline lists the old ones), then **delete the old price device**.

**Meters (grid, solar, power, gas, water)**
- Price and tariff settings are now in **Repair**, not in the device settings.
- Grid: check phases, main fuse and capacity tariff in **Repair**.

**Battery**
- Choose how the battery is controlled: [Control](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.battery.md#control)
  - **Built-in:** tick **Let the app control the battery** and pick a [mode](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.battery.md#modes). Then **remove your own (dis)charge flows**, or they will fight the app.
  - **By flows:** leave control off and use **New planned battery power** or **New XOM power available**.
- The old **ROI** cards still work but are deprecated: replace them with the new plan cards.
- Several batteries? They now plan as one group.
- Older Homey (Pro 2019 or Early 2023)? Leave **Extra precise planning** off: it uses much more memory.

**Flows**
- Old cards show as deprecated. They still work, but move to the new cards when you can.
- App developers: use `GET /prices` and the realtime event `prices-updated`. The v8 names `/dap-prices` and `dap-prices-updated` are gone. [API](https://github.com/gruijter/com.gruijter.powerhour/blob/beta-v9/README.prices-api.md)

---

🐞 **Problems?** Send a diagnostic report (Homey app → Power by the Hour → Settings) and post the time and what went wrong here, or on [GitHub](https://github.com/gruijter/com.gruijter.powerhour/issues).
