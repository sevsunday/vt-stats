"""Throwaway: list every ODF in data/odf.min.json with 'pool' in its name,
and report which BZNs reference each one."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve().parent
sys.path.insert(0, str(_THIS))
sys.path.insert(0, str(_THIS.parent.parent / "scripts"))

from analyze_map import analyze_map_dir  # noqa: E402

REPO = _THIS.parent.parent.parent
DB_PATH = REPO / "data" / "odf.min.json"

with DB_PATH.open("r", encoding="utf-8") as f:
    db = json.load(f)

print("All ODFs in db with 'pool' in name:")
print(f"  {'odf':<24} {'classLabel':<22} {'unitName':<30}")
for k in sorted(k for k in db if "pool" in k.lower()):
    e = db[k]
    cl = e.get("classLabel") or "-"
    un = e.get("unitName") or "-"
    print(f"  {k:<24} {cl:<22} {un:<30}")
print()

print("Per-class summary across 310 vs Big Chill vs Mountain Top (all 'pool' BZN-occurrences):")
for map_dir_name in ["310", "Big Chill", "Mountain Top", "Uxbridge", "Strategy Arena"]:
    map_dir = REPO / "_map-analysis" / "vsrmaplist" / map_dir_name
    if not map_dir.is_dir():
        continue
    report = analyze_map_dir(map_dir)
    pool_objs = [o for o in report.objects
                 if o.position is not None and "pool" in (o.obj_class or "").lower()]
    print(f"  {map_dir_name}:")
    by_class: dict[str, list] = {}
    for o in pool_objs:
        by_class.setdefault(o.obj_class, []).append(o)
    for cls in sorted(by_class):
        objs = by_class[cls]
        xs = [o.position[0] for o in objs]
        zs = [o.position[2] for o in objs]
        print(f"    {cls:<22} count={len(objs):>2}  "
              f"x[{min(xs):>5.0f}, {max(xs):>5.0f}]  z[{min(zs):>5.0f}, {max(zs):>5.0f}]")
