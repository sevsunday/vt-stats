#!/usr/bin/env python3
"""Downscale replay model textures to 128px.

Reads stock perf / emissive / team-color PNGs and the same three folders
under each workshop pack. Writes a mirror at
data/models/textures/replay-lite/. The 3D replay's Reduced quality setting
fetches that mirror. hq, normal, and specular folders are skipped because
the replay never loads them.

Idempotent: an existing output newer than its source is left alone.
Images already within 128px on the long side are copied unchanged.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TEXTURES = ROOT / "data" / "models" / "textures"
OUT = TEXTURES / "replay-lite"
KINDS = ("perf", "emissive", "teamcolor")
MAX_EDGE = 128


def sources():
    for kind in KINDS:
        folder = TEXTURES / kind
        if folder.is_dir():
            for src in sorted(folder.glob("*.png")):
                yield src, OUT / kind / src.name
    mods = TEXTURES / "mods"
    if not mods.is_dir():
        return
    for pack in sorted(p for p in mods.iterdir() if p.is_dir()):
        for kind in KINDS:
            folder = pack / kind
            if not folder.is_dir():
                continue
            for src in sorted(folder.glob("*.png")):
                yield src, OUT / "mods" / pack.name / kind / src.name


def fit(im: Image.Image) -> Image.Image:
    w, h = im.size
    long_edge = max(w, h)
    if long_edge <= MAX_EDGE:
        return im
    scale = MAX_EDGE / long_edge
    nw = max(1, round(w * scale))
    nh = max(1, round(h * scale))
    return im.resize((nw, nh), Image.Resampling.LANCZOS)


def emit(src: Path, dest: Path, force: bool) -> str:
    if (
        not force
        and dest.is_file()
        and dest.stat().st_size > 0
        and dest.stat().st_mtime >= src.stat().st_mtime
    ):
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im.load()
        if max(im.size) <= MAX_EDGE:
            shutil.copy2(src, dest)
            return "copy"
        out = fit(im)
        if out.mode not in ("RGB", "RGBA"):
            out = out.convert("RGBA")
        out.save(dest, format="PNG", optimize=True)
    return "resize"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="rewrite every output")
    args = parser.parse_args()
    counts = {"skip": 0, "copy": 0, "resize": 0}
    n = 0
    for src, dest in sources():
        kind = emit(src, dest, args.force)
        counts[kind] += 1
        n += 1
        if n % 100 == 0:
            print(f"  {n} ...", file=sys.stderr)
    print(
        f"replay-lite: {counts['resize']} resized, "
        f"{counts['copy']} copied, {counts['skip']} unchanged"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
