# Gas Summarizer (Gas Driver)

The **Gas Summarizer** device tracks your gas consumption in cubic meters ($\text{m}^3$) and calculates costs per hour, day, month, and year. It also features automatic gas leak detection and seasonal budget tracking.

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Configuration & Settings](#configuration--settings)
- [Gas Leak & Continuous Flow Monitoring](#gas-leak--continuous-flow-monitoring)
- [Useful Flow Cards](#useful-flow-cards)

---

## Key Features

- **Volume & Cost Tracking:** Real-time tracking of $\text{m}^3$ and monetary cost for *this/last hour, day, month, year*.
- **Gas Leak Detection:** Continuous monitoring of minimum gas flow rate ($\text{L/min}$) over a 24-hour window.
- **Seasonal Budget Models:** Aligns monthly target consumption with heavy winter gas heating profiles (`gas_nl_2023`).
- **Dynamic Tariff Groups:** Automatically receives real-time gas rates when linked to a Gas Day-Ahead Pricing (`dapg`) device.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Gas Summarizer**.
3. Choose your gas meter source (e.g. P1 Smart Meter Gas Channel, Homewizard Gas, Youless, etc.).
4. Complete pairing.

---

## Configuration & Settings

- **Tariff & Fixed Costs:** Set your gas price per $\text{m}^3$ and fixed daily/monthly delivery charges in **Device Settings**.
- **Distribution Model:** Set to `gas_nl_2023` to align monthly budget targets with typical Dutch price ceiling gas heating curves.
- **Tariff Update Group:** Assign a group number (e.g. `1`) to receive dynamic gas tariffs automatically from a `DAPg` device.

---

## Gas Leak & Continuous Flow Monitoring

The `measure_lpm_min` capability measures the lowest gas flow rate in Liters per minute ($\text{L/min}$) over a 24-hour period.

> [!WARNING]
> **Gas Leak Alarm:** In a normal household, gas flow should drop to `0.0 L/min` at least several times a day (when heating/cooking is off). If the 24-hour minimum gas flow rate is greater than `0.0 L/min` (resolution $\ge 0.5\text{ L/min}$), there is continuous gas flow. This indicates a gas leak, a central heating bypass valve fault, or a stuck valve.

### Recommended Flow for Gas Leak Warning
- **WHEN:** 24-hour Minimum Gas Flow changed
- **AND:** 24-hour Minimum Gas Flow > 0
- **THEN:** Send push notification: *"Warning: Continuous gas flow detected on your gas meter!"*

---

## Useful Flow Cards

### Triggers
- **Gas target exceeded / below:** Trigger when monthly/yearly gas consumption strays from budget.
- **New hour / day / month / year:** Trigger period updates.

### Actions
- **Set Tariff:** Update gas price per $\text{m}^3$.
- **Set Meter Value:** Sync meter readings manually if needed.
