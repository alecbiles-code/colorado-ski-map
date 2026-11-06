"""Build route, ski-area, place, region and search products from staged inputs.

Run after fetch.py and osm_extract.py. Reads only files under the work
directory and writes the deliverables (plus *.meta.json) into the repository.
"""

from __future__ import annotations

import argparse
import json
import logging
from collections import Counter
from typing import Any

from classify import classify_way, is_area
from common import connect, load_config, rows, setup_logging, utc_now, work_path
from dem import TerrariumDEM, densify, haversine_m, line_metrics
from outputs import write_products
from places import place_features
from regions import assign_regions, load_regions

log = logging.getLogger("routes.build")
LINE_CLASSES = {"ski_descent", "ascent_skin", "approach"}
OSM_URL = "https://www.openstreetmap.org/{kind}/{id}"
SNOW_USE = {"1": "snowshoe", "2": "xc_ski", "3": "snowmobile"}


def load_osd_ski_areas(con, cfg) -> None:
    """Load the Colorado subset of OpenSkiData ski areas into a table."""
    src = cfg["sources"]["openskidata"]
    recs = []
    with open(work_path(cfg, src["ski_areas_file"]), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().rstrip(",")
            if src["region_code"] not in line or not line.startswith("{"):
                continue
            f = json.loads(line)
            if any(p.get("iso3166_2") == src["region_code"] for p in f["properties"].get("places", [])):
                recs.append((json.dumps(f["properties"]), json.dumps(f["geometry"])))
    con.execute("CREATE OR REPLACE TABLE osd_raw(props JSON, gj VARCHAR)")
    con.executemany("INSERT INTO osd_raw VALUES (?, ?)", recs)
    con.execute("""CREATE OR REPLACE TABLE ski_areas AS SELECT props, props->>'status' AS status,
        list_contains(CAST(props->'activities' AS VARCHAR[]), 'downhill') AS downhill, ST_GeomFromGeoJSON(gj) AS geom FROM osd_raw""")
    log.info("OpenSkiData Colorado ski areas: %d", len(recs))


def load_sources(con, cfg) -> None:
    """Create tables for OSM ways/nodes, ski areas, lifts, USFS trails and GNIS."""
    w = lambda rel: str(work_path(cfg, rel))  # noqa: E731
    crs = cfg["metric_crs"]
    con.execute(f"""CREATE OR REPLACE TABLE ways AS SELECT id, tags::JSON AS tags, rel_id, rtags::JSON AS rtags, closed,
        ST_GeomFromWKB(wkb) AS geom FROM '{w("interim/osm_ways.parquet")}'""")
    con.execute(f"""CREATE OR REPLACE TABLE pnodes AS SELECT id, tags::JSON AS tags, ST_Point(lon, lat) AS geom
        FROM '{w("interim/osm_nodes.parquet")}'""")
    load_osd_ski_areas(con, cfg)
    excl = cfg["resort_context"]["lift_exclude_values"]
    con.execute(f"""CREATE OR REPLACE TABLE lifts AS SELECT id, ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true) AS gm
        FROM ways WHERE tags->>'aerialway' IS NOT NULL AND NOT list_contains($excl, tags->>'aerialway')""", {"excl": excl})
    con.execute(f"CREATE OR REPLACE TABLE usfs AS SELECT * FROM ST_Read('{w(cfg['sources']['usfs_trails']['file'])}')")
    con.execute(f"""CREATE OR REPLACE TABLE gnis AS SELECT feature_id, feature_name, feature_class,
        ST_Point(prim_long_dec, prim_lat_dec) AS geom FROM read_csv('{w(cfg['sources']['gnis']['file'])}', delim='|', header=true,
        all_varchar=true, types={{'prim_long_dec': 'DOUBLE', 'prim_lat_dec': 'DOUBLE'}}) WHERE prim_lat_dec <> 0""")


def build_resort_context(con, cfg) -> None:
    """Create the lift-served context table (geometry in metres plus buffer distance)."""
    rc, crs = cfg["resort_context"], cfg["metric_crs"]
    tr = f"ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true)"
    con.execute(f"""CREATE OR REPLACE TABLE ctx AS
        SELECT {tr} AS gm, {rc['polygon_buffer_m']} AS d FROM ski_areas
          WHERE status = 'operating' AND downhill AND ST_GeometryType(geom) <> 'POINT'
        UNION ALL SELECT {tr}, {rc['point_buffer_m']} FROM ski_areas
          WHERE list_contains($st, status) AND downhill AND ST_GeometryType(geom) = 'POINT'
        UNION ALL SELECT gm, {rc['lift_buffer_m']} FROM lifts""", {"st": rc["point_statuses"]})


def effective_tags(tags: dict[str, str], rtags: dict[str, str] | None) -> dict[str, str]:
    """Fill piste tags and name from a parent route relation when the way lacks piste:type."""
    if not rtags or tags.get("piste:type"):
        return tags
    merged = dict(tags)
    for k, v in rtags.items():
        if (k.startswith("piste:") or k == "name") and k not in merged:
            merged[k] = v
    return merged


def stage_candidates(con, cfg, table: str, select_sql: str) -> list[dict[str, Any]]:
    """Materialise candidate rows with full/simplified GeoJSON, a label point and the resort flag.

    Args:
        con: DuckDB connection.
        cfg: Pipeline config.
        table: Name for the staged table.
        select_sql: Query returning at least id-like columns and a WGS84 `geom` column.

    Returns:
        Rows as dictionaries.
    """
    crs, tol = cfg["metric_crs"], cfg["simplify"]["tolerance_deg"]
    con.execute(f"""CREATE OR REPLACE TABLE {table} AS SELECT *, ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true) AS gm
        FROM ({select_sql})""")
    return rows(con, f"""SELECT * EXCLUDE (geom, gm), ST_AsGeoJSON(geom) AS gj,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {tol})) AS gjs,
        ST_X(ST_PointOnSurface(geom)) AS px, ST_Y(ST_PointOnSurface(geom)) AS py,
        EXISTS (SELECT 1 FROM ctx WHERE ST_DWithin(t.gm, ctx.gm, ctx.d)) AS resort FROM {table} t""")


def osm_route_feature(r: dict[str, Any], tags: dict[str, str], cls: str, basis: str, kind: str) -> dict[str, Any]:
    """Assemble one route feature from an OSM way or node row."""
    geom = json.loads(r["gjs"])
    if cls == "touring_area":
        geom = {"type": "Polygon", "coordinates": [geom["coordinates"]]}
    props = {
        "id": f"osm-{kind}-{r['id']}", "class": cls, "name": tags.get("name") or tags.get("piste:name"),
        "upstreamId": f"{kind}/{r['id']}", "source": "openstreetmap", "sourceUrl": OSM_URL.format(kind=kind, id=r["id"]),
        "classBasis": basis, "sourceDifficulty": tags.get("piste:difficulty"), "sourceGrooming": tags.get("piste:grooming"),
        "description": tags.get("description"), "pisteType": tags.get("piste:type"),
        "winterAccess": {k: tags[k] for k in ("ski", "ski:nordic", "snowshoe", "snowmobile") if k in tags} or None,
        "osmRelationId": r.get("rel_id"),
    }
    return {"type": "Feature", "geometry": geom, "properties": props, "_full": json.loads(r["gj"]), "_label": (r["px"], r["py"])}


def osm_routes(con, cfg, census: Counter) -> list[dict[str, Any]]:
    """Classify OSM ways and piste nodes into route features; count exclusions."""
    allowed = set(cfg["osm_rules"]["winter_access_values"])
    cand = stage_candidates(con, cfg, "cand_ways", """SELECT id, tags, rel_id, rtags, closed, geom FROM ways
        WHERE tags->>'piste:type' IS NOT NULL OR rel_id IS NOT NULL OR tags->>'ski' IS NOT NULL
           OR tags->>'ski:nordic' IS NOT NULL OR tags->>'snowshoe' IS NOT NULL""")
    cand += [dict(r, kind="node") for r in stage_candidates(con, cfg, "cand_nodes", """SELECT id, tags, NULL::BIGINT AS rel_id,
        NULL::JSON AS rtags, false AS closed, geom FROM pnodes WHERE tags->>'piste:type' IS NOT NULL""")]
    out = []
    for r in cand:
        tags = effective_tags(json.loads(r["tags"]), json.loads(r["rtags"]) if r["rtags"] else None)
        cls, basis = classify_way(tags, allowed)
        if cls is None:
            if basis != "no_winter_tag":
                census[f"excluded:{basis}"] += 1
            continue
        if r["resort"]:
            census[f"excluded:lift_served_context:{cls}"] += 1
            continue
        if cls != "approach" and r.get("kind") != "node" and is_area(tags, r["closed"]):
            cls, basis = "touring_area", basis + "; closed way read as area"
        out.append(osm_route_feature(r, tags, cls, basis, r.get("kind", "way")))
    return out


def usfs_routes(con, cfg, census: Counter) -> list[dict[str, Any]]:
    """USFS trail segments with source-recorded nonmotorized winter use, as approach features."""
    src = cfg["sources"]["usfs_trails"]
    out = []
    for r in stage_candidates(con, cfg, "cand_usfs", "SELECT * EXCLUDE (geom), geom FROM usfs"):
        if r["resort"]:
            census["excluded:lift_served_context:usfs_approach"] += 1
            continue
        uses = [SNOW_USE[c] for c in sorted(r["allowed_snow_use"] or "") if c in SNOW_USE]
        props = {
            "id": f"usfs-{r['trail_cn']}-{r['bmp']:.2f}-{r['emp']:.2f}", "class": "approach", "name": r["trail_name"],
            "upstreamId": f"{r['trail_cn']}:{r['bmp']:.2f}-{r['emp']:.2f}", "source": "usfs-trailnfs", "sourceUrl": src["metadata_url"],
            "classBasis": "USFS TrailNFS nonmotorized winter use (allowed_snow_use or managed season)",
            "usfsTrailNo": r["trail_no"], "usfsAllowedSnowUse": uses or None, "usfsSnowMotorized": r["snow_motorized"],
            "usfsXcSkiManaged": r["xcountry_ski_managed"], "usfsSnowshoeManaged": r["snowshoe_managed"],
        }
        geom = json.loads(r["gjs"])
        out.append({"type": "Feature", "geometry": geom, "properties": props, "_full": json.loads(r["gj"]), "_label": (r["px"], r["py"])})
    return out


def line_parts(geom: dict[str, Any]) -> list[list[list[float]]]:
    """Return the line parts of a LineString or MultiLineString geometry."""
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def line_features(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Route features that are lines (descent, skin, approach)."""
    return [f for f in features if f["properties"]["class"] in LINE_CLASSES and line_parts(f["_full"])]


def add_lengths(features: list[dict[str, Any]]) -> None:
    """Set lengthM (geodesic, unsimplified geometry) on line features."""
    for f in line_features(features):
        parts = line_parts(f["_full"])
        f["properties"]["lengthM"] = round(sum(haversine_m(a, b) for p in parts for a, b in zip(p[:-1], p[1:])), 1)


def make_dem(cfg, points: list[tuple[float, float]]) -> tuple[TerrariumDEM, int]:
    """DEM reader with every tile needed for the points prefetched; returns (reader, tile count)."""
    d = cfg["sources"]["dem"]
    dem = TerrariumDEM(d["url_template"], d["zoom"], d["tile_size"], work_path(cfg, d["cache_dir"]), d["user_agent"],
                       d["max_workers"], d["retries"])
    tiles = dem.tiles_for(points)
    if len(tiles) > d["max_tiles"]:
        raise SystemExit(f"{len(tiles)} DEM tiles needed; raise sources.dem.max_tiles to allow")
    dem.prefetch(tiles)
    return dem, len(tiles)


def add_peak_dem(cfg, places: list[dict[str, Any]]) -> dict[str, Any]:
    """Set demElevationM (bilinear DEM sample at the point) on peaks without a source elevation."""
    peaks = [f for f in places if f["properties"]["class"] == "peak" and f["properties"].get("elevationM") is None]
    pts = [tuple(f["geometry"]["coordinates"]) for f in peaks]
    dem, n_tiles = make_dem(cfg, pts)
    for f, (lon, lat) in zip(peaks, pts):
        f["properties"]["demElevationM"] = round(dem.elevation(lon, lat), 1)
    return {"peaksSampled": len(peaks), "tilesUsed": n_tiles, "tilesDownloadedThisRun": dem.fetched, "sampledAt": utc_now()}


def add_dem_metrics(cfg, features: list[dict[str, Any]]) -> dict[str, Any]:
    """Add dem* metrics to line features; return DEM run statistics."""
    d = cfg["sources"]["dem"]
    lines = line_features(features)
    pts = [p for f in lines for part in line_parts(f["_full"]) for p in densify(part, d["sample_spacing_m"])]
    dem, n_tiles = make_dem(cfg, pts)
    for f in lines:
        want_aspect = f["properties"]["class"] == "ski_descent"
        f["properties"].update(line_metrics(dem, line_parts(f["_full"]), d["sample_spacing_m"], want_aspect))
    return {"tilesUsed": n_tiles, "tilesDownloadedThisRun": dem.fetched, "linesMeasured": len(lines),
            "samples": len(pts), "sampledAt": utc_now()}


def main() -> None:
    """Build every routes-lane product."""
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-dem", action="store_true", help="skip DEM metrics (dem* fields stay null)")
    args = ap.parse_args()
    cfg = load_config()
    con = connect(cfg)
    load_sources(con, cfg)
    build_resort_context(con, cfg)
    census: Counter = Counter()
    routes = osm_routes(con, cfg, census) + usfs_routes(con, cfg, census)
    add_lengths(routes)
    dem_stats = {"skipped": True} if args.no_dem else add_dem_metrics(cfg, routes)
    places, ski_areas, place_stats = place_features(con, cfg)
    place_stats["dem"] = {"skipped": True} if args.no_dem else add_peak_dem(cfg, places)
    regions = load_regions(cfg)
    for fs in (routes, places, ski_areas):
        assign_regions(regions, fs)
    write_products(con, cfg, routes, places, ski_areas, regions, {"census": dict(census), "dem": dem_stats, "places": place_stats})


if __name__ == "__main__":
    main()
