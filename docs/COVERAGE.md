# Colorado coverage report

What the app actually covers, layer by layer, as built on 2026-11-06. "Statewide" means the whole Colorado bounding box (-109.06 to -102.04 E, 36.99 to 41.01 N). Region names in section 4 are the app's own reporting regions (`data/coverage/regions.geojson`), approximations, not official or CAIC boundaries. Gaps are shown in the app as no data, never as an absence of hazard or of features.

## 1. Summary

| Layer | Coverage | Resolution / date | Notes |
|---|---|---|---|
| Basemap (OSM via Protomaps) | Statewide, z0-14 (overzoom above) | OSM data to 2026-11-04 04:00Z | 23 archives, 267 MB |
| Hillshade, contours, 3D, Tier 1 slope and aspect | Statewide | Mapterhorn z13, about 7.3 m pixels | Online; offline only for downloaded areas |
| Tier 2 analytical slope display | 14 one-degree mountain cells covering Colorado's ski terrain (section 2), 154 MB | USGS 3DEP 1/3 arc-second, 10 m UTM grid, z10-14 | See section 2 |
| Tier 2 exact tap values (elevation, slope, aspect) | Cells n40w106 and n40w107 (Front Range, Summit, Vail, Gore, Tenmile, Aspen, Maroon Bells), 118 MB | 10 m | See section 2 |
| Potential release areas and modeled runout | Pilot only: Berthoud, Jones and Loveland Pass box, 1,252 km2; reliable core 922 km2 | 10 m | Experimental, uncalibrated; 2.5 km truncation band marked |
| CAIC forecast | Statewide link for any point | CAIC's own site | In-app ratings off pending permission |
| NWS and Open-Meteo weather | Statewide, any point | NWS 2.5 km grid; Open-Meteo best_match | Live in the browser |
| SNOTEL | 118 SNOTEL and 4 SNOLITE stations in Colorado | Hourly and daily | Live in the browser; station list snapshot 2026-11-06 |
| SNODAS snow depth and SWE | Statewide plus margin | 1 km, analysis 2026-11-05 | Daily refresh once the workflow is enabled |
| SAR avalanche candidates | Front Range study box only (-106.43 to -105.34 E, 39.41 to 39.95 N), winters 2021-22 to 2023-24 | 20 m | Experimental, unvalidated |
| Historical accidents | None loaded | n/a | CAIC permission needed; official links shown |
| Routes and places | Statewide; ski-specific lines sparse (section 4) | OSM 2026-11-03, USFS 2025-05, GNIS 2026-11-02 | |
| Land manager | Statewide | BLM SMA 2026-09-22 | Manager only, not access |
| Aerial imagery | Statewide (USGS), online only | June 2024 | Optional layer |

## 2. Terrain (Tier 2) cells

| Cell | Extent | Main ranges (approximate) | Slope display (z10-14) | Exact tap values |
|---|---|---|---|---|
| n41w108 | 40-41 N, 108-107 W | Flat Tops north | 7.0 MB | no (Tier 1 values) |
| n41w107 | 40-41 N, 107-106 W | Park Range, Rabbit Ears, Steamboat | 6.8 MB | no (Tier 1 values) |
| n41w106 | 40-41 N, 106-105 W | Never Summer, Cameron Pass, Rocky Mountain NP, Indian Peaks | 11.5 MB | no (Tier 1 values) |
| n40w108 | 39-40 N, 108-107 W | Flat Tops south, McClure Pass, Grand Mesa (east part) | 15.4 MB | no (Tier 1 values) |
| n40w107 | 39-40 N, 107-106 W | Gore, Tenmile, Mosquito, Vail Pass, Holy Cross, Aspen, Maroon Bells | 16.3 MB | yes (four 0.5-degree parts) |
| n40w106 | 39-40 N, 106-105 W | Front Range: Berthoud, Loveland, Jones, James Peak, Mount Evans | 11.3 MB | yes (four 0.5-degree parts) |
| n39w108 | 38-39 N, 108-107 W | West Elk, Kebler Pass, Ruby Range | 13.6 MB | no (Tier 1 values) |
| n39w107 | 38-39 N, 107-106 W | Sawatch, Collegiates, Crested Butte, Monarch | 10.6 MB | no (Tier 1 values) |
| n39w106 | 38-39 N, 106-105 W | South Park, Pikes Peak, northern Sangre de Cristo, Wet Mountains | 11.3 MB | no (Tier 1 values) |
| n38w109 | 37-38 N, 109-108 W | La Plata Mountains | 10.4 MB | no (Tier 1 values) |
| n38w108 | 37-38 N, 108-107 W | San Juans: Red Mountain, Silverton, Ouray, Telluride, Wilson group, Lizard Head | 18.5 MB | no (Tier 1 values) |
| n38w107 | 37-38 N, 107-106 W | Eastern San Juans, Wolf Creek, Creede | 10.7 MB | no (Tier 1 values) |
| n38w106 | 37-38 N, 106-105 W | Sangre de Cristo (south), Culebra | 6.5 MB | no (Tier 1 values) |
| n38w105 | 37-38 N, 105-104 W | Spanish Peaks | 4.2 MB | no (Tier 1 values) |

The range names are orientation aids, not boundaries. The pilot (Berthoud, Jones and Loveland passes) is a separate, earlier product that the n40w106 and n40w107 cells reproduce exactly (one 0.1 m rounding cell of 12.5 million differs); the app uses the cells. Each cell was checked against GDAL (slope within 0.0031 degrees), 200 sampled display pixels against the analysis classes, and every overlapping pair of regions cell by cell (docs/methods/terrain.md section 10). Colorado terrain outside these 14 cells (mostly plains and plateaus) has Tier 1 only.

Outside these cells, slope and aspect are Tier 1 (computed in the browser). Measured agreement of Tier 1 (Mapterhorn z13) with Tier 2 on slopes above 25 degrees over the pilot: same 5-degree class in 78.2 percent of cells, within one class in 99.4 percent, slope MAE 1.22 degrees (docs/methods/terrain.md).

## 3. Avalanche terrain model

Pilot only: EPSG:26913 bounds 414110, 4381320, 447020, 4419360 (lon -106.005 to -105.617, lat 39.577 to 39.923). Release outside the pilot is not modeled, so runout within 2,500 m of the pilot edge is incomplete and marked as such. Extending to more areas needs one processing job per cell (estimated in docs/methods/avalanche-model.md section 12) and, more importantly, Colorado calibration and validation data that are not available under clear reuse terms.

## 4. Routes and places by region

Ski-specific geometry from open, redistributable sources is thin: 53 features statewide (11 ski descents, 40 skin or ascent routes, 2 touring areas, about 66 km of line), concentrated around Maroon Bells (Elk) and the Collegiate Peaks (Sawatch). There is no ski-specific line at Berthoud, Loveland, Jones, Vail, Red Mountain, Cameron or Rabbit Ears passes, on Grand Mesa, or in the Sangre de Cristo. Approaches are better covered (664 winter-use features: OSM winter-tagged ways and USFS trails with recorded snowshoe or cross-country ski use). Points cover the state well: 3,867 peaks, 380 passes, 563 trailheads, 515 trailhead parking areas, 67 huts.

| Region | Ski descents | Skin / ascent | Touring areas | Winter approaches | Peaks | Passes | Trailheads | Huts |
|---|---|---|---|---|---|---|---|---|
| Front Range | 1 | 5 | 1 | 91 | 631 | 65 | 118 | 10 |
| Summit / Tenmile | 0 | 2 | 0 | 94 | 123 | 15 | 32 | 9 |
| Vail / Eagle / Gore | 2 | 6 | 0 | 19 | 118 | 18 | 11 | 12 |
| Sawatch | 3 | 1 | 0 | 42 | 144 | 23 | 21 | 5 |
| Elk | 2 | 22 | 0 | 44 | 216 | 42 | 14 | 13 |
| San Juans | 3 | 3 | 0 | 92 | 669 | 68 | 103 | 7 |
| Northern | 0 | 0 | 1 | 67 | 363 | 38 | 14 | 2 |
| Sangre de Cristo | 0 | 0 | 0 | 12 | 242 | 26 | 19 | 0 |
| Grand Mesa | 0 | 0 | 0 | 76 | 74 | 0 | 2 | 1 |
| Other | 0 | 1 | 0 | 127 | 1,287 | 85 | 229 | 8 |
| **Total** | **11** | **40** | **2** | **664** | **3,867** | **380** | **563** | **67** |

Peaks and passes include GNIS-only additions. Full tables, data dates, the excluded lift-served candidates (3,964 resort runs and others) and a region-by-region description of what exists are in `docs/coverage-routes.md`.

## 5. Observations and incidents

1. SNOTEL: 122 stations; the nearest station to a backcountry destination is usually lower and more sheltered. Station elements differ (the 4 SNOLITE stations report snow depth only).
2. SAR candidates: 506,224 per-winter polygons and 105,568 cross-season hotspot polygons inside the study box; nothing outside it.
3. Historical accidents: none. A blank map here means no authorized dataset, not no accidents.
