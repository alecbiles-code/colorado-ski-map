"""Measure a PMTiles vector archive: header, metadata, tile sizes per zoom, unique features at max zoom.

Read-only. Used to fill data/sar/sar-inventory.meta.json; re-run after the inventory is rebuilt.

Usage:
  python pipeline/sar/inspect_pmtiles.py ARCHIVE.pmtiles LAYER [> facts.json]
"""

from __future__ import annotations

import argparse
import collections
import gzip
import json
import logging
import sys
from typing import Any

import mapbox_vector_tile
from pmtiles.reader import MmapSource, Reader, all_tiles

log = logging.getLogger("inspect_pmtiles")


def header_and_metadata(reader: Reader) -> dict[str, Any]:
    """Header fields as plain values, and metadata without the bulky tilestats value samples."""
    header = {k: (v if isinstance(v, (int, float, str, bool)) else str(v)) for k, v in reader.header().items()}
    meta = reader.metadata()
    stats = meta.pop("tilestats", {})
    for layer in stats.get("layers", []):
        for attr in layer.get("attributes", []):
            if attr.get("type") != "string":
                attr.pop("values", None)
    meta.pop("strategies", None)
    return {"header": header, "metadata": meta, "tilestats": stats}


def scan(reader: Reader, layer: str) -> dict[str, Any]:
    """Tile byte sizes per zoom, and unique features (by event_id) at the archive's max zoom."""
    maxz = reader.header()["max_zoom"]
    sizes: dict[int, list[int]] = collections.defaultdict(list)
    first: dict[Any, dict[str, Any]] = {}
    tiles_per_id: collections.Counter = collections.Counter()
    for (z, _x, _y), data in all_tiles(reader.get_bytes):
        sizes[z].append(len(data))
        if z != maxz:
            continue
        raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
        for feat in mapbox_vector_tile.decode(raw).get(layer, {}).get("features", []):
            props = feat["properties"]
            tiles_per_id[props.get("event_id")] += 1
            first.setdefault(props.get("event_id"), props)
    groups = collections.Counter(f"{p.get('season')}|{p.get('confidence')}" for p in first.values())
    areas = [p["Area_m2"] for p in first.values() if isinstance(p.get("Area_m2"), (int, float))]
    return {
        "tileBytesByZoom": {z: {"tiles": len(v), "maxBytes": max(v), "meanBytes": round(sum(v) / len(v))} for z, v in sorted(sizes.items())},
        "maxZoomUniqueFeatures": len(first), "bySeasonConfidence": dict(sorted(groups.items())),
        "areaM2": {"min": min(areas), "max": max(areas)} if areas else None,
        "featuresSplitAcrossTiles": sum(1 for n in tiles_per_id.values() if n > 1),
        "maxTilesForOneFeature": max(tiles_per_id.values(), default=0),
        "featuresWithoutEventId": tiles_per_id.get(None, 0),
    }


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point; writes JSON to stdout."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("archive")
    p.add_argument("layer")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    with open(args.archive, "rb") as f:
        reader = Reader(MmapSource(f))
        facts = header_and_metadata(reader) | scan(reader, args.layer)
    json.dump(facts, sys.stdout, indent=1)
    sys.stdout.write("\n")
    log.info("%s: %d unique features at max zoom", args.archive, facts["maxZoomUniqueFeatures"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
