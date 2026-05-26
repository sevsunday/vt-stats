"""Compare 310's .3d.json (the canonical 3D extract) with my analyze_map
pool positions. Goal: find out which one is right, or whether they agree."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
sys.path.insert(0, str(_THIS))
sys.path.insert(0, str(_THIS.parent.parent / "scripts"))

from analyze_map import analyze_map_dir  # noqa: E402

REPO = _THIS.parent.parent.parent
MAP_DIR = REPO / "_map-analysis" / "vsrmaplist" / "310"
J = REPO / "data" / "render" / "vsr310.3d.json"

with J.open("r", encoding="utf-8") as f:
    j = json.load(f)

print("=" * 60)
print("From data/render/vsr310.3d.json (the canonical 3D extract):")
print("=" * 60)
hm = j["heightmap"]
print(f"heightmap.cells_x  : {hm['cells_x']}")
print(f"heightmap.cells_z  : {hm['cells_z']}")
print(f"heightmap.src_cells_x: {hm.get('src_cells_x')}")
print(f"heightmap.src_cells_z: {hm.get('src_cells_z')}")
print(f"heightmap.cell_meters_x: {hm['cell_meters_x']}")
print(f"heightmap.cell_meters_z: {hm['cell_meters_z']}")
print(f"heightmap.world_origin : {hm['world_origin']}")
if "world_rect" in j:
    print(f"world_rect (calibrated): {j['world_rect']}")
print()

pools_3d = [o for o in j.get("objects", []) if o.get("kind") == "scrap_pool"]
spawns_3d = [o for o in j.get("objects", []) if o.get("kind") == "spawn_point"]
print(f"3d.json scrap_pool count: {len(pools_3d)}")
for p in pools_3d:
    print(f"  {p.get('obj_class', '?'):<20} world=({p['world']['x']:>7.1f}, {p['world']['z']:>7.1f})")
print()
print(f"3d.json spawn_point count: {len(spawns_3d)}")
for p in spawns_3d:
    print(f"  {p.get('obj_class', '?'):<20} world=({p['world']['x']:>7.1f}, {p['world']['z']:>7.1f})")

print()
print("=" * 60)
print("From analyze_map_dir (my BZN parse of the same map):")
print("=" * 60)
report = analyze_map_dir(MAP_DIR)
pools_bzn = [o for o in report.objects if o.kind == "scrap_pool"]
spawns_bzn = [o for o in report.objects if o.kind == "spawn_point"]
print(f"BZN scrap_pool count: {len(pools_bzn)}")
for p in pools_bzn:
    print(f"  {p.obj_class:<20} world=({p.position[0]:>7.1f}, {p.position[2]:>7.1f})")
print()
print(f"BZN spawn_point count: {len(spawns_bzn)}")
for p in spawns_bzn:
    print(f"  {p.obj_class:<20} world=({p.position[0]:>7.1f}, {p.position[2]:>7.1f})")
