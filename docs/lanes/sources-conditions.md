# Lane notes: sources-conditions

Deliverable: `docs/sources/conditions.md` (matrix, quoted terms, tested URLs, config recommendations). All tests 2026-11-06 00:02 to 00:23 UTC, curl 8.7.1 and headless Chrome 156, `Origin: https://alecbiles-code.github.io`. Raw responses: `/Users/bci-spatialecon/firstmate/data/colorado-ski-map-build/work/sources-conditions/`. No app code written by this lane.

## 1. Decisions

1. CAIC: the deep link `https://avalanche.state.co.us/?lat={lat}&lng={lon}` is the always-on integration. Verified in headless Chrome: CAIC's own page resolves the point to the current dynamic area and opens the full forecast. It needs WebGL2.
2. avalanche.org map layer: conditional. The NAC Public API User Guide documents third-party display rules, but the API root says "Please contact avalanche.org / American Avalanche Associate for permission". Recommended default off until the captain decides. [ALEC TO CONFIRM: accept the NAC guide for personal display, or wait for written permission.]
3. avalanche.org `/v2/public/product`: permission needed. It returns elevation-band danger (two days), problems with aspect/elevation, likelihood and size, and the bottom line, but it is undocumented and CAIC's Terms require written permission to reproduce. Forecast discussion is not available there at all.
4. CAIC AVID (`/avid/products/all...`): rejected. The Terms prohibit robots and data mining, and it sends no CORS header.
5. NWS, Open-Meteo and NRCS AWDB: usable now from the browser (`Access-Control-Allow-Origin: *` on all three).
6. SNODAS and the NOHRSC snowfall analysis: pipeline only (no CORS). A NOAA ArcGIS map service with the latest SNODAS images is browser-usable as an optional layer.

## 2. Findings other lanes must not miss

1. CAIC areas are dynamic (`config.dynamic_zones: true`); there were 10 or 11 areas a day with changing membership between 2026-11-01 and 11-05. Map-layer feature ids are not stable zones.
2. The map-layer `start_date` and `end_date` have no offset and are UTC (three-way check against the product API and CAIC's page). `link` is always the CAIC homepage.
3. A disabled legacy zone (`zone_id=2496`) returns HTTP 200 with a 2022 product. Check `expires_time`; HTTP 200 does not mean current.
4. The undated `products?avalanche_center_id=CAIC` returned 142 MB. Never call it.
5. Product `valid_day: "current"` is the local date of `expires_time` (issued Nov 5 at 4:30 PM, "current" was Fri Nov 6). Verified on one area only.
6. SNOTEL hourly timestamps are fixed UTC-8 (`dataTimeZone: -8.0` for all 118 Colorado stations; confirmed by temperature cross-correlation across the 2026-11-01 DST change). A daily value dated D equals the hourly value at D+1 00:00 UTC-8 (24 of 24 matches).
7. AWDB omits suspect values entirely by default (no null placeholder). Loveland Basin SNWD read -7804 (`qcFlag: S`) on 2026-11-04.
8. AWDB rejects an all-elements station metadata request (HTTP 400). The filtered request takes about 28 s, so take it from a pipeline snapshot.
9. Open-Meteo lists HRRR as discontinued on 2026-11-30 and NAM on 2026-11-01; `best_match` uses RRFS in North America. NBM has no freezing level or snow depth. `elevation` only changes temperature (lapse rate).
10. NWS hourly forecasts have no gusts or snowfall; take `windGust`, `snowfallAmount` (6 h, mm) and `snowLevel` (3 h, m) from `forecastGridData`. The grid cell elevation differs from the pass by about 135 to 180 m. The nearest NWS observation station to Berthoud is 35 km away at 2,501 m, and its parsed values were null (QC "Z").
11. An empty User-Agent gets 403 from NWS; a browser's own UA works. Coordinates with more than 4 decimals get a 301 redirect (CORS intact).

## 3. Open items and blockers

1. Permission for the CAIC detail (product endpoint): written permission from CAIC and from avalanche.org / the A3. This lane did not contact anyone (rule 4).
2. The meaning of AWDB QC/QA flags comes from a secondary source; not confirmed in NRCS docs. The USDA public-domain text was read via the `usda.azureedge.us` mirror because usda.gov and nrcs.usda.gov block automated fetches.
3. Untested on a real iPhone: CAIC deep link rendering (WebGL2), `persist()` grant, `estimate()` quota, eviction, and whether Safari and the Home Screen app share storage.
4. Not provoked: NWS 5xx and rate-limit responses, Open-Meteo 429, avalanche.org outage shape, and the CAIC deep link for a point outside every area.
5. Contract note for the lead: none required. The SNOTEL time rule (fixed station offset, not America/Denver) is consistent with ARCHITECTURE section 4.3 but worth stating in the stations schema.
