# Grid Power Summarizer (Grid Driver)

The **Grid Power Summarizer** driver tracks the electricity exchanged with the grid at your main meter (P1 smart meter or CT clamp) — imported and exported separately — and derives your real house load, capacity-tariff peaks, and a self-learning home load forecast from it.

---

## Table of Contents

- [Key Features](#key-features)
- [Compatible Source Devices](#compatible-source-devices)
- [Setup & Pairing](#setup--pairing)
- [Grid Connection Settings](#grid-connection-settings)
- [Home Power Calculation](#home-power-calculation)
- [Import / Export Tracking & Price Settlement](#import--export-tracking--price-settlement)
- [Peak Load (Capacity Tariff)](#peak-load-capacity-tariff)
- [Home Load Forecast](#home-load-forecast)
- [Capabilities](#capabilities)
- [Flow Cards & Automations](#flow-cards--automations)
- [Repairing / Changing the Source Meter](#repairing--changing-the-source-meter)

---

## Key Features

- **Net, Import & Export Totals:** kWh and money per hour, day, month and year — net, and split into imported and exported.
- **Selectable Price Settlement:** Price import and export per direction, as one continuous net total, or netted per time block — matching how your supplier actually bills.
- **Real House Load:** Calculates what your house itself consumes by combining grid, solar, home battery and EV charger power.
- **Capacity Tariff Peaks:** 15/30/60-minute average peak demand per day, month and year, with a live projection and headroom for the running interval.
- **Self-Learning Load Forecast:** Learns your weekly consumption pattern in 15-minute slots and predicts house load and net grid exchange for the coming hours, today and tomorrow.
- **Charts:** Today, Tomorrow, Yesterday and Weekly charts on the device.

---

## Compatible Source Devices

The source device must be registered in Homey Energy as a **cumulative** (main grid) meter. Typical examples:
- P1 smart meter readers (HomeWizard, Homey Energy Dongle, Slimme Meter apps, etc.)
- CT-clamp / main-meter energy monitors

The driver reads the import and export registers that the source device declares in its Homey Energy settings. Devices that only report a signed `measure_power` (positive = import, negative = export) are also supported: the app integrates Watt into kWh itself (**Use Watt as source**). This is less accurate — only use it when no kWh meter is available.

---

## Setup & Pairing

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Grid Power Summarizer**.
3. Choose your main grid meter.
4. Complete pairing.
5. In the device settings, check the **Grid connection** values (phases, main fuse, voltage) — see below.
6. Set the tariff (fixed, via flow, or via a Day-Ahead Pricing device in the same **Tariff update group**).

After pairing, the load forecast is trained automatically from the Insights history of your grid meter (and solar / battery / EV devices, if present). This may take a few minutes.

---

## Grid Connection Settings

**Phases**, **Main fuse (A)** and **Voltage (V)** describe your grid connection (default 3 × 25 A × 230 V ≈ 17.25 kW). They are used to:
- Reject implausible readings when calculating house load (anything above twice the connection rating is ignored).
- Provide the connection limit to the Power by the Hour Home Battery devices.

Fill in your real values — especially on a small (e.g. 1 × 35 A) or large connection.

---

## Home Power Calculation

`measure_power.home` shows what your house actually consumes, calculated live on every grid meter update:

```
Home = Grid (import +) + Solar − Battery (charging +) − EV charger (charging +)
```

- **Solar:** sum of all Power by the Hour Solar devices. Without those, the total generation from Homey Energy is used.
- **Battery / EV charger:** sum of all Power by the Hour Home Battery and EV Charger devices.
- The result is smoothed with a 2-minute rolling average, to absorb timing differences between meters that report at different moments.

The components are also shown separately as `measure_power.solar`, `measure_power.battery` and `measure_power.evcharger`.

---

## Import / Export Tracking & Price Settlement

Imported and exported energy are tracked separately (kWh and money per day, month and year), next to the regular net totals.

**Tariff selection** decides which tariff is applied:
- **Automatic** (default): import tariff while importing, export tariff while exporting.
- **Always Import** / **Always Export**.

**Price settlement scheme** decides how import and export are combined before pricing. This drives the main `meter_money_*` totals:

| Scheme | Behavior |
| :--- | :--- |
| **Per direction (continuous)** *(default)* | Import and export are priced separately at their own tariff. Matches most real-world billing. |
| **Continuous net** | Everything is netted into one total, then priced. |
| **Block settlement** | Import and export are netted per closed time block (15/30/45/60 min, or **Auto** = the price interval), then priced. |

*Per direction* and *Block settlement* need a source device that can tell import from export.

Fixed costs per hour, day and month can be added in the settings or via flow.

---

## Peak Load (Capacity Tariff)

Many grid operators bill a capacity tariff based on your highest **average** import power over a fixed interval. The driver tracks this per interval:

- **Peak load interval:** 15 min (most of the EU), 30 min (UK) or 60 min (Norway, some Swedish DSOs). The interval is shown in the capability titles, e.g. *"15 min Peak demand (import day)"*.
- **Minimum billed peak (W):** a floor the tariff always bills (e.g. `2500` in Flanders). `0` = none.

| Capability | Meaning |
| :--- | :--- |
| `measure_watt_peak.day / .month / .year` | Highest interval-average import this day / month / year. |
| `measure_watt_peak_export.day / .month / .year` | Same for export. |
| `measure_watt_peak.projected` | Expected average of the **running** interval, assuming the current import holds until the interval ends. |
| `measure_watt_peak.headroom` | Extra power you can still switch on now, for the rest of the interval, without setting a new month peak (the minimum billed peak counts too). Empty while there is no month peak yet. |

Use the **Projected peak exceeds month peak** trigger or the **Peak headroom is below** condition to switch off loads before a new peak is set.

---

## Home Load Forecast

The driver learns a weekly home load profile (7 days × 96 quarter-hours) from `measure_power.home`:
- **Initial training:** on pairing, from the Insights history of the underlying meters.
- **Continuous learning:** every quarter-hour, the profile is updated with the measured load.
- **Nightly retrain:** blends recent history into the profile.
- **Forecast accuracy:** each finished quarter-hour is compared with its forecast. The result is shown in the device settings (**Load forecast** → **Forecast accuracy**) and needs about a day of data to be meaningful.

Besides the house load, the driver forecasts the **net grid exchange** (+ import / − export):
- **Net:** home load − solar forecast (from Power by the Hour Solar devices).
- **Net incl. battery plan:** net + the planned charge/discharge of Power by the Hour Home Batteries (with ROI enabled).

EV charging is not included in the forecast.

Use **Retrain home load model** (button or flow) to rebuild the profile from scratch, e.g. after a large change in household or appliances.

---

## Capabilities

- **Live power:** `measure_power.grid`, `measure_power.home`, `measure_power.solar`, `measure_power.battery`, `measure_power.evcharger`, `meter_tariff`
- **Net energy & money:** `meter_kwh_*` and `meter_money_*` for this/last hour, day, month and year, plus month/year average price and budget targets
- **Import / export split:** `meter_kwh_*.imported / .exported` and `meter_money_*.imported / .exported` for this/last day, month and year
- **Min / max power:** `measure_watt_min.*` / `measure_watt_max.*` for day, month and year
- **Peak load:** see [Peak Load](#peak-load-capacity-tariff)
- **Load forecast:** `measure_watt_forecast.h0`, `.m15`, `.m30`, `.m45`, `.h1`, `.h2`, `.h3`, `.tomorrow_peak`, `meter_kwh_forecast.h0`, `.this_day`, `.tomorrow`
- **Net grid forecast:** `measure_watt_forecast.net_h0`, `.net_h1`
- `button.retrain_load` — retrain the load forecast model from scratch

---

## Flow Cards & Automations

### Triggers
- **Load forecast updated:** fires when the forecast is updated. Tokens: load forecast, forecast accuracy, net grid forecast, net grid forecast incl. battery plan, and peak forecast (all JSON).
- **Projected peak exceeds month peak:** fires once per peak interval, as soon as the running interval is on course to set a new month peak. Tokens: projected, month peak.

### Conditions
- **Peak headroom is / isn't below a value:** false while there is no month peak yet.

### Actions
- **Provide load forecast JSON:** returns the same JSON tokens as the trigger, for this day, tomorrow or the next hours.
- **Retrain home load model.**
- **Set a new tariff update group.**
- **Set hourly / daily / monthly fixed cost.**

The **peak forecast** JSON contains the month peak, the projected value and headroom of the running interval, and the highest expected interval average (with time) until the end of tomorrow or the month, including whether a new month peak is expected.

---

## Repairing / Changing the Source Meter

If you replace your smart meter or P1 reader, use **Repair** on the device to select the new source device. The import/export and peak-load bookkeeping is re-anchored to the new meter, so the switch does not create a false jump in money totals or peaks. Check the **Meter readings** settings (day/month/year start) afterwards.
