"""Download raw inputs once into the work directory and log each request.

Existing files are kept unless --force is given, which keeps OpenSkiData
downloads within its "at most once per day" automated-download term.
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from common import load_config, setup_logging, utc_now, work_path

log = logging.getLogger("routes.fetch")
LOG_HEADERS = ("content-length", "last-modified", "etag", "access-control-allow-origin", "content-type")


def download(url: str, dest: Path, fetch_log: list[dict[str, Any]], force: bool) -> None:
    """Download a URL to a file (gzip-decoding if served compressed).

    Args:
        url: Source URL.
        dest: Destination path.
        fetch_log: List that receives one record per request.
        force: Re-download even when dest exists.
    """
    if dest.exists() and not force:
        log.info("keep existing %s", dest)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "skintrack-co-pipeline"})
    started = utc_now()
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as out:
        stream = gzip.GzipFile(fileobj=resp) if resp.headers.get("Content-Encoding") == "gzip" else resp
        while chunk := stream.read(1 << 20):
            out.write(chunk)
        headers = {k: resp.headers.get(k) for k in LOG_HEADERS}
        fetch_log.append({"url": url, "requestedAt": started, "status": resp.status, "headers": headers, "bytes": dest.stat().st_size})
    log.info("downloaded %s (%d bytes)", dest, dest.stat().st_size)


def arcgis_query(url: str, params: dict[str, str], page_size: int, fetch_log: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Page through an ArcGIS REST query (f=geojson) and return all features.

    Args:
        url: Layer query endpoint.
        params: Query parameters without paging keys.
        page_size: resultRecordCount per request.
        fetch_log: Request log.

    Returns:
        GeoJSON features.
    """
    features: list[dict[str, Any]] = []
    offset = 0
    while True:
        page_params = dict(params, resultOffset=str(offset), resultRecordCount=str(page_size), f="geojson")
        full = url + "?" + urllib.parse.urlencode(page_params)
        with urllib.request.urlopen(full, timeout=300) as resp:
            page = json.load(resp)
            fetch_log.append({"url": full, "requestedAt": utc_now(), "status": resp.status, "features": len(page.get("features", []))})
        if "error" in page:
            raise RuntimeError(f"ArcGIS error {page['error']} for {full}")
        features.extend(page.get("features", []))
        if len(page.get("features", [])) < page_size:
            return features
        offset += page_size


def fetch_usfs_winter_trails(cfg: dict[str, Any], fetch_log: list[dict[str, Any]], force: bool) -> None:
    """Download Colorado USFS TrailNFS segments with nonmotorized winter use.

    Args:
        cfg: Pipeline config.
        fetch_log: Request log.
        force: Re-download even when the file exists.
    """
    src = cfg["sources"]["usfs_trails"]
    dest = work_path(cfg, src["file"])
    if dest.exists() and not force:
        log.info("keep existing %s", dest)
        return
    params = {
        "where": src["where"], "geometry": ",".join(str(v) for v in cfg["colorado_bbox"]),
        "geometryType": "esriGeometryEnvelope", "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
        "outFields": src["out_fields"], "outSR": "4326", "returnGeometry": "true", "orderByFields": "objectid",
    }
    features = arcgis_query(src["query_url"], params, src["page_size"], fetch_log)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    log.info("USFS winter trail segments: %d", len(features))


def append_fetch_log(cfg: dict[str, Any], fetch_log: list[dict[str, Any]]) -> None:
    """Append request records to <work_dir>/logs/fetch_log.json."""
    log_path = work_path(cfg, "logs/fetch_log.json")
    old = json.loads(log_path.read_text()) if log_path.exists() else []
    log_path.write_text(json.dumps(old + fetch_log, indent=2), encoding="utf-8")


def main() -> None:
    """Download every raw input listed in config.yaml."""
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="re-download existing files")
    args = ap.parse_args()
    cfg = load_config()
    s = cfg["sources"]
    fetch_log: list[dict[str, Any]] = []
    download(s["osm"]["url"], work_path(cfg, s["osm"]["file"]), fetch_log, args.force)
    osd = s["openskidata"]
    for key in ("metadata", "ski_areas", "runs"):
        download(osd[f"{key}_url"], work_path(cfg, osd[f"{key}_file"]), fetch_log, args.force)
    gnis_zip = work_path(cfg, "raw/gnis/" + Path(s["gnis"]["url"]).name)
    download(s["gnis"]["url"], gnis_zip, fetch_log, args.force)
    with zipfile.ZipFile(gnis_zip) as zf:
        zf.extractall(work_path(cfg, "raw/gnis/x"))
    fetch_usfs_winter_trails(cfg, fetch_log, args.force)
    append_fetch_log(cfg, fetch_log)


if __name__ == "__main__":
    main()
