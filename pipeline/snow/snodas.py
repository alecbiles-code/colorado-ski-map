"""Build the Colorado SNODAS snow depth and SWE product from the NSIDC G02158 masked archive.

Outputs, under <root>/data/snow/ (paths from config.yaml):
  snodas/<date>/snow-depth.png, swe.png  palette PNGs on a Web Mercator grid for a MapLibre image source
  snodas/<date>/grid/r{r}c{c}.bin        numeric chunks, int16 little-endian, interleaved [depth_mm, swe_mm]
  snodas.meta.json                       analysis date, corner coordinates, grid layout, provenance

Usage:
  python pipeline/snow/snodas.py [--root DIR] [--date YYYY-MM-DD] [--tar FILE] [--work DIR]
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import logging
import math
import re
import shutil
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from PIL import Image

log = logging.getLogger("snodas")

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_config(path: Path = HERE / "config.yaml") -> dict[str, Any]:
    """Read the snow pipeline YAML config."""
    return yaml.safe_load(path.read_text())


def tar_url(base: str, day: dt.date) -> str:
    """NSIDC masked archive URL for one SNODAS day, e.g. .../2026/11_Nov/SNODAS_20261105.tar."""
    return f"{base}/{day:%Y}/{day:%m}_{MONTHS[day.month - 1]}/SNODAS_{day:%Y%m%d}.tar"


def http(url: str, cfg: dict[str, Any], method: str = "GET") -> tuple[bytes, dict[str, str]]:
    """HTTP request with bounded retries. A 404 is raised at once (the day is not published)."""
    h = cfg["http"]
    for attempt in range(1, h["retries"] + 1):
        try:
            req = urllib.request.Request(url, method=method, headers={"User-Agent": h["user_agent"]})
            with urllib.request.urlopen(req, timeout=h["timeout_s"]) as r:
                return r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            log.warning("attempt %d for %s failed: %s", attempt, url, e)
        except (urllib.error.URLError, TimeoutError) as e:
            log.warning("attempt %d for %s failed: %s", attempt, url, e)
        time.sleep(attempt * h["retry_wait_s"])
    raise RuntimeError(f"giving up on {url}")


def find_latest(cfg: dict[str, Any], today: dt.date) -> dt.date:
    """Newest SNODAS day on NSIDC, probing back from `today` with HEAD requests."""
    s = cfg["snodas"]
    for back in range(s["max_lookback_days"] + 1):
        day = today - dt.timedelta(days=back)
        try:
            http(tar_url(s["base_url"], day), cfg, method="HEAD")
            return day
        except urllib.error.HTTPError:
            log.info("no archive for %s", day)
    raise RuntimeError(f"no SNODAS archive in the last {s['max_lookback_days']} days")


def download(day: dt.date, cfg: dict[str, Any], work: Path) -> tuple[Path, str | None]:
    """Download one day's tar into `work`. Returns the path and the HTTP Last-Modified header."""
    url = tar_url(cfg["snodas"]["base_url"], day)
    body, headers = http(url, cfg)
    path = work / url.rsplit("/", 1)[1]
    path.write_bytes(body)
    log.info("downloaded %s (%d bytes)", url, len(body))
    return path, headers.get("Last-Modified")


def read_member(tar_path: Path, key: str, suffix: str) -> tuple[str, bytes]:
    """Name (without .gz) and gunzipped bytes of the tar member containing `key` and ending in `suffix`."""
    with tarfile.open(tar_path) as tf:
        names = [m for m in tf.getnames() if key in m and m.endswith(suffix)]
        if len(names) != 1:
            raise ValueError(f"expected one member with {key}*{suffix} in {tar_path.name}, found {names}")
        data = gzip.decompress(tf.extractfile(names[0]).read())
    return names[0].removesuffix(".gz"), data


def parse_header(text: str) -> dict[str, str]:
    """NOHRSC GIS/RS header ('Key: value' lines) as a dict of stripped strings."""
    out = {}
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            out[key.strip()] = value.strip()
    return out


def grid_origin(hdr: dict[str, str], var: dict[str, Any], grid: dict[str, Any]) -> tuple[float, float]:
    """Validate a header against the documented format; return the grid's (west, north) edge, snapped.

    Header corner values carry rounding noise (user guide 1.7.4), so they are snapped to the
    30 arc-second lattice; a snap error above 1e-6 degree means an unexpected grid and fails.
    """
    expect = {"Data units": var["expected_units"], "Data bytes per pixel": "2",
              "Number of columns": str(grid["cols"]), "Number of rows": str(grid["rows"])}
    for key, want in expect.items():
        if hdr.get(key) != want:
            raise ValueError(f"header {key!r} is {hdr.get(key)!r}, expected {want!r}")
    if float(hdr["No data value"]) != grid["nodata"] or float(hdr["Data slope"]) != 1 or float(hdr["Data intercept"]) != 0:
        raise ValueError("unexpected nodata, slope or intercept in header")
    n = grid["cells_per_degree"]
    west, north = float(hdr["Minimum x-axis coordinate"]), float(hdr["Maximum y-axis coordinate"])
    snapped = round(west * n) / n, round(north * n) / n
    if abs(snapped[0] - west) > 1e-6 or abs(snapped[1] - north) > 1e-6:
        raise ValueError(f"grid origin {west}, {north} is off the 30 arc-second lattice")
    return snapped


def decode(dat: bytes, grid: dict[str, Any]) -> np.ndarray:
    """Big-endian int16 grid (user guide 1.3) as a native int16 array, row 0 = north."""
    expected = grid["rows"] * grid["cols"] * 2
    if len(dat) != expected:
        raise ValueError(f"data is {len(dat)} bytes, expected {expected}")
    return np.frombuffer(dat, dtype=">i2").reshape(grid["rows"], grid["cols"]).astype(np.int16)


def subset_window(origin: tuple[float, float], bbox: dict[str, float], n: int) -> dict[str, Any]:
    """Row/column window of the bbox, snapped outward to whole cells, with its exact edges."""
    west, north = origin
    c0, c1 = math.floor((bbox["west"] - west) * n + 1e-9), math.ceil((bbox["east"] - west) * n - 1e-9)
    r0, r1 = math.floor((north - bbox["north"]) * n + 1e-9), math.ceil((north - bbox["south"]) * n - 1e-9)
    return {"r0": r0, "r1": r1, "c0": c0, "c1": c1, "west": west + c0 / n, "east": west + c1 / n,
            "north": north - r0 / n, "south": north - r1 / n, "cols": c1 - c0, "rows": r1 - r0}


def merc_y(lat_deg: np.ndarray | float) -> np.ndarray | float:
    """Web Mercator y in radians of arc (unit sphere)."""
    return np.log(np.tan(np.pi / 4 + np.radians(lat_deg) / 2))


def mercator_index(win: dict[str, Any], n: int, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Source row and column for each pixel of a Web Mercator image spanning the window exactly.

    Columns: k pixels per cell (Mercator x is linear in longitude, so this is exact).
    Rows: square pixels in Mercator; each pixel takes the cell containing its centre (nearest).
    """
    width = win["cols"] * k
    px = math.radians(1 / n / k)
    top, bottom = merc_y(win["north"]), merc_y(win["south"])
    height = max(1, round((top - bottom) / px))
    centres = top - (np.arange(height) + 0.5) * (top - bottom) / height
    lat = np.degrees(2 * np.arctan(np.exp(centres)) - np.pi / 2)
    rows = np.clip(np.floor((win["north"] - lat) * n).astype(int), 0, win["rows"] - 1)
    cols = np.arange(width) // k
    return rows, cols


def classify(values: np.ndarray, var: dict[str, Any], grid: dict[str, Any]) -> np.ndarray:
    """Palette index per cell: 0 = valid zero (transparent), 1..N = classes, N+1 = no data or saturated."""
    idx = 1 + np.searchsorted(np.asarray(var["classes_mm"]), values, side="left")
    idx = np.where(values == 0, 0, idx)
    bad = (values < 0) | (values >= grid["saturated"])
    return np.where(bad, len(var["colors"]) + 1, idx).astype(np.uint8)


def write_png(index: np.ndarray, var: dict[str, Any], nodata_rgba: list[int], path: Path) -> None:
    """Palette PNG with per-index alpha: zero snow transparent, no data translucent grey."""
    colors = [(0, 0, 0)] + [tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for c in var["colors"]] + [tuple(nodata_rgba[:3])]
    alpha = bytes([0] + [255] * len(var["colors"]) + [nodata_rgba[3]])
    img = Image.fromarray(index, mode="P")
    img.putpalette([v for rgb in colors for v in rgb])
    img.save(path, optimize=True, transparency=alpha)


def write_chunks(depth: np.ndarray, swe: np.ndarray, chunk: int, nodata: int, out: Path) -> tuple[int, int]:
    """Write r{r}c{c}.bin chunks (chunk x chunk cells, edge chunks padded with nodata). Returns (chunk rows, chunk cols)."""
    rows, cols = depth.shape
    nr, nc = math.ceil(rows / chunk), math.ceil(cols / chunk)
    both = np.full((nr * chunk, nc * chunk, 2), nodata, dtype="<i2")
    both[:rows, :cols, 0], both[:rows, :cols, 1] = depth, swe
    out.mkdir(parents=True, exist_ok=True)
    for r in range(nr):
        for c in range(nc):
            block = both[r * chunk:(r + 1) * chunk, c * chunk:(c + 1) * chunk]
            (out / f"r{r}c{c}.bin").write_bytes(np.ascontiguousarray(block).tobytes())
    return nr, nc


def sample(depth: np.ndarray, win: dict[str, Any], n: int, lon: float, lat: float) -> int | None:
    """Reference sampler: raw value of the cell containing (lon, lat), or None outside the window."""
    c, r = math.floor((lon - win["west"]) * n), math.floor((win["north"] - lat) * n)
    return int(depth[r, c]) if 0 <= r < win["rows"] and 0 <= c < win["cols"] else None


def stats(depth: np.ndarray, swe: np.ndarray, grid: dict[str, Any]) -> dict[str, Any]:
    """Cell counts by state and maxima of valid values, for the meta file."""
    valid = (depth >= 0) & (depth < grid["saturated"])
    valid_swe = (swe >= 0) & (swe < grid["saturated"])
    return {"cells": int(depth.size), "nodataCells": int((depth == grid["nodata"]).sum()),
            "otherNegativeCells": int(((depth < 0) & (depth != grid["nodata"])).sum()),
            "saturatedDepthCells": int((depth >= grid["saturated"]).sum()),
            "saturatedSweCells": int((swe >= grid["saturated"]).sum()),
            "zeroDepthCells": int((depth == 0).sum()), "snowCells": int((valid & (depth > 0)).sum()),
            "maxDepthMm": int(depth[valid].max()) if valid.any() else None,
            "maxSweMm": int(swe[valid_swe].max()) if valid_swe.any() else None}


def legend(var: dict[str, Any], nodata_rgba: list[int]) -> list[dict[str, Any]]:
    """Legend rows matching classify(): value ranges in mm (lower exclusive, upper inclusive)."""
    bounds = [0] + list(var["classes_mm"]) + [None]
    rows = [{"state": "zero", "label": "0 (no modeled snow)", "color": None}]
    for i, color in enumerate(var["colors"]):
        rows.append({"state": "value", "minMmExclusive": bounds[i], "maxMmInclusive": bounds[i + 1], "color": color})
    grey = "#{:02x}{:02x}{:02x}".format(*nodata_rgba[:3])
    rows.append({"state": "nodata", "label": "No data, or saturated value flagged by NSIDC", "color": grey,
                 "alpha": round(nodata_rgba[3] / 255, 2)})
    return rows


def header_valid_at(hdr: dict[str, str], day: dt.date) -> str:
    """Snapshot time from the header; SWE and depth must be the 06:00 UTC state of `day`."""
    start = [int(hdr[f"Start {p}"]) for p in ("year", "month", "day", "hour", "minute", "second")]
    stop = [int(hdr[f"Stop {p}"]) for p in ("year", "month", "day", "hour", "minute", "second")]
    want = [day.year, day.month, day.day, 6, 0, 0]
    if start != want or stop != want:
        raise ValueError(f"header snapshot {start}/{stop} is not 06:00 UTC on {day}")
    return f"{day.isoformat()}T06:00:00Z"


def load_variables(tar_path: Path, day: dt.date, cfg: dict[str, Any]) -> dict[str, Any]:
    """Decode and subset each configured variable; all must share one grid and one valid time."""
    s = cfg["snodas"]
    out: dict[str, Any] = {"arrays": {}, "files": {}}
    for name, var in s["variables"].items():
        hname, htext = read_member(tar_path, var["member_key"], ".txt.gz")
        dname, dat = read_member(tar_path, var["member_key"], ".dat.gz")
        hdr = parse_header(htext.decode("ascii", errors="replace"))
        origin = grid_origin(hdr, var, s["grid"])
        valid_at = header_valid_at(hdr, day)
        if out.setdefault("origin", origin) != origin or out.setdefault("validAt", valid_at) != valid_at:
            raise ValueError(f"{name} grid or time differs from the other variables")
        win = subset_window(origin, s["bbox"], s["grid"]["cells_per_degree"])
        out["arrays"][name] = decode(dat, s["grid"])[win["r0"]:win["r1"], win["c0"]:win["c1"]]
        out["files"][name] = {"data": dname, "header": hname, "description": hdr.get("Description"),
                              "units": hdr["Data units"], "created": header_created(hdr)}
        out["window"] = win
    return out


def header_created(hdr: dict[str, str]) -> str:
    """Header creation time as written (the header does not state a time zone)."""
    parts = [hdr.get(f"Created {p}", "?") for p in ("year", "month", "day", "hour", "minute", "second")]
    return "{}-{:0>2}-{:0>2} {:0>2}:{:0>2}:{:0>2}".format(*parts)


def write_outputs(loaded: dict[str, Any], day: dt.date, cfg: dict[str, Any], root: Path) -> dict[str, Any]:
    """PNG per variable and the numeric chunks for one day. Returns the layer/grid part of the meta."""
    s, grid = cfg["snodas"], cfg["snodas"]["grid"]
    n, win = grid["cells_per_degree"], loaded["window"]
    out_dir = root / s["out_dir"] / day.isoformat()
    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "grid").mkdir(parents=True)
    rows, cols = mercator_index(win, n, s["png_pixels_per_cell_x"])
    corners = [[win["west"], win["north"]], [win["east"], win["north"]], [win["east"], win["south"]], [win["west"], win["south"]]]
    rel = f"{Path(s['out_dir']).name}/{day.isoformat()}"
    layers = {}
    for name, var in s["variables"].items():
        index = classify(loaded["arrays"][name], var, grid)[rows[:, None], cols[None, :]]
        write_png(index, var, s["nodata_rgba"], out_dir / var["png"])
        layers[name] = {"url": f"{rel}/{var['png']}", "coordinates": corners, "width": int(index.shape[1]),
                        "height": int(index.shape[0]), "legend": legend(var, s["nodata_rgba"])}
    a = loaded["arrays"]
    nr, nc = write_chunks(a["snow_depth"], a["swe"], s["chunk_cells"], grid["nodata"], out_dir / "grid")
    grid_meta = {"format": "int16 little-endian, 2 interleaved bands per cell, row-major from the NW corner",
                 "bands": ["snow_depth_mm", "swe_mm"], "crs": "EPSG:4326", "cellDeg": 1 / n, "cellArcSec": 3600 / n,
                 "west": win["west"], "north": win["north"], "east": win["east"], "south": win["south"],
                 "cols": win["cols"], "rows": win["rows"], "chunkCells": s["chunk_cells"], "chunkRows": nr,
                 "chunkCols": nc, "chunkBytes": s["chunk_cells"] ** 2 * 4, "chunkUrl": f"{rel}/grid/r{{r}}c{{c}}.bin",
                 "nodata": grid["nodata"], "saturated": grid["saturated"]}
    return {"layers": layers, "grid": grid_meta, "dir": out_dir}


LIMITATIONS = [
    "Modeled analysis, not a measurement: NOHRSC snow model with data assimilation, one value per 30 arc-second cell "
    "(about 0.7 km east-west by 0.9 km north-south in Colorado). It cannot resolve wind loading, cornices, gullies, "
    "aspect-scale differences or conditions on a ski line. Do not read ski-line-scale detail into the image.",
    "Snapshot of the snowpack state at 06:00 UTC on the analysis date (11 PM MST the previous evening, or midnight "
    "MDT). It does not change during the day.",
    "Snow depth and SWE are the whole snowpack. They are not new snow, snowfall or forecast snowfall.",
    "NSIDC documents erroneously high SWE in some high-elevation regions; values at the int16 ceiling (32767) are "
    "flagged as saturated and drawn as no data. Zero is a valid modeled value (no snow) and is distinct from no data.",
    "NSIDC lists G02158 at a 'Basic' level of service; days can be late or missing "
    "(see https://noaadata.apps.nsidc.org/NOAA/G02158/G02158_missing_files.txt).",
    "The PNG is resampled (nearest neighbour) to Web Mercator for display only; read values from the numeric grid.",
    "Not an avalanche, stability or travel product. Says nothing about avalanche danger.",
]


def build_meta(day: dt.date, loaded: dict[str, Any], written: dict[str, Any], cfg: dict[str, Any],
               fetched: dict[str, Any]) -> dict[str, Any]:
    """Provenance and layout for snodas.meta.json (ARCHITECTURE 4.5)."""
    s, g = cfg["snodas"], written["grid"]
    files = sorted(p for p in written["dir"].rglob("*") if p.is_file())
    return {
        "id": "snodas-colorado", "title": "SNODAS modeled snow depth and SWE, Colorado",
        "analysisDate": day.isoformat(), "validFrom": loaded["validAt"], "validTo": loaded["validAt"],
        "issuedAt": None, "publishedAt": fetched.get("lastModified"), "retrievedAt": fetched.get("retrievedAt"),
        "processedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timeNote": "validFrom/validTo is the 06:00 UTC snapshot. publishedAt is the NSIDC HTTP Last-Modified "
                    "of the archive. The source header creation time has no stated time zone and is kept as text.",
        "layers": written["layers"], "grid": g,
        "units": {"snow_depth_mm": "millimetres of snow depth (divide by 10 for cm)", "swe_mm": "millimetres of water"},
        "coverage": {"bbox": [g["west"], g["south"], g["east"], g["north"]],
                     "polygon": {"type": "Polygon", "coordinates": [[[g["west"], g["south"]], [g["east"], g["south"]],
                                 [g["east"], g["north"]], [g["west"], g["north"]], [g["west"], g["south"]]]]}},
        "crs": {"image": "EPSG:3857 pixel grid, corners given in EPSG:4326 for a MapLibre image source",
                "grid": "EPSG:4326 (SNODAS native WGS84 latitude/longitude)"},
        "resolution": {"cellArcSec": g["cellArcSec"], "nominal": "1 km (user guide 1.7.3)"},
        "stats": stats(loaded["arrays"]["snow_depth"], loaded["arrays"]["swe"], s["grid"]),
        "sources": [{"name": "NOHRSC Snow Data Assimilation System (SNODAS) Data Products at NSIDC, Version 1 (G02158), masked",
                     "url": fetched["url"], "landingPage": s["landing_page"], "userGuide": s["user_guide"],
                     "files": loaded["files"],
                     "terms": "NSIDC: 'As a condition of using these data, you must cite the use of this data set.' "
                              "No other license text is given on the landing page.",
                     "citation": "National Operational Hydrologic Remote Sensing Center. 2004. Snow Data Assimilation "
                                 "System (SNODAS) Data Products at NSIDC, Version 1. Colorado subset. Boulder, Colorado "
                                 f"USA. NSIDC: National Snow and Ice Data Center. https://doi.org/10.7265/N5TB14TC. "
                                 f"Date accessed {fetched.get('retrievedAt', '')[:10]}.",
                     "attribution": "SNODAS: NOAA NOHRSC, via NSIDC"}],
        "processing": {"script": "pipeline/snow/snodas.py", "config": "pipeline/snow/config.yaml",
                       "parameters": {"bbox": s["bbox"], "pngPixelsPerCellX": s["png_pixels_per_cell_x"],
                                      "resampling": "nearest", "chunkCells": s["chunk_cells"]}},
        "limitations": LIMITATIONS,
        "byteSize": sum(p.stat().st_size for p in files), "fileCount": len(files),
    }


def prune(out_dir: Path, keep: int) -> None:
    """Delete all but the newest `keep` dated product directories (names YYYY-MM-DD only)."""
    dated = sorted(p for p in out_dir.iterdir() if p.is_dir() and DATE_DIR.match(p.name))
    for old in dated[:-keep]:
        log.info("removing old product %s", old)
        shutil.rmtree(old)


def is_current(meta_path: Path, out_dir: Path, day: dt.date) -> bool:
    """True when the published meta already describes `day` and its directory exists."""
    if not meta_path.exists():
        return False
    meta = json.loads(meta_path.read_text())
    return meta.get("analysisDate") == day.isoformat() and (out_dir / day.isoformat()).is_dir()


def run(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Pick the day, fetch, build and write. Returns a process exit code."""
    s, root = cfg["snodas"], Path(args.root).resolve()
    meta_path = root / s["out_meta"]
    day = dt.date.fromisoformat(args.date) if args.date else find_latest(cfg, dt.datetime.now(dt.timezone.utc).date())
    if not args.force and not args.tar and is_current(meta_path, root / s["out_dir"], day):
        log.info("product for %s is already current; nothing to do", day)
        return 0
    with tempfile.TemporaryDirectory(dir=args.work) as tmp:
        fetched = {"url": tar_url(s["base_url"], day), "retrievedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        if args.tar:
            tar_path, fetched["lastModified"] = Path(args.tar), None
        else:
            tar_path, last_mod = download(day, cfg, Path(tmp))
            fetched["lastModified"] = http_date_iso(last_mod)
        loaded = load_variables(tar_path, day, cfg)
    written = write_outputs(loaded, day, cfg, root)
    meta = build_meta(day, loaded, written, cfg, fetched)
    meta_path.write_text(json.dumps(meta, indent=1) + "\n")
    prune(root / s["out_dir"], s["keep_dates"])
    log.info("wrote %s for %s: %d files, %d bytes", meta_path, day, meta["fileCount"], meta["byteSize"])
    return 0


def http_date_iso(value: str | None) -> str | None:
    """RFC 7231 HTTP date to ISO 8601 UTC, or None."""
    if not value:
        return None
    return parsedate_to_datetime(value).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", default=str(REPO), help="output root; products go to <root>/data/snow/ (default: repo)")
    p.add_argument("--date", help="SNODAS day YYYY-MM-DD (default: newest on NSIDC)")
    p.add_argument("--tar", help="use a local SNODAS_YYYYMMDD.tar instead of downloading (needs --date)")
    p.add_argument("--work", help="directory for the temporary download (default: system temp)")
    p.add_argument("--force", action="store_true", help="rebuild even if the product is current")
    p.add_argument("--config", default=str(HERE / "config.yaml"))
    args = p.parse_args(argv)
    if args.tar and not args.date:
        p.error("--tar needs --date")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return run(args, load_config(Path(args.config)))


if __name__ == "__main__":
    raise SystemExit(main())
