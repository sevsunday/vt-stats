"""`.WAT`, `.SKY`, and `.TRN` lighting / atmosphere decoders.

The `.WAT` and `.SKY` formats are partially binary; we extract the
water plane height (.WAT byte 16 float32), a fallback sky tint
(first plausible RGB triple of .SKY, via `parse_sky_header`), and the
dome / cloud / sun parameters (`parse_sky`).

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

    Tint-only path used by extract_3d.py. The chunk decode (dome mesh,
    cloud and sun stems, the three SKY1 colors) is `parse_sky`. This
    helper's byte offsets and fallback stay as they are so existing
    `.3d.json` sky_tint values do not move.

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


# Fixed 7068-byte version-4 layout, identical on every ingested map.
# Header: magic `_YKS` (little-endian `SKY_`) + uint32 version + uint32
# flags, then chunks of (4-byte reversed tag, uint32 size, payload).
# SKY1 holds three RGBA colors and two texture names. DOME names the mesh.
_SKY_NAME_EXTS = (".tga", ".dds", ".fbx", ".xsi", ".pic", ".png", ".bmp",
                  ".jpg", ".jpeg")


def _sky_chunks(raw: bytes) -> dict[str, bytes] | None:
    """Walk a `.SKY` body. Returns {tag: payload} or None if the file
    is not a versioned SKY_ chunk stream."""
    if len(raw) < 16 or raw[:4] not in (b"_YKS", b"SKY_"):
        return None
    chunks: dict[str, bytes] = {}
    off = 0x0C
    while off + 8 <= len(raw):
        tag = raw[off:off + 4][::-1].decode("latin1")
        size = struct.unpack_from("<I", raw, off + 4)[0]
        payload = off + 8
        end = payload + size
        if end > len(raw):
            return None
        chunks[tag] = raw[payload:end]
        off = end
    if off != len(raw) or "SKY1" not in chunks or "DOME" not in chunks:
        return None
    return chunks


def _zstr(blob: bytes, off: int, width: int) -> str:
    if off < 0 or off >= len(blob):
        return ""
    end = blob.find(b"\x00", off, min(len(blob), off + width))
    if end < 0:
        end = min(len(blob), off + width)
    return blob[off:end].decode("latin1", errors="replace").strip()


def sky_asset_stem(name: str | None) -> str | None:
    """Lowercase stem of a SKY texture or mesh name. Extension ignored.
    `null` and empty slots are None."""
    if not name:
        return None
    text = name.strip().strip('"').strip("'").lower()
    if not text or text == "null":
        return None
    for ext in _SKY_NAME_EXTS:
        if text.endswith(ext):
            text = text[: -len(ext)]
            break
    text = text.strip()
    return text or None


def _rgba_hex(blob: bytes, off: int) -> str | None:
    if off + 16 > len(blob):
        return None
    try:
        r, g, b, _a = struct.unpack_from("<4f", blob, off)
    except struct.error:
        return None
    if not all(v == v for v in (r, g, b)):  # NaN
        return None

    def ch(v: float) -> int:
        return int(round(max(0.0, min(1.0, v)) * 255))

    return f"#{ch(r):02x}{ch(g):02x}{ch(b):02x}"


def parse_sky(path: Path | None) -> dict | None:
    """Decode the dome / cloud / sun parameters from a `.SKY` file.

    Returns None when the file is missing or not the version-4 chunk
    layout. Colors are the three SKY1 RGBA triples, clamped to 8-bit:

        sky      payload 0x00  (the tint `parse_sky_header` already uses)
        zenith   payload 0x2C
        horizon  payload 0x3C

    `dome`, `cloud`, and `sun` are lowercase stems with the extension
    stripped (`miredome.fbx` -> `miredome`). `radius` is the DOME float
    at payload 0x0C (engine meters; the viewer does not use it as the
    on-screen size). `sprites` is the SPRT billboard list from
    `parse_sky_sprites`.
    """
    if path is None or not path.is_file():
        return None
    raw = path.read_bytes()
    chunks = _sky_chunks(raw)
    if chunks is None:
        return None
    sky1 = chunks["SKY1"]
    dome = chunks["DOME"]
    version = int.from_bytes(raw[4:8], "little")
    radius = None
    if len(dome) >= 16:
        try:
            radius_f = struct.unpack_from("<f", dome, 0x0C)[0]
        except struct.error:
            radius_f = None
        if radius_f is not None and radius_f == radius_f and 1.0 <= radius_f <= 10000.0:
            radius = float(radius_f)
    return {
        "version": version,
        "dome": sky_asset_stem(_zstr(dome, 0x10, 48)),
        "cloud": sky_asset_stem(_zstr(sky1, 0x54, 40)),
        "sun": sky_asset_stem(_zstr(sky1, 0x7C, 40)),
        "radius": radius,
        "colors": {
            "sky": _rgba_hex(sky1, 0x00),
            "zenith": _rgba_hex(sky1, 0x2C),
            "horizon": _rgba_hex(sky1, 0x3C),
        },
        "sprites": parse_sky_sprites(chunks.get("SPRT", b"")),
    }


# SPRT: 12-byte header, then 56-byte records. Confirmed on the version-4
# files (payload length == 12 + N*56). The name is a 32-byte cstring; the
# rest is blend mode, an RGBA tint, and size / azimuth / elevation / roll.
_SPRT_HEADER = 12
_SPRT_RECORD = 56


def _finite(value: float) -> float | None:
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def parse_sky_sprites(blob: bytes) -> list[dict]:
    """Billboards from a SPRT payload. Empty names are skipped.

    `blend` 0 is an alpha disc (Earth). `blend` 1 is additive (moons,
    galaxies, lens flares). `color` is the record's RGB bytes as #rrggbb.
    Angles are degrees, as stored.
    """
    if not blob or len(blob) < _SPRT_HEADER + _SPRT_RECORD:
        return []
    count = (len(blob) - _SPRT_HEADER) // _SPRT_RECORD
    out: list[dict] = []
    for i in range(count):
        rec = blob[_SPRT_HEADER + i * _SPRT_RECORD:
                   _SPRT_HEADER + (i + 1) * _SPRT_RECORD]
        name = sky_asset_stem(rec[:32].split(b"\x00", 1)[0].decode("latin1", "replace"))
        if not name:
            continue
        blend = struct.unpack_from("<I", rec, 32)[0]
        red, green, blue = rec[36], rec[37], rec[38]
        size, azimuth, elevation, roll = struct.unpack_from("<4f", rec, 40)
        out.append({
            "name": name,
            "blend": int(blend),
            "color": f"#{red:02x}{green:02x}{blue:02x}",
            "size": _finite(size),
            "azimuth": _finite(azimuth),
            "elevation": _finite(elevation),
            "roll": _finite(roll),
        })
    return out


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
    extension stripped). Slot N is `TileTextureN` so the list lines up with
    `InfoMap`'s 4-bit layer indices (0..15). Empty / missing / blank slots
    are `None`. `TileTexture16` is outside that range and is ignored.

    The returned list is always exactly 16 entries; trailing `None`s are NOT
    stripped because `InfoMap` may legally reference any slot in 0..15.

    Example .TRN block:

        [Texture]
        TileTexture0 = "rend.tga"
        TileTexture1 = "rend2.tga"
        TileTexture5 = "rend5.dds"      // (slots 2-4 are holes)

    Returns: ['rend', 'rend2', None, None, None, 'rend5', None, ..., None]
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
    for i in range(16):
        raw = tex.get(f"TileTexture{i}")
        if raw is None:
            continue
        name = _normalize_tile_name(raw)
        if not name:
            continue
        out[i] = name
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
    print(f"      -> {parse_sky(sky) if sky else 'missing'}")
    print(f".TRN: {trn}")
    print(f"      -> {parse_trn_lighting(trn)}")
