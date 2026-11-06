"""Statewide cost estimate from measured regions: bytes and runtime per km^2, scaled to the
configured Colorado mountain cells, checked against GitHub Pages limits.

Usage: python estimate_statewide.py
"""

from __future__ import annotations

import json
import math
from typing import Any

from terrain_core import LOG, load_config, setup_logging

EARTH_R_KM = 6371.0


def cell_area_km2(name: str) -> float:
    """Area of a 1x1 degree cell named by its NW corner (e.g. n40w107), spherical earth."""
    north = int(name[1:3])
    return EARTH_R_KM ** 2 * math.radians(1.0) * (
        math.sin(math.radians(north)) - math.sin(math.radians(north - 1)))


def region_area_km2(region: dict[str, Any]) -> float:
    """Area of a region: its 1x1 degree cell if it has one, else its UTM grid rectangle."""
    if "cell" in region:
        return cell_area_km2(f"n{region['cell'][3]}w{-region['cell'][0]}")
    xmin, ymin, xmax, ymax = region["bounds"]
    return (xmax - xmin) * (ymax - ymin) / 1e6


def rates(cfg: dict[str, Any], region_id: str) -> dict[str, Any]:
    """Measured bytes and seconds per km^2 for one processed region."""
    out_dir, work = cfg["out_dir"], cfg["work_dir"]
    disp = json.loads((out_dir / f"terrain-slope-{region_id}.meta.json").read_text())
    nums = [json.loads(p.read_text()) for p in sorted(out_dir.glob(f"terrain-numeric-{region_id}*.meta.json"))]
    num_bytes, num_secs = sum(m["bytes"] for m in nums), sum(m["processingSeconds"] for m in nums)
    build = json.loads((work / f"{region_id}_build_record.json").read_text())
    area = region_area_km2(cfg["regions"][region_id])
    per_zoom = {int(z): v["bytes"] for z, v in disp["perZoom"].items()}
    measure = work / f"{region_id}_display_measure_z15.meta.json"  # full-zoom run kept for sizing
    if measure.exists():
        per_zoom |= {int(z): v["bytes"] for z, v in json.loads(measure.read_text())["perZoom"].items()}
    display = {mz: sum(b for z, b in per_zoom.items() if z <= mz) / area
               for mz in cfg["statewide"]["candidate_max_zooms"] if mz in per_zoom}
    secs = build["compute_s"] + disp["processingSeconds"] + num_secs
    return {"area_km2": round(area, 1), "display_bytes_per_km2": display,
            "numeric_bytes_per_km2": num_bytes / area, "compute_s_per_km2": secs / area,
            "fetch_s": build["fetch_s"], "source_bytes": build["source_bytes"]}


def scale(cfg: dict[str, Any], r: dict[str, Any], area: float) -> dict[str, Any]:
    """Statewide totals and per-cell file counts implied by one set of rates."""
    sw = cfg["statewide"]
    cell = area / len(sw["cells"])
    out = {"numeric_bytes": r["numeric_bytes_per_km2"] * area,
           "numeric_files_per_cell": math.ceil(r["numeric_bytes_per_km2"] * cell / sw["file_limit_bytes"]),
           "compute_hours": r["compute_s_per_km2"] * area / 3600, "display": {}}
    for mz, b in r["display_bytes_per_km2"].items():
        total = b * area
        out["display"][mz] = {"bytes": total,
                              "files_per_cell": math.ceil(b * cell / sw["file_limit_bytes"]),
                              "with_numeric_fits_pages": total + out["numeric_bytes"]
                              <= sw["pages_site_limit_bytes"],
                              "alone_fits_pages": total <= sw["pages_site_limit_bytes"]}
    return out


def run() -> None:
    """Write statewide_estimate.json to the work dir and log a summary."""
    cfg = load_config()
    sw = cfg["statewide"]
    area = sum(cell_area_km2(c) for c in sw["cells"])
    report = {"cells": sw["cells"], "area_km2": round(area), "download_bytes":
              len(sw["cells"]) * sw["tile_bytes_typical"], "by_measured_region": {}}
    for rid in sw["measured"]:
        r = rates(cfg, rid)
        report["by_measured_region"][rid] = {"rates": r, "statewide": scale(cfg, r, area)}
    (cfg["work_dir"] / "statewide_estimate.json").write_text(json.dumps(report, indent=2))
    LOG.info("%s", json.dumps(report, indent=1))


if __name__ == "__main__":
    setup_logging()
    run()
