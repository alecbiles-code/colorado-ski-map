# Routes and places pipeline

Builds the static route, ski-area, place, region and search products for Skintrack CO from open sources. Everything runs offline on a workstation; the browser only reads the finished files.

## 1. Outputs

| File | Contents |
|---|---|
| `data/routes/routes.geojson` | `ski_descent`, `ascent_skin`, `approach`, `touring_area` features (OSM + USFS) with DEM metrics |
| `data/routes/ski-areas.geojson` | OpenSkiData ski areas (lift-served, nordic, abandoned), class `ski_area` |
| `data/places/places.geojson` | `peak`, `pass`, `trailhead`, `parking`, `hut` points (OSM + USGS GNIS) |
| `data/places/search.json` | Columnar search index (`fields` + `rows`) over every named feature |
| `data/coverage/regions.geojson` | App-defined reporting regions (approximations, not official boundaries) |
| `data/land/land-status.geojson` | BLM Surface Management Agency polygons for Colorado, one per managing agency, generalised to about 30 m (`land.py`). Managing agency only, not access or legal parking |

Each file has a sibling `*.meta.json` (sources, license, attribution, retrieval times, processing steps and parameters, bbox, counts, byte size, limitations). Schemas: `schemas/route.schema.json`, `schemas/place.schema.json`.

## 2. Setup

```
uv venv --python 3.12 <work_dir>/.venv
uv pip install --python <work_dir>/.venv/bin/python -r pipeline/routes/requirements.txt
```

All paths, URLs, tag rules, buffers and tolerances are in `config.yaml`. Set `paths.work_dir` (downloads, caches, interim files; never committed) and `paths.repo_dir` for your machine.

## 3. Run

```
PY="<work_dir>/.venv/bin/python -B -E -s"   # -B: no __pycache__ in the repo
$PY pipeline/routes/fetch.py          # one download per source; existing files are kept (OpenSkiData allows at most one automated download per day)
$PY pipeline/routes/osm_extract.py    # DuckDB ST_ReadOSM: tag census + candidate ways/nodes (about 10 s)
$PY pipeline/routes/build.py          # classify, lift-served filter, DEM metrics, regions, search, metas
$PY pipeline/routes/land.py           # land-status layer (one BLM SMA query, cached)
$PY pipeline/routes/coverage.py       # markdown count tables for docs/coverage-routes.md
$PY -m pytest -p no:cacheprovider pipeline/routes/test_routes.py
```

`build.py --no-dem` skips the DEM step (dem* fields stay null). DEM tiles are cached under `<work_dir>/cache/mapterhorn`, so only the first run downloads them; `sources.dem.max_tiles` guards against an accidental statewide download.

## 4. Method summary

1. OSM ways are candidates only if they carry `piste:type`, a winter access tag (`ski`, `ski:nordic`, `snowshoe` = yes/designated/permissive/official), or belong to a `route=piste`/`route=ski` relation (relation piste tags fill ways that lack their own). A summer path without such a tag is never included.
2. `classify.py` maps tags to classes. Downhill pistes become `ski_descent`; undirected ski-tour ways become `ascent_skin` unless they run on a road or track (`approach`) or the source name names a descent feature (`ski_descent`); groomed and unknown-grooming nordic trails are excluded as pistes; ungroomed nordic, winter-hike and snowshoe routes and winter-access paths become `approach`. Closed downhill or tour ways become `touring_area`. Each feature keeps `classBasis`.
3. Lift-served context: candidates within 500 m of an operating downhill ski-area polygon, 3 km of an operating or proposed ski-area point that has no polygon, or 1 km of a lift are excluded and counted in `routes.meta.json` (`classificationCensus`). Abandoned ski areas (Berthoud Pass, Hidden Valley) are not lift-served.
4. USFS TrailNFS segments whose `allowed_snow_use` includes snowshoe or cross-country ski, or that have a managed snowshoe or ski season, are added as `approach`.
5. DEM metrics: lines are densified to at most 7.5 m spacing and sampled bilinearly from Mapterhorn terrain tiles (Terrarium-encoded WebP, 512 px) at zoom 13, about 7.4 m pixels at 39 N (contract Tier 1 DEM, attribution "© Mapterhorn"). Requests send the identifying User-Agent from `config.yaml`, because the endpoint returns 403 to the default one. `demGainM`/`demLossM` are raw sums of sampled steps. `demMeanAspectDeg` (descents only) is the circular mean of the Horn 3x3 downslope aspect, in degrees clockwise from true north. `demAspectResultant` shows how consistent it is.
6. Places: OSM peaks and passes are matched to the nearest GNIS Summit/Gap within 300 m (`gnisId`, `gnisNameMatch`); GNIS features without an OSM counterpart are added. Parking is kept only within 250 m of a trailhead. Peaks with no source elevation get `demElevationM`, a Mapterhorn z13 bilinear sample at the point. `elevationM` is kept as the source value and stays null when the source has none.
7. Geometry is simplified with `ST_SimplifyPreserveTopology` at 0.00003 degrees (about 3 m) and rounded to 5 decimals.

## 5. Sources and terms

See `docs/lanes/routes.md` for the terms text relied on, and `docs/coverage-routes.md` for coverage. COTREX is link-only (its terms forbid redistribution and use of its location data to build other datasets).
