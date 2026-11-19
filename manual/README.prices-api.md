# Prices API — Developer Documentation

This document describes how other Homey apps and HomeyScript can access the electricity and gas prices published by **Power by the Hour** (`com.gruijter.powerhour`): dynamic (market) prices as well as fixed tariffs, including their time of day and weekend changes.

Two access patterns are supported:
| Pattern | When to use |
|---|---|
| **GET** (poll) | On app init — fetch all currently known future prices |
| **Realtime push** (event) | Subscribe once; receive prices on every slot change or whenever new prices are fetched |

---

## 1. GET — Poll current future prices

Fetches all future price slots (from the current period onwards) for **every configured price device**: the Energy Price driver (`price`) and the old Day-Ahead drivers (`dap`, `dap15`, `dapg`).

```js
// In your app's onInit()
const phApi = this.homey.api.getApiApp('com.gruijter.powerhour');
const data = await phApi.get('/prices');
```

### Response format

```json
{
  "generatedAt": "2025-08-01T10:00:00.000Z",
  "prices": [
    {
      "deviceId":      "10YNL----------L_a1b2c3",
      "deviceName":    "Stroomprijs NL",
      "driverType":    "price",
      "commodity":     "power",
      "tariffType":    "dynamic",
      "biddingZone":   "10YNL----------L",
      "currency":      "€",
      "priceInterval": 15,
      "slots": [
        {
          "time":        "2025-08-01T10:00:00.000Z",
          "importPrice":  0.112,
          "exportPrice":  0.095,
          "isForecast":   false
        },
        {
          "time":        "2025-08-01T10:15:00.000Z",
          "importPrice":  0.115,
          "exportPrice":  0.098,
          "isForecast":   false
        }
      ]
    },
    {
      "deviceId":      "fixed_d4e5f6",
      "deviceName":    "Gasprijs vast",
      "driverType":    "price",
      "commodity":     "gas",
      "tariffType":    "fixed",
      "biddingZone":   "fixed",
      "currency":      "€",
      "priceInterval": 60,
      "slots": [
        {
          "time":        "2025-08-01T10:00:00.000Z",
          "importPrice":  1.25,
          "exportPrice":  0,
          "isForecast":   false
        }
      ]
    }
  ]
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `generatedAt` | ISO 8601 UTC string | Timestamp at which the response was generated |
| `prices[].deviceId` | string | Device data ID (unique per device) |
| `prices[].deviceName` | string | Name as set by the user in Homey |
| `prices[].driverType` | `"price"` \| `"dap"` \| `"dap15"` \| `"dapg"` | Energy Price driver \| deprecated: hourly electricity \| 15-min electricity \| gas |
| `prices[].commodity` | `"power"` \| `"gas"` | What the price is for. Use this instead of `driverType` to tell electricity from gas |
| `prices[].tariffType` | `"dynamic"` \| `"fixed"` | Market based price, or a fixed tariff (with its time of day and weekend changes) |
| `prices[].biddingZone` | string | ENTSO-E bidding zone code or gas hub; `"fixed"` for a fixed tariff |
| `prices[].currency` | string | Currency of the price values (e.g. `"€"`) |
| `prices[].priceInterval` | number | Slot duration in minutes (`15`, `30` or `60`) |
| `slots[].time` | ISO 8601 UTC string | Start time of the slot |
| `slots[].importPrice` | number | Consumer import price incl. all markups, taxes and VAT, in currency per kWh (gas: per m³) |
| `slots[].exportPrice` | number | Consumer export (feed-in) price, in currency per kWh. Not meaningful for gas |
| `slots[].isForecast` | boolean | `true` = Stekker AI forecast, `false` = confirmed market price or fixed tariff |

> **Note:** All prices are the user's final prices: markups, taxes, VAT and exchange rate included. Raw market prices are intentionally omitted.

---

## 2. Realtime push — Subscribe to price updates

Subscribe once in `onInit()`. Power by the Hour will emit `prices-updated` in two situations:

| `reason` value | When |
|---|---|
| `"period-changed"` | At the start of every new slot (every `priceInterval` minutes) |
| `"new-prices-fetched"` | When new prices are available: for dynamic prices typically once per day around 13:00–15:00 CET when tomorrow's prices are published; for a fixed tariff once per hour, when its slots are rebuilt |

```js
// In your app's onInit()
const phApi = this.homey.api.getApiApp('com.gruijter.powerhour');

phApi.on('realtime', ({ name, data }) => {
  if (name !== 'prices-updated') return;

  const { reason, generatedAt, prices } = data;
  // prices has the same structure as the GET response (one entry per device)
  this.log(`Prices updated [${reason}] at ${generatedAt}`);

  prices.forEach((device) => {
    this.log(`${device.deviceName} (${device.commodity}, ${device.tariffType}): ${device.slots.length} future slots`);
    const now = device.slots[0]; // current slot is always first
    this.log(`  Current import: ${now.importPrice} ${device.currency}/kWh`);
  });
});
```

### Push payload format

The push payload has the **same structure** as the GET response, with one extra field at the top level:

```json
{
  "generatedAt": "2025-08-01T10:00:00.000Z",
  "reason":      "period-changed",
  "prices": [ /* same as GET response */ ]
}
```

> **Note:** Each push event contains data for **one device only** (the device whose slot changed or whose prices were refreshed). Use `deviceId` to identify which device sent the update.

---

## 3. HomeyScript example

You can also use this API from HomeyScript (e.g. to test or for simple automations):

```js
// HomeyScript — fetch all current prices
const data = await Homey.api('GET', '/api/app/com.gruijter.powerhour/prices');
const now = new Date();

data.prices.forEach((device) => {
  const currentSlot = device.slots.find(s => new Date(s.time) <= now);
  log(`${device.deviceName}: ${currentSlot?.importPrice} ${device.currency}/kWh`);
});
```

---

## 4. Recommended pattern for other apps

```js
class MyApp extends Homey.App {
  async onInit() {
    // 1. Get API reference
    this.phApi = this.homey.api.getApiApp('com.gruijter.powerhour');

    // 2. Fetch initial prices (for app startup / cache warming)
    try {
      const initial = await this.phApi.get('/prices');
      this.handlePriceUpdate(initial);
    } catch (err) {
      this.error('Could not fetch initial prices:', err);
    }

    // 3. Subscribe to push updates
    this.phApi.on('realtime', ({ name, data }) => {
      if (name === 'prices-updated') this.handlePriceUpdate(data);
    });
  }

  handlePriceUpdate({ generatedAt, reason, prices }) {
    // reason is undefined on the initial GET response
    prices.forEach((device) => {
      // process device.slots ...
    });
  }
}
```

---

## 5. Notes & caveats

- The API is only available when Power by the Hour is installed and running on the **same Homey**.
- If no price devices are configured, `prices` will be an empty array.
- Prices are in the **user's configured currency** (field `currency`). This may differ from € if the user has set a custom exchange rate.
- `slots` always starts at the **current period** and includes all known future slots (up to tomorrow if market prices are available, plus up to 24 h of AI forecast if enabled).
- A fixed tariff always has slots up to the end of tomorrow. Its prices change only where the user set a time of day or weekend markup.
- Slots advance every `priceInterval` minutes.
- `driverType` is kept for existing integrations. New integrations should use `commodity` and `tariffType`.
