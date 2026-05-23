"""Render overlay PNGs from per-map configs in `calibration/configs/`.

For every config:
1. Load `calibration/map_data/<stem>.json` (BZN-derived object positions).
2. Load the iondriver minimap PNG.
3. For each object: render at the override pixel if one is set,
   otherwise project via the config's affine.
4. Write the overlay to `calibration/<tier>/<stem>_overlay.png` (WITH title
   strip - browser cards).
5. Write a clean copy to `calibration/staging/<stem>.png` (NO title strip -
   eventual production export).

The detector + fallback helpers in this module (`full_solve_calibration`,
`inferred_bbox_fallback`, `derive_world_rect_from_transform`) are
imported by `init_configs.py` to generate the initial affines. This
module is the runtime-facing renderer; init is one-time bootstrap.

CLI:
  python scripts/render_overlays.py
      [--maps S1,S2,..]    only render these specific stems
      [--no-staging]       skip writing the staging/ copies
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_map import analyze_map_dir  # noqa: E402
from prove_png_calibration import (  # noqa: E402
    find_local_contrast_markers,
    match_by_brute_force,
    solve_affine_lsq,
)
from _paths import (  # noqa: E402
    CONFIGS_DIR,
    MAP_DATA_DIR,
    CALIBRATION_DIR,
    TIER_DIRS,
    STAGING_DIR,
    DATA_MAPS_DIR,
)
from _schema import (  # noqa: E402
    load_config,
    load_map_data,
    derive_tier,
    project_world_to_pixel as schema_project,
)


# Quality thresholds for the auto-detector. RMSE is in iondriver PNG pixels
# (256x256). Sub-pixel (<2) = essentially perfect; <5 = visually plausible
# but not pixel-perfect; >=5 = detector probably picked wrong markers.
RMSE_GOOD_PX = 2.0
RMSE_OK_PX = 5.0


# How the iondriver PNG is rendered for inspection.
UPSCALE = 4   # 256 -> 1024


# Quick detector sweep used for the corpus pass. Far fewer configs than
# the proof script's exhaustive sweep, but enough to catch the common
# cases. Each config runs in ~0.5s on a 256x256 PNG. We stop on the
# first config that produces a sub-pixel fit; otherwise we keep the
# best one we found.
# Full detector sweep - mirrors prove_png_calibration.py's configurations.
# Trimmed for corpus-pass speed: drop r6_nms8 (rarely the winner) and
# the achromatic r2_nms4 + r5_nms6 (achromatic-with-combinatorial is
# expensive; keep the two most-productive configs).
FULL_DETECTOR_SWEEP = [
    # (radius, nms_radius, achromatic, label)
    (2, 4, False, "r2_nms4"),
    (3, 4, False, "r3_nms4"),
    (4, 5, False, "r4_nms5"),
    (5, 6, False, "r5_nms6"),
    (3, 4, True,  "r3_nms4_white"),
    (4, 5, True,  "r4_nms5_white"),
]


# Per-map wall-clock budget (seconds). If the solver hasn't found a
# sub-pixel fit by this point, accept whatever it has and move on. Stops
# pathological maps from blocking the whole pass.
PER_MAP_BUDGET_S = 30.0


# Empirical multiplier from the 4-proof-map analysis: PNG world width is
# on average 1.43x the bounding box of placed BZN objects, with 9% relative
# std deviation. Used as the fallback when no marker detector config
# produces a plausible fit - lets us render SOMETHING reasonable so the
# user can see where the calibration is landing.
INFERRED_BBOX_MULTIPLIER = 1.43


def full_solve_calibration(stem: str, folder_name: str,
                          map_dir: Path, png_path: Path) -> dict | None:
    """Run the full prove_png_calibration sweep. Returns the affine
    transform with the lowest combined RMSE across all configurations,
    plus combinatorial subset searches for achromatic configs (which
    rescues maps where the contrast detector misranks the real pool
    markers behind false positives like lava blobs).
    """
    from itertools import combinations
    report = analyze_map_dir(map_dir)
    pools = [o for o in report.objects
             if o.kind == "scrap_pool" and o.position]
    if not pools or len(pools) < 2:
        return None
    n_pools = len(pools)
    bzn_xz = [(o.position[0], o.position[2]) for o in pools]
    im = Image.open(png_path).convert("RGB")
    png_w, png_h = im.size

    best = None
    deadline = time.time() + PER_MAP_BUDGET_S
    for radius, nms_radius, achroma, label in FULL_DETECTOR_SWEEP:
        if time.time() > deadline:
            break
        candidates = find_local_contrast_markers(
            im, n_target=n_pools, radius=radius, nms_radius=nms_radius,
            require_achromatic=achroma,
        )
        if len(candidates) < n_pools:
            continue
        # For each config: try the top-N candidates by contrast score;
        # for the achromatic configs additionally enumerate small subsets
        # of the candidate pool. We CAP the candidate pool at 10 here -
        # at C(10,7) * 7! = 604K iterations per config that's ~6s, still
        # workable per map. Beyond that the combinatorics explode.
        attempts = [tuple(range(n_pools))]
        if achroma and len(candidates) <= 10:
            for combo in combinations(range(len(candidates)), n_pools):
                if combo != tuple(range(n_pools)):
                    attempts.append(combo)
        for chosen in attempts:
            if time.time() > deadline:
                break
            pix_xy = [(candidates[i][0], candidates[i][1]) for i in chosen]
            match_result = match_by_brute_force(bzn_xz, pix_xy)
            if match_result is None:
                continue
            mapping, rmse_total = match_result
            paired_pix = [pix_xy[mapping[i]] for i in range(n_pools)]
            t = solve_affine_lsq(bzn_xz, paired_pix)
            t["png_dim"] = (png_w, png_h)
            t["detector"] = label
            if best is None or rmse_total < best.get("rmse_total", float("inf")):
                best = dict(t, rmse_total=rmse_total)
            # Early-exit on excellent fit (saves time on easy maps).
            if max(t["rmse_x"], t["rmse_y"]) < RMSE_GOOD_PX:
                return best
    return best


def inferred_bbox_fallback(map_dir: Path, png_w: int, png_h: int) -> dict | None:
    """Build a best-effort calibration when the detector fails completely.

    Uses the BZN object bounding box inflated by `INFERRED_BBOX_MULTIPLIER`
    (1.43) centered on world origin. Empirically ~10% accurate.
    """
    report = analyze_map_dir(map_dir)
    ib = report.inferred_bounds_from_objects
    if not ib:
        return None
    cx = (ib["min_x"] + ib["max_x"]) / 2
    cz = (ib["min_z"] + ib["max_z"]) / 2
    half_x = (ib["max_x"] - ib["min_x"]) / 2 * INFERRED_BBOX_MULTIPLIER
    half_z = (ib["max_z"] - ib["min_z"]) / 2 * INFERRED_BBOX_MULTIPLIER
    return {
        "world_rect": (cx - half_x, cx + half_x,
                       cz - half_z, cz + half_z),
        "x_flipped": False,
        "y_flipped": False,
        "rmse_x": float("nan"),
        "rmse_y": float("nan"),
    }
MARKER_STYLE = {
    "scrap_pool":   {"color": (255, 210, 74),  "outer_r": 9, "label": "P"},
    "spawn_point":  {"color": (93,  173, 255), "outer_r": 11, "label": "S"},
    "loose_scrap":  {"color": (126, 231, 135), "outer_r": 4, "label": ""},
}


# ---------------------------------------------------------------------------
# Calibration loaders
# ---------------------------------------------------------------------------

def load_hand_calibration(map_dir: Path) -> dict | None:
    """Read `calibration.json` from a vsrmaplist folder if present.

    Returns the normalized world rect + a 'std' orientation (hand
    calibrations don't know about axis flips, so they always assume
    standard).
    """
    cal = map_dir / "calibration.json"
    if not cal.is_file():
        return None
    try:
        data = json.loads(cal.read_text(encoding="utf-8"))
    except Exception:
        return None
    inner = data.get("image_calibration") or data
    ibw = inner.get("image_bounds_world") if isinstance(inner, dict) else None
    if not ibw:
        return None
    mn, mx = ibw.get("min"), ibw.get("max")
    if not (mn and mx):
        return None
    try:
        x0, x1 = float(mn["x"]), float(mx["x"])
        z0, z1 = float(mn["z"]), float(mx["z"])
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "source": "hand_calibration",
        "world_rect": (x0, x1, z0, z1),
        "x_flipped": False,
        "y_flipped": False,
        "rmse_x": 0.0,
        "rmse_y": 0.0,
    }


def derive_world_rect_from_transform(t: dict, png_w: int, png_h: int) -> dict:
    """Convert the detector's affine into a (x_min, x_max, z_min, z_max)
    world rect + flip flags for symmetric storage."""
    s_x, b_x = t["s_x"], t["b_x"]
    s_y, b_y = t["s_y"], t["b_y"]
    # pix=0  -> world_x = -b_x/s_x ; pix=W -> (W-b_x)/s_x
    if s_x == 0 or s_y == 0:
        return None
    x_a, x_b = -b_x / s_x, (png_w - b_x) / s_x
    z_a, z_b = -b_y / s_y, (png_h - b_y) / s_y
    return {
        "world_rect": (min(x_a, x_b), max(x_a, x_b),
                       min(z_a, z_b), max(z_a, z_b)),
        "x_flipped": s_x < 0,
        "y_flipped": s_y > 0,
        "rmse_x": t["rmse_x"],
        "rmse_y": t["rmse_y"],
        "m_per_px": 1.0 / abs(s_x) if s_x != 0 else 0.0,
    }


# ---------------------------------------------------------------------------
# Overlay rendering
# ---------------------------------------------------------------------------

def project_world_to_pixel(
    wx: float, wz: float,
    world_rect: tuple[float, float, float, float],
    out_w: int, out_h: int,
    x_flipped: bool, y_flipped: bool,
) -> tuple[float, float]:
    wx_min, wx_max, wz_min, wz_max = world_rect
    u = (wx - wx_min) / (wx_max - wx_min)
    v = 1.0 - (wz - wz_min) / (wz_max - wz_min)
    if x_flipped:
        u = 1.0 - u
    if y_flipped:
        v = 1.0 - v
    return u * out_w, v * out_h


# ---------------------------------------------------------------------------
# Config-driven overlay rendering (called by reprocess.py)
# ---------------------------------------------------------------------------

def render_from_config(stem: str, write_staging: bool = True) -> dict | None:
    """Render the tier-folder overlay + (optionally) the staging PNG for
    one map, driven entirely by `calibration/configs/<stem>.config.json` +
    `calibration/map_data/<stem>.json`.

    Returns a result dict {tier, n_pools, n_spawns, n_loose,
                           overlay_path, staging_path, error?} or None if
    the config can't even be loaded.
    """
    cfg = load_config(stem)
    if cfg is None:
        return None
    md = load_map_data(stem)
    if md is None:
        return {"stem": stem, "tier": "no_png", "error": "no map_data"}

    affine = cfg.get("affine")
    tier = derive_tier(cfg)

    # no_png maps: nothing to render. Still useful to report.
    iondriver_rel = md.get("iondriver_png_rel")
    if not iondriver_rel or affine is None:
        return {"stem": stem, "tier": "no_png",
                "n_pools": 0, "n_spawns": 0, "n_loose": 0,
                "overlay_path": None, "staging_path": None}

    # Resolve iondriver PNG path. `iondriver_png_rel` is stored as a
    # path relative to CALIBRATION_DIR (so the browser can use it directly
    # as an `<img src>` from calibrate.html). Python anchors at CALIBRATION_DIR.
    iondriver_png = (CALIBRATION_DIR / iondriver_rel).resolve()
    if not iondriver_png.is_file():
        return {"stem": stem, "tier": tier,
                "error": f"iondriver PNG not found: {iondriver_png}"}

    base = Image.open(iondriver_png).convert("RGB")
    base_w, base_h = base.size
    up = base.resize((base_w * UPSCALE, base_h * UPSCALE),
                     Image.LANCZOS).convert("RGBA")
    out_w, out_h = up.size

    overrides_by_uid = {o["obj_uid"]: o for o in (cfg.get("overrides") or [])}

    # Project every overlayable object.
    counts = {"scrap_pool": 0, "spawn_point": 0, "loose_scrap": 0}
    layer_order = ("loose_scrap", "spawn_point", "scrap_pool")
    placements: dict[str, list[tuple[float, float, bool]]] = {
        k: [] for k in layer_order
    }
    for obj in (md.get("objects") or []):
        kind = obj.get("kind")
        if kind not in placements:
            continue
        uid = obj["uid"]
        if uid in overrides_by_uid:
            ov = overrides_by_uid[uid]
            # Override pixel is in iondriver-native pixel coords; scale to
            # the upscaled canvas.
            px = float(ov["pixel"]["x"]) * UPSCALE
            py = float(ov["pixel"]["y"]) * UPSCALE
            is_override = True
        else:
            wx = float(obj["world"]["x"])
            wz = float(obj["world"]["z"])
            base_px, base_py = schema_project(wx, wz, affine, (base_w, base_h))
            px = base_px * UPSCALE
            py = base_py * UPSCALE
            is_override = False
        if 0 <= px < out_w and 0 <= py < out_h:
            placements[kind].append((px, py, is_override))
            counts[kind] += 1

    def draw_markers(canvas: Image.Image) -> None:
        d = ImageDraw.Draw(canvas, "RGBA")
        for kind in layer_order:
            style = MARKER_STYLE.get(kind)
            if not style:
                continue
            color = style["color"]
            r = style["outer_r"]
            for px, py, is_override in placements[kind]:
                # Overrides get a brighter fill so they pop slightly.
                fill_alpha = 150 if is_override else 110
                pad = 2 if is_override else 0
                d.ellipse(
                    [px - r - pad, py - r - pad,
                     px + r + pad, py + r + pad],
                    fill=(*color, fill_alpha),
                    outline=(*color, 255), width=2,
                )
                d.ellipse(
                    [px - 1, py - 1, px + 1, py + 1],
                    fill=(0, 0, 0, 255),
                )

    # Clean staging copy (no title strip).
    staging_path = STAGING_DIR / f"{stem}.png"
    if write_staging:
        staging_canvas = up.copy()
        draw_markers(staging_canvas)
        staging_path.parent.mkdir(parents=True, exist_ok=True)
        staging_canvas.convert("RGB").save(staging_path)

    # Tier-folder copy with title strip on top.
    tier_dir = TIER_DIRS[tier]
    overlay_path = tier_dir / f"{stem}_overlay.png"
    tier_canvas = up.copy()
    draw_markers(tier_canvas)
    label = _build_label(cfg, counts)
    d = ImageDraw.Draw(tier_canvas, "RGBA")
    d.rectangle([0, 0, out_w, 26], fill=(16, 18, 22, 230))
    d.text((8, 6), label, fill="#ffffff")
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    tier_canvas.convert("RGB").save(overlay_path)

    return {
        "stem": stem,
        "tier": tier,
        "n_pools": counts["scrap_pool"],
        "n_spawns": counts["spawn_point"],
        "n_loose": counts["loose_scrap"],
        "overlay_path": str(overlay_path),
        "staging_path": str(staging_path) if write_staging else None,
    }


def _build_label(cfg: dict, counts: dict) -> str:
    affine = cfg.get("affine") or {}
    src = affine.get("source")
    rmse = affine.get("rmse_max")
    n_overrides = len(cfg.get("overrides") or [])
    name = cfg.get("map_name") or cfg.get("map_stem", "?")
    parts = [name]
    if n_overrides > 0:
        parts.append(f"hand-cal, {n_overrides} override(s)")
    elif src == "hand_migrated":
        parts.append("hand-migrated")
    elif src == "auto_proven":
        parts.append(f"auto-proven (RMSE {rmse:.2f}px)"
                     if rmse is not None else "auto-proven")
    elif src == "auto_borderline":
        parts.append(f"borderline (RMSE {rmse:.2f}px)"
                     if rmse is not None else "borderline")
    elif src == "auto_failed_fallback":
        parts.append("FAILED - bbox x 1.43 fallback")
    counts_str = (f"{counts.get('scrap_pool', 0)} pools, "
                  f"{counts.get('spawn_point', 0)} spawns, "
                  f"{counts.get('loose_scrap', 0)} loose")
    return f"  {' - '.join(parts)}  -  {counts_str}"


def clear_tier_dirs() -> None:
    """Wipe all PNG files in tier folders so stale overlays from old
    runs don't accumulate (a map can shift between tiers)."""
    for tier_dir in TIER_DIRS.values():
        if not tier_dir.is_dir():
            continue
        for f in tier_dir.glob("*.png"):
            try:
                f.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Render overlays from configs")
    ap.add_argument("--maps", default=None,
                    help="Comma-separated stems to render; skip everything else.")
    ap.add_argument("--no-staging", action="store_true",
                    help="Skip writing the staging/ copies.")
    args = ap.parse_args(argv)

    if not CONFIGS_DIR.is_dir():
        print(f"error: {CONFIGS_DIR} not found - run init_configs.py first",
              file=sys.stderr)
        return 1

    if args.maps:
        stems_to_render = [s.strip().lower()
                           for s in args.maps.split(",") if s.strip()]
    else:
        stems_to_render = sorted(
            cfg.stem.removesuffix(".config")
            for cfg in CONFIGS_DIR.glob("*.config.json")
        )

    if not stems_to_render:
        print("error: nothing to render", file=sys.stderr)
        return 1

    print(f"Rendering overlays for {len(stems_to_render)} maps")
    print(f"  CONFIGS_DIR: {CONFIGS_DIR}")
    print(f"  STAGING_DIR: {STAGING_DIR}")
    if args.no_staging:
        print(f"  --no-staging: skipping staging/ copies")
    print()

    # Full-corpus passes wipe stale overlays in tier dirs.
    if not args.maps:
        clear_tier_dirs()

    counts: dict[str, int] = {k: 0 for k in TIER_DIRS}
    counts["error"] = 0
    start = time.time()
    for i, stem in enumerate(stems_to_render, 1):
        try:
            r = render_from_config(stem, write_staging=not args.no_staging)
        except Exception as e:
            print(f"[{i:>3}/{len(stems_to_render)}] {stem:<28s} ERROR: {e}",
                  file=sys.stderr)
            counts["error"] += 1
            continue
        if r is None:
            print(f"[{i:>3}/{len(stems_to_render)}] {stem:<28s} ERROR: "
                  f"no config", file=sys.stderr)
            counts["error"] += 1
            continue
        if "error" in r:
            print(f"[{i:>3}/{len(stems_to_render)}] {stem:<28s} ERROR: "
                  f"{r['error']}", file=sys.stderr)
            counts["error"] += 1
            continue
        tier = r["tier"]
        counts[tier] = counts.get(tier, 0) + 1
        marker_count = (r['n_pools'] + r['n_spawns'] + r['n_loose'])
        print(f"[{i:>3}/{len(stems_to_render)}] {stem:<28s} "
              f"-> {tier:<10s} ({marker_count} markers)")

    elapsed = time.time() - start
    print()
    print(f"Done in {elapsed:.1f}s")
    for tier in ("proven", "borderline", "hand_cal", "failed", "no_png"):
        print(f"  {tier:<11s}: {counts.get(tier, 0)}")
    if counts["error"]:
        print(f"  errors:      {counts['error']}")
    print(f"  TOTAL:       {len(stems_to_render)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

