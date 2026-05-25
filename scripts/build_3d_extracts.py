"""Build 3D-render extracts for every map stem referenced by the corpus.

Pipeline order, mirroring build_map_registry's "soft-fail and continue"
contract:

  1. Auto-bootstrap (one-shot, gated on output existence):
       a. ingest_maps.py (in _map-analysis/scripts/) when
          _map-analysis/vsrmaplist/ is empty / missing.
       b. extract_tile_textures (sibling module) when
          data/render/tiles/_manifest.json is missing.
     Both are Steam-dependent; soft-fail when Steam isn't found locally
     (fresh CI / Docker boxes etc.) without crashing the pipeline.
  2. Per-stem extract: extract_3d.extract_one(stem) for each missing
     <stem>.3d.json. Soft-fails per stem (vsrmaplist gap, .TER parse
     error, etc.). Stems where vsrmaplist is still missing post-bootstrap
     log WARN and continue -- the dashboard's "no 3D extract" empty state
     covers those matches.
  3. Manifest refresh: build_render_manifest.main() if any new extracts
     succeeded.

Public API (called by scripts/process_stats.py):

    build_3d_extracts(stems: list[str], force: bool = False) -> dict

The returned dict has counters: ok / skipped / failed / manifest_refreshed
/ bootstrapped_vsrmaplist / bootstrapped_tiles.
"""
from __future__ import annotations

import subprocess
import sys

from _paths import (
    MAP_ANALYSIS_DIR,
    RENDER_DATA_DIR,
    TILES_DIR,
    VSRMAPLIST_DIR,
)


def maybe_bootstrap_vsrmaplist() -> dict:
    """If vsrmaplist/ is empty/missing, run ingest_maps.py once with
    --no-rebuild (we don't want the heavy reprocess.py overlay-render
    pass triggered as part of every production pipeline run; calibration
    tooling drives that manually).

    Steam-dependent: soft-fails when Steam isn't found locally.

    ingest_maps.py lives at _map-analysis/scripts/ingest_maps.py and is
    NOT moving as part of the render-pipeline consolidation (it's
    calibration-authoring tooling, not pipeline tooling). Subprocess
    invocation is cleaner than sys.path juggling here because
    ingest_maps owns its own argparse + extensive logging that's already
    plumbed for stdout.
    """
    try:
        is_populated = VSRMAPLIST_DIR.exists() and any(VSRMAPLIST_DIR.iterdir())
    except OSError:
        is_populated = False
    if is_populated:
        return {"ran": False, "reason": "vsrmaplist already populated"}
    print("  bootstrap: vsrmaplist/ empty -- one-time ingest from local Steam install...")
    ingest_path = MAP_ANALYSIS_DIR / "scripts" / "ingest_maps.py"
    if not ingest_path.is_file():
        print(f"  WARN: {ingest_path} not found; cannot bootstrap vsrmaplist.")
        return {"ran": True, "error": "ingest_maps.py missing"}
    try:
        result = subprocess.run(
            [sys.executable, str(ingest_path), "--no-rebuild"],
            check=False,
        )
        return {"ran": True, "rc": result.returncode}
    except Exception as e:
        print(f"  WARN: ingest_maps bootstrap failed ({e}); 3D extracts may be incomplete.")
        return {"ran": True, "error": str(e)}


def maybe_bootstrap_tiles() -> dict:
    """If data/render/tiles/_manifest.json is missing, run
    extract_tile_textures once. Steam-dependent; soft-fails."""
    manifest_path = TILES_DIR / "_manifest.json"
    if manifest_path.exists():
        return {"ran": False, "reason": "tiles manifest already present"}
    print("  bootstrap: tile textures missing -- one-time extract from local Steam install...")
    try:
        import extract_tile_textures
        rc = extract_tile_textures.main([])
        return {"ran": True, "rc": rc}
    except SystemExit:
        print("  WARN: extract_tile_textures bootstrap failed; tier-3 floor unavailable.")
        return {"ran": True, "error": "SystemExit"}
    except Exception as e:
        print(f"  WARN: extract_tile_textures bootstrap failed ({e}); tier-3 floor unavailable.")
        return {"ran": True, "error": str(e)}


def build_3d_extracts(stems: list[str], force: bool = False) -> dict:
    counts: dict = {
        "ok": 0,
        "skipped": 0,
        "failed": 0,
        "manifest_refreshed": False,
        "bootstrapped_vsrmaplist": False,
        "bootstrapped_tiles": False,
    }

    bs_v = maybe_bootstrap_vsrmaplist()
    counts["bootstrapped_vsrmaplist"] = bool(bs_v.get("ran"))
    bs_t = maybe_bootstrap_tiles()
    counts["bootstrapped_tiles"] = bool(bs_t.get("ran"))

    # Lazy-imported here so the bootstrap helpers above (which may fail with
    # informative messages) run before any heavy module pulls in numpy /
    # Pillow / etc.
    import extract_3d
    import build_render_manifest

    seen: set[str] = set()
    for stem in stems:
        if not stem:
            continue
        s = stem.strip().lower()
        if not s or s in seen:
            continue
        seen.add(s)
        out_path = RENDER_DATA_DIR / f"{s}.3d.json"
        if out_path.exists() and not force:
            counts["skipped"] += 1
            continue
        try:
            extract_3d.extract_one(s, out_path)
            counts["ok"] += 1
        except FileNotFoundError as e:
            print(f"  3d:WARN  {s}: {e}")
            counts["failed"] += 1
        except Exception as e:
            print(f"  3d:WARN  {s}: extraction failed -- {e}")
            counts["failed"] += 1

    if counts["ok"] > 0:
        try:
            build_render_manifest.main()
            counts["manifest_refreshed"] = True
        except Exception as e:
            print(f"  3d:WARN  manifest refresh failed: {e}")

    return counts


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stems", nargs="*",
                    help="map stems to extract; default = every stem in vsrmaplist/")
    ap.add_argument("--force", action="store_true",
                    help="ignore skip-on-existence and re-extract every requested stem")
    args = ap.parse_args()

    if args.stems:
        target_stems = args.stems
    else:
        # Default: every stem with a .TER under vsrmaplist/.
        import extract_3d as _e3
        target_stems = _e3._all_stems_from_vsrmaplist()

    result = build_3d_extracts(target_stems, force=args.force)
    print(
        f"3D extracts: {result['ok']} new, {result['skipped']} cached, "
        f"{result['failed']} skipped/failed"
        + (" (manifest refreshed)" if result["manifest_refreshed"] else "")
    )
