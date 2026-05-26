"""Render BZN pool / spawn positions onto the data/maps/<stem>.png iondriver
minimap using the CALIBRATED world_rect from data/render/<stem>.3d.json.

If the cyan circles land on the visible yellow pool dots, my projection logic
is sound and I just need to figure out the correct rect for the SHELLMAP BMP.

Output: _map-analysis/overlays/_diag_iondriver/<stem>.composite.png
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

_THIS = Path(__file__).resolve().parent
sys.path.insert(0, str(_THIS))
sys.path.insert(0, str(_THIS.parent.parent / "scripts"))

from analyze_map import analyze_map_dir  # noqa: E402

REPO = _THIS.parent.parent.parent
OUT_DIR = REPO / "_map-analysis" / "overlays" / "_diag_iondriver"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# (stem, map_dir_name)
SMOKE = [
    ("chill", "Big Chill"),
    ("vsruxbridge", "Uxbridge"),
    ("vsr310", "310"),
    ("havenvsr", "Haven"),
    ("starena", "Strategy Arena"),
]


def project(x: float, z: float, rect: dict, img_w: int, img_h: int) -> tuple[int, int]:
    """Project world (x, z) onto an image of size (img_w, img_h) where the
    image covers world rect `{min: {x,z}, max: {x,z}}`. Returns (px, py)."""
    rx = (x - rect["min"]["x"]) / (rect["max"]["x"] - rect["min"]["x"])
    rz = (z - rect["min"]["z"]) / (rect["max"]["z"] - rect["min"]["z"])
    px = int(round(rx * img_w))
    py = int(round((1.0 - rz) * img_h))  # +Z = up on image
    return px, py


for stem, name in SMOKE:
    j_path = REPO / "data" / "render" / f"{stem}.3d.json"
    png_path = REPO / "data" / "maps" / f"{stem}.png"
    if not j_path.exists():
        print(f"{stem}: no .3d.json, skipping")
        continue
    if not png_path.exists():
        print(f"{stem}: no iondriver PNG, skipping")
        continue

    with j_path.open("r", encoding="utf-8") as f:
        j = json.load(f)
    rect = j.get("world_rect")
    if not rect:
        print(f"{stem}: no world_rect in .3d.json, skipping")
        continue

    img = Image.open(png_path).convert("RGBA")
    # Scale up to 512 for visibility
    scale = max(1, 512 // max(img.size))
    target_w, target_h = img.size[0] * scale, img.size[1] * scale
    img = img.resize((target_w, target_h), Image.Resampling.NEAREST)

    rep = analyze_map_dir(REPO / "_map-analysis" / "vsrmaplist" / name)
    pools = [o for o in rep.objects if o.kind == "scrap_pool" and o.position is not None]
    spawns = [o for o in rep.objects if o.kind == "spawn_point" and o.position is not None]

    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    for p in pools:
        px, py = project(p.position[0], p.position[2], rect, target_w, target_h)
        r = 8
        draw.ellipse((px - r, py - r, px + r, py + r),
                     fill=(0, 212, 255, 200),
                     outline=(255, 255, 255, 230), width=2)

    for p in spawns:
        px, py = project(p.position[0], p.position[2], rect, target_w, target_h)
        h = 4
        draw.rectangle((px - h, py - h, px + h, py + h),
                       fill=(255, 200, 0, 220),
                       outline=(255, 255, 255, 230), width=1)

    out = Image.alpha_composite(img, layer).convert("RGB")
    out_path = OUT_DIR / f"{stem}.png"
    out.save(out_path, format="PNG")
    print(f"{stem}: {len(pools)} pools, {len(spawns)} spawns -> {out_path.relative_to(REPO)}")
