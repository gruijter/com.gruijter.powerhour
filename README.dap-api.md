# DAP Prices API — Developer Documentation

This document describes how other Homey apps and HomeyScript can access the electricity and gas spot prices published by **Power by the Hour** (`com.gruijter.powerhour`).

Two access patterns are supported:
| Pattern | When to use |
|---|---|
| **GET** (poll) | On app init — fetch all currently known future prices |
| **Realtime push** (event) | Subscribe once; receive prices on every slot change or whenever new prices are fetched |

---

## 1. GET — Poll current future prices

Fetches all future price slots (from the current period onwards) for **every configured DAP / DAP15 / Gas device**.

```js
// In your app's onInit()
const phApi = this.homey.api.getApiApp('com.gruijter.powerhour');
const data = await phApi.get('/dap-prices');
```

### Response format

```json
{
  "generatedAt": "2025-08-01T10:00:00.000Z",
  "prices": [
    {
      "deviceId":     "10YNL----------L_a1b2c3",
      "deviceName":   "Stroomprijs NL",
      "driverType":   "dap",
      "biddingZone":  "10YNL----------L",
      "currency":     "€",
      "priceInterval": 60,
      "slots": [
        {
          "time":        "2025-08-01T10:00:00.000Z",
          "importPrice":  0.112,
          "exportPrice":  0.095,
          "isForecast":   false
        },
        {
          "time":        "2025-08-01T11:00:00.000Z",
          "importPrice":  0.134,
          "exportPrice":  0.117,
          "isForecast":   false
        }
      ]
    },
    {
      "deviceId":     "10YNL----------L_d4e5f6",
      "deviceName":   "Kwartiertarieven NL",
      "driverType":   "dap15",
      "biddingZone":  "10YNL----------L",
      "currency":     "€",
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
    }
  ]
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `generatedAt` | ISO 8601 UTC string | Timestamp at which the response was generated |
| `prices[].deviceId` | string | Homey device ID (unique per device) |
| `prices[].deviceName` | string | Name as set by the user in Homey |
| `prices[].driverType` | `"dap"` \| `"dap15"` \| `"dapg"` | Hourly electricity \| 15-min electricity \| gas |
| `prices[].biddingZone` | string | ENTSO-E bidding zone code |
| `prices[].currency` | string | Currency of the price values (e.g. `"€"`) |
| `prices[].priceInterval` | number | Slot duration in minutes (`60` or `15`) |
| `slots[].time` | ISO 8601 UTC string | Start time of the slot |
| `slots[].importPrice` | number | Consumer import price after markup, in currency/kWh |
| `slots[].exportPrice` | number | Consumer export (feed-in) price after markup, in currency/kWh |
| `slots[].isForecast` | boolean | `true` = Stekker AI forecast, `false` = confirmed market price |

> **Note:** All prices include the user-configured markups and exchange rate. Raw market prices are intentionally omitted.

---

## 2. Realtime push — Subscribe to price updates

Subscribe once in `onInit()`. Power by the Hour will emit `dap-prices-updated` in two situations:

| `reason` value | When |
|---|---|
| `"period-changed"` | At the start of every new slot (every hour for DAP, every 15 min for DAP15) |
| `"new-prices-fetched"` | When new market prices are fetched from the provider (typically once per day around 13:00–15:00 CET when tomorrow's prices become available) |

```js
// In your app's onInit()
const phApi = this.homey.api.getApiApp('com.gruijter.powerhour');

phApi.on('realtime', ({ name, data }) => {
  if (name !== 'dap-prices-updated') return;

  const { reason, generatedAt, prices } = data;
  // prices has the same structure as the GET response (one entry per device)
  this.log(`Prices updated [${reason}] at ${generatedAt}`);

  prices.forEach((device) => {
    this.log(`${device.deviceName} (${device.driverType}): ${device.slots.length} future slots`);
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
// HomeyScript — fetch all current DAP prices
const data = await Homey.api('GET', '/api/app/com.gruijter.powerhour/dap-prices');
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
      const initial = await this.phApi.get('/dap-prices');
      this.handlePriceUpdate(initial);
    } catch (err) {
      this.error('Could not fetch initial DAP prices:', err);
    }

    // 3. Subscribe to push updates
    this.phApi.on('realtime', ({ name, data }) => {
      if (name === 'dap-prices-updated') this.handlePriceUpdate(data);
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
- If no dap/dap15/dapg devices are configured, `prices` will be an empty array.
- Prices are in the **user's configured currency** (field `currency`). This may differ from € if the user has set a custom exchange rate.
- `slots` always starts at the **current period** and includes all known future slots (up to tomorrow if market prices are available, plus up to 24 h of AI forecast if enabled).
- For DAP15 devices, `priceInterval` is `15` and slots advance every 15 minutes.
