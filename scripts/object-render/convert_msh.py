"""
convert_msh.py -- offline BZCC baked `.msh` -> glTF `.glb` converter + dual
texture-set + static-gallery generator for the object-render asset pipeline.

Scales the original 4-model POC to EVERY renderable BZCC model: every ODF
`GameObjectClass.geometryName` plus every weapon/ordnance `shotGeometry` that
resolves to a baked `.msh` across the base game + the VSR config mod + every
workshop asset/model pack (the same roots `_map-analysis/scripts/bz2_paths.py`
walks). ~700 unique meshes after dedup by lowercased mesh stem.

Per model it emits ONE geometry GLB (shared by both quality modes) plus TWO
deduped diffuse texture sets, assigned at runtime by material name in the
browser (the F9bomber `unit-viewer.js` pattern):

  data/models/
    index.json                  manifest: models[] + odf_index (odf -> stem)
    geometry/<stem>.glb          geometry + UVs + per-prim materials NAMED by
                                 their lowercased diffuse stem, baseColorFactor
                                 for textureless mats, NO embedded texture
    textures/perf/<stem>.png     512px PNG (decoded via mip) -- low-VRAM default
    textures/hq/<stem>.dds       native 2048 BC .dds copied verbatim -- true max
    thumbnails/<stem>.png        hero (~256px) for the directory grid cards
    shots/<stem>/<angle>.png     7-angle HQ gallery (~512px)

Coordinate handling: baked geometry is meters, Y-up. BZCC is a DirectX
(left-handed) engine, so we convert to glTF's right-handed space by negating Z
and reversing triangle winding. Toggle with --no-handedness-fix.

Caching: a model is skipped when its glb + hero + 7 gallery shots already exist
and the glb is newer than the source .msh (prior index.json entry reused).
--force reprocesses; --limit N caps the run (smoke-test); --jobs N parallelizes
the per-model render (the bottleneck). Texture writes are idempotent + atomic so
parallel workers are safe.

Usage:
  python scripts/object-render/convert_msh.py --limit 20    # smoke run
  python scripts/object-render/convert_msh.py --jobs 8      # full run, parallel
  python scripts/object-render/convert_msh.py --odf ivscout_vsr.odf
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(PROJECT_ROOT / "_map-analysis" / "scripts"))

import msh_thumbnail  # noqa: E402
from msh_parser import parse_msh  # noqa: E402
from glb_writer import GlbBuilder  # noqa: E402
from dds_decode import decode_dds, UnsupportedDDS  # noqa: E402
from PIL import Image  # noqa: E402

try:
    import bz2_paths  # from _map-analysis/scripts
except ImportError:
    bz2_paths = None

ODF_DB = PROJECT_ROOT / "data" / "odf.min.json"
OUT_DIR = PROJECT_ROOT / "data" / "models"
GEO_DIR = OUT_DIR / "geometry"
TEX_PERF_DIR = OUT_DIR / "textures" / "perf"
TEX_HQ_DIR = OUT_DIR / "textures" / "hq"

PERF_MAX_DIM = 512       # performance PNG largest side
DECODE_MAX_DIM = 1024    # decode-once size (downscaled to perf + reused for gallery)

FACTION_NAMES = {"i": "ISDF", "e": "Hadean", "f": "Scion", "c": "Cerberi"}

# Module-global worker state (set by _worker_init for the process pool, or
# directly in the serial path). Holds the read-only indexes + run config so
# job dicts stay small + picklable.
_G: dict | None = None


# ----------------------------- enumeration -----------------------------


def _stem(name: str) -> str:
    return Path(str(name)).stem.lower()


def enumerate_targets(odf_filter=None):
    """Scan odf.min.json for every geometryName + shotGeometry. Returns a dict
    stem -> {odfs, primaryOdf, unitName, category, factionCode, factionName}."""
    db = json.loads(ODF_DB.read_text(encoding="utf-8"))
    refs: dict[str, list[dict]] = {}

    def add(stem, odf, unit, category, source):
        if not stem or stem.upper() == "NULL":
            return
        refs.setdefault(stem, []).append({
            "odf": odf, "unitName": unit or "",
            "category": category, "source": source,
        })

    for cat, entries in db.items():
        for name, blocks in entries.items():
            if not isinstance(blocks, dict):
                continue
            go = blocks.get("GameObjectClass", {}) or {}
            unit = go.get("unitName")
            geo = go.get("geometryName")
            if geo and str(geo).upper() != "NULL":
                add(_stem(geo), name, unit, cat, "geometryName")
            # shotGeometry lives in nested *OrdnanceClass blocks (dotted keys)
            for bv in blocks.values():
                if isinstance(bv, dict):
                    sg = bv.get("shotGeometry")
                    if sg and str(sg).upper() != "NULL":
                        add(_stem(sg), name, unit, "Ordnance", "shotGeometry")

    out = {}
    for stem, cands in refs.items():
        # primary: prefer a geometryName ref with a unitName, then any
        # geometryName, then anything; tie-break on shortest odf name.
        def key(c):
            rank = 0 if (c["source"] == "geometryName" and c["unitName"]) else (
                1 if c["source"] == "geometryName" else 2)
            return (rank, len(c["odf"]))
        cands_sorted = sorted(cands, key=key)
        primary = cands_sorted[0]
        odfs = sorted({c["odf"] for c in cands})
        if odf_filter and not (set(odfs) & odf_filter):
            continue
        fcode = primary["odf"][0].lower()
        if fcode not in FACTION_NAMES:
            fcode = "_"
        out[stem] = {
            "odfs": odfs,
            "primaryOdf": primary["odf"],
            "unitName": primary["unitName"] or stem,
            "category": primary["category"],
            "factionCode": fcode,
            "factionName": FACTION_NAMES.get(fcode, "Other"),
        }
    return out


def build_file_index(roots, ext):
    """stem(lower) -> Path for every *.<ext>, base-first precedence with
    LAST-WINS override (matches build_odf_db so the asset matches the ODF)."""
    idx = {}
    for path, _label in roots:
        for f in path.rglob(f"*.{ext}"):
            idx[f.stem.lower()] = f
    return idx


def resolve_roots(steam_override=None):
    if bz2_paths is not None:
        try:
            return bz2_paths.resolve_root_dirs(
                steam_override=steam_override, quiet=True)
        except SystemExit:
            pass
    fallback = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
    if fallback.is_dir():
        return [(fallback, "BZ2R fallback")]
    raise SystemExit("Could not locate the BZ2R install.")


def workshop_content_dir(steam_override=None):
    """Locate the BZCC workshop content dir (.../workshop/content/624970) so we
    can index EVERY subscribed item as a last-resort texture fallback, not just
    the VSR asset dependencies."""
    if bz2_paths is not None:
        if steam_override:
            base = Path(steam_override).expanduser().resolve()
        else:
            base = bz2_paths.detect_steam_base() or bz2_paths.STEAM_BASE_FALLBACK
        ws = base / bz2_paths.WORKSHOP_RELATIVE
        if ws.is_dir():
            return ws
    fallback = Path(
        r"C:\Program Files (x86)\Steam\steamapps\workshop\content\624970")
    return fallback if fallback.is_dir() else None


def build_workshop_index(ws_dir, ext):
    """stem(lower) -> Path for every *.<ext> across the ENTIRE workshop tree.
    first-wins (don't override; only a fallback layer)."""
    idx = {}
    if not ws_dir:
        return idx
    for f in ws_dir.rglob(f"*.{ext}"):
        idx.setdefault(f.stem.lower(), f)
    return idx


# ----------------------------- material / texture -----------------------------


def parse_material(msh_dir: Path, material_filename: str):
    """Read the [solid] diffuse RGBA + [texture] diffuse .dds name from a sibling
    (or globally-indexed) `.material` file. Returns (rgba, diffuse_dds|None)."""
    rgba = (0.8, 0.8, 0.8, 1.0)
    diffuse_dds = None
    if not material_filename:
        return rgba, diffuse_dds
    p = msh_dir / material_filename
    if not p.is_file():
        p = msh_dir / "materials" / material_filename
    if not p.is_file():
        key = _stem(material_filename)
        mat_index = _G["mat_index"] if _G else {}
        mat_index_all = _G["mat_index_all"] if _G else {}
        # VSR-scoped match wins; full-workshop is last-resort fallback.
        p = mat_index.get(key) or mat_index_all.get(key)
    if not p or not Path(p).is_file():
        return rgba, diffuse_dds
    try:
        text = Path(p).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return rgba, diffuse_dds
    section = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.lower().strip("[]")
            continue
        if "=" not in s:
            continue
        key, val = (x.strip() for x in s.split("=", 1))
        kl = key.lower()
        if section == "solid" and kl == "diffuse":
            try:
                vals = [float(x) for x in val.split()[:4]]
                while len(vals) < 4:
                    vals.append(1.0)
                rgba = tuple(vals[:4])
            except ValueError:
                pass
        elif section == "texture" and kl == "diffuse":
            diffuse_dds = val.strip()
    return rgba, diffuse_dds


def _atomic_write_bytes(path: Path, data: bytes):
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _find_diffuse_src(msh_dir: Path, dds_name: str):
    candidates = [
        msh_dir / dds_name,
        msh_dir / "textures" / dds_name,
        msh_dir.parent / "textures" / dds_name,
    ]
    for c in candidates:
        if c.is_file():
            return c
    key = _stem(dds_name)
    dds_index = _G["dds_index"] if _G else {}
    dds_index_all = _G["dds_index_all"] if _G else {}
    # VSR-scoped match wins; full-workshop is last-resort fallback.
    return dds_index.get(key) or dds_index_all.get(key)


def resolve_diffuse(msh_dir: Path, dds_name: str, cache: dict):
    """Resolve + dedup a diffuse `.dds`. Writes textures/perf/<stem>.png (512,
    decoded via mip) and textures/hq/<stem>.dds (native copy, verbatim), both
    idempotently. Returns (tex_key, rgb_float_array_1024) or None.

    `cache` is per-model: maps tex_key -> (already-resolved) rgb array so groups
    sharing a diffuse decode once."""
    if not dds_name:
        return None
    tex_key = _stem(dds_name)
    if tex_key in cache:
        return (tex_key, cache[tex_key]) if cache[tex_key] is not None else None

    src = _find_diffuse_src(msh_dir, dds_name)
    if src is None:
        cache[tex_key] = None
        return None
    src = Path(src)

    try:
        pil = decode_dds(src, max_dim=DECODE_MAX_DIM).convert("RGBA")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    tex decode failed {dds_name}: {e}")
        cache[tex_key] = None
        return None

    force = _G["force"] if _G else False
    # perf PNG (downscale the 1024 decode to <=512)
    perf_path = TEX_PERF_DIR / f"{tex_key}.png"
    if force or not perf_path.exists():
        w, h = pil.size
        perf = pil
        if max(w, h) > PERF_MAX_DIM:
            scale = PERF_MAX_DIM / max(w, h)
            perf = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                              Image.LANCZOS)
        buf = _png_bytes(perf)
        _atomic_write_bytes(perf_path, buf)
    # hq DDS (native, verbatim)
    hq_path = TEX_HQ_DIR / f"{tex_key}.dds"
    if force or not hq_path.exists():
        _atomic_write_bytes(hq_path, src.read_bytes())

    arr = np.asarray(pil.convert("RGB"), np.float32) / 255.0
    cache[tex_key] = arr
    return tex_key, arr


def _png_bytes(img: Image.Image) -> bytes:
    import io
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


# ----------------------------- per-model conversion -----------------------------


def _build_groups(mesh, msh_dir: Path, handedness_fix: bool):
    """Weld each material group once into (positions, normals, uvs, indices) +
    resolve its material (name, base color, texture array). Returns the GLB
    builder, the rasterizer prim list, the set of textured material keys, and
    the set of texture stems that were referenced but did NOT resolve to a
    `.dds` (for the missing-texture report)."""
    gb = GlbBuilder()
    prims = []
    tex_keys = set()
    unresolved = set()
    tex_cache: dict = {}
    zf = -1.0 if handedness_fix else 1.0

    for gi, g in enumerate(mesh.groups):
        if g.hidden or not g.tris:
            continue
        rgba, mat_diffuse = parse_material(msh_dir, g.material)
        # The MSH-embedded diffuse name (g.texture) wins -- workshop models
        # (Cerberi etc.) use inline material names with no `.material` file but
        # carry the diffuse here; the `.material` [texture] diffuse is the
        # fallback for game-baked models where g.texture is empty.
        diffuse_dds = g.texture or mat_diffuse
        tex_key = None
        tex_arr = None
        if diffuse_dds:
            res = resolve_diffuse(msh_dir, diffuse_dds, tex_cache)
            if res:
                tex_key, tex_arr = res
                tex_keys.add(tex_key)
            else:
                unresolved.add(_stem(diffuse_dds))
        base_color = (1.0, 1.0, 1.0, 1.0) if tex_key else rgba
        mat_name = tex_key or (_stem(g.material) if g.material else f"mat{gi}")

        weld = {}
        positions, normals, uvs, indices = [], [], [], []

        def corner_index(c):
            pos = (c["pos"][0], c["pos"][1], c["pos"][2] * zf)
            nrm = (c["norm"][0], c["norm"][1], c["norm"][2] * zf)
            uv = (c["uv"][0], c["uv"][1])
            key = (round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                   round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4),
                   round(uv[0], 5), round(uv[1], 5))
            i = weld.get(key)
            if i is None:
                i = len(positions)
                weld[key] = i
                positions.append(pos)
                normals.append(nrm)
                uvs.append(uv)
            return i

        for tri in g.tris:
            a = corner_index(tri[0])
            b = corner_index(tri[1])
            c = corner_index(tri[2])
            if handedness_fix:
                indices.extend((a, c, b))  # reverse winding LH->RH
            else:
                indices.extend((a, b, c))

        mat_idx = gb.add_material(name=mat_name, base_color=base_color,
                                  double_sided=g.two_sided)
        gb.add_primitive(positions, normals, uvs, indices, material=mat_idx)
        prims.append({
            "positions": np.asarray(positions, np.float64),
            "normals": np.asarray(normals, np.float64),
            "uvs": np.asarray(uvs, np.float64),
            "indices": indices,
            "color": np.asarray(base_color[:3], np.float32),
            "tex": tex_arr,
        })

    return gb, prims, tex_keys, unresolved


def process_model(job: dict) -> dict:
    """Worker entrypoint: parse + convert + texture + render one model. Returns
    a manifest entry (with an 'error' key on failure)."""
    stem = job["stem"]
    try:
        cfg = _G
        msh_path = Path(job["msh"])
        meshes = parse_msh(msh_path)
        if not meshes:
            return {"stem": stem, "error": "no blocks parsed"}
        mesh = meshes[0]

        gb, prims, tex_keys, unresolved = _build_groups(
            mesh, msh_path.parent, cfg["handedness"])
        if not prims:
            return {"stem": stem, "error": "no renderable groups"}

        GEO_DIR.mkdir(parents=True, exist_ok=True)
        glb_bytes = gb.to_bytes(node_name=mesh.name or stem)
        _atomic_write_bytes(GEO_DIR / f"{stem}.glb", glb_bytes)

        shots = []
        if cfg["render"]:
            written = msh_thumbnail.render_model(
                prims, OUT_DIR, stem,
                hero_size=cfg["hero_size"], gallery_size=cfg["gallery_size"],
                supersample=cfg["supersample"], want_gallery=cfg["gallery"],
            )
            shots = written.get("shots", [])

        lo, hi = mesh.bbox()
        tris = sum(len(g.tris) for g in mesh.groups if not g.hidden)
        groups = len([g for g in mesh.groups if not g.hidden and g.tris])
        return {
            "stem": stem,
            "glb": f"geometry/{stem}.glb",
            "thumb": f"thumbnails/{stem}.png",
            "shots": shots,
            "unitName": job["unitName"],
            "primaryOdf": job["primaryOdf"],
            "odfs": job["odfs"],
            "category": job["category"],
            "factionCode": job["factionCode"],
            "factionName": job["factionName"],
            "triangles": tris,
            "groups": groups,
            "textures": sorted(tex_keys),
            "unresolvedTextures": sorted(unresolved - tex_keys),
            "radius": round(mesh.radius, 3),
            "bboxSize": [round(hi[i] - lo[i], 3) for i in range(3)],
            "_glb_bytes": len(glb_bytes),
        }
    except Exception as e:  # noqa: BLE001 - resilient over ~700 models
        return {"stem": stem, "error": f"{e!r}",
                "trace": traceback.format_exc(limit=3)}


def _worker_init(dds_index, mat_index, dds_index_all, mat_index_all, cfg):
    global _G
    _G = {"dds_index": dds_index, "mat_index": mat_index,
          "dds_index_all": dds_index_all, "mat_index_all": mat_index_all, **cfg}


# ----------------------------- caching -----------------------------


def _outputs_fresh(stem: str, msh_path: Path, want_gallery: bool) -> bool:
    glb = GEO_DIR / f"{stem}.glb"
    thumb = OUT_DIR / "thumbnails" / f"{stem}.png"
    if not glb.exists() or not thumb.exists():
        return False
    if glb.stat().st_mtime < msh_path.stat().st_mtime:
        return False
    if want_gallery:
        shot_dir = OUT_DIR / "shots" / stem
        if not shot_dir.is_dir():
            return False
        if sum(1 for _ in shot_dir.glob("*.png")) < len(msh_thumbnail.ANGLES):
            return False
    return True


def _cached_entry(stem: str, meta: dict, prior: dict) -> dict:
    """Reuse a prior index.json entry's geometry stats, refreshing the ODF /
    category / faction fields from the current enumeration."""
    p = prior.get(stem, {})
    return {
        "stem": stem,
        "glb": f"geometry/{stem}.glb",
        "thumb": f"thumbnails/{stem}.png",
        "shots": p.get("shots", [
            f"shots/{stem}/{a}.png" for a in msh_thumbnail.ANGLES]),
        "unitName": meta["unitName"],
        "primaryOdf": meta["primaryOdf"],
        "odfs": meta["odfs"],
        "category": meta["category"],
        "factionCode": meta["factionCode"],
        "factionName": meta["factionName"],
        "triangles": p.get("triangles", 0),
        "groups": p.get("groups", 0),
        "textures": p.get("textures", []),
        "unresolvedTextures": p.get("unresolvedTextures", []),
        "radius": p.get("radius", 0),
        "bboxSize": p.get("bboxSize", [0, 0, 0]),
    }


# ----------------------------- main -----------------------------


def main():
    ap = argparse.ArgumentParser(description="Convert all baked BZCC .msh to .glb + textures + gallery")
    ap.add_argument("--odf", nargs="*", default=None,
                    help="Only convert meshes referenced by these ODFs (default: all).")
    ap.add_argument("--steam-base", default=None)
    ap.add_argument("--no-handedness-fix", action="store_true")
    ap.add_argument("--no-render", action="store_true",
                    help="Skip thumbnail + gallery (geometry + textures only).")
    ap.add_argument("--no-gallery", action="store_true",
                    help="Hero thumbnail only; skip the 7-angle gallery.")
    ap.add_argument("--hero-size", type=int, default=256)
    ap.add_argument("--gallery-size", type=int, default=512)
    ap.add_argument("--supersample", type=int, default=2)
    ap.add_argument("--limit", type=int, default=None, help="Cap to N models (smoke run).")
    ap.add_argument("--force", action="store_true", help="Reprocess even if cached.")
    ap.add_argument("--jobs", type=int, default=1, help="Parallel worker processes.")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    t0 = time.perf_counter()
    odf_filter = set(args.odf) if args.odf else None
    targets = enumerate_targets(odf_filter)
    print(f"enumerated {len(targets)} unique mesh stems from {ODF_DB.name}")

    roots = resolve_roots(args.steam_base)
    print(f"resolved {len(roots)} asset roots")
    msh_index = build_file_index(roots, "msh")
    dds_index = build_file_index(roots, "dds")
    mat_index = build_file_index(roots, "material")
    print(f"indexed {len(msh_index)} .msh, {len(dds_index)} .dds, {len(mat_index)} .material (VSR-scoped)")
    ws_dir = workshop_content_dir(args.steam_base)
    dds_index_all = build_workshop_index(ws_dir, "dds")
    mat_index_all = build_workshop_index(ws_dir, "material")
    print(f"full-workshop fallback: {len(dds_index_all)} .dds, {len(mat_index_all)} .material ({ws_dir})")

    # Resolve each target to a baked .msh; record the misses.
    resolved = []
    missing = []
    for stem, meta in sorted(targets.items()):
        mp = msh_index.get(stem)
        if mp is None:
            missing.append(stem)
            continue
        resolved.append((stem, meta, mp))
    print(f"resolved {len(resolved)} meshes, {len(missing)} missing (no baked .msh)")
    if args.verbose and missing:
        print("  missing:", ", ".join(sorted(missing)))

    if args.limit:
        resolved = resolved[:args.limit]
        print(f"--limit: capped to {len(resolved)} models")

    for d in (GEO_DIR, TEX_PERF_DIR, TEX_HQ_DIR, OUT_DIR / "thumbnails"):
        d.mkdir(parents=True, exist_ok=True)

    # Prior manifest (for cache reuse of geometry stats).
    prior = {}
    idx_path = OUT_DIR / "index.json"
    if idx_path.exists():
        try:
            prior = {m["stem"]: m for m in
                     json.loads(idx_path.read_text(encoding="utf-8")).get("models", [])
                     if "stem" in m}
        except (json.JSONDecodeError, KeyError):
            prior = {}

    want_gallery = not args.no_gallery and not args.no_render
    cfg = {
        "handedness": not args.no_handedness_fix,
        "render": not args.no_render,
        "gallery": not args.no_gallery,
        "hero_size": args.hero_size,
        "gallery_size": args.gallery_size,
        "supersample": args.supersample,
        "force": args.force,
        "verbose": args.verbose,
    }

    # Partition into cache-hits (reuse prior entry) and jobs (process).
    jobs = []
    manifest = []
    cached = 0
    for stem, meta, mp in resolved:
        if (not args.force and stem in prior
                and _outputs_fresh(stem, mp, want_gallery)):
            manifest.append(_cached_entry(stem, meta, prior))
            cached += 1
            continue
        jobs.append({"stem": stem, "msh": str(mp), **meta})

    print(f"{cached} cached, {len(jobs)} to process "
          f"(jobs={args.jobs}, render={cfg['render']}, gallery={cfg['gallery']})")

    errors = []
    done = 0

    def _handle(entry):
        nonlocal done
        done += 1
        if "error" in entry:
            errors.append(entry)
            print(f"  [{done}/{len(jobs)}] FAIL {entry['stem']}: {entry['error']}")
        else:
            manifest.append({k: v for k, v in entry.items() if not k.startswith("_")})
            if args.verbose or done % 25 == 0 or done == len(jobs):
                kb = entry.get("_glb_bytes", 0) // 1024
                print(f"  [{done}/{len(jobs)}] OK {entry['stem']:20s} "
                      f"{entry['triangles']:>6d} tris, {len(entry['textures'])} tex, {kb} KB")

    if jobs:
        if args.jobs > 1:
            with ProcessPoolExecutor(
                max_workers=args.jobs,
                initializer=_worker_init,
                initargs=(dds_index, mat_index, dds_index_all, mat_index_all, cfg),
            ) as ex:
                futs = [ex.submit(process_model, j) for j in jobs]
                for f in as_completed(futs):
                    _handle(f.result())
        else:
            _worker_init(dds_index, mat_index, dds_index_all, mat_index_all, cfg)
            for j in jobs:
                _handle(process_model(j))

    # Assemble + write the manifest.
    manifest.sort(key=lambda e: (e.get("category") or "", e.get("unitName") or "", e["stem"]))
    odf_index = {}
    for m in manifest:
        for odf in m.get("odfs", []):
            odf_index[odf] = m["stem"]

    # Missing-texture report: models with no resolved diffuse, split into those
    # that referenced a `.dds` we couldn't find (unresolved) vs. genuinely
    # untextured (no texture name anywhere).
    no_tex = [m for m in manifest if not m.get("textures")]
    unresolved = {m["stem"]: m["unresolvedTextures"]
                  for m in no_tex if m.get("unresolvedTextures")}
    genuinely = sorted(m["stem"] for m in no_tex if not m.get("unresolvedTextures"))
    texture_report = {
        "models_total": len(manifest),
        "models_textured": len(manifest) - len(no_tex),
        "models_no_texture": len(no_tex),
        "models_unresolved_refs": len(unresolved),
        "genuinely_untextured": genuinely,
        "unresolved": dict(sorted(unresolved.items())),
    }
    idx_path.write_text(json.dumps({
        "schema_version": 3,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(manifest),
        "texture_report": texture_report,
        "models": manifest,
        "odf_index": odf_index,
    }, indent=2), encoding="utf-8")

    dt = time.perf_counter() - t0
    print(f"\nwrote {idx_path} -- {len(manifest)} models "
          f"({cached} cached, {len(jobs) - len(errors)} processed, {len(errors)} failed)")
    print(f"textures: {texture_report['models_textured']} textured, "
          f"{texture_report['models_no_texture']} without "
          f"({texture_report['models_unresolved_refs']} have unresolved refs, "
          f"{len(genuinely)} genuinely untextured)")
    if unresolved:
        miss = sorted({n for names in unresolved.values() for n in names})
        print(f"  unresolved texture stems ({len(miss)}): {', '.join(miss)}")
    print(f"elapsed {dt:.1f}s")
    if errors and args.verbose:
        for e in errors[:20]:
            print(f"  ! {e['stem']}: {e.get('trace', e['error'])}")


if __name__ == "__main__":
    main()
