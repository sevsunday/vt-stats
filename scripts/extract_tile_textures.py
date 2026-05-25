"""Extract BZ:CC tile textures from a local game install for tier-3
"Game tiles" floor rendering.

CLI:
    python _map-analysis/render/scripts/extract_tile_textures.py \
        --steam-root "C:/Program Files (x86)/Steam"

The script:
1. Walks every `.TRN` in `_map-analysis/vsrmaplist/`, parses the `[Texture]`
   block, collects the union of `TileTextureN` stems referenced by our maps.
2. Recursively scans `--steam-root` for `.dds` / `.tga` files. Builds a
   name-keyed index (stems lowercased, first-found wins on duplicates,
   conflicts logged).
3. For each unique tile referenced by our maps, materializes the best
   available format into `_map-analysis/render/data/tiles/`:
       - `.dds` available -> copy as-is (GPU-native compressed)
       - only `.tga` available -> Pillow converts to `.png` (lossless)
       - neither -> mark missing (viewer disables tier 3 for affected maps)
4. Emits `_map-analysis/render/data/tiles/_manifest.json` summarizing what
   was found / converted / missing.

Idempotent: re-running with the same args is mostly a no-op (already-copied
DDS files are detected by size match; already-converted PNGs are skipped).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

from _wat_sky import parse_trn_tile_textures
from _paths import VSRMAPLIST_DIR, TILES_DIR, PROJECT_ROOT


MANIFEST_PATH = TILES_DIR / "_manifest.json"
MANIFEST_SCHEMA = 1
# Image extensions to look for on disk. .dds + .tga are the primary BZ:CC
# formats; .bmp + .png are occasionally used by older maps / community packs.
# Preference order is dds > tga > bmp > png (best GPU efficiency first).
TARGET_EXTS = {".dds", ".tga", ".bmp", ".png"}
# Preference order when multiple extensions exist for the same stem.
EXT_PRIORITY = (".dds", ".tga", ".bmp", ".png")


# -----------------------------------------------------------------------
# Step 1 -- collect required tile stems from .TRN files
# -----------------------------------------------------------------------

def collect_required_tiles(vsrmaplist_dir: Path) -> tuple[dict[str, list[str | None]], set[str]]:
    """Walk vsrmaplist/ and return:
        (by_map: {map_stem: [tile0 | None, tile1 | None, ..., tile15 | None]},
         required: union of all non-None tile stems across all maps)

    Each per-map list is exactly 16 entries -- a fixed-slot mapping aligned
    with `InfoMap`'s 4-bit layer indices. Holes are None.
    """
    by_map: dict[str, list[str | None]] = {}
    required: set[str] = set()
    if not vsrmaplist_dir.is_dir():
        return by_map, required
    for folder in sorted(vsrmaplist_dir.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        bzns = list(folder.glob("*.bzn")) + list(folder.glob("*.BZN"))
        trns = list(folder.glob("*.TRN")) + list(folder.glob("*.trn"))
        if not bzns or not trns:
            continue
        stem = bzns[0].stem.lower()
        tiles = parse_trn_tile_textures(trns[0])
        by_map[stem] = tiles
        for t in tiles:
            if t:
                required.add(t)
    return by_map, required


# -----------------------------------------------------------------------
# Step 2 -- recursive scan for .dds / .tga files
# -----------------------------------------------------------------------

def _print_progress(count: int, found: int, last_dir: str) -> None:
    # Trim noisy long paths.
    trimmed = last_dir if len(last_dir) <= 70 else "..." + last_dir[-67:]
    sys.stdout.write(f"\r  scanned {count:>7,}  matched {found:>5,}  {trimmed:<70s}")
    sys.stdout.flush()


def scan_for_textures(roots: list[Path],
                      verbose: bool = True
                      ) -> tuple[dict[str, dict[str, Path | None]], list[dict]]:
    """Recursively scan one or more directories for tile-candidate files.

    Returns:
        index: {stem_lower: {ext: Path|None for ext in TARGET_EXTS}}
        conflicts: list of {name, winner, rejected} records when multiple
                   files share the same stem + extension.

    First-found wins on duplicates within the same extension.
    """
    raw: dict[str, dict[str, list[Path]]] = {}
    scanned = 0
    matched = 0
    last_dir = ""
    t0 = time.time()
    import os
    for root in roots:
        if not root.is_dir():
            print(f"  warning: root not found: {root}", file=sys.stderr)
            continue
        # os.walk is more forgiving than Path.rglob across locked dirs.
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False, onerror=lambda e: None):
            scanned += len(filenames)
            if verbose and dirpath != last_dir:
                last_dir = dirpath
                _print_progress(scanned, matched, dirpath)
            for fn in filenames:
                ext = Path(fn).suffix.lower()
                if ext not in TARGET_EXTS:
                    continue
                stem = Path(fn).stem.lower()
                slot = raw.setdefault(
                    stem, {e: [] for e in TARGET_EXTS}
                )
                slot[ext].append(Path(dirpath) / fn)
                matched += 1
    if verbose:
        elapsed = time.time() - t0
        sys.stdout.write("\r" + " " * 100 + "\r")
        print(f"  scan complete: {scanned:,} files, {matched:,} matches, {elapsed:.1f}s")

    index: dict[str, dict[str, Path | None]] = {}
    conflicts: list[dict] = []
    for stem, exts in raw.items():
        per_ext: dict[str, Path | None] = {}
        extras: list[Path] = []
        for ext, paths in exts.items():
            if paths:
                per_ext[ext] = paths[0]
                extras.extend(paths[1:])
            else:
                per_ext[ext] = None
        if extras:
            winner = next((p for e in EXT_PRIORITY if (p := per_ext.get(e))), None)
            conflicts.append({
                "name": stem,
                "winner": str(winner) if winner else None,
                "rejected": [str(p) for p in extras][:8],
            })
        index[stem] = per_ext
    return index, conflicts


# -----------------------------------------------------------------------
# Step 3 -- materialize one tile into tiles/<name>.{dds|png}
# -----------------------------------------------------------------------

def _convert_to_png(src: Path, dst: Path) -> None:
    """Read any Pillow-supported image and write a PNG. Preserves alpha
    when present."""
    from PIL import Image
    with Image.open(src) as im:
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if im.mode in ("LA", "PA") else "RGB")
        im.save(dst, format="PNG", optimize=True)


def materialize_tile(name: str,
                     src: dict[str, Path | None],
                     tiles_dir: Path) -> dict:
    """Copy or convert a tile file into `tiles_dir`. Returns the manifest
    entry dict for the tile.

    Preference: .dds (copy as-is, GPU-native compressed) > .tga/.bmp/.png
    (convert to .png via Pillow, lossless).
    """
    dds_src = src.get(".dds")
    if dds_src is not None:
        out = tiles_dir / f"{name}.dds"
        if not out.exists() or out.stat().st_size != dds_src.stat().st_size:
            try:
                shutil.copyfile(dds_src, out)
            except Exception as e:
                return {"name": name, "format": "copy_failed",
                        "error": str(e), "source_path": str(dds_src)}
        return {
            "name": name,
            "format": "dds",
            "filename": out.name,
            "bytes": out.stat().st_size,
            "source_path": str(dds_src),
        }

    # Pick the best non-DDS fallback. Prefer .png > .tga > .bmp (.png is
    # already in the format we'll re-emit; .tga is more common for BZ:CC
    # tiles; .bmp last since some are RLE-compressed and Pillow occasionally
    # chokes).
    for ext, source_format in [(".png", "png"), (".tga", "tga"), (".bmp", "bmp")]:
        candidate = src.get(ext)
        if candidate is None:
            continue
        out = tiles_dir / f"{name}.png"
        if not out.exists():
            try:
                _convert_to_png(candidate, out)
            except Exception as e:
                return {"name": name, "format": f"{source_format}_convert_failed",
                        "error": str(e), "source_path": str(candidate)}
        return {
            "name": name,
            "format": "png",
            "filename": out.name,
            "bytes": out.stat().st_size,
            "source_path": str(candidate),
            "source_format": source_format,
        }

    return {"name": name, "format": "missing"}


# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--steam-root",
        default="C:/Program Files (x86)/Steam",
        help="Root directory to recursively scan for .dds / .tga files. "
             "Default: %(default)s",
    )
    ap.add_argument(
        "--extra-root",
        action="append",
        default=[],
        help="Additional root(s) to scan (repeatable; e.g. workshop "
             "shortcut, second drive Steam library).",
    )
    ap.add_argument(
        "--vsrmaplist",
        default=str(VSRMAPLIST_DIR),
        help="Path to the vsrmaplist/ folder (default uses _paths constant).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Do all the scanning + parsing but don't copy or convert any "
             "files. Useful for previewing what would happen.",
    )
    args = ap.parse_args(argv)

    vsrmaplist_dir = Path(args.vsrmaplist)
    steam_root = Path(args.steam_root)
    extra_roots = [Path(p) for p in args.extra_root]
    roots = [steam_root] + extra_roots

    print(f"vsrmaplist: {vsrmaplist_dir}")
    print(f"scan roots: {', '.join(str(r) for r in roots)}")
    print()

    # Step 1: gather required tile names.
    print("[1/3] parsing .TRN [Texture] blocks across vsrmaplist...")
    by_map, required = collect_required_tiles(vsrmaplist_dir)
    print(f"      {len(by_map)} maps parsed, {len(required)} unique tile stems referenced")
    if required:
        sample = sorted(required)[:10]
        print(f"      sample: {', '.join(sample)}{'...' if len(required) > 10 else ''}")
    print()

    # Step 2: scan filesystem.
    print("[2/3] recursively scanning for .dds / .tga files...")
    print(f"      (this may take 10-60s depending on Steam library size)")
    index, conflicts = scan_for_textures(roots)
    # Restrict to tiles actually referenced (most found textures will be
    # unrelated game assets we don't care about).
    relevant = {k: v for k, v in index.items() if k in required}
    print(f"      {len(relevant)} of {len(required)} required tiles found in scan")
    print()

    # Step 3: materialize.
    try:
        rel = TILES_DIR.relative_to(PROJECT_ROOT)
    except ValueError:
        rel = TILES_DIR
    print(f"[3/3] materializing tiles into {rel}/")
    if not args.dry_run:
        TILES_DIR.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    missing: list[str] = []
    counts = {"dds": 0, "png": 0, "missing": 0, "failed": 0}
    empty_src = {e: None for e in TARGET_EXTS}
    for name in sorted(required):
        src = relevant.get(name, empty_src)
        if args.dry_run:
            if src.get(".dds"):
                entry = {"name": name, "format": "dds (dry-run)",
                         "source_path": str(src[".dds"])}
            elif src.get(".tga"):
                entry = {"name": name, "format": "png (dry-run, from tga)",
                         "source_path": str(src[".tga"])}
            elif src.get(".bmp"):
                entry = {"name": name, "format": "png (dry-run, from bmp)",
                         "source_path": str(src[".bmp"])}
            elif src.get(".png"):
                entry = {"name": name, "format": "png (dry-run, copy)",
                         "source_path": str(src[".png"])}
            else:
                entry = {"name": name, "format": "missing"}
        else:
            entry = materialize_tile(name, src, TILES_DIR)
        entries.append(entry)
        fmt = entry["format"].split(" ")[0]  # drop "(dry-run)" suffix for counter
        if fmt == "missing":
            missing.append(name)
            counts["missing"] += 1
        elif fmt in ("dds", "png"):
            counts[fmt] += 1
        else:
            counts["failed"] += 1
            print(f"      WARN: {name}: {entry}", file=sys.stderr)

    print(
        f"      dds={counts['dds']}  png={counts['png']}  "
        f"missing={counts['missing']}  failed={counts['failed']}"
    )

    # Emit manifest.
    manifest = {
        "schema_version": MANIFEST_SCHEMA,
        "tiles": entries,
        "missing": missing,
        "conflicts": [c for c in conflicts if c["name"] in required],
        "source_roots": [str(r) for r in roots],
        "by_map_tile_lists": by_map,
    }
    if not args.dry_run:
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n",
                                 encoding="utf-8")
        print(f"\nwrote {MANIFEST_PATH}")

    if missing:
        print(
            f"\nNOTE: {len(missing)} tile(s) referenced by maps but not "
            "found in the scan:\n  " + ", ".join(sorted(missing)[:20])
            + ("\n  ..." if len(missing) > 20 else "")
        )
        # Find which maps reference any missing tile.
        missing_set = set(missing)
        affected = sorted({
            m for m, tiles in by_map.items()
            if any((t is not None and t in missing_set) for t in tiles)
        })
        if affected:
            print(f"  -> {len(affected)} map(s) will be tier-3-disabled, e.g.: "
                  + ", ".join(affected[:15])
                  + ("..." if len(affected) > 15 else ""))

    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
