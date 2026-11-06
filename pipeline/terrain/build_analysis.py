"""Build the Tier 2 analysis rasters for one region: DEM, slope, aspect on the region's UTM grid.

Steps: windowed read of the 3DEP 1/3 arc-second COGs over the buffered footprint (cached locally),
bilinear reprojection EPSG:4269 -> EPSG:26913 onto the buffered grid, quantization to
round(z * dem_scale) / dem_scale (float64), Horn slope and aspect on the quantized DEM (aspect
corrected from grid north to true north by the meridian convergence at each cell),
crop the buffer, write float32 GeoTIFFs (NoData -9999) via temp file + atomic rename.

Usage: python build_analysis.py --region pilot
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds

from terrain_core import (LOG, load_config, meridian_convergence_deg, replace_atomic, setup_logging,
                          slope_aspect, true_north_aspect)

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
}


def buffered_grid(region: dict[str, Any], buffer_cells: int) -> tuple[Any, int, int]:
    """Return (transform, width, height) of the region grid expanded by buffer_cells."""
    res = region["res_m"]
    xmin, ymin, xmax, ymax = region["bounds"]
    b = buffer_cells * res
    width = round((xmax - xmin + 2 * b) / res)
    height = round((ymax - ymin + 2 * b) / res)
    return from_origin(xmin - b, ymax + b, res, res), width, height


def snap_to_grid(bounds: tuple, ppd: int) -> tuple[float, float, float, float]:
    """Expand (west, south, east, north) outward onto the 3DEP pixel lattice (multiples of 1/ppd deg).

    merge() copies source pixels by nearest neighbour onto a grid starting at the given bounds; if
    those bounds are not on pixel edges, every value is shifted by the fractional offset (up to
    half a pixel, about 4 m here). Snapping to the exact lattice (rather than to one tile's
    slightly rounded geotransform) also gives every region the same georeference for a pixel.
    """
    w, s, e, n = bounds
    return (math.floor(w * ppd) / ppd, math.floor(s * ppd) / ppd,
            math.ceil(e * ppd) / ppd, math.ceil(n * ppd) / ppd)


def source_path(cfg: dict[str, Any], url: str) -> str:
    """Local copy <work_dir>/3dep/<file name> if one was downloaded, else a /vsicurl/ URL.

    Whole tiles (needed for 1x1 degree cells) are faster to fetch once with curl than through
    many range requests; neighbouring tiles are only read in slivers, remotely.
    """
    local = cfg["work_dir"] / "3dep" / url.rsplit("/", 1)[1]
    return str(local) if local.exists() else "/vsicurl/" + url


def fetch_source(cfg: dict[str, Any], region_id: str, geo_bounds: tuple) -> Path:
    """Windowed-read and mosaic the source COGs over geo_bounds; cache as a local GeoTIFF.

    Args:
        cfg: Pipeline config.
        region_id: Region key in cfg["regions"].
        geo_bounds: (west, south, east, north) in EPSG:4269 degrees.

    Returns:
        Path to the cached source mosaic (EPSG:4269, float32, source NoData).
    """
    out = cfg["work_dir"] / f"src_{region_id}_4269.tif"
    if out.exists():
        LOG.info("using cached source mosaic %s", out)
        return out
    src_cfg = cfg["source"]
    # Sorted, so where 3DEP tiles overlap every region takes the value from the same tile.
    urls = [source_path(cfg, src_cfg["tiles"][t]["url"]) for t in sorted(cfg["regions"][region_id]["tiles"])]
    t0 = time.time()
    with rasterio.Env(**GDAL_ENV):
        srcs = [rasterio.open(u) for u in urls]
        ppd = src_cfg["pixels_per_degree"]
        arr, transform = merge(srcs, bounds=snap_to_grid(geo_bounds, ppd), res=(1 / ppd, 1 / ppd),
                               nodata=src_cfg["nodata"])
        profile = srcs[0].profile | {"driver": "GTiff", "height": arr.shape[1], "width": arr.shape[2],
                                     "transform": transform, "compress": "deflate", "predictor": 3}
        for s in srcs:
            s.close()
    tmp = out.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(arr)
    replace_atomic(tmp, out)
    LOG.info("source fetch %.1f s, %d x %d px", time.time() - t0, arr.shape[2], arr.shape[1])
    return out


def reproject_dem(src_path: Path, transform: Any, width: int, height: int, crs: str,
                  resampling: str, nodata_out: float) -> np.ndarray:
    """Reproject the source mosaic onto the buffered analysis grid.

    Returns:
        float64 array (float64 warp arithmetic, so neighbouring regions agree to the last bit
        before quantization), NaN where no valid source data contributed.
    """
    dem = np.full((height, width), np.nan, dtype=np.float64)
    with rasterio.open(src_path) as src:
        # tolerance=0 (exact per-pixel transform) and XSCALE=YSCALE=1 (plain 4-point bilinear; GDAL
        # otherwise widens the kernel by a scale it estimates per warp chunk): a cell then gets
        # the same value whichever region grid computes it, so regional products join seamlessly.
        reproject(source=rasterio.band(src, 1), destination=dem, src_nodata=src.nodata,
                  dst_transform=transform, dst_crs=crs, dst_nodata=np.nan,
                  resampling=Resampling[resampling], tolerance=0, XSCALE=1, YSCALE=1)
    LOG.info("reprojected DEM: %d NaN cells of %d", int(np.isnan(dem).sum()), dem.size)
    return dem


def strips(dem: np.ndarray, transform: Any, res: float, flat: float,
           rows: int) -> tuple[np.ndarray, np.ndarray]:
    """Slope and true-north aspect (float32, NaN for none), computed in row strips.

    Each strip is read with one extra row above and below, so results are identical to a
    whole-array computation. Aspect is corrected by the meridian convergence at each cell centre.
    """
    h, w = dem.shape
    slope = np.full(dem.shape, np.nan, dtype=np.float32)
    aspect = np.full(dem.shape, np.nan, dtype=np.float32)
    east = transform.c + (np.arange(w) + 0.5) * res
    for r0 in range(0, h, rows):
        r1, a0 = min(h, r0 + rows), max(0, r0 - 1)
        s, a = slope_aspect(dem[a0:min(h, r1 + 1)], res, res, flat)
        north = transform.f - (np.arange(r0, r1) + 0.5) * res
        conv = meridian_convergence_deg(east[None, :], north[:, None])
        slope[r0:r1] = s[r0 - a0:r1 - a0]
        aspect[r0:r1] = true_north_aspect(a[r0 - a0:r1 - a0], conv)
    return slope, aspect


def write_raster(path: Path, arr: np.ndarray, transform: Any, crs: str, nodata: float,
                 tags: dict[str, str]) -> None:
    """Write a float32 GeoTIFF (NaN -> nodata) to a temp name, then rename."""
    data = np.where(np.isnan(arr), nodata, arr).astype(np.float32)
    profile = {"driver": "GTiff", "dtype": "float32", "count": 1, "height": data.shape[0],
               "width": data.shape[1], "crs": crs, "transform": transform, "nodata": nodata,
               "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "deflate",
               "predictor": 3}
    tmp = path.with_name(path.name + ".partial")
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(data, 1)
        dst.update_tags(**tags)
    replace_atomic(tmp, path)


def run(region_id: str) -> None:
    """Build DEM, slope and aspect for one region and write them plus a run record."""
    cfg = load_config()
    region, proc = cfg["regions"][region_id], cfg["processing"]
    t0 = time.time()
    transform, width, height = buffered_grid(region, proc["buffer_cells"])
    x0, y1 = transform.c, transform.f
    bounds = (x0, y1 - height * region["res_m"], x0 + width * region["res_m"], y1)
    geo = transform_bounds(region["crs"], cfg["source"]["crs"], *bounds, densify_pts=51)
    m = proc["geo_margin_deg"]
    src_path = fetch_source(cfg, region_id, (geo[0] - m, geo[1] - m, geo[2] + m, geo[3] + m))
    t_fetch = time.time()
    dem_buf = reproject_dem(src_path, transform, width, height, region["crs"],
                            proc["resampling"], proc["nodata_out"])
    scale = float(proc["dem_scale"])
    dem_buf = np.round(dem_buf.astype(np.float64) * scale) / scale
    res = float(region["res_m"])
    slope, aspect = strips(dem_buf, transform, res, proc["flat_threshold_deg"], proc["strip_rows"])
    b = proc["buffer_cells"]
    crop = (slice(b, height - b), slice(b, width - b))
    xmin, _, _, ymax = region["bounds"]
    out_transform = from_origin(xmin, ymax, res, res)
    work, nd = cfg["work_dir"], proc["nodata_out"]
    write_raster(work / f"{region_id}_dem_buffered_26913_10m.tif", dem_buf, transform,
                 region["crs"], nd, {"UNITS": "m", "VERTICAL_DATUM": "NAVD88"})
    outputs = {"dem": (dem_buf[crop], {"UNITS": "m", "VERTICAL_DATUM": "NAVD88"}),
               "slope": (slope[crop], {"UNITS": "degrees", "METHOD": "Horn 1981"}),
               "aspect": (aspect[crop], {"UNITS": "degrees clockwise from true north",
                                         "FLAT": f"-1 where slope < {proc['flat_threshold_deg']}"})}
    for name, (arr, tags) in outputs.items():
        write_raster(work / f"{region_id}_{name}_26913_10m.tif", arr, out_transform,
                     region["crs"], nd, tags)
    record = {"region": region_id, "fetch_s": round(t_fetch - t0, 1),
              "compute_s": round(time.time() - t_fetch, 1), "source_bytes": src_path.stat().st_size,
              "nan_cells": {k: int(np.isnan(v[0]).sum()) for k, v in outputs.items()},
              "shape": list(outputs["dem"][0].shape)}
    (work / f"{region_id}_build_record.json").write_text(json.dumps(record, indent=2))
    LOG.info("done: %s", record)


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    run(ap.parse_args().region)
