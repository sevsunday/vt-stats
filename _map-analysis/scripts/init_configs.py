"""One-time-then-idempotent bootstrap of `calibration/configs/` + `calibration/map_data/`.

For every map folder under `_map-analysis/vsrmaplist/<MapName>/`:

1. **map_data**: parse BZN via analyze_map_dir, emit (or overwrite)
   `calibration/map_data/<stem>.json` with object positions + iondriver PNG
   reference.
2. **config**: if `calibration/configs/<stem>.config.json` ALREADY exists, keep
   it untouched (preserves any user overrides). Otherwise:
   - If a legacy `vsrmaplist/<MapName>/calibration.json` exists,
     migrate its bounds to `hand_migrated` source.
   - Else run the full PNG-marker detector. If RMSE < 2, source is
     `auto_proven`. If < 5, `auto_borderline`. If higher (or detector
     failed), use `inferred_bbox_fallback` with `auto_failed_fallback`.
   - If no iondriver PNG exists, write config with affine=null (->
     no_png tier).

Run order:
  1. ingest_maps.py  (populate vsrmaplist/)
  2. init_configs.py (this script)  - one-time bootstrap
  3. render_overlays.py + build_browser.py  (always orchestrated by
     reprocess.py)

CLI:
  python scripts/init_configs.py
      [--limit N]         only process the first N maps (testing)
      [--force-affine]    overwrite ANY existing affine in configs (still
                          preserves overrides). Use after a detector
                          improvement to re-run with the new algorithm
                          without losing hand-cal work.
      [--maps S1,S2,..]   only process these specific .bzn stems
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import (  # noqa: E402
    VSRMAPLIST_DIR,
    DATA_MAPS_DIR,
    CONFIGS_DIR,
    MAP_DATA_DIR,
)
from _schema import (  # noqa: E402
    make_config,
    make_affine,
    make_map_data,
    config_path,
    save_config,
    save_map_data,
    load_config,
    build_object_uids,
    migrate_legacy_calibration_json,
    SOURCE_AUTO_PROVEN,
    SOURCE_AUTO_BORDERLINE,
    SOURCE_AUTO_FAILED_FALLBACK,
    utc_now_iso,
)
from analyze_map import analyze_map_dir  # noqa: E402
from render_overlays import (  # noqa: E402
    full_solve_calibration,
    inferred_bbox_fallback,
    derive_world_rect_from_transform,
    RMSE_GOOD_PX,
    RMSE_OK_PX,
)


def vsrmaplist_to_targets() -> list[tuple[str, str, Path]]:
    """Walk vsrmaplist/ and return [(stem, folder_name, map_dir)] for
    every folder containing a `.bzn` file."""
    targets: list[tuple[str, str, Path]] = []
    if not VSRMAPLIST_DIR.is_dir():
        return targets
    for folder in sorted(VSRMAPLIST_DIR.iterdir(),
                         key=lambda p: p.name.lower()):
        if not folder.is_dir() or folder.name.startswith("_"):
            continue
        bzns = (list(folder.glob("*.bzn")) + list(folder.glob("*.BZN")))
        if not bzns:
            continue
        stem = bzns[0].stem.lower()
        targets.append((stem, folder.name, folder))
    return targets


def iondriver_png_for(stem: str) -> Path | None:
    p = DATA_MAPS_DIR / f"{stem}.png"
    return p if p.is_file() else None


def detector_affine_for(stem: str, folder_name: str,
                       map_dir: Path, png_path: Path) -> dict | None:
    """Run the detector + fallback chain and return a CANONICAL affine
    dict (per _schema.make_affine), or None if even the fallback fails
    (no inferrable bounds)."""
    try:
        t = full_solve_calibration(stem, folder_name, map_dir, png_path)
    except Exception as e:
        print(f"  detector crashed: {e}", file=sys.stderr)
        t = None

    if t is not None and "s_x" in t:
        png_w, png_h = t["png_dim"]
        derived = derive_world_rect_from_transform(t, png_w, png_h)
        if derived:
            rmse_max = max(t["rmse_x"], t["rmse_y"])
            if rmse_max < RMSE_GOOD_PX:
                source = SOURCE_AUTO_PROVEN
            elif rmse_max < RMSE_OK_PX:
                source = SOURCE_AUTO_BORDERLINE
            else:
                source = None  # fall through to bbox fallback
            if source is not None:
                return make_affine(
                    derived["world_rect"],
                    x_flipped=derived["x_flipped"],
                    y_flipped=derived["y_flipped"],
                    source=source,
                    rmse_max=rmse_max,
                    detector=t.get("detector"),
                )

    # Fallback to inferred-bbox * 1.43.
    png_w, png_h = Image.open(png_path).size
    fallback = inferred_bbox_fallback(map_dir, png_w, png_h)
    if fallback is None:
        return None
    return make_affine(
        fallback["world_rect"],
        x_flipped=False, y_flipped=False,
        source=SOURCE_AUTO_FAILED_FALLBACK,
        rmse_max=None,
        detector="inferred_bbox_fallback",
    )


def resolve_map_name(stem: str, folder_name: str, report) -> str:
    """Return the human-friendly display name. Prefer mission_name from
    the BZN; fallback to folder name."""
    return (report.mission_name or folder_name).strip()


def init_one(stem: str, folder_name: str, map_dir: Path,
             force_affine: bool) -> dict:
    """Initialize / refresh map_data + config for one map.

    Returns a result dict {stem, status, tier_inferred, affine_source}."""
    result = {"stem": stem, "folder": folder_name, "status": "ok",
              "config_created": False, "config_kept": False,
              "config_force_updated": False,
              "affine_source": None}

    report = analyze_map_dir(map_dir)
    map_name = resolve_map_name(stem, folder_name, report)

    # ----- map_data: always regenerate -----
    png = iondriver_png_for(stem)
    png_rel = None
    png_dim = None
    if png is not None:
        # calibration/map_data/<stem>.json -> ../../data/maps/<stem>.png  (relative)
        png_rel = "../../data/maps/" + png.name
        try:
            with Image.open(png) as im:
                png_dim = im.size
        except Exception:
            png_dim = None

    objects = build_object_uids(report.objects)
    map_data = make_map_data(
        map_stem=stem,
        map_name=map_name,
        iondriver_png_rel=png_rel,
        iondriver_dim=png_dim,
        objects=objects,
    )
    save_map_data(map_data)

    # ----- config: preserve existing, else build new -----
    existing = load_config(stem)
    if existing is not None and not force_affine:
        # Keep existing config (preserves overrides). Refresh map_name in
        # case the BZN's mission_name changed since last init.
        if existing.get("map_name") != map_name:
            existing["map_name"] = map_name
            save_config(existing)
        result["config_kept"] = True
        result["affine_source"] = (existing.get("affine") or {}).get("source")
        return result

    # Determine affine. Priority:
    #   1) Legacy vsrmaplist/<MapName>/calibration.json (if present) -> hand_migrated
    #   2) PNG marker detector (proven / borderline)
    #   3) Inferred bbox * 1.43 fallback
    #   4) No PNG -> affine=null (tier no_png)
    legacy_json = map_dir / "calibration.json"
    affine = None
    new_cfg: dict | None = None

    if legacy_json.is_file():
        migrated = migrate_legacy_calibration_json(legacy_json, stem, map_name)
        if migrated is not None:
            affine = migrated["affine"]

    if affine is None and png is not None:
        affine = detector_affine_for(stem, folder_name, map_dir, png)

    # Build the config (affine may be None - that's the no_png case).
    if existing is not None and force_affine:
        # Preserve overrides + metadata, swap affine.
        existing["affine"] = affine
        existing["map_name"] = map_name
        save_config(existing)
        new_cfg = existing
        result["config_force_updated"] = True
    else:
        new_cfg = make_config(stem, map_name, affine)
        if affine is not None and affine.get("source") == "hand_migrated":
            new_cfg["metadata"]["first_calibrated"] = utc_now_iso()
        save_config(new_cfg)
        result["config_created"] = True

    result["affine_source"] = (new_cfg.get("affine") or {}).get("source")
    return result


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None,
                    help="Only process the first N maps (alphabetical).")
    ap.add_argument("--force-affine", action="store_true",
                    help="Overwrite the affine on every existing config "
                         "(still preserves overrides + metadata).")
    ap.add_argument("--maps", default=None,
                    help="Comma-separated list of stems to process; "
                         "skip everything else.")
    args = ap.parse_args(argv)

    targets = vsrmaplist_to_targets()
    if not targets:
        print(f"error: no maps under {VSRMAPLIST_DIR} (run ingest_maps.py first)",
              file=sys.stderr)
        return 1

    if args.maps:
        wanted = {s.strip().lower() for s in args.maps.split(",") if s.strip()}
        targets = [t for t in targets if t[0] in wanted]
        if not targets:
            print(f"error: --maps filter matched nothing", file=sys.stderr)
            return 1

    if args.limit is not None:
        targets = targets[: args.limit]

    print(f"Initializing configs for {len(targets)} maps...")
    print(f"  CONFIGS_DIR:  {CONFIGS_DIR}")
    print(f"  MAP_DATA_DIR: {MAP_DATA_DIR}")
    if args.force_affine:
        print(f"  --force-affine: existing affines WILL be overwritten")
    print()

    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    MAP_DATA_DIR.mkdir(parents=True, exist_ok=True)

    start = time.time()
    counts = {"created": 0, "kept": 0, "force_updated": 0, "failed": 0}
    src_counts: dict[str, int] = {}
    for i, (stem, folder_name, map_dir) in enumerate(targets, 1):
        try:
            r = init_one(stem, folder_name, map_dir, args.force_affine)
        except Exception as e:
            print(f"[{i:>3}/{len(targets)}] {folder_name:<28s} ({stem})... "
                  f"FAILED: {e}", file=sys.stderr)
            counts["failed"] += 1
            continue
        if r["config_created"]:
            counts["created"] += 1
            tag = "NEW"
        elif r["config_force_updated"]:
            counts["force_updated"] += 1
            tag = "UPD"
        elif r["config_kept"]:
            counts["kept"] += 1
            tag = "KEEP"
        else:
            tag = "?"
        src = r["affine_source"] or "none"
        src_counts[src] = src_counts.get(src, 0) + 1
        print(f"[{i:>3}/{len(targets)}] {folder_name:<28s} ({stem:<22s}) "
              f"{tag:<5s} source={src}")

    elapsed = time.time() - start
    print()
    print(f"Done in {elapsed:.1f}s")
    print(f"  configs created:       {counts['created']}")
    print(f"  configs kept (no-op):  {counts['kept']}")
    if args.force_affine:
        print(f"  configs force-updated: {counts['force_updated']}")
    print(f"  failed:                {counts['failed']}")
    print(f"  TOTAL processed:       {len(targets)}")
    print()
    print("Affine sources distribution:")
    for src, n in sorted(src_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {src:<32s} {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))