"""Build a 2x2 calibration comparison sheet.

Renders the same map at 4 different `image_bounds_world` calibrations onto
a single PNG so the user can pick the best fit by eye.

Usage:
    python compare_calibrations.py "Europa Night"

Modify CANDIDATES below to try different shifts.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from analyze_map import analyze_map_dir
from overlay_on_minimap import render_overlay, find_minimap


# (label, image_bounds tuple or None for default)
CANDIDATES: list[tuple[str, tuple[float, float, float, float] | None]] = [
    ("symmetric +/-600 (centered)", (-600, 600, -600, 600)),
    ("shift +12,-12 (small NE)",    (-612, 588, -588, 612)),
    ("shift +20,-20 (medium NE)",   (-620, 580, -580, 620)),
    ("shift +35,-23 (large NE)",    (-635, 565, -577, 623)),
]


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python compare_calibrations.py <map_dir>", file=sys.stderr)
        return 2
    map_dir = Path(argv[0])
    report = analyze_map_dir(map_dir)
    mini = find_minimap(report, None)
    if mini is None:
        print(f"error: no minimap PNG found for {map_dir}", file=sys.stderr)
        return 2

    # Render each candidate to a temp PNG (in memory via Pillow)
    temp_dir = Path("renders/_calibration_temp")
    temp_dir.mkdir(parents=True, exist_ok=True)
    panels: list[tuple[str, Image.Image]] = []
    for label, bounds in CANDIDATES:
        out = temp_dir / f"_panel_{label.replace(' ', '_').replace(',', '').replace('/', '_')}.png"
        render_overlay(report, mini, out, upscale=8, flip_z=True, image_bounds=bounds)
        panels.append((label, Image.open(out).convert("RGBA")))

    # Compose 2x2 grid
    panel_w, panel_h = panels[0][1].size
    GUTTER = 16
    HEADER = 36
    sheet_w = panel_w * 2 + GUTTER
    sheet_h = (panel_h + HEADER) * 2 + GUTTER
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (24, 24, 32, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except Exception:
        font = ImageFont.load_default()

    for i, (label, im) in enumerate(panels):
        col = i % 2
        row = i // 2
        x = col * (panel_w + GUTTER)
        y = row * (panel_h + HEADER + GUTTER)
        draw.text((x + 8, y + 4), label, fill=(230, 230, 230, 255), font=font)
        sheet.paste(im, (x, y + HEADER))

    out_path = Path("renders") / f"{map_dir.name.lower().replace(' ', '_')}_calibration_grid.png"
    sheet.save(out_path)
    print(f"wrote {out_path}  ({sheet_w}x{sheet_h} px, 4 candidates)")

    for p in temp_dir.glob("*.png"):
        p.unlink()
    try:
        temp_dir.rmdir()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
