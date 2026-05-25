"""One-shot probe to figure out the .TER layout for Europa Night.

We have a 3,233,162-byte file with 16 header bytes carrying:
   magic 'TERR', version 5, tile bounds (-512..+512, -512..+512)
   => 1024x1024 cells, payload = 3,233,146 bytes (~3.08 bytes/cell).

Try multiple decode strategies and report which yields plausible heights
(range in [0,500]m, nonzero stdev). Print a stats line per layout.
"""
import struct
import math
from pathlib import Path

P = Path("Europa Night/vsreuronig.TER")
raw = P.read_bytes()
print(f"file size: {len(raw):,} bytes")
print(f"magic: {raw[:4]!r}, version_LE: {int.from_bytes(raw[4:8], 'little')}")
for off in (8, 10, 12, 14):
    print(f"  bytes[{off}:{off+2}] as i16 LE = {int.from_bytes(raw[off:off+2], 'little', signed=True)}")
print()

CX = CZ = 1024
total = CX * CZ
print(f"assume {CX}x{CZ} = {total:,} cells")
print()


def stats(vals):
    if not vals:
        return None
    vals = [v for v in vals if math.isfinite(v)]
    if not vals:
        return None
    m = sum(vals) / len(vals)
    var = sum((x - m) ** 2 for x in vals) / len(vals)
    return min(vals), max(vals), m, var ** 0.5


def sample(layout, n_samples=8000):
    """layout: callable(int idx) -> float or None.
    Pulls n_samples evenly spaced cells, returns stats."""
    step = max(1, total // n_samples)
    vals = []
    for i in range(0, total, step):
        v = layout(i)
        if v is None:
            continue
        vals.append(v)
    return stats(vals)


# Layout A: int16 LE, scaled by HeightGranularity = 0.1, at offset 16
def A(i):
    o = 16 + i * 2
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=True)
    return v * 0.1


# Layout B: int16 LE, scaled by Height/32767 = 100/32767, at offset 16
def B(i):
    o = 16 + i * 2
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=True)
    return v * (100 / 32767)


# Layout C: int16 LE at offset 20 (skip 4-byte sub-header), scaled 0.1
def C(i):
    o = 20 + i * 2
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=True)
    return v * 0.1


# Layout D: float32 BE at offset 20 (skip 4-byte sub-header), stride 3
# (heights only every 3 bytes -- improbable but who knows)
def D(i):
    o = 20 + i * 3
    if o + 4 > len(raw):
        return None
    return struct.unpack(">f", raw[o:o + 4])[0]


# Layout E: uint16 LE at offset 16, scale 0.1 (matches HeightGranularity)
def E(i):
    o = 16 + i * 2
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=False)
    return v * 0.1


# Layout F: 3 bytes per cell, interpret first 2 as int16 LE * 0.1 (height),
# and the 3rd byte is texture/blend index (ignored here)
def F(i):
    o = 16 + i * 3
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=True)
    return v * 0.1


# Layout G: same as F but uint16
def G(i):
    o = 16 + i * 3
    if o + 2 > len(raw):
        return None
    v = int.from_bytes(raw[o:o + 2], "little", signed=False)
    return v * 0.1


layouts = [
    ("A int16 LE @16 * 0.1", A),
    ("B int16 LE @16 * (100/32767)", B),
    ("C int16 LE @20 * 0.1", C),
    ("D float32 BE @20 stride=3", D),
    ("E uint16 LE @16 * 0.1", E),
    ("F int16 LE @16 stride=3 * 0.1", F),
    ("G uint16 LE @16 stride=3 * 0.1", G),
]
for name, fn in layouts:
    s = sample(fn)
    if s is None:
        print(f"  {name:<36}  (no data)")
        continue
    mn, mx, mean, sd = s
    print(f"  {name:<36}  min={mn:>9.2f}  max={mx:>9.2f}  mean={mean:>9.2f}  sd={sd:>8.2f}")
