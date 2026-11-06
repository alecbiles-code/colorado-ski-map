"""Build the Colorado SNOTEL and SNOLITE station snapshot from the NRCS AWDB REST API (keyless).

Writes data/snow/snotel-stations.geojson and its .meta.json (paths from config.yaml).
Station metadata changes rarely; rebuild by hand each autumn or when NRCS adds stations.

Usage:
  python pipeline/snow/snotel_stations.py [--root DIR]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("snotel_stations")

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def load_config(path: Path = HERE / "config.yaml") -> dict[str, Any]:
    """Read the snow pipeline YAML config."""
    return yaml.safe_load(path.read_text())


def stations_url(cfg: dict[str, Any]) -> str:
    """AWDB /stations query: active stations, only the configured elements and durations."""
    s = cfg["snotel"]
    q = {"stationTriplets": ",".join(s["station_triplets"]), "activeOnly": "true", "returnStationElements": "true",
         "durations": ",".join(s["durations"]), "elements": ",".join(s["elements"])}
    return f"{s['api_base']}/stations?{urllib.parse.urlencode(q, safe='*:,')}"


def fetch_json(url: str, cfg: dict[str, Any]) -> Any:
    """GET a JSON document (no retry: this is a hand-run snapshot, a failure should be seen)."""
    req = urllib.request.Request(url, headers={"User-Agent": cfg["http"]["user_agent"], "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=cfg["http"]["timeout_s"]) as r:
        return json.load(r)


def element_summary(elements: list[dict[str, Any]]) -> dict[str, Any]:
    """Per element code (ordinal 1): stored unit and begin date for each duration the station reports."""
    out: dict[str, Any] = {}
    for e in sorted(elements, key=lambda e: (e["elementCode"], e["durationName"])):
        if e.get("ordinal") != 1 or e.get("heightDepth") is not None:
            continue
        item = out.setdefault(e["elementCode"], {"unit": e["storedUnitCode"]})
        item[e["durationName"].lower() + "Begin"] = e["beginDate"][:10]
    return out


def to_feature(st: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any] | None:
    """One station as a GeoJSON Feature, or None when its coordinates or elevation are unusable."""
    s = cfg["snotel"]
    lon, lat, elev_ft = st.get("longitude"), st.get("latitude"), st.get("elevation")
    if not all(isinstance(v, (int, float)) for v in (lon, lat, elev_ft)) or not (-180 <= lon <= 180 and -90 <= lat <= 90):
        log.warning("skipping %s: bad location %s, %s, %s", st.get("stationTriplet"), lon, lat, elev_ft)
        return None
    triplet = st["stationTriplet"]
    props = {
        "id": f"nrcs-awdb:{triplet}", "upstreamId": triplet, "source": "NRCS AWDB",
        "sourceUrl": s["station_page"].format(station_id=st["stationId"]),
        "name": st["name"], "network": st["networkCode"], "networkName": s["network_names"].get(st["networkCode"]),
        "stationId": st["stationId"], "stateCode": st["stateCode"], "county": st.get("countyName"),
        "huc": st.get("huc"), "shefId": st.get("shefId"),
        "elevationM": round(elev_ft * s["feet_to_m"], 1), "elevationSource": {"value": elev_ft, "unit": "ft"},
        "dataTimeZoneOffsetHours": st.get("dataTimeZone"), "beginDate": (st.get("beginDate") or "")[:10] or None,
        "elements": element_summary(st.get("stationElements", [])),
    }
    return {"type": "Feature", "id": props["id"], "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


def build(cfg: dict[str, Any]) -> tuple[dict[str, Any], str, str]:
    """Fetch and convert. Returns (FeatureCollection, query URL, retrieval time)."""
    url = stations_url(cfg)
    retrieved = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = fetch_json(url, cfg)
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"unexpected AWDB response: {str(raw)[:200]}")
    feats = [f for f in (to_feature(st, cfg) for st in raw) if f]
    feats.sort(key=lambda f: (f["properties"]["network"], f["properties"]["name"]))
    return {"type": "FeatureCollection", "features": feats}, url, retrieved


def build_meta(fc: dict[str, Any], url: str, retrieved: str, out_bytes: int) -> dict[str, Any]:
    """Provenance for snotel-stations.meta.json (ARCHITECTURE 4.5)."""
    coords = [f["geometry"]["coordinates"] for f in fc["features"]]
    offsets = sorted({f["properties"]["dataTimeZoneOffsetHours"] for f in fc["features"]}, key=str)
    nets: dict[str, int] = {}
    for f in fc["features"]:
        nets[f["properties"]["network"]] = nets.get(f["properties"]["network"], 0) + 1
    return {
        "id": "snotel-stations", "title": "NRCS SNOTEL and SNOLITE stations, Colorado",
        "retrievedAt": retrieved, "processedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "featureCount": len(coords), "byNetwork": nets, "dataTimeZoneOffsetsHours": offsets,
        "coverage": {"bbox": [min(c[0] for c in coords), min(c[1] for c in coords), max(c[0] for c in coords), max(c[1] for c in coords)]},
        "crs": "EPSG:4326", "units": {"elevationM": "m (converted from AWDB feet x 0.3048)", "elements.*.unit": "AWDB storedUnitCode, as returned"},
        "sources": [{"name": "USDA NRCS National Water and Climate Center, Air and Water Database (AWDB) REST API",
                     "url": url, "docs": "https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html",
                     "license": "data.gov lists AWDB with license https://www.usa.gov/government-works (U.S. Government work)",
                     "attribution": "USDA NRCS National Water and Climate Center"}],
        "processing": {"script": "pipeline/snow/snotel_stations.py", "config": "pipeline/snow/config.yaml"},
        "limitations": [
            "Active stations only, as listed by AWDB on the retrieval date.",
            "AWDB gives elevation in feet and does not state its vertical datum or accuracy.",
            "dataTimeZoneOffsetHours is the fixed UTC offset of the station's hourly timestamps (no daylight time). "
            "For every Colorado station it is -8; see docs/methods/snow-sar-incidents.md for the check.",
            "A station measures one point in a clearing. The nearest station is not necessarily representative of "
            "alpine, wind-loaded or differently aspected terrain.",
            "Elements list what the station is configured to report; a listed element can still be missing or "
            "suspect on any given day.",
        ],
        "byteSize": out_bytes,
    }


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", default=str(REPO), help="output root (default: the repository)")
    p.add_argument("--config", default=str(HERE / "config.yaml"))
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config(Path(args.config))
    fc, url, retrieved = build(cfg)
    out = Path(args.root) / cfg["snotel"]["out_geojson"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, separators=(",", ":")) + "\n")
    meta = build_meta(fc, url, retrieved, out.stat().st_size)
    (Path(args.root) / cfg["snotel"]["out_meta"]).write_text(json.dumps(meta, indent=1) + "\n")
    log.info("wrote %d stations to %s (%d bytes)", len(fc["features"]), out, out.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
