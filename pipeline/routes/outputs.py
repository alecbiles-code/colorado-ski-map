"""Write GeoJSON products, the search index and their *.meta.json files."""

from __future__ import annotations

import json
import logging
from collections import Counter
from pathlib import Path
from typing import Any

from common import feature_collection_bbox, repo_path, round_coords, utc_now, work_path, write_json
from regions import region_polygons

log = logging.getLogger("routes.outputs")
CORE = {"id", "class", "name", "upstreamId", "source", "sourceUrl", "region"}
KEEP_NULL = {"lengthM", "elevationM"}  # explicit null = unknown, never dropped
SOURCE_KEYS = {"openstreetmap": "osm", "usfs-trailnfs": "usfs_trails", "usgs-gnis": "gnis", "openskidata": "openskidata"}


def clean(features: list[dict[str, Any]], ndigits: int) -> list[dict[str, Any]]:
    """Drop private keys, round coordinates, drop null optional properties, sort by id."""
    out = []
    for f in features:
        props = {k: v for k, v in f["properties"].items() if v is not None or k in CORE or k.startswith("dem") or k in KEEP_NULL}
        geom = {"type": f["geometry"]["type"], "coordinates": round_coords(f["geometry"]["coordinates"], ndigits)}
        out.append({"type": "Feature", "id": props["id"], "geometry": geom, "properties": props})
    return sorted(out, key=lambda f: f["id"])


def counts(features: list[dict[str, Any]]) -> dict[str, Any]:
    """Feature counts by class, by region, by region and class, and by source."""
    by = Counter((f["properties"].get("region"), f["properties"]["class"]) for f in features)
    nested: dict[str, dict[str, int]] = {}
    for (reg, cls), n in sorted(by.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        nested.setdefault(str(reg), {})[cls] = n
    return {"total": len(features), "byClass": dict(Counter(f["properties"]["class"] for f in features)),
            "bySource": dict(Counter(f["properties"]["source"] for f in features)), "byRegionClass": nested}


def retrievals(cfg) -> dict[str, str]:
    """Latest retrieval time per source URL from the fetch log."""
    path = work_path(cfg, "logs/fetch_log.json")
    log_rows = json.loads(path.read_text()) if path.exists() else []
    latest: dict[str, str] = {}
    for r in log_rows:
        base = r["url"].split("?")[0]
        latest[base] = max(latest.get(base, ""), r["requestedAt"])
    return latest


def source_entry(cfg, key: str, got: dict[str, str]) -> dict[str, Any]:
    """Provenance record for one configured source."""
    s = cfg["sources"][key]
    url = s.get("url") or s.get("ski_areas_url") or s.get("query_url") or s.get("url_template")
    entry = {"name": key, "url": url, "license": s["license"], "attribution": s["attribution"],
             "termsUrl": s.get("terms_url") or s.get("metadata_url"), "retrievedAt": got.get(url)}
    for k in ("data_timestamp", "published", "upstream"):
        if k in s:
            entry[k] = s[k]
    return entry


def write_meta(cfg, path: Path, product: dict[str, Any], features: list[dict[str, Any]] | None, got: dict[str, str]) -> None:
    """Write <file>.meta.json next to a product."""
    meta = {
        "id": product["id"], "title": product["title"], "file": path.name, "format": product.get("format", "GeoJSON"),
        "bytes": path.stat().st_size, "processedAt": utc_now(), "crs": "EPSG:4326", "coordinateOrder": "lon,lat",
        "license": product["license"], "attribution": product["attribution"],
        "sources": [source_entry(cfg, k, got) for k in product["sources"]],
        "processing": {"script": product.get("script", "pipeline/routes/build.py"), "steps": product["steps"], "parameters": product.get("parameters", {})},
        "coverage": {"bbox": feature_collection_bbox(features) if features else cfg["colorado_bbox"], "area": "Colorado (state bounding box)"},
        "units": product.get("units", {}), "limitations": product["limitations"],
    }
    if features is not None:
        meta["counts"] = counts(features)
    meta.update(product.get("extra", {}))
    write_json(path.with_name(path.name.replace(".geojson", "").replace(".json", "") + ".meta.json"), meta, compact=False)


def search_index(routes, places, ski_areas) -> dict[str, Any]:
    """Compact columnar search index over named features."""
    fields = ["id", "name", "class", "lon", "lat", "region", "elevationM", "source"]
    data = []
    for f in places + ski_areas + routes:
        p = f["properties"]
        if not p.get("name"):
            continue
        x, y = f["_label"]
        data.append([p["id"], p["name"], p["class"], round(x, 5), round(y, 5), p.get("region"), p.get("elevationM"), p["source"]])
    data.sort(key=lambda r: (r[1].lower(), r[0]))
    return {"fields": fields, "rows": data}


def write_collection(cfg, key: str, features: list[dict[str, Any]], got: dict[str, str], extra: dict[str, Any] | None = None) -> int:
    """Write one FeatureCollection product and its meta; return its byte size."""
    path = repo_path(cfg, cfg["outputs"][key])
    cl = clean(features, cfg["simplify"]["coordinate_decimals"])
    size = write_json(path, {"type": "FeatureCollection", "features": cl})
    prod = dict(cfg["products"][key], extra=extra or {}, parameters=product_parameters(cfg))
    write_meta(cfg, path, prod, cl, got)
    return size


def product_parameters(cfg) -> dict[str, Any]:
    """Processing parameters recorded in every meta file."""
    return {"simplifyToleranceDeg": cfg["simplify"]["tolerance_deg"], "coordinateDecimals": cfg["simplify"]["coordinate_decimals"],
            "resortContext": cfg["resort_context"], "parkingMaxDistanceM": cfg["osm_rules"]["parking_max_distance_m"],
            "gnisMatchRadiusM": cfg["sources"]["gnis"]["match_radius_m"], "demSampleSpacingM": cfg["sources"]["dem"]["sample_spacing_m"]}


def dem_description(cfg, stats: dict[str, Any]) -> dict[str, Any]:
    """DEM label for the routes meta (name, zoom, pixel size at 39 N, run stats)."""
    from dem import pixel_size_m

    d = cfg["sources"]["dem"]
    return {"name": d["name"], "urlTemplate": d["url_template"], "zoom": d["zoom"], "tileSizePx": d["tile_size"],
            "upstream": d["upstream"], "attribution": d["attribution"], "accuracy": d["accuracy_note"],
            "pixelSizeMAt39N": round(pixel_size_m(39.0, d["zoom"], d["tile_size"]), 2), "interpolation": "bilinear",
            "aspectMethod": "Horn 3x3 on the Web Mercator tile grid with per-latitude pixel size; degrees clockwise from true north",
            **stats}


def write_products(con, cfg, routes, places, ski_areas, regions, stats) -> None:
    """Write all products and metas; fail loudly if any file exceeds the size limit."""
    got = retrievals(cfg)
    sizes = {
        "routes": write_collection(cfg, "routes", routes, got, {"classificationCensus": stats["census"], "dem": dem_description(cfg, stats["dem"])}),
        "ski_areas": write_collection(cfg, "ski_areas", ski_areas, got),
        "places": write_collection(cfg, "places", places, got, {"placeStats": stats["places"], "dem": dem_description(cfg, stats["places"]["dem"])}),
    }
    path = repo_path(cfg, cfg["outputs"]["regions"])
    feats = region_polygons(con, cfg)
    sizes["regions"] = write_json(path, {"type": "FeatureCollection", "features": [dict(f, id=f["properties"]["id"]) for f in feats]})
    write_meta(cfg, path, dict(cfg["products"]["regions"], extra={"regionIds": [f["properties"]["id"] for f in feats], "counts": {"total": len(feats)}}), None, got)
    path = repo_path(cfg, cfg["outputs"]["search"])
    idx = search_index(routes, places, ski_areas)
    sizes["search"] = write_json(path, idx)
    write_meta(cfg, path, dict(cfg["products"]["search"], extra={"counts": {"total": len(idx["rows"]),
               "byClass": dict(Counter(r[2] for r in idx["rows"]))}}), None, got)
    log.info("sizes: %s", sizes)
    too_big = {k: v for k, v in sizes.items() if v > cfg["outputs"]["max_file_bytes"]}
    if too_big:
        raise SystemExit(f"files over the size limit: {too_big}")
