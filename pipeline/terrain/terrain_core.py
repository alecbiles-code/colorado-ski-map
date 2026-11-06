"""Core terrain math and shared helpers for the Tier 2 terrain pipeline.

Slope and aspect use Horn (1981) on a 3x3 window. Row 0 of every array is the northern edge
(GeoTIFF convention), columns increase eastward. `slope_aspect` returns aspect as the downslope
direction in degrees clockwise from UTM grid north (0 north, 90 east); flat cells are -1.
Published aspect is relative to TRUE north: `true_north_aspect` adds the meridian convergence at
the cell centre. The convergence formula mirrors app/lib/terrain-math.js operation for operation.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
import yaml

LOG = logging.getLogger("terrain")
REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"
FLAT_ASPECT = -1.0

# GRS80 and UTM constants, written exactly as in app/lib/terrain-math.js so both give equal doubles.
_A = 6378137.0
_F = 1 / 298.257222101
_N = _F / (2 - _F)
_N2 = _N * _N
_N3 = _N2 * _N
_N4 = _N3 * _N
_RECT = (_A / (1 + _N)) * (1 + _N2 / 4 + _N4 / 64)
_BETA = (_N / 2 - (2 * _N2) / 3 + (37 * _N3) / 96, _N2 / 48 + _N3 / 15, (17 * _N3) / 480)
UTM_K0 = 0.9996


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load the pipeline YAML config and resolve its directories.

    Args:
        path: Path to config.yaml.

    Returns:
        Config dict with `work_dir` and `out_dir` as absolute Paths.
    """
    cfg = yaml.safe_load(path.read_text())
    cfg["work_dir"] = Path(cfg["work_dir"])
    cfg["out_dir"] = (REPO_ROOT / cfg["out_dir"]).resolve()
    cfg["work_dir"].mkdir(parents=True, exist_ok=True)
    cfg["out_dir"].mkdir(parents=True, exist_ok=True)
    return cfg


def setup_logging() -> None:
    """Configure INFO-level logging with timestamps."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def horn_gradient(z: np.ndarray, dx: float, dy: float) -> tuple[np.ndarray, np.ndarray]:
    """Horn finite-difference gradient.

    Args:
        z: 2-D elevation array (metres), NaN for no data, row 0 = north.
        dx: Cell width in metres (east-west).
        dy: Cell height in metres (north-south).

    Returns:
        (p, q): dz/d(east) and dz/d(north), same shape as z. Edge cells and any cell whose
        3x3 window touches NaN are NaN.
    """
    z = np.asarray(z, dtype=np.float64)
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    p = np.full(z.shape, np.nan)
    q = np.full(z.shape, np.nan)
    p[1:-1, 1:-1] = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * dx)
    q[1:-1, 1:-1] = ((a + 2 * b + c) - (g + 2 * h + i)) / (8.0 * dy)
    p[1:-1, 1:-1][np.isnan(z[1:-1, 1:-1])] = np.nan
    return p, q


def slope_aspect(
    z: np.ndarray, dx: float, dy: float, flat_threshold_deg: float
) -> tuple[np.ndarray, np.ndarray]:
    """Slope (degrees) and aspect (degrees clockwise from grid north, -1 flat).

    Args:
        z: 2-D elevation array (metres), NaN for no data, row 0 = north.
        dx: Cell width in metres.
        dy: Cell height in metres.
        flat_threshold_deg: Cells with slope below this get aspect -1.

    Returns:
        (slope, aspect) float64 arrays; NaN where undefined (edges, no data).
    """
    p, q = horn_gradient(z, dx, dy)
    slope = np.degrees(np.arctan(np.hypot(p, q)))
    aspect = np.mod(np.degrees(np.arctan2(-p, -q)) + 360.0, 360.0)
    aspect = np.where(slope < flat_threshold_deg, FLAT_ASPECT, aspect)
    aspect[np.isnan(slope)] = np.nan
    return slope, aspect


def meridian_convergence_deg(e: np.ndarray, n: np.ndarray) -> np.ndarray:
    """Meridian convergence at UTM points (northern hemisphere), Krueger series (Karney 2011).

    Sign: negative west of the central meridian. True-north azimuth = grid azimuth + result.

    Args:
        e: Easting(s) in metres.
        n: Northing(s) in metres.

    Returns:
        Convergence in degrees, broadcast shape of e and n.
    """
    xi = n / (UTM_K0 * _RECT)
    eta = (e - 500000.0) / (UTM_K0 * _RECT)
    xi1, eta1, p, q = xi, eta, 1.0, 0.0
    for j, b in enumerate(_BETA, start=1):
        xi1 = xi1 - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta1 = eta1 - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
        p = p - 2 * j * b * np.cos(2 * j * xi) * np.cosh(2 * j * eta)
        q = q + 2 * j * b * np.sin(2 * j * xi) * np.sinh(2 * j * eta)
    return np.degrees(np.arctan(np.tan(xi1) * np.tanh(eta1)) + np.arctan2(q, p))


def true_north_aspect(aspect_grid: np.ndarray, convergence_deg: np.ndarray) -> np.ndarray:
    """Grid-north aspect to true-north aspect in [0, 360); -1 (flat) and NaN pass through."""
    t = np.mod(aspect_grid + convergence_deg, 360.0)
    return np.where(aspect_grid < 0, aspect_grid, t)


def slope_class_index(slope: np.ndarray, classes: list[dict[str, Any]]) -> np.ndarray:
    """Map slope degrees to class index (lower bound inclusive, upper exclusive).

    Args:
        slope: Slope array in degrees, NaN for no data.
        classes: Ordered `slope_classes` list from config (each has `min`).

    Returns:
        int16 array of class indices into `classes`; -1 where slope is NaN.
    """
    mins = np.array([c["min"] for c in classes[1:]], dtype=np.float64)
    idx = np.searchsorted(mins, np.nan_to_num(slope, nan=-1.0), side="right").astype(np.int16)
    idx[np.isnan(slope)] = -1
    return idx


def replace_atomic(tmp: Path, final: Path) -> None:
    """Rename a finished temp file onto its final name (atomic on one filesystem).

    Args:
        tmp: Completed temporary file.
        final: Destination path.
    """
    os.replace(tmp, final)
    LOG.info("wrote %s (%d bytes)", final, final.stat().st_size)
