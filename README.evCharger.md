# Smart EV Charger (EV Charger Driver)

The **Smart EV Charger** plans when your car charges: at the cheapest prices and on solar surplus, while making sure the car has enough charge when you leave. It learns your driving pattern from the car and the charger, and can switch the charger itself or leave that to your flows.

---

## Table of Contents

- [Key Features](#key-features)
- [Compatible Devices](#compatible-devices)
- [Setup & Pairing](#setup--pairing)
- [Charge Modes](#charge-modes)
- [How the Charge Plan Works](#how-the-charge-plan-works)
- [Departures & Driving Pattern](#departures--driving-pattern)
- [Controlling the Charger](#controlling-the-charger)
- [Capabilities & Charts](#capabilities--charts)
- [Flow Cards](#flow-cards)

---

## Key Features

- **Price and solar aware:** charges in the cheapest periods of the Energy Price device, or on solar surplus.
- **Ready at departure:** plans to reach the needed State of Charge (SoC) before each expected departure.
- **Learns your driving:** departure times and trip consumption per weekday, from the car and charger.
- **Cheap top-up:** charges up to the daily maximum when the price is unusually low (optional).
- **Works with or without a car device:** with a car device the plan uses its real SoC and location.
- **Charge, tariff and money totals** per hour, day, month and year.
- **Part of the home plan:** planned charging is included in the net grid forecast of the Grid Monitor.

---

## Compatible Devices

- **Charger:** a device of class *EV charger*, or any device that has Homey's energy setting *This device is an EV charger*. It needs `meter_power` (preferred) or `measure_power`. A smart plug used as a charger works too: set its Homey energy setting, and see *Plug on without car* below.
- **Car (optional):** a device of class *car* or *vehicle*, or a device with both a charge state and a SoC. The car's SoC, location (home/away) and charge state are used when available.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Smart EV Charger**.
2. Pick the charger, or a charger with its car. Combinations are shown as *Charger (Car)*. The new device gets the name of the charger.
3. The setup view asks for the key settings: max. charging power, battery capacity, variable charging power, tariff group and *Control charger*.

Use **Repair** to pick another charger or car later. The device keeps its name.

---

## Charge Modes

| Mode | Behaviour |
|---|---|
| **Smart** | Plans on price and solar, to reach the needed SoC before departure. |
| **Solar only** | Charges on solar surplus only. *Max. grid power on solar (W)* allows some grid power next to the surplus. |
| **Charge now** | Charges straight to the daily maximum. |
| **Don't charge** | No charging. |
| **Charge now (temporary)** / **Don't charge (temporary)** | As above, then back to the previous mode after *Temporary mode max. (h)*. |

Below **Minimum SoC (%)** charging always starts right away, whatever the price.

---

## How the Charge Plan Works

The plan is made every price period (15 or 60 minutes) and when something changes. It uses:
- **Prices:** from the Energy Price device in the same **Tariff group**. With *Enable forecast prices* on that device the plan can look further ahead.
- **Needed SoC:** enough for the expected trips, plus **Reserve SoC (%)** for unplanned trips. After a trip the car is charged back to the reserve within **Back to reserve within (h)**.
- **Daily maximum SoC (%):** the upper limit, unless a higher *Min. SoC tomorrow* is set.
- **Charge to max SoC when cheap:** *Automatic* tops up when the price is at least 10% below the usual lowest price of a day, or below what charging on the coming days is expected to cost. *Below fixed price* uses **Cheap price**. A price of 0 or less always counts as cheap.
- **Max. price (per kWh):** no charging at home above this price, e.g. when public charging is cheaper (not below the minimum SoC, nor with *Charge now*).
- **Charging power:** **Max. charging power (W)**, or the measured power when set to 0. Tick **Variable charging power** if the charger can follow a power setpoint.

Charge efficiency and consumption are learned and shown under **Learned driving pattern**.

---

## Departures & Driving Pattern

- **Learn driving pattern:** departure times and trip use per weekday are learned. Trips that used less than **Min. trip SoC (%)** are not counted.
- **Weekly schedule:** a time per weekday (`HH:MM`) overrides the learned time. Leave empty for automatic.
- **Today / tomorrow:** the device tiles *Departure today/tomorrow* and *Min. SoC today/tomorrow*, or the matching flow cards, change one day only.
- **Away periods:** holidays and other periods that are not normal use, e.g. `2026-09-17/2026-10-01, 2026-12-24`. No trips are planned and these days are not learned. Nights away from home are recognised by themselves.
- **Car has left / is home:** a flow card to tell the device before the car app does.
- **Retrain departure learning:** maintenance action to relearn the pattern.

---

## Controlling the Charger

- **Control charger** *(default on):* the device switches the charger on and off by the plan. Off: use your own flows, e.g. on **New charging strategy active**, which provides the power and duration for the current period.
- **Plug on without car:** for a charger that cannot report a plug state, e.g. a smart plug. The plug stays on while no car is detected, so plugging in is seen right away.
- **Shared charger:** several cars use the charger. Power at the charger only counts for this car when its car app does not say it is away.
- **Start charging in the car:** when the charger is on but the car takes no power after a minute, the car app is asked to start charging. This wakes the car.
- **V2X:** shows the energy the car returned to home or grid (*Discharging total*). Measuring only: the plan does not discharge the car.

---

## Capabilities & Charts

- **Status:** Car status (*Away, At home, Plugged in, Charging*), SoC, Charge mode, Next departure, Next charge, Resumes.
- **Day pickers:** Departure today/tomorrow, Min. SoC today/tomorrow.
- **Energy and money:** kWh and money per hour, day, month and year, active tariff, budget targets.
- **Alarm:** *Not plugged in* while charging is needed.
- **Charts:** charge plan today, tomorrow, next hours and yesterday, and the weekly driving pattern.

---

## Flow Cards

### Triggers
- **Car status changed** — token: car status.
- **Charge mode changed** — token: charge mode.
- **Car not plugged in while charging is needed** — tokens: departure, required SoC.
- **New charging strategy active** — every price period: power, duration, target SoC and the plan (JSON).

### Conditions
- **Car status is / is not** …
- **Charge mode is / is not** …

### Actions
- **Set charge mode**
- **Departure today / tomorrow at** a time — `HH:MM`, decimal hours, `auto` (automatic again) or `-` (car not used that day).
- **Min. SoC today / tomorrow** — `0` is automatic again.
- **Car away from … to …** — adds an away period.
- **Car has left / is home**
- **Set car SoC** — for chargers and cars that do not report the SoC.
- **Set tariff group**
