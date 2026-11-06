# Avalanche terrain model pilot: potential release areas and Flow-Py runout

Status: implemented and run for the pilot only (Berthoud Pass, Jones Pass, Loveland Pass, Mount
Sniktau; EPSG:26913 10 m grid, xmin 414110, ymin 4381320, xmax 447020, ymax 4419360). Label in the
app: "Experimental terrain model". It is not an avalanche hazard map, not an ATES rating, not a
forecast and not a statement that any slope is safe. Terrain with no modeled release or runout is
not "safe terrain": it is terrain this model, with these parameters and inputs, did not flag.

Code: `pipeline/avalanche/` (README there lists the commands). Products: `data/avalanche/`.
Numbers below come from `work/avalanche/analysis.json` and the run records of the rerun on
2026-11-06 01:37-02:20Z (Apple Silicon workstation, 10 cores, 16 GB RAM, 5 cores used), made on
the terrain lane's grid-snap-fixed DEM (the earlier pilot DEM was displaced about 3.0 m east and
2.8 m south). Against the pre-fix run, primary PRA cells agree at Jaccard 0.914 and the primary
runout footprint at 0.967; headline areas changed by less than 0.5 %.

## 1. Research and model choice

### 1.1 What was evaluated (sources checked 2026-11-06 UTC)

| Candidate | Version / commit | License | What it is | Used here |
|---|---|---|---|---|
| Flow-Py v1.0, D'Amboise et al. 2022, GMD 15:2423-2439, doi:10.5194/gmd-15-2423-2022 | github.com/avaframe/FlowPy, last commit 27ad81d (2022-06-20); repository archived | GPL-3.0 (code); article CC BY 4.0 | Angle-of-reach energy line plus raster flow routing with persistence. "No time-dependent equations ... are solved." | Concept and parameter reference |
| AvaFrame com4FlowPy (maintained successor of Flow-Py) | PyPI `avaframe` 2.1 (2026-06-11, latest stable), 2.2b1 (2026-09-24, pre-release with numba engine), GitHub main 40a15f5 (2026-10-14) | EUPL-1.2 | Same model, tiling, multiprocessing, forest modules; docs at docs.avaframe.org/en/latest/moduleCom4FlowPy.html | Yes: runout, `avaframe==2.2b1`, engine `numba` |
| onXmaps/FlowPy | fork at the same commit 27ad81d as avaframe/FlowPy; no public onX changes | GPL-3.0 | Evidence that onX uses Flow-Py; onX's ATES page names autoATES (John Sykes). The onX Zendesk help center returned HTTP 403 to automated fetch. | Research lead only; nothing copied |
| AutoATES v2.0, Toft et al. 2024, NHESS 24:1779-1793, doi:10.5194/nhess-24-1779-2024 | github.com/AutoATES/AutoATES-v2.0, HEAD 3afcb49 (2023-10-31), CITATION version 2.1 | GPL-3.0 (code); article CC BY 4.0 | Fuzzy-logic PRA (slope, wind shelter, forest as stems/ha, basal area or percent canopy cover) + Flow-Py with forest detrainment + ATES classifier. Validated against expert ATES maps at Bow Summit and Connaught Creek (F1 77 % and 71 %). The paper states its parameters are "valid for the two test areas in western Canada" and that users "should not adopt the input parameters" without local validation. | Yes: PRA method and parameters (reimplemented; no code copied) |
| autoATES v3.0 ISSW 2026 snapshot | github.com/AutoATES/autoATES-v3.0-issw, HEAD 5558c16 (2026-10-02), snapshot of private dev commit adb83f6 (2026-09-16), version 3.0.0-issw2026 | MIT | Typical/infrequent PRA scenarios (thresholds 0.25/0.05), Sentinel-2 canopy ("sen2cc") forest curve, ruggedness off, com4FlowPy alpha 30/18 with forest detrainment, numba engine. Defaults are "the ISSW / western Canada working version"; the development repository is private. | Compared; not used (see 1.2) |
| issw2026-autoates-workshop | github.com/AutoATES/issw2026-autoates-workshop, HEAD fd50675 (2026-10-02) | MIT (code); data under JAXA/Copernicus terms, "not a licence to redistribute" | Notebooks and the Connaught Creek bundle (ALOS AW3D30 30 m DEM, Sentinel-2 canopy). Shows that `sen2cc` = share of conifer-classified 10 m pixels in a 3 x 3 window. | Semantics check only |
| Veitinger et al. 2016, NHESS 16:2211-2225, doi:10.5194/nhess-16-2211-2016 | | CC BY 4.0 | Fuzzy PRA from slope, wind shelter index and multi-scale roughness; outperformed a slope-only approach on historical data; "snowpack stability is not integrated". | Origin of the slope and wind memberships |
| Bühler et al. 2018, NHESS 18:3235-3251, doi:10.5194/nhess-18-3235-2018 | | CC BY 4.0 | Validated existing PRA algorithms against mapped avalanches near Davos: all "failed to delineate individual PRAs meaningfully"; proposes an object-based method. | Caveat: pixel PRA is not a set of individual start zones |
| CAIC Regional Avalanche Runout layer (Foley, Cooperstein, Greene, Natural Hazards Workshop poster, June 2026) | not published as data | CAIC terms | Colorado-specific: 1 m lidar DEM, 10 m Sentinel-2 canopy anchored to the CSFS 20 m canopy as a forest structure index, fuzzy PRA thresholded at 0.55 (R-size 4 start zones), com4FlowPy with forest friction. Against 41 forecaster-drawn paths: median IoU 0.77, Dice 0.81, median underprediction 9 %. Statewide by fall 2026. | Not used; best Colorado reference (see 9) |

### 1.2 Decisions

1. Runout: AvaFrame com4FlowPy, because it is the maintained Flow-Py (the original repository is archived), installs from PyPI with pinned versions, and runs headless with custom input paths. Version 2.2b1 is a pre-release; it is pinned because it is the first release with the numba engine (pin accepted by the lead, 2026-11-06). The stable 2.1 release also works, with the python engine only, about 4x slower on the test window (8x with a warm numba cache). On a 2 x 2 km test window at Berthoud Pass (3,257 release cells) the numba and python engines gave bit-identical zDelta, cellCounts, travelLengthMax, fpTravelAngleMax and flux on all 9,389 affected cells, in 3.1 s vs 24.7 s with a warm numba cache (9.6 s vs 37.3 s on the first, cold run with the pre-fix DEM, which also showed the results are identical with 500 or 10 chunks).
2. PRA: the AutoATES v2.0 fuzzy-logic method with its percent-canopy-cover (`pcc`) forest curve. The autoATES v3.0 `sen2cc` curve was tested and rejected for this input: it expects the share of conifer-classified Sentinel-2 pixels, a different quantity from NLCD modeled canopy percent. With `sen2cc` on NLCD, 98-99 % of 30-45 degree cells with 30-70 % canopy became release, so forest had almost no effect. NLCD canopy rarely exceeds 70 % here (95 cells on 30-45 degree slopes); the mean over all cells between 2,400 and 3,300 m is 38-43 %. With `pcc` (membership 0.5 at 25 %, below 0.1 above 40 %), the share of 30-45 degree cells that are release falls from 99 % at 30-35 % canopy and 79 % at 35-40 % to 0.1 % at 40-50 % and 0 % above (section 3). The `pcc` curve was set from Parks Canada expert input in two Canadian test areas; it is not calibrated for NLCD or Colorado either.
3. Not Colorado-calibrated: every parameter is a published default from western Canada (AutoATES) or the Austrian regional example (Flow-Py). European or Canadian workshop parameters encode those snow climates, forests, DEMs and canopy products. Colorado's continental snowpack, high treeline (mean NLCD canopy falls from 38 % at 3,300-3,500 m to 12 % at 3,500-3,700 m here) and beetle-killed stands differ. Parameters were not tuned on any local data.
4. ATES: not produced. AutoATES v3.0's classifier is tied to its sen2cc forest semantics and Canadian class thresholds; an automated ATES map from mismatched inputs would look authoritative without being so.

## 2. Inputs and their semantics

| Input | Source | Semantics | Grid handling |
|---|---|---|---|
| DEM | USGS 3DEP 1/3 arc-second (files USGS_13_n40w106_20260630, USGS_13_n40w107_20260708), bilinear to the pilot grid by `pipeline/terrain` | Bare-earth elevation, m, NAVD88 | Used as is; also the terrain lane's 160 m buffered DEM for wind shelter |
| Slope | `pipeline/terrain` (Horn 1981, degrees) | Same slope the app displays | Used as is |
| Wind shelter | computed here from the buffered DEM | Median (quantile 0.5) of arctan((z_i - z_0)/d_i) over all cells within 60 m (omnidirectional); radians; positive = sheltered, negative = exposed | Computed on the buffered DEM and cropped, so the pilot edge has full windows; cells whose window leaves the DEM or touches NoData are NoData, never partial |
| Canopy | USFS NLCD Percent Tree Canopy CONUS v2025-6, year 2025 (`nlcd_tcc_conus_wgs84_v2025-6_20250101_20251231.tif`), public domain | Modeled percent tree canopy cover 0-100, 30 m, Albers on WGS84; 254 non-processing area, 255 background | Read by HTTP range from the official zip (stored member, tiled GeoTIFF), clipped with a 300 m margin, reprojected to the pilot grid by nearest neighbour (each 10 m cell takes the 30 m cell under its centre; no invented values); 254 and 255 become NoData (255). Pilot: 0 NoData cells, mean 28.6 %, 32.8 % of cells at 0 % |

Canopy semantics are matched to the method's `pcc` membership (percent cover). Canopy is not
converted to stems/ha or basal area. NoData canopy (none in this pilot, tested synthetically) makes
PRA unknown (NoData), not 0 and not release; unknown cells are not used as release.

## 3. Potential release area (PRA)

Method: AutoATES v2.0 (`PRA/PRA_AutoATES-v2.0.py` at 3afcb49, forest type `pcc`), reimplemented
in `pipeline/avalanche/pra.py` and `avy_core.py`. Each input is mapped to a membership in [0, 1]
with a generalised bell (Cauchy) function m(x) = 1 / (1 + ((x - c) / a)^(2b)), and the three
memberships are combined with the ordered-weighted fuzzy AND of Veitinger et al. (2016):
PRA = (1 - m_min) m_min + m_min mean(m_slope, m_wind, m_forest).

| Parameter | Value | Meaning |
|---|---|---|
| Slope membership a, b, c | 11, 4, 43 | 0.5 at 32 and 54 degrees, near 1 at 38-48 degrees, near 0 below 25 and above 62 |
| Wind shelter membership a, b, c | 3, 10, 3 | 0.5 at 0 (planar terrain), rising to about 1 for sheltered (positive) cells, falling for exposed cells |
| Wind shelter radius, quantile, sector | 60 m, 0.5, omnidirectional (direction 0, tolerance 180) | AutoATES v2.0 defaults (no prevailing wind assumed) |
| Canopy membership a, b, c | 40, 3.5, -15 | 1.0 at 0 %, 0.5 at 25 %, 0.097 at 40 %, 0.012 at 60 % |
| Release threshold | 0.15 (AutoATES v2.0 default) | Binary PRA = continuous >= 0.15 |
| Patch filter | drop 8-connected release patches under 4 cells (400 m2) | AutoATES v2.0 `sf = 3`; small holes are not filled (gdal.SieveFilter would fill them) |
| Sensitivity threshold | 0.25 | autoATES v3.0 "typical" threshold |

Differences from the AutoATES v2.0 script, all deliberate: slope is the terrain lane's Horn slope
(the script uses `numpy.gradient`); wind shelter is computed on a buffered DEM so the pilot edge is
valid (the script pads with -9999); unknown inputs give unknown PRA (the script maps
NoData-like forest values to open terrain); the binary keeps values exactly at the threshold.

Result (primary): 2,096,961 release cells, 209.7 km2, 16.8 % of the pilot, 10,213 patches. At
threshold 0.25: 1,645,336 cells, 164.5 km2, 13.1 %, 9,325 patches. Compute: 11 s for wind
shelter, memberships and both binaries (numba, 10 threads); peak RSS 1.6 GB.

Share of cells that are primary release, by slope (all cells), by canopy (30-45 degree cells) and
by elevation:

| Slope (deg) | <28 | 28-30 | 30-35 | 35-40 | 40-45 | 45-50 | 50-55 | 55-60 | >=60 |
|---|---|---|---|---|---|---|---|---|---|
| Release share | 0.000 | 0.335 | 0.659 | 0.806 | 0.872 | 0.912 | 0.919 | 0.531 | 0.000 |

| Canopy % (30-45 deg) | 0 | 1-20 | 20-30 | 30-35 | 35-40 | 40-50 | >=50 |
|---|---|---|---|---|---|---|---|
| Release share | 0.993 | 0.994 | 0.993 | 0.991 | 0.792 | 0.001 | 0.000 |

| Elevation (m) | 2400-3000 | 3000-3300 | 3300-3500 | 3500-3700 | >=3700 |
|---|---|---|---|---|---|
| Release share | 0.089 | 0.078 | 0.123 | 0.235 | 0.389 |

Read: on 30-45 degree slopes the canopy curve acts almost as a switch at about 38 % NLCD canopy.
Release terrain in sparse or patchy trees below that value is kept; closed forest is excluded. On
open terrain the threshold is effectively a slope cut at about 28.6 degrees (computed: 28.55 to
28.70 degrees for wind shelter +0.1 to -0.1 rad; 29.6 to 29.8 degrees at threshold 0.25). Wind
shelter shifts that cut by less than 0.2 degrees and barely separates release from non-release
in the 28-30 degree band (51 % vs 44 % of open cells there are sheltered), so at 60 m radius
and omnidirectional settings it contributes little.

The continuous value is a terrain-suitability membership, not a probability of release, and the
binary is not a set of individual start zones (Bühler et al. 2018). Snowpack, wind events,
cornices, and the actual snow surface are not represented.

## 4. Runout (Flow-Py via com4FlowPy)

Software: AvaFrame com4FlowPy `avaframe==2.2b1`, engine `numba`, 5 worker processes (AvaFrame
default: 50 % of cores). Inputs: pilot DEM (GeoTIFF, NoData -9999) and the binary PRA as release
(1 release, 0 not; unknown PRA never released). Parameters (`config.yaml` `runout`):

| Parameter | Value | Source and meaning |
|---|---|---|
| alpha | 25 degrees | Angle of reach; paths stop when the energy line meets the terrain. Flow-Py v1.0 regional snow-avalanche example and the com4FlowPy default. autoATES v3.0 uses 30 (typical) and 18 (infrequent) for western Canada. |
| exp | 8 | Lateral spreading exponent (higher = more concentrated). Flow-Py v1.0 (10 m DEM), com4FlowPy default, autoATES v3.0. |
| flux_threshold | 3e-4 | Minimum routed flux still processed. Flow-Py v1.0 and com4FlowPy default. |
| max_z | 270 m | Cap on the energy-line height (sqrt(2 g 270) = 72.8 m/s equivalent); com4FlowPy config comment value for avalanches, also autoATES v3.0. Flow-Py v1.0 used 8849 m (no cap). |
| forest | off | See 1.2 and limitations. |
| tileSize, tileOverlap | 15,000 m, 5,000 m | com4FlowPy defaults; tiles advance 5 km, so each release cell is routed with at least 5 km of terrain around its tile core. |
| maxChunks | 10 | Memory control only; results are chunk-invariant (verified). |

The tiles processed exactly the 2,096,961 release cells supplied (sum of per-tile counts), so no
release is double counted.

## 5. What the outputs mean (and do not mean)

Flow-Py solves no time-dependent equations (D'Amboise et al. 2022; AvaFrame docs). There is no
mass, velocity field, flow depth, pressure, arrival time or burial depth, and none is derived here.

| Output | Definition | Use here | Not |
|---|---|---|---|
| Footprint | cells with cellCounts >= 1 | Runout layer extent: start, transit and runout cells reached by at least one modeled path | Not a reach probability; not the extent of any real or design event |
| zDelta (m) | maximum over all paths of the energy-line height above the terrain at the cell | Runout display classes; numeric inspector | A geometric intensity proxy, not a speed (the sqrt(2 g zDelta) conversion assumes frictionless point mass and is not shown) |
| cellCounts | number of release cells whose path reaches the cell | Footprint definition; GeoTIFF in the work dir | Not a frequency or probability; scales with how much release terrain lies above |
| fpTravelAngleMax (deg) | maximum gamma (travel angle along the flow path from release) | GeoTIFF in the work dir | Cells with gamma near alpha are near the modeled stopping point |
| travelLengthMax (m) | maximum path length from release | Truncation band width | Along-path length, not straight-line distance |
| flux | maximum routing flux of all paths (0-1) | Kept in the work dir | Not mass or volume |

## 6. Runtime, memory and size (measured)

Machine: Apple Silicon, 10 cores, 16 GB RAM, shared with other build lanes during the runs (load
average up to about 15). com4FlowPy used 5 worker processes.

| Step | Wall time | CPU time | Peak memory | Output |
|---|---|---|---|---|
| Inputs (terrain snapshot, canopy range read and reprojection; first run) | 17.7 s | 3.1 s | 0.17 GB RSS | canopy clip and 10 m grid |
| PRA (wind shelter, memberships, two binaries) | 10.6 s | 39.1 s | 1.6 GB RSS | 5 GeoTIFFs |
| Flow-Py primary (alpha 25, 2,096,961 release cells, 30 tiles) | 497 s | 1,781 s | 2.92 GB footprint; main 1.98 GB, largest worker 0.79 GB RSS | 5 GeoTIFFs, 113 MB |
| Flow-Py alpha 23 | 698 s | 2,542 s | 2.68 GB footprint | 127 MB |
| Flow-Py alpha 27 | 371 s | 1,301 s | 2.65 GB footprint | 97 MB |
| Flow-Py PRA threshold 0.25 (1,645,336 release cells) | 420 s | 1,523 s | 2.65 GB footprint | 105 MB |
| Checks and SAR overlap | about 25 s | | | analysis.json |
| Web products (3 PMTiles, coverage, metas) | about 55 s | 53 s | 1.5 GB RSS | 17.4 MB in `data/avalanche/` |

Flow-Py cost scales with the number of release cells times path length: 0.24 ms of wall time
(0.85 ms CPU) per release cell at alpha 25, rising to 0.33 ms at alpha 23. Wall times above
include process start-up and tiling.

## 7. Sensitivity

Footprint = cells reached by at least one path. Areas in km2 of the 1,251.9 km2 pilot.

| Run | Release cells | Footprint km2 | Change vs primary | Gained / lost km2 | Jaccard vs primary | Longest path (p99) | zDelta median / p90 |
|---|---|---|---|---|---|---|---|
| Primary: alpha 25, PRA 0.15 | 2,096,961 | 520.4 | | | 1 | 2,213 m (1,430 m) | 26.0 / 93.3 m |
| alpha 23 | 2,096,961 | 586.7 | +12.7 % | +66.4 / -0.09 | 0.887 | 2,446 m (1,625 m) | 33.7 / 113.1 m |
| alpha 27 | 2,096,961 | 450.8 | -13.4 % | +0.05 / -69.6 | 0.866 | 2,006 m (1,256 m) | 19.3 / 75.9 m |
| PRA threshold 0.25, alpha 25 | 1,645,336 (-21.5 %) | 469.3 | -9.8 % | 0 / -51.1 | 0.902 | 2,213 m (1,429 m) | 27.6 / 94.5 m |

Reading:

1. Plus or minus 2 degrees of alpha changes the footprint by about 13 % either way. Almost all of the change is at runout tips: the cells added at alpha 23 (or removed at alpha 27) have a median slope of 18-20 degrees, 33-38 % of them lie on slopes under 15 degrees, and 54-57 % lie under canopy of 40 % or more, against 30 % for the footprint as a whole. Those are exactly the cells where the missing forest friction matters most, so the runout boundary in valley forest is the least certain part of the product.
2. Lowering alpha is not perfectly monotone: 902 cells (0.09 km2) reached at alpha 25 are not reached at alpha 23, and 481 cells the other way at alpha 27, because routing and the flux cutoff interact with the energy-line height. This is negligible against the 66-70 km2 changes.
3. Raising the PRA threshold from 0.15 to 0.25 removes 45.2 km2 of release (21.5 %), cells that are marginal by slope (57 % at 28-32 degrees, median 31.0) or by canopy (56 % at 30-40 %). 72 % of them are still reached by paths from the remaining release above, so the footprint shrinks by 51.1 km2 (9.8 %): 12.8 km2 of former release cells and 38.3 km2 of runout below them.
4. These spreads are a lower bound on parameter uncertainty: the canopy curve, the wind-shelter settings, exp, max_z and forest effects were not varied, and no parameter is calibrated.

## 8. Checks

1. Co-registration: every input, PRA raster, release raster and com4FlowPy output (29 rasters) has EPSG:26913, 3804 x 3291 cells and the pilot transform (origin 414110, 4419360; 10 m) to 1e-6 (`avy_checks.coregistration`). com4FlowPy writes its outputs on the DEM header it was given, so outputs co-register by construction; this was checked, not assumed. Canopy was reprojected onto the same transform (nearest); the 160 m buffered DEM is checked to sit on the same 10 m lattice before cropping.
2. NoData: DEM, slope, canopy, wind shelter, PRA continuous and binary all have 0 NoData cells in the pilot. com4FlowPy marks cells no path reached with -9999; this pipeline reads that as "not reached" (a valid model state), kept distinct from "outside the model" in the numeric product.
3. Missing canopy: none in this pilot. Behaviour tested synthetically: a NoData canopy cell gives NoData PRA and binary code 255 (unknown), is never released, and does not affect neighbours.
4. Edge and seams: com4FlowPy never routes into the outermost row and column and drops flux sent there, so paths reaching the pilot edge are cut: no cell of the outermost row or column is ever reached, 2,974 cells in the outer 2-cell frame are, and the 1,376 release cells on the outermost ring are never routed (com4FlowPy needs a full 3 x 3 window). Releases outside the pilot are not modeled at all. The longest modeled path is 2,213 m in the primary run (99th percentile 1,430 m) and 2,446 m in the alpha 23 run, so a 2,500 m band (longest path of any run, rounded up) inside the boundary (329.8 km2, 26.3 % of the pilot) is marked "runout incomplete"; the reliable core is 922.1 km2. Internal com4FlowPy tiles: the per-tile release counts sum to exactly the 2,096,961 supplied, and a seam test on a 6 x 6 km window gave identical outputs (all five layers, every cell) for a single tile and for 3 km tiles with 1 km overlap (68,537 release cells, longest path 1,798 m); with 2 km tiles and 500 m overlap, cellCounts differed in 4,511 cells and 106 reached cells were lost, so the test does detect seams. Production tiles use a 5 km overlap against a longest path of 2,446 m.
5. Resolution: aggregating DEM and canopy to 20 m and 30 m (mean) and recomputing slope, wind shelter (60 m) and PRA gives release fractions of 16.0 % and 15.3 % (16.8 % at 10 m) and Jaccard agreement with the 10 m binary of 0.84 and 0.76 (89 % and 82 % of 10 m release cells kept). Flow-Py at 20 m on the 20 m PRA (72 s instead of 497 s) gives a footprint of 39.7 % of the area against 41.6 % at 10 m, Jaccard 0.92. Results are therefore moderately resolution-dependent at release boundaries and robust in the bulk of the footprint; nothing finer than 10 m was tested.
6. Engines: numba vs python bit-identical on the 2 x 2 km window (section 1.2).
7. Numeric product: the app's `terrain-math.js` (`numericCellAt`, `decodeNumericTile`) run in node on tiles pulled from `avalanche-numeric-pilot.pmtiles` returned PRA (n / 100), zDelta (m), the release bit and the reached bit exactly equal to the quantized analysis rasters at 500 random test points (pyproj on the Python side, the app's own `lonLatToUtm` on the JS side).
8. Tests: `tests/pipeline/test_avalanche.py` (10 tests) cover memberships, fuzzy AND, wind shelter on plane, bowl and dome surfaces and NoData windows, unknown canopy, dense canopy, patch filter connectivity, numeric round trip and block placement, nearest tile sampling, and max-class overviews.

## 9. Validation: what was and was not possible

What was done is verification, not validation:

1. Implementation checks: synthetic tests of memberships, wind shelter (plane = 0, bowl > 0, dome < 0, NoData windows give NoData), unknown-canopy handling, patch filter, tile sampling and numeric round trip (`tests/pipeline/test_avalanche.py`); numba vs python engine identity; release-cell conservation across com4FlowPy tiles; co-registration of every raster; decoding of the numeric product by the app's own `terrain-math.js` in node.
2. Plausibility: a visual check near Berthoud Pass shows release on open steep bowls and ridges, none in closed forest, and runout following gullies to valley floors. This is not evidence of accuracy.

Not possible here, and why:

1. No independent Colorado reference with permission. The CAIC Regional Avalanche Runout layer (section 1.1) is the most relevant reference: Colorado-specific, built with the same model family, and compared by CAIC against 41 forecaster-drawn paths. Its reuse terms are not established and CAIC terms restrict automated access. This project does not contact CAIC or CDOT (lead decision, 2026-11-06). Captain-level next step: ask CAIC for permission to use the layer (or its path polygons) for comparison; with it, compute per-path IoU/Dice of our runout footprint against it inside the pilot, with the same caveats CAIC lists (reference outlines vary by event and analyst).
2. onX Backcountry's Avalanche Runout, Potential Release Area and ATES layers are proprietary app content: not used, not compared.
3. Mapped avalanche paths. One web search (2026-11-06) found two candidates, neither usable now. The CDOT avalanche atlas (522 known paths statewide, per a hazard-planning document) is reportedly hosted on CDOT C-Plan ArcGIS Online and linked from the CAIC page https://lb.avalanche.state.co.us/gis_cplan_survey123/, which returned HTTP 503 at 2026-11-06T00:44Z; access terms are unknown. avalanchemapping.org offers a Colorado atlas, but says in a public forum post that most of its data is for government agencies and not given away. Captain-level next step: confirm public access and reuse terms for the CDOT path layer with CDOT or CAIC. US 40 (Berthoud Pass) and US 6 (Loveland Pass) paths inside the pilot would then give the most direct reference for runout extent. CAIC accident records are incident points, not path extents.
4. Return periods, release depths and snow climate are not modeled, so no event-scale comparison is meaningful.

### 9.1 Descriptive comparison with the experimental SAR inventory (not validation)

The captain's Sentinel-1 avalanche inventory (`avalanche-inventory` at d69692a,
`cross_season_hotspot.pmtiles`, layer `hotspots`) covers the whole pilot. Hotspot polygons
(48,342 tile features read at the archive's maximum zoom, rasterized at cell centres onto the
pilot grid) were overlaid on the primary PRA and runout footprint. The model was not tuned on
these data and they are not used anywhere else in the pipeline.

| Cells | Count | Share in primary PRA | Share in primary runout footprint |
|---|---|---|---|
| All pilot cells | 12,518,964 | 16.8 % | 41.6 % |
| Pilot cells with slope 20-70 degrees | 6,469,214 | 32.4 % | 62.1 % |
| SAR hotspot cells, higher confidence | 272,616 | 50.9 % | 76.6 % |
| SAR hotspot cells, lower confidence | 1,024,311 | 39.1 % | 65.4 % |

Reading: hotspot cells fall inside the modeled footprint more often than pilot cells in general,
and more often than cells in the 20-70 degree window the SAR candidates were restricted to. This
says the two products are spatially related; it does not validate either. The SAR candidates are
unvalidated (their accuracy and false-alarm rate are unknown), they were thresholded in a manual
step, layover and forest were not masked, and many sit on the steep terrain both products favour
by construction.

## 10. Web products (`data/avalanche/`)

| File | Content | Size |
|---|---|---|
| `avalanche-pra-pilot.pmtiles` | Primary binary PRA cells, coloured by continuous PRA class (0.15-0.30, 0.30-0.50, >= 0.50); paletted PNG, z9-z15 | 4.72 MB |
| `avalanche-runout-pilot.pmtiles` | Primary-run footprint coloured by zDelta class (< 5, 5-20, 20-50, >= 50 m); paletted PNG, z9-z15 | 4.55 MB |
| `avalanche-numeric-pilot.pmtiles` | Per-cell integers for tap inspection: PRA continuous (x100), flags (release at both thresholds, reached in each of the 4 runs, truncation band), primary zDelta (1 m) | 8.04 MB |
| `avalanche-coverage-pilot.geojson` | `pilot-extent` (outside: not modeled) and `truncation-band` (runout incomplete) | 17 KB |
| `*.meta.json` | Provenance, model version and parameters, units, bbox, coverage and truncation band, classes, legend, limitations, sizes, sha256 | |

Display tiles: each max-zoom (z15, 3.7 m) pixel takes the class of the 10 m analysis cell under
its centre (EPSG:3857 pixel centre transformed to EPSG:26913; nearest neighbour, no
interpolation). Lower zooms take the maximum class of each 2 x 2 block of child pixels, so a
class never disappears when zooming out; at z9-z12 the layers therefore look more extensive than
at full resolution. Use `raster-resampling: nearest`. Colours are baked into the PNGs and listed in
each meta `classes` and `legend`; the families (magenta for PRA, blue for runout) avoid the slope
ramp (yellow-red-purple) and danger-scale colours.

Numeric inspection: same block scheme and encoding as `data/terrain/terrain-numeric-pilot`
(UTM 13N blocks of 256 x 256 cells, origin E 0 / N 4,700,000, zlib byte planes of zigzag 2-D
difference residuals), with no apron and one tile zoom per variable (9 PRA, 10 flags, 11 zDelta). cellCounts and
travel angle were left out for size (about 4.2 MB and 2.3 MB more) and remain in the work-dir
GeoTIFFs. `app/lib/terrain-math.js` decodes it unchanged:
`numericCellAt(lon, lat, {...numeric, tileZ: variable.tileZ})`, then
`decodeNumericTile(bytes, numeric.blockCells)`, value = n / scale. Distinct states: `nodata`
(-1,000,000) = outside the model grid or unknown PRA; `notReached` (-1 for zDelta) =
inside the model, no modeled path reaches the cell. Flags bit 6 marks the truncation band. In node, the app's own decoder reproduced the analysis rasters at 500 random test points (section 8).

## 11. Limitations

1. Experimental terrain modeling only. Not a hazard map, not ATES, not a forecast, not a ski or no-ski signal. Never combine it with weather or the CAIC forecast into a slope-danger score.
2. Absence of modeled release or runout is not safety. Unmodeled hazards include: start zones smaller than about 20-30 m or not resolved by a 10 m bare-earth DEM (cornices, gullies, cliff bands, convex rolls, terrain traps), slopes below the effective 28.6 degree cut that still avalanche in wet or unusual conditions, release in forest gaps the 30 m canopy does not resolve, avalanches larger than an alpha of 25 degrees allows (alpha 23 reaches further, section 7), and release outside the pilot reaching the truncation band.
3. Parameters are published defaults from western Canada (PRA) and Austria (runout). None is calibrated or validated for Colorado or for NLCD canopy.
4. Canopy: NLCD TCC is a Landsat-based model at 30 m, nearest-resampled to 10 m (blocky edges, no sub-30 m gaps). Standing dead trees and recent disturbance are poorly represented; CAIC reports the same problem for its canopy product. Canopy controls PRA almost as a switch near 38 %, so canopy error moves release boundaries directly.
5. Runout ignores forest. Modeled runout into and through forest is likely too long.
6. The DEM is bare earth: snow depth, wind deposits and cornices change the real surface.
7. Pixel PRA is not a set of individual start zones, and runout from many adjacent release cells is merged; per-path statements are not supported.
8. Inside the 2,500 m truncation band the runout is incomplete.
9. The numba engine ships in a pre-release (`avaframe==2.2b1`, pin accepted by the lead); its identity with the python engine was checked on one window, not the full pilot. Stable 2.1 runs the python engine, about 4x slower.

## 12. Extending beyond the pilot (estimated)

Scope as in `docs/methods/terrain.md` section 10: 14 one-degree cells holding Colorado's ski
ranges, 134,901 km2 (107.8 x the pilot). The pilot is unusually steep (16.8 % release, 41.6 %
footprint), so pilot rates give upper bounds.

| Item | Pilot measured | Statewide at pilot rates (upper bound) |
|---|---|---|
| PRA (wind shelter, memberships) | 11 s | 20 min |
| Flow-Py, one parameter set | 497 s wall on 5 cores; 1,781 CPU-s | 15 h wall on 5 cores; 53 CPU-hours |
| Display PRA, z9-z15 / z9-z14 | 4.72 / 2.08 MB | 509 / 224 MB |
| Display runout, z9-z15 / z9-z14 | 4.55 / 1.97 MB | 490 / 212 MB |
| Numeric | 8.04 MB | 867 MB (priority cells only, as for terrain) |

Plan, if pursued:

1. Calibrate before scaling. The binding constraint is not compute but the absence of a Colorado reference. Captain-level step (the project itself does not contact organizations): obtain permission for the CAIC regional runout layer or the CDOT path atlas; then compare inside the pilot (IoU/Dice per path, release-area overlap), and only then consider changing alpha, the canopy curve or the threshold, keeping a held-out set of paths for validation.
2. Forest: decide on a forest-structure input for the runout (CSFS canopy or the CAIC approach) with explicit semantics before enabling com4FlowPy forest friction.
3. Process per one-degree cell with real neighbouring DEM and canopy in a halo of at least 5 km (paths here reach 2.4 km; larger relief elsewhere), publish each cell's products masked to the cell.
4. Compute: about 4 CPU-hours per cell at pilot rates for one parameter set. GitHub-hosted `ubuntu-latest` runners have 4 vCPU and 16 GB RAM for public repositories (2 vCPU, 8 GB for private) and a 6 h limit per job (docs.github.com/en/actions/reference/runners/github-hosted-runners and /limits, read 2026-11-06), so one job per cell fits if runner CPUs are not much slower than this workstation (not measured). Memory is bounded by com4FlowPy tiling (at most 2.9 GB peak footprint here with 5 workers), not by region size.
5. Size: z15 statewide (about 1 GB for PRA plus runout) exceeds the 1 GB Pages budget shared with the basemap and terrain. Use z14 statewide (at most about 440 MB, less once gentle cells are measured) and z15 only for priority touring cells, and split archives to stay under 25 MB per file.

## 13. Reproduce

```
W=/Users/bci-spatialecon/firstmate/data/colorado-ski-map-build/work/avalanche
uv venv --python 3.12 $W/.venv && VIRTUAL_ENV=$W/.venv uv pip install -r pipeline/avalanche/requirements.txt
$W/.venv/bin/python pipeline/avalanche/prep_inputs.py
$W/.venv/bin/python pipeline/avalanche/pra.py
$W/.venv/bin/python pipeline/avalanche/runout.py
$W/.venv/bin/python pipeline/avalanche/avy_checks.py
$W/.venv/bin/python pipeline/avalanche/avy_products.py
$W/.venv/bin/python -m pytest tests/pipeline/test_avalanche.py
```

Requires the terrain lane's pilot rasters and, on a first run or with `--refetch-canopy`, network
access to data.fs.usda.gov for the canopy range read (the native clip is cached afterwards). com4FlowPy writes a `<uid>.json` copy of its full configuration next to each run.
