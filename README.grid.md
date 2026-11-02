# 🔌 Grid Monitor

**Your main meter: import, export, home load, peaks and load forecast.**
[← Overview](./README.md)

---

## What it does

- Import, export and net: kWh and money per hour, day, month and year.
- Prices import and export the way your supplier bills (with or without netting).
- Calculates your real home load.
- Tracks capacity tariff peaks, live.
- Learns and forecasts your home load.
- Gives the fuse and peak limits to the battery and EV planners.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Grid Monitor**.
2. Pick your P1 meter or main meter.
3. Check price, grid connection and peak settings. Done.

- Source: a cumulative main meter in Homey Energy. Only a signed power? Tick **Use Watt as source**.
- The load forecast trains itself from Homey Insights at pairing.
- **Repair:** new meter (totals stay correct), budget, settings, fix totals.

---

## Prices & netting

**Price settlement scheme:**
| Scheme | What it does |
|---|---|
| **Per direction** (default) | Import and export each at their own price. |
| **Continuous net** | Everything netted, then priced (netting). |
| **Block settlement** | Netted per block of 15–60 min, then priced. |

- **Fixed costs** per hour, day and month.

---

## Home load

`Home = Grid + Solar − Battery charging − EV charging`
- Solar, battery and EV from the Power by the Hour devices.
- Shown apart: home, solar, battery and EV power.

---

## Capacity tariff & fuse

- **Grid connection:** phases, main fuse, voltage, fuse margin.
- **Max. import (W):** contracted power, never exceeded.
- **Presets:** Flanders, Norway, Sweden, or custom.
- **Custom:** interval (15/30/60 min), billed peak (highest, average or N-th), counting hours and months, price per kW or steps.
- **Live:** peak per day, month and year; projected peak and headroom now.

---

## Home load forecast

- Learns your week in 15-minute steps; keeps learning.
- **Net forecast:** home load − solar + planned EV charging.
- **Net incl. battery plan:** plus the battery plan.
- Appliances with a forecast add their expected runs.
- **Extra load** (flow): a known load, e.g. legionella run, without learning it.
- **Forecast accuracy** in the settings.
- **Retrain home load forecast** (button): start again.

---

## Flow cards

**Triggers**
- Home load forecast updated (JSON tokens)
- Projected peak exceeds billing level

**Conditions**
- Peak headroom is / isn't below … W

**Actions**
- Provide home load forecast JSON
- Extra load … W today/tomorrow at … for … min (0 W: remove)
- Set fixed tariff or fixed export tariff
- Set fixed cost per hour, day or month
