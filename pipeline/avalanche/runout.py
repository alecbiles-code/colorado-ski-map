"""Flow-Py runout with AvaFrame com4FlowPy from the binary PRA, plus the sensitivity set.

Runs: primary (PRA primary threshold, alpha from config), alpha - 2 and alpha + 2 degrees, and the
PRA sensitivity threshold at the primary alpha. Flow-Py solves no time-dependent equations: its
outputs are geometric (energy-line height, path counts, routing flux, travel angle), not speeds,
timing, impact pressure or reach probabilities.

Usage: python pipeline/avalanche/runout.py [run_name ...]   (default: all runs)
"""

from __future__ import annotations

import logging
import resource
import sys
import time
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
from avaframe import runCom4FlowPy
from avaframe.com4FlowPy import com4FlowPy
from avaframe.in3Utils import cfgUtils

from avy_core import load_config, read_band, setup_logging, write_band, write_json

LOG = logging.getLogger("avalanche.runout")


def runs(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Named run definitions: release raster and alpha.

    Args:
        cfg: Loaded config.

    Returns:
        {name: {"pra": tag, "alpha": degrees}}.
    """
    a = cfg["runout"]["alpha_deg"]
    out = {"primary": {"pra": "primary", "alpha": a}}
    for s in cfg["runout"]["sensitivity_alpha_deg"]:
        out[f"alpha{s:g}"] = {"pra": "primary", "alpha": s}
    out["pra_threshold"] = {"pra": "sens_threshold", "alpha": a}
    return out


def release_raster(cfg: dict[str, Any], tag: str) -> Path:
    """Write the Flow-Py release raster (1 release, 0 not) from a binary PRA.

    Unknown PRA cells (255) are not released; config/methods document this.

    Args:
        cfg: Loaded config.
        tag: PRA tag ("primary" or "sens_threshold").

    Returns:
        Path to the release GeoTIFF.
    """
    b, _ = read_band(cfg["work_dir"] / "pra" / f"pra_binary_{tag}.tif")
    path = cfg["work_dir"] / "runout" / f"release_{tag}.tif"
    path.parent.mkdir(parents=True, exist_ok=True)
    write_band(path, (b == 1).astype(np.float32), cfg, -9999.0)
    return path


def flowpy_cfg(cfg: dict[str, Any], dem: Path, release: Path, work: Path, alpha: float) -> Any:
    """com4FlowPy configparser: package defaults overridden by config.yaml `runout`.

    Args:
        cfg: Loaded config.
        dem: DEM GeoTIFF on the pilot grid.
        release: Release GeoTIFF.
        work: com4FlowPy work directory.
        alpha: Alpha angle in degrees.

    Returns:
        configparser.ConfigParser.
    """
    r = cfg["runout"]
    fc = cfgUtils.getModuleConfig(com4FlowPy)
    g = fc["GENERAL"]
    g["alpha"], g["exp"] = str(alpha), str(r["exponent"])
    g["flux_threshold"], g["max_z"] = str(r["flux_threshold"]), str(r["max_z_m"])
    g["forest"], g["engine"] = str(r["forest"]), r["engine"]
    g["tileSize"], g["tileOverlap"] = str(r["tile_size_m"]), str(r["tile_overlap_m"])
    g["maxChunks"] = str(r["max_chunks"])
    p = fc["PATHS"]
    p["useCustomPaths"], p["workDir"] = "True", str(work)
    p["demPath"], p["releasePath"] = str(dem), str(release)
    p["outputFiles"], p["outputFileFormat"] = r["output_files"], ".tif"
    p["overwriteResults"], p["deleteTempFolder"] = "reRunAndOverwrite", "True"
    return fc


def run_one(cfg: dict[str, Any], name: str, spec: dict[str, Any], dem: Path) -> dict[str, Any]:
    """Run com4FlowPy once and measure wall time, peak memory and output size.

    Args:
        cfg: Loaded config.
        name: Run name.
        spec: Run definition from runs().
        dem: DEM path.

    Returns:
        Run record.
    """
    work = cfg["work_dir"] / "runout" / name
    fc = flowpy_cfg(cfg, dem, release_raster(cfg, spec["pra"]), work, spec["alpha"])
    t0 = time.time()
    res = runCom4FlowPy.main(cfg=fc)
    wall = time.time() - t0
    res_dir = work / f"res_{res['uid']}"
    files = {f.name: f.stat().st_size for f in sorted(res_dir.glob("*.tif"))}
    rec = {"name": name, **spec, "uid": res["uid"], "message": res["message"],
           "wall_s": round(wall, 1), "res_dir": str(res_dir), "outputs_bytes": files,
           "peak_rss_self_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20,
           "peak_rss_largest_child_mb": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 2**20,
           "avaframe_version": version("avaframe"), "engine": cfg["runout"]["engine"],
           "cpu_cores_used": cfgUtils.getNumberOfProcesses(cfgUtils.getGeneralConfig(), 9999)}
    LOG.info("run %s done in %.0f s", name, wall)
    return rec


def main(names: list[str]) -> None:
    """Run the requested (or all) runs and write runout/runs_<name>.json records.

    Args:
        names: Run names to execute; empty means all.
    """
    setup_logging()
    cfg = load_config()
    dem = cfg["work_dir"] / "inputs" / "pilot_dem_26913_10m.tif"
    for name, spec in runs(cfg).items():
        if names and name not in names:
            continue
        write_json(cfg["work_dir"] / "runout" / f"run_{name}.json", run_one(cfg, name, spec, dem))


if __name__ == "__main__":
    main(sys.argv[1:])
