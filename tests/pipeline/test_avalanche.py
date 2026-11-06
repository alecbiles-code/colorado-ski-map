"""Synthetic tests for pipeline/avalanche (PRA memberships, wind shelter, binary PRA, tiling)."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline" / "avalanche"))
import avy_core as ac  # noqa: E402
import avy_tiles as at  # noqa: E402
import pra  # noqa: E402

CFG = ac.load_config()
P = CFG["pra"]


def test_cauchy_half_points() -> None:
    """Configured memberships cross 0.5 where the methods doc says they do."""
    a, b, c = P["slope_cauchy"]
    assert ac.cauchy(np.array([c - a, c + a]), a, b, c) == pytest.approx([0.5, 0.5])
    assert ac.cauchy(np.array([25.0]), *P["forest_cauchy"])[0] == pytest.approx(0.5)
    assert ac.cauchy(np.array([0.0]), *P["wind_cauchy"])[0] == pytest.approx(0.5)
    assert np.isnan(ac.cauchy(np.array([np.nan]), 1, 1, 0)[0])


def test_fuzzy_and_bounds() -> None:
    """All-one memberships give 1, any zero gives 0, result stays within [min, 1]."""
    one, zero, half = np.ones(3), np.zeros(3), np.full(3, 0.5)
    assert np.allclose(ac.fuzzy_and([one, one, one]), 1)
    assert np.allclose(ac.fuzzy_and([one, zero, half]), 0)
    r = ac.fuzzy_and([one, half, half])
    assert np.all((r >= 0.5) & (r <= 1))


def surface(kind: str, n: int = 31, cell: float = 10.0) -> np.ndarray:
    """Plane, bowl or dome elevations (m), row 0 = north."""
    r, c = np.mgrid[0:n, 0:n] * cell
    if kind == "plane":
        return 3000.0 + 0.6 * c - 0.3 * r
    d2 = (r - r.mean()) ** 2 + (c - c.mean()) ** 2
    return 3000.0 + (1 if kind == "bowl" else -1) * 0.002 * d2


def test_windshelter_signs_and_edges() -> None:
    """Plane -> 0 (symmetric), bowl centre sheltered (> 0), dome centre exposed (< 0), edges NaN."""
    kw = dict(cell_m=10.0, radius_m=60.0, prob=0.5, direction=0.0, tolerance=180.0)
    ws = ac.windshelter(surface("plane"), **kw)
    assert np.nanmax(np.abs(ws[6:-6, 6:-6])) < 1e-9
    assert np.isnan(ws[:6]).all() and np.isnan(ws[:, -6:]).all()
    assert ac.windshelter(surface("bowl"), **kw)[15, 15] > 0
    assert ac.windshelter(surface("dome"), **kw)[15, 15] < 0
    z = surface("plane")
    z[15, 18] = np.nan
    ws = ac.windshelter(z, **kw)
    assert np.isnan(ws[15, 15]) and not np.isnan(ws[15, 6])


def test_sector_offsets_count() -> None:
    """A 6-cell radius full circle has the integer lattice points inside it, centre excluded."""
    offs = ac.sector_offsets(60.0, 10.0, 0.0, 180.0)
    r, c = np.mgrid[-6:7, -6:7]
    assert len(offs) == int(((r ** 2 + c ** 2) <= 36).sum()) - 1
    half = ac.sector_offsets(60.0, 10.0, 0.0, 90.0)
    assert (half[:, 0] <= 0).all()  # north half: rows above or level with the centre


def test_unknown_canopy_gives_unknown_pra() -> None:
    """NaN canopy (NoData) must give NaN PRA and the unknown code, never 0 or release."""
    slope = np.full((5, 5), 38.0)
    ws = np.zeros((5, 5))
    canopy = np.zeros((5, 5))
    canopy[2, 2] = np.nan
    cont = pra.continuous_pra(slope, ws, canopy, P)
    assert np.isnan(cont[2, 2]) and cont[0, 0] > P["threshold"]
    b = pra.binary_pra(cont, P["threshold"], 1, 8)
    assert b[2, 2] == pra.UNKNOWN and b[0, 0] == 1


def test_dense_canopy_suppresses_release() -> None:
    """With the pcc curve, 60 % canopy on a 38 degree slope is not release; 0 % canopy is."""
    slope, ws = np.full(2, 38.0), np.zeros(2)
    cont = pra.continuous_pra(slope, ws, np.array([0.0, 60.0]), P)
    assert cont[0] >= P["threshold"] > cont[1]


def test_binary_sieve_connectivity() -> None:
    """Patches below min_cells are dropped; a diagonal pair is one patch only with 8-connectivity."""
    cont = np.zeros((8, 8))
    cont[1:3, 1:3] = 0.9          # 4 cells: kept
    cont[5, 5] = cont[6, 6] = 0.9  # diagonal pair
    b8 = pra.binary_pra(cont, 0.15, 2, 8)
    b4 = pra.binary_pra(cont, 0.15, 2, 4)
    assert b8[1:3, 1:3].all() and b8[5, 5] == 1 and b4[5, 5] == 0


def test_numeric_roundtrip_and_location() -> None:
    """encode/decode is lossless, and block placement matches numericCellAt arithmetic."""
    rng = np.random.default_rng(1)
    blk = rng.integers(-5000, 5000, (256, 256))
    assert np.array_equal(at.decode_block(at.encode_block(blk), 256), blk)
    grid = {"res_m": 10, "bounds": [414110, 4381320, 447020, 4419360]}
    num = {"originE": 0, "originN": 4700000, "blockCells": 256, "nodata": -1}
    vals = np.arange(3804 * 3291, dtype=np.int64).reshape(3804, 3291)
    tiles = at.numeric_blocks(vals, grid, num, 9)
    e, n = 430005.0, 4400005.0  # any point inside the grid
    gc, gr = int(e // 10), int((4700000 - n) // 10)
    x, y = gc // 256, gr // 256
    dec = at.decode_block(tiles[(9, x, y)], 256)
    row, col = int((4419360 - n) // 10), int((e - 414110) // 10)
    assert dec[gr - y * 256, gc - x * 256] == vals[row, col]


def test_render_tile_nearest() -> None:
    """Each tile pixel takes the code of the analysis cell under its centre (EPSG:3857 -> UTM)."""
    from pyproj import Transformer
    grid = CFG["grid"]
    codes = (np.arange(np.prod(grid["shape"])) % 251 + 1).astype(np.uint8).reshape(grid["shape"])
    to_utm = Transformer.from_crs("EPSG:3857", grid["crs"], always_xy=True)
    xs, ys = at.tile_range((-105.80, 39.78, -105.79, 39.79), 15)
    z, x, y = 15, xs[0], ys[0]
    t = at.render_tile(codes, grid, to_utm, z, x, y)
    res = 2 * at.HALF / (256 * 2 ** z)
    e, n = to_utm.transform(-at.HALF + (x * 256 + 100.5) * res, at.HALF - (y * 256 + 37.5) * res)
    assert t[37, 100] == codes[int((grid["bounds"][3] - n) // 10), int((e - grid["bounds"][0]) // 10)]


def test_pyramid_keeps_max_class() -> None:
    """A single high-class pixel survives aggregation to every lower zoom."""
    grid = {"crs": "EPSG:26913", "res_m": 10, "bounds": [430000, 4400000, 430100, 4400100],
            "shape": [10, 10]}
    codes = np.ones((10, 10), dtype=np.uint8)
    codes[5, 5] = 4
    from rasterio.warp import transform_bounds
    bbox = transform_bounds(grid["crs"], "EPSG:4326", *grid["bounds"])
    tiles = at.pyramid(codes, grid, bbox, 12, 15)
    for z in range(12, 16):
        assert max(t.max() for (zz, _, _), t in tiles.items() if zz == z) == 4
