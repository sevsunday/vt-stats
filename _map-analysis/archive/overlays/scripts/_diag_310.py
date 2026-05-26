"""Throwaway: dump 310's pool/spawn/scrap world positions + projected pixels.

Used to figure out whether the cyan circles ARE actually the pools
(in which case the white squares on the shellmap are something else),
or whether my projection is just wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
sys.path.insert(0, str(_THIS))
sys.path.insert(0, str(_THIS.parent.parent / "scripts"))

from analyze_map import analyze_map_dir  # noqa: E402
from terrain_bounds import derive_rect    # noqa: E402
from project import world_to_px           # noqa: E402

MAP_DIR = _THIS.parent.parent / "vsrmaplist" / "310"

report = analyze_map_dir(MAP_DIR)
rect = derive_rect(MAP_DIR)

print(f"Map dir: {MAP_DIR}")
print(f"Rect: half_extent={rect.half_extent_m:g} m  cells={rect.cells}  "
      f"m/cell={rect.m_per_cell:g}  provenance={rect.provenance}")
print()

pools = [o for o in report.objects if o.kind == "scrap_pool" and o.position is not None]
spawns = [o for o in report.objects if o.kind == "spawn_point" and o.position is not None]
scrap = [o for o in report.objects if o.kind == "loose_scrap" and o.position is not None]

print(f"Pools ({len(pools)}):")
print(f"  {'class':<22} {'world (x, z)':>20} {'pixel (px, py)':>18}")
for p in pools:
    wp = world_to_px(p.position[0], p.position[2], rect.half_extent_m, 512)
    cls = p.obj_class or "(none)"
    print(f"  {cls:<22} ({p.position[0]:>7.1f}, {p.position[2]:>7.1f}) -> "
          f"({wp.px:>4d}, {wp.py:>4d}) {'OOB' if not wp.in_bounds else ''}")

print()
print(f"Spawns ({len(spawns)}):")
for p in spawns:
    wp = world_to_px(p.position[0], p.position[2], rect.half_extent_m, 512)
    cls = p.obj_class or "(none)"
    team = p.team if p.team is not None else "-"
    print(f"  {cls:<22} ({p.position[0]:>7.1f}, {p.position[2]:>7.1f}) -> "
          f"({wp.px:>4d}, {wp.py:>4d}) team={team}")

print()
print(f"Loose scrap ({len(scrap)}): bbox = "
      f"x [{min(s.position[0] for s in scrap):.0f}, {max(s.position[0] for s in scrap):.0f}], "
      f"z [{min(s.position[2] for s in scrap):.0f}, {max(s.position[2] for s in scrap):.0f}]")

print()
print("All non-pool/non-spawn/non-scrap objects with positions (potential 'white square' candidates):")
print(f"  {'kind':<14} {'class':<24} {'world (x, z)':>20}")
others = [o for o in report.objects
          if o.kind not in ("scrap_pool", "spawn_point", "loose_scrap")
          and o.position is not None]
for o in others[:200]:
    cls = (o.obj_class or "(none)")[:24]
    print(f"  {o.kind:<14} {cls:<24} ({o.position[0]:>7.1f}, {o.position[2]:>7.1f})")
if len(others) > 200:
    print(f"  ... and {len(others) - 200} more")

print()
print("=" * 70)
print("All distinct obj_classes in this BZN (with counts + positional bbox):")
print(f"{'class':<28} {'kind':<14} {'count':>5}  {'x range':>20} {'z range':>20}")
print("-" * 100)
by_class: dict[str, list] = {}
for o in report.objects:
    if o.position is None:
        continue
    by_class.setdefault(o.obj_class or "(none)", []).append(o)
for cls in sorted(by_class):
    objs = by_class[cls]
    xs = [o.position[0] for o in objs]
    zs = [o.position[2] for o in objs]
    kind = objs[0].kind
    x_rng = f"[{min(xs):>6.0f}, {max(xs):>6.0f}]"
    z_rng = f"[{min(zs):>6.0f}, {max(zs):>6.0f}]"
    print(f"{cls:<28} {kind:<14} {len(objs):>5}  {x_rng:>20} {z_rng:>20}")
