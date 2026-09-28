"""Weapon-effect textures, sounds and FX meshes for the Weapons Lab shooting range.

Standalone. Not invoked by process_stats.py. Walks the VSR armory the same way
js/weapons-calc.js scope('vsr') does, collects every textureName / geomName /
shotGeometry / *.wav those weapons (and the mines they dispense) reference,
and writes:

    data/fx/textures/<stem>.png   RGBA, longest side <= 256
    data/fx/geometry/<stem>.glb   FX meshes that are not already a model GLB
    data/audio/<stem>.wav         only the clips not already vendored
    data/fx/index.json            stem -> file, plus workshop credits

Existing outputs are skipped unless --force. Sources are the local BZ2R
install and the subscribed workshop tree (Forgotten Enemies packs supply
most of the effect art the stock install does not).

    python scripts/build_fx_assets.py
    python scripts/build_fx_assets.py --force
    python scripts/build_fx_assets.py --bz2r "D:/Steam/steamapps/common/BZ2R"
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS / "object-render"))

from dds_decode import decode_dds  # noqa: E402
from glb_writer import GlbBuilder  # noqa: E402
from msh_parser import MshError, parse_msh  # noqa: E402

REPO = SCRIPTS.parent
ODF_PATH = REPO / "data" / "odf.min.json"
FX_DIR = REPO / "data" / "fx"
TEX_DIR = FX_DIR / "textures"
GEOM_DIR = FX_DIR / "geometry"
AUDIO_DIR = REPO / "data" / "audio"
MODEL_GEOM = REPO / "data" / "models" / "geometry"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
DEFAULT_WS = Path(r"C:\Program Files (x86)\Steam\steamapps\workshop\content\624970")
SCHEMA_VERSION = 1
TEX_MAX = 256
VSR_ROOTS = ("ibrecy_vsr", "ebrecym_vsr", "fbrecy_vsr")

# Workshop packs the effect art actually comes from. Credited in the index
# and in the firing-range footer.
CREDITS = {
    "2785557433": {
        "name": "Forgotten Enemies: Remastered: Shared Asset Pack",
        "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=2785557433",
    },
    "2785542655": {
        "name": "FE:Remastered: Hadean Asset Pack",
        "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=2785542655",
    },
    "3532748119": {
        "name": "Vet Recycler Variant Asset Pack",
        "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=3532748119",
    },
}

ASSET_KEYS = {
    "texturename": "tex",
    "geomname": "geom",
    "shotgeometry": "geom",
    "geometryname": "geom",
}


def stem_of(value) -> str:
    s = str(value or "").strip().strip('"').strip()
    s = re.sub(r"\.[^.]+$", "", s)
    s = s.lower()
    if not s or s == "null":
        return ""
    return s


def num_key(key: str):
    m = re.match(r"^(builditem)(\d+)$", key, re.I)
    return int(m.group(2)) if m else None


def child_stems(entry: dict) -> list[str]:
    """Factory / rig / armory build items plus upgradeName. Mirrors weapons-calc childNames."""
    found = []
    seen = set()

    def add(raw):
        s = stem_of(raw)
        if s and s not in seen:
            seen.add(s)
            found.append(s)

    for sec_name, sec in entry.items():
        if not isinstance(sec, dict):
            continue
        low = sec_name.lower()
        if low in ("factoryclass", "constructionrigclass") or re.match(r"armorygroup\d+$", low):
            items = []
            for k, v in sec.items():
                n = num_key(k)
                if n is not None and str(v).strip():
                    items.append((n, v))
            for _, v in sorted(items):
                add(v)
        if low == "gameobjectclass":
            up = sec.get("upgradeName") or sec.get("upgradename")
            if up:
                add(up)
    return found


def section_ci(entry: dict, name: str) -> dict:
    want = name.lower()
    for k, v in entry.items():
        if k.lower() == want and isinstance(v, dict):
            return v
    return {}


def prop_ci(sec: dict, key: str):
    want = key.lower()
    for k, v in sec.items():
        if str(k).lower() == want:
            return v
    return None


def vsr_weapon_stems(db: dict) -> list[str]:
    """The Weapons Lab VSR scope: build-tree weapons, mounted weapons, altName twins."""
    by_stem = {}
    for bucket, entries in db.items():
        if not isinstance(entries, dict):
            continue
        for name, entry in entries.items():
            by_stem[stem_of(name)] = (bucket, entry)

    weapons = set()
    ships = set()
    seen = set()
    stack = list(VSR_ROOTS)
    while stack:
        s = stack.pop()
        if s in seen:
            continue
        seen.add(s)
        hit = by_stem.get(s)
        if not hit:
            continue
        bucket, entry = hit
        if bucket == "Vehicle":
            ships.add(s)
        elif bucket == "Powerup":
            w = stem_of(prop_ci(section_ci(entry, "WeaponPowerupClass"), "weaponName"))
            if w:
                weapons.add(w)
        stack.extend(child_stems(entry))

    for s in ships:
        hit = by_stem.get(s)
        if not hit:
            continue
        go = section_ci(hit[1], "GameObjectClass")
        for i in range(1, 6):
            w = stem_of(prop_ci(go, "weaponName%d" % i))
            if w:
                weapons.add(w)

    extra = set()
    for w in weapons:
        hit = by_stem.get(w)
        if not hit or hit[0] != "Weapon":
            continue
        alt = stem_of(prop_ci(section_ci(hit[1], "WeaponClass"), "altName"))
        if alt and alt != w and alt in by_stem and by_stem[alt][0] == "Weapon":
            extra.add(alt)
    weapons |= extra
    weapons = {w for w in weapons if w in by_stem and by_stem[w][0] == "Weapon"}
    return sorted(weapons)


def walk_refs(entry: dict, tex: set, geom: set, snd: set) -> None:
    for sec in entry.values():
        if not isinstance(sec, dict):
            continue
        for k, v in sec.items():
            if not isinstance(v, str):
                continue
            kl = str(k).lower()
            kind = ASSET_KEYS.get(kl)
            if kind == "tex":
                s = stem_of(v)
                if s:
                    tex.add(s)
            elif kind == "geom":
                s = stem_of(v)
                if s:
                    geom.add(s)
            elif v.lower().strip().strip('"').endswith(".wav"):
                s = stem_of(v.strip().strip('"'))
                if s:
                    snd.add(s)


NAMED_REF_RE = re.compile(
    r"^(payloadname|objectclass|launchord|explosionname|leadername|ordname\d*|xpl[a-z]*)$", re.I)


def named_refs(entry: dict) -> list[str]:
    """Stems of the separate ODFs an entry names: dispensed mines and payloads,
    a targeting gun's leader round, charge-level ordnances, a popper's second
    stage and every xpl* explosion that was not inlined. Mirrors
    js/fx/weapon-profile.js profileAssets so the range can preload them."""
    out = []
    for sec in entry.values():
        if not isinstance(sec, dict):
            continue
        for k, v in sec.items():
            if isinstance(v, str) and NAMED_REF_RE.match(str(k)):
                s = stem_of(v)
                if s:
                    out.append(s)
    return out


def follow_dispensed(db: dict, weapon: dict, tex, geom, snd, seen: set) -> None:
    """Mines, payloads, leader rounds, charge ordnances and explosions are
    separate ODFs; the weapon entry only names them."""
    pending = named_refs(weapon)
    while pending:
        s = pending.pop()
        if s in seen:
            continue
        seen.add(s)
        entry = None
        for bucket in ("Mine", "Misc", "Ordnance", "Explosion", "Effect"):
            hit = db.get(bucket, {}).get(s + ".odf")
            if hit:
                entry = hit
                break
        if not entry:
            continue
        walk_refs(entry, tex, geom, snd)
        pending.extend(named_refs(entry))


def index_files(roots: list[Path], exts: set[str]) -> dict[str, Path]:
    """stem -> first path. BZ2R is listed before workshop so stock wins."""
    out = {}
    for root in roots:
        if not root.is_dir():
            continue
        for f in root.rglob("*"):
            if not f.is_file():
                continue
            if f.suffix.lower() not in exts:
                continue
            out.setdefault(f.stem.lower(), f)
    return out


def credit_for(path: Path) -> str | None:
    parts = path.parts
    if "624970" not in parts:
        return None
    i = parts.index("624970")
    if i + 1 < len(parts):
        return parts[i + 1]
    return None


def msh_to_glb(path: Path) -> bytes | None:
    """Single-piece FX mesh. Z-mirror matches convert_msh's handedness fix.
    The shooting range retextures the mesh from the render's textureName, so the
    GLB carries a flat material named after the mesh stem."""
    try:
        meshes = parse_msh(path)
    except (MshError, OSError) as exc:
        print(f"warn: {path.name}: {exc}", file=sys.stderr)
        return None
    if not meshes:
        return None
    mesh = meshes[0]
    gb = GlbBuilder(generator="vt-stats build_fx_assets")
    mat = gb.add_material(name=path.stem.lower(), base_color=(1, 1, 1, 1), double_sided=True)
    wrote = False
    for g in mesh.groups:
        if g.hidden or not g.tris:
            continue
        weld = {}
        positions, normals, uvs, indices = [], [], [], []

        def corner(c):
            pos = (c["pos"][0], c["pos"][1], -c["pos"][2])
            nrm = (c["norm"][0], c["norm"][1], -c["norm"][2])
            uv = (c["uv"][0], c["uv"][1])
            key = tuple(round(x, 5) for x in pos + nrm + uv)
            i = weld.get(key)
            if i is None:
                i = len(positions)
                weld[key] = i
                positions.append(pos)
                normals.append(nrm)
                uvs.append(uv)
            return i

        for tri in g.tris:
            a, b, c = corner(tri[0]), corner(tri[1]), corner(tri[2])
            indices.extend((a, c, b))
        if indices:
            gb.add_primitive(positions, normals, uvs, indices, material=mat)
            wrote = True
    if not wrote:
        return None
    return gb.to_bytes(node_name=path.stem.lower())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Extract weapon-effect assets for the shooting range.")
    ap.add_argument("--bz2r", type=Path, default=DEFAULT_BZ2R)
    ap.add_argument("--workshop", type=Path, default=DEFAULT_WS)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    db = json.loads(ODF_PATH.read_text(encoding="utf-8"))
    stems = vsr_weapon_stems(db)
    if len(stems) < 100:
        print(f"error: VSR weapon scope resolved only {len(stems)} (expected ~123)", file=sys.stderr)
        return 1

    tex, geom, snd = set(), set(), set()
    followed = set()
    for s in stems:
        entry = db["Weapon"][s + ".odf"]
        walk_refs(entry, tex, geom, snd)
        follow_dispensed(db, entry, tex, geom, snd, followed)

    print(f"VSR weapons: {len(stems)}; textures {len(tex)}, geoms {len(geom)}, sounds {len(snd)}")

    roots = [args.bz2r, args.workshop]
    files = index_files(roots, {".dds", ".tga", ".png", ".msh", ".wav"})

    TEX_DIR.mkdir(parents=True, exist_ok=True)
    GEOM_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    textures = {}
    missing_tex = []
    tex_written = 0
    used_credits = set()
    for s in sorted(tex):
        src = files.get(s)
        if not src or src.suffix.lower() not in (".dds", ".tga", ".png"):
            # prefer dds; index_files is first-wins across mixed extensions,
            # so a .wav of the same stem must not shadow a texture.
            src = None
            for ext in (".dds", ".tga", ".png"):
                # rescan is expensive; the index only kept one suffix.
                break
        if src is None or src.suffix.lower() not in (".dds", ".tga", ".png"):
            missing_tex.append(s)
            continue
        out = TEX_DIR / f"{s}.png"
        if args.force or not out.is_file():
            if src.suffix.lower() == ".png":
                shutil.copyfile(src, out)
            else:
                img = decode_dds(src, max_dim=TEX_MAX).convert("RGBA")
                img.thumbnail((TEX_MAX, TEX_MAX))
                img.save(out, optimize=True)
            tex_written += 1
        pack = credit_for(src)
        if pack:
            used_credits.add(pack)
        textures[s] = {
            "file": f"fx/textures/{s}.png",
            "source": str(src),
            "credit": pack,
        }

    # The file index keeps a single suffix per stem. Textures that lost to a
    # same-stem wav/msh need a second pass restricted to image suffixes.
    if missing_tex:
        images = index_files(roots, {".dds", ".tga", ".png"})
        still = []
        for s in missing_tex:
            src = images.get(s)
            if not src:
                still.append(s)
                continue
            out = TEX_DIR / f"{s}.png"
            if args.force or not out.is_file():
                img = decode_dds(src, max_dim=TEX_MAX).convert("RGBA")
                img.thumbnail((TEX_MAX, TEX_MAX))
                img.save(out, optimize=True)
                tex_written += 1
            pack = credit_for(src)
            if pack:
                used_credits.add(pack)
            textures[s] = {"file": f"fx/textures/{s}.png", "source": str(src), "credit": pack}
        missing_tex = still

    geometry = {}
    missing_geom = []
    geom_written = 0
    msh_index = index_files(roots, {".msh"})
    for s in sorted(geom):
        model = MODEL_GEOM / f"{s}.glb"
        if model.is_file():
            geometry[s] = {"file": f"models/geometry/{s}.glb", "kind": "model"}
            continue
        src = msh_index.get(s)
        if not src:
            missing_geom.append(s)
            continue
        out = GEOM_DIR / f"{s}.glb"
        if args.force or not out.is_file():
            blob = msh_to_glb(src)
            if not blob:
                missing_geom.append(s)
                continue
            out.write_bytes(blob)
            geom_written += 1
        pack = credit_for(src)
        if pack:
            used_credits.add(pack)
        geometry[s] = {"file": f"fx/geometry/{s}.glb", "kind": "fx", "source": str(src), "credit": pack}

    sounds = {}
    missing_snd = []
    snd_written = 0
    wav_index = index_files(roots, {".wav"})
    for s in sorted(snd):
        dest = AUDIO_DIR / f"{s}.wav"
        if dest.is_file() and not args.force:
            sounds[s] = {"file": f"audio/{s}.wav", "vendored": True}
            continue
        src = wav_index.get(s)
        if not src:
            missing_snd.append(s)
            continue
        if not dest.is_file() or args.force:
            shutil.copyfile(src, dest)
            snd_written += 1
        sounds[s] = {"file": f"audio/{s}.wav", "vendored": False, "source": str(src)}

    credits = []
    for pack in sorted(used_credits):
        info = CREDITS.get(pack, {"name": "Workshop " + pack, "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=" + pack})
        credits.append({"id": pack, "name": info["name"], "url": info["url"]})

    index = {
        "schema_version": SCHEMA_VERSION,
        "weapons": stems,
        "textures": textures,
        "geometry": geometry,
        "sounds": sounds,
        "credits": credits,
        "missing": {"textures": missing_tex, "geometry": missing_geom, "sounds": missing_snd},
    }
    (FX_DIR / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    print(f"textures: {len(textures)} ({tex_written} written), missing {missing_tex}")
    print(f"geometry: {len(geometry)} ({geom_written} fx glbs), missing {missing_geom}")
    print(f"sounds: {len(sounds)} ({snd_written} copied), missing {missing_snd}")
    print(f"-> {(FX_DIR / 'index.json').relative_to(REPO).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
