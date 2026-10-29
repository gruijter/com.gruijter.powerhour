# Solar Monitor (Solar Driver)

The **Solar Monitor** tracks the production of your solar panels and forecasts the yield for the coming hours, today and tomorrow. The forecast combines a weather forecast with what it learns from your own panels. It also shows how much of the production your home uses itself.

---

## Table of Contents

- [Key Features](#key-features)
- [How the Forecast Works](#how-the-forecast-works)
- [Setup & Pairing](#setup--pairing)
- [Peak Power Setting](#peak-power-setting)
- [Self-Consumption](#self-consumption)
- [Curtailment](#curtailment)
- [Capabilities & Charts](#capabilities--charts)
- [Flow Cards](#flow-cards)
- [Reporting a Forecaster Problem](#reporting-a-forecaster-problem)

---

## Key Features

- **Production totals:** kWh and money per hour, day, month and year, and the maximum power per day, month and year.
- **Self-learning forecast:** learns how your panels respond to the sun (orientation, tilt, shading, inverter limit) from the measured production.
- **Forecast in 15-minute steps:** power now and +15 min to +3 h, energy this hour, today and tomorrow, and tomorrow's peak.
- **Self-consumption:** the share of the production used in the home, per hour, day, month and year.
- **Curtailment detection:** recognises when the inverter is limited, and pauses learning meanwhile.
- **Feeds the other devices:** the battery and EV planners and the grid forecast use the solar forecast.

---

## How the Forecast Works

1. **Weather:** the solar radiation forecast for your location comes from Open-Meteo.
2. **Learning:** the measured production is compared with the radiation, per time of day. The result is the *yield distribution* of your panels.
3. **Training:** at pairing, and with **Retrain solar forecast**, the history of the source device in Homey Insights is used. After that it keeps learning from new data.

**Training status** in the settings shows how far the learning is.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Solar Monitor**.
2. Choose the device that measures your solar production (inverter, energy meter or smart plug). Solar panels in Homey are listed first. The new device gets the name of the source device.
3. The setup view asks for **Use Watt as source**, **Has daily reset**, **Peak Power (W)**, the **Tariff group** (an Energy Price device, or **Fixed tariff** with the import and export price), the **Tariff selection**, which meter capability to use, and the **Year budget** (on by default, Local climate; left empty it is estimated from the peak power and the location). Change it later with **Repair** > *Year budget*.
4. **Latitude / Longitude:** leave empty to use your Homey's location.

---

## Peak Power Setting

**Peak Power (W)** should be the *realistic maximum AC power your array can actually deliver* — not necessarily the sum of your panels' Wp ratings.

For most systems, the real ceiling is whichever of these two is **lower**:
- Your **inverter's** rated AC output, or
- The combined **Wp** of your solar panels.

If your system is intentionally "over-paneled" (panel Wp higher than the inverter's AC rating), the **inverter's AC rating is almost always the true ceiling**, since that's the maximum your Homey device will ever measure.

Leaving this at **0** makes the app estimate a value from observed history. That works, but gives the learning a weaker safety net: several checks use Peak Power to reject or cap implausible readings, most of all around sunrise and sunset. Filling in the real value from the start is the single most effective setting for forecast quality.

**Auto-detected Peak Power (W)** in the settings shows the highest power ever measured. It is used as a fallback for some checks when Peak Power is 0, but never to filter raw readings, since it starts low and only grows. It resets on a full retrain.

---

## Self-Consumption

**Own usage** shows which share of the production the home used itself, per hour, day, month and year. It needs the grid power: from the Grid Monitor, or else from the main meter in Homey Energy. While the home exports, the export is subtracted from the production; with several Solar Monitors it is shared in proportion to their production.

---

## Curtailment

When the inverter is limited, e.g. at negative prices, the production is lower than the sun allows. The device recognises this (**Curtailment active**) and does not learn from that time. Set it yourself with **Set curtailment** when you limit the inverter from a flow.

---

## Capabilities & Charts

- **Production:** power, kWh and money per hour, day, month and year, maximum power per day, month and year.
- **Forecast:** power now, +15 min, +30 min, +45 min, +1 h, +2 h, +3 h; energy this hour, today and tomorrow; peak power tomorrow.
- **Own usage** per hour, day, month and year.
- **Curtailment active** (alarm).
- **Charts:** production and forecast today, tomorrow and yesterday, and the learned yield distribution.
- **Maintenance actions:** *Retrain solar forecast*, *Export diagnostics data*.

---

## Flow Cards

### Triggers
- **Solar forecast for** today / tomorrow / next hours **updated** — token: forecast (JSON)
- **Solar production becomes one of the top** N **hours of today**
- **Remaining yield before** a time **is less than** … kWh
- **Yield between** two times **is less than** … kWh
- **Solar curtailment detected** / **ended**

### Conditions
- **Expected yield for** today / tomorrow / next hours **is more / less than** … kWh
- **Tomorrow's yield is better / worse than today's**
- **Solar production is / isn't one of the top** N **hours of today**
- **Remaining yield before** a time **is less / more than** … kWh
- **Yield between** two times **is less / more than** … kWh
- **Solar curtailment is / isn't active**

### Actions
- **Provide solar forecast JSON for** today / tomorrow / next hours
- **Retrain solar model**
- **Set curtailment**
- **Set tariff group**
- **Set fixed tariff**
- **Set fixed export tariff**

Times are text: `07:30`, decimal hours (`7.5`), or a tag.

---

## Reporting a Forecaster Problem

If the solar forecast looks clearly wrong (e.g. way too high or too low at certain times of day), the most useful thing you can send is your array's settings and raw production history.

1. Open the solar device's settings and run the **Export diagnostics data** maintenance action.
   - This only *logs* your array's settings (Peak Power, latitude/longitude) and its raw 14-day/24-hour Homey Insights power history — it does **not** change the forecast model.
   - It does **not** include weather data — that can be looked up from your location.
2. Then send a **Homey App Diagnostics Report** for Power by the Hour from the Homey app.
3. In the report, please mention:
   - The **panel orientation** (e.g. South, East, West) — there is no setting for it.
   - What looked wrong, roughly when, and what you expected instead.
