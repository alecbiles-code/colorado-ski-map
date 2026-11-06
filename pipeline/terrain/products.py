"""Shared product helpers: geographic bounds, coverage polygon and the *.meta.json writer."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from pyproj import Transformer

from terrain_core import LOG, REPO_ROOT

LIMITATIONS = [
    "Slope classes describe steepness only. They are not a hazard rating and do not say whether "
    "any slope is safe to ski.",
    "Computed from a 10 m grid resampled from the USGS 3DEP 1/3 arc-second DEM. Features smaller "
    "than about 20-30 m (cliff bands, gullies, cornices, rollovers) are smoothed or missing; "
    "short steep pitches can be steeper than shown.",
    "Snow depth, wind loading and cornices change the real surface; this is bare-earth terrain.",
    "Aspect is degrees clockwise from true north: computed on the UTM 13N grid, then corrected by "
    "the meridian convergence at each cell (0.39-0.65 degrees in the pilot).",
]


def coverage_ring(region: dict[str, Any], step_m: float = 1000.0) -> list[list[float]]:
    """Coverage as a closed lon/lat ring: the 1x1 degree cell if the region has one, else the
    region grid boundary densified so it follows the UTM edges."""
    if "cell" in region:
        w, s, e, n = region["cell"]
        return [[w, s], [e, s], [e, n], [w, n], [w, s]]
    xmin, ymin, xmax, ymax = region["bounds"]
    t = Transformer.from_crs(region["crs"], "EPSG:4326", always_xy=True)
    pts = []
    for (x0, y0), (x1, y1) in [((xmin, ymin), (xmax, ymin)), ((xmax, ymin), (xmax, ymax)),
                               ((xmax, ymax), (xmin, ymax)), ((xmin, ymax), (xmin, ymin))]:
        k = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) // step_m))
        pts += [(x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k) for i in range(k)]
    ring = [[round(v, 6) for v in t.transform(x, y)] for x, y in pts]
    return ring + [ring[0]]


def geo_bounds(region: dict[str, Any]) -> tuple[float, float, float, float]:
    """(west, south, east, north) degrees enclosing the region grid."""
    ring = coverage_ring(region)
    lons, lats = [p[0] for p in ring], [p[1] for p in ring]
    return min(lons), min(lats), max(lons), max(lats)


def tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Web Mercator tile containing lon/lat at zoom z."""
    n = 2 ** z
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int((lon + 180) / 360 * n), int(y)


def sha256(path: Path) -> str:
    """Hex SHA-256 of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sources(cfg: dict[str, Any], region: dict[str, Any], region_id: str) -> list[dict[str, Any]]:
    """Provenance entries for the 3DEP tiles a region was built from."""
    src = cfg["source"]
    role = lambda t: "cell" if t == region_id else "edge buffer" if "cell" in region else "area"  # noqa: E731
    return [{"name": f"{src['name']} tile {t}", "tile": t, "role": role(t), "url": src["tiles"][t]["url"],
             "landingPage": src["landing_page"], "publicationDate": src["tiles"][t]["publication_date"],
             "etag": src["tiles"][t]["etag"], "license": src["license"],
             "attribution": "U.S. Geological Survey, 3D Elevation Program"} for t in region["tiles"]]


def write_meta(cfg: dict[str, Any], region_id: str, pid: str, path: Path, kind: str,
               extra: dict[str, Any]) -> Path:
    """Write <pid>.meta.json next to a product file.

    Args:
        cfg: Pipeline config.
        region_id: Region key.
        pid: Product id (file stem).
        path: Product file.
        kind: "display" or "numeric".
        extra: Product-specific fields merged into the record.

    Returns:
        Path of the written meta file.
    """
    region = cfg["regions"][region_id]
    meta = {
        "id": pid, "kind": f"terrain-{kind}", "tier": 2, "region": region_id,
        "url": f"./data/terrain/{path.name}", "bytes": path.stat().st_size, "sha256": sha256(path),
        "processedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
        .replace("+00:00", "Z"),
        "sources": sources(cfg, region, region_id),
        "processing": {"script": f"pipeline/terrain/{'display' if kind == 'display' else 'numeric'}"
                                 "_tiles.py", "config": "pipeline/terrain/config.yaml",
                       **{k: v for k, v in cfg["processing"].items() if k != "geo_margin_deg"},
                       "slopeMethod": "Horn (1981) 3x3, degrees",
                       "aspectConvention": "degrees clockwise from true north (UTM grid aspect "
                                           "plus meridian convergence at the cell centre); -1 flat"},
        "analysisGrid": {"crs": region["crs"], "resM": region["res_m"], "bounds": region["bounds"]},
        "verticalDatum": cfg["source"]["vertical_datum"], "units": {"elevation": "m",
                                                                   "slope": "degrees", "aspect": "degrees"},
        "bbox": [round(v, 6) for v in geo_bounds(region)],
        "coverage": {"type": "Polygon", "coordinates": [coverage_ring(region)]},
        "limitations": LIMITATIONS, "methods": "docs/methods/terrain.md",
    } | extra
    out = path.with_name(f"{pid}.meta.json")
    out.write_text(json.dumps(meta, indent=2) + "\n")
    LOG.info("wrote %s", out.relative_to(REPO_ROOT))
    return out
