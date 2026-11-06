"""Station snapshot tests: AWDB record conversion and the committed snapshot against schemas/station.schema.json."""

import json
import sys
from pathlib import Path

import jsonschema
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "snow"))
import snotel_stations as ss  # noqa: E402

CFG = ss.load_config()
SCHEMA = json.loads((ROOT / "schemas" / "station.schema.json").read_text())
AWDB = {"stationTriplet": "335:CO:SNTL", "stationId": "335", "stateCode": "CO", "networkCode": "SNTL",
        "name": "Berthoud Summit", "countyName": "Grand", "huc": "1", "elevation": 11300.0, "latitude": 39.80,
        "longitude": -105.78, "dataTimeZone": -8.0, "shefId": "BSUC2", "beginDate": "1963-09-01 00:00",
        "stationElements": [
            {"elementCode": "SNWD", "ordinal": 1, "heightDepth": None, "durationName": "HOURLY", "storedUnitCode": "in", "beginDate": "2002-07-03 14:00"},
            {"elementCode": "SNWD", "ordinal": 1, "heightDepth": None, "durationName": "DAILY", "storedUnitCode": "in", "beginDate": "2002-07-03 14:00"},
            {"elementCode": "WTEQ", "ordinal": 2, "heightDepth": None, "durationName": "DAILY", "storedUnitCode": "in", "beginDate": "1990-01-01 00:00"}]}


def test_conversion() -> None:
    f = ss.to_feature(AWDB, CFG)
    assert f["geometry"]["coordinates"] == [-105.78, 39.80]
    p = f["properties"]
    assert p["elevationM"] == pytest.approx(3444.2) and p["elevationSource"] == {"value": 11300.0, "unit": "ft"}
    assert p["elements"] == {"SNWD": {"unit": "in", "dailyBegin": "2002-07-03", "hourlyBegin": "2002-07-03"}}
    assert p["dataTimeZoneOffsetHours"] == -8.0 and p["networkName"] == "SNOTEL"
    jsonschema.validate(f, SCHEMA)


def test_bad_location_skipped() -> None:
    assert ss.to_feature(AWDB | {"latitude": None}, CFG) is None
    assert ss.to_feature(AWDB | {"longitude": -250.0}, CFG) is None


def test_committed_snapshot_matches_schema() -> None:
    fc = json.loads((ROOT / CFG["snotel"]["out_geojson"]).read_text())
    assert len(fc["features"]) > 100
    v = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
    for f in fc["features"]:
        v.validate(f)
        lon, lat = f["geometry"]["coordinates"]
        assert -109.1 < lon < -102 and 36.9 < lat < 41.1  # Colorado, [lon, lat] order
