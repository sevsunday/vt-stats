"""One-stop orchestrator. Run this after hand-calibrating maps in
calibration/calibrate.html (or after re-running init_configs.py to pick up
fresh BZN data, etc.).

The default sequence:
  1. Render every overlay from configs (-> tier folders + staging/)
  2. Rebuild calibration/index.html

Optional steps (off by default; opt-in via flags):
  --regen-map-data    : re-run analyze_map_dir on every vsrmaplist
                        folder and refresh calibration/map_data/<stem>.json.
                        Use this when BZN data changes (e.g. you
                        re-ingested from Steam).
  --re-detect-failed  : re-run the PNG-marker detector on every config
                        whose source = auto_failed_fallback. Useful
                        after improving the detector.
  --re-detect-all     : re-run the detector on EVERY config whose
                        source = auto_* (still preserves any overrides).
                        Use sparingly - rerun cost = ~10 minutes corpus.
  --skip-render       : don't render overlays; just rebuild the index.
  --maps stem,stem    : restrict everything to these specific stems.

CLI:
  # Default - typical "after calibrating some maps" workflow:
  python scripts/reprocess.py

  # After ingesting new map files from Steam:
  python scripts/reprocess.py --regen-map-data

  # After improving the detector:
  python scripts/reprocess.py --re-detect-failed
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import (  # noqa: E402
    CONFIGS_DIR,
    CALIBRATION_DIR,
    THIS_DIR,
)
from _schema import load_config, save_config  # noqa: E402


def _run_script(script_name: str, extra_args: list[str] | None = None) -> int:
    """Exec another script in scripts/ via subprocess. Returns exit code."""
    path = THIS_DIR / script_name
    if not path.is_file():
        print(f"WARN: {script_name} not found at {path}; skipping",
              file=sys.stderr)
        return 0
    cmd = [sys.executable, str(path)] + (extra_args or [])
    print(f"\n>>> {script_name} {' '.join(extra_args or [])}")
    return subprocess.call(cmd, cwd=str(THIS_DIR))


def step_regen_map_data(maps_filter: str | None) -> int:
    """Refresh calibration/map_data/*.json from BZN. Preserves configs."""
    args = []
    if maps_filter:
        args += ["--maps", maps_filter]
    return _run_script("init_configs.py", args)


def step_re_detect(scope: str, maps_filter: str | None) -> int:
    """Re-run the detector on a subset of configs.

    `scope` is one of:
      - 'failed': only configs with affine.source=auto_failed_fallback
      - 'all':    every config with affine.source starting with 'auto_'
    """
    from _schema import (
        SOURCE_AUTO_FAILED_FALLBACK,
        SOURCE_AUTO_PROVEN, SOURCE_AUTO_BORDERLINE,
    )

    if not CONFIGS_DIR.is_dir():
        print(f"error: {CONFIGS_DIR} not found", file=sys.stderr)
        return 1

    auto_sources = {SOURCE_AUTO_PROVEN, SOURCE_AUTO_BORDERLINE,
                    SOURCE_AUTO_FAILED_FALLBACK}
    failed_only_sources = {SOURCE_AUTO_FAILED_FALLBACK}

    target_set = (auto_sources if scope == "all" else failed_only_sources)

    stems_to_redetect: list[str] = []
    for cfg_path in sorted(CONFIGS_DIR.glob("*.config.json")):
        stem = cfg_path.stem.removesuffix(".config")
        cfg = load_config(stem)
        if cfg is None:
            continue
        src = (cfg.get("affine") or {}).get("source")
        if src in target_set:
            stems_to_redetect.append(stem)

    # Honor --maps filter.
    if maps_filter:
        wanted = {s.strip().lower() for s in maps_filter.split(",") if s.strip()}
        stems_to_redetect = [s for s in stems_to_redetect if s in wanted]

    if not stems_to_redetect:
        print(f"  no configs match scope={scope!r}; nothing to re-detect")
        return 0

    print(f"  will re-detect {len(stems_to_redetect)} configs "
          f"(scope={scope})")
    args = ["--force-affine", "--maps", ",".join(stems_to_redetect)]
    return _run_script("init_configs.py", args)


def step_render(maps_filter: str | None) -> int:
    args = []
    if maps_filter:
        args += ["--maps", maps_filter]
    return _run_script("render_overlays.py", args)


def step_build_browser() -> int:
    return _run_script("build_browser.py")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--regen-map-data", action="store_true",
                    help="Re-run BZN parser; refresh calibration/map_data/ from disk.")
    ap.add_argument("--re-detect-failed", action="store_true",
                    help="Re-run the detector on configs whose source=auto_failed_fallback.")
    ap.add_argument("--re-detect-all", action="store_true",
                    help="Re-run the detector on EVERY auto_* config "
                         "(preserves overrides).")
    ap.add_argument("--skip-render", action="store_true",
                    help="Skip the overlay-render step.")
    ap.add_argument("--skip-index", action="store_true",
                    help="Skip the index.html rebuild step.")
    ap.add_argument("--maps", default=None,
                    help="Comma-separated stems; restrict all steps to these.")
    args = ap.parse_args(argv)

    overall_start = time.time()
    print(f"reprocess.py @ {Path.cwd()}")
    print(f"  CALIBRATION_DIR: {CALIBRATION_DIR}")
    print(f"  CONFIGS_DIR: {CONFIGS_DIR}")

    # Step 1 (optional): refresh BZN-derived data.
    if args.regen_map_data:
        rc = step_regen_map_data(args.maps)
        if rc != 0:
            print(f"\nreprocess: init_configs (regen-map-data) failed with {rc}",
                  file=sys.stderr)
            return rc

    # Step 2 (optional): re-run detector on subset.
    if args.re_detect_all:
        rc = step_re_detect("all", args.maps)
        if rc != 0:
            return rc
    elif args.re_detect_failed:
        rc = step_re_detect("failed", args.maps)
        if rc != 0:
            return rc

    # Step 3: render overlays (default).
    if not args.skip_render:
        rc = step_render(args.maps)
        if rc != 0:
            return rc

    # Step 4: rebuild index.
    if not args.skip_index:
        rc = step_build_browser()
        if rc != 0:
            return rc

    elapsed = time.time() - overall_start
    print(f"\nreprocess complete in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
