"""Write data/render/loose_overlay.json for the map browser dots.

Coordinates match the orthographic top-down camera in
_map-analysis/render/js/viewer.js (image top = north):

    u = (x - minX) / width
    v = (maxZ - z) / depth

min/max come from the heightmap extent in data/render/<stem>.3d.json.
Loose XZ comes from _map-analysis/calibration/map_data/<stem>.json.
Not part of the match pipeline cache key.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "data" / "render"
MAP_DATA = ROOT / "_map-analysis" / "calibration" / "map_data"
OUT = RENDER / "loose_overlay.json"


def _extent(stem: str) -> tuple[float, float, float, float] | None:
    path = RENDER / f"{stem}.3d.json"
    if not path.is_file():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    hm = raw.get("heightmap") or {}
    try:
        cells_x = int(hm["cells_x"])
        cells_z = int(hm["cells_z"])
        mx = float(hm["cell_meters_x"])
        mz = float(hm["cell_meters_z"])
        origin = hm["world_origin"]
        min_x = float(origin["x"])
        min_z = float(origin["z"])
    except (KeyError, TypeError, ValueError):
        return None
    width = cells_x * mx
    depth = cells_z * mz
    if width <= 0 or depth <= 0:
        return None
    return min_x, min_z, width, depth


def _loose_points(stem: str, min_x: float, min_z: float, width: float, depth: float):
    path = MAP_DATA / f"{stem}.json"
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    max_z = min_z + depth
    points = []
    for obj in raw.get("objects") or []:
        if not isinstance(obj, dict) or obj.get("kind") != "loose_scrap":
            continue
        world = obj.get("world") or {}
        try:
            x = float(world["x"])
            z = float(world["z"])
        except (KeyError, TypeError, ValueError):
            continue
        u = (x - min_x) / width
        v = (max_z - z) / depth
        points.append([round(u, 5), round(v, 5)])
    return points


def main() -> int:
    maps = {}
    for path in sorted(RENDER.glob("*.3d.json")):
        stem = path.name[: -len(".3d.json")]
        extent = _extent(stem)
        if extent is None:
            continue
        min_x, min_z, width, depth = extent
        points = _loose_points(stem, min_x, min_z, width, depth)
        if not points:
            continue
        maps[stem] = {"points": points}
    payload = {
        "schema_version": 1,
        "frame": "topdown",
        "maps": maps,
    }
    text = json.dumps(payload, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}  maps={len(maps)}  bytes={OUT.stat().st_size}")
    oldboy = maps.get("vsroldboy")
    if oldboy:
        print(f"vsroldboy points={len(oldboy['points'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
