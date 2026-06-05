# BZCC in-game cursor → browser custom cursor — feasibility smoke test

**Verdict: feasible, high confidence.** No blockers.

## Source asset

`C:\Program Files (x86)\Steam\steamapps\common\BZ2R\bz2r_res\baked\UI\cursor.dds`

| Field | Value |
|-------|-------|
| Container | DDS, DX10 header |
| Compression | BC3 / DXT5 (DXGI format **78** = `BC3_UNORM_SRGB`) |
| Dimensions | 128 × 128, 8 mipmaps |
| Alpha | full 0..255 (67% transparent, 23% opaque) — real cutout |
| **Layout** | **4 × 4 sprite sheet = 16 animation frames of 32 × 32** |

It's the rotating "comet/orb" cursor: an arrow/comet tail with a spinning
multicolor orb. 16 frames = one full rotation loop.

## Decode path (already working)

Pillow 12.1.1 decodes BC3 fine but rejects the sRGB tag (78). Trick: patch the
DXGI format byte `78 → 77` (`BC3_UNORM`) in a memory copy before `Image.open` —
identical block layout, sRGB only affects gamma interpretation. See
`inspect_dds.py`. (three.js `DDSLoader.js` in `_object-render/vendor` also
handles DXT5 directly if we ever want client-side decode.)

Artifacts emitted here:
- `cursor_decoded.png` — full 128×128 sheet, RGBA
- `cursor_decoded_4x.png` — 4× upscale for eyeballing
- `cursor_strip.png` — 16 frames laid out horizontally (512×32)
- `cursor_anim.gif` — animated preview (~70ms/frame)
- `frames/frame_00..15.png` — individual 32×32 frames

## Browser custom-cursor reality check

- **Static** custom cursor is trivial: `cursor: url(frame.png) hx hy, auto;`.
  32×32 is the safe/native size (Chrome hard-caps at 128×128).
- **Animation caveat:** CSS `cursor:` does **not** animate (no APNG/GIF playback
  on the cursor property). Two standard workarounds, both viable:
  1. **DOM follower** (recommended, smoothest): `cursor: none` on the page +
     a fixed-position `<div>` that tracks `mousemove`, with the 16-frame sprite
     played via CSS `steps(16)` animation. Pixel-perfect, GPU-cheap, lets us
     keep the orb spinning continuously.
  2. **URL-swap hack**: `setInterval` swapping `cursor: url(frame_N.png)` every
     ~70ms. Zero extra DOM, works everywhere, but can micro-flicker and needs a
     consistent hotspot per frame.
- **Hotspot**: arrow/comet tip — pin down exact (x,y) during implementation
  (rough probe landed near the upper-left opaque cluster).

## Recommended pipeline if we proceed

1. Add a tiny build step (mirror of `inspect_dds.py`) that decodes `cursor.dds`
   → emits a packed sprite sheet PNG (or 16 frames) into `data/` or `img/`.
2. Ship a small `js/cursor.js` (DOM-follower approach) + CSS keyframes.
3. Respect `prefers-reduced-motion` (freeze on frame 0) and touch devices
   (skip entirely — no pointer).
