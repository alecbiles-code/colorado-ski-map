"""Shared helpers for the avalanche terrain model pilot (PRA + Flow-Py runout).

Grid convention: row 0 is the northern edge, columns increase eastward (GeoTIFF). Every raster
this pipeline reads or writes must sit exactly on the shared pilot grid in config.yaml.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
import yaml
from numba import njit, prange
from rasterio.transform import from_origin

LOG = logging.getLogger("avalanche")
REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load config.yaml and resolve work_dir/out_dir to absolute Paths (created if missing).

    Args:
        path: Path to config.yaml.

    Returns:
        Config dict.
    """
    cfg = yaml.safe_load(Path(path).read_text())
    cfg["work_dir"] = Path(cfg["work_dir"])
    cfg["out_dir"] = (REPO_ROOT / cfg["out_dir"]).resolve()
    for d in (cfg["work_dir"], cfg["out_dir"], cfg["work_dir"] / "inputs", cfg["work_dir"] / "pra"):
        d.mkdir(parents=True, exist_ok=True)
    return cfg


def setup_logging() -> None:
    """Configure INFO-level logging with timestamps."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def grid_profile(cfg: dict[str, Any], dtype: str, nodata: float) -> dict[str, Any]:
    """GeoTIFF profile for the shared pilot grid.

    Args:
        cfg: Loaded config.
        dtype: numpy dtype name for the band.
        nodata: NoData value to declare.

    Returns:
        rasterio profile dict.
    """
    g = cfg["grid"]
    xmin, _, _, ymax = g["bounds"]
    rows, cols = g["shape"]
    return {
        "driver": "GTiff", "dtype": dtype, "nodata": nodata, "count": 1,
        "width": cols, "height": rows, "crs": g["crs"],
        "transform": from_origin(xmin, ymax, g["res_m"], g["res_m"]),
        "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "deflate",
    }


def check_on_grid(path: Path, cfg: dict[str, Any]) -> None:
    """Raise ValueError unless the raster at `path` is exactly on the pilot grid.

    Args:
        path: Raster to check.
        cfg: Loaded config.
    """
    ref = grid_profile(cfg, "float32", -9999.0)
    with rasterio.open(path) as src:
        same = (src.crs == rasterio.crs.CRS.from_user_input(ref["crs"])
                and (src.height, src.width) == (ref["height"], ref["width"])
                and src.transform.almost_equals(ref["transform"], precision=1e-6))
        if not same:
            raise ValueError(f"{path} is not on the pilot grid: {src.crs} {src.shape} {src.transform}")


def read_band(path: Path) -> tuple[np.ndarray, Any]:
    """Read band 1 and its NoData value.

    Args:
        path: Raster path.

    Returns:
        (array, nodata).
    """
    with rasterio.open(path) as src:
        return src.read(1), src.nodata


def write_band(path: Path, arr: np.ndarray, cfg: dict[str, Any], nodata: float) -> None:
    """Write a single-band GeoTIFF on the pilot grid.

    Args:
        path: Output path.
        arr: 2-D array with the pilot grid shape.
        cfg: Loaded config.
        nodata: NoData value to declare.
    """
    prof = grid_profile(cfg, arr.dtype.name, nodata)
    with rasterio.open(path, "w", **prof) as dst:
        dst.write(arr, 1)
    LOG.info("wrote %s", path)


def sha256(path: Path) -> str:
    """Hex sha256 of a file.

    Args:
        path: File path.

    Returns:
        Hex digest.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, obj: Any) -> None:
    """Write JSON with stable formatting.

    Args:
        path: Output path.
        obj: JSON-serialisable object.
    """
    Path(path).write_text(json.dumps(obj, indent=2, sort_keys=False) + "\n")


def cauchy(x: np.ndarray, a: float, b: float, c: float) -> np.ndarray:
    """Generalised bell (Cauchy) membership 1 / (1 + ((x - c) / a) ** (2b)).

    Args:
        x: Input values.
        a: Width.
        b: Shape exponent (2b must be even for real results below c; integer b).
        c: Centre.

    Returns:
        Membership in [0, 1], NaN where x is NaN.
    """
    return 1.0 / (1.0 + ((np.asarray(x, dtype=np.float64) - c) / a) ** (2.0 * b))


def fuzzy_and(members: list[np.ndarray]) -> np.ndarray:
    """Ordered-weighted fuzzy AND of Veitinger et al. (2016): (1 - m) m + m mean(members), m = min.

    Args:
        members: Membership arrays of equal shape.

    Returns:
        Aggregated membership.
    """
    m = np.minimum.reduce(members)
    return (1.0 - m) * m + m * np.mean(members, axis=0)


def sector_offsets(radius_m: float, cell_m: float, direction: float, tolerance: float) -> np.ndarray:
    """Neighbour offsets (drow, dcol, distance_m) inside a circular sector, centre excluded.

    Args:
        radius_m: Search radius in metres.
        cell_m: Cell size in metres.
        direction: Sector centre azimuth in degrees clockwise from north (where wind comes from).
        tolerance: Half-width of the sector in degrees; 180 means the full circle.

    Returns:
        float64 array (n, 3).
    """
    r = int(round(radius_m / cell_m))
    out = []
    for dr in range(-r, r + 1):
        for dc in range(-r, r + 1):
            d = np.hypot(dr, dc)
            if d == 0 or d > r:
                continue
            az = np.degrees(np.arctan2(dc, -dr)) % 360.0
            diff = abs((az - direction + 180.0) % 360.0 - 180.0)
            if tolerance >= 180.0 or diff <= tolerance:
                out.append((dr, dc, d * cell_m))
    return np.array(out, dtype=np.float64)


@njit(parallel=True, cache=True)
def _windshelter_kernel(z: np.ndarray, offs: np.ndarray, prob: float) -> np.ndarray:
    rows, cols = z.shape
    out = np.full((rows, cols), np.nan)
    n = offs.shape[0]
    for i in prange(rows):
        buf = np.empty(n)
        for j in range(cols):
            z0 = z[i, j]
            if np.isnan(z0):
                continue
            k = 0
            for m in range(n):
                ii = i + int(offs[m, 0])
                jj = j + int(offs[m, 1])
                if ii < 0 or jj < 0 or ii >= rows or jj >= cols or np.isnan(z[ii, jj]):
                    k = -1
                    break
                buf[k] = np.arctan((z[ii, jj] - z0) / offs[m, 2])
                k += 1
            if k <= 0:
                continue
            out[i, j] = np.quantile(buf[:k], prob)
    return out


def windshelter(z: np.ndarray, cell_m: float, radius_m: float, prob: float,
                direction: float, tolerance: float) -> np.ndarray:
    """Wind shelter index (Plattner et al. 2004; Veitinger et al. 2016), radians.

    Quantile `prob` of arctan((z_neighbour - z_centre) / distance) over the sector. Positive means
    sheltered (surrounded by higher terrain), negative means exposed. Cells whose window leaves the
    array or touches NaN are NaN (never silently computed from a partial window).

    Args:
        z: Elevation (m), NaN for NoData.
        cell_m: Cell size (m).
        radius_m: Search radius (m).
        prob: Quantile in [0, 1].
        direction: Sector azimuth (degrees from north).
        tolerance: Sector half-width (degrees); 180 = omnidirectional.

    Returns:
        Wind shelter array (radians), NaN where undefined.
    """
    offs = sector_offsets(radius_m, cell_m, direction, tolerance)
    return _windshelter_kernel(np.asarray(z, dtype=np.float64), offs, float(prob))
