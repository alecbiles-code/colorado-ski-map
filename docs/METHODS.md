# Sources and methods

Plain-language account of where each layer comes from, what it means, and where it stops being trustworthy. The app's Sources and Methods view shows the same information per layer from each product's `*.meta.json`. Technical detail lives in `docs/methods/` and the source evidence in `docs/SOURCES.md`.

Nothing in this app is an avalanche danger rating, a safety rating, or a recommendation to ski or not ski a slope. Only the Colorado Avalanche Information Center (CAIC) issues avalanche forecasts for Colorado; the app links to them.

## 1. Four kinds of information, kept apart

1. **Official forecasts**: the CAIC forecast (linked for the selected point), NWS forecasts and alerts. Issued by agencies, with issue and expiry times.
2. **Observations**: SNOTEL station readings. Measured at a station, which is near your destination, not on it.
3. **Models and analyses**: Open-Meteo weather models, SNODAS snow analysis, slope and aspect from elevation data, and the experimental avalanche terrain model. Computed, not observed.
4. **Experimental detections**: the Sentinel-1 SAR avalanche candidates. Unvalidated satellite change detections, not confirmed avalanches.

They never share a layer, color family or legend, and missing data is shown as missing (n/a), never as zero or as a low rating.

## 2. Terrain: slope, aspect, elevation, contours, hillshade

1. **Everywhere (Tier 1, approximate).** Your phone computes slope and aspect from Mapterhorn elevation tiles (USGS 3DEP lidar and 10 m data, Copernicus elsewhere) at about 7.3 m pixels, using the standard Horn method with the exact pixel size for your latitude. Hillshade, 3D and contours come from the same tiles. It shows where steep terrain is; it is not exact at class boundaries. Measured agreement with the analytical pilot is in `docs/methods/terrain.md`.
2. **Analytical regions (Tier 2).** In 14 one-degree mountain cells covering Colorado's ski terrain (listed in `docs/COVERAGE.md`), slope was computed offline from the current USGS 3DEP 1/3 arc-second DEM on a 10 m UTM grid, checked against GDAL (maximum difference 0.0031 degrees), and drawn from those results instead of the browser estimate. In cells n40w106 and n40w107 (Front Range passes, Summit, Vail Pass, Gore, Tenmile, Aspen, Maroon Bells) tapping a point reports the exact elevation, slope and aspect of the 10 m cell under your finger. Elsewhere tap values come from Tier 1. The app always says which tier answered.
3. **Slope bands** (degrees, lower bound included, so 30.0 is in 30 to 35): under 25 (not shaded), 25 to 30, 30 to 35, 35 to 40, 40 to 45, 45 and steeper. Bands describe steepness only. Unshaded terrain is not safe: avalanches start above, run through, and stop on gentler ground.
4. **Aspect** is degrees clockwise from true north. **Elevation** is metres above NAVD88, shown in feet by default.
5. **Aerial imagery** (optional, online only): USDA and USGS orthoimagery from The National Map, refreshed June 2024. It is summer imagery: useful for tree cover and open slopes, not for snow.
6. Limits: a 10 m grid smooths small features (cornices, rolls, gullies, cliff bands); slope depends on the grid size it was measured at; snow depth changes the real surface.

## 3. Experimental avalanche terrain model (pilot only)

1. **Potential release areas**: terrain the AutoATES v2.0 fuzzy method scores as able to start an avalanche, from slope, wind shelter and NLCD tree canopy cover. In practice it behaves like a slope cut near 28.6 degrees plus a canopy cut near 38 percent. The score (0 to 1) is a terrain-suitability membership, not a probability.
2. **Modeled runout**: where flow from those release areas can travel by the Flow-Py angle-of-reach routing model (AvaFrame com4FlowPy, alpha 25 degrees). The colors show the energy-line height above the terrain (zDelta), a geometric intensity proxy. It is not a reach probability, and there is no speed, timing, impact or burial estimate because Flow-Py does not model them.
3. All parameters are published Canadian and Austrian defaults; none is calibrated or validated for Colorado. Runout ignores forest, so runout into trees is probably too long. Within 2.5 km of the pilot edge the runout is incomplete (marked on the map).
4. Absence of modeled release or runout does not mean safe terrain. Do not combine this layer with the forecast or weather into your own danger rating. Details: `docs/methods/avalanche-model.md`.

## 4. Avalanche forecast (CAIC)

1. For any selected point, route or your location, the app shows a link that opens CAIC's own forecast for that location (`avalanche.state.co.us/?lat=&lng=`). For a route it links the start, high point and end, because forecast areas can change daily.
2. Danger colors and forecast details inside the app are built but switched off until permission is obtained (see `docs/SOURCES.md` section 2). When switched on, each zone keeps its own issue and expiry times; expired, unavailable, outside-coverage and boundary cases are shown as such, never as a rating.

## 5. Weather

1. **NWS**: forecast, hourly forecast, grid data (wind gusts, snowfall, snow level) and active alerts for the point's 2.5 km forecast grid cell. The app shows the grid cell's elevation next to the point's elevation; at Berthoud Pass the grid cell is about 135 m higher than the pass.
2. **Open-Meteo** (its `best_match` model selection for the location): hourly temperature, wind, gusts, precipitation type, snowfall, cloud cover and freezing level. Longer ranges are flagged as less certain. Its elevation setting only adjusts temperature.
3. Model snowfall is a forecast, not measured snow. Neither source says anything about snowpack stability. Details: `docs/methods/conditions.md`.

## 6. Snow observations and analyses

1. **SNOTEL** (NRCS): snow depth, snow water equivalent, temperature and precipitation at 118 SNOTEL and 4 SNOLITE stations, with 24 h, 7 day and 30 day changes. Times are the station's fixed UTC-8 clock; a daily value dated D is the reading at midnight starting D+1. A drop or rise in depth is not the same as new snowfall (settling, wind, sensor noise). Suspect and missing readings are labeled, never zeroed. The nearest station is often lower and more sheltered than the terrain you are looking at; the app shows distance and elevation difference.
2. **SNODAS** (NOAA NOHRSC via NSIDC): daily modeled snow depth and SWE on a 1 km grid with its analysis date. A 1 km model is far coarser than a ski line and assimilates SNOTEL, so it is context, not a measurement of your slope. Details: `docs/methods/snow-sar-incidents.md`.

## 7. Experimental SAR avalanche candidates

Sentinel-1 radar backscatter change detections for the Front Range study area over winters 2021-22, 2022-23 and 2023-24, from the captain's avalanche-inventory project. Confidence is a hand-assigned class, not a probability; the only date is the season; the method has known false-positive sources (no forest mask, max-z statistic) and has not been validated against observed avalanches. Outside the study box there is no data, not an absence of avalanches. Recurrence is not a forecast.

## 8. Historical accidents

No accident dataset is loaded: CAIC's terms require written permission to reproduce its accident records. The layer lists CAIC's official accident pages instead. A missing incident never implies low risk.

## 9. Routes, places and land

1. Routes come from OpenStreetMap (winter-tagged routes and paths) and USFS trails with recorded snowshoe or cross-country ski use. Open ski-touring line data for Colorado is thin (53 ski-specific features statewide); see `docs/COVERAGE.md`. A summer trail is never shown as a winter approach.
2. Descent or skin-track roles come from source tags and names; each feature records why. Distance, gain, loss and aspect are computed from Mapterhorn elevation and labeled as DEM-derived. Difficulty appears only when the source provides it.
3. Land manager (BLM Surface Management Agency) shows who manages land, not whether access is open today or parking is legal.
