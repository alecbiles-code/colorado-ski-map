"""Verify a display archive: decoded tile pixels against the slope class of the analysis cell under
each pixel centre; for a 1x1 degree cell also check that pixels just outside the cell are empty.

Usage: python verify_display.py --region n38w107 --pixels 200
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
from typing import Any

import numpy as np
import rasterio
from PIL import Image
from pmtiles.reader import MmapSource, Reader
from pyproj import Transformer

from terrain_core import LOG, load_config, setup_logging, slope_class_index


def pixel_class(reader: Reader, colors: dict, z: int, lon: float, lat: float) -> tuple[int, float, float]:
    """Palette class (0 = transparent or missing tile) of the pixel containing lon/lat, and its centre."""
    n = 256 * 2 ** z
    px = (lon + 180) / 360 * n
    py = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
    x, y, i, j = int(px // 256), int(py // 256), int(px % 256), int(py % 256)
    clon = (x * 256 + i + 0.5) / n * 360 - 180
    clat = float(np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y * 256 + j + 0.5) / n)))))
    data = reader.get(z, x, y)
    if not data:
        return 0, clon, clat
    rgba = Image.open(io.BytesIO(data)).convert("RGBA").getpixel((i, j))
    return (0 if rgba[3] == 0 else colors[rgba[:3]]), clon, clat


def sample_lonlat(region: dict[str, Any], rng: np.random.Generator) -> tuple[float, float]:
    """Random lon/lat inside the region's cell, or inside its grid rectangle (pilot)."""
    if "cell" in region:
        w, s, e, n = region["cell"]
        return rng.uniform(w, e), rng.uniform(s, n)
    xmin, ymin, xmax, ymax = region["bounds"]
    t = Transformer.from_crs(region["crs"], "EPSG:4326", always_xy=True)
    return t.transform(rng.uniform(xmin, xmax), rng.uniform(ymin, ymax))


def run(region_id: str, pixels: int) -> None:
    """Check `pixels` pixels inside and pixels/5 just outside (cells only); write the report."""
    cfg = load_config()
    region, disp = cfg["regions"][region_id], cfg["display"]
    with rasterio.open(cfg["work_dir"] / f"{region_id}_slope_26913_10m.tif") as s:
        cls = np.maximum(slope_class_index(s.read(1).astype(np.float64), cfg["slope_classes"]), 0)
    colors = {tuple(int(c["color"][k:k + 2], 16) for k in (1, 3, 5)): i
              for i, c in enumerate(cfg["slope_classes"]) if c["color"]}
    pid = f"terrain-slope-{region_id}"
    reader = Reader(MmapSource(open(cfg["out_dir"] / f"{pid}.pmtiles", "rb")))
    to_utm = Transformer.from_crs("EPSG:4326", region["crs"], always_xy=True)
    xmin, _, _, ymax = region["bounds"]
    zooms = [12, 14] + ([15] if region.get("display_max_zoom", disp["max_zoom"]) >= 15 else [])
    rng = np.random.default_rng(cfg["verify"]["seed"])
    match = 0
    for k in range(pixels):
        got, clon, clat = pixel_class(reader, colors, zooms[k % len(zooms)], *sample_lonlat(region, rng))
        w, s, e, n = region.get("cell", (-180, -90, 180, 90))
        inside = w <= clon < e and s < clat <= n
        ce, cn = to_utm.transform(clon, clat)
        c, r = int((ce - xmin) // region["res_m"]), int((ymax - cn) // region["res_m"])
        ok_rc = 0 <= r < cls.shape[0] and 0 <= c < cls.shape[1]
        match += got == (int(cls[r, c]) if inside and ok_rc else 0)
    report = {"pixels": pixels, "zooms": zooms, "classMatch": match,
              "outsideChecked": 0, "outsideTransparent": 0,
              "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    if "cell" in region:
        report |= outside_check(reader, colors, region["cell"], pixels // 5, rng)
    (cfg["work_dir"] / f"{region_id}_verify_display.json").write_text(json.dumps(report, indent=2))
    meta_path = cfg["out_dir"] / f"{pid}.meta.json"
    meta_path.write_text(json.dumps(json.loads(meta_path.read_text()) | {"verification": report},
                                    indent=2) + "\n")
    LOG.info("display verification %s: %s", region_id, json.dumps(report))


def outside_check(reader: Reader, colors: dict, cell: list, count: int,
                  rng: np.random.Generator) -> dict[str, int]:
    """Pixels about 300 m outside each cell edge (z14) must be transparent in this archive."""
    w, s, e, n = cell
    d, ok = 0.003, 0
    for k in range(count):
        side = k % 4
        lon = [w - d, e + d, rng.uniform(w, e), rng.uniform(w, e)][side]
        lat = [rng.uniform(s, n), rng.uniform(s, n), s - d, n + d][side]
        ok += pixel_class(reader, colors, 14, lon, lat)[0] == 0
    return {"outsideChecked": count, "outsideTransparent": ok}


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", required=True)
    ap.add_argument("--pixels", type=int, default=200)
    args = ap.parse_args()
    run(args.region, args.pixels)
