"""Independent check: compare our slope/aspect with GDAL's gdaldem (GDALDEMProcessing, Horn).

GDAL's Python bindings are not on PyPI as wheels, so this calls the documented C API
(gdal_utils.h: GDALDEMProcessingOptionsNew, GDALDEMProcessing) of the libgdal that the
rasterio wheel bundles, through ctypes. No terrain math is reimplemented here.

Usage: python gdal_check.py --region pilot
"""

from __future__ import annotations

import argparse
import ctypes
import json
from pathlib import Path

import numpy as np
import rasterio

from terrain_core import (LOG, load_config, meridian_convergence_deg, setup_logging,
                          slope_class_index, true_north_aspect)

GDAL_OF_RASTER = 0x02


def libgdal() -> ctypes.CDLL:
    """Load the libgdal shipped inside the rasterio wheel."""
    libdir = Path(rasterio.__file__).parent / ".dylibs"
    candidates = sorted(libdir.glob("libgdal*")) or sorted(
        (Path(rasterio.__file__).parent.parent / "rasterio.libs").glob("libgdal*"))
    lib = ctypes.CDLL(str(candidates[0]))
    lib.GDALAllRegister()
    lib.GDALOpenEx.restype = ctypes.c_void_p
    lib.GDALOpenEx.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p,
                               ctypes.c_void_p]
    lib.GDALDEMProcessingOptionsNew.restype = ctypes.c_void_p
    lib.GDALDEMProcessingOptionsNew.argtypes = [ctypes.POINTER(ctypes.c_char_p), ctypes.c_void_p]
    lib.GDALDEMProcessing.restype = ctypes.c_void_p
    lib.GDALDEMProcessing.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_char_p,
                                      ctypes.c_char_p, ctypes.c_void_p,
                                      ctypes.POINTER(ctypes.c_int)]
    lib.GDALClose.argtypes = [ctypes.c_void_p]
    return lib


def gdaldem(lib: ctypes.CDLL, src: Path, dst: Path, mode: str) -> None:
    """Run gdaldem <mode> -alg Horn on src, writing GeoTIFF dst."""
    args = [b"-alg", b"Horn", b"-of", b"GTiff", None]
    argv = (ctypes.c_char_p * len(args))(*args)
    opts = lib.GDALDEMProcessingOptionsNew(argv, None)
    ds = lib.GDALOpenEx(str(src).encode(), GDAL_OF_RASTER, None, None, None)
    err = ctypes.c_int(0)
    out = lib.GDALDEMProcessing(str(dst).encode(), ds, mode.encode(), None, opts, ctypes.byref(err))
    if not out or err.value:
        raise RuntimeError(f"GDALDEMProcessing {mode} failed (usage error {err.value})")
    lib.GDALClose(out)
    lib.GDALClose(ds)
    lib.GDALDEMProcessingOptionsFree(ctypes.c_void_p(opts))


def read_crop(path: Path, b: int) -> np.ndarray:
    """Read band 1 as float64 with NoData as NaN, cropping b cells from each edge."""
    with rasterio.open(path) as s:
        a = s.read(1, masked=True).astype(np.float64).filled(np.nan)
    return a[b:-b, b:-b] if b else a


def compare(cfg: dict, region_id: str, gslope: Path, gaspect: Path) -> dict:
    """Compare GDAL outputs with ours over the region; return summary statistics."""
    b, work = cfg["processing"]["buffer_cells"], cfg["work_dir"]
    flat = cfg["processing"]["flat_threshold_deg"]
    gs, ga = read_crop(gslope, b), read_crop(gaspect, b)
    ours_s = read_crop(work / f"{region_id}_slope_26913_10m.tif", 0)
    ours_a = read_crop(work / f"{region_id}_aspect_26913_10m.tif", 0)
    ds = np.abs(gs - ours_s)
    region = cfg["regions"][region_id]
    xmin, _, _, ymax = region["bounds"]
    rows, cols = np.mgrid[0:gs.shape[0], 0:gs.shape[1]]
    conv = meridian_convergence_deg(xmin + (cols + 0.5) * region["res_m"],
                                    ymax - (rows + 0.5) * region["res_m"])
    ga = true_north_aspect(ga, conv)  # gdaldem aspect is relative to grid north
    m = ours_s >= flat
    da = np.abs((ours_a[m] - ga[m] + 180.0) % 360.0 - 180.0)
    return {"gdal_version": rasterio.__gdal_version__, "cells": int(ds.size),
            "slope_max_abs_diff_deg": float(np.nanmax(ds)),
            "slope_mean_abs_diff_deg": float(np.nanmean(ds)),
            "slope_cells_nan_mismatch": int((np.isnan(gs) != np.isnan(ours_s)).sum()),
            "aspect_cells_compared": int(da.size),
            "aspect_max_abs_diff_deg": float(np.nanmax(da)),
            "aspect_mean_abs_diff_deg": float(np.nanmean(da)),
            "slope_class_disagreements": class_disagreements(cfg, gs, ours_s)}


def class_disagreements(cfg: dict, a: np.ndarray, b: np.ndarray) -> int:
    """Count cells whose slope class differs between two slope arrays."""
    cls = cfg["slope_classes"]
    return int((slope_class_index(a, cls) != slope_class_index(b, cls)).sum())


def run(region_id: str) -> None:
    """Run gdaldem slope and aspect on the buffered DEM and compare."""
    cfg = load_config()
    work = cfg["work_dir"]
    src = work / f"{region_id}_dem_buffered_26913_10m.tif"
    lib = libgdal()
    outs = {}
    for mode in ("slope", "aspect"):
        outs[mode] = work / f"{region_id}_gdaldem_{mode}_buffered.tif"
        gdaldem(lib, src, outs[mode], mode)
    result = compare(cfg, region_id, outs["slope"], outs["aspect"])
    (work / f"{region_id}_gdal_check.json").write_text(json.dumps(result, indent=2))
    LOG.info("GDAL check: %s", json.dumps(result))


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    run(ap.parse_args().region)
