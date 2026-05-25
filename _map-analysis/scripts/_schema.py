"""Backwards-compat shim. Schema helpers moved to scripts/_schema.py
(post-2026-05 render-pipeline-consolidation). Existing calibration tooling
imports stay valid through this re-export.

See `_paths.py` for the implementation rationale (importlib bypass of
Python's module-cache aliasing).
"""
import importlib.util
import sys
from pathlib import Path

_REAL_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"

# _schema imports `_paths`; make sure the real `_paths.py` is on sys.path so
# the real `_schema.py` resolves it correctly when loaded below.
if str(_REAL_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_REAL_SCRIPTS_DIR))

_REAL_SCHEMA_PY = _REAL_SCRIPTS_DIR / "_schema.py"
_spec = importlib.util.spec_from_file_location("_schema_real", _REAL_SCHEMA_PY)
_real = importlib.util.module_from_spec(_spec)
sys.modules["_schema_real"] = _real
_spec.loader.exec_module(_real)

for _name in dir(_real):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_real, _name)

del _name, _spec, _REAL_SCHEMA_PY, _REAL_SCRIPTS_DIR, importlib, Path
