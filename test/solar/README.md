AI HANDOFF - SOLAR LEARNING ALGORITHM: DATA-DRIVEN ANALYSIS & REGRESSION TESTING
===================================================================================
Repo: com.gruijter.powerhour (Homey app, "Power by the Hour")
File you will mostly be working in: lib/strategies/SolarLearningStrategy.js
(possibly also drivers/solar/device.js and lib/helpers/ClearSkyGHI.js)

Paste this whole file as your task brief. It is self-contained: you do not need
prior conversation history. This document is NOT tied to one incident or one
season - it is the standing reference for this whole working set, meant to be
read fresh every time new real-world data or a new bug report comes in. Read
section 7 ("PITFALLS ALREADY HIT") before touching anything, so you don't
repeat mistakes already made and corrected.

WHY THIS DOCUMENT EXISTS: this app has thousands of users. Real device data
(Homey Insights exports + weather history) trickles in over time - a user
reports the solar forecaster behaving badly, sends their data, it gets added
to this working set. This document's job is to let ANY AI (no memory of past
sessions) immediately (a) understand the algorithm, (b) analyze whatever real
data has accumulated so far to find actual problems, and (c) use that same
data as a regression suite when testing a code change - so a fix for one
user's data doesn't silently break another's.


1. WHAT THIS MODULE DOES
-------------------------
This is a Homey app driver for solar PV forecasting. Each night it retrains a
per-15-minute-slot "yield factor" model (96 slots/day, UTC time) from:
  - up to 14 days of Homey Insights power history (hourly resolution for
    days 2-14, 5-minute resolution for the last 24h - "Step 1"/"Step 2" in
    drivers/solar/device.js's updateLearning()), and
  - Open-Meteo weather-model radiation forecasts for the same period
    (lib/providers/OpenMeteo.js).

For every historical sample it computes `yieldFactor = power / forecastRadiation`
and aggregates these per slot into a robust estimate (weighted median/p75),
which is then used going forward as: `predictedPower(t) = yieldFactor[slot(t)]
* forecastRadiation(t)`. There is no "live" intraday learning - the nightly
batch retrain is the sole source of truth, so whatever it produces is what the
device shows and acts on for the next 24h, unconditionally.

Key functions (verify line numbers below haven't drifted - this file gets
edited, don't trust a cached line number over actually reading the file):
  - `extractSlotSamples()`: turns raw power+weather entries into per-slot
    arrays of `{ yieldFactor, weight, power, radiation, timestamp, isFallback }`
    samples. Computes a per-sample confidence `weight` via
    `computeHourlyConfidence()`/`computeHighResConfidence()`, roughly
    `1 / (relative_coefficient_of_variation^2 + epsilon)` over a small local
    time window - i.e. "how locally consistent was power/forecastRadiation
    around this sample". Below `MIN_RADIATION_FOR_CONFIDENCE` (50 W/m2), a
    sample never gets a real computed weight - it's `isFallback: true` and
    gets a shared, self-calibrated neutral weight instead. THIS DISTINCTION
    (isFallback vs not) IS THE SINGLE MOST USEFUL THING TO CHECK FIRST when
    diagnosing ANY reported-bad value - see section 5.
  - `capOutlierWeights()`: caps any single sample's weight at 50% of the sum
    of all OTHER samples in its slot, so one freak spike can't dominate.
  - `weightedPercentile()`: standard weighted-percentile helper.
  - `aggregateYieldFactors()`: per slot, takes the weighted p50->p75
    percentile (blended toward p50 when there are few samples, see
    `MIN_SAMPLES_FOR_FULL_PERCENTILE`) as `best`, applies a safety `limit`
    (a data-derived global soft cap, `datasetMaxYF`, loosened by a per-slot
    `physicalCeiling` anchored to `peakPower` - ONLY when the anchor sample
    is independently verified, not isFallback, see section 4b), computes a
    "Model Fit" confidence score (0-100%, how much of the day-grouped
    verified data agrees with `best`), then does 3-pass neighbor smoothing.
  - `mergeYields()`: blends this retrain's fresh result with the previously
    stored model. `alpha` (base 0.7, or 1.0 on a from-scratch retrain) is
    scaled per slot by that slot's own `trainingConfidence` - a 0%-confidence
    fresh value defers entirely to the previous established model, a 100%
    one behaves at full alpha. This is what protects an established model
    from being swung by one noisy/unverified night - but does NOT fix the
    raw single-night `aggregateYieldFactors()` output itself, and does
    nothing on a from-scratch retrain (no previous model to defer to) - see
    section 6a.

Admission gates: `MIN_RADIATION_FOR_CONFIDENCE = 50` W/m2 (gates whether a
*real* confidence score can be computed) and `CLEAR_SKY_ADMISSION_FRACTION =
0.05` (a sample is only admitted at all if forecastRadiation > 5% of the
astronomical clear-sky GHI for that timestamp/location, via
`estimateClearSkyGHI()` in lib/helpers/ClearSkyGHI.js - a loose floor, not a
clear-sky classifier, works for any lat/lon/hemisphere/season via real solar
position astronomy, no cold-start problem).

ALREADY FIXED, DO NOT RE-INVESTIGATE THESE (settled, with real-device
evidence behind each):
  - A ~30min systematic radiation-timestamp misalignment (Open-Meteo's
    shortwave_radiation is timestamped at hour END, not start - see
    `getInterpolatedRadiation()`/`RADIATION_TIMESTAMP_CORRECTION_MS`).
  - Outlier weight explosion near sunrise (`capOutlierWeights()`).
  - A p75-percentile vulnerability to outliers at low sample counts (p50->p75
    blend by sample count, `MIN_SAMPLES_FOR_FULL_PERCENTILE`).
  - A smoothing-boundary bug that leaked sunrise-peak value into later slots.
  - The "Model Fit" (formerly "Training Confidence") index: continuous
    Gaussian agreement falloff + 3-pass neighbor smoothing.
  - `datasetMaxYF`'s admission tier was a hard-coded `radiation > 100` W/m2 -
    inert (stuck at 0) whenever a dataset never sees >100 W/m2 (e.g. a
    genuinely overcast multi-week stretch). Now data-relative:
    `Math.min(100, Math.max(15, maxRadSeen * 0.5))`.
  - `physicalCeiling` (both in `aggregateYieldFactors()` and `mergeYields()`)
    used to be able to loosen the safety cap based on a single sample's own
    (possibly tiny, possibly never-independently-verified) radiation reading,
    turning a correctly-tight cap uselessly loose. Now gated on
    `!bestSample.isFallback` (only loosens using a sample this file already
    trusts) plus a `MIN_RADIATION_FOR_CONFIDENCE` floor on the denominator as
    a second layer. `mergeYields()`'s independent floor raised from 10 to
    `MIN_RADIATION_FOR_CONFIDENCE` (50) for the same reason (10 gave a
    ceiling=110 for a 1kW array - no real backstop at all).
  - `mergeYields()`'s flat `alpha=0.7` didn't distinguish a well-corroborated
    slot from a single-sample/unverified one - now scaled by that slot's own
    `trainingConfidence` (see above).
  Real-device evidence behind the physicalCeiling/alpha fixes: the East
  array's slot 16 (04:00 UTC) had exactly 2 samples, both isFallback,
  yielding yf=28.07 (true ~1) - see data/5400Wp_East_08_14_Sunny/meta.json's
  notes for the full mechanism and how it's now caught.


2. HOW THIS WORKING SET IS ORGANIZED
----------------------------------------
Everything lives under test/solar/. The scripts and this file are in git;
data/ is gitignored (real user data: location, system size):

  README.md                 - this file
  scripts/                  - all benchmark/regression scripts (see section 3)
  data/
    baseline.json           - stored expected output per real-data scenario,
                               see section 3
    <scenario>/              - one folder per real dataset, see naming below
      meta.json              - { peakPower, lat, lon, orientation, condition,
                                  dateRange, source, notes } - REQUIRED for a
                                  scenario to be picked up by the regression
                                  script. `source`/`notes` should say where
                                  peakPower/lat/lon actually came from (a
                                  settings screenshot, user-confirmed value,
                                  a guess) - this file has already had wrong
                                  values silently assumed once (see section
                                  7, pitfall #6), don't repeat that quietly.
      hourly_14d.csv          - Homey Insights "last 14 days" export
                                  (columns: date,value - hourly average power)
      high_res_24h.csv        - Homey Insights "last 24 hours" export
                                  (5-minute power)
      weather_cache.json      - Open-Meteo radiation history for this
                                  scenario's own date range AND location -
                                  do NOT reuse another scenario's weather
                                  cache unless it's genuinely the same
                                  place/time, format: [{time (ms), radiation
                                  (W/m2)}, ...], fetched via
                                  lib/providers/OpenMeteo.js
      (optional) settings.png, chart screenshots, anything else useful for
        that scenario

  SCENARIO FOLDER NAMING: `{peakPowerW}Wp_{Orientation}_{MM_DD}_{ConditionLabel}`
  e.g. `1000Wp_South_08_14_Sunny`, `5400Wp_East_01_15_TwoWeeksOvercast`.
  MM_DD is the scenario's representative/end date. ConditionLabel is a short
  free-text hint (Sunny, TwoWeeksOvercast, SnowCovered, PartialShading, ...) -
  not parsed by any script, purely for humans scanning the folder list.

  WHEN NEW REAL DATA ARRIVES: create a new `data/<scenario>/` folder
  following this convention, populate meta.json + the 3 data files as above.
  That's it - `scripts/run_real_data_regression.js` auto-discovers any
  folder under data/ that has a meta.json, nothing else needs to change.
  Keep this structure intact rather than inventing a one-off location for
  new data - the entire point is that it accumulates in one place over the
  year without needing script edits each time.


3. USING THIS AS A REGRESSION / UNIT-TEST SUITE
----------------------------------------------------
Run everything with `node test/solar/scripts/<name>.js`
from the repo root.

  scripts/run_real_data_regression.js  - THE PRIMARY REGRESSION TOOL. Auto-
    discovers every data/<scenario>/, runs it through the REAL production
    pipeline (extractSlotSamples x2 + aggregateYieldFactors, matching
    drivers/solar/device.js exactly), and compares min/max/limit/slot-count
    against data/baseline.json. There is no "true" value for real device
    data (no ground truth), so this is a DIFF tool, not a pass/fail-against-
    truth tool: it tells you when a code change moved a real scenario's
    output, not whether the new number is "correct" - you still have to
    judge that.
      `node .../run_real_data_regression.js`                  - diff vs baseline
      `node .../run_real_data_regression.js --update-baseline` - overwrite
        baseline.json with current results. ONLY do this after you've
        checked the new numbers by hand and are confident they're right -
        this is how a real regression gets silently baked in as "expected"
        forever. Never run --update-baseline as a way to make a failing diff
        go away without understanding why it changed.
    WORKFLOW when changing SolarLearningStrategy.js or drivers/solar/
    device.js: run this BEFORE your change (confirm it matches the existing
    baseline - if it doesn't, something already changed since baseline.json
    was last updated, investigate that first), make your change, run it
    AGAIN, and manually reason about every scenario that shows a diff. Only
    --update-baseline once you're confident each diff is an intended
    improvement, not a side effect.

  Synthetic stress-test scripts - useful for conditions you don't have real
  data for YET (extreme weather, other latitudes, other system sizes), or
  for isolating a specific mechanism (see section 7, pitfall #4, about
  isolating confounds rather than guessing):
    scripts/test_winter_fix.js            - synthetic hourly-only overcast
                                             winter scenarios
    scripts/test_realistic_benchmarks.js  - same, CURRENT vs an old
                                             (rejected) ratio-estimator
                                             prototype - see section 6's
                                             "what was investigated and not
                                             done" note
    scripts/test_combined_pipeline.js     - Step1(hourly)+Step2(5-min)
                                             combined synthetic winter
                                             benchmark - the resolution:'high'
                                             path is otherwise easy to leave
                                             untested
    scripts/compare_estimators.js         - another CURRENT-vs-prototype
                                             comparison, same rejected
                                             ratio-estimator idea
    scripts/test_scale_and_geography.js   - 10kW/20kW systems x 5 locations
                                             (NL, Tromso/polar, Singapore/
                                             equator, Sydney/southern
                                             hemisphere, Phoenix/desert),
                                             fully synthetic
  These are all self-contained synthetic generators (no data/ dependency) -
  useful for exploring "what if" scenarios, but real data from
  run_real_data_regression.js should always be weighted more heavily than
  synthetic results when they disagree (see section 7, pitfall #1 and #4 -
  synthetic noise models have already been shown to not perfectly match
  reality, and this repo has already been burned by a synthetic-only
  handoff document's claims not surviving contact with real device data).

  `npx eslint lib/strategies/SolarLearningStrategy.js drivers/solar/
  device.js` must stay clean - this repo enforces lint on every change to
  those files. (Scripts under test/solar/ are scratch
  tooling, not subject to the same lint requirement.)


4. HOW TO ANALYZE NEWLY RECEIVED DATA / DIAGNOSE A REPORTED PROBLEM
-------------------------------------------------------------------------
This pattern has found the root cause of every concrete bad-value case found
so far - it will very likely find it again:

  1. Add the data as a new data/<scenario>/ folder (section 2). Get meta.json
     right - peakPower/lat/lon from the user's actual device settings if at
     all possible, not a guess (see pitfall #6, section 7).
  2. Run scripts/run_real_data_regression.js. It'll pick up the new scenario
     automatically and print its min/max/limit/slots - eyeball whether
     anything looks physically implausible (yieldFactor should very roughly
     track "how many kW this array produces per kW/m2 of sunlight", so a
     value wildly above ~1-3x peakPower/1000 or oddly negative-adjacent
     deserves a closer look).
  3. Once you've identified a bad slot (from the user's report, or from step
     2's eyeball check, or from a lower `Model Fit`/`trainingConfidence`
     shown on the device), dump that slot's RAW samples: power, radiation,
     yieldFactor, weight, isFallback, timestamp - write a small throwaway
     script for this (see any of the existing scripts for the
     extractSlotSamples()+aggregateYieldFactors() call pattern, or copy the
     relevant loop out of run_real_data_regression.js). This single step is
     the highest-value diagnostic move available - it immediately tells you
     which of the following you're looking at:
       a) SPARSE/UNVERIFIED SAMPLES DOMINATE THE SLOT (check this FIRST -
          it's been the answer almost every time so far): few samples (1-3),
          most/all `isFallback: true`. The `mergeYields()` confidence-scaled
          alpha only protects this once a decent PREVIOUS model already
          exists for that slot - it does nothing on a from-scratch retrain
          or if the same bias recurs night after night. See section 6a - no
          fix for the raw single-night value itself exists yet.
       b) GENUINE RATIO-ESTIMATOR (JENSEN'S INEQUALITY) BIAS: many samples,
          mostly NOT fallback, systematically skewed relative to a plausible
          true value, correlated with sustained low/noisy radiation (not
          just a sunrise/sunset edge). This has been investigated and
          evidence so far says it's NOT a significant problem on the actual
          production pipeline (see section 6, "what was investigated and not
          done") - but if you find a case that actually looks like this,
          it's the first real evidence to reopen that question. Don't
          assume it without checking (a) first.
       c) A LOCAL-OBSTRUCTION SIGNATURE (snow cover, physical shading,
          temporary fault): stable, LOW, locally-consistent ratio over a
          period where you can externally confirm the cause (weather
          history, user description). See section 6b - there is NO
          detection/exclusion for this anywhere in the pipeline; it gets
          learned as ground truth like anything else, self-corrects only by
          being outnumbered within the rolling 14-day window if the
          condition is shorter than that window.
       d) A STRUCTURAL SUNRISE/SUNSET ARTIFACT: consistent mild overshoot
          (not an extreme single-slot spike) specifically at the daylight
          edges, present even on genuinely clear days. See section 6f - a
          real, still-not-root-caused artifact from approximating a
          nonlinear clear-sky curve with piecewise-linear sub-slot
          interpolation.
       e) Something new - if it doesn't match (a)-(d), you've found a
          genuinely new failure mode. Document it the way the existing
          fixes are documented (concrete evidence, mechanism, why the fix -
          see section 7's comment-style expectation) and add it to section 6
          of a future revision of this document.
  4. Before writing a fix: run the full section 3 regression baseline to
     confirm you're not chasing something that isn't actually a regression,
     and check section 6 first - it may already be a known, understood,
     intentionally-deferred limitation rather than a new defect.
  5. If you write a fix: re-run section 3's full regression (all scenarios,
     not just the one that prompted the fix - a fix motivated by one array's
     data must not quietly break another's), re-run eslint, and follow this
     repo's established comment style at the fix site (see pitfall #7,
     section 7): concrete evidence (which real scenario, what the raw
     samples showed), the mechanism, and why the chosen fix - not a simpler-
     looking alternative - is actually correct. Then --update-baseline.


5. (reserved - diagnostic playbook is section 4 above; numbering kept
   deliberately open here in case this document gets split again later)


6. CONFIRMED, KNOWN GAPS - CHECK THESE BEFORE ASSUMING SOMETHING IS NEW
----------------------------------------------------------------------------
In rough likelihood-of-being-the-cause order, based on everything found so
far:

  a) SPARSE/UNVERIFIED SAMPLE DOMINATES A SLOT'S RAW VALUE (most likely
     cause of most future reports). Every concrete bad-value case found so
     far - the East array's 28x outlier (fixed), the South/West arrays'
     dawn-dip minimums (damped via confidence-scaled alpha, not eliminated),
     several synthetic sunset/dawn slots - traced back to the SAME root
     cause: a 15-min slot with only 1-2 samples, all `isFallback` (radiation
     below `MIN_RADIATION_FOR_CONFIDENCE`, never independently confidence-
     scored), where nothing constrains the raw aggregation result on a
     SINGLE night. `mergeYields()`'s confidence-scaled alpha only helps once
     a decent PREVIOUS model already exists for that slot to fall back to -
     NOT on a fresh/bootstrap install, NOT if the bias recurs night after
     night. Worst observed case so far: a bewolkt->helder (or reverse)
     TRANSITION day specifically - more boundary slots fall under the
     confidence threshold simultaneously than on an ordinary day, not just
     the literal sunrise/sunset edge. NOT YET DESIGNED: a fix for the raw
     single-night value itself (as opposed to damping it across nights).

  b) LOCAL OBSTRUCTIONS (snow cover, physical shading, temporary faults) -
     NO DETECTION OR EXCLUSION EXISTS ANYWHERE IN THE PIPELINE. The noise-
     floor filter (`power < 10 && radiation < 50` -> reject) does NOT catch
     this - the signature is LOW power under HIGH forecast radiation, the
     opposite combination. The `isClipped` heuristic (designed for inverter
     clipping: flat power while radiation is still visibly changing within a
     local window) might incidentally catch the START/END transition of such
     an event but was assessed (not empirically confirmed) as unlikely to
     reliably exclude a STABLE multi-something-day obstruction. The
     confidence-weighting design explicitly scores "was this locally
     consistent", not "is this physically plausible" - a stable low ratio
     from snow/shading IS locally consistent, so it gets learned as if it
     were the true yield factor. Protection is purely incidental: outnumbered
     by unaffected days within the rolling 14-day window if the condition is
     shorter than that window; if longer, it gets learned as ground truth,
     and un-learning it afterward takes another ~14 days. RECURRING
     obstructions (a chimney's shadow, permanent nearby structure) are
     actually handled correctly BY DESIGN, precisely because they recur at a
     fixed time-of-day slot every retrain cycle - it's TEMPORARY-BUT-LONG
     anomalies (extended snow, a fault that gets fixed) that this can't
     distinguish from a real, should-be-learned change.

  c) EXTREME LATITUDE / POLAR NIGHT. Confirmed via synthetic testing: a
     location with genuine polar night for the whole 14-day window admits
     ZERO samples, learns ZERO slots. `mergeYields()` degrades gracefully
     (keeps the previous model if one exists; stays at 0 on a genuine cold-
     start during polar night) - not a crash/corruption risk, but a real
     "no forecast coverage" experience for extreme-latitude users. Low
     priority unless there's evidence PbtH actually has users that far
     north/south.

  d) `peakPower` LEFT AT 0 (the default, "auto-estimate" per
     driver.compose.json's own hint text) BYPASSES ALL physicalCeiling
     protection. Every peakPower-gated code path in extractSlotSamples/
     aggregateYieldFactors/mergeYields is behind `if (peakPower > 0)`.
     `peakPowerAllTime` (auto-tracked observed max, drivers/solar/device.js)
     is NOT substituted in as a fallback for the learning pipeline - it's
     only used for UI/chart scaling. CHECK THE USER'S peakPower SETTING
     FIRST when a report comes in - if it's 0, that's very likely at least a
     contributing factor, and the fix is more a support/UX question (should
     the pipeline fall back to peakPowerAllTime when unset?) than a pure
     code-correctness one - not decided or implemented as of this writing.

  e) STRUCTURAL SUNRISE/SUNSET INTERPOLATION ARTIFACT. A genuine, still-not-
     root-caused artifact from approximating a nonlinear clear-sky radiation
     curve with piecewise-linear sub-slot interpolation - shows up as a
     consistent mild overshoot (roughly up to ~130-200% of true, not an
     extreme spike) right at the daylight edges, present even on completely
     clear days with zero cloud noise. Partially, incidentally reduced by
     the physicalCeiling isFallback-gating fix (catches some of it as a side
     effect) but not eliminated or specifically targeted. If a report is
     about mild, consistent overprediction rather than an extreme single-
     slot value, this is a more likely explanation than (a) or ratio-
     estimator bias.

  f) THE RATIO-ESTIMATOR/JENSEN'S-INEQUALITY QUESTION REMAINS FORMALLY
     OPEN, BUT CURRENT EVIDENCE LEANS "NOT A SIGNIFICANT PROBLEM". What was
     investigated and NOT implemented: swapping the per-sample ratio
     (power/radiation) percentile estimator for a ratio-of-weighted-sums
     estimator, to address a theoretical bias (E[1/X] > 1/E[X] for noisy X,
     by Jensen's inequality). A combined Step1(hourly)+Step2(5-min)
     synthetic winter benchmark (test_combined_pipeline.js) showed the bias,
     tested on the actual production code path with realistic noise
     assumptions, is modest. A prototyped ratio-estimator+SNR-blend
     alternative was OUTPERFORMED by the targeted isFallback-gating fix on
     the one concrete real-world outlier available at the time. The p75
     percentile choice is deliberate (see aggregateYieldFactors()'s own
     comment on why: learn clear-sky capacity, not average conditions) - a
     ratio estimator would systematically learn "average conditions"
     instead, risking underprediction on clear days. RECONSIDER only if new
     real data specifically shows failure mode (b) from section 4's
     playbook - not just any large deviation, which is far more often (a).

  g) NEVER VALIDATED AGAINST A LONG-DURATION REAL OVERCAST/ADVERSE DATASET.
     As of this writing, every real scenario in data/ is a single sunny
     August period (same general property, 3 orientations). Everything
     about adverse-condition (winter, extended cloud, snow, etc.) behavior
     is synthetic simulation. THIS IS THE GAP REAL FIELD REPORTS FILL - a
     new adverse-condition scenario folder is strictly better evidence than
     any synthetic result in this working set, and should also be used to
     sanity-check whether the synthetic noise models in the stress-test
     scripts were ever realistic (real weather-model forecast error is more
     autocorrelated per weather system than the independent-per-sample
     noise those scripts use - flagged, never resolved).


7. PITFALLS ALREADY HIT - DO NOT REPEAT
--------------------------------------------
  1. TRUST NOTHING IN A HANDOFF DOCUMENT WITHOUT RUNNING IT. An earlier
     version of this document quoted specific numbers for a synthetic
     scenario that, when the referenced script was actually run, produced
     DIFFERENT numbers - the script had been edited after the numbers were
     written down, and the prose was never updated to match. Always re-run
     before you build on a claimed result, including claims IN THIS
     DOCUMENT - the section 3 regression baseline exists specifically so
     you don't have to trust prose numbers for the real-data scenarios.

  2. WHEN A "Math.max(softLimit, physicalCeiling)"-STYLE LOOSENING
     MECHANISM MISBEHAVES AT LOW RADIATION, A BIGGER DENOMINATOR FLOOR
     ALONE PROBABLY WON'T FIX IT. Tried first on the East array's 28x
     outlier: even a floor of 50 W/m2 gives physicalCeiling~99 for that
     array, nowhere near the already-correct soft limit of ~11.8 it was
     overriding - you'd need an absurd floor (~400+ W/m2) to numerically
     match, breaking the mechanism's actual purpose (loosening legitimate
     moderate-radiation sunrise/sunset ramps). The real fix was gating on
     WHETHER to loosen at all (`!bestSample.isFallback`), not adjusting HOW
     MUCH. If tuning a magic-number floor isn't converging to something
     sane, ask whether the loosening should be happening at all in that
     case, not what the number should be.

  3. AN ADAPTIVE THRESHOLD ANCHORED TO A THEORETICAL/PHYSICAL REFERENCE
     (e.g. a fraction of clear-sky GHI) CAN REPRODUCE THE EXACT BUG YOU'RE
     FIXING. Considered for `datasetMaxYF`'s adaptive threshold: a fraction
     of `estimateClearSkyGHI()` seemed more "principled" than an
     empirically-observed-max-based threshold, but theoretical clear-sky can
     vastly exceed what a heavily overcast window ever actually observes -
     under pessimistic enough conditions, that threshold could ALSO never be
     met by any sample, reproducing the original bug with a different,
     still-unreachable number. Prefer thresholds anchored to what the
     dataset ACTUALLY contains (guaranteed achievable) over what's
     theoretically possible, for this class of "best-available tier of THIS
     dataset" logic.

  4. DON'T ASSUME A GEOGRAPHIC/STRUCTURAL EXPLANATION WITHOUT ISOLATING THE
     CONFOUND. Initially hypothesized that lower latitudes (steeper sunrise/
     sunset curves) would make the sub-slot interpolation artifact worse.
     Testing a desert location's hourly-ONLY path in isolation (no Step 2)
     on 14 clear days gave a near-perfect result - completely undermining
     that hypothesis. The actual cause, confirmed by dumping the raw
     samples, was the SAME sparse-sample/isFallback mechanism as everywhere
     else (gap 6a), unrelated to curve steepness or latitude. Before writing
     up a geographic or structural explanation for an anomaly, isolate it -
     run the suspected mechanism alone (e.g. hourly-only vs combined, one
     array vs another) before concluding WHY something happened, not just
     THAT it happened.

  5. A SYNTHETIC BENCHMARK'S PRINTED "TRUE VALUE" REFERENCE IS ONLY RIGHT IF
     THE SCRIPT REMEMBERS TO SCALE IT. test_scale_and_geography.js's true
     yieldFactor scales with the tested peakPower (TRUE_YIELD =
     peakPower/1000) - a hardcoded "(true=1.000)"-style label in a new
     script would be wrong for anything other than a 1kW test. When adding a
     new synthetic benchmark, compute expected/true values explicitly rather
     than trusting a label that may not have been updated for the scale
     being tested.

  6. DON'T HARDCODE peakPower/lat/lon FOR A REAL ARRAY FROM MEMORY OR A
     PLAUSIBLE-LOOKING GUESS - GO CHECK THE ACTUAL SETTINGS. The scripts
     that became this working set's real-data regression tool used to
     hardcode peakPower=4000/4500/3000 and a single shared lat/lon for all
     three original arrays. Reading the arrays' actual settings screenshots
     revealed the real values were 1000/5400/(3000, confirmed separately)
     with TWO DIFFERENT lat/lon pairs, not one shared pair - a ~20-100%
     error that had been silently carried through multiple rounds of
     analysis. It happened to not change the final regression numbers this
     time (peakPower wasn't the binding constraint for those particular
     values), but that was luck, not a reason to skip verification next
     time. This is exactly why meta.json requires a `source` field now -
     record where a scenario's parameters actually came from.

  7. THIS CODEBASE'S ESTABLISHED FIX-COMMENT STYLE (follow it - every fix
     referenced in section 1 does): lead with "BUG FOUND AND FIXED
     (date, evidence source)", state the concrete mechanism (not just the
     symptom), and explain why the chosen fix - not a simpler-looking
     alternative - is actually correct. If you can't explain why a number is
     what it is in physical/statistical terms, it's probably the wrong
     number (pitfalls #2 and #3 above are both examples of exactly that
     check catching a bad first attempt).


8. LOCALE / UI NOTE
------------------------
This repo has a mandatory-13-locale rule for any new user-facing string (see
locales/*.json - ar, da, de, en, es, fr, it, ko, nl, no, pl, ru, sv must stay
in sync). Only relevant if a fix touches UI-facing text - the core algorithm
work in SolarLearningStrategy.js touches no user-facing strings.
