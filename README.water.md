# Water Monitor (Water Driver)

The **Water Monitor** summarizes your water use: m³ and money per hour, day, month and year, the water flow, and the minimum and maximum flow to spot a dripping tap or a running toilet.

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Tariff, Fixed Costs & Budget](#tariff-fixed-costs--budget)
- [Leak Check](#leak-check)
- [Flow Cards](#flow-cards)

---

## Key Features

- **Period totals:** m³ and money for this and last hour, day, month and year.
- **Water flow:** the current flow, and the minimum and maximum flow (L/min) per day, month and year.
- **Budget:** compare the use with a year budget.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Water Monitor**.
2. Choose the device with your water meter. The new device gets the name of the source device.
3. The setup view asks for **Has daily reset**, the **Tariff group**, the tariff, and which meter capability to use.

For a meter that is not a Homey device, pair `VIRTUAL_VIA_FLOW` and send the cumulative reading (m³) with the flow card **Send reading to virtual meter**.

Use **Repair** to switch to another source device. The device keeps its name.

---

## Tariff, Fixed Costs & Budget

- **Tariff:** your water price per m³, including sewage and taxes if you like.
- **Tariff group:** for a tariff set by the flow card **Set a new tariff** (water). 0: no updates.
- **Fixed costs** per hour, day and month: in the settings, or with **Set fixed cost**.
- **Budget:** a year budget (m³), linear or with 12 own values.
- **Meter readings:** the readings at the start of this day, month and year. Set them when you start in the middle of a period.

---

## Leak Check

In a normal home the water flow drops to 0 many times a day, especially at night. When **Minimum (day)** stays above 0 for a whole day, water was running all the time: a dripping tap, a running toilet or a leak.

Example flow:
- **WHEN:** the time is 23:55
- **AND:** Logic — the Water Monitor's *Minimum (day)* tag is greater than 0
- **THEN:** send a notification: *Water kept running today*

---

## Flow Cards

- **Set fixed cost** per hour, day or month
- **Set tariff group**
- **Set a new tariff** and **Send reading to virtual meter** (app cards)
