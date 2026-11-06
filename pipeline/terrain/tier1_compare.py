"""Quantify Tier 1 (browser terrain tiles) against Tier 2 (analysis grid) over a region.

For each provider (Mapterhorn WebP 512 px, AWS Terrain Tiles PNG 256 px) and zoom: fetch the
Terrarium tiles covering the region (cached, identifying User-Agent, response headers recorded),
mosaic them, compute slope with app/lib/terrain-math.js in node (tier1_slope.mjs), then read the
Tier 1 pixel under every Tier 2 cell centre and report slope bias, MAE, RMSE and class agreement,
plus elevation bias, MAE and RMSE (nearest pixel, metres).

Usage: python tier1_compare.py --region pilot
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer

from products import geo_bounds, tile_xy
from terrain_core import LOG, load_config, setup_logging, slope_class_index


RECORDED_HEADERS = ("Content-Type", "Last-Modified", "Cache-Control", "ETag",
                    "x-amz-meta-x-imagery-sources")


def webp_kind(data: bytes) -> str | None:
    """'lossless' (VP8L), 'lossy' (VP8) or None for a non-WebP payload."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    return "lossless" if b"VP8L" in data[:64] else "lossy" if b"VP8 " in data[:64] else "unknown"


def fetch_tile(url: str, path: Path, user_agent: str) -> dict[str, Any]:
    """Download one tile if not cached; return status and the headers we record."""
    if path.exists() and path.with_suffix(".json").exists():
        return json.loads(path.with_suffix(".json").read_text())
    path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        rec = {"url": url, "status": r.status, "bytes": len(data), "webp": webp_kind(data),
               "retrievedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
               "headers": {h: r.headers.get(h) for h in RECORDED_HEADERS if r.headers.get(h)}}
    path.write_bytes(data)
    path.with_suffix(".json").write_text(json.dumps(rec))
    return rec


def tile_path(cfg: dict[str, Any], prov: str, z: int, x: int, y: int) -> Path:
    """Cache path of one provider tile (extension taken from the URL template)."""
    ext = cfg["tier1"]["providers"][prov]["url_template"].rsplit(".", 1)[1]
    return cfg["work_dir"] / "terrarium" / prov / str(z) / str(x) / f"{y}.{ext}"


def fetch_zoom(cfg: dict[str, Any], prov: str, z: int, xs: range, ys: range) -> dict[str, Any]:
    """Fetch every tile of the zoom's range; summarise statuses, headers and bytes."""
    t1 = cfg["tier1"]
    tmpl = t1["providers"][prov]["url_template"]
    jobs = [(tmpl.format(z=z, x=x, y=y), tile_path(cfg, prov, z, x, y)) for x in xs for y in ys]
    with ThreadPoolExecutor(t1["workers"]) as ex:
        recs = list(ex.map(lambda j: fetch_tile(*j, t1["user_agent"]), jobs))
    hdr = lambda r, k: str(r["headers"].get(k))  # noqa: E731
    return {"tiles": len(recs), "bytes": sum(r["bytes"] for r in recs),
            "status": dict(Counter(r["status"] for r in recs)),
            "webp": dict(Counter(str(r["webp"]) for r in recs)),
            "imagerySources": dict(Counter(hdr(r, "x-amz-meta-x-imagery-sources") for r in recs)),
            "lastModified": sorted({hdr(r, "Last-Modified") for r in recs})[-3:],
            "cacheControl": sorted({hdr(r, "Cache-Control") for r in recs}),
            "firstRetrievedAt": min(r["retrievedAt"] for r in recs)}


def tier1_slope(cfg: dict[str, Any], prov: str, z: int, xs: range, ys: range) -> np.ndarray:
    """Mosaic the tiles and run tier1_slope.mjs; return the float32 slope mosaic."""
    ts = cfg["tier1"]["providers"][prov]["tile_size"]
    rgb = np.zeros((len(ys) * ts, len(xs) * ts, 3), dtype=np.uint8)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            img = Image.open(tile_path(cfg, prov, z, x, y))
            rgb[j * ts:(j + 1) * ts, i * ts:(i + 1) * ts] = np.asarray(img.convert("RGB"))
    base = cfg["work_dir"] / f"tier1_{prov}_z{z}"
    base.with_suffix(".rgb").write_bytes(rgb.tobytes())
    hdr = {"z": z, "y0": ys[0] * ts, "width": rgb.shape[1], "height": rgb.shape[0], "tileSize": ts}
    base.with_suffix(".json").write_text(json.dumps(hdr))
    script = Path(__file__).with_name("tier1_slope.mjs")
    subprocess.run(["node", str(script), str(base.with_suffix(".rgb")), str(base.with_suffix(".json")),
                    str(base.with_suffix(".f32"))], check=True)
    out = np.fromfile(base.with_suffix(".f32"), dtype=np.float32)
    return out[: rgb.shape[0] * rgb.shape[1]].reshape(rgb.shape[:2])


def tier2_cells(cfg: dict[str, Any], region_id: str) -> tuple[np.ndarray, ...]:
    """Tier 2 slope and elevation plus lon/lat of every analysis cell centre (flattened)."""
    with rasterio.open(cfg["work_dir"] / f"{region_id}_dem_26913_10m.tif") as s:
        dem = s.read(1, masked=True).astype(np.float64).filled(np.nan)
    with rasterio.open(cfg["work_dir"] / f"{region_id}_slope_26913_10m.tif") as s:
        slope = s.read(1, masked=True).astype(np.float64).filled(np.nan)
        rows, cols = np.mgrid[0:s.height, 0:s.width]
        x, y = rasterio.transform.xy(s.transform, rows.ravel(), cols.ravel())
    lon, lat = Transformer.from_crs(s.crs, "EPSG:4326", always_xy=True).transform(x, y)
    return slope.ravel(), dem.ravel(), np.asarray(lon), np.asarray(lat)


def tier1_elevation(cfg: dict[str, Any], prov: str, z: int) -> np.ndarray:
    """Terrarium-decoded elevation mosaic written by tier1_slope()."""
    base = cfg["work_dir"] / f"tier1_{prov}_z{z}"
    hdr = json.loads(base.with_suffix(".json").read_text())
    rgb = np.fromfile(base.with_suffix(".rgb"), dtype=np.uint8).reshape(hdr["height"], hdr["width"], 3)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def sample(mosaic: np.ndarray, z: int, xs: range, ys: range, ts: int, lon: np.ndarray,
           lat: np.ndarray) -> np.ndarray:
    """Tier 1 mosaic value of the pixel containing each lon/lat."""
    n = ts * 2 ** z
    px = np.floor((lon + 180) / 360 * n).astype(np.int64) - xs[0] * ts
    py = np.floor((1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n).astype(np.int64) - ys[0] * ts
    return mosaic[py, px].astype(np.float64)


def stats(t1: np.ndarray, t2: np.ndarray, classes: list[dict[str, Any]]) -> dict[str, float]:
    """Bias, MAE, RMSE, exact and within-one class agreement of t1 against t2."""
    ok = ~np.isnan(t1) & ~np.isnan(t2)
    d = t1[ok] - t2[ok]
    c1, c2 = slope_class_index(t1[ok], classes), slope_class_index(t2[ok], classes)
    return {"cells": int(ok.sum()), "bias": float(d.mean()), "mae": float(np.abs(d).mean()),
            "rmse": float(np.sqrt((d ** 2).mean())), "p95_abs": float(np.percentile(np.abs(d), 95)),
            "class_agreement": float((c1 == c2).mean()),
            "class_within_one": float((np.abs(c1.astype(int) - c2) <= 1).mean())}


def run(region_id: str, providers: list[str]) -> None:
    """Compare every configured provider and zoom; write <region>_tier1_compare.json."""
    cfg = load_config()
    t1, region = cfg["tier1"], cfg["regions"][region_id]
    w, s, e, n = geo_bounds(region)
    t2, dem, lon, lat = tier2_cells(cfg, region_id)
    steep = t2 > 25.0
    out_path = cfg["work_dir"] / f"{region_id}_tier1_compare.json"
    report = json.loads(out_path.read_text()) if out_path.exists() else {}
    for prov in providers:
        pc = t1["providers"][prov]
        report[prov] = {}
        for z in pc["zooms"]:
            (x0, y0), (x1, y1), m = tile_xy(w, n, z), tile_xy(e, s, z), t1["margin_tiles"]
            xs, ys = range(x0 - m, x1 + m + 1), range(y0 - m, y1 + m + 1)
            fetched = fetch_zoom(cfg, prov, z, xs, ys)
            v = sample(tier1_slope(cfg, prov, z, xs, ys), z, xs, ys, pc["tile_size"], lon, lat)
            d = sample(tier1_elevation(cfg, prov, z), z, xs, ys, pc["tile_size"], lon, lat) - dem
            report[prov][f"z{z}"] = {
                "fetch": fetched, "all": stats(v, t2, cfg["slope_classes"]),
                "tier2_gt25": stats(v[steep], t2[steep], cfg["slope_classes"]),
                "elevation_m": {"bias": float(d.mean()), "mae": float(np.abs(d).mean()),
                                "rmse": float(np.sqrt((d ** 2).mean()))}}
            LOG.info("%s z%d: %s", prov, z, json.dumps(report[prov][f"z{z}"]))
            out_path.write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", default="pilot")
    ap.add_argument("--providers", nargs="+", default=["mapterhorn", "aws"])
    args = ap.parse_args()
    run(args.region, args.providers)
