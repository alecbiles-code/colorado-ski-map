"""Print the markdown count tables used in docs/coverage-routes.md from the built products."""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict

from common import load_config, repo_path, work_path

SKI = ["ski_descent", "ascent_skin", "touring_area"]


def load(cfg, key: str) -> list[dict]:
    """Features of one built product."""
    return json.loads(repo_path(cfg, cfg["outputs"][key]).read_text())["features"]


def approach_kind(p: dict) -> str:
    """Group approach features by the kind of source evidence."""
    if p["source"] == "usfs-trailnfs":
        return "approach_usfs"
    b = p["classBasis"]
    if "winter access tag" in b:
        return "approach_osm_access_tag"
    if " on highway=" in b:
        return "approach_osm_tour_road"
    if "nordic" in b and "hike" not in b and "snowshoe" not in b:
        return "approach_osm_bc_nordic"
    return "approach_osm_winter_hike"


def table(title: str, rows: dict[str, Counter], cols: list[str], region_order: list[str]) -> str:
    """Markdown table of region rows by column counts, with a total row."""
    out = [f"\n{title}\n", "| Region | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    total: Counter = Counter()
    for reg in region_order:
        c = rows.get(reg, Counter())
        total.update(c)
        out.append(f"| {reg} | " + " | ".join(str(c.get(k, 0)) for k in cols) + " |")
    out.append("| **total** | " + " | ".join(f"**{total.get(k, 0)}**" for k in cols) + " |")
    return "\n".join(out)


def main() -> None:
    """Print route, place, ski-area and tag-census tables."""
    cfg = load_config()
    regions = [r["id"] for r in cfg["regions"]] + [cfg["other_region"]["id"]]
    routes, places, areas = load(cfg, "routes"), load(cfg, "places"), load(cfg, "ski_areas")
    rc, km = defaultdict(Counter), defaultdict(Counter)
    for f in routes:
        p = f["properties"]
        k = p["class"] if p["class"] != "approach" else approach_kind(p)
        rc[p["region"]][k] += 1
        km[p["region"]][k] += round((p.get("lengthM") or 0) / 1000)
    cols = SKI + ["approach_osm_tour_road", "approach_osm_bc_nordic", "approach_osm_winter_hike", "approach_osm_access_tag", "approach_usfs"]
    print(table("Route features by region (count)", rc, cols, regions))
    print(table("Route length by region (km, rounded per feature)", km, ["ski_descent", "ascent_skin"] + cols[3:], regions))
    pc = defaultdict(Counter)
    for f in places:
        p = f["properties"]
        pc[p["region"]][p["class"] + ("_gnis_only" if p["source"] == "usgs-gnis" else "")] += 1
    print(table("Places by region", pc, ["peak", "peak_gnis_only", "pass", "pass_gnis_only", "trailhead", "parking", "hut"], regions))
    ac = defaultdict(Counter)
    for f in areas:
        p = f["properties"]
        kind = "lift_served" if p["liftServed"] else ("nordic_operating" if p["status"] == "operating" else p["status"])
        ac[p["region"]][kind] += 1
    print(table("Ski areas by region", ac, ["lift_served", "nordic_operating", "abandoned", "proposed", "never_opened", "disused"], regions))
    census = json.loads(repo_path(cfg, "data/routes/routes.meta.json").read_text())["classificationCensus"]
    print("\nExcluded route candidates\n\n| Bucket | Count |\n|---|---|")
    for k, v in sorted(census.items(), key=lambda kv: -kv[1]):
        print(f"| {k} | {v} |")
    print("\nOSM tag census (Colorado extract, ski-relevant keys)\n\n| key=value | kind | count |\n|---|---|---|")
    with open(work_path(cfg, "interim/osm_tag_census.csv"), encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["key"].startswith(("piste:type", "piste:grooming", "ski", "snowshoe", "route", "landuse")) and int(r["n"]) >= 1:
                if r["key"].startswith("ski:") and r["key"] not in ("ski:nordic",):
                    continue
                print(f"| {r['key']}={r['value']} | {r['kind']} | {r['n']} |")


if __name__ == "__main__":
    main()
