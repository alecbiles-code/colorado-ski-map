"""Point places (peaks, passes, trailheads, parking, huts) and ski-area features."""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from common import rows

GNIS_URL = "https://edits.nationalmap.gov/apps/gaz-domestic/public/summary/{id}"
OSM_URL = "https://www.openstreetmap.org/{kind}/{id}"
SKIMAP_URL = "https://skimap.org/skiareas/view/{id}"
PLACE_SQL = {
    "peak": "tags->>'natural' = 'peak'",
    "pass": "tags->>'mountain_pass' = 'yes' OR tags->>'natural' = 'saddle'",
    "trailhead": "tags->>'highway' = 'trailhead' OR tags->>'tourism' = 'trailhead'",
    "hut": "list_contains($huts, tags->>'tourism') OR list_contains($shelters, tags->>'shelter_type')",
    "parking": "tags->>'amenity' = 'parking' AND coalesce(tags->>'access', '') NOT IN ('private', 'no', 'customers')",
}


def parse_ele(raw: str | None, lo: float, hi: float) -> float | None:
    """Parse an OSM ele value to metres; None when absent, unparseable or implausible."""
    if not raw:
        return None
    m = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?\s*$", raw.replace(",", ""))
    if not m:
        return None
    v = float(m.group(1)) * (0.3048 if m.group(2) in ("ft", "'") else 1.0)
    return round(v, 1) if lo <= v <= hi else None


def norm_name(s: str | None) -> str:
    """Normalise a place name for comparison (case, punctuation, Mt/Mount)."""
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    s = re.sub(r"\bmt\b", "mount", s)
    return " ".join(s.split())


def stage_places(con, cfg) -> None:
    """Create table `pl` of candidate OSM places (nodes and way centroids) with metric geometry."""
    crs, r = cfg["metric_crs"], cfg["osm_rules"]
    union = " UNION ALL ".join(
        f"SELECT '{cls}' AS cls, 'node' AS kind, id, tags, geom FROM pnodes WHERE {cond} "
        f"UNION ALL SELECT '{cls}', 'way', id, tags, ST_Centroid(geom) FROM ways WHERE {cond}"
        for cls, cond in PLACE_SQL.items())
    con.execute(f"""CREATE OR REPLACE TABLE pl AS SELECT *, ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true) AS gm,
        EXISTS (SELECT 1 FROM ctx WHERE ST_DWithin(ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true), ctx.gm, ctx.d)) AS resort
        FROM ({union})""", {"huts": r["hut_tourism"], "shelters": r["hut_shelter_types"]})
    # A trailhead node that is also tagged parking stays a trailhead only.
    con.execute("DELETE FROM pl WHERE cls = 'parking' AND (kind, id) IN (SELECT (kind, id) FROM pl WHERE cls = 'trailhead')")
    con.execute("DELETE FROM pl WHERE cls = 'pass' AND (kind, id) IN (SELECT (kind, id) FROM pl WHERE cls = 'peak')")


def gnis_matches(con, cfg) -> tuple[dict[tuple[str, int], dict[str, Any]], list[dict[str, Any]]]:
    """Nearest GNIS Summit/Gap for OSM peaks/passes, and GNIS records with no OSM match."""
    g, crs = cfg["sources"]["gnis"], cfg["metric_crs"]
    con.execute(f"""CREATE OR REPLACE TABLE gn AS SELECT feature_id, feature_name, geom,
        CASE WHEN list_contains($s, feature_class) THEN 'peak' ELSE 'pass' END AS cls,
        ST_Transform(geom, 'EPSG:4326', '{crs}', always_xy := true) AS gm FROM gnis
        WHERE list_contains($s, feature_class) OR list_contains($p, feature_class)""", {"s": g["summit_classes"], "p": g["pass_classes"]})
    match = rows(con, f"""SELECT pl.kind, pl.id, arg_min(gn.feature_id, ST_Distance(pl.gm, gn.gm)) AS gid,
        arg_min(gn.feature_name, ST_Distance(pl.gm, gn.gm)) AS gname, min(ST_Distance(pl.gm, gn.gm)) AS dist
        FROM pl JOIN gn ON gn.cls = pl.cls AND ST_DWithin(pl.gm, gn.gm, {g['match_radius_m']}) GROUP BY ALL""")
    only = rows(con, f"""SELECT gn.feature_id, gn.feature_name, gn.cls, ST_X(gn.geom) AS x, ST_Y(gn.geom) AS y FROM gn
        WHERE NOT EXISTS (SELECT 1 FROM pl WHERE pl.cls = gn.cls AND ST_DWithin(pl.gm, gn.gm, {g['match_radius_m']}))""")
    return {(m["kind"], m["id"]): m for m in match}, only


def osm_place(r: dict[str, Any], m: dict[str, Any] | None, cfg) -> dict[str, Any] | None:
    """Build one OSM place feature; None when it should be skipped (unnamed peak/pass)."""
    tags = json.loads(r["tags"])
    name, name_source = tags.get("name"), "openstreetmap"
    if not name and m and r["cls"] in ("peak", "pass"):
        name, name_source = m["gname"], "usgs-gnis"
    if not name and r["cls"] in ("peak", "pass"):
        return None
    lo, hi = cfg["elevation_range_m"]
    ele = parse_ele(tags.get("ele"), lo, hi)
    props = {
        "id": f"osm-{r['kind']}-{r['id']}", "class": r["cls"], "name": name, "nameSource": name_source if name else None,
        "upstreamId": f"{r['kind']}/{r['id']}", "source": "openstreetmap", "sourceUrl": OSM_URL.format(kind=r["kind"], id=r["id"]),
        "elevationM": ele, "elevationSource": "osm:ele" if ele is not None else None,
        "eleRaw": tags.get("ele") if tags.get("ele") and ele is None else None,
        "geometrySource": "node" if r["kind"] == "node" else "way centroid",
        "operator": tags.get("operator"), "access": tags.get("access"),
    }
    if m:
        props.update({"gnisId": str(m["gid"]), "gnisName": m["gname"], "gnisDistanceM": round(m["dist"], 1),
                      "gnisNameMatch": norm_name(m["gname"]) == norm_name(name)})
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["x"], r["y"]]}, "properties": props, "_label": (r["x"], r["y"])}


def gnis_place(r: dict[str, Any]) -> dict[str, Any]:
    """Build a peak/pass feature from a GNIS record that has no OSM counterpart."""
    props = {"id": f"gnis-{r['feature_id']}", "class": r["cls"], "name": r["feature_name"], "nameSource": "usgs-gnis",
             "upstreamId": str(r["feature_id"]), "source": "usgs-gnis", "sourceUrl": GNIS_URL.format(id=r["feature_id"]),
             "elevationM": None, "elevationSource": None, "geometrySource": "GNIS primary point"}
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["x"], r["y"]]}, "properties": props, "_label": (r["x"], r["y"])}


def ski_area_features(con, cfg) -> tuple[list[dict[str, Any]], int]:
    """OpenSkiData ski areas with a stable upstream id; returns features and the count skipped."""
    tol = cfg["simplify"]["tolerance_deg"]
    out, skipped = [], 0
    for r in rows(con, f"""SELECT props, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, {tol})) AS gj,
            ST_X(ST_PointOnSurface(geom)) AS x, ST_Y(ST_PointOnSurface(geom)) AS y FROM ski_areas"""):
        p = json.loads(r["props"])
        osm = [s["id"] for s in p["sources"] if s["type"] == "openstreetmap"]
        skimap = [str(s["id"]) for s in p["sources"] if s["type"] == "skimap.org"]
        if not osm and not skimap:
            skipped += 1  # OpenSkiData-generated cluster with only an unstable content-hash id
            continue
        props = {
            "id": "osd-" + (f"osm-{osm[0].replace('/', '-')}" if osm else f"skimap-{skimap[0]}"), "class": "ski_area",
            "name": p.get("name"), "status": p.get("status"), "activities": p.get("activities"),
            "liftServed": p.get("status") == "operating" and "downhill" in (p.get("activities") or []),
            "website": (p.get("websites") or [None])[0],
            "upstreamId": ";".join([f"openstreetmap:{i}" for i in osm] + [f"skimap.org:{i}" for i in skimap]),
            "source": "openskidata", "sourceUrl": OSM_URL.format(kind=osm[0].split("/")[0], id=osm[0].split("/")[1]) if osm else SKIMAP_URL.format(id=skimap[0]),
            "osdId": p.get("id"),
        }
        out.append({"type": "Feature", "geometry": json.loads(r["gj"]), "properties": props, "_label": (r["x"], r["y"])})
    return out, skipped


def place_features(con, cfg) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    """Build place features and ski-area features.

    Returns:
        (places, ski_areas, stats) where stats counts exclusions and GNIS additions.
    """
    stage_places(con, cfg)
    matches, only = gnis_matches(con, cfg)
    stats: Counter = Counter()
    d = cfg["osm_rules"]["parking_max_distance_m"]
    feats = []
    for r in rows(con, f"""SELECT cls, kind, id, tags, resort, ST_X(geom) AS x, ST_Y(geom) AS y FROM pl
            WHERE cls <> 'parking' OR EXISTS (SELECT 1 FROM pl t WHERE t.cls = 'trailhead' AND ST_DWithin(pl.gm, t.gm, {d}))"""):
        if r["cls"] == "hut" and r["resort"]:
            stats["excluded:hut_in_lift_served_context"] += 1
            continue
        f = osm_place(r, matches.get((r["kind"], r["id"])), cfg)
        if f is None:
            stats[f"excluded:unnamed_{r['cls']}"] += 1
            continue
        feats.append(f)
    for r in only:
        feats.append(gnis_place(r))
        stats[f"added:gnis_only_{r['cls']}"] += 1
    stats["parking_candidates_total"] = con.execute("SELECT count(*) FROM pl WHERE cls = 'parking'").fetchone()[0]
    ski_areas, skipped = ski_area_features(con, cfg)
    stats["excluded:ski_area_without_stable_id"] = skipped
    return feats, ski_areas, dict(stats)
