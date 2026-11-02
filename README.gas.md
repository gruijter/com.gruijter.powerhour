# 🛢️ Gas Monitor

**Gas use and costs, with the daily gas price.**
[← Overview](./README.md)

---

## What it does

- m³ and money per hour, day, month and year.
- Gas flow now, minimum and maximum (L/min).
- Daily market gas price, or a fixed tariff.
- Compares use with a year budget, spread by your local climate.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Gas Monitor**.
2. Pick your gas meter, e.g. a P1 meter with gas.
3. Check tariff group and budget. Done.

- **Virtual meter:** pair `VIRTUAL_VIA_FLOW`, send readings (m³) by flow.
- **Repair:** other source, budget, settings, fix totals.

---

## Leak check

- Normal: the flow drops to 0 several times a day.
- **Minimum (day)** above 0 all day = gas kept flowing.
- Flow: at 23:55, *Minimum (day)* > 0 → notification.

---

## Flow cards

**Actions**
- Set fixed cost per hour, day or month
- Set fixed tariff
- Send reading to virtual meter (app card)
