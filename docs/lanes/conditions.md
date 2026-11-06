# Lane notes: conditions

Owner of `app/providers/`, `app/ui/conditions.{js,css}`, `app/lib/{units,time}.js`, `tests/providers-*`, `tests/lib-*`, `tests/fixtures/`, `tests/harness/conditions.html`, `docs/methods/conditions.md`. Data meaning and live test log: `docs/methods/conditions.md`.

## 1. API for app-core

1. `app/lib/units.js`: `getUnits`, `setUnits` (fires `skintrack:units`), `fmtElevation`, `fmtDistance`, `fmtTemp`, `fmtSpeed`, `fmtSnowDepth`, `fmtWater`, `fmtSnowfall`, `fmtAngle`, `fmtElevationDelta`, `compass`, `unitLabel`, pure converters. Formatters take SI and options `{units, signed, bare}`; missing input gives 'n/a'.
2. `app/lib/time.js`: `TZ`, `toMs`, `iso`, `fmtDateTime`, `fmtTime`, `fmtDay`, `fmtHour`, `ageText`, `validityState`, `withOffset`, `localDate`, `shiftDate`, `zonedEpoch`, `dayBounds`. Offsetless date-times are rejected (n/a), a bare `YYYY-MM-DD` is a calendar day.
3. `app/ui/conditions.js`: `createConditionsView(container)` returns `{show(place), showStation(feature), clear()}`; `renderPlaceSummary(el, place)`. Station features are those of `data/snow/snotel-stations.geojson`.
4. Adapters: `getNws`, `getOpenMeteo`, `getStationDetail`, `getLatest`, `loadStations`, `nearestStations`, `getCaic`, `officialLink`. None throws; each returns an object with `state`.

## 2. Decisions

1. 2026-11-06: weather app commit 914f4aa reused: `integrate` and DST calendar (ported), retry policy (ported into `fetch.js`), end-of-day SNOTEL semantics, per-source failure isolation, CAIC UTC window rule. Not reused: the station new-snow estimate (`measuredDay` 10:1 rule) and model rankings; out of scope for a measured-only SNOTEL panel.
2. Lead decisions applied: CAIC map layer and product endpoint off; official deep link `?lat=&lng=` at 4 decimals is the first element of the forecast card; route links at start, high point (if elevations) and end; product accepted only for the same publication and before `expires_time`; Open-Meteo `best_match` with attribution link; SNOTEL suspect data requested and flagged.
3. NWS `forecastHourly` not fetched (duplicate of grid data in US units, 160 KB).
4. SNOTEL plausibility bounds taken from docs/sources/conditions.md 3.7. QC/QA flag meanings taken from the NRCS Report Generator CSV header, a primary NRCS source (the sources doc cites a secondary table and lists a QA flag `F` that the NRCS header does not have).

## 3. Open items for the lead

1. Config contract: endpoint URLs live at the top of each adapter (`NWS`, `OPEN_METEO`, `SNOTEL`, `CAIC` objects), not in `app/config.js`. The view reads `CONFIG.providers.caic.enabled` and `CONFIG.providers.caic.product.enabled` (absent means off). Move the URLs into config.js if strict single-source is wanted.
2. Station list path: the sources doc names `./data/snow/snotel-stations.json`; the snow-obs lane wrote `data/snow/snotel-stations.geojson`, which the adapter reads.
3. [ALEC TO CONFIRM: map-layer display under the NAC guide vs. written permission, docs/sources/conditions.md 2.1.1.]

## 4. Status log

1. 2026-11-06T00:30Z: lib, providers, view, CSS, harness written; 72 node tests pass (all lanes' tests in `tests/`).
2. 2026-11-06T00:30Z: workstation system DNS lost its configuration; headless Chrome would not start (exit 0, no output). chrome-devtools-axi 0.1.29 with npx chrome-devtools-mcp latest fails with "pageId: expected number"; app-core's pinned mcp 1.12.0 attached no target either.
3. 2026-11-06T00:50Z: through the lead's DoH shim: best_match fixtures refreshed, every adapter run live (all ok), jsdom render check of the view passed with fixtures and live data (`work/conditions/render-check.mjs`, logs beside it).
4. Owed: real-browser pass of `tests/harness/conditions.html` at 390 x 844 and 375 px (overflow, touch targets, contrast) with screenshots to `work/conditions/shots/`. The shared dev server was started on port 8792 for it.
