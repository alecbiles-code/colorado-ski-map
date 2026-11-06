"""Prepare model inputs on the pilot grid: snapshot terrain-lane rasters and fetch canopy cover.

Canopy: USFS NLCD Tree Canopy Cover (percent, 30 m, Albers on WGS84) is read by HTTP range from
the official zip (stored member, tiled GeoTIFF), clipped, and reprojected to the 10 m pilot grid
with nearest neighbour so no canopy value is invented and NoData stays NoData (unknown).

Usage: python pipeline/avalanche/prep_inputs.py [--refetch-canopy]
(the native canopy clip is cached in work_dir/inputs and reused unless --refetch-canopy)
"""

from __future__ import annotations

import logging
import shutil
import sys
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds

from avy_core import check_on_grid, grid_profile, load_config, setup_logging, sha256, write_band, write_json

LOG = logging.getLogger("avalanche.prep")


def snapshot_terrain(cfg: dict[str, Any]) -> dict[str, Any]:
    """Copy the terrain-lane DEM/slope into work_dir/inputs and record checksums.

    Args:
        cfg: Loaded config.

    Returns:
        Provenance dict keyed by input name.
    """
    out = {}
    for key in ("dem", "dem_buffered", "slope"):
        src = Path(cfg["inputs"][key])
        dst = cfg["work_dir"] / "inputs" / src.name
        shutil.copy2(src, dst)
        if key != "dem_buffered":
            check_on_grid(dst, cfg)
        out[key] = {"source_path": str(src), "path": str(dst), "sha256": sha256(dst)}
        LOG.info("snapshot %s -> %s", src, dst)
    return out


def read_canopy_window(cfg: dict[str, Any]) -> tuple[np.ndarray, Any, Any]:
    """Read the canopy source window covering the pilot (plus margin) by HTTP range.

    Args:
        cfg: Loaded config.

    Returns:
        (array with all source NoData codes set to the output NoData, window transform, source CRS).
    """
    c = cfg["inputs"]["canopy"]
    xmin, ymin, xmax, ymax = cfg["grid"]["bounds"]
    m = c["clip_margin_m"]
    path = f"/vsizip//vsicurl/{c['url']}/{c['member']}"
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"), rasterio.open(path) as src:
        b = transform_bounds(cfg["grid"]["crs"], src.crs, xmin - m, ymin - m, xmax + m, ymax + m)
        win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=win)
        tr, crs = src.window_transform(win), src.crs
    bad = np.isin(arr, c["nodata_values"]) | (arr > c["valid_max"])
    arr = np.where(bad, c["nodata_out"], arr).astype(np.uint8)
    LOG.info("canopy window %s, %d source NoData cells", arr.shape, int(bad.sum()))
    return arr, tr, crs


def native_canopy(cfg: dict[str, Any], refetch: bool) -> tuple[np.ndarray, Any, Any]:
    """Native-resolution canopy clip: reuse the saved clip unless refetch, else read by range and save.

    Args:
        cfg: Loaded config.
        refetch: Ignore a saved clip and read the source again.

    Returns:
        (array, transform, CRS) of the native clip.
    """
    c = cfg["inputs"]["canopy"]
    native = cfg["work_dir"] / "inputs" / "canopy_tcc2025_native_clip.tif"
    if native.exists() and not refetch:
        LOG.info("reusing saved canopy clip %s (pass --refetch-canopy to read the source again)", native)
        with rasterio.open(native) as src:
            return src.read(1), src.transform, src.crs
    arr, tr, crs = read_canopy_window(cfg)
    prof = {"driver": "GTiff", "dtype": "uint8", "nodata": c["nodata_out"], "count": 1,
            "width": arr.shape[1], "height": arr.shape[0], "crs": crs, "transform": tr,
            "compress": "deflate"}
    with rasterio.open(native, "w", **prof) as dst:
        dst.write(arr, 1)
    return arr, tr, crs


def canopy_to_grid(cfg: dict[str, Any], refetch: bool) -> dict[str, Any]:
    """Get the native canopy clip, reproject it to the pilot grid, and report statistics.

    Args:
        cfg: Loaded config.
        refetch: Read the source again even if a saved clip exists.

    Returns:
        Provenance and statistics dict.
    """
    c = cfg["inputs"]["canopy"]
    arr, tr, crs = native_canopy(cfg, refetch)
    native = cfg["work_dir"] / "inputs" / "canopy_tcc2025_native_clip.tif"
    dst_prof = grid_profile(cfg, "uint8", c["nodata_out"])
    out = np.full((dst_prof["height"], dst_prof["width"]), c["nodata_out"], dtype=np.uint8)
    reproject(arr, out, src_transform=tr, src_crs=crs, src_nodata=c["nodata_out"],
              dst_transform=dst_prof["transform"], dst_crs=dst_prof["crs"],
              dst_nodata=c["nodata_out"], resampling=Resampling[c["resampling"]])
    path = cfg["work_dir"] / "inputs" / "canopy_pct_26913_10m.tif"
    write_band(path, out, cfg, c["nodata_out"])
    valid = out != c["nodata_out"]
    stats = {"nodata_cells": int((~valid).sum()), "cells": int(out.size),
             "mean_pct": float(out[valid].mean()), "zero_pct_cells": int((out[valid] == 0).sum()),
             "ge50_pct_cells": int((out[valid] >= 50).sum())}
    LOG.info("canopy on grid: %s", stats)
    return {"source": c["url"], "member": c["member"], "native_clip": str(native),
            "native_sha256": sha256(native), "path": str(path), "sha256": sha256(path),
            "resampling": c["resampling"], "stats": stats}


def main() -> None:
    """Prepare inputs and write work_dir/inputs/inputs_manifest.json."""
    setup_logging()
    cfg = load_config()
    manifest = {"terrain": snapshot_terrain(cfg),
                "canopy": canopy_to_grid(cfg, "--refetch-canopy" in sys.argv[1:])}
    write_json(cfg["work_dir"] / "inputs" / "inputs_manifest.json", manifest)


if __name__ == "__main__":
    main()
