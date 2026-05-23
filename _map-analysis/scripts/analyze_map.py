"""
VT Stats - Map file analyzer (exploration tool).

Parses a Battlezone: Combat Commander map directory (containing some subset of
.bzn / .inf / .TRN / .des / .TER / .SKY / .WAT / .dds files) and extracts:
  - game objects (objClass + 3D position) from .bzn (ASCII or binary)
  - terrain bounds (origin, width/depth, m/grid, height range) from .TRN
  - NetVars / mission name from .inf
  - description text from .des
  - heightmap stats from .TER (TERR magic, BE float32 grid)

Outputs a structured JSON document and prints a human-readable summary.

Usage:
    python analyze_map.py "_map-analysis/Europa Night"
    python analyze_map.py "_map-analysis/Quarry" --out _map-analysis/quarry.json

This is exploratory / read-only. No project state is touched.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Object classification.
#
# Tier 1 (authoritative): the project's main ODF database at ../data/odf.min.json.
# Each ODF entry carries a pre-computed `inheritanceChain` listing every base
# class it inherits from (e.g. mossyjagged01pool -> [tepool01, deposit]). Any
# entry whose chain passes through a "known base" (`tepool01` for biometal
# pools, `scrap` for loose scrap, `recycler*` for recyclers, etc.) is
# classified accordingly. This catches custom-named pools / scrap variants
# that map authors invent for their maps - the names can be anything, but the
# inheritance is the ground truth.
#
# Tier 2 (regex fallback): a small set of regexes for things NOT in the ODF DB.
# BZN-level player slot markers (pspwn_*), DLL references, generic "player"
# tokens, and AI path / waypoint sentinels live in the BZN itself with no ODF
# file backing them, so they will never appear in odf.min.json.
# ---------------------------------------------------------------------------

# A bunch of common ODF-DB bases mapped to the kind we care about. Anything
# that inherits from these gets the corresponding kind, regardless of name.
ODF_BASE_TO_KIND: dict[str, str] = {
    # Scrap pools - 58 ODFs across the BZ:CC universe chain through tepool01.
    "tepool01":         "scrap_pool",
    # Loose scrap pieces - 11 ODFs through `scrap` (npscr1/2/3, scrapbig,
    # snowball / candy holiday variants, etc.)
    "scrap":            "loose_scrap",
    # Recyclers (starting building + dropship). 52 ODFs each through these.
    "recycler":         "recycler",
    "recyclervehicle":  "recycler",
}

# Top-level ODF DB categories we treat as "starting/initial unit" when the
# specific kind isn't more interesting. Used to bucket pre-placed BZN objects
# like ivscout / ispilo / etc. that would otherwise fall under "other".
ODF_CATEGORY_TO_KIND_FALLBACK: dict[str, str] = {
    "Pilot": "starting_unit",   # pre-placed unit pilots (rare in MP maps)
}

# Regex fallbacks: only for tokens NOT in the ODF DB. Order matters; first
# match wins.
OBJ_KIND_RULES_FALLBACK: list[tuple[str, str]] = [
    # Player / team spawn points (BZN-level markers, no ODF file)
    (r"^pspwn", "spawn_point"),
    # AI Paths / waypoints / markers
    (r"^aipath", "ai_path"),
    (r"^marker|^waypoint", "marker"),
    # DLL / mission script references
    (r"\.dll$", "mission_script"),
    # Generic top-level map references that aren't real game objects
    (r"^player$", "player_slot"),
    # Last-resort pool / scrap regexes - shouldn't be needed once the ODF DB
    # is loaded, but keep them as defense-in-depth for missing-DB scenarios.
    (r"^[a-z]{1,3}pool\d*$", "scrap_pool"),
    (r"^npscr", "loose_scrap"),
]


# Lazily loaded ODF DB. Keyed by lowercased ODF basename (no `.odf` suffix).
# Each value is {category, classLabel, inheritanceChain, unitName}.
_ODF_DB: dict[str, dict[str, Any]] | None = None
_ODF_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "odf.min.json"


def _load_odf_db() -> dict[str, dict[str, Any]]:
    """Lazily load + flatten data/odf.min.json into a name->info map.

    The on-disk DB is keyed by top-level category (Vehicle / Weapon / Pilot /
    Building / Misc / ...) -> {filename.odf: entry}. We flatten across
    categories so a single lookup answers "what is this ODF".
    """
    global _ODF_DB
    if _ODF_DB is not None:
        return _ODF_DB
    flat: dict[str, dict[str, Any]] = {}
    if not _ODF_DB_PATH.exists():
        _ODF_DB = flat
        return flat
    try:
        raw = json.loads(_ODF_DB_PATH.read_text(encoding="utf-8"))
    except Exception:
        _ODF_DB = flat
        return flat
    if not isinstance(raw, dict):
        _ODF_DB = flat
        return flat
    for category, entries in raw.items():
        if not isinstance(entries, dict):
            continue
        for fname, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            base = fname.lower()
            if base.endswith(".odf"):
                base = base[:-4]
            chain = entry.get("inheritanceChain") or []
            gobj = entry.get("GameObjectClass") or {}
            class_label = gobj.get("classLabel") if isinstance(gobj, dict) else None
            unit_name = gobj.get("unitName") if isinstance(gobj, dict) else None
            flat[base] = {
                "category": category,
                "classLabel": class_label,
                "inheritanceChain": list(chain) if isinstance(chain, list) else [],
                "unitName": unit_name,
            }
    _ODF_DB = flat
    return flat


def lookup_odf(odf: str) -> dict[str, Any] | None:
    """Return DB entry for an ODF basename, or None if not present."""
    db = _load_odf_db()
    key = odf.lower().strip()
    if key.endswith(".odf"):
        key = key[:-4]
    return db.get(key)


def classify_objclass(odf: str) -> str:
    """Classify a BZN objClass string into a coarse 'kind'.

    Strategy:
      1. ODF DB inheritance walk - reliable for anything that has an ODF file.
      2. ODF DB category fallback - covers e.g. Pilot.
      3. Regex fallback - covers BZN-only tokens (spawn slots, AI paths, etc).
    """
    info = lookup_odf(odf)
    if info is not None:
        for base in info["inheritanceChain"]:
            if base in ODF_BASE_TO_KIND:
                return ODF_BASE_TO_KIND[base]
        cat = info.get("category")
        if cat in ODF_CATEGORY_TO_KIND_FALLBACK:
            return ODF_CATEGORY_TO_KIND_FALLBACK[cat]

    s = odf.lower().strip()
    for pat, kind in OBJ_KIND_RULES_FALLBACK:
        if re.search(pat, s):
            return kind

    # Last-mile heuristic for vehicle-shaped names like `ivscout`, `evturr`,
    # etc. that came from custom ODFs not in the DB. Anything starting with
    # one of the four faction prefixes + `v` (vehicle) is treated as a
    # starting unit. Pilots get `pilo` suffix.
    if info is not None:
        cat = info.get("category")
        if cat == "Vehicle":
            return "starting_unit"
    if re.match(r"^[ifeb]v[a-z]", s):
        return "starting_unit"
    if re.match(r"^[ifeb]?pilo$", s):
        return "pilot"
    return "other"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class GameObject:
    obj_class: str
    kind: str
    position: tuple[float, float, float] | None  # (x, y, z) in meters; y is up
    team: int | None = None
    name: str | None = None
    source: str = "ascii"  # 'ascii' or 'binary'
    # ODF-DB enrichment (None when the ODF isn't in data/odf.min.json - true
    # for BZN-only tokens like `pspwn_1`).
    unit_name: str | None = None        # GameObjectClass.unitName, e.g. "Biometal Pool"
    db_category: str | None = None      # Top-level ODF DB category, e.g. "Building"
    inheritance_chain: list[str] = field(default_factory=list)


def enrich_game_object(obj: GameObject) -> GameObject:
    """Populate the optional ODF-DB fields on a GameObject in-place."""
    info = lookup_odf(obj.obj_class)
    if info is not None:
        obj.unit_name = info.get("unitName") or None
        obj.db_category = info.get("category") or None
        obj.inheritance_chain = info.get("inheritanceChain") or []
    return obj


@dataclass
class TerrainBounds:
    min_x: float
    min_z: float
    width: float        # extent along +X
    depth: float        # extent along +Z
    meters_per_grid: float
    height_max_setting: float | None = None
    tile_textures: list[str] = field(default_factory=list)


@dataclass
class HeightmapStats:
    cells_x: int
    cells_z: int
    cell_meters: float | None
    min_height: float
    max_height: float
    mean_height: float
    stdev_height: float
    sample_layout: str  # short note describing the decoded TER layout


@dataclass
class MapReport:
    map_dir: str
    files_present: dict[str, int]      # filename -> byte size
    mission_name: str | None = None
    description: str | None = None
    map_format_version: int | None = None
    binary_save: bool | None = None
    seq_count: int | None = None
    object_size: int | None = None
    terrain_name: str | None = None
    terrain_bounds: TerrainBounds | None = None
    # Why terrain_bounds is or isn't set. One of:
    #   "ok"              -> .TRN parsed cleanly with a [Size] block
    #   "missing"         -> no .TRN file in the map directory
    #   "no_size_block"   -> .TRN file is present but has no [Size] section
    #                        (typical for Strategy-Mode overlay .TRNs like
    #                         STAncientvsr.TRN that only carry textures + DLL)
    #   "parse_error"     -> .TRN exists and has [Size] but parsing failed
    trn_status: str = "missing"
    heightmap: HeightmapStats | None = None
    netvars: dict[str, str] = field(default_factory=dict)
    objects: list[GameObject] = field(default_factory=list)
    object_counts_by_kind: dict[str, int] = field(default_factory=dict)
    object_counts_by_class: dict[str, int] = field(default_factory=dict)
    object_counts_by_category: dict[str, int] = field(default_factory=dict)  # ODF DB top-level
    odf_db_hits: int = 0          # how many parsed objects matched in odf.min.json
    odf_db_misses: int = 0        # how many didn't (BZN-only tokens, custom non-DB classes)
    odf_db_miss_classes: list[str] = field(default_factory=list)  # distinct miss list
    inferred_bounds_from_objects: dict[str, float] | None = None
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Plain-text BZN parser (ASCII save format)
# ---------------------------------------------------------------------------

_ASCII_HEADER_RE = re.compile(
    r"^(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\[(?P<idx>\d+)\])?\s*=\s*(?P<val>.*)$"
)


def parse_bzn_ascii(text: str) -> tuple[dict[str, Any], list[GameObject]]:
    """Parse an ASCII (binarySave=false) BZN file.

    Returns (header_dict, [GameObject, ...]). header_dict carries top-level
    scalars like 'version', 'seq_count', 'g_TerrainName', 'size'.
    """
    lines = text.splitlines()
    header: dict[str, Any] = {}
    objects: list[GameObject] = []

    # Phase 1: top-of-file header (everything before the first [GameObject])
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].rstrip()
        if line.startswith("[GameObject]"):
            break
        m = _ASCII_HEADER_RE.match(line)
        if m and m.group("val") == "":
            # value lives on the NEXT line (the BZN convention is `key [N] =\nvalue`)
            if i + 1 < n:
                header[m.group("key")] = lines[i + 1].strip()
                i += 2
                continue
        elif m and m.group("val"):
            header[m.group("key")] = m.group("val").strip()
        i += 1

    # Phase 2: GameObject blocks
    while i < n:
        line = lines[i].rstrip()
        if not line.startswith("[GameObject]"):
            i += 1
            continue
        obj_class: str | None = None
        team: int | None = None
        name: str | None = None
        posit: dict[str, float] = {}
        i += 1
        while i < n and not lines[i].rstrip().startswith("[GameObject]"):
            ln = lines[i].rstrip()
            if obj_class is None and ln.startswith("objClass ="):
                obj_class = ln.split("=", 1)[1].strip()
            elif ln.startswith("team [1] =") or ln.startswith("team ="):
                if i + 1 < n:
                    try:
                        team = int(lines[i + 1].strip())
                    except ValueError:
                        team = None
            elif ln.startswith("name ="):
                rhs = ln.split("=", 1)[1].strip()
                if rhs:
                    name = rhs
            elif ln.startswith("  posit.x [1]"):
                if i + 1 < n:
                    posit["x"] = _parse_float(lines[i + 1].strip())
            elif ln.startswith("  posit.y [1]"):
                if i + 1 < n:
                    posit["y"] = _parse_float(lines[i + 1].strip())
            elif ln.startswith("  posit.z [1]"):
                if i + 1 < n:
                    posit["z"] = _parse_float(lines[i + 1].strip())
            i += 1

        if obj_class:
            pos: tuple[float, float, float] | None = None
            if {"x", "y", "z"}.issubset(posit):
                pos = (posit["x"], posit["y"], posit["z"])
            objects.append(enrich_game_object(GameObject(
                obj_class=obj_class,
                kind=classify_objclass(obj_class),
                position=pos,
                team=team,
                name=name,
                source="ascii",
            )))

    return header, objects


def _parse_float(s: str) -> float:
    try:
        return float(s)
    except ValueError:
        return float("nan")


# ---------------------------------------------------------------------------
# Binary BZN parser (binarySave=true). BZ2/BZCC layout per BZNTools README:
#   TypeSize=1, SizeSize=2, Alignment=0, Little-Endian
#   Each token = [1B type][2B size LE][size bytes data]
#
# BinaryFieldType enum (subset we care about):
#   0x01 BOOL    0x02 CHAR    0x03 SHORT   0x04 LONG
#   0x05 FLOAT   0x06 DOUBLE  0x08 PTR     0x09 VEC3D
#   0x0B MAT3DOLD  0x0C MAT3D  0x0D STRING
# ---------------------------------------------------------------------------

TYPE_BOOL, TYPE_CHAR, TYPE_SHORT, TYPE_LONG = 0x01, 0x02, 0x03, 0x04
TYPE_FLOAT, TYPE_DOUBLE, TYPE_ID, TYPE_PTR = 0x05, 0x06, 0x07, 0x08
TYPE_VEC3D, TYPE_VEC2D, TYPE_MAT3DOLD, TYPE_MAT3D = 0x09, 0x0A, 0x0B, 0x0C
TYPE_STRING, TYPE_QUAT = 0x0D, 0x0E
VALID_TYPES = {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E}

TYPE_NAME = {
    0x00: "VOID", 0x01: "BOOL", 0x02: "CHAR", 0x03: "SHORT", 0x04: "LONG",
    0x05: "FLOAT", 0x06: "DOUBLE", 0x07: "ID", 0x08: "PTR", 0x09: "VEC3D",
    0x0A: "VEC2D", 0x0B: "MAT3DOLD", 0x0C: "MAT3D", 0x0D: "STRING", 0x0E: "QUAT",
}


@dataclass
class BinToken:
    type_: int
    size: int
    data: bytes
    offset: int


def _find_binary_start(buf: bytes) -> int | None:
    """Locate the byte offset where binary data begins, immediately after the
    ASCII header's `binarySave [1] =\\r\\ntrue\\r\\n`."""
    # Use regex on the raw bytes; `re.search` accepts bytes.
    m = re.search(rb"binarySave\s*\[\s*1\s*\]\s*=\s*\r?\n(true|false)\s*\r?\n", buf)
    if not m:
        return None
    if m.group(1).lower() == b"false":
        return -1  # signal "no binary section"
    return m.end()


def _tokenize_binary(buf: bytes, start: int) -> Iterable[BinToken]:
    """Walk binary tokens starting at `start`. Stops on EOF or malformed type byte.

    Recovers gracefully: skips one byte on type bytes outside VALID_TYPES so a
    rare alignment glitch doesn't kill the whole pass.
    """
    pos = start
    n = len(buf)
    while pos + 3 <= n:
        type_ = buf[pos]
        if type_ not in VALID_TYPES:
            # mild resync: step one byte
            pos += 1
            continue
        size = int.from_bytes(buf[pos + 1:pos + 3], "little", signed=False)
        if pos + 3 + size > n:
            return
        data = buf[pos + 3:pos + 3 + size]
        yield BinToken(type_=type_, size=size, data=data, offset=pos)
        pos += 3 + size


def _decode_mat3d_position(data: bytes) -> tuple[float, float, float] | None:
    """Decode the position from a MAT3D token.

    Per BZNTools' BZNTokenBinary.GetMatrix (BZ:CC binary format):
        DATA_MAT3D = 16 LE float32 in a 4x4 row layout
            [right.xyzw][up.xyzw][front.xyzw][posit.xyzw]
        Position lives at float indices 12,13,14 (bytes 48..60).
        Position.W (index 15) is the homogeneous 1.0 marker.

    DATA_MAT3DOLD = 12 LE float32 (no W columns) in non-bigPosit mode:
        [right.xyz][up.xyz][front.xyz][posit.xyz]
        Position at float indices 9,10,11 (bytes 36..48).

    DATA_MAT3DOLD bigPosit = 9 floats + 4 bytes junk + 3 doubles (60 bytes):
        Position is the 3 doubles at bytes 40..64.
    """
    if len(data) == 64:
        floats = struct.unpack("<16f", data)
        return floats[12], floats[13], floats[14]
    if len(data) == 48:
        floats = struct.unpack("<12f", data)
        return floats[9], floats[10], floats[11]
    if len(data) == 60:
        doubles = struct.unpack("<3d", data[36:60])
        return doubles[0], doubles[1], doubles[2]
    return None


_ODF_CHAR_RE = re.compile(rb"^[a-z][a-z0-9_]{2,29}(?:\.[a-z0-9]{2,4})?$")


def parse_bzn_binary(buf: bytes) -> tuple[dict[str, Any], list[GameObject]]:
    """Parse the binary tail of a BZ2/BZCC BZN file.

    Strategy: tokenize the entire binary section, then walk the token list
    looking for the SizedString length-byte / value-byte pattern that encodes
    each `objClass` (a printable ASCII ODF name). For every objClass token
    we accept, we then scan forward for the next MAT3D token and decode the
    object's position from it.
    """
    header: dict[str, Any] = {}
    objects: list[GameObject] = []

    bstart = _find_binary_start(buf)
    if bstart is None or bstart == -1:
        return header, objects

    # Capture an attempt at top-level header tokens before object stream begins.
    # We just record them as decoded scalars where useful.
    toks: list[BinToken] = list(_tokenize_binary(buf, bstart))
    if not toks:
        return header, objects

    # Heuristic header peek: first SizedString = msn_filename; first LONG after
    # it = seq_count; second LONG = saveType; next SizedString (size up to 100)
    # = g_TerrainName; next LONG = `size`.
    def _read_sized_string(i: int) -> tuple[str | None, int]:
        # SizedString in BZ2 v>1128: CHAR(size=1, len byte) then optional CHAR(value)
        if i >= len(toks):
            return None, i
        t = toks[i]
        if t.type_ != TYPE_CHAR or t.size != 1:
            return None, i
        length = t.data[0]
        if length == 0:
            return "", i + 1
        if i + 1 >= len(toks):
            return None, i + 1
        t2 = toks[i + 1]
        if t2.type_ != TYPE_CHAR:
            return None, i + 1
        try:
            return t2.data[:length].decode("ascii", errors="replace"), i + 2
        except Exception:
            return None, i + 2

    i = 0
    s, j = _read_sized_string(i)
    if s is not None:
        header["msn_filename"] = s
        i = j
    if i < len(toks) and toks[i].type_ == TYPE_LONG:
        header["seq_count"] = int.from_bytes(toks[i].data, "little")
        i += 1
    if i < len(toks) and toks[i].type_ == TYPE_LONG:
        header["saveType"] = int.from_bytes(toks[i].data, "little")
        i += 1
    # g_TerrainName lives in a CHAR[100] buffer in the file but the token
    # may report its true on-wire size; we just want the c-string prefix.
    if i < len(toks) and toks[i].type_ == TYPE_CHAR and toks[i].size >= 8:
        s = toks[i].data.split(b"\x00", 1)[0].decode("ascii", errors="replace")
        header["g_TerrainName"] = s
        i += 1
    if i < len(toks) and toks[i].type_ == TYPE_LONG:
        header["size"] = int.from_bytes(toks[i].data, "little")
        i += 1

    # Now sweep the token stream looking for objClass entries.
    #
    # An objClass token in a BZ2 binary GameObject stream is a SizedString
    # (length byte + value bytes) that is IMMEDIATELY followed by a LONG
    # `seqno` token. That seqno-after-objClass invariant is what lets us
    # distinguish a real objClass from intermediate property strings like
    # name="Scrap" or curPilot="ispilo" that share the SizedString shape.
    #
    # Acceptance rule (all must hold):
    #   - toks[k]   = (CHAR, size=1, data=[L])      with 3 <= L <= 31
    #   - toks[k+1] = (CHAR, size>=L)               with data[:L] matching
    #                                                an all-lowercase ODF regex
    #   - toks[k+2] = (LONG, size=4)                seqno
    #
    # Then we scan forward (up to NEXT_OBJ_MAX_SCAN tokens) for the next
    # MAT3D token and decode the object's world position from it.
    NEXT_OBJ_MAX_SCAN = 200

    k = i
    while k < len(toks) - 2:
        t = toks[k]
        if t.type_ == TYPE_CHAR and t.size == 1 and 3 <= t.data[0] <= 31:
            L = t.data[0]
            t2 = toks[k + 1]
            t3 = toks[k + 2]
            if (
                t2.type_ == TYPE_CHAR
                and t2.size >= L
                and t3.type_ == TYPE_LONG
                and t3.size == 4
            ):
                name_bytes = t2.data[:L]
                if _ODF_CHAR_RE.match(name_bytes):
                    odf = name_bytes.decode("ascii", errors="replace")
                    pos: tuple[float, float, float] | None = None
                    team: int | None = None
                    for m in range(k + 3, min(k + 3 + NEXT_OBJ_MAX_SCAN, len(toks))):
                        tm = toks[m]
                        # Stop scanning when we hit the next likely objClass start.
                        if (
                            m + 2 < len(toks)
                            and tm.type_ == TYPE_CHAR and tm.size == 1
                            and 3 <= tm.data[0] <= 31
                            and toks[m + 1].type_ == TYPE_CHAR
                            and toks[m + 1].size >= tm.data[0]
                            and toks[m + 2].type_ == TYPE_LONG
                            and _ODF_CHAR_RE.match(toks[m + 1].data[:tm.data[0]])
                        ):
                            break
                        if team is None and tm.type_ in (TYPE_CHAR, TYPE_SHORT) and tm.size in (1, 2):
                            if tm.type_ == TYPE_CHAR and tm.size == 1:
                                v = tm.data[0]
                                if 0 <= v <= 20:
                                    team = v
                            elif tm.type_ == TYPE_SHORT and tm.size == 2:
                                v = int.from_bytes(tm.data, "little", signed=True)
                                if 0 <= v <= 20:
                                    team = v
                        if tm.type_ == TYPE_MAT3D and tm.size in (48, 60, 64):
                            pos = _decode_mat3d_position(tm.data)
                            break
                    objects.append(enrich_game_object(GameObject(
                        obj_class=odf,
                        kind=classify_objclass(odf),
                        position=pos,
                        team=team,
                        name=None,
                        source="binary",
                    )))
                    k += 3
                    continue
        k += 1

    return header, objects


# ---------------------------------------------------------------------------
# .TRN / .inf / .des / .TER parsers
# ---------------------------------------------------------------------------

def parse_ini_file(path: Path) -> dict[str, dict[str, str]]:
    """Lightweight INI parser; ignores // comments. Returns sections->{key:val}.
    Bare keys (no section) live under "".
    """
    sections: dict[str, dict[str, str]] = {"": {}}
    cur = sections[""]
    if not path.exists():
        return sections
    text = path.read_text(encoding="utf-8", errors="replace")
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            name = line[1:-1].strip()
            cur = sections.setdefault(name, {})
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            v = v.strip().strip('"')
            cur[k.strip()] = v
    return sections


def parse_trn(path: Path) -> tuple[TerrainBounds | None, str]:
    """Parse a `.TRN` file. Returns (bounds, status).

    status is one of:
      "ok"             - [Size] block present and parsed cleanly
      "no_size_block"  - file present, no [Size] section (typical for Strategy
                         Mode overlay .TRNs that only carry texture/DLL config)
      "parse_error"    - [Size] section is present but a value couldn't parse
    """
    sections = parse_ini_file(path)
    sz = sections.get("Size") or {}
    if not sz:
        return None, "no_size_block"
    tex = sections.get("Texture") or {}
    tile_textures = [v for k, v in sorted(tex.items()) if k.startswith("TileTexture") and v]
    try:
        return TerrainBounds(
            min_x=float(sz.get("MinX", "0")),
            min_z=float(sz.get("MinZ", "0")),
            width=float(sz.get("Width", "0")),
            depth=float(sz.get("Depth", "0")),
            meters_per_grid=float(sz.get("MetersPerGrid", "0")),
            height_max_setting=float(sz["Height"]) if "Height" in sz else None,
            tile_textures=tile_textures,
        ), "ok"
    except (ValueError, KeyError):
        return None, "parse_error"


def parse_ter(
    path: Path,
    expected_meters_per_grid: float | None = None,
    height_setting: float | None = None,
) -> HeightmapStats | None:
    """Decode a `.TER` heightmap.

    Layout (empirically reverse-engineered from BZ:CC v5 .TER files):

        offset 0x00  magic "TERR" (4 bytes)
        offset 0x04  uint32 LE  -> version (observed: 5)
        offset 0x08  int16 LE x4 -> tile_min_x, tile_min_z, tile_max_x, tile_max_z
                                     (cell counts in TER's 2 m units, signed)
        offset 0x10  int16 LE per cell -> raw signed height
                      scaled by `Height` (from .TRN, default 100) / 32767
                      so the on-disk values map to roughly -100..+100 m
                      around a per-map base altitude carried elsewhere.
        ...trailer with per-cell texture indices and lighting data
           (not decoded here; ~1.08 extra bytes per cell + small footer)

    Returns None on magic/version mismatch or unusable dimensions.
    """
    if not path.exists():
        return None
    raw = path.read_bytes()
    if len(raw) < 32 or raw[:4] != b"TERR":
        return None
    version = int.from_bytes(raw[4:8], "little")
    tile_min_x = int.from_bytes(raw[8:10], "little", signed=True)
    tile_min_z = int.from_bytes(raw[10:12], "little", signed=True)
    tile_max_x = int.from_bytes(raw[12:14], "little", signed=True)
    tile_max_z = int.from_bytes(raw[14:16], "little", signed=True)
    cells_x = tile_max_x - tile_min_x
    cells_z = tile_max_z - tile_min_z
    if cells_x <= 0 or cells_z <= 0:
        return None
    body = raw[16:]

    # Empirically, each cell occupies 4 bytes: int16 LE height plus 2 bytes
    # of per-cell auxiliary data (texture/blend indices, lighting nibbles).
    # Verified by minimizing the mean |h(x+1) - h(x)| across rows: stride=4
    # was ~2.5x smoother than 2 or 3 on `vsreuronig.TER`.
    cell_stride = 4
    if cells_x * cells_z * cell_stride > len(body):
        # The TER body in real BZ:CC files is sometimes shorter than the
        # header-declared cells_x*cells_z*4 would require. Clamp cells_z to
        # whatever the body actually fits at stride 4.
        max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            cell_stride = 3
            max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            cell_stride = 2
            max_rows = len(body) // (cells_x * cell_stride)
        if max_rows <= 0:
            return None
        cells_z = max_rows
    total_cells = cells_x * cells_z

    scale = (height_setting or 100.0) / 32767.0
    heights: list[float] = []
    sample_stride = max(1, total_cells // 16384)  # cap stat samples at ~16k
    for i in range(0, total_cells, sample_stride):
        o = i * cell_stride
        if o + 2 > len(body):
            break
        v = int.from_bytes(body[o:o + 2], "little", signed=True)
        heights.append(v * scale)
    if not heights:
        return None
    mean = sum(heights) / len(heights)
    var = sum((h - mean) ** 2 for h in heights) / len(heights)
    stdev = var ** 0.5
    cell_meters = None
    if expected_meters_per_grid is not None:
        # .TRN MetersPerGrid is usually 8.0 with a 2048m map => 256 "grids".
        # The .TER is finer, with cells_x cells over the same span; per-cell
        # spacing is therefore (width_m / cells_x).
        if cells_x > 0:
            cell_meters = (expected_meters_per_grid * (cells_x // 256)) if False else None
            # Better: derive from world width if we have it. The caller passes
            # MetersPerGrid; we don't have width here, so leave None for now.
    return HeightmapStats(
        cells_x=cells_x,
        cells_z=cells_z,
        cell_meters=cell_meters,
        min_height=min(heights),
        max_height=max(heights),
        mean_height=mean,
        stdev_height=stdev,
        sample_layout=(
            f"TERR v{version}; {cells_x}x{cells_z} cells, stride={cell_stride} bytes; "
            f"heights = int16 LE at byte 0 of each cell, scaled by {scale:.6g} "
            f"(Height={height_setting or 100.0:g}); "
            f"sampled {len(heights)} of {total_cells} cells"
        ),
    )


# ---------------------------------------------------------------------------
# Top-level analyze() driver
# ---------------------------------------------------------------------------

def analyze_map_dir(map_dir: Path) -> MapReport:
    report = MapReport(map_dir=str(map_dir), files_present={})

    files = {p.name.lower(): p for p in map_dir.iterdir() if p.is_file()}
    for p in map_dir.iterdir():
        if p.is_file():
            report.files_present[p.name] = p.stat().st_size

    # ----- .inf
    inf_path = _find_one(files, ".inf")
    if inf_path:
        sections = parse_ini_file(inf_path)
        desc = sections.get("DESCRIPTION", {})
        report.mission_name = desc.get("missionName")
        nv = sections.get("NetVars", {})
        # filter only the canonical i/svar keys for the report
        report.netvars = {k: v for k, v in nv.items() if k.startswith(("ivar", "svar"))}

    # ----- .des
    des_path = _find_one(files, ".des")
    if des_path:
        try:
            report.description = des_path.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            report.description = None

    # ----- .TRN
    trn_path = _find_one(files, ".trn")
    if trn_path:
        report.terrain_bounds, report.trn_status = parse_trn(trn_path)
    else:
        report.trn_status = "missing"

    # ----- .bzn
    bzn_path = _find_one(files, ".bzn")
    if bzn_path:
        raw = bzn_path.read_bytes()
        # Decide ASCII vs binary by reading the binarySave flag
        m = re.search(rb"binarySave\s*\[\s*1\s*\]\s*=\s*\r?\n(true|false)", raw)
        if m and m.group(1).lower() == b"true":
            header, objs = parse_bzn_binary(raw)
            report.notes.append("BZN parsed in binary mode (BZ2/BZCC).")
        else:
            text = raw.decode("utf-8", errors="replace")
            header, objs = parse_bzn_ascii(text)
            report.notes.append("BZN parsed in ASCII mode.")
        # Pull header scalars we care about
        report.binary_save = (m is not None and m.group(1).lower() == b"true")
        if "version" in header:
            try:
                report.map_format_version = int(str(header["version"]).strip())
            except ValueError:
                report.map_format_version = None
        if "seq_count" in header:
            try:
                report.seq_count = int(str(header["seq_count"]).strip())
            except ValueError:
                report.seq_count = None
        if "g_TerrainName" in header:
            report.terrain_name = str(header["g_TerrainName"]).strip()
        if "size" in header:
            try:
                report.object_size = int(str(header["size"]).strip())
            except ValueError:
                report.object_size = None
        report.objects = objs
        # Build counts (kind + class + DB category) and audit DB hit rate
        miss_classes_seen: set[str] = set()
        for o in objs:
            report.object_counts_by_kind[o.kind] = report.object_counts_by_kind.get(o.kind, 0) + 1
            report.object_counts_by_class[o.obj_class] = report.object_counts_by_class.get(o.obj_class, 0) + 1
            if o.db_category:
                report.object_counts_by_category[o.db_category] = report.object_counts_by_category.get(o.db_category, 0) + 1
                report.odf_db_hits += 1
            else:
                report.odf_db_misses += 1
                if o.obj_class not in miss_classes_seen:
                    miss_classes_seen.add(o.obj_class)
                    report.odf_db_miss_classes.append(o.obj_class)
        # Inferred bounds from object positions (fallback when no .TRN)
        xs = [o.position[0] for o in objs if o.position is not None]
        zs = [o.position[2] for o in objs if o.position is not None]
        ys = [o.position[1] for o in objs if o.position is not None]
        if xs and zs:
            report.inferred_bounds_from_objects = {
                "min_x": min(xs), "max_x": max(xs),
                "min_z": min(zs), "max_z": max(zs),
                "x_extent": max(xs) - min(xs),
                "z_extent": max(zs) - min(zs),
                "min_y": min(ys) if ys else float("nan"),
                "max_y": max(ys) if ys else float("nan"),
                "n_objects_with_position": len(xs),
            }

    # ----- .TER
    ter_path = _find_one(files, ".ter")
    if ter_path:
        mpg = report.terrain_bounds.meters_per_grid if report.terrain_bounds else None
        hset = report.terrain_bounds.height_max_setting if report.terrain_bounds else None
        report.heightmap = parse_ter(
            ter_path,
            expected_meters_per_grid=mpg,
            height_setting=hset,
        )

    return report


def _find_one(files: dict[str, Path], ext: str) -> Path | None:
    for name, p in files.items():
        if name.endswith(ext):
            return p
    return None


# ---------------------------------------------------------------------------
# Pretty-printer
# ---------------------------------------------------------------------------

def summarize(report: MapReport) -> str:
    out: list[str] = []
    out.append(f"=== {report.mission_name or Path(report.map_dir).name} ===")
    out.append(f"map_dir: {report.map_dir}")
    out.append("")
    out.append("Files:")
    for n, sz in sorted(report.files_present.items()):
        out.append(f"  {n:<24} {sz:>10,d} bytes")
    out.append("")
    if report.description:
        out.append("Description (.des):")
        for ln in report.description.splitlines():
            out.append(f"  | {ln}")
        out.append("")
    out.append("BZN header:")
    out.append(f"  binary_save:          {report.binary_save}")
    out.append(f"  map_format_version:   {report.map_format_version}")
    out.append(f"  seq_count:            {report.seq_count}")
    out.append(f"  object_size (header): {report.object_size}")
    out.append(f"  terrain_name:         {report.terrain_name}")
    out.append("")
    if report.terrain_bounds:
        tb = report.terrain_bounds
        out.append("Terrain (.TRN):")
        out.append(f"  origin:           ({tb.min_x:g}, {tb.min_z:g}) meters")
        out.append(f"  extent:           {tb.width:g} x {tb.depth:g} meters")
        out.append(f"  meters_per_grid:  {tb.meters_per_grid:g}")
        if tb.height_max_setting is not None:
            out.append(f"  height setting:   {tb.height_max_setting:g}")
        if tb.tile_textures:
            out.append(f"  tile textures:    {', '.join(tb.tile_textures)}")
        out.append("")
    else:
        out.append("Terrain (.TRN):   (no .TRN file in map dir)")
        if report.inferred_bounds_from_objects:
            ib = report.inferred_bounds_from_objects
            out.append("Inferred from object positions:")
            out.append(f"  x range:  [{ib['min_x']:.1f}, {ib['max_x']:.1f}]  extent {ib['x_extent']:.1f} m")
            out.append(f"  z range:  [{ib['min_z']:.1f}, {ib['max_z']:.1f}]  extent {ib['z_extent']:.1f} m")
            out.append(f"  y range:  [{ib['min_y']:.1f}, {ib['max_y']:.1f}]")
            out.append("")
    if report.heightmap:
        h = report.heightmap
        out.append("Heightmap (.TER):")
        out.append(f"  grid:        {h.cells_x} x {h.cells_z} cells")
        out.append(f"  height min:  {h.min_height:.2f}")
        out.append(f"  height max:  {h.max_height:.2f}")
        out.append(f"  height mean: {h.mean_height:.2f}")
        out.append(f"  stdev:       {h.stdev_height:.2f}")
        out.append(f"  decode note: {h.sample_layout}")
        out.append("")
    out.append(f"Game objects (size header={report.object_size}, parsed={len(report.objects)}):")
    for kind, cnt in sorted(report.object_counts_by_kind.items(), key=lambda kv: -kv[1]):
        out.append(f"  {kind:<14} {cnt}")
    out.append("")
    if report.object_counts_by_category:
        out.append("By ODF-DB category:")
        for cat, cnt in sorted(report.object_counts_by_category.items(), key=lambda kv: -kv[1]):
            out.append(f"  {cat:<14} {cnt}")
        out.append(f"  (DB hits={report.odf_db_hits}, misses={report.odf_db_misses})")
        if report.odf_db_miss_classes:
            out.append(f"  miss classes: {', '.join(report.odf_db_miss_classes)}")
        out.append("")
    out.append("By class:")
    for cls, cnt in sorted(report.object_counts_by_class.items(), key=lambda kv: -kv[1]):
        out.append(f"  {cls:<24} {cnt}")
    out.append("")
    # Pools + spawn points + a sample of loose scrap
    pools = [o for o in report.objects if o.kind == "scrap_pool"]
    spawns = [o for o in report.objects if o.kind == "spawn_point"]
    scrap = [o for o in report.objects if o.kind == "loose_scrap"]
    out.append(f"Pool count:        {len(pools)}")
    out.append(f"Loose scrap count: {len(scrap)}")
    out.append(f"Spawn point count: {len(spawns)}")
    out.append("")
    if pools:
        out.append("Pool positions:")
        for o in pools:
            pos = _fmt_pos(o.position)
            out.append(f"  {o.obj_class:<10} {pos}    team={o.team}")
        out.append("")
    if spawns:
        out.append("Spawn point positions:")
        for o in spawns:
            pos = _fmt_pos(o.position)
            out.append(f"  {o.obj_class:<10} {pos}    team={o.team}")
        out.append("")
    if scrap[:5]:
        out.append("Loose scrap (first 5):")
        for o in scrap[:5]:
            out.append(f"  {o.obj_class:<10} {_fmt_pos(o.position)}    team={o.team}")
        out.append(f"  ... ({len(scrap)} total)")
        out.append("")
    if report.notes:
        out.append("Notes:")
        for nt in report.notes:
            out.append(f"  - {nt}")
    return "\n".join(out)


def _fmt_pos(p: tuple[float, float, float] | None) -> str:
    if p is None:
        return "(no transform decoded)"
    return f"({p[0]:>9.2f}, {p[1]:>8.2f}, {p[2]:>9.2f})"


def report_to_json(report: MapReport) -> dict[str, Any]:
    d = asdict(report)
    # Tuples come out as lists from asdict; fine.
    return d


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="VT Stats - BZ:CC map analyzer")
    ap.add_argument("map_dir", help="Path to a directory holding one map's files")
    ap.add_argument("--out", default=None, help="Write JSON to this path")
    args = ap.parse_args(argv)

    map_dir = Path(args.map_dir)
    if not map_dir.is_dir():
        print(f"error: {map_dir} is not a directory", file=sys.stderr)
        return 2

    report = analyze_map_dir(map_dir)
    print(summarize(report))

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report_to_json(report), indent=2, default=str), encoding="utf-8")
        print(f"\nWrote JSON: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
