# pipeline/avalanche: experimental PRA and Flow-Py runout pilot

Builds the experimental avalanche terrain model for the shared pilot grid (EPSG:26913, 10 m,
Berthoud Pass / Jones Pass / Loveland Pass). Method, parameters, results and limitations:
`docs/methods/avalanche-model.md`. The products are experimental terrain modeling, never a hazard
rating, ATES rating or safety statement.

## 1. Setup

Python 3.12 with uv, venv outside the repo (work dir in `config.yaml`):

```
W=/Users/bci-spatialecon/firstmate/data/colorado-ski-map-build/work/avalanche
uv venv --python 3.12 $W/.venv
VIRTUAL_ENV=$W/.venv uv pip install -r pipeline/avalanche/requirements.txt
```

`avaframe==2.2b1` is a PyPI pre-release, pinned because it is the first release with the
com4FlowPy numba engine (bit-identical to the python engine on the check window, about 4x faster
there).

## 2. Run (from the repository root)

```
$W/.venv/bin/python pipeline/avalanche/prep_inputs.py   # snapshot terrain DEM/slope, fetch canopy
$W/.venv/bin/python pipeline/avalanche/pra.py           # wind shelter, PRA continuous + binary
$W/.venv/bin/python pipeline/avalanche/runout.py        # 4 com4FlowPy runs (primary + sensitivity)
$W/.venv/bin/python pipeline/avalanche/avy_checks.py    # co-registration, edges, sensitivity, SAR overlap
$W/.venv/bin/python pipeline/avalanche/avy_products.py  # data/avalanche/*.pmtiles, *.geojson, *.meta.json
$W/.venv/bin/python -m pytest tests/pipeline/test_avalanche.py
```

Inputs: the terrain lane's pilot rasters (`pipeline/terrain`, paths in `config.yaml`) must exist
first. Canopy is read by HTTP range from the USFS zip (no full 3.6 GB download); the native
clip is cached in `work_dir/inputs` and reused unless `prep_inputs.py --refetch-canopy` is given.

## 3. Files

| File | Purpose |
|---|---|
| `config.yaml` | Every path, parameter, class and colour |
| `avy_core.py` | Config, grid checks, raster IO, Cauchy membership, fuzzy AND, wind shelter (numba) |
| `prep_inputs.py` | Terrain snapshot with sha256; canopy clip and nearest reprojection |
| `pra.py` | PRA continuous and binary (primary and sensitivity thresholds) |
| `runout.py` | com4FlowPy runs; wall time, peak memory, output bytes |
| `avy_checks.py` | analysis.json: co-registration, NoData, edge/truncation band, sensitivity, SAR overlap |
| `avy_tiles.py` | PNG PMTiles pyramid (nearest, max-class overviews) and numeric UTM blocks |
| `avy_products.py` | Web products and meta files |

## 4. Outputs

Work dir (not committed): `inputs/`, `pra/`, `runout/<run>/res_<uid>/` (com4FlowPy GeoTIFFs and
`<uid>.json` config), `analysis.json`, `logs/`. Repository: `data/avalanche/`.
