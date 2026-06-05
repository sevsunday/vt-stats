"""
dds_decode.py -- minimal DDS (BC1/BC3) decoder, stdlib-only.

BZCC baked textures are DDS with a DX10 header tagging BC1_UNORM_SRGB (DXGI 71/72)
for opaque diffuse maps and BC3 (DXGI 76-78) for alpha maps. Pillow's DDS plugin
doesn't implement the sRGB-tagged DX10 variants, so we decode the BC blocks
ourselves (the block layout is standard regardless of the sRGB tag) and hand
back an RGBA Pillow image of the largest mip.

Only what the texture step needs: decode an image. Returns a PIL.Image (RGBA).
Raises UnsupportedDDS for formats we don't handle.

`decode_dds(path, max_dim=N)` skips the BC mip pyramid down to the smallest mip
whose largest side is still `>= N` and decodes only that mip (then downscales to
exactly N if it overshoots). This makes the performance-texture path (512px) and
the thumbnail rasterizer's HQ sampling source (1024px) fast + low-memory by
never touching the full 2048 base image. `max_dim=None` (default) decodes mip 0.
"""

from __future__ import annotations

import struct
from pathlib import Path

from PIL import Image

# DDS_PIXELFORMAT flags
DDPF_FOURCC = 0x4

# DXGI formats we handle (BC1 = DXT1, BC3 = DXT5 color+alpha)
DXGI_BC1 = {70, 71, 72}        # BC1_TYPELESS / UNORM / UNORM_SRGB
DXGI_BC2 = {73, 74, 75}
DXGI_BC3 = {76, 77, 78}        # BC3_TYPELESS / UNORM / UNORM_SRGB


class UnsupportedDDS(Exception):
    pass


def _rgb565(c):
    r = (c >> 11) & 0x1F
    g = (c >> 5) & 0x3F
    b = c & 0x1F
    return (r << 3) | (r >> 2), (g << 2) | (g >> 1), (b << 3) | (b >> 2)


def _decode_bc1_block(data, off, out, ox, oy, w, h):
    c0, c1, bits = struct.unpack_from("<HHI", data, off)
    r0, g0, b0 = _rgb565(c0)
    r1, g1, b1 = _rgb565(c1)
    palette = [(r0, g0, b0, 255), (r1, g1, b1, 255)]
    if c0 > c1:
        palette.append(((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3, 255))
        palette.append(((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3, 255))
    else:
        palette.append(((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2, 255))
        palette.append((0, 0, 0, 0))
    for py in range(4):
        for px in range(4):
            idx = (bits >> (2 * (py * 4 + px))) & 0x3
            x, y = ox + px, oy + py
            if x < w and y < h:
                out[(y * w + x)] = palette[idx]


def _decode_bc3_block(data, off, out, ox, oy, w, h):
    a0, a1 = data[off], data[off + 1]
    abits = int.from_bytes(data[off + 2:off + 8], "little")
    alpha = [a0, a1]
    if a0 > a1:
        for i in range(1, 7):
            alpha.append(((7 - i) * a0 + i * a1) // 7)
    else:
        for i in range(1, 5):
            alpha.append(((5 - i) * a0 + i * a1) // 5)
        alpha.append(0)
        alpha.append(255)
    # color portion is a BC1 block (without the 1-bit alpha mode)
    c0, c1, bits = struct.unpack_from("<HHI", data, off + 8)
    r0, g0, b0 = _rgb565(c0)
    r1, g1, b1 = _rgb565(c1)
    palette = [
        (r0, g0, b0), (r1, g1, b1),
        ((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3),
        ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3),
    ]
    for py in range(4):
        for px in range(4):
            pi = py * 4 + px
            cidx = (bits >> (2 * pi)) & 0x3
            aidx = (abits >> (3 * pi)) & 0x7
            x, y = ox + px, oy + py
            if x < w and y < h:
                r, g, b = palette[cidx]
                out[(y * w + x)] = (r, g, b, alpha[aidx])


def _mip_bytes(w: int, h: int, block_bytes: int) -> int:
    """Stored size of one BC mip of dimensions (w, h)."""
    return ((w + 3) // 4) * ((h + 3) // 4) * block_bytes


def decode_dds(path, max_dim: int | None = None) -> Image.Image:
    b = Path(path).read_bytes()
    if b[:4] != b"DDS ":
        raise UnsupportedDDS("not a DDS file")
    (size, flags, height, width, pitch, depth, mipcount) = struct.unpack_from("<7I", b, 4)
    # pixelformat starts at offset 4 + 76 = 80
    pf_flags, fourcc = struct.unpack_from("<I4s", b, 80)
    data_off = 4 + 124  # past magic + DDS_HEADER

    bc = None
    if fourcc == b"DXT1":
        bc = 1
    elif fourcc == b"DXT3":
        bc = 2
    elif fourcc == b"DXT5":
        bc = 3
    elif fourcc == b"DX10":
        dxgi = struct.unpack_from("<I", b, data_off)[0]
        data_off += 20  # DDS_HEADER_DXT10
        if dxgi in DXGI_BC1:
            bc = 1
        elif dxgi in DXGI_BC3:
            bc = 3
        elif dxgi in DXGI_BC2:
            bc = 2
        else:
            raise UnsupportedDDS(f"DXGI format {dxgi}")
    else:
        raise UnsupportedDDS(f"fourCC {fourcc!r}")

    block_bytes = 8 if bc == 1 else 16

    # Walk the mip pyramid (smaller each level) to the smallest mip whose
    # largest side is still >= max_dim, advancing the data offset past every
    # skipped mip. mipcount may be 0 (treated as 1).
    off = data_off
    mw, mh = width, height
    levels = max(1, mipcount)
    if max_dim:
        for _ in range(levels - 1):
            nw, nh = max(1, mw >> 1), max(1, mh >> 1)
            if max(nw, nh) < max_dim:
                break
            off += _mip_bytes(mw, mh, block_bytes)
            mw, mh = nw, nh

    out = [(0, 0, 0, 0)] * (mw * mh)
    for by in range(0, mh, 4):
        for bx in range(0, mw, 4):
            if bc == 1:
                _decode_bc1_block(b, off, out, bx, by, mw, mh)
            else:
                # BC2/BC3 both 16 bytes; we decode the BC3-style (DXT5) alpha.
                # BC2 (explicit alpha) is rare for diffuse; treat as BC3.
                _decode_bc3_block(b, off, out, bx, by, mw, mh)
            off += block_bytes

    img = Image.new("RGBA", (mw, mh))
    img.putdata(out)
    if max_dim and max(mw, mh) > max_dim:
        scale = max_dim / max(mw, mh)
        img = img.resize(
            (max(1, round(mw * scale)), max(1, round(mh * scale))),
            Image.LANCZOS,
        )
    return img


if __name__ == "__main__":
    import sys
    import time
    md = None
    args = sys.argv[1:]
    if args and args[0].startswith("--max-dim="):
        md = int(args[0].split("=", 1)[1])
        args = args[1:]
    for p in args:
        try:
            t = time.perf_counter()
            im = decode_dds(p, max_dim=md)
            dt = (time.perf_counter() - t) * 1000
            print(f"{Path(p).name}: {im.size} {im.mode} (max_dim={md}, {dt:.0f}ms)")
        except UnsupportedDDS as e:
            print(f"{Path(p).name}: UNSUPPORTED ({e})")
