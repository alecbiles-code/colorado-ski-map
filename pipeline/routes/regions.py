"""App-defined reporting regions: point assignment and published polygons."""

from __future__ import annotations

import json
from typing import Any


def load_regions(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Return configured regions in priority order (dicts with id, name, note, ring)."""
    return [{"id": r["id"], "name": r["name"], "note": r["note"], "ring": r["polygon"]} for r in cfg["regions"]]


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    """Even-odd ray test for a point against a simple polygon ring."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def region_for(regions: list[dict[str, Any]], x: float, y: float, other_id: str = "other") -> str:
    """First region (by priority) containing the point, else the catch-all id."""
    for r in regions:
        if point_in_ring(x, y, r["ring"]):
            return r["id"]
    return other_id


def assign_regions(regions: list[dict[str, Any]], features: list[dict[str, Any]]) -> None:
    """Set properties.region on each feature from its label point."""
    for f in features:
        x, y = f["_label"]
        f["properties"]["region"] = region_for(regions, x, y)


def region_polygons(con, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Publishable non-overlapping region polygons, plus the 'other' remainder of the Colorado box.

    Each region is its configured polygon minus all higher-priority regions.
    """
    bbox = cfg["colorado_bbox"]
    taken = f"ST_MakeEnvelope({bbox[0]}, {bbox[1]}, {bbox[2]}, {bbox[3]})"
    con.execute(f"CREATE OR REPLACE TEMP TABLE taken AS SELECT ST_GeomFromText('POLYGON EMPTY') AS g, {taken} AS co")
    out = []
    for r in cfg["regions"] + [dict(cfg["other_region"], polygon=None)]:
        if r["polygon"]:
            wkt = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in r["polygon"]) + "))"
            gj = con.execute(f"SELECT ST_AsGeoJSON(ST_Intersection(ST_Difference(ST_GeomFromText('{wkt}'), g), co)) FROM taken").fetchone()[0]
            con.execute(f"UPDATE taken SET g = ST_Union(g, ST_GeomFromText('{wkt}'))")
        else:
            gj = con.execute("SELECT ST_AsGeoJSON(ST_Difference(co, g)) FROM taken").fetchone()[0]
        props = {"id": r["id"], "name": r["name"], "note": r["note"], "appDefined": True,
                 "definition": "App-defined approximate reporting region; not an official, land-management or CAIC forecast boundary."}
        out.append({"type": "Feature", "geometry": json.loads(gj), "properties": props})
    return out
