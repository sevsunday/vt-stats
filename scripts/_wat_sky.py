"""`.WAT`, `.SKY`, and `.TRN` lighting / atmosphere decoders.

The `.WAT` and `.SKY` formats are partially binary; we extract just the
water plane height (.WAT byte 16 float32) and a fallback sky tint
(first 3 floats of .SKY).

The `.TRN` is an INI text file that carries the engine's lighting model
in human-readable blocks: `[Light]`, `[Sky]`, `[Water]`, `[NormalView]`.
This module's `parse_trn_lighting()` extracts:

- sun color, ambient color, sun-angle-above-horizon (for directional light)
- sky color (overrides the binary .SKY fallback when present)
- water color + alpha (the actual engine water tint, not a generic blue)
- fog color, fog start/end, visibility range (atmospheric falloff)

When fields are missing the helper falls back to reasonable defaults.
"""
from __future__ import annotations

import struct
from pathlib import Path


# -----------------------------------------------------------------------
# .WAT
# -----------------------------------------------------------------------

def parse_wat_header(path: Path) -> dict | None:
    """Return {magic, version, water_y} or None on failure.

    Empirically:
        offset 0x00  magic "WATR"
        offset 0x04  uint32 LE  version
        offset 0x08  int16 LE x4  -> same tile bounds as the .TER (unused here)
        offset 0x10  float32 LE  -> water plane height in meters (~10.0 for VSR maps)
    """
    if not path.is_file():
        return None
    raw = path.read_bytes()
    if len(raw) < 32 or raw[:4] != b"WATR":
        return None
    version = int.from_bytes(raw[4:8], "little")
    try:
        water_y = struct.unpack_from("<f", raw, 16)[0]
    except struct.error:
        return None
    # Sanity check: BZ:CC water planes are in the -100..+200 m range. Out-of-band
    # values likely indicate the byte-16 offset is wrong for this map.
    if not (-200.0 <= water_y <= 500.0):
        return None
    return {"magic": "WATR", "version": version, "water_y": float(water_y)}


# -----------------------------------------------------------------------
# .SKY
# -----------------------------------------------------------------------

def parse_sky_header(path: Path) -> dict | None:
    """Return {magic, version, sky_tint} or None on failure.

    The .SKY format hasn't been fully decoded, but the first ~50 float32s
    after the header look like color gradients, fog density, sun direction,
    time-of-day. For the POC we just want a single tint color.

    Strategy: read the first 3 floats at byte 16 (after the magic + version +
    a few bookkeeping bytes), clamp to [0,1], treat as an RGB tint. If any
    value is wildly out of range we fall back to a neutral grey-blue.
    """
    if not path.is_file():
        return None
    raw = path.read_bytes()
    # The on-disk magic is stored little-endian, so the four bytes spell
    # "_YKS" when read sequentially (corresponding to the conceptual "SKY_"
    # tag). Accept both spellings defensively.
    if len(raw) < 32 or raw[:4] not in (b"_YKS", b"SKY_"):
        return None
    version = int.from_bytes(raw[4:8], "little")

    # The .SKY header is small but its exact layout isn't documented. Try a
    # few candidate offsets and pick the first triple where all three floats
    # land in a plausible color range [0, 4] (HDR-ish, normalized later).
    # Empirically vsreuronig.SKY has the night-sky RGB at byte 20.
    candidate_offsets = (20, 24, 28, 32, 36)
    rgb: tuple[float, float, float] | None = None
    for off in candidate_offsets:
        if off + 12 > len(raw):
            continue
        try:
            r, g, b = struct.unpack_from("<3f", raw, off)
        except struct.error:
            continue
        if all(0.0 <= v <= 4.0 for v in (r, g, b)) and (r + g + b) > 0.05:
            rgb = (r, g, b)
            break

    if rgb is None:
        # Fallback: night-sky slate-blue (matches Europa Night's vibe).
        rgb = (0.10, 0.13, 0.20)

    # Normalize the HDR-ish triple to [0,1] by simple clamp + tone-map.
    peak = max(rgb)
    if peak > 1.0:
        rgb = tuple(v / peak for v in rgb)  # type: ignore[assignment]

    r8 = int(round(max(0.0, min(1.0, rgb[0])) * 255))
    g8 = int(round(max(0.0, min(1.0, rgb[1])) * 255))
    b8 = int(round(max(0.0, min(1.0, rgb[2])) * 255))
    sky_tint = f"#{r8:02x}{g8:02x}{b8:02x}"

    return {
        "magic": "SKY_",
        "version": version,
        "sky_tint": sky_tint,
        "sky_rgb_float": [float(rgb[0]), float(rgb[1]), float(rgb[2])],
    }


# -----------------------------------------------------------------------
# .TRN lighting / atmosphere
# -----------------------------------------------------------------------

def _parse_rgba(s: str | None) -> tuple[float, float, float, float] | None:
    """Parse a 'R G B' or 'R G B A' string (0..255 ints) into 0..1 floats."""
    if not s:
        return None
    s = s.strip().strip('"').strip("'")
    parts = s.split()
    try:
        vals = [float(p) / 255.0 for p in parts[:4]]
    except ValueError:
        return None
    if len(vals) < 3:
        return None
    r, g, b = vals[0], vals[1], vals[2]
    a = vals[3] if len(vals) >= 4 else 1.0
    return (r, g, b, a)


def _rgb_to_hex(rgb: tuple[float, float, float, float] | None,
                fallback: str = "#808080") -> str:
    if rgb is None:
        return fallback
    r, g, b, _ = rgb
    return "#{:02x}{:02x}{:02x}".format(
        int(round(max(0, min(1, r)) * 255)),
        int(round(max(0, min(1, g)) * 255)),
        int(round(max(0, min(1, b)) * 255)),
    )


def _parse_ini(path: Path) -> dict[str, dict[str, str]]:
    """Lightweight INI parser. Ignores `//` comments. Returns
    {section_name: {key: value}}."""
    out: dict[str, dict[str, str]] = {"": {}}
    cur = out[""]
    if not path.is_file():
        return out
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return out
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            name = line[1:-1].strip()
            cur = out.setdefault(name, {})
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            cur[k.strip()] = v.strip()
    return out


def parse_trn_lighting(trn_path: Path | None) -> dict:
    """Pull lighting/atmosphere settings from `.TRN`.

    Returns a dict with normalized values:
        sun_color:       (r, g, b, a) in [0,1]   or default (1, 1, 1, 1)
        ambient_color:   (r, g, b, a) in [0,1]   or default (0.55, 0.55, 0.65, 1)
        sun_angle_deg:   float  (angle above horizon)  default 30
        sky_color:       (r, g, b, a) or None (falls back to .SKY parse)
        sky_color_hex:   '#rrggbb' or None
        water_color:     (r, g, b, a) or None
        water_color_hex: '#rrggbb' or None
        water_opacity:   0..1 alpha
        fog_color:       (r, g, b, a) or None
        fog_color_hex:   '#rrggbb' or None
        fog_start:       float meters or None
        fog_end:         float meters or None
        visibility_range: float meters or None
    """
    DEFAULTS = {
        "sun_color":       (1.0, 1.0, 1.0, 1.0),
        "ambient_color":   (0.55, 0.55, 0.65, 1.0),
        "sun_angle_deg":   30.0,
        "sky_color":       None,
        "sky_color_hex":   None,
        "water_color":     None,
        "water_color_hex": None,
        "water_opacity":   0.55,
        "fog_color":       None,
        "fog_color_hex":   None,
        "fog_start":       None,
        "fog_end":         None,
        "visibility_range": None,
    }
    if trn_path is None or not trn_path.is_file():
        return DEFAULTS

    ini = _parse_ini(trn_path)
    out = dict(DEFAULTS)

    # [Light] block: SunColor, AmbientColor, SunAngle
    light = ini.get("Light", {})
    sc = _parse_rgba(light.get("SunColor"))
    ac = _parse_rgba(light.get("AmbientColor"))
    if sc: out["sun_color"] = sc
    if ac: out["ambient_color"] = ac
    try:
        out["sun_angle_deg"] = float(light.get("SunAngle", DEFAULTS["sun_angle_deg"]))
    except (TypeError, ValueError):
        pass

    # [Sky] block: SkyColor
    sky = ini.get("Sky", {})
    sky_color = _parse_rgba(sky.get("SkyColor"))
    if sky_color:
        out["sky_color"] = sky_color
        out["sky_color_hex"] = _rgb_to_hex(sky_color)

    # [Water] block: WaterDiffuse1 carries (r g b a) where a is opacity
    water = ini.get("Water", {})
    wc = _parse_rgba(water.get("WaterDiffuse1"))
    if wc:
        out["water_color"] = wc
        out["water_color_hex"] = _rgb_to_hex(wc)
        out["water_opacity"] = wc[3]

    # [NormalView] block: FogColor, FogStart, FogEnd, VisibilityRange
    nv = ini.get("NormalView", {})
    fc = _parse_rgba(nv.get("FogColor"))
    if fc:
        out["fog_color"] = fc
        out["fog_color_hex"] = _rgb_to_hex(fc)
    for k, key in [("FogStart", "fog_start"), ("FogEnd", "fog_end"),
                   ("VisibilityRange", "visibility_range")]:
        try:
            v = nv.get(k)
            if v is not None:
                out[key] = float(v)
        except (TypeError, ValueError):
            pass

    return out


# Image extensions the engine accepts in TileTextureN references. Anything
# in this set gets stripped from the tail of the tile name during
# normalization so downstream matching against on-disk files is uniform.
_TILE_NAME_EXTS = (".tga", ".dds", ".bmp", ".png", ".jpg", ".jpeg", ".pic")


def _normalize_tile_name(raw: str) -> str:
    name = raw.strip().strip('"').strip("'").lower()
    for ext in _TILE_NAME_EXTS:
        if name.endswith(ext):
            name = name[: -len(ext)]
            break
    return name


def parse_trn_tile_textures(trn_path: Path | None) -> list[str | None]:
    """Pull the `[Texture]` block's TileTextureN list from `.TRN`.

    Returns a fixed-length 16-slot list of normalized tile stems (lowercase,
    extension stripped). Slot index 0 corresponds to `TileTexture1` (the
    engine's 1-indexed naming collapsed to 0-indexed so lookup matches
    `InfoMap`'s 4-bit fields directly). Empty / missing slots are `None`.
    The returned list is always exactly 16 entries; trailing `None`s are NOT
    stripped because `InfoMap` may legally reference any slot in 0..15.

    Example .TRN block:

        [Texture]
        TileTexture1 = "rend.tga"
        TileTexture2 = "rend2.tga"
        TileTexture5 = "rend5.dds"      // (slots 3-4 are holes)

    Returns: ['rend', 'rend2', None, None, 'rend5', None, ..., None]
    (16 entries total)

    Accepts the common image extensions BZ:CC supports (`.tga`/`.dds`/`.bmp`/
    `.png`/`.jpg`/`.jpeg`/`.pic`); the stripped stem is what we look for
    on disk during tile extraction.
    """
    out: list[str | None] = [None] * 16
    if trn_path is None or not trn_path.is_file():
        return out
    ini = _parse_ini(trn_path)
    tex = ini.get("Texture", {})
    for i in range(1, 17):
        raw = tex.get(f"TileTexture{i}")
        if raw is None:
            continue
        name = _normalize_tile_name(raw)
        if not name:
            continue
        out[i - 1] = name
    return out


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: python _wat_sky.py <map_dir>", file=sys.stderr)
        raise SystemExit(2)
    map_dir = Path(sys.argv[1])
    wat = next(iter(map_dir.glob("*.WAT")), None) or next(iter(map_dir.glob("*.wat")), None)
    sky = next(iter(map_dir.glob("*.SKY")), None) or next(iter(map_dir.glob("*.sky")), None)
    trn = next(iter(map_dir.glob("*.TRN")), None) or next(iter(map_dir.glob("*.trn")), None)
    print(f".WAT: {wat}")
    print(f"      -> {parse_wat_header(wat) if wat else 'missing'}")
    print(f".SKY: {sky}")
    print(f"      -> {parse_sky_header(sky) if sky else 'missing'}")
    print(f".TRN: {trn}")
    print(f"      -> {parse_trn_lighting(trn)}")
