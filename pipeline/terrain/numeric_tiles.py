"""Numeric inspection product: lossless 0.1 m elevation blocks on the analysis grid, in PMTiles.

Each tile is one block of block_cells x block_cells analysis cells plus a 1-cell apron, holding
integer elevations n = round(z * dem_scale) (the exact values the Tier 2 slope/aspect were
computed from). Payload: zlib(4 byte planes of zigzag(2-D difference residuals) as uint32 LE).
The browser decodes a tile (app/lib/terrain-math.js) and recomputes Horn slope/aspect for the
tapped cell with the same arithmetic, so it reproduces the analysis rasters.

Usage: python numeric_tiles.py --region pilot
"""

from __future__ import annotations

import argparse
import time
import zlib
from typing import Any

import numpy as np
import rasterio
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from rasterio.warp import transform_bounds

from terrain_core import LOG, load_config, replace_atomic, setup_logging
from products import geo_bounds, write_meta


def encode_block(n: np.ndarray, level: int) -> bytes:
    """Encode a square int block: 2-D difference, zigzag, byte-plane shuffle, zlib.

    Args:
        n: 2-D integer array (quantized elevations, nodata code included).
        level: zlib compression level.

    Returns:
        Tile payload bytes.
    """
    r = np.diff(np.diff(n.astype(np.int64), axis=0, prepend=0), axis=1, prepend=0)
    r = r.astype(np.int32)
    zz = ((r << 1) ^ (r >> 31)).astype(np.uint32).astype("<u4")
    planes = zz.reshape(-1).view(np.uint8).reshape(-1, 4).T
    return zlib.compress(planes.tobytes(), level)


def load_quantized(cfg: dict[str, Any], region_id: str) -> tuple[np.ndarray, Any]:
    """Read the buffered analysis DEM back as integers round(z * dem_scale); nodata code applied."""
    path = cfg["work_dir"] / f"{region_id}_dem_buffered_26913_10m.tif"
    with rasterio.open(path) as s:
        z = s.read(1, masked=True)
        transform = s.transform
    n = np.round(z.filled(np.nan).astype(np.float64) * cfg["processing"]["dem_scale"])
    n = np.where(np.isnan(n), cfg["numeric"]["nodata"], n).astype(np.int64)
    return n, transform


def block_ranges(cfg: dict[str, Any], bounds: list[float], res: float) -> tuple[range, range]:
    """Tile x and y ranges whose blocks intersect UTM bounds (xmin, ymin, xmax, ymax)."""
    num = cfg["numeric"]
    xmin, ymin, xmax, ymax = bounds
    span = num["block_cells"] * res
    xs = range(int((xmin - num["origin_e"]) // span), int((xmax - num["origin_e"] - res) // span) + 1)
    ys = range(int((num["origin_n"] - ymax) // span), int((num["origin_n"] - ymin - res) // span) + 1)
    return xs, ys


def parts(cfg: dict[str, Any], region_id: str) -> list[tuple[str, list[float], tuple | None]]:
    """Archives to write: (product id, UTM bounds, lon/lat box or None).

    A 1x1 degree cell region is split into split_deg x split_deg parts named <cell>-<n|s><w|e>
    (north and west edges inclusive, as regionPartName in terrain-math.js) to keep files small.
    """
    region = cfg["regions"][region_id]
    if "cell" not in region:
        return [(f"terrain-numeric-{region_id}", region["bounds"], None)]
    w, s, e, n = region["cell"]
    step, out = cfg["numeric"]["split_deg"], []
    for ns, (s0, n0) in (("n", (n - step, n)), ("s", (s, s + step))):
        for ew, (w0, e0) in (("w", (w, w + step)), ("e", (e - step, e))):
            ub = transform_bounds("EPSG:4326", region["crs"], w0, s0, e0, n0, densify_pts=51)
            rb = region["bounds"]
            ub = [max(ub[0], rb[0]), max(ub[1], rb[1]), min(ub[2], rb[2]), min(ub[3], rb[3])]
            out.append((f"terrain-numeric-{region_id}-{ns}{ew}", ub, (w0, s0, e0, n0)))
    return out


def padded_block(n: np.ndarray, transform: Any, num: dict[str, Any], res: float,
                 x: int, y: int) -> np.ndarray:
    """Cut block (x, y) plus apron from the buffered grid; cells beyond it get the nodata code."""
    b, ap = num["block_cells"], num["apron_cells"]
    gc0 = round((transform.c - num["origin_e"]) / res)   # global col of buffered grid col 0
    gr0 = round((num["origin_n"] - transform.f) / res)   # global row of buffered grid row 0
    side = b + 2 * ap
    out = np.full((side, side), num["nodata"], dtype=np.int64)
    c0, r0 = x * b - ap - gc0, y * b - ap - gr0          # block origin in buffered-grid indices
    rs, cs = max(r0, 0), max(c0, 0)
    re, ce = min(r0 + side, n.shape[0]), min(c0 + side, n.shape[1])
    if rs < re and cs < ce:
        out[rs - r0:re - r0, cs - c0:ce - c0] = n[rs:re, cs:ce]
    return out


def write_archive(cfg: dict[str, Any], region: dict[str, Any], n: np.ndarray, transform: Any,
                  pid: str, bounds: list[float], box: tuple) -> tuple[Any, int]:
    """Write one numeric PMTiles archive holding every block that intersects bounds."""
    num = cfg["numeric"]
    xs, ys = block_ranges(cfg, bounds, region["res_m"])
    tiles = sorted((zxy_to_tileid(num["tile_z"], x, y), x, y) for x in xs for y in ys)
    out = cfg["out_dir"] / f"{pid}.pmtiles"
    tmp = out.with_name(out.name + ".partial")
    w_lon, s_lat, e_lon, n_lat = box
    e7 = lambda v: int(round(v * 1e7))  # noqa: E731
    with open(tmp, "wb") as f:
        writer = Writer(f)
        for tid, x, y in tiles:
            block = padded_block(n, transform, num, region["res_m"], x, y)
            writer.write_tile(tid, encode_block(block, num["zlib_level"]))
        writer.finalize({"tile_type": TileType.UNKNOWN, "tile_compression": Compression.NONE,
                         "min_lon_e7": e7(w_lon), "min_lat_e7": e7(s_lat), "max_lon_e7": e7(e_lon),
                         "max_lat_e7": e7(n_lat), "center_zoom": num["tile_z"],
                         "center_lon_e7": e7((w_lon + e_lon) / 2),
                         "center_lat_e7": e7((s_lat + n_lat) / 2)},
                        {"name": pid, "numeric": numeric_meta(cfg, region)})
    replace_atomic(tmp, out)
    return out, len(tiles)


def run(region_id: str) -> None:
    """Write data/terrain/terrain-numeric-<region>[-<part>].pmtiles and their meta.json."""
    cfg = load_config()
    region = cfg["regions"][region_id]
    n, transform = load_quantized(cfg, region_id)
    for pid, bounds, box in parts(cfg, region_id):
        t0 = time.time()
        out, count = write_archive(cfg, region, n, transform, pid, bounds, box or geo_bounds(region))
        secs = time.time() - t0
        LOG.info("%s: %d tiles in %.1f s", pid, count, secs)
        extra = {"numeric": numeric_meta(cfg, region), "tileCount": count,
                 "processingSeconds": round(secs, 1)}
        if box:
            w, s, e, nn = box
            extra |= {"part": pid.rsplit("-", 1)[1], "bbox": list(box), "coverage": {
                "type": "Polygon", "coordinates": [[[w, s], [e, s], [e, nn], [w, nn], [w, s]]]}}
        write_meta(cfg, region_id, pid, out, "numeric", extra)


def numeric_meta(cfg: dict[str, Any], region: dict[str, Any]) -> dict[str, Any]:
    """Decoder parameters consumed by app/lib/terrain-math.js (numericCellAt, inspectNumericCell)."""
    num, proc = cfg["numeric"], cfg["processing"]
    return {"tileScheme": "utm-block (NOT Web Mercator; never add as a map source)",
            "crs": region["crs"], "utmZone": num["utm_zone"], "resM": region["res_m"],
            "gridBounds": region["bounds"], "originE": num["origin_e"], "originN": num["origin_n"],
            "blockCells": num["block_cells"], "apronCells": num["apron_cells"],
            "tileZ": num["tile_z"], "elevScale": proc["dem_scale"], "nodata": num["nodata"],
            "flatThresholdDeg": proc["flat_threshold_deg"],
            "aspect": "degrees clockwise from true north; the decoder adds the meridian convergence "
                      "at the cell centre (utmConvergenceDeg)",
            "encoding": "zlib(byte planes 0..3 of uint32 LE zigzag(2-D difference residuals of "
                        "int elevation)); elevation_m = n / elevScale"}


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    run(ap.parse_args().region)
