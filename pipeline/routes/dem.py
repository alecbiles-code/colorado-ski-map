"""DEM sampling along lines from Terrarium-encoded terrain tiles (Mapterhorn WebP or AWS PNG).

Elevation is bilinear-interpolated on the Web Mercator tile grid. Aspect uses
Horn's 3x3 gradient with the true per-latitude Mercator pixel size, reported
as degrees clockwise from north of the downslope direction.
"""

from __future__ import annotations

import io
import logging
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image

log = logging.getLogger("routes.dem")
EARTH_RADIUS_M = 6378137.0  # Web Mercator sphere radius
MEAN_EARTH_RADIUS_M = 6371008.8  # for haversine distances


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    """Decode Terrarium RGB to elevation in metres: R*256 + G + B/256 - 32768."""
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def lonlat_to_pixel(lon: float, lat: float, zoom: int, tile_size: int) -> tuple[float, float]:
    """Convert lon/lat to global Web Mercator pixel coordinates (y grows south)."""
    world = tile_size * (2**zoom)
    x = (lon + 180.0) / 360.0 * world
    phi = math.radians(lat)
    y = (1.0 - math.log(math.tan(phi) + 1.0 / math.cos(phi)) / math.pi) / 2.0 * world
    return x, y


def pixel_size_m(lat: float, zoom: int, tile_size: int) -> float:
    """Ground size of one Web Mercator pixel at a latitude, in metres."""
    return 2.0 * math.pi * EARTH_RADIUS_M * math.cos(math.radians(lat)) / (tile_size * 2**zoom)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between two lon/lat points."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * MEAN_EARTH_RADIUS_M * math.asin(math.sqrt(h))


def densify(line: list[list[float]], spacing_m: float) -> list[tuple[float, float]]:
    """Return points along a line no further apart than spacing_m (vertices kept)."""
    out: list[tuple[float, float]] = [(line[0][0], line[0][1])]
    for p, q in zip(line[:-1], line[1:]):
        n = max(1, math.ceil(haversine_m(p, q) / spacing_m))
        for k in range(1, n + 1):
            t = k / n
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return out


class TerrariumDEM:
    """Tile-cached Terrarium DEM reader; tiles are stored on disk as downloaded (PNG or WebP)."""

    def __init__(self, url_template: str, zoom: int, tile_size: int, cache_dir: Path, user_agent: str,
                 max_workers: int = 4, retries: int = 4):
        self.url_template, self.zoom, self.tile_size = url_template, zoom, tile_size
        self.cache_dir, self.user_agent = cache_dir, user_agent
        self.max_workers, self.retries = max_workers, retries
        self.suffix = Path(url_template).suffix
        self._tiles: dict[tuple[int, int], np.ndarray] = {}
        self.fetched = 0

    def _path(self, x: int, y: int) -> Path:
        return self.cache_dir / str(self.zoom) / str(x) / f"{y}{self.suffix}"

    def _download(self, key: tuple[int, int]) -> None:
        path = self._path(*key)
        if path.exists():
            return
        url = self.url_template.format(z=self.zoom, x=key[0], y=key[1])
        for attempt in range(self.retries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read()
                break
            except OSError as exc:  # URLError and connection resets
                if attempt == self.retries - 1:
                    raise
                log.warning("retry %s after %s", url, exc)
                time.sleep(2**attempt)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.fetched += 1

    def prefetch(self, keys: Iterable[tuple[int, int]]) -> None:
        """Download any missing tiles in parallel."""
        todo = [k for k in set(keys) if not self._path(*k).exists()]
        log.info("DEM tiles to download: %d", len(todo))
        with ThreadPoolExecutor(self.max_workers) as pool:
            list(pool.map(self._download, todo))

    def tile(self, key: tuple[int, int]) -> np.ndarray:
        """Return a decoded elevation tile, loading from cache or network."""
        if key not in self._tiles:
            self._download(key)
            img = Image.open(io.BytesIO(self._path(*key).read_bytes())).convert("RGB")
            self._tiles[key] = decode_terrarium(np.asarray(img))
        return self._tiles[key]

    def pixel(self, ix: int, iy: int) -> float:
        """Elevation of one global pixel."""
        ts = self.tile_size
        return float(self.tile((ix // ts, iy // ts))[iy % ts, ix % ts])

    def elevation(self, lon: float, lat: float) -> float:
        """Bilinear elevation at a lon/lat (pixel centres at +0.5)."""
        px, py = lonlat_to_pixel(lon, lat, self.zoom, self.tile_size)
        u, v = px - 0.5, py - 0.5
        i0, j0 = math.floor(u), math.floor(v)
        fx, fy = u - i0, v - j0
        z00, z10 = self.pixel(i0, j0), self.pixel(i0 + 1, j0)
        z01, z11 = self.pixel(i0, j0 + 1), self.pixel(i0 + 1, j0 + 1)
        return (z00 * (1 - fx) + z10 * fx) * (1 - fy) + (z01 * (1 - fx) + z11 * fx) * fy

    def window(self, lon: float, lat: float) -> np.ndarray:
        """3x3 elevation window centred on the pixel containing lon/lat."""
        px, py = lonlat_to_pixel(lon, lat, self.zoom, self.tile_size)
        ix, iy = math.floor(px), math.floor(py)
        return np.array([[self.pixel(ix + dx, iy + dy) for dx in (-1, 0, 1)] for dy in (-1, 0, 1)])

    def tiles_for(self, points: Iterable[tuple[float, float]]) -> set[tuple[int, int]]:
        """Tiles (with one-pixel margin) needed to sample the given points."""
        keys: set[tuple[int, int]] = set()
        ts = self.tile_size
        for lon, lat in points:
            px, py = lonlat_to_pixel(lon, lat, self.zoom, ts)
            for dx in (-1.5, 1.5):
                for dy in (-1.5, 1.5):
                    keys.add((int((px + dx) // ts), int((py + dy) // ts)))
        return keys


def horn_aspect_deg(win: np.ndarray, cell_m: float) -> float | None:
    """Downslope aspect (degrees clockwise from north) from a 3x3 window.

    Rows run north to south, columns west to east. Returns None on flat cells.
    """
    a, b, c = win[0]
    d, _, f = win[1]
    g, h, i = win[2]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell_m)
    dzdsouth = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell_m)
    dzdnorth = -dzdsouth
    if math.hypot(dzdx, dzdnorth) < 1e-6:
        return None
    return math.degrees(math.atan2(-dzdx, -dzdnorth)) % 360.0


def circular_mean_deg(angles: list[float]) -> tuple[float | None, float | None]:
    """Circular mean of angles in degrees and resultant length (0..1)."""
    if not angles:
        return None, None
    s = sum(math.sin(math.radians(a)) for a in angles) / len(angles)
    c = sum(math.cos(math.radians(a)) for a in angles) / len(angles)
    r = math.hypot(s, c)
    if r < 1e-9:
        return None, 0.0
    return math.degrees(math.atan2(s, c)) % 360.0, r


def gain_loss(elevs: list[float]) -> tuple[float, float]:
    """Sum of positive and negative elevation steps (loss returned positive)."""
    diffs = np.diff(np.asarray(elevs, dtype=float))
    return float(diffs[diffs > 0].sum()), float(-diffs[diffs < 0].sum())


def line_metrics(dem: TerrariumDEM, parts: list[list[list[float]]], spacing_m: float, want_aspect: bool) -> dict[str, Any]:
    """DEM metrics over one or more line parts (each part sampled separately).

    Args:
        dem: DEM reader.
        parts: Line parts as lists of [lon, lat].
        spacing_m: Maximum sample spacing in metres.
        want_aspect: Compute the mean downslope aspect (descent lines).

    Returns:
        Dictionary of dem* fields in metres and degrees.
    """
    gain = loss = 0.0
    elev_all: list[float] = []
    aspects: list[float] = []
    for part in parts:
        pts = densify(part, spacing_m)
        elevs = [dem.elevation(lon, lat) for lon, lat in pts]
        g, l = gain_loss(elevs)
        gain, loss = gain + g, loss + l
        elev_all.extend(elevs)
        if want_aspect:
            for lon, lat in pts:
                asp = horn_aspect_deg(dem.window(lon, lat), pixel_size_m(lat, dem.zoom, dem.tile_size))
                if asp is not None:
                    aspects.append(asp)
    out: dict[str, Any] = {
        "demGainM": round(gain, 1), "demLossM": round(loss, 1),
        "demMinElevM": round(min(elev_all), 1), "demMaxElevM": round(max(elev_all), 1),
    }
    if want_aspect:
        mean, r = circular_mean_deg(aspects)
        out["demMeanAspectDeg"] = None if mean is None else round(mean, 1)
        out["demAspectResultant"] = None if r is None else round(r, 3)
    return out
