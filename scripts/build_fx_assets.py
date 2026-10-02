"""Weapon-effect textures, sounds and FX meshes for the Weapons Lab shooting range.

Standalone. Not invoked by process_stats.py. Walks the VSR armory the same way
js/weapons-calc.js scope('vsr') does, plus every other named weapon the
armories do not sell (weaponStemsFor().library), and collects every
textureName / geomName / shotGeometry / *.wav those weapons (and the mines
they dispense) reference,
and writes:

    data/fx/textures/<stem>.png   RGBA, longest side <= 256
    data/fx/geometry/<stem>.glb   FX meshes that are not already a model GLB
    data/audio/<stem>.wav         only the clips not already vendored
    data/fx/index.json            stem -> file, plus workshop credits

Existing outputs are skipped unless --force. Sources are searched in the
game's order (the VSR config mod, its asset dependencies in INI order, the
BZ2R install), then the rest of the subscribed workshop tree as a fallback.

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
sys.path.insert(0, str(SCRIPTS / "odf"))

from dds_decode import decode_dds  # noqa: E402
from glb_writer import GlbBuilder  # noqa: E402
from msh_parser import MshError, parse_msh  # noqa: E402
from build_odf_db import VSR_MOD_ID, parse_mod_ini  # noqa: E402

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


def _numbered(obj: dict, prefix: str) -> list[str]:
    """Case-sensitive buildItemN, matching js/weapons-calc.js numbered()."""
    if not isinstance(obj, dict):
        return []
    rx = re.compile(r"^" + prefix + r"(\d+)$")
    rows = []
    for key, value in obj.items():
        match = rx.match(key)
        if match and value is not None and str(value).strip():
            rows.append((int(match.group(1)), str(value).strip()))
    rows.sort()
    return [value for _, value in rows]


def _armory_children(entry: dict) -> list[str]:
    """Factory, rig, and armory build items plus upgradeName. Mirrors childNames."""
    found = []
    seen = set()

    def add(raw):
        stem = stem_of(raw)
        if stem and stem not in seen:
            seen.add(stem)
            found.append(stem)

    for raw in _numbered(entry.get("FactoryClass") or {}, "buildItem"):
        add(raw)
    for raw in _numbered(entry.get("ConstructionRigClass") or {}, "buildItem"):
        add(raw)
    groups = [key for key in entry if re.match(r"^ArmoryGroup\d+$", key)]
    groups.sort(key=lambda key: int(key[len("ArmoryGroup"):]))
    for key in groups:
        group = entry[key]
        if isinstance(group, dict):
            for raw in _numbered(group, "buildItem"):
                add(raw)
    go = entry.get("GameObjectClass") or {}
    if isinstance(go, dict) and go.get("upgradeName"):
        add(go.get("upgradeName"))
    return found


def armory_weapon_stems(db: dict) -> set[str]:
    """Powerups sold by the three VSR armories, plus altName twins.

    Mirrors weapons-calc armoryByFaction(). Ship mounts are not included;
    those stay on the VSR walk.
    """
    by_stem = {}
    for bucket, entries in db.items():
        if not isinstance(entries, dict):
            continue
        for name, entry in entries.items():
            by_stem[stem_of(name)] = (bucket, entry)

    weapons = set()
    seen = set()
    stack = list(VSR_ROOTS)
    while stack:
        stem = stack.pop()
        if stem in seen:
            continue
        seen.add(stem)
        hit = by_stem.get(stem)
        if not hit:
            continue
        bucket, entry = hit
        if bucket == "Powerup":
            weapon = stem_of(prop_ci(section_ci(entry, "WeaponPowerupClass"), "weaponName"))
            rec = by_stem.get(weapon) if weapon else None
            if weapon and rec and rec[0] == "Weapon":
                weapons.add(weapon)
                alt = stem_of(prop_ci(section_ci(rec[1], "WeaponClass"), "altName"))
                alt_rec = by_stem.get(alt) if alt else None
                if alt and alt_rec and alt_rec[0] == "Weapon":
                    weapons.add(alt)
        stack.extend(_armory_children(entry))
    return weapons


def library_weapon_stems(db: dict) -> list[str]:
    """Named weapons the VSR armories do not sell.

    Mirrors weaponStemsFor(null).library against the stock database
    (community packs are merged in the page, not here).
    """
    armory = armory_weapon_stems(db)
    library = set()
    for name, entry in (db.get("Weapon") or {}).items():
        stem = stem_of(name)
        if not stem or stem in armory:
            continue
        wpn = str(prop_ci(section_ci(entry, "WeaponClass"), "wpnName") or "").replace('"', "'").strip()
        if not wpn or wpn.upper() == "NULL":
            continue
        library.add(stem)
    return sorted(library)


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


SECTION_REF_RE = re.compile(
    r"^(rendername\d*|renderbase|emitname|particleclass\d+|flashname|effectname\d*)$", re.I)


def section_ref_files(entry: dict) -> list[str]:
    """Files named by "file.section" render, flash, emitter, particle and
    effect names (renderName = "shellgun_c.render" is the [render] section of
    shellgun_c.odf; effectName1 = "hfire2.render" is hfire2.odf). The range
    borrows such sections when the entry's own tree lacks them
    (js/fx/weapon-profile.js mergeCrossRefs), so their assets ship too."""
    out = []
    for sec in entry.values():
        if not isinstance(sec, dict):
            continue
        for k, v in sec.items():
            if not isinstance(v, str) or not SECTION_REF_RE.match(str(k)):
                continue
            parts = v.strip().replace('"', "").lower().split(".")
            if len(parts) < 2 or not parts[-1] or parts[-1].startswith("draw_"):
                continue
            out.append(".".join(parts[:-1]))
    return out


def follow_dispensed(db: dict, weapon: dict, tex, geom, snd, seen: set) -> None:
    """Mines, payloads, leader rounds, charge ordnances, explosions and the
    files named by "file.section" render names are separate ODFs; the weapon
    entry only names them."""
    pending = named_refs(weapon) + section_ref_files(weapon)
    while pending:
        s = pending.pop()
        if s in seen:
            continue
        seen.add(s)
        entry = None
        for bucket in ("Mine", "Misc", "Ordnance", "Explosion", "Effect", "Weapon"):
            hit = db.get(bucket, {}).get(s + ".odf")
            if hit:
                entry = hit
                break
        if not entry:
            continue
        walk_refs(entry, tex, geom, snd)
        pending.extend(named_refs(entry) + section_ref_files(entry))


def search_roots(bz2r: Path, workshop: Path) -> list[Path]:
    """Directories in the game's lookup order, first match wins: the VSR
    config mod, its asset dependencies in INI order, then the base game.
    The rest of the workshop tree follows as a fallback for art outside
    that set."""
    roots = []
    ini = workshop / VSR_MOD_ID / f"{VSR_MOD_ID}.ini"
    if ini.is_file():
        deps = parse_mod_ini(ini).get("WORKSHOP", {}).get("assetDependencies", "")
        roots.append(workshop / VSR_MOD_ID)
        roots.extend(workshop / wid.strip() for wid in deps.split(",") if wid.strip())
    roots += [bz2r, workshop]
    return roots


def index_files(roots: list[Path], exts: set[str]) -> dict[str, Path]:
    """stem -> the first path across `roots` (first wins)."""
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
    vsr = vsr_weapon_stems(db)
    if len(vsr) < 100:
        print(f"error: VSR weapon scope resolved only {len(vsr)} (expected ~123)", file=sys.stderr)
        return 1
    library = library_weapon_stems(db)
    stems = sorted(set(vsr) | set(library))
    weapon_by_stem = {stem_of(name): entry for name, entry in db["Weapon"].items()}

    tex, geom, snd = set(), set(), set()
    followed = set()
    for s in stems:
        entry = weapon_by_stem.get(s)
        if entry is None:
            print(f"warn: no weapon entry {s}", file=sys.stderr)
            continue
        walk_refs(entry, tex, geom, snd)
        follow_dispensed(db, entry, tex, geom, snd, followed)

    print(f"VSR weapons: {len(vsr)}; library: {len(library)}; effect walk: {len(stems)}")
    print(f"textures {len(tex)}, geoms {len(geom)}, sounds {len(snd)}")

    roots = search_roots(args.bz2r, args.workshop)
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
