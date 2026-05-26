"""Quick corpus coverage report: how many .3d.json files have world_rect,
and which shellmap BMPs are missing a matching .3d.json."""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent.parent
RENDER_DIR = REPO / "data" / "render"
BMP_DIR = REPO / "_map-analysis" / "shellmaps" / "bmps"

j_files = sorted(RENDER_DIR.glob("*.3d.json"))
total = len(j_files)
with_rect = 0
no_rect = []
for jp in j_files:
    with jp.open("r", encoding="utf-8") as f:
        j = json.load(f)
    wr = j.get("world_rect")
    if wr and "min" in wr and "max" in wr:
        with_rect += 1
    else:
        no_rect.append(jp.stem.replace(".3d", ""))

bmps = sorted(p.stem.lower() for p in BMP_DIR.glob("*.bmp"))
jstems = set(p.stem.replace(".3d", "").lower() for p in j_files)
bmps_without_json = [b for b in bmps if b not in jstems]

print(f"Total .3d.json files:                   {total}")
print(f"  with world_rect:                      {with_rect}")
print(f"  without world_rect:                   {len(no_rect)}")
if no_rect:
    print(f"  -> {', '.join(no_rect[:20])}{' ...' if len(no_rect) > 20 else ''}")
print()
print(f"Total shellmap BMPs:                    {len(bmps)}")
print(f"  matching .3d.json:                    {len(bmps) - len(bmps_without_json)}")
print(f"  shellmap BMPs without .3d.json:       {len(bmps_without_json)}")
if bmps_without_json:
    print(f"  -> {', '.join(bmps_without_json[:20])}{' ...' if len(bmps_without_json) > 20 else ''}")
