"""Simplified Colorado land-manager layer from the BLM Surface Management Agency service."""

from __future__ import annotations

import json
import logging

from common import connect, load_config, repo_path, setup_logging, work_path, write_json
from fetch import append_fetch_log, arcgis_query
from outputs import clean, retrievals, write_meta

log = logging.getLogger("routes.land")


def fetch_sma(cfg) -> list[dict]:
    """Download (once) the Colorado SMA multipolygons, generalised server-side."""
    src = cfg["sources"]["blm_sma"]
    dest = work_path(cfg, src["file"])
    if not dest.exists():
        fetch_log: list[dict] = []
        params = {"where": src["where"], "outFields": src["out_fields"], "outSR": "4326", "returnGeometry": "true",
                  "maxAllowableOffset": str(src["max_allowable_offset_deg"]), "orderByFields": "OBJECTID"}
        feats = arcgis_query(src["query_url"], params, src["page_size"], fetch_log)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
        append_fetch_log(cfg, fetch_log)
    return json.loads(dest.read_text())["features"]


def make_valid(con, geom: dict, grid: float) -> dict:
    """Repair generalisation self-intersections and snap to the output grid (valid after rounding)."""
    sql = "SELECT ST_AsGeoJSON(ST_CollectionExtract(ST_ReducePrecision(ST_MakeValid(ST_GeomFromGeoJSON(?)), ?), 3))"
    return json.loads(con.execute(sql, [json.dumps(geom), grid]).fetchone()[0])


def to_features(cfg, raw: list[dict]) -> list[dict]:
    """One feature per managing agency with display name and caveat."""
    names = cfg["sources"]["blm_sma"]["agency_names"]
    con = connect(cfg)
    out = []
    for f in raw:
        code = f["properties"]["ADMIN_AGENCY_CODE"]
        props = {"id": f"sma-co-{code.lower()}", "class": "land_manager", "name": names.get(code, code), "agencyCode": code,
                 "deptCode": f["properties"].get("ADMIN_DEPT_CODE"), "upstreamId": f"SMA:CO:{code}", "source": "blm-sma",
                 "sourceUrl": cfg["sources"]["blm_sma"]["metadata_url"], "region": None,
                 "caveat": "Managing agency only; not current access, legal parking or permission."}
        out.append({"type": "Feature", "geometry": make_valid(con, f["geometry"], 10.0 ** -cfg["simplify"]["coordinate_decimals"]), "properties": props})
    return out


def main() -> None:
    """Fetch, convert and write data/land/land-status.geojson with its meta."""
    setup_logging()
    cfg = load_config()
    feats = clean(to_features(cfg, fetch_sma(cfg)), cfg["simplify"]["coordinate_decimals"])
    path = repo_path(cfg, cfg["outputs"]["land"])
    size = write_json(path, {"type": "FeatureCollection", "features": feats})
    prod = dict(cfg["products"]["land"], parameters={"maxAllowableOffsetDeg": cfg["sources"]["blm_sma"]["max_allowable_offset_deg"],
                "coordinateDecimals": cfg["simplify"]["coordinate_decimals"]})
    write_meta(cfg, path, prod, feats, retrievals(cfg))
    log.info("land-status: %d features, %d bytes", len(feats), size)
    if size > cfg["outputs"]["max_file_bytes"]:
        raise SystemExit(f"{path} is {size} bytes, over the limit")


if __name__ == "__main__":
    main()
