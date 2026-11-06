"""Extract ski-relevant OSM elements from the Geofabrik Colorado PBF with DuckDB.

Writes a tag census (CSV) and two interim parquet files: candidate ways with
their line or polygon geometry, and candidate tagged nodes. Classification
happens later in build.py; this step only selects and builds geometry.
"""

from __future__ import annotations

import logging

from common import connect, load_config, setup_logging, work_path

log = logging.getLogger("routes.osm")

# Ways worth building geometry for: pistes, winter-access paths, ski areas,
# lifts (for lift-served proximity), and areas that become points.
WAY_FILTER = """
    tags['piste:type'] IS NOT NULL
    OR tags['ski'] IN (SELECT unnest($access)) OR tags['ski:nordic'] IN (SELECT unnest($access))
    OR tags['snowshoe'] IN (SELECT unnest($access))
    OR tags['landuse'] = 'winter_sports' OR tags['aerialway'] IS NOT NULL
    OR tags['tourism'] IN (SELECT unnest($huts)) OR tags['shelter_type'] IN (SELECT unnest($shelters))
    OR tags['highway'] = 'trailhead' OR tags['amenity'] = 'parking'
"""
NODE_FILTER = """
    tags['natural'] IN ('peak', 'saddle') OR tags['mountain_pass'] = 'yes'
    OR tags['highway'] = 'trailhead' OR tags['amenity'] = 'parking'
    OR tags['tourism'] IN (SELECT unnest($huts)) OR tags['shelter_type'] IN (SELECT unnest($shelters))
    OR tags['piste:type'] IS NOT NULL
"""


def stage_elements(con, pbf: str) -> None:
    """Load every tagged element from the PBF into a table."""
    con.execute(f"""CREATE OR REPLACE TABLE elems AS
        SELECT kind::VARCHAR AS kind, id, tags, refs, lat, lon, ref_roles, ref_types::VARCHAR[] AS ref_types
        FROM ST_ReadOSM('{pbf}') WHERE cardinality(tags) > 0""")
    log.info("tagged elements: %s", con.execute("SELECT kind, count(*) FROM elems GROUP BY 1").fetchall())


def write_census(con, cfg, out_csv: str) -> None:
    """Count key (and for selected keys, key=value) usage by element kind."""
    rules = cfg["osm_rules"]
    like = " OR ".join(f"k LIKE '{p}'" for p in rules["census_key_patterns"])
    con.execute(f"""COPY (
        WITH kv AS (SELECT kind, e.key AS k, e.value AS v FROM (SELECT kind, unnest(map_entries(tags)) AS e FROM elems))
        SELECT k AS key, CASE WHEN k LIKE '%name%' OR k LIKE '%ref%' OR k LIKE '%network%' THEN '*' ELSE v END AS value,
               kind, count(*) AS n
        FROM kv WHERE ({like})
          AND (k NOT IN ('landuse','natural','highway','tourism','amenity','route')
               OR v IN ('winter_sports','peak','saddle','trailhead','alpine_hut','wilderness_hut','shelter','parking','ski','piste'))
        GROUP BY ALL ORDER BY key, n DESC) TO '{out_csv}' (HEADER)""")
    log.info("census written to %s", out_csv)


def inherit_relation_tags(con) -> None:
    """Map member ways of route=piste/ski relations to the relation's piste tags."""
    con.execute("""CREATE OR REPLACE TABLE rel_member AS
        WITH m AS (SELECT id AS rel_id, tags AS rtags, unnest(refs) AS way_id, unnest(ref_types) AS t
                   FROM elems WHERE kind = 'relation' AND tags['route'] IN ('piste', 'ski'))
        SELECT way_id, min(rel_id) AS rel_id, any_value(rtags) AS rtags FROM m WHERE t = 'way' GROUP BY way_id""")


def build_ways(con, pbf: str, cfg) -> None:
    """Select candidate ways (own or inherited tags) and build their geometry."""
    rules = cfg["osm_rules"]
    params = {"access": rules["winter_access_values"], "huts": rules["hut_tourism"], "shelters": rules["hut_shelter_types"]}
    con.execute(f"""CREATE OR REPLACE TABLE cand_ways AS
        SELECT w.id, w.tags, w.refs, r.rel_id, r.rtags FROM elems w LEFT JOIN rel_member r ON r.way_id = w.id
        WHERE w.kind = 'way' AND (({WAY_FILTER}) OR r.way_id IS NOT NULL)""", params)
    con.execute(f"""CREATE OR REPLACE TABLE need_nodes AS
        SELECT id, lon, lat FROM ST_ReadOSM('{pbf}')
        WHERE kind = 'node' AND id IN (SELECT DISTINCT unnest(refs) FROM cand_ways)""")
    con.execute("""CREATE OR REPLACE TABLE way_geom AS
        WITH pts AS (SELECT w.id, unnest(w.refs) AS nid, generate_subscripts(w.refs, 1) AS i FROM cand_ways w)
        SELECT pts.id, ST_MakeLine(list(ST_Point(n.lon, n.lat) ORDER BY pts.i)) AS line, count(n.id) AS n_found,
               count(*) AS n_refs
        FROM pts LEFT JOIN need_nodes n ON n.id = pts.nid GROUP BY pts.id""")
    missing = con.execute("SELECT count(*) FROM way_geom WHERE n_found < n_refs").fetchone()[0]
    log.info("candidate ways: %d (with missing nodes: %d)", con.execute("SELECT count(*) FROM cand_ways").fetchone()[0], missing)


def export(con, ways_out: str, nodes_out: str, cfg) -> None:
    """Write candidate ways and nodes to parquet with WKB geometry."""
    rules = cfg["osm_rules"]
    params = {"huts": rules["hut_tourism"], "shelters": rules["hut_shelter_types"]}
    con.execute(f"""COPY (
        SELECT w.id, to_json(w.tags) AS tags, w.rel_id, to_json(w.rtags) AS rtags,
               ST_IsClosed(g.line) AND ST_NPoints(g.line) >= 4 AS closed, ST_AsWKB(g.line) AS wkb
        FROM cand_ways w JOIN way_geom g USING (id) WHERE g.n_found = g.n_refs AND g.n_refs >= 2
        ) TO '{ways_out}' (FORMAT parquet)""")
    con.execute(f"""COPY (SELECT id, to_json(tags) AS tags, lon, lat FROM elems
        WHERE kind = 'node' AND ({NODE_FILTER})) TO '{nodes_out}' (FORMAT parquet)""", params)
    log.info("wrote %s and %s", ways_out, nodes_out)


def main() -> None:
    """Run the OSM extraction."""
    setup_logging()
    cfg = load_config()
    pbf = str(work_path(cfg, cfg["sources"]["osm"]["file"]))
    con = connect(cfg)
    stage_elements(con, pbf)
    write_census(con, cfg, str(work_path(cfg, "interim/osm_tag_census.csv")))
    inherit_relation_tags(con)
    build_ways(con, pbf, cfg)
    export(con, str(work_path(cfg, "interim/osm_ways.parquet")), str(work_path(cfg, "interim/osm_nodes.parquet")), cfg)


if __name__ == "__main__":
    main()
