"""Seam check: two processed regions must give identical DEM, slope and aspect where their analysis
grids overlap (they share the 10 m lattice, the source lattice and the warp settings).

Usage: python seam_check.py n40w106 n40w107 [more region ids ...]   (checks every overlapping pair)
"""

from __future__ import annotations

import argparse
import itertools
import json

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from terrain_core import LOG, load_config, setup_logging


def overlap(a: list[float], b: list[float]) -> list[float] | None:
    """Intersection of two (xmin, ymin, xmax, ymax) boxes, or None."""
    box = [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]
    return box if box[0] < box[2] and box[1] < box[3] else None


def compare(cfg: dict, ra: str, rb: str, box: list[float]) -> dict[str, int | float]:
    """Cells compared, identical cells and max |difference| per raster over box."""
    out: dict[str, int | float] = {}
    for name in ("dem", "slope", "aspect"):
        vals = []
        for rid in (ra, rb):
            with rasterio.open(cfg["work_dir"] / f"{rid}_{name}_26913_10m.tif") as s:
                vals.append(s.read(1, window=from_bounds(*box, s.transform)).astype(np.float64))
        d = np.abs(vals[0] - vals[1])
        out[f"{name}_cells"], out[f"{name}_identical"] = int(d.size), int((d == 0).sum())
        out[f"{name}_max_abs_diff"] = float(d.max())
    return out


def run(regions: list[str]) -> None:
    """Check every overlapping pair; append results to <work>/seam_checks.json."""
    cfg = load_config()
    path = cfg["work_dir"] / "seam_checks.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    for ra, rb in itertools.combinations(regions, 2):
        box = overlap(cfg["regions"][ra]["bounds"], cfg["regions"][rb]["bounds"])
        if box is None:
            continue
        results[f"{ra}|{rb}"] = {"box": box, **compare(cfg, ra, rb, box)}
        LOG.info("seam %s|%s: %s", ra, rb, json.dumps(results[f"{ra}|{rb}"]))
    path.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("regions", nargs="+")
    run(ap.parse_args().regions)
