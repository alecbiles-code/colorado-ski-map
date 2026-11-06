"""SNODAS decode, scaling, NoData and grid layout tests for pipeline/snow/snodas.py (synthetic small grid)."""

import copy
import datetime as dt
import gzip
import io
import math
import struct
import sys
import tarfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pipeline" / "snow"))
import snodas  # noqa: E402

CFG = snodas.load_config()
DAY = dt.date(2026, 11, 5)
N = 120
# Tiny 40 x 30 cell grid whose NW corner is (-110, 42); the bbox covers part of it.
SMALL = {"cols": 40, "rows": 30, "cells_per_degree": N, "nodata": -9999, "saturated": 32767}
BBOX = {"west": -109.9, "east": -109.75, "south": 41.85, "north": 41.95}


def header(units: str = "Meters / 1000.000000", west: str = "-110.000000000001") -> bytes:
    """Minimal NOHRSC header for the small grid, snapshot at 06:00 UTC on DAY."""
    lines = {"Description": "synthetic", "Data units": units, "Data bytes per pixel": "2", "Data slope": "1.0",
             "Data intercept": "0.0", "No data value": "-9999.00000000000", "Number of columns": "40      ",
             "Number of rows": "30      ", "Minimum x-axis coordinate": west, "Maximum y-axis coordinate": "41.9999999999990"}
    for kind in ("Start", "Stop"):
        lines.update({f"{kind} year": "2026", f"{kind} month": "11", f"{kind} day": "5 ", f"{kind} hour": "6 ",
                      f"{kind} minute": "0", f"{kind} second": "0"})
    lines.update({f"Created {p}": "1" for p in ("year", "month", "day", "hour", "minute", "second")})
    return "\n".join(f"{k}: {v}" for k, v in lines.items()).encode()


def small_cfg() -> dict:
    cfg = copy.deepcopy(CFG)
    cfg["snodas"]["grid"] = SMALL
    cfg["snodas"]["bbox"] = BBOX
    cfg["snodas"]["chunk_cells"] = 8
    return cfg


def make_tar(path: Path, depth: np.ndarray, swe: np.ndarray) -> None:
    """Tar shaped like the NSIDC archive: gzipped big-endian .dat plus gzipped .txt per variable."""
    stem = "us_ssmv1{code}tS__T0001TTNATS2026110505HP001"
    with tarfile.open(path, "w") as tf:
        for code, arr in (("1036", depth), ("1034", swe)):
            for suffix, body in ((".txt.gz", header()), (".dat.gz", arr.astype(">i2").tobytes())):
                data = gzip.compress(body)
                info = tarfile.TarInfo(stem.format(code=code) + suffix)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))


def test_decode_is_big_endian_and_unscaled() -> None:
    raw = struct.pack(">4h", 0, 1234, -9999, 32767) + b"\x00\x00" * (SMALL["rows"] * SMALL["cols"] - 4)
    arr = snodas.decode(raw, SMALL)
    assert arr[0, :4].tolist() == [0, 1234, -9999, 32767]
    # 1234 in the file is 1.234 m (scale divisor 1000), i.e. 1234 mm: the stored unit is the millimetre.
    assert arr[0, 1] / CFG["snodas"]["variables"]["snow_depth"]["scale_divisor"] == pytest.approx(1.234)


def test_decode_rejects_wrong_size() -> None:
    with pytest.raises(ValueError):
        snodas.decode(b"\x00" * 10, SMALL)


def test_header_checks() -> None:
    var = CFG["snodas"]["variables"]["snow_depth"]
    assert snodas.grid_origin(snodas.parse_header(header().decode()), var, SMALL) == (-110.0, 42.0)
    with pytest.raises(ValueError):
        snodas.grid_origin(snodas.parse_header(header(units="Meters / 100.000000").decode()), var, SMALL)
    with pytest.raises(ValueError):
        snodas.grid_origin(snodas.parse_header(header(west="-110.0004").decode()), var, SMALL)


def test_classify_keeps_zero_and_nodata_distinct() -> None:
    var = CFG["snodas"]["variables"]["snow_depth"]
    nodata_idx = len(var["colors"]) + 1
    got = snodas.classify(np.array([0, 1, 50, 51, 3001, -9999, 32767]), var, SMALL).tolist()
    assert got == [0, 1, 1, 2, len(var["colors"]), nodata_idx, nodata_idx]


def test_end_to_end_chunks_and_png(tmp_path: Path) -> None:
    cfg = small_cfg()
    depth = np.zeros((30, 40), dtype=np.int16)
    swe = np.zeros((30, 40), dtype=np.int16)
    depth[10, 15], swe[10, 15] = 1234, 321      # a snowy cell
    depth[11, 16] = swe[11, 16] = -9999         # a no-data cell next to a valid zero at [11, 15]
    make_tar(tmp_path / "s.tar", depth, swe)
    loaded = snodas.load_variables(tmp_path / "s.tar", DAY, cfg)
    assert loaded["validAt"] == "2026-11-05T06:00:00Z"
    written = snodas.write_outputs(loaded, DAY, cfg, tmp_path)
    g = written["grid"]
    assert (g["west"], g["north"], g["cols"], g["rows"]) == (pytest.approx(-109.9), pytest.approx(41.95), 18, 12)

    def sample(lon: float, lat: float) -> tuple[int, int]:
        """The browser recipe documented in docs/methods/snow-sar-incidents.md."""
        col, row = math.floor((lon - g["west"]) / g["cellDeg"]), math.floor((g["north"] - lat) / g["cellDeg"])
        r, c = row // g["chunkCells"], col // g["chunkCells"]
        buf = (tmp_path / "data" / "snow" / g["chunkUrl"].format(r=r, c=c)).read_bytes()
        assert len(buf) == g["chunkBytes"]
        return struct.unpack_from("<hh", buf, ((row % g["chunkCells"]) * g["chunkCells"] + col % g["chunkCells"]) * 4)

    centre = lambda r, c: (-110 + (c + 0.5) / N, 42 - (r + 0.5) / N)  # noqa: E731
    assert sample(*centre(10, 15)) == (1234, 321)
    assert sample(*centre(11, 16)) == (-9999, -9999)
    assert sample(*centre(11, 15)) == (0, 0)

    png = Image.open(tmp_path / "data" / "snow" / written["layers"]["snow_depth"]["url"])
    alpha = png.info["transparency"]
    assert png.mode == "P" and alpha[0] == 0 and alpha[-1] == CFG["snodas"]["nodata_rgba"][3]


def test_mercator_rows_match_source_cells() -> None:
    win = snodas.subset_window((-124.7333333333, 52.875), CFG["snodas"]["bbox"], N)
    rows, cols = snodas.mercator_index(win, N, 2)
    top, bottom = snodas.merc_y(win["north"]), snodas.merc_y(win["south"])
    # MapLibre maps the image linearly in Mercator between the corners; each pixel centre must sit in its cell.
    for i in range(0, len(rows), 37):
        m = top - (i + 0.5) * (top - bottom) / len(rows)
        lat = math.degrees(2 * math.atan(math.exp(m)) - math.pi / 2)
        assert rows[i] == math.floor((win["north"] - lat) * N)
    assert cols[0] == 0 and cols[-1] == win["cols"] - 1 and len(cols) == 2 * win["cols"]
