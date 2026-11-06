# pipeline/incidents

`import_incidents.py` validates an authorized accident file (CSV or GeoJSON) into `data/incidents/incidents.geojson` (schema `schemas/incident.schema.json`) and `incidents.meta.json`. It refuses to run without `--source` and `--authorization`, which is recorded in the meta file with the input's SHA-256.

The committed dataset is empty on purpose: no source was found whose terms clearly permit republishing accident records (CAIC terms prohibit robots and data mining and require prior written permission to reproduce; see `docs/methods/snow-sar-incidents.md`). The app shows `data/incidents/official-links.json` instead.

What unlocks the layer: written permission from CAIC (Request for API Access form on https://avalanche.state.co.us/contact, or caic@state.co.us) to republish, in a personal non-commercial map, the date, location name, latitude/longitude, activity and number killed from its US fatal accident spreadsheet (or a feed of its accident reports with report UUIDs and status). Then:

```sh
uv pip install -r pipeline/incidents/requirements.txt
# Save the spreadsheet's Data sheet as CSV, then:
.venv/bin/python pipeline/incidents/import_incidents.py caic.csv --profile caic_us_fatal_xlsx --source CAIC \
    --authorization "CAIC written permission <date>, <reference>"
.venv/bin/python -m pytest tests/pipeline/test_incidents.py
```

Rows are rejected, never repaired: future or invalid dates, half-missing or out-of-Colorado coordinates (catches swapped lon/lat), negative or fractional counts, unknown report status or position meaning, non-https URLs, duplicates. `0, 0` coordinates in the CAIC sheet mean missing and become unlocated records (geometry null). Exit code 1 when any row was rejected; reasons are in the meta file.
