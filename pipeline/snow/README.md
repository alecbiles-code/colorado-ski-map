# pipeline/snow

Snow observation and snow-model products. Method, formats, time semantics and test records: `docs/methods/snow-sar-incidents.md`.

1. `snotel_stations.py` writes `data/snow/snotel-stations.geojson` and `.meta.json`: active Colorado SNOTEL (SNTL) and SNOLITE (SNTLT) stations from the keyless NRCS AWDB REST API, with location, elevation (metres, source feet kept), hourly data time zone offset, begin dates and the elements each station reports. Observations are not stored; the app fetches them at runtime. Rebuild by hand each autumn or when NRCS adds stations.
2. `snodas.py` writes `data/snow/snodas.meta.json` and `data/snow/snodas/<date>/`: the newest NSIDC G02158 masked SNODAS day, snow depth and SWE, subset to Colorado plus about 0.25 degree, as palette PNGs on a Web Mercator grid (MapLibre image source) and numeric int16 chunks for tap sampling. `.github/workflows/snodas.yml` runs it daily and publishes to the `data` branch.
3. `config.yaml` holds every URL, bound, class break and colour.

## Run

```sh
uv venv --python 3.12 .venv && uv pip install -r pipeline/snow/requirements.txt pytest==9.2.0 jsonschema==4.26.0
.venv/bin/python pipeline/snow/snotel_stations.py            # about 10 s
.venv/bin/python pipeline/snow/snodas.py                     # newest day; a few seconds; the tar is 8 MB in early November, up to about 35 MB midwinter
.venv/bin/python pipeline/snow/snodas.py --date 2026-11-05 --tar SNODAS_20261105.tar   # offline rebuild
.venv/bin/python -m pytest tests/pipeline/test_snodas.py tests/pipeline/test_snow_stations.py
```

`snodas.py` exits 0 without writing when the published product already has the newest date (`--force` rebuilds). It keeps the two newest dated directories.
