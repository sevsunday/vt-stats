"""Per-map sky sidecars plus the baked dome mesh and textures they name.

Standalone. Not invoked by process_stats.py, and it does not rewrite
the heightmap `*.3d.json` files.

The `.SKY` file names a dome mesh, cloud / sun textures, and SPRT
billboards. The pixels live in the BZCC install as baked `.msh` + `.dds`
under `bz2r_res/baked/Worlds/<biome>/Sky/`, shared sky art under
`Worlds/Textures/` (stars, earth, banesky, darkflat3), and a few effect
textures such as `blast.dds`. This script:

1. Decodes every ingested `.SKY` via `parse_sky`.
2. Writes `data/render/<stem>.sky.json`.
3. Copies only the referenced `.dds` files and a static GLB of each
   referenced dome `.msh` into `data/render/sky/`.

    python scripts/extract_sky.py
    python scripts/extract_sky.py --stem vsrvegan
    python scripts/extract_sky.py --bz2r "D:/Steam/steamapps/common/BZ2R"
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "object-render"))

from _paths import RENDER_DATA_DIR, VSRMAPLIST_DIR  # noqa: E402
from _wat_sky import parse_sky  # noqa: E402
from msh_parser import parse_msh  # noqa: E402

SKY_DIR = RENDER_DATA_DIR / "sky"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
SCHEMA_VERSION = 2


def _mirror_z(v):
    return (float(v[0]), float(v[1]), -float(v[2]))


def _pad4(buf: bytearray, fill: int = 0) -> None:
    while len(buf) % 4:
        buf.append(fill)


def _dome_geometry(msh_path: Path):
    """Welded, Z-mirrored triangles from a baked dome `.msh`."""
    positions = []
    normals = []
    uvs = []
    indices = []
    weld = {}
    for block in parse_msh(msh_path):
        for group in block.groups:
            if group.hidden:
                continue
            for tri in group.tris:
                corners = []
                for corner in tri:
                    pos = _mirror_z(corner["pos"])
                    nrm = _mirror_z(corner["norm"])
                    uv = corner["uv"]
                    key = (
                        round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                        round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4),
                        round(uv[0], 5), round(uv[1], 5),
                    )
                    wi = weld.get(key)
                    if wi is None:
                        wi = len(positions)
                        weld[key] = wi
                        positions.append(pos)
                        normals.append(nrm)
                        uvs.append((float(uv[0]), float(uv[1])))
                    corners.append(wi)
                if len(corners) == 3:
                    indices.extend((corners[0], corners[2], corners[1]))
    return positions, normals, uvs, indices


def _write_glb(positions, normals, uvs, indices, name: str) -> bytes:
    """One-mesh glTF binary. No embedded image; the viewer binds the DDS."""
    bin_buf = bytearray()
    views = []
    accessors = []

    def add_view(data: bytes, target: int | None) -> int:
        _pad4(bin_buf)
        offset = len(bin_buf)
        bin_buf.extend(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        return len(views) - 1

    def add_vec3(vals) -> int:
        flat = bytearray()
        mn = [float("inf")] * 3
        mx = [float("-inf")] * 3
        for v in vals:
            flat += struct.pack("<3f", v[0], v[1], v[2])
            for i in range(3):
                mn[i] = min(mn[i], v[i])
                mx[i] = max(mx[i], v[i])
        bv = add_view(bytes(flat), 34962)
        accessors.append({
            "bufferView": bv, "componentType": 5126, "count": len(vals),
            "type": "VEC3", "min": mn, "max": mx,
        })
        return len(accessors) - 1

    def add_vec2(vals) -> int:
        flat = bytearray()
        for v in vals:
            flat += struct.pack("<2f", v[0], v[1])
        bv = add_view(bytes(flat), 34962)
        accessors.append({
            "bufferView": bv, "componentType": 5126, "count": len(vals),
            "type": "VEC2",
        })
        return len(accessors) - 1

    def add_indices(idx) -> int:
        flat = bytearray()
        for i in idx:
            flat += struct.pack("<I", i)
        bv = add_view(bytes(flat), 34963)
        accessors.append({
            "bufferView": bv, "componentType": 5125, "count": len(idx),
            "type": "SCALAR",
        })
        return len(accessors) - 1

    prim = {
        "attributes": {
            "POSITION": add_vec3(positions),
            "NORMAL": add_vec3(normals),
            "TEXCOORD_0": add_vec2(uvs),
        },
        "indices": add_indices(indices),
        "mode": 4,
        "material": 0,
    }
    gltf = {
        "asset": {"version": "2.0", "generator": "vt-stats extract_sky"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "meshes": [{"name": name, "primitives": [prim]}],
        "materials": [{
            "name": name,
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [1, 1, 1, 1],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        }],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_buf)}],
    }
    js = bytearray(json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
    _pad4(js, 0x20)
    bb = bytearray(bin_buf)
    _pad4(bb, 0)
    total = 12 + 8 + len(js) + 8 + len(bb)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A)
    out += js
    out += struct.pack("<II", len(bb), 0x004E4942)
    out += bb
    return bytes(out)


def _first_float(text: str) -> float | None:
    parts = text.replace(",", " ").split()
    if not parts:
        return None
    try:
        value = float(parts[0])
    except ValueError:
        return None
    if value != value:
        return None
    return value


def _material_surface(path: Path) -> dict | None:
    """Diffuse stem plus the solid ambient / emissive greys.

    Ambient and emissive are the first component of the material's
    RGB triple. A missing key stays None.
    """
    section = ""
    diffuse = None
    ambient = None
    emissive = None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            continue
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip().lower()
        val = val.strip().strip('"').strip("'")
        if section == "texture" and key == "diffuse":
            stem = Path(val).stem.lower()
            diffuse = stem or None
        elif section == "solid" and key == "ambient":
            ambient = _first_float(val)
        elif section == "solid" and key == "emissive":
            emissive = _first_float(val)
    if diffuse is None and ambient is None and emissive is None:
        return None
    return {"diffuse": diffuse, "ambient": ambient, "emissive": emissive}


def _index_baked(bz2r: Path):
    """stem -> Path for dome meshes and every sky DDS we might name.

    Sky-folder files win. `Worlds/Textures` (recursive — `darkflat3` lives
    under `Textures/Water`) and effect textures only fill stems the sky
    folders did not already provide.
    """
    dds: dict[str, Path] = {}
    msh: dict[str, Path] = {}
    worlds = bz2r / "bz2r_res" / "baked" / "Worlds"
    effects = bz2r / "bz2r_res" / "baked" / "Effects" / "Textures"

    def keep(table: dict[str, Path], path: Path) -> None:
        table.setdefault(path.stem.lower(), path)

    if worlds.is_dir():
        for sky_dir in worlds.glob("*/Sky"):
            if not sky_dir.is_dir():
                continue
            for path in sky_dir.iterdir():
                ext = path.suffix.lower()
                if ext == ".dds":
                    keep(dds, path)
                elif ext == ".msh":
                    keep(msh, path)
        textures = worlds / "Textures"
        if textures.is_dir():
            for path in textures.rglob("*.dds"):
                keep(dds, path)
    if effects.is_dir():
        for path in effects.glob("*.dds"):
            keep(dds, path)
    return dds, msh


def _dome_surface(msh_path: Path, stem: str, dds: dict[str, Path]) -> dict:
    """Material diffuse + lighting, or a sibling `<stem>.dds` with no lighting.

    `ambient` / `emissive` stay None when there is no material. The viewer
    treats that as "tint the texture" (rendsky). A material with ambient 0
    is a self-lit dome (stars, DarkSkyS) and must not be tinted.
    """
    parent = msh_path.parent
    if parent.is_dir():
        for path in sorted(parent.iterdir(), key=lambda p: p.name.lower()):
            if path.suffix.lower() != ".material":
                continue
            name = path.stem.lower()
            if name != stem and not name.startswith(stem + "_"):
                continue
            found = _material_surface(path)
            if found and found.get("diffuse"):
                return found
    sibling = msh_path.with_suffix(".dds")
    if sibling.is_file() or stem in dds:
        return {"diffuse": stem, "ambient": None, "emissive": None}
    return {"diffuse": None, "ambient": None, "emissive": None}


def _copy_dds(src: Path) -> str | None:
    SKY_DIR.mkdir(parents=True, exist_ok=True)
    dest = SKY_DIR / f"{src.stem.lower()}.dds"
    src_size = src.stat().st_size
    if not dest.is_file() or dest.stat().st_size != src_size:
        shutil.copyfile(src, dest)
    return f"sky/{dest.name}"


def _ensure_glb(stem: str, msh_path: Path) -> str | None:
    SKY_DIR.mkdir(parents=True, exist_ok=True)
    dest = SKY_DIR / f"{stem}.glb"
    if dest.is_file() and dest.stat().st_mtime >= msh_path.stat().st_mtime:
        return f"sky/{dest.name}"
    positions, normals, uvs, indices = _dome_geometry(msh_path)
    if len(indices) < 3:
        print(f"  warn: {msh_path.name} has no triangles")
        return None
    dest.write_bytes(_write_glb(positions, normals, uvs, indices, stem))
    return f"sky/{dest.name}"


def _bzn_stem(folder: Path) -> str | None:
    seen = set()
    for path in list(folder.glob("*.bzn")) + list(folder.glob("*.BZN")):
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        return path.stem.lower()
    return None


def _sky_path(folder: Path) -> Path | None:
    seen = set()
    for path in list(folder.glob("*.sky")) + list(folder.glob("*.SKY")):
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        return path
    return None


def _iter_maps(only: str | None):
    if not VSRMAPLIST_DIR.is_dir():
        return
    seen = set()
    for folder in sorted(VSRMAPLIST_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        key = str(folder.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        stem = _bzn_stem(folder)
        if stem is None:
            continue
        if only and stem != only:
            continue
        sky = _sky_path(folder)
        if sky is None:
            continue
        yield stem, sky


def _rel_for_stem(table: dict[str, Path], stem: str | None, cache: dict[str, str | None]) -> str | None:
    if not stem:
        return None
    if stem in cache:
        return cache[stem]
    src = table.get(stem)
    if src is None:
        cache[stem] = None
        return None
    cache[stem] = _copy_dds(src)
    return cache[stem]


def extract(bz2r: Path, only: str | None) -> int:
    dds, msh = _index_baked(bz2r) if bz2r.is_dir() else ({}, {})
    if not bz2r.is_dir():
        print(f"warn: BZ2R not found at {bz2r}; sidecars will have colors only")
    else:
        print(f"baked index: {len(msh)} meshes, {len(dds)} textures")

    dds_cache: dict[str, str | None] = {}
    glb_cache: dict[str, str | None] = {}
    surface_cache: dict[str, dict] = {}
    written = 0
    missing_dome = []
    empty_surface = {"diffuse": None, "ambient": None, "emissive": None}
    RENDER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    for stem, sky_path in _iter_maps(only):
        parsed = parse_sky(sky_path)
        if parsed is None:
            print(f"  skip {stem}: SKY did not parse")
            continue
        dome = parsed.get("dome")
        glb_rel = None
        surface = empty_surface
        if dome:
            if dome in glb_cache:
                glb_rel = glb_cache[dome]
                surface = surface_cache.get(dome) or empty_surface
            else:
                msh_path = msh.get(dome)
                if msh_path is None:
                    glb_cache[dome] = None
                    surface_cache[dome] = empty_surface
                    missing_dome.append(dome)
                    surface = empty_surface
                else:
                    try:
                        glb_rel = _ensure_glb(dome, msh_path)
                    except Exception as exc:
                        print(f"  warn: {dome}.msh -> {exc}")
                        glb_rel = None
                    glb_cache[dome] = glb_rel
                    surface = _dome_surface(msh_path, dome, dds)
                    surface_cache[dome] = surface
        dome_stem = surface.get("diffuse")
        if dome and dome_stem:
            dome_dds_rel = _rel_for_stem(dds, dome_stem, dds_cache)
        else:
            dome_dds_rel = None
        sprites = []
        for rec in parsed.get("sprites") or []:
            row = dict(rec)
            row["texture"] = _rel_for_stem(dds, rec.get("name"), dds_cache)
            sprites.append(row)
        doc = {
            "schema_version": SCHEMA_VERSION,
            "map_stem": stem,
            "dome": dome,
            "cloud": parsed.get("cloud"),
            "sun": parsed.get("sun"),
            "radius": parsed.get("radius"),
            "colors": parsed.get("colors") or {},
            "assets": {
                "dome_glb": glb_rel,
                "dome_dds": dome_dds_rel,
                "dome_ambient": surface.get("ambient"),
                "dome_emissive": surface.get("emissive"),
                "cloud_dds": _rel_for_stem(dds, parsed.get("cloud"), dds_cache),
                "sun_dds": _rel_for_stem(dds, parsed.get("sun"), dds_cache),
            },
            "sprites": sprites,
        }
        out = RENDER_DATA_DIR / f"{stem}.sky.json"
        out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        written += 1

    copied = sum(1 for v in dds_cache.values() if v)
    glbs = sum(1 for v in glb_cache.values() if v)
    print(f"wrote {written} sidecars, {glbs} dome GLBs, {copied} textures")
    if missing_dome:
        uniq = sorted(set(missing_dome))
        print(f"domes with no baked mesh: {', '.join(uniq)}")
    return 0 if written else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract replay sky domes from .SKY files")
    ap.add_argument("--stem", default=None, help="one map stem (bzn filename)")
    ap.add_argument("--bz2r", default=str(DEFAULT_BZ2R), help="BZCC install (the BZ2R folder)")
    args = ap.parse_args()
    only = args.stem.lower() if args.stem else None
    raise SystemExit(extract(Path(args.bz2r), only))


if __name__ == "__main__":
    main()
