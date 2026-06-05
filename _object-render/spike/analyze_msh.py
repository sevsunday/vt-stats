"""
analyze_msh.py -- reverse-engineering spike for the BZCC baked `.msh` (DOCB)
binary mesh format.

Read-only forensic dumper: reads a single `.msh`, prints the header, walks the
node/string/float regions, and tries several vertex-stride interpretations so
we can lock down the layout against a known unit (ivscout00).

NOT the production converter -- that's scripts/object-render/convert_msh.py. This stays in
_object-render/spike/ as the format-decode work record.

Usage:
  python _object-render/spike/analyze_msh.py [path-to-msh]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

DEFAULT = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R"
    r"\bz2r_res\baked\ISDF\vehicles\ivscout00.msh"
)


def hexdump(b: bytes, base: int = 0, n: int = 256) -> None:
    for i in range(0, min(n, len(b)), 16):
        chunk = b[i : i + 16]
        hx = " ".join(f"{c:02x}" for c in chunk)
        asc = "".join(chr(c) if 32 <= c <= 126 else "." for c in chunk)
        print(f"  0x{base + i:06x}  {hx:<48}  {asc}")


def find_ascii_runs(b: bytes, minlen: int = 4):
    runs = []
    cur = []
    start = 0
    for i, c in enumerate(b):
        if 32 <= c <= 126:
            if not cur:
                start = i
            cur.append(chr(c))
        else:
            if len(cur) >= minlen:
                runs.append((start, "".join(cur)))
            cur = []
    if len(cur) >= minlen:
        runs.append((start, "".join(cur)))
    return runs


def f32(b: bytes, off: int) -> float:
    return struct.unpack_from("<f", b, off)[0]


def u32(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]


def u16(b: bytes, off: int) -> int:
    return struct.unpack_from("<H", b, off)[0]


def plausible_float(v: float) -> bool:
    import math

    if math.isnan(v) or math.isinf(v):
        return False
    a = abs(v)
    return a == 0.0 or (1e-4 < a < 1e5)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    b = path.read_bytes()
    print(f"file: {path}")
    print(f"size: {len(b)} bytes (0x{len(b):x})")

    print("\n=== magic + header ===")
    print(f"  magic           : {b[0:4]!r}")
    print(f"  u32@0x04        : {u32(b, 0x04)}")
    print(f"  u32@0x08        : {u32(b, 0x08)}")
    print(f"  bytes 0x0c-0x2b : {b[0x0c:0x2c].hex()}")
    print(f"  u32@0x2c        : {u32(b, 0x2c)}  (0x{u32(b,0x2c):x})")
    print(f"  u32@0x30        : {u32(b, 0x30)}  (0x{u32(b,0x30):x})  filesize-52={len(b)-52}")

    print("\n=== first 0x80 bytes ===")
    hexdump(b, 0, 0x80)

    print("\n=== ascii runs (offset, text) ===")
    for off, s in find_ascii_runs(b, 4):
        # filter the float-noise: keep ones with letters
        if any(ch.isalpha() for ch in s) and len(s) >= 4:
            print(f"  0x{off:06x}  {s!r}")

    # Try to read the node header right after the 52-byte header.
    print("\n=== node region @ 0x34 ===")
    off = 0x34
    nlen = u16(b, off)
    print(f"  u16@0x34 (namelen?) : {nlen}")
    name = b[off + 2 : off + 2 + nlen]
    print(f"  name                : {name!r}")
    after = off + 2 + nlen
    print(f"  after-name offset   : 0x{after:x}")
    print(f"  next 16 floats:")
    for i in range(16):
        v = f32(b, after + i * 4)
        print(f"    [{i:2d}] @0x{after + i*4:06x}  {v: .6f}")

    main_scan(b)


def main_scan(b: bytes):
    """Scan for uint32 values that look like vertex/index counts: a count C
    such that off+4 + C*stride lands on another plausible count or EOF."""
    print("\n=== count-candidate scan (stride guesses) ===")
    strides = [12, 20, 24, 28, 32, 36]
    n = len(b)
    hits = []
    for off in range(0x34, n - 8, 4):
        c = u32(b, off)
        if c < 8 or c > 200000:
            continue
        for st in strides:
            end = off + 4 + c * st
            if end <= n and end > off + 4 + 8 * st:
                # check the value right after the block is a small plausible count
                if end + 4 <= n:
                    nxt = u32(b, end)
                    if 0 <= nxt < 200000:
                        hits.append((off, c, st, end, nxt))
    # Dedup-ish: print the most promising (largest blocks)
    hits.sort(key=lambda h: -h[1] * h[2])
    seen = 0
    for off, c, st, end, nxt in hits:
        print(
            f"  count@0x{off:06x}={c:<7d} stride={st:<3d} -> block_end=0x{end:06x} next_u32={nxt}"
        )
        seen += 1
        if seen >= 25:
            break


if __name__ == "__main__":
    main()
