# Water Summarizer (Water Driver)

The **Water Summarizer** device tracks water consumption in cubic meters ($\text{m}^3$) and Liters, providing cost breakdowns and continuous water leak monitoring.

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Configuration & Settings](#configuration--settings)
- [Dripping Tap & Toilet Leak Monitoring](#dripping-tap--toilet-leak-monitoring)

---

## Key Features

- **Volume & Cost Tracking:** Track water usage in $\text{m}^3$ and monetary value across hourly, daily, monthly, and annual periods.
- **Water Leak Detection:** Continuous monitoring of minimum flow rate ($\text{L/min}$) to detect dripping taps, leaking toilets, or burst pipes.
- **Budget Tracking:** Track monthly and annual water usage against reference targets.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Water Summarizer**.
3. Choose your water meter source (e.g. Homewizard Watermeter, Grohe Sense, line pulse meter).
4. Complete pairing.

---

## Configuration & Settings

- **Tariff:** Enter your water supplier rate per $\text{m}^3$ (including sewage and tax contributions) in **Device Settings**.
- **Initial Reading:** Enter current water meter index to sync historical totals.

---

## Dripping Tap & Toilet Leak Monitoring

The `measure_lpm_min` capability monitors the minimum water flow over a rolling window.

> [!IMPORTANT]
> **Detect Dripping Taps & Running Toilets:** In a normal household, water flow should drop to exactly `0.0 L/min` multiple times a day (especially overnight). If the minimum flow remains above zero over 24 hours, water is constantly escaping.

### Recommended Leak Flow
- **WHEN:** 24-hour Minimum Water Flow changed
- **AND:** 24-hour Minimum Water Flow > 0
- **THEN:** Send push notification: *"Water leak warning: Minimum water flow has not dropped to 0 L/min today!"*
