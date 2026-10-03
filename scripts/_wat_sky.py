"""`.WAT`, `.SKY`, and `.TRN` decoders for the map renderers.

The `.SKY` file is the engine's atmosphere source. BZCC's editor
documentation: "SKY: This file contains all the information regarding
atmosphere, weather, fog and effects, sun angle and time of day, sky
graphics, ambient color, and visibility distance." `parse_sky()` decodes
it: fog colour / range / visibility, the sun light (colour, intensity,
hour and period), the ambient light, the clear colour, the cloud layer,
the dome mesh, the sun sprite, the SPRT billboards, and the FOG chunk's
local and ground fog. The field names mirror the in-game console variables
(`sky.fogstart`, `sun.angle`, ...), which is how the layout was confirmed.

The `.TRN` is an INI text file. Its `[NormalView]` material keys
(`DiffuseColor`, `SpecularColor`, `SpecularPower`, `EmissiveColor`) are
still what the engine applies to the terrain; `parse_trn_terrain_material()`
reads those, with the engine defaults the console reports when a key is
absent (diffuse `178 178 178`). Its `[Light]`, `[Sky]` and `[NormalView]`
fog keys are BZ2-era leftovers that BZCC no longer renders (only a few maps
carry them and they disagree with the `.SKY`); `parse_trn_lighting()` still
reads them for the legacy `.3d.json` `lighting` block, which the renderers
use only as a fallback when a sky sidecar is missing.

The `.WAT` is partially binary; `parse_wat_header()` extracts the water
plane height (byte 16 float32). `parse_sky_header()` is the older tint-only
`.SKY` read that `extract_3d.py` still uses for `sky_tint`.
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


# SKY1 payload layout (212 bytes), confirmed against the in-game console
# (`sky`, `sun` listings) and the editor panel bindings. Names are the
# console variables.
#   0x00 f32x4 sky.fogcolor RGBA   (fog colour; also the clear colour behind the dome)
#   0x10 f32   sky.fogstart        0x14 f32 sky.fogend   0x18 f32 sky.visibilityrange
#   0x1C f32   sun.period (realtime hours)   0x20 f32 sun.angle (hours along the arc)
#   0x24 f32   2*pi*angle/period (derived)
#   0x2C f32x4 sun.color RGBA      (alpha = light intensity)
#   0x3C f32x4 sky.ambientcolor RGBA (alpha = intensity)
#   0x50 f32   sky.height          0x54 char[32] sky.texturename (cloud layer)
#   0x74 u8x4  sky.color as B,G,R,A   0x78 u32 sky.modulate
#   0x7C char[32] sun.texturename
#   0x9C f32   sky.uspeed   0xA0 f32 sky.vspeed   0xA4 f32 sky.tilesize
#   0xA8 u32   sky.flags    0xB8 f32 sun.size (degrees)   0xBC f32 sun.distance
_SKY1_MIN_LEN = 0xC0
# `sky.flags` bits, from the editor's six TOGGLE buttons bound to the
# variable (bz2r_res/config/editor/bzeditor_sky.cfg: Toggle Dome 1, Stars 2,
# Flat 4, Clouds 8, Sprites 16, Sun 32). They decide which layers the engine
# draws: Remnant 49 = dome + sprites + sun; Europa Night 54 = stars + flat
# + sprites + sun, so its template dome name is never rendered. Bit 64
# appears on six maps and has no editor button.
SKY_FLAG_BITS = {
    "dome": 1,
    "stars": 2,
    "flat": 4,
    "clouds": 8,
    "sprites": 16,
    "sun": 32,
}
# STAR payload (64 bytes), confirmed against the console `stars` listing:
#   0x00 u8x4 stars.color (B,G,R,A)   0x04 u32 stars.count   0x08 f32 stars.distance
#   0x0C f32  stars.size (metres at that distance)   0x10 f32 stars.height
#   0x14 char[32] stars.texture   0x34 u32 stars.modulate (1 = add)
#   0x38 f32  stars.azimspeed     0x3C f32 stars.elevspeed
# Star positions are not stored; the engine scatters them at load.
_STAR_MIN_LEN = 0x40
# DOME payload (1808 bytes): a raw struct with embedded pointers. The fields
# the console confirms (`dome` listing, Europa Night):
#   0x0C f32 dome.radius   0x10 char[32] dome.name   0x30 u32 dome.type
#   (editor: 0 "Dome", 1 "Planet")   0x34 f32 dome.height
#   0x38 f32 dome.uspeed   0x3C f32 dome.vspeed   0x44 f32x3 dome.ambient
#   0x58 f32 dome.light.azim (rad)   0x5C f32 dome.light.elev (rad)
#   0x60 f32 dist   0x64 f32 range   0x68 f32 attenuation   0x6C f32x3 colour
_DOME_MIN_LEN = 0x78
# FOG payload (488 bytes): 16 local fog volumes of 7 floats
# (x, y, z, rx, ry, rz, density; density -1 = unused), then u32 count,
# then the height (ground) fog band: start, end, density, min dist, max dist.
_FOG_SLOTS = 16
_FOG_SLOT_FLOATS = 7


def _f32(blob: bytes, off: int) -> float | None:
    if off + 4 > len(blob):
        return None
    value = struct.unpack_from("<f", blob, off)[0]
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def _u32(blob: bytes, off: int) -> int | None:
    if off + 4 > len(blob):
        return None
    return struct.unpack_from("<I", blob, off)[0]


def _rgb_hex_floats(blob: bytes, off: int) -> str | None:
    if off + 12 > len(blob):
        return None
    r, g, b = struct.unpack_from("<3f", blob, off)
    if any(v != v for v in (r, g, b)):
        return None

    def ch(v: float) -> int:
        return int(round(max(0.0, min(1.0, v)) * 255))

    return f"#{ch(r):02x}{ch(g):02x}{ch(b):02x}"


def _bgra_hex(blob: bytes, off: int) -> str | None:
    if off + 4 > len(blob):
        return None
    b, g, r, _a = blob[off:off + 4]
    return f"#{r:02x}{g:02x}{b:02x}"


def _round(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def _sky1_atmosphere(sky1: bytes) -> dict | None:
    """Fog, sun, ambient, clear colour and cloud layer from a SKY1 payload."""
    if len(sky1) < _SKY1_MIN_LEN:
        return None
    return {
        "fog": {
            "color_hex": _rgb_hex_floats(sky1, 0x00),
            "start": _round(_f32(sky1, 0x10)),
            "end": _round(_f32(sky1, 0x14)),
            "visibility": _round(_f32(sky1, 0x18)),
            # Not stored in the file; the engine default, confirmed on every
            # map checked (`sky.fogmode` 3, `sky.fogbreak` 0.5).
            "mode": "linear",
            "break": 0.5,
        },
        "sky_color_hex": _bgra_hex(sky1, 0x74),
        # `sun` / `cloud` at the top level stay the asset stems; the light
        # and the cloud layer get their own keys.
        "sun_light": {
            "period_h": _round(_f32(sky1, 0x1C)),
            "angle_h": _round(_f32(sky1, 0x20)),
            "color_hex": _rgb_hex_floats(sky1, 0x2C),
            "intensity": _round(_f32(sky1, 0x38)),
            "texture": sky_asset_stem(_zstr(sky1, 0x7C, 32)),
            "size_deg": _round(_f32(sky1, 0xB8)),
            "distance": _round(_f32(sky1, 0xBC)),
        },
        "ambient": {
            "color_hex": _rgb_hex_floats(sky1, 0x3C),
            "intensity": _round(_f32(sky1, 0x48)),
        },
        "cloud_layer": {
            "texture": sky_asset_stem(_zstr(sky1, 0x54, 32)),
            "height": _round(_f32(sky1, 0x50)),
            "tilesize": _round(_f32(sky1, 0xA4)),
            "uspeed": _round(_f32(sky1, 0x9C), 4),
            "vspeed": _round(_f32(sky1, 0xA0), 4),
            "modulate": _u32(sky1, 0x78),
        },
        "flags": _u32(sky1, 0xA8),
    }


def decode_sky_flags(flags: int | None) -> dict:
    """`sky.flags` -> {dome, stars, flat, clouds, sprites, sun} booleans."""
    value = int(flags or 0)
    return {name: bool(value & bit) for name, bit in SKY_FLAG_BITS.items()}


def _star_chunk(blob: bytes) -> dict | None:
    """The starfield parameters from a STAR payload (positions are random)."""
    if len(blob) < _STAR_MIN_LEN:
        return None
    return {
        "color_hex": _bgra_hex(blob, 0x00),
        "count": _u32(blob, 0x04),
        "distance": _round(_f32(blob, 0x08)),
        "size": _round(_f32(blob, 0x0C), 4),
        "height": _round(_f32(blob, 0x10)),
        "texture": sky_asset_stem(_zstr(blob, 0x14, 32)),
        "modulate": _u32(blob, 0x34),
        "azim_speed": _round(_f32(blob, 0x38), 4),
        "elev_speed": _round(_f32(blob, 0x3C), 4),
    }


def _dome_chunk(blob: bytes) -> dict | None:
    """Dome type, placement, texture drift, ambient and first light."""
    if len(blob) < _DOME_MIN_LEN:
        return None
    azim = _f32(blob, 0x58)
    elev = _f32(blob, 0x5C)
    return {
        "type": _u32(blob, 0x30),
        "height": _round(_f32(blob, 0x34)),
        "uspeed": _round(_f32(blob, 0x38), 5),
        "vspeed": _round(_f32(blob, 0x3C), 5),
        "ambient_hex": _rgb_hex_floats(blob, 0x44),
        "light": {
            "azim_deg": None if azim is None else round(azim * 180.0 / 3.141592653589793, 2),
            "elev_deg": None if elev is None else round(elev * 180.0 / 3.141592653589793, 2),
            "dist": _round(_f32(blob, 0x60)),
            "range": _round(_f32(blob, 0x64)),
            "attenuation": _round(_f32(blob, 0x68)),
            "color_hex": _rgb_hex_floats(blob, 0x6C),
        },
    }


def _fog_chunk(blob: bytes) -> dict:
    """Local fog volumes and the ground fog band from a FOG payload."""
    volumes: list[dict] = []
    for i in range(_FOG_SLOTS):
        base = i * _FOG_SLOT_FLOATS * 4
        if base + _FOG_SLOT_FLOATS * 4 > len(blob):
            break
        x, y, z, rx, ry, rz, density = struct.unpack_from("<7f", blob, base)
        if density < 0 or density != density:
            continue
        volumes.append({
            "slot": i,
            "position": [_round(x), _round(y), _round(z)],
            "radius": [_round(rx), _round(ry), _round(rz)],
            "density": _round(density),
        })
    tail = _FOG_SLOTS * _FOG_SLOT_FLOATS * 4
    density = _f32(blob, tail + 0x0C)
    ground = {
        "start": _round(_f32(blob, tail + 0x04)),
        "end": _round(_f32(blob, tail + 0x08)),
        "density": _round(density),
        "min_dist": _round(_f32(blob, tail + 0x10)),
        "max_dist": _round(_f32(blob, tail + 0x14)),
        "enabled": bool(density is not None and density > 0),
    }
    return {"local_fog": volumes, "ground_fog": ground}


def parse_sky(path: Path | None) -> dict | None:
    """Decode a `.SKY` file: dome, clouds, sun sprite, billboards, and the
    atmosphere the engine actually renders (fog, sun light, ambient).

    Returns None when the file is missing or not the version-4 chunk
    layout. `colors.sky` is the SKY1 colour at payload 0x00, which the
    console reports as `sky.fogcolor`; it is kept under that name for the
    existing sidecar readers. The earlier `zenith` / `horizon` keys were a
    mislabel of the sun and ambient colours and are gone; those live in
    `sun.color_hex` and `ambient.color_hex`.

    `dome`, `cloud`, and `sun` are lowercase stems with the extension
    stripped (`miredome.fbx` -> `miredome`). `radius` is the DOME float
    at payload 0x0C (engine meters; the viewer does not use it as the
    on-screen size). `sprites` is the SPRT billboard list from
    `parse_sky_sprites`, with the header's shared `sprite_distance` /
    `sprite_height` beside it (`sprites.distance` 100 on every map; a
    sprite's `size` is metres at that distance). `fog` / `sun_light` /
    `ambient` / `sky_color_hex` / `cloud_layer` / `flags` follow the SKY1
    layout documented above; `layers` is `flags` decoded per
    `SKY_FLAG_BITS`; `stars` is the STAR chunk; `dome_params` the DOME
    extras; `local_fog` / `ground_fog` come from the FOG chunk.
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
    sprt = chunks.get("SPRT", b"")
    out = {
        "version": version,
        "dome": sky_asset_stem(_zstr(dome, 0x10, 48)),
        "cloud": sky_asset_stem(_zstr(sky1, 0x54, 40)),
        "sun": sky_asset_stem(_zstr(sky1, 0x7C, 40)),
        "radius": radius,
        "colors": {
            "sky": _rgba_hex(sky1, 0x00),
        },
        "sprites": parse_sky_sprites(sprt),
        "sprite_distance": _round(_f32(sprt, 0x04)) if len(sprt) >= _SPRT_HEADER else None,
        "sprite_height": _round(_f32(sprt, 0x08)) if len(sprt) >= _SPRT_HEADER else None,
        "stars": _star_chunk(chunks.get("STAR", b"")),
        "dome_params": _dome_chunk(dome),
    }
    atmosphere = _sky1_atmosphere(sky1)
    if atmosphere:
        out.update(atmosphere)
    out["layers"] = decode_sky_flags(out.get("flags"))
    out.update(_fog_chunk(chunks.get("FOG ", b"")))
    return out


# SPRT: 12-byte header (u32 selected index, f32 sprites.distance, f32
# sprites.height), then 56-byte records. Confirmed on the version-4 files
# (payload length == 12 + N*56) and the console `sprites` listing. The name
# is a 32-byte cstring; the rest is blend mode, a B,G,R,A tint (the console
# reports Remnant's moon as `255 220 180` for file bytes `b4 dc ff`), and
# size / azimuth / elevation / roll.
_SPRT_HEADER = 12
_SPRT_RECORD = 56


def _finite(value: float) -> float | None:
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def parse_sky_sprites(blob: bytes) -> list[dict]:
    """Billboards from a SPRT payload. Empty names are skipped.

    `blend` 0 is an alpha disc (Earth). `blend` 1 is additive (moons,
    galaxies, lens flares). `color` is the record's B,G,R bytes as #rrggbb.
    `size` is metres at the header's `sprites.distance` (100 m), so
    Remnant's size-40 moon spans `2 * atan(20 / 100)` = 22.6 degrees; 0
    hides the sprite (the stock template carries 44 slots, most of them 0).
    Angles are degrees, as stored: azimuth 0 is north, 90 east.
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
        blue, green, red = rec[36], rec[37], rec[38]
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


# Engine defaults when the .TRN omits the key, as the console reports them
# on Remnant (`terrain.diffusecolor` -> 178 178 178 255, `terrain.specularcolor`
# -> 255 255 255 255). Not white: a map without `DiffuseColor` renders its
# terrain at 70% of the texture brightness.
TERRAIN_DIFFUSE_DEFAULT_HEX = "#b2b2b2"
TERRAIN_SPECULAR_DEFAULT_HEX = "#ffffff"
TERRAIN_EMISSIVE_DEFAULT_HEX = "#000000"


def parse_trn_terrain_material(trn_path: Path | None) -> dict:
    """The terrain material the engine still reads from `.TRN [NormalView]`.

    Returns `diffuse_hex`, `specular_hex`, `specular_power` (float or None)
    and `emissive_hex`, with the engine defaults where a key is absent. Keys
    are matched case-insensitively (`DiffuseColor`, `Diffusecolor`,
    `diffusecolor` all occur in the corpus).
    """
    out = {
        "diffuse_hex": TERRAIN_DIFFUSE_DEFAULT_HEX,
        "specular_hex": TERRAIN_SPECULAR_DEFAULT_HEX,
        "specular_power": None,
        "emissive_hex": TERRAIN_EMISSIVE_DEFAULT_HEX,
        "source": "default",
    }
    if trn_path is None or not trn_path.is_file():
        return out
    nv = {k.lower(): v for k, v in _parse_ini(trn_path).get("NormalView", {}).items()}
    diffuse = _parse_rgba(nv.get("diffusecolor"))
    specular = _parse_rgba(nv.get("specularcolor"))
    emissive = _parse_rgba(nv.get("emissivecolor"))
    if diffuse:
        out["diffuse_hex"] = _rgb_to_hex(diffuse)
        out["source"] = "trn"
    if specular:
        out["specular_hex"] = _rgb_to_hex(specular)
        out["source"] = "trn"
    if emissive:
        out["emissive_hex"] = _rgb_to_hex(emissive)
    power = nv.get("specularpower")
    if power is not None:
        try:
            out["specular_power"] = float(str(power).strip().strip('"').strip("'"))
        except ValueError:
            pass
    return out


def parse_trn_lighting(trn_path: Path | None) -> dict:
    """Legacy: the BZ2-era `[Light]` / `[Sky]` / `[NormalView]` fog keys.

    BZCC renders the `.SKY` values instead (see `parse_sky`); only 9-11 of
    142 VSR maps still carry these keys and where they do they disagree
    with the `.SKY`. Kept because `extract_3d.py` writes them to the
    `.3d.json` `lighting` block, which the renderers use only as a fallback
    when a sky sidecar is missing.

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
