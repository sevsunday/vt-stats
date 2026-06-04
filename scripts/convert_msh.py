"""
convert_msh.py -- offline BZCC baked `.msh` -> glTF `.glb` converter for the
object-render POC.

For each target ODF: resolves its `geometryName` from data/odf.min.json, swaps
the extension to `.msh`, locates the baked mesh under the BZ2R install, parses
it (scripts/msh_parser.py), welds per material group, reads the `.material`
[solid] diffuse for a base color, and writes data/models/<stem>.glb plus a
data/models/index.json manifest consumed by _object-render/.

Geometry-first (milestone 2): per-group base colors come from the `.material`
[solid] diffuse; .dds textures are milestone 4. Stdlib + scripts/glb_writer.py
only -- no trimesh/pygltflib dependency.

Coordinate handling: baked geometry is meters, Y-up. BZCC is a DirectX
(left-handed) engine, so we convert to glTF's right-handed space by negating Z
and reversing triangle winding (keeps the model un-mirrored and front-faces
correct). Toggle with --no-handedness-fix.

Usage:
  python scripts/convert_msh.py            # convert the default proof set
  python scripts/convert_msh.py --odf ivscout_vsr.odf ivtank_vsr.odf
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
sys.path.insert(0, str(PROJECT_ROOT / "_map-analysis" / "scripts"))

from msh_parser import parse_msh  # noqa: E402
from glb_writer import GlbBuilder  # noqa: E402
from dds_decode import decode_dds, UnsupportedDDS  # noqa: E402

try:
    import bz2_paths  # from _map-analysis/scripts
except ImportError:
    bz2_paths = None

ODF_DB = PROJECT_ROOT / "data" / "odf.min.json"
OUT_DIR = PROJECT_ROOT / "data" / "models"
TEX_DIR = OUT_DIR / "textures"
TEX_MAX_DIM = 1024  # downscale baked diffuse (often 2048) for web-sized PNGs

# Default proof set: 2 ISDF vehicles, 1 ISDF building, 1 Scion vehicle.
DEFAULT_TARGETS = [
    "ivscout_vsr.odf",
    "ivtank_vsr.odf",
    "ibrecy_vsr.odf",
    "fvburn.odf",
]

FACTION_NAMES = {"i": "ISDF", "e": "Hadean", "f": "Scion"}


def load_odf_index():
    db = json.loads(ODF_DB.read_text(encoding="utf-8"))
    idx = {}
    for cat, entries in db.items():
        for name, blocks in entries.items():
            go = blocks.get("GameObjectClass", {}) if isinstance(blocks, dict) else {}
            idx[name] = {
                "category": cat,
                "geometryName": go.get("geometryName"),
                "unitName": go.get("unitName"),
            }
    return idx


def find_baked_root(steam_override=None):
    """Return the bz2r_res/baked directory under the BZ2R install."""
    if bz2_paths is not None:
        try:
            roots = bz2_paths.resolve_root_dirs(
                steam_override=steam_override, no_deps=True, quiet=True,
            )
            bz2r_dir = roots[0][0]
            baked = bz2r_dir / "bz2r_res" / "baked"
            if baked.is_dir():
                return baked
        except SystemExit:
            pass
    # Fallback to the hardcoded default.
    fallback = Path(
        r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R\bz2r_res\baked"
    )
    if fallback.is_dir():
        return fallback
    raise SystemExit("Could not locate the BZ2R baked mesh directory.")


def find_msh(baked_root: Path, geometry_name: str) -> Path | None:
    """geometryName is like 'ivscout00.fbx'; the baked file is '<stem>.msh'."""
    stem = Path(geometry_name).stem
    matches = list(baked_root.rglob(f"{stem}.msh"))
    return matches[0] if matches else None


def parse_material(msh_dir: Path, material_filename: str):
    """Read the [solid] diffuse RGBA and [texture] diffuse filename from a
    sibling `.material` file. Returns (rgba_tuple, diffuse_dds_name|None)."""
    rgba = (0.8, 0.8, 0.8, 1.0)
    diffuse_dds = None
    if not material_filename:
        return rgba, diffuse_dds
    p = msh_dir / material_filename
    if not p.is_file():
        return rgba, diffuse_dds
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
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


def resolve_texture(msh_dir: Path, dds_name: str, tex_cache: dict):
    """Decode a diffuse `.dds` (looked up in the msh dir + a sibling textures/
    folder) to a deduped downscaled PNG under data/models/textures/. Returns the
    glb-relative uri ('textures/<stem>.png') or None on failure."""
    if not dds_name:
        return None
    if dds_name in tex_cache:
        return tex_cache[dds_name]

    candidates = [
        msh_dir / dds_name,
        msh_dir / "textures" / dds_name,
        msh_dir.parent / "textures" / dds_name,
    ]
    src = next((c for c in candidates if c.is_file()), None)
    if src is None:
        # Recursive fallback within the faction tree.
        hits = list(msh_dir.parent.rglob(dds_name))
        src = hits[0] if hits else None
    if src is None:
        tex_cache[dds_name] = None
        return None

    try:
        img = decode_dds(src).convert("RGBA")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001 - best-effort
        print(f"    tex decode failed for {dds_name}: {e}")
        tex_cache[dds_name] = None
        return None

    w, h = img.size
    if max(w, h) > TEX_MAX_DIM:
        scale = TEX_MAX_DIM / max(w, h)
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))

    TEX_DIR.mkdir(parents=True, exist_ok=True)
    stem = Path(dds_name).stem
    out = TEX_DIR / f"{stem}.png"
    img.save(out, optimize=True)
    uri = f"textures/{stem}.png"
    tex_cache[dds_name] = uri
    return uri


def build_glb(mesh, msh_dir: Path, handedness_fix: bool, with_textures: bool):
    gb = GlbBuilder()
    zf = -1.0 if handedness_fix else 1.0
    tex_cache = {}
    tex_used = 0

    for g in mesh.groups:
        if g.hidden or not g.tris:
            continue
        base_color, diffuse_dds = parse_material(msh_dir, g.material)
        tex_idx = None
        if with_textures and diffuse_dds:
            uri = resolve_texture(msh_dir, diffuse_dds, tex_cache)
            if uri:
                tex_idx = gb.add_texture(uri)
                tex_used += 1
                base_color = (1.0, 1.0, 1.0, 1.0)  # let the texture show true color
        mat_idx = gb.add_material(
            name=g.material or f"bucky{g.bucky_index}",
            base_color=base_color,
            double_sided=g.two_sided,
            base_color_texture=tex_idx,
        )

        weld = {}
        positions, normals, uvs, indices = [], [], [], []

        def corner_index(c):
            pos = (c["pos"][0], c["pos"][1], c["pos"][2] * zf)
            nrm = (c["norm"][0], c["norm"][1], c["norm"][2] * zf)
            uv = (c["uv"][0], c["uv"][1])
            key = (
                round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4),
                round(uv[0], 5), round(uv[1], 5),
            )
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
                indices.extend((a, c, b))  # reverse winding for LH->RH
            else:
                indices.extend((a, b, c))

        gb.add_primitive(positions, normals, uvs, indices, material=mat_idx)

    return gb.to_bytes(node_name=mesh.name or "model"), tex_used


def main():
    ap = argparse.ArgumentParser(description="Convert baked BZCC .msh to .glb")
    ap.add_argument("--odf", nargs="*", default=None,
                    help="ODF names to convert (default: proof set).")
    ap.add_argument("--steam-base", default=None)
    ap.add_argument("--no-handedness-fix", action="store_true",
                    help="Skip LH->RH conversion (debug).")
    ap.add_argument("--no-textures", action="store_true",
                    help="Geometry only; skip .dds->png diffuse textures.")
    args = ap.parse_args()

    targets = args.odf if args.odf else DEFAULT_TARGETS
    handedness_fix = not args.no_handedness_fix
    with_textures = not args.no_textures

    odf_idx = load_odf_index()
    baked_root = find_baked_root(args.steam_base)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"baked root: {baked_root}")
    print(f"out dir   : {OUT_DIR}")

    manifest = []
    for odf in targets:
        meta = odf_idx.get(odf)
        if not meta or not meta.get("geometryName"):
            print(f"  SKIP {odf}: no geometryName in odf.min.json")
            continue
        geo = meta["geometryName"]
        msh_path = find_msh(baked_root, geo)
        if not msh_path:
            print(f"  SKIP {odf}: baked .msh not found for {geo}")
            continue

        meshes = parse_msh(msh_path)
        if not meshes:
            print(f"  SKIP {odf}: no blocks parsed from {msh_path.name}")
            continue
        mesh = meshes[0]
        glb, tex_used = build_glb(mesh, msh_path.parent, handedness_fix, with_textures)

        stem = Path(geo).stem
        out_path = OUT_DIR / f"{stem}.glb"
        out_path.write_bytes(glb)

        faction_code = odf[0].lower() if odf and odf[0].lower() in FACTION_NAMES else "_"
        lo, hi = mesh.bbox()
        tris = sum(len(g.tris) for g in mesh.groups if not g.hidden)
        entry = {
            "odf": odf,
            "glb": f"{stem}.glb",
            "unitName": meta.get("unitName") or stem,
            "geometryName": geo,
            "category": meta.get("category"),
            "factionCode": faction_code,
            "factionName": FACTION_NAMES.get(faction_code),
            "triangles": tris,
            "groups": len([g for g in mesh.groups if not g.hidden]),
            "textured": tex_used > 0,
            "radius": round(mesh.radius, 3),
            "bboxSize": [round(hi[i] - lo[i], 3) for i in range(3)],
        }
        manifest.append(entry)
        print(f"  OK   {odf:18s} -> {out_path.name:18s} "
              f"({tris} tris, {entry['groups']} groups, {tex_used} tex, "
              f"{len(glb)//1024} KB)")

    manifest.sort(key=lambda e: (e["category"] or "", e["unitName"] or ""))
    (OUT_DIR / "index.json").write_text(
        json.dumps({"schema_version": 1, "models": manifest}, indent=2),
        encoding="utf-8",
    )
    print(f"\nwrote {OUT_DIR / 'index.json'} ({len(manifest)} models)")


if __name__ == "__main__":
    main()
