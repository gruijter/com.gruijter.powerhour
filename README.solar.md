# ☀️ Solar Monitor

**Measures your solar production and forecasts it, fully self-learning.**
[← Overview](./README.md)

---

## What it does

- Forecasts your production, in 15-minute steps, for today and tomorrow.
- **Fully self-learning:** no orientation, tilt or panel data needed.
- Learns shade, orientation and inverter limit from what your panels really did.
- Corrects today's forecast during the day.
- Production, money and own use per hour, day, month and year.
- Detects curtailment.
- Feeds the battery, EV and grid planners.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Solar Monitor**.
2. Pick your inverter, or the meter or plug of your panels.
3. Fill in **Peak power (W)**. Done.

- Location: from your Homey.
- The forecast trains itself from Homey Insights at pairing.
- **Repair:** other source, budget, settings.

---

## How the forecast works

- **Weather:** solar radiation forecast for your location (Open-Meteo).
- **Learning:** measured production vs. radiation, per time of day. Shade and orientation show up by themselves.
- **Keeps learning:** every day, from new data.
- **Intraday:** today's forecast follows how the day really goes.
- **Training status** (settings): how far the learning is.
- **Retrain solar forecast** (maintenance): start again from Insights.

---

## Key settings

- **Peak Power (W):** the real AC maximum: the lower of inverter AC and panel Wp. 0 = estimate (works, but less precise).
- **Use Watt as source:** only without a kWh meter.
- **Has daily reset:** the source meter resets at midnight.

---

## Own use & curtailment

- **Own usage:** share of the production used at home. Needs the grid power.
- **Curtailment active:** the inverter is limited; the forecaster does not learn then.

---

## Flow cards

**Triggers**
- Solar forecast for today / tomorrow / next hours updated
- Solar production becomes one of the top N hours of today
- Yield between two times is less than … kWh (empty start: now)
- Solar curtailment detected / ended

**Conditions**
- Expected yield for today / tomorrow / next hours is less / more than … kWh
- Solar production is / isn't one of the top N hours of today
- Yield between two times is less / more than … kWh (empty start: now)
- Solar curtailment is / isn't active

**Actions**
- Provide solar forecast JSON
- Set curtailment
- Set fixed tariff or fixed export tariff

Times: `07:30`, `7.5`, or a tag.

---

## Forecast looks wrong?

1. Run **Export diagnostics data** (maintenance).
2. Send a **Diagnostics Report** of the app.
3. Mention the panel orientation and what looked wrong.
