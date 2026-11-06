"""Checks for the routes pipeline: regions, tag rules, DEM math, outputs vs schemas.

Run: <venv>/bin/python -m pytest pipeline/routes/test_routes.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from build import effective_tags
from classify import classify_way, is_area
from common import load_config, repo_path
from dem import circular_mean_deg, decode_terrarium, gain_loss, horn_aspect_deg, lonlat_to_pixel, pixel_size_m
from places import norm_name, parse_ele
from regions import load_regions, region_for

CFG = load_config()
ALLOWED = set(CFG["osm_rules"]["winter_access_values"])


def test_yaml_access_values_are_strings():
    assert "yes" in ALLOWED and True not in ALLOWED


@pytest.mark.parametrize("lon,lat,expected", CFG["region_anchors"])
def test_region_anchors(lon, lat, expected):
    assert region_for(load_regions(CFG), lon, lat) == expected


@pytest.mark.parametrize("tags,cls", [
    ({"piste:type": "downhill", "piste:grooming": "backcountry"}, "ski_descent"),
    ({"piste:type": "skitour", "highway": "path"}, "ascent_skin"),
    ({"piste:type": "skitour", "highway": "track"}, "approach"),
    ({"piste:type": "skitour", "name": "Mount Columbia Southwest Coulior"}, "ski_descent"),
    ({"piste:type": "uphill"}, "ascent_skin"),
    ({"piste:type": "nordic", "piste:grooming": "classic+skating"}, None),
    ({"piste:type": "nordic"}, None),
    ({"piste:type": "nordic", "piste:grooming": "backcountry"}, "approach"),
    ({"piste:type": "hike"}, "approach"),
    ({"piste:type": "fatbike"}, None),
    ({"highway": "path", "ski": "yes"}, "approach"),
    ({"highway": "path", "ski": "no"}, None),
    ({"highway": "path"}, None),
    ({"highway": "path", "snowmobile": "yes"}, None),
])
def test_classify(tags, cls):
    assert classify_way(tags, ALLOWED)[0] == cls


def test_area_and_relation_inheritance():
    assert is_area({"piste:type": "downhill"}, True)
    assert not is_area({"piste:type": "nordic"}, True)
    assert not is_area({"piste:type": "downhill", "area": "no"}, True)
    merged = effective_tags({"highway": "path"}, {"piste:type": "hike", "name": "Loop", "route": "piste"})
    assert merged["piste:type"] == "hike" and merged["name"] == "Loop" and "route" not in merged
    assert effective_tags({"piste:type": "nordic"}, {"piste:type": "hike"})["piste:type"] == "nordic"


def test_terrarium_decode_and_tiles():
    assert decode_terrarium(np.array([[[128, 0, 0]]]))[0, 0] == 0.0
    assert decode_terrarium(np.array([[[140, 186, 128]]]))[0, 0] == pytest.approx(12 * 256 + 186 + 0.5)
    for size in (256, 512):  # AWS PNG and Mapterhorn WebP tiles share z/x/y indexing
        x, y = lonlat_to_pixel(-105.777, 39.798, 13, size)
        assert (int(x // size), int(y // size)) == (1688, 3107)  # tile verified against both live endpoints
    assert pixel_size_m(39.0, 13, 256) == pytest.approx(14.85, abs=0.01)
    assert pixel_size_m(39.0, 13, 512) == pytest.approx(7.43, abs=0.01)


def plane(dzdx: float, dzdnorth: float, cell: float = 10.0) -> np.ndarray:
    """3x3 window of z = dzdx*east + dzdnorth*north; row 0 is north."""
    return np.array([[dzdx * (c - 1) * cell + dzdnorth * (1 - r) * cell for c in range(3)] for r in range(3)])


@pytest.mark.parametrize("dzdx,dzdn,aspect", [(1, 0, 270), (-1, 0, 90), (0, 1, 180), (0, -1, 0), (-1, -1, 45)])
def test_horn_aspect_on_planes(dzdx, dzdn, aspect):
    got = horn_aspect_deg(plane(dzdx, dzdn), 10.0)
    assert min(abs(got - aspect), 360 - abs(got - aspect)) < 1e-6
    assert horn_aspect_deg(plane(0, 0), 10.0) is None


def test_circular_mean_and_gain_loss():
    mean, r = circular_mean_deg([350.0, 10.0])
    assert min(mean, 360 - mean) < 1e-9 and r == pytest.approx(math.cos(math.radians(10)))
    assert gain_loss([100, 110, 105, 120]) == (25.0, 5.0)


def test_parse_ele_and_names():
    assert parse_ele("4345", 1000, 4410) == 4345.0
    assert parse_ele("14,259 ft", 1000, 4410) == pytest.approx(4346.1, abs=0.1)
    assert parse_ele("14259", 1000, 4410) is None  # feet without a unit: implausible as metres, not converted
    assert parse_ele("high", 1000, 4410) is None
    assert norm_name("Mt. Elbert") == norm_name("Mount Elbert")


@pytest.mark.parametrize("product,schema", [
    ("data/routes/routes.geojson", "schemas/route.schema.json"),
    ("data/places/places.geojson", "schemas/place.schema.json"),
    ("data/routes/ski-areas.geojson", "schemas/place.schema.json"),
])
def test_outputs_match_schema(product, schema):
    jsonschema = pytest.importorskip("jsonschema")
    path = repo_path(CFG, product)
    if not path.exists():
        pytest.skip(f"{product} not built")
    data = json.loads(path.read_text())
    validator = jsonschema.Draft202012Validator(json.loads(repo_path(CFG, schema).read_text()))
    errors = list(validator.iter_errors(data))
    assert not errors, errors[0].message
    ids = [f["id"] for f in data["features"]]
    assert len(ids) == len(set(ids)), "duplicate ids"
    assert Path(path).stat().st_size <= CFG["outputs"]["max_file_bytes"]
