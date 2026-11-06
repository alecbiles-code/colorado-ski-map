# Skintrack CO

A personal Colorado backcountry ski-touring map for iPhone, built as a static web app for GitHub Pages. No backend, no accounts, no API keys, no recurring cost. Personal, non-commercial, and not affiliated with BCI or any organization whose data it links to.

It shows slope-angle shading, aspect, contours and hillshade; an experimental avalanche release-area and runout model for the Berthoud / Jones / Loveland Pass pilot; the official CAIC forecast for any point; NWS and Open-Meteo weather; nearby SNOTEL stations with charts; SNODAS snow depth and SWE; the experimental Sentinel-1 SAR avalanche-candidate inventory; ski-touring routes, peaks, passes, trailheads and huts from open data; saved places and GPX/GeoJSON import and export; and offline map packages.

What actually works, what was tested and how, and what is limited: `docs/HANDOFF.md` and `docs/VERIFICATION.md`. Nothing in this app is a safety rating or a go/no-go recommendation.

## 1. Run locally

Requires Node 18 or newer. ES modules and PMTiles need HTTP with Range support, so `python -m http.server` will not do.

```sh
node tools/serve.mjs 8790
# open http://localhost:8790/colorado-ski-map/
```

The server mirrors the GitHub Pages subpath `/colorado-ski-map/` and answers Range requests with 206.

## 2. Tests

```sh
node --test tests/*.test.mjs          # app logic, providers, terrain math (no network)
node tools/check-imports.mjs          # every import in app/ resolves
```

Pipeline tests run per pipeline in a Python 3.12 venv; each `pipeline/<name>/README.md` gives the exact commands. Browser smoke test with screenshots (needs `puppeteer-core` and a Chrome or chrome-headless-shell binary):

```sh
node tests/harness/smoke.mjs http://localhost:8790/colorado-ski-map/ <outDir> --modules <dir containing node_modules/puppeteer-core> --chrome <path to chrome>
```

## 3. Deploy to GitHub Pages (manual)

The app expects to live at `https://<user>.github.io/colorado-ski-map/`, next to the existing `/weather/` and `/avalanche-inventory/` sites on the same origin. It only uses its own path, its own service-worker scope, and cache and storage names prefixed `skintrack-`, so it does not interfere with them.

1. On GitHub, create a new public repository named `colorado-ski-map` under your personal account (Pages is free for public repositories). Do not add a README or license there.
2. Push this folder with git (the web uploader takes 100 files and 25 MB per file at a time; this project has about 440 files and its largest file is about 22 MB, so the command line is much easier):
   ```sh
   git init -b main          # skip if the folder already is a git repository
   git add -A && git commit -m "Initial deploy"
   git remote add origin https://github.com/<user>/colorado-ski-map.git
   git push -u origin main
   ```
3. Repository Settings > Pages > Build and deployment > Source: "Deploy from a branch", branch `main`, folder `/ (root)`. Save. The first build takes a minute or two.
4. Open `https://<user>.github.io/colorado-ski-map/`. On the iPhone, Share > Add to Home Screen installs it as an app.
5. Optional, for the daily SNODAS snow layer: Settings > Actions > General > Workflow permissions: "Read and write permissions". Then Actions > "Refresh SNODAS snow product" > Enable workflow (and "Run workflow" once). It publishes to a separate `data` branch that is rebuilt as one commit each run, so history does not grow. Without it, the app shows the committed snapshot with its date and an "old" warning.
6. Check after deploying (from any terminal):
   ```sh
   curl -sI -H 'Range: bytes=0-16383' -H 'Accept-Encoding: identity' https://<user>.github.io/colorado-ski-map/data/basemap/co-z0-10.pmtiles
   ```
   Expect `HTTP/2 206` and a `content-range` header. Then work through the device checklist in `docs/VERIFICATION.md` section 4 on the iPhone.

Size: the published site is about 570 MB of the 1 GB GitHub Pages limit (basemap about 267 MB, terrain about 286 MB). Each data refresh that rewrites large archives adds to the repository's git history; refresh the basemap rarely.

## 4. Updating data

Each product has a `*.meta.json` beside it with its sources, dates, parameters and limitations. After changing any product run `node tools/gen-manifest.mjs` to rebuild `data/manifest.json`.

1. Basemap (OpenStreetMap via Protomaps, yearly or as needed): set `source` and `build_date` in `pipeline/basemap/config.yaml` to a current build from `https://build-metadata.protomaps.dev/builds.json`, download the `pmtiles` CLI from github.com/protomaps/go-pmtiles releases, set `pmtiles_bin` and `work_dir`, then run `uv run --with pyyaml python pipeline/basemap/extract_basemap.py --force`.
2. Terrain (slope, aspect, numeric inspection from USGS 3DEP): `pipeline/terrain/README.md`. Regions are configured as cells in its `config.yaml`.
3. Avalanche terrain model (PRA and runout): `pipeline/avalanche/README.md`.
4. Routes, places, search, regions, land manager: `pipeline/routes/README.md`.
5. SNOTEL station list (NRCS AWDB): `pipeline/snow/README.md`. SNODAS runs daily in GitHub Actions (step 3.5 above) or by hand with the same script.
6. SAR inventory metadata: `pipeline/sar/README.md`. The archives themselves are read from the avalanche-inventory site; `app/config.js` holds that base URL.
7. Incidents: `pipeline/incidents/README.md`. The layer ships empty because CAIC's terms require written permission to reproduce its accident records; the importer accepts an authorized file.

## 5. Settings in `app/config.js`

Every external URL and provider switch is there. `providers.caic.enabled` (avalanche.org map-layer danger colors) and `providers.caic.product.enabled` (full forecast detail) are off: avalanche.org's API page asks users to contact it for permission, and CAIC's terms require written permission to reproduce its content. The official CAIC forecast link for the selected point works either way. See `docs/sources/conditions.md` before turning either on.

## 6. Layout

`index.html`, `sw.js`, `manifest.webmanifest`: the app shell. `app/`: ES modules (map, layers, providers, ui, offline, lib). `vendor/`: MapLibre GL JS 5.24.0, PMTiles 4.5.0, maplibre-contour 0.1.1 with licenses. `assets/`: icons, glyphs, sprite. `data/`: static products, each with a meta file. `pipeline/`: offline preprocessing. `schemas/`: JSON Schemas. `tests/`: node and harness tests. `tools/`: dev server and maintenance scripts. `docs/`: architecture, sources, methods, coverage, verification, handoff.

## 7. Credits

Map data © OpenStreetMap contributors (ODbL) via Protomaps. Terrain © Mapterhorn (USGS 3DEP, Copernicus GLO-30) and USGS 3DEP (public domain). Weather: NOAA National Weather Service and Open-Meteo (CC BY 4.0). Snow: NRCS SNOTEL and NOAA NOHRSC SNODAS via NSIDC. Canopy: USFS / MRLC NLCD Tree Canopy Cover. Land manager: BLM Surface Management Agency. Names: USGS GNIS. Avalanche forecasts: links to the Colorado Avalanche Information Center. Full attribution and terms: `docs/sources/`.
