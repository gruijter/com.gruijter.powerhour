# 💶 Energy Price

**Your real price, per 15 minutes or per hour: market or fixed, with all markups and taxes.**
[← Overview](./README.md)

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/b/5/b536b76cdb308d7d3745e087f17280ac481600b4_2_182x500.jpeg" alt="Price chart" width="180"/>

---

## What it does

- Electricity, gas or water. Dynamic or fixed.
- 15-minute or hourly prices, as your supplier bills.
- Supplier markup, taxes, VAT, time-of-day and weekend markups.
- Own export price, with an optional minimum.
- AI price forecast until tomorrow's prices are out.
- Sends the price to all devices in its **tariff group**.
- Flow cards for cheapest and most expensive periods and blocks.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Energy Price**.
2. Answer the wizard from your contract: type, zone, import price, export price.
3. Pick a tariff group. Done.

- **Price now** shows the result while you type.
- Each amount: incl. or excl. VAT, as on your contract.
- **Repair:** same wizard, to change anything.

---

## How the price is made

| Your contract | Formula in use |
|---|---|
| Markup 0.02 and tax 0.1108 excl. VAT, VAT 21% | `(market + 0.02 + 0.1108) * 1.21` |
| Tax incl. VAT, plus time-of-day markup | `(market + 0.02 + tod) * 1.21 + 0.1108` |
| Export: market minus 0.02, no VAT | `market - 0.02` |

- **Variable markup (%):** on the market price (fixed: on the supply price).
- **Time-of-day markup:** `7:0.05;23:0` = +0.05 from 07:00, 0 from 23:00.
- **Weekend markup:** Saturday and Sunday, replaces time-of-day.
- **Minimum export price:** the higher of a fixed amount and a % of the supply or import price.

**Own formula (advanced):** names `market`, `tod`, `weekend`, `markup`, `tax`, `vat`, `percent`, `abspercent`; export also `import`, `supply`. Functions `min()`, `max()`, `abs()`.
Example: `max(market - 0.02, import * 0.5)`.

---

## Types

- **Fixed:** no market prices. Day/night and weekend tariffs still work everywhere.
- **Gas:** one price per day (TTF). No cheapest-period cards.
- **Water:** price per m³, always fixed.

---

## Sources, forecast, currency

- **Price provider:** Automatic picks the best source for your zone, with fallback.
- **ENTSO-E key:** a shared key is built in. Own free key: register at [ENTSO-E](https://transparency.entsoe.eu/), mail `transparency@entsoe.eu` (*Restful API access*).
- **Forecast prices:** AI prices (Stekker) for the planners to look further ahead.
- **Currency:** fixed exchange rate, or daily ECB rate.

---

## Flow cards

**Amounts:** quarters, half hours or hours. **Windows:** next H hours (0 = all) or between t1 and t2. **Times:** `7:30`, `7.5`, or a tag.

**Triggers**
- A new price period started
- New prices received for today / tomorrow / next hours
- The price becomes one of the cheapest / most expensive N … (next H hours / between times)
- The cheapest / most expensive block of D … starts (next H hours / between times)
- The price becomes P% above / below the average of …

**Conditions**
- The price is one of the cheapest / most expensive N …
- The cheapest / most expensive block of D … is now
- The price is P% above / below the average of …

**Actions**
- Find the cheapest / most expensive block (tokens: start, end, minutes until, average)
- Provide import / export prices JSON
- Set a price component
- Set time-of-day markup or own formula

---

## Examples

- **Dishwasher:** cheapest 2-hour block between 22:00 and 07:00 starts → plug on.
- **Boiler:** new price period AND price is one of the cheapest 4 hours → relay on.
- **Heat pump:** price becomes 30% above the 8-hour average → eco mode.
- **Notify:** new prices for tomorrow → find cheapest 3-hour block → notification.

---

## From the old Day-Ahead price drivers

- Old `dap`, `dap15` and `dapg` devices keep working, but can't be added.
- Add an **Energy Price** device; **Take over settings** copies the old one.
- The new device takes over the tariff group.
- Rebuild flows with the new cards (the timeline lists them), then delete the old device.

---

## Developer API

Other apps and HomeyScript can read all prices: **[README.dap-api.md](./README.dap-api.md)**.
