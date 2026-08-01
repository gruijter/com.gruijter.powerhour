# Electricity Summarizer (Power Driver)

The **Power Summarizer** device aggregates electricity consumption and production data from your smart meter, energy meters, or power meters. It calculates real-time kWh usage and monetary costs across hourly, daily, monthly, and annual periods.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/5/5/55d1f95545e8389c18729221bf901a71321811fb.jpeg" alt="Power Summarizer Device Tile" width="350"/>

---

## Table of Contents

- [Key Features](#key-features)
- [Setup & Pairing](#setup--pairing)
- [Homey Energy Virtual Devices](#homey-energy-virtual-devices)
- [Configuration & Settings](#configuration--settings)
- [Standby / Always-On Power Detection](#standby--always-on-power-detection)
- [Heat Pump & Dedicated Appliance Monitoring](#heat-pump--dedicated-appliance-monitoring)
- [Virtual Meter Setup](#virtual-meter-setup)
- [Useful Flow Cards & Automations](#useful-flow-cards--automations)

---

## Key Features

- **Multi-Period Summaries:** Real-time calculation of kWh and money spent/earned for *this/last hour, day, month, year*.
- **Flexible Source Selection:** Automatically selects the best available energy capability (`meter_power`, `meter_power.consumed`, `meter_power.t1/t2`, etc.) or falls back to power polling (`measure_power` in Watts).
- **Homey Energy Integration:** Summarize all smart meters, solar panels, or individual devices connected to Homey Energy in a single device.
- **Budget Tracking:** Track consumption against a reference annual budget with linear, Dutch 2023 price ceiling (`el_nl_2023`), or solar PV distribution models.
- **Always-On Power Detection:** Measures minimum Wattage per period to highlight standby power consumption. Save ~90 kWh/year (€20–€40) per 10W saved!
- **Dynamic Tariff Groups:** Automatically receive real-time hourly rates when paired with a Day-Ahead Pricing (DAP) device via Tariff Groups.

---

## Setup & Pairing

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/1/2/12a1275dde87ca9c92c8d79ce12db4f586e2866b_2_250x220.jpeg" alt="Driver Selection" width="220"/> <img src="https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/d/7/d7a40d7917baf5456c07562b42c6b4d37b7ed7cd.jpeg" alt="Device Selection" width="180"/>

1. Go to **Devices** → **Add Device** → **Power by the Hour**.
2. Select **Power Summarizer**.
3. Select your source device from the detected list (e.g. P1 Smart Meter, Plugwise Smile, Youless, Homewizard, Shelly, or Smart Plugs).
   - *Note:* PBTH automatically picks the best energy capability. If your device isn't listed, select **Virtual Meter** at the bottom of the list.
4. Click **Next** to complete pairing.

---

## Homey Energy Virtual Devices

During pairing, PBTH also offers special virtual aggregators that summarize Homey Energy groups:

| Virtual Device Name | Source Data | Description |
|---|---|---|
| `HOMEY_ENERGY_SMARTMETERS_Σpower` | Homey Energy Cumulative | Aggregates total net house grid import/export |
| `HOMEY_ENERGY_SOLARPANELS_Σpower` | Homey Energy Solar | Aggregates all solar panels connected to Homey Energy |
| `HOMEY_ENERGY_DEVICES_Σpower` | Homey Energy Devices | Aggregates total power from all smart plugs and measured devices |

---

## Configuration & Settings

### Initial Meter Readings & Tariffs
- **Initial Readings:** Navigate to **Device Settings** to set starting values for *This Month* or *This Year* if you are setting up mid-period.
- **Fixed Tariff:** Enter your fixed electricity contract price per kWh directly in the device settings.
- **Dynamic Tariff:** If your contract uses peak/off-peak or dynamic hourly rates:
  - Assign a **Tariff Update Group** (e.g. `1`) in Device Settings to automatically receive rates from a DAP device.
  - Or update the tariff dynamically via Flows using the **Set Tariff** card.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/4/d/4d66a18295c0e18112eed0150d22ca9864a2773c_2_200x290.jpeg" alt="Tariff Change Flow" width="200"/>

### Budget Distribution Models
Choose how your annual kWh budget is distributed across months:
- **Linear:** Equal allocation each month (30.4 days/month).
- **Dutch 2023 Price Ceiling (`el_nl_2023`):** Weighted for seasonal heating and household usage patterns.
- **Solar PV:** Weighted according to typical European solar irradiance curves.

---

## Standby / Always-On Power Detection

The `measure_watt_min` capability measures the lowest power draw over a period.

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/optimized/3X/2/3/238b5a7c7a3495dd4e375d5b8f3621ccc97b8bf6_2_200x411.jpeg" alt="Always On Power Detection" width="200"/>

> [!TIP]
> **Energy Saving Tip:** Check the minimum Wattage reported during early morning hours (e.g. 03:00–05:00). **Every 10 Watt saved on this value saves ~90 kWh/year (approx. €20–€40 per year)!**

---

## Heat Pump & Dedicated Appliance Monitoring

You can add a dedicated Power Summarizer device for heavy consumers like heat pumps, air conditioners, hot tubs, or washing machines.
- Select the smart plug or power meter measuring the appliance as the source device.
- Set the tariff or link it to your DAP device via a Tariff Group.
- Gain full visibility into hourly, daily, monthly, and yearly running costs without resetting the original device meter.

---

## Virtual Meter Setup

If your source device uses non-standard capability names or split tariffs:
1. Select **VIRTUAL_METER** during driver pairing.
2. Create a Flow to push cumulative values into PBTH:

<img src="https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/5/5/55e82da0ff03a2e8357db5e83bf71d458e72040b.png" alt="Virtual Meter Upload Flow" width="220"/>

> [!IMPORTANT]
> The meter value for energy must be the total cumulative net kWh: `(consumed_high + consumed_low) - (returned_high + returned_low)`.

---

## Useful Flow Cards & Automations

### Triggers
- **Energy target exceeded / below:** Trigger when monthly/yearly consumption strays from budget.
- **New hour / day / month / year:** Trigger automations on period boundaries.

### Actions
- **Set Tariff:** Dynamically update the active tariff rate per kWh.
- **Set Meter Value:** Force-set meter readings from external inputs.
