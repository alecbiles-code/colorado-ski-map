# Verification report

Built and checked 2026-11-05 to 2026-11-06 (UTC). This report separates what passed, what failed, and what was not tested. "Passed" always names the check that ran. Nothing here is a scientific validation of the terrain or avalanche model: a successful run or a matching render is not evidence that a model is right about avalanches.

## 1. Environment

1. macOS 26.5.1 (arm64), Node 26.7.0, Python 3.12 virtual environments (uv), GDAL 3.12 inside the terrain venv.
2. Real-browser checks were possible only until about 00:40Z on 2026-11-06 (headless Chrome 156 at 390x844 with touch emulation). After that, every browser launch from this machine's agent session aborted (Chrome, chrome-headless-shell 157 and Playwright WebKit all fail with `bootstrap_check_in ... unknown error code (141)`): the session's launchd bootstrap became stale when the console login restarted at 17:26 local. A fresh terminal session should not have this problem.
3. From about 00:30Z the system DNS resolver also had no configuration (`scutil --dns`: "No DNS configuration available"). Live network checks after that used a DNS-over-HTTPS shim kept outside the repository (it changes no system setting; TLS still verifies real hostnames).
4. No real iPhone was available. Viewport emulation is not a device test.

## 2. Passed

| Area | Check | Result |
|---|---|---|
| App logic | `node --test tests/*.test.mjs` (units, time and DST, providers with recorded fixtures, terrain math, tile enumeration, offline size estimates, GPX/GeoJSON parsing limits and escaping, share-link hash, Tier 2 region routing) | 80 of 80 |
| App structure | `node tools/check-imports.mjs` | every import in 43 files resolves to a real export |
| Map style | Full style with every overlay validated against the MapLibre style spec (app-core lane, then review lane); imagery source and layer validated separately | valid |
| App review | Line-by-line review for runtime defects without a browser | 19 defects found and fixed (docs/lanes/app-review.md) |
| First render (real browser, 00:15Z) | Page under `/colorado-ski-map/` from the Range-capable dev server, 23-archive basemap through the single tile protocol, hillshade, contours, bottom navigation, search bar and map controls at 390x844 | rendered; the two console 404s seen then (manifest, conditions.css) were missing files that exist now |
| Slope and aspect math | pytest synthetic planes (25, 30, 35, 45 degrees, all aspects), cone, NoData holes, class boundaries (30.0 lands in 30-35); same cases in node | 100 passed; 15 node tests |
| Slope vs an independent GIS tool | GDAL `gdaldem` (Horn) over every analysis cell, per region | max difference 0.003 degrees (pilot, n40w106, n40w107 and each statewide cell; see docs/methods/terrain.md) |
| Tap values equal the analysis rasters | Numeric tiles decoded through pmtiles 4.5.0 and `terrain-math.js` at random points | pilot 1,004 of 1,004; n40w107 1,004 of 1,004; n40w106 304 of 304; avalanche model 500 of 500 |
| Display tiles equal the analysis classes | Sampled display pixels vs analysis cells; pixels just outside each cell empty | 200 of 200 and 40 of 40 per cell |
| Seams | Overlapping regions compared cell by cell | identical (one 0.1 m rounding-boundary cell of 12.5 million between pilot and n40w106) |
| Tier 1 vs Tier 2 | Mapterhorn z13 browser slope vs 3DEP 10 m on slopes above 25 degrees, 4.35 million cells | same class 78.2 percent, within one class 99.4 percent, MAE 1.22 degrees; AWS fallback 36.4 percent |
| Release and runout alignment | All 29 model rasters on the shared 10 m grid; fast vs slow Flow-Py engine; tile-seam test (fails at 500 m overlap, passes at 1 km) | passed; 10 pytest tests |
| Routes, places, regions | pytest: tag rules, region landmarks, elevation decode, aspect on synthetic slopes, schema validation, unique ids, 25 MB limit | 46 of 46 |
| Snow, SNOTEL, incidents | pytest: SNODAS decode and scaling, NoData vs zero, station snapshot, incident schema and importer refusal without authorization | 25 of 25 |
| Basemap archives | `pmtiles verify` on all 23 archives | all valid; largest 22.0 MB |
| Units and times | SI internally, imperial default; missing renders n/a; America/Denver display across the 2026-11-01 DST change; SNOTEL fixed UTC-8 clock | covered by node tests |
| Live providers (00:50Z) | NWS points, grid data, hourly, alerts; Open-Meteo; NRCS AWDB daily and hourly; avalanche.org map layer (read for verification only; ships off) | all returned data; `Access-Control-Allow-Origin: *` on each (curl with the github.io origin) |
| Missing or expired forecast | Provider tests and a jsdom render: expired, unavailable, outside coverage, no product, zone overlap, all providers down | never rendered as a rating; official link always first |
| PMTiles on GitHub Pages | Range request to the existing `avalanche-inventory/all_seasons.pmtiles` | 206, correct Content-Range, no Content-Encoding, ACAO `*` |
| GeoJSON on GitHub Pages | `.geojson` served by GitHub Pages (maplibre.org docs assets) | `application/geo+json`, gzip-encoded |
| Dev server | Range 206 and path-traversal guard in `tools/serve.mjs` | passed |

## 3. Failed or known defects open

1. iOS 16.0 to 16.3 lack `DecompressionStream`, which the Tier 2 numeric decoder uses; on those versions tap values inside Tier 2 regions fall back to Tier 1 and model values show unavailable. iOS 16.4 and later are unaffected.
2. The bottom-sheet handle and the coordinate chip are under 44 px tall (left as designed).
3. No other failure is known, which is not the same as none existing: most interactive behavior is untested in a browser (section 4).

## 4. Not tested

1. Everything interactive in a real browser after the first render: Mapterhorn hillshade, contours and 3D; slope and aspect shading and the Tier 2 composited source; the tap inspector; sheets and layer panel; search; geolocation states; Explore cards; Saved import and export; offline download, cancel, resume and reload with the network blocked; service-worker install, update and offline cold start; Sources and Methods; the units switch; the 1280x900 layout; the imagery layer.
2. Anything on a real iPhone: Safari layout at 375 to 430 px, safe areas, rotation, home-screen install, WebP decode through canvas, touch drag on sheets, file import from Files, storage quota and eviction, background behavior.
3. Performance: time to usable map, interaction responsiveness and memory were not measured. Static budgets are in section 5.
4. Deployment on github.io: not deployed (manual step). Non-interference with `/weather/` and `/avalanche-inventory/` rests on construction (relative paths, service-worker scope `./`, cache and IndexedDB names prefixed `skintrack-`, no deletion of foreign caches), not on a test on the live origin.
5. Provider failure modes not reproduced live: NWS and Open-Meteo 5xx and rate-limit responses; CAIC link for a point outside every forecast area.
6. Model validity: the release-area and runout model has no Colorado validation (docs/methods/avalanche-model.md section 9).

## 5. Budgets (measured file sizes; transfer is estimated)

1. App shell: MapLibre 275 KB gzipped, its CSS 10 KB, PMTiles 8 KB, maplibre-contour 11 KB, app modules about 98 KB if all load, app CSS about 6 KB, `index.html` 2 KB.
2. Default data at first view: manifest 1.6 KB, basemap meta 1.1 KB, peaks and passes layer 230 KB gzipped (GitHub Pages gzips GeoJSON), a few glyph ranges, about 10 to 30 basemap tiles, and about 6 to 12 Mapterhorn 512 px DEM tiles at 83 to 145 KB each (the largest share). Estimated first-view transfer: about 1.5 to 2.5 MB. Not measured in a browser.
3. Large optional layers load only when switched on (slope and aspect compute from the same DEM tiles; Tier 2 tiles, SAR, model, SNODAS are separate).
4. Published site: about 570 MB of the 1 GB GitHub Pages limit; largest file 22.0 MB.

## 6. Run the browser pass (one command, from a fresh terminal)

```sh
node tools/serve.mjs 8790 &
node tests/harness/smoke.mjs http://localhost:8790/colorado-ski-map/ /tmp/skintrack-shots --modules <dir with node_modules/puppeteer-core> --chrome <chrome or chrome-headless-shell>
```

It writes screenshots and `report.json` covering 390x844 touch and 1280x900: load, overflow, layers, slope, inspector, Conditions, Explore, search, overlays, GPX import, Sources and Methods, and an offline download followed by a reload with the network blocked.

## 7. iPhone checklist (after deploying)

1. Open `https://<user>.github.io/colorado-ski-map/` in Safari; the map appears within a few seconds with hillshade and contours; no sideways scrolling in portrait or landscape; controls clear the notch and home indicator.
2. Search "Berthoud Pass", select it, open Conditions: the CAIC link opens the forecast for that spot; NWS and Open-Meteo show times in Mountain time; nearby SNOTEL stations list distance and elevation difference.
3. Turn on Slope angle at Berthoud Pass: shading appears; tap a slope: elevation, slope, aspect and "Tier 2" appear; tap a point outside the processed regions (for example the eastern plains): the values say Tier 1.
4. Turn on Potential release areas and Modeled runout near Loveland Pass: the "Experimental terrain model" label shows; the dashed truncation band is visible near the pilot edge.
5. Turn on SAR candidates near Loveland Pass at zoom 12 or more: the "Experimental SAR avalanche candidates" label shows; outside the study box the map says no data.
6. Import a GPX file from Files; it appears on the map and in Saved; export it back.
7. Share > Add to Home Screen; open it from the home screen; download the current view as an offline area; turn on Airplane Mode; force-quit and reopen: the downloaded area renders with slope and contours, and areas outside it say they are not downloaded.
8. Deny location permission once, then allow it: both states read clearly; the location readout shows accuracy and age, and switches to "Last known location" (dimmed dot) after 60 s without a fix.
