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
"""
from __future__ import annotations

import os
import sys
import zipfile

# Allow `python scripts/import_lego_zip.py` to import sibling modules.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build_lego import (  # noqa: E402
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


def _longest_io_prefix(img_stem: str, stems: list[tuple[str, str]]) -> str | None:
    """Return the slug of the longest .io stem that is a prefix of img_stem."""
    best_slug = None
    best_len = -1
    for stem, slug in stems:
        if img_stem.startswith(stem) and len(stem) > best_len:
            best_slug = slug
            best_len = len(stem)
    return best_slug


def main() -> int:
    zip_path = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ZIP)
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

        used: set[str] = set()
        stems: list[tuple[str, str]] = []   # (raw .io stem, slug)
        slug_of: dict[str, str] = {}
        for fname in copied_io:
            name, code, _faction, ver = parse_meta(fname)
            slug = make_slug(name, code, ver, used)
            slug_of[fname] = slug
            stems.append((_io_stem(fname), slug))
            print(f"        -> {slug}")

        routed: dict[str, list[str]] = {s: [] for s in slug_of.values()}
        unmatched: list[str] = []
        for zip_name, base in img_entries:
            slug = _longest_io_prefix(_img_stem(base), stems)
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


if __name__ == "__main__":
    sys.exit(main())
