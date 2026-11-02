# 🚗 Smart EV Charger

**Charges your car at the cheapest time or on solar, ready when you leave.**
[← Overview](./README.md)

---

## What it does

- Plans charging days ahead in 15-minute blocks (also with hourly prices), on price and solar.
- Learns when you leave and how much you drive.
- Reaches the needed SoC before every departure.
- Tops up when the price is unusually low.
- Works with or without a car app.
- Protects the main fuse per phase, together with the batteries.

---

## Setup

1. **Add Device** → **Power by the Hour** → **Smart EV Charger**.
2. Pick the charger, or charger + car (*Charger (Car)*).
3. Check max. charging power and battery capacity. Done.

- **Charger:** class *EV charger*, or Homey's energy setting *This device is an EV charger*. A smart plug works too.
- **Car (optional):** gives real SoC, home/away and charge state.
- **Repair:** other charger or car, budget, settings.

---

## Modes

| Mode | What it does |
|---|---|
| **Smart** | Cheapest charging that is ready before departure. |
| **Solar only** | Solar surplus only. Optional: some grid power next to it. |
| **Charge now** | Straight to the daily maximum. |
| **Don't charge** | No charging. |
| **Temporary** (charge now / don't charge) | Then back to the previous mode. |

- Below the **Minimum level** it always charges right away.

---

## How Smart works

**Every need is a target:** "SoC at least X before time T".
- Each expected departure: reserve + that day's trips (or your min. SoC).
- Below reserve: back to it within **Back to reserve within (h)**.
- Below minimum level: now.

**It picks the cheapest charging that meets all targets:**
- **Days ahead:** beyond the known prices it uses expected prices. A cheap weekend fills up for the week.
- **Solar:** surplus counts at the export price, what it would earn exported.
- **Cheap extra:** up to the daily maximum when clearly cheaper than usual (learned), or below your fixed price. ≤ 0 is always cheap.
- **Max. price:** no charging at home above it.
- **No flapping:** short gaps in a session are bridged.
- **No SoC known:** plans on the usual energy per session.

**Learns your driving:** departure times and trip use per weekday. Short trips (< **Min. trip SoC**) and away periods are not learned.

---

## Key settings

- **Reserve level / Minimum level / Daily maximum (%)**
- **Charge to max SoC when cheap:** Automatic, below fixed price, or off.
- **Max. charging power** (0: measured) and **Variable charging power**.
- **Control charger:** off: drive the charger with your own flows.
- **Charger phase:** Automatic (learned from the meter), L1, L2, L3 or 3 phases.
- **Charger guards the main fuse:** the app does not cut the charger on an overload.
- **Weekly departures:** a time per weekday overrides the learned one.
- **Away periods:** e.g. `2026-09-17/2026-10-01, 2026-12-24`.
- **Plug on without car, Shared charger, Start charging in the car, V2X.**

---

## Flow cards

**Triggers**
- Car status changed
- Charge mode changed
- Car not plugged in while charging is needed
- New planned charging power

**Conditions**
- Car status is / is not …
- Charge mode is / is not …

**Actions**
- Set charge mode
- Departure today/tomorrow at …, min. SoC … (empty: unchanged; `auto`; `-` = car not used)
- Car away from … to …
- Car has left / is home
- Set car SoC
