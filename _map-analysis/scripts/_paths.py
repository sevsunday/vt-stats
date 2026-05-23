"""Centralized path constants for `_map-analysis/scripts/*.py`.

Layout (all relative to MAP_ANALYSIS_DIR):

    _map-analysis/
      scripts/         <- THIS_DIR (where the .py files live)
      vsrmaplist/      <- ingested per-map source files
      ppm/             <- King's PPM renders (legacy reference data)
      calibration/     <- the calibration webapp + per-map artifacts
        configs/       <- per-map calibration configs (user state)
        map_data/      <- per-map BZN-derived data (regenerated)
        proven/, borderline/, hand_cal/, failed/, no_png/  <- tier overlays
        staging/       <- clean overlays for production export
      archive/         <- deprecated stuff
    data/
      maps/            <- iondriver minimap PNGs (the calibration target)
      vsrmaplist.json  <- BZCC-Website map manifest

Anything outside `_map-analysis/` (e.g. `data/maps/`) lives in PROJECT_ROOT.
"""

from pathlib import Path

# THIS file lives in _map-analysis/scripts/.
THIS_DIR = Path(__file__).resolve().parent
MAP_ANALYSIS_DIR = THIS_DIR.parent
PROJECT_ROOT = MAP_ANALYSIS_DIR.parent

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

# Legacy paths (for migration)
LEGACY_CALIBRATE_ARCHIVE = ARCHIVE_DIR / "vsrmaplist_legacy_calibrate_html"


def ensure_dirs() -> None:
    """Create every output directory if it doesn't exist."""
    for d in (CONFIGS_DIR, MAP_DATA_DIR, STAGING_DIR,
              *TIER_DIRS.values()):
        d.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    # Diagnostic: print all resolved paths
    print(f"THIS_DIR:          {THIS_DIR}")
    print(f"MAP_ANALYSIS_DIR:  {MAP_ANALYSIS_DIR}")
    print(f"PROJECT_ROOT:      {PROJECT_ROOT}")
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
    ):
        exists = "OK" if p.exists() else "missing"
        print(f"  {name:<22s} {exists}  {p}")
