# pipeline/sar

The SAR avalanche inventory is not rebuilt here. The two archives stay in the avalanche-inventory app (`https://alecbiles-code.github.io/avalanche-inventory/all_seasons.pmtiles`, `cross_season_hotspot.pmtiles`, 67 and 74 MB) and this app reads them by HTTP range requests on the same origin. Nothing is copied into this repository.

`inspect_pmtiles.py ARCHIVE LAYER` prints the measured facts (header, metadata, tile bytes per zoom, unique features by season and confidence at max zoom) used in `data/sar/sar-inventory.meta.json`. Re-run it after the inventory is rebuilt (for example the v3 detector) and update the meta file and `data/sar/coverage.geojson`.

```sh
uv pip install -r pipeline/sar/requirements.txt
.venv/bin/python pipeline/sar/inspect_pmtiles.py ../avalanche-inventory/all_seasons.pmtiles avalanches > seasonal.json
.venv/bin/python pipeline/sar/inspect_pmtiles.py ../avalanche-inventory/cross_season_hotspot.pmtiles hotspots > hotspots.json
```
