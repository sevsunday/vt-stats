"""Schema definitions + read/write helpers for the calibration configs.

Two JSON file types per map:

1. **`calibration/configs/<stem>.config.json`** - the user's calibration state.
   The SOURCE OF TRUTH. Edited by the user via calibration/calibrate.html;
   produced initially by scripts/init_configs.py; read by render_overlays.py
   to produce the overlays + staging PNGs.

2. **`calibration/map_data/<stem>.json`** - per-map BZN-derived data (object
   positions, iondriver PNG path, dimensions). Regenerated from BZN
   every time `reprocess.py --regen-map-data` runs. Read by both the
   render script and the calibrate.html tool.

Both schemas are at `schema_version: 1`. Bump if/when the JSON shape
changes meaningfully.

This module is the single source of truth for the JSON shapes so all
scripts and the future calibrate.html JS read/write them consistently.
"""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import CONFIGS_DIR, MAP_DATA_DIR  # noqa: E402


CONFIG_SCHEMA_VERSION = 1
MAP_DATA_SCHEMA_VERSION = 1

# Tier IDs (must match TIER_DIRS keys in _paths.py and TIERS in build_browser.py).
TIER_PROVEN     = "proven"
TIER_BORDERLINE = "borderline"
TIER_HAND_CAL   = "hand_cal"
TIER_FAILED     = "failed"
TIER_NO_PNG     = "no_png"

# affine.source values. Determines tier (combined with override count).
SOURCE_AUTO_PROVEN          = "auto_proven"
SOURCE_AUTO_BORDERLINE      = "auto_borderline"
SOURCE_AUTO_FAILED_FALLBACK = "auto_failed_fallback"
SOURCE_HAND_CALIBRATED      = "hand_calibrated"
SOURCE_HAND_MIGRATED        = "hand_migrated"


def utc_now_iso() -> str:
    """Return current UTC time as an ISO-8601 string (Z-suffixed)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -----------------------------------------------------------------------
# Config (user state)
# -----------------------------------------------------------------------

def make_config(
    map_stem: str,
    map_name: str,
    affine: dict | None,
    overrides: list[dict] | None = None,
    metadata: dict | None = None,
) -> dict:
    """Build a fresh config dict (schema v1) with the given fields.

    `affine` may be None (e.g., a no_png map that has nothing to project).
    `overrides` defaults to empty list.
    """
    return {
        "schema_version": CONFIG_SCHEMA_VERSION,
        "map_stem": map_stem,
        "map_name": map_name,
        "affine": affine,
        "overrides": list(overrides) if overrides else [],
        "metadata": dict(metadata) if metadata else {
            "tier_at_last_render": None,
            "first_calibrated": None,
            "last_modified": utc_now_iso(),
        },
    }


def make_affine(
    world_rect: tuple[float, float, float, float],
    *,
    x_flipped: bool = False,
    y_flipped: bool = False,
    source: str,
    rmse_max: float | None = None,
    detector: str | None = None,
) -> dict:
    """Build an affine dict in the canonical form.

    `world_rect = (x_min, x_max, z_min, z_max)`.
    """
    x_min, x_max, z_min, z_max = world_rect
    return {
        "world_rect": {
            "min": {"x": float(x_min), "z": float(z_min)},
            "max": {"x": float(x_max), "z": float(z_max)},
        },
        "x_flipped": bool(x_flipped),
        "y_flipped": bool(y_flipped),
        "source": source,
        "rmse_max": (float(rmse_max) if rmse_max is not None else None),
        "detector": detector,
    }


def make_override(
    obj_uid: str,
    obj_class: str,
    world_x: float,
    world_z: float,
    pixel_x: float,
    pixel_y: float,
    set_at: str | None = None,
) -> dict:
    """Build an override entry in the canonical form."""
    return {
        "obj_uid": obj_uid,
        "obj_class": obj_class,
        "world": {"x": float(world_x), "z": float(world_z)},
        "pixel": {"x": float(pixel_x), "y": float(pixel_y)},
        "set_at": set_at or utc_now_iso(),
    }


def config_path(stem: str) -> Path:
    return CONFIGS_DIR / f"{stem.lower()}.config.json"


def load_config(stem: str) -> dict | None:
    p = config_path(stem)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"WARN: failed to parse {p}: {e}", file=sys.stderr)
        return None


def save_config(cfg: dict) -> Path:
    """Write a config to its canonical path. Updates `metadata.last_modified`."""
    stem = cfg["map_stem"].lower()
    cfg.setdefault("metadata", {})
    cfg["metadata"]["last_modified"] = utc_now_iso()
    p = config_path(stem)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n",
                 encoding="utf-8")
    return p


# -----------------------------------------------------------------------
# Map data (BZN-derived)
# -----------------------------------------------------------------------

def make_map_data(
    map_stem: str,
    map_name: str,
    iondriver_png_rel: str | None,
    iondriver_dim: tuple[int, int] | None,
    objects: list[dict],
) -> dict:
    """Build a map_data dict in canonical form.

    `objects` is a list of {uid, kind, obj_class, world: {x,z}} entries.
    Object UIDs are `<kind>#<index>`, indexed within that kind starting
    at 0 in BZN order.
    """
    iw, ih = (iondriver_dim if iondriver_dim else (None, None))
    return {
        "schema_version": MAP_DATA_SCHEMA_VERSION,
        "map_stem": map_stem,
        "map_name": map_name,
        "iondriver_png_rel": iondriver_png_rel,
        "iondriver_dim": [iw, ih] if iw and ih else None,
        "objects": list(objects),
    }


def make_object(uid: str, kind: str, obj_class: str,
                world_x: float, world_z: float) -> dict:
    return {
        "uid": uid,
        "kind": kind,
        "obj_class": obj_class,
        "world": {"x": float(world_x), "z": float(world_z)},
    }


def map_data_path(stem: str) -> Path:
    return MAP_DATA_DIR / f"{stem.lower()}.json"


def load_map_data(stem: str) -> dict | None:
    p = map_data_path(stem)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"WARN: failed to parse {p}: {e}", file=sys.stderr)
        return None


def save_map_data(md: dict) -> Path:
    stem = md["map_stem"].lower()
    p = map_data_path(stem)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(md, indent=2, ensure_ascii=False) + "\n",
                 encoding="utf-8")
    return p


# -----------------------------------------------------------------------
# Object UID derivation
# -----------------------------------------------------------------------

def build_object_uids(bzn_objects: Iterable[Any]) -> list[dict]:
    """From a list of analyze_map.GameObject (or dict-like with
    .kind/.obj_class/.position), produce the canonical objects list for
    map_data with deterministic UIDs.

    UID format: `<kind>#<index_within_kind>` where index is 0-based, in
    the iteration order of `bzn_objects` (typically BZN file order).

    Only objects with a non-null `position` AND kind in OVERLAY_KINDS
    get a UID - the calibration tool only renders/handles those kinds.
    """
    out: list[dict] = []
    kind_counts: dict[str, int] = {}
    for o in bzn_objects:
        if o.position is None:
            continue
        if o.kind not in OVERLAY_KINDS:
            continue
        idx = kind_counts.get(o.kind, 0)
        kind_counts[o.kind] = idx + 1
        uid = f"{o.kind}#{idx}"
        out.append(make_object(uid, o.kind, o.obj_class,
                              o.position[0], o.position[2]))
    return out


# Kinds the overlay/calibration tool cares about. Pools and spawns are
# the calibration anchors; loose_scrap is the bulk noisy data the user
# tunes via multi-select. Other kinds (starting_unit, pilot, recycler,
# ai_path, marker, etc.) are excluded from the calibration UI because
# they tend to add noise without value.
OVERLAY_KINDS = ("scrap_pool", "spawn_point", "loose_scrap")


# -----------------------------------------------------------------------
# Tier derivation
# -----------------------------------------------------------------------

def derive_tier(cfg: dict) -> str:
    """Return the tier ID for a given config.

    Logic (highest priority first):
      - has overrides    -> hand_cal
      - no affine        -> no_png  (no PNG to overlay on)
      - affine.source...
          auto_proven           -> proven
          auto_borderline       -> borderline
          auto_failed_fallback  -> failed
          hand_calibrated       -> hand_cal
          hand_migrated         -> hand_cal
          (anything else)       -> failed
    """
    if cfg.get("overrides"):
        return TIER_HAND_CAL
    affine = cfg.get("affine")
    if affine is None:
        return TIER_NO_PNG
    src = affine.get("source")
    return {
        SOURCE_AUTO_PROVEN:          TIER_PROVEN,
        SOURCE_AUTO_BORDERLINE:      TIER_BORDERLINE,
        SOURCE_AUTO_FAILED_FALLBACK: TIER_FAILED,
        SOURCE_HAND_CALIBRATED:      TIER_HAND_CAL,
        SOURCE_HAND_MIGRATED:        TIER_HAND_CAL,
    }.get(src, TIER_FAILED)


# -----------------------------------------------------------------------
# World/pixel projection (the affine projection used by render_overlays
# and (in JS form) by calibrate.html). Pure math; no I/O.
# -----------------------------------------------------------------------

def project_world_to_pixel(
    world_x: float, world_z: float,
    affine: dict,
    image_dim: tuple[int, int],
) -> tuple[float, float]:
    """Project (world_x, world_z) -> (pixel_x, pixel_y) using the affine.

    Mirrors the JS implementation in calibration/js/shared.js exactly so both
    paths produce identical pixel positions.

    Standard convention:
      px = (world_x - x_min) / (x_max - x_min) * image_w   [flip if x_flipped]
      py = (z_max - world_z) / (z_max - z_min) * image_h   [flip if y_flipped]
    """
    rect = affine["world_rect"]
    x_min = float(rect["min"]["x"])
    x_max = float(rect["max"]["x"])
    z_min = float(rect["min"]["z"])
    z_max = float(rect["max"]["z"])
    w, h = image_dim
    u = (world_x - x_min) / (x_max - x_min) if x_max != x_min else 0.5
    v = (z_max - world_z) / (z_max - z_min) if z_max != z_min else 0.5
    if affine.get("x_flipped"):
        u = 1.0 - u
    if affine.get("y_flipped"):
        v = 1.0 - v
    return u * w, v * h


# -----------------------------------------------------------------------
# Migration helpers
# -----------------------------------------------------------------------

def migrate_legacy_calibration_json(legacy_path: Path, stem: str,
                                    map_name: str) -> dict | None:
    """Migrate the pre-restructure `vsrmaplist/<MapName>/calibration.json`
    shape into a current v1 config.

    Legacy schema:
        {
          "image_calibration": {
            "image_bounds_world": {
              "min": {"x": -667, "z": -627},
              "max": {"x": 578,  "z": 627}
            },
            "note": "..."
          }
        }

    Returns None if the legacy file can't be read / understood.
    """
    if not legacy_path.is_file():
        return None
    try:
        data = json.loads(legacy_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"WARN: legacy parse {legacy_path}: {e}", file=sys.stderr)
        return None
    inner = data.get("image_calibration") or data
    ibw = inner.get("image_bounds_world") if isinstance(inner, dict) else None
    if not ibw:
        return None
    mn, mx = ibw.get("min", {}), ibw.get("max", {})
    try:
        x_min, x_max = float(mn["x"]), float(mx["x"])
        z_min, z_max = float(mn["z"]), float(mx["z"])
    except (KeyError, TypeError, ValueError):
        return None
    affine = make_affine(
        (x_min, x_max, z_min, z_max),
        x_flipped=False, y_flipped=False,
        source=SOURCE_HAND_MIGRATED,
        rmse_max=None,
        detector=None,
    )
    cfg = make_config(stem, map_name, affine)
    cfg["metadata"]["first_calibrated"] = utc_now_iso()
    return cfg


if __name__ == "__main__":
    # Smoke test: make a config, write it, read it back.
    test_cfg = make_config(
        "smoke_test", "Smoke Test",
        affine=make_affine((-100, 100, -100, 100),
                          source=SOURCE_AUTO_PROVEN, rmse_max=0.5,
                          detector="local_contrast_r3_nms4"),
    )
    print(json.dumps(test_cfg, indent=2))
    print()
    print(f"tier: {derive_tier(test_cfg)}")
    px, py = project_world_to_pixel(50, 50, test_cfg["affine"], (256, 256))
    print(f"project (50, 50) -> ({px:.2f}, {py:.2f})  (expected (192, 64))")
