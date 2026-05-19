#!/usr/bin/env python3
"""
Build the static OG card used by the Player Profile pages.

One-shot tool — produces a single `data/og/player-card.png` (1200x630)
from `isdf-logo.png` plus a "VT STATS — Players" text overlay. Re-run
this script when the dashboard theme changes or the logo gets a refresh:

    python scripts/build_og_card.py

The output file is committed to the repo so neither the pipeline nor
GitHub Pages needs Pillow at deploy time. Every pre-generated
/player/<slug>/index.html embeds this same image via og:image +
twitter:image -- Discord, Slack, Twitter, etc. all unfurl the same
shared graphic.

Design (intentionally austere -- the OG card competes for ~1s of
attention in the chat embed, so legibility beats decoration):

  ┌────────────────────────────────────────────────────────┐
  │                                                        │
  │        ▣  VT STATS                                     │
  │      LOGO                                              │
  │        ▣  Players                                      │
  │            Career profiles · VTSR-T · comparisons      │
  │                                                        │
  └────────────────────────────────────────────────────────┘
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent.parent
LOGO_SOURCE = ROOT / "isdf-logo.png"
OUTPUT_PATH = ROOT / "data" / "og" / "player-card.png"

OG_WIDTH = 1200
OG_HEIGHT = 630

# Background -- matches the dashboard's dark-mode `--kb-bg-primary`.
BG_TOP = (15, 22, 32)
BG_BOT = (8, 12, 18)

# Type colors. RGB values are intentionally a hair brighter than the
# in-app text-primary so the PNG reads cleanly on social-card cards
# (which often have their own translucent overlay).
TEXT_PRIMARY = (235, 240, 245)
TEXT_ACCENT = (54, 162, 235)        # --kb-primary (cyan/blue)
TEXT_MUTED = (155, 165, 175)


def main() -> None:
    if not LOGO_SOURCE.exists():
        raise SystemExit(f"Missing logo source: {LOGO_SOURCE}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    # 1. Gradient background.
    bg = Image.new("RGB", (OG_WIDTH, OG_HEIGHT), BG_TOP)
    grad = ImageDraw.Draw(bg)
    for y in range(OG_HEIGHT):
        t = y / max(1, OG_HEIGHT - 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        grad.line([(0, y), (OG_WIDTH, y)], fill=(r, g, b))

    # 2. Logo (resized + alpha-composited).
    logo = Image.open(LOGO_SOURCE).convert("RGBA")
    target_h = 380
    scale = target_h / logo.height
    target_w = int(logo.width * scale)
    logo = logo.resize((target_w, target_h), Image.LANCZOS)
    logo_x = 90
    logo_y = (OG_HEIGHT - target_h) // 2
    bg.paste(logo, (logo_x, logo_y), logo)

    # 3. Text block.
    draw = ImageDraw.Draw(bg)

    title_font = _font_or_default(96, mono=False)
    sub_font   = _font_or_default(64, mono=False)
    tag_font   = _font_or_default(32, mono=False)

    text_x = logo_x + target_w + 60
    text_w_avail = OG_WIDTH - text_x - 60

    # "VT STATS"
    draw.text((text_x, 200), "VT STATS",
              font=title_font, fill=TEXT_PRIMARY)

    # "Players" (accented)
    draw.text((text_x, 200 + 110), "Players",
              font=sub_font, fill=TEXT_ACCENT)

    # tagline
    draw.text((text_x, 200 + 110 + 80),
              "Career profiles · VTSR-T · comparisons",
              font=tag_font, fill=TEXT_MUTED)

    # 4. A 4-pixel accent stripe along the bottom for visual seasoning.
    draw.rectangle([(0, OG_HEIGHT - 4), (OG_WIDTH, OG_HEIGHT)],
                   fill=TEXT_ACCENT)

    bg.save(OUTPUT_PATH, "PNG", optimize=True)
    print(f"Wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size:,} bytes)")


def _font_or_default(size: int, *, mono: bool = False) -> ImageFont.ImageFont:
    """Try a few well-known system font paths in priority order, fall
    back to PIL's default bitmap font if none load. The CI / pipeline
    box is Windows so we lead with Geist-style sans-serif candidates
    that ship with Windows (Segoe UI Variable, Segoe UI), then fall
    back to DejaVu (Linux) and PIL's default.
    """
    candidates = [
        "C:/Windows/Fonts/SegoeUIVariableDisplay.ttf" if not mono else "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if not mono else None,
        "C:/Windows/Fonts/segoeui.ttf" if not mono else None,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if not mono else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        if not path:
            continue
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


if __name__ == "__main__":
    main()
