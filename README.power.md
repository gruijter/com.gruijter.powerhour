# Power Monitor (Power Driver)

The **Power Monitor** summarizes the electricity use (or production) of any metered device: kWh and money per hour, day, month and year, with minimum and maximum power. For a washing machine, dishwasher or dryer it can also learn the programs and plan the cheapest start.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/5/5/55d1f95545e8389c18729221bf901a71321811fb.jpeg" alt="Power Monitor Device Tile" width="350"/>

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Homey Energy Totals](#homey-energy-totals)
- [Virtual Meter (via Flow)](#virtual-meter-via-flow)
- [Tariff, Fixed Costs & Budget](#tariff-fixed-costs--budget)
- [Always-On Power](#always-on-power)
- [Appliance Forecast & Planner](#appliance-forecast--planner)
- [Flow Cards](#flow-cards)

---

## Key Features

- **Period totals:** kWh and money for this and last hour, day, month and year, plus the month and year average price.
- **Any meter:** smart meters, energy monitors, smart plugs, heat pumps. The best energy capability is picked automatically; you can choose another in the setup view.
- **Homey Energy totals:** one device for all smart meters, all solar panels or all measured devices in Homey Energy.
- **Always-on power:** minimum and maximum power per day, month and year.
- **Dynamic tariffs:** the price of an Energy Price device in the same tariff group, or a tariff set by flow.
- **Budget:** compare the use with a year budget.
- **Appliance forecast & planner:** learns washing machine, dishwasher or dryer programs and plans the cheapest start.

---

## Setup & Pairing

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/1/2/12a1275dde87ca9c92c8d79ce12db4f586e2866b_2_250x220.jpeg" alt="Driver Selection" width="220"/>

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Power Monitor**.
2. Choose the source device. Likely sources are listed first. The new device gets the name of the source device.
3. The setup view asks for:
   - **Use Watt as source** — only when the device has no kWh meter. The app then integrates the power, which is less accurate.
   - **Has daily reset** — when the source meter resets to 0 every midnight.
   - **Enable forecast and planner** — for a washing machine, dishwasher or dryer, see below.
   - **Tariff group** and, without an Energy Price device in that group, a fixed **tariff**.
   - Which meter capabilities to use (import, import 2, export, export 2, power), when the automatic choice is not right.

Use **Repair** to switch to another source device, e.g. after replacing a meter. The device keeps its name.

---

## Homey Energy Totals

The pairing list also offers devices that summarize Homey Energy:

| Device | Summarizes |
|---|---|
| `HOMEY_ENERGY_SMARTMETERS` | The cumulative (main) meters in Homey Energy |
| `HOMEY_ENERGY_SOLARPANELS` | All solar panels in Homey Energy |
| `HOMEY_ENERGY_DEVICES` | All measured devices in Homey Energy |

---

## Virtual Meter (via Flow)

For a meter that is not a Homey device, or that needs a calculation first:
1. Pair `VIRTUAL_VIA_FLOW`.
2. Send the cumulative meter reading with the flow card **Send reading to virtual meter**.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/5/5/55e82da0ff03a2e8357db5e83bf71d458e72040b.png" alt="Virtual Meter Upload Flow" width="220"/>

> [!IMPORTANT]
> Send the total cumulative net kWh, e.g. `(consumed_high + consumed_low) - (returned_high + returned_low)`.

---

## Tariff, Fixed Costs & Budget

- **Tariff group:** the device uses the price of the Energy Price device with the same group number ([README.price.md](./README.price.md)), also for a fixed tariff. 0: no price.
- **Tariff selection:** *Automatic* uses the import price while the home imports from the grid, and the export price while it exports. Or always import, or always export.
- **Fixed costs** per hour, day and month: in the settings, or with **Set fixed cost**.
- **Budget:** a year budget with a distribution over the year (0 = no budget; linear, household electricity NW Europe, PV 52°N, or 12 own values). The device shows how the use compares to the budget so far this month and year.
- **Fix totals or costs:** with **Repair** > *Fix totals or costs* you correct the totals and money values: after a wrong meter jump, after changing the source device or the start date, or to enter the totals so far after pairing.

---

## Always-On Power

The minimum power per day, month and year shows what is always on.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/2/3/238b5a7c7a3495dd4e375d5b8f3621ccc97b8bf6_2_200x411.jpeg" alt="Always On Power Detection" width="200"/>

> [!TIP]
> Every 10 W of always-on power is about 90 kWh per year.

---

## Appliance Forecast & Planner

Tick **Enable forecast and planner** for a washing machine, dishwasher or dryer on its own smart plug or meter. The device then:
- learns its programs (duration and power) and when they usually start; **Learned program** in the settings shows what is known,
- adds the expected runs to the home load forecast of the Grid Monitor,
- finds the cheapest start for the learned program, with the prices of the tariff group.

**Start today / Start tomorrow** (device tiles): *Automatic* (as learned), *Not used*, *Cheapest*, or a fixed time. At that start **Planned start** fires: start the program from that flow, e.g. by switching on the plug or through the appliance's app. **Next run** shows the coming start.

Charts: the plan for today, tomorrow and the next hours, the weekly start pattern and the learned program. **Retrain appliance forecast** (maintenance action) relearns it.

---

## Flow Cards

The program and cheapest-start cards are available when **Enable forecast and planner** is on.

### Triggers
- **The power changed**
- **Program started** / **Program finished** / **Planned start**
- **Cheapest program start in the next … hours**
- **Cheapest program start in the … hours before** a time

### Conditions
- **Now is the cheapest program start in the next … hours**
- **Now is the cheapest program start in the … hours before** a time

### Actions
- **Plan cheapest start, at the latest at** a time — once; *Planned start* fires at the cheapest start
- **Cancel planned program**
- **Set fixed cost** per hour, day or month
- **Set tariff group**
- **Send reading to virtual meter** (app card)

Times are text: `07:30`, decimal hours (`7.5`), or a tag.
