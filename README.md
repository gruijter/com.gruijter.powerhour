# Power by the Hour

**Power by the Hour (PBTH)** turns Homey into a complete Home Energy Management System. Track electricity, gas and water use and costs, forecast solar production and home load, plan and control home batteries and EV charging, and plan appliances at the cheapest moment, with dynamic (15 min or hourly) or fixed energy prices.

<img src="./assets/images/large.jpg" alt="Power by the Hour" width="500"/>

---

## 🎯 Use Case Directory

Select a use case below for setup instructions, settings and flow cards:

| Use Case | Device | Guide |
|---|---|---|
| 💶 **Electricity & Gas Prices (dynamic or fixed, 15 min or 1 hour)** | Energy Price (`price`) | [→ README.price.md](./README.price.md) |
| 🔌 **Grid Import/Export, Home Load, Capacity Tariff & Load Forecast** | Grid Monitor (`grid`) | [→ README.grid.md](./README.grid.md) |
| ☀️ **Solar Production, Forecast & Self-Consumption** | Solar Monitor (`solar`) | [→ README.solar.md](./README.solar.md) |
| 🔋 **Plan & Control Home Batteries** | Smart Battery Charger (`battery`) | [→ README.battery.md](./README.battery.md) |
| 🚗 **Smart EV Charging** | Smart EV Charger (`evCharger`) | [→ README.evCharger.md](./README.evCharger.md) |
| ⚡ **Electricity Use, Standby Power & Appliance Planner** | Power Monitor (`power`) | [→ README.power.md](./README.power.md) |
| 🛢️ **Gas Use & Constant Flow Check** | Gas Monitor (`gas`) | [→ README.gas.md](./README.gas.md) |
| 💧 **Water Use & Leak Check** | Water Monitor (`water`) | [→ README.water.md](./README.water.md) |
| 💻 **App-to-App & HomeyScript Developer API** | Inter-App API | [→ README.dap-api.md](./README.dap-api.md) |

---

## 🚀 Quick Start

1. **Energy Price:** add an *Energy Price* device. The wizard asks for your bidding zone (pre-filled from your Homey's location), the amounts from your contract, and a **Tariff group** (e.g. `1`).
2. **Grid Monitor:** add a *Grid Monitor* for your P1 smart meter or main meter, with the same tariff group.
3. **Solar Monitor** (if you have solar panels): add one for the device that measures your solar production, and fill in **Peak Power (W)**.
4. **More devices** (optional): a *Smart Battery Charger* for your home battery, a *Smart EV Charger* for your car, a *Power Monitor* per appliance or sub-meter, a *Gas Monitor* and a *Water Monitor*.

Every device in the tariff group now follows your real price, each price period (15 minutes or 1 hour). The battery and EV planners use the prices together with the solar and home load forecasts.

---

## 💡 Shared Concepts

### 1. Pairing
Pick the source device from the list: the likely ones are listed first. A setup view then asks for the key settings and shows which capabilities of the source device are used, with the option to choose others. The new device gets the name of the source device. **Repair** lets you switch to another source device later; the device keeps its name.

### 2. Tariff Groups
A tariff group links an *Energy Price* device to the other devices: Grid, Power, Solar, Gas, Battery and EV charger.
- Give the price device and the other devices the same **Tariff group** number (e.g. `1`).
- Every price period the price device sends the current price to all devices in its group.
- Without a price device, the flow card **Set a new tariff** sets the tariff of a group (energy, gas or water). Group `0`: no updates.

### 3. Year Budget
Power, Grid, Solar, Gas and Water Monitors can compare the use with a year budget, distributed over the year:
- **Linear:** the same every day.
- **NL price ceiling 2023:** more in winter, for electricity and gas.
- **PV N-Europe, tilt 40°S:** a typical solar production curve.
- **Custom:** 12 monthly values.

### 4. Virtual Meter
For a meter that is not a Homey device, or that needs a calculation first:
1. Pair `VIRTUAL_VIA_FLOW` (Power, Grid, Solar, Gas or Water Monitor).
2. Send the cumulative reading with the flow card **Send reading to virtual meter**.
3. For electricity, send the total net kWh: `(consumed_high + consumed_low) - (returned_high + returned_low)`.

---

## 📡 Data Sources, Online Services & Credits

Power by the Hour integrates data from external market data providers and online services to retrieve spot pricing, forecasts, exchange rates, and chart rendering.

### 🌐 Data Sources & Credits
- **ENTSO-E (European Network of Transmission System Operators for Electricity):** The electricity pricing information is fetched from ENTSO-E.
  - Website: [ENTSO-E Transparency Platform](https://newtransparency.entsoe.eu/)
  - Terms of Use: [ENTSO-E Data Terms and Conditions](https://transparency.entsoe.eu/content/static_content/Static%20content/data%20terms%20and%20conditions/data-terms-and-conditions.html)
- **EEX (European Energy Exchange):** The TTF Gas spot pricing (EOD and EGSI) is coming from EEX.
  - Website: [EEX](https://www.eex.com/)
  - Terms of Use: [EEX Terms of Use](https://www.eex.com/en/terms-of-use)
- **EasyEnergy / Nieuwestroom:** The TTF LEBA gas pricing is derived from EasyEnergy as seen on [Nieuwestroom Gas Handelsbeurs](https://www.nieuwestroom.nl/energiemarkt/energiebeurzen/gas-handelsbeurs/).
  - Website: [EasyEnergy](https://www.easyenergy.com/) | [Nieuwestroom](https://www.nieuwestroom.nl/)
  - Terms of Use: [Nieuwestroom Voorwaarden](https://www.nieuwestroom.nl/voorwaarden/)
- **EnergyZero:** Dynamic electricity and gas retail prices for the Netherlands.
  - Website: [EnergyZero](https://www.energyzero.nl/)
  - Terms of Use: [EnergyZero Algemene Voorwaarden](https://www.energyzero.nl/voorwaarden)
- **Nord Pool:** Day-ahead electricity spot prices for Nordic, Baltic, and European bidding zones.
  - Website: [Nord Pool Group](https://www.nordpoolgroup.com/)
  - Terms of Use: [Nord Pool Terms & Conditions](https://www.nordpoolgroup.com/en/About-us/Terms-and-conditions-for-website-use/)
- **OMIE (Operador del Mercado Ibérico de Energía):** Day-ahead spot prices for the Iberian market (Spain and Portugal). OMIE is the market operator that runs the MIBEL auction, so it is the primary source for these zones.
  - Website: [OMIE](https://www.omie.es/)
  - Terms of Use: [OMIE Aviso Legal](https://www.omie.es/es/aviso-legal)
- **Open-Meteo:** Solar radiation and weather forecast data for solar production forecasting.
  - Website: [Open-Meteo](https://open-meteo.com/)
  - Terms & License: [Open-Meteo Terms & Attribution](https://open-meteo.com/en/terms)
- **SMARD | Bundesnetzagentur:** Day-ahead electricity spot prices for the German market area and its neighbouring bidding zones, used as an independent backup source.
  - Website: [SMARD.de](https://www.smard.de/en)
  - Terms of Use: [SMARD Data Use](https://www.smard.de/en/datennutzung)
  - License: Data licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attributed to **Bundesnetzagentur | SMARD.de**.
- **Stekker.ai:** AI price forecasting and smart charging optimization data.
  - Website: [Stekker.ai](https://stekker.ai/)
  - Terms of Use: [Stekker Terms](https://stekker.app/terms)
- **European Central Bank (ECB):** Foreign exchange reference rates for multi-currency conversion.
  - Website: [European Central Bank](https://www.ecb.europa.eu/)
  - Terms of Use: [ECB Copyright & Disclaimer](https://www.ecb.europa.eu/services/disclaimer/html/index.en.html)

### 📊 Online Services & Tools
- **QuickChart:** Online chart rendering service used to generate dynamic graph images for Homey devices and flow notifications.
  - Website: [QuickChart](https://quickchart.io/)
  - Terms of Use: [QuickChart Terms of Service](https://quickchart.io/terms/)

---

## 👨‍💻 Developer API

Other Homey apps and HomeyScript can query prices or listen for real-time slot pushes via the PBTH Inter-App API:
- `GET /dap-prices` — fetch all current future price slots.
- Realtime event `dap-prices-updated` — emitted on slot changes and price updates.

See **[README.dap-api.md](./README.dap-api.md)** for full API reference and code examples.

---

## ❤️ Donate & Support

If Power by the Hour helps you save energy and money, consider supporting development:

[![Donate with PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.me/gruijter)