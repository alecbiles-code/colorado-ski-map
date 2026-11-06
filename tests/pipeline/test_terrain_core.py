"""Synthetic-surface tests for pipeline/terrain/terrain_core.py (Horn slope, aspect, classes)."""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline" / "terrain"))
import terrain_core as tc  # noqa: E402

CLASSES = tc.load_config()["slope_classes"]
FLAT = 1.0


def plane(slope_deg: float, aspect_deg: float, dx: float, dy: float, n: int = 9) -> np.ndarray:
    """Plane that falls at slope_deg toward aspect_deg (clockwise from north). Row 0 = north."""
    rows, cols = np.mgrid[0:n, 0:n]
    east, north = cols * dx, -rows * dy
    a = math.radians(aspect_deg)
    return 3000.0 - math.tan(math.radians(slope_deg)) * (math.sin(a) * east + math.cos(a) * north)


@pytest.mark.parametrize("slope_deg", [25.0, 30.0, 35.0, 45.0, 10.0, 60.0])
@pytest.mark.parametrize("aspect_deg", [0.0, 90.0, 180.0, 270.0, 45.0, 225.0])
@pytest.mark.parametrize("dx,dy", [(10.0, 10.0), (7.35, 7.32)])
def test_plane(slope_deg: float, aspect_deg: float, dx: float, dy: float) -> None:
    s, a = tc.slope_aspect(plane(slope_deg, aspect_deg, dx, dy), dx, dy, FLAT)
    inner = (slice(1, -1), slice(1, -1))
    assert np.allclose(s[inner], slope_deg, atol=1e-9)
    diff = (a[inner] - aspect_deg + 180.0) % 360.0 - 180.0
    assert np.allclose(diff, 0.0, atol=1e-9)
    assert np.isnan(s[0]).all() and np.isnan(s[:, -1]).all()


def test_rising_east_faces_west() -> None:
    z = np.tile(np.arange(5, dtype=float) * 10.0, (5, 1))  # rises 10 m per 10 m cell eastward
    s, a = tc.slope_aspect(z, 10.0, 10.0, FLAT)
    assert s[2, 2] == pytest.approx(45.0)
    assert a[2, 2] == pytest.approx(270.0)


def test_cone() -> None:
    n, d, k = 201, 10.0, math.tan(math.radians(35.0))
    rows, cols = np.mgrid[0:n, 0:n]
    east, north = (cols - 100) * d, (100 - rows) * d
    s, a = tc.slope_aspect(4000.0 - k * np.hypot(east, north), d, d, FLAT)
    r = np.hypot(east, north)
    ring = (r > 200.0) & ~np.isnan(s)
    assert np.abs(s[ring] - 35.0).max() < 0.05
    expected = np.degrees(np.arctan2(east, north)) % 360.0
    diff = (a[ring] - expected[ring] + 180.0) % 360.0 - 180.0
    assert np.abs(diff).max() < 0.5


def test_nodata_hole() -> None:
    z = plane(30.0, 90.0, 10.0, 10.0, n=11)
    z[5, 5] = np.nan
    s, a = tc.slope_aspect(z, 10.0, 10.0, FLAT)
    assert np.isnan(s[4:7, 4:7]).all() and np.isnan(a[4:7, 4:7]).all()
    valid = np.ones_like(s, dtype=bool)
    valid[[0, -1], :] = valid[:, [0, -1]] = False
    valid[4:7, 4:7] = False
    assert np.allclose(s[valid], 30.0)


def test_flat_and_gentle() -> None:
    s, a = tc.slope_aspect(np.full((5, 5), 2500.0), 10.0, 10.0, FLAT)
    assert s[2, 2] == 0.0 and a[2, 2] == -1.0
    s, a = tc.slope_aspect(plane(0.5, 90.0, 10.0, 10.0, 5), 10.0, 10.0, FLAT)
    assert s[2, 2] == pytest.approx(0.5) and a[2, 2] == -1.0


@pytest.mark.parametrize("value,label", [
    (0.0, "<25"), (24.999, "<25"), (25.0, "25-30"), (29.9999, "25-30"), (30.0, "30-35"),
    (34.99, "30-35"), (35.0, "35-40"), (40.0, "40-45"), (44.999, "40-45"), (45.0, ">=45"),
    (89.9, ">=45")])
def test_class_boundaries(value: float, label: str) -> None:
    idx = tc.slope_class_index(np.array([value]), CLASSES)[0]
    assert CLASSES[idx]["label"] == label


def test_class_nodata() -> None:
    assert tc.slope_class_index(np.array([np.nan]), CLASSES)[0] == -1


def test_strips_match_whole_array() -> None:
    import build_analysis
    from rasterio.transform import from_origin
    rng = np.random.default_rng(1)
    z = np.cumsum(np.cumsum(rng.normal(size=(53, 41)), 0), 1)
    z[20, 10] = np.nan
    t = from_origin(413950.0, 4419520.0, 10.0, 10.0)
    s0, a0 = tc.slope_aspect(z, 10.0, 10.0, FLAT)
    rows, cols = np.mgrid[0:53, 0:41]
    conv = tc.meridian_convergence_deg(413950.0 + (cols + 0.5) * 10.0, 4419520.0 - (rows + 0.5) * 10.0)
    s1, a1 = build_analysis.strips(z, t, 10.0, FLAT, 7)
    np.testing.assert_array_equal(s1, s0.astype(np.float32))
    np.testing.assert_array_equal(a1, tc.true_north_aspect(a0, conv).astype(np.float32))


@pytest.mark.parametrize("e,n,ref", [
    (414115, 4419355, -0.6449466466), (446995, 4381325, -0.3932570906),
    (430565, 4400345, -0.5182811702), (139565, 4102545, -2.4399651577),
    (748955, 4542975, 1.9429197012), (500000, 4427755, 0.0), (283205, 4308655, -1.5704957491)])
def test_convergence_matches_proj(e: float, n: float, ref: float) -> None:
    """Reference: pyproj Proj('EPSG:26913').get_factors(lon, lat).meridian_convergence."""
    assert float(tc.meridian_convergence_deg(np.float64(e), np.float64(n))) == pytest.approx(ref, abs=1e-8)


def test_convergence_sign_is_true_north_minus_grid() -> None:
    """A step due true north has grid bearing -convergence (west of the central meridian > 0)."""
    from pyproj import Transformer
    to_utm = Transformer.from_crs(4269, 26913, always_xy=True)
    lon, lat = -105.9, 39.8
    e0, n0 = to_utm.transform(lon, lat)
    e1, n1 = to_utm.transform(lon, lat + 1e-5)
    bearing_of_true_north = math.degrees(math.atan2(e1 - e0, n1 - n0))
    conv = float(tc.meridian_convergence_deg(np.float64(e0), np.float64(n0)))
    assert bearing_of_true_north == pytest.approx(-conv, abs=1e-5)
    # A slope facing true north therefore has grid aspect -conv, and true aspect 0.
    assert float(tc.true_north_aspect(np.float64(-conv % 360.0), conv)) % 360.0 == pytest.approx(0.0, abs=1e-9)


def test_true_north_aspect_passthrough_and_wrap() -> None:
    a = np.array([-1.0, np.nan, 0.2, 359.9, 180.0])
    out = tc.true_north_aspect(a, np.array([-0.5, -0.5, -0.5, 0.5, -0.5]))
    assert out[0] == -1.0 and np.isnan(out[1])
    assert out[2] == pytest.approx(359.7) and out[3] == pytest.approx(0.4) and out[4] == 179.5


def lightness(hex_color: str) -> float:
    """CIELAB L* of an sRGB hex color (D65)."""
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.0721750 * lin[2]
    return 116 * y ** (1 / 3) - 16 if y > 216 / 24389 else 24389 / 27 * y


def test_class_colors_ordered_by_lightness() -> None:
    lum = [lightness(c["color"]) for c in CLASSES[1:]]
    assert all(a - b >= 12.0 for a, b in zip(lum, lum[1:])), lum


def test_snap_to_grid_lands_on_source_pixel_edges() -> None:
    import build_analysis
    raw = (-106.0083, 39.5751, -105.6146, 39.9248)
    w, s, e, n = build_analysis.snap_to_grid(raw, 10800)
    # n40w106 geotransform; its pixel size is rounded in the file, so allow 1e-4 px (about 1 mm)
    origin, size = -106.00055555649311, 9.259259269220167e-05
    for v in (w, e):
        k = (v - origin) / size
        assert abs(k - round(k)) < 1e-4
    for v in (s, n):
        k = (v - 40.000555556394715) / size
        assert abs(k - round(k)) < 1e-4
    assert w <= raw[0] and s <= raw[1] and e >= raw[2] and n >= raw[3]
