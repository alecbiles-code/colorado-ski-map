"""Potential release area (PRA) on the pilot grid, AutoATES fuzzy-logic method.

Memberships (generalised bell / Cauchy) for slope, wind shelter and canopy cover are combined
with the Veitinger et al. (2016) ordered-weighted fuzzy AND. Parameters: config.yaml `pra`
(AutoATES v2.0 defaults with the "pcc" percent-canopy-cover forest curve, not Colorado-calibrated).

The continuous value is a terrain-suitability membership in [0, 1], not a release probability.
Unknown inputs (NoData slope, DEM window or canopy) give NoData PRA, never 0.

Usage: python pipeline/avalanche/pra.py
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import rasterio
from rasterio.transform import rowcol
from scipy import ndimage

from avy_core import (cauchy, check_on_grid, fuzzy_and, load_config, read_band,
                      setup_logging, windshelter, write_band, write_json)

LOG = logging.getLogger("avalanche.pra")
UNKNOWN = 255


def pilot_windshelter(cfg: dict[str, Any]) -> np.ndarray:
    """Wind shelter on the buffered DEM, cropped to the pilot grid so edge cells are valid.

    Args:
        cfg: Loaded config.

    Returns:
        Wind shelter (radians) on the pilot grid, NaN where undefined.
    """
    p = cfg["pra"]
    path = cfg["work_dir"] / "inputs" / "pilot_dem_buffered_26913_10m.tif"
    with rasterio.open(path) as src:
        z = src.read(1).astype(np.float64)
        z[z == src.nodata] = np.nan
        xmin, _, _, ymax = cfg["grid"]["bounds"]
        res = cfg["grid"]["res_m"]
        off = ((xmin - src.transform.c) / res, (src.transform.f - ymax) / res)
        if src.crs != rasterio.crs.CRS.from_user_input(cfg["grid"]["crs"]) or src.res != (res, res) \
                or any(abs(o - round(o)) > 1e-6 or o < 0 for o in off):
            raise ValueError(f"{path} is not a buffer of the pilot grid: {src.crs} {src.transform}")
        r0, c0 = rowcol(src.transform, xmin + 1e-6, ymax - 1e-6)
    ws = windshelter(z, cfg["grid"]["res_m"], p["wind_radius_m"], p["wind_probability"],
                     p["wind_direction_deg"], p["wind_tolerance_deg"])
    rows, cols = cfg["grid"]["shape"]
    return ws[r0:r0 + rows, c0:c0 + cols]


def continuous_pra(slope: np.ndarray, ws: np.ndarray, canopy: np.ndarray,
                   p: dict[str, Any]) -> np.ndarray:
    """Fuzzy PRA membership in [0, 1]; NaN where any input is NaN (unknown).

    Args:
        slope: Slope in degrees (NaN = unknown).
        ws: Wind shelter in radians (NaN = unknown).
        canopy: Canopy cover percent 0-100 (NaN = unknown).
        p: config `pra` section.

    Returns:
        Continuous PRA membership.
    """
    members = [cauchy(slope, *p["slope_cauchy"]), cauchy(ws, *p["wind_cauchy"]),
               cauchy(canopy, *p["forest_cauchy"])]
    return fuzzy_and(members)


def binary_pra(cont: np.ndarray, threshold: float, min_cells: int, connectivity: int) -> np.ndarray:
    """Threshold and sieve: 1 release, 0 not, 255 unknown.

    Release patches smaller than `min_cells` are removed (AutoATES v2.0 gdal.SieveFilter step).
    Unlike gdal.SieveFilter, small non-release holes inside release patches are not filled.

    Args:
        cont: Continuous PRA (NaN = unknown).
        threshold: Release if cont >= threshold.
        min_cells: Minimum patch size in cells.
        connectivity: 4 or 8.

    Returns:
        uint8 array.
    """
    rel = np.nan_to_num(cont, nan=-1.0) >= threshold
    struct = ndimage.generate_binary_structure(2, 2 if connectivity == 8 else 1)
    lab, n = ndimage.label(rel, structure=struct)
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    keep = sizes >= min_cells
    keep[0] = False
    out = keep[lab].astype(np.uint8)
    out[np.isnan(cont)] = UNKNOWN
    return out


def load_inputs(cfg: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Slope (degrees) and canopy (percent) on the pilot grid with NoData as NaN.

    Args:
        cfg: Loaded config.

    Returns:
        (slope, canopy).
    """
    out = []
    for name in ("pilot_slope_26913_10m.tif", "canopy_pct_26913_10m.tif"):
        path = cfg["work_dir"] / "inputs" / name
        check_on_grid(path, cfg)
        a, nd = read_band(path)
        a = a.astype(np.float64)
        a[a == nd] = np.nan
        out.append(a)
    return out[0], out[1]


def summarize(binary: np.ndarray, cell_m2: float) -> dict[str, Any]:
    """Cell and area counts for a binary PRA raster.

    Args:
        binary: Output of binary_pra.
        cell_m2: Cell area.

    Returns:
        Summary dict.
    """
    lab, n = ndimage.label(binary == 1, structure=np.ones((3, 3)))
    rel = int((binary == 1).sum())
    return {"release_cells": rel, "release_km2": rel * cell_m2 / 1e6, "patches": int(n),
            "unknown_cells": int((binary == UNKNOWN).sum()),
            "release_fraction": rel / binary.size}


def main() -> None:
    """Compute wind shelter, continuous PRA and binary PRA (primary + sensitivity threshold)."""
    setup_logging()
    cfg = load_config()
    p, d = cfg["pra"], cfg["work_dir"] / "pra"
    slope, canopy = load_inputs(cfg)
    ws = pilot_windshelter(cfg)
    write_band(d / "windshelter.tif", np.nan_to_num(ws, nan=-9999).astype(np.float32), cfg, -9999.0)
    cont = continuous_pra(slope, ws, canopy, p)
    write_band(d / "pra_continuous.tif", np.nan_to_num(cont, nan=-9999).astype(np.float32), cfg, -9999.0)
    cell_m2 = cfg["grid"]["res_m"] ** 2
    stats = {"parameters": p,
             "windshelter_nan_cells": int(np.isnan(ws).sum()),
             "continuous_nan_cells": int(np.isnan(cont).sum())}
    for tag, thr in (("primary", p["threshold"]), ("sens_threshold", p["sensitivity_threshold"])):
        b = binary_pra(cont, thr, p["sieve_min_cells"], p["sieve_connectivity"])
        write_band(d / f"pra_binary_{tag}.tif", b, cfg, UNKNOWN)
        stats[tag] = {"threshold": thr, **summarize(b, cell_m2)}
        LOG.info("%s: %s", tag, stats[tag])
    write_json(d / "pra_stats.json", stats)


if __name__ == "__main__":
    main()
