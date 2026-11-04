# Power by the Hour

**Your own Energy Management System (EMS) on Homey.**
Lowest energy costs, most self-consumption. Set up from your phone.

<img src="./assets/images/large.jpg" alt="Power by the Hour" width="500"/>

---

## ⚡ What is an EMS?

- **Measures** use, solar production, import and export.
- **Predicts** prices, solar yield and home load.
- **Plans** when the battery, car and appliances run.
- **Controls** them, automatically.

---

## 🧠 The heart: smart planning

- **🔋 Smart battery:** plans charge and discharge on prices, solar and home load. Cheapest total, including losses and wear. [How](./README.battery.md#how-smart-works)
- **🚗 Smart EV charging:** learns when you leave, charges at the cheapest hours or on solar, ready on time. [How](./README.evCharger.md#how-smart-works)
- **☀️ Self-learning solar forecast:** no orientation or panel data needed. Learns shade by itself. [How](./README.solar.md#how-the-forecast-works)
- **⚡ Appliances:** learns programs, plans the cheapest start for the washing machine or dishwasher. [How](./README.power.md#appliance-forecast--planner)

**No battery? No problem.** Prices, meters, forecasts, EV charging and appliances all work without one.

---

## ✅ Why Power by the Hour

- **Any brand:** P1 meters, inverters, batteries, EV chargers, washing machines. Anything with a meter in Homey, or via flow.
- **Any contract:** dynamic (15 min or hourly) or fixed, with or without netting, capacity tariff, any currency.
- **Your goal:** lowest costs, most self-consumption, or both.
- **Easy:** a wizard at pairing. If you can use a smartphone, you can set up your EMS.
- **Self-learning:** home load, solar yield, car trips and appliance programs.
- **Safe:** keeps the main fuse and capacity peaks in check.

---

## 🧩 Devices

| Device | What it does | Guide |
|---|---|---|
| 💶 Energy Price | Your real price: market or fixed, all markups and taxes | [price](./README.price.md) |
| 🔌 Grid Monitor | Import/export, home load, capacity peaks, load forecast | [grid](./README.grid.md) |
| ☀️ Solar Monitor | Production, self-learning solar forecast | [solar](./README.solar.md) |
| 🔋 Smart Battery | Plans and controls home batteries | [battery](./README.battery.md) |
| 🚗 Smart EV Charger | Charges at the cheapest time or on solar, ready for departure | [evCharger](./README.evCharger.md) |
| ⚡ Power Monitor | Use per appliance, standby, cheapest program start | [power](./README.power.md) |
| 🛢️ Gas Monitor | Gas use and costs | [gas](./README.gas.md) |
| 💧 Water Monitor | Water use, costs, leak check | [water](./README.water.md) |

---

## 🚀 Quick Start

1. Add an **Energy Price** device: zone and contract, tariff group `1`.
2. Add a **Grid Monitor**: pick your P1 or main meter.
3. Add a **Solar Monitor**: pick your inverter.
4. Optional: battery, EV charger, appliances, gas, water.
5. Done. Prices, forecasts and plans run by themselves; flows are optional.

**Good to know**
- **Tariff group:** devices with the same number share one price device.
- **Repair:** change source, budget, price or totals later.
- **Year budget:** compare your use with a budget, spread over the year by your local climate.
- **Virtual meter:** no Homey device? Pair `VIRTUAL_VIA_FLOW` and send readings by flow.

---

## 📡 Data Sources & Credits

- **[ENTSO-E](https://newtransparency.entsoe.eu/):** electricity prices ([terms](https://transparency.entsoe.eu/content/static_content/Static%20content/data%20terms%20and%20conditions/data-terms-and-conditions.html))
- **[Nord Pool](https://www.nordpoolgroup.com/):** electricity prices ([terms](https://www.nordpoolgroup.com/en/About-us/Terms-and-conditions-for-website-use/))
- **[SMARD | Bundesnetzagentur](https://www.smard.de/en):** electricity prices, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([terms](https://www.smard.de/en/datennutzung))
- **[OMIE](https://www.omie.es/):** electricity prices Spain and Portugal ([terms](https://www.omie.es/es/aviso-legal))
- **[EnergyZero](https://www.energyzero.nl/):** electricity and gas prices NL ([terms](https://www.energyzero.nl/voorwaarden))
- **[EEX](https://www.eex.com/):** TTF gas prices ([terms](https://www.eex.com/en/terms-of-use))
- **[EasyEnergy](https://www.easyenergy.com/) / [Nieuwestroom](https://www.nieuwestroom.nl/):** TTF LEBA gas prices ([terms](https://www.nieuwestroom.nl/voorwaarden/))
- **[Stekker.ai](https://stekker.ai/):** price forecasts ([terms](https://stekker.app/terms))
- **[Open-Meteo](https://open-meteo.com/):** weather, solar radiation and climate history ([terms](https://open-meteo.com/en/terms))
- **[PVGIS](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en) (EU JRC):** solar climate data for the year budget
- **[ECB](https://www.ecb.europa.eu/):** exchange rates ([terms](https://www.ecb.europa.eu/services/disclaimer/html/index.en.html))
- **[QuickChart](https://quickchart.io/):** chart images ([terms](https://quickchart.io/terms/))

---

## 👨‍💻 Developer API

- `GET /prices`: all prices from now on.
- Realtime event `prices-updated`: new slot or new prices.
- Full reference: **[README.prices-api.md](./README.prices-api.md)**

---

## ❤️ Donate & Support

- Questions: [Homey Community](https://community.homey.app/t/20535)
- Bugs: [GitHub issues](https://github.com/gruijter/com.gruijter.powerhour/issues)
- Like the app? [![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.me/gruijter)
