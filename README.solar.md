# Solar Forecaster (Solar Driver)

The **Solar Forecaster** driver combines historical solar panel production data with weather forecasts to predict solar yield for Today and Tomorrow, while tracking house self-consumption.

---

## Table of Contents

- [Key Features](#key-features)
- [How it Works](#how-it-works)
- [Setup & Pairing](#setup--pairing)
- [Yield Distribution & Capabilities](#yield-distribution--capabilities)
- [Proportional Self-Consumption Tracking](#proportional-self-consumption-tracking)
- [Flow Cards & Automations](#flow-cards--automations)

---

## Key Features

- **Self-Learning AI Forecast:** Learns the unique characteristics of your solar array (tilt, orientation, shading, inverter efficiency) over a 14-day rolling window.
- **Hourly & Daily Predictions:** Provides Watt predictions for the next hours ($H_0, H_1, H_2, H_3$) and total kWh forecasts for Today and Tomorrow.
- **Yield Distribution Curve:** Visualizes your array's hourly efficiency profile throughout the day on the device UI.
- **Proportional Self-Consumption:** Calculates how much generated solar power is directly consumed by your house vs. exported to the grid.

---

## How it Works

The Solar Forecaster continuously analyzes your inverter's production against local solar irradiance and weather data:
1. **Initial Calibration:** Upon installation, it uses 14 days of power history to train an efficiency model.
2. **Dynamic Forecast:** Every hour, weather forecasts are transformed into expected Watt and kWh values.
3. **Continuous Learning:** The model updates daily to adapt to seasonal sun angles and cloud cover patterns.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Solar Panel**.
3. Choose the device that measures your solar production (e.g. Enphase, SolarEdge, SMA, Fronius, Shelly, or Smart Plug).
4. Complete pairing.

---

## Yield Distribution & Capabilities

### Capabilities
- `meter_kwh_forecast.this_day` — Total predicted kWh for today.
- `meter_kwh_forecast.tomorrow` — Total predicted kWh for tomorrow.
- `measure_watt_forecast.h0..h3` — Expected production in Watts for current and upcoming hours.
- `measure_watt_forecast.tomorrow_peak` — Peak production expected tomorrow (Watts).
- `button.retrain` — Force retrain the machine learning model.

---

## Proportional Self-Consumption Tracking

When connected alongside a P1 Smart Meter, PBTH automatically computes house self-consumption:
- `measure_solar_use.this_hour`
- `measure_solar_use.this_day`
- `measure_solar_use.this_month`
- `measure_solar_use.this_year`

If solar production exceeds total house load, export is subtracted so only the power consumed *in the house* is credited as self-consumed solar energy.

---

## Flow Cards & Automations

### Triggers
- **Forecast updated:** Trigger when tomorrow's solar forecast is updated.
- **Yield target reached:** Trigger when today's production meets expectations.

### Actions
- **Retrain model:** Trigger retraining via flow button.
