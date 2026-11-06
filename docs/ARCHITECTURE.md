# Architecture contract

Working name: **Skintrack CO** (personal, non-commercial Colorado backcountry ski map). Every lane builds to this contract. Change it only through the lead (the integrating agent), and record the change in `docs/PROGRESS.md`.

## 1. Hosting shape

1. Static site served by GitHub Pages from the repository root at the subpath `/colorado-ski-map/`. No backend, no build step for the app, no keys, no paid services. `.nojekyll` at the root.
2. All app URLs are relative (`./app/main.js`, `./data/...`). Nothing may assume the site is at `/`. Service worker scope is `/colorado-ski-map/` only (registered as `./sw.js`); cache and IndexedDB names are prefixed `skintrack-` so they never touch the captain's other apps on the same origin (`/weather/`, `/avalanche-inventory/`).
3. File size: every committed file must be at most 25 MB (GitHub web-upload limit; hard git limit is 100 MB). Larger tile sets are split by region into several PMTiles archives. The whole published site must stay under 1 GB. GitHub Pages returns wrong bytes for a Range request that accepts gzip; browsers send `Accept-Encoding: identity` with ranges, and every script that range-reads a published archive must do the same.
4. Heavy compute (GDAL/rasterio/numpy/Flow-Py) lives in `pipeline/` and runs offline on a workstation or in a bounded GitHub Action. The browser only reads finished static products.

## 2. Repository layout

```
index.html  manifest.webmanifest  sw.js  .nojekyll
app/          ES modules, no framework, no bundler
  main.js       boot, routing between views, state
  config.js     every external URL and provider switch (single source of truth)
  map/          MapLibre setup, style, layer registry, tile protocol
  layers/       one module per layer group (terrain, avalanche-model, forecast, history, routes, weather, snow)
  providers/    pure adapters: nws.js, openmeteo.js, snotel.js, caic.js (+ tests); return normalized objects
  ui/           sheets, inspector, search, saved, legends, settings, sources-and-methods
  offline/      package planner, downloader, IndexedDB store
  lib/          pure helpers (units, time, geo, terrain-math.js, escape, validate)
vendor/       self-hosted maplibre-gl 5.24.0 (UMD), pmtiles 4.5.0, maplibre-contour; each with its LICENSE
assets/       icons, fonts/glyphs (PBF), sprite
data/         static products, each with a sibling *.meta.json (schema: schemas/product-meta.schema.json)
  manifest.json   index of every product (id, title, url, meta url, bytes, bbox)
  terrain/  avalanche/  routes/  places/  snow/  incidents/  coverage/
pipeline/     python + node preprocessing; README per subfolder; requirements pinned
schemas/      JSON Schemas for products, routes, destinations, incidents, stations, forecasts, model runs
tests/        node --test (app/lib, app/providers) and pytest (pipeline)
docs/         ARCHITECTURE, PROGRESS, SOURCES (decision matrix), COVERAGE, METHODS, VERIFICATION, HANDOFF, screenshots/
.github/workflows/  bounded data refresh jobs
```

## 3. Map stack

1. MapLibre GL JS 5.24.0 UMD, self-hosted in `vendor/` (same pin the captain's other apps use; self-hosting makes offline work and removes the CDN dependency). PMTiles JS 4.5.0. maplibre-contour for client-side contours.
2. Basemap: self-hosted Protomaps basemap extract for Colorado (ODbL OpenStreetMap data), PMTiles, split if needed to respect the 25 MB rule. Style is our own topo style in `app/map/style.js`. Glyphs and sprite self-hosted.
3. Terrain, two tiers, kept explicitly separate:
   1. Tier 1, statewide, visual and approximate: Mapterhorn terrain tiles (Terrarium-encoded WebP, 512 px, keyless; USGS 3DEP 1 m and 1/3 arc-second plus Copernicus GLO-30; attribution "© Mapterhorn"). Online from `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`; offline packages read the same tiles for the selected area only from Mapterhorn's documented limited-area download archives (`download.mapterhorn.com/planet.pmtiles` for z0-12, per-z6 archives such as `6-13-24.pmtiles` for z13+). Fallback provider: AWS Terrain Tiles (Terrarium PNG, 256 px), which over the pilot are a November 2017 pre-lidar render with 5.6 to 8.5 m RMSE against current 3DEP versus 1.4 to 1.9 m for Mapterhorn (docs/sources/map-routes.md section 5.5). Used for hillshade, 3D, contours (maplibre-contour), and an in-browser slope/aspect computation on the Web Mercator grid with exact per-latitude pixel size, at z13 (about 7.3 m pixels at 39.8 N). Labeled as computed in the browser, naming the DEM provider actually used.
   2. Tier 2, analytical: `pipeline/terrain` reads current USGS 3DEP 1/3 arc-second COGs, reprojects to the analysis grid, computes slope (degrees, Horn) and aspect (degrees clockwise from TRUE north, 0 = north, flat = -1; computed on the UTM grid, then corrected by the meridian convergence at the cell, which is 0.4 to 0.65 degrees in the pilot and up to about 2.7 degrees in western Colorado; Tier 1 Web Mercator grid north is already true north), writes display PMTiles (classified, nearest-neighbour) and numeric inspection products. Where Tier 2 exists the inspector reports Tier 2 numbers and says so.
   3. Slope classes (degrees, lower bound inclusive): `<25`, `25-30`, `30-35`, `35-40`, `40-45`, `>=45`. Example: 30.0 is in `30-35`. Bands describe steepness only.
4. Pilot analysis grid (shared by terrain and avalanche-model lanes so outputs co-register exactly): CRS EPSG:26913 (NAD83 / UTM 13N), 10 m cells, bounds xmin 414110, ymin 4381320, xmax 447020, ymax 4419360 (3291 x 3804 cells). Geographic pilot box: lon -106.00 to -105.62, lat 39.58 to 39.92 (Berthoud Pass, Jones Pass, Loveland Pass, Mount Sniktau area). Vertical datum NAVD88, metres.

## 4. Data contracts

1. Coordinates are GeoJSON order `[lon, lat]` everywhere, WGS84 for anything the browser reads.
2. Canonical internal units are SI: metres, m/s, millimetres of water, centimetres of snow depth, degrees Celsius, degrees for angles. Display defaults to feet, miles, inches, Fahrenheit, mph, with a metric switch. Conversion happens only in `app/lib/units.js`.
3. Time: ISO 8601 strings with an explicit offset or `Z`. Time-sensitive objects keep `issuedAt`, `validFrom`, `validTo`, `observedAt`, `retrievedAt`, `processedAt` separately. Display in `America/Denver`.
4. Unknown is explicit: `null` means missing; outside-coverage, failed-load, expired and zero are distinct states and render differently. Never coerce missing to 0.
5. Every product has `*.meta.json` (provenance: sources with license and attribution, processing script and parameters, processedAt, coverage bbox and polygon, CRS, resolution, units, limitations, byte size). Features keep `id` (stable internal), `upstreamId`, `source`, `sourceUrl`; derived fields are prefixed `dem` (for example `demGainM`).
6. Feature classes stay distinct: `ski_descent`, `ascent_skin`, `approach`, `touring_area`, `peak`, `pass`, `trailhead`, `parking`, `hut`, `user_route`, plus `ski_area` (lift-served resort context, never backcountry) and `land_manager` (surface manager only, not current access or legal parking). Experimental SAR candidates, observed incidents, modeled terrain and official forecasts never share a layer, color family or legend.
7. User data (saved places, notes, imported routes, offline packages) stays in this browser (IndexedDB `skintrack-*`). Nothing personal is sent anywhere or committed.

## 5. Provider rules

1. A provider is used from the browser only if its terms permit it and a real browser request from a GitHub Pages origin works (CORS). Otherwise a bounded pipeline job makes a static snapshot, or the app shows an official link.
2. Each provider has its own loading, timeout (15 s default), bounded retries, failure state and last-good copy with its age. One dead provider never blanks the app. A failed or expired avalanche product is never shown as a rating.
3. Permission-dependent integrations sit behind a switch in `app/config.js`, with an official-link fallback that always works.
