"""Project BZN game-object positions onto a map's existing minimap PNG.

The dashboard already ships top-down minimap thumbnails at
    data/maps/<map_file>.png      (e.g. data/maps/vsreuronig.png)
for every map in `data/map-registry.json`. These thumbnails cover the
play area declared in the `.TRN` file's `[Size]` section:

    [Size]
    MinX = -1024.0
    MinZ = -1024.0
    Width  = 2048.0
    Depth  = 2048.0

With those bounds plus the image dimensions, we can convert world
coordinates (BZ:CC: +X east, +Y up, +Z north) into image pixels:

    px = (world_x - MinX) / Width  * img_w
    py = img_h - (world_z - MinZ) / Depth * img_h   # +Z up => image-Y down

This script demonstrates the projection by overlaying the pool / spawn /
scrap markers on top of the source minimap (upscaled 8x for visibility),
then saving the result to `_map-analysis/renders/<map>_overlay.png`.

Usage:
    python overlay_on_minimap.py "Europa Night"
        --minimap ../data/maps/vsreuronig.png

If --minimap is omitted, we try to find one at:
    ../data/maps/<terrain_name>.png    (where terrain_name comes from the BZN
    header's `g_TerrainName` field, or the map dir name)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from analyze_map import analyze_map_dir, MapReport
from render_map import KIND_STYLE


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

def world_to_pixel(
    world_x: float,
    world_z: float,
    min_x: float,
    min_z: float,
    width: float,
    depth: float,
    img_w: int,
    img_h: int,
    flip_z: bool = True,
) -> tuple[float, float]:
    """BZ:CC world (X east, Z north) -> image pixels (origin top-left).

    The default `flip_z=True` matches the convention where minimaps are
    "north-up": +Z in world points up in the image, which means the image's
    Y axis (down) corresponds to -Z. Try `flip_z=False` if a particular map's
    minimap turns out to be Z-down.
    """
    px = (world_x - min_x) / width * img_w
    v = (world_z - min_z) / depth * img_h
    py = (img_h - v) if flip_z else v
    return px, py


# ---------------------------------------------------------------------------
# Renderer
# ---------------------------------------------------------------------------

def render_overlay(
    report: MapReport,
    minimap_path: Path,
    out_path: Path,
    upscale: int = 8,
    flip_z: bool = True,
    image_bounds: tuple[float, float, float, float] | None = None,
) -> None:
    """Render an overlay PNG.

    `image_bounds` (min_x, max_x, min_z, max_z) overrides the .TRN terrain
    bounds — use this to calibrate when the minimap covers a smaller world
    rectangle than the full terrain mesh (which is the common case in BZ:CC,
    where the mesh has 100-300m of dead border outside the playable area).
    The override mirrors the production system's `image_calibration.image_bounds_world`
    field in `data/maps/<mapfile>.json`.
    """
    if image_bounds is not None:
        min_x, max_x, min_z, max_z = image_bounds
        width = max_x - min_x
        depth = max_z - min_z
        bounds_source = f"override [{min_x:g}, {max_x:g}] x [{min_z:g}, {max_z:g}]"
    elif report.terrain_bounds is not None:
        tb = report.terrain_bounds
        min_x, min_z = tb.min_x, tb.min_z
        width, depth = tb.width, tb.depth
        max_x, max_z = min_x + width, min_z + depth
        bounds_source = f"terrain_bounds [{min_x:g}, {max_x:g}] x [{min_z:g}, {max_z:g}]"
    else:
        # Fallback: 5%-padded object bounding box (Quarry-style maps with no .TRN)
        ib = report.inferred_bounds_from_objects
        if ib is None:
            raise SystemExit("no .TRN, no objects with positions — nothing to project")
        x_pad = (ib["x_extent"] or 100) * 0.10
        z_pad = (ib["z_extent"] or 100) * 0.10
        min_x = ib["min_x"] - x_pad
        max_x = ib["max_x"] + x_pad
        min_z = ib["min_z"] - z_pad
        max_z = ib["max_z"] + z_pad
        width, depth = max_x - min_x, max_z - min_z
        bounds_source = f"inferred from objects (~10% pad) [{min_x:g}, {max_x:g}] x [{min_z:g}, {max_z:g}]"

    src = Image.open(minimap_path).convert("RGBA")
    img_w_src, img_h_src = src.size

    target_w = img_w_src * upscale
    target_h = img_h_src * upscale
    img = src.resize((target_w, target_h), Image.NEAREST)
    draw = ImageDraw.Draw(img, "RGBA")

    # Translucent inner border showing the exact play-area we're projecting into.
    draw.rectangle([(0, 0), (target_w - 1, target_h - 1)], outline=(255, 255, 255, 80), width=1)

    # Origin crosshair at world (0, 0)
    ox, oy = world_to_pixel(0, 0, min_x, min_z, width, depth, target_w, target_h, flip_z)
    draw.line([(ox - 14, oy), (ox + 14, oy)], fill=(255, 220, 0, 200), width=2)
    draw.line([(ox, oy - 14), (ox, oy + 14)], fill=(255, 220, 0, 200), width=2)

    # Object markers (small kinds first, big ones last so they render on top)
    layer_order = [
        "ai_path", "marker", "pilot", "loose_scrap", "mission_script",
        "starting_unit", "player_slot", "recycler", "geyser", "spawn_point", "scrap_pool",
    ]
    by_kind: dict[str, list] = {}
    for o in report.objects:
        by_kind.setdefault(o.kind, []).append(o)

    for kind in layer_order:
        for o in by_kind.get(kind, []):
            if o.position is None:
                continue
            x, _, z = o.position
            cx, cy = world_to_pixel(
                x, z, min_x, min_z, width, depth,
                target_w, target_h, flip_z,
            )
            color, radius, letter = KIND_STYLE.get(kind, ("#ffffff", 4, ""))
            if radius <= 0:
                continue
            # Scale the marker radius modestly with upscale (but cap it so
            # large maps don't get bowling-ball markers).
            r = min(int(radius * (upscale / 4.0)), 24)
            # Hollow circle so the precise projection center is visible.
            draw.ellipse(
                [cx - r, cy - r, cx + r, cy + r],
                fill=color + "55",
                outline=color, width=2,
            )
            # Tiny center dot — unambiguous "this is where the projection lands"
            draw.ellipse(
                [cx - 2, cy - 2, cx + 2, cy + 2],
                fill=(0, 0, 0, 255), outline=color, width=1,
            )
            if letter:
                draw.text((cx + r + 3, cy - r - 2), letter, fill="#ffffff")

    # Title + legend strip
    title = report.mission_name or Path(report.map_dir).name
    info_y = target_h - 22 * 8
    draw.rectangle([8, info_y - 8, 320, target_h - 8], fill=(0, 0, 0, 170))
    draw.text((14, info_y - 4), title, fill="#ffffff")
    draw.text(
        (14, info_y + 14),
        f"image_bounds_world: {bounds_source}",
        fill="#cccccc",
    )
    legend_kinds = [(k, c) for k, c in {
        "Pools": KIND_STYLE["scrap_pool"][0],
        "Spawns": KIND_STYLE["spawn_point"][0],
        "Loose scrap": KIND_STYLE["loose_scrap"][0],
        "Start unit": KIND_STYLE["starting_unit"][0],
    }.items() if any(o.kind == kind_key for kind_key in [_kind_lookup(k)] for o in report.objects)]

    for i, (label, color) in enumerate(legend_kinds):
        ly = info_y + 36 + i * 16
        draw.ellipse([14, ly, 22, ly + 8], fill=color, outline=(0, 0, 0, 200))
        cnt = sum(1 for o in report.objects if o.kind == _kind_lookup(label))
        draw.text((30, ly - 2), f"{label}: {cnt}", fill="#dddddd")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"wrote {out_path}  ({target_w}x{target_h} px)")


def _kind_lookup(label: str) -> str:
    return {
        "Pools": "scrap_pool",
        "Spawns": "spawn_point",
        "Loose scrap": "loose_scrap",
        "Start unit": "starting_unit",
    }.get(label, label.lower())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def find_minimap(report: MapReport, explicit: Path | None) -> Path | None:
    """Locate the minimap PNG for a map.

    Lookup order (best -> worst):
      1. `--minimap` override (always wins when set).
      2. **Local map folder** by terrain stem (`<map_dir>/<terrain>.png|.tga|.bmp`).
         This is the new vsrmaplist/<MapName>/ contract: each map folder
         is self-contained, so once `ingest_maps.py` has copied the image
         in, no cross-repo lookup is needed.
      3. **Local map folder** by folder name (`<map_dir>/<folder_name>.<ext>`).
      4. **Repo-wide `data/maps/`** by terrain stem - legacy backstop for
         maps that haven't been re-ingested yet or were dropped into
         test-maps/ from a different source.
    """
    if explicit:
        return explicit if explicit.exists() else None

    map_dir = Path(report.map_dir)
    candidates: list[Path] = []

    if report.terrain_name:
        for ext in (".png", ".tga", ".bmp"):
            candidates.append(map_dir / f"{report.terrain_name}{ext}")
    for ext in (".png", ".tga", ".bmp"):
        candidates.append(map_dir / f"{map_dir.name}{ext}")

    repo_root = Path(__file__).resolve().parent.parent
    if report.terrain_name:
        candidates.append(repo_root / "data" / "maps" / f"{report.terrain_name}.png")

    for c in candidates:
        if c.exists():
            return c
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("map_dir")
    ap.add_argument("--minimap", default=None, help="Override the minimap PNG path")
    ap.add_argument("--no-flip-z", action="store_true", help="Disable the +Z=>image-up flip")
    ap.add_argument("--upscale", type=int, default=8)
    ap.add_argument("--out", default=None)
    ap.add_argument(
        "--bounds",
        default=None,
        help=(
            "Override image bounds for projection. Format: 'min_x,max_x,min_z,max_z' "
            "or a single number N for symmetric +/-N (i.e. '-N,N,-N,N'). "
            "Mirrors data/maps/<map>.json's image_calibration.image_bounds_world."
        ),
    )
    args = ap.parse_args(argv)

    image_bounds: tuple[float, float, float, float] | None = None
    if args.bounds:
        parts = [p.strip() for p in args.bounds.split(",")]
        if len(parts) == 1:
            n = float(parts[0])
            image_bounds = (-n, n, -n, n)
        elif len(parts) == 4:
            image_bounds = tuple(float(p) for p in parts)  # type: ignore[assignment]
        else:
            print(f"error: --bounds expected 1 or 4 numbers, got {len(parts)}", file=sys.stderr)
            return 2

    map_dir = Path(args.map_dir)
    report = analyze_map_dir(map_dir)

    mini = find_minimap(report, Path(args.minimap) if args.minimap else None)
    if mini is None:
        print(
            "error: no minimap PNG found.\n"
            f"   tried: data/maps/{report.terrain_name}.png\n"
            f"   pass --minimap PATH to specify one explicitly.",
            file=sys.stderr,
        )
        return 2

    print(f"using minimap: {mini}  ({Image.open(mini).size[0]}x{Image.open(mini).size[1]} px)")
    out = Path(args.out) if args.out else Path("renders") / f"{map_dir.name.lower().replace(' ', '_')}_overlay.png"
    render_overlay(
        report, mini, out,
        upscale=args.upscale, flip_z=not args.no_flip_z,
        image_bounds=image_bounds,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
