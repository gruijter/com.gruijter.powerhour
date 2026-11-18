# Architecture and design decisions

Why the code is the way it is, pitfalls, and stored data formats. The code itself carries no
explanatory comments: look here (per module) before changing something that looks odd.
Generic Homey SDK / Insights / memory findings live in the shared skill
`~/HomeyDev/.agents/skills/homey-app-development/SKILL.md`.

## Cross-cutting rules

- **Restart/init**: a restart waits for a running init (`restartDevice`), so two inits never run at once. Homey refuses `setSettings` while `onSettings` is pending: settings changes that need a write are handled after the restart.
- **`setSettings()` skips `onSettings()`** (SDK Device.d.ts): code that changes settings itself must apply the side effects (restart, tariff history) itself.
- **Rebuilt capabilities** (DeviceMigrator) come back with the manifest's options: options are synced again after a migration.
- **Jitter on hourly/15m events**: all drivers fire on the same app events; a random jitter spreads their update loops. Without it a burst of Insights fetches and chart rebuilds pushed the process over its memory limit. Own devices run sequentially, not via `Promise.all`.
- **Tariff of a new price slot** is set first, without jitter, on all consumers (`app.slotTariffs()`), so flows on the price period trigger read the new `meter_tariff`. Price devices wait at most `SLOT_TARIFF_WAIT_MS`.
- **Store writes**: `setStoreValue()` sends the whole store (IPC). Fast-changing data (price lists, histories, profiles, day logs) lives in the file store (`FileStore`); hot-path bookkeeping is throttled (`STORE_FLUSH_MS`, max loss on crash).
- **Charts are not time-critical**: drawn after a slot boundary's burst (`LoadSpread`). A deferred chart is flushed before a trigger whose flow sends the image.
- **Trigger state** passed to run listeners holds only what they read: Homey serializes it per card; the full device state cost MBs per period (2026-11-12).
- **Homey Energy settings** (`energy_exclude` etc.) arrive in `onSettings` too: `EnergyExclude.onlyHomeyEnergy()` → nothing to do.
- **Multi-currency**: thresholds are shares/ratios, never fixed money amounts.
- **Times**: everything is derived from real UTC slot timestamps (DST-safe local midnights via `TimeHelpers`), never from local clock hours. Plan slots follow local minutes (half-hour-offset zones such as India, Adelaide). Solar `yieldFactors[]` is indexed by real UTC hour.
- **"Drivers not loaded"**: `homey.drivers.getDriver()` throws when no device of that type is paired; callers catch and skip.

## lib/Budget.js, lib/ClimateProfile.js

- Day of year 1-366; leap day disregarded in budget shares. Budget period can cross two years.
- ClimateProfile: parts fitted on ERA5 De Bilt 2014-2023 against NEDU profiles E1A/G1A, kept at their Dutch size per degree-day or night hour. Heat pump COP: EN 14511 ratings; air conditioning: EIA RECS 2020. Night hours at 52.1°N; sunrise at -0.83°. Hybrid heat pump leaves heating to the boiler below a daily mean threshold.

## lib/DeviceMigrator.js

- Kept identical (apart from the licence header) in com.foxess, com.solarwatt, com.solaredge, com.growatt and com.gruijter.powerhour; the algorithm is com.kia_hyundai's.
- Homey orders tiles by the order capabilities were added: a capability slotted in the middle means a rebuild from that point. Values are carried across the rebuild.
- Only what follows the first mismatch is rebuilt; dropped capabilities are removed wherever they are. The list is snapshotted once (re-reading after each change is O(n²)).
- One migration per device at a time (an optional capability reported during init would otherwise race).
- Never delete a custom capability's definition in the release that drops it: Homey then rejects every add/removeCapability on devices that still carry it ("Invalid Capability").
- A removed enum value is not restored (assumed rejected; not verified). `null` stored value: restore is a no-op.
- Option values compared structurally (per-language titles; key order not significant).
- `setClass` breaks flows depending on the old class: only when it differs. Energy object: refresh of paired devices from the manifest not verified, so compared and written.
- Reading capability options throws "Invalid Capability" for a capability without own options (confirmed live 2026-10-05): then compare against the manifest's.
- Settle pause after every add/remove (1 s; kia uses 2 s).

## lib/PriceCalculator.js, lib/PriceFormula.js

- TOD string: `h:markup` or `h:mm:markup` (mm 0/15/30/45) → 96 quarters; quarters before the first entry take the last entry's value. A time within the hour needs 15-minute price slots.
- Prices are rounded to 7 decimals against float noise (MWh price with 2 decimals × 21 % VAT).
- Formula variables: `market` (per unit after exchange rate), `tod`, `weekend` (weekend markup replaces TOD on weekend days), `markup`, `tax`, `vat`, `percent`, `abspercent`, `import` and `supply` (export only; supply = market part + supplier markup, no tax/time markups/VAT). Operators `+ - * /`, `min`, `max`, `abs`; dot decimal, comma or semicolon separator.
- `abspercent` follows the sign of the market price. Import with marketFloor: negative market counts as zero. Export floor: minimum and X % of the base, both with export VAT.

## lib/charts

- Chart specs are plain JSON posted to quickchart.io: no formatter functions (legend filter is written in via `withLegendFilter()`, QuickChart accepts the chart as JavaScript). QuickChart calls a filter even with the legend hidden.
- Chart.js v2 draws the first dataset on top.
- `isFuture` (slot not happened) is independent of `isForecast` (price not published).
- Palette (lib/charts/Palette.js) is the single source of colours; `tools/widget-shared/gen.js` writes it into widget CSS as `--c-<name>`.
- PriceChart label offset assumes a ~250 px plot area (rendered externally).
- Solar chart: forecast drawn on top of real. A yieldFactors array of all zeros (before the first retrain) is treated as absent.
- ImageHelpers dedupes in-flight fetches per cacheKey (stringified config); a failed fetch is retried.

## lib/flows

- Action card errors are logged and rethrown so they reach the user's flow.
- `settings.set()` returns void (@types/homey): no promise to catch.
- Tariff broadcast groups → drivers: solar/grid remapped to `power`, gas/water own name; battery/evCharger always on `power`. `applyTariffFromEvent()` is awaited per driver so the card resolves after the tariff is written; first failure thrown after all.
- After a flow tariff, price devices feeding the same group send their next list in full (not shift-only).
- Battery plan cards: re-trigger when a duration ends; a newer plan for the same card cancels the pending stop. Triggered twice (inverted and normal sign). No retrigger when the duration crosses into the next slot.
- Price trigger cards fire only in the first period they become true, per card and args; unknown before a priming run.
- Price comparisons relative to |avg| (negative average stays the right way round).
- Comparing new prices uses the rounded token values: a higher ranking provider confirming the same prices must not trigger again.
- Sum flows: JSON tokens are only built for periods a flow on this device uses.
- Device-only EV cards: no args, every flow on the device runs.

## lib/genericDeviceDrivers (meters, charge devices, price devices)

- MeterDeviceMixin is mixed into the prototypes of generic_sum_device and generic_bat_device: no `super` calls inside.
- Up to v9.0.3 a device could count from a start date; it moves once to calendar months/years (from Insights). A main meter with that start keeps it as contract year (`meter_money_this_contract`).
- Money of last month/year after a move: energy part scaled with kWh (same average price), markups of a full period kept. Not for net meters (battery; grid uses `rebaseSplitMoney()`).
- Fixed costs (markups) are kept apart in `fixedMoney` so `_avg` capabilities show the energy price per kWh (issue #229).
- Meter jump guard (issues #126/#234/#341, #155/#215/#289/#353): IMPOSSIBLE value (≥1e7, above any domestic register) rejected; ANOMALY (scaled to own usage, `anomalyCeiling()`) withheld until the next reading confirms, then all baselines re-anchored; GROSS jump needs one more consistent reading. Never reject outright: later valid readings would deadlock against a stale value. A corrupt stored reading is re-anchored. `Math.abs()`: meters wired negative are protected too (#353). Delta limit: 20× last full hour or day (bursty EV chargers), fixed floor without history. Direction = how the meter went this year/month, not the sign.
- Another source device: its first reading continues the totals; the difference between meters is not booked.
- A poll re-feeds our own value only for the rollovers: `checkMeterJump()` skipped (a zero delta would clear a pending anomaly).
- Self-heal of hour/day baselines only against the counting direction and implausible margins; month/year not checked.
- Listener silent an hour while the meter moved → polled every minute from then on (store, survives restarts).
- `firstReadingDone`, not `initReady`: a reading after a failed init must not end its retry; polling devices set initReady early.
- `meter_tariff` is the tariff now: a delta across a price-period boundary is paid at the previous tariff (`MeterHelpers.getPeriodTariff()`).
- Battery meter counts energy delivered to the home (charging lowers it); EV charger sets `measureAddsToMeter`.
- Charge/discharge counters per period: counter minus its value at the period start (store `counterReadings`); a counter drop (source reset) keeps the period count. Source log first (own counter only followed it from 2026-03-20).
- Battery v8 `roiEnable` → v9 `precisePlanning`: v8 batteries get the light planner (LP needs far more memory).
- Price lists start at `pricesStartTm`; after a slot change the first entries are past until the next broadcast. A list without it (flow tariff) is valid as is.
- A deleted price device: battery/EV group gets no prices (as never fed); meters keep their last tariff.
- Price device: providers ranked; a lower ranking provider only fills missing periods (Stekker cannot overwrite Entsoe/Nordpool). Small differences (≤5 EUR/MWh) don't flip provider. Forecast at 60 m interpolated to 15 m slots. Fetch retries scheduled at the earliest of pending retry and rate-limit end; waits over an hour left to the hourly event. Exchange rate fetched with random delay.
- Month averages kept in capabilities over restarts; rollover stored with the averages (a flow before the period event must not consume it).
- Inter-app prices payload: `getApiApp('com.gruijter.powerhour')`, realtime event reasons `period-changed` | `new-prices-fetched`.
- `applyTariffFromEvent()`/`updateDeviceTariff()` share a per-driver exclusive queue (`Util.runExclusive`); inside it never call the public locked method (deadlock).
- Finest declared interval of a tariff group wins (PriceIntervalGroups).
- A meter that counts down (solar/export wired negative) has negative totals (issue #353). An edited month/year total replaces the fixed costs booked in it.
- Tariff group 0 = fixed tariff settings (no price device). `tariff_export` was new: older devices got the import price once (store `fixedExport`).
- v8 meters sit in tariff group 1 (the old manifest default) with their fixed tariff. Once per device (store `fixedTariffChecked`), a minute after start: a meter whose group has no price device (old dap drivers included) and no `set_tariff_<commodity>` flow moves to group 0, so its tariff keeps working as the fixed tariff. Only once the flow scan succeeded (needs the Homey API).
- Source detection order: Homey energy object, then driver-specific capabilities, then a single primary meter. Own app devices and Homey's virtual power device are never sources.

## lib/helpers (A–M)

- **BatteryHistory**: capacity/power proposal at pairing from hourly Insights of the source. Summed hourly power matches the kWh meters within 0.5 % (Sessy, Dev, 2026-11-12). Capacity from discharge runs (charge runs include losses, ~15 % high on a Sessy). Max power = highest hour rounded up (a lower limit). Proposals only.
- **BatteryPlan**: LP (`precisePlanning`, loaded only when used, several MB per solve) or light planner. Batteries controlled in one mode are planned together (one LP, first member solves). A plan stays while each SoC is within a few points of the planned one (a solve per SoC step cost CPU and memory). Members plan up to ~25 s apart. Killed in the LP → light planner until CrashNotice turns the LP off.
- **BudgetSetup**: year start and budget are app-managed settings (not in the manifest), set in pair/repair setup views; the settings page shows a summary label. 'NONE' became budget 0. Pair/repair handlers time out after 30 s: climate fetch waits at most `maxWaitMs`.
- **ChargeDeviceHelpers**: price lists indexed by time once per list (a per-slot scan with a Date per entry cost up to 17 MB per 30 s, 2026-11-12). Price profile: the Energy Price device's once it learned from history (`PriceDeviceProfile.isReady`), else the device's own (learned from flow prices). `PRICE_BOOTSTRAP_VERSION` bump rebuilds own profiles. Yesterday's price history from Insights once per local day, fetched once for the whole group; 'today' resolution only returns today; Insights pads windows with nulls; timestamps can be at the end of the hour (closest within 55 min). Plan schedule: block 'zero' became 'xom'. scheme[0] is the current partial slot from `planTm`.
- **ChartImages**: camera images are not capabilities: order fixed at first `setCameraImage()`, recreated every app start, a re-created id goes to the end. Registered in canonical order at every boot, before chart content exists, with jitter.
- **ClearSkyGHI**: NOAA sun position (within 3 W/m² of astronomy-engine); that library cost ~2.5 MB and ~20× allocations (Dev, 2026-11-13).
- **ClimateNormals**: Open-Meteo ERA5 (10 full years) + PVGIS monthly PV, in app settings for a year, location rounded to 0.1°. PVGIS optimal angles unusable south of the equator: facing the equator.
- **ContractYear**: every meter counts calendar months/years; main meters can have a contract start ('ddmm'). Insights jobs (restores, rebases) one at a time app-wide (`serial`). Meter value at ms from bucket centres; thisYear/lastYear are UTC calendar years, last2Years weekly.
- **CrashNotice**: Homey restarts the app after a crash and counts it (`crashedCount`, Web API). The LP writes a marker file synchronously before and clears it after (it blocks the process): a marker at start = killed in the LP. Then LP off for all batteries + timeline notice.
- **DapTakeover** (TEMPORARY): remove with the old DAP drivers (search 'DapTakeover'). Old amounts included VAT. Month averages carried with their last-updated day/month.
- **DayLog** format: `{ v, year, <a>, <b>, money, est [366], mMoney [12], prev { year, from, ... last 31 days } }`, -1 unknown, money -1 encoded as -1.0001. Rebuilt once from Insights 5-7 min after start (fillVersion bump rebuilds), retried hourly ×3 after failed reads. Exact day ends: hourly means equal over the last two hours, else the 'last day' counter an hour after its roll.
- **EnergyExclude**: Homey Energy settings (energy_exclude, energy_value_constant) cannot be set by the app (setSettings no effect, Web API 'Missing Scopes', Dev 2026-11-16).
- **EvCarCaps / EvChargerCaps**: confirmed ids from com.kia_hyundai and com.zaptec; 'guessed' ids from other apps' manifests, used only when their type fits. `Number(null)` is 0: an unreported location is no location.
- **EvHistory**: charge power = p99 of readings above 500 W rounded to 100 W; default 16 A single phase.
- **FileStore**: whole-store sends of 200 KB stores pushed the app over the memory limit (2026-10-28). /userdata survives reboot and update and is served over http: random file name per device. Written at most once per `WRITE_DELAY_MS`, only when changed, tmp + rename. Keys still in the device store move once.
- **FixValues**: `getCapabilityOptions()` throws for a capability without own options: fall back to the manifest.
- **FlowScan**: card ids in flows are `homey:app:<app>:<card>` or `homey:device:<id>:<card>` (Dev 2026-11-15); image use as `homey:device:<id>|image-…`. Reads all flows: only on demand, never on a minutes timer.
- **GridConnection**: default 3×25 A @ 230 V = 17250 W. Plausibility ceiling is a sanity bound only, never for load balancing/safety. Several grid devices: the largest wins.
- **HistoryLookup**: Insights 'yesterday' (5-min) always returns the previous calendar day, ignores start/end. Light 3-tap moving average per series before combining meters (reporting times differ; confirmed 2026-08-10). Load stored history before `super.onInit()`, or a fresh instance's first save overwrites it.
- **HomePowerReconstruction**: home = grid + solar − battery − EV − appliances, per 15 min, per device then summed; a large negative residual is dropped, not clamped.
- **InsightsHistory**: every entry is the mean of `[t, t+step)` at every resolution (Dev+Prod 2026-11-14, 16 logs, 7 apps): no time shift. Log ids looked up directly (`getLogs()` lists ~2000 logs, ~13 MB). Step read from data, never from the resolution name. Meter → power by central difference.
- **LoadSpread**: non-critical work (charts) moved out of the quarter-boundary burst (+13 MB heap measured, Dev 2026-10-19).
- **MemLog** (dev builds with `PBTH_MEMLOG=1`): app setting memLog `{ limit, boots[], rows[], spikes[], crashes[] }`; row per 15 min, sampled every 10 s.
- **MeterHelpers**: a month starts on the start day or the last day of a shorter month. A cumulative source meter only goes up: a lower value is a reset only when it lasts `holdMs`. Tariff across a price-interval boundary: the previous interval's when set at/after the boundary.
- **MigrationNotice**: last notification times in app settings (survive restarts). replace ≤7 days, flows ≤3 days, cards a day after welcome then ≤7 days, tariff conflict via SetupNotice daily; tariff flow names fetched ≤1/h.
- **MinMaxTracker**: min/max per day/month/year, no 15-minute window (capacity tariffs bill the average, a different metric). Boundaries from the reading's own calendar fields.
- **MoneyUnit**: currency and decimals of a consumer come from the price device of its group (sent with its prices), stored `{ currency, decimals }`; older devices fall back to their removed settings (still in `getSettings()`). HUF in whole forints.

## lib/helpers (P–W)

- **PairSetup**: driver opts in with `ds.setup = { settings, steps: [{ id, ids, optional, roles, repairOnly }], preset, prices, requirePrice }` plus optional hooks `setupSettings, setupInfo, setupValue, setupProposals, setupParsed, setupCalc, setupRoles, setupStored/setupStore, setupNewStore, setupValidate, repairActions, capabilitiesFor` (see the hook list at the top of the file history). App-managed settings (SetupSettings.json, DriverSetupSettings.json) live outside the manifest but stay readable/writable. View handlers must stay under Homey's 30 s timeout. Virtual sources get a new id per listing. The group's currency is written at pairing (else the first prices set it, with a restart during init).
- **PriceDeviceProfile**: profile learned from the device's own prices, bootstrapped once from the longest of its own and taken-over dap logs; learned before every broadcast (no Insights reads). `BOOTSTRAP_VERSION` 3: daily sums. Reset on a new market or currency.
- **PriceDrivers**: no "no price device" warning when a tariff flow feeds the group (`flowFed`): a flow run in the last 26 h (in memory) or a `set_tariff_*` card for that group in the flow scan (`FlowScan.tariffFlowGroups`, cached 6 h in app memory, refreshed hourly by the meter drivers).
- **PriceDrivers**: what a price device is (commodity, interval) comes only from these helpers, never from driver id checks elsewhere. Devices are still listed during `onDeleted()` (`isDeleted`). A group's prices are dropped when no price device is left, except a group last set by flow. Flow tariff conflicts kept in app memory per `<commodity>|<group>`.
- **PriceIntervalGroups**: several sources per group made last-write-wins flip the interval and drop quarterly updates: per source the latest declaration is kept, the finest wins, silent sources stop voting after two missed hourly rounds. A flow's Set Tariff has no interval (inherits). Lazy per-app singleton reached defensively (driver onInit can run before the app's); never a precondition for the broadcast.
- **PriceLevels**: cheapest/dearest hours per day (`priceLevelHours`); a flat day (spread < 10 % of mean) is normal; ≤0 is free.
- **PriceSetup**: an exchange rate is only known after the first fetch: preview stays in € until then. Luxembourg uses DE-LU zones. An own formula is checked in the view (pairing has no onSettings).
- **PriceShift**: a broadcast list (from `pricesStartTm`) gives every coming slot: receivers move on themselves at a slot change; a price device only broadcasts with news.
- **PriceZones**: zone from Homey's time zone, then nearest rough zone centre within a country.
- **SettingsView**: setup settings shown read-only as `view_<id>` labels; manifest part generated by `test/tools/settingsView.js`.
- **SetupNotice**: setup conflict notices when a conflict starts or its detail changes, then ≤1/day; in memory (a restart notifies once more).
- **SolarEclipse**: weather models don't model eclipses; astronomy-engine (~2.5 MB) loaded only for the daily search and released from the require cache (both references). Raised-sine ramp.
- **SolarHistory**: one log fetched at a time and reduced at once (~1600 numbers). Estimates per 6-hour bucket (no finer data for the year). A bucket where batteries discharge >10 % of solar can't be told apart from battery export: own use unknown. Meters' zero points differ: one series per day.
- **SourceCaps**: choice stored `{ sourceId, caps: { role: id | 'auto' | 'none' } }`; units, else id when an app omits units.
- **SourceDeviceHelper**: `fresh` reads bypass the cached HomeyAPI object (`$updateCache false`), so listeners stay on the cached object.
- **TimeHelpers**: one Intl formatter per zone; UTC offset cached per quarter (offsets are whole quarters). `formatToParts()` per call allocated MBs per plan (2026-11-12). 30/60-min blocks need the offset (half-hour zones). Local midnight in two passes (DST). Clock args: '7:30' or decimal hours (7.5 or '7,5').
- **Util.runExclusive**: tariff broadcast handlers are re-entrant (`homey.emit()` doesn't wait); overlapping runs could hand a device the older tariff last. `.then(fn, fn)` so a rejection doesn't block the queue. `awaitMigration` in onUninit at most maxMs.
- **WidgetData**: Homey Energy counts this app's own devices too (double with their sources). Gas/water meters of the home: those on the grid's source device, else all (a submeter would count twice). Flows signed as on the Grid Monitor; unsmoothed balance can be negative from timing skew.
- **WidgetData** periods: solar `{ kwh, own, money, est }`; battery/EV `{ charged, discharged, money, est }`; grid `{ imported, exported, money, est }`. Unknown own use/money of a part: scaled from parts holding ≥ half the kWh (estimated). Estimated days add up to the meter difference over the month: only missing days make a month uncertain. Price widget keeps one scale for both days (lowest/highest incl. 0). Device zones via the app's Homey API (SDK has no device zone), cached 10 min. Homey Energy reports: live per zone 30 s cache, per device 60 s cache.

## lib/providers

- Market providers are ranked; Stekker is lowest (never revalidate), Nordpool highest in its zones (nothing can correct it there; no conditional requests, revalidate rarely). Nordpool returns EXAA (sequence 2) prices, not SDAC.
- **ENTSO-E**: strict rate limits; calls spread over 45 min (esp. around 13:00 CET publication), at most once an hour, back off up to 6 h. Only zones that publish day-ahead prices (swept 2026-09-10; GB, RU Kaliningrad, TR, UA BEI have none: re-run the sweep before adding a zone). SEM all-island zone; EirGrid control area has no prices. A document can mix resolutions: finest per hour kept, never mixed within an hour; mRID duplicates skipped.
- **EntsoeGruijter** proxy (Cloudflare R2, 5 min CDN): cheap, conditional request → 304 = unchanged. '10Y1001A1001A59C' is SEM, not Amprion. IT Saco DC not offered (always the 1700 EUR/MWh cap).
- **OMIE**: primary for ES/PT (ENTSO-E Spain didn't match, 2026-09-10/11). MIBEL day is CET-aligned for both zones; a Lisbon civil day runs one hour past the last auctioned hour. Columns: year;month;day;period;pricePT;priceES, both on Spanish local time. 92/100 periods on DST days. A missing day is an HTML 404 page with status 200: sniff the payload.
- **SMARD**: backup for DE and neighbours (15 zones), CC BY 4.0 attribution "Bundesnetzagentur | SMARD.de". Filter ids not published: derived 2026-09-10 by matching values; re-verify before adding (a wrong id serves another country). Week files padded with nulls; fetch every week the window touches, always the newest.
- **Stekker**: zones must match `biddingZonesMap` (DE_LU answers 422). Hourly (-3600) and sub-hourly (-900/-1800) regions; fallback to the other. Bug fix: hourly average at xx:00 in non-900 regions: Q1 = 4·avg − Q2 − Q3 − Q4.
- **Easyenergy**: open API deprecated; transparent proxy to EnergyZero (TTF gas), legacy zone name kept. EnergyZero gas day changes at 06:00 CET; values ×1000 to keep the old format.
- **EEX**: weekend fetch is best effort; EOD and EGSI index pricing.
- **ECB / Entsoe XML**: mimic xml-js compact output, no numeric coercion (caller casts).
- **OpenMeteo**: ensemble of regional top-tier models (KNMI Harmonie, AROME, ICON, UKMO, MET Norway, GEM) + global backbone. ERA5 archive blended 50/50 into entries 5+ days old (nearly halved day-to-day yield factor spread). past_days for ≤92 days, then dates, then archive.

## lib/strategies (A–B)

- **ApplianceModel**: runs start above standby, end after the learned end hold (×longest pause inside runs, between SHORT_HOLD_MS and END_HOLD_MS; the longest, not the median, or a soak would end the run). Back-to-back programs: after a pause, power back to a share of the peak = new start (only once the run reached FULL_SHARE of the shortest learned run). Long outliers left out of the profile. Curve = mean per 15 min (a median underestimates mixed programs). Start rates as EMA per weekday-hour (~5 weeks), corrected for the start at 0; weekdays seen too few times use the mean of others. Hourly history: an hour below average is no program. A value repeated ≥3× (not 0) is stale. `learnHistory()` has a version: older bootstraps relearn.
- **BatteryCalibration**: occasionally fully empty then fully full, each until the battery stops by itself (asked ≥ ASK_W, doing < STOP_W for STOP_MS; a battery can take a minute to start). Batteries with own limits stop before 0/100 %. Targets chosen where stored energy sells best and the full charge is cheapest; waiting costs a share of mean price per hour (soonest wins). Pure: state in the device store.
- **BatteryControl**: pure, W with + charging. XOM integrates: new = last − grid × GAIN (0.5; 1 overshoots because the grid reading lags). Anti-windup lead limit only for batteries reporting fast. Group XOM: a rise only after RISE_HOLD_MS (Quooker spikes ~10-15 s stay on the grid). Follow detection (Sessy takes up to a minute from standstill). Smart mode: xom where the plan covers the deficit in part discharges at most the planned power; planned surplus charge (hold) stays hold (no discharge on a cloud); self-consumption never idles. Pulse mode for blocks below the efficient power, only where the saved loss beats fan start/stop costs; not in XOM. Below reserve: full power recharge (not in modes without grid charging). Import and export limit at once: import wins.
- **BatteryEfficiency**: samples from one SoC change to a later one, ≥10 min and MIN_SAMPLE_KWH (Homey meters in 10 Wh steps, lag the SoC). Per-direction efficiency depends on the capacity setting; the round trip doesn't: capacity factor from their ratio. Loss model fixedW + k·P² (weighted least squares; kW for conditioning). Efficient power: highest within a margin of the best (flat top; fewer batteries at higher power save fixed losses). Defaults: Sessy-like curve.
- **BatteryResponse**: setpoint step to first report at 90 %; writes in parts keep the step start.
- **BatterySplit**: fewest batteries within their efficient power; cheapest per kWh cycled first, then least used, then most efficient, then SoC (charging emptiest, discharging fullest), with hysteresis.
- **BatteryTaper**: max AC power near full/empty = k × (room % + OFFSET), linear so the LP keeps it as a constraint.
- **BatteryUse**: equivalent full cycles from the SoC; jitter below a threshold and big jumps (corrections) ignored.
- **BatteryUse cost classes**: cost per kWh cycled at a reference price (wear + round-trip losses); class 0 for the cheapest, one up per share of the mean price above it.

## lib/strategies (E–P)

- **EvChargerControl**: wanted state compared with the actual one (corrects lost commands and restarted chargers). A switch by someone else starts a temporary mode (Charge now / Don't charge) so the plan doesn't switch it back. Minimum time between commands (relays, car logic, offline chargers). `evcharger_charging` is command and status: a switch close to a plug change is the charger's own (auto-start). Current control: W/A per phase at 230 V; unknown phases → 3 (fewest amps, never more than planned); fewer phases learned only from many samples (a tapering car must not look like fewer phases). IEC 61851 minimum current 6 A. Kia e-Niro sometimes doesn't start when the charger switches on: the car app is told to start. Restarting source counters (wallbox session meter, Zaptec yearly) → own counter = source + offset. Solar surplus hysteresis against passing clouds. Standby probe for chargers without plug state.
- **EvEnergyMode**: without a usable SoC, sessions planned on energy (usual session energy + margin); too much only reserves slots.
- **EvPlanner**: requirements "SoC ≥ X before T" (trips, reserve recovery, floor now), cheapest charging meeting all, earliest requirement first, never above the ceiling. Beyond published prices expected prices decide how much to charge now; only published slots execute. Solar surplus valued at the export price (NL export drops well below import from 2027), or at the home battery's value where it would store it. Cheap extra only CHEAP_BELOW under the usual daily low (median of daily lows, 14 days) or under the expected cost of coming days; ≤0 always cheap; ratios only (any currency). Unpublished prices count dearer for extras. Expected weekday-hour prices have shallower dips: a full day's cheapest slots are lowered to what they usually cost. Equal cost: the latest slot (battery less long at high SoC). Min charge time bridges gaps / extends short sessions (charger wear, cars that don't resume). Slot parts are computed without arrays (allocated MBs per plan, 2026-11-12). A SoC above the ceiling may stay (never force discharge).
- **EvPresence**: car apps often report only after a trip; location is still the best home/away signal. Away, plug state only counts when "plugged in". At home, "not plugged in" from the charger's own plug state, else the car's (can be stale). Power at this charger while the car is elsewhere: another car.
- **EvSocEstimator**: SoC between reports = last report + charger kWh × efficiency; efficiency learned only between reports without driving (same odometer) and with enough SoC rise (integer SoC). A lower report while parked and charged is a stale cloud value. A hand-entered SoC is no base for the stale check.
- **EvUsageModel**: per calendar day, last 12 weeks. Departure = report time − estimated driving time, unless a cable pull was seen. Round trips from home; only trips using ≥ minTripSoc count. Safe need: P80 (median + 25 % with few days); a day above 2× median capped. Long idle odometer runs are an unreachable car app, not "not used". Away overnight (distance at NIGHT_HOUR): that day and the next not learned. History: hourly values are averages, one odometer step spreads over two hours. `VERSION` bump rebuilds models. Away periods `YYYY-MM-DD/YYYY-MM-DD` (or DD-MM-YYYY), comma/semicolon/newline separated.
- **FuseGuard**: stale grid reading (≥3 telegrams of DSMR4 10 s and of the learned interval) → batteries keep power, EV chargers not switched on. Import over the limit for a while → EV cut/off; held off a minimum time; raised again with room and a reservation so batteries make room first (car starts in seconds). Phase overload without relief → learned phases distrusted for a while. Unknown phases: 3 above one phase's limit, else 1 (worst case).
- **LightPlanner**: DP over stored energy in small steps (100 W × 15 min), backwards per slot; costs as PrecisePlanner. Typed arrays in a small hot-loop function: one group plan allocated 70-80 MB and pushed the app over the memory limit (2026-11-12). Gap bridging of charge/discharge runs (≤ MAX_GAP_MIN, ≤ BRIDGE_MAX_SHARE of run cost; not over import-limit slots). solarPays false → idle instead of hold. Where grid trading doesn't pay, XOM sets the power at steady efficiency. minimizeGrid: per-kWh grid cost far above any price. Group = one battery, split by BatterySplit.
- **LoadForecastStrategy**: planned extra loads `{ from, to, power }` added on top, not learned, kept 14 days. Nightly retrain moves hours with few history samples only partly (one week of history must not replace weeks of live learning). No midpoint shift for hourly entries (MAE worse 307 → 333 W, 2026-08-14: home load is steps). Standby floor: p10 of night slots (00:00-04:45), ≤0 excluded (battery timing artifacts). Accuracy: errors = predicted − actual.
- **PeakTariff**: window average × weight; per month max / mean of top N / N-th, optionally one per day; per kW or steps (`'2:190; 5:300'`), with minimum. Hours `'06-22'` (wraps), months `'11-3'` or lists. Changing a preset-written key makes it 'custom'; history resets when the meaning of weighted values changes.
- **PhaseLearning**: a step between two steady levels moves its phases (1 phase whole step, 3 phases a third each); other devices' simultaneous steps fitted along; one vote per clean step, clear majority. Gap covers device + meter report delay (DSMR4 10 s).
- **PhaseLearning** votes in device store `phaseVotes`; setting `batteryPhase`/`chargerPhase` wins, else learned when trusted.

## lib/strategies (P–X)

- **PrecisePlanner** (LP): blocks `xom` (charge surplus / cover deficit only), `hold` (no discharge, surplus may charge), `idle`, `charge`, `discharge` (grid too, to the slot SoC). Export > import valued conservatively. Steps merged (flat stretches, dead zones, max `MAX_LP_STEPS`); import-limit slots never merged (Infinity sum hides the limit). Taper exact for any step length. Bounds with slack at a big penalty. Batteries with equal properties: LP split arbitrary, re-split by BatterySplit. Uses YALPS: javascript-lp-solver kept its last dense model outside the V8 heap and fragmented memory; Homey killed the app within minutes (2026-11-12). Not optimal → all idle. Each slot of a merged step gets its average power (frontLoad where taper limits). Never discharge into ≤0 price.
- **PriceFetchStrategy**: provider authority ranks (Entsoe variants share a rank; OMIE primary ES/PT; SMARD above scraped sources, below ENTSO-E; Nordpool deprioritized outside its zones; proxy before direct). Large spread windows get their own random moment per provider (not all Homeys at the top of the hour); a reservation is handed back if not called. Market day tolerance one hour (PT/IE trade on a CET day), not a per-zone table. Exponential backoff only for failing calls, not rejected content. A 200 with stale/short prices doesn't use up the revalidation window. Before 10:00 nothing new anywhere; Nordpool ~10:00, Entsoe ~13:00.
- **PriceProfile**: EWMA per weekday-hour (~4 weeks), published prices only (no forecasts); sub-hour averaged per local hour first. Level of known prices fades over a few days ahead (additive: taxes fixed). Daily lows only from (nearly) complete days. `dailyMin`, `dailyLows`, `dailySums` keyed by local date.
- **SolarLearningStrategy**: Open-Meteo radiation is the average over the hour BEFORE its timestamp (open-meteo discussion 1556): read at K−30 min (confirmed vs solar noon). Homey hourly entries = mean over the hour starting at t (quarters read off a piecewise-linear curve through midpoints). Samples weighted by local consistency of power/radiation, not clear-sky classification (tried, reverted). Below a radiation threshold the ratio is unstable (one near-sunrise sample outweighed 13 days): fallback weight; no sample > half the others in its slot. p75 (blended toward p50 with few samples), not the median. Global limit relative to best radiation seen (a fixed 100 W/m² bar emptied in a winter cloud spell). Day/night boundary slots not smoothed (leaked). Energy-derived power only without measure_power (0.05 kWh/1 min = 3000 W spikes). Intraday correction (clouds forecast that didn't come: ~40 % under clear sky, 2026-10-17), fading with lead time, not learned; window halves compared (tested on Prod 20-26 Oct 2026). Retrain blends with previous factors scaled by confidence; hard cap at the physical limit. Nightly retrain is the only learning.
- **XomSplit**: from the last commands, not actualPower (would break the integral loop). Reference price for the group. Full battery takes no charge, empty (at reserve) gives nothing.

## drivers/battery

- Replan when SoC is ≥3 % from the plan (above 1 % steps), at most every SOC_REPLAN_MS. Plans in 15-minute slots (grid forecast, capacity tariffs), 48 h ahead (expected prices beyond published).
- A (re)init can follow a settings change: never reuse a plan from before it. Load histories before `super.onInit()` (it sets initReady partway and renders charts / overwrites stored history).
- Homey keeps a warning over a restart: the first `updateWarning()` writes or clears it.
- Never leave the battery on a last setpoint while the app isn't running; `isDestroyed` first so a tick during release doesn't take control again. Release retried every RELEASE_RETRY_MS; refused for RELEASE_FAST_MS → once a night (03:00).
- A mode write of our own echoed back within OWN_WRITE_ECHO_MS is not a battery-app change; a real change by the battery app takes over (this app stops controlling).
- After a start, smart leaves batteries as they are until the first plan (≤10 min), unless the connection is overloaded.
- Group: one mode and one planner (from the battery with the lowest id); 'device' leaves the group; a calibrating battery plans alone; unavailable ones are not planned (only enlarge the LP). The home's net per slot for the planner excludes batteries and adds the plans of batteries before this one (no double use of surplus); never the grid's netPlanned. Surplus lowered by the measured forecast error.
- Phase bounds: unknown phases only limit power (down to 0), never force the other way.
- Reserve kept always (only peak shaving may use it), not while calibrating. New battery's use (BatteryUse) starts at the mean of the others.
- Capacity tariff: stepJump used as price per kW (linear approximation); hard limit → large penalty.
- Efficiency chart bootstrap from the last 24 h of own Insights (5-min means blur SoC: samples ≥3 %, quarter weight). `meter_kwh_stored` is on usable capacity, samples on the capacity setting. Source meters preferred (Homey capability meters in 10 Wh steps).
- Learned props (store `batteryProps`) replaced settings; the old values were taken once as start (Homey keeps removed settings' values). Repair "forget learned": no Insights bootstrap for a day.
- Driver: XOM target in app setting `xomSettings.x` (flow 'Set XOM' and battery setting `xomTarget`); a flow value mirrored into the setting only when stable for XOM_MIRROR_MS. With 'Discharge into EV' off the XOM aim moves up by the EV chargers' power (discharge side only). Calibration: at most half the batteries at once, longest waiting first. Hold batteries only take part in XOM when charging, noCharge batteries only when discharging. Vendor source exceptions (Solax, Victron, Blauhoff, SolarEdge Growatt unverified; Sessy legacy inverted; Sonnen) only when the source isn't a Homey standard battery (class battery + measure_battery + measure_power, + = charging). Wear helper: rated cycles until EOL share (70 %), average capacity (1 + share) / 2. New battery min profit = share of the group's mean price. Dependencies lazy loaded (memory).

## drivers/evCharger

- Plans in quarters also with hourly prices (departures rarely on the hour).
- Capability listeners survive `restartDevice()` (same instance): registered once. A former temporary mode (`charge_temp`/`off_temp`) maps to its mode; `charge_temp` became the manual flag. A temporary mode without its start (store lost): back to Smart.
- Usage model bootstrap: the app API may still be connecting and the learner swallows "API not ready": retry (no nightly retrain catches it). Model in the file store (size).
- `evcharger_charging` is not a plug state: it's Homey's setable start/stop. Homey standard: + = charging the car (not negated; meter split uses the sign). Without V2X a small negative idle reading (smart plug −0.1 W) is 0.
- Car listeners can miss events when the car app started after them (seen live, cause unverified): the car is also read directly in the control loop and listeners re-registered on a fresh device object. One car status update sets several capabilities: handled as one report. An unchanged SoC is not re-set by most apps; odometer/location still move. "Charging" says plugged; "not charging" says nothing about the cable.
- Power gone while the charger stays on (not our switch-off): cable pulled or car full; a trip report shortly after tells which.
- Live departure/return feeds the usage model only for cars without odometer and only from timely signals (charger plug state, power gap); a car location arrives after the trip.
- Energy mode: no SoC report, or an old one while the car was used since. A parked car's app doesn't report an unchanged SoC: old alone isn't stale.
- Home but not plugged in: no charging in the next hour (only when the charger itself says so: the car's plug state can be stale and a charger kept off would never show the cable).
- Switch by someone else → temporary mode, judged after PLUG_WINDOW_MS (the charger switches itself on plug changes; that report can come later). Always for a time: a hand switch must not hold the plan off for good.
- Plan runs are merged (start-up, car reports, learning and listeners all ask); a call during a run gets one run after it. Plan-change triggers/logs only when the current slot's decision or future charge slots change (else users' flows flood).
- Fuse overload the batteries didn't solve: a variable charger is cut by the overload (raised later), else switched off at once, until `FuseGuard.mayRelease()`. A charger power report can lag the last cut: the lowest known value counts. Batteries make room first (RELEASE_LEAD_MS).
- Up to v8.20 a charger without its own kWh meter counted charging down on `meter_power_hidden`: baselines and money flipped once. Repair fix_values: money only (the charged counter feeds SoC estimate and sessions).
- Driver: no `meter_power` (Homey Energy would count the charger twice); total in `meter_power_hidden` (needed by `updateMeterFromMeasure()`). Images added later go last (position fixed at first registration). Car detection: class/virtualClass, Homey's "electric car" energy setting (eu.nissanconnect uses class sensor), or charge state + SoC on a generic class (`ev_charging_state` is the car twin of `evcharger_charging_state`). Two EV devices conflict only with the same charger and car. Minimum SoC ≤ reserve ≤ daily max.

## drivers/grid

- Power per phase: signed like measure_power, + import (verified Sessy P1, Enelogic LS120; HomeWizard P1 by API docs v2). Only L1 above 0 for a while → 1-phase connection; a phase counts once it read non-zero (1-phase meters report 0 on L2/L3).
- Bookkeeping restored before `super.onInit()`: its first poll reaches `handleUpdateMeter()`; without anchors it would re-bootstrap and zero this_* import/export and split money. All bookkeeping in ONE store value (throttled, `STORE_FLUSH_MS`, forced on period boundaries and shutdown); old per-key values migrated then removed.
- A repair can point the device at another meter or remap registers (P1 net → consumed/returned): anchors on raw registers dropped (else one huge bogus delta and a peak that sticks all year). Checked in onInit because `setSettings()` doesn't call onSettings.
- `enableDirectionalNetting` boolean migrated once via a store flag (Homey fills the new setting's default before onInit).
- Settlement scheme `directionalNettingScheme`: continuousNet / perDirection / fixedBlock; case 1 real p1/n1 registers, case 2 import only, case 3 pseudo registers from the sign of measure_power. Registers updated before `super.handleUpdateMeter()` (serialized), resolved once per tick (a second call would see the advanced snapshot). A scheme switch resets the running this_* money buckets. Split money is always per direction (as a bill itemizes it). Background: zzz_export_import_netting_research_and_plan.md.
- Home = grid + solar − battery − EV, 2-minute rolling average (devices report at different moments); negative = timing skew → 0 (skipping biases upward). History one entry per 5 min, 576 = 48 h.
- Capacity-tariff peak = highest 15-minute AVERAGE import (e.g. Fluvius), own anchor (works without export data); stored so a restart mid-slot doesn't fire `peak_projected_exceeded` again; window length change drops the running window (else up to 4× off). Median of expected daily max fills the top N early in the month (cached 1 h). measure_watt_peak.billed: measured only.
- Phase setup conflict (setting vs meter): device warning + SetupNotice; store `phaseSetupNotified`.
- Fuse guard: export above the fuse is only notified (batteries are all there is). A trend-only source (2-min average) is never "stale" (can't protect in time anyway). Import limits per 15-min slot for the planners (`getImportLimits`).
- Load model retrain/forecast loops idempotent via an epoch (retrain can take long). Slots with a planned extra load or not measured in full aren't learned; program appliances forecast separately.
- Diagnostic for forum #4048 (HomeWizard P1 energy fields).
- Forecast grid exchange per 15-min slot: `netNoBattery = home − solar + planned EV`, `netPlanned = netNoBattery + planned battery`. Battery planners plan against netNoBattery. EV only while connected. Forecast recorded per slot when it starts (accuracy scored before the slot's learning update; slots <10 min after a restart not scored). Plan-change notifications from batteries/EV/appliances debounced.
- Training from the physical source devices' Insights, never from this device's own derived `measure_watt_home` log. Components resolved to the physical device via `homey_device_id` (resolving PbtH devices via data.id returned the PbtH device itself, 2026-08-10). Per device summed, not averaged. A grand total meter (`:meter_power`) drops its sub-totals; phase/tariff meters alone are summed. Instantaneous power before meter_power (W and kWh-derived W not mixed). One resolution chosen on the first log for all components.

## drivers/power (program appliances)

- appliance_mode off/forecast/plan; only a Homey device as source learns (Homey Energy/flow sources are totals; an EV charger's source is already out of the home load). Bootstrap from 14 days of source Insights (hourly + 5-min last 24 h); live runs before it kept.
- When an appliance becomes ready, stops being one, or is deleted, the grid relearns its home load from Insights (else the learned load keeps or misses it for weeks).
- A run is a program once it used MIN_RUN_KWH; it ends a flow plan it belongs to (started in its window or hours before). Plans have a deadline (latest start); a fixed start stays (only its cost follows prices). New prices move a not-started plan to the cheapest start. Cheapest-start cards checked once per 15-min slot at its first sample, not while running, not again after a restart in the slot.
- Day pickers per local date: 'unused', 'cheapest' or 'HH:MM', once; "Via flow" shows the flow's plan day; a hand choice wins. Price lookups memoized per minute and list.

## drivers/price

- Fixed tariff: price slots from yesterday to end of tomorrow with market price 0; price from the settings. Gas: one price per day; water: fixed tariff only (no export, no cheapest/most expensive cards).
- MARKET_KEYS need new market prices (repair); stored prices are of one zone and interval. Price settings changed by flow recalculate at once (no restart), unless a TOD markup needs other slots.
- Profile history read after the start burst (60-120 s).

## drivers/solar

- Init order: values before `super.initDeviceValues()` (first poll zeroes them); histories before `super.onInit()`. Loops idempotent via epochs. Retrain after pairing retried (API may still be connecting).
- Eclipse correction before the radiation time shift (tied to astronomical time).
- Usable Insights log found by test-fetching real (>10 W) data: a log can exist without values.
- Without a Peak Power setting the observed peak is used only for soft ceilings, never for the hard reject filter.
- Retrain: 100 % from scratch, else 70 % blend scaled per slot by confidence; peak p90 (ignores spikes).
- Diagnostics export result shown via `setWarning()`: a thrown error shows no text in the mobile app, a notification is easily missed (both confirmed).
- Yesterday's snapshot backfilled when missing, all-zero, or off the local-midnight grid (older getLocalMidnightUTC bug).
- Chart scale: Peak Power, else max(all-time peak, estimated Wpeak); 850 not 1000: GHI ≈ 85 % of tilted-roof irradiance at summer peak (estimate).
- Intraday ratio not while curtailed (panels could give more than measured).
- Day log rebuild ≥5 min after start and 7 min into a quarter (away from start and slot-change peaks). Day log save flushed before the done flag.
- Solar max only (no min: ~0 every night).

## widgets

- `public/icons.js`, `public/flow.js`, `public/periodcache.js` are generated/copied by `tools/widget-shared/gen.js`: edit the sources in `tools/widget-shared`, never the copies (their header comment says so).
- periodcache: now always live, hour after 5 min, day after 15, month/year after an hour.
- flows widget: users via `homey=1` include Homey Energy devices, never this app's devices or their sources (counted once); live values of a Power Summarizer use Homey's value of its source (own average lags).

## app.js / api.js

- Homey runs in UTC; all local time via TimeHelpers with the Homey time zone. In half-hour-offset zones the UTC hour starts at local :30.
- Dev diagnostics (env.json): `PBTH_INSPECT=1` opens the V8 inspector to the LAN (no auth), `PBTH_MEMLOG=1` logs memory to app settings.
- Shared Insights fetch per key and local day; empty/partial results not kept.
- Slot tariffs once per boundary, first caller runs it, one driver after the other.
- Inter-app API: see README.prices-api.md.
