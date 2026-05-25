"""Centralized path constants for the production pipeline + calibration tooling.

This file is the canonical home for every path constant the project's Python
scripts share. It lives in `scripts/` (post-2026-05 render-pipeline
consolidation); a thin re-export shim at `_map-analysis/scripts/_paths.py`
keeps existing calibration-tooling imports working without code changes.

Layout:

    PROJECT_ROOT/
      scripts/                 <- THIS_DIR (production pipeline + 3D extract)
      data/
        maps/                  <- iondriver minimap PNGs
        vsrmaplist.json        <- BZCC-Website map manifest
        render/                <- 3D-render extracts (NEW)
          *.3d.json            <- per-map heightmap + objects
          *.{color,alpha1-3}.png   <- tier-3 composite inputs
          _manifest.json       <- map switcher directory
          tiles/               <- BZ:CC tile textures
            *.dds              <- GPU-native compressed
            _manifest.json     <- per-tile audit log
      _map-analysis/
        scripts/               <- calibration authoring tooling (shim re-exports)
        vsrmaplist/            <- ingested per-map source files
        ppm/                   <- King's PPM renders
        calibration/           <- calibration webapp + per-map artifacts
          configs/             <- per-map calibration configs (user state)
          map_data/            <- per-map BZN-derived data (regenerated)
          proven/, borderline/, hand_cal/, failed/, no_png/   <- tier overlays
          staging/             <- clean overlays for production export
        render/                <- standalone 3D viewer shell (no data subdir)
        archive/               <- deprecated stuff
"""

from pathlib import Path

# THIS file lives in scripts/.
THIS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = THIS_DIR.parent
MAP_ANALYSIS_DIR = PROJECT_ROOT / "_map-analysis"

# Within _map-analysis/
VSRMAPLIST_DIR = MAP_ANALYSIS_DIR / "vsrmaplist"
PPM_DIR = MAP_ANALYSIS_DIR / "ppm"
ARCHIVE_DIR = MAP_ANALYSIS_DIR / "archive"

# Within _map-analysis/calibration/  (was: main/  pre-2026-05 rename)
CALIBRATION_DIR = MAP_ANALYSIS_DIR / "calibration"
CONFIGS_DIR = CALIBRATION_DIR / "configs"
MAP_DATA_DIR = CALIBRATION_DIR / "map_data"
STAGING_DIR = CALIBRATION_DIR / "staging"
TIER_DIRS = {
    "proven":     CALIBRATION_DIR / "proven",
    "borderline": CALIBRATION_DIR / "borderline",
    "hand_cal":   CALIBRATION_DIR / "hand_cal",
    "failed":     CALIBRATION_DIR / "failed",
    "no_png":     CALIBRATION_DIR / "no_png",
}
INDEX_HTML = CALIBRATION_DIR / "index.html"
CALIBRATE_HTML = CALIBRATION_DIR / "calibrate.html"
SUMMARY_TXT = CALIBRATION_DIR / "_summary.txt"
README_MD = CALIBRATION_DIR / "_README.md"

# Within data/ (project-root)
DATA_MAPS_DIR = PROJECT_ROOT / "data" / "maps"
VSRMAPLIST_MANIFEST = PROJECT_ROOT / "data" / "vsrmaplist.json"

# 3D-render extract outputs (post-2026-05 consolidation: moved from
# _map-analysis/render/data/ to data/render/).
RENDER_DATA_DIR = PROJECT_ROOT / "data" / "render"
TILES_DIR = RENDER_DATA_DIR / "tiles"

# Legacy paths (for migration)
LEGACY_CALIBRATE_ARCHIVE = ARCHIVE_DIR / "vsrmaplist_legacy_calibrate_html"


def ensure_dirs() -> None:
    """Create every output directory if it doesn't exist."""
    for d in (CONFIGS_DIR, MAP_DATA_DIR, STAGING_DIR,
              *TIER_DIRS.values()):
        d.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    print(f"THIS_DIR:          {THIS_DIR}")
    print(f"PROJECT_ROOT:      {PROJECT_ROOT}")
    print(f"MAP_ANALYSIS_DIR:  {MAP_ANALYSIS_DIR}")
    print()
    print("Within _map-analysis/:")
    for name, p in (
        ("VSRMAPLIST_DIR", VSRMAPLIST_DIR),
        ("PPM_DIR", PPM_DIR),
        ("ARCHIVE_DIR", ARCHIVE_DIR),
        ("CALIBRATION_DIR", CALIBRATION_DIR),
        ("CONFIGS_DIR", CONFIGS_DIR),
        ("MAP_DATA_DIR", MAP_DATA_DIR),
        ("STAGING_DIR", STAGING_DIR),
    ):
        exists = "OK" if p.exists() else "missing"
        print(f"  {name:<22s} {exists}  {p}")
    print()
    print("Within data/:")
    for name, p in (
        ("DATA_MAPS_DIR", DATA_MAPS_DIR),
        ("VSRMAPLIST_MANIFEST", VSRMAPLIST_MANIFEST),
        ("RENDER_DATA_DIR", RENDER_DATA_DIR),
        ("TILES_DIR", TILES_DIR),
    ):
        exists = "OK" if p.exists() else "missing"
        print(f"  {name:<22s} {exists}  {p}")
