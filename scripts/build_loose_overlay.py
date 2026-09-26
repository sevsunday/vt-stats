"""Write data/render/loose_overlay.json for the map browser markers.

Coordinates match the orthographic top-down camera in
_map-analysis/render/js/viewer.js (image top = north):

    u = (x - minX) / width
    v = (maxZ - z) / depth

The shot is the smallest square that contains every loose piece, team
base, and scrap pool, plus padding, so markers do not sit on the edge.
That rect is stored on each map as ``view`` and is what the camera
frames. A map with none of those objects is omitted; the camera then
frames the full heightmap.

World XZ comes from _map-analysis/calibration/map_data/<stem>.json.
Heightmap extent comes from data/render/<stem>.3d.json.
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

# Padding is applied on every side of the marker box BEFORE the box is
# squared. 18% of the longer side, and at least 80 m, so a tight cluster
# still has a visible margin. A crop that stops where the markers stop
# is not valid.
PAD_FRAC = 0.18
PAD_MIN_M = 80.0

_KINDS = {
    "loose_scrap": "loose",
    "spawn_point": "spawns",
    "scrap_pool": "pools",
}


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


def _world_points(stem: str) -> dict[str, list[tuple[float, float]]]:
    grouped = {"loose": [], "spawns": [], "pools": []}
    path = MAP_DATA / f"{stem}.json"
    if not path.is_file():
        return grouped
    raw = json.loads(path.read_text(encoding="utf-8"))
    for obj in raw.get("objects") or []:
        if not isinstance(obj, dict):
            continue
        key = _KINDS.get(obj.get("kind"))
        if not key:
            continue
        world = obj.get("world") or {}
        try:
            x = float(world["x"])
            z = float(world["z"])
        except (KeyError, TypeError, ValueError):
            continue
        grouped[key].append((x, z))
    return grouped


def _padded_square(
    points: list[tuple[float, float]],
    hm_min_x: float,
    hm_min_z: float,
    hm_w: float,
    hm_d: float,
) -> tuple[float, float, float, float]:
    """Smallest square containing every point plus padding, inside the heightmap."""
    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span = max(max_x - min_x, max_z - min_z)
    pad = max(span * PAD_FRAC, PAD_MIN_M)
    min_x -= pad
    max_x += pad
    min_z -= pad
    max_z += pad
    side = max(max_x - min_x, max_z - min_z)
    cx = (min_x + max_x) * 0.5
    cz = (min_z + max_z) * 0.5

    limit = min(hm_w, hm_d)
    if side > limit:
        side = limit
    min_x = cx - side * 0.5
    min_z = cz - side * 0.5
    if min_x < hm_min_x:
        min_x = hm_min_x
    if min_x + side > hm_min_x + hm_w:
        min_x = hm_min_x + hm_w - side
    if min_z < hm_min_z:
        min_z = hm_min_z
    if min_z + side > hm_min_z + hm_d:
        min_z = hm_min_z + hm_d - side
    return min_x, min_z, side, side


def _uv(points, min_x, min_z, width, depth):
    max_z = min_z + depth
    out = []
    for x, z in points:
        u = (x - min_x) / width
        v = (max_z - z) / depth
        out.append([round(u, 5), round(v, 5)])
    return out


def _margin(groups, min_x, min_z, width, depth) -> float:
    vals = []
    for pts in groups.values():
        for u, v in _uv(pts, min_x, min_z, width, depth):
            vals.append(min(u, v, 1.0 - u, 1.0 - v))
    return min(vals) if vals else 1.0


def main() -> int:
    maps = {}
    margins = []
    for path in sorted(RENDER.glob("*.3d.json")):
        stem = path.name[: -len(".3d.json")]
        extent = _extent(stem)
        if extent is None:
            continue
        hm_min_x, hm_min_z, hm_w, hm_d = extent
        grouped = _world_points(stem)
        flat = grouped["loose"] + grouped["spawns"] + grouped["pools"]
        if not flat:
            continue
        min_x, min_z, width, depth = _padded_square(
            flat, hm_min_x, hm_min_z, hm_w, hm_d,
        )
        entry = {
            "view": {
                "min_x": round(min_x, 2),
                "min_z": round(min_z, 2),
                "width": round(width, 2),
                "depth": round(depth, 2),
            },
        }
        # Re-project through the rounded rect so the camera and the dots match.
        vx = entry["view"]
        for key in ("loose", "spawns", "pools"):
            uv = _uv(grouped[key], vx["min_x"], vx["min_z"], vx["width"], vx["depth"])
            if uv:
                entry[key] = uv
        maps[stem] = entry
        margins.append((stem, _margin(grouped, vx["min_x"], vx["min_z"], vx["width"], vx["depth"])))

    payload = {
        "schema_version": 2,
        "frame": "topdown",
        "maps": maps,
    }
    text = json.dumps(payload, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    worst = sorted(margins, key=lambda item: item[1])[:5]
    print(f"wrote {OUT}  maps={len(maps)}  bytes={OUT.stat().st_size}")
    for stem in ("vsroldboy", "vsrscammed", "vsroverlook"):
        entry = maps.get(stem)
        if not entry:
            print(f"{stem}  missing")
            continue
        print(
            f"{stem}  loose={len(entry.get('loose') or [])}"
            f"  spawns={len(entry.get('spawns') or [])}"
            f"  pools={len(entry.get('pools') or [])}"
            f"  side={entry['view']['width']}"
        )
    print("tightest margins " + ", ".join(f"{s}:{m:.3f}" for s, m in worst))
    outside = [s for s, m in margins if m < 0]
    if outside:
        print("OUTSIDE " + ", ".join(outside))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
