# Source decision matrix (summary)

This is the one-page decision view. The evidence (exact URLs tested, UTC times, HTTP status, CORS and range headers, and the quoted terms text each decision relies on) is in the two detailed matrices:

1. `docs/sources/conditions.md`: CAIC and avalanche.org, NWS, Open-Meteo, NRCS AWDB, SNODAS, NOHRSC, iOS storage. Tested 2026-11-06 00:02 to 00:23 UTC.
2. `docs/sources/map-routes.md`: basemap, terrain, imagery, hosting limits, routes and access, names, land status, canopy. Tested 2026-11-06 00:03 to 00:35 UTC.
3. Incident and SAR inventory sources: `docs/methods/snow-sar-incidents.md`. Routes source terms as relied on: `docs/lanes/routes.md`.

Status words: **used** (in the app now), **link only** (the app links to it, reproduces nothing), **off, permission needed** (adapter built and switched off), **rejected**. "Tested" always means a real request was sent; it never means permission.

## 1. Decisions

| Need | Source | How the app uses it | Terms basis (short) | Status |
|---|---|---|---|---|
| Basemap | OpenStreetMap via Protomaps daily build 2026-11-04 | 23 self-hosted PMTiles extracts, z0-14 | ODbL, attribution | Used |
| Basemap (alternative) | OpenFreeMap | Not used | Offline download needs an app-specific User-Agent a browser cannot send | Rejected |
| Basemap (alternative) | Standard OSM tiles | Not used | OSM tile policy forbids offline prefetch | Rejected |
| Optional imagery | USGS USGSImageryOnly | Optional layer, online only, not in offline packages | Public domain, "no restrictions", max z16 | Used (off by default) |
| Visual terrain (hillshade, 3D, contours, in-browser slope) | Mapterhorn terrain tiles | Live tiles online; offline packages read the selected area from Mapterhorn's documented limited-area download archives | Data public domain (USGS) and Copernicus open licence; "© Mapterhorn" | Used. No stated policy for the tile endpoint itself; limited-area extracts are documented |
| Visual terrain fallback | AWS Terrain Tiles | Config switch only | Open data | Used as fallback. Over the pilot it is a 2017 pre-lidar render, 5.6 to 8.5 m RMSE vs current 3DEP |
| Analytical terrain | USGS 3DEP 1/3 arc-second COGs | `pipeline/terrain`, Tier 2 pilot and regional cells | Public domain, credit requested | Used |
| Canopy for the release model | USFS / MRLC NLCD Tree Canopy Cover 2025 (percent) | `pipeline/avalanche` input | Public domain | Used |
| Runout model software | AvaFrame com4FlowPy (`avaframe==2.2b1`) | `pipeline/avalanche` | EUPL-1.2 software | Used (pre-release pin; stable 2.1 works about 4x slower) |
| Ski-touring routes, peaks, passes, trailheads, huts | OSM (Geofabrik Colorado, data to 2026-11-03) | `pipeline/routes` GeoJSON | ODbL | Used |
| Winter-use trails | USFS EDW TrailNFS_Publish (snowshoe or cross-country ski use recorded) | `pipeline/routes` approaches | Public domain | Used |
| Names cross-check | USGS GNIS Domestic Names (2026-11-02) | Peaks and passes OSM lacks | Public domain | Used |
| Ski areas | OpenSkiData export (downloaded once) | Resort context, kept apart from backcountry | ODbL plus source attributions | Used; its hosted vector tiles are not used |
| Winter-use trails | COTREX (trails.colorado.gov) | Not used | App terms forbid redistribution and derived datasets | Link only; written CPW permission would unlock it |
| Guidebook and route sites | Beacon Guidebooks, huts.org, Friends of Berthoud Pass, CMC, SummitPost, Powder Project | Not used as data | No redistribution licence found | Link only |
| Land manager | BLM Surface Management Agency | Simplified GeoJSON | Public domain | Used; manager only, not access or legal parking |
| CAIC forecast | avalanche.state.co.us `?lat=&lng=` deep link | Prominent link for every selected point and route | Linking reproduces nothing | Used (link) |
| CAIC danger colors | avalanche.org `map-layer/CAIC` | Adapter built, off | API page: "Please contact avalanche.org / American Avalanche Associate for permission"; NAC guide sets display rules | Off, permission needed |
| CAIC forecast detail | avalanche.org `/v2/public/product` | Adapter built, off | CAIC terms require prior written permission to reproduce | Off, permission needed |
| CAIC site data feed (AVID) | avalanche.state.co.us/avid | Not used | CAIC terms prohibit robots and data mining; no CORS | Rejected |
| Historical accidents | CAIC accident reports and statistics | Official links; importer for an authorized file; empty dataset | CAIC terms require prior written permission | Link only until permission |
| Weather | NWS api.weather.gov (points, grid data, hourly, alerts) | Browser, live | Public domain; browser User-Agent suffices | Used |
| Weather models | Open-Meteo forecast API (`best_match`) | Browser, live | CC BY 4.0, free tier non-commercial | Used |
| Snow stations | NRCS AWDB REST (SNOTEL, SNOLITE) | Station snapshot in pipeline; data live in browser | Public domain, credit requested | Used |
| Snow model | SNODAS (NSIDC G02158) | Daily pipeline to image and numeric grid | NSIDC citation | Used (snapshot 2026-11-05 plus daily workflow) |
| Snowfall analysis | NOHRSC National Snowfall Analysis v2 | Not used in this build | Public domain | Researched only |
| SAR avalanche candidates | Captain's own avalanche-inventory archives | Read remotely from the same github.io origin by range requests | Own data | Used, labeled experimental |
| Hosting | GitHub Pages | Static site | 1 GB site, 100 MB per file in git, 25 MB via web upload; LFS and release assets cannot serve tiles | Used |

## 2. What would unlock more

1. CAIC danger colors and forecast detail inside the app: written permission from avalanche.org / the American Avalanche Association for the API, and from CAIC for reproducing its forecast content. Then set `providers.caic.enabled` (and `providers.caic.product.enabled`) in `app/config.js`.
2. Historical incidents on the map: written permission from CAIC (Request for API Access form or caic@state.co.us) to republish date, place, coordinates, activity and outcome from its accident records; `pipeline/incidents/import_incidents.py` already has a profile for its fatal-accident spreadsheet.
3. COTREX winter trails: written permission from Colorado Parks and Wildlife.
4. Guidebook lines (Beacon and others): a licence from the publisher. Nothing is reconstructed from paid or restricted catalogs.
5. Model validation: reuse terms for CAIC's regional runout layer or CDOT's avalanche path atlas.
