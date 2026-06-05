"""Smoke test: inspect the BZCC in-game cursor.dds and probe feasibility
of using it as a browser custom cursor.

Read-only. Writes a decoded PNG + a contact-sheet next to this script so we
can eyeball the asset and decide whether to proceed.
"""

import struct
import sys
from pathlib import Path

SRC = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R\bz2r_res\baked\UI\cursor.dds")
OUT_DIR = Path(__file__).parent


def parse_header(data: bytes) -> dict:
    magic = data[0:4]
    (size, flags, height, width, pitch, depth, mipmaps) = struct.unpack_from("<7I", data, 4)
    # pixel format at offset 76: size, flags, fourcc, rgbbitcount, masks
    (pf_size, pf_flags) = struct.unpack_from("<2I", data, 76)
    fourcc = data[84:88]
    (rgb_bits, r_mask, g_mask, b_mask, a_mask) = struct.unpack_from("<5I", data, 88)
    (caps, caps2) = struct.unpack_from("<2I", data, 108)
    has_dx10 = fourcc == b"DX10"
    dxgi = None
    if has_dx10:
        (dxgi_format, res_dim, misc, arr_size, misc2) = struct.unpack_from("<5I", data, 128)
        dxgi = dxgi_format
    return {
        "magic": magic,
        "header_size": size,
        "width": width,
        "height": height,
        "pitch": pitch,
        "mipmaps": mipmaps,
        "pf_flags": hex(pf_flags),
        "fourcc": fourcc,
        "rgb_bits": rgb_bits,
        "masks": tuple(hex(m) for m in (r_mask, g_mask, b_mask, a_mask)),
        "caps": hex(caps),
        "caps2": hex(caps2),
        "dx10": has_dx10,
        "dxgi_format": dxgi,
    }


def main() -> int:
    if not SRC.exists():
        print(f"NOT FOUND: {SRC}")
        return 1

    data = SRC.read_bytes()
    print(f"file: {SRC}")
    print(f"size: {len(data)} bytes")
    hdr = parse_header(data)
    for k, v in hdr.items():
        print(f"  {k}: {v}")

    # Try Pillow decode. BZCC uses BC3_UNORM_SRGB (DXGI 78); Pillow only
    # implements the non-sRGB BC3 (77). Patch the format tag in a temp copy so
    # the block decompressor (identical for both) runs. sRGB only affects the
    # gamma curve interpretation, not the byte layout.
    try:
        from PIL import Image
        import io
        if hdr.get("dxgi_format") == 78:
            patched = bytearray(data)
            struct.pack_into("<I", patched, 128, 77)  # BC3_UNORM_SRGB -> BC3_UNORM
            im = Image.open(io.BytesIO(bytes(patched)))
        else:
            im = Image.open(SRC)
        im.load()
        print(f"\nPillow decode OK: mode={im.mode} size={im.size}")
        rgba = im.convert("RGBA")
        png_path = OUT_DIR / "cursor_decoded.png"
        rgba.save(png_path)
        print(f"  wrote {png_path}")

        # Alpha histogram: cursors need transparency
        alpha = rgba.getchannel("A")
        amin, amax = alpha.getextrema()
        opaque = sum(1 for p in alpha.getdata() if p > 250)
        transp = sum(1 for p in alpha.getdata() if p < 5)
        total = rgba.width * rgba.height
        print(f"  alpha range: {amin}..{amax}")
        print(f"  fully opaque px: {opaque}/{total} ({100*opaque/total:.1f}%)")
        print(f"  fully transparent px: {transp}/{total} ({100*transp/total:.1f}%)")

        # Is the square divisible into an animation strip? Check aspect.
        w, h = rgba.size
        print(f"\naspect: {w}x{h} ratio={w/h:.3f}")
        # Save an upscaled 4x preview for eyeballing detail
        big = rgba.resize((w * 4, h * 4), Image.NEAREST)
        big_path = OUT_DIR / "cursor_decoded_4x.png"
        big.save(big_path)
        print(f"  wrote {big_path}")

        # It's a 4x4 sprite sheet => 16 frames of 32x32. Slice + emit frames,
        # a horizontal strip, and an animated GIF/WebP preview.
        cols, rows = 4, 4
        fw, fh = w // cols, h // rows
        print(f"\nsprite sheet: {cols}x{rows} grid => {cols*rows} frames of {fw}x{fh}")
        frames = []
        frames_dir = OUT_DIR / "frames"
        frames_dir.mkdir(exist_ok=True)
        for r in range(rows):
            for c in range(cols):
                box = (c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)
                fr = rgba.crop(box)
                idx = r * cols + c
                fr.save(frames_dir / f"frame_{idx:02d}.png")
                frames.append(fr)

        # Hotspot probe: find the topmost-leftmost opaque pixel (arrow tip).
        tip = None
        px = rgba.crop((0, 0, fw, fh)).load()
        for y in range(fh):
            for x in range(fw):
                if px[x, y][3] > 200:
                    tip = (x, y)
                    break
            if tip:
                break
        print(f"  likely hotspot (arrow tip) in frame coords: {tip}")

        # Animated previews (upscaled 4x for visibility)
        big_frames = [f.resize((fw * 4, fh * 4), Image.NEAREST) for f in frames]
        gif_path = OUT_DIR / "cursor_anim.gif"
        big_frames[0].save(
            gif_path, save_all=True, append_images=big_frames[1:],
            duration=70, loop=0, disposal=2, transparency=0,
        )
        print(f"  wrote {gif_path}")
        strip = Image.new("RGBA", (fw * 16, fh))
        for i, f in enumerate(frames):
            strip.paste(f, (i * fw, 0))
        strip.save(OUT_DIR / "cursor_strip.png")
        print(f"  wrote {OUT_DIR / 'cursor_strip.png'}  ({fw*16}x{fh})")
        return 0
    except Exception as e:
        print(f"\nPillow decode FAILED: {type(e).__name__}: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
