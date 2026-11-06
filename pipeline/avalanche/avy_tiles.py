"""Tile writers for avalanche-model web products.

1. Display: classified rasters (uint8 class codes on the UTM pilot grid) rendered to Web Mercator
   PNG tiles. Max zoom samples the analysis cell under each pixel centre (nearest neighbour, no
   interpolation); lower zooms take the maximum class of the 2 x 2 child pixels, so a class never
   disappears when zooming out (classes are ordered by intensity).
2. Numeric: integer blocks on the UTM grid in the terrain lane's scheme (pipeline/terrain/
   numeric_tiles.py, decoded by app/lib/terrain-math.js decodeNumericTile/numericCellAt).
"""

from __future__ import annotations

import io
import math
import zlib
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from pyproj import Transformer

HALF = 20037508.342789244  # Web Mercator half-extent (m)


def tile_range(bbox: tuple[float, float, float, float], z: int) -> tuple[range, range]:
    """Web Mercator tile x and y ranges covering a lon/lat bbox.

    Args:
        bbox: (west, south, east, north) degrees.
        z: Zoom.

    Returns:
        (xs, ys).
    """
    n = 2 ** z
    def ty(lat: float) -> int:
        return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    w, s, e, nn = bbox
    return range(int((w + 180) / 360 * n), int((e + 180) / 360 * n) + 1), range(ty(nn), ty(s) + 1)


def render_tile(codes: np.ndarray, grid: dict[str, Any], to_utm: Transformer,
                z: int, x: int, y: int) -> np.ndarray:
    """Nearest-neighbour class codes for one 256 x 256 Web Mercator tile.

    Args:
        codes: uint8 class grid (row 0 north) on the analysis grid; 0 = no class.
        grid: config `grid` section.
        to_utm: EPSG:3857 -> grid CRS transformer (always_xy).
        z, x, y: Tile address.

    Returns:
        uint8 (256, 256).
    """
    res = 2 * HALF / (256 * 2 ** z)
    j, i = np.meshgrid(np.arange(256) + 0.5, np.arange(256) + 0.5)
    e, n = to_utm.transform(-HALF + (x * 256 + j) * res, HALF - (y * 256 + i) * res)
    xmin, _, _, ymax = grid["bounds"]
    col = np.floor((e - xmin) / grid["res_m"]).astype(np.int64)
    row = np.floor((ymax - n) / grid["res_m"]).astype(np.int64)
    ok = (row >= 0) & (row < codes.shape[0]) & (col >= 0) & (col < codes.shape[1])
    out = np.zeros((256, 256), dtype=np.uint8)
    out[ok] = codes[row[ok], col[ok]]
    return out


def pyramid(codes: np.ndarray, grid: dict[str, Any], bbox: tuple[float, float, float, float],
            minzoom: int, maxzoom: int) -> dict[tuple[int, int, int], np.ndarray]:
    """All tiles from maxzoom down to minzoom; lower zooms are 2 x 2 max of their children.

    Args:
        codes: uint8 class grid.
        grid: config `grid` section.
        bbox: lon/lat bbox of the grid.
        minzoom: Lowest zoom.
        maxzoom: Highest zoom (sampled from the grid).

    Returns:
        {(z, x, y): uint8 (256, 256)} including empty tiles.
    """
    to_utm = Transformer.from_crs("EPSG:3857", grid["crs"], always_xy=True)
    xs, ys = tile_range(bbox, maxzoom)
    tiles = {(maxzoom, x, y): render_tile(codes, grid, to_utm, maxzoom, x, y) for x in xs for y in ys}
    for z in range(maxzoom - 1, minzoom - 1, -1):
        xs, ys = tile_range(bbox, z)
        for x in xs:
            for y in ys:
                big = np.zeros((512, 512), dtype=np.uint8)
                for dx in (0, 1):
                    for dy in (0, 1):
                        child = tiles.get((z + 1, 2 * x + dx, 2 * y + dy))
                        if child is not None:
                            big[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = child
                tiles[(z, x, y)] = big.reshape(256, 2, 256, 2).max(axis=(1, 3))
    return tiles


def png_bytes(tile: np.ndarray, colors: dict[int, str]) -> bytes:
    """Paletted PNG; code 0 transparent, other codes opaque in their configured colour.

    Args:
        tile: uint8 class codes.
        colors: {code: "#rrggbb"}.

    Returns:
        PNG bytes.
    """
    pal = [0] * 768
    alpha = [0] * 256
    for code, hexc in colors.items():
        pal[3 * code:3 * code + 3] = [int(hexc[k:k + 2], 16) for k in (1, 3, 5)]
        alpha[code] = 255
    im = Image.fromarray(tile, mode="P")
    im.putpalette(pal)
    buf = io.BytesIO()
    im.save(buf, format="PNG", transparency=bytes(alpha[:max(colors) + 1]), optimize=True)
    return buf.getvalue()


def write_pmtiles(path: Path, tiles: dict[tuple[int, int, int], bytes], bbox: tuple[float, ...],
                  tile_type: TileType, center_zoom: int, metadata: dict[str, Any]) -> None:
    """Write tiles (ascending tile id, clustered) to a PMTiles v3 archive.

    Args:
        path: Output path.
        tiles: {(z, x, y): payload bytes}.
        bbox: (west, south, east, north) degrees.
        tile_type: PMTiles tile type.
        center_zoom: Header centre zoom.
        metadata: JSON metadata stored in the archive.
    """
    e7 = lambda v: int(round(v * 1e7))  # noqa: E731
    w, s, e, n = bbox
    with open(path, "wb") as f:
        writer = Writer(f)
        for tid, data in sorted((zxy_to_tileid(*k), v) for k, v in tiles.items()):
            writer.write_tile(tid, data)
        writer.finalize({"tile_type": tile_type, "tile_compression": Compression.NONE,
                         "min_lon_e7": e7(w), "min_lat_e7": e7(s), "max_lon_e7": e7(e),
                         "max_lat_e7": e7(n), "center_zoom": center_zoom,
                         "center_lon_e7": e7((w + e) / 2), "center_lat_e7": e7((s + n) / 2)},
                        metadata)


def encode_block(n: np.ndarray, level: int = 9) -> bytes:
    """Numeric tile payload, identical to pipeline/terrain/numeric_tiles.py encode_block.

    2-D difference residuals, zigzag, uint32 LE byte planes, zlib.

    Args:
        n: 2-D integer block.
        level: zlib level.

    Returns:
        Payload bytes.
    """
    r = np.diff(np.diff(n.astype(np.int64), axis=0, prepend=0), axis=1, prepend=0).astype(np.int32)
    zz = ((r << 1) ^ (r >> 31)).astype(np.uint32).astype("<u4")
    return zlib.compress(zz.reshape(-1).view(np.uint8).reshape(-1, 4).T.tobytes(), level)


def decode_block(payload: bytes, side: int) -> np.ndarray:
    """Inverse of encode_block (Python port of terrain-math.js decodeNumericTile), for tests.

    Args:
        payload: Tile bytes.
        side: Block side in cells.

    Returns:
        int64 (side, side).
    """
    planes = np.frombuffer(zlib.decompress(payload), dtype=np.uint8).reshape(4, -1)
    u = planes.T.copy().view("<u4").reshape(side, side).astype(np.int64)
    r = (u >> 1) ^ -(u & 1)
    return np.cumsum(np.cumsum(r, axis=1), axis=0)


def numeric_blocks(values: np.ndarray, grid: dict[str, Any], num: dict[str, Any],
                   z: int) -> dict[tuple[int, int, int], bytes]:
    """Cut an int grid into terrain-scheme UTM blocks (no apron) and encode each.

    Args:
        values: int64 grid on the pilot grid.
        grid: config `grid` section.
        num: Numeric scheme (originE, originN, blockCells, nodata).
        z: Tile zoom used as the variable key.

    Returns:
        {(z, x, y): payload}.
    """
    b, res = num["blockCells"], grid["res_m"]
    xmin, ymin, xmax, ymax = grid["bounds"]
    gc0, gr0 = round((xmin - num["originE"]) / res), round((num["originN"] - ymax) / res)
    out = {}
    for x in range(gc0 // b, (gc0 + values.shape[1] - 1) // b + 1):
        for y in range(gr0 // b, (gr0 + values.shape[0] - 1) // b + 1):
            blk = np.full((b, b), num["nodata"], dtype=np.int64)
            r0, c0 = y * b - gr0, x * b - gc0
            rs, cs = max(r0, 0), max(c0, 0)
            re, ce = min(r0 + b, values.shape[0]), min(c0 + b, values.shape[1])
            blk[rs - r0:re - r0, cs - c0:ce - c0] = values[rs:re, cs:ce]
            out[(z, x, y)] = encode_block(blk)
    return out
