"""Build community weapon packs for the Weapons Lab.

Standalone. Not invoked by process_stats.py. Each creator drops a pack under
contrib/<id>/ (see contrib/README.md). This script parses those ODFs against
the stock data/odf.min.json (inheritance and composition refs resolve into the
stock corpus, which is never rewritten), decodes textures and copies sounds,
and writes:

    data/contrib/index.json
    data/contrib/<id>/odf.min.json
    data/contrib/<id>/fx.json
    data/contrib/<id>/textures/<stem>.png
    data/contrib/<id>/audio/<stem>.wav

A texture or sound the pack does not ship is reused from data/fx/textures/ or
data/audio/ when that file is already there. Otherwise the local BZ2R install
is searched and the stock asset is copied into those shared dirs. Anything
still missing is listed under fx.json "missing" and printed.

    python scripts/build_contrib_weapons.py
    python scripts/build_contrib_weapons.py --only lamper
    python scripts/build_contrib_weapons.py --force
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS / "odf"))
sys.path.insert(0, str(SCRIPTS / "object-render"))

from build_fx_assets import (  # noqa: E402
    CREDITS,
    TEX_MAX,
    credit_for,
    follow_dispensed,
    index_files,
    stem_of,
    walk_refs,
)
from build_odf_db import (  # noqa: E402
    CATEGORIES,
    STAGE4_WALLCLOCK_CAP_S,
    apply_powerup_push,
    categorize_corpus,
    expand_refs,
    parse_odf_text,
    process_inheritance,
)
from dds_decode import UnsupportedDDS, decode_dds, decode_dxtbz2  # noqa: E402
from PIL import Image  # noqa: E402

REPO = SCRIPTS.parent
CONTRIB_SRC = REPO / "contrib"
STOCK_ODF = REPO / "data" / "odf.min.json"
OUT_ROOT = REPO / "data" / "contrib"
INDEX_PATH = OUT_ROOT / "index.json"
FX_TEX = REPO / "data" / "fx" / "textures"
FX_GEOM = REPO / "data" / "fx" / "geometry"
MODEL_GEOM = REPO / "data" / "models" / "geometry"
AUDIO_DIR = REPO / "data" / "audio"
DEFAULT_BZ2R = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
DEFAULT_WS = Path(r"C:\Program Files (x86)\Steam\steamapps\workshop\content\624970")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
SCHEMA_VERSION = 1
IMAGE_PREFERENCE = (".dxtbz2", ".dds", ".tga", ".png")


def discover(only: str | None) -> list[tuple[str, Path, dict]]:
    """(id, weapons dir, manifest) for every contrib/<id>/contrib.json."""
    if not CONTRIB_SRC.is_dir():
        print(f"error: {CONTRIB_SRC} does not exist", file=sys.stderr)
        sys.exit(1)
    found = []
    for manifest_path in sorted(CONTRIB_SRC.glob("*/contrib.json")):
        folder = manifest_path.parent
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"error: {manifest_path}: {exc}", file=sys.stderr)
            sys.exit(1)
        pack_id = str(manifest.get("id") or "").strip().lower()
        if pack_id != folder.name or not ID_RE.match(pack_id):
            print(
                f"error: {manifest_path}: id {pack_id!r} must match the folder name "
                f"({folder.name!r}) and {ID_RE.pattern}",
                file=sys.stderr,
            )
            sys.exit(1)
        if manifest.get("schema_version") != SCHEMA_VERSION:
            print(
                f"error: {manifest_path}: schema_version must be {SCHEMA_VERSION}",
                file=sys.stderr,
            )
            sys.exit(1)
        if not str(manifest.get("name") or "").strip():
            print(f"error: {manifest_path}: name is required", file=sys.stderr)
            sys.exit(1)
        weapons = folder / "weapons"
        if not weapons.is_dir():
            print(f"error: {weapons} does not exist", file=sys.stderr)
            sys.exit(1)
        if only and pack_id != only:
            continue
        found.append((pack_id, weapons, manifest))
    if only and not found:
        print(f"error: no contrib pack with id {only!r}", file=sys.stderr)
        sys.exit(1)
    if not found and not only:
        print("error: no contrib/*/contrib.json packs found", file=sys.stderr)
        sys.exit(1)
    return found


def flatten_stock() -> tuple[dict, dict]:
    db = json.loads(STOCK_ODF.read_text(encoding="utf-8"))
    flat = {}
    for bucket, entries in db.items():
        if not isinstance(entries, dict):
            continue
        for name, blocks in entries.items():
            flat[name.lower()] = blocks
    return flat, db


def collect_odfs(root: Path) -> dict[str, Path]:
    """basename lower -> path. Later sorted path wins, so the result is stable."""
    out = {}
    overrides = 0
    for path in sorted(root.rglob("*"), key=lambda p: str(p).lower()):
        if not path.is_file() or path.suffix.lower() != ".odf":
            continue
        key = path.name.lower()
        if key in out:
            overrides += 1
        out[key] = path
    if overrides:
        print(f"  {overrides} duplicate ODF name(s); the later path won")
    return out


def parse_pack(files: dict[str, Path]) -> dict[str, dict]:
    out = {}
    for name, path in files.items():
        text = path.read_text(encoding="utf-8", errors="replace")
        out[name] = parse_odf_text(text)
    return out


def index_by_preference(root: Path, ranking: tuple[str, ...]) -> dict[str, Path]:
    """stem -> best file. Lower rank index wins; equal rank keeps the first path."""
    best = {}
    rank = {}
    if not root.is_dir():
        return best
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in ranking:
            continue
        key = path.stem.lower()
        r = ranking.index(ext)
        if key not in best or r < rank[key]:
            best[key] = path
            rank[key] = r
    return best


def write_texture(src: Path, dest: Path, force: bool) -> None:
    if dest.is_file() and not force:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower()
    if ext == ".dxtbz2":
        img = decode_dxtbz2(src, max_dim=TEX_MAX)
    elif ext == ".dds":
        img = decode_dds(src, max_dim=TEX_MAX)
    elif ext in (".png", ".tga"):
        img = Image.open(src).convert("RGBA")
        img.thumbnail((TEX_MAX, TEX_MAX))
    else:
        raise UnsupportedDDS(ext)
    img.save(dest, optimize=True)


def rel_data(path: Path) -> str:
    return path.relative_to(REPO / "data").as_posix()


def build_pack(pack_id, weapons_dir, manifest, stock_flat, stock_db, args) -> dict:
    print(f"\n[{pack_id}] {weapons_dir.relative_to(REPO).as_posix()}")
    files = collect_odfs(weapons_dir)
    parsed = parse_pack(files)
    print(f"  parsed {len(parsed)} ODFs")

    collisions = sorted(name for name in parsed if name in stock_flat)
    if collisions:
        print(
            f"error: {len(collisions)} ODF name(s) already exist in the stock database:",
            file=sys.stderr,
        )
        for name in collisions:
            print(f"  {name}", file=sys.stderr)
        sys.exit(1)

    corpus = dict(stock_flat)
    corpus.update(parsed)
    pack_names = list(parsed)
    for name in pack_names:
        corpus[name] = process_inheritance(name, corpus[name], corpus)

    settled = set(stock_flat)
    deadline = time.monotonic() + STAGE4_WALLCLOCK_CAP_S
    t0 = time.monotonic()
    for name in pack_names:
        expand_refs(name, corpus, settled, visited=(), depth=0, deadline=deadline)
    print(f"  expanded refs in {time.monotonic() - t0:.2f}s")

    pack_only = {name: corpus[name] for name in pack_names}
    apply_powerup_push(pack_only)

    categorized, dropped = categorize_corpus(pack_only)
    for cat_name, _sigs in CATEGORIES:
        count = len(categorized.get(cat_name, {}))
        if count:
            print(f"  {cat_name:10s}: {count}")
    if dropped:
        print(f"  dropped {len(dropped)} (config / abstract)")

    # Asset walk uses the merged database so a pack weapon can name a stock
    # explosion, and a stock weapon is never the thing being walked.
    merged = {cat: dict(entries) for cat, entries in stock_db.items() if isinstance(entries, dict)}
    for cat, entries in categorized.items():
        merged.setdefault(cat, {}).update(entries)

    tex, geom, snd = set(), set(), set()
    followed = set()
    weapon_names = sorted(categorized.get("Weapon", {}))
    for name in weapon_names:
        entry = categorized["Weapon"][name]
        walk_refs(entry, tex, geom, snd)
        follow_dispensed(merged, entry, tex, geom, snd, followed)
    print(f"  asset refs: {len(tex)} textures, {len(geom)} geoms, {len(snd)} sounds")

    out_dir = OUT_ROOT / pack_id
    tex_dir = out_dir / "textures"
    audio_dir = out_dir / "audio"
    tex_dir.mkdir(parents=True, exist_ok=True)
    audio_dir.mkdir(parents=True, exist_ok=True)

    pack_images = index_by_preference(weapons_dir, IMAGE_PREFERENCE)
    pack_wavs = index_by_preference(weapons_dir, (".wav",))
    install_images = index_files([args.bz2r, args.workshop], {".dds", ".tga", ".png"})
    install_wavs = index_files([args.bz2r, args.workshop], {".wav"})

    textures = {}
    missing_tex = []
    written_tex = 0
    used_credits = set()
    for stem in sorted(tex):
        pack_src = pack_images.get(stem)
        shared = FX_TEX / f"{stem}.png"
        if pack_src:
            dest = tex_dir / f"{stem}.png"
            try:
                write_texture(pack_src, dest, args.force)
            except (UnsupportedDDS, OSError) as exc:
                print(f"  warn: texture {stem}: {exc}", file=sys.stderr)
                missing_tex.append(stem)
                continue
            written_tex += 1
            textures[stem] = {"file": rel_data(dest), "source": "pack", "credit": None}
            continue
        if shared.is_file():
            textures[stem] = {"file": rel_data(shared), "source": "shared", "credit": None}
            continue
        install = install_images.get(stem)
        if install:
            try:
                write_texture(install, shared, args.force)
            except (UnsupportedDDS, OSError) as exc:
                print(f"  warn: install texture {stem}: {exc}", file=sys.stderr)
                missing_tex.append(stem)
                continue
            pack = credit_for(install)
            if pack:
                used_credits.add(pack)
            textures[stem] = {"file": rel_data(shared), "source": "install", "credit": pack}
            continue
        missing_tex.append(stem)

    sounds = {}
    missing_snd = []
    written_snd = 0
    for stem in sorted(snd):
        pack_src = pack_wavs.get(stem)
        shared = AUDIO_DIR / f"{stem}.wav"
        if pack_src:
            dest = audio_dir / f"{stem}.wav"
            if args.force or not dest.is_file():
                shutil.copyfile(pack_src, dest)
                written_snd += 1
            sounds[stem] = {"file": rel_data(dest), "source": "pack"}
            continue
        if shared.is_file():
            sounds[stem] = {"file": rel_data(shared), "source": "shared", "vendored": True}
            continue
        install = install_wavs.get(stem)
        if install:
            if args.force or not shared.is_file():
                shutil.copyfile(install, shared)
                written_snd += 1
            sounds[stem] = {"file": rel_data(shared), "source": "install", "vendored": False}
            continue
        missing_snd.append(stem)

    geometry = {}
    missing_geom = []
    for stem in sorted(geom):
        model = MODEL_GEOM / f"{stem}.glb"
        fx = FX_GEOM / f"{stem}.glb"
        if model.is_file():
            geometry[stem] = {"file": rel_data(model), "kind": "model"}
        elif fx.is_file():
            geometry[stem] = {"file": rel_data(fx), "kind": "fx"}
        else:
            missing_geom.append(stem)

    credits = []
    for pack in sorted(used_credits):
        info = CREDITS.get(pack, {
            "name": "Workshop " + pack,
            "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=" + pack,
        })
        credits.append({"id": pack, "name": info["name"], "url": info["url"]})

    missing = {"textures": missing_tex, "geometry": missing_geom, "sounds": missing_snd}
    fx_doc = {
        "schema_version": SCHEMA_VERSION,
        "contributor": pack_id,
        "weapons": [stem_of(name) for name in weapon_names],
        "textures": textures,
        "geometry": geometry,
        "sounds": sounds,
        "credits": credits,
        "missing": missing,
    }
    odf_path = out_dir / "odf.min.json"
    fx_path = out_dir / "fx.json"
    odf_path.write_text(json.dumps(categorized, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    fx_path.write_text(json.dumps(fx_doc, indent=2) + "\n", encoding="utf-8")

    print(
        f"  textures: {len(textures)} ({written_tex} from the pack), missing {len(missing_tex)}"
    )
    print(f"  sounds: {len(sounds)} ({written_snd} copied), missing {len(missing_snd)}")
    print(f"  geometry: {len(geometry)}, missing {len(missing_geom)}")
    if missing_tex:
        print("  missing textures: " + ", ".join(missing_tex))
    if missing_snd:
        print("  missing sounds: " + ", ".join(missing_snd))
    if missing_geom:
        print("  missing geometry: " + ", ".join(missing_geom))

    url = manifest.get("url") or None
    return {
        "id": pack_id,
        "name": str(manifest["name"]).strip(),
        "url": url if isinstance(url, str) and url.strip() else None,
        "description": str(manifest.get("description") or "").strip(),
        "odf": rel_data(odf_path),
        "fx": rel_data(fx_path),
        "counts": {
            "weapons": len(categorized.get("Weapon", {})),
            "ordnance": len(categorized.get("Ordnance", {})),
            "explosions": len(categorized.get("Explosion", {})),
            "powerups": len(categorized.get("Powerup", {})),
            "textures": len(textures),
            "sounds": len(sounds),
        },
        "missing": missing,
    }


def write_index(updated: list[dict], manifests: dict[str, dict]) -> None:
    """Refresh index.json. Packs not rebuilt this run keep their entry when
    their built bundle is still on disk."""
    previous = {}
    if INDEX_PATH.is_file():
        try:
            doc = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
            for entry in doc.get("contributors") or []:
                if isinstance(entry, dict) and entry.get("id"):
                    previous[entry["id"]] = entry
        except json.JSONDecodeError:
            previous = {}
    for entry in updated:
        previous[entry["id"]] = entry
    contributors = []
    for pack_id in sorted(previous):
        if pack_id not in manifests:
            continue
        if not (OUT_ROOT / pack_id / "odf.min.json").is_file():
            continue
        contributors.append(previous[pack_id])
    doc = {
        "schema_version": SCHEMA_VERSION,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "contributors": contributors,
    }
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"\n-> {INDEX_PATH.relative_to(REPO).as_posix()} ({len(contributors)} pack(s))")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build community weapon packs for the Weapons Lab.")
    ap.add_argument("--only", help="Build just this contributor id")
    ap.add_argument("--bz2r", type=Path, default=DEFAULT_BZ2R)
    ap.add_argument("--workshop", type=Path, default=DEFAULT_WS)
    ap.add_argument("--force", action="store_true", help="Re-decode textures and re-copy sounds")
    args = ap.parse_args(argv)

    if not STOCK_ODF.is_file():
        print(f"error: {STOCK_ODF} is missing", file=sys.stderr)
        return 1

    packs = discover(args.only.strip().lower() if args.only else None)
    manifests = {pack_id: manifest for pack_id, _weapons, manifest in discover(None)}
    # discover(None) exits when empty; packs already proved the tree exists.
    print(f"Stock ODF: {STOCK_ODF.relative_to(REPO).as_posix()}")
    stock_flat, stock_db = flatten_stock()
    print(f"  {len(stock_flat)} stock ODFs")

    updated = []
    for pack_id, weapons_dir, manifest in packs:
        updated.append(build_pack(pack_id, weapons_dir, manifest, stock_flat, stock_db, args))
    write_index(updated, manifests)
    return 0


if __name__ == "__main__":
    sys.exit(main())
