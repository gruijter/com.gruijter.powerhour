# Smart Battery Charger (Battery Driver)

The **Smart Battery Charger** plans and controls your home battery: when to charge, save up, rest or discharge, based on the energy prices, your solar forecast and your home load forecast. It can set the battery power itself, or give the plan to your flows. Several batteries, also of different brands, can share one plan.

---

## Table of Contents

- [Key Features](#key-features)
- [Compatible Batteries](#compatible-batteries)
- [Setup & Pairing](#setup--pairing)
- [Battery Modes](#battery-modes)
- [The Planner](#the-planner)
- [Control: Built-in or by Flows](#control-built-in-or-by-flows)
- [Grid Protection, Peak Shaving & Reserve](#grid-protection-peak-shaving--reserve)
- [XOM (Zero on the Meter)](#xom-zero-on-the-meter)
- [Learned Battery Properties](#learned-battery-properties)
- [Capabilities & Charts](#capabilities--charts)
- [Flow Cards](#flow-cards)

---

## Key Features

- **Smart planning in 15-minute blocks:** import and export prices, solar forecast, home load forecast, losses and wear.
- **Battery modes:** Smart, Solar self-use, and forced modes for a fixed time or until changed.
- **Built-in control:** sets the battery power through a power setpoint, without flows.
- **Group planning:** one plan and one mode for all your batteries.
- **Grid protection and peak shaving:** stays below the main fuse, contracted power and capacity tariff level.
- **Self-learning:** usable capacity, losses per power level and the minimum useful power.
- **Charge, discharge and money totals** per day, month and year.

---

## Compatible Batteries

Any battery device in Homey with a State of Charge and a battery power, of any brand. Devices that follow Homey's home battery standard (`measure_battery`, `measure_power`, `target_power`, optional `target_power_mode`) are recognised right away; for others the setup view lets you pick the capabilities.

- **Monitoring and planning** work with any compatible battery.
- **Built-in control** needs a power setpoint the app can set (e.g. `target_power`).

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Smart Battery Charger**.
2. Choose your battery. The new device gets the name of the battery.
3. The setup view asks for the tariff group, the nominal capacity, the max. charging and discharging power, the planner type and whether the app controls the battery. It also shows which capabilities of the battery are used (State of Charge, power, setpoint), and lets you choose others.

Use **Repair** to change the battery or its capabilities. Tick **Forget learned values** after replacing the battery, or when the learned values are clearly wrong.

---

## Battery Modes

| Mode | Behaviour |
|---|---|
| **Smart** | Follows the plan: the most cost-effective action in every block. |
| **Solar self-use** | Least energy from and to the grid first, cost second. No charging from the grid, no export from the battery. |
| **Force save up** | No discharging; solar surplus may still charge. |
| **Force XOM** | Keeps the grid power near the XOM target (zero on the meter). |
| **Force rest** | 0 W. |
| **Force charge** / **Force discharge** | Charges or discharges, also from or to the grid. |
| **Battery decides** | This battery leaves the group and follows its own app or settings. |

Set the mode on the device tile or with **Set battery mode** (optionally for a number of minutes; afterwards the previous mode returns). **Action** shows what the battery is doing right now: XOM, Save up, Rest, Charge, Discharge, Refill reserve or No control.

---

## The Planner

The plan is made every 15 minutes, when new prices arrive, and when the battery's State of Charge drifts away from the plan. It uses:
- **Prices** from the Energy Price device in the same **Tariff group** (import and export).
- **Solar and home load forecasts** from the Solar Monitor and Grid Monitor devices, when present. Without a Grid Monitor a fixed home usage is assumed.
- **Minimum profit per kWh:** what a charge and discharge cycle must earn on top of losses and wear (not used in Solar self-use).
- **Wear cost per kWh:** battery wear per kWh stored and used again, e.g. price / (capacity × cycles).

Both can be changed from a flow with **Set battery cost**, e.g. a higher minimum profit in winter.
- **Discharge into EV:** off: the battery does not cover the charging of a Power by the Hour EV charger.

**Advanced planner (LP)** uses linear programming: best for a group of different batteries, but it uses more memory and CPU. Off: the light planner, nearly as good.

**Plan together with other batteries** *(default on):* one plan and one battery mode for all batteries with this on, whether controlled by the app or by flows. Off: this battery plans on its own, around the others.

---

## Control: Built-in or by Flows

**Built-in control** — tick **Control the battery**. The app takes over the battery's power setpoint and keeps it set by the mode and the plan. When the battery has a `target_power_mode`, the app switches it to Homey control and gives the previous mode back when its control ends, e.g. when the app stops.

**Your own logic, built-in control** — keep **Control the battery** on and let your flows choose the mode, e.g. *Force charge* for 30 minutes when something happens, or *Battery decides* while you need the battery for something else. The app does the rest. This covers most custom behaviour without any power calculations.

**By flows** — leave **Control the battery** off and drive the battery yourself with the plan:
- **New planned battery power:** the planned power for the current block (tokens power, duration, SoC afterwards, plan block, plan JSON). Positive is charging, negative discharging (or inverted). The same plan as the chart, with the costs of the device settings.
- **New XOM power available:** the power that keeps the grid near the XOM target.

---

## Grid Protection, Peak Shaving & Reserve

- **Protect the grid connection** *(default on):* keeps the import below the main fuse and the *Max. import (W)* of the Grid Monitor, in every block.
- **Peak shaving:** keeps the import below the capacity tariff level set on the Grid Monitor.
- **Reserve (%):** charge the battery always keeps. Below it, it recharges as soon as possible. Only grid protection and peak shaving may use it. Advice with peak shaving: 10%.

These apply in every mode that the app controls. They need a Grid Monitor device.

---

## XOM (Zero on the Meter)

XOM keeps the grid power near a target, e.g. 0 W: the battery covers the home load and stores the solar surplus. **XOM target (W)** is the same for all batteries (positive: a little import, negative: a little export). The flow card **Set XOM** changes the target, and the smoothing and minimum battery load of the XOM flows.

---

## Learned Battery Properties

Fill in the nominal capacity and the max. power. The rest is learned from what the battery does: the usable capacity, the losses per power level and the minimum charging and discharging power worth running. Until enough is learned (both directions), start values based on the max. power are used. **Learned** in the device settings shows the progress or the learned values.

---

## Capabilities & Charts

- **Power and energy:** battery power, stored energy, charged and discharged totals.
- **Money:** per day, month and year, and the active tariff.
- **Battery mode** and **Action**.
- **Action duration:** minutes the current planned action lasts.
- **Charts:** charge plan today, tomorrow, next hours and yesterday, and the learned efficiency. Graph options in the settings: power line, SoC line, export price, legend.

---

## Flow Cards

### Triggers
- **Battery mode changed**
- **New planned battery power** (inverted)
- **New XOM power available** (inverted)

### Conditions
- **Battery mode is / is not** …

### Actions
- **Set battery mode** … for … minutes (0: until changed)
- **Provide planned battery power** — the same tokens as the trigger, on demand
- **Set battery cost** — minimum profit or wear cost per kWh
- **Set XOM** (app-wide)
- **Set tariff group**
