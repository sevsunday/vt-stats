"""Scenery and pool-mesh sidecars for the 3D map viewer and the replay.

Standalone. Not invoked by process_stats.py, and it does not rewrite the
heightmap `*.3d.json` files.

Each map's `.bzn` names the placed palms, rocks, ruins, and the exact pool
ODF (`bepool01`, `uepool01`, ...). This writes `data/render/<stem>.props.json`
for every ingested map: one row per object that has a position and a mesh in
`data/models/index.json`. Spawns, loose scrap, recyclers, and path nodes are
left out.

    python scripts/extract_props.py
    python scripts/extract_props.py --stem vsroasis
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))

from _paths import RENDER_DATA_DIR, VSRMAPLIST_DIR  # noqa: E402
from analyze_map import analyze_map_dir  # noqa: E402

SCHEMA_VERSION = 1
MODELS_INDEX = ROOT / "data" / "models" / "index.json"

# Gameplay markers and path nodes. Pool meshes are NOT in this set: the BZN
# class is the model (`bepool01`), and the orange/yellow markers stay separate.
_SKIP_KIND = {
    "spawn_point",
    "loose_scrap",
    "recycler",
    "starting_unit",
    "ai_path",
    "marker",
    "mission_script",
    "player_slot",
    "pilot",
}
_SKIP_CLASS = re.compile(r"^(spawn$|aipath|vsrpth)", re.IGNORECASE)


def _odf_index() -> dict[str, str]:
    raw = json.loads(MODELS_INDEX.read_text(encoding="utf-8"))
    index = raw.get("odf_index") or {}
    return {str(k).lower(): str(v) for k, v in index.items()}


def _stem_for(obj_class: str, index: dict[str, str]) -> str | None:
    key = obj_class.strip().lower()
    if key.endswith(".odf"):
        return index.get(key)
    return index.get(key + ".odf")


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def _props_for_map(map_dir: Path, index: dict[str, str]) -> list[dict]:
    report = analyze_map_dir(map_dir)
    rows: list[dict] = []
    for obj in report.objects:
        if obj.kind in _SKIP_KIND:
            continue
        if _SKIP_CLASS.match(obj.obj_class or ""):
            continue
        if obj.position is None:
            continue
        x, y, z = obj.position
        if not (_finite(x) and _finite(y) and _finite(z)):
            continue
        stem = _stem_for(obj.obj_class, index)
        if not stem:
            continue
        yaw = obj.yaw if _finite(obj.yaw) else 0.0
        rows.append({
            "stem": stem,
            "x": round(float(x), 2),
            "y": round(float(y), 2),
            "z": round(float(z), 2),
            "yaw": round(math.degrees(yaw), 2),
        })
    return rows


def _iter_maps(only: str | None):
    if not VSRMAPLIST_DIR.is_dir():
        return
    seen = set()
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        key = str(folder.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        if not bzns:
            continue
        stem = bzns[0].stem.lower()
        if only and stem != only:
            continue
        yield stem, folder


def extract(only: str | None) -> int:
    if not MODELS_INDEX.is_file():
        print(f"missing {MODELS_INDEX}")
        return 1
    index = _odf_index()
    RENDER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    placed = 0
    for stem, folder in _iter_maps(only):
        rows = _props_for_map(folder, index)
        doc = {
            "schema_version": SCHEMA_VERSION,
            "map_stem": stem,
            "props": rows,
        }
        out = RENDER_DATA_DIR / f"{stem}.props.json"
        out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        written += 1
        placed += len(rows)
    print(f"wrote {written} prop sidecars, {placed} placements")
    return 0 if written else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract map scenery and pool meshes")
    ap.add_argument("--stem", default=None, help="one map stem (bzn filename)")
    args = ap.parse_args()
    only = args.stem.lower() if args.stem else None
    raise SystemExit(extract(only))


if __name__ == "__main__":
    main()
