# Day-Ahead Electricity Pricing (DAP & DAP15 Drivers)

The **Day-Ahead Pricing** drivers fetch European spot market prices (ENTSO-E, Nordpool) and apply your energy supplier's markups, taxes, and exchange rates. Available in **1-hour (`dap`)** and **15-minute (`dap15`)** resolution.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/b/5/b536b76cdb308d7d3745e087f17280ac481600b4_2_182x500.jpeg" alt="Day-Ahead Pricing Graph" width="180"/>

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Bidding Zones](#setup--bidding-zones)
- [ENTSO-E Free API Key (Recommended)](#entso-e-free-api-key-recommended)
- [Markup & Tax Calculation](#markup--tax-calculation)
- [AI Price Forecasting (Stekker)](#ai-price-forecasting-stekker)
- [Broadcasting Rates via Tariff Groups](#broadcasting-rates-via-tariff-groups)
- [Community-Proven Flow Automations](#community-proven-flow-automations)

---

## Key Features

- **1H and 15M Spot Prices:** Supports both hourly EU market prices (`dap`) and 15-minute kwartiertarieven (`dap15`).
- **Comprehensive Markup Formula:** Supports variable %, fixed markup per kWh, Time-of-Day (TOD) hourly markups, weekend markups, and currency exchange rates.
- **Separate Export Tariffs:** Configure feed-in / export markups separately from import tariffs.
- **Price Graphs:** Real-time camera image graphs for *Today*, *Tomorrow*, and *Next Hours*.
- **Tariff Groups:** Broadcasts rates automatically to all Power Summarizer devices.

---

## Setup & Bidding Zones

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Day-ahead Pricing** (for 1-hour) or **Day-ahead 15m Pricing** (for 15-minute).
3. Select your European **Bidding Zone** (e.g. `NL`, `BE`, `DE-LU`, `NO1–NO5`, `SE1–SE4`, `DK1–DK2`, `AT`, `FR`, `ES`, `PL`, etc.).
4. Complete pairing.

---

## ENTSO-E Free API Key (Recommended)

To ensure reliable access to European electricity prices and avoid shared rate limits:
1. Register a free account at [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/).
2. Request an API token by emailing `transparency@entsoe.eu` with subject *"Restful API access"*.
3. Enter your personal key in **Device Advanced Settings → ENTSO-E API Key**.

---

## Markup & Tax Calculation

Consumer prices are calculated as:

$$\text{ImportPrice} = \left( \text{SpotPrice}_{\text{EUR/MWh}} \times \frac{\text{ExchangeRate}}{1000} \right) \times \left(1 + \frac{\text{VariableMarkup}}{100}\right) + \text{FixedMarkup} + \text{TODMarkup}$$

### Configuration Parameters (in Device Settings)
- **Variable Markup (%):** Supplier markup percentage.
- **Fixed Markup (€/kWh):** Energy tax, ODE, and supplier fixed surcharge per kWh.
- **Fixed Markup TOD (Time-of-Day):** Hourly custom tariffs (format: `0:0.15; 6:0.25; 23:0.15`).
- **Exchange Rate:** Currency conversion multiplier (e.g. for NOK, SEK, DKK, GBP).

---

## AI Price Forecasting (Stekker)

Enable **Forecast Enable** in settings to append up to 24 hours of AI-predicted electricity prices (via Stekker.ai) when official tomorrow market prices have not yet been published.

---

## Broadcasting Rates via Tariff Groups

Set **Tariff Update Group** (e.g. `1`) in the DAP device settings.
Any Power Summarizer device with the same group number will automatically update its active tariff every hour/quarter.

---

## Community-Proven Flow Automations

### 1. Dishwasher / Washing Machine — Run during lowest price hours
- **WHEN:** Price changed (or 13:00 tomorrow prices published)
- **AND:** Current hour is among the **lowest 3 hours** before 17:00
- **THEN:** Turn on Dishwasher Smart Plug

### 2. Water Heater / Boiler — Heat during cheap slots
- **WHEN:** Period changed
- **AND:** Price is in the **lowest 4 hours of the day**
- **THEN:** Switch Boiler relay ON

### 3. Pause EV Charger / Heat Pump during price spikes
- **WHEN:** Price changed
- **AND:** Current price > 8-hour average price
- **THEN:** Pause EV Charger / Set Heat Pump eco mode
