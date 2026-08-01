# Home Battery Manager (Battery Driver)

The **Home Battery Manager** driver monitors home battery systems (kWh stored, charging, discharging, costs) and provides dynamic load balancing using the **xom / Nom-Xom** optimization strategy.

---

## Table of Contents

- [Key Features](#key-features)
- [Compatible Battery Systems](#compatible-battery-systems)
- [Setup & Pairing](#setup--pairing)
- [xom / Nom-Xom Balancing Strategy](#xom--nom-xom-balancing-strategy)
- [Return on Investment (ROI) Tracking](#return-on-investment-roi-tracking)

---

## Key Features

- **Energy & Financial Tracking:** Tracks kWh charged, discharged, and currently stored, alongside financial throughput.
- **xom / Nom-Xom Load Strategy:** Balances battery power against grid import/export to eliminate peak charges or export penalties.
- **ROI Tracking (Homey Pro 2023+):** Tracks battery investment payback duration based on arbitrage savings.

---

## Compatible Battery Systems

Compatible with any battery inverter exposing state-of-charge (SoC) and battery power capabilities:
- Victron Energy (`battery_capacity`, `measure_power.battery`)
- Solax Inverters (`measure_battery_soc`, `measure_battery_power`)
- Sonnen Batterie (`measure_battery`, `measure_power.batt_in/out`)
- Blauhoff (Afore / Deye inverters)
- SolarEdge & Growatt TCP Modbus
- Sessy Home Batteries

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Home Battery**.
3. Choose your battery inverter device.
4. Complete pairing.

---

## xom / Nom-Xom Balancing Strategy

The xom strategy optimizes battery charging and discharging against house grid power (`cumulativePower`):

- **Parameter `x`:** Targeted net grid exchange point (Watts). Set to `0` for zero-export/zero-import balancing.
- **Parameter `smoothing`:** Exponential smoothing factor ($1–100$) for battery response times to prevent oscillation during heavy appliance switching.
- **Parameter `minLoad`:** Threshold below which battery power adjustments are suppressed.

### Flow Automation
When xom conditions update, the battery driver triggers flow actions to adjust your inverter's charge/discharge rate dynamically.

---

## Return on Investment (ROI) Tracking

On **Homey Pro (2023+)**, the battery driver includes the `roi_duration` capability:
- Enter your total battery system purchase cost in Device Settings.
- PBTH calculates cumulative money saved by avoiding expensive grid tariffs vs. storing cheap solar/DAP power.
- Displays estimated remaining time until full investment payback.
