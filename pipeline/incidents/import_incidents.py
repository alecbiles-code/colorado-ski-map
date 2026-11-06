"""Validate an authorized avalanche-incident file (CSV or GeoJSON) into data/incidents/incidents.geojson.

Only run this on a file whose source has given permission to republish it, and record that permission
with --authorization. Rows that fail validation are rejected (never repaired by guessing); coordinates
are taken only as published and never inferred from a place description.

Usage:
  python pipeline/incidents/import_incidents.py INPUT.csv|INPUT.geojson --profile caic_us_fatal_xlsx \
      --source CAIC --authorization "CAIC written permission, <date>, <reference>"
  python pipeline/incidents/import_incidents.py --empty --reason "why there is no data yet"
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

import jsonschema
import yaml

log = logging.getLogger("import_incidents")

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
STATUSES = {"preliminary": "preliminary", "final": "final", "final report": "final", "preliminary information": "preliminary"}
MEANINGS = {"accident_site", "burial_site", "release_area", "approximate_report_location", "unknown"}


def load_config(path: Path = HERE / "config.yaml") -> dict[str, Any]:
    """Read the incidents YAML config."""
    return yaml.safe_load(path.read_text())


def read_rows(path: Path) -> list[dict[str, Any]]:
    """CSV rows, or GeoJSON feature properties with lon/lat taken from Point geometry."""
    if path.suffix.lower() in (".geojson", ".json"):
        rows = []
        for feat in json.loads(path.read_text())["features"]:
            row = dict(feat.get("properties") or {})
            geom = feat.get("geometry")
            if geom and geom.get("type") == "Point":
                row["lon"], row["lat"] = geom["coordinates"][:2]
            rows.append(row)
        return rows
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def blank(value: Any) -> Any:
    """Empty strings and whitespace become None; other values pass through."""
    return None if value is None or (isinstance(value, str) and not value.strip()) else value


def text(value: Any, limit: int) -> str | None:
    """Trimmed text within a length bound, or None."""
    value = blank(value)
    if value is None:
        return None
    value = re.sub(r"\s+", " ", str(value)).strip()
    if len(value) > limit:
        raise ValueError(f"text longer than {limit} characters")
    return value


def count(value: Any) -> int | None:
    """Non-negative whole number, or None when not reported (never 0 by default)."""
    value = blank(value)
    if value is None:
        return None
    number = float(value)
    if number < 0 or number != int(number):
        raise ValueError(f"count {value!r} is not a non-negative whole number")
    return int(number)


def parse_date(row: dict[str, Any], cols: dict[str, Any], today: dt.date) -> dt.date:
    """Date from one ISO column or from [year, month, day] columns; must not be in the future."""
    if "date_parts" in cols:
        y, m, d = (int(float(row[c])) for c in cols["date_parts"])
        day = dt.date(y, m, d)
    else:
        day = dt.date.fromisoformat(str(row[cols["date"]]).strip()[:10])
    if day > today:
        raise ValueError(f"date {day} is in the future")
    return day


def season_of(day: dt.date, start_month: int) -> str:
    """Avalanche year containing `day`, e.g. 2025-01-10 -> '2024-2025' when the year starts in October."""
    first = day.year if day.month >= start_month else day.year - 1
    return f"{first}-{first + 1}"


def coordinates(lon: Any, lat: Any, zero_missing: bool, bbox: list[float]) -> list[float] | None:
    """[lon, lat] inside the Colorado bbox, or None when not published. Half-missing or outside is an error."""
    lon, lat = blank(lon), blank(lat)
    if lon is None and lat is None:
        return None
    if lon is None or lat is None:
        raise ValueError("only one of lon/lat is present")
    lon, lat = float(lon), float(lat)
    if zero_missing and lon == 0 and lat == 0:
        return None
    if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
        raise ValueError(f"point ({lon}, {lat}) is outside Colorado (lon/lat swapped?)")
    return [lon, lat]


def field(row: dict[str, Any], profile: dict[str, Any], name: str) -> Any:
    """Value of schema field `name` via the profile's column map, else the profile default, else None."""
    col = profile["columns"].get(name)
    if col is not None and col in row:
        value = blank(row[col])
        if value is not None:
            return value
    return profile.get("defaults", {}).get(name)


def position(row: dict[str, Any], profile: dict[str, Any], point: list[float] | None, limit: int) -> dict[str, Any]:
    """What the point represents and its stated uncertainty; 'none' when there is no point."""
    if point is None:
        return {"meaning": "none", "uncertaintyM": None, "note": text(field(row, profile, "position_note"), limit)}
    meaning = field(row, profile, "position_meaning")
    if meaning not in MEANINGS:
        raise ValueError(f"position meaning {meaning!r} is not one of {sorted(MEANINGS)}")
    unc = blank(field(row, profile, "uncertainty_m"))
    return {"meaning": meaning, "uncertaintyM": None if unc is None else float(unc),
            "note": text(field(row, profile, "position_note"), limit)}


def report_status(value: Any) -> str:
    """'preliminary', 'final', or 'unknown' when absent. Unrecognised wording is an error, not a guess."""
    value = blank(value)
    if value is None or str(value).strip().lower() == "unknown":
        return "unknown"
    try:
        return STATUSES[str(value).strip().lower()]
    except KeyError:
        raise ValueError(f"report status {value!r} not recognised") from None


def facts(value: Any, limit: int) -> list[str]:
    """Verified facts from a list, or from a ' | '-separated string in CSV."""
    value = blank(value)
    items = value if isinstance(value, list) else ([] if value is None else str(value).split(" | "))
    return [t for t in (text(v, limit) for v in items) if t]


def make_id(source: str, upstream: str | None, day: dt.date, place: str | None, point: list[float] | None) -> str:
    """<source>:<upstream id>, or <source>:<date>:<hash of date, place, point> when there is no upstream id."""
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")
    if upstream:
        return f"{slug}:{upstream}"
    digest = hashlib.sha1(f"{day}|{place}|{point}".encode()).hexdigest()[:10]
    return f"{slug}:{day}:{digest}"


def to_feature(row: dict[str, Any], profile: dict[str, Any], source: str, cfg: dict[str, Any], today: dt.date) -> dict[str, Any]:
    """One validated incident Feature, or ValueError with the reason."""
    lim, cols = cfg["max_text"], profile["columns"]
    day = parse_date(row, cols, today)
    point = coordinates(field(row, profile, "lon"), field(row, profile, "lat"), profile["zero_coordinates_are_missing"], cfg["bbox"])
    place = text(field(row, profile, "place"), lim["place"])
    upstream = text(field(row, profile, "upstream_id"), 200)
    url = text(field(row, profile, "url"), 500)
    if url and not url.startswith("https://"):
        raise ValueError(f"url {url!r} is not https")
    props = {
        "id": make_id(source, upstream, day, place, point), "upstreamId": upstream, "source": source, "sourceUrl": url,
        "date": day.isoformat(), "season": season_of(day, cfg["season_start_month"]), "place": place,
        "state": text(field(row, profile, "state"), 2), "position": position(row, profile, point, lim["fact"]),
        "activity": text(field(row, profile, "activity"), lim["activity"]),
        "caught": count(field(row, profile, "caught")), "buried": count(field(row, profile, "buried")),
        "injured": count(field(row, profile, "injured")), "killed": count(field(row, profile, "killed")),
        "reportStatus": report_status(field(row, profile, "report_status")),
        "summary": text(field(row, profile, "summary"), lim["summary"]),
        "verifiedFacts": facts(field(row, profile, "verified_facts"), lim["fact"]),
    }
    geometry = None if point is None else {"type": "Point", "coordinates": point}
    return {"type": "Feature", "id": props["id"], "geometry": geometry, "properties": props}


def convert(rows: list[dict[str, Any]], profile: dict[str, Any], source: str, cfg: dict[str, Any],
            today: dt.date) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate every row. Returns (features, rejects); duplicates of an id are rejected, not merged.

    Rows from states outside the profile's keep_states (for a US-wide file) are skipped, not rejected.
    """
    feats, rejects, seen = [], [], set()
    keep = set(profile.get("keep_states") or [])
    for i, row in enumerate(rows, start=1):
        if keep and str(field(row, profile, "state") or "").strip() not in keep:
            continue
        try:
            feat = to_feature(row, profile, source, cfg, today)
            if feat["id"] in seen:
                raise ValueError(f"duplicate id {feat['id']}")
        except (ValueError, KeyError, TypeError) as e:
            rejects.append({"row": i, "reason": str(e)})
            continue
        seen.add(feat["id"])
        feats.append(feat)
    feats.sort(key=lambda f: (f["properties"]["date"], f["id"]), reverse=True)
    return feats, rejects


def check_columns(path: Path, profile: dict[str, Any]) -> None:
    """A CSV must carry every mapped column, so a renamed upstream column fails loudly instead of nulling a field."""
    if path.suffix.lower() != ".csv":
        return
    with path.open(newline="", encoding="utf-8-sig") as f:
        header = set(next(csv.reader(f), []))
    wanted = {c for v in profile["columns"].values() for c in (v if isinstance(v, list) else [v])}
    if missing := sorted(wanted - header):
        raise ValueError(f"{path.name} lacks mapped columns {missing}")


def validate(feats: list[dict[str, Any]], schema_path: Path) -> None:
    """Every feature must pass schemas/incident.schema.json; raise on the first failure."""
    validator = jsonschema.Draft202012Validator(json.loads(schema_path.read_text()), format_checker=jsonschema.FormatChecker())
    for feat in feats:
        validator.validate(feat)


LIMITATIONS = [
    "Reported accidents only. Missing incidents never imply low risk, and the map never shows a hazard rating.",
    "A point is shown only where the source published coordinates; position.meaning says what it marks (often unknown).",
    "Preliminary reports can change; the official report page is authoritative.",
]


def write(feats: list[dict[str, Any]], meta: dict[str, Any], cfg: dict[str, Any], root: Path) -> None:
    """Write the FeatureCollection and its meta file."""
    out = root / cfg["out_geojson"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")) + "\n")
    meta |= {"featureCount": len(feats), "locatedCount": sum(1 for f in feats if f["geometry"]),
             "processedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "crs": "EPSG:4326", "schema": cfg["schema"], "limitations": LIMITATIONS, "byteSize": out.stat().st_size,
             "officialLinks": "./data/incidents/official-links.json"}
    (root / cfg["out_meta"]).write_text(json.dumps(meta, indent=1) + "\n")
    log.info("wrote %d incidents (%d located) to %s", meta["featureCount"], meta["locatedCount"], out)


def run(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Import or write the empty dataset. Returns a process exit code (1 when rows were rejected)."""
    root = Path(args.root)
    meta: dict[str, Any] = {"id": "incidents", "title": "Avalanche incidents"}
    if args.empty:
        feats, rejects = [], []
        meta |= {"status": "empty", "reason": args.reason, "source": None, "authorization": None}
    else:
        path, profile = Path(args.input), cfg["profiles"][args.profile]
        check_columns(path, profile)
        rows = read_rows(path)
        feats, rejects = convert(rows, profile, args.source, cfg, dt.date.today())
        log.info("read %d rows: %d features, %d rejected, %d skipped by state", len(rows), len(feats), len(rejects), len(rows) - len(feats) - len(rejects))
        meta |= {"status": "imported", "source": args.source, "authorization": args.authorization,
                 "input": {"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "profile": args.profile},
                 "rejectedCount": len(rejects), "rejected": rejects[:100]}
        for r in rejects[:20]:
            log.warning("rejected row %d: %s", r["row"], r["reason"])
    validate(feats, REPO / cfg["schema"])
    write(feats, meta, cfg, root)
    return 1 if rejects else 0


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", nargs="?", help="authorized CSV or GeoJSON file")
    p.add_argument("--profile", default="native", help="column mapping in config.yaml")
    p.add_argument("--source", help="source name, e.g. CAIC")
    p.add_argument("--authorization", help="the permission you hold to republish this file (recorded in the meta)")
    p.add_argument("--empty", action="store_true", help="write a valid empty dataset")
    p.add_argument("--reason", help="with --empty: why there is no data")
    p.add_argument("--root", default=str(REPO), help="output root (default: the repository)")
    p.add_argument("--config", default=str(HERE / "config.yaml"))
    args = p.parse_args(argv)
    if args.empty and not args.reason:
        p.error("--empty needs --reason")
    if not args.empty and not (args.input and args.source and args.authorization):
        p.error("an import needs INPUT, --source and --authorization (only import data you may republish)")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return run(args, load_config(Path(args.config)))


if __name__ == "__main__":
    raise SystemExit(main())
