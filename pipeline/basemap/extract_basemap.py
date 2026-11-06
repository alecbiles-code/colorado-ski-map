"""Extract the Colorado basemap cells from a Protomaps daily build and write basemap.meta.json.

Usage (from anywhere):
    uv run --with pyyaml python pipeline/basemap/extract_basemap.py [--force]

Each cell in config.yaml becomes one PMTiles archive. Existing archives are reused unless --force,
so the metadata can be rebuilt without downloading again. The app routes each tile request to the
archive whose bounds and zoom range cover it (see app/map/ tile protocol).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import shutil
import subprocess
from pathlib import Path

import yaml

LOG = logging.getLogger("basemap")
REPO = Path(__file__).resolve().parents[2]


def extract_cell(cfg: dict, name: str, cell: list, force: bool) -> Path:
    """Run `pmtiles extract` for one cell unless its archive already exists.

    Args:
        cfg: Parsed config.yaml.
        name: Cell name, used as the archive file stem.
        cell: [west, south, east, north, minzoom, maxzoom].
        force: Re-extract even when the archive exists.

    Returns:
        Path of the archive in the work directory.
    """
    out = Path(cfg["work_dir"]) / f"{name}.pmtiles"
    if out.exists() and not force:
        LOG.info("reuse %s (%d bytes)", out.name, out.stat().st_size)
        return out
    west, south, east, north, minz, maxz = cell
    part = out.with_suffix(".part")
    cmd = [cfg["pmtiles_bin"], "extract", cfg["source"], str(part), f"--bbox={west},{south},{east},{north}",
           f"--minzoom={minz}", f"--maxzoom={maxz}"]
    LOG.info("extract %s", " ".join(cmd[1:]))
    subprocess.run(cmd, check=True, capture_output=True, stdin=subprocess.DEVNULL)
    part.rename(out)  # a reader never sees a partial archive
    return out


def verify(cfg: dict, path: Path) -> None:
    """Fail loudly when `pmtiles verify` rejects an archive."""
    subprocess.run([cfg["pmtiles_bin"], "verify", str(path)], check=True, capture_output=True, stdin=subprocess.DEVNULL)


def archive_entry(cfg: dict, name: str, cell: list, path: Path) -> dict:
    """Describe one archive for the app and copy it into the repo.

    Raises:
        ValueError: When the archive exceeds the configured per-file limit.
    """
    verify(cfg, path)
    size = path.stat().st_size
    if size > cfg["max_bytes"]:
        raise ValueError(f"{name} is {size} bytes, over the {cfg['max_bytes']} byte limit; split the cell")
    dest = REPO / cfg["out_dir"] / path.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, dest)
    west, south, east, north, minz, maxz = cell
    return {"id": name, "url": cfg["url_prefix"] + path.name, "bounds": [west, south, east, north],
            "minzoom": minz, "maxzoom": maxz, "bytes": size}


def write_meta(cfg: dict, archives: list[dict]) -> None:
    """Write data/basemap/basemap.meta.json with provenance and the archive list."""
    meta = {
        "id": "basemap-colorado",
        "title": "Colorado basemap (OpenStreetMap via Protomaps)",
        "kind": "pmtiles-vector-multi",
        "schema": "Protomaps basemap v4",
        "bbox": [-109.06, 36.99, -102.04, 41.01],
        "minzoom": 0,
        "maxzoom": max(a["maxzoom"] for a in archives),
        "archives": archives,
        "bytes": sum(a["bytes"] for a in archives),
        "sources": [{"name": "Protomaps daily build", "url": cfg["source"], "version": cfg["build_date"], "dataAsOf": cfg["osm_data_as_of"],
                     "license": cfg["license"], "attribution": cfg["attribution"]}],
        "processing": {"script": "pipeline/basemap/extract_basemap.py", "config": "pipeline/basemap/config.yaml",
                       "processedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")},
        "limitations": ["OpenStreetMap is volunteer-mapped; trail presence, names and winter usability are not guaranteed.",
                        "Snapshot of one build date; it does not update itself."],
    }
    out = REPO / cfg["out_dir"] / "basemap.meta.json"
    out.write_text(json.dumps(meta, indent=1) + "\n")
    LOG.info("wrote %s: %d archives, %d bytes", out, len(archives), meta["bytes"])


def main() -> None:
    """Parse arguments, extract every cell, and write the metadata."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-extract existing archives")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    cfg = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())
    Path(cfg["work_dir"]).mkdir(parents=True, exist_ok=True)
    archives = [archive_entry(cfg, n, c, extract_cell(cfg, n, c, args.force)) for n, c in cfg["cells"].items()]
    write_meta(cfg, archives)


if __name__ == "__main__":
    main()
