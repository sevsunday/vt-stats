"""TEST HYPOTHESIS: the shellmap BMP covers the same calibrated world_rect
that the .3d.json carries. If true, projecting BZN pools onto the shellmap
using that rect should put the cyan circles on the visible pool features
(matching what we just verified works on the iondriver PNG)."""

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
OUT_DIR = REPO / "_map-analysis" / "overlays" / "_diag_shellmap_cal"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SMOKE = [
    ("chill", "Big Chill"),
    ("vsruxbridge", "Uxbridge"),
    ("vsr310", "310"),
    ("havenvsr", "Haven"),
    ("starena", "Strategy Arena"),
]


def project(x: float, z: float, rect: dict, img_w: int, img_h: int) -> tuple[int, int]:
    rx = (x - rect["min"]["x"]) / (rect["max"]["x"] - rect["min"]["x"])
    rz = (z - rect["min"]["z"]) / (rect["max"]["z"] - rect["min"]["z"])
    px = int(round(rx * img_w))
    py = int(round((1.0 - rz) * img_h))
    return px, py


for stem, name in SMOKE:
    bmp_path = REPO / "_map-analysis" / "shellmaps" / "bmps" / f"{stem}.bmp"
    j_path = REPO / "data" / "render" / f"{stem}.3d.json"
    if not bmp_path.exists() or not j_path.exists():
        print(f"{stem}: missing inputs, skipping")
        continue

    with j_path.open("r", encoding="utf-8") as f:
        j = json.load(f)
    rect = j.get("world_rect")
    if not rect:
        print(f"{stem}: no world_rect")
        continue

    img = Image.open(bmp_path).convert("RGBA")
    if img.size != (512, 512):
        img = img.resize((512, 512), Image.Resampling.LANCZOS)

    rep = analyze_map_dir(REPO / "_map-analysis" / "vsrmaplist" / name)
    pools = [o for o in rep.objects if o.kind == "scrap_pool" and o.position is not None]
    spawns = [o for o in rep.objects if o.kind == "spawn_point" and o.position is not None]

    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    for p in pools:
        px, py = project(p.position[0], p.position[2], rect, 512, 512)
        r = 8
        draw.ellipse((px - r, py - r, px + r, py + r),
                     fill=(0, 212, 255, 200),
                     outline=(255, 255, 255, 230), width=2)

    for p in spawns:
        px, py = project(p.position[0], p.position[2], rect, 512, 512)
        h = 4
        draw.rectangle((px - h, py - h, px + h, py + h),
                       fill=(255, 200, 0, 220),
                       outline=(255, 255, 255, 230), width=1)

    out = Image.alpha_composite(img, layer).convert("RGB")
    out_path = OUT_DIR / f"{stem}.png"
    out.save(out_path, format="PNG")
    rect_str = (f"x[{rect['min']['x']:.0f}, {rect['max']['x']:.0f}] "
                f"z[{rect['min']['z']:.0f}, {rect['max']['z']:.0f}]")
    print(f"{stem}: rect={rect_str}  pools={len(pools)} spawns={len(spawns)} -> {out_path.relative_to(REPO)}")
