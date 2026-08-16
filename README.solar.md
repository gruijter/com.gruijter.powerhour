# Solar Forecaster (Solar Driver)

The **Solar Forecaster** driver combines historical solar panel production data with weather forecasts to predict solar yield for Today and Tomorrow, while tracking house self-consumption.

---

## Table of Contents

- [Key Features](#key-features)
- [How it Works](#how-it-works)
- [Setup & Pairing](#setup--pairing)
- [Peak Power Setting](#peak-power-setting)
- [Yield Distribution & Capabilities](#yield-distribution--capabilities)
- [Proportional Self-Consumption Tracking](#proportional-self-consumption-tracking)
- [Flow Cards & Automations](#flow-cards--automations)
- [Reporting a Forecaster Problem](#reporting-a-forecaster-problem)

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
5. In the device settings, fill in **Peak Power (W)** — see [Peak Power Setting](#peak-power-setting) below, this matters more than it might seem.

---

## Peak Power Setting

**Peak Power (W)** should be the *realistic maximum AC power your array can actually deliver* — not necessarily the sum of your panels' Wp ratings.

For most systems, the real ceiling is whichever of these two is **lower**:
- Your **inverter's** rated AC output, or
- The combined **Wp** of your solar panels.

If your system is intentionally "over-paneled" (panel Wp higher than the inverter's AC rating — a common design choice to boost output on hazy/low-sun days), the **inverter's AC rating is almost always the true ceiling**, since that's the maximum your Homey device will ever actually measure, regardless of how much DC power the panels could theoretically produce.

Leaving this at **0** makes the app auto-estimate a value from observed history, which works but gives the learning algorithm a weaker safety net: several internal checks use Peak Power to reject or cap implausible readings (most importantly around sunrise/sunset, where a tiny amount of noise in the measurement can otherwise get misread as an extreme value). Filling in the real, correct value from the start gives the model the strongest protection against learning bad data as normal — this is the single most impactful setting for forecast quality and robustness.

The device settings also show **Auto-detected Peak Power (W)** — a read-only field with the highest power ever measured for this array. It's a useful reference point when deciding what to fill in above. When Peak Power is left at 0, this auto-detected value is used automatically as a fallback for *some* of the internal safety checks — but never for filtering out raw readings, since this value starts low and only grows over time, so relying on it there could wrongly discard your own array's genuine higher output before it's had a chance to catch up (e.g. a system paired outside its peak season). It resets when you run **Retrain solar forecast** from scratch.

---

## Yield Distribution & Capabilities

### Capabilities
- `meter_kwh_forecast.this_day` — Total predicted kWh for today.
- `meter_kwh_forecast.tomorrow` — Total predicted kWh for tomorrow.
- `measure_watt_forecast.h0..h3` — Expected production in Watts for current and upcoming hours.
- `measure_watt_forecast.tomorrow_peak` — Peak production expected tomorrow (Watts).
- `button.retrain` — Force retrain the machine learning model.
- `button.export_diagnostics` — Log this array's settings and raw power history for troubleshooting, without changing the forecast model (see [Reporting a Forecaster Problem](#reporting-a-forecaster-problem)).

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

---

## Reporting a Forecaster Problem

If the solar forecast looks clearly wrong (e.g. way too high or too low at certain times of day), the most useful thing you can send is your array's actual settings and raw production history — that's what lets the forecast model be checked against what really happened, rather than guessed at.

**How to send it:**
1. Open the solar device's settings page and run the **Export diagnostics data** maintenance action (`button.export_diagnostics`).
   - This only *logs* your array's settings (Peak Power, latitude/longitude) and its raw 14-day/24-hour Homey Insights power history — it does **not** change your forecast model or retrain anything.
   - It does **not** include weather data — that can be looked up separately from your location and doesn't need to come from you.
2. After pressing the button, you'll see a message asking you to send a **Homey App Diagnostics Report** for Power by the Hour. Start that report from the Homey app.
3. In the diagnostics report (or wherever you're describing the problem), please mention:
   - This array's **panel orientation** (e.g. South, East, West) — the app doesn't have a setting for this, so it can't be read from the report automatically.
   - Any extra context that might help — what looked wrong, roughly when, and what you'd expect instead.
