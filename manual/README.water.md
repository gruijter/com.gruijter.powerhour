# 💧 Water Monitor

**Water use and costs, and a leak check.**
[← Overview](../README.md)

---

## What it does

- m³ and money per hour, day, calendar month and year. Contract year too, when it does not start on 1 January.
- Water flow now, minimum and maximum (L/min).
- Price from an Energy Price device with **Water**, or a fixed tariff.
- Compares use with a year budget.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Water Monitor**.
2. Pick your water meter.
3. Check tariff group and budget. Done.

- **Price:** a tariff group with an Energy Price device, or **Fixed tariff**.
- **Virtual meter:** pair `VIRTUAL_VIA_FLOW`, send readings (m³) with **Send reading**.
- **Repair:** other source, budget, settings, fix totals. The device settings only show the values.

---

## Leak check

- Normal: the flow drops to 0 many times a day.
- **Minimum (day)** above 0 all day = a dripping tap, running toilet or leak.
- Flow: at 23:55, *Minimum (day)* > 0 → notification.

---

## Flow cards

**Actions**
- Set fixed cost per hour, day or month
- Set fixed tariff
- Send reading (virtual meter)

---

## Widget

**Energy** shows water too (setting **Show water**).
