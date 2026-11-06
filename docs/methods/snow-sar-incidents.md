# Snow observations, SNODAS, SAR inventory and incidents: sources and methods

Lane snow-obs, 2026-11-05/06 (UTC). Status words: researched (read the source), implemented (code exists), tested (ran, result recorded here). Every endpoint test lists URL, UTC time, status and the relevant headers. Nothing here implies safety, a danger rating or a go/no-go decision.

## 1. Status

1. SNOTEL station snapshot: implemented and run (`pipeline/snow/snotel_stations.py`, 122 stations); runtime query patterns and CORS headers tested with curl; a real-browser request was not possible here (2.6).
2. SNODAS Colorado product: implemented, run for 2026-11-05, unit-tested (`tests/pipeline/test_snodas.py`), cross-checked against SNOTEL. Daily workflow written (`.github/workflows/snodas.yml`), not enabled and never run on GitHub.
3. SAR inventory: archives inspected, range requests tested against the published copies, `data/sar/sar-inventory.meta.json` and `data/sar/coverage.geojson` written. No archive copied.
4. Incidents: sources and terms researched; schema, importer and tests implemented; dataset ships empty because no source clearly permits republishing. `data/incidents/official-links.json` lists the official pages.

## 2. SNOTEL and SNOLITE (NRCS AWDB REST API)

### 2.1 Source and terms

The USDA NRCS National Water and Climate Center Air and Water Database REST API (`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/`, OpenAPI at `.../awdbRestApi/v3/api-docs`, UI at `.../awdbRestApi/swagger-ui/index.html`) needs no key. The catalog.data.gov entry for AWDB (`https://catalog.data.gov/dataset/awdb`, read 2026-11-06) gives License "https://www.usa.gov/government-works" and, confusingly, Access Level "restricted public" with Access Rights "Access restricted. Contact the publisher to request access." The keyless REST API answered every request below; the "restricted" wording appears to describe the older registered SOAP service, but I found no NRCS page that says so. I could not load the current NRCS terms text (the NRCS products page timed out). Treat AWDB as a U.S. Government work used within its documented public API, and attribute "USDA NRCS National Water and Climate Center". NRCS's own data header adds a revision and no-liability notice (quoted in 2.5).

### 2.2 Station snapshot

`data/snow/snotel-stations.geojson` (schema `schemas/station.schema.json`, 142,668 bytes) is built from one request:

`GET .../stations?stationTriplets=*:CO:SNTL,*:CO:SNTLT&activeOnly=true&returnStationElements=true&durations=DAILY,HOURLY&elements=SNWD,WTEQ,PREC,PRCPSA,TOBS,TMAX,TMIN,TAVG,SNDN,RHUM,WSPDV,WSPDX,WDIRV,SWINV`

The `elements` filter is required: the same request with all elements returns HTTP 400 "The requested number of station elements exceeds the amount allowed." (tested 2026-11-06T00:05:13Z). Result: 118 SNOTEL and 4 SNOLITE stations (Cottonwood Pass, Italian Creek, Tin Cup and Trail Creek, Gunnison County, Taylor Park area, 3,179 to 3,557 m). SNOLITE reports snow depth and temperature, no SWE or precipitation; it is included because it adds high-elevation depth sites. Snow courses (network SNOW, monthly manual), SCAN and COOP were left out (not daily snow).

Per station: `id` (`nrcs-awdb:<triplet>`), `upstreamId` (triplet), NRCS station page URL, name, network, county, HUC, SHEF id, `elevationM` (AWDB feet x 0.3048, source value kept in `elevationSource`; AWDB does not state the vertical datum), `dataTimeZoneOffsetHours`, station `beginDate`, and `elements`: for each element the station reports (ordinal 1 sensor), its stored unit and the begin date per duration. Example: Berthoud Summit has daily WTEQ since 1978 but SNWD only since 2002-07-03, so long snow-depth histories are shorter than SWE histories.

### 2.3 Time semantics (tested)

1. Every Colorado SNOTEL and SNOLITE station has `dataTimeZone: -8.0` in AWDB, not -7. Hourly timestamps carry no offset (`"2026-11-05 15:00"`).
2. Check against the sun: hourly incoming shortwave (SWINV) at four stations, 2026-10-23 to 2026-11-05, was correlated with modelled solar elevation for assumed offsets -6 to -9. Best fits: Arapaho Ridge -8 (r 0.85 vs 0.77 at -7), Joe Wright -8 (0.86 vs 0.79), Red Mountain Pass -8 (0.82 vs 0.77), Berthoud Summit -9 hour-ending, which is equivalent to -8 hour-starting (0.88 vs 0.64 at -7 hour-ending). MST (-7) was worse at all four. The daylight window (first and last hour above 5 W/m2) stayed at 06 to 15 across the 2026-11-01 daylight-time change, so there is no DST shift.
3. Conclusion: interpret hourly timestamps as fixed UTC-8, i.e. `"YYYY-MM-DD HH:MM"` becomes `YYYY-MM-DDTHH:MM:00-08:00`, then display in America/Denver. Use the station's `dataTimeZoneOffsetHours` rather than a constant, so a future change is picked up.
4. Daily values are end-of-day readings: the daily TOBS dated D equalled the hourly TOBS stamped D+1 00:00 on 7 of 7 days at each of Berthoud Summit, Jones Pass and Loveland Basin (the weather app found the same). So a daily state value (SNWD, WTEQ, PREC accumulation) dated D is the reading at 00:00 UTC-8 on D+1 = 08:00 UTC = 01:00 MST (02:00 MDT). A change "on day D" is value(D) minus value(D-1). Depth change is not new snowfall (settlement, wind and melt act on it), and PREC is a water-year accumulation, so daily precipitation is a difference of consecutive values (PRCPSA is NRCS's own snow-adjusted daily increment).
5. `endDate=0` and `beginDate=-n` are relative dates in the unit of the duration (days for DAILY, hours for HOURLY), evaluated on the server.

### 2.4 Runtime query patterns for the conditions adapter

Base: `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data`. One request can carry many comma-separated triplets; batch the stations near a destination into one call.

1. Daily, 30 days (tested 2026-11-06T00:07:31Z, 200, 51,746 bytes, 3.1 s for 3 stations x 8 elements):
   `?stationTriplets=335:CO:SNTL,970:CO:SNTL,602:CO:SNTL&elements=WTEQ,SNWD,PREC,TOBS,TMAX,TMIN,TAVG,PRCPSA&duration=DAILY&beginDate=-30&endDate=0&returnFlags=true&centralTendencyType=MEDIAN`
   Returned dates 2026-10-06 to 2026-11-04 (today's value is not complete until the end-of-day reading). `centralTendencyType=MEDIAN` adds the NRCS median for the date (WTEQ and PREC only; null otherwise).
2. Hourly, 7 days (tested 2026-11-06T00:07:31Z, 200, 129,421 bytes, 5.3 s for 3 stations x 4 elements):
   `?stationTriplets=335:CO:SNTL,970:CO:SNTL,602:CO:SNTL&elements=WTEQ,SNWD,PREC,TOBS&duration=HOURLY&beginDate=-168&endDate=0&returnFlags=true`
   The newest hourly value was stamped 2026-11-05 15:00 (UTC-8) = 23:00 UTC, about one hour before the request.
3. Do not load the whole state at runtime: all 122 stations x 4 daily elements x 30 days was 978,457 bytes and 9.2 s (tested 2026-11-06T00:39:04Z). Request the few stations near the selected point (the snapshot gives locations), and load hourly only when the user opens a station.
4. Response shape: an array of `{stationTriplet, data: [{stationElement: {elementCode, storedUnitCode, ...}, values: [{date, value, qcFlag, qaFlag, median?}], error?}]}`. Units are the `storedUnitCode` (in, degF, pct, mph, degree, watt/m2); convert to SI only in `app/lib/units.js`. `periodRef` defaults to `END` (timestamp at the end of the period).
5. Missing and suspect data: with the default `returnSuspectData=false`, suspect values are removed, so dates are simply absent (Berthoud Summit had 29 of 30 daily SNWD and 28 of 30 PRCPSA). Align series by date, never by index, and treat an absent date as null. A `value` of null is also possible. Snow depth below 0 or absurd jumps should be shown as suspect, not repaired; never substitute 0.

### 2.5 Quality flags (`returnFlags=true`)

The API documentation does not define the letters. The NRCS Report Generator CSV header (fetched 2026-11-06T00:38:54Z from `https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/daily/335:CO:SNTL%7Cid=%22%22%7Cname/-3,0/WTEQ::value,WTEQ::qcFlag,WTEQ::qaFlag`) gives them verbatim:

1. Quality control (`qcFlag`): V Valid "Validated Data"; N No Profile "No profile for automated validation"; E Edit "Edit, minor adjustment for sensor noise"; K Estimate "Estimate"; C Correction "A different equation has been applied to the original sensor voltage"; B Back Estimate "Regression-based estimate for homogenizing collocated Snow Course and Snow Pillow data sets"; X External Estimate "External estimate"; S Suspect "Suspect data"; M Missing "Value is missing".
2. Quality assurance (`qaFlag`): U Unknown; R Raw "No Human Review"; P Provisional "Preliminary Human Review"; A Approved "Processing and Final Review Completed".
3. Observed in 30 days of daily data for all Colorado stations: V/P 9,202, V/R 2,503, E/P 2,159, V/A 225, E/A 153, K/P 61, E/R 50, N/R 5, M/P 4. Recent hourly values are mostly R (raw).
4. The same header warns: "The data you have obtained from this automated Natural Resources Conservation Service database are subject to revision regardless of indicated Quality Assurance level. Data are released on condition that neither the NRCS nor the United States Government may be held liable for any damages resulting from its use." and "SNOTEL air temperature data contains a known bias. This bias is rooted in the sensor conversion equation and varies through the output range. Solutions are in development." Show K, X, B and C as estimated, S as suspect, M as missing, R as raw/unreviewed, and keep the temperature-bias note next to station temperatures.

### 2.6 CORS (tested with curl; real browser not tested)

Simple GETs with `Origin: https://alecbiles-code.github.io` to `/stations` and `/data` (2026-11-06T00:05:13Z, 00:07:03Z, 00:07:31Z, 00:09:02Z, 00:39:04Z) all returned `access-control-allow-origin: *` and `access-control-allow-headers: *`, also on the HTTP 400 error response. An OPTIONS preflight (`Access-Control-Request-Method: GET`, `Access-Control-Request-Headers: accept`) returned 200 with the same headers. A plain `fetch(url)` from the GitHub Pages origin should therefore work; do not add custom request headers. A headless Chrome 156 check (page in the work directory fetching both URLs) could not run: Chrome aborted at start (exit 134) in this environment, so a real-browser request is still owed by the lead's browser verification. Responses carry `cache-control: max-age=0, private`, so the app must keep its own last-good copy.

## 3. SNODAS Colorado product

### 3.1 Source, access, terms

NOHRSC SNODAS via NSIDC data set G02158 version 1, masked (contiguous US) daily tar files at `https://noaadata.apps.nsidc.org/NOAA/G02158/masked/YYYY/MM_Mon/SNODAS_YYYYMMDD.tar` (public HTTPS, no login; directory listing and download tested 2026-11-06T00:09:16Z and 00:09:21Z, both 200). Landing page `https://nsidc.org/data/g02158/versions/1`; user guide `https://nsidc.org/sites/default/files/g02158-v001-userguide_2_1.pdf` (downloaded 2026-11-06T00:11:08Z). Terms on both: "As a condition of using these data, you must cite the use of this data set." No other license text is given. The landing page also says "Due to funding limitations, this data set was recently changed to a "Basic" Level of Service." Citation: National Operational Hydrologic Remote Sensing Center. 2004. Snow Data Assimilation System (SNODAS) Data Products at NSIDC, Version 1. Colorado subset. Boulder, Colorado USA. NSIDC: National Snow and Ice Data Center. https://doi.org/10.7265/N5TB14TC.

### 3.2 Format facts used (user guide and file header)

Flat binary 16-bit signed integer, big-endian; masked grid 6,935 columns x 3,351 rows, 30 arc-second cells, WGS84 latitude/longitude, first value at the NW corner, row-major. Grid edges from 2013-10-01: west 124.7333 W, north 52.8750 N (header values carry rounding noise, user guide 1.7.4). Snow depth is product 1036 and SWE product 1034, both "Snapshot at 06:00 UTC", units metres with scale factor 1000 (header: "Data units: Meters / 1000.000000"), so the stored integer is millimetres. No data is -9999. NSIDC warns of erroneously high SWE in some high-elevation regions, saturating at 32767 (32.767 m). Model values are point estimates for the cell centre. The 2026-11-05 file was created 10:55:38 (header, time zone not stated) and posted at NSIDC at 14:00:25 UTC (HTTP Last-Modified), 8 hours after its valid time.

### 3.3 Processing (`pipeline/snow/snodas.py`)

1. Probe back from today (UTC) with HEAD requests, up to 10 days, for the newest tar; skip if the published meta already has that date.
2. Read the two members by product key (`ssmv11036tS__T0001`, `ssmv11034tS__T0001`). Validate the header against the documented format: units string, 2 bytes per pixel, slope 1, intercept 0, no-data -9999, 6935 x 3351, origin on the 30 arc-second lattice within 1e-6 degree, and a 06:00 UTC snapshot on the requested day. Any mismatch fails the run (nothing is published).
3. Decode big-endian int16; subset to west -109.3, east -101.8, south 36.75, north 41.25 (Colorado plus about 0.25 degree), snapped to whole cells: 900 x 540 cells.
4. Display PNG per variable: palette PNG, 1800 x 1391, on a Web Mercator pixel grid whose corners are exactly the subset edges. Columns are exact (2 pixels per cell; Mercator x is linear in longitude); rows take the cell containing each pixel centre (nearest neighbour). Palette index 0 = valid zero, fully transparent; classes from `config.yaml`; last index = no data or saturated, translucent grey. 35 KB each on 2026-11-05.
5. Numeric grid: the native SNODAS cells, not resampled. 64 x 64 cell chunks, 15 x 9 chunks of 16,384 bytes, each cell two little-endian int16 values `[snow_depth_mm, swe_mm]`, row-major from the NW corner; edge chunks padded with -9999 beyond the grid. Raw analysis integers, no rounding.
6. Write `data/snow/snodas.meta.json` (analysis date, valid time, layer URLs, corners, legend, grid layout, stats, provenance, citation, limitations) and prune to the two newest dated directories.

### 3.4 Browser contract

Files are relative to `data/snow/`: `snodas.meta.json` (fixed path) points to `snodas/<date>/snow-depth.png`, `swe.png` and `grid/r{r}c{c}.bin`. Dated paths make every product file immutable, so caches and offline packages never mix days.

1. Image: `map.addSource('snodas-depth', {type: 'image', url: base + meta.layers.snow_depth.url, coordinates: meta.layers.snow_depth.coordinates})` with corners in [lon, lat] order top-left, top-right, bottom-right, bottom-left. Legend rows come from `meta.layers.*.legend` (`minMmExclusive`, `maxMmInclusive`, colour; zero and no-data rows separate).
2. Sampling a tapped point:

```js
const g = meta.grid;
const col = Math.floor((lon - g.west) / g.cellDeg), row = Math.floor((g.north - lat) / g.cellDeg);
if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return {state: 'outside-coverage'};
const r = Math.floor(row / g.chunkCells), c = Math.floor(col / g.chunkCells);
const buf = await (await fetch(base + g.chunkUrl.replace('{r}', r).replace('{c}', c))).arrayBuffer();
const i = ((row % g.chunkCells) * g.chunkCells + (col % g.chunkCells)) * 4, dv = new DataView(buf);
const depthMm = dv.getInt16(i, true), sweMm = dv.getInt16(i + 2, true);
// -9999 -> no data; >= g.saturated (32767) -> flagged erroneous; 0 -> valid zero (no modelled snow)
```

Show depth in cm (mm / 10) and SWE in mm through `app/lib/units.js`, the analysis date, "valid 06:00 UTC (11 PM MST the evening before)", "1 km modelled", and the source. A failed chunk load is a failed-load state, not zero.

3. Chunks avoid HTTP Range requests on purpose: `raw.githubusercontent.com` answered a ranged GET with 206 and `access-control-allow-origin: *` but rejected the CORS preflight (OPTIONS 403, tested 2026-11-06T00:11:46Z), and whether a browser preflights a Range header cross-origin varies. A plain GET of a 16 KB file works everywhere.

### 3.5 Hosting and refresh

`.github/workflows/snodas.yml` (daily 16:35 UTC, 15 min timeout, no secrets) installs the pinned requirements, runs the decoder test, starts from the current `data` branch tree, runs `snodas.py --root out`, and force-pushes a single-commit `data` branch only when the meta changed, following the weather app (`alecbiles-code/weather` `.github/workflows/data.yml` at 914f4aa). Size: about 2.3 MB per day, two days kept. The app should read `https://raw.githubusercontent.com/<owner>/<repo>/data/data/snow/snodas.meta.json` when served from github.io (owner and repo derived from `location`, as `app.js` does in the weather app) and fall back to the committed `./data/snow/snodas.meta.json` (2026-11-05, stale and dated) locally or when the branch is missing. raw.githubusercontent.com sends `cache-control: max-age=300`. Any other workflow writing the `data` branch must share the concurrency group `data-branch` and start from the published tree.

A better zero-cost option exists but changes the contract: deploying Pages from a GitHub Actions artifact (site plus fresh data) would make the data same-origin and keep it out of git entirely. It requires switching Pages from "deploy from branch" to "GitHub Actions" and would make the daily job a deployment, so it is left to the lead.

### 3.6 Checks

1. Unit tests (synthetic tar): big-endian decode, scale and units, header validation, class boundaries, zero vs no data vs saturated, chunk sampling recipe, PNG transparency, Mercator row mapping. 6 passed.
2. Real data 2026-11-05: 486,000 cells, 74 no-data cells (scattered points on the plains, probably water bodies; not checked), 0 saturated, 351,383 zero depth, 134,543 with snow, max depth 1,373 mm, max SWE 377 mm.
3. Cross-check against SNOTEL daily values for 2026-11-04 (end-of-day reading 08:00 UTC Nov 5, two hours after the SNODAS snapshot), sampled with the browser recipe at 115 station locations: SWE agrees closely (Red Mountain Pass 183 vs 183 mm, Elwood Pass 180 vs 182, Brumley 58 vs 57), depth differs more (median SNODAS minus SNOTEL +37 mm; Beartown 787 vs 1,085). This confirms geolocation, byte order, scaling and the sampling recipe. It is not a validation: SNODAS assimilates SNOTEL, so the two are not independent.
4. Visual: the depth PNG shows the San Juans deepest, then the Elk, Sawatch and Park ranges, plains bare.
5. Online path: the local DNS resolver failed from about 00:29Z, so at 00:39Z `snodas.py` was run end to end with a scratch shim mapping `noaadata.apps.nsidc.org` to its public-DNS address: HEAD for 2026-11-06 returned 404, 2026-11-05 was downloaded and built (numeric chunks byte-identical to the committed ones, `publishedAt` 2026-11-05T14:00:25Z), and a second run logged "already current; nothing to do". A retention test with older dated directories removed all but the two newest and left a non-date directory alone. The committed product was built from the tar downloaded at 00:09:21Z (`--tar`), with that download's `retrievedAt` and `publishedAt` recorded in the meta.

### 3.7 Limitations

Modelled 1 km analysis, not a measurement; one value per cell (about 0.7 km east-west by 0.9 km north-south here); says nothing about wind loading, cornices, gullies or aspect; a sharp image must not suggest ski-line detail. Snapshot at 06:00 UTC, not updated during the day. Whole snowpack, not new snow or forecast snowfall. Saturated SWE flagged by NSIDC. Basic level of service, so late or missing days happen. Not an avalanche or stability product.

### 3.8 Other snow products considered

NOHRSC 24-hour snowfall analysis (new snow, 0.04 degree) is already used by the weather app and belongs to the conditions lane. Satellite snow cover (MODIS/VIIRS) shows presence, not depth, and is redundant with SNODAS depth for this use; not built.

## 4. SAR avalanche inventory

Inspected local archives at avalanche-inventory commit d69692a with `pipeline/sar/inspect_pmtiles.py`; the published copies are byte-identical in their first 6,503 bytes (header, root directory, metadata; fetched by curl, which sends no Accept-Encoding, so identity ranges as ARCHITECTURE 1.3 requires) and identical in size. Full facts in `data/sar/sar-inventory.meta.json`. Summary:

1. `all_seasons.pmtiles` (67,200,745 bytes), layer `avalanches`, PMTiles v3, gzip MVT, z5 to z14, 1,154 tiles, 506,224 polygons (all present at z14): 2021-2022 49,034 higher and 102,422 lower confidence; 2022-2023 59,726 and 125,328; 2023-2024 57,249 and 112,465. Fields: `event_id`, `season`, `confidence`, `Area_m2` (400 m2 to 3.98 km2), `centroid_lat`, `centroid_lon`, `type`.
2. `cross_season_hotspot.pmtiles` (73,770,573 bytes), layer `hotspots`, uncompressed MVT, z5 to z14, 1,114 tiles, 105,568 polygons (36,681 higher, 68,887 lower). Same fields without `season`. Tiles reach 5.4 MB at z9, so the layer needs a minzoom (12) on phones.
3. Bounds -106.4299, 39.4101 to -105.4695, 39.9499 inside the study box -106.43, 39.41, -105.34, 39.95 (`data/sar/coverage.geojson`).
4. Confidence is a hand-assigned class from the manual ArcGIS step (README rule: peak z above 6 = higher, 3 to 6 = lower; unconfirmed for v2), not a probability. Dates: season only (January 1 to April 30 scenes of the later year); no acquisition date. Hotspots are a thresholded mean z across three winters. Polygons split across tiles share `event_id` (59,220 seasonal and 13,267 hotspot polygons span more than one z14 tile); de-duplicate by `event_id`.
5. Range test (2026-11-06T00:20:42Z): `Range: bytes=0-126` and `bytes=3000000-3016383` on both URLs returned 206 with correct `Content-Range` (`bytes 0-126/67200745`, `bytes 0-126/73770573`), `access-control-allow-origin: *`, `cache-control: max-age=600`, `content-type: application/octet-stream`.
6. Limitations from the audit (2026-10-28) and update report (2026-11-05): unvalidated against observations; max-z over the winter stack; summer baseline; constant incidence angle, no layover, shadow or forest mask; manual, unreproducible threshold step; descending orbit only; very high polygon density suggests many false positives. The improved v3 detector exists in code but has not been run. Label everywhere: "Experimental SAR avalanche candidates".

## 5. Historical incidents

### 5.1 What exists (researched 2026-11-06 00:05 to 00:14 UTC; single page reads, no crawling)

1. CAIC Colorado accident table, `https://avalanche.state.co.us/accidents/colorado`: date, location name, level of involvement, severity, caught, caught-not-buried, caught-and-buried, injured, killed, description, link per report; URL filters (`?from=2024-10-01&to=2026-09-30&fatal=1` returned 4 fatal accidents). No coordinates, map or export. Coverage text conflicts (page: 1949-1950 onward; `/accidents/help`: 2019-2020 onward); records from 1951 are served.
2. CAIC report pages, `https://avalanche.state.co.us/reports/canonical/{uuid}`: status ("Preliminary Information" or "Final Report"), published date, narrative, coding, photos, and a map with "Lat: 39.468, Lon: -106.263" style coordinates (3 decimals, about 100 m). No page states what the point marks or its precision. A 1951 record shows migration artifacts (status "Preliminary Information", published Sep 14, 2026, caught 0 with 2 killed).
3. CAIC statistics, `https://avalanche.state.co.us/accidents/statistics-and-reporting`: fatality tables 1950-51 to 2025-26 and an Excel "full US avalanche accident dataset" (fatal accidents, AvyYear 1951 to 2025; columns AvyYear, YYYY, MM, DD, Date, Location, Setting, State, lat, lon, PrimaryActivity, TravelMode, Killed, Description). Colorado: 276 rows, 328 deaths; only 135 rows have non-zero coordinates, starting in 2000; missing coordinates are stored as 0.0. The sheet ends at 2024-25 while the page lists 2025-26.
4. CAIC historic fatalities, `https://avalanche.state.co.us/experimental-products/historic-accidents`: county choropleth 1861 to 2025, no points, no download.
5. CAIC Avalanche Explorer: observations map, not accidents; did not load headless, unverified.
6. avalanche.org accidents, `https://avalanche.org/avalanche-accidents/`: US fatal accidents from 2009-2010, loaded from CAIC's API, no coordinates found.
7. NOAA NCEI Storm Events Database records "Avalanche" events by forecast zone ("Cite dataset when used as a source."); whether rows carry coordinates and from which year is unverified. Zone-level, so not a point layer.
8. data.colorado.gov: no avalanche accident dataset (0 results).

### 5.2 Terms (verbatim)

1. CAIC, `https://avalanche.state.co.us/terms-use` (re-checked by curl 2026-11-06T00:15:37Z): "Use of computerized “robots” or “data mining” of the information and images presented here is prohibited." and "Some of the materials made available on this website are the intellectual property of CAIC and are protected by applicable law and may not be reproduced, in whole or in part, without the prior written permission of CAIC." Footer: "© 2026 Colorado Avalanche Information Center. All Rights Reserved." Non-commercial use is not addressed.
2. CAIC statistics page (re-checked 00:15:37Z): "The graphs below are drawn from the CAIC Accident Database and may be used for avalanche education and awareness." and "The full US avalanche accident dataset is available as an Excel file. Please cite the Colorado Avalanche Information Center when you use it." This asks for citation; it does not grant permission to republish locations, and the site terms reserve reproduction.
3. CAIC contact, `https://avalanche.state.co.us/contact`: "If you’d like to build an app, website, or service on CAIC’s data, use the Request for API Access form (opens in a new tab). We review each request and will contact you." Also a Request for Data form and caic@state.co.us.
4. avalanche.org API, `https://api.avalanche.org/` (re-checked 00:15:37Z): "Please contact avalanche.org / American Avalanche Associate for permission" (sic). No avalanche.org terms page exists (`/terms-of-use/`, `/terms/` return "Page not found").

### 5.3 Decision and unlock

No source clearly permits republishing incident records, so `data/incidents/incidents.geojson` is an empty, schema-valid collection and the app links to the official pages (`data/incidents/official-links.json`). Nothing was scraped and no coordinates were invented.

Unlock: written permission from CAIC, requested through the Request for API Access form or caic@state.co.us, to republish in this personal, non-commercial map the date, location name, latitude/longitude, activity and number killed from the CAIC US fatal accident spreadsheet, ideally with report UUIDs, report status and the meaning and precision of the coordinates. With that file: `pipeline/incidents/import_incidents.py caic.csv --profile caic_us_fatal_xlsx --source CAIC --authorization "<permission reference>"`. The importer keeps CAIC's 0.0 coordinates as unlocated records (no point), sets `position.meaning` to `unknown` because CAIC does not say what the point marks, keeps unreported counts as null, and rejects rather than repairs bad rows.

## 6. Contract notes for other lanes

1. Conditions lane: SNOTEL adapter per 2.3 and 2.4; SNODAS sampler per 3.4.
2. App core: SAR styling and minzoom per `sar-inventory.meta.json` `recommendedStyle`; SAR, incidents, modelled terrain and forecasts in separate layers, colours and legends; incidents layer shows official links when the dataset is empty.
3. Lead: data branch and raw.githubusercontent.com base URL (3.5) are not yet in `app/config.js`; the Pages-from-Actions alternative needs a contract decision.

## 7. Endpoint log

All times UTC, 2026-11-06. curl with `Origin: https://alecbiles-code.github.io` unless noted.

| Time | URL | Status | Relevant headers |
|---|---|---|---|
| 00:05:13 | AWDB `/stations?stateCds=CO&networkCds=SNTL&returnStationElements=true...` (all elements) | 400 | ACAO `*`, ACAH `*`; "exceeds the amount allowed" |
| 00:07:03 | AWDB `/data?...elements=SWINV&duration=HOURLY...` | 200 | ACAO `*`, `cache-control: max-age=0, private` |
| 00:07:31 | AWDB daily 30 d and hourly 7 d (2.4) | 200, 200 | ACAO `*`, ACAH `*` |
| 00:09:02 | AWDB OPTIONS preflight on `/data` | 200 | ACAO `*`, ACAH `*` |
| 00:09:02 | `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=335` | 200 | |
| 00:09:16 | `https://noaadata.apps.nsidc.org/NOAA/G02158/masked/2026/11_Nov/` | 200 | text/html listing, newest SNODAS_20261105.tar |
| 00:09:21 | `.../masked/2026/11_Nov/SNODAS_20261105.tar` (no Origin) | 200 | 8,263,680 bytes, Last-Modified Thu, 05 Nov 2026 14:00:25 GMT, Accept-Ranges bytes |
| 00:11:46 | `https://raw.githubusercontent.com/alecbiles-code/weather/data/grid.json` Range 0-3 | 206 | ACAO `*`, Content-Range `bytes 0-3/96594`, max-age=300 |
| 00:11:46 | same, OPTIONS preflight with `Access-Control-Request-Headers: range` | 403 | ACAO `*` |
| 00:15:37 | `https://avalanche.state.co.us/terms-use`, `/accidents/statistics-and-reporting`, `https://api.avalanche.org/` (no Origin) | 200 each | quotes in 5.2 |
| 00:20:42 | avalanche-inventory PMTiles range requests (4.5) | 206 x 4 | ACAO `*`, Content-Range as listed |
| 00:38:54 | Report Generator CSV for 335:CO:SNTL WTEQ value, qcFlag, qaFlag (via public-DNS address) | 200 | flag legend in 2.5 |
| 00:39:04 | NSIDC HEAD `.../2026/11_Nov/SNODAS_20261106.tar`, `SNODAS_20261105.tar` | 404, 200 | Content-Length 8263680, Last-Modified 14:00:25 GMT |
| 00:39:04 | AWDB `/data` all CO SNTL and SNTLT, 4 daily elements, 30 days | 200 | 978,457 bytes, 9.2 s, ACAO `*` |
