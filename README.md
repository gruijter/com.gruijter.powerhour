# Power by the Hour

**Power by the Hour (PBTH)** turns Homey into a complete Home Energy Management System. Track power, gas, and water usage, forecast solar yield, optimize home battery storage, and automate appliances using dynamic European Day-Ahead energy spot prices.

<img src="./assets/images/large.jpg" alt="Power by the Hour" width="500"/>

---

## 🎯 Use Case Directory

Select a use case below for detailed setup instructions, settings guides, and community-proven flow recipes:

| Use Case | Core Driver | Detailed Guide |
|---|---|---|
| ⚡ **Track Electricity Usage & Standby Power** | Power Summarizer (`power`) | [→ README.power.md](./README.power.md) |
| 🛢️ **Monitor Gas Consumption & Leak Alarms** | Gas Summarizer (`gas`) | [→ README.gas.md](./README.gas.md) |
| 💧 **Track Water Usage & Dripping Taps** | Water Summarizer (`water`) | [→ README.water.md](./README.water.md) |
| ☀️ **Forecast Solar Production & Self-Consumption** | Solar Forecaster (`solar`) | [→ README.solar.md](./README.solar.md) |
| 🔋 **Optimize Home Battery Balancing & ROI** | Home Battery Manager (`battery`) | [→ README.battery.md](./README.battery.md) |
| 💶 **Dynamic Electricity Spot Prices (1H & 15M)** | Day-Ahead Pricing (`dap` / `dap15`) | [→ README.dap.md](./README.dap.md) |
| ⚡ **Dynamic Gas Spot Prices** | Gas Day-Ahead Pricing (`dapg`) | [→ README.dapg.md](./README.dapg.md) |
| 💻 **App-to-App & HomeyScript Developer API** | Inter-App API | [→ README.dap-api.md](./README.dap-api.md) |

---

## 🚀 Quick Start — The Most Popular Setup

Get dynamic electricity tracking running in 3 simple steps:

1. **Add Day-Ahead Pricing:** Add a `Day-ahead Pricing` device, select your Bidding Zone (e.g. `NL`, `BE`, `DE-LU`, `NO1`, `SE3`, `DK1`), and set **Tariff Update Group** to `1` in device settings.
2. **Add Power Summarizer:** Add a `Power Summarizer` device and select your P1 Smart Meter or main energy meter as the source.
3. **Connect Tariff Broadcast:** Set **Tariff Update Group** to `1` in the Power Summarizer settings.

*Your Power Summarizer now updates its electricity tariff automatically every hour based on official market spot prices!*

---

## 💡 Shared Core Concepts

To avoid repeating configuration steps across guides, key shared mechanisms are explained here:

### 1. Tariff Update Groups
Tariff Update Groups link pricing providers (`dap`, `dap15`, `dapg`) to consumer summarizer devices (`power`, `gas`).
- Assign a group number (e.g. `1`) to both the pricing device and the summarizer device.
- Whenever prices update or time slots change, the pricing device automatically broadcasts updated tariffs to all summarizers in that group.

### 2. Annual Budget Distribution Models
PBTH compares real-time usage against annual reference targets using seasonal distribution models:
- **Linear:** Equal allocation for each month ($30.4\text{ days/month}$).
- **Dutch 2023 Price Ceiling (`el_nl_2023` / `gas_nl_2023`):** Weighted according to seasonal heating and household consumption profiles.
- **Solar PV:** Weighted according to typical European solar irradiance curves.

### 3. Virtual Meter Setup
For source devices with non-standard capability names or split tariffs:
1. Select **VIRTUAL_METER** during driver pairing.
2. Push cumulative meter readings via a Flow using the action **Update Virtual Meter Value**.
3. Pass total net cumulative energy: $\text{kWh}_{\text{total}} = (\text{consumed}_{\text{high}} + \text{consumed}_{\text{low}}) - (\text{returned}_{\text{high}} + \text{returned}_{\text{low}})$.

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
- **Open-Meteo:** Solar radiation and weather forecast data for solar production forecasting.
  - Website: [Open-Meteo](https://open-meteo.com/)
  - Terms & License: [Open-Meteo Terms & Attribution](https://open-meteo.com/en/terms)
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