"""Build the site-wide custom-cursor sprite sheet from the BZCC in-game cursor.

Decodes the HD cursor DDS (DX10 / BC3-DXT5, DXGI format 78 = BC3_UNORM_SRGB)
into a flat horizontal strip PNG that the website's `js/cursor-settings.js`
overlay plays back as a continuously-spinning cursor.

The shipped artifact is the committed `data/ui/cursor-sprite.png`. This script
is REPRODUCIBILITY-ONLY; the source DDS is vendored in the repo so it can be
re-run offline, but it is not part of the pipeline run.

Source layout:
  - HD (default): `_ui-cursor/cursors/cursorHD_x2_0.dds`, 512x512, BC3 (DXT5),
    an 8x8 grid => 64 frames of 64x64. Re-packed left-to-right into a 4096x64
    strip so the browser can animate `background-position-x` with a CSS
    steps(64) keyframe. (The original `cursor.dds` is the 4x4 / 16-frame /
    32x32 SD variant; pass --cols 4 --rows 4 --src ... to rebuild from it.)

Pillow decodes BC3 fine but rejects the sRGB DXGI tag (78); we patch the format
word 78 -> 77 (BC3_UNORM) in a memory copy before decoding. sRGB only changes
gamma interpretation, not the block byte layout.

Usage:
  python scripts/build_cursor_sprite.py
  python scripts/build_cursor_sprite.py --src "C:\\path\\to\\cursor.dds" --cols 4 --rows 4
"""

import argparse
import io
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = REPO_ROOT / "_ui-cursor" / "cursors" / "cursorHD_x2_0.dds"
OUT_PATH = REPO_ROOT / "data" / "ui" / "cursor-sprite.png"

DEFAULT_COLS = 8
DEFAULT_ROWS = 8


def decode_dds(path: Path):
    """Return an RGBA PIL.Image of the full sheet, patching the sRGB tag."""
    from PIL import Image

    data = bytearray(path.read_bytes())
    if data[0:4] != b"DDS ":
        raise ValueError(f"not a DDS file: {path}")

    fourcc = bytes(data[84:88])
    if fourcc == b"DX10":
        (dxgi_format,) = struct.unpack_from("<I", data, 128)
        if dxgi_format == 78:  # BC3_UNORM_SRGB -> BC3_UNORM (same block layout)
            struct.pack_into("<I", data, 128, 77)

    im = Image.open(io.BytesIO(bytes(data)))
    im.load()
    return im.convert("RGBA")


def build_strip(sheet, cols, rows):
    """Slice a cols x rows sheet into frames and re-pack as a horizontal strip."""
    w, h = sheet.size
    fw, fh = w // cols, h // rows
    from PIL import Image

    strip = Image.new("RGBA", (fw * cols * rows, fh))
    for r in range(rows):
        for c in range(cols):
            idx = r * cols + c
            frame = sheet.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh))
            strip.paste(frame, (idx * fw, 0))
    return strip, fw, fh


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="path to cursor DDS")
    ap.add_argument("--out", type=Path, default=OUT_PATH, help="output PNG path")
    ap.add_argument("--cols", type=int, default=DEFAULT_COLS, help="sheet grid columns")
    ap.add_argument("--rows", type=int, default=DEFAULT_ROWS, help="sheet grid rows")
    args = ap.parse_args()

    if not args.src.exists():
        print(f"source DDS not found: {args.src}", file=sys.stderr)
        print("Pass --src with the path to your BZ2R cursor.dds.", file=sys.stderr)
        return 1

    try:
        sheet = decode_dds(args.src)
    except Exception as e:  # noqa: BLE001
        print(f"decode failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    strip, fw, fh = build_strip(sheet, args.cols, args.rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    strip.save(args.out)
    n = args.cols * args.rows
    print(f"wrote {args.out} ({strip.width}x{strip.height}, {n} frames of {fw}x{fh})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
