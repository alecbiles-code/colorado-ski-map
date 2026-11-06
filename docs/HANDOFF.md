# Handoff

Skintrack CO: a personal, static, zero-cost Colorado backcountry ski map for iPhone on GitHub Pages. Branch `fm/colorado-ski-map-build`. Nothing was pushed or deployed; deployment is the manual step in `README.md` section 3.

Status words: **implemented** (code exists and ran), **tested** (a named check passed, see `docs/VERIFICATION.md`), **browser-verified** (seen working in a real browser), **deployed** (none: nothing is deployed).

## 1. Architecture in one paragraph

Plain ES modules, no build step, MapLibre GL JS 5.24.0 and PMTiles 4.5.0 self-hosted in `vendor/`. One custom tile protocol (`skt://`) serves every tile from offline packages in IndexedDB first, then the network; multi-archive PMTiles sets (basemap cells, Tier 2 terrain cells) route by bounds and composite where regions meet. Heavy processing (GDAL, rasterio, Flow-Py) lives in `pipeline/` and produces static products with `*.meta.json` provenance files indexed by `data/manifest.json`. Live data (NWS, Open-Meteo, NRCS SNOTEL) is fetched by the browser with per-provider timeouts, retries, last-good copies and explicit failure states. Contract: `docs/ARCHITECTURE.md`.

## 2. What works now

| Capability (spec section 1) | State | Coverage |
|---|---|---|
| Mobile map: basemap, search, location, layers, sheets, share link | Implemented, tested in node; first render browser-verified | Statewide |
| Slope, aspect, elevation, contours, hillshade | Implemented and tested (GDAL agreement 0.003 degrees; tap values exact) | Tier 2 analytical slope shading in 14 mountain cells, exact tap values in n40w106 and n40w107; Tier 1 browser-computed statewide |
| Potential release areas and runout | Implemented, run and checked; experimental and unvalidated | Berthoud / Jones / Loveland pilot |
| Ski lines, approaches, trailheads, huts, peaks | Implemented and tested | Statewide; ski-specific lines sparse (53) |
| CAIC forecast | Official location-aware link implemented and live-tested; in-app ratings built but off pending permission | Statewide link |
| Weather (NWS, Open-Meteo) | Implemented and live-tested from node | Statewide |
| Historical accidents | Schema, importer and official links; no data (permission) | None |
| SAR avalanche inventory | Implemented against the published archives (range requests tested) | Front Range study box |
| SNOTEL stations and charts | Implemented and live-tested from node | 122 Colorado stations |
| SNODAS snow depth and SWE | Implemented; snapshot 2026-11-05; daily workflow written, not run | Statewide, 1 km |
| Saved places, GPX/GeoJSON import and export | Implemented, parsing and validation tested in node | Device only |
| Offline areas and service worker | Implemented, planning and estimates tested in node; download and offline reload not browser-tested | Selected areas |
| Aerial imagery | Implemented, style-validated | Statewide, online only |

The honest summary: data products and pipelines are tested hard; the app's code is reviewed and unit-tested but has been seen in a real browser only for its first render, because no browser could start on the build machine after 00:40Z (section 5).

## 3. Needs permission (implemented fallback in brackets)

1. CAIC danger colors and forecast detail in the app: written permission from avalanche.org / the American Avalanche Association and from CAIC. [Official CAIC deep link for every point; adapters behind `providers.caic.enabled` and `providers.caic.product.enabled` in `app/config.js`.] [ALEC TO CONFIRM: whether to request permission, or to enable the map-layer adapter on the reading that the NAC public API guide's display rules imply permission for third-party display.]
2. Historical accidents: written permission from CAIC to republish its accident records. [Official accident links; `pipeline/incidents/import_incidents.py` with a profile for CAIC's fatal-accident spreadsheet.]
3. COTREX winter trails: written permission from Colorado Parks and Wildlife. [USFS and OSM winter trails.]
4. Guidebook lines (Beacon and others): a publisher licence. [Link only; nothing reconstructed.]
5. Model validation data: reuse terms for CAIC's regional runout layer or CDOT's avalanche path atlas. [Model labeled experimental and unvalidated.]

## 4. Needs processing or a decision

1. Run the browser smoke pass from a fresh terminal (`docs/VERIFICATION.md` section 6), then the iPhone checklist (section 7) after deploying. Fix whatever they find before relying on the app in the field.
2. Enable the SNODAS workflow after the first push (`README.md` section 3 step 5).
3. Tier 2 exact tap values exist only for n40w106 and n40w107 (about 60 MB per cell); all 14 cells would push the site past 1 GB. More cells can be added one at a time (`pipeline/terrain/README.md`), within budget.
4. The avalanche model covers only the pilot. Extending it is mostly compute (about 56 CPU-hours per parameter set statewide) but should wait for Colorado calibration data.
5. [ALEC TO CONFIRM: the v2 thresholds behind the SAR confidence classes (z 3.0 vs 2.5, slope 20-70 vs 25-60), carried from the inventory's own audit.]
6. The peaks and passes layer is on by default because the basemap carries few peak names in the mountains; it costs about 230 KB (gzipped) at startup.

## 5. Build environment incidents

1. About 00:30Z on 2026-11-06 the build machine's DNS resolver lost its configuration and stayed down. Network work continued through a DNS-over-HTTPS shim kept outside the repository; the repository contains no DNS workaround.
2. About 00:40Z every browser launch from the agent session started failing (launchd bootstrap error 141 after the console login restarted at 17:26 local). Screenshots: only the first-render screenshot from 00:15Z exists (`docs/screenshots/01-first-map-390x844.png`). The rest of the spec's screenshot set is owed and is produced by the smoke script in one command.

## 6. Where things are

1. Requirements traceability: `docs/PROGRESS.md` (plan and log), `docs/lanes/*.md` (each lane's findings and decisions).
2. Sources: `docs/SOURCES.md` (decisions), `docs/sources/conditions.md` and `docs/sources/map-routes.md` (tested endpoints and quoted terms).
3. Methods: `docs/METHODS.md` (plain language), `docs/methods/*.md` (technical).
4. Coverage: `docs/COVERAGE.md`, `docs/coverage-routes.md`. Verification: `docs/VERIFICATION.md`.
5. Commands: `README.md` (run, test, deploy, refresh data).
