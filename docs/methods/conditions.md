# Conditions: what the data mean

Plain-language reference for the Conditions view (`app/ui/conditions.js`) and its adapters (`app/providers/`). Permissions and terms are in `docs/sources/conditions.md`; this file covers meaning, timestamps, units and limits, and records the live tests.

## 1. Order and principle

1. The view shows, in order: the avalanche forecast, weather now and the next 48 hours, hourly and daily detail, then nearby SNOTEL stations.
2. Four kinds of information stay separate and labeled: the official avalanche forecast (CAIC), forecasts (NWS and an Open-Meteo model), measurements (SNOTEL), and values this app derives (window totals, changes). Nothing here is combined into a danger rating, a stability judgment or a go/no-go call.
3. Missing is shown as "n/a" or a labeled state, never as zero. Each provider loads, times out and fails on its own, so one dead service never blanks the others.

## 2. Avalanche forecast (CAIC)

1. Always shown first: a button "Official CAIC forecast (opens avalanche.state.co.us)" that opens `https://avalanche.state.co.us/?lat={lat}&lng={lon}` (4 decimals). CAIC's forecast map reads these parameters and opens the forecast area containing the point (tested by the sources lane, docs/sources/conditions.md 2.1.4). For a route with the feed off, extra links open the start, the high point (only when the route carries elevations) and the end.
2. The avalanche.org map-layer adapter is built and tested but ships switched off (`CONFIG.providers.caic.enabled = false`), as is the detailed product endpoint (`CONFIG.providers.caic.product.enabled`, read as off when absent). Reason, from the sources research: the API root page asks users to contact avalanche.org for permission, CAIC's copyright clause requires written permission for its content, and no license grant exists. What unlocks it: the captain's decision on the [ALEC TO CONFIRM] in docs/sources/conditions.md 2.1.1 for the map layer, and written permission from CAIC and avalanche.org for the product endpoint. Enabling either is a config change.
3. When enabled, the adapter resolves the point, and every point of a route sampled at most 200 m apart, against the polygons of the same map-layer response (CAIC zones are dynamic and change daily, so nothing is hardcoded). Each zone keeps its own times: `start_date` and `end_date` carry no offset and are UTC (the product endpoint gives the same clock values with `+00:00`).
4. States, all distinct, none shown as a rating except the first: rated (current window, level 1 to 5), no rating published (off season or level -1/0), expired, not yet in effect, validity unknown, outside coverage (no polygon contains the point), zone boundary (more than one polygon: each listed, no single rating), no product (empty feed), unavailable (request failed; "missing is not low danger"), switched off.
5. A saved copy of the feed (kept up to 2 days) is used only when a request fails, is labeled as saved, and each zone is still checked against its own expiry, so it turns into "expired" on time. The detailed product is never fetched from a saved feed.
6. Detailed product (when its switch is on): accepted only when its `published_time` and `expires_time` equal the zone's window, the product lists the zone id, and it has not expired. `upper`, `middle`, `lower` are shown as Above, Near, Below Treeline; the "current" column is the Colorado date of `expires_time`, "tomorrow" the day after. The bottom line is converted to plain text and rendered as text.

## 3. Weather

### 3.1 NWS (official forecast)

1. The adapter calls `/points/{lat},{lon}` and follows the `forecast` and `forecastGridData` URLs it returns; grid ids are never constructed. `forecastHourly` is not fetched: it repeats the same grid in US units with text wind speeds (about 160 KB per place). Alerts come from `/alerts/active?point=`.
2. Grid values are interval series (`start/duration`). Temperature, wind, gust, direction, sky cover and snow level are values over their interval; QPF and snowfall are totals over 6 h blocks. A 24 or 48 h total from now splits a block cut by the window evenly by hour, and is "n/a" if any part of the window has no value. NWS `snowfallAmount` is millimetres of snow and is stored as centimetres.
3. Elevation: the view states the NWS grid cell elevation (about 2.5 km cell) and its difference from the selected point. At Berthoud Pass the cell is 3,581 m against 3,446 m at the pass. These are grid values, not ridge-top or slope values.
4. Freshness: flagged stale when the forecast `updateTime` is more than 12 h old (a judgment knob), expired when its valid period has ended. A 404 from `/points` means outside NWS coverage, not a failure.
5. Alerts are never served from a saved copy: a failed alert request shows "alerts unavailable", which is different from "no active alerts".

### 3.2 Open-Meteo (model)

1. One request per place, `models=best_match`: Open-Meteo chooses and blends the models for the location; the response does not say which model or run time, so the view labels it "Open-Meteo best match" and shows retrieval time only. Attribution "Weather data by Open-Meteo.com" with a link, CC BY 4.0.
2. Grid and elevation, tested 2026-11-06 at Berthoud Pass: the response latitude/longitude is the centre of the model cell used (here 39.80367, -105.76832, about 965 m from the pass). By default Open-Meteo adjusts 2 m temperature from the cell height to the elevation of its own 90 m DEM at the point (3,449 m here); `elevation=nan` disables that and uses the mean cell height (3,512 m). Passing `elevation` replaces the DEM value as the adjustment target. Only temperature changed; wind, gusts, precipitation, snowfall, cloud, weather code and freezing level were identical. The app passes the selected point's elevation when the map supplies one (from our terrain data) and shows which elevation was used.
3. Hourly precipitation and snowfall at time t are the amounts in the hour ending at t; wind gusts are the maximum of the hour ending at t; temperature, wind and freezing level are at t. Totals use the weather app's `integrate` rule (commit 914f4aa): a window with any missing hour has no total.
4. Precipitation type per hour: from amounts first (snow and liquid both present is "rain and snow"), then from the WMO weather code (snow codes, freezing drizzle and rain, rain, thunderstorm), else "dry". Model snowfall uses Open-Meteo's fixed ratio of 0.7 cm of snow per mm of water, so light, cold snow reads low.
5. Daily rows are Colorado calendar days, 23 or 25 hours on DST change days. Days 4 to 7 are marked lower confidence.

## 4. SNOTEL (measurements)

1. Stations come from `data/snow/snotel-stations.geojson` (snow-obs lane; `upstreamId` is the AWDB triplet). The view lists the 5 nearest within 60 km with distance and elevation difference from the point (unknown elevation is "n/a", not 0). Their latest hourly depth comes from one batched request; a station's 30 days of daily and 7 days of hourly data load only when it is opened.
2. Time: AWDB timestamps are station clock times in a fixed offset (`dataTimeZone`, -8, Pacific Standard Time, for every Colorado station) all year, never shifted for DST. The adapter attaches that offset and the view shows Colorado time. A daily value dated D is the reading at 00:00 ending D, which equals the hourly reading at D+1 00:00 (verified on 2026-11-02 to 11-04 at Berthoud Summit).
3. Units: depth inches to cm, SWE and precipitation inches to mm, temperature F to C, all converted in the adapter; display units follow the user's setting.
4. Quality: values are requested with flags and with suspect data included, so suspect values show as suspect instead of silently disappearing. Flag meanings from the NRCS Report Generator header (fetched 2026-11-06): QC V valid, N no profile, E edit (minor adjustment for sensor noise), K estimate, C correction, B back estimate, X external estimate, S suspect, M missing; QA U unknown, R raw (no human review), P provisional, A approved. Readings flagged S or M, or outside the plausibility bounds (depth 0 to 400 in, SWE 0 to 150 in, air -60 to 100 F; judgment values from docs/sources/conditions.md), are labeled and never used in a change or chart. An absent date is missing.
5. Derived changes are shown separately from readings, each with its exact window: 24 h and 7 days from hourly readings ending at the latest usable one, 30 days from end-of-day values. Precipitation (PREC) is the gauge total since Oct 1, so a window across the water-year reset, or a falling total, has no value. A depth change is not new snowfall: settling, wind and melt change depth, and the sensors jitter by about an inch early in the season. A reading older than 6 h is marked delayed.
6. Charts (inline SVG, no library): depth hourly 7 days, SWE end of day 30 days, air temperature hourly 7 days. Unusable readings are gaps, never zeros. NRCS notes a known bias in SNOTEL air temperature.
7. A station measures one clearing. The nearest station is not necessarily representative of alpine, wind-loaded or differently aspected terrain.

## 5. Network behavior

1. Shared helper `app/providers/fetch.js`: 15 s timeout per attempt (30 s for NRCS), up to 2 retries after 1 s and 3 s for network errors, timeouts, 408, 429 and 5xx; other 4xx are not retried. A new selection aborts in-flight requests at once.
2. Last-good copies per provider and place (about 100 m) in `localStorage` under `skintrack-lastgood-*`, 12 places per provider: NWS and Open-Meteo up to 24 h, SNOTEL detail up to 3 days, CAIC feed up to 2 days. Shown only when a live request fails, always with their age. Storage errors are ignored (the app keeps working without copies).

## 6. Live tests

All times UTC. Origin header `https://alecbiles-code.github.io` on curl tests; every endpoint below answered with `access-control-allow-origin: *`.

| Time (2026-11-06) | Request | Result |
|---|---|---|
| 00:07:35 | NWS `/points/39.7983,-105.7772` | 200, 0.28 s, `cache-control: max-age=86400`; BOU 36,66, zone COZ034 |
| 00:07:41 | NWS forecast, forecastHourly | 200 (13 KB, 0.26 s), 200 (162 KB, 0.49 s), `max-age=3600` |
| 00:07:42 | NWS forecastGridData, alerts `?point=` | 200 (222 KB, 0.18 s); 200, empty FeatureCollection, `max-age=5` |
| 00:13:22 | NWS `/points/30,-140` | 404 problem+json "Data Unavailable For Requested Point" (outside coverage) |
| 00:08:16 | Open-Meteo, gfs_seamless and best_match, elevation default / nan / 3446 | all 200, 0.36 to 0.99 s; outputs identical between the two model ids; elevation changed temperature only |
| 00:08:47 | AWDB `/stations?stationTriplets=335:CO:SNTL&returnStationElements=true` | 200, 3.8 s, `dataTimeZone: -8.0` |
| 00:09:02 | AWDB `/data` hourly SNWD, WTEQ, TOBS, PREC, 8 days, flags and suspect data | 200, 1.0 s, 184 values per element; QC V, E, S seen; one SNWD reading of -7806 in flagged S |
| 00:09:03 | AWDB `/data` daily, 30 days | 200, 2.1 s |
| 00:09:27 | AWDB `/stations?stationTriplets=*:CO:SNTL&activeOnly=true` | 200, 118 stations, all `dataTimeZone: -8.0` |
| 00:10:36 | avalanche.org map layer CAIC | 200, 5.2 s (cold cache), 152,600 B, 10 zones valid 2026-11-05T23:30Z to 11-06T23:30Z; Berthoud Pass in zone 2745, level 1 |
| 00:10:50 | avalanche.org `/v2/public/product/2752` (by id) | 200, 200 B, every field null: the path takes a product id, not a zone id |
| 00:10:55 | avalanche.org product `?type=forecast&center_id=CAIC&zone_id=2752` | 200, 4,371 B, product 185711, published 23:30Z |
| 00:18:15 | same, `zone_id=2745` | 200, 7,184 B, product 185706, lists zone 2745 |
| 00:49:56 | Open-Meteo `models=best_match`, elevation 3446 (fixture `tests/fixtures/openmeteo.json`), and `past_days=6` (DST fixture) | 200, 2.0 s, 12,628 B; same grid cell; no null values |
| between 00:10 and 00:18 (seconds not logged) | Node runs of `getNws`, `getOpenMeteo` (gfs_seamless), `getStationDetail` (966 ms), `getLatest`, `getCaic` (enabled, verification only) | all state ok / rated, values as in the fixtures |
| from 00:30 | all hosts | this workstation's system resolver lost its configuration (curl exit 6, Node ENOTFOUND); a local outage, not a provider failure. Later requests went through the lead's DNS-over-HTTPS shim (work/dnsshim), which changes only name lookup |
| 00:50:09 | `getNws` live | ok, 1.3 s; BOU 36,66, grid 3,581 m, updated 18:47:50Z, 14 periods, alerts ok (0) |
| 00:50:09 | `getOpenMeteo` live (best_match) | ok, 0.34 s; cell 39.80367, -105.76832; temperature elevation 3,446 m; 7 days |
| 00:50:10 | `getLatest` live, 5 nearest stations in one request | ok, 1.2 s; 335, 1186, 970, 602, 505 all 1 in depth |
| 00:50:11 | `getStationDetail` live, 335:CO:SNTL | ok, 0.64 s; dataTimeZone -8 from metadata; latest depth 16:00 UTC-8; 209 hourly, 32 daily values |
| 00:50:11 | `getCaic` switched off | disabled, no request; link `https://avalanche.state.co.us/?lat=39.7983&lng=-105.7772` |
| 00:50:16 | `getCaic` switched on (verification only) | rated, 4.9 s; zone 2745 level 1, 2026-11-05T23:30Z to 11-06T23:30Z |
| 00:53:37 / 00:54:18 | View render check in jsdom (`work/conditions/render-check.mjs`), fixtures then live | all checks pass: link first and no rating with the feed off; grid elevation and attribution; 5 nearest stations; summary line; station detail with 3 charts; units re-render; feed on gives zone and 2 route zones with links; route links start, high point, end; untrusted name stays text; with every provider failing, unavailable states and the link, no rating (fixtures run only) |

Time sync check: SNOTEL hourly air temperature at Berthoud Summit correlated best with Open-Meteo hourly temperature at a fixed UTC-8 offset (r 0.954, against 0.922 at UTC-7), consistent with `dataTimeZone`.

## 7. Tests

`node --test tests/` runs `tests/lib-*.test.mjs` and `tests/providers-*.test.mjs` against trimmed real responses in `tests/fixtures/` (recorded 2026-11-06). Covered: normal responses; HTTP failure, retries and saved copies; timeouts and cancellation; expired, stale and not-yet-valid products; missing hours and readings (never zero); the 2026-11-01 DST day (25 h) and fixed-offset station clocks across it; outside coverage and zone overlaps; a route crossing two CAIC zones; product mismatch and expiry.

## 8. Limitations

1. No elevation adjustment is applied by this app. NWS values belong to a 2.5 km grid cell and Open-Meteo values to a model cell; only Open-Meteo temperature is adjusted, by Open-Meteo, to the stated elevation.
2. Open-Meteo best_match does not report the model or run used.
3. Forecast snowfall (NWS, model) and measured depth change (SNOTEL) are different quantities and are never merged or called "new snow".
4. Not yet checked in a real browser: on 2026-11-06 headless Chrome would not start on the build machine (it exited at once with no output, also for a data: URL) and chrome-devtools-axi could not attach. The jsdom render check covers DOM content, states and escaping, not layout. Owed: the iPhone-width (390 x 844 and 375 px) pass on `tests/harness/conditions.html` for overflow, 44 px targets, sunlight contrast and the real browser CORS path. Viewport emulation in desktop Chrome would still not be a real iPhone.
