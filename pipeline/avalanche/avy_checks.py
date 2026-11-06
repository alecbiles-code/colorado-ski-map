"""Checks and sensitivity analysis for the avalanche-model pilot; writes work_dir/analysis.json.

1. Co-registration: every input and output raster is exactly on the pilot grid.
2. NoData: counts per input; PRA unknown cells; Flow-Py "not affected" semantics.
3. Edge: modelled cells touching the 2-cell outer frame (paths cut at the DEM edge) and the
   truncation band width (longest modelled travel length of any run, rounded up to 100 m).
4. Sensitivity: footprint area per run and change against the primary run.

Usage: python pipeline/avalanche/avy_checks.py
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np

from avy_core import check_on_grid, load_config, read_band, setup_logging, write_json
from runout import runs

LOG = logging.getLogger("avalanche.checks")


def run_output(cfg: dict[str, Any], run: str, var: str) -> np.ndarray:
    """One com4FlowPy output of a run as float64 with "not affected" (-9999) as NaN.

    Args:
        cfg: Loaded config.
        run: Run name.
        var: Output name as in the file suffix (zdelta, cellCounts, travelLengthMax, ...).

    Returns:
        Array on the pilot grid.
    """
    rec = json.loads((cfg["work_dir"] / "runout" / f"run_{run}.json").read_text())
    path = next(Path(rec["res_dir"]).glob(f"*_{var}.tif"))
    check_on_grid(path, cfg)
    a, nd = read_band(path)
    a = a.astype(np.float64)
    a[a == nd] = np.nan
    return a


def coregistration(cfg: dict[str, Any]) -> dict[str, str]:
    """Check every input, PRA and run output raster against the pilot grid.

    Args:
        cfg: Loaded config.

    Returns:
        {path: "ok" | error message}.
    """
    w = cfg["work_dir"]
    paths = [*sorted((w / "inputs").glob("*_26913_10m.tif")), *sorted((w / "pra").glob("*.tif")),
             *sorted((w / "runout").glob("release_*.tif"))]
    for run in runs(cfg):
        rec = w / "runout" / f"run_{run}.json"
        if rec.exists():
            paths += sorted(Path(json.loads(rec.read_text())["res_dir"]).glob("*.tif"))
    out = {}
    for p in paths:
        if "buffered" in p.name:
            continue
        try:
            check_on_grid(p, cfg)
            out[str(p)] = "ok"
        except ValueError as e:
            out[str(p)] = str(e)
    return out


def nodata_counts(cfg: dict[str, Any]) -> dict[str, int]:
    """NoData cell counts of the model inputs and PRA rasters.

    Args:
        cfg: Loaded config.

    Returns:
        {file name: count}.
    """
    w = cfg["work_dir"]
    out = {}
    for p in [*sorted((w / "inputs").glob("*_26913_10m.tif")), *sorted((w / "pra").glob("*.tif"))]:
        if "buffered" not in p.name:
            a, nd = read_band(p)
            out[p.name] = int((a == nd).sum())
    return out


def edge_stats(cfg: dict[str, Any], run: str) -> dict[str, Any]:
    """Affected cells in the outer 2-cell frame and the maximum travel length of a run.

    Args:
        cfg: Loaded config.
        run: Run name.

    Returns:
        Stats dict.
    """
    cc = run_output(cfg, run, "cellCounts")
    tl = run_output(cfg, run, "travelLengthMax")
    hit = ~np.isnan(cc)
    frame = np.ones(hit.shape, dtype=bool)
    frame[2:-2, 2:-2] = False
    return {"affected_cells_in_outer_2_cell_frame": int((hit & frame).sum()),
            "frame_cells": int(frame.sum()),
            "travel_length_max_m": float(np.nanmax(tl)),
            "travel_length_p99_m": float(np.nanpercentile(tl, 99))}


def footprint_change(cfg: dict[str, Any], base: np.ndarray, run: str) -> dict[str, Any]:
    """Footprint (cells reached by any path) of a run and its change against the primary.

    Args:
        cfg: Loaded config.
        base: Primary footprint (bool).
        run: Run name.

    Returns:
        Stats dict (areas in km2).
    """
    fp = ~np.isnan(run_output(cfg, run, "cellCounts"))
    km2 = cfg["grid"]["res_m"] ** 2 / 1e6
    inter, union = int((fp & base).sum()), int((fp | base).sum())
    return {"footprint_km2": fp.sum() * km2, "gained_vs_primary_km2": int((fp & ~base).sum()) * km2,
            "lost_vs_primary_km2": int((base & ~fp).sum()) * km2,
            "jaccard_vs_primary": inter / union if union else None,
            "area_change_pct": 100.0 * (fp.sum() - base.sum()) / base.sum()}


def zdelta_stats(cfg: dict[str, Any], run: str) -> dict[str, Any]:
    """Distribution of zDelta (m) over affected cells.

    Args:
        cfg: Loaded config.
        run: Run name.

    Returns:
        Percentiles and max.
    """
    z = run_output(cfg, run, "zdelta")
    v = z[~np.isnan(z)]
    pct = np.percentile(v, [10, 25, 50, 75, 90, 99])
    return {"p10_p25_p50_p75_p90_p99_m": [round(float(x), 2) for x in pct], "max_m": float(v.max())}


def sar_comparison(cfg: dict[str, Any]) -> dict[str, Any]:
    """Descriptive overlap of SAR cross-season hotspots with modelled PRA and runout.

    Not validation: the SAR candidates are unvalidated, restricted to 20-70 degree slopes, and
    their thresholding was a manual step. Nothing here feeds back into model parameters.

    Args:
        cfg: Loaded config.

    Returns:
        Shares of hotspot cells inside PRA / runout, against the same shares for all pilot cells
        and for pilot cells in the SAR slope window.
    """
    import pyogrio
    from rasterio.features import rasterize
    from rasterio.warp import transform_bounds

    from avy_core import grid_profile
    r, prof = cfg["reference"], grid_profile(cfg, "uint8", 0)
    bb = transform_bounds(cfg["grid"]["crs"], "EPSG:3857", *cfg["grid"]["bounds"])
    df = pyogrio.read_dataframe(r["sar_hotspots"], layer=r["sar_layer"], bbox=bb).to_crs(cfg["grid"]["crs"])
    shape = (prof["height"], prof["width"])
    masks = {lvl: rasterize(df[df["confidence"] == lvl].geometry, out_shape=shape,
                            transform=prof["transform"], fill=0, default_value=1).astype(bool)
             for lvl in ("higher confidence", "lower confidence")}
    slope, _ = read_band(cfg["work_dir"] / "inputs" / "pilot_slope_26913_10m.tif")
    lo, hi = r["sar_slope_window_deg"]
    pra_b, _ = read_band(cfg["work_dir"] / "pra" / "pra_binary_primary.tif")
    layers = {"pra": pra_b == 1, "runout": ~np.isnan(run_output(cfg, "primary", "cellCounts"))}
    groups = {"all_pilot_cells": np.ones(shape, bool), "pilot_cells_slope_window": (slope >= lo) & (slope <= hi),
              **{f"hotspot_{k.split()[0]}": m for k, m in masks.items()}}
    out = {"hotspot_features_read_in_bbox": int(len(df)),
           "cells": {g: int(m.sum()) for g, m in groups.items()}}
    for name, lay in layers.items():
        out[f"share_in_{name}"] = {g: float(lay[m].mean()) for g, m in groups.items()}
    return out


def main() -> None:
    """Run all checks for the runs that exist and write work_dir/analysis.json."""
    setup_logging()
    cfg = load_config()
    w = cfg["work_dir"]
    done = [r for r in runs(cfg) if (w / "runout" / f"run_{r}.json").exists()]
    out: dict[str, Any] = {"coregistration": coregistration(cfg), "nodata_cells": nodata_counts(cfg),
                           "runs": {r: json.loads((w / "runout" / f"run_{r}.json").read_text())
                                    for r in done}}
    out["coregistration_all_ok"] = all(v == "ok" for v in out["coregistration"].values())
    out["edge"] = {r: edge_stats(cfg, r) for r in done}
    longest = max(e["travel_length_max_m"] for e in out["edge"].values())
    out["truncation_band_m"] = math.ceil(longest / 100) * 100   # longest path of any run
    out["zdelta"] = {r: zdelta_stats(cfg, r) for r in done}
    base = ~np.isnan(run_output(cfg, "primary", "cellCounts"))
    out["sensitivity"] = {r: footprint_change(cfg, base, r) for r in done}
    out["sar_descriptive_comparison"] = sar_comparison(cfg)
    write_json(w / "analysis.json", out)
    LOG.info("coregistration ok: %s; truncation band %s m", out["coregistration_all_ok"],
             out["truncation_band_m"])


if __name__ == "__main__":
    main()
