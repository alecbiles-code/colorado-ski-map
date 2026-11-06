"""Shared helpers for the routes and places pipeline: config, DuckDB, output."""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any

import duckdb
import yaml

CONFIG_PATH = Path(__file__).with_name("config.yaml")
log = logging.getLogger("routes")


def setup_logging() -> None:
    """Configure INFO-level logging to stderr."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load the pipeline YAML config.

    Args:
        path: Config file path.

    Returns:
        Parsed config dictionary.
    """
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def work_path(cfg: dict[str, Any], rel: str) -> Path:
    """Resolve a path relative to the work directory."""
    return Path(cfg["paths"]["work_dir"]) / rel


def repo_path(cfg: dict[str, Any], rel: str) -> Path:
    """Resolve a path relative to the repository root."""
    return Path(cfg["paths"]["repo_dir"]) / rel


def connect(cfg: dict[str, Any]) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB connection with the spatial extension loaded.

    Args:
        cfg: Pipeline config.

    Returns:
        DuckDB connection.
    """
    p = cfg["paths"]
    con = duckdb.connect()
    con.execute(f"SET extension_directory='{work_path(cfg, p['duckdb_extension_dir'])}'")
    tmp = work_path(cfg, p["duckdb_temp_dir"])
    tmp.mkdir(parents=True, exist_ok=True)
    con.execute(f"SET temp_directory='{tmp}'")
    con.execute(f"SET memory_limit='{p['duckdb_memory_limit']}'")
    con.execute("INSTALL spatial")
    con.execute("LOAD spatial")
    return con


def rows(con: duckdb.DuckDBPyConnection, sql: str, params: Any = None) -> list[dict[str, Any]]:
    """Run a query and return rows as dictionaries."""
    cur = con.execute(sql, params) if params else con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def utc_now() -> str:
    """Return the current UTC time as an ISO 8601 string with Z."""
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def round_coords(coords: Any, ndigits: int) -> Any:
    """Round nested GeoJSON coordinates, dropping any Z value.

    Args:
        coords: Nested coordinate lists.
        ndigits: Decimal places to keep.

    Returns:
        Coordinates with the same nesting, 2D, rounded.
    """
    if coords and isinstance(coords[0], (int, float)):
        return [round(coords[0], ndigits), round(coords[1], ndigits)]
    return [round_coords(c, ndigits) for c in coords]


def write_json(path: Path, obj: Any, compact: bool = True) -> int:
    """Write JSON to disk and return its byte size.

    Args:
        path: Destination file.
        obj: JSON-serialisable object.
        compact: Use minimal separators when True; indent otherwise.

    Returns:
        Size of the written file in bytes.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    else:
        text = json.dumps(obj, indent=2, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8")
    return path.stat().st_size


def feature_collection_bbox(features: list[dict[str, Any]]) -> list[float] | None:
    """Compute [minLon, minLat, maxLon, maxLat] over all feature coordinates."""
    xs: list[float] = []
    ys: list[float] = []

    def walk(c: Any) -> None:
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for item in c:
                walk(item)

    for f in features:
        if f.get("geometry"):
            walk(f["geometry"]["coordinates"])
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]
