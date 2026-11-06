"""Display product: classified slope raster tiles (Web Mercator PNG) in a PMTiles archive.

Every output pixel takes the class of the analysis cell under the pixel centre (nearest
neighbour), so class boundaries stay crisp. Slopes under 25 degrees and no data are transparent;
fully transparent tiles are omitted.

Usage: python display_tiles.py --region pilot
"""

from __future__ import annotations

import argparse
import io
import time
from typing import Any

import numpy as np
import rasterio
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from pyproj import Transformer

from products import geo_bounds, tile_xy, write_meta
from terrain_core import LOG, load_config, replace_atomic, setup_logging, slope_class_index


def class_grid(cfg: dict[str, Any], region_id: str) -> np.ndarray:
    """Palette index per analysis cell: 0 transparent (<25 or no data), k = slope_classes[k]."""
    with rasterio.open(cfg["work_dir"] / f"{region_id}_slope_26913_10m.tif") as s:
        slope = s.read(1, masked=True).astype(np.float64).filled(np.nan)
    idx = slope_class_index(slope, cfg["slope_classes"])
    return np.where(idx < 1, 0, idx).astype(np.uint8)


def palette(classes: list[dict[str, Any]]) -> list[int]:
    """Flat RGB palette: index 0 black (made transparent), then each class color."""
    pal = [0, 0, 0]
    for c in classes[1:]:
        pal += [int(c["color"][i:i + 2], 16) for i in (1, 3, 5)]
    return pal


def render_tile(z: int, x: int, y: int, cls: np.ndarray, region: dict[str, Any],
                to_utm: Transformer, ts: int, pal: list[int]) -> bytes | None:
    """PNG bytes for tile z/x/y, or None when every pixel is transparent."""
    n = ts * 2 ** z
    lon = (x * ts + np.arange(ts) + 0.5) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y * ts + np.arange(ts) + 0.5) / n))))
    lon, lat = np.meshgrid(lon, lat)
    e, nn = to_utm.transform(lon, lat)
    xmin, _, _, ymax = region["bounds"]
    col = np.floor((e - xmin) / region["res_m"]).astype(np.int64)
    row = np.floor((ymax - nn) / region["res_m"]).astype(np.int64)
    inside = (col >= 0) & (col < cls.shape[1]) & (row >= 0) & (row < cls.shape[0])
    if "cell" in region:  # 1x1 degree region: draw only inside its cell so neighbours never overlap
        w, s, ce, n = region["cell"]
        inside &= (lon >= w) & (lon < ce) & (lat > s) & (lat <= n)
    idx = np.zeros((ts, ts), dtype=np.uint8)
    idx[inside] = cls[row[inside], col[inside]]
    if not idx.any():
        return None
    img = Image.fromarray(idx, mode="P")
    img.putpalette(pal)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True, transparency=0)
    return buf.getvalue()


def max_zoom(cfg: dict[str, Any], region: dict[str, Any]) -> int:
    """Display max zoom: the region's override (to respect the 25 MB file limit) or the default."""
    return region.get("display_max_zoom", cfg["display"]["max_zoom"])


def render_all(cfg: dict[str, Any], region_id: str) -> tuple[list, dict[str, Any]]:
    """Render every zoom; return sorted (tileid, bytes) and per-zoom tile counts and bytes."""
    region, disp = cfg["regions"][region_id], cfg["display"]
    cls, pal = class_grid(cfg, region_id), palette(cfg["slope_classes"])
    to_utm = Transformer.from_crs("EPSG:4326", region["crs"], always_xy=True)
    w, s, e, n = geo_bounds(region)
    tiles, per_zoom = [], {}
    for z in range(disp["min_zoom"], max_zoom(cfg, region) + 1):
        (x0, y0), (x1, y1) = tile_xy(w, n, z), tile_xy(e, s, z)
        t0, count, nbytes = time.time(), 0, 0
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                png = render_tile(z, x, y, cls, region, to_utm, disp["tile_size"], pal)
                if png is not None:
                    tiles.append((zxy_to_tileid(z, x, y), png))
                    count, nbytes = count + 1, nbytes + len(png)
        per_zoom[z] = {"tiles": count, "bytes": nbytes, "seconds": round(time.time() - t0, 1)}
        LOG.info("z%d: %s", z, per_zoom[z])
    return sorted(tiles), per_zoom


def run(region_id: str) -> None:
    """Write data/terrain/terrain-slope-<region>.pmtiles and its meta.json."""
    cfg = load_config()
    region = cfg["regions"][region_id]
    t0 = time.time()
    tiles, per_zoom = render_all(cfg, region_id)
    pid = f"terrain-slope-{region_id}"
    out = cfg["out_dir"] / f"{pid}.pmtiles"
    tmp = out.with_name(out.name + ".partial")
    w, s, e, n = geo_bounds(region)
    e7 = lambda v: int(round(v * 1e7))  # noqa: E731
    classes = [{k: c[k] for k in ("id", "min", "max", "label", "color")} for c in cfg["slope_classes"]]
    with open(tmp, "wb") as f:
        writer = Writer(f)
        for tid, png in tiles:
            writer.write_tile(tid, png)
        writer.finalize({"tile_type": TileType.PNG, "tile_compression": Compression.NONE,
                         "min_lon_e7": e7(w), "min_lat_e7": e7(s), "max_lon_e7": e7(e),
                         "max_lat_e7": e7(n), "center_zoom": cfg["display"]["min_zoom"] + 2,
                         "center_lon_e7": e7((w + e) / 2), "center_lat_e7": e7((s + n) / 2)},
                        {"name": pid, "attribution": "Slope from USGS 3DEP", "classes": classes})
    replace_atomic(tmp, out)
    write_meta(cfg, region_id, pid, out, "display", {
        "title": f"Slope angle classes ({region_id})", "tileType": "png", "tileSize":
        cfg["display"]["tile_size"], "minzoom": cfg["display"]["min_zoom"],
        "maxzoom": max_zoom(cfg, region), "resampling": "nearest (analysis cell under pixel centre)",
        "classes": classes, "transparent": "slope < 25 degrees, no data, outside coverage",
        "perZoom": per_zoom, "processingSeconds": round(time.time() - t0, 1)})


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    run(ap.parse_args().region)
