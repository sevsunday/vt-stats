"""
convert_msh.py -- offline BZCC baked `.msh` -> glTF `.glb` converter + dual
texture-set + static-gallery generator for the object-render asset pipeline.

Scales the original 4-model POC to EVERY renderable BZCC model: every ODF
`GameObjectClass.geometryName` plus every weapon/ordnance `shotGeometry` that
resolves to a baked `.msh` across the base game + the VSR config mod + every
workshop asset/model pack (the same roots `_map-analysis/scripts/bz2_paths.py`
walks). ~700 unique meshes after dedup by lowercased mesh stem.

Per model it emits ONE geometry GLB (shared by both quality modes) plus TWO
deduped diffuse texture sets, assigned at runtime by material name in the
browser (the F9bomber `unit-viewer.js` pattern):

  data/models/
    index.json                  manifest: models[] + odf_index (odf -> stem)
    geometry/<stem>.glb          geometry + UVs + per-prim materials NAMED by
                                 their lowercased diffuse stem, baseColorFactor
                                 for textureless mats, NO embedded texture
    textures/perf/<stem>.png     512px PNG (decoded via mip) -- low-VRAM default
    textures/hq/<stem>.dds       native 2048 BC .dds copied verbatim -- true max
    thumbnails/<stem>.png        hero (~256px) for the directory grid cards
    shots/<stem>/<angle>.png     7-angle HQ gallery (~512px)

Coordinate handling: baked geometry is meters, Y-up. BZCC is a DirectX
(left-handed) engine, so we convert to glTF's right-handed space by negating Z
and reversing triangle winding. Toggle with --no-handedness-fix.

Caching: a model is skipped when its glb + hero + 7 gallery shots already exist
and the glb is newer than the source .msh (prior index.json entry reused).
--force reprocesses; --limit N caps the run (smoke-test); --jobs N parallelizes
the per-model render (the bottleneck). Texture writes are idempotent + atomic so
parallel workers are safe.

Usage:
  python scripts/object-render/convert_msh.py --limit 20    # smoke run
  python scripts/object-render/convert_msh.py --jobs 8      # full run, parallel
  python scripts/object-render/convert_msh.py --odf ivscout_vsr.odf
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "object-render"))
sys.path.insert(0, str(PROJECT_ROOT / "_map-analysis" / "scripts"))

import msh_thumbnail  # noqa: E402
from msh_parser import parse_msh, parse_msh_full  # noqa: E402
from glb_writer import GlbBuilder, build_animated_glb  # noqa: E402
from dds_decode import decode_dds, UnsupportedDDS  # noqa: E402
from PIL import Image  # noqa: E402

try:
    import bz2_paths  # from _map-analysis/scripts
except ImportError:
    bz2_paths = None

ODF_DB = PROJECT_ROOT / "data" / "odf.min.json"
OUT_DIR = PROJECT_ROOT / "data" / "models"
GEO_DIR = OUT_DIR / "geometry"
TEX_PERF_DIR = OUT_DIR / "textures" / "perf"
TEX_HQ_DIR = OUT_DIR / "textures" / "hq"
TEX_TEAMCOLOR_DIR = OUT_DIR / "textures" / "teamcolor"
TEX_EMISSIVE_DIR = OUT_DIR / "textures" / "emissive"
TEX_NORMAL_DIR = OUT_DIR / "textures" / "normal"
TEX_SPECULAR_DIR = OUT_DIR / "textures" / "specular"
TEX_SPECULAR_TRUE_DIR = OUT_DIR / "textures" / "specular_true"
TEX_MODS_DIR = OUT_DIR / "textures" / "mods"

PERF_MAX_DIM = 512       # performance PNG largest side
TEAMCOLOR_MAX_DIM = 512  # team-color mask largest side (coverage+shading; no HQ set)
EMISSIVE_MAX_DIM = 512   # emissive glow map largest side (no HQ set)
NORMAL_MAX_DIM = 1024    # tangent-space normal map largest side (detail survives
                         # downscaling poorly -- 1024 locked per payload review)
SPECULAR_MAX_DIM = 512   # specular->roughness map largest side (gloss is low-freq)
DECODE_MAX_DIM = 1024    # decode-once size (downscaled to perf + reused for gallery)

# Specular -> roughness conversion (BZCC is legacy spec/gloss; the viewer is PBR
# metalness/roughness -- there is no exact conversion, these are the tuned knobs):
#   roughness = clamp((1 - L)^K * (1 - 0.3 * log10(specularPower) / 2), MIN, 1)
# where L is the spec map's per-pixel luminance and specularPower comes from the
# `.material` [solid] section (observed range 1..~50; no bias when undeclared).
SPEC_ROUGHNESS_K = 0.6   # contrast exponent (lower = shinier overall)
SPEC_ROUGHNESS_MIN = 0.05

# Workshop texture-override packs surfaced as alternate "texture sets" in the
# Models Browser. Each pack is a pure DDS overlay keyed by the same texture
# stems the stock game uses (diffuse + optional `_c` team mask + `_e` glow).
# A pack whose workshop dir is not installed on this machine is soft-skipped
# with a console warning. `label`/`url` feed the viewer's credit links.
MOD_TEXTURE_PACKS = [
    {"id": "1554202061", "label": "Scion Stock-Enhanced Textures",
     "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=1554202061"},
    {"id": "1581901346", "label": "ISDF Stock-Enhanced Textures",
     "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=1581901346"},
    {"id": "3365986032", "label": "ISDF Redux Re-Texture",
     "url": "https://steamcommunity.com/sharedfiles/filedetails/?id=3365986032"},
]

# Bump when the animated-GLB emission shape changes; mismatch vs the prior
# index.json forces a full regen (animated GLBs aren't invalidated by msh mtime
# since only the export CODE changed, not the source mesh).
#   v2: rigid weld key includes UV (fix texture seams); deploy+loop buildings bake
#       the deployed pose as the node default (loop plays deployed, not folded).
#   v3: emit a node-hierarchy GLB for EVERY rigid multi-node model (not just ones
#       with baked clips) so named moveable parts (turret_y / turret_x / recoil*
#       and the tread material) survive into the published GLB for the viewer's
#       interactive articulation. Adds the per-model `parts` manifest block.
#   v4: `parts` is now ODF-authoritative -- it carries resolved node-name lists
#       (turretNodes / pitchNodes / recoilNodes) sourced from GameObjectClass
#       turretName*/recoilName* and a walker `head` block (WalkerClass headpiece
#       + per-model yaw/pitch limits), so walkers aim their head + fire their
#       guns. Forces a full regen to recompute every parts block.
#   v5: turret yaw/pitch detection is ODF-declared ONLY (the turret_y/turret_x
#       naming-convention fallback produced false aimables -- the engine never
#       aims an undeclared joint: ivtank / ivmisl guns are hull-fixed in game).
#       Recoil keeps the declared+convention union. Parts-only change; GLB
#       bytes are unchanged by the regen.
ANIM_FORMAT_VERSION = 5

# Bump when the emitted texture SET shape changes (new texture kind / dir layout)
# without the GLB geometry changing. A mismatch vs the prior index.json forces a
# reprocess so the new textures get emitted; the GLB write is guarded (skipped
# when fresh) so this does NOT churn the ~700 geometry GLBs.
#   v1: add the team-color mask set (textures/teamcolor/<stem>.png) + the per-model
#       `teamColorTextures` manifest block.
#   v2: add the emissive glow set (textures/emissive/<stem>.png) + per-model
#       `emissiveTextures`, and the workshop mod texture-override sets
#       (textures/mods/<pack_id>/{perf,hq,teamcolor,emissive}/) + per-model
#       `textureSets` + top-level `texture_packs`.
#   v3: add the tangent-space normal map set (textures/normal/<stem>.png, 1024px,
#       decoded from the BC5-SNORM `_n.dds` sources) + per-model `normalTextures`,
#       and the specular->roughness set (textures/specular/<stem>.png, 512px
#       grayscale, luminance-converted from the `_s.dds` sources) + per-model
#       `specularTextures`; both mirrored into the mod texture sets
#       (textures/mods/<pack_id>/{normal,specular}/).
#   v4: specular gloss source corrected from RGB luminance to the ALPHA channel
#       (community-confirmed BZCC convention: spec RGB = specular tint, A =
#       gloss; 547/660 stock `_s.dds` are BC3 with an authored alpha, and the
#       two channels are essentially uncorrelated -- several unit spec maps
#       carry FLAT RGB with all their gloss detail in alpha). Luminance remains
#       the fallback for BC1 sources / flat-255 alpha. Same roughness LUT.
#       NOTE: a v4 regen needs the stale specular PNGs deleted first
#       (textures/specular/ + textures/mods/*/specular/) -- emits are
#       skipped when the output file already exists.
#   v5: DUAL specular sets. textures/specular/ reverts to the v3 RGB-luminance
#       conversion (the stylized glossier look, restored as the viewer
#       DEFAULT per user preference); the v4 alpha/game-true conversion moves
#       to textures/specular_true/ (+ mods/<id>/specular_true/), consumed by
#       the viewer's opt-in "True lighting" toggle. Decode once, emit both.
#       Same stems in both sets, so the manifest shape is unchanged.
#       NOTE: a v5 regen needs textures/specular/ + textures/mods/*/specular/
#       purged first (on-disk v4 files are alpha-based and must revert to
#       luminance; emits skip existing files).
TEXTURE_FORMAT_VERSION = 5

# Render flags (mirror msh_parser): hidden/collision geometry is not drawable.
RS_HIDDEN = 0x400
RS_COLLIDABLE = 0x100

FACTION_NAMES = {"i": "ISDF", "e": "Hadean", "f": "Scion", "c": "Cerberi"}

# Module-global worker state (set by _worker_init for the process pool, or
# directly in the serial path). Holds the read-only indexes + run config so
# job dicts stay small + picklable.
_G: dict | None = None


# ----------------------------- enumeration -----------------------------


def _stem(name: str) -> str:
    return Path(str(name)).stem.lower()


def _renderable_node_count(full: dict) -> int:
    """Count mesh-tree nodes that carry drawable geometry (have verts and are
    not hidden/collision helpers). >1 => a real multi-part hierarchy worth
    preserving instead of welding to a single mesh."""
    n = 0
    for nd in full.get("nodes", []):
        if nd.get("verts") and not (nd.get("flags", 0) & (RS_HIDDEN | RS_COLLIDABLE)):
            n += 1
    return n


def _classify_parts(full: dict, clip_names, odf_art=None) -> dict | None:
    """Derive the interactive-articulation `parts` block from a parse_msh_full()
    result. Returns None when the model has no moveable parts (so plain
    multi-part scenery doesn't carry an empty block).

    Detection is ODF-authoritative:
      - turret yaw/pitch : ODF GameObjectClass.turretName* ONLY -- the engine
        aims a joint only when it is declared, so convention-named turret_y /
        turret_x nodes WITHOUT a declaration stay fixed (e.g. the ISDF Tank's
        gun is hull-fixed in game despite its mesh carrying both nodes). The
        AXIS of a declared node is decided by name convention (turret_x* =
        pitch, anything else yaws) since the ODF doesn't split yaw/pitch.
      - recoil : ODF GameObjectClass.recoilName* + convention recoil* nodes
        (kept as a union -- Fire is an explicit viewer action and the engine
        evidence for convention-only recoil is ambiguous)
      - head (walker) : WalkerClass.headpiece -> ONE node aimed in yaw AND pitch
        within per-model limits (carried through so the viewer can clamp)
      - tread / tractor node, or a 'tread' material : scrolling treads
      - bankClips : body steering clips (forward / reverse / neutral)
    All ODF-declared node names are validated against the actual mesh (only kept
    when a node really exists, matched case-insensitively)."""
    odf_art = odf_art or {}
    nodes = full.get("nodes", [])
    actual_names = [(nd.get("name") or "") for nd in nodes]
    lower_to_actual = {}
    for nm in actual_names:
        if nm:
            lower_to_actual.setdefault(nm.lower(), nm)

    def resolve(decl):
        """ODF-declared names -> existing actual node names (dedup, order-keep)."""
        out = []
        for dn in (decl or []):
            actual = lower_to_actual.get(str(dn).lower())
            if actual and actual not in out:
                out.append(actual)
        return out

    def add_unique(dst, items):
        for it in items:
            if it not in dst:
                dst.append(it)

    # Turret nodes: ODF turretName* declarations ONLY (ODFs commonly declare
    # turretName1=yaw base + turretName2=gun mantlet). The engine aims a joint
    # only when declared -- convention-named turret_y/turret_x nodes without a
    # declaration are fixed in game (ivtank, ivmisl). The AXIS is decided by
    # node-name convention -- turret_x* is a pitch joint, anything else
    # (turret_y* or a custom base name) yaws -- so an ODF-declared pitch node
    # never lands in the yaw bucket.
    cand_turret = resolve(odf_art.get("turretNames"))
    turret_nodes, pitch_nodes = [], []
    for nm in cand_turret:
        if re.fullmatch(r"turret_x(_\d+)?", nm.lower()):
            if nm not in pitch_nodes:
                pitch_nodes.append(nm)
        elif nm not in turret_nodes:
            turret_nodes.append(nm)

    # Recoil: convention recoil* nodes + ODF recoilName* (walker guns name these
    # lgun / cannon_recoil_* / etc., which the convention misses entirely).
    recoil_nodes = []
    add_unique(recoil_nodes, [nm for nm in actual_names if nm.lower().startswith("recoil")])
    add_unique(recoil_nodes, resolve(odf_art.get("recoilNames")))

    # Walker head: a single node aimed in both axes, with per-model limits.
    head = None
    ha = odf_art.get("head")
    if ha:
        node = lower_to_actual.get(str(ha.get("node", "")).lower())
        if node:
            head = {
                "node": node,
                "yawMin": ha["yawMin"], "yawMax": ha["yawMax"],
                "pitchMin": ha["pitchMin"], "pitchMax": ha["pitchMax"],
            }

    tread_node = any(x.lower().startswith("tread") or x.lower().startswith("tractor")
                     for x in actual_names)
    tread_mat = False
    for nd in nodes:
        for grp in nd.get("groups", []):
            # grp = (vert_count, index_count, material_name, texture_name)
            for s in (grp[3], grp[2]):
                if s and "tread" in str(s).lower():
                    tread_mat = True
    bank = sorted(c for c in (clip_names or [])
                  if str(c).lower() in ("forward", "reverse", "neutral"))

    # A resolved head implies an aimable joint (yaw + pitch) for the legacy flags
    # so the directory badge + existing boolean readers keep working unchanged.
    turret = bool(turret_nodes) or head is not None
    pitch = bool(pitch_nodes) or head is not None
    treads = bool(tread_node or tread_mat)
    parts = {
        "turret": turret,
        "pitch": pitch,
        "recoil": len(recoil_nodes),
        "treads": treads,
        "bankClips": bank,
        "turretNodes": turret_nodes,
        "pitchNodes": pitch_nodes,
        "recoilNodes": recoil_nodes,
        "head": head,
    }
    if not (turret or pitch or parts["recoil"] or treads):
        return None
    return parts


def _extract_odf_art(blocks: dict) -> dict:
    """Pull articulation declarations from one ODF entry's class blocks:
      - GameObjectClass.turretName<N> -> yaw-turret node names
      - GameObjectClass.recoilName<N> -> per-weapon recoil node names (the DB
        also carries RecoilName<N> casing)
      - WalkerClass.headpiece + min/maxHead{Yaw,Pitch} -> the walker head joint
        (a single node aimed in BOTH yaw and pitch, with per-model limits)
    Returns {turretNames, recoilNames, head|None}; node names are verified
    against the real mesh later in _classify_parts."""
    go = blocks.get("GameObjectClass", {}) or {}
    turret, recoil = [], []
    for k, v in go.items():
        if not v or str(v).upper() == "NULL":
            continue
        kl = k.lower()
        if re.fullmatch(r"turretname\d+", kl):
            turret.append(str(v))
        elif re.fullmatch(r"recoilname\d+", kl):
            recoil.append(str(v))
    head = None
    wc = blocks.get("WalkerClass")
    if isinstance(wc, dict) and wc.get("headpiece") and str(wc["headpiece"]).upper() != "NULL":
        def f(key, default):
            try:
                return float(str(wc.get(key, default)).rstrip("fF"))
            except (TypeError, ValueError):
                return default
        head = {
            "node": str(wc["headpiece"]),
            "yawMin": f("minHeadYaw", -90.0), "yawMax": f("maxHeadYaw", 90.0),
            "pitchMin": f("minHeadPitch", -30.0), "pitchMax": f("maxHeadPitch", 30.0),
        }
    return {"turretNames": turret, "recoilNames": recoil, "head": head}


# Movement archetypes for the viewer's WASD Drive Mode, in priority order (a
# walker ODF also carries CraftClass etc., so the most specific class wins).
DRIVE_CLASS_ARCHETYPES = [
    ("WalkerClass", "walker"),
    ("MorphTankClass", "morph"),
    ("TrackedVehicleClass", "tracked"),
    ("HoverCraftClass", "hover"),
    ("PersonClass", "pilot"),
]


def _odf_float(props: dict, key: str):
    v = props.get(key)
    if v is None or str(v).upper() == "NULL":
        return None
    try:
        return float(str(v).rstrip("fF"))
    except (TypeError, ValueError):
        return None


def _normalize_omega(val):
    """omegaTurn/omegaSpin are rad/s in vehicle ODFs (0.5 .. 3.5) but deg/s in
    walker ODFs (e.g. 40.0). No real turn rate exceeds 10 rad/s (~570 deg/s),
    so values above 10 are degrees -> convert to rad/s."""
    if val is None:
        return None
    return round(math.radians(val), 4) if val > 10.0 else val


def _extract_odf_drive(blocks: dict) -> dict | None:
    """Movement profile for the viewer's WASD Drive Mode: archetype + the
    ODF-authored speeds (m/s, rad/s). Pilots (PersonClass) read the Run-stance
    variants (velocForwardRun etc.). `animSteer` flags craft whose ODF declares
    a steer animation (the steer pose is baked into zero GLBs corpus-wide, so
    the viewer substitutes a procedural turn-lean -- ONLY for these craft).
    Returns None for non-driveable ODFs."""
    for cls, archetype in DRIVE_CLASS_ARCHETYPES:
        props = blocks.get(cls)
        if not isinstance(props, dict):
            continue
        suffix = "Run" if archetype == "pilot" else ""
        fwd = _odf_float(props, f"velocForward{suffix}")
        rev = _odf_float(props, f"velocReverse{suffix}")
        strafe = _odf_float(props, f"velocStrafe{suffix}")
        turn = _normalize_omega(_odf_float(props, f"omegaTurn{suffix}"))
        spin = _normalize_omega(_odf_float(props, f"omegaSpin{suffix}"))
        if fwd is None and rev is None and turn is None and spin is None:
            continue   # class block present but speedless -> try the next class
        # alphaSteer = angular acceleration toward the commanded turn rate
        # (rad/s^2; 0.1-15 in the corpus -- no deg normalization needed). The
        # viewer ramps its yaw rate at this, so heavy craft wind up/coast down.
        alpha = _odf_float(props, f"alphaSteer{suffix}")
        steer = props.get("animSteer")
        # setAltitude (hover/morph only): "Height above Ground that it tries
        # to maintain" (linear meters, per the vendored ODF guide) -- measured
        # at the craft's physics ORIGIN, which is why a shallow-hulled APC at
        # 1.5 reads much higher than a scout at 1.0. Corpus range: 0 (ivcons,
        # grounded) .. 75 (FE flying artillery). Morph ODFs usually carry it on
        # MorphTankClass; fall back to a sibling HoverCraftClass block.
        altitude = None
        if archetype in ("hover", "morph"):
            props_l = {str(k).lower(): v for k, v in props.items()}
            altitude = _light_float(props_l, "setaltitude", None) \
                if "setaltitude" in props_l else None
            if altitude is None:
                hc = blocks.get("HoverCraftClass")
                if isinstance(hc, dict):
                    hcl = {str(k).lower(): v for k, v in hc.items()}
                    if "setaltitude" in hcl:
                        altitude = _light_float(hcl, "setaltitude", None)
            if altitude is None:
                altitude = 1.0   # engine default per the guide
        # flightAltitude (APCClass / BomberClass / SavClass, incl. nested
        # `Bomber.BomberClass`): the craft's FLYING ceiling -- "How high above
        # ground it flies" (APC 75, bombers 85, SAV 150; linear meters). Only
        # emitted when authored; powers the viewer's Fly toggle.
        flight = None
        for bk, bv in blocks.items():
            if not isinstance(bv, dict):
                continue
            if str(bk).lower().split(".")[-1] not in ("apcclass", "bomberclass", "savclass"):
                continue
            bl = {str(k).lower(): v for k, v in bv.items()}
            if "flightaltitude" in bl:
                flight = _light_float(bl, "flightaltitude", None)
                if flight is not None:
                    break
        return {
            "archetype": archetype,
            "velocForward": fwd,
            "velocReverse": rev,
            "velocStrafe": strafe,
            "omegaTurn": turn,
            "omegaSpin": spin,
            "alphaSteer": alpha,
            "animSteer": bool(steer and str(steer).upper() != "NULL"),
            "setAltitude": altitude,
            "flightAltitude": flight,
        }
    return None


def _extract_odf_snipe(blocks: dict) -> dict:
    """Snipe-point eligibility from GameObjectClass.canSnipe. In odf.min.json
    canSnipe is almost only written to turn it OFF (support units, assault
    tanks); the snipeable default-true lives in the absent base craft class
    (wingman). So treat a craft as snipeable UNLESS canSnipe is explicitly
    0/false. cockpitSniperRadius (the engine's snipe-dot radius) is captured
    for orb sizing when present. The eyepoint POSITION is not baked here -- the
    viewer locates the mesh's hp_eyepoint node at runtime.
    Returns {canSnipe: bool, cockpitSniperRadius: float|None}."""
    go = blocks.get("GameObjectClass", {}) or {}
    go_l = {str(k).lower(): v for k, v in go.items()}
    can = True
    raw = go_l.get("cansnipe")
    if raw is not None and str(raw).strip().lower() in ("0", "false"):
        can = False
    return {"canSnipe": can,
            "cockpitSniperRadius": _odf_float(go_l, "cockpitsniperradius")}


def _extract_odf_collision(blocks: dict):
    """Authored collisionRadius from GameObjectClass (the AI-avoidance / path-
    planning footprint, per docs/reference/odf-properties-guide.md). Returns the
    explicit float when declared, else None -- the viewer derives the engine
    default (boundingSphere * 0.75) from the already-shipped `radius`."""
    go = blocks.get("GameObjectClass", {}) or {}
    go_l = {str(k).lower(): v for k, v in go.items()}
    return _odf_float(go_l, "collisionradius")


# The 8 valid weapon-hardpoint categories (per GenBlackDragon's ODF guide,
# vendored at docs/reference/odf-properties-guide.md): a hardpoint node name
# must START with one of these, with or without the traditional HP_ prefix
# (HP_GUN_1, hp_cannon_2, HP_SHIELD, ...). Same-type hardpoints fire together
# when that weapon slot is selected in-game.
WEAPON_HARD_CATEGORIES = ("GUN", "CANN", "MORT", "ROCK", "SPEC", "SHIE", "HAND", "PACK")


def _hardpoint_type(hard: str) -> str | None:
    """Map a hardpoint node name (HP_GUN_1 / hp_cannon_2 / HP_SHIELD) to its
    weapon category code, or None when the name matches no category."""
    h = str(hard).strip().upper()
    if h.startswith("HP_"):
        h = h[3:]
    for cat in WEAPON_HARD_CATEGORIES:
        if h.startswith(cat):
            return cat
    return None


def _odf_strv(props_lower: dict, key_lower: str) -> str | None:
    """Read a string prop from a lowercase-keyed block; '', 'NULL' -> None."""
    v = props_lower.get(key_lower)
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s.upper() != "NULL" else None


def _lookup_weapon(weapon_db: dict, odf_stem: str):
    """Resolve (wpnName, wpnCategory) for a weapon ODF stem from the Weapon
    category of odf.min.json. The DB pre-flattens most inheritance, but we
    still follow inheritanceChain as a fallback (e.g. variants that only
    override firing props)."""
    seen = set()
    key = str(odf_stem).strip().lower().removesuffix(".odf")
    while key and key not in seen:
        seen.add(key)
        entry = weapon_db.get(key + ".odf")
        if not isinstance(entry, dict):
            return None, None
        name = cat = None
        for bk, bv in entry.items():
            if isinstance(bv, dict) and "." not in bk:
                name = name or bv.get("wpnName")
                cat = cat or bv.get("wpnCategory")
        if name or cat:
            return (str(name).strip() if name else None,
                    str(cat).strip().upper() if cat else None)
        chain = entry.get("inheritanceChain") or []
        key = str(chain[0]).strip().lower() if chain else None
    return None, None


def _extract_odf_loadout(blocks: dict, weapon_db: dict) -> list | None:
    """Default weapon loadout from one ODF entry's GameObjectClass:
    weaponHard1..5 (hardpoint node name) + weaponName1..5 (weapon ODF) +
    weaponAssault1..5. Slot type comes from the hardpoint name prefix with
    the weapon's own wpnCategory as fallback. A declared hardpoint with no
    weapon is kept as an empty slot. Returns None when no slots exist."""
    go = blocks.get("GameObjectClass", {}) or {}
    gol = {str(k).lower(): v for k, v in go.items()}
    slots = []
    for i in range(1, 6):
        hard = _odf_strv(gol, f"weaponhard{i}")
        wname = _odf_strv(gol, f"weaponname{i}")
        if not hard and not wname:
            continue
        weapon_odf = wname.lower().removesuffix(".odf") if wname else None
        wpn_name, wpn_cat = _lookup_weapon(weapon_db, weapon_odf) if weapon_odf else (None, None)
        stype = (_hardpoint_type(hard) if hard else None) or wpn_cat
        assault = str(gol.get(f"weaponassault{i}", "")).strip().lower() in ("1", "true")
        slots.append({
            "hard": hard,
            "type": stype,
            "weaponOdf": weapon_odf,
            "weaponName": wpn_name,
            "assault": assault,
        })
    return slots or None


def _light_float(props_lower: dict, key_lower: str, default: float) -> float:
    v = props_lower.get(key_lower)
    if v is None:
        return default
    try:
        return float(str(v).rstrip("fF"))
    except (TypeError, ValueError):
        return default


def _extract_odf_lights(blocks: dict, effect_db: dict) -> list | None:
    """Authored ship lights from one ODF entry's GameObjectClass:
    lightHard1..8 (hardpoint node name) + lightName1..8 (LightClass ODF in the
    Effect category). Each resolved light carries the authored color / range /
    attenuation / spot cone so the viewer can build a real THREE light.
    Slots with an empty lightName or an unresolvable light ODF are skipped.
    Returns None when nothing resolves."""
    go = blocks.get("GameObjectClass", {}) or {}
    gol = {str(k).lower(): v for k, v in go.items()}
    only_piloted = str(gol.get("lightsonlywhenpiloted", "")).strip().lower() in ("1", "true")
    out = []
    for i in range(1, 9):
        hard = _odf_strv(gol, f"lighthard{i}")
        name = _odf_strv(gol, f"lightname{i}")
        if not hard or not name:
            continue
        entry = effect_db.get(name.lower().removesuffix(".odf") + ".odf")
        lc = entry.get("LightClass") if isinstance(entry, dict) else None
        if not isinstance(lc, dict):
            continue
        lcl = {str(k).lower(): v for k, v in lc.items()}
        kind = "spot" if str(lcl.get("classlabel", "")).strip().lower() == "spotlight" else "point"
        light = {
            "hard": hard,
            "lightOdf": name.lower().removesuffix(".odf"),
            "kind": kind,
            "color": [round(_light_float(lcl, f"lightcolor.{c}", 1.0), 4) for c in "rgb"],
            "range": _light_float(lcl, "lightrange", 20.0),
            "attenuation": [
                _light_float(lcl, "attenuateconstant", 1.0),
                _light_float(lcl, "attenuatelinear", 0.0),
                _light_float(lcl, "attenuatequadratic", 15.0),
            ],
            "onlyWhenPiloted": only_piloted,
        }
        if kind == "spot":
            light["coneInner"] = _light_float(lcl, "coneanginner", 0.5)
            light["coneOuter"] = _light_float(lcl, "coneangouter", 2.0)
        out.append(light)
    return out or None


def enumerate_targets(odf_filter=None):
    """Scan odf.min.json for every geometryName + shotGeometry. Returns a dict
    stem -> {odfs, primaryOdf, unitName, category, factionCode, factionName,
    odf_art}."""
    db = json.loads(ODF_DB.read_text(encoding="utf-8"))
    refs: dict[str, list[dict]] = {}

    def add(stem, odf, unit, category, source, blocks):
        if not stem or stem.upper() == "NULL":
            return
        refs.setdefault(stem, []).append({
            "odf": odf, "unitName": unit or "",
            "category": category, "source": source, "blocks": blocks,
        })

    for cat, entries in db.items():
        for name, blocks in entries.items():
            if not isinstance(blocks, dict):
                continue
            go = blocks.get("GameObjectClass", {}) or {}
            unit = go.get("unitName")
            geo = go.get("geometryName")
            if geo and str(geo).upper() != "NULL":
                add(_stem(geo), name, unit, cat, "geometryName", blocks)
            # shotGeometry lives in nested *OrdnanceClass blocks (dotted keys)
            for bv in blocks.values():
                if isinstance(bv, dict):
                    sg = bv.get("shotGeometry")
                    if sg and str(sg).upper() != "NULL":
                        add(_stem(sg), name, unit, "Ordnance", "shotGeometry", blocks)

    weapon_db = db.get("Weapon", {}) or {}
    effect_db = db.get("Effect", {}) or {}

    out = {}
    for stem, cands in refs.items():
        # primary: prefer a geometryName ref with a unitName, then any
        # geometryName, then anything; tie-break on shortest odf name.
        def key(c):
            rank = 0 if (c["source"] == "geometryName" and c["unitName"]) else (
                1 if c["source"] == "geometryName" else 2)
            return (rank, len(c["odf"]))
        cands_sorted = sorted(cands, key=key)
        primary = cands_sorted[0]
        odfs = sorted({c["odf"] for c in cands})
        if odf_filter and not (set(odfs) & odf_filter):
            continue
        fcode = primary["odf"][0].lower()
        if fcode not in FACTION_NAMES:
            fcode = "_"
        # Articulation: union turret/recoil declarations across all candidate
        # ODFs (primary first), take the head from the first candidate declaring
        # a WalkerClass. Node existence is validated against the mesh later.
        art_turret, art_recoil, art_head = [], [], None
        for c in cands_sorted:
            a = _extract_odf_art(c["blocks"])
            for t in a["turretNames"]:
                if t not in art_turret:
                    art_turret.append(t)
            for r in a["recoilNames"]:
                if r not in art_recoil:
                    art_recoil.append(r)
            if art_head is None and a["head"]:
                art_head = a["head"]
        # Drive profile: first candidate (primary first) declaring a movement
        # class with speeds wins.
        drive = None
        for c in cands_sorted:
            drive = _extract_odf_drive(c["blocks"])
            if drive:
                break
        # Weapon loadouts: one entry per candidate ODF declaring >= 1 weapon
        # slot (virtual_class_* stubs skipped) -- powers the viewer's variant
        # dropdown. Default variant prefers _vsr (this is a VSR stats site),
        # then the primary ODF. Ship lights come from the first VSR-preferred
        # candidate that declares any (lights rarely vary across variants).
        uniq_cands, seen_odfs = [], set()
        for c in cands_sorted:
            o = c["odf"]
            if o in seen_odfs or o.startswith("virtual_class_"):
                continue
            seen_odfs.add(o)
            uniq_cands.append(c)
        loadouts = []
        for c in uniq_cands:
            slots = _extract_odf_loadout(c["blocks"], weapon_db)
            if slots:
                # `unit` = the source ODF's own unitName so the viewer can flag
                # variants that belong to a DIFFERENT unit sharing this mesh
                # (e.g. ivapc00's only armed variants are the holiday-mod
                # ivsnowplow ODFs -- the stock APC has no weapon hardpoints).
                loadouts.append({"odf": c["odf"], "unit": c["unitName"] or None,
                                 "slots": slots})
        # Default variant: VSR first, then stock (the primary ODF or any
        # candidate whose unitName matches this unit). When ONLY foreign-unit
        # variants are armed (e.g. ivapc00's holiday-mod Snowplow ODFs), the
        # default stays None -- the stock unit genuinely has no hardpoints and
        # the viewer renders a "None" state with the variants as opt-in.
        default_loadout_odf = None
        if loadouts:
            base_unit = (primary["unitName"] or "").strip().lower()
            vsr = [lo["odf"] for lo in loadouts if lo["odf"].endswith("_vsr.odf")]
            stock = [lo["odf"] for lo in loadouts
                     if lo["odf"] == primary["odf"]
                     or (base_unit and (lo["unit"] or "").strip().lower() == base_unit)]
            if vsr:
                default_loadout_odf = min(vsr, key=lambda o: (len(o), o))
            elif stock:
                default_loadout_odf = stock[0]
        lights = None
        for c in sorted(uniq_cands,
                        key=lambda c: 0 if c["odf"].endswith("_vsr.odf") else 1):
            lights = _extract_odf_lights(c["blocks"], effect_db)
            if lights:
                break
        # Snipe-point eligibility from the primary (representative) ODF: show
        # the eyepoint orb unless canSnipe is explicitly false (matches the
        # in-game rule that support units / assault tanks aren't snipeable).
        snipe = _extract_odf_snipe(primary["blocks"])
        # Collision radius (AI-avoidance footprint): sparse per-ODF map of the
        # ODFs that explicitly declare one. The viewer follows the loadout
        # variant select and falls back to boundingSphere * 0.75 (the engine
        # default) from the shipped `radius` for any ODF not in this map.
        collision = {}
        for c in uniq_cands:
            cr = _extract_odf_collision(c["blocks"])
            if cr is not None:
                collision[c["odf"]] = round(cr, 3)
        out[stem] = {
            "odfs": odfs,
            "primaryOdf": primary["odf"],
            "unitName": primary["unitName"] or stem,
            "category": primary["category"],
            "factionCode": fcode,
            "factionName": FACTION_NAMES.get(fcode, "Other"),
            "odf_art": {"turretNames": art_turret, "recoilNames": art_recoil,
                        "head": art_head},
            "drive": drive,
            "loadouts": loadouts or None,
            "defaultLoadoutOdf": default_loadout_odf,
            "lights": lights,
            "snipe": snipe,
            "collisionRadiiByOdf": collision or None,
        }
    return out


def build_file_index(roots, ext):
    """stem(lower) -> Path for every *.<ext>, base-first precedence with
    LAST-WINS override (matches build_odf_db so the asset matches the ODF)."""
    idx = {}
    for path, _label in roots:
        for f in path.rglob(f"*.{ext}"):
            idx[f.stem.lower()] = f
    return idx


def resolve_roots(steam_override=None):
    if bz2_paths is not None:
        try:
            return bz2_paths.resolve_root_dirs(
                steam_override=steam_override, quiet=True)
        except SystemExit:
            pass
    fallback = Path(r"C:\Program Files (x86)\Steam\steamapps\common\BZ2R")
    if fallback.is_dir():
        return [(fallback, "BZ2R fallback")]
    raise SystemExit("Could not locate the BZ2R install.")


def workshop_content_dir(steam_override=None):
    """Locate the BZCC workshop content dir (.../workshop/content/624970) so we
    can index EVERY subscribed item as a last-resort texture fallback, not just
    the VSR asset dependencies."""
    if bz2_paths is not None:
        if steam_override:
            base = Path(steam_override).expanduser().resolve()
        else:
            base = bz2_paths.detect_steam_base() or bz2_paths.STEAM_BASE_FALLBACK
        ws = base / bz2_paths.WORKSHOP_RELATIVE
        if ws.is_dir():
            return ws
    fallback = Path(
        r"C:\Program Files (x86)\Steam\steamapps\workshop\content\624970")
    return fallback if fallback.is_dir() else None


def build_workshop_index(ws_dir, ext):
    """stem(lower) -> Path for every *.<ext> across the ENTIRE workshop tree.
    first-wins (don't override; only a fallback layer)."""
    idx = {}
    if not ws_dir:
        return idx
    for f in ws_dir.rglob(f"*.{ext}"):
        idx.setdefault(f.stem.lower(), f)
    return idx


# ----------------------------- material / texture -----------------------------


def parse_material(msh_dir: Path, material_filename: str):
    """Read the [solid] diffuse RGBA + specularPower and the [texture]
    diffuse/teamColor/emissive/normal/specular .dds names from a sibling (or
    globally-indexed) `.material` file. Returns
    (rgba, diffuse_dds|None, teamcolor_dds|None, emissive_dds|None,
     normal_dds|None, specular_dds|None, specular_power|None).
    `teamColor = <stem>_c.dds` marks the team-colorable mask (BC3: alpha =
    colorizable region, RGB = shading); `emissive = <stem>_e.dds` is the
    self-illumination glow map; `normal = <stem>_n.dds` is the tangent-space
    normal map (BC5S); `specular = <stem>_s.dds` is the legacy spec/gloss map
    converted to roughness with `specularPower` as a per-material gloss hint."""
    rgba = (0.8, 0.8, 0.8, 1.0)
    diffuse_dds = None
    teamcolor_dds = None
    emissive_dds = None
    normal_dds = None
    specular_dds = None
    specular_power = None
    empty = (rgba, diffuse_dds, teamcolor_dds, emissive_dds,
             normal_dds, specular_dds, specular_power)
    if not material_filename:
        return empty
    p = msh_dir / material_filename
    if not p.is_file():
        p = msh_dir / "materials" / material_filename
    if not p.is_file():
        key = _stem(material_filename)
        mat_index = _G["mat_index"] if _G else {}
        mat_index_all = _G["mat_index_all"] if _G else {}
        # VSR-scoped match wins; full-workshop is last-resort fallback.
        p = mat_index.get(key) or mat_index_all.get(key)
    if not p or not Path(p).is_file():
        return empty
    try:
        text = Path(p).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return empty
    section = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s.lower().strip("[]")
            continue
        if "=" not in s:
            continue
        key, val = (x.strip() for x in s.split("=", 1))
        kl = key.lower()
        if section == "solid" and kl == "diffuse":
            try:
                vals = [float(x) for x in val.split()[:4]]
                while len(vals) < 4:
                    vals.append(1.0)
                rgba = tuple(vals[:4])
            except ValueError:
                pass
        elif section == "solid" and kl == "specularpower":
            try:
                specular_power = float(val.split()[0])
            except (ValueError, IndexError):
                pass
        elif section == "texture" and kl == "diffuse":
            diffuse_dds = val.strip()
        elif section == "texture" and kl == "teamcolor":
            teamcolor_dds = val.strip()
        elif section == "texture" and kl == "emissive":
            emissive_dds = val.strip()
        elif section == "texture" and kl == "normal":
            normal_dds = val.strip()
        elif section == "texture" and kl == "specular":
            specular_dds = val.strip()
    return (rgba, diffuse_dds, teamcolor_dds, emissive_dds,
            normal_dds, specular_dds, specular_power)


def _atomic_write_bytes(path: Path, data: bytes):
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _find_diffuse_src(msh_dir: Path, dds_name: str):
    candidates = [
        msh_dir / dds_name,
        msh_dir / "textures" / dds_name,
        msh_dir.parent / "textures" / dds_name,
    ]
    for c in candidates:
        if c.is_file():
            return c
    key = _stem(dds_name)
    dds_index = _G["dds_index"] if _G else {}
    dds_index_all = _G["dds_index_all"] if _G else {}
    # VSR-scoped match wins; full-workshop is last-resort fallback.
    return dds_index.get(key) or dds_index_all.get(key)


def resolve_diffuse(msh_dir: Path, dds_name: str, cache: dict):
    """Resolve + dedup a diffuse `.dds`. Writes textures/perf/<stem>.png (512,
    decoded via mip) and textures/hq/<stem>.dds (native copy, verbatim), both
    idempotently. Returns (tex_key, rgb_float_array_1024) or None.

    `cache` is per-model: maps tex_key -> (already-resolved) rgb array so groups
    sharing a diffuse decode once."""
    if not dds_name:
        return None
    tex_key = _stem(dds_name)
    if tex_key in cache:
        return (tex_key, cache[tex_key]) if cache[tex_key] is not None else None

    src = _find_diffuse_src(msh_dir, dds_name)
    if src is None:
        cache[tex_key] = None
        return None
    src = Path(src)

    try:
        pil = decode_dds(src, max_dim=DECODE_MAX_DIM).convert("RGBA")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    tex decode failed {dds_name}: {e}")
        cache[tex_key] = None
        return None

    force = _G["force"] if _G else False
    # perf PNG (downscale the 1024 decode to <=512)
    perf_path = TEX_PERF_DIR / f"{tex_key}.png"
    if force or not perf_path.exists():
        w, h = pil.size
        perf = pil
        if max(w, h) > PERF_MAX_DIM:
            scale = PERF_MAX_DIM / max(w, h)
            perf = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                              Image.LANCZOS)
        buf = _png_bytes(perf)
        _atomic_write_bytes(perf_path, buf)
    # hq DDS (native, verbatim)
    hq_path = TEX_HQ_DIR / f"{tex_key}.dds"
    if force or not hq_path.exists():
        _atomic_write_bytes(hq_path, src.read_bytes())

    arr = np.asarray(pil.convert("RGB"), np.float32) / 255.0
    cache[tex_key] = arr
    return tex_key, arr


def resolve_teammask(msh_dir: Path, mask_dds_name: str, out_key: str, cache: set):
    """Resolve + emit a team-color mask `.dds` to textures/teamcolor/<out_key>.png
    (<=512px, RGBA preserved: alpha = colorizable region, RGB = shading). Keyed by
    the DIFFUSE/material stem (`out_key`) so the viewer maps material name -> mask.
    Perf PNG only (no HQ DDS set). Idempotent + atomic. Returns out_key or None.

    `cache` is a per-model set of already-emitted out_keys so groups sharing a
    diffuse only emit once."""
    if not mask_dds_name or not out_key:
        return None
    if out_key in cache:
        return out_key
    src = _find_diffuse_src(msh_dir, mask_dds_name)
    if src is None:
        return None
    src = Path(src)
    try:
        pil = decode_dds(src, max_dim=TEAMCOLOR_MAX_DIM).convert("RGBA")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    teammask decode failed {mask_dds_name}: {e}")
        return None
    w, h = pil.size
    if max(w, h) > TEAMCOLOR_MAX_DIM:
        scale = TEAMCOLOR_MAX_DIM / max(w, h)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                         Image.LANCZOS)
    force = _G["force"] if _G else False
    out_path = TEX_TEAMCOLOR_DIR / f"{out_key}.png"
    if force or not out_path.exists():
        _atomic_write_bytes(out_path, _png_bytes(pil))
    cache.add(out_key)
    return out_key


def _aux_name_candidates(tex_key: str, declared: str | None, suffix: str):
    """Candidate stems for an aux map (`_c` / `_e`) belonging to diffuse stem
    `tex_key`. The `.material`-declared name wins; the filename convention
    (trailing `_d` replaced by the suffix, e.g. fvtank00_d -> fvtank00_c, or
    plainly appended, e.g. ibgtow00 -> ibgtow00_c) is the fallback for inline
    materials with no `.material` file."""
    cands = []
    if declared:
        cands.append(_stem(declared))
    base = tex_key[:-2] if tex_key.endswith("_d") else tex_key
    for c in (f"{base}{suffix}", f"{tex_key}{suffix}"):
        if c not in cands:
            cands.append(c)
    return cands


def resolve_emissive(msh_dir: Path, tex_key: str, declared_dds: str | None, cache: set):
    """Resolve + emit an emissive glow map to textures/emissive/<tex_key>.png
    (<=512px RGB). Keyed by the DIFFUSE stem so the viewer maps material name ->
    emissive. Tries the `.material`-declared name first, then the `<stem>_e`
    filename convention (covers inline-material workshop models). Idempotent +
    atomic. Returns tex_key or None.

    `cache` is a per-model set of already-emitted tex_keys."""
    if not tex_key:
        return None
    if tex_key in cache:
        return tex_key
    src = None
    for cand in _aux_name_candidates(tex_key, declared_dds, "_e"):
        src = _find_diffuse_src(msh_dir, f"{cand}.dds")
        if src is not None:
            break
    if src is None:
        return None
    src = Path(src)
    try:
        pil = decode_dds(src, max_dim=EMISSIVE_MAX_DIM).convert("RGB")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    emissive decode failed {tex_key}: {e}")
        return None
    w, h = pil.size
    if max(w, h) > EMISSIVE_MAX_DIM:
        scale = EMISSIVE_MAX_DIM / max(w, h)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                         Image.LANCZOS)
    force = _G["force"] if _G else False
    out_path = TEX_EMISSIVE_DIR / f"{tex_key}.png"
    if force or not out_path.exists():
        _atomic_write_bytes(out_path, _png_bytes(pil))
    cache.add(tex_key)
    return tex_key


def resolve_normal(msh_dir: Path, tex_key: str, declared_dds: str | None, cache: set):
    """Resolve + emit a tangent-space normal map to textures/normal/<tex_key>.png
    (<=1024px RGB, standard [0,1] encoding with reconstructed Z -- the BC5S
    sources are decoded by dds_decode's BC5 path). Keyed by the DIFFUSE stem so
    the viewer maps material name -> normal map. Tries the `.material`-declared
    name first, then the `<stem>_n` filename convention. The PNG carries raw
    data bytes (no color management); _png_bytes recompresses losslessly.
    Idempotent + atomic. Returns tex_key or None.

    `cache` is a per-model set of already-emitted tex_keys."""
    if not tex_key:
        return None
    if tex_key in cache:
        return tex_key
    src = None
    for cand in _aux_name_candidates(tex_key, declared_dds, "_n"):
        src = _find_diffuse_src(msh_dir, f"{cand}.dds")
        if src is not None:
            break
    if src is None:
        return None
    src = Path(src)
    try:
        pil = decode_dds(src, max_dim=NORMAL_MAX_DIM).convert("RGB")
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    normal decode failed {tex_key}: {e}")
        return None
    w, h = pil.size
    if max(w, h) > NORMAL_MAX_DIM:
        scale = NORMAL_MAX_DIM / max(w, h)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                         Image.LANCZOS)
    force = _G["force"] if _G else False
    out_path = TEX_NORMAL_DIR / f"{tex_key}.png"
    if force or not out_path.exists():
        _atomic_write_bytes(out_path, _png_bytes(pil))
    cache.add(tex_key)
    return tex_key


def _roughness_lut(specular_power: float | None):
    """256-entry luminance -> roughness LUT implementing
    roughness = clamp((1 - L)^K * powerBias, MIN, 1). Higher specularPower =>
    narrower engine highlights => bias roughness lower."""
    bias = 1.0
    if specular_power and specular_power > 0:
        bias = 1.0 - 0.3 * math.log10(specular_power) / 2.0
    lut = []
    for v in range(256):
        lum = v / 255.0
        rough = ((1.0 - lum) ** SPEC_ROUGHNESS_K) * bias
        rough = min(1.0, max(SPEC_ROUGHNESS_MIN, rough))
        lut.append(min(255, max(0, round(rough * 255.0))))
    return lut


def _spec_gloss_band(img):
    """Pick the GAME-TRUE gloss channel from a decoded spec map (texture
    format v4+). BZCC convention: spec RGB = specular tint, ALPHA = gloss
    (high alpha = glossier). Use alpha whenever it carries authored data; fall
    back to RGB luminance for BC1 sources (the decoder emits flat 255 alpha)
    and for flat-255 BC3 alpha (ambiguous -- luminance is the safer read)."""
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    lo, hi = alpha.getextrema()
    if hi - lo == 0 and hi >= 250:
        return rgba.convert("L")
    return alpha


def _spec_band_to_roughness(band, lut):
    """Resize a gloss band to the spec budget and run it through the LUT."""
    w, h = band.size
    if max(w, h) > SPECULAR_MAX_DIM:
        scale = SPECULAR_MAX_DIM / max(w, h)
        band = band.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                           Image.LANCZOS)
    return band.point(lut)


def resolve_specular(msh_dir: Path, tex_key: str, declared_dds: str | None,
                     specular_power: float | None, cache: set):
    """Resolve a legacy spec/gloss map and emit BOTH roughness conversions
    (<=512px grayscale; three.js samples the green channel and browsers decode
    gray PNGs to replicated RGB, so L mode works):

      textures/specular/<tex_key>.png       RGB-luminance gloss -- the v3
                                            "stylized glossy" look, the
                                            viewer DEFAULT
      textures/specular_true/<tex_key>.png  ALPHA gloss channel (BZCC's
                                            authored convention) -- the
                                            viewer's opt-in True lighting

    Keyed by the DIFFUSE stem. Tries the `.material`-declared name first,
    then the `<stem>_s` filename convention. Decode once, emit twice; each
    write keeps its own exists-skip. Idempotent + atomic. Returns tex_key or
    None.

    `cache` is a per-model set of already-emitted tex_keys."""
    if not tex_key:
        return None
    if tex_key in cache:
        return tex_key
    src = None
    for cand in _aux_name_candidates(tex_key, declared_dds, "_s"):
        src = _find_diffuse_src(msh_dir, f"{cand}.dds")
        if src is not None:
            break
    if src is None:
        return None
    src = Path(src)
    try:
        decoded = decode_dds(src, max_dim=SPECULAR_MAX_DIM)
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    specular decode failed {tex_key}: {e}")
        return None
    lut = _roughness_lut(specular_power)
    force = _G["force"] if _G else False
    for out_dir, band in (
        (TEX_SPECULAR_DIR, decoded.convert("L")),
        (TEX_SPECULAR_TRUE_DIR, _spec_gloss_band(decoded)),
    ):
        out_path = out_dir / f"{tex_key}.png"
        if force or not out_path.exists():
            _atomic_write_bytes(out_path,
                                _png_bytes(_spec_band_to_roughness(band, lut)))
    cache.add(tex_key)
    return tex_key


def _emit_mod_png(src: Path, out_path: Path, max_dim: int, mode: str) -> bool:
    """Decode a mod-pack `.dds` and write it as a <=max_dim PNG (idempotent +
    atomic). `mode` is the PIL conversion ('RGBA' for masks, 'RGB' otherwise;
    specular goes through _emit_mod_spec instead)."""
    force = _G["force"] if _G else False
    if not force and out_path.exists():
        return True
    try:
        pil = decode_dds(src, max_dim=max_dim).convert(mode)
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    mod tex decode failed {src.name}: {e}")
        return False
    w, h = pil.size
    if max(w, h) > max_dim:
        scale = max_dim / max(w, h)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))),
                         Image.LANCZOS)
    _atomic_write_bytes(out_path, _png_bytes(pil))
    return True


def _emit_mod_spec(src: Path, pack_dir: Path, tex_key: str, lut: list) -> bool:
    """Mod-pack counterpart of resolve_specular's dual emit: decode the pack's
    `_s.dds` once and write both roughness variants -- specular/ (luminance,
    viewer default) + specular_true/ (alpha gloss channel, True lighting).
    Idempotent + atomic per output."""
    force = _G["force"] if _G else False
    out_def = pack_dir / "specular" / f"{tex_key}.png"
    out_true = pack_dir / "specular_true" / f"{tex_key}.png"
    if not force and out_def.exists() and out_true.exists():
        return True
    try:
        decoded = decode_dds(src, max_dim=SPECULAR_MAX_DIM)
    except (UnsupportedDDS, Exception) as e:  # noqa: BLE001
        if _G and _G.get("verbose"):
            print(f"    mod spec decode failed {src.name}: {e}")
        return False
    for out_path, band in (
        (out_def, decoded.convert("L")),
        (out_true, _spec_gloss_band(decoded)),
    ):
        if force or not out_path.exists():
            _atomic_write_bytes(out_path,
                                _png_bytes(_spec_band_to_roughness(band, lut)))
    return True


def emit_mod_texture_sets(tex_keys: set, aux_names: dict) -> list:
    """For every registered mod texture pack, intersect the pack's DDS index with
    this model's resolved diffuse stems and emit the pack's overrides under
    textures/mods/<pack_id>/: perf PNG + verbatim HQ DDS for the diffuse, plus
    teamcolor / emissive / normal / specular PNGs when the pack carries them.
    Returns the model's `textureSets` manifest block (packs with >=1 diffuse hit
    only).

    `aux_names` maps tex_key -> (declared_teamcolor_dds, declared_emissive_dds,
    declared_normal_dds, declared_specular_dds, specular_power) from the stock
    `.material`, used to name-match the pack's aux maps (and convert the pack's
    spec map with the same gloss hint as stock)."""
    mod_indexes = (_G or {}).get("mod_indexes") or {}
    if not mod_indexes or not tex_keys:
        return []
    force = _G["force"] if _G else False
    sets = []
    for pack_id, idx in mod_indexes.items():
        hit_tex, hit_team, hit_emis = [], [], []
        hit_norm, hit_spec = [], []
        pack_dir = TEX_MODS_DIR / pack_id
        for tex_key in sorted(tex_keys):
            src_str = idx.get(tex_key)
            if not src_str:
                continue
            src = Path(src_str)
            if not _emit_mod_png(src, pack_dir / "perf" / f"{tex_key}.png",
                                 PERF_MAX_DIM, "RGBA"):
                continue
            hq_path = pack_dir / "hq" / f"{tex_key}.dds"
            if force or not hq_path.exists():
                _atomic_write_bytes(hq_path, src.read_bytes())
            hit_tex.append(tex_key)

            team_decl, emis_decl, norm_decl, spec_decl, spec_power = \
                aux_names.get(tex_key, (None, None, None, None, None))
            for cand in _aux_name_candidates(tex_key, team_decl, "_c"):
                cand_src = idx.get(cand)
                if cand_src and _emit_mod_png(
                        Path(cand_src), pack_dir / "teamcolor" / f"{tex_key}.png",
                        TEAMCOLOR_MAX_DIM, "RGBA"):
                    hit_team.append(tex_key)
                    break
            for cand in _aux_name_candidates(tex_key, emis_decl, "_e"):
                cand_src = idx.get(cand)
                if cand_src and _emit_mod_png(
                        Path(cand_src), pack_dir / "emissive" / f"{tex_key}.png",
                        EMISSIVE_MAX_DIM, "RGB"):
                    hit_emis.append(tex_key)
                    break
            for cand in _aux_name_candidates(tex_key, norm_decl, "_n"):
                cand_src = idx.get(cand)
                if cand_src and _emit_mod_png(
                        Path(cand_src), pack_dir / "normal" / f"{tex_key}.png",
                        NORMAL_MAX_DIM, "RGB"):
                    hit_norm.append(tex_key)
                    break
            for cand in _aux_name_candidates(tex_key, spec_decl, "_s"):
                cand_src = idx.get(cand)
                if cand_src and _emit_mod_spec(
                        Path(cand_src), pack_dir, tex_key,
                        _roughness_lut(spec_power)):
                    hit_spec.append(tex_key)
                    break
        if hit_tex:
            sets.append({"id": pack_id, "textures": hit_tex,
                         "teamColorTextures": hit_team,
                         "emissiveTextures": hit_emis,
                         "normalTextures": hit_norm,
                         "specularTextures": hit_spec})
    return sets


def _png_bytes(img: Image.Image) -> bytes:
    import io
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


# ----------------------------- per-model conversion -----------------------------


def _build_groups(mesh, msh_dir: Path, handedness_fix: bool):
    """Weld each material group once into (positions, normals, uvs, indices) +
    resolve its material (name, base color, texture array). Returns the GLB
    builder, the rasterizer prim list, the set of textured material keys, the
    sets of texture keys that also emitted a team-color mask / emissive map /
    normal map / specular(roughness) map, a dict of declared aux map names per
    texture key (for the mod texture-set pass), and the set of texture stems
    that were referenced but did NOT resolve to a `.dds` (missing-texture
    report)."""
    gb = GlbBuilder()
    prims = []
    tex_keys = set()
    teammask_keys = set()
    emissive_keys = set()
    normal_keys = set()
    specular_keys = set()
    aux_names: dict = {}
    unresolved = set()
    tex_cache: dict = {}
    teammask_cache: set = set()
    emissive_cache: set = set()
    normal_cache: set = set()
    specular_cache: set = set()
    zf = -1.0 if handedness_fix else 1.0

    for gi, g in enumerate(mesh.groups):
        if g.hidden or not g.tris:
            continue
        (rgba, mat_diffuse, mat_teamcolor, mat_emissive,
         mat_normal, mat_specular, mat_spec_power) = parse_material(msh_dir, g.material)
        # The MSH-embedded diffuse name (g.texture) wins -- workshop models
        # (Cerberi etc.) use inline material names with no `.material` file but
        # carry the diffuse here; the `.material` [texture] diffuse is the
        # fallback for game-baked models where g.texture is empty.
        diffuse_dds = g.texture or mat_diffuse
        tex_key = None
        tex_arr = None
        if diffuse_dds:
            res = resolve_diffuse(msh_dir, diffuse_dds, tex_cache)
            if res:
                tex_key, tex_arr = res
                tex_keys.add(tex_key)
            else:
                unresolved.add(_stem(diffuse_dds))
        base_color = (1.0, 1.0, 1.0, 1.0) if tex_key else rgba
        mat_name = tex_key or (_stem(g.material) if g.material else f"mat{gi}")
        # Team-color mask: emit only for textured groups (need the diffuse stem as
        # the key so the viewer maps material name -> mask). The mask is keyed by
        # the diffuse stem (mat_name), NOT the `_c` stem.
        if tex_key and mat_teamcolor:
            if resolve_teammask(msh_dir, mat_teamcolor, tex_key, teammask_cache):
                teammask_keys.add(tex_key)
        # Emissive / normal / specular maps: same diffuse-stem keying. Each
        # falls back to its filename convention (`_e` / `_n` / `_s`) when no
        # `.material` declares one (covers inline-material workshop models).
        if tex_key:
            aux_names[tex_key] = (mat_teamcolor, mat_emissive,
                                  mat_normal, mat_specular, mat_spec_power)
            if resolve_emissive(msh_dir, tex_key, mat_emissive, emissive_cache):
                emissive_keys.add(tex_key)
            if resolve_normal(msh_dir, tex_key, mat_normal, normal_cache):
                normal_keys.add(tex_key)
            if resolve_specular(msh_dir, tex_key, mat_specular, mat_spec_power,
                                specular_cache):
                specular_keys.add(tex_key)

        weld = {}
        positions, normals, uvs, indices = [], [], [], []

        def corner_index(c):
            pos = (c["pos"][0], c["pos"][1], c["pos"][2] * zf)
            nrm = (c["norm"][0], c["norm"][1], c["norm"][2] * zf)
            uv = (c["uv"][0], c["uv"][1])
            key = (round(pos[0], 5), round(pos[1], 5), round(pos[2], 5),
                   round(nrm[0], 4), round(nrm[1], 4), round(nrm[2], 4),
                   round(uv[0], 5), round(uv[1], 5))
            i = weld.get(key)
            if i is None:
                i = len(positions)
                weld[key] = i
                positions.append(pos)
                normals.append(nrm)
                uvs.append(uv)
            return i

        for tri in g.tris:
            a = corner_index(tri[0])
            b = corner_index(tri[1])
            c = corner_index(tri[2])
            if handedness_fix:
                indices.extend((a, c, b))  # reverse winding LH->RH
            else:
                indices.extend((a, b, c))

        mat_idx = gb.add_material(name=mat_name, base_color=base_color,
                                  double_sided=g.two_sided)
        gb.add_primitive(positions, normals, uvs, indices, material=mat_idx)
        prims.append({
            "positions": np.asarray(positions, np.float64),
            "normals": np.asarray(normals, np.float64),
            "uvs": np.asarray(uvs, np.float64),
            "indices": indices,
            "color": np.asarray(base_color[:3], np.float32),
            "tex": tex_arr,
        })

    return (gb, prims, tex_keys, teammask_keys, emissive_keys,
            normal_keys, specular_keys, aux_names, unresolved)


def process_model(job: dict) -> dict:
    """Worker entrypoint: parse + convert + texture + render one model. Returns
    a manifest entry (with an 'error' key on failure)."""
    stem = job["stem"]
    try:
        cfg = _G
        msh_path = Path(job["msh"])
        meshes = parse_msh(msh_path)
        if not meshes:
            return {"stem": stem, "error": "no blocks parsed"}
        mesh = meshes[0]

        (gb, prims, tex_keys, teammask_keys, emissive_keys,
         normal_keys, specular_keys, aux_names, unresolved) = \
            _build_groups(mesh, msh_path.parent, cfg["handedness"])
        if not prims:
            return {"stem": stem, "error": "no renderable groups"}

        # Workshop mod texture-override sets (diffuse + teamcolor + emissive),
        # keyed by the same diffuse stems. Idempotent like the stock emits above.
        texture_sets = emit_mod_texture_sets(tex_keys, aux_names)

        GEO_DIR.mkdir(parents=True, exist_ok=True)

        # GLB-write guard: when the existing geometry GLB is already fresh (e.g. a
        # texture-format-only regen to emit the new team-color masks), `_build_groups`
        # above has already re-emitted the diffuse + masks idempotently, so we skip
        # the geometry GLB rewrite + animated rebuild + thumbnail render entirely and
        # reuse the prior entry's animated/clips/parts/shots. This keeps a team-color
        # regen from churning the ~700 deterministic GLBs.
        glb_fresh = bool(job.get("glb_fresh"))
        clips = []
        animated = False
        parts = None
        glb_bytes = b""
        if glb_fresh:
            animated = job.get("prior_animated", False)
            clips = job.get("prior_clips", []) or []
            parts = job.get("prior_parts")
            shots = job.get("prior_shots") or []
        else:
            glb_bytes = gb.to_bytes(node_name=mesh.name or stem)

            # Animated models: replace the welded GLB with a node-hierarchy /
            # SkinnedMesh GLB carrying the baked clips. Materials are named by the same
            # texture stems so the viewer's runtime texture assignment is unchanged.
            # Thumbnails + stats below still come from the welded `prims` (rest pose).
            try:
                full = parse_msh_full(msh_path)
            except Exception:  # noqa: BLE001
                full = None
            # Emit a node-hierarchy GLB (preserving named moveable parts: turret_y /
            # turret_x / recoil* nodes + the tread material) whenever the mesh has
            # baked clips OR is a rigid multi-part model. Welding is kept only for
            # single-node rigid meshes and skinned meshes without clips (skinned
            # needs the dedicated skin path, which is only built when clips exist).
            rigid_multinode = bool(
                full and not full.get("skinned") and _renderable_node_count(full) > 1)
            if full and (full.get("clips") or rigid_multinode):
                def _resolve_tex_key(msh_dir, mat_name, tex_name):
                    diffuse = tex_name
                    if not diffuse and mat_name:
                        try:
                            diffuse = parse_material(Path(msh_dir), mat_name)[1]
                        except Exception:  # noqa: BLE001
                            diffuse = None
                    return _stem(diffuse) if diffuse else None
                try:
                    anim_bytes, clips = build_animated_glb(full, _resolve_tex_key)
                    glb_bytes = anim_bytes
                    animated = bool(clips)
                except Exception:  # noqa: BLE001 - fall back to the welded GLB
                    if cfg.get("verbose"):
                        print(f"    [{stem}] node-hierarchy GLB failed; using welded:\n"
                              f"{traceback.format_exc(limit=2)}")
                    clips = []
                parts = _classify_parts(full, clips, job.get("odf_art"))

            _atomic_write_bytes(GEO_DIR / f"{stem}.glb", glb_bytes)

            shots = []
            if cfg["render"]:
                written = msh_thumbnail.render_model(
                    prims, OUT_DIR, stem,
                    hero_size=cfg["hero_size"], gallery_size=cfg["gallery_size"],
                    supersample=cfg["supersample"], want_gallery=cfg["gallery"],
                )
                shots = written.get("shots", [])
            elif job.get("prior_shots"):
                # --no-render: keep the existing (committed) gallery references rather
                # than emitting [] when reprocessing only the GLB (e.g. anim regen).
                shots = job["prior_shots"]

        lo, hi = mesh.bbox()
        tris = sum(len(g.tris) for g in mesh.groups if not g.hidden)
        groups = len([g for g in mesh.groups if not g.hidden and g.tris])
        return {
            "stem": stem,
            "glb": f"geometry/{stem}.glb",
            "thumb": f"thumbnails/{stem}.png",
            "shots": shots,
            "unitName": job["unitName"],
            "primaryOdf": job["primaryOdf"],
            "odfs": job["odfs"],
            "category": job["category"],
            "factionCode": job["factionCode"],
            "factionName": job["factionName"],
            "triangles": tris,
            "groups": groups,
            "textures": sorted(tex_keys),
            "teamColorTextures": sorted(teammask_keys),
            "emissiveTextures": sorted(emissive_keys),
            "normalTextures": sorted(normal_keys),
            "specularTextures": sorted(specular_keys),
            "textureSets": texture_sets,
            "unresolvedTextures": sorted(unresolved - tex_keys),
            "radius": round(mesh.radius, 3),
            "bboxSize": [round(hi[i] - lo[i], 3) for i in range(3)],
            "animated": animated,
            "clips": clips,
            "parts": parts,
            "drive": job.get("drive"),
            "loadouts": job.get("loadouts"),
            "defaultLoadoutOdf": job.get("defaultLoadoutOdf"),
            "lights": job.get("lights"),
            "snipe": job.get("snipe"),
            "collisionRadiiByOdf": job.get("collisionRadiiByOdf"),
            "_glb_bytes": len(glb_bytes),
        }
    except Exception as e:  # noqa: BLE001 - resilient over ~700 models
        return {"stem": stem, "error": f"{e!r}",
                "trace": traceback.format_exc(limit=3)}


def _worker_init(dds_index, mat_index, dds_index_all, mat_index_all, cfg):
    global _G
    _G = {"dds_index": dds_index, "mat_index": mat_index,
          "dds_index_all": dds_index_all, "mat_index_all": mat_index_all, **cfg}


# ----------------------------- caching -----------------------------


def _outputs_fresh(stem: str, msh_path: Path, want_gallery: bool) -> bool:
    glb = GEO_DIR / f"{stem}.glb"
    thumb = OUT_DIR / "thumbnails" / f"{stem}.png"
    if not glb.exists() or not thumb.exists():
        return False
    if glb.stat().st_mtime < msh_path.stat().st_mtime:
        return False
    if want_gallery:
        shot_dir = OUT_DIR / "shots" / stem
        if not shot_dir.is_dir():
            return False
        if sum(1 for _ in shot_dir.glob("*.png")) < len(msh_thumbnail.ANGLES):
            return False
    return True


def _cached_entry(stem: str, meta: dict, prior: dict) -> dict:
    """Reuse a prior index.json entry's geometry stats, refreshing the ODF /
    category / faction fields from the current enumeration."""
    p = prior.get(stem, {})
    return {
        "stem": stem,
        "glb": f"geometry/{stem}.glb",
        "thumb": f"thumbnails/{stem}.png",
        "shots": p.get("shots", [
            f"shots/{stem}/{a}.png" for a in msh_thumbnail.ANGLES]),
        "unitName": meta["unitName"],
        "primaryOdf": meta["primaryOdf"],
        "odfs": meta["odfs"],
        "category": meta["category"],
        "factionCode": meta["factionCode"],
        "factionName": meta["factionName"],
        "triangles": p.get("triangles", 0),
        "groups": p.get("groups", 0),
        "textures": p.get("textures", []),
        "teamColorTextures": p.get("teamColorTextures", []),
        "emissiveTextures": p.get("emissiveTextures", []),
        "normalTextures": p.get("normalTextures", []),
        "specularTextures": p.get("specularTextures", []),
        "textureSets": p.get("textureSets", []),
        "unresolvedTextures": p.get("unresolvedTextures", []),
        "radius": p.get("radius", 0),
        "bboxSize": p.get("bboxSize", [0, 0, 0]),
        "animated": p.get("animated", False),
        "clips": p.get("clips", []),
        "parts": p.get("parts"),
        "drive": meta.get("drive"),
        "loadouts": meta.get("loadouts"),
        "defaultLoadoutOdf": meta.get("defaultLoadoutOdf"),
        "lights": meta.get("lights"),
        "snipe": meta.get("snipe"),
        "collisionRadiiByOdf": meta.get("collisionRadiiByOdf"),
    }


# ----------------------------- main -----------------------------


def main():
    ap = argparse.ArgumentParser(description="Convert all baked BZCC .msh to .glb + textures + gallery")
    ap.add_argument("--odf", nargs="*", default=None,
                    help="Only convert meshes referenced by these ODFs (default: all).")
    ap.add_argument("--steam-base", default=None)
    ap.add_argument("--no-handedness-fix", action="store_true")
    ap.add_argument("--no-render", action="store_true",
                    help="Skip thumbnail + gallery (geometry + textures only).")
    ap.add_argument("--no-gallery", action="store_true",
                    help="Hero thumbnail only; skip the 7-angle gallery.")
    ap.add_argument("--hero-size", type=int, default=256)
    ap.add_argument("--gallery-size", type=int, default=512)
    ap.add_argument("--supersample", type=int, default=2)
    ap.add_argument("--limit", type=int, default=None, help="Cap to N models (smoke run).")
    ap.add_argument("--force", action="store_true", help="Reprocess even if cached.")
    ap.add_argument("--jobs", type=int, default=1, help="Parallel worker processes.")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    t0 = time.perf_counter()
    odf_filter = set(args.odf) if args.odf else None
    targets = enumerate_targets(odf_filter)
    print(f"enumerated {len(targets)} unique mesh stems from {ODF_DB.name}")

    roots = resolve_roots(args.steam_base)
    print(f"resolved {len(roots)} asset roots")
    msh_index = build_file_index(roots, "msh")
    dds_index = build_file_index(roots, "dds")
    mat_index = build_file_index(roots, "material")
    print(f"indexed {len(msh_index)} .msh, {len(dds_index)} .dds, {len(mat_index)} .material (VSR-scoped)")
    ws_dir = workshop_content_dir(args.steam_base)
    dds_index_all = build_workshop_index(ws_dir, "dds")
    mat_index_all = build_workshop_index(ws_dir, "material")
    print(f"full-workshop fallback: {len(dds_index_all)} .dds, {len(mat_index_all)} .material ({ws_dir})")

    # Mod texture packs: per-pack {stem: path} DDS index. Missing pack dirs are
    # soft-skipped so the pipeline still runs on machines without them installed.
    mod_indexes = {}
    for pack in MOD_TEXTURE_PACKS:
        pack_dir = Path(ws_dir) / pack["id"] if ws_dir else None
        if not pack_dir or not pack_dir.is_dir():
            print(f"mod pack NOT installed, skipped: {pack['label']} ({pack['id']})")
            continue
        idx = {p.stem.lower(): str(p) for p in pack_dir.rglob("*.dds")}
        mod_indexes[pack["id"]] = idx
        print(f"mod pack: {pack['label']} ({pack['id']}): {len(idx)} .dds")

    # Resolve each target to a baked .msh; record the misses.
    resolved = []
    missing = []
    for stem, meta in sorted(targets.items()):
        mp = msh_index.get(stem)
        if mp is None:
            missing.append(stem)
            continue
        resolved.append((stem, meta, mp))
    print(f"resolved {len(resolved)} meshes, {len(missing)} missing (no baked .msh)")
    if args.verbose and missing:
        print("  missing:", ", ".join(sorted(missing)))

    if args.limit:
        resolved = resolved[:args.limit]
        print(f"--limit: capped to {len(resolved)} models")

    for d in (GEO_DIR, TEX_PERF_DIR, TEX_HQ_DIR, TEX_TEAMCOLOR_DIR, TEX_EMISSIVE_DIR,
              TEX_NORMAL_DIR, TEX_SPECULAR_DIR, TEX_SPECULAR_TRUE_DIR,
              OUT_DIR / "thumbnails"):
        d.mkdir(parents=True, exist_ok=True)
    for pack_id in mod_indexes:
        for sub in ("perf", "hq", "teamcolor", "emissive", "normal",
                    "specular", "specular_true"):
            (TEX_MODS_DIR / pack_id / sub).mkdir(parents=True, exist_ok=True)

    # Prior manifest (for cache reuse of geometry stats). A change in
    # ANIM_FORMAT_VERSION forces a full regen (the GLB shape changed even though
    # the source meshes did not, so mtime-based freshness can't catch it). A
    # change in TEXTURE_FORMAT_VERSION forces a TEXTURE-only re-emit: otherwise-
    # fresh models are reprocessed but the GLB write is guarded (skipped) so the
    # geometry GLBs don't churn -- only the new texture set + index.json change.
    prior = {}
    prior_anim_version = None
    prior_tex_version = None
    idx_path = OUT_DIR / "index.json"
    if idx_path.exists():
        try:
            prior_doc = json.loads(idx_path.read_text(encoding="utf-8"))
            prior_anim_version = prior_doc.get("anim_format_version")
            prior_tex_version = prior_doc.get("texture_format_version")
            prior = {m["stem"]: m for m in prior_doc.get("models", []) if "stem" in m}
        except (json.JSONDecodeError, KeyError):
            prior = {}
    anim_version_changed = prior_anim_version != ANIM_FORMAT_VERSION
    tex_version_changed = prior_tex_version != TEXTURE_FORMAT_VERSION
    if anim_version_changed and prior:
        print(f"anim_format_version {prior_anim_version} -> {ANIM_FORMAT_VERSION}: "
              f"forcing full regen")
    if tex_version_changed and prior and not anim_version_changed:
        print(f"texture_format_version {prior_tex_version} -> {TEXTURE_FORMAT_VERSION}: "
              f"re-emitting textures (GLB writes guarded)")
    # `force` = full rebuild incl. geometry GLB. A texture-version bump alone does
    # NOT set force -- it only re-runs fresh models with glb_fresh=True so the GLB
    # write is skipped.
    force = args.force or anim_version_changed

    want_gallery = not args.no_gallery and not args.no_render
    cfg = {
        "handedness": not args.no_handedness_fix,
        "render": not args.no_render,
        "gallery": not args.no_gallery,
        "hero_size": args.hero_size,
        "gallery_size": args.gallery_size,
        "supersample": args.supersample,
        "force": args.force,
        "verbose": args.verbose,
        "mod_indexes": mod_indexes,
    }

    # Partition into cache-hits (reuse prior entry) and jobs (process). When only
    # the texture version changed, an otherwise-fresh model is reprocessed with
    # glb_fresh=True (emit textures/masks, skip the GLB rewrite + render).
    jobs = []
    manifest = []
    cached = 0
    for stem, meta, mp in resolved:
        fresh = stem in prior and _outputs_fresh(stem, mp, want_gallery)
        if not force and fresh and not tex_version_changed:
            manifest.append(_cached_entry(stem, meta, prior))
            cached += 1
            continue
        glb_fresh = (not force) and fresh   # GLB reusable -> texture-only re-emit
        p = prior.get(stem, {})
        jobs.append({"stem": stem, "msh": str(mp),
                     "prior_shots": p.get("shots"),
                     "glb_fresh": glb_fresh,
                     "prior_animated": p.get("animated", False),
                     "prior_clips": p.get("clips", []),
                     "prior_parts": p.get("parts"),
                     **meta})

    print(f"{cached} cached, {len(jobs)} to process "
          f"(jobs={args.jobs}, render={cfg['render']}, gallery={cfg['gallery']})")

    errors = []
    done = 0

    def _handle(entry):
        nonlocal done
        done += 1
        if "error" in entry:
            errors.append(entry)
            print(f"  [{done}/{len(jobs)}] FAIL {entry['stem']}: {entry['error']}")
        else:
            manifest.append({k: v for k, v in entry.items() if not k.startswith("_")})
            if args.verbose or done % 25 == 0 or done == len(jobs):
                kb = entry.get("_glb_bytes", 0) // 1024
                print(f"  [{done}/{len(jobs)}] OK {entry['stem']:20s} "
                      f"{entry['triangles']:>6d} tris, {len(entry['textures'])} tex, {kb} KB")

    if jobs:
        if args.jobs > 1:
            with ProcessPoolExecutor(
                max_workers=args.jobs,
                initializer=_worker_init,
                initargs=(dds_index, mat_index, dds_index_all, mat_index_all, cfg),
            ) as ex:
                futs = [ex.submit(process_model, j) for j in jobs]
                for f in as_completed(futs):
                    _handle(f.result())
        else:
            _worker_init(dds_index, mat_index, dds_index_all, mat_index_all, cfg)
            for j in jobs:
                _handle(process_model(j))

    # Assemble + write the manifest.
    manifest.sort(key=lambda e: (e.get("category") or "", e.get("unitName") or "", e["stem"]))
    odf_index = {}
    for m in manifest:
        for odf in m.get("odfs", []):
            odf_index[odf] = m["stem"]

    # Missing-texture report: models with no resolved diffuse, split into those
    # that referenced a `.dds` we couldn't find (unresolved) vs. genuinely
    # untextured (no texture name anywhere).
    no_tex = [m for m in manifest if not m.get("textures")]
    unresolved = {m["stem"]: m["unresolvedTextures"]
                  for m in no_tex if m.get("unresolvedTextures")}
    genuinely = sorted(m["stem"] for m in no_tex if not m.get("unresolvedTextures"))
    texture_report = {
        "models_total": len(manifest),
        "models_textured": len(manifest) - len(no_tex),
        "models_no_texture": len(no_tex),
        "models_unresolved_refs": len(unresolved),
        "genuinely_untextured": genuinely,
        "unresolved": dict(sorted(unresolved.items())),
    }
    animated_count = sum(1 for m in manifest if m.get("animated"))
    teamcolor_count = sum(1 for m in manifest if m.get("teamColorTextures"))
    emissive_count = sum(1 for m in manifest if m.get("emissiveTextures"))
    normal_count = sum(1 for m in manifest if m.get("normalTextures"))
    specular_count = sum(1 for m in manifest if m.get("specularTextures"))
    modskin_count = sum(1 for m in manifest if m.get("textureSets"))
    loadout_count = sum(1 for m in manifest if m.get("loadouts"))
    lights_count = sum(1 for m in manifest if m.get("lights"))
    snipe_count = sum(1 for m in manifest if (m.get("snipe") or {}).get("canSnipe"))
    collision_count = sum(1 for m in manifest if m.get("collisionRadiiByOdf"))
    idx_path.write_text(json.dumps({
        "schema_version": 18,
        "anim_format_version": ANIM_FORMAT_VERSION,
        "texture_format_version": TEXTURE_FORMAT_VERSION,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(manifest),
        "animated_count": animated_count,
        "teamcolor_count": teamcolor_count,
        "emissive_count": emissive_count,
        "normal_count": normal_count,
        "specular_count": specular_count,
        "modskin_count": modskin_count,
        "loadout_count": loadout_count,
        "lights_count": lights_count,
        "snipe_count": snipe_count,
        "collision_count": collision_count,
        "texture_packs": {p["id"]: {"label": p["label"], "url": p["url"]}
                          for p in MOD_TEXTURE_PACKS},
        "texture_report": texture_report,
        "models": manifest,
        "odf_index": odf_index,
    }, indent=2), encoding="utf-8")

    dt = time.perf_counter() - t0
    print(f"\nwrote {idx_path} -- {len(manifest)} models "
          f"({cached} cached, {len(jobs) - len(errors)} processed, {len(errors)} failed, "
          f"{animated_count} animated, {teamcolor_count} team-colorable, "
          f"{emissive_count} emissive, {normal_count} normal-mapped, "
          f"{specular_count} roughness-mapped, {modskin_count} with mod skins, "
          f"{loadout_count} with loadouts, {lights_count} with lights, "
          f"{collision_count} with collision radii)")
    print(f"textures: {texture_report['models_textured']} textured, "
          f"{texture_report['models_no_texture']} without "
          f"({texture_report['models_unresolved_refs']} have unresolved refs, "
          f"{len(genuinely)} genuinely untextured)")
    if unresolved:
        miss = sorted({n for names in unresolved.values() for n in names})
        print(f"  unresolved texture stems ({len(miss)}): {', '.join(miss)}")
    print(f"elapsed {dt:.1f}s")
    if errors and args.verbose:
        for e in errors[:20]:
            print(f"  ! {e['stem']}: {e.get('trace', e['error'])}")


if __name__ == "__main__":
    main()
