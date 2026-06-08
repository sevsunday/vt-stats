"""
scan_anims.py -- TEMP smoke test (research only). Corpus-wide scan of every
resolved baked `.msh` to count: how many carry an `anim_list`, the clip names,
frame counts, skinned flag, and the distinct AnimKey `type` values seen.

Reuses convert_msh.enumerate_targets + the same root resolution so the scan
covers exactly the models the viewer ships.

Usage: python _object-render/spike/scan_anims.py [--limit N]
"""
from __future__ import annotations

import argparse
import struct
import sys
from collections import Counter
from ctypes import sizeof
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(ROOT / "_map-analysis" / "scripts"))
import msh_parser as M  # noqa: E402
import convert_msh as C  # noqa: E402

ANIMKEY = 36


def _f32(f):
    return struct.unpack("<f", f.read(4))[0]


def scan_one(path):
    """Return (skinned, [(clipname, type, maxFrame, n_tracks, total_keys)], type_counter) or None."""
    with open(path, "rb") as f:
        hdr = M._read_struct(f, M._BlockHeader)
        if bytes(hdr.fileType) != b"DOCB" or hdr.blockCount == 0:
            return None
        M._read_struct(f, M._BlockInfo)
        M._read_name(f)
        M._read_struct(f, M._Sphere)
        mh = M._read_struct(f, M._MshHeader)

        def skip_arr(ct):
            n = M._read_u32(f); f.read(n * sizeof(ct)); return n
        skip_arr(M._Vec3); skip_arr(M._Vec3); skip_arr(M._UV); skip_arr(M._Color)
        skip_arr(M._FaceObj)
        nb = M._read_u32(f)
        for _ in range(nb):
            M._read_u32(f); M._read_u32(f); M._read_u32(f); M._read_optionals(f)
        nvts = M._read_u32(f)
        for _ in range(nvts):
            m = M._read_u32(f); f.read(m * 6)
        n = M._read_u32(f)
        for _ in range(n):
            M._read_vert_group(f)
        ni = M._read_u32(f); f.read(ni * 2)
        npl = M._read_u32(f); f.read(npl * sizeof(M._Plane))
        n_sm = M._read_u32(f); f.read(n_sm * sizeof(M._Matrix))
        n_states = M._read_u32(f); f.read(n_states * ANIMKEY)

        types = Counter()
        clips = []
        n_al = M._read_u32(f)
        for _ in range(n_al):
            aname = M._read_name(f)
            atype = M._read_u32(f)
            maxf = _f32(f); _f32(f)
            ns = M._read_u32(f)
            for _ in range(ns):
                raw = f.read(ANIMKEY); types[struct.unpack_from("<I", raw, 4)[0]] += 1
            n_anim = M._read_u32(f)
            total_keys = 0
            for _ in range(n_anim):
                M._read_u32(f); _f32(f)
                kc = M._read_u32(f)
                total_keys += kc
                for _ in range(kc):
                    raw = f.read(ANIMKEY); types[struct.unpack_from("<I", raw, 4)[0]] += 1
            clips.append((aname, atype, maxf, n_anim, total_keys))
        return mh.skinned, clips, types


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    targets = C.enumerate_targets(None)
    roots = C.resolve_roots(None)
    msh_index = C.build_file_index(roots, "msh")

    resolved = []
    for stem, meta in sorted(targets.items()):
        mp = msh_index.get(stem)
        if mp:
            resolved.append((stem, meta, mp))
    if args.limit:
        resolved = resolved[:args.limit]

    total = 0
    animated = 0
    skinned_count = 0
    animated_and_skinned = 0
    type_totals = Counter()
    animated_list = []
    errors = 0
    for stem, meta, mp in resolved:
        total += 1
        try:
            res = scan_one(mp)
        except Exception:  # noqa: BLE001
            errors += 1
            continue
        if res is None:
            continue
        skinned, clips, types = res
        if skinned:
            skinned_count += 1
        if clips:
            animated += 1
            if skinned:
                animated_and_skinned += 1
            type_totals.update(types)
            names = ",".join(f"{c[0]}({c[2]:.0f}f,{c[3]}n)" for c in clips)
            animated_list.append((stem, meta["primaryOdf"], meta["category"], skinned, names))

    print(f"\nscanned {total} meshes ({errors} parse errors)")
    print(f"  animated (has anim_list): {animated}")
    print(f"  skinned (msh_header.skinned=1): {skinned_count}")
    print(f"  animated AND skinned: {animated_and_skinned}")
    print(f"  AnimKey 'type' value distribution: {dict(type_totals)}")
    print(f"\n  animated models ({len(animated_list)}):")
    for stem, odf, cat, sk, names in sorted(animated_list, key=lambda x: (x[2], x[0])):
        print(f"    {stem:22s} {cat:10s} skin={int(sk)}  {odf:22s}  {names}")


if __name__ == "__main__":
    main()
