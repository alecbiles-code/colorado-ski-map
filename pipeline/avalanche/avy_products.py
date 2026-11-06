"""Write the avalanche-model web products to data/avalanche/ with *.meta.json each.

1. avalanche-pra-pilot.pmtiles: primary binary PRA, coloured by continuous PRA class (PNG tiles).
2. avalanche-runout-pilot.pmtiles: primary Flow-Py footprint classed by zDelta (PNG tiles).
3. avalanche-numeric-pilot.pmtiles: per-cell PRA, flags and zDelta for tap inspection (UTM blocks).
4. avalanche-coverage-pilot.geojson: pilot extent and the boundary truncation band.

Requires pra.py, runout.py and avy_checks.py outputs. Usage: python pipeline/avalanche/avy_products.py
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
from pmtiles.tile import TileType
from pyproj import Transformer

from avy_core import load_config, read_band, setup_logging, sha256, write_json
from avy_checks import run_output
from avy_tiles import numeric_blocks, png_bytes, pyramid, write_pmtiles
from runout import runs

LOG = logging.getLogger("avalanche.products")
NUMERIC = {"originE": 0, "originN": 4700000, "blockCells": 256, "apronCells": 0, "nodata": -1000000}


def classify(values: np.ndarray, mask: np.ndarray, classes: list[dict[str, Any]]) -> np.ndarray:
    """uint8 class codes: lower bound inclusive, upper exclusive; 0 outside `mask`.

    Args:
        values: Float grid (NaN allowed).
        mask: Cells eligible for a class.
        classes: [{code, min, max}] with max null for open-ended.

    Returns:
        uint8 grid.
    """
    out = np.zeros(values.shape, dtype=np.uint8)
    for c in classes:
        sel = mask & (values >= c["min"])
        if c["max"] is not None:
            sel &= values < c["max"]
        out[sel] = c["code"]
    return out


def ring(cfg: dict[str, Any], inset_m: float = 0.0, step_m: float = 2000.0) -> list[list[float]]:
    """Densified lon/lat ring of the pilot rectangle, optionally inset (counter-clockwise).

    Args:
        cfg: Loaded config.
        inset_m: Inset distance in metres.
        step_m: Densification step.

    Returns:
        Closed ring [[lon, lat], ...].
    """
    xmin, ymin, xmax, ymax = (v + s * inset_m for v, s in zip(cfg["grid"]["bounds"], (1, 1, -1, -1)))
    to_ll = Transformer.from_crs(cfg["grid"]["crs"], "EPSG:4326", always_xy=True)
    pts = []
    for (x0, y0), (x1, y1) in zip([(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)],
                                  [(xmax, ymin), (xmax, ymax), (xmin, ymax), (xmin, ymin)]):
        k = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) // step_m))
        pts += [(x0 + (x1 - x0) * t / k, y0 + (y1 - y0) * t / k) for t in range(k)]
    pts.append(pts[0])
    return [[round(c, 6) for c in to_ll.transform(x, y)] for x, y in pts]


def bbox_of(r: list[list[float]]) -> list[float]:
    """(west, south, east, north) of a ring."""
    lons, lats = [p[0] for p in r], [p[1] for p in r]
    return [min(lons), min(lats), max(lons), max(lats)]


def coverage(cfg: dict[str, Any], band_m: float) -> dict[str, Any]:
    """Coverage FeatureCollection: modelled extent and the truncation band inside it.

    Args:
        cfg: Loaded config.
        band_m: Truncation band width.

    Returns:
        GeoJSON FeatureCollection.
    """
    outer, inner = ring(cfg), ring(cfg, band_m)
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": "pilot-extent", "properties": {
            "role": "model_extent", "label": "Avalanche model pilot extent (outside: not modelled)"},
         "geometry": {"type": "Polygon", "coordinates": [outer]}},
        {"type": "Feature", "id": "truncation-band", "properties": {
            "role": "truncation_band", "widthM": band_m,
            "label": "Runout incomplete: release terrain outside the pilot is not modelled and "
                     "paths are cut at the pilot edge"},
         "geometry": {"type": "Polygon", "coordinates": [outer, inner[::-1]]}}]}


def display_product(cfg: dict[str, Any], pid: str, codes: np.ndarray, classes: list[dict[str, Any]],
                    bbox: list[float]) -> dict[str, Any]:
    """Render a classified grid to a PNG PMTiles archive.

    Args:
        cfg: Loaded config.
        pid: Product id (file stem).
        codes: uint8 class grid.
        classes: Classes with code and color.
        bbox: lon/lat bbox.

    Returns:
        Tile statistics.
    """
    p = cfg["products"]
    colors = {c["code"]: c["color"] for c in classes}
    tiles = pyramid(codes, cfg["grid"], tuple(bbox), p["minzoom"], p["maxzoom"])
    payload = {k: png_bytes(v, colors) for k, v in tiles.items() if v.any()}
    path = cfg["out_dir"] / f"{pid}.pmtiles"
    write_pmtiles(path, payload, bbox, TileType.PNG, p["minzoom"] + 2,
                  {"name": pid, "classes": classes, "attribution": "Skintrack CO experimental model"})
    return {"tileCount": len(payload), "minzoom": p["minzoom"], "maxzoom": p["maxzoom"],
            "tileType": "png", "tileSize": 256,
            "tileFormat": "png (paletted, class code 0 transparent)", "resampling":
            "nearest at maxzoom; lower zooms take the maximum class of 2 x 2 child pixels; "
            "display with raster-resampling nearest",
            "legend": {"items": [{"label": c["label"], "color": c["color"]} for c in classes]}}


def flag_bits(cfg: dict[str, Any]) -> dict[str, str]:
    """Meaning of each bit of the numeric `flags` variable."""
    p = cfg["pra"]
    bits = {"0": f"release cell, PRA threshold {p['threshold']}",
            "1": f"release cell, PRA threshold {p['sensitivity_threshold']}"}
    for k, (name, spec) in enumerate(runs(cfg).items()):
        thr = p["threshold"] if spec["pra"] == "primary" else p["sensitivity_threshold"]
        bits[str(2 + k)] = f"reached by any path, run {name} (alpha {spec['alpha']}, PRA threshold {thr})"
    bits[str(2 + len(runs(cfg)))] = "inside the boundary truncation band (runout incomplete)"
    return bits


def flag_grid(cfg: dict[str, Any], band_m: float) -> np.ndarray:
    """Per-cell bit flags, bit meanings from flag_bits()."""
    rows, cols = cfg["grid"]["shape"]
    out = np.zeros((rows, cols), dtype=np.int64)
    for bit, tag in ((0, "primary"), (1, "sens_threshold")):
        b, _ = read_band(cfg["work_dir"] / "pra" / f"pra_binary_{tag}.tif")
        out |= (b == 1).astype(np.int64) << bit
    for k, run in enumerate(runs(cfg)):
        out |= (~np.isnan(run_output(cfg, run, "cellCounts"))).astype(np.int64) << (2 + k)
    k = int(round(band_m / cfg["grid"]["res_m"]))
    band = np.ones((rows, cols), dtype=bool)
    band[k:-k, k:-k] = False
    return out | (band.astype(np.int64) << (2 + len(runs(cfg))))


def quantize(a: np.ndarray, scale: float, missing: int) -> np.ndarray:
    """round(a * scale) as int64, NaN -> `missing`."""
    return np.where(np.isnan(a), missing, np.round(np.nan_to_num(a) * scale)).astype(np.int64)


# Quanta chosen for size (8 MB total); cellCounts and travel angle stay in the work-dir GeoTIFFs
# (adding them at 1 count / 1 degree would cost about 4.2 MB and 2.3 MB).
NUMERIC_VARIABLES = [
    {"name": "praContinuous", "label": "Release-area score (0 to 1, not a probability)",
     "tileZ": 9, "scale": 100, "unit": "membership 0-1",
     "meaning": "fuzzy PRA terrain-suitability membership (not a probability); value = n / 100"},
    {"name": "flags", "label": "Model flags", "tileZ": 10, "scale": 1, "unit": "bit field", "bits": None},
    {"name": "zDelta", "label": "Runout energy-line height (Flow-Py z-delta)", "tileZ": 11, "scale": 1,
     "unit": "m", "notReached": -1,
     "meaning": "primary run maximum energy-line height above terrain, rounded to 1 m; "
                "not a speed"},
]


def numeric_product(cfg: dict[str, Any], pid: str, band_m: float, bbox: list[float]) -> dict[str, Any]:
    """Write the numeric inspection PMTiles (one tile zoom per variable).

    Args:
        cfg: Loaded config.
        pid: Product id.
        band_m: Truncation band width.
        bbox: lon/lat bbox.

    Returns:
        Decoder parameters for the meta file.
    """
    cont, _ = read_band(cfg["work_dir"] / "pra" / "pra_continuous.tif")
    cont = np.where(cont == -9999, np.nan, cont.astype(np.float64))
    grids = {"praContinuous": quantize(cont, 100, NUMERIC["nodata"]), "flags": flag_grid(cfg, band_m),
             "zDelta": quantize(run_output(cfg, "primary", "zdelta"), 1, -1)}
    variables = [v | ({"bits": flag_bits(cfg)} if v["name"] == "flags" else {}) for v in NUMERIC_VARIABLES]
    tiles: dict[tuple[int, int, int], bytes] = {}
    for v in variables:
        tiles |= numeric_blocks(grids[v["name"]], cfg["grid"], NUMERIC, v["tileZ"])
    num = {"tileScheme": "utm-block (NOT Web Mercator; never add as a map source)",
           "crs": cfg["grid"]["crs"], "utmZone": 13, "resM": cfg["grid"]["res_m"],
           "gridBounds": cfg["grid"]["bounds"], **NUMERIC, "variables": variables,
           "encoding": "same as data/terrain/terrain-numeric-pilot (zlib byte planes of zigzag 2-D "
                       "difference residuals); decode with decodeNumericTile(bytes, blockCells) and "
                       "locate with numericCellAt(lon, lat, {...numeric, tileZ: variable.tileZ})"}
    write_pmtiles(cfg["out_dir"] / f"{pid}.pmtiles", tiles, bbox, TileType.UNKNOWN, 9,
                  {"name": pid, "numeric": num})
    return {"numeric": num, "tileCount": len(tiles)}


LIMITATIONS = [
    "Experimental terrain modeling. Not an avalanche hazard map, not an ATES rating, not a "
    "forecast; it says nothing about current snowpack, stability, or whether any slope is safe.",
    "Absence of modeled release or runout does not mean terrain is safe or free of avalanche "
    "exposure. Start zones smaller than about 20-30 m (cornices, gullies, cliff bands, convex "
    "rolls), avalanches larger than the alpha angle allows, and release outside the pilot can "
    "reach unshaded terrain.",
    "Parameters are published defaults: PRA from AutoATES v2.0 (two western Canada test areas), "
    "runout from the Flow-Py v1.0 regional example (Austria). None is calibrated or validated for "
    "Colorado.",
    "PRA is a fuzzy terrain-suitability membership from slope, wind shelter and canopy cover; it "
    "is not a release probability.",
    "Flow-Py solves no time-dependent equations. zDelta is an energy-line height (a geometric "
    "intensity proxy), not a speed, depth, pressure or arrival time; cell counts are numbers of "
    "modeled paths, not reach probabilities.",
    "Forest enters only the PRA (canopy cover). The runout ignores forest friction, so modeled "
    "runout into forest is likely too long. Canopy is 2025 NLCD Tree Canopy Cover at 30 m; "
    "standing dead trees and recent disturbance are poorly represented.",
    "Bare-earth 10 m DEM resampled from USGS 3DEP 1/3 arc-second; snow surface, cornices and small "
    "terrain features are not represented.",
    "Inside the truncation band near the pilot edge the runout is incomplete (paths from outside "
    "the pilot are missing and paths leaving it are cut).",
]


def sources(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Provenance entries: DEM, canopy, model software and method references."""
    c = cfg["inputs"]["canopy"]
    return [
        {"name": "USGS 3DEP 1/3 arc-second DEM via pipeline/terrain pilot grid",
         "detail": cfg["inputs"]["dem_source"], "landingPage": "https://www.usgs.gov/3d-elevation-program",
         "license": "Public domain (USGS)", "attribution": "U.S. Geological Survey, 3D Elevation Program"},
        {"name": c["name"], "url": c["url"], "landingPage": c["landing_page"], "license": c["license"],
         "attribution": c["citation"]},
        {"name": f"AvaFrame com4FlowPy {cfg['runout']['avaframe_version']} (Flow-Py)",
         "url": "https://pypi.org/project/avaframe/2.2b1/", "license": "EUPL-1.2",
         "attribution": "D'Amboise et al. 2022, GMD 15:2423, doi:10.5194/gmd-15-2423-2022; AvaFrame"},
        {"name": "AutoATES v2.0 PRA method (reimplemented, no code copied)",
         "url": "https://github.com/AutoATES/AutoATES-v2.0", "license": "GPL-3.0 (software)",
         "attribution": "Toft et al. 2024, NHESS 24:1779, doi:10.5194/nhess-24-1779-2024; "
                        "Veitinger et al. 2016, NHESS 16:2211"}]


def write_meta(cfg: dict[str, Any], pid: str, path: Path, kind: str, title: str,
               analysis: dict[str, Any], extra: dict[str, Any]) -> None:
    """Write <pid>.meta.json next to a product.

    Args:
        cfg: Loaded config.
        pid: Product id.
        path: Product file.
        kind: Product kind.
        title: Display title.
        analysis: checks.py analysis.json content.
        extra: Product-specific fields.
    """
    cov = json.loads((cfg["out_dir"] / "avalanche-coverage-pilot.geojson").read_text())
    runs = analysis["runs"]
    meta = {
        "id": pid, "kind": kind, "title": title, "label": "Experimental terrain model",
        "region": "pilot", "url": f"./data/avalanche/{path.name}", "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "processedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
        .replace("+00:00", "Z"),
        "sources": sources(cfg),
        "model": {"pra": {"method": "AutoATES v2.0 fuzzy logic (slope, wind shelter, canopy cover)",
                          "parameters": cfg["pra"]},
                  "runout": {"software": "AvaFrame com4FlowPy", "version": runs["primary"]["avaframe_version"],
                             "engine": runs["primary"]["engine"],
                             "parameters": {k: v for k, v in cfg["runout"].items()
                                            if k not in ("avaframe_version", "engine")}}},
        "processing": {"scripts": ["pipeline/avalanche/prep_inputs.py", "pipeline/avalanche/pra.py",
                                   "pipeline/avalanche/runout.py", "pipeline/avalanche/avy_checks.py",
                                   "pipeline/avalanche/avy_products.py"],
                       "config": "pipeline/avalanche/config.yaml",
                       "runtimeSeconds": {k: v["wall_s"] for k, v in runs.items()}},
        "analysisGrid": {"crs": cfg["grid"]["crs"], "resM": cfg["grid"]["res_m"],
                         "bounds": cfg["grid"]["bounds"]},
        "units": {"praContinuous": "dimensionless fuzzy membership 0-1", "zDelta": "m",
                  "angles": "degrees", "lengths": "m", "areas": "km2",
                  "canopy": "percent tree canopy cover"},
        "bbox": bbox_of(ring(cfg)),
        "coverage": cov["features"][0]["geometry"],
        "truncationBand": {"widthM": analysis["truncation_band_m"], "geometry": cov["features"][1]["geometry"]},
        "coverageFile": "./data/avalanche/avalanche-coverage-pilot.geojson",
        "limitations": LIMITATIONS, "methods": "docs/methods/avalanche-model.md",
    } | extra
    out = path.with_name(f"{pid}.meta.json")
    write_json(out, meta)
    LOG.info("wrote %s (%d bytes product)", out, meta["bytes"])


def main() -> None:
    """Build all products from the PRA rasters, runs and analysis.json."""
    setup_logging()
    cfg = load_config()
    a = json.loads((cfg["work_dir"] / "analysis.json").read_text())
    band = a["truncation_band_m"]
    cov_path = cfg["out_dir"] / "avalanche-coverage-pilot.geojson"
    write_json(cov_path, coverage(cfg, band))
    bbox = bbox_of(ring(cfg))
    p = cfg["products"]
    cont, _ = read_band(cfg["work_dir"] / "pra" / "pra_continuous.tif")
    rel, _ = read_band(cfg["work_dir"] / "pra" / "pra_binary_primary.tif")
    codes = classify(cont.astype(np.float64), rel == 1, p["pra_classes"])
    info = display_product(cfg, "avalanche-pra-pilot", codes, p["pra_classes"], bbox)
    write_meta(cfg, "avalanche-pra-pilot", cfg["out_dir"] / "avalanche-pra-pilot.pmtiles",
               "avalanche-pra-display", "Potential release areas (experimental model)", a,
               {"classes": p["pra_classes"], "classField": "continuous PRA of primary release cells",
                "praStats": json.loads((cfg["work_dir"] / "pra" / "pra_stats.json").read_text()), **info})
    zd, cc = run_output(cfg, "primary", "zdelta"), run_output(cfg, "primary", "cellCounts")
    codes = classify(zd, ~np.isnan(cc), p["runout_classes"])
    info = display_product(cfg, "avalanche-runout-pilot", codes, p["runout_classes"], bbox)
    write_meta(cfg, "avalanche-runout-pilot", cfg["out_dir"] / "avalanche-runout-pilot.pmtiles",
               "avalanche-runout-display", "Modeled avalanche runout (experimental, Flow-Py)", a,
               {"classes": p["runout_classes"], "classField": "zDelta (m), primary run, cells reached",
                "sensitivity": a["sensitivity"], "edge": a["edge"], **info})
    info = numeric_product(cfg, "avalanche-numeric-pilot", band, bbox)
    write_meta(cfg, "avalanche-numeric-pilot", cfg["out_dir"] / "avalanche-numeric-pilot.pmtiles",
               "avalanche-numeric", "Avalanche model values for tap inspection", a, info)


if __name__ == "__main__":
    main()
