"""Prove the 3D terrain is the engine's own meters, drawn 1:1, on every map.

Standalone and read-only; not part of the match pipeline. Run it after any
change to a `.TER`, `scripts/_ter_full.py`, `scripts/extract_3d.py` or the
committed `data/render/*.3d.json`:

    python scripts/verify_terrain_scale.py
    python scripts/verify_terrain_scale.py --stem vsroasis

Per map, against sources that do not depend on the renderer:

1. Format: the `.TER` decodes with every byte accounted for.
2. Extract: `<stem>.3d.json` heights (int16 * scale + base_offset_m) equal a
   fresh 4 x 4 box average of the `.TER` to within half a quantization step,
   with schema_version >= 4, no exaggeration field, the sample frame
   world_origin = 2 * GridMin + 3 at 8 m spacing, and the texture frame
   2 * GridMin - 1 .. 2 * GridMax - 1 (texel k centred on vertex k).
3. Engine: every recorded session on the map carries header terrain bounds
   y = [min(TER min, H), max(TER max, H)] (H = `.TRN` [Size] Height, 0 when
   absent) and x/z = 2 * GridMin .. 2 * GridMax, to 0.01 m.
4. Authoring: every BZN-placed scrap pool (a `*pool*` mesh) sits on the
   `.TER` surface, sampled at vertex k = 2 * (GridMin + k), to 0.05 m.
   Scenery is reported, not judged: authors sink rocks and palms on purpose
   (Beyond sinks all of them exactly 1 m) and stack structures over pools.
5. Builds: v4 BuildEvent positions (engine GetPosition of the built unit) are
   the TER height plus the unit's pivot: lowest >= -3 m, median 0..6 m.

Corpus-wide, the vertex frame must fit the sloped props better than any
one-vertex shift of it.

Exit code 1 when any check fails.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import statistics
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from _paths import RENDER_DATA_DIR, VSRMAPLIST_DIR  # noqa: E402
from _ter_full import (  # noqa: E402
    DOWNSAMPLE_FACTOR,
    TER_CELL_METERS,
    decode_v5_heights,
    read_trn_size_height,
)

try:
    import numpy as np
except ImportError:
    np = None

PROCESSED_DIR = ROOT / "data" / "processed"

MIN_SCHEMA_VERSION = 4
ENGINE_TOL_M = 0.011          # session headers are rounded to 0.01 m
POOL_TOL_M = 0.05
PROP_BAND_M = 2.0             # scenery further off the surface is sunk or raised on purpose
PROP_SLOPE_MIN_M = 0.05       # a row only tests the frame when shifting it moves the ground
BUILD_MIN_M = -3.0
BUILD_MEDIAN_RANGE_M = (0.0, 6.0)
FRAME_SHIFTS = ((0.0, 0.0), (TER_CELL_METERS, 0.0), (-TER_CELL_METERS, 0.0),
                (0.0, TER_CELL_METERS), (0.0, -TER_CELL_METERS))


@dataclass
class Ter:
    heights: array            # row-major float32, row 0 = GridMinZ
    w: int
    h: int
    grid: tuple[int, int, int, int]
    whole: bool               # every byte of the file consumed

    @property
    def x0(self) -> float:
        return self.grid[0] * TER_CELL_METERS

    @property
    def z0(self) -> float:
        return self.grid[1] * TER_CELL_METERS

    def height_at(self, x: float, z: float, dx: float = 0.0, dz: float = 0.0) -> float | None:
        """Bilinear height with vertex k at 2 * (GridMin + k) + (dx, dz)."""
        fx = (x - self.x0 - dx) / TER_CELL_METERS
        fz = (z - self.z0 - dz) / TER_CELL_METERS
        ix = math.floor(fx)
        iz = math.floor(fz)
        if ix < 0 or iz < 0 or ix >= self.w - 1 or iz >= self.h - 1:
            return None
        tx = fx - ix
        tz = fz - iz
        a = self.heights
        i = iz * self.w + ix
        return ((a[i] * (1 - tx) + a[i + 1] * tx) * (1 - tz)
                + (a[i + self.w] * (1 - tx) + a[i + self.w + 1] * tx) * tz)


def _first(folder: Path, *patterns: str) -> Path | None:
    for pattern in patterns:
        for p in sorted(folder.glob(pattern)):
            return p
    return None


def discover_maps() -> dict[str, tuple[Path | None, Path | None]]:
    """BZN stem (lowercase) -> (.TER, .TRN) for every ingested map folder."""
    out: dict[str, tuple[Path | None, Path | None]] = {}
    if not VSRMAPLIST_DIR.is_dir():
        return out
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        bzn = _first(folder, "*.bzn", "*.BZN")
        if bzn is None:
            continue
        out[bzn.stem.lower()] = (_first(folder, "*.TER", "*.ter"), _first(folder, "*.TRN", "*.trn"))
    return out


def load_ter(path: Path) -> Ter:
    raw = path.read_bytes()
    heights, w, h, grid, used = decode_v5_heights(raw)
    return Ter(heights, w, h, grid, used == len(raw))


def sessions_by_stem() -> dict[str, list[str]]:
    manifest = PROCESSED_DIR / "matches.json"
    if not manifest.is_file():
        return {}
    out: dict[str, list[str]] = {}
    for entry in json.loads(manifest.read_text(encoding="utf-8")):
        stem = str(entry.get("map") or "").lower()
        if stem.endswith(".bzn"):
            stem = stem[:-4]
        if stem and entry.get("id"):
            out.setdefault(stem, []).append(entry["id"])
    return out


def load_session_terrain(match_id: str) -> tuple[dict | None, list[dict]]:
    """(header terrain bounds, BUILD positions) from one processed match."""
    path = PROCESSED_DIR / f"{match_id}.json"
    if not path.is_file():
        return None, []
    doc = json.loads(path.read_text(encoding="utf-8"))
    bounds = (doc.get("match") or {}).get("terrain_bounds")
    feed = (doc.get("builds") or {}).get("feed") or []
    positions = [row["position"] for row in feed if isinstance(row.get("position"), dict)]
    return bounds, positions


def _box_means(ter: Ter, f: int) -> list[float]:
    """Row-major means of every f x f block of source vertices."""
    if np is not None:
        a = np.frombuffer(ter.heights, dtype=np.float32).astype(np.float64)
        return a.reshape(ter.h // f, f, ter.w // f, f).mean(axis=(1, 3)).ravel().tolist()
    out_w = ter.w // f
    sums = [0.0] * (out_w * (ter.h // f))
    for z in range(ter.h - ter.h % f):
        row = ter.heights[z * ter.w:(z + 1) * ter.w]
        base = (z // f) * out_w
        for x in range(out_w * f):
            sums[base + x // f] += row[x]
    inv = 1.0 / (f * f)
    return [s * inv for s in sums]


def check_extract(stem: str, ter: Ter) -> tuple[list[str], str]:
    path = RENDER_DATA_DIR / f"{stem}.3d.json"
    if not path.is_file():
        return [f"missing {path.name}"], ""
    doc = json.loads(path.read_text(encoding="utf-8"))
    problems: list[str] = []
    if (doc.get("schema_version") or 0) < MIN_SCHEMA_VERSION:
        problems.append(f"schema_version {doc.get('schema_version')} < {MIN_SCHEMA_VERSION}")
    if "default_exaggeration" in (doc.get("defaults") or {}):
        problems.append("defaults.default_exaggeration is present")

    f = DOWNSAMPLE_FACTOR
    hm = doc.get("heightmap") or {}
    cells = (hm.get("cells_x"), hm.get("cells_z"))
    if cells != (ter.w // f, ter.h // f):
        problems.append(f"cells {cells} != {(ter.w // f, ter.h // f)}")
        return problems, ""
    spacing = TER_CELL_METERS * f
    if hm.get("cell_meters_x") != spacing or hm.get("cell_meters_z") != spacing:
        problems.append(f"cell_meters {hm.get('cell_meters_x')}x{hm.get('cell_meters_z')} != {spacing:g}")
    lead = TER_CELL_METERS * (f - 1) / 2.0
    origin = hm.get("world_origin") or {}
    want_origin = (ter.x0 + lead, ter.z0 + lead)
    if (origin.get("x"), origin.get("z")) != want_origin:
        problems.append(f"world_origin ({origin.get('x')}, {origin.get('z')}) != {want_origin}")
    tc = doc.get("tile_composite")
    if tc:
        half = TER_CELL_METERS / 2.0
        want_min = {"x": ter.x0 - half, "z": ter.z0 - half}
        want_max = {"x": ter.x0 - half + TER_CELL_METERS * ter.w,
                    "z": ter.z0 - half + TER_CELL_METERS * ter.h}
        if tc.get("world_min") != want_min or tc.get("world_max") != want_max:
            problems.append(f"tile_composite frame {tc.get('world_min')}..{tc.get('world_max')} "
                            f"!= {want_min}..{want_max}")

    q = array("h")
    q.frombytes(base64.b64decode(hm.get("data") or ""))
    if sys.byteorder == "big":
        q.byteswap()
    fresh = _box_means(ter, f)
    if len(q) != len(fresh):
        problems.append(f"heightmap has {len(q)} samples, expected {len(fresh)}")
        return problems, ""
    scale = float(hm.get("scale") or 0.0)
    base = float(hm.get("base_offset_m") or 0.0)
    worst = max(abs(v * scale + base - want) for v, want in zip(q, fresh))
    if worst > scale / 2.0 + 1e-6:
        problems.append(f"heights off by {worst:.4f} m (step {scale:.5f} m)")
    lo, hi = min(fresh), max(fresh)
    if abs(hm.get("height_min_m", lo) - lo) > 1e-6 or abs(hm.get("height_max_m", hi) - hi) > 1e-6:
        problems.append(f"height range {hm.get('height_min_m')}..{hm.get('height_max_m')} "
                        f"!= {lo:.3f}..{hi:.3f}")
    return problems, f"extract err {worst:.4f} m"


def check_engine(ter: Ter, trn_height: float | None, sessions: list[tuple[str, dict]]) -> tuple[list[str], str]:
    if not sessions:
        return [], "engine n/a"
    h = 0.0 if trn_height is None else trn_height
    ter_min, ter_max = min(ter.heights), max(ter.heights)
    want_y = (min(ter_min, h), max(ter_max, h))
    want_xz = (ter.x0, ter.x0 + TER_CELL_METERS * ter.w, ter.z0, ter.z0 + TER_CELL_METERS * ter.h)
    problems = []
    for match_id, tb in sessions:
        got_y = (tb["min"]["y"], tb["max"]["y"])
        got_xz = (tb["min"]["x"], tb["max"]["x"], tb["min"]["z"], tb["max"]["z"])
        if any(abs(g - w) > ENGINE_TOL_M for g, w in zip(got_y, want_y)):
            problems.append(f"{match_id}: engine y {got_y} != {tuple(round(v, 2) for v in want_y)}")
        if any(abs(g - w) > ENGINE_TOL_M for g, w in zip(got_xz, want_xz)):
            problems.append(f"{match_id}: engine x/z {got_xz} != {want_xz}")
    return problems, f"engine {len(sessions) - len(problems)}/{len(sessions)}"


def check_props(stem: str, ter: Ter, sloped: list[tuple[float, ...]]) -> tuple[list[str], str]:
    """Pools must sit on the TER. Sloped near-surface rows go to `sloped` as
    |y - TER| under each of FRAME_SHIFTS for the corpus-wide frame test."""
    path = RENDER_DATA_DIR / f"{stem}.props.json"
    if not path.is_file():
        return [], "props n/a"
    rows = json.loads(path.read_text(encoding="utf-8")).get("props") or []

    near = []
    for r in rows:
        resid = [ter.height_at(r["x"], r["z"], dx, dz) for dx, dz in FRAME_SHIFTS]
        if any(g is None for g in resid):
            continue
        resid = [abs(r["y"] - g) for g in resid]
        if resid[0] > PROP_BAND_M:
            continue
        near.append(resid[0])
        if max(resid) - min(resid) >= PROP_SLOPE_MIN_M:
            sloped.append(tuple(resid))

    problems = []
    pool_err = []
    for r in rows:
        if "pool" not in str(r.get("stem") or "").lower():
            continue
        g = ter.height_at(r["x"], r["z"])
        if g is not None:
            pool_err.append(abs(r["y"] - g))
    if pool_err and max(pool_err) > POOL_TOL_M:
        problems.append(f"a scrap pool sits {max(pool_err):.3f} m off the TER surface")
    pools_note = f"pools {len(pool_err)} max {max(pool_err):.3f} m" if pool_err else "pools n/a"
    scenery_note = f"scenery med {statistics.median(near):.2f} m" if near else "scenery n/a"
    return problems, f"{pools_note}  {scenery_note}"


def check_frame(sloped: list[tuple[float, ...]]) -> tuple[list[str], str]:
    if not sloped:
        return [], "frame n/a"
    medians = [statistics.median(r[i] for r in sloped) for i in range(len(FRAME_SHIFTS))]
    problems = []
    for (dx, dz), m in zip(FRAME_SHIFTS[1:], medians[1:]):
        if m <= medians[0]:
            problems.append(f"shifting the vertex frame by ({dx:g}, {dz:g}) m fits props as well "
                            f"({m:.3f} <= {medians[0]:.3f} m)")
    shifts = ", ".join(f"{m:.3f}" for m in medians[1:])
    return problems, f"{len(sloped)} sloped props: median |y - TER| {medians[0]:.3f} m vs {shifts} m shifted"


def check_builds(ter: Ter, positions: list[dict]) -> tuple[list[str], str]:
    resid = []
    for p in positions:
        g = ter.height_at(p["x"], p["z"])
        if g is not None:
            resid.append(p["y"] - g)
    if not resid:
        return [], "builds n/a"
    med = statistics.median(resid)
    low = min(resid)
    problems = []
    if low < BUILD_MIN_M:
        problems.append(f"a built unit sits {low:.2f} m under the TER")
    if not BUILD_MEDIAN_RANGE_M[0] <= med <= BUILD_MEDIAN_RANGE_M[1]:
        problems.append(f"built units sit a median {med:.2f} m off the TER")
    return problems, f"builds {len(resid)} med {med:.2f} m"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stem", action="append", help="check only these map stems (repeatable)")
    args = ap.parse_args(argv)

    maps = discover_maps()
    sessions = sessions_by_stem()
    wanted = sorted({s.lower() for s in args.stem} if args.stem else set(maps) | set(sessions))

    failed = 0
    skipped = 0
    sloped: list[tuple[float, ...]] = []
    for stem in wanted:
        ter_path, trn_path = maps.get(stem, (None, None))
        if ter_path is None:
            skipped += 1
            n = len(sessions.get(stem, []))
            print(f"SKIP {stem:<20s} no .TER in {VSRMAPLIST_DIR.name}/ ({n} recorded sessions)")
            continue
        ter = load_ter(ter_path)
        problems = [] if ter.whole else [f"{ter_path.name} has bytes the decoder did not consume"]

        recorded = []
        positions = []
        for match_id in sessions.get(stem, []):
            bounds, built = load_session_terrain(match_id)
            if bounds:
                recorded.append((match_id, bounds))
            positions.extend(built)

        notes = []
        for check in (
            lambda: check_extract(stem, ter),
            lambda: check_engine(ter, read_trn_size_height(trn_path), recorded),
            lambda: check_props(stem, ter, sloped),
            lambda: check_builds(ter, positions),
        ):
            found, note = check()
            problems.extend(found)
            if note:
                notes.append(note)

        status = "FAIL" if problems else "OK  "
        print(f"{status} {stem:<20s} {ter.w}x{ter.h}  " + "  ".join(notes))
        for p in problems:
            print(f"       - {p}")
        failed += bool(problems)

    frame_problems, frame_note = check_frame(sloped)
    print(f"\n{'FAIL' if frame_problems else 'OK  '} vertex frame: {frame_note}")
    for p in frame_problems:
        print(f"       - {p}")
    checked = len(wanted) - skipped
    print(f"{checked - failed}/{checked} maps pass, {failed} fail, {skipped} skipped (no .TER)")
    return 1 if failed or frame_problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
