"""Extract one map's 3D-render JSON.

Reads from existing pipeline artifacts:
  - vsrmaplist/<MapName>/<stem>.{bzn, TER, WAT, SKY, TRN, inf, des}
  - _map-analysis/calibration/configs/<stem>.config.json   (calibrated world_rect)
  - _map-analysis/calibration/map_data/<stem>.json         (BZN-derived objects)
  - data/maps/<stem>.png                            (calibrated minimap)

Emits:
  - _map-analysis/render/data/<stem>.3d.json

The output JSON is consumed by `render/js/loader.js`. See the README in
`render/` for the schema and rendering contract.

CLI:
    python _map-analysis/render/scripts/extract_3d.py vsreuronig
    python _map-analysis/render/scripts/extract_3d.py vsreuronig --out custom.json
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

# Allow imports from sibling render/scripts/ and from _map-analysis/scripts/.
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))
sys.path.insert(0, str(THIS_DIR.parent.parent / "scripts"))

from _ter_full import parse_ter_full, read_trn_height_setting  # noqa: E402
from _wat_sky import (  # noqa: E402
    parse_wat_header,
    parse_sky_header,
    parse_trn_lighting,
    parse_trn_tile_textures,
)

# From _map-analysis/scripts/
from _paths import (  # noqa: E402
    VSRMAPLIST_DIR,
    DATA_MAPS_DIR,
)
from _schema import (  # noqa: E402
    load_config,
    load_map_data,
)


RENDER_DATA_DIR = THIS_DIR.parent / "data"

# Object kinds that get rendered as primitives in the viewer. Everything
# else (ai_path, marker, mission_script, etc.) is skipped.
RENDERED_KINDS = {
    "scrap_pool",
    "spawn_point",
    "loose_scrap",
    "recycler",
    "starting_unit",
}


def find_map_dir(stem: str) -> Path | None:
    """Walk vsrmaplist/ and return the folder whose .bzn stem matches."""
    if not VSRMAPLIST_DIR.is_dir():
        return None
    stem_lc = stem.lower()
    for folder in sorted(VSRMAPLIST_DIR.iterdir(),
                         key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        for b in bzns:
            if b.stem.lower() == stem_lc:
                return folder
    return None


def find_first_file(map_dir: Path, *patterns: str) -> Path | None:
    for pat in patterns:
        for p in map_dir.glob(pat):
            return p
    return None


# read_trn_height_setting moved to _ter_full.py (now the single source).


def build_objects(stem: str) -> tuple[list[dict], str]:
    """Pull objects from calibration/map_data/<stem>.json (BZN-derived list with
    UIDs). Returns (objects, map_name).

    Filters to RENDERED_KINDS only, attaches a default y of 0 because
    the dashboard's per-object world coords are flat (the viewer samples
    terrain height anyway).
    """
    md = load_map_data(stem)
    if md is None:
        return [], stem
    objs_out: list[dict] = []
    for obj in (md.get("objects") or []):
        kind = obj.get("kind")
        if kind not in RENDERED_KINDS:
            continue
        w = obj.get("world") or {}
        objs_out.append({
            "uid": obj.get("uid"),
            "kind": kind,
            "obj_class": obj.get("obj_class"),
            "world": {
                "x": float(w.get("x") or 0.0),
                "z": float(w.get("z") or 0.0),
                # We don't carry y in map_data; viewer samples terrain.
            },
        })
    return objs_out, (md.get("map_name") or stem)


def build_output(stem: str) -> dict:
    map_dir = find_map_dir(stem)
    if map_dir is None:
        raise FileNotFoundError(
            f"no vsrmaplist/ folder for stem {stem!r}; run ingest_maps.py first"
        )

    ter_path = find_first_file(map_dir, "*.TER", "*.ter")
    wat_path = find_first_file(map_dir, "*.WAT", "*.wat")
    sky_path = find_first_file(map_dir, "*.SKY", "*.sky")
    trn_path = find_first_file(map_dir, "*.TRN", "*.trn")

    if ter_path is None:
        raise FileNotFoundError(f"no .TER in {map_dir}")

    height_setting = read_trn_height_setting(trn_path)
    # Keep the .TER metadata (tile bounds, version) but don't trust its
    # height bytes -- the format is partially undecoded (see render/README.md
    # "Notes / known limitations"). We synthesize a low-amplitude heightmap
    # from the minimap PNG instead.
    ter = parse_ter_full(ter_path, height_setting)
    if ter is None:
        raise RuntimeError(f"failed to parse {ter_path}")

    wat = parse_wat_header(wat_path) if wat_path else None
    sky = parse_sky_header(sky_path) if sky_path else None
    lighting = parse_trn_lighting(trn_path)

    # Calibrated world_rect from the user's hand-cal / detector-fit config.
    cfg = load_config(stem)
    world_rect = None
    if cfg and cfg.get("affine"):
        wr = cfg["affine"].get("world_rect")
        if wr and "min" in wr and "max" in wr:
            world_rect = {
                "min": {"x": float(wr["min"]["x"]), "z": float(wr["min"]["z"])},
                "max": {"x": float(wr["max"]["x"]), "z": float(wr["max"]["z"])},
            }

    if world_rect is None:
        # Fallback to .TRN bounds so the viewer always has SOMETHING.
        world_rect = {
            "min": {"x": ter.world_min_x, "z": ter.world_min_z},
            "max": {"x": ter.world_max_x, "z": ter.world_max_z},
        }

    objects, map_name = build_objects(stem)

    # Minimap PNG path: rel from render/data/<stem>.3d.json to data/maps/<stem>.png
    png_disk = DATA_MAPS_DIR / f"{stem}.png"
    minimap_rel = None
    minimap_dim = None
    if png_disk.is_file():
        minimap_rel = f"../../../data/maps/{stem}.png"
        try:
            from PIL import Image
            with Image.open(png_disk) as im:
                minimap_dim = list(im.size)
        except Exception:
            minimap_dim = None

    # Tier 3 (Game tiles) bake: emit color + alpha1/2/3 as per-map PNGs
    # at source resolution, plus the InfoMap as base64 inside the .3d.json.
    # Row 0 of every map = grid_min_z (.TER decode convention), aligned with
    # the heightmap + cell-types mask conventions.
    tile_composite = None
    try:
        from PIL import Image
        src_w, src_h = ter.src_cells_x, ter.src_cells_z
        color_path  = RENDER_DATA_DIR / f"{stem}.color.png"
        alpha1_path = RENDER_DATA_DIR / f"{stem}.alpha1.png"
        alpha2_path = RENDER_DATA_DIR / f"{stem}.alpha2.png"
        alpha3_path = RENDER_DATA_DIR / f"{stem}.alpha3.png"
        # Color is RGB; alphas are single-channel grayscale.
        Image.frombytes("RGB", (src_w, src_h), ter.color_rgb_bytes).save(
            color_path, optimize=True)
        Image.frombytes("L",   (src_w, src_h), ter.alpha1_bytes).save(
            alpha1_path, optimize=True)
        Image.frombytes("L",   (src_w, src_h), ter.alpha2_bytes).save(
            alpha2_path, optimize=True)
        Image.frombytes("L",   (src_w, src_h), ter.alpha3_bytes).save(
            alpha3_path, optimize=True)
        # InfoMap is per-cluster uint32. Tiny -- embed as base64 inline in
        # the .3d.json (saves a separate fetch on tier-3 select).
        info_map_b64 = base64.b64encode(ter.info_map_bytes).decode("ascii")
        # Tile texture names from .TRN [Texture] block. Fixed 16-slot list;
        # None for holes. Output as a JSON-safe list (None -> null).
        tile_texture_names = parse_trn_tile_textures(trn_path) if trn_path else [None] * 16
        tile_composite = {
            "color_png_rel":   f"{stem}.color.png",
            "alpha1_png_rel":  f"{stem}.alpha1.png",
            "alpha2_png_rel":  f"{stem}.alpha2.png",
            "alpha3_png_rel":  f"{stem}.alpha3.png",
            "src_cells_x":     src_w,
            "src_cells_z":     src_h,
            "info_map_b64":    info_map_b64,
            "info_cluster_size": 16,
            "info_cluster_cols": ter.info_cluster_cols,
            "info_cluster_rows": ter.info_cluster_rows,
            "tile_texture_names": tile_texture_names,
        }
    except Exception as e:
        # Pillow / write failure: emit warning, tier-3 will be disabled for
        # this map in the viewer (graceful fallback to Default mode).
        print(f"warning: failed to bake tile-composite assets for {stem}: {e}",
              file=sys.stderr)

    # Heightmap comes from the full .TER decode per the bz2terraineditor
    # source: cluster-based, 16x16 cells per cluster, row-major clusters
    # with per-channel compression flags, float32 heights in absolute
    # meters. We box-downsample 1024x1024 -> 256x256 for browser meshes.
    # Output int16 is centered on midpoint via base_offset; viewer recovers
    # meters via `int16 * scale + base_offset`.
    hm_cells_x = ter.cells_x
    hm_cells_z = ter.cells_z
    hm_bytes = ter.heights_le_bytes
    hm_scale = ter.scale
    hm_base_offset_m = ter.height_setting  # midpoint of measured height range
    decode_method = "ter_v5_cluster_float32"
    heights_b64 = base64.b64encode(hm_bytes).decode("ascii")

    # Smart sidebar defaults derived from real .TER content -----------------
    #
    # has_visible_water: any cell with the CellType.Water bit (0x02) set --
    # threshold at >= 0.5% of total cells so spurious single-cell mishaps
    # don't trigger a misleading water plane. For VSR competitive maps this
    # is almost always 0; campaign maps with coastlines will trigger.
    LIQUID_VISIBILITY_THRESHOLD = 0.005
    water_ratio = ter.water_cells / max(1, ter.total_cells)
    has_visible_water = water_ratio >= LIQUID_VISIBILITY_THRESHOLD
    lava_ratio = ter.lava_cells / max(1, ter.total_cells)
    has_visible_lava = lava_ratio >= LIQUID_VISIBILITY_THRESHOLD

    # default_exaggeration: heuristic to give every map a visually
    # interesting default Y. We aim for ~12% visual slope at 1x by dividing
    # the desired ratio by the natural ratio. Clamped so mountainous maps
    # (Hubris) don't end up at 0.1x and flat maps don't blow up to 10x.
    world_extent_x = ter.world_max_x - ter.world_min_x
    world_extent_z = ter.world_max_z - ter.world_min_z
    world_extent_m = max(world_extent_x, world_extent_z)
    height_range_m = max(1.0, ter.height_max_m - ter.height_min_m)
    natural_slope = height_range_m / world_extent_m
    TARGET_VISUAL_SLOPE = 0.12
    default_exaggeration = TARGET_VISUAL_SLOPE / max(0.001, natural_slope)
    default_exaggeration = max(0.5, min(3.0, default_exaggeration))
    default_exaggeration = round(default_exaggeration * 10) / 10  # 0.1 step

    # Heightmap world extent matches the .TER tile bounds (full terrain mesh
    # spans -1024..+1024 typically). The viewer UV-maps the minimap PNG
    # only onto the calibrated playable subregion.
    hm_world_min_x = ter.world_min_x
    hm_world_min_z = ter.world_min_z
    hm_world_max_x = ter.world_max_x
    hm_world_max_z = ter.world_max_z
    cell_m_x = (hm_world_max_x - hm_world_min_x) / hm_cells_x
    cell_m_z = (hm_world_max_z - hm_world_min_z) / hm_cells_z

    # Per-cell CellType bitmap at render resolution. One byte per output cell,
    # bits per CellType.cs. Used by the viewer as an alphaMap on the
    # water/lava planes so liquids only render on flagged cells.
    cell_types_b64 = base64.b64encode(ter.cell_type_bytes).decode("ascii")

    return {
        "schema_version": 3,
        "map_stem": stem,
        "map_name": map_name,
        "heightmap": {
            "cells_x": hm_cells_x,
            "cells_z": hm_cells_z,
            "src_cells_x": ter.src_cells_x,
            "src_cells_z": ter.src_cells_z,
            "encoding": "int16_le_base64",
            "data": heights_b64,
            "scale": hm_scale,
            "base_offset_m": hm_base_offset_m,
            "height_min_m": ter.height_min_m,
            "height_max_m": ter.height_max_m,
            "cell_meters_x": cell_m_x,
            "cell_meters_z": cell_m_z,
            "world_origin": {"x": hm_world_min_x, "z": hm_world_min_z},
            "ter_version": ter.version,
            "decode_method": decode_method,
        },
        "cell_types": {
            "total":    ter.total_cells,
            "flat":     ter.flat_cells,
            "cliff":    ter.cliff_cells,
            "water":    ter.water_cells,
            "building": ter.building_cells,
            "lava":     ter.lava_cells,
            "sloped":   ter.sloped_cells,
        },
        "cell_types_map": {
            "cells_x": hm_cells_x,
            "cells_z": hm_cells_z,
            "encoding": "uint8_base64",
            "data": cell_types_b64,
            "bits": {
                "cliff":    0x01,
                "water":    0x02,
                "building": 0x04,
                "lava":     0x08,
                "sloped":   0x10,
            },
        },
        "defaults": {
            "has_visible_water": has_visible_water,
            "has_visible_lava":  has_visible_lava,
            "default_exaggeration": default_exaggeration,
        },
        "world_rect": world_rect,
        "minimap_png_rel": minimap_rel,
        "minimap_dim": minimap_dim,
        # Tier 3 "Game tiles" floor-quality asset block. Bundles the per-map
        # inputs the shader needs to composite real BZ:CC tile textures:
        # color tint PNG + 3 alpha PNGs + base64'd InfoMap + .TRN tile name
        # list. Null when the bake step failed (viewer disables tier 3).
        "tile_composite": tile_composite,
        # Water plane Y is in ABSOLUTE engine meters (.WAT byte 16).
        # Viewer subtracts heightmap.base_offset_m to align with the centered mesh.
        "water_y_raw": (wat["water_y"] if wat else None),
        # Prefer .TRN [Sky] SkyColor over the .SKY binary header tint -- the
        # .TRN value is authoritative engine input.
        "sky_tint": (lighting.get("sky_color_hex")
                     or (sky["sky_tint"] if sky else "#1a2030")),
        "sky_rgb_float": (sky.get("sky_rgb_float") if sky else None),
        # All the lighting/atmosphere data from .TRN that the viewer applies
        # to its Three.js scene. Each field is optional; viewer has defaults.
        "lighting": {
            "sun_color_hex":     _rgb_to_hex(lighting.get("sun_color")),
            "ambient_color_hex": _rgb_to_hex(lighting.get("ambient_color")),
            "sun_angle_deg":     lighting.get("sun_angle_deg"),
            "water_color_hex":   lighting.get("water_color_hex"),
            "water_opacity":     lighting.get("water_opacity"),
            "fog_color_hex":     lighting.get("fog_color_hex"),
            "fog_start":         lighting.get("fog_start"),
            "fog_end":           lighting.get("fog_end"),
            "visibility_range":  lighting.get("visibility_range"),
        },
        "objects": objects,
        "object_count_by_kind": _count_by_kind(objects),
    }


def _count_by_kind(objects: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for o in objects:
        out[o["kind"]] = out.get(o["kind"], 0) + 1
    return out


def _rgb_to_hex(rgba):
    """Convert (r, g, b, a) 0..1 floats to '#rrggbb'. None passthrough."""
    if rgba is None:
        return None
    r, g, b = rgba[0], rgba[1], rgba[2]
    return "#{:02x}{:02x}{:02x}".format(
        int(round(max(0, min(1, r)) * 255)),
        int(round(max(0, min(1, g)) * 255)),
        int(round(max(0, min(1, b)) * 255)),
    )


def _all_stems_from_vsrmaplist() -> list[str]:
    """Walk vsrmaplist/ and collect every map's .bzn stem (lowercased).
    Returns sorted list."""
    stems: list[str] = []
    if not VSRMAPLIST_DIR.is_dir():
        return stems
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        if not bzns:
            continue
        # Verify a .TER exists too -- skip maps without a heightmap.
        ters = list(folder.glob("*.TER")) + list(folder.glob("*.ter"))
        if not ters:
            continue
        stems.append(bzns[0].stem.lower())
    return stems


def _extract_one(stem: str, quiet: bool = False) -> tuple[bool, str]:
    """Extract one map's JSON. Returns (ok, message)."""
    out_path = RENDER_DATA_DIR / f"{stem}.3d.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        payload = build_output(stem)
        out_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        if not quiet:
            preview = {k: v for k, v in payload.items() if k != "heightmap"}
            preview["heightmap_summary"] = {
                k: v for k, v in payload["heightmap"].items() if k != "data"
            }
            preview["heightmap_summary"]["data_base64_len"] = len(payload["heightmap"]["data"])
            print(json.dumps(preview, indent=2))
        size_kb = out_path.stat().st_size / 1024
        return True, f"{stem:<22s} -> {size_kb:>6.0f} KB"
    except Exception as e:
        return False, f"{stem:<22s} FAILED: {e}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stem", nargs="?", help="map stem (e.g. vsreuronig); omit when using --all")
    ap.add_argument("--out", default=None,
                    help="output path; default render/data/<stem>.3d.json (single-stem mode only)")
    ap.add_argument("--all", action="store_true",
                    help="extract every map in vsrmaplist/ that has a .TER file")
    ap.add_argument("--skip-existing", action="store_true",
                    help="when --all is set, skip stems that already have a JSON in data/")
    args = ap.parse_args(argv)

    if args.all:
        if args.out:
            print("error: --out is incompatible with --all", file=sys.stderr)
            return 2
        stems = _all_stems_from_vsrmaplist()
        if not stems:
            print(f"error: no maps with .TER in {VSRMAPLIST_DIR}", file=sys.stderr)
            return 1
        if args.skip_existing:
            stems = [s for s in stems if not (RENDER_DATA_DIR / f"{s}.3d.json").is_file()]
            print(f"--skip-existing: {len(stems)} remaining after filtering already-done stems")
        print(f"extracting {len(stems)} maps...")
        ok = 0; fail = 0
        for i, stem in enumerate(stems, 1):
            success, msg = _extract_one(stem, quiet=True)
            tag = "OK " if success else "ERR"
            print(f"[{i:>3}/{len(stems)}] {tag}  {msg}")
            if success: ok += 1
            else: fail += 1
        print()
        print(f"done: {ok} ok, {fail} failed")
        return 0 if fail == 0 else 1

    if not args.stem:
        ap.print_help()
        return 2
    stem = args.stem.lower()
    out_path = Path(args.out) if args.out else (RENDER_DATA_DIR / f"{stem}.3d.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"extracting 3D data for {stem}...")
    payload = build_output(stem)

    # Pretty preview before writing the JSON (which contains a 2 MB
    # base64 blob and would obliterate the terminal).
    preview = {k: v for k, v in payload.items() if k != "heightmap"}
    preview["heightmap_summary"] = {
        k: v for k, v in payload["heightmap"].items() if k != "data"
    }
    preview["heightmap_summary"]["data_base64_len"] = len(payload["heightmap"]["data"])
    print(json.dumps(preview, indent=2))

    out_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\nwrote {out_path}  ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
