"""Render two diagnostic PNGs per analyzed map:

  1) <name>_layout.png   - top-down marker plot of pools / scrap / spawns / etc.
                          backed by the .TER heightmap shaded as a grayscale
                          relief (lighter = higher). Useful for visually
                          verifying that BZN positions land where they should.

  2) <name>_relief.png   - just the shaded heightmap relief (no overlays),
                          rendered as a "synthetic top-down" of the terrain.

Also outputs a small 3D-style wireframe perspective preview so we can answer
"can the terrain power a 3D wireframe?":

  3) <name>_wireframe.png - low-poly isometric line render of the heightmap.

Requires only the standard `Pillow` module (no matplotlib/numpy).

Usage:
    python render_map.py "Europa Night"
    python render_map.py "Quarry"
"""

from __future__ import annotations

import argparse
import math
import struct
import sys
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw

from analyze_map import (
    analyze_map_dir,
    GameObject,
    MapReport,
    _find_one,
    parse_trn,
)


# ---------------------------------------------------------------------------
# .TER → 2-D height grid
# ---------------------------------------------------------------------------

def load_height_grid(
    ter_path: Path, height_setting: float = 100.0
) -> tuple[list[list[float]], dict[str, float]] | None:
    """Read a .TER file and return (heights[z][x], meta).

    Layout: 16-byte header (magic 'TERR', version u32, four i16 tile bounds),
    then `cells_x * cells_z` int16 LE heights scaled by `height_setting/32767`
    to get meters. Trailer bytes (texture indices, lighting) are ignored.
    """
    raw = ter_path.read_bytes()
    if len(raw) < 32 or raw[:4] != b"TERR":
        return None
    version = int.from_bytes(raw[4:8], "little")
    tile_min_x = int.from_bytes(raw[8:10], "little", signed=True)
    tile_min_z = int.from_bytes(raw[10:12], "little", signed=True)
    tile_max_x = int.from_bytes(raw[12:14], "little", signed=True)
    tile_max_z = int.from_bytes(raw[14:16], "little", signed=True)
    cells_x = tile_max_x - tile_min_x
    cells_z = tile_max_z - tile_min_z
    if cells_x <= 0 or cells_z <= 0:
        return None
    body = raw[16:]
    cell_stride = 4
    if cells_x * cells_z * cell_stride > len(body):
        # Same clamp logic as analyze_map.parse_ter: cap cells_z to whatever
        # the body actually fits at the chosen cell stride.
        max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            cell_stride = 3
            max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            cell_stride = 2
            max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            return None
        cells_z = max_rows
    total = cells_x * cells_z
    scale = height_setting / 32767.0
    grid: list[list[float]] = []
    for z in range(cells_z):
        row: list[float] = []
        base = z * cells_x * cell_stride
        for x in range(cells_x):
            o = base + x * cell_stride
            v = int.from_bytes(body[o:o + 2], "little", signed=True)
            row.append(v * scale)
        grid.append(row)
    return grid, {
        "version": float(version),
        "tile_min_x": float(tile_min_x), "tile_min_z": float(tile_min_z),
        "tile_max_x": float(tile_max_x), "tile_max_z": float(tile_max_z),
        "cells_x": float(cells_x), "cells_z": float(cells_z),
        "height_setting": float(height_setting),
        "scale": scale,
        "cell_stride": float(cell_stride),
    }


def grid_stats(grid: Sequence[Sequence[float]]) -> tuple[float, float, float]:
    flat = [h for row in grid for h in row]
    return min(flat), max(flat), sum(flat) / len(flat)


# ---------------------------------------------------------------------------
# Shaded relief renderer (grayscale + diagonal lighting)
# ---------------------------------------------------------------------------

def render_relief(grid: Sequence[Sequence[float]], out_size: int = 768) -> Image.Image:
    cells_z = len(grid)
    cells_x = len(grid[0]) if cells_z else 0
    hmin, hmax, _ = grid_stats(grid)
    rng = max(1e-6, hmax - hmin)

    img = Image.new("RGB", (out_size, out_size), (10, 12, 18))
    px = img.load()
    sx = cells_x / out_size
    sz = cells_z / out_size

    for py in range(out_size):
        gz = int(py * sz)
        gz1 = min(gz + 1, cells_z - 1)
        for px_ in range(out_size):
            gx = int(px_ * sx)
            gx1 = min(gx + 1, cells_x - 1)
            h = grid[gz][gx]
            # Sobel-ish slope along +X / +Z for diagonal sun light
            dhx = grid[gz][gx1] - h
            dhz = grid[gz1][gx] - h
            # Sun direction = (1, 0.5) in (x, z) plane, light from above-NE
            slope = (dhx * 1.0 + dhz * 0.5) / math.sqrt(1.25)
            base = (h - hmin) / rng
            shade = max(0.0, min(1.0, 0.55 * base + 0.45 - 0.08 * slope))
            # Soft sepia-cool ramp
            r = int(40 + 200 * shade)
            g = int(50 + 195 * shade)
            b = int(60 + 180 * shade)
            px[px_, py] = (r, g, b)
    return img


# ---------------------------------------------------------------------------
# Top-down marker overlay
# ---------------------------------------------------------------------------

KIND_STYLE: dict[str, tuple[str, int, str]] = {
    # kind          fill_color    radius  label_letter
    "scrap_pool":   ("#ffd24a",       10,  "P"),
    "loose_scrap":  ("#7ee787",        3,  ""),
    "spawn_point":  ("#5dadff",       12,  "S"),
    "recycler":     ("#ff8a3d",       11,  "R"),
    "starting_unit":("#ff5577",        9,  "U"),
    "pilot":        ("#bb88ff",        6,  ""),
    "geyser":       ("#00d7c4",        9,  "G"),
    "ai_path":      ("#888888",        3,  ""),
    "marker":       ("#aaaaaa",        4,  ""),
    "mission_script":("#ff00ff",       0,  ""),  # not drawn (no position)
    "player_slot":  ("#ffffff",        7,  ""),
}


def render_layout(
    report: MapReport,
    base_relief: Image.Image | None,
    out_size: int = 1024,
) -> Image.Image:
    """Top-down marker plot.

    Coordinate system: BZ:CC uses Y as up, X is east, Z is north. We render
    +X to the right and +Z upward. The image origin (0,0) is the bottom-left
    of the play area in world coords.
    """
    # World bounds (prefer .TRN, fall back to inferred-from-objects)
    if report.terrain_bounds:
        tb = report.terrain_bounds
        min_x, max_x = tb.min_x, tb.min_x + tb.width
        min_z, max_z = tb.min_z, tb.min_z + tb.depth
    elif report.inferred_bounds_from_objects:
        ib = report.inferred_bounds_from_objects
        pad = max(ib["x_extent"], ib["z_extent"]) * 0.08 + 32
        min_x, max_x = ib["min_x"] - pad, ib["max_x"] + pad
        min_z, max_z = ib["min_z"] - pad, ib["max_z"] + pad
    else:
        min_x = min_z = -512; max_x = max_z = 512

    w = max_x - min_x
    h = max_z - min_z
    size = out_size

    if base_relief is not None:
        img = base_relief.resize((size, size)).convert("RGB")
    else:
        img = Image.new("RGB", (size, size), (24, 28, 36))
    draw = ImageDraw.Draw(img, "RGBA")

    def to_px(x: float, z: float) -> tuple[int, int]:
        u = (x - min_x) / w
        v = 1.0 - (z - min_z) / h  # flip Z so +Z is up in image
        return int(u * size), int(v * size)

    # Grid (every 256 m)
    grid_step = 256.0
    gx = math.floor(min_x / grid_step) * grid_step
    while gx <= max_x:
        x0, _ = to_px(gx, min_z)
        draw.line([(x0, 0), (x0, size)], fill=(255, 255, 255, 40), width=1)
        gx += grid_step
    gz = math.floor(min_z / grid_step) * grid_step
    while gz <= max_z:
        _, y0 = to_px(min_x, gz)
        draw.line([(0, y0), (size, y0)], fill=(255, 255, 255, 40), width=1)
        gz += grid_step

    # Origin crosshair
    ox, oy = to_px(0, 0)
    draw.line([(ox - 12, oy), (ox + 12, oy)], fill=(255, 255, 0, 200), width=1)
    draw.line([(ox, oy - 12), (ox, oy + 12)], fill=(255, 255, 0, 200), width=1)

    # Objects (draw small first, big last for proper layering)
    layer_order = [
        "ai_path", "marker", "pilot", "loose_scrap", "mission_script",
        "starting_unit", "player_slot", "recycler", "geyser", "spawn_point", "scrap_pool",
    ]
    by_kind: dict[str, list[GameObject]] = {}
    for o in report.objects:
        by_kind.setdefault(o.kind, []).append(o)
    for kind in layer_order:
        for o in by_kind.get(kind, []):
            if o.position is None:
                continue
            x, _, z = o.position
            cx, cy = to_px(x, z)
            color, radius, letter = KIND_STYLE.get(kind, ("#ffffff", 4, ""))
            if radius <= 0:
                continue
            draw.ellipse(
                [cx - radius, cy - radius, cx + radius, cy + radius],
                fill=color, outline=(0, 0, 0, 180), width=1,
            )
            if letter:
                draw.text((cx + radius + 2, cy - radius), letter, fill="#ffffff")

    # Legend
    legend_y = size - 18 * (len(layer_order) + 2)
    draw.rectangle([8, legend_y - 8, 200, size - 8], fill=(0, 0, 0, 150))
    title = report.mission_name or Path(report.map_dir).name
    draw.text((14, legend_y - 4), title, fill="#ffffff")
    for i, kind in enumerate(layer_order):
        cnt = report.object_counts_by_kind.get(kind, 0)
        if cnt == 0:
            continue
        color, radius, _ = KIND_STYLE.get(kind, ("#ffffff", 4, ""))
        ly = legend_y + 14 + i * 16
        draw.ellipse([14, ly, 14 + 8, ly + 8], fill=color, outline=(0, 0, 0, 200))
        draw.text((28, ly - 2), f"{kind} ({cnt})", fill="#dddddd")
    return img


# ---------------------------------------------------------------------------
# Wireframe (low-poly isometric)
# ---------------------------------------------------------------------------

def render_wireframe(
    grid: Sequence[Sequence[float]],
    out_w: int = 1280,
    out_h: int = 720,
    n_lines: int = 96,
) -> Image.Image:
    """Cheap parametric wireframe to demonstrate viability.

    Down-samples the heightmap to an `n_lines` x `n_lines` mesh and draws both
    +X-running and +Z-running lines in isometric projection. Vertical scale is
    auto-clipped to a sensible visual range.
    """
    cells_z = len(grid)
    cells_x = len(grid[0]) if cells_z else 0
    if cells_x == 0 or cells_z == 0:
        return Image.new("RGB", (out_w, out_h), (12, 14, 22))

    n = min(n_lines, cells_x, cells_z)
    step_x = cells_x / n
    step_z = cells_z / n
    sampled = [
        [grid[int(j * step_z)][int(i * step_x)] for i in range(n)]
        for j in range(n)
    ]
    hmin, hmax, hmean = grid_stats(sampled)
    rng = max(1e-6, hmax - hmin)

    # Isometric projection
    img = Image.new("RGB", (out_w, out_h), (10, 12, 20))
    draw = ImageDraw.Draw(img)
    # Scale so the mesh fits
    scale = min(out_w * 0.50 / n, out_h * 0.55 / n)
    vscale = scale * 1.6  # vertical exaggeration for visibility
    cx = out_w // 2
    cy = out_h // 2 + int(out_h * 0.10)

    def project(i: float, j: float, h: float) -> tuple[float, float]:
        # i: along X, j: along Z, h: terrain height
        xi = (i - n / 2) * scale
        zj = (j - n / 2) * scale
        # 30-degree iso
        px_ = cx + (xi - zj) * 0.866
        # height contribution shaded into the projection vertical
        norm_h = (h - hmin) / rng
        py_ = cy + (xi + zj) * 0.5 - norm_h * vscale
        return px_, py_

    def color_for(h: float) -> tuple[int, int, int]:
        t = (h - hmin) / rng
        return (int(60 + 180 * t), int(80 + 160 * t), int(110 + 130 * t))

    # +X-running rows
    for j in range(n):
        for i in range(n - 1):
            h0 = sampled[j][i]; h1 = sampled[j][i + 1]
            p0 = project(i, j, h0); p1 = project(i + 1, j, h1)
            draw.line([p0, p1], fill=color_for((h0 + h1) / 2), width=1)
    # +Z-running cols
    for i in range(n):
        for j in range(n - 1):
            h0 = sampled[j][i]; h1 = sampled[j + 1][i]
            p0 = project(i, j, h0); p1 = project(i, j + 1, h1)
            draw.line([p0, p1], fill=color_for((h0 + h1) / 2), width=1)

    draw.text((12, 12), f"Wireframe preview ({n}x{n}) | h={hmin:.1f}..{hmax:.1f}", fill="#dddddd")
    return img


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("map_dir")
    ap.add_argument("--out", default=None, help="Output directory (default: same as map_dir parent / `_map-analysis/renders`)")
    args = ap.parse_args(argv)

    map_dir = Path(args.map_dir)
    if not map_dir.is_dir():
        print(f"error: {map_dir} is not a directory", file=sys.stderr)
        return 2

    out_dir = Path(args.out) if args.out else (map_dir.parent / "renders")
    out_dir.mkdir(parents=True, exist_ok=True)

    report = analyze_map_dir(map_dir)
    name = map_dir.name.lower().replace(" ", "_")

    files = {p.name.lower(): p for p in map_dir.iterdir() if p.is_file()}
    ter_path = _find_one(files, ".ter")
    grid = None
    meta: dict[str, float] | None = None
    height_setting = 100.0
    if report.terrain_bounds and report.terrain_bounds.height_max_setting:
        height_setting = report.terrain_bounds.height_max_setting
    if ter_path:
        loaded = load_height_grid(ter_path, height_setting=height_setting)
        if loaded:
            grid, meta = loaded

    base_relief: Image.Image | None = None
    if grid is not None:
        # Orient the relief to match the layout view (+Z up, +X right).
        relief = render_relief(grid)
        relief = relief.transpose(Image.FLIP_TOP_BOTTOM)
        base_relief = relief
        relief_out = out_dir / f"{name}_relief.png"
        relief.save(relief_out)
        print(f"wrote {relief_out}")

    layout = render_layout(report, base_relief)
    layout_out = out_dir / f"{name}_layout.png"
    layout.save(layout_out)
    print(f"wrote {layout_out}")

    if grid is not None:
        wf = render_wireframe(grid)
        wf_out = out_dir / f"{name}_wireframe.png"
        wf.save(wf_out)
        print(f"wrote {wf_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
