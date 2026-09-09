"""Bake-to-minimap image registration.

Solves the iondriver minimap's world_rect AND flip orientation together by
registering the .TER paint bake (`data/render/<stem>.color.png`, row 0 = south)
plus the heightmap against `data/maps/<stem>.png`.

Search is constrained: BZN pool/spawn bbox supplies the center (empirically
the world_rect center on proven maps); a square window of side
`k * max(obj_w, obj_d)` is scored against the square minimap at 4 flip
hypotheses via equal-size NCC on combined height+color gradient images.
A free sliding search over the whole TER was tried first and locked onto
local paint patches — the May lesson, again.

180° rotational symmetry of the pool constellation makes x0y0 vs x1y1
unobservable; axis mirror symmetry makes a single flip a no-op. The
validation gate excludes those axes. Ambiguous fallback writes prefer
the unflipped pair.

CLI:
    python _map-analysis/scripts/register_minimap.py --validate
    python _map-analysis/scripts/register_minimap.py --apply-fallback --played-only
    python _map-analysis/scripts/register_minimap.py --apply-fallback --played-only --write
    python _map-analysis/scripts/register_minimap.py --maps vsrravine,vsrpstrgle
    python _map-analysis/scripts/register_minimap.py --write-stems vsrfoo,vsrbar
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import (  # noqa: E402
    CONFIGS_DIR,
    DATA_MAPS_DIR,
    PROJECT_ROOT,
    RENDER_DATA_DIR,
)
from _schema import (  # noqa: E402
    SOURCE_AUTO_FAILED_FALLBACK,
    SOURCE_AUTO_PROVEN,
    SOURCE_AUTO_REGISTERED,
    load_config,
    load_map_data,
    make_affine,
    save_config,
    utc_now_iso,
)


DETECTOR_NAME = "bake_minimap_registration"

# Square-window scale relative to the long side of the pool/spawn bbox.
K_MIN = 1.10
K_MAX = 2.70
K_COARSE = 16
K_REFINE_STEPS = 11
K_REFINE_SPAN = 0.12
CENTER_JITTER = (0.0, -0.06, 0.06)  # fraction of side, refine only
PREP_LONG = 96

HIGH_CONF_MIN_SCORE = 0.20
HIGH_CONF_MIN_MARGIN = 0.030
TIE_EPS = 0.012  # treat scores this close as a tie (prefer fewer flips)

VAL_CENTER_TOL_FRAC = 0.08
VAL_SIZE_TOL_FRAC = 0.12
VAL_MIN_FLIP_MATCH_STRICT = 0.90
VAL_MIN_RECT_MATCH = 0.80

SYM_TOL_M = 20.0
SYM_MIN_POINTS = 4
SYM_MIN_PAIR_FRAC = 0.90

AUDIT_DIR = PROJECT_ROOT / "_map-analysis" / "calibration" / "registration"
MATCHES_JSON = PROJECT_ROOT / "data" / "processed" / "matches.json"

FLIP_COMBOS = (
    (False, False),
    (True, False),
    (False, True),
    (True, True),
)


# -----------------------------------------------------------------------
# Image helpers
# -----------------------------------------------------------------------

def gradient_mag(im: Image.Image, long_side: int | None = None) -> np.ndarray:
    g = ImageOps.equalize(im.convert("L"))
    if long_side is not None:
        w, h = g.size
        long = max(w, h)
        if long != long_side and long > 0:
            s = long_side / long
            g = g.resize((max(8, int(round(w * s))), max(8, int(round(h * s)))),
                         Image.Resampling.BILINEAR)
    g = g.filter(ImageFilter.GaussianBlur(radius=0.7))
    arr = np.asarray(g, dtype=np.float32)
    gy, gx = np.gradient(arr)
    mag = np.hypot(gx, gy)
    peak = float(mag.max())
    if peak > 1e-6:
        mag /= peak
    return mag


def orient_bake(im: Image.Image, x_flipped: bool, y_flipped: bool) -> Image.Image:
    """South-up bake -> minimap UV space for this flip combo."""
    out = im
    if not y_flipped:
        out = out.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    if x_flipped:
        out = out.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return out


def ncc_scalar(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        ai = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
        ai = ai.resize((b.shape[1], b.shape[0]), Image.Resampling.BILINEAR)
        a = np.asarray(ai, dtype=np.float32) / 255.0
    aa = a.astype(np.float64) - float(a.mean())
    bb = b.astype(np.float64) - float(b.mean())
    denom = math.sqrt(float((aa * aa).sum()) * float((bb * bb).sum()))
    if denom < 1e-8:
        return 0.0
    return float((aa * bb).sum() / denom)


def load_height_image(stem: str) -> tuple[Image.Image, dict]:
    payload = json.loads(
        (RENDER_DATA_DIR / f"{stem}.3d.json").read_text(encoding="utf-8")
    )
    hm = payload["heightmap"]
    cx, cz = int(hm["cells_x"]), int(hm["cells_z"])
    raw = np.frombuffer(base64.b64decode(hm["data"]), dtype="<i2")
    h = raw.reshape(cz, cx).astype(np.float32)
    gy, gx = np.gradient(h)
    mag = np.hypot(gx, gy)
    peak = float(mag.max())
    if peak > 1e-6:
        mag = mag / peak
    img = Image.fromarray((np.clip(mag, 0, 1) * 255).astype(np.uint8), "L").convert("RGB")
    ox = float(hm["world_origin"]["x"])
    oz = float(hm["world_origin"]["z"])
    bounds = {
        "minx": ox,
        "minz": oz,
        "maxx": ox + float(hm["cell_meters_x"]) * cx,
        "maxz": oz + float(hm["cell_meters_z"]) * cz,
    }
    return img, bounds


def crop_world(im: Image.Image, bounds: dict, rect: dict) -> Image.Image:
    """Crop a south-up world-aligned image to a world_rect."""
    w, h = im.size
    ww = bounds["maxx"] - bounds["minx"]
    wd = bounds["maxz"] - bounds["minz"]
    u0 = (rect["min"]["x"] - bounds["minx"]) / ww if ww else 0.0
    u1 = (rect["max"]["x"] - bounds["minx"]) / ww if ww else 1.0
    v0 = (rect["min"]["z"] - bounds["minz"]) / wd if wd else 0.0  # south = top
    v1 = (rect["max"]["z"] - bounds["minz"]) / wd if wd else 1.0
    left = int(round(u0 * w))
    right = int(round(u1 * w))
    top = int(round(v0 * h))
    bottom = int(round(v1 * h))
    left, right = max(0, min(left, w - 1)), max(left + 1, min(right, w))
    top, bottom = max(0, min(top, h - 1)), max(top + 1, min(bottom, h))
    return im.crop((left, top, right, bottom))


def combined_grad(color_crop: Image.Image, height_crop: Image.Image,
                  mini_g: np.ndarray) -> np.ndarray:
    c = gradient_mag(color_crop, PREP_LONG)
    h = gradient_mag(height_crop, PREP_LONG)
    if h.shape != c.shape:
        hi = Image.fromarray((np.clip(h, 0, 1) * 255).astype(np.uint8), "L")
        hi = hi.resize((c.shape[1], c.shape[0]), Image.Resampling.BILINEAR)
        h = np.asarray(hi, dtype=np.float32) / 255.0
    ref = 0.55 * h + 0.45 * c
    return ref if ref.shape == mini_g.shape else ref


def square_rect(cx: float, cz: float, side: float) -> dict:
    hs = side / 2.0
    return {
        "min": {"x": cx - hs, "z": cz - hs},
        "max": {"x": cx + hs, "z": cz + hs},
    }


# -----------------------------------------------------------------------
# Object prior + constellation symmetry
# -----------------------------------------------------------------------

def object_points(stem: str) -> list[tuple[float, float]]:
    md = load_map_data(stem) or {}
    return [
        (float(o["world"]["x"]), float(o["world"]["z"]))
        for o in md.get("objects") or []
        if o.get("kind") in ("scrap_pool", "spawn_point") and o.get("world")
    ]


def object_center_span(stem: str) -> dict | None:
    pts = object_points(stem)
    if not pts:
        return None
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return {
        "cx": 0.5 * (min(xs) + max(xs)),
        "cz": 0.5 * (min(zs) + max(zs)),
        "span": max(max(xs) - min(xs), max(zs) - min(zs)),
    }


def _pair_frac(vals_a: list[float], vals_b: list[float], center: float, tol: float) -> float:
    pts = list(zip(vals_a, vals_b))
    if not pts:
        return 0.0
    used = [False] * len(pts)
    paired = 0
    for i, (a, b) in enumerate(pts):
        if used[i]:
            continue
        if abs(a - center) <= tol:
            used[i] = True
            paired += 1
            continue
        target = 2.0 * center - a
        best_j, best_d = -1, tol + 1.0
        for j, (aj, bj) in enumerate(pts):
            if used[j] or j == i:
                continue
            d = math.hypot(aj - target, bj - b)
            if d < best_d:
                best_d, best_j = d, j
        if best_j >= 0 and best_d <= tol:
            used[i] = True
            used[best_j] = True
            paired += 2
    return paired / len(pts)


def _rot180_frac(pts: list[tuple[float, float]], cx: float, cz: float, tol: float) -> float:
    if not pts:
        return 0.0
    used = [False] * len(pts)
    paired = 0
    for i, (x, z) in enumerate(pts):
        if used[i]:
            continue
        if math.hypot(x - cx, z - cz) <= tol:
            used[i] = True
            paired += 1
            continue
        tx, tz = 2.0 * cx - x, 2.0 * cz - z
        best_j, best_d = -1, tol + 1.0
        for j, (xj, zj) in enumerate(pts):
            if used[j] or j == i:
                continue
            d = math.hypot(xj - tx, zj - tz)
            if d < best_d:
                best_d, best_j = d, j
        if best_j >= 0 and best_d <= tol:
            used[i] = True
            used[best_j] = True
            paired += 2
    return paired / len(pts)


def constellation_symmetry(stem: str) -> dict:
    pts = object_points(stem)
    empty = {
        "n": len(pts),
        "x_symmetric": False,
        "z_symmetric": False,
        "rot180_symmetric": False,
        "x_center": None,
        "z_center": None,
        "x_pair_frac": 0.0,
        "z_pair_frac": 0.0,
        "rot180_pair_frac": 0.0,
    }
    if len(pts) < SYM_MIN_POINTS:
        return empty
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]

    def best_axis(primary, secondary):
        candidates = [
            0.5 * (min(primary) + max(primary)),
            float(np.median(primary)),
            float(np.mean(primary)),
        ]
        best_c, best_f = candidates[0], -1.0
        for c in candidates:
            f = _pair_frac(primary, secondary, c, SYM_TOL_M)
            if f > best_f:
                best_f, best_c = f, c
        return best_c, best_f

    xc, xf = best_axis(xs, zs)
    zc, zf = best_axis(zs, xs)
    r180 = _rot180_frac(pts, xc, zc, SYM_TOL_M)
    return {
        "n": len(pts),
        "x_symmetric": xf >= SYM_MIN_PAIR_FRAC,
        "z_symmetric": zf >= SYM_MIN_PAIR_FRAC,
        "rot180_symmetric": r180 >= SYM_MIN_PAIR_FRAC,
        "x_center": xc,
        "z_center": zc,
        "x_pair_frac": xf,
        "z_pair_frac": zf,
        "rot180_pair_frac": r180,
    }


def rect_metrics(a: dict, b: dict) -> dict:
    def mid(r):
        return (
            0.5 * (r["min"]["x"] + r["max"]["x"]),
            0.5 * (r["min"]["z"] + r["max"]["z"]),
        )
    def size(r):
        return (
            abs(r["max"]["x"] - r["min"]["x"]),
            abs(r["max"]["z"] - r["min"]["z"]),
        )
    acx, acz = mid(a)
    bcx, bcz = mid(b)
    aw, ad = size(a)
    bw, bd = size(b)
    return {
        "dx": acx - bcx,
        "dz": acz - bcz,
        "center_frac": math.hypot(acx - bcx, acz - bcz) / max(1e-6, math.hypot(bw, bd) * 0.5),
        "width_frac": abs(aw - bw) / max(1e-6, bw),
        "depth_frac": abs(ad - bd) / max(1e-6, bd),
    }


# -----------------------------------------------------------------------
# Search
# -----------------------------------------------------------------------

def _score_candidate(color, himg, bounds, mini_g, rect, xf, yf) -> float:
    crop_c = crop_world(color, bounds, rect)
    crop_h = crop_world(himg, bounds, rect)
    oc = orient_bake(crop_c, xf, yf)
    oh = orient_bake(crop_h, xf, yf)
    ref = combined_grad(oc, oh, mini_g)
    return ncc_scalar(ref, mini_g)


def register_map(stem: str) -> dict:
    """Run registration for one map. Never writes configs."""
    stem = stem.lower()
    color_path = RENDER_DATA_DIR / f"{stem}.color.png"
    mini_path = DATA_MAPS_DIR / f"{stem}.png"
    json_path = RENDER_DATA_DIR / f"{stem}.3d.json"
    if not color_path.is_file():
        return {"stem": stem, "ok": False, "error": f"missing {color_path.name}"}
    if not mini_path.is_file():
        return {"stem": stem, "ok": False, "error": f"missing minimap PNG"}
    if not json_path.is_file():
        return {"stem": stem, "ok": False, "error": f"missing {json_path.name}"}

    color = Image.open(color_path).convert("RGB")
    himg, bounds = load_height_image(stem)
    mini = Image.open(mini_path).convert("RGB")
    mini_g = gradient_mag(mini, PREP_LONG)

    ob = object_center_span(stem)
    ter_w = bounds["maxx"] - bounds["minx"]
    ter_d = bounds["maxz"] - bounds["minz"]
    ter_side = max(ter_w, ter_d)
    if ob and ob["span"] >= 32:
        cx, cz, span = ob["cx"], ob["cz"], ob["span"]
    else:
        cx = 0.5 * (bounds["minx"] + bounds["maxx"])
        cz = 0.5 * (bounds["minz"] + bounds["maxz"])
        span = 0.55 * ter_side

    ks = [float(k) for k in np.geomspace(K_MIN, K_MAX, K_COARSE)]
    coarse = []
    for k in ks:
        rect = square_rect(cx, cz, span * k)
        for xf, yf in FLIP_COMBOS:
            sc = _score_candidate(color, himg, bounds, mini_g, rect, xf, yf)
            coarse.append((sc, xf, yf, k, 0.0, 0.0, rect))
    coarse.sort(key=lambda t: t[0], reverse=True)
    best0 = coarse[0]
    k0 = best0[3]

    k_lo, k_hi = max(K_MIN, k0 - K_REFINE_SPAN), min(K_MAX, k0 + K_REFINE_SPAN)
    ks_r = [float(k) for k in np.linspace(k_lo, k_hi, K_REFINE_STEPS)]
    refined = []
    for k in ks_r:
        for jx in CENTER_JITTER:
            for jz in CENTER_JITTER:
                rect = square_rect(cx + jx * span * k, cz + jz * span * k, span * k)
                for xf, yf in FLIP_COMBOS:
                    sc = _score_candidate(color, himg, bounds, mini_g, rect, xf, yf)
                    refined.append((sc, xf, yf, k, jx, jz, rect))
    refined.sort(key=lambda t: t[0], reverse=True)

    # Per-flip best (for margin + all_flips)
    per_flip = {}
    for row in refined:
        key = (row[1], row[2])
        if key not in per_flip or row[0] > per_flip[key][0]:
            per_flip[key] = row
    ranked = sorted(per_flip.values(), key=lambda t: t[0], reverse=True)
    best = ranked[0]
    other = [r for r in ranked if (r[1], r[2]) != (best[1], best[2])]
    margin = best[0] - (other[0][0] if other else 0.0)

    score, xf, yf, k, jx, jz, rect = best
    sym = constellation_symmetry(stem)
    runner_is_sym = False
    if other:
        oxf, oyf = other[0][1], other[0][2]
        if (xf != oxf and yf == oyf and sym["x_symmetric"]) or \
           (yf != oyf and xf == oxf and sym["z_symmetric"]) or \
           (xf != oxf and yf != oyf and sym["rot180_symmetric"]):
            runner_is_sym = True

    high_conf = (
        score >= HIGH_CONF_MIN_SCORE
        and (margin >= HIGH_CONF_MIN_MARGIN or runner_is_sym)
    )

    cfg = load_config(stem) or {}
    affine = cfg.get("affine") or {}
    stored_rect = affine.get("world_rect")
    stored_xf = bool(affine.get("x_flipped", False))
    stored_yf = bool(affine.get("y_flipped", False))
    cmp_ = rect_metrics(rect, stored_rect) if stored_rect else None

    return {
        "stem": stem,
        "ok": True,
        "error": None,
        "x_flipped": xf,
        "y_flipped": yf,
        "score": score,
        "margin": margin,
        "k": k,
        "high_confidence": high_conf,
        "runner_is_symmetric": runner_is_sym,
        "world_rect": rect,
        "ter_bounds": {
            "min": {"x": bounds["minx"], "z": bounds["minz"]},
            "max": {"x": bounds["maxx"], "z": bounds["maxz"]},
        },
        "object_prior": ob,
        "symmetry": sym,
        "all_flips": [
            {"x_flipped": r[1], "y_flipped": r[2], "score": r[0], "k": r[3]}
            for r in ranked
        ],
        "stored": {
            "source": affine.get("source"),
            "x_flipped": stored_xf,
            "y_flipped": stored_yf,
            "world_rect": stored_rect,
        },
        "vs_stored": cmp_,
        "bounds": bounds,
    }


def render_audit_sheet(stem: str, result: dict, dest: Path) -> Path | None:
    """3-panel: bake crop (oriented) | minimap | 50/50 blend."""
    if not result.get("ok"):
        return None
    color = Image.open(RENDER_DATA_DIR / f"{stem}.color.png").convert("RGB")
    bounds = result["bounds"]
    crop = crop_world(color, bounds, result["world_rect"])
    oriented = orient_bake(crop, result["x_flipped"], result["y_flipped"])
    mini = Image.open(DATA_MAPS_DIR / f"{stem}.png").convert("RGB")
    panel_w, panel_h = mini.size
    crop_r = oriented.resize((panel_w, panel_h), Image.Resampling.BILINEAR)
    blend = Image.blend(crop_r.convert("RGB"), mini, 0.5)

    pad, label_h = 8, 28
    W = panel_w * 3 + pad * 4
    H = panel_h + pad * 2 + label_h + 22
    sheet = Image.new("RGB", (W, H), (18, 20, 24))
    draw = ImageDraw.Draw(sheet)
    title = (
        f"{stem}  x{int(result['x_flipped'])}y{int(result['y_flipped'])}  "
        f"ncc={result['score']:.3f}  mar={result['margin']:.3f}  "
        f"k={result.get('k', 0):.2f}  "
        f"{'HIGH' if result['high_confidence'] else 'LOW'}"
    )
    draw.text((pad, 6), title, fill=(220, 224, 230))
    x, y = pad, label_h
    for lab, im in (("bake crop", crop_r), ("minimap", mini), ("blend", blend)):
        sheet.paste(im, (x, y))
        draw.text((x, y + panel_h + 4), lab, fill=(160, 168, 180))
        x += panel_w + pad
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest)
    return dest


def write_result(result: dict) -> Path:
    stem = result["stem"]
    cfg = load_config(stem)
    if cfg is None:
        raise FileNotFoundError(f"no config for {stem}")
    wr = result["world_rect"]
    cfg["affine"] = make_affine(
        (wr["min"]["x"], wr["max"]["x"], wr["min"]["z"], wr["max"]["z"]),
        x_flipped=result["x_flipped"],
        y_flipped=result["y_flipped"],
        source=SOURCE_AUTO_REGISTERED,
        rmse_max=None,
        detector=DETECTOR_NAME,
    )
    md = cfg.setdefault("metadata", {})
    md["registration"] = {
        "score": result["score"],
        "margin": result["margin"],
        "k": result.get("k"),
        "high_confidence": result["high_confidence"],
        "registered_at": utc_now_iso(),
    }
    return save_config(cfg)


# -----------------------------------------------------------------------
# Corpus helpers
# -----------------------------------------------------------------------

def iter_configs() -> list[dict]:
    out = []
    for p in sorted(CONFIGS_DIR.glob("*.config.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


def proven_stems() -> list[str]:
    return [
        c["map_stem"] for c in iter_configs()
        if (c.get("affine") or {}).get("source") == SOURCE_AUTO_PROVEN
    ]


def fallback_stems() -> list[str]:
    return [
        c["map_stem"] for c in iter_configs()
        if (c.get("affine") or {}).get("source") == SOURCE_AUTO_FAILED_FALLBACK
    ]


def played_stems() -> set[str]:
    if not MATCHES_JSON.is_file():
        return set()
    matches = json.loads(MATCHES_JSON.read_text(encoding="utf-8"))
    out = set()
    for m in matches:
        raw = (m.get("map") or "").lower()
        if raw.endswith(".bzn"):
            raw = raw[:-4]
        if raw:
            out.add(raw)
    return out


def flip_agrees(result: dict, stored_xf: bool, stored_yf: bool) -> bool:
    """True if recovered flip matches stored, or differs only on a free axis."""
    got_x, got_y = result["x_flipped"], result["y_flipped"]
    if (got_x, got_y) == (stored_xf, stored_yf):
        return True
    sym = result.get("symmetry") or {}
    dx, dy = got_x != stored_xf, got_y != stored_yf
    if dx and not dy and sym.get("x_symmetric"):
        return True
    if dy and not dx and sym.get("z_symmetric"):
        return True
    if dx and dy and sym.get("rot180_symmetric"):
        return True
    if sym.get("x_symmetric") and sym.get("z_symmetric"):
        return True
    return False


def rect_agrees(cmp_: dict | None) -> bool:
    if not cmp_:
        return False
    return (
        cmp_["center_frac"] <= VAL_CENTER_TOL_FRAC
        and cmp_["width_frac"] <= VAL_SIZE_TOL_FRAC
        and cmp_["depth_frac"] <= VAL_SIZE_TOL_FRAC
    )


def _is_strict(sym: dict) -> bool:
    return not (sym.get("x_symmetric") or sym.get("z_symmetric")
                or sym.get("rot180_symmetric"))


def _fmt_flip(xf: bool, yf: bool) -> str:
    return f"x{int(xf)}y{int(yf)}"


def run_validate(stems: list[str], audit: bool) -> int:
    print(f"validation gate: {len(stems)} auto_proven maps")
    rows = []
    n_strict = n_flip_ok = n_rect_ok = 0
    n_sym_x = n_sym_z = n_sym_180 = 0
    for i, stem in enumerate(stems, 1):
        r = register_map(stem)
        if audit and r.get("ok"):
            render_audit_sheet(stem, r, AUDIT_DIR / "validate" / f"{stem}.png")
        rows.append(r)
        if not r.get("ok"):
            print(f"[{i:>2}/{len(stems)}] ERR  {stem:<22s} {r.get('error')}")
            continue
        stored = r["stored"]
        f_ok = flip_agrees(r, stored["x_flipped"], stored["y_flipped"])
        r_ok = rect_agrees(r["vs_stored"])
        sym = r["symmetry"]
        if sym.get("x_symmetric"):
            n_sym_x += 1
        if sym.get("z_symmetric"):
            n_sym_z += 1
        if sym.get("rot180_symmetric"):
            n_sym_180 += 1
        if _is_strict(sym):
            n_strict += 1
            if f_ok:
                n_flip_ok += 1
        if r_ok:
            n_rect_ok += 1
        tag = "OK " if (f_ok and r_ok) else "MIS"
        print(
            f"[{i:>2}/{len(stems)}] {tag}  {stem:<22s} "
            f"got {_fmt_flip(r['x_flipped'], r['y_flipped'])}  "
            f"want {_fmt_flip(stored['x_flipped'], stored['y_flipped'])}  "
            f"ncc={r['score']:.3f}  mar={r['margin']:.3f}  k={r['k']:.2f}  "
            f"ctr={r['vs_stored']['center_frac']:.3f}  "
            f"dw={r['vs_stored']['width_frac']:.3f}  "
            f"dd={r['vs_stored']['depth_frac']:.3f}"
            f"{'  SYMx' if sym.get('x_symmetric') else ''}"
            f"{'  SYMz' if sym.get('z_symmetric') else ''}"
            f"{'  R180' if sym.get('rot180_symmetric') else ''}"
        )

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = AUDIT_DIR / "validate_report.json"
    report_path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    ok_n = sum(1 for r in rows if r.get("ok"))
    strict_flip_rate = (n_flip_ok / n_strict) if n_strict else 1.0
    rect_rate = (n_rect_ok / max(1, ok_n))
    print()
    print(f"strict (asymmetric) maps: {n_strict}")
    print(f"strict flip match:        {n_flip_ok}/{n_strict} ({strict_flip_rate:.1%})")
    print(f"rect match:               {n_rect_ok}/{ok_n} ({rect_rate:.1%})")
    print(f"x-symmetric excluded:     {n_sym_x}")
    print(f"z-symmetric excluded:     {n_sym_z}")
    print(f"rot180 excluded:          {n_sym_180}")
    print(f"report: {report_path}")
    ok = (strict_flip_rate + 1e-9) >= VAL_MIN_FLIP_MATCH_STRICT and rect_rate >= VAL_MIN_RECT_MATCH
    print("GATE:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def _gate_from_report(rows: list[dict]) -> tuple[float, float]:
    strict_ok = strict_n = rect_ok = ok_n = 0
    for r in rows:
        if not r.get("ok"):
            continue
        ok_n += 1
        stored = r.get("stored") or {}
        f_ok = flip_agrees(r, stored.get("x_flipped", False), stored.get("y_flipped", False))
        if _is_strict(r.get("symmetry") or {}):
            strict_n += 1
            if f_ok:
                strict_ok += 1
        if rect_agrees(r.get("vs_stored")):
            rect_ok += 1
    flip_rate = (strict_ok / strict_n) if strict_n else 1.0
    rect_rate = (rect_ok / ok_n) if ok_n else 0.0
    return flip_rate, rect_rate


def _prefer_fewer_flips(r: dict) -> dict:
    """If the runner-up flip is a symmetry no-op, publish the fewer-flip combo."""
    if not (r.get("runner_is_symmetric") and r.get("margin", 1) <= TIE_EPS):
        return r
    flips = r.get("all_flips") or []
    if len(flips) < 2:
        return r
    a = (bool(r["x_flipped"]), bool(r["y_flipped"]))
    b = (bool(flips[1]["x_flipped"]), bool(flips[1]["y_flipped"]))
    pick = min((a, b), key=lambda t: (int(t[0]) + int(t[1]), int(t[0]), int(t[1])))
    if pick == a:
        return r
    out = dict(r)
    out["x_flipped"], out["y_flipped"] = pick
    return out


def run_apply(stems: list[str], *, write: bool, force_stems: set[str]) -> int:
    print(f"registering {len(stems)} maps (write={write})")
    high, low, failed = [], [], []
    for i, stem in enumerate(stems, 1):
        r = register_map(stem)
        if not r.get("ok"):
            print(f"[{i:>3}/{len(stems)}] ERR  {stem:<22s} {r.get('error')}")
            failed.append(r)
            continue
        force = stem in force_stems
        if not force:
            r = _prefer_fewer_flips(r)
        render_audit_sheet(stem, r, AUDIT_DIR / "fallback" / f"{stem}.png")
        do_write = write and (r["high_confidence"] or force)
        tag = "HIGH" if r["high_confidence"] else "low "
        extra = ""
        if do_write:
            write_result(r)
            extra = "  WROTE"
        if r["high_confidence"] or (force and do_write):
            high.append(r)
        else:
            low.append(r)
        print(
            f"[{i:>3}/{len(stems)}] {tag} {stem:<22s} "
            f"{_fmt_flip(r['x_flipped'], r['y_flipped'])}  "
            f"ncc={r['score']:.3f}  mar={r['margin']:.3f}  k={r['k']:.2f}"
            f"{extra}"
        )

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    summary = {
        "high": [r["stem"] for r in high],
        "low": [r["stem"] for r in low],
        "failed": [r["stem"] for r in failed],
        "results": high + low + failed,
    }
    (AUDIT_DIR / "fallback_report.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print()
    print(f"high-confidence: {len(high)}")
    print(f"low-confidence:  {len(low)}  -> {AUDIT_DIR / 'fallback'}")
    print(f"failed:          {len(failed)}")
    if low:
        print("low-confidence stems (review audit sheets):")
        for r in low:
            print(f"  {r['stem']}  {_fmt_flip(r['x_flipped'], r['y_flipped'])}  "
                  f"ncc={r['score']:.3f}  mar={r['margin']:.3f}  k={r['k']:.2f}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--validate", action="store_true",
                    help="read-only gate on auto_proven maps")
    ap.add_argument("--apply-fallback", action="store_true",
                    help="score auto_failed_fallback maps")
    ap.add_argument("--played-only", action="store_true",
                    help="restrict --apply-fallback to maps in matches.json")
    ap.add_argument("--write", action="store_true",
                    help="persist high-confidence results (requires a passing "
                         "validate report, or --allow-write-without-gate)")
    ap.add_argument("--allow-write-without-gate", action="store_true")
    ap.add_argument("--write-stems", default="",
                    help="comma stems to force-write after human review")
    ap.add_argument("--maps", default="",
                    help="comma stems (overrides --validate/--apply-fallback set)")
    ap.add_argument("--audit", action="store_true",
                    help="also write audit sheets during --validate")
    args = ap.parse_args(argv)

    force = {s.strip().lower() for s in args.write_stems.split(",") if s.strip()}
    named = [s.strip().lower() for s in args.maps.split(",") if s.strip()]

    if args.validate:
        stems = named or proven_stems()
        if not stems:
            print("error: no auto_proven maps found", file=sys.stderr)
            return 1
        return run_validate(stems, audit=args.audit)

    if args.apply_fallback or named or force:
        if named:
            stems = named
        else:
            stems = fallback_stems()
            if args.played_only:
                played = played_stems()
                stems = [s for s in stems if s in played]
        if args.write and not args.allow_write_without_gate:
            report = AUDIT_DIR / "validate_report.json"
            if not report.is_file():
                print("error: run --validate first (no validate_report.json)",
                      file=sys.stderr)
                return 2
            rows = json.loads(report.read_text(encoding="utf-8"))
            flip_rate, rect_rate = _gate_from_report(rows)
            if flip_rate < VAL_MIN_FLIP_MATCH_STRICT or rect_rate < VAL_MIN_RECT_MATCH:
                print(
                    f"error: last --validate did not pass "
                    f"(flip {flip_rate:.1%}, rect {rect_rate:.1%}); refusing --write",
                    file=sys.stderr,
                )
                return 2
        if force and not stems:
            stems = sorted(force)
        if not stems:
            print("error: no maps to register", file=sys.stderr)
            return 1
        return run_apply(stems, write=args.write, force_stems=force)

    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
