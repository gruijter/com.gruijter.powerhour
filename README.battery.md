# 🔋 Smart Battery Charger

**Plans and controls your home battery: lowest costs, most self-consumption.**
The heart of the EMS. [← Overview](./README.md)

---

## What it does

- Plans charge and discharge per price period (15 or 60 min), on prices, solar and home load.
- Controls the battery itself, or hands the plan to your flows.
- One plan for several batteries, any brand.
- Protects the main fuse and limits capacity peaks.
- Learns capacity, losses and taper by itself.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Smart Battery Charger**.
2. Pick your battery.
3. Fill in capacity and max. charge/discharge power. Done.

- Works with any battery that shows a SoC and a power in Homey.
- Built-in control needs a power setpoint (e.g. `target_power`).
- **Repair:** other battery, other capabilities, forget learned values.

---

## Modes

| Mode | What it does |
|---|---|
| **Smart** | Follows the plan: lowest total cost. |
| **Solar self-use** | Least grid use first, cost second. No grid charging, no battery export. |
| **Force save up** | No discharging. Solar surplus may charge. |
| **Force XOM** | Keeps the grid at the XOM target (zero on the meter). |
| **Force rest** | 0 W. |
| **Force charge / discharge** | Full power, also from or to the grid. |
| **Battery decides** | Leaves the group, follows its own app. |

- Set by tile or flow, for a number of minutes or until changed.
- **Action** tile: XOM, Save up, Rest, Charge, Discharge, Refill reserve, Calibrate, No control.

---

## How Smart works

**When:** every 15 minutes, on new prices, and when the SoC drifts from the plan.

**Looks ahead:** as far as prices are known (with AI price forecast: further).

**Per price period (15 or 60 min) it picks:** charge, discharge, save up, rest, or zero on the meter.

**It chooses the cheapest total over the whole period:**
- **Grid charge:** only when a later price pays the losses, wear and minimum profit.
- **Solar surplus:** stored when using it later beats exporting it now. Else exported.
- **Discharge:** covers the home first. Exports only when the export price pays.
- **Efficiency:** knows its losses per power level and picks efficient powers.
- **End of plan:** stored energy keeps its value; no emptying for nothing.
- **No flapping:** short gaps in a charge or discharge run are bridged.

**Inputs from other devices** (all optional):
- **Energy Price:** import and export price.
- **Solar Monitor:** solar forecast.
- **Grid Monitor:** home load forecast, fuse, capacity tariff. Without it: a fixed home load.
- **EV Charger / appliances:** their planned load.

---

## Key settings

- **Minimum profit per kWh:** extra a grid charge must earn.
- **Wear cost per kWh:** or calculate it from purchase price and cycles.
- **Extra precise planning:** LP planner, best for several different batteries. Uses more memory.
- **Plan together with other batteries:** one plan, one mode for the group.
- **Also discharge for the car:** off: the battery does not charge the EV.
- **Protect the main fuse / Limit peaks:** uses the Grid Monitor's limits.
- **Reserve (%):** kept for fuse and peak protection.
- **Calibrate every (days):** now and then fully empty and full, so the SoC stays right.
- **Learned:** shows usable capacity, losses and minimum useful power.

---

## Control

- **Built-in:** tick **Let the app control the battery**. The app sets the power.
- **Own logic, built-in control:** let flows set the mode, the app does the rest.
- **By flows:** control off. Use **New planned battery power** or **New XOM power available**.

---

## Flow cards

**Triggers**
- Battery mode changed
- New planned battery power (inverted)
- New XOM power available (inverted)

**Conditions**
- Battery mode is / is not …

**Actions**
- Set battery mode … for … minutes (0: until changed)
- Provide planned battery power
- Set battery cost: minimum profit or wear per kWh
- Calibrate battery: start / stop
- Set XOM (all batteries)
