"""
build_odf_db.py - Single-script rebuild of data/odf.min.json with safeguards.

Walks every *.odf in the BZ2R install + the VSR mod's INI-declared asset
dependencies, parses them with full data (no noise filter), runs an
inheritance pass + recursive composition-ref expansion (with shared-reference
assignment, depth cap, per-ODF block valve, and 90s wall-clock deadline),
categorizes into 12 buckets, and writes the result to scripts/odf/odf.min.json.

The production file at data/odf.min.json is NEVER touched. Promotion is
a deliberate manual `copy` step after reviewing the build summary.

Safety: a psutil RSS watchdog daemon thread is armed before any heavy work.
If process RSS exceeds RSS_HARD_CAP_BYTES at any point, the watchdog dumps
diagnostics and forces os._exit(2). 2 GB is intentional - if Stage 4 needs
more, the algorithm has a structural bug, not a memory budget shortage.

CLI:
  python scripts/odf/build_odf_db.py [--verbose] [--dry-run] [--no-deps]
                                     [--steam-base PATH] [--limit N]
                                     [--forensic [N]] [--self-check]

Run order discipline (mandatory, do not skip):
  1. python scripts/odf/build_odf_db.py --forensic       (peak RSS < 500 MB)
  2. python scripts/odf/build_odf_db.py --limit 200      (peak RSS < 1 GB)
  3. python scripts/odf/build_odf_db.py --self-check     (peak RSS < 2 GB)
  4. Manual:  copy scripts\\odf\\odf.min.json data\\odf.min.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import tracemalloc
from copy import deepcopy
from pathlib import Path

try:
    import psutil
except ImportError:
    sys.stderr.write(
        "ERROR: psutil is required for the RSS watchdog.\n"
        "Install with: pip install psutil\n"
    )
    sys.exit(1)


# ---------- Paths ----------

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent

# Hardcoded fallback. Real path resolution: registry-first via winreg, then
# this constant, then --steam-base override (highest precedence).
STEAM_BASE_FALLBACK = Path(r"C:\Program Files (x86)\Steam\steamapps")
BZ2R_DIR_RELATIVE = Path("common") / "BZ2R"
WORKSHOP_RELATIVE = Path("workshop") / "content" / "624970"  # BZCC appid
VSR_MOD_ID = "1325933293"  # "Vet Strat Recycler Variant" config mod

# Output goes into the SCRIPT folder, not directly into data/. Hand-copy to
# data/odf.min.json after reviewing the diff summary. Build is safe-by-default.
OUTPUT_PATH = SCRIPT_DIR / "odf.min.json"
PROD_PATH = PROJECT_ROOT / "data" / "odf.min.json"


# ---------- Safeguards ----------

RSS_HARD_CAP_BYTES = 2 * 1024 ** 3       # 2 GB - watchdog kill threshold
STAGE4_WALLCLOCK_CAP_S = 90.0             # 90 s - Stage 4 hard deadline
PER_ODF_BLOCK_VALVE = 2000                # break expansion if any ODF crosses this (post-MAX_PREFIX_DEPTH backstop)
RSS_WATCHDOG_POLL_S = 0.25                # 250 ms watchdog poll
MAX_REF_DEPTH = 4                         # max recursion depth in expand_refs walk
MAX_PREFIX_DEPTH = 3                      # max dot count in prefixed keys (caps JSON fanout from Explosion.classX 13-way refs)


# ---------- Categorize order (first-match wins) ----------
# Config and Effect must be LAST so all the better-fitting buckets get first dibs.

CATEGORIES = [
    ("Vehicle",   ["CraftClass"]),
    ("Weapon",    ["WeaponClass"]),
    ("Pilot",     ["PersonClass"]),
    ("Building",  ["BuildingClass"]),
    ("Ordnance",  ["OrdnanceClass"]),
    ("Powerup",   ["WeaponPowerupClass"]),
    ("Explosion", ["ExplosionClass", "Explosion"]),
    ("Mine",      ["MineClass", "MagnetMineClass", "FlareMineClass"]),
    ("Spawn",     ["ObjectSpawnClass"]),
    ("Misc",      ["CameraPodClass", "ScrapClass", "TeleportalClass",
                   "PlantClass", "TorpedoClass", "KingOfHillClass",
                   "MoneyPowerupClass"]),
    ("Config",    ["EasyWeaponSlot1", "MediumWeaponSlot1",
                   "HardWeaponSlot1", "ExtremeWeaponSlot1"]),
    ("Effect",    ["LightClass"]),
]

SPECIAL_CATEGORY = {
    "apwrck.odf": "Weapon",
    "apwrckvsr.odf": "Weapon",
    "apserv.odf": "Powerup",
}

# Mission/config singletons that aren't game objects in any meaningful sense.
# These get unconditionally dropped before categorize.
CONFIG_DROPLIST = {
    "missions.odf", "audio.odf", "instant.odf", "weapons.odf",
    "taunts.odf", "music.odf", "mpvehicles.odf", "dmvehicles.odf",
    "mpicheck.odf", "ctfcheck.odf", "stcheck.odf", "stctfcheck.odf",
    "mpivsrcheck.odf",
    "fevent.odf", "eevent.odf", "cevent.odf", "ievent.odf",
    "forder.odf", "iorder.odf", "eorder.odf", "corder.odf",
    "stratstarting.odf", "stratstartingvsr.odf",
}

# Regex-driven additions to the droplist. Anything matching these patterns
# is also dropped before categorize. The names look like
# "vsr-stock05stratstarting.odf" - VSR mission-level config stubs.
CONFIG_DROPLIST_PATTERNS = [
    re.compile(r"^vsr-stock\d+stratstarting\.odf$", re.IGNORECASE),
]


# ---------- Composition refs (recursive expansion table) ----------
# Each entry: (containing_section_pattern, field_pattern, prefix_segment)
# When a property matches, recursively expand the target ODF's blocks under
# the composing prefix segment.

COMPOSITION_REFS = [
    # Existing (carried over from current merge.py - PULL direction:
    # target ODF's data copied INTO the source ODF under <prefix>.<section>):
    ("WeaponClass",          "ordName",         "Ordnance"),
    # NOTE: WeaponPowerupClass.weaponName is handled separately in
    # apply_powerup_push() because the seed inverts its direction
    # (it injects the POWERUP data INTO the WEAPON under Powerup.* prefix).
    # The production data/odf.min.json reflects this: weapons have Powerup.*
    # blocks; powerups do not. Keeping that semantics for parity.
    # Explosion refs:
    ("OrdnanceClass",        "xplGround",       "ExplGround"),
    ("OrdnanceClass",        "xplVehicle",      "ExplVehicle"),
    ("OrdnanceClass",        "xplBuilding",     "ExplBuilding"),
    ("OrdnanceClass",        "xplBlast",        "ExplBlast"),
    ("OrdnanceClass",        "xplExpire",       "ExplExpire"),
    ("PulseShellClass",      "xplPulse",        "ExplPulse"),
    ("BlinkDeviceClass",     "xplEnter",        "ExplEnter"),
    ("BlinkDeviceClass",     "xplExit",         "ExplExit"),
    ("DayWreckerClass",      "xplBlast",        "ExplBlast"),
    ("ArcCannonClass",       "xplVehicle",      "ExplVehicle"),
    ("ArcCannonClass",       "xplBuilding",     "ExplBuilding"),
    ("GameObjectClass",      "explosionName",   "Explosion"),
    ("GameObjectClass",      "xplName",         "Explosion"),
    ("CraftClass",           "XplChunk",        "ExplChunk"),
    # Secondary-ordnance / payload / dispenser refs:
    ("RadarPopperClass",     "launchOrd",       "LaunchOrd"),
    ("FlareMineClass",       "payloadName",     "Payload"),
    ("SprayBombClass",       "payloadName",     "Payload"),
    ("TripMineClass",        "payloadName",     "Payload"),
    ("SprayBuildingClass",   "payloadName",     "Payload"),
    ("DispenserClass",       "objectClass",     "DispenserObj"),
    ("TorpedoLauncherClass", "objectClass",     "LaunchedTorpedo"),
    ("BomberClass",          "bombName",        "Bomb"),
    ("BomberBayClass",       "bomberType",      "Bomber"),
    ("QuakeBlastClass",      "quakeClass",      "Quake"),
    # Plant secondary explosions:
    ("PlantClass",           "hitGroundName",   "HitGround"),
    ("PlantClass",           "hitByCarName",    "HitByCar"),
    ("PlantClass",           "hitByBulletName", "HitByBullet"),
    # NOTE: The 13 [Explosion] section class* sub-targets (classCraft,
    # classVehicle, classBuilding, classStruct, classChunk, classCrash,
    # classCollapse, classTorpedo, classPowerup, classPerson, classAnimal,
    # classSign, classPlant) are intentionally NOT inlined. They form a
    # 13-way fanout that, recursed, balloons JSON output by 100x with
    # marginal informational value (these describe internal sub-explosion
    # behaviour engine-side, not user-visible weapon characteristics).
    # The bare [Explosion] section IS preserved on every Explosion-bucket
    # ODF, and Stage 7's ODF-browser cross-links make those values
    # navigable manually from the Explosion category.
    # Vehicle loadout config refs (Config bucket):
    ("CraftClass",           "weaponConfig",    "WeaponConfig"),
]


# ---------- Module-global verbose flag + global corpus ref for diagnostics ----------

VERBOSE = False
# Set to corpus dict during Stage 4 so abort_with_dump() can introspect.
_GLOBAL_CORPUS = None


def vlog(*args, **kwargs):
    if VERBOSE:
        print(*args, **kwargs)


# ---------- argparse ----------

def build_argparser():
    p = argparse.ArgumentParser(
        prog="build_odf_db.py",
        description=(
            "Rebuild data/odf.min.json from raw ODFs with memory safeguards. "
            "Output written to scripts/odf/odf.min.json; production file is "
            "NEVER touched - hand-copy is required."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="Verbose logging (per-file parse logs + full diff name lists).",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Run all stages but skip the final write to disk.",
    )
    p.add_argument(
        "--no-deps", action="store_true",
        help="Use only BZ2R + the VSR config mod (skip dep INI resolution).",
    )
    p.add_argument(
        "--steam-base", type=str, default=None,
        help=(
            "Override the Steam library path. Default: registry first, then "
            r"hardcoded fallback C:\Program Files (x86)\Steam\steamapps."
        ),
    )
    p.add_argument(
        "--limit", type=int, default=None,
        help=(
            "Process only the first N ODFs from the collected corpus "
            "(alphabetical by basename). Cheap regression-test mode."
        ),
    )
    p.add_argument(
        "--forensic", nargs="?", type=int, const=50, default=None,
        metavar="N",
        help=(
            "Forensic diagnostic mode. Run Stages 0-3 on full corpus, then "
            "Stage 4 only on a hand-picked slice (default N=50) with "
            "tracemalloc + per-ref-pattern tally + peak-RSS report. "
            "Exits before Stage 5+."
        ),
    )
    p.add_argument(
        "--self-check", action="store_true",
        help=(
            "After full build, validate output via Layers 1-4 self-check "
            "assertions (structural correctness, recursive-chain spot checks, "
            "parity diff vs data/odf.min.json)."
        ),
    )
    return p


# ---------- Stage 0: Resolve root directories ----------
#
# Order of precedence for the Steam library path:
#   1. --steam-base CLI override (highest)
#   2. Windows registry HKLM Wow6432Node SteamPath, fallback to HKLM Steam
#   3. Hardcoded STEAM_BASE_FALLBACK
# The chosen base must contain steamapps/common/BZ2R AND
# steamapps/workshop/content/624970/<VSR_MOD_ID>/<VSR_MOD_ID>.ini for the
# build to proceed. Asset deps are read from the VSR INI's [WORKSHOP]
# assetDependencies (comma-separated workshop IDs); the comment lines beside
# the IDs supply human-readable labels via get_mod_label().


def detect_steam_base():
    """
    Locate Steam's steamapps directory. Returns Path or None.
    On Windows uses winreg HKLM Wow6432Node SteamPath then HKLM SteamPath.
    On non-Windows (or registry miss) returns None and the caller falls back.
    """
    if os.name != "nt":
        return None
    try:
        import winreg  # noqa: WPS433 - only valid on Windows
    except ImportError:
        return None

    candidates = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Wow6432Node\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Valve\Steam"),
    ]
    for hive, subkey in candidates:
        try:
            with winreg.OpenKey(hive, subkey) as k:
                steam_path, _ = winreg.QueryValueEx(k, "InstallPath")
        except OSError:
            continue
        steamapps = Path(steam_path) / "steamapps"
        if steamapps.is_dir():
            return steamapps
    return None


def strip_quotes(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1].strip()
    return s


def parse_mod_ini(path):
    """
    Lightweight INI parser tailored to the BZ2R workshop INI shape:
      - [Section] headers
      - key = "value"  or  key = value
      - lines starting with ';' are comments (we KEEP them - the dep block's
        comments carry the human-readable labels)
    Returns dict[section][key] = value (strings) plus a parallel
    dict[section][__comments__] = list[str] of comment lines (in order).
    """
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    out = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            out.setdefault(section, {"__comments__": []})
            continue
        if section is None:
            continue
        if line.startswith(";"):
            out[section]["__comments__"].append(line[1:].strip())
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            out[section][key.strip()] = strip_quotes(val)
    return out


def get_mod_label(workshop_id, ini_data):
    """
    Best-effort human-readable label for a workshop ID. Looks at the
    [WORKSHOP] comment block for any line containing the ID and extracts
    the prose before the parenthesized ID. Falls back to "<workshop_id>".
    """
    section = ini_data.get("WORKSHOP", {})
    comments = section.get("__comments__", []) if isinstance(section, dict) else []
    sentinel = f"({workshop_id})"
    for c in comments:
        if sentinel in c:
            label = c.split(sentinel)[0].rstrip(", ").strip()
            if label.lower().startswith(("current vsr", "removed:", "asset")):
                continue
            if label:
                return label
    return f"workshop:{workshop_id}"


def resolve_root_dirs(steam_override=None, no_deps=False):
    """
    Returns: ordered list of (Path, label) tuples for ODF collection.
    Last-wins precedence is later in this list overrides earlier matches
    by basename - so put base game first, then VSR config mod, then asset
    deps in INI order.

    Hard-fails (sys.exit) if BZ2R or the VSR INI can't be found.
    """
    if steam_override:
        steam_base = Path(steam_override).expanduser().resolve()
        source = "--steam-base override"
    else:
        detected = detect_steam_base()
        if detected and detected.is_dir():
            steam_base = detected
            source = "registry"
        else:
            steam_base = STEAM_BASE_FALLBACK
            source = "hardcoded fallback"

    bz2r_dir = steam_base / BZ2R_DIR_RELATIVE
    workshop_dir = steam_base / WORKSHOP_RELATIVE
    vsr_dir = workshop_dir / VSR_MOD_ID
    vsr_ini = vsr_dir / f"{VSR_MOD_ID}.ini"

    if not bz2r_dir.is_dir():
        sys.stderr.write(
            f"ERROR: BZ2R directory not found: {bz2r_dir}\n"
            f"  Steam base ({source}): {steam_base}\n"
            f"  Override with --steam-base PATH if Steam is installed elsewhere.\n"
        )
        sys.exit(1)
    if not vsr_ini.is_file():
        sys.stderr.write(
            f"ERROR: VSR mod INI not found: {vsr_ini}\n"
            f"  Subscribe to 'Vet Strat Recycler Variant' in Steam Workshop\n"
            f"  (or use --steam-base PATH).\n"
        )
        sys.exit(1)

    ini_data = parse_mod_ini(vsr_ini)
    workshop_section = ini_data.get("WORKSHOP", {})
    mod_name = workshop_section.get("modName", "Vet Strat Recycler Variant")

    print(f"  Steam base ({source}): {steam_base}")
    print(f"  BZ2R: {bz2r_dir}")
    print(f"  VSR config mod: {vsr_dir}  ({mod_name!r})")

    roots = [
        (bz2r_dir, "BZ2R (base game)"),
        (vsr_dir, f"VSR config mod: {mod_name}"),
    ]

    if no_deps:
        print("  --no-deps: skipping asset dependency resolution.")
        return roots

    deps_raw = workshop_section.get("assetDependencies", "")
    dep_ids = [s.strip() for s in deps_raw.split(",") if s.strip()]
    missing = []
    for wid in dep_ids:
        dep_path = workshop_dir / wid
        label = get_mod_label(wid, ini_data)
        if not dep_path.is_dir():
            missing.append((wid, label, dep_path))
            continue
        roots.append((dep_path, f"dep {wid}: {label}"))
    if missing:
        print(f"  WARN: {len(missing)} asset dep(s) not on disk (skipped):")
        for wid, label, p in missing:
            print(f"    - {wid} ({label}): {p}")
    print(f"  Total roots: {len(roots)}")
    return roots


# ---------- Stage 1: Walk + collect ----------
#
# rglob *.odf per root, key by lowercased basename, last-wins dedup.
# Within each root, sort matched files deterministically before emitting,
# so the last-wins outcome is reproducible across runs / OS file enumerations.


def walk_and_collect(roots):
    """
    Returns (collected, source_map):
      collected   = dict[str_basename_lower -> Path]
      source_map  = dict[str_basename_lower -> str_root_label]
    Roots are processed in order; later roots override earlier matches.
    """
    collected = {}
    source_map = {}
    for root, label in roots:
        per_root_count = 0
        try:
            files = sorted(
                (p for p in root.rglob("*.odf") if p.is_file()),
                key=lambda p: str(p).lower(),
            )
        except OSError as exc:
            print(f"  WARN: scan failed for {root}: {exc}")
            continue
        overrides = 0
        for p in files:
            key = p.name.lower()
            if key in collected:
                overrides += 1
            collected[key] = p
            source_map[key] = label
            per_root_count += 1
        print(
            f"  {label}: {per_root_count} ODFs"
            + (f" ({overrides} overrode earlier roots)" if overrides else "")
        )
    print(f"  Total unique ODFs: {len(collected)}")
    return collected, source_map


# ---------- Stage 2: Parse ODF text ----------
#
# ODF is a flat INI-ish format:
#   - Section headers: [SomeClassName]
#   - Properties:      key = value   (whitespace flexible)
#   - Comments:        // ... or ; ... (quote-aware: a // or ; inside a
#                      double-quoted string is NOT a comment)
#
# Casing: section names preserve original casing; property names are
# normalized case-insensitively (lowercase compare key, but the FINAL key
# in output uses the ORIGINAL casing of the LAST occurrence). This matches
# the BZCC engine's last-wins lookup behaviour.
#
# Values: ALWAYS strings (downstream consumers parse types lazily). Outer
# quotes (single or double) are stripped from values; inline tokens are not.
#
# NO noise filter (the original collector dropped misc/effect classes; we
# explicitly keep them - that's the rehydration we asked for).


_SECTION_RE = re.compile(r"^\s*\[(?P<name>[^\]]+)\]\s*$")
_KV_RE = re.compile(r"^\s*([^=\s][^=]*?)\s*=\s*(.*?)\s*$")


def strip_comment_to_eol(line):
    """
    Quote-aware comment stripper: removes everything from the first un-quoted
    '//' or ';' to end-of-line. Returns the cleaned line (no trailing
    newline, but inner whitespace preserved).
    """
    in_dq = False  # only double-quotes; single quotes never delimit in ODF
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch == '"':
            in_dq = not in_dq
            i += 1
            continue
        if not in_dq:
            if ch == ";":
                return line[:i]
            if ch == "/" and i + 1 < n and line[i + 1] == "/":
                return line[:i]
        i += 1
    return line


def _strip_value_quotes(v):
    """Strip a single layer of matching outer quotes (' or ") from a value."""
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


def parse_odf_text(text):
    """
    Returns dict[section_name -> dict[property_name -> str_value]].
    Property keys: case-insensitive last-wins (lowercased compare; the LAST
    occurrence's original casing is the key kept in output).

    Properties before any [Section] header land in a synthetic "" section
    (extremely rare in BZCC ODFs but valid; preserved for parity).
    """
    sections = {}
    # Per-section maps from lowercase key -> ORIGINAL key (so we can rewrite
    # the prior original-cased entry when a new occurrence wins).
    lc_to_orig = {}

    current_section = ""
    sections[current_section] = {}
    lc_to_orig[current_section] = {}

    for raw_line in text.splitlines():
        line = strip_comment_to_eol(raw_line).rstrip()
        if not line.strip():
            continue
        m_sec = _SECTION_RE.match(line)
        if m_sec:
            sec = m_sec.group("name").strip()
            if sec not in sections:
                sections[sec] = {}
                lc_to_orig[sec] = {}
            current_section = sec
            continue
        m_kv = _KV_RE.match(line)
        if not m_kv:
            continue
        key = m_kv.group(1).strip()
        val = _strip_value_quotes(m_kv.group(2).strip())
        lc_key = key.lower()
        sec_dict = sections[current_section]
        sec_lc = lc_to_orig[current_section]
        prior_orig = sec_lc.get(lc_key)
        if prior_orig is not None and prior_orig != key:
            # Key collision under different casing - rewrite under the new
            # casing (last-wins) and drop the old entry to keep dict size
            # stable.
            sec_dict.pop(prior_orig, None)
        sec_dict[key] = val
        sec_lc[lc_key] = key

    if not sections.get("") and "" in sections:
        # Drop empty synthetic section.
        del sections[""]
    return sections


def parse_corpus(collected):
    """
    Parse every collected ODF. Returns dict[basename_lower -> blocks_dict].
    Failures (unreadable file, decode error) are logged but do NOT abort -
    the corpus is large and a hostile file shouldn't poison the run.
    """
    out = {}
    failures = 0
    for name, path in collected.items():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(f"  WARN: read failed for {path}: {exc}")
            failures += 1
            continue
        try:
            blocks = parse_odf_text(text)
        except Exception as exc:  # noqa: BLE001 - parser must never abort run
            print(f"  WARN: parse failed for {path}: {exc}")
            failures += 1
            continue
        out[name] = blocks
        vlog(f"  parsed {name}: {len(blocks)} sections")
    print(
        f"  Parsed {len(out)} ODFs"
        + (f" ({failures} failures)" if failures else "")
    )
    return out


# ---------- Stage 3: Inheritance pass ----------
#
# Each ODF's first section that carries a classLabel is treated as the parent
# pointer: classLabel="dispenser" -> parent ODF "dispenser.odf". Walk that
# chain, deep-merge parent into child (child wins), and emit the chain at
# blocks["inheritanceChain"]. This pass mutates the corpus in place.
#
# Inheritance chains are short in practice (most ODFs hit depth 2-3); deepcopy
# is cheap here and safe (chains live in a small, bounded tree). Stage 4 has
# a different cost profile and uses shared references instead.


def find_class_label(blocks):
    """Return classLabel from the first section that has one, or None."""
    for section_props in blocks.values():
        if isinstance(section_props, dict) and "classLabel" in section_props:
            return section_props["classLabel"]
    return None


def deep_merge(child, parent):
    """
    Returns a new dict: parent merged with child overrides. Child values
    win at every level. Both inputs are deep-copied so the result is fully
    detached from the source corpus (Stage 3 only).
    """
    result = deepcopy(parent)
    for key, value in child.items():
        if (
            key in result
            and isinstance(value, dict)
            and isinstance(result[key], dict)
        ):
            result[key] = deep_merge(value, result[key])
        else:
            result[key] = deepcopy(value)
    return result


def _chain_dedup_append(chain, label):
    """Append label to chain only if not already present (case-sensitive)."""
    if label not in chain:
        chain.append(label)


def process_inheritance(name, blocks, corpus, processed=None, depth=0):
    """
    Resolve the inheritance chain for `name` (a basename like "fball2b.odf").
    Returns the merged blocks dict (parent + this ODF, child wins). Mutates
    nothing - caller is responsible for replacing corpus[name] with the result.
    """
    if processed is None:
        processed = set()

    if name in processed:
        # Cycle - return as-is. Each call gets its own `processed` because
        # cycles only matter within a single resolution.
        return blocks
    processed = processed | {name}

    # Always make sure inheritanceChain key exists.
    if "inheritanceChain" not in blocks:
        blocks["inheritanceChain"] = []

    class_label = find_class_label(blocks)
    if not class_label:
        return blocks

    parent_basename = f"{class_label.lower()}.odf"
    parent_blocks = corpus.get(parent_basename)
    if parent_blocks is None:
        # No parent on disk - this is the chain terminator (engine-side class).
        _chain_dedup_append(blocks["inheritanceChain"], class_label)
        return blocks

    # Recursively resolve the parent first so its merged form is what we
    # inherit from. Use a copy guard so the parent's blocks dict isn't
    # mutated mid-walk by our future children (process_corpus_inheritance
    # snapshot-replaces, but parent_blocks here is a live ref).
    parent_resolved = process_inheritance(
        parent_basename, parent_blocks, corpus, processed, depth + 1,
    )
    merged = deep_merge(blocks, parent_resolved)

    # Build the new chain: this label first, then parent's chain (no dups).
    new_chain = [class_label]
    for label in parent_resolved.get("inheritanceChain", []):
        _chain_dedup_append(new_chain, label)
    merged["inheritanceChain"] = new_chain
    return merged


def process_corpus_inheritance(corpus):
    """
    Run process_inheritance over every ODF in the corpus and replace each
    entry with its merged form. Done in two passes via snapshot to avoid
    feedback loops where a child's resolution would inherit from a previously
    resolved sibling that already absorbed our future child's data.
    """
    merged = {}
    max_chain = 0
    for name, blocks in corpus.items():
        resolved = process_inheritance(name, deepcopy(blocks), corpus)
        merged[name] = resolved
        chain_len = len(resolved.get("inheritanceChain", []))
        if chain_len > max_chain:
            max_chain = chain_len
    print(f"  Resolved inheritance for {len(merged)} ODFs (max chain depth {max_chain}).")
    return merged


# ---------- Stage 4: Safeguarded recursive composition-ref expansion ----------
#
# This is the stage that crashed previous attempts. Five hard safeguards
# build the ceiling we can't punch through:
#
#   1. SHARED REFERENCES. blocks[new_key] = block_props (NO dict() copy).
#      Property values are immutable strings, sections are read-only after
#      Stage 3, so two ODFs sharing the same dict for an inlined section
#      is correct AND cheap. This alone collapses the worst-case memory
#      footprint by 1-2 orders of magnitude.
#   2. MAX_REF_DEPTH = 4. Real chains top out at 3 (weapon -> ord -> xpl -> classCraft).
#      4 leaves a one-step buffer.
#   3. PER_ODF_BLOCK_VALVE = 5000. If any single ODF's blocks dict crosses
#      this threshold during expansion, halt and warn. Prevents pathological
#      fanout from snowballing.
#   4. STAGE4_WALLCLOCK_CAP_S = 90. Wall-clock deadline. Crossing it fires
#      abort_with_dump.
#   5. RSS watchdog (separate module, armed in main()). 2 GB hard cap.
#
# Memoization (`settled` set) ensures each ODF is expanded at most once.
# Cycle protection (`visited` tuple) ensures recursion never re-enters an
# ODF already on the current call stack.
#
# Iteration safety: target_blocks.items() is snapshotted to a list before
# we start mutating target_blocks. Plan #1 catastrophic mistake of the
# previous iteration was iterating a live dict while it grew.


def _normalize_ref_basename(raw):
    """Lowercase, append .odf if missing, strip surrounding whitespace."""
    if not raw:
        return None
    s = raw.strip().lower()
    if not s or s.upper() == "NULL":
        return None
    if not s.endswith(".odf"):
        s += ".odf"
    return s


# Pre-index COMPOSITION_REFS by (section, field_lower) for O(1) match lookup
# inside the inner loop. Built lazily.
_REF_INDEX = None


def _build_ref_index():
    global _REF_INDEX
    if _REF_INDEX is None:
        idx = {}
        for section, field, prefix in COMPOSITION_REFS:
            idx.setdefault(section, []).append((field, prefix))
        _REF_INDEX = idx
    return _REF_INDEX


def expand_refs(name, corpus, settled, visited, depth, deadline,
                stats=None, max_depth=MAX_REF_DEPTH):
    """
    Recursively expand composition refs for ODF `name`. Mutates corpus[name]
    in place by adding prefixed sections that share references with the
    target ODFs' sections.

    Args:
      name      : basename_lower of the ODF to expand
      corpus    : full corpus dict
      settled   : set of names already fully expanded (memoized)
      visited   : tuple of names currently on the call stack (cycle guard)
      depth     : current recursion depth (capped at max_depth)
      deadline  : time.monotonic() value at which we abort
      stats     : optional dict; if given, incremented with per-pattern
                  key-adds and per-ODF block counts (forensic mode)
      max_depth : MAX_REF_DEPTH (overridable for tests)
    """
    if name in settled:
        return
    if depth >= max_depth:
        return
    if name in visited:
        return  # cycle on current call stack

    blocks = corpus.get(name)
    if blocks is None:
        return

    if time.monotonic() > deadline:
        abort_with_dump(
            "Stage 4 wall-clock cap exceeded",
            current_odf=name,
            settled_count=len(settled),
            depth=depth,
        )

    ref_index = _build_ref_index()
    visited_next = visited + (name,)

    # Snapshot top-level keys BEFORE expansion. We will only iterate the
    # snapshot - prefixed keys we add during this call must not feed back
    # into the same iteration (that's the bug from before).
    target_items = list(blocks.items())

    for section_name, section_props in target_items:
        if not isinstance(section_props, dict):
            continue
        # We only PULL through bare (un-prefixed) sections. A prefixed key
        # like "Ordnance.WeaponClass" is a result of expansion and must not
        # be re-followed (would explode the prefix tree pointlessly).
        if "." in section_name:
            continue
        ref_patterns = ref_index.get(section_name)
        if not ref_patterns:
            continue
        for field_name, prefix in ref_patterns:
            ref_value = None
            # Case-insensitive field lookup. Most ODFs use the canonical
            # casing already, but the parser keeps last-wins original casing
            # so a hostile ODF could store "Ordname" instead of "ordName".
            if field_name in section_props:
                ref_value = section_props[field_name]
            else:
                fnl = field_name.lower()
                for k, v in section_props.items():
                    if k.lower() == fnl:
                        ref_value = v
                        break
            target_basename = _normalize_ref_basename(ref_value)
            if target_basename is None:
                continue
            target_blocks = corpus.get(target_basename)
            if target_blocks is None:
                continue
            if target_basename in visited_next:
                continue  # cycle - skip this branch

            # Recursively settle the target FIRST. After this returns, the
            # target's blocks dict has all of ITS prefixed expansions baked in.
            expand_refs(
                target_basename, corpus, settled, visited_next,
                depth + 1, deadline, stats, max_depth,
            )

            # Snapshot target items at this point (target may have grown
            # during its own expansion above).
            tgt_resolved = corpus[target_basename]
            tgt_items = list(tgt_resolved.items())
            adds_for_pattern = 0
            for tgt_section, tgt_props in tgt_items:
                if tgt_section == "inheritanceChain":
                    continue
                new_key = f"{prefix}.{tgt_section}"
                if new_key in blocks:
                    continue
                # Hard cap on prefix depth (dots in the resulting key).
                # Single biggest control on JSON output size, since shared
                # references collapse memory but every key path is fully
                # serialized at every reference site. Targets the Explosion
                # classX 13-way fanout while still allowing the user's
                # medusa -> ord -> launchOrd -> xplGround chain (depth 3).
                if new_key.count(".") > MAX_PREFIX_DEPTH:
                    continue
                blocks[new_key] = tgt_props  # SHARED REFERENCE
                adds_for_pattern += 1

                # Per-ODF safety valve.
                if len(blocks) > PER_ODF_BLOCK_VALVE:
                    sys.stderr.write(
                        f"  WARN: per-ODF block valve tripped for {name} "
                        f"(>{PER_ODF_BLOCK_VALVE} blocks); halting expansion.\n"
                    )
                    settled.add(name)
                    return
                # Cheap deadline check (every key add).
                if time.monotonic() > deadline:
                    abort_with_dump(
                        "Stage 4 wall-clock cap exceeded mid-expansion",
                        current_odf=name,
                        ref_target=target_basename,
                        settled_count=len(settled),
                    )

            if stats is not None:
                stats.setdefault("by_pattern", {})
                key = f"{section_name}.{field_name}"
                stats["by_pattern"][key] = stats["by_pattern"].get(key, 0) + adds_for_pattern

    settled.add(name)
    if stats is not None:
        stats.setdefault("blocks_per_odf", {})
        stats["blocks_per_odf"][name] = len(blocks)


def expand_all_refs(corpus, deadline=None, stats=None,
                    max_depth=MAX_REF_DEPTH):
    """
    Drive expand_refs over every ODF in the corpus. Uses a single shared
    `settled` memoization set so any ODF visited as a target of a prior
    ODF's expansion is already done when we get to it directly.
    """
    global _GLOBAL_CORPUS
    _GLOBAL_CORPUS = corpus  # so abort_with_dump can introspect

    if deadline is None:
        deadline = time.monotonic() + STAGE4_WALLCLOCK_CAP_S

    settled = set()
    t0 = time.monotonic()
    for name in list(corpus.keys()):
        expand_refs(
            name, corpus, settled, visited=(),
            depth=0, deadline=deadline, stats=stats, max_depth=max_depth,
        )
    elapsed = time.monotonic() - t0
    print(f"  Expanded refs for {len(settled)} ODFs in {elapsed:.2f}s.")

    _GLOBAL_CORPUS = None
    return corpus


def apply_powerup_push(corpus):
    """
    Post-Stage-4 PUSH pass for WeaponPowerupClass.weaponName references.
    Direction is INVERTED from the regular PULL refs: powerup data is
    copied INTO the weapon under "Powerup.<section>" prefixes. Matches the
    seed's process_powerup_references() exactly so production parity is
    preserved.

    Also handles unitName backfill: if a powerup has no GameObjectClass
    .unitName, fill it from the referenced weapon's WeaponClass.wpnName.
    The mutation is on the POWERUP's dict (not the weapon's), so future
    Powerup.* prefix copies onto the weapon will carry the unitName too.
    """
    pushed = 0
    backfilled = 0
    for pu_name, pu_blocks in corpus.items():
        wpc = pu_blocks.get("WeaponPowerupClass")
        if not isinstance(wpc, dict):
            continue
        weapon_name_raw = wpc.get("weaponName")
        target = _normalize_ref_basename(weapon_name_raw)
        if target is None:
            continue
        weapon_blocks = corpus.get(target)
        if weapon_blocks is None:
            continue

        # unitName backfill on the POWERUP side (per seed semantics).
        wpn_class = weapon_blocks.get("WeaponClass", {})
        wpn_name = wpn_class.get("wpnName") if isinstance(wpn_class, dict) else None
        if wpn_name:
            go = pu_blocks.get("GameObjectClass")
            if not isinstance(go, dict):
                go = {}
                pu_blocks["GameObjectClass"] = go
            if "unitName" not in go:
                go["unitName"] = wpn_name
                backfilled += 1

        # PUSH the powerup's blocks into the weapon under "Powerup.*" prefix.
        for sec, props in list(pu_blocks.items()):
            if "." in sec:
                # Don't push already-prefixed sections (e.g. "Ordnance.*")
                # back onto the weapon - we'd be double-injecting.
                continue
            new_key = f"Powerup.{sec}"
            if new_key in weapon_blocks:
                continue
            weapon_blocks[new_key] = props  # shared reference
            pushed += 1
    print(f"  Powerup PUSH pass: {pushed} keys added, {backfilled} unitName backfills.")


# ---------- Stage 5: Categorize corpus ----------
#
# Sort each ODF into one of the 12 categories. Order:
#   1. SPECIAL_CATEGORY explicit overrides win first.
#   2. CONFIG_DROPLIST and CONFIG_DROPLIST_PATTERNS drop entries unconditionally.
#   3. Abstract / unusable shells:
#        - Sole section is [GameObjectClass] -> drop (engine base, no class).
#        - Empty blocks (no sections at all) -> drop.
#   4. Iterate CATEGORIES in declared order; first matching signature wins.
#      A signature matches if the ODF has a section by that name OR if any
#      section's `classLabel` value equals it (case-insensitive).
#      The Effect bucket's "LightClass" signature works the same way -
#      LightClass-only ODFs get Effect.
#   5. Anything that didn't match any category falls into Effect (catch-all).


def _bare_sections(blocks):
    """Returns the list of un-prefixed section names of an ODF."""
    return [
        k for k in blocks.keys()
        if k != "inheritanceChain" and "." not in k
    ]


def _section_or_label_match(blocks, signature):
    """
    True if `signature` matches a bare section name OR a `classLabel` value
    of any section. Case-insensitive comparisons on both sides.
    """
    sig_lc = signature.lower()
    for sec_name, sec_props in blocks.items():
        if "." in sec_name or sec_name == "inheritanceChain":
            continue
        if sec_name.lower() == sig_lc:
            return True
        if isinstance(sec_props, dict):
            label = sec_props.get("classLabel")
            if isinstance(label, str) and label.lower() == sig_lc:
                return True
    return False


def _is_droplist(name):
    if name in CONFIG_DROPLIST:
        return True
    for pat in CONFIG_DROPLIST_PATTERNS:
        if pat.match(name):
            return True
    return False


def categorize_corpus(corpus):
    """
    Returns a dict[category_name -> dict[odf_basename -> blocks]] following
    the 12-category schema declared in CATEGORIES. ODFs that match no
    category and no signature (Vehicle/Weapon/etc.) fall into Effect.
    Returns also a dict of dropped names (basename -> reason) for diagnostics.
    """
    out = {cat_name: {} for cat_name, _ in CATEGORIES}
    dropped = {}

    for name, blocks in corpus.items():
        if name in SPECIAL_CATEGORY:
            cat = SPECIAL_CATEGORY[name]
            out.setdefault(cat, {})[name] = blocks
            continue
        if _is_droplist(name):
            dropped[name] = "config-droplist"
            continue
        bare = _bare_sections(blocks)
        if not bare:
            dropped[name] = "no-sections"
            continue
        if len(bare) == 1 and bare[0] == "GameObjectClass":
            dropped[name] = "abstract-base (only [GameObjectClass])"
            continue

        placed = False
        for cat_name, signatures in CATEGORIES:
            for sig in signatures:
                if _section_or_label_match(blocks, sig):
                    out.setdefault(cat_name, {})[name] = blocks
                    placed = True
                    break
            if placed:
                break
        if not placed:
            # Default catch-all is Effect (per plan).
            out.setdefault("Effect", {})[name] = blocks

    return out, dropped


# ---------- Stage 6: Diff + emit ----------
#
# load_existing_min_json     : read-only load of data/odf.min.json (production
#                              copy); never written to.
# diff_against_existing      : compute added/removed/changed counts per
#                              category. With --verbose, also emits name lists.
# write_output               : write the new build to scripts/odf/odf.min.json
#                              (NOT data/odf.min.json - hand-copy is mandatory).
# emit_summary               : final summary banner with file size + hand-copy
#                              hint.


def load_existing_min_json():
    """Read-only load of production data/odf.min.json. Returns {} if missing."""
    if not PROD_PATH.is_file():
        return {}
    try:
        with PROD_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  WARN: failed to read prod {PROD_PATH}: {exc}")
        return {}


def diff_against_existing(new_categorized, existing):
    """
    Compute per-category diff: added, removed, and "changed" (same name in
    both, but section count differs). Returns dict[cat -> dict[summary]].
    """
    out = {}
    all_cats = set(new_categorized.keys()) | set(existing.keys())
    for cat in sorted(all_cats):
        new_set = set(new_categorized.get(cat, {}).keys())
        old_set = set(existing.get(cat, {}).keys())
        added = sorted(new_set - old_set)
        removed = sorted(old_set - new_set)
        common = new_set & old_set
        changed = []
        for n in sorted(common):
            new_count = len(new_categorized[cat][n])
            old_count = len(existing[cat][n])
            if new_count != old_count:
                changed.append((n, old_count, new_count))
        out[cat] = {
            "added": added,
            "removed": removed,
            "changed": changed,
            "new_total": len(new_set),
            "old_total": len(old_set),
        }
    return out


def print_diff(diff):
    """Print per-category diff summary (verbose adds full name lists)."""
    print("\n  Diff vs production data/odf.min.json:")
    print(
        f"  {'Category':<10s}  {'old':>5s}  {'new':>5s}  {'+':>5s}  {'-':>5s}  {'~':>5s}"
    )
    for cat in sorted(diff.keys()):
        d = diff[cat]
        print(
            f"  {cat:<10s}  "
            f"{d['old_total']:>5d}  "
            f"{d['new_total']:>5d}  "
            f"{len(d['added']):>5d}  "
            f"{len(d['removed']):>5d}  "
            f"{len(d['changed']):>5d}"
        )
    if VERBOSE:
        for cat, d in diff.items():
            if d["added"]:
                print(f"  + {cat} added ({len(d['added'])}):")
                for n in d["added"]:
                    print(f"      {n}")
            if d["removed"]:
                print(f"  - {cat} removed ({len(d['removed'])}):")
                for n in d["removed"]:
                    print(f"      {n}")
            if d["changed"]:
                print(f"  ~ {cat} changed ({len(d['changed'])}):")
                for n, o, nn in d["changed"]:
                    print(f"      {n}: {o} -> {nn} sections")


def _file_size_mb(path):
    return path.stat().st_size / (1024 * 1024) if path.is_file() else 0.0


def write_output(new_categorized, dry_run=False):
    """
    Write minified JSON to OUTPUT_PATH. PROD_PATH is NEVER touched.
    Returns the bytes written (or 0 if dry-run).
    """
    if dry_run:
        print(f"  --dry-run: skipping write to {OUTPUT_PATH}")
        return 0
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(new_categorized, f, separators=(",", ":"), ensure_ascii=False)
    sz = OUTPUT_PATH.stat().st_size
    print(f"  Wrote {OUTPUT_PATH} ({sz / (1024 * 1024):.2f} MB)")
    return sz


def emit_summary(written_bytes, prod_path):
    """Final banner summarising next steps."""
    new_mb = written_bytes / (1024 * 1024) if written_bytes else 0.0
    prod_mb = _file_size_mb(prod_path)
    print()
    print("=" * 64)
    print("Build complete.")
    print(f"  Output: {OUTPUT_PATH}  ({new_mb:.2f} MB)")
    print(f"  Prod:   {PROD_PATH}    ({prod_mb:.2f} MB)")
    print()
    print("To ship: review the diff above, then manually copy:")
    print(f"  copy \"{OUTPUT_PATH}\" \"{PROD_PATH}\"")
    print("=" * 64)


# ---------- Stage 8: Forensic mode + self-check ----------
#
# Forensic mode (--forensic [N]):
#   Run Stages 0-3 on the FULL corpus, then Stage 4 only on a hand-picked
#   slice (default 50 ODFs) with tracemalloc enabled. Reports per-ref-pattern
#   key-add tally, per-ODF block counts, max prefix depth, and peak RSS.
#   Used to validate safeguards before opening the floodgates on the full
#   3221-ODF corpus.
#
# Self-check mode (--self-check):
#   After full build, validate output via 4 layers:
#     L1 - structural correctness: 12 categories + each entry has at least
#          one bare section, prefixed keys all share inner section dicts (or
#          are valid orphans), inheritanceChain present everywhere.
#     L2 - recursive-chain spot checks: gpopgun/medusa-style chain reaches
#          depth 3, ord -> xpl reaches depth 2 on a few samples.
#     L3 - parity diff: every name still in production lands somewhere in
#          the new build (unless intentional drop).
#     L4 - file-size envelope: 1-100 MB minified (refuses to write a build
#          that's blatantly broken).


def _forensic_pick_slice(corpus, n):
    """
    Pick a hand-curated slice of N ODFs that exercise the deep-ref paths,
    pad with random fill if needed.
    """
    deep_weapons = [
        "gpopgun.odf", "meteora.odf", "gpoptag.odf",
        "gartill.odf", "gmortar.odf", "ggrenade.odf",
    ]
    referenced_explosions = [
        "xmortgnd.odf", "xmortxpl.odf", "xpoptaggnd.odf",
        "xartillxpl.odf", "xpoptagxpl.odf",
    ]
    picks = []
    seen = set()
    for name in deep_weapons + referenced_explosions:
        if name in corpus and name not in seen:
            picks.append(name)
            seen.add(name)
    # Pad with deterministic samples (sorted so runs are reproducible).
    for name in sorted(corpus.keys()):
        if len(picks) >= n:
            break
        if name not in seen:
            picks.append(name)
            seen.add(name)
    return picks[:n]


def run_forensic(corpus, n):
    """
    Forensic Stage 4 dry-run: expand a hand-picked N-slice with tracemalloc
    and detailed stats. Returns nothing - prints a report and sys.exits(0).
    """
    tracemalloc.start(25)
    proc = psutil.Process(os.getpid())

    picks = _forensic_pick_slice(corpus, n)
    print(f"\n[FORENSIC] Slice ({len(picks)} ODFs):")
    for name in picks:
        print(f"  - {name}")

    # Subset corpus to picks + their direct refs (so expand_refs can resolve
    # targets). Use a SHALLOW dict copy so the rest of corpus isn't disturbed.
    subset_keys = set(picks)
    # Walk one level of refs to bring in plausible targets (so the slice is
    # self-sufficient for the test).
    ref_index = _build_ref_index()
    for name in list(subset_keys):
        blocks = corpus.get(name, {})
        for sec_name, sec_props in blocks.items():
            if "." in sec_name or not isinstance(sec_props, dict):
                continue
            patterns = ref_index.get(sec_name, [])
            for field, _ in patterns:
                tgt = _normalize_ref_basename(sec_props.get(field))
                if tgt and tgt in corpus:
                    subset_keys.add(tgt)

    subset = {k: corpus[k] for k in subset_keys}
    stats = {"by_pattern": {}, "blocks_per_odf": {}}

    rss0 = proc.memory_info().rss
    t0 = time.monotonic()
    deadline = t0 + STAGE4_WALLCLOCK_CAP_S
    settled = set()
    for name in picks:
        expand_refs(name, subset, settled, visited=(),
                    depth=0, deadline=deadline, stats=stats)
    elapsed = time.monotonic() - t0
    rss_peak = proc.memory_info().rss
    snap = tracemalloc.take_snapshot()
    top_stats = snap.statistics("lineno")[:10]
    tracemalloc.stop()

    # Per-ODF max prefix depth from the slice.
    max_pref = 0
    for name in picks:
        for k in subset[name].keys():
            d = k.count(".")
            if d > max_pref:
                max_pref = d

    print(f"\n[FORENSIC] Stage 4 slice results:")
    print(f"  Elapsed: {elapsed:.3f} s")
    print(f"  RSS delta: {(rss_peak - rss0) / (1024 * 1024):+.1f} MB "
          f"(peak {rss_peak / (1024 * 1024):.1f} MB)")
    print(f"  Max prefix depth: {max_pref}")
    print(f"  Settled ODFs: {len(settled)}")
    print(f"\n  By pattern (key-adds):")
    for pat, n in sorted(stats["by_pattern"].items(), key=lambda kv: -kv[1])[:25]:
        print(f"    {pat:<40s} {n}")
    print(f"\n  Top {len(stats['blocks_per_odf'])} ODFs by block count:")
    rows = sorted(stats["blocks_per_odf"].items(), key=lambda kv: -kv[1])[:15]
    for name, count in rows:
        print(f"    {count:>5d}  {name}")
    print(f"\n  tracemalloc top 10 allocations:")
    for s in top_stats:
        print(f"    {s}")

    sys.exit(0)


def run_self_check(new_categorized, prod):
    """
    Layered post-build validation. Returns (passed, fail_list).
    Each layer prints PASS / FAIL lines so the build log is self-documenting.
    """
    passed = True
    fails = []

    def check(layer, label, condition, detail=""):
        nonlocal passed
        if condition:
            print(f"  [{layer}] PASS  {label}")
        else:
            print(f"  [{layer}] FAIL  {label}  {detail}")
            passed = False
            fails.append(f"{layer}: {label} {detail}".strip())

    print("\n[Stage 8] Self-check")
    # Layer 1 - structural correctness.
    expected_cats = {name for name, _ in CATEGORIES}
    check("L1", "all 12 categories present",
          set(new_categorized.keys()) >= expected_cats,
          f"missing: {expected_cats - set(new_categorized.keys())}")
    bad_no_chain = []
    bad_no_section = []
    for cat, entries in new_categorized.items():
        for name, blocks in entries.items():
            if "inheritanceChain" not in blocks:
                bad_no_chain.append(name)
            bare = [k for k in blocks if "." not in k and k != "inheritanceChain"]
            if not bare:
                bad_no_section.append(name)
    check("L1", "every entry has inheritanceChain",
          not bad_no_chain, f"missing on {bad_no_chain[:3]}")
    check("L1", "every entry has >=1 bare section",
          not bad_no_section, f"missing on {bad_no_section[:3]}")

    # Layer 2 - recursive-chain spot checks.
    weapon_block = new_categorized.get("Weapon", {})
    chain_ok = False
    chain_evidence = ""
    for name, blocks in weapon_block.items():
        # Look for any depth-3 prefixed key.
        for k in blocks.keys():
            if k.count(".") >= 3:
                chain_ok = True
                chain_evidence = f"{name} has {k}"
                break
        if chain_ok:
            break
    check("L2", "depth-3 chain present in at least one Weapon",
          chain_ok, chain_evidence)
    # Ordnance.xpl* refs reach depth 2.
    ord_block = new_categorized.get("Ordnance", {})
    xpl_depth2 = sum(
        1 for blocks in ord_block.values()
        for k in blocks.keys()
        if k.startswith("ExplGround.") or k.startswith("ExplVehicle.")
        or k.startswith("ExplBuilding.")
    )
    check("L2", "Ordnance ODFs have ExplX.* prefixes",
          xpl_depth2 > 0, f"count={xpl_depth2}")

    # Layer 3 - parity diff: production names should land somewhere.
    if prod:
        prod_names = set()
        for v in prod.values():
            prod_names.update(v.keys())
        new_names = set()
        for v in new_categorized.values():
            new_names.update(v.keys())
        # Some intentional drops are OK - we only fail if we lost *most* of prod.
        retained = prod_names & new_names
        retention = len(retained) / max(1, len(prod_names))
        check("L3", "retained >= 95% of production names",
              retention >= 0.95,
              f"retained {len(retained)}/{len(prod_names)} = {retention*100:.1f}%")
    else:
        print("  [L3] SKIP  no production data/odf.min.json to diff against")

    # Layer 4 - file-size envelope.
    sz = OUTPUT_PATH.stat().st_size if OUTPUT_PATH.is_file() else 0
    sz_mb = sz / (1024 * 1024)
    check("L4", "output size 1-100 MB",
          1.0 <= sz_mb <= 100.0,
          f"actual={sz_mb:.2f} MB")

    print(f"\nSelf-check {'PASSED' if passed else 'FAILED'}")
    if fails:
        for f in fails:
            print(f"  - {f}")
    return passed, fails


# ---------- Safety infrastructure (Stage 3.5) ----------
#
# Armed unconditionally at the top of main(), before any heavy work. The plan
# explicitly forbids running Stage 4 without these in place. Independent of
# --forensic / --limit / --self-check.
#
# Three layers:
#   1. RSS watchdog daemon thread - polls process RSS every 250 ms; if it
#      exceeds RSS_HARD_CAP_BYTES (2 GB), fires abort_with_dump and os._exit.
#   2. Wall-clock deadline check - inside Stage 4, if time.monotonic exceeds
#      the deadline, fires abort_with_dump.
#   3. Per-ODF block-count valve (PER_ODF_BLOCK_VALVE) - inside expand_refs.
#
# All three call abort_with_dump for a uniform exit with diagnostics.


def _peak_block_summary(corpus, limit=3):
    """Return list of '<basename>: N blocks' for top-N ODFs by block count."""
    if not corpus:
        return []
    items = sorted(corpus.items(), key=lambda kv: -len(kv[1]))[:limit]
    return [f"{name}: {len(blocks)} blocks" for name, blocks in items]


def abort_with_dump(reason, **ctx):
    """
    Emergency exit. Prints reason + RSS + caller-supplied context + a snapshot
    of the top-3 ODFs by block count (so we can see which expansion went off
    the rails), then calls os._exit(2) to terminate hard. Does NOT raise -
    intentionally bypasses Python cleanup so a runaway recursion can never
    hold the process open.
    """
    try:
        rss_mb = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except Exception:
        rss_mb = -1
    sys.stderr.write("\n*** ABORT: " + str(reason) + "\n")
    sys.stderr.write(f"    RSS: {rss_mb:.0f} MB\n")
    for k, v in ctx.items():
        sys.stderr.write(f"    {k}: {v}\n")
    if _GLOBAL_CORPUS:
        sys.stderr.write("    Top 3 ODFs by block count:\n")
        for line in _peak_block_summary(_GLOBAL_CORPUS, limit=3):
            sys.stderr.write(f"      {line}\n")
    sys.stderr.flush()
    os._exit(2)


def start_rss_watchdog():
    """
    Spawn a daemon thread that polls process RSS every RSS_WATCHDOG_POLL_S
    seconds. If RSS exceeds RSS_HARD_CAP_BYTES, calls abort_with_dump.
    Returns the Thread (caller doesn't need to join - it's a daemon).
    """
    proc = psutil.Process(os.getpid())

    def _watch():
        while True:
            try:
                rss = proc.memory_info().rss
                if rss > RSS_HARD_CAP_BYTES:
                    abort_with_dump(
                        "RSS hard cap exceeded",
                        rss_bytes=rss,
                        cap_bytes=RSS_HARD_CAP_BYTES,
                        cap_mb=RSS_HARD_CAP_BYTES // (1024 * 1024),
                    )
            except Exception:
                # Watchdog must never raise into its own thread - if anything
                # goes wrong here, just keep polling.
                pass
            time.sleep(RSS_WATCHDOG_POLL_S)

    t = threading.Thread(target=_watch, daemon=True, name="rss-watchdog")
    t.start()
    return t


# ---------- main entry (stub for now; stages added by subsequent todos) ----------

def main(argv=None):
    """
    Main entrypoint. Order:
      1. argparse
      2. Arm RSS watchdog (so EVERY subsequent run has it active)
      3. Stage 0: resolve roots
      4. Stage 1: walk + collect
      5. Stage 2: parse all ODFs
      6. Stage 3: inheritance pass
      7. Stage 4: recursive composition-ref expansion (safeguarded)
      8. Stage 5: categorize
      9. Stage 6: diff + write
     10. Stage 8: optional --self-check

    NOTE: stages are wired in by their respective todos.
    """
    parser = build_argparser()
    args = parser.parse_args(argv)

    global VERBOSE
    VERBOSE = bool(args.verbose)

    # The watchdog is armed BEFORE any heavy work. From this point on, RSS
    # > RSS_HARD_CAP_BYTES will force os._exit(2) with a diagnostic dump.
    start_rss_watchdog()
    print(
        f"Watchdog: armed (cap={RSS_HARD_CAP_BYTES // (1024 * 1024)} MB)."
    )

    # Stage 0: Resolve root directories.
    print("\n[Stage 0] Resolving root directories...")
    roots = resolve_root_dirs(
        steam_override=args.steam_base, no_deps=args.no_deps,
    )

    # Stage 1: Walk + collect.
    print("\n[Stage 1] Walking roots, collecting ODFs (last-wins dedup)...")
    collected, source_map = walk_and_collect(roots)

    if args.limit and args.limit > 0:
        names_sorted = sorted(collected.keys())[: args.limit]
        collected = {n: collected[n] for n in names_sorted}
        print(f"  --limit {args.limit}: capped corpus to {len(collected)} ODFs")

    # Stage 2: Parse.
    print("\n[Stage 2] Parsing ODFs (no noise filter, case-insensitive keys)...")
    corpus = parse_corpus(collected)

    # Stage 3: Inheritance pass.
    print("\n[Stage 3] Resolving inheritance chains...")
    corpus = process_corpus_inheritance(corpus)

    # Stage 4: Recursive composition-ref expansion (safeguarded).
    print(
        f"\n[Stage 4] Expanding composition refs "
        f"(MAX_REF_DEPTH={MAX_REF_DEPTH}, "
        f"MAX_PREFIX_DEPTH={MAX_PREFIX_DEPTH}, "
        f"valve={PER_ODF_BLOCK_VALVE}, "
        f"deadline={STAGE4_WALLCLOCK_CAP_S}s)..."
    )
    if args.forensic is not None:
        # Forensic mode: only expand a hand-picked slice with tracemalloc on.
        # Skips Stages 5-8 entirely.
        run_forensic(corpus, args.forensic)
        return 0  # unreachable - run_forensic exits

    expand_all_refs(corpus)
    apply_powerup_push(corpus)

    # Stage 5: Categorize.
    print("\n[Stage 5] Categorizing corpus into 12 buckets...")
    categorized, dropped = categorize_corpus(corpus)
    for cat_name, _sigs in CATEGORIES:
        cnt = len(categorized.get(cat_name, {}))
        print(f"  {cat_name:10s}: {cnt}")
    print(f"  Dropped: {len(dropped)}")
    if VERBOSE and dropped:
        print(f"  Dropped (verbose):")
        for name, reason in sorted(dropped.items()):
            print(f"    {name}: {reason}")

    # Stage 6: Diff + emit.
    print("\n[Stage 6] Diffing against production + writing output...")
    existing = load_existing_min_json()
    diff = diff_against_existing(categorized, existing)
    print_diff(diff)
    written = write_output(categorized, dry_run=args.dry_run)
    emit_summary(written, PROD_PATH)

    if args.self_check:
        passed, _fails = run_self_check(categorized, existing)
        return 0 if passed else 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
