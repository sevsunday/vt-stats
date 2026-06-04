"""
dds_decode.py -- minimal DDS (BC1/BC3) decoder, stdlib-only.

BZCC baked textures are DDS with a DX10 header tagging BC1_UNORM_SRGB (DXGI 71/72)
for opaque diffuse maps and BC3 (DXGI 76-78) for alpha maps. Pillow's DDS plugin
doesn't implement the sRGB-tagged DX10 variants, so we decode the BC blocks
ourselves (the block layout is standard regardless of the sRGB tag) and hand
back an RGBA Pillow image of the largest mip.

Only what the texture step needs: decode the base (mip 0) image. Returns a
PIL.Image (RGBA). Raises UnsupportedDDS for formats we don't handle.
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


def decode_dds(path) -> Image.Image:
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

    out = [(0, 0, 0, 0)] * (width * height)
    block_bytes = 8 if bc == 1 else 16
    off = data_off
    for by in range(0, height, 4):
        for bx in range(0, width, 4):
            if bc == 1:
                _decode_bc1_block(b, off, out, bx, by, width, height)
            else:
                # BC2/BC3 both 16 bytes; we decode the BC3-style (DXT5) alpha.
                # BC2 (explicit alpha) is rare for diffuse; treat as BC3.
                _decode_bc3_block(b, off, out, bx, by, width, height)
            off += block_bytes

    img = Image.new("RGBA", (width, height))
    img.putdata(out)
    return img


if __name__ == "__main__":
    import sys
    for p in sys.argv[1:]:
        try:
            im = decode_dds(p)
            print(f"{Path(p).name}: {im.size} {im.mode}")
        except UnsupportedDDS as e:
            print(f"{Path(p).name}: UNSUPPORTED ({e})")
