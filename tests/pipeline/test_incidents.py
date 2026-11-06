"""Incident import validation tests for pipeline/incidents/import_incidents.py (synthetic rows only)."""

import copy
import csv
import datetime as dt
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "incidents"))
import import_incidents as ii  # noqa: E402

CFG = ii.load_config()
TODAY = dt.date(2026, 11, 5)
NATIVE = CFG["profiles"]["native"]
CAIC = CFG["profiles"]["caic_us_fatal_xlsx"]


def native_row(**over: str) -> dict:
    row = {"source_event_id": "abc-1", "date": "2025-01-10", "place": "Berthoud Pass", "state": "CO",
           "lon": "-105.78", "lat": "39.80", "position_meaning": "accident_site", "uncertainty_m": "",
           "position_note": "", "activity": "Backcountry tourer", "caught": "2", "buried": "", "injured": "0",
           "killed": "1", "report_status": "Final Report", "url": "https://avalanche.state.co.us/reports/canonical/x",
           "summary": "", "verified_facts": "Two caught | One killed"}
    return row | over


def caic_row(**over: str) -> dict:
    row = {"YYYY": "2021", "MM": "2", "DD": "1", "Location": "Somewhere", "State": "CO", "lat": "39.5",
           "lon": "-106.1", "PrimaryActivity": "Backcountry Tourer", "Killed": "1", "Description": "text"}
    return row | over


def test_valid_row_keeps_lon_lat_order_and_nulls() -> None:
    feats, rejects = ii.convert([native_row()], NATIVE, "CAIC", CFG, TODAY)
    assert not rejects
    f = feats[0]
    assert f["geometry"]["coordinates"] == [-105.78, 39.80]
    p = f["properties"]
    assert p["id"] == "caic:abc-1" and p["season"] == "2024-2025" and p["reportStatus"] == "final"
    assert p["buried"] is None and p["injured"] == 0 and p["killed"] == 1
    assert p["verifiedFacts"] == ["Two caught", "One killed"]
    ii.validate(feats, ROOT / CFG["schema"])


@pytest.mark.parametrize("over,reason", [
    ({"lon": "39.80", "lat": "-105.78"}, "outside Colorado"),
    ({"lat": ""}, "only one of lon/lat"),
    ({"date": "2027-01-01"}, "future"),
    ({"date": "2025-02-30"}, "day is out of range"),
    ({"killed": "-1"}, "non-negative"),
    ({"caught": "1.5"}, "non-negative"),
    ({"report_status": "draft"}, "not recognised"),
    ({"position_meaning": "somewhere"}, "position meaning"),
    ({"url": "http://insecure.example"}, "not https"),
])
def test_bad_rows_are_rejected_not_repaired(over: dict, reason: str) -> None:
    feats, rejects = ii.convert([native_row(**over)], NATIVE, "CAIC", CFG, TODAY)
    assert not feats and reason in rejects[0]["reason"]


def test_duplicate_ids_rejected() -> None:
    feats, rejects = ii.convert([native_row(), native_row()], NATIVE, "CAIC", CFG, TODAY)
    assert len(feats) == 1 and "duplicate" in rejects[0]["reason"]


def test_caic_profile_zero_coords_unlocated_and_other_states_skipped() -> None:
    rows = [caic_row(), caic_row(lat="0.0", lon="0.0", DD="2"), caic_row(State="UT", lat="40.6", lon="-111.6")]
    feats, rejects = ii.convert(rows, CAIC, "CAIC", CFG, TODAY)
    assert not rejects and len(feats) == 2
    unlocated = [f for f in feats if f["geometry"] is None][0]
    assert unlocated["properties"]["position"]["meaning"] == "none"
    located = [f for f in feats if f["geometry"]][0]
    assert located["properties"]["position"]["meaning"] == "unknown"
    assert located["properties"]["upstreamId"] is None and located["id"].startswith("caic:2021-02-01:")
    assert located["properties"]["caught"] is None  # not in the sheet: unknown, never 0
    ii.validate(feats, ROOT / CFG["schema"])


def test_missing_csv_column_fails(tmp_path: Path) -> None:
    path = tmp_path / "in.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[k for k in caic_row() if k != "Killed"])
        w.writeheader()
        w.writerow({k: v for k, v in caic_row().items() if k != "Killed"})
    with pytest.raises(ValueError, match="Killed"):
        ii.check_columns(path, CAIC)


def test_cli_refuses_import_without_authorization(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        ii.main([str(tmp_path / "x.csv"), "--source", "CAIC", "--root", str(tmp_path)])


def test_empty_dataset_and_committed_file_validate(tmp_path: Path) -> None:
    assert ii.main(["--empty", "--reason", "test", "--root", str(tmp_path)]) == 0
    fc = json.loads((tmp_path / CFG["out_geojson"]).read_text())
    assert fc == {"type": "FeatureCollection", "features": []}
    committed = json.loads((ROOT / CFG["out_geojson"]).read_text())
    ii.validate(committed["features"], ROOT / CFG["schema"])


def test_schema_rejects_missing_position() -> None:
    feats, _ = ii.convert([native_row()], NATIVE, "CAIC", CFG, TODAY)
    bad = copy.deepcopy(feats[0])
    del bad["properties"]["position"]
    with pytest.raises(Exception):
        ii.validate([bad], ROOT / CFG["schema"])
