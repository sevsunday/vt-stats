"""Prototype: produce side-by-side comparisons that demonstrate what an
auto-generated minimap pipeline would look like, vs the current
iondriver-PNG approach.

NOTE: an earlier version of this script attempted to render minimaps
directly from `.ter` heightmap data via `render_map.load_height_grid`.
That hit a documented limitation — the .ter row layout is partially
decoded; per-cell rendering produces horizontal-stripe noise. See
`_map-analysis/README.md` "Extraction surface" section, the `.ter`
status note: "Per-cell texture/lighting bytes (2 trailing bytes per
cell) -- not yet decoded".

So instead, we use **King Just!ce's existing PPMs** as the stand-in for
the auto-render output. He generated them from .ter data using a
proper renderer (the source of which is currently in an old archive he
can't locate). The PPMs are correctly rendered, so they're an honest
preview of what a fully-working auto-render pipeline would produce.

For each demo map: we
  1. Load the iondriver PNG (current production minimap)
  2. Load King's PPM (proxy for auto-render)
  3. Crop the PPM to the same world rectangle the iondriver PNG covers
     (we know this rect from our proven PNG affine work)
  4. Overlay BZN object markers using the PNG's calibration (so markers
     in BOTH images sit at matching pixel locations)
  5. Produce a 4-image folder per map:
       01_iondriver_original.png
       02_our_render_no_overlays.png   (= cropped PPM)
       03_our_render_with_overlays.png (= cropped PPM + BZN markers)
       04_side_by_side.png             (iondriver | our render w/overlays)

Output: `_map-analysis/proof-render/`
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_map import analyze_map_dir  # noqa: E402


ROOT = Path(__file__).resolve().parent
DATA_MAPS = ROOT.parent / "data" / "maps"
VSR_DIR = ROOT / "vsrmaplist"
PPM_DIR = ROOT / "ppm"
OUT_DIR = ROOT / "proof-render"
OUT_DIR.mkdir(parents=True, exist_ok=True)


# PPMs are universally rendered at 2 meters per pixel by King's pipeline.
PPM_M_PER_PX = 2.0

# Each demo carries:
#   folder      = vsrmaplist/<folder>/ directory
#   ppm_stem    = stem to look up in _map-analysis/ppm/
#   png_stem    = stem to look up in data/maps/
#   ppm_affine  = (s_x, b_x, s_y, b_y) from the PPM magenta-fiducial solve
#                 (None if we don't have the solve for this map)
#   png_rect    = (x_min, x_max, z_min, z_max) world bounds the iondriver
#                 PNG covers, from our proven PNG-marker solve (or hand cal)
#   x_flipped, y_flipped = iondriver render orientation per our proof
#   source      = note explaining where the rect came from
DEMOS = [
    {
        "folder": "Quagmire",
        "ppm_stem": "stquagmirevsr",
        "png_stem": "stquagmirevsr",
        "png_rect": (-851, 799, -816, 822),
        "x_flipped": False, "y_flipped": False,
        "source": "PNG marker affine solve",
    },
    {
        "folder": "Strategy Arena",
        "ppm_stem": "starena",
        "png_stem": "starena",
        "png_rect": (-1004, 1021, -1071, 976),
        "x_flipped": False, "y_flipped": False,
        "source": "PPM magenta-fiducial solve",
    },
    {
        "folder": "Haven",
        "ppm_stem": "havenvsr",
        "png_stem": "havenvsr",
        "png_rect": (-1013, 1034, -1022, 1032),
        "x_flipped": False, "y_flipped": False,
        "source": "PPM magenta-fiducial solve",
    },
    {
        "folder": "Garden",
        "ppm_stem": "vsrgarden",
        "png_stem": "vsrgarden",
        "png_rect": (-991, 1056, -1052, 994),
        "x_flipped": False, "y_flipped": False,
        "source": "PPM magenta-fiducial solve",
    },
    {
        "folder": "Uxbridge",
        "ppm_stem": "vsruxbridge",
        "png_stem": "vsruxbridge",
        "png_rect": (-479, 545, -513, 511),
        "x_flipped": False, "y_flipped": False,
        "source": "PPM magenta-fiducial solve",
    },
]


def crop_ppm_to_world_rect(
    ppm: Image.Image,
    world_rect: tuple[float, float, float, float],
    out_size: int,
) -> Image.Image:
    """Crop a PPM to a target world rectangle, assuming the PPM is
    rendered at 2 m/px centered on world origin.

    BZ:CC convention: world +X is east, +Z is north. PPM image is
    +X right, +Z up (Y-flipped relative to standard image-Y-down).
    """
    pw, ph = ppm.size
    # The PPM covers world [-(pw/2)*2 .. +(pw/2)*2] x [-(ph/2)*2 .. +(ph/2)*2]
    half_w = pw * PPM_M_PER_PX / 2
    half_h = ph * PPM_M_PER_PX / 2
    full_x_min, full_x_max = -half_w, half_w
    full_z_min, full_z_max = -half_h, half_h

    wx_min, wx_max, wz_min, wz_max = world_rect

    def world_to_pix(wx: float, wz: float) -> tuple[float, float]:
        u = (wx - full_x_min) / (full_x_max - full_x_min)
        v = 1.0 - (wz - full_z_min) / (full_z_max - full_z_min)
        return u * pw, v * ph

    x0, y1 = world_to_pix(wx_min, wz_min)
    x1, y0 = world_to_pix(wx_max, wz_max)
    box = (max(0, int(round(x0))),
           max(0, int(round(y0))),
           min(pw, int(round(x1))),
           min(ph, int(round(y1))))
    cropped = ppm.crop(box).resize((out_size, out_size), Image.LANCZOS)
    return cropped


def project_world_to_pixel(
    wx: float, wz: float,
    world_rect: tuple[float, float, float, float],
    out_size: int,
    x_flipped: bool, y_flipped: bool,
) -> tuple[float, float]:
    """Project world (x, z) -> pixel coords in a `out_size` x `out_size`
    image that exactly covers `world_rect`."""
    wx_min, wx_max, wz_min, wz_max = world_rect
    u = (wx - wx_min) / (wx_max - wx_min)
    v = 1.0 - (wz - wz_min) / (wz_max - wz_min)
    if x_flipped:
        u = 1.0 - u
    if y_flipped:
        v = 1.0 - v
    return u * out_size, v * out_size


KIND_MARKER = {
    "scrap_pool":   ("#ffd24a", 7),
    "spawn_point":  ("#5dadff", 9),
    "loose_scrap":  ("#7ee787", 3),
    "starting_unit": ("#ff5577", 6),
}


def draw_overlays(
    img: Image.Image,
    report,
    world_rect: tuple[float, float, float, float],
    x_flipped: bool, y_flipped: bool,
) -> Image.Image:
    out = img.copy().convert("RGBA")
    draw = ImageDraw.Draw(out, "RGBA")
    w, h = out.size

    by_kind: dict[str, list] = {}
    for o in report.objects:
        by_kind.setdefault(o.kind, []).append(o)
    layer_order = ["loose_scrap", "starting_unit", "scrap_pool", "spawn_point"]
    for kind in layer_order:
        if kind not in KIND_MARKER:
            continue
        color, r = KIND_MARKER[kind]
        for o in by_kind.get(kind, []):
            if o.position is None:
                continue
            wx, _, wz = o.position
            px, py = project_world_to_pixel(
                wx, wz, world_rect, max(w, h),
                x_flipped, y_flipped,
            )
            if not (0 <= px < w and 0 <= py < h):
                continue
            r_, g_, b_ = (int(color[1:3], 16), int(color[3:5], 16),
                          int(color[5:7], 16))
            draw.ellipse(
                [px - r, py - r, px + r, py + r],
                fill=(r_, g_, b_, 110), outline=(r_, g_, b_, 255), width=2,
            )
            draw.ellipse([px - 1, py - 1, px + 1, py + 1],
                         fill=(0, 0, 0, 255))
    return out.convert("RGB")


def make_side_by_side(left: Image.Image, right: Image.Image,
                     left_label: str, right_label: str) -> Image.Image:
    w, h = left.size
    gap = 16
    label_h = 28
    canvas = Image.new("RGB", (w * 2 + gap, h + label_h + 8), (24, 26, 32))
    canvas.paste(left, (0, label_h))
    canvas.paste(right, (w + gap, label_h))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, w * 2 + gap, label_h - 2], fill=(16, 18, 22))
    draw.text((8, 6), left_label, fill="#ffffff")
    draw.text((w + gap + 8, 6), right_label, fill="#ffffff")
    return canvas


def render_one(demo: dict) -> dict:
    folder = demo["folder"]
    ppm_path = PPM_DIR / f"{demo['ppm_stem']}.ppm"
    png_path = DATA_MAPS / f"{demo['png_stem']}.png"
    map_dir = VSR_DIR / folder
    if not ppm_path.is_file():
        return {"folder": folder, "error": f"no PPM at {ppm_path}"}
    if not png_path.is_file():
        return {"folder": folder, "error": f"no PNG at {png_path}"}
    if not map_dir.is_dir():
        return {"folder": folder, "error": f"no map folder at {map_dir}"}

    print(f"\n=== {folder} ===")
    report = analyze_map_dir(map_dir)
    ppm = Image.open(ppm_path).convert("RGB")
    print(f"  PPM dim: {ppm.size}")

    out_size = 512
    cropped = crop_ppm_to_world_rect(ppm, demo["png_rect"], out_size=out_size)
    cropped = cropped.filter(ImageFilter.SMOOTH)

    with_overlays = draw_overlays(cropped, report, demo["png_rect"],
                                  demo["x_flipped"], demo["y_flipped"])

    iondriver = Image.open(png_path).convert("RGB").resize(
        (out_size, out_size), Image.LANCZOS,
    )

    safe = folder.lower().replace(" ", "_")
    map_out = OUT_DIR / safe
    map_out.mkdir(parents=True, exist_ok=True)

    iondriver.save(map_out / "01_iondriver_original.png")
    cropped.save(map_out / "02_our_render_no_overlays.png")
    with_overlays.save(map_out / "03_our_render_with_overlays.png")
    side_by_side = make_side_by_side(
        iondriver, with_overlays,
        "iondriver player screenshot (current)",
        "auto-render preview (proposed)",
    )
    side_by_side.save(map_out / "04_side_by_side.png")

    print(f"  -> {map_out}")
    return {"folder": folder, "out_dir": str(map_out),
            "world_rect": demo["png_rect"],
            "source": demo["source"]}


def write_readme(results: list[dict]) -> None:
    lines = [
        "# Auto-render preview",
        "",
        "**Read this first.** You're looking at 5 demo maps that compare:",
        "",
        "- **Left**: the current dashboard minimap (iondriver player screenshot, "
        "what you see today)",
        "- **Right**: an auto-generated render of the same world rectangle, "
        "with BZN pool / spawn / loose-scrap markers overlaid",
        "",
        "**Caveat about the right-hand image.** The original plan was to "
        "render the right-hand side directly from `.ter` heightmap data. That "
        "hit a known limitation - our project's .ter parser produces "
        "horizontal-stripe noise instead of clean terrain shapes (the per-cell "
        "row layout is only partially decoded). So I substituted King "
        "Just!ce's existing PPMs, which were generated by his own working "
        ".ter renderer.",
        "",
        "The right-hand image therefore demonstrates what auto-rendering "
        "WOULD deliver IF we either:",
        "  (a) reverse-engineered the rest of the .ter format and built our "
        "own renderer, OR",
        "  (b) ran King's PPM script across the full corpus and shipped its "
        "output as our minimap source.",
        "",
        "Either way, the alignment story is the same: **calibration is free "
        "by construction**, because we control the projection.",
        "",
        "## What to look at, in order",
        "",
        "Each folder has 4 images. Open them in this order:",
        "",
        "1. **`01_iondriver_original.png`** -- current dashboard minimap "
        "(upscaled from 256x256).",
        "2. **`02_our_render_no_overlays.png`** -- King's PPM cropped to the "
        "exact same world rectangle the iondriver PNG covers. Compare the "
        "**outline and playable-area shape** to image #1.",
        "3. **`03_our_render_with_overlays.png`** -- same image plus "
        "BZN-extracted pool / spawn / loose-scrap markers. These markers are "
        "guaranteed-correct by construction.",
        "4. **`04_side_by_side.png`** -- iondriver (left) vs auto-render with "
        "overlays (right), at matched scale.",
        "",
        "## Maps included",
        "",
    ]
    for r in results:
        if "error" in r:
            lines.append(f"- **{r['folder']}** -- ERROR: {r['error']}")
            continue
        rect = r["world_rect"]
        lines.append(f"- **{r['folder']}** -- world rect "
                    f"x=[{rect[0]}, {rect[1]}] z=[{rect[2]}, {rect[3]}] "
                    f"(source: {r['source']})")
    lines.append("")
    lines.append("## Key decision points")
    lines.append("")
    lines.append("Looking at each side-by-side, ask:")
    lines.append("")
    lines.append("1. **Does the playable-area outline match between left and "
                 "right?** If yes, the auto-render is geometrically aligned "
                 "to the iondriver PNG and could substitute for it.")
    lines.append("2. **Are markers landing in plausible positions?** Pools "
                 "should be on or near visible base structures, spawns near "
                 "map edges where bases sit, loose scrap in clusters.")
    lines.append("3. **Is the visual style acceptable as a dashboard backdrop?** "
                 "The PPM aesthetic is schematic / teal-on-black, not "
                 "photographic. With a real ground-texture renderer (our own "
                 ".ter parser + game-pak textures), the look could be closer "
                 "to in-game minimap aesthetic. But the question is whether "
                 "the *schematic* look is acceptable as a baseline if real "
                 "textures aren't worth the engineering investment.")
    lines.append("")
    lines.append("## If we wanted to proceed")
    lines.append("")
    lines.append("Three independent paths:")
    lines.append("")
    lines.append("- **Use King's PPMs directly**: requires getting PPMs for "
                 "the other 85 maps (we only have ~57). King would need to "
                 "re-run his generator -- or share his source so we can run "
                 "it ourselves on the missing maps.")
    lines.append("- **Reverse-engineer the rest of .ter**: a focused day or "
                 "two of staring at hex dumps + cross-referencing with the "
                 "in-game editor. Once cracked, we render all 142 maps with "
                 "no external dependencies.")
    lines.append("- **Hybrid**: use PPMs where available (57 maps free), "
                 "hand-calibrate the rest. Mixed visual style on the "
                 "dashboard but functional.")
    (OUT_DIR / "_README.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    # Clear out the old broken outputs first
    if OUT_DIR.exists():
        for child in OUT_DIR.iterdir():
            if child.is_dir():
                for f in child.iterdir():
                    f.unlink()
                child.rmdir()
            elif child.is_file():
                child.unlink()

    results = []
    for demo in DEMOS:
        r = render_one(demo)
        results.append(r)
    write_readme(results)
    print(f"\nDone. Outputs in {OUT_DIR}")
    print(f"Start by reading {OUT_DIR / '_README.md'}")


if __name__ == "__main__":
    main()
