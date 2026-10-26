# Energy Prices (Price Driver)

The **Energy Price** driver (`price`) gives Homey your real electricity or gas price, per 15 minutes or per hour. It fetches market prices from the day-ahead exchanges (ENTSO-E, Nord Pool, EPEX via SMARD, OMIE, EEX), adds your supplier's markups, taxes and VAT, and sends the result to your other Power by the Hour devices. Fixed contracts work too, with time-of-day and weekend tariffs.

One driver for everything: it replaces the old **Day-ahead Pricing** (`dap`), **Day-ahead 15m Pricing** (`dap15`) and **Gas Day-ahead Pricing** (`dapg`) drivers. See [Moving from the old DAP drivers](#moving-from-the-old-dap-drivers).

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/b/5/b536b76cdb308d7d3745e087f17280ac481600b4_2_182x500.jpeg" alt="Price chart" width="180"/>

---

## Table of Contents

- [Key Features](#key-features)
- [Setup: the Price Wizard](#setup-the-price-wizard)
- [How the Price Is Calculated](#how-the-price-is-calculated)
- [Fixed Tariffs](#fixed-tariffs)
- [Gas Prices](#gas-prices)
- [Water Prices](#water-prices)
- [Price Providers & ENTSO-E API Key](#price-providers--entso-e-api-key)
- [AI Price Forecast](#ai-price-forecast)
- [Currency](#currency)
- [Sending the Price to Other Devices (Tariff Groups)](#sending-the-price-to-other-devices-tariff-groups)
- [Capabilities & Charts](#capabilities--charts)
- [Flow Cards](#flow-cards)
- [Flow Examples](#flow-examples)
- [Moving from the Old DAP Drivers](#moving-from-the-old-dap-drivers)
- [Developer API](#developer-api)

---

## Key Features

- **Electricity or gas, dynamic or fixed:** one driver, chosen in the wizard.
- **15-minute or hourly prices:** follow your supplier's billing interval. Since October 2025 the EU day-ahead market trades in 15-minute periods.
- **Guided setup:** answer the questions from your contract or price sheet. The wizard writes the price formula and shows the resulting price right away.
- **Amounts incl. or excl. VAT:** enter each amount the way your contract shows it. Power by the Hour applies the VAT.
- **Separate export price:** its own markups, taxes and VAT, or simply the same as the import price.
- **Time-of-day and weekend markups:** for day/night tariffs, grid tariff bands and similar schemes.
- **Own formula (advanced):** override the generated formula with your own, with `min()`, `max()` and `abs()`.
- **Price charts:** today, tomorrow and the next hours.
- **Flow cards built around periods:** cheapest or most expensive periods and blocks, in the next hours or between two times.
- **Tariff groups:** sends the current price to all devices in the same group: Grid, Power, Solar, Gas, Battery and EV charger.

---

## Setup: the Price Wizard

1. Go to **Devices** → **Add Device** → **Power by the Hour** → **Energy Price**.
2. Follow the wizard:
   - **Take over settings** *(only shown if you still have an old DAP device):* choose the old device to copy its settings, or fill in everything yourself.
   - **Which price?** Electricity, gas or water, and a dynamic (market) or fixed tariff. Water is always fixed.
   - **Market:** your bidding zone, pre-filled from your Homey's location, and the price interval (15 or 60 minutes, as your supplier bills).
   - **Import price:** supplier markup, fixed taxes and levies, variable markup (%), time-of-day and weekend markups, and VAT. Each amount has its own *incl. VAT / excl. VAT* choice.
   - **Export price** *(electricity):* the feed-in tariff, set up the same way, or **Same as import**. Tick **Minimum export price** if your contract guarantees one; the next step asks for it.
   - **Finish:** a name, and which tariff group should use this price.
3. A **Price now** preview shows the market price and your resulting price while you fill in the fields.

To change the energy type, tariff type, bidding zone or interval later, use **Repair** on the device. It opens the same wizard. All amounts can also be changed in the device settings.

---

## How the Price Is Calculated

From your answers the wizard builds a price formula. You can see it in the device settings under **Formula in use**. Some examples:

| Your contract | Formula in use |
|---|---|
| Supplier markup 0.02 and tax 0.1108, both excl. VAT, VAT 21% | `(market + 0.02 + 0.1108) * 1.21` |
| As above, but the tax already includes VAT, plus a time-of-day markup | `(market + 0.02 + tod) * 1.21 + 0.1108` |
| Export: market price minus 0.02, no VAT | `market - 0.02` |

- **Variable markup (%)** applies to the market price (fixed tariff: to the supply price).
- **Markup also at negative prices (%)** is rarely needed. It is a percentage of the market price that is always a cost. E.g. 10% at −0.20 adds 0.02, where a normal variable markup would subtract 0.02.
- **Time-of-day markup:** each markup applies from its hour until the next one. Format `hour:markup;hour:markup`, e.g. `7:0.05;23:0` adds 0.05 from 07:00 and nothing from 23:00. The wizard has a helper with a **Day/night** shortcut.
- **Weekend markup:** applies on Saturday and Sunday and replaces the time-of-day markup on those days.
- **Minimum export price:** the export price never goes below the highest of **Minimum per kWh** (0 = never negative) and **Minimum as % of base**. The base is the *bare supply price* (market price after the variable markups, plus the supplier markup; without taxes, time markups and VAT) or the full import price. Example, NL from 2027: 50% of the bare supply price gives `max(market - 0.02, 0, supply * 0.5)`. The export VAT also applies to the minimum. An own export formula replaces it.

### Own formula (advanced)

Leave **Own formula** empty to use the generated one. If your contract does not fit the fields, you can write your own. It may use these names:

| Name | Meaning |
|---|---|
| `market` | Market price per kWh (gas: per m³), after the exchange rate |
| `tod`, `weekend` | Time-of-day markup of the period (0 on weekend days if a weekend markup is set), weekend markup (0 on weekdays) |
| `markup`, `tax`, `vat`, `percent`, `abspercent` | The values from the settings (`vat` and percentages in %) |
| `import` | The import price of the same period (export formula only) |
| `supply` | The bare supply price of the same period (export formula only) |

Operators `+ - * /` and parentheses, functions `min(a, b, …)`, `max(a, b, …)` and `abs(a)`. Use a dot as the decimal separator. An invalid formula is rejected when you save it.

Example: an export price of at least 50% of the import price:
`max(market - 0.02, import * 0.5)`

---

## Fixed Tariffs

Choose **Fixed** in the wizard. No market prices are fetched. You enter your **Supply price** (and feed-in tariff), plus taxes, VAT and any time-of-day or weekend markups. The device then behaves like a dynamic one: day/night tariffs show in the charts, flow cards and tariff groups.

---

## Gas Prices

Choose **Gas** in the wizard. Gas has one price per day (TTF day-ahead via EEX or EasyEnergy), per m³. Markups, taxes and VAT work as for electricity, without an export price.

---

## Water Prices

Choose **Water** in the wizard. Water has no market: you enter your price per m³ as a fixed tariff, with taxes, VAT and any time-of-day or weekend markups. Water Monitors in the same tariff group use it.

Because there is only one price per day, the cards for cheapest or most expensive periods and blocks are not available for gas. The card *The price is …% above/below the average* is.

---

## Price Providers & ENTSO-E API Key

**Price Provider** (device settings) is `AUTO` by default: the best source for your bidding zone is used, with automatic fallback to the others (ENTSO-E, Nord Pool, SMARD, OMIE, EEX, EasyEnergy, Stekker). Pick a fixed provider only when you have a reason to.

A shared ENTSO-E key is built in. For the most reliable access you can request your own free key:
1. Register at the [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/).
2. Email `transparency@entsoe.eu` with subject *"Restful API access"*.
3. Enter the key in **Device Settings → ENTSO-E API Key**.

---

## AI Price Forecast

Electricity only. Enable **Enable forecast prices** to add AI-predicted prices (Stekker) until the official prices for tomorrow are published. The battery, EV and appliance planners can then look further ahead. The trigger *New prices received* fires for forecast updates only when **include forecast** is ticked.

---

## Currency

- **Currency unit** and **Price decimals** set how prices are shown. **Money decimals** (from the currency: 2, or 0 for HUF and ISK) and the currency are passed on to the devices in the tariff group, for their money totals.
- **Exchange rate with €:** market prices are in euro. Set a fixed rate, or choose a currency under **Daily update the exchange rate** to fetch the ECB rate every day (NOK, SEK, DKK, GBP, CHF, PLN and others).

---

## Sending the Price to Other Devices (Tariff Groups)

In the wizard or under **Tariff group** (settings), choose a group number. Every device with the same **Tariff group** then uses this price, updated every period: Grid, Power, Solar and Gas Monitors, Smart Battery Chargers and Smart EV Chargers. The import price goes to consumption, the export price to feed-in. Choose **0** (wizard: *Nothing (flows only)*) to use the device in flows only.

When you add another device, its setup view offers the groups that have a price device.

---

## Capabilities & Charts

| Capability | Meaning |
|---|---|
| Price now / Price now (export) | Current import and export price |
| Price next period | Price of the next 15 minutes or hour |
| Avg. / Lowest / Highest price this day | For today |
| Avg. / Lowest / Highest price tomorrow | Empty until tomorrow's prices are known |
| Avg. price this month / last month | Month averages |
| Time of lowest/highest price today/tomorrow | When the extremes occur |
| Rank this day / Rank next 8h | 1 = cheapest period of the day or of the next 8 hours |

Gas devices have the import, next, average and month capabilities only.

The device shows three price charts: **Today**, **Tomorrow** and **Next hours**. Tick **Show export price in chart** to add the export price as a line.

---

## Flow Cards

### Amounts, windows and times

- **Amounts** are entered as a number with a unit: quarters, half hours or hours (blocks: minutes or hours). They are rounded up to whole price periods of the device.
- **Windows** are either *the next H hours* (0 = all known prices) or *between t1 and t2*. If t1 equals t2, the window is the full 24 hours.
- **Times** are text fields, so tags work too. With a colon it is a clock time (`7:30`). A plain number is decimal hours (`7.5` or `7,5` = 07:30). Note: `7.30` means 07:18.

### Triggers

- **A new price period started** — tokens: import, export.
- **New prices received for** this day / tomorrow / next hours (option: include forecast) — tokens: prices JSON, export prices JSON, provider.
- **The price becomes one of the** cheapest / most expensive N … **in the next H hours** / **between t1 and t2**.
- **The cheapest / most expensive block of** D … **in the next H hours** / **between t1 and t2** **starts**.
- **The price becomes P% above / below the average of** today / the next 8 hours / this month.

### Conditions

- **The price is one of the** cheapest / most expensive N … in the next H hours / between t1 and t2.
- **The cheapest / most expensive block of** D … in the next H hours / between t1 and t2 **is now**.
- **The price is P% above / below the average of** today / the next 8 hours / this month.

### Actions

- **Find the cheapest / most expensive block of** D … **in the next H hours, before** a time (leave the time empty for no limit) — tokens: start time, end time, minutes until, average price.
- **Provide import / export prices JSON for** this day / tomorrow / next hours — tokens: prices, provider.
- **Set** a price component (supplier markup, taxes, variable markup, VAT, weekend markup, import or export, exchange rate) **to** a value.
- **Set** the time-of-day markup or own formula (import or export) **to** a text.

---

## Flow Examples

### 1. Dishwasher: start in the cheapest 2-hour block before morning
- **WHEN:** The cheapest block of 2 hours between 22:00 and 07:00 starts
- **THEN:** Turn on the dishwasher smart plug

### 2. Boiler: heat in the 4 cheapest hours of the day
- **WHEN:** A new price period started
- **AND:** The price is one of the cheapest 4 hours between 0:00 and 0:00
- **THEN:** Switch the boiler relay on

### 3. Pause the heat pump during price spikes
- **WHEN:** The price becomes 30% above the average of the next 8 hours
- **THEN:** Set the heat pump to eco mode

### 4. Plan ahead with a notification
- **WHEN:** New prices received for tomorrow
- **THEN:** Find the cheapest block of 3 hours in the next 0 hours, before 18:00
- **THEN:** Send a notification: *Cheapest start: [start time], average [average price]*

---

## Moving from the Old DAP Drivers

The old **Day-ahead Pricing**, **Day-ahead 15m Pricing** and **Gas Day-ahead Pricing** devices keep working, but can no longer be added. Their flow cards are hidden for new flows. Existing flows keep running. Homey's timeline shows a message while you still have an old device.

To move:
1. Add an **Energy Price** device. In the first wizard step, choose your old device under **Take over settings**. Bidding zone, interval, markups, time-of-day and weekend markups, currency, provider, forecast and tariff group are copied over. The old markups already included VAT, so they are taken over as *incl. VAT* with VAT 0%. Splitting them into supplier markup, taxes and VAT is optional, the price stays the same.
2. From then on, the old device no longer sends its price to the tariff group. The new device does.
3. Rebuild the flows that use the old device's cards with the new cards. The timeline message lists those flows.
4. Delete the old device.

What is different:
- Amounts can be entered incl. or excl. VAT. VAT is a separate field, no longer folded into the markups.
- Amounts in flow cards use quarters, half hours or hours, instead of a fixed number of hours.
- One trigger *A new price period started* replaces *New hour* and *Price changed*.

---

## Developer API

Other apps and HomeyScript can read the prices of every price device (new and old drivers). See **[README.dap-api.md](./README.dap-api.md)**.
