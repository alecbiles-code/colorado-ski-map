# Plan and progress notes

## 1. Implementation plan (2026-11-05)

1. Audit: weather app at commit `914f4aa` (firstmate/projects/weather), avalanche-inventory at `d69692a` (firstmate/projects/avalanche-inventory) plus the audit-updated copy in `~/avy/avalanche-site-update-2026-11-05`. Reuse: weather `core.js` time and accumulation discipline, NRCS AWDB access pattern, per-source failure isolation; inventory PMTiles archives and its honest SAR framing.
2. Lanes run in parallel against `docs/ARCHITECTURE.md`:
   1. Sources A (conditions): CAIC and avalanche.org permissions, CAIC zone geometry and deep links, accident records, NWS, Open-Meteo, NRCS AWDB, SNODAS, NOHRSC, iOS storage.
   2. Sources B (map and routes): basemap, terrain sources, imagery, OSM and OpenSkiData, COTREX, USFS, CPW, huts, Beacon, land status, canopy, GitHub Pages limits.
   3. Terrain pipeline: 3DEP pilot, slope and aspect, synthetic tests, independent check, display and numeric tiles, Tier 1 vs Tier 2 comparison, statewide cost estimate.
   4. Avalanche terrain model: PRA and Flow-Py runout pilot on the shared grid.
   5. Routes and places: OSM and OpenSkiData extraction, feature classes, search index, coverage by region.
   6. Snow and observations: SNOTEL station snapshot, SNODAS Colorado product and refresh job, SAR inventory audit and integration metadata, incident data contract and import path.
   7. App core: shell, map, layers, inspector, search, saved routes, offline packages, service worker.
   8. Conditions providers: NWS, Open-Meteo, SNOTEL, CAIC adapters and the conditions view.
3. Lead integrates products into `data/manifest.json`, runs browser verification at iPhone sizes, writes the verification report, coverage report, sources and methods, README and handoff.

## 2. Progress log

1. 2026-11-05: branch created, plan and architecture contract written, lanes launched.
2. 2026-11-05 to 06: sources (2 matrices), basemap (23 Protomaps cells), routes and places, snow / SNOTEL / SAR / incidents, conditions providers, app core landed. Contract amended: Tier 1 DEM switched from AWS Terrain Tiles (2017 pre-lidar render) to Mapterhorn; aspect to true north; ski_area and land_manager classes.
3. 2026-11-06 about 00:30Z: build machine DNS resolver lost its configuration; work continued through a DNS-over-HTTPS shim outside the repo. About 00:40Z: browsers could no longer launch from the agent session (launchd bootstrap error 141); browser verification after the first render is owed (docs/VERIFICATION.md).
4. App review found and fixed 19 defects without a browser. Terrain lane found a 4 m grid-snap shift in the pilot DEM; fixed, and the avalanche pilot was rerun on the corrected DEM (headline numbers moved under 0.5 percent).
5. Statewide Tier 2 slope display for 14 mountain cells (154 MB) and exact tap values for n40w106 and n40w107; app made multi-region (composited seams, per-region routing). Docs: README, SOURCES, METHODS, COVERAGE, VERIFICATION, HANDOFF.
