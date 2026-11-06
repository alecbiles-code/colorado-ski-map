# pipeline/terrain

Tier 2 analytical terrain (docs/ARCHITECTURE.md 3.3): USGS 3DEP 1/3 arc-second DEM to a 10 m UTM 13N analysis grid, Horn slope and aspect, a classified slope display archive and a numeric inspection archive. Method, parameters, test results and limitations: `docs/methods/terrain.md`.

## 1. Setup

```
W=<work_dir from config.yaml>
uv venv --python 3.12 $W/.venv
uv pip install --python $W/.venv/bin/python -r pipeline/terrain/requirements.txt
npm install --prefix $W/node pmtiles@4.5.0      # only for verify_numeric.py
```

All settings (paths, source URLs, grid, quantization, classes, colors, zooms) are in `config.yaml`. Scripts import each other, so run them from this folder: `( cd pipeline/terrain && $W/.venv/bin/python <script> --region pilot )`.

## 2. Run order for one region

1. `build_analysis.py`: fetch (windowed COG reads, cached in the work dir), reproject, quantize to 0.1 m, slope, aspect. Writes `<work>/<region>_{dem,slope,aspect}_26913_10m.tif` (float32, NoData -9999) and the buffered DEM.
2. `gdal_check.py`: independent check with GDAL `gdaldem` (Horn) through the libgdal inside the rasterio wheel.
3. `display_tiles.py`: `data/terrain/terrain-slope-<region>.pmtiles` and `.meta.json`.
4. `numeric_tiles.py`: `data/terrain/terrain-numeric-<region>.pmtiles` and `.meta.json`.
5. `verify_numeric.py`: decodes random points through pmtiles + `app/lib/terrain-math.js` in node and compares with the GeoTIFFs.
6. `tier1_compare.py`, then `tier1_vintage.py`: browser tier (AWS Terrain Tiles) against Tier 2.
7. `estimate_statewide.py`: statewide size and runtime from the measured regions.

Tests: `$W/.venv/bin/python -m pytest tests/pipeline` and `node --test tests/terrain-math.test.mjs` from the repo root.

## 3. Adding a region

Add an entry under `regions` (UTM bounds on multiples of 10 m; for a 1x1 degree cell also `cell: [west, south, east, north]` and `display_max_zoom: 14`), list every 3DEP tile the buffered grid touches (for a cell: the cell's tile and its eight neighbours) under `source.tiles` with its dated URL, publication date and ETag from the TNM Access API, then run steps 1 to 5. For a cell, download the cell's own tile once to `<work_dir>/3dep/<file name>` (`curl -o`); `build_analysis.py` uses a local copy when present and reads neighbours remotely. Numeric archives of a cell are written as four 0.5 degree parts (`<cell>-nw`, `-ne`, `-sw`, `-se`). Check the seam against an already processed neighbour: DEM, slope and aspect must be identical in the overlap.
