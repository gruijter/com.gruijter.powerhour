# Day-Ahead Gas Spot Pricing (DAPg Driver)

The **Gas Day-Ahead Pricing (`dapg`)** driver fetches daily European natural gas spot market prices (EEX TTF, EasyEnergy) and broadcasts updated gas rates to your Gas Summarizer devices.

---

## Table of Contents

- [Key Features](#key-features)
- [Providers & Data Sources](#providers--data-sources)
- [Setup & Pairing](#setup--pairing)
- [Tariff Broadcast to Gas Summarizer](#tariff-broadcast-to-gas-summarizer)

---

## Key Features

- **Daily Gas Spot Prices:** Fetches TTF natural gas spot rates ($\text{€/m}^3$ or $\text{€/MWh}$).
- **Automatic Markup & Tax Addition:** Add supplier surcharges, energy tax, and VAT.
- **Gas Tariff Groups:** Broadcasts updated gas rates to Gas Summarizers.

---

## Providers & Data Sources

- **EEX (European Energy Exchange):** Official spot gas exchange rates (EOD / EGSI).
- **EasyEnergy:** Dutch dynamic gas market rates (TTF LEBA).

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Gas Day-ahead Pricing**.
3. Choose your market region (e.g. `TTF Gas Spot NL`).
4. Complete pairing.

---

## Tariff Broadcast to Gas Summarizer

1. Open **Gas Day-ahead Pricing** → **Device Settings**.
2. Set **Tariff Update Group** to `1` (or any group number).
3. Open your **Gas Summarizer** device → **Device Settings**.
4. Set its **Tariff Update Group** to the same number (`1`).

Your Gas Summarizer will now automatically calculate daily gas costs based on official dynamic gas spot prices!
