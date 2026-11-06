"""Separate source vintage from resolution in the AWS (fallback) Tier 1 vs Tier 2 comparison.

AWS Terrain Tiles were built in 2017 from the 3DEP/NED of that time. Over a sub-area of the
pilot this script reprojects older 3DEP releases of the same tile onto the analysis grid and
reports (1) how far each release is from the current one (Tier 2), (2) which release the Terrain
Tiles match, and (3) Tier 1 slope error per zoom against the Tier 2 method applied to the
matching release, i.e. the error due to the browser method and zoom alone.
Run tier1_compare.py --providers aws first (it leaves the Tier 1 mosaics in the work dir).

Usage: python tier1_vintage.py --region pilot
"""

from __future__ import annotations

import argparse
import json
import math
from typing import Any

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds

from build_analysis import GDAL_ENV
from products import geo_bounds, tile_xy
from terrain_core import LOG, load_config, setup_logging, slope_aspect
from tier1_compare import sample, stats


def release_dem(url: str, box: list[float], res: float, crs: str) -> np.ndarray:
    """Reproject one 3DEP release (bilinear) onto box plus a 1-cell ring; NaN for no data."""
    xmin, ymin, xmax, ymax = box
    nx, ny = round((xmax - xmin) / res) + 2, round((ymax - ymin) / res) + 2
    out = np.full((ny, nx), np.nan)
    t = from_origin(xmin - res, ymax + res, res, res)
    geo = transform_bounds(crs, "EPSG:4269", xmin - res, ymin - res, xmax + res,
                                         ymax + res, densify_pts=21)
    with rasterio.Env(**GDAL_ENV), rasterio.open("/vsicurl/" + url) as src:
        f = from_bounds(geo[0] - 0.002, geo[1] - 0.002, geo[2] + 0.002, geo[3] + 0.002, src.transform)
        win = Window(math.floor(f.col_off), math.floor(f.row_off), math.ceil(f.width) + 1,
                     math.ceil(f.height) + 1)  # whole source pixels: no sub-pixel shift
        a = src.read(1, window=win)
        reproject(a, out, src_transform=src.window_transform(win), src_crs=src.crs,
                  src_nodata=src.nodata, dst_transform=t, dst_crs=crs, dst_nodata=np.nan,
                  resampling=Resampling.bilinear, tolerance=0, XSCALE=1, YSCALE=1)
    return out


def diff_stats(a: np.ndarray, b: np.ndarray) -> dict[str, float]:
    """Bias, MAE, RMSE of a - b (metres)."""
    d = a - b
    return {"bias": float(np.nanmean(d)), "mae": float(np.nanmean(np.abs(d))),
            "rmse": float(np.sqrt(np.nanmean(d ** 2)))}


def tier1_mosaics(cfg: dict[str, Any], region: dict[str, Any]) -> dict[int, tuple]:
    """Load the AWS Tier 1 slope and elevation mosaics left by tier1_compare.py."""
    w, s, e, n = geo_bounds(region)
    out = {}
    for z in cfg["tier1"]["providers"]["aws"]["zooms"]:
        base = cfg["work_dir"] / f"tier1_aws_z{z}"
        hdr = json.loads(base.with_suffix(".json").read_text())
        h, wd = hdr["height"], hdr["width"]
        slope = np.fromfile(base.with_suffix(".f32"), dtype=np.float32)[: h * wd]
        rgb = np.fromfile(base.with_suffix(".rgb"), dtype=np.uint8).reshape(h, wd, 3)
        elev = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
        (x0, y0), (x1, y1), m = tile_xy(w, n, z), tile_xy(e, s, z), cfg["tier1"]["margin_tiles"]
        out[z] = (slope.reshape(h, wd), elev, range(x0 - m, x1 + m + 1), range(y0 - m, y1 + m + 1))
    return out


def run(region_id: str) -> None:
    """Write <region>_tier1_vintage.json."""
    cfg = load_config()
    region, vin = cfg["regions"][region_id], cfg["tier1"]["vintage"]
    ts = cfg["tier1"]["providers"]["aws"]["tile_size"]
    box, res, flat = vin["utm_box"], float(region["res_m"]), cfg["processing"]["flat_threshold_deg"]
    with rasterio.open(cfg["work_dir"] / f"{region_id}_dem_26913_10m.tif") as src:
        cur = src.read(1, window=from_bounds(*box, src.transform)).astype(np.float64)
    ny, nx = cur.shape
    rows, cols = np.mgrid[0:ny, 0:nx]
    lon, lat = Transformer.from_crs(region["crs"], "EPSG:4326", always_xy=True).transform(
        (box[0] + (cols + 0.5) * res).ravel(), (box[3] - (rows + 0.5) * res).ravel())
    lon, lat = np.asarray(lon), np.asarray(lat)
    mos = tier1_mosaics(cfg, region)
    report: dict[str, Any] = {"utm_box": box}
    for tag, url in vin["versions"].items():
        dem = release_dem(url, box, res, region["crs"])
        s_rel = slope_aspect(dem, res, res, flat)[0][1:-1, 1:-1].ravel()
        rec = {"url": url, "minus_current_m": diff_stats(dem[1:-1, 1:-1], cur)}
        for z, (slope, elev, xs, ys) in mos.items():
            t1e = sample(elev, z, xs, ys, ts, lon, lat)
            t1s = sample(slope, z, xs, ys, ts, lon, lat)
            steep = s_rel > 25.0
            rec[f"z{z}"] = {"tier1_elev_minus_release_m": diff_stats(t1e, dem[1:-1, 1:-1].ravel()),
                            "slope_all": stats(t1s, s_rel, cfg["slope_classes"]),
                            "slope_release_gt25": stats(t1s[steep], s_rel[steep], cfg["slope_classes"])}
        report[tag] = rec
        LOG.info("%s: %s", tag, json.dumps(rec))
    (cfg["work_dir"] / f"{region_id}_tier1_vintage.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    run(ap.parse_args().region)
