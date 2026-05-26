"""For each smoke map: print full-ter rect (my current model) vs calibrated
world_rect (from .3d.json) vs object bbox. So we can see where the discrepancy
between '.ter rect == shellmap rect' actually leaves us."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
sys.path.insert(0, str(_THIS))
sys.path.insert(0, str(_THIS.parent.parent / "scripts"))

from analyze_map import analyze_map_dir  # noqa: E402
from terrain_bounds import derive_rect    # noqa: E402

REPO = _THIS.parent.parent.parent
RENDER_DIR = REPO / "data" / "render"

SMOKE = [
    ("chill", "Big Chill"),
    ("vsruxbridge", "Uxbridge"),
    ("vsr310", "310"),
    ("havenvsr", "Haven"),
    ("starena", "Strategy Arena"),
]

print(f"{'stem':<14} {'.ter rect (full, my current model)':<40} {'.3d.json world_rect (calibrated)':<48} {'object bbox':<32}")
print("-" * 140)

for stem, name in SMOKE:
    j_path = RENDER_DIR / f"{stem}.3d.json"
    if not j_path.exists():
        print(f"{stem:<14} (no .3d.json)")
        continue
    with j_path.open("r", encoding="utf-8") as f:
        j = json.load(f)

    my_rect = derive_rect(REPO / "_map-analysis" / "vsrmaplist" / name)
    my_str = f"[-{my_rect.half_extent_m:.0f}, +{my_rect.half_extent_m:.0f}] x [-{my_rect.half_extent_m:.0f}, +{my_rect.half_extent_m:.0f}]"

    wr = j.get("world_rect")
    if wr:
        wr_str = (f"x[{wr['min']['x']:.0f}, {wr['max']['x']:.0f}]"
                  f" z[{wr['min']['z']:.0f}, {wr['max']['z']:.0f}]")
    else:
        wr_str = "(none)"

    # Object bbox (all kinds with positions)
    rep = analyze_map_dir(REPO / "_map-analysis" / "vsrmaplist" / name)
    objs = [o for o in rep.objects if o.position is not None]
    if objs:
        xs = [o.position[0] for o in objs]
        zs = [o.position[2] for o in objs]
        bbox_str = f"x[{min(xs):.0f}, {max(xs):.0f}] z[{min(zs):.0f}, {max(zs):.0f}]"
    else:
        bbox_str = "-"

    print(f"{stem:<14} {my_str:<40} {wr_str:<48} {bbox_str:<32}")
