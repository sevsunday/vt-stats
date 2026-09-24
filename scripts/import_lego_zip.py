#!/usr/bin/env python3
"""
scripts/import_lego_zip.py — one-shot unpack of Darkvale's Bricklink.zip.

Copies every `.io` (incl. `.ldr.io`) from the zip into `data/lego/` and
routes each PNG/GIF (and other RENDER_EXTS) into `data/lego/<slug>/renders/`
by longest `.io`-stem prefix match. Instruction PDFs are skipped.

Slug assignment reuses `parse_meta` / `make_slug` from `scripts/build_lego.py`
so the importer and the builder agree on every directory name.

NOT part of the pipeline. After this runs:

    python scripts/build_lego.py

Usage:
  python scripts/import_lego_zip.py
  python scripts/import_lego_zip.py path/to/Bricklink.zip
  python scripts/import_lego_zip.py --renders data/lego/new_model_bulk_download/renders
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile

# Allow `python scripts/import_lego_zip.py` to import sibling modules.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_lego import (  # noqa: E402
    INDEX_PATH,
    LEGO_DIR,
    RENDER_EXTS,
    make_slug,
    parse_meta,
)

SKIP_EXTS = (".pdf",)
DEFAULT_ZIP = os.path.join(LEGO_DIR, "Bricklink.zip")


def _basename(entry_name: str) -> str:
    return entry_name.replace("\\", "/").rstrip("/").split("/")[-1]


def _io_stem(fname: str) -> str:
    if fname.lower().endswith(".io"):
        return fname[:-3]
    return os.path.splitext(fname)[0]


def _img_stem(fname: str) -> str:
    return os.path.splitext(fname)[0]


# Remainder after a matched stem. Angle shots (`_2`, `V1`, `V1.25`, `V1UD`,
# `trans`, a bare trailing digit). A leading dot is a longer version
# (`V4` must not take `V4.5`). `_` plus a letter is a different model
# (`DESERT_STORM` must not take `DESERT_STORM_CAMO`).
_ANGLE_RE = re.compile(
    r"^(?:_\d+|-\d+|\d+|(?:V\d+(?:\.\d+)?)+(?:UD|D)?|trans)$",
    re.IGNORECASE,
)

# Image stems that do not share the .io filename. Mapped to a source .io
# that is still in data/lego/ after the scrap pass.
_EXTRA_STEMS = (
    ("Display-APC[ISDF]", "APC[ISDF].ldr.io"),
    ("Display-Bomber[ISDF]", "Bomber[ISDF]V2.io"),
    ("Display-Scout[ISDF]", "Scout[ISDF]V2.io"),
    ("Display-Walker[ISDF]", "Walker[ISDF]V5.io"),
    ("Display-Rocket-Tank[ISDF]", "Rocket-Tank[ISDF]V5.io"),
    ("Scout[ISDF]trans", "Scout[ISDF]V2.io"),
    ("Turret[ISDF]Trans", "Turret[ISDF]V3.0.io"),
    ("Tug[ISDF]", "Tug[ISDF]V2.io"),
    ("ISDF-DESERT_STORM_CAMO_V2", "ISDF-DESERT_STORM_CAMO_Copy.io"),
    ("transmitter", "Transmitter[BLACK DOG].io"),
)


def _stem_aliases(io_stem: str) -> list[str]:
    """Real stem, plus `_Copy` stripped and a trailing `V3.0` -> `V3`."""
    stems = [io_stem]
    if io_stem.endswith("_Copy"):
        stems.append(io_stem[: -len("_Copy")])
    for stem in list(stems):
        if re.search(r"V\d+\.0$", stem, re.IGNORECASE):
            stems.append(re.sub(r"\.0$", "", stem))
    out: list[str] = []
    seen: set[str] = set()
    for stem in stems:
        if stem not in seen:
            seen.add(stem)
            out.append(stem)
    return out


def _rest_ok(rest: str) -> bool:
    if not rest:
        return True
    if rest.startswith("."):
        return False
    if re.match(r"_[A-Za-z]", rest):
        return False
    return _ANGLE_RE.match(rest) is not None


def _longest_io_prefix(img_stem: str, stems: list[tuple[str, str]]) -> str | None:
    """Slug of the longest stem that prefixes img_stem with an angle remainder."""
    best_slug = None
    best_len = -1
    img_cf = img_stem.casefold()
    for stem, slug in stems:
        stem_cf = stem.casefold()
        if img_cf.startswith(stem_cf) and len(stem) > best_len:
            if not _rest_ok(img_stem[len(stem):]):
                continue
            best_slug = slug
            best_len = len(stem)
    return best_slug


def _fallback_slug(img_stem: str, slug_of: dict[str, str]) -> str | None:
    """Weapon-sheet shots that are not named after the parent .io."""
    low = img_stem.casefold()
    if low.startswith("specials-") and "rkt" in low:
        return slug_of.get("Specials-Rockets[ISDF].io")
    if low.startswith("specials-"):
        return slug_of.get("Specials-Cannons[ISDF].io")
    return None


def slugs_for_io_files(io_names: list[str]) -> dict[str, str]:
    """Same slug order as build_lego.main (sorted filenames, make_slug)."""
    used: set[str] = set()
    out: dict[str, str] = {}
    for fname in sorted(io_names):
        name, code, _faction, ver = parse_meta(fname)
        out[fname] = make_slug(name, code, ver, used)
    return out


def stems_for(slug_of: dict[str, str]) -> list[tuple[str, str]]:
    """(match stem, slug) pairs, longest-prefix wins at match time."""
    pairs: list[tuple[str, str]] = []
    for fname, slug in slug_of.items():
        for stem in _stem_aliases(_io_stem(fname)):
            pairs.append((stem, slug))
    for stem, fname in _EXTRA_STEMS:
        slug = slug_of.get(fname)
        if slug:
            pairs.append((stem, slug))
    return pairs


def import_zip(zip_path: str) -> int:
    if not os.path.isfile(zip_path):
        print(f"ERROR: zip not found: {zip_path}")
        return 1

    os.makedirs(LEGO_DIR, exist_ok=True)

    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        io_entries: list[tuple[str, str]] = []   # (zip name, basename)
        img_entries: list[tuple[str, str]] = []
        skipped: list[tuple[str, str]] = []

        for n in names:
            base = _basename(n)
            if not base or base.startswith(".") or base.startswith("__"):
                continue
            lower = base.lower()
            if lower.endswith(".io"):
                io_entries.append((n, base))
            elif lower.endswith(RENDER_EXTS):
                img_entries.append((n, base))
            elif lower.endswith(SKIP_EXTS):
                skipped.append((base, "pdf"))
            else:
                skipped.append((base, "other"))

        io_entries.sort(key=lambda t: t[1])
        copied_io: list[str] = []
        for zip_name, base in io_entries:
            dest = os.path.join(LEGO_DIR, base)
            with z.open(zip_name) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            copied_io.append(base)
            print(f"   io  {base}")

        slug_of = slugs_for_io_files(copied_io)
        stems = stems_for(slug_of)
        for fname, slug in slug_of.items():
            print(f"        {fname} -> {slug}")

        routed: dict[str, list[str]] = {s: [] for s in slug_of.values()}
        unmatched: list[str] = []
        for zip_name, base in img_entries:
            img_stem = _img_stem(base)
            slug = _longest_io_prefix(img_stem, stems) or _fallback_slug(img_stem, slug_of)
            if slug is None:
                unmatched.append(base)
                print(f"   UNMATCHED image: {base}")
                continue
            rdir = os.path.join(LEGO_DIR, slug, "renders")
            os.makedirs(rdir, exist_ok=True)
            dest = os.path.join(rdir, base)
            with z.open(zip_name) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            routed[slug].append(base)
            print(f"   img {base}  ->  {slug}/renders/")

    print()
    print(f"Copied {len(copied_io)} .io files into {LEGO_DIR}")
    with_photos = sum(1 for v in routed.values() if v)
    n_imgs = sum(len(v) for v in routed.values())
    print(f"Routed {n_imgs} images across {with_photos} models.")
    if unmatched:
        print(f"UNMATCHED images ({len(unmatched)}):")
        for u in unmatched:
            print(f"   {u}")
    if skipped:
        print(f"Skipped {len(skipped)} non-model files (pdfs / other):")
        for base, kind in skipped:
            print(f"   [{kind}] {base}")
    print("\nNext: python scripts/build_lego.py")
    return 0


def route_render_dir(render_dir: str, dry_run: bool) -> int:
    """Copy PNGs from an unpacked folder onto the .io files already in data/lego/."""
    render_dir = os.path.abspath(render_dir)
    if not os.path.isdir(render_dir):
        print(f"ERROR: render dir not found: {render_dir}")
        return 1
    io_names = sorted(f for f in os.listdir(LEGO_DIR) if f.lower().endswith(".io"))
    slug_of = slugs_for_io_files(io_names)
    if os.path.isfile(INDEX_PATH):
        prev = json.load(open(INDEX_PATH, encoding="utf-8"))
        by_src = {m["source_file"]: m["slug"] for m in prev.get("models", []) if m.get("source_file")}
        drifted = [f for f in io_names if f in by_src and by_src[f] != slug_of[f]]
        if drifted:
            print(f"ERROR: slug drift vs index.json ({len(drifted)}):")
            for f in drifted:
                print(f"   {f}: index {by_src[f]}  computed {slug_of[f]}")
            return 1
    stems = stems_for(slug_of)
    imgs = sorted(
        f for f in os.listdir(render_dir)
        if f.lower().endswith(RENDER_EXTS)
    )
    routed: dict[str, list[str]] = {}
    unmatched: list[str] = []
    for base in imgs:
        img_stem = _img_stem(base)
        slug = _longest_io_prefix(img_stem, stems) or _fallback_slug(img_stem, slug_of)
        if slug is None:
            unmatched.append(base)
            continue
        routed.setdefault(slug, []).append(base)
        if dry_run:
            continue
        rdir = os.path.join(LEGO_DIR, slug, "renders")
        os.makedirs(rdir, exist_ok=True)
        dest = os.path.join(rdir, base)
        with open(os.path.join(render_dir, base), "rb") as src, open(dest, "wb") as dst:
            dst.write(src.read())
    n_imgs = sum(len(v) for v in routed.values())
    print(f"{'Would route' if dry_run else 'Routed'} {n_imgs} images across {len(routed)} models.")
    for slug in sorted(routed):
        print(f"   {len(routed[slug]):3d}  {slug}")
    print(f"UNMATCHED ({len(unmatched)}):")
    for name in unmatched:
        print(f"   {name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Import Darkvale .io files and studio renders.")
    ap.add_argument("zip", nargs="?", help="BrickLink zip (default data/lego/Bricklink.zip)")
    ap.add_argument("--renders", metavar="DIR", help="route an unpacked renders folder onto existing .io files")
    ap.add_argument("--dry-run", action="store_true", help="with --renders, print the routing and write nothing")
    args = ap.parse_args()
    if args.renders:
        return route_render_dir(args.renders, args.dry_run)
    return import_zip(os.path.abspath(args.zip) if args.zip else DEFAULT_ZIP)


if __name__ == "__main__":
    sys.exit(main())
