"""Verify the numeric inspection product against the analysis rasters.

Random points inside the region (plus its four corner cells) go through the browser decode path
(verify_numeric.mjs: pmtiles + app/lib/terrain-math.js). Each result is compared with the
GeoTIFF cell containing the point and with a float64 Horn recomputation in Python.

Usage: python verify_numeric.py --region pilot
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import Transformer

from terrain_core import (LOG, load_config, meridian_convergence_deg, setup_logging, slope_aspect,
                          slope_class_index, true_north_aspect)


def sample_points(region: dict[str, Any], count: int, seed: int) -> np.ndarray:
    """Random UTM points plus four corner points: inside the grid, or inside the 1x1 degree cell."""
    rng = np.random.default_rng(seed)
    if "cell" in region:  # uniform in lon/lat over the cell; corners just inside the cell
        w, s, e, n = region["cell"]
        d = 1e-4
        lon = np.concatenate([[w + d, w + d, e - d, e - d], rng.uniform(w, e, count)])
        lat = np.concatenate([[s + d, n - d, s + d, n - d], rng.uniform(s, n, count)])
        x, y = Transformer.from_crs("EPSG:4326", region["crs"], always_xy=True).transform(lon, lat)
        return np.column_stack([x, y])
    xmin, ymin, xmax, ymax = region["bounds"]
    h = region["res_m"] / 2
    pts = np.column_stack([rng.uniform(xmin, xmax, count), rng.uniform(ymin, ymax, count)])
    corners = np.array([[xmin + h, ymin + h], [xmin + h, ymax - h], [xmax - h, ymin + h],
                        [xmax - h, ymax - h]])
    return np.vstack([corners, pts])


def expected(cfg: dict[str, Any], region_id: str, utm: np.ndarray) -> dict[str, np.ndarray]:
    """GeoTIFF values and float64 recomputation at the cells containing the points."""
    region, work = cfg["regions"][region_id], cfg["work_dir"]
    xmin, _, _, ymax = region["bounds"]
    cols = np.floor((utm[:, 0] - xmin) / region["res_m"]).astype(int)
    rows = np.floor((ymax - utm[:, 1]) / region["res_m"]).astype(int)
    out = {}
    for name in ("dem", "slope", "aspect"):
        with rasterio.open(work / f"{region_id}_{name}_26913_10m.tif") as s:
            out[name] = s.read(1)[rows, cols].astype(np.float64)
    b, scale = cfg["processing"]["buffer_cells"], cfg["processing"]["dem_scale"]
    with rasterio.open(work / f"{region_id}_dem_buffered_26913_10m.tif") as s:
        zb = np.round(s.read(1).astype(np.float64) * scale) / scale
    s64, a64 = [], []
    for r, c in zip(rows + b, cols + b):
        s_, a_ = slope_aspect(zb[r - 1:r + 2, c - 1:c + 2], region["res_m"], region["res_m"],
                              cfg["processing"]["flat_threshold_deg"])
        s64.append(s_[1, 1])
        a64.append(a_[1, 1])
    conv = meridian_convergence_deg(xmin + (cols + 0.5) * region["res_m"],
                                    ymax - (rows + 0.5) * region["res_m"])
    out["slope64"], out["aspect64"] = np.array(s64), true_north_aspect(np.array(a64), conv)
    return out


def run_node(cfg: dict[str, Any], region_id: str, lonlat: np.ndarray) -> list[dict[str, Any]]:
    """Run verify_numeric.mjs on the points and return its parsed results."""
    pts = cfg["work_dir"] / f"{region_id}_verify_points.json"
    pts.write_text(json.dumps(lonlat.tolist()))
    product = "parts" if "cell" in cfg["regions"][region_id] else f"terrain-numeric-{region_id}"
    script = Path(__file__).with_name("verify_numeric.mjs")
    res = subprocess.run(["node", str(script), str(cfg["out_dir"]), product, str(pts),
                          cfg["pmtiles_js"]], check=True, capture_output=True, text=True)
    return json.loads(res.stdout)


def summarize(cfg: dict[str, Any], got: list[dict[str, Any]], exp: dict[str, np.ndarray]) -> dict:
    """Compare decoded values with expectations; return counts and max differences."""
    el = np.array([g["elevationM"] for g in got], dtype=np.float64)
    sl = np.array([g["slopeDeg"] for g in got], dtype=np.float64)
    asp = np.array([g["aspectDeg"] for g in got], dtype=np.float64)
    cls = cfg["slope_classes"]
    return {
        "points": len(got),
        "elevation_equal_float32": int((el.astype(np.float32) == exp["dem"].astype(np.float32)).sum()),
        "slope_max_abs_diff_vs_float64_recompute": float(np.abs(sl - exp["slope64"]).max()),
        "slope_max_abs_diff_vs_geotiff": float(np.abs(sl - exp["slope"]).max()),
        "slope_equal_float32": int((sl.astype(np.float32) == exp["slope"].astype(np.float32)).sum()),
        "slope_class_equal": int((slope_class_index(sl, cls) == slope_class_index(exp["slope"], cls)).sum()),
        "aspect_max_abs_diff_vs_float64_recompute": float(np.abs(asp - exp["aspect64"]).max()),
        "aspect_equal_float32": int((asp.astype(np.float32) == exp["aspect"].astype(np.float32)).sum()),
        "aspect_flat_equal": int(((asp == -1) == (exp["aspect"] == -1)).sum()),
    }


def run(region_id: str, points: int | None) -> None:
    """Sample, decode through the browser path, compare, and write a JSON report."""
    cfg = load_config()
    region = cfg["regions"][region_id]
    utm = sample_points(region, points or cfg["verify"]["points"], cfg["verify"]["seed"])
    lon, lat = Transformer.from_crs(region["crs"], "EPSG:4326", always_xy=True).transform(
        utm[:, 0], utm[:, 1])
    got = run_node(cfg, region_id, np.column_stack([lon, lat]))
    missing = sum(g is None for g in got)
    if missing:
        raise RuntimeError(f"{missing} points returned no value")
    report = summarize(cfg, got, expected(cfg, region_id, utm))
    report["verifiedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    report["pointsPerArchive"] = dict(Counter(g.get("archive") for g in got))
    (cfg["work_dir"] / f"{region_id}_verify_numeric.json").write_text(json.dumps(report, indent=2))
    for archive in report["pointsPerArchive"]:
        meta_path = cfg["out_dir"] / f"{archive}.meta.json"
        meta = json.loads(meta_path.read_text()) | {"verification": report}
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
    LOG.info("numeric verification: %s", json.dumps(report))


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    ap.add_argument("--points", type=int, help="random points (default: verify.points in config)")
    args = ap.parse_args()
    run(args.region, args.points)
