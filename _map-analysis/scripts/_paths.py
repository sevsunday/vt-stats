"""Backwards-compat shim. Path constants moved to scripts/_paths.py
(post-2026-05 render-pipeline-consolidation). Existing calibration tooling
imports stay valid through this re-export.

Implementation note: we load the real module via `importlib` against an
explicit file path to avoid Python's module-cache aliasing
(`sys.modules['_paths']` may already point at THIS shim when calibration
tooling injects `_map-analysis/scripts/` ahead of `scripts/` on sys.path).
The real module is registered under the name `_paths_real`, then its public
names are re-exported into this shim's namespace.

Add a `from _paths import ...` to any new script in `scripts/` directly --
this file is only here so the calibration tooling cluster
(`init_configs.py`, `reprocess.py`, `render_overlays.py`, `build_browser.py`,
`analyze_map.py`, `ingest_maps.py`, `prove_png_calibration.py`, `bz2_paths.py`)
keeps working without per-file import surgery.
"""
import importlib.util
import sys
from pathlib import Path

_REAL_PATHS_PY = (
    Path(__file__).resolve().parents[2] / "scripts" / "_paths.py"
)
_spec = importlib.util.spec_from_file_location("_paths_real", _REAL_PATHS_PY)
_real = importlib.util.module_from_spec(_spec)
sys.modules["_paths_real"] = _real
_spec.loader.exec_module(_real)

# Re-export every public name from the real module into this shim's namespace.
for _name in dir(_real):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_real, _name)

# Expose `ensure_dirs` explicitly for type checkers / star-import edge cases.
ensure_dirs = _real.ensure_dirs  # noqa: F401

del _name, _spec, _REAL_PATHS_PY, importlib, Path


if __name__ == "__main__":
    import runpy
    runpy.run_module("_paths_real", run_name="__main__")
