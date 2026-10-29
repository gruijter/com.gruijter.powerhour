# Gas Monitor (Gas Driver)

The **Gas Monitor** summarizes your gas use: m³ and money per hour, day, month and year, the gas flow, and the minimum and maximum flow to spot a constant flow.

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Tariff, Fixed Costs & Budget](#tariff-fixed-costs--budget)
- [Constant Flow (Leak) Check](#constant-flow-leak-check)
- [Flow Cards](#flow-cards)

---

## Key Features

- **Period totals:** m³ and money for this and last hour, day, month and year, plus the month and year average price.
- **Gas flow:** the current flow, and the minimum and maximum flow (L/min) per day, month and year.
- **Dynamic gas prices:** the daily gas price of an Energy Price device set to gas, in the same tariff group.
- **Budget:** compare the use with a year budget, e.g. spread like the local climate (more gas in winter).

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Gas Monitor**.
2. Choose the device with your gas meter, e.g. a P1 meter with gas. The new device gets the name of the source device.
3. The setup view asks for **Has daily reset**, the **Tariff group** (the Energy Price devices for gas, or **Fixed tariff** with the price and the currency), which meter capability to use, and the **Year budget** (on by default: 1100 m³, Local climate, Gas boiler).

For a meter that is not a Homey device, pair `VIRTUAL_VIA_FLOW` and send the cumulative reading (m³) with the flow card **Send reading to virtual meter**.

Use **Repair** to switch to another source device (the device keeps its name) or to change the **Year budget**.

---

## Tariff, Fixed Costs & Budget

- **Tariff group:** the device uses the gas price of the Energy Price device with the same group number ([README.price.md](./README.price.md)). 0: the **Fixed tariff** from the settings, no Energy Price device needed.
- **Fixed costs** per hour, day and month: in the settings, or with **Set fixed cost**.
- **Year budget:** a year budget (m³) spread **Evenly**, like the **Local climate (auto)** with the heating you choose (gas boiler, hybrid heat pump, or no gas heating), or **Custom (per month)**. Change it with **Repair** > *Year budget*.
- **Fix totals or costs:** with **Repair** > *Fix totals or costs* you correct the totals and money values: after a wrong meter jump, after changing the source device or the start date (Repair then opens it by itself), or to enter the totals so far after pairing.

---

## Constant Flow (Leak) Check

In a normal home the gas flow drops to 0 several times a day. When **Minimum (day)** stays above 0 for a whole day, gas was flowing all the time: a leak, or an appliance that keeps burning.

Example flow:
- **WHEN:** the time is 23:55
- **AND:** Logic — the Gas Monitor's *Minimum (day)* tag is greater than 0
- **THEN:** send a notification: *Gas flow did not stop today*

---

## Flow Cards

- **Set fixed cost** per hour, day or month
- **Set tariff group**
- **Send reading to virtual meter** (app card)
