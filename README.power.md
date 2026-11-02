# ⚡ Power Monitor

**Use and costs per appliance or sub-meter, and the cheapest start for your washing machine.**
[← Overview](./README.md)

---

## What it does

- kWh and money per hour, day, month and year.
- Any meter: smart plug, energy monitor, heat pump, sub-meter.
- Shows always-on (standby) power.
- Learns appliance programs and plans the cheapest start.
- Compares use with a year budget.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Power Monitor**.
2. Pick the device. Likely ones first.
3. Washing machine, dishwasher or dryer? Choose a **Forecast and planner** mode. Done.

- **Use Watt as source:** only without a kWh meter.
- **Has daily reset:** the meter resets at midnight.
- **Homey Energy totals:** pair `HOMEY_ENERGY_SMARTMETERS`, `_SOLARPANELS` or `_DEVICES`.
- **Virtual meter:** pair `VIRTUAL_VIA_FLOW`, send readings by flow.
- **Repair:** other source, mode, budget, fix totals.

---

## Always-on power

- Minimum power per day, month and year = what is always on.
- Every 10 W always on ≈ 90 kWh per year.

---

## Appliance forecast & planner

**Forecast and planner** (setup or Repair):
- **Off**
- **Forecast only:** learns programs and start times; adds expected runs to the grid forecast.
- **Forecast and plan:** also plans the cheapest start, in 15-minute steps.

**Start today / tomorrow** (tiles): As learned, Not used, Cheapest, Via flow, or a time.
- At the start, **Planned start** fires: start the appliance from that flow.
- **Next run** shows the coming start.
- **Learned program** (settings): runs, energy, duration, starts per week.

---

## Flow cards

**Triggers**
- The power changed
- Program started / finished
- Planned start
- Cheapest program start in the next … hours / between two times

**Conditions**
- Now is the cheapest program start in the next … hours / between two times

**Actions**
- Plan cheapest start between two times (empty start: now)
- Plan start at a time
- Cancel planned program
- Set fixed cost per hour, day or month
- Set fixed tariff or fixed export tariff
- Send reading to virtual meter (app card)

Times: `07:30`, `7.5`, or a tag.
