#!/usr/bin/env python3
"""
VT Stats Processing Pipeline

Reads .binpb.gz protobuf session files from data/sessions/<username>/,
aggregates match statistics, and outputs pre-computed JSON files to
data/processed/ for browser consumption.
"""

import argparse
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

import statsgate_pb2

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
SESSIONS_DIR = PROJECT_ROOT / "data" / "sessions"
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"
ODF_PATH = PROJECT_ROOT / "data" / "odf.min.json"
STEAMID_TO_NAME_PATH = PROJECT_ROOT / "data" / "steamid_to_name.txt"

# Sibling git clone of the upstream statsgate repo. Sync mode (default) does
# `git pull --ff-only` here and additively mirrors any new .binpb.gz files
# into SESSIONS_DIR before processing. Soft-skips if missing so the
# manual-drop-only workflow doesn't require --no-sync.
STATSGATE_DIR = PROJECT_ROOT / "statsgate"
STATSGATE_SESSIONS_DIR = STATSGATE_DIR / "sessions"

# Cache invalidator for incremental processing. Bump this whenever
# process_match() output semantics change (new fields, value tweaks, or any
# helper it transitively calls -- positioning, highlights, weapon meta,
# rivalry matrices, _extract_contribution, etc.). Cached per-match JSONs
# whose match.pipeline_version != this constant are reprocessed from the
# raw .binpb.gz on the next run. Orthogonal to match.schema_version: that
# one is a frontend contract (the JS reads it to decide rendering);
# pipeline_version is an internal cache invalidator only.
PIPELINE_VERSION = 12

TIMELINE_BUCKET_SECONDS = 10

# --- Positioning (player movement) constants ---
# Axis convention: +X East, +Y Up, +Z North (developer-confirmed for Z).
# Horizontal plane = (x, z); all distance/path math ignores y.

POSITIONING_SAMPLE_RATE_HZ = 1  # downsample UpdateTicks to 1 Hz regardless of source tick_rate
POSITIONING_SPAWN_SAMPLES = 3  # median of first N kept samples = spawn reference
POSITIONING_TELEPORT_MIN_SPEED = 300.0  # u/s floor for teleport detection (self-calibrates upward)
POSITIONING_TELEPORT_P99_MULT = 2.0  # teleport_threshold = max(MIN, p99_speed * this)
POSITIONING_BASE_RADIUS_FRACTION = 0.15  # R_base = this * base_separation
POSITIONING_MIN_BASE_SEPARATION = 500.0  # safety floor for base_separation
POSITIONING_BASE_SEP_MAXRANGE_FRAC = 0.3  # base_separation also floored at observed_max_range * this
POSITIONING_PERSONAL_RADIUS_MIN = 100.0
POSITIONING_PERSONAL_RADIUS_MAX = 400.0
POSITIONING_PERSONAL_RADIUS_FALLBACK = 150.0
POSITIONING_RETURN_HYSTERESIS_OUT = 1.2  # out when dist > R_base * this
POSITIONING_RETURN_HYSTERESIS_IN = 0.8  # in when dist < R_base * this
POSITIONING_RETURN_MIN_OUT_SEC = 5  # must be sustained outside this many seconds before a return counts
POSITIONING_HEATMAP_GRID_SIZE = 32
POSITIONING_POLAR_ANGULAR_BINS = 16
POSITIONING_POLAR_RADIAL_BINS = 8

# Sentinel damage filter. The BZCC engine's DAMAGE_TYPE_UNKNOWN force-kill
# pathway emits DamageDealt/DamageReceived pairs with amount = 2^28
# (268435456.0) through the mission DLL's damage callback at
# misnexport2 + 0x1c. These events have no shooter, no victim, and no
# ordnance_odf, and are not real combat damage. Any event with
# amount > SENTINEL_DAMAGE_THRESHOLD is dropped before aggregation.
# Threshold matches the upstream collector's unusual_damage.txt diagnostic
# threshold (real BZCC combat per-event amounts top out in low tens of
# thousands; SENTINEL threshold is ~100x above any legitimate event).
# See docs/DATA_DICTIONARY.md §7 "Sentinel Damage Filter" for full evidence chain.
SENTINEL_DAMAGE_THRESHOLD = 1e6

# ODFs to drop from `kills.by_vehicle` only. Non-combatant objects that the
# engine emits UnitDestroyed events for (e.g. APC-deployed scrap/service pods)
# spam the Vehicle Destruction Breakdown chart with counts an order of
# magnitude larger than real player vehicles, squashing every real bar against
# the y-axis. After the 4-way classification (KNOWN_POWERUP_ODFS /
# KNOWN_DEPLOYABLE_ODFS) suppresses pickups + destructions + deployables, the
# remaining ~13% of `apserv_vsr.odf` destructions still come from real
# combat shots; this chart-only filter hides those residual events from
# the Vehicle Destruction Breakdown so it stays focused on real vehicles.
# The raw events still flow through `kill_feed`, `odf_map`,
# `powerup_destructions.feed`, and the Raw Data Browser untouched -- only
# the leaderboard summary is filtered. Match keys lowercased for safety.
VEHICLE_DESTRUCTION_IGNORE_ODFS = frozenset({
    "apserv_vsr.odf",
})

# Powerups: collectible items dropped on the map. Their unit_destroyed
# events are routed by killer_team:
#   - killer_team == 0: pickup. Suppressed from kills aggregation; new-schema
#     matches separately emit a real PickupPowerup event with full picker
#     context (consumed by the pickup_powerup branch in the event loop).
#   - killer_team != 0: destruction. A real player shot the powerup
#     before someone else could pick it up. Routed to the
#     powerup_destructions output block (effectively denies the enemy
#     economy by removing the pickup).
# Either way, NEVER counted as a vehicle kill. Match keys lowercased.
#
# Authoritative set: the `Powerup` bucket of `data/odf.min.json` (159 entries
# in the current DB) plus VSR-mod variants synthesized via `_strip_vsr_suffix`
# inverse (append `vsr` and `_vsr` suffixes). VSR mod ODFs typically inherit
# from stock parents at runtime via [GameObjectClass]\nbaseName, but the
# flattened DB doesn't capture inheritance, so we synthesize the variants.
# Built once per pipeline run via `_load_known_powerup_odfs(odf_db)` in
# `main()` and threaded through `process_match()` as a parameter (symmetric
# with `resolve_weapon` / `resolve_unit`).
#
# See docs/DATA_DICTIONARY.md §8 "UnitDestroyed Classification & Powerup Economy" for evidence + maintenance procedure.

# Deployable utilities: ground-deployed objects (mines, decoys, traps) that
# detonate, expire, or get shot but are NEVER kills in any meaningful sense.
# Routed to the deployable_destructions block regardless of killer_team.
# Distinguished from powerups by domain knowledge, not by team-zero %.
# fball2c.odf shows 79% team-zero but is a deployable mine (not in the DB
# Powerup bucket), so it lives here rather than sharing the powerup path.
# See docs/DATA_DICTIONARY.md §8 "UnitDestroyed Classification & Powerup Economy" for the curation rationale.
KNOWN_DEPLOYABLE_ODFS = frozenset({
    "fball2c.odf",  # flame mine
})

# Recycler / factory ODFs, used by:
#   - kill_feed cleanup (relabeling + Self/World fallback)
#   - compute_match_winner() to identify game-ending destruction events
# BZCC naming convention: lowercase first letter encodes faction
#   - i*: ISDF
#   - e*: Hadean
#   - f*: Scion
# Both base + upgrade variants are listed for factories: the engine emits
# a distinct UnitDestroyed for each variant when destroyed (e.g. Kiln vs
# Forge for Scion, Xenomator vs Mega Xenomator for Hadean). Match keys
# lowercased for direct comparison against `(odf or "").lower()`.
RECYCLER_ODFS = frozenset({
    "ibrecy_vsr.odf",   # ISDF Recycler
    "ebrecym_vsr.odf",  # Hadean Procreator
    "fbrecy_vsr.odf",   # Scion Matriarch
})
FACTORY_ODFS = frozenset({
    "ibfact_vsr.odf",   # ISDF Factory
    "ebfact_vsr.odf",   # Hadean Xenomator (base)
    "ebfact2_vsr.odf",  # Hadean Mega Xenomator (upgrade)
    "fbkiln_vsr.odf",   # Scion Kiln (base)
    "fbforg_vsr.odf",   # Scion Forge (upgrade)
})

# First-letter -> faction. Reliable for vehicles, structures, and pilots --
# every BZCC unit ODF in those categories carries a faction prefix as the
# first character (no exceptions in the corpus). NOT reliable for weapon
# ordnance (gauss_a, cphcg_c, etc.) or generic deployables (fball2c is a
# flame mine, not a Scion asset). Vote sources in Algorithm B should only
# look at vehicle/structure/pilot ODFs to avoid prefix-collision pollution.
FACTION_BY_PREFIX = {"i": "ISDF", "e": "Hadean", "f": "Scion"}

# Pilot ODFs (player on foot). When a kill_feed entry has killer_team == 0
# AND killer == 0 AND the victim died in one of these ODFs, the death is
# treated as self-inflicted ("Self") rather than environmental ("World").
PILOT_ODFS = frozenset({
    "isuser_m.odf",   # ISDF pilot
    "esuser_m.odf",   # Hadean pilot
    "fsuser_m.odf",   # Scion pilot
})


def faction_from_odf(odf):
    """Map an ODF string to a faction code ('i' / 'e' / 'f') via its
    first letter. Returns None for empty / unrecognized strings.

    Used by detect_team_factions() to vote on each team's faction from
    every team-attributed vehicle/structure/pilot ODF observed in the
    event stream.
    """
    if not odf:
        return None
    code = odf[0].lower()
    return code if code in FACTION_BY_PREFIX else None


def _strip_vsr_suffix(odf):
    """Map apserv_vsr.odf -> apserv.odf, apchain_vsr.odf -> apchain.odf,
    apchainvsr.odf -> apchain.odf. Returns None when no suffix to strip
    (i.e. the ODF doesn't end in vsr or _vsr).

    Mirrors BZ's runtime [GameObjectClass]\\nbaseName inheritance for
    VSR-mod variants whose stock parent IS in the flattened odf.min.json
    but the variant itself is not. Highest-volume case: apserv_vsr.odf
    (110,589 pickup_powerup events in the current corpus) is absent from
    the DB Powerup bucket but the stock apserv.odf is present with
    `unitName = "Service Pod"`.
    """
    m = re.match(r"^(.*?)_?vsr\.odf$", odf, flags=re.IGNORECASE)
    return f"{m.group(1)}.odf" if m else None


def _load_known_powerup_odfs(odf_db):
    """Authoritative powerup ODF set, sourced from data/odf.min.json's
    Powerup bucket plus VSR-mod variants. The mod variants typically
    inherit from stock ODFs via [GameObjectClass]\\nbaseName but the
    flattened DB doesn't capture inheritance, so we synthesize the
    common `_vsr` / `vsr` suffix variants for every stock entry.

    Returns an empty frozenset when odf_db lacks a Powerup bucket
    (degrades gracefully -- pipeline behaves like Phase 3 minus
    suppression). Membership lookup is O(1) per event.
    """
    base = set()
    for k in (odf_db.get("Powerup") or {}).keys():
        odfl = (k if k.lower().endswith(".odf") else f"{k}.odf").lower()
        base.add(odfl)
    expanded = set(base)
    for odf in base:
        stem = odf[:-4]  # strip .odf
        expanded.add(f"{stem}vsr.odf")
        expanded.add(f"{stem}_vsr.odf")
    return frozenset(expanded)


def _load_building_odfs(odf_db):
    """Authoritative building ODF set, sourced from data/odf.min.json's
    Building bucket plus VSR-mod variants. Used by the BulletHit ->
    DamageDealt join in `process_match()` to credit `player_structure_dealt`
    when a player's bullet impacts an enemy building (recycler, factory,
    extractor, power gen, etc.). Feeds the VTSR-T `pve_share` axis (and
    via the BulletHit join, also feeds the `personal.structure_dealt`
    field that downstream readers consume).

    Mirrors `_load_known_powerup_odfs()`: builds the base set from the DB
    bucket, then synthesizes `vsr` / `_vsr` suffix variants for each entry
    so VSR-mod ODFs that inherit from stock parents at runtime are still
    recognized. Returns an empty frozenset when odf_db lacks a Building
    bucket (degrades gracefully -- structure_share axis just sees zero
    damage for every lobby and self-omits via weight redistribution).
    """
    base = set()
    for k in (odf_db.get("Building") or {}).keys():
        odfl = (k if k.lower().endswith(".odf") else f"{k}.odf").lower()
        base.add(odfl)
    expanded = set(base)
    for odf in base:
        stem = odf[:-4]
        expanded.add(f"{stem}vsr.odf")
        expanded.add(f"{stem}_vsr.odf")
    return frozenset(expanded)


def _is_sentinel_damage(amount):
    """True when a damage amount is the engine's DAMAGE_TYPE_UNKNOWN sentinel.

    Any amount > 1e6 is treated as a sentinel. Today the only observed value
    is exactly 268435456.0 (= 2^28); using a threshold instead of the exact
    value catches future sentinel variants the engine might emit from other
    DAMAGE_TYPE_UNKNOWN paths and aligns with the upstream collector's own
    "unusual damage" diagnostic threshold.
    """
    return amount is not None and amount > SENTINEL_DAMAGE_THRESHOLD


def _faction_totals_for_player_counts(counter, s64_to_slot, slot_to_faction):
    """Sum a Steam64-keyed Counter into per-faction totals (team_1/team_2).

    Used by the pickup, destruction, and similar blocks to roll Steam64-indexed
    counts up into team totals. Counts not associated with a known team
    slot land in the `ai` bucket via a separate caller-supplied count.

    `slot_to_faction` returns int 1/2 (BZ convention: slots 1-5 = Team 1,
    slots 6-10 = Team 2; 0 for unknown).
    """
    team_1 = 0
    team_2 = 0
    for s64, count in counter.items():
        slot = s64_to_slot.get(s64, 0)
        faction = slot_to_faction(slot)
        if faction == 1:
            team_1 += count
        elif faction == 2:
            team_2 += count
    return team_1, team_2


def _build_pickups_block(
    has_pickup_data, pickup_events, pickup_count_by_player,
    pickup_count_by_odf, nick_for_s64, in_game_nick_for, powerup_display_name,
    s64_to_slot, slot_to_faction,
):
    """Per-match pickups block. Always emitted; empty for legacy sessions.

    Uses `powerup_display_name` (NOT `prettify_odf`) for both the per-feed
    `powerup_name` field and the `by_odf[].name` so collectibles are
    suffixed with " Powerup" to disambiguate from the same-named weapon
    ordnance (e.g. apchainvsr.odf -> "Chain Gun Powerup", vs the
    apchain.odf weapon ordnance -> "Chain Gun")."""
    feed = []
    for pe in pickup_events:
        picker_s64 = pe["picker_s64"]
        if picker_s64 > 0:
            picker_name = nick_for_s64(picker_s64)
            picker_in_game_nick = in_game_nick_for(picker_s64, picker_name)
        else:
            picker_name = f"Team {pe['picker_team']}"
            picker_in_game_nick = None
        feed.append({
            "tick": pe["tick"],
            "picker": picker_name,
            "picker_in_game_nick": picker_in_game_nick,
            "picker_odf": pe["picker_odf"],
            "powerup_odf": pe["powerup_odf"],
            "powerup_name": powerup_display_name(pe["powerup_odf"]),
            "powerup_team": pe["powerup_team"],
        })

    team_1, team_2 = _faction_totals_for_player_counts(
        pickup_count_by_player, s64_to_slot, slot_to_faction,
    )
    ai_total = sum(1 for pe in pickup_events if pe["picker_s64"] == 0)

    return {
        "has_pickup_data": has_pickup_data,
        "feed": feed,
        "by_player": [
            {"name": nick_for_s64(s64), "count": cnt}
            for s64, cnt in pickup_count_by_player.most_common()
        ],
        "by_odf": [
            {"odf": odf, "name": powerup_display_name(odf), "count": cnt}
            for odf, cnt in pickup_count_by_odf.most_common()
        ],
        "totals": {
            "total": len(feed),
            "team_1": team_1,
            "team_2": team_2,
            "ai": ai_total,
        },
    }


def _build_powerup_destructions_block(
    feed, count_by_player, count_by_odf, nick_for_s64, powerup_display_name,
    s64_to_slot, slot_to_faction,
):
    """Per-match powerup/crate destruction block. Same shape for old and
    new schema.

    `feed` is pre-built by the caller (process_match's destruction branch)
    with `powerup_name` already populated; we only need
    `powerup_display_name` here to label the by_odf rollup."""
    team_1, team_2 = _faction_totals_for_player_counts(
        count_by_player, s64_to_slot, slot_to_faction,
    )
    return {
        "feed": feed,
        "by_player": [
            {"name": nick_for_s64(s64), "count": cnt}
            for s64, cnt in count_by_player.most_common()
        ],
        "by_odf": [
            {"odf": odf, "name": powerup_display_name(odf), "count": cnt}
            for odf, cnt in count_by_odf.most_common()
        ],
        "totals": {
            "total": len(feed),
            "team_1": team_1,
            "team_2": team_2,
        },
    }


def _build_deployable_destructions_block(
    count_by_player, count_by_odf, nick_for_s64, prettify_odf,
):
    """Per-match deployable-destruction stats. No feed (too noisy)."""
    return {
        "by_player": [
            {"name": nick_for_s64(s64), "count": cnt}
            for s64, cnt in count_by_player.most_common()
        ],
        "by_odf": [
            {"odf": odf, "name": prettify_odf(odf), "count": cnt}
            for odf, cnt in count_by_odf.most_common()
        ],
        "totals": {
            "total": sum(count_by_odf.values()),
        },
    }


def _build_snipes_block(
    feed, count_by_player, nick_for_s64, s64_to_slot, slot_to_faction,
):
    """Per-match snipe block. Empty feed when no UnitSniped events."""
    team_1, team_2 = _faction_totals_for_player_counts(
        count_by_player, s64_to_slot, slot_to_faction,
    )
    return {
        "feed": feed,
        "by_player": [
            {"name": nick_for_s64(s64), "count": cnt}
            for s64, cnt in count_by_player.most_common()
        ],
        "totals": {
            "total": len(feed),
            "team_1": team_1,
            "team_2": team_2,
        },
    }


# --- Match Highlights ---------------------------------------------------------
# Per-match award catalog. Always emitted in this order; cards whose data
# gates fail are simply omitted (the UI grid reflows around the missing tiles).
# See `.cursor/plans/match-highlights-section_*.plan.md` for the design rationale.
HIGHLIGHTS_RENDER_ORDER = [
    "the_bully",
    "the_grim_reaper",
    "bullet_sponge",
    "the_hustler",
    "sharpshooter",
    "gunner",
    "puppeteer",
    "frenemies",
    "roadrunner",
    "crate_pod_goblin",
    "chris_kyle",
    "the_locksmith",
]

HIGHLIGHTS_LABELS = {
    "the_bully":        ("The Bully",        "bi-emoji-angry"),
    "the_grim_reaper":  ("The Grim Reaper",  "bi-person-x-fill"),
    "bullet_sponge":    ("Bullet Sponge",    "bi-shield-fill"),
    "the_hustler":      ("The Hustler",      "bi-graph-up-arrow"),
    "sharpshooter":     ("Sharpshooter",     "bi-bullseye"),
    "gunner":           ("Gunner",           "bi-lightning-charge"),
    "puppeteer":        ("Puppeteer",        "bi-diagram-3"),
    "frenemies":        ("Frenemies",        "bi-people-fill"),
    "roadrunner":       ("Roadrunner",       "bi-rocket-takeoff"),
    "crate_pod_goblin": ("Pod Goblin",       "bi-box-seam"),
    "chris_kyle":       ("Chris Kyle",       "bi-crosshair"),
    "the_locksmith":    ("The Locksmith",    "bi-lock-fill"),
}


def _delta_pct(winner_v, runner_v):
    """Fraction by which winner exceeds runner-up. None when no comparison
    is possible (no runner-up, or runner-up is zero/negative)."""
    if runner_v is None:
        return None
    try:
        rv = float(runner_v)
    except (TypeError, ValueError):
        return None
    if rv <= 0:
        return None
    return round((float(winner_v) - rv) / rv, 3)


def _narrative_bucket(delta_pct):
    """Discrete narrative bucket keyed off delta_pct. Drives copy-template
    selection in the renderer. Solo standouts (no runner-up) read as 'clear'."""
    if delta_pct is None:
        return "clear"
    if delta_pct >= 0.50:
        return "dominant"
    if delta_pct >= 0.15:
        return "clear"
    return "close"


def _round_value(v, ndigits):
    if ndigits is None:
        return v
    if ndigits == 0:
        return int(round(v))
    return round(v, ndigits)


def _player_card(category, leaderboard, *, value_fn, value_format,
                 round_value=1, floor=None, tiebreak=None):
    """Pick top + runner-up from leaderboard rows by `value_fn`.

    floor: callable(row, value) -> bool; row kept only when True.
    tiebreak: callable(row) -> sort key (lower is better) used after the
        primary value sort. Falls back to lowercase name.
    """
    eligible = []
    for p in leaderboard:
        v = value_fn(p)
        if v is None:
            continue
        if floor is not None and not floor(p, v):
            continue
        eligible.append((v, p))
    if not eligible:
        return None
    if tiebreak:
        eligible.sort(key=lambda x: (-x[0], tiebreak(x[1])))
    else:
        eligible.sort(key=lambda x: (-x[0], (x[1].get("name") or "").lower()))
    winner_v, winner = eligible[0]
    runner = None
    if len(eligible) > 1:
        runner_v, runner_row = eligible[1]
        runner = {
            "name": runner_row.get("name"),
            "value": _round_value(runner_v, round_value),
        }
    label, icon = HIGHLIGHTS_LABELS[category]
    delta = _delta_pct(winner_v, runner["value"] if runner else None)
    return {
        "category": category,
        "label": label,
        "icon": icon,
        "winner": {
            "type": "player",
            "name": winner.get("name"),
            "steam64": winner.get("steam64"),
        },
        "value": _round_value(winner_v, round_value),
        "value_format": value_format,
        "runner_up": runner,
        "delta_pct": delta,
        "narrative": _narrative_bucket(delta),
    }


def _top_kv(d, key=lambda v: v):
    """Return (name, value) for the entry maximizing key(value) in dict `d`,
    or (None, None) when `d` is empty/None. Tiebreak alphabetic on name."""
    if not d:
        return (None, None)
    best_name = None
    best_v = None
    best_k = None
    for n, v in d.items():
        k = key(v)
        if k is None:
            continue
        if best_k is None or k > best_k or (k == best_k and (n or "").lower() < (best_name or "").lower()):
            best_k = k
            best_v = v
            best_name = n
    return (best_name, best_v)


def compute_highlights(match_data):
    """Build the per-match Highlights block (12-card always-on catalog).

    Each card emits when its data gates pass; missing data means the card is
    omitted (the UI grid reflows around the gap). All values are sourced from
    already-built per-match blocks (no event re-walking). Match-global +
    always-unfiltered: the dashboard reads this without applying filterState.

    Schema v2 (this revision): every card carries a `value_breakdown` payload
    so the renderer can show contextual sub-lines instead of bare scalars.
    The Bully ranks by `personal.pvp_dealt` (was `personal.dealt`) so a
    future Domination card can claim the directional argmax-rivalry story.
    Bullet Sponge keeps ranking on total `personal.received` (humans + AI /
    turrets / scavs / mines / world) — the Bully/Sponge asymmetry is
    intentional: bullying is something you do *to humans*, sponging is what
    you do *to incoming damage from anything*. Hustler's value_format moved
    from "ratio" to "kd" so the renderer knows to surface raw kills/deaths.
    """
    leaderboard = match_data.get("leaderboard") or []
    name_to_s64 = {p["name"]: p.get("steam64") for p in leaderboard if p.get("name")}
    leaderboard_by_name = {p["name"]: p for p in leaderboard if p.get("name")}

    cards = []

    def emit(card):
        if card is not None:
            cards.append(card)

    # ---- The Bully: max personal.pvp_dealt; breakdown = top victim from hit_targets.
    bully = _player_card(
        "the_bully", leaderboard,
        value_fn=lambda p: (p.get("personal") or {}).get("pvp_dealt", 0),
        tiebreak=lambda p: (
            -(p.get("personal") or {}).get("dealt", 0),
            -p.get("kills", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="damage",
        round_value=1,
    )
    if bully is not None:
        winner_p = leaderboard_by_name.get(bully["winner"]["name"]) or {}
        hit_targets = winner_p.get("hit_targets") or {}
        v_name, v_data = _top_kv(hit_targets, key=lambda v: (v or {}).get("damage", 0))
        bully["value_breakdown"] = {
            "top_victim": v_name,
            "top_victim_damage": round((v_data or {}).get("damage", 0), 1) if v_data else 0,
        }
        emit(bully)

    # ---- Grim Reaper: max kills; breakdown = top victim from kill_rivalry_matrix.
    grim = _player_card(
        "the_grim_reaper", leaderboard,
        value_fn=lambda p: p.get("kills", 0),
        floor=lambda p, v: v > 0,
        tiebreak=lambda p: (
            -(p.get("kd_ratio") or 0),
            -(p.get("personal") or {}).get("dealt", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="count",
        round_value=0,
    )
    if grim is not None:
        kill_rivalry = (match_data.get("kills") or {}).get("kill_rivalry_matrix") or {}
        per_victim = kill_rivalry.get(grim["winner"]["name"]) or {}
        v_name, v_count = _top_kv(per_victim, key=lambda v: v if isinstance(v, (int, float)) else 0)
        grim["value_breakdown"] = {
            "top_victim": v_name,
            "top_victim_count": int(v_count) if v_count else 0,
        }
        emit(grim)

    # ---- Bullet Sponge: max personal.received (total, including PvE — turrets,
    # scavs, mines, world). Asymmetric to The Bully on purpose: sponge soaks
    # everything; bullying is a humans-only verb. Tiebreak prefers higher
    # PvP-side received so a true tie resolves toward the player who took more
    # of their damage from real opponents. Breakdown still names the worst
    # human tormentor (rivalry_matrix is human-only by construction); the
    # delta between value and breakdown surfaces PvE implicitly.
    sponge = _player_card(
        "bullet_sponge", leaderboard,
        value_fn=lambda p: (p.get("personal") or {}).get("received", 0),
        tiebreak=lambda p: (
            -(p.get("personal") or {}).get("pvp_received", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="damage",
        round_value=1,
    )
    if sponge is not None:
        # Column-scan rivalry_matrix for the winner victim's worst tormentor.
        rivalry = match_data.get("rivalry_matrix") or {}
        victim = sponge["winner"]["name"]
        best_name = None
        best_dmg = 0.0
        for shooter, victims in rivalry.items():
            if shooter == victim:
                continue
            dmg = (victims or {}).get(victim, 0)
            if dmg > best_dmg or (
                dmg == best_dmg and best_name is not None
                and (shooter or "").lower() < (best_name or "").lower()
            ):
                best_dmg = dmg
                best_name = shooter
        sponge["value_breakdown"] = {
            "top_tormentor": best_name,
            "top_tormentor_damage": round(best_dmg, 1) if best_name else 0,
        }
        emit(sponge)

    # ---- The Hustler — best K/D trade. leaderboard.kd_ratio is None when
    # deaths == 0 (even with kills > 0), so map that to the player's kill
    # count as a synthetic dominant-K/D value: a 5-kill 0-death player still
    # beats a 3:1 K/D player. Renderer detects deaths == 0 in the breakdown
    # and renders "(perfect)" instead of a numeric ratio.
    def _hustler_kd(p):
        kr = p.get("kd_ratio")
        if kr is not None:
            return kr
        kills = p.get("kills", 0)
        deaths = p.get("deaths", 0)
        if deaths == 0 and kills > 0:
            return float(kills)
        return None
    hustler = _player_card(
        "the_hustler", leaderboard,
        value_fn=_hustler_kd,
        floor=lambda p, v: p.get("kills", 0) >= 3,
        tiebreak=lambda p: (
            -p.get("kills", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="kd",
        round_value=2,
    )
    if hustler is not None:
        winner_p = leaderboard_by_name.get(hustler["winner"]["name"]) or {}
        hustler["value_breakdown"] = {
            "kills": int(winner_p.get("kills", 0)),
            "deaths": int(winner_p.get("deaths", 0)),
        }
        emit(hustler)

    # ---- Sharpshooter: max accuracy; breakdown = shots_hit / shots_fired.
    sharp = _player_card(
        "sharpshooter", leaderboard,
        value_fn=lambda p: (p.get("personal") or {}).get("accuracy", 0),
        floor=lambda p, v: (p.get("personal") or {}).get("shots_fired", 0) >= 100,
        tiebreak=lambda p: (
            -(p.get("personal") or {}).get("shots_hit", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="accuracy",
        round_value=3,
    )
    if sharp is not None:
        winner_p = (leaderboard_by_name.get(sharp["winner"]["name"]) or {}).get("personal") or {}
        sharp["value_breakdown"] = {
            "shots_hit": int(winner_p.get("shots_hit", 0)),
            "shots_fired": int(winner_p.get("shots_fired", 0)),
        }
        emit(sharp)

    # ---- Gunner: max shots_fired; breakdown = accuracy.
    gunner = _player_card(
        "gunner", leaderboard,
        value_fn=lambda p: (p.get("personal") or {}).get("shots_fired", 0),
        tiebreak=lambda p: (
            -(p.get("personal") or {}).get("accuracy", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="count",
        round_value=0,
    )
    if gunner is not None:
        winner_p = (leaderboard_by_name.get(gunner["winner"]["name"]) or {}).get("personal") or {}
        gunner["value_breakdown"] = {
            "accuracy": round(winner_p.get("accuracy", 0), 3),
        }
        emit(gunner)

    # ---- Puppeteer: max assets.dealt; breakdown = personal_dealt for contrast.
    puppeteer = _player_card(
        "puppeteer", leaderboard,
        value_fn=lambda p: (p.get("assets") or {}).get("dealt", 0),
        floor=lambda p, v: v > 0,
        tiebreak=lambda p: (
            -(p.get("personal") or {}).get("dealt", 0),
            (p.get("name") or "").lower(),
        ),
        value_format="damage",
        round_value=1,
    )
    if puppeteer is not None:
        winner_p = (leaderboard_by_name.get(puppeteer["winner"]["name"]) or {}).get("personal") or {}
        puppeteer["value_breakdown"] = {
            "personal_dealt": round(winner_p.get("dealt", 0), 1),
        }
        emit(puppeteer)

    # ---- Frenemies (pair). breakdown = directional split a_to_b / b_to_a.
    rivalries = match_data.get("top_rivalries") or []
    if rivalries and rivalries[0].get("total", 0) > 0:
        winner = rivalries[0]
        runner = None
        if len(rivalries) > 1 and rivalries[1].get("total", 0) > 0:
            r = rivalries[1]
            runner = {
                "name": f"{r['a']} vs {r['b']}",
                "value": round(r["total"], 1),
            }
        delta = _delta_pct(winner["total"], runner["value"] if runner else None)
        label, icon = HIGHLIGHTS_LABELS["frenemies"]
        cards.append({
            "category": "frenemies",
            "label": label,
            "icon": icon,
            "winner": {"type": "pair", "a": winner["a"], "b": winner["b"]},
            "value": round(winner["total"], 1),
            "value_format": "damage",
            "value_breakdown": {
                "a_to_b": round(winner.get("a_to_b", 0), 1),
                "b_to_a": round(winner.get("b_to_a", 0), 1),
            },
            "runner_up": runner,
            "delta_pct": delta,
            "narrative": _narrative_bucket(delta),
        })

    # ---- Roadrunner: max activity_score; breakdown = movement_band + path_length.
    pos = match_data.get("positioning") or {}
    has_pos = (match_data.get("match") or {}).get("has_position_data", False)
    pos_players = pos.get("players") or {}
    if has_pos and pos_players:
        rows = []
        for pname, pdata in pos_players.items():
            metrics = pdata.get("metrics") or {}
            score = metrics.get("activity_score")
            if score is None:
                continue
            rows.append({
                "name": pname,
                "steam64": name_to_s64.get(pname),
                "score": score,
                "movement_band": metrics.get("movement_band"),
                "path_length": metrics.get("path_length", 0),
            })
        if rows:
            rows.sort(key=lambda r: (-r["score"], -r["path_length"], r["name"].lower()))
            winner = rows[0]
            runner = None
            if len(rows) > 1:
                runner = {"name": rows[1]["name"], "value": int(rows[1]["score"])}
            delta = _delta_pct(winner["score"], runner["value"] if runner else None)
            label, icon = HIGHLIGHTS_LABELS["roadrunner"]
            cards.append({
                "category": "roadrunner",
                "label": label,
                "icon": icon,
                "winner": {
                    "type": "player",
                    "name": winner["name"],
                    "steam64": winner["steam64"],
                },
                "value": int(winner["score"]),
                "value_format": "score",
                "value_breakdown": {
                    "movement_band": winner.get("movement_band"),
                    "path_length": int(round(winner["path_length"])),
                },
                "runner_up": runner,
                "delta_pct": delta,
                "narrative": _narrative_bucket(delta),
            })

    # ---- Pod Goblin: combined pickups + powerup destructions per player.
    pickups_by_player = (match_data.get("pickups") or {}).get("by_player") or []
    destr_by_player = (match_data.get("powerup_destructions") or {}).get("by_player") or []
    combined = {}
    for row in pickups_by_player:
        n = row.get("name")
        if not n:
            continue
        combined.setdefault(n, {"pickups": 0, "destructions": 0})
        combined[n]["pickups"] += int(row.get("count", 0))
    for row in destr_by_player:
        n = row.get("name")
        if not n:
            continue
        combined.setdefault(n, {"pickups": 0, "destructions": 0})
        combined[n]["destructions"] += int(row.get("count", 0))
    rows = [
        {
            "name": n,
            "steam64": name_to_s64.get(n),
            "total": v["pickups"] + v["destructions"],
            "pickups": v["pickups"],
            "destructions": v["destructions"],
        }
        for n, v in combined.items()
        if v["pickups"] + v["destructions"] > 0
    ]
    if rows:
        rows.sort(key=lambda r: (-r["total"], -r["pickups"], r["name"].lower()))
        winner = rows[0]
        runner = None
        if len(rows) > 1:
            runner = {"name": rows[1]["name"], "value": rows[1]["total"]}
        delta = _delta_pct(winner["total"], runner["value"] if runner else None)
        label, icon = HIGHLIGHTS_LABELS["crate_pod_goblin"]
        cards.append({
            "category": "crate_pod_goblin",
            "label": label,
            "icon": icon,
            "winner": {
                "type": "player",
                "name": winner["name"],
                "steam64": winner["steam64"],
            },
            "value": winner["total"],
            "value_format": "count",
            "value_breakdown": {
                "pickups": winner["pickups"],
                "destructions": winner["destructions"],
            },
            "runner_up": runner,
            "delta_pct": delta,
            "narrative": _narrative_bucket(delta),
        })

    # ---- Chris Kyle: max pilot snipes; breakdown = top victim from snipes.feed[].
    snipes = match_data.get("snipes") or {}
    snipe_total = (snipes.get("totals") or {}).get("total", 0)
    snipe_by_player = snipes.get("by_player") or []
    snipe_feed = snipes.get("feed") or []
    if snipe_total > 0 and snipe_by_player:
        kills_lookup = {p.get("name"): p.get("kills", 0) for p in leaderboard}
        rows = [
            {
                "name": r["name"],
                "count": r["count"],
                "kills": kills_lookup.get(r["name"], 0),
            }
            for r in snipe_by_player if r.get("count", 0) > 0
        ]
        if rows:
            rows.sort(key=lambda r: (-r["count"], -r["kills"], r["name"].lower()))
            winner = rows[0]
            runner = None
            if len(rows) > 1:
                runner = {"name": rows[1]["name"], "value": rows[1]["count"]}
            delta = _delta_pct(winner["count"], runner["value"] if runner else None)
            # Per-winner victim counter from the snipe feed. Tiebreak: alphabetic.
            victim_counts = Counter(
                e.get("victim") for e in snipe_feed
                if e.get("sniper") == winner["name"] and e.get("victim")
            )
            top_victim, top_victim_count = (None, 0)
            if victim_counts:
                victims_sorted = sorted(
                    victim_counts.items(),
                    key=lambda kv: (-kv[1], (kv[0] or "").lower()),
                )
                top_victim, top_victim_count = victims_sorted[0][0], int(victims_sorted[0][1])
            label, icon = HIGHLIGHTS_LABELS["chris_kyle"]
            cards.append({
                "category": "chris_kyle",
                "label": label,
                "icon": icon,
                "winner": {
                    "type": "player",
                    "name": winner["name"],
                    "steam64": name_to_s64.get(winner["name"]),
                },
                "value": winner["count"],
                "value_format": "count",
                "value_breakdown": {
                    "top_victim": top_victim,
                    "top_victim_count": top_victim_count,
                },
                "runner_up": runner,
                "delta_pct": delta,
                "narrative": _narrative_bucket(delta),
            })

    # ---- The Locksmith: max target_lock_pct, gated on has_target_lock_data.
    has_lock = (match_data.get("match") or {}).get("has_target_lock_data", False)
    if has_lock and pos_players:
        rows = []
        for pname, pdata in pos_players.items():
            metrics = pdata.get("metrics") or {}
            tlp = metrics.get("target_lock_pct")
            if tlp is None or tlp < 0.10:
                continue
            rows.append({
                "name": pname,
                "steam64": name_to_s64.get(pname),
                "tlp": tlp,
                "sample_count": pdata.get("sample_count", 0),
            })
        if rows:
            rows.sort(key=lambda r: (-r["tlp"], -r["sample_count"], r["name"].lower()))
            winner = rows[0]
            runner = None
            if len(rows) > 1:
                runner = {
                    "name": rows[1]["name"],
                    "value": round(rows[1]["tlp"], 3),
                }
            delta = _delta_pct(winner["tlp"], runner["value"] if runner else None)
            label, icon = HIGHLIGHTS_LABELS["the_locksmith"]
            cards.append({
                "category": "the_locksmith",
                "label": label,
                "icon": icon,
                "winner": {
                    "type": "player",
                    "name": winner["name"],
                    "steam64": winner["steam64"],
                },
                "value": round(winner["tlp"], 3),
                "value_format": "percent",
                "value_breakdown": {
                    "seconds_locked": int(round(winner["tlp"] * winner["sample_count"])),
                    "total_seconds": int(winner["sample_count"]),
                },
                "runner_up": runner,
                "delta_pct": delta,
                "narrative": _narrative_bucket(delta),
            })

    # Stable canonical render order. (The append order above already matches,
    # but sort defensively so a future refactor cannot reorder cards.)
    order = {cat: i for i, cat in enumerate(HIGHLIGHTS_RENDER_ORDER)}
    cards.sort(key=lambda c: order.get(c["category"], 999))

    return {
        "schema_version": 2,
        "cards": cards,
    }


# Movement band thresholds on activity_score (0-100): Defensive ... Aggressive
# 0 = camper (stayed at base), 100 = roamer (covered map).
POSITIONING_BANDS = [
    (20, "Defensive"),
    (40, "Territorial"),
    (60, "Balanced"),
    (80, "Mobile"),
    (100, "Aggressive"),
]


def build_weapon_name_resolver(odf_db):
    """Port of the JS weapon name resolver from the original dataProcessor.js."""
    by_ord_name = {}
    by_object_class = {}
    by_leader_name = {}
    dispenser_to_wpn = {}

    for wpn in (odf_db.get("Weapon") or {}).values():
        wc = wpn.get("WeaponClass", {})
        dc = wpn.get("DispenserClass", {})
        tg = wpn.get("TargetingGunClass", {})
        name = wc.get("wpnName")
        if not name:
            continue

        ord_name = wc.get("ordName")
        if ord_name:
            by_ord_name[ord_name] = name

        obj_class = dc.get("objectClass")
        if obj_class:
            by_object_class[obj_class] = name
            dispenser_to_wpn[obj_class] = name

        leader = tg.get("leaderName")
        if leader:
            by_leader_name[leader] = name

    by_explosion = {}
    for veh_key, veh in (odf_db.get("Vehicle") or {}).items():
        gc = veh.get("GameObjectClass", {})
        tc = veh.get("TorpedoClass", {})
        veh_base = re.sub(r"\.odf$", "", veh_key, flags=re.IGNORECASE)
        parent_wpn = dispenser_to_wpn.get(veh_base)
        if not parent_wpn:
            continue
        xpl = tc.get("xplBlast")
        if xpl:
            by_explosion[xpl] = parent_wpn
        expl = gc.get("explosionName")
        if expl:
            by_explosion[expl] = parent_wpn

    def resolve(odf_string):
        if not odf_string:
            return "Unknown"
        key = re.sub(r"\.odf$", "", odf_string, flags=re.IGNORECASE)
        return (
            by_ord_name.get(key)
            or by_object_class.get(key)
            or by_leader_name.get(key)
            or by_explosion.get(key)
            or key
        )

    return resolve


def build_unit_name_resolver(odf_db):
    """Resolve in-game object ODF strings to GameObjectClass.unitName.

    Indexes every top-level category in the ODF DB (Vehicle, Building,
    Powerup, Pilot, Ordnance, etc.). `unitName` lives on `GameObjectClass`,
    which every game-object ODF inherits regardless of which top-level
    bucket it ends up in (BZCC's `apeburst.odf` is bucketed under `Powerup`,
    `ibscav_vsr.odf` under `Building`, `esuser_m.odf` under `Pilot`, etc.).
    The flattened ODF DB at `data/odf.min.json` carries each entry's
    `unitName` directly (no inheritance walk required). VSR-overridden
    variants whose `unitName` differs from the stock parent are picked up
    automatically via direct key lookup. Returns `None` when no entry / no
    `unitName` is available so callers can fall through.
    """
    by_key = {}
    for bucket in (odf_db or {}).values():
        if not isinstance(bucket, dict):
            continue
        for odf_key, entry in bucket.items():
            goc = (entry or {}).get("GameObjectClass", {}) or {}
            name = (goc.get("unitName") or "").strip()
            if not name:
                continue
            key = re.sub(r"\.odf$", "", odf_key, flags=re.IGNORECASE)
            by_key[key] = name

    def resolve(odf_string):
        if not odf_string:
            return None
        key = re.sub(r"\.odf$", "", odf_string, flags=re.IGNORECASE)
        return by_key.get(key)

    return resolve


def disambiguate_names(odf_set, resolve_fn):
    """When multiple ODF strings resolve to the same display name, append the raw ODF stem.

    Category-agnostic: works for both weapon ordnance ODFs and vehicle/structure
    ODFs. Same-name collisions render as `Name (raw_stem)`, e.g.
    `Pulse (epulse)` / `Pulse (fpulse)` and `Scavenger (ivscav)` /
    `Scavenger (ivscav_vsr)`.

    Resolvers may return `None` to signal "no name in the DB" (the unit
    resolver does this so callers can fall through to a title-case stem).
    Such entries are passed through as `None` and are not counted toward
    collision detection — otherwise multiple unrecognized ODFs would all
    falsely collide on `None` and render as the literal string
    `"None (raw_stem)"`.
    """
    raw = {odf: resolve_fn(odf) for odf in odf_set}
    counts = defaultdict(int)
    for name in raw.values():
        if name is None:
            continue
        counts[name] += 1
    result = {}
    for odf, name in raw.items():
        if name is None:
            result[odf] = None
            continue
        key = re.sub(r"\.odf$", "", odf, flags=re.IGNORECASE)
        result[odf] = f"{name} ({key})" if counts[name] > 1 else name
    return result


def resolve_match_name(raw_map: str, registry: dict) -> str:
    """Resolve a match's display name from a raw map filename.

    Preference order:
      1. `registry[<key>].title` with iteratively-stripped `TOKEN: ` prefixes
         (so "ST: VSR: TVD: Ebola" -> "Ebola", "VSR: Haven" -> "Haven").
         Internal whitespace and special characters (e.g. the `*~V8~*+`
         decoration on the V8 map title) are preserved as-is.
      2. The raw filename minus a trailing `.bzn`, case preserved
         (used when the registry has no entry / no title for this map,
         e.g. when the iondriver fetch failed across all mod-id fallbacks).
    """
    key = re.sub(r"\.bzn$", "", raw_map or "", flags=re.IGNORECASE).lower()
    title = (registry.get(key, {}) or {}).get("title") or ""
    while True:
        nxt = re.sub(r"^[^:]+:\s*", "", title, count=1)
        if nxt == title:
            break
        title = nxt
    title = title.strip()
    if title:
        return title
    return re.sub(r"\.bzn$", "", raw_map or "", flags=re.IGNORECASE)


def discover_sessions():
    """Find all .binpb.gz session files under data/sessions/<username>/."""
    sources = []
    if not SESSIONS_DIR.exists():
        return sources
    for user_dir in sorted(SESSIONS_DIR.iterdir()):
        if not user_dir.is_dir():
            continue
        submitter = user_dir.name
        for entry in sorted(user_dir.iterdir()):
            if entry.suffix == ".gz" and entry.stem.endswith(".binpb"):
                sources.append((entry, submitter))
    return sources


def sync_upstream():
    """Pull upstream statsgate clone + mirror new .binpb.gz into data/sessions/.

    Soft-skips (warn + return) if statsgate/ isn't cloned -- supports the
    "I only ever drop files in manually" workflow without needing
    --no-sync. Hard-fails on git pull errors (auth, conflicts, network) so
    the user notices real problems; --no-sync is the documented escape
    hatch.

    The mirror copy is strictly additive: never deletes from data/sessions/
    (protects local-only submitter folders) and never overwrites existing
    files (size mismatches warn but don't clobber). git pull uses
    --ff-only so a divergent local statsgate clone fails loudly instead
    of auto-merging.
    """
    if not STATSGATE_DIR.exists():
        print(f"  Note: {STATSGATE_DIR.name}/ not present; skipping sync.")
        print(f"  (Clone it with: git clone https://github.com/vtrider/statsgate.git {STATSGATE_DIR.name})")
        return

    print(f"Pulling upstream in {STATSGATE_DIR}...")
    try:
        subprocess.run(
            ["git", "-C", str(STATSGATE_DIR), "pull", "--ff-only"],
            check=True,
        )
    except FileNotFoundError:
        print("\nERROR: 'git' not found on PATH; cannot sync.")
        print("  Install git or run with --no-sync to process local sessions only.")
        sys.exit(2)
    except subprocess.CalledProcessError as e:
        print(f"\nERROR: git pull failed (exit {e.returncode}).")
        print("  Use --no-sync to skip and process local sessions only.")
        sys.exit(2)

    if not STATSGATE_SESSIONS_DIR.exists():
        print(f"  Note: {STATSGATE_SESSIONS_DIR.relative_to(PROJECT_ROOT)} not present; nothing to mirror.")
        return

    copied: list[str] = []
    skipped_size_mismatch: list[Path] = []
    for user_dir in sorted(STATSGATE_SESSIONS_DIR.iterdir()):
        if not user_dir.is_dir():
            continue
        for src in sorted(user_dir.iterdir()):
            if src.suffix != ".gz" or not src.stem.endswith(".binpb"):
                continue
            dest = SESSIONS_DIR / user_dir.name / src.name
            if dest.exists():
                if dest.stat().st_size != src.stat().st_size:
                    skipped_size_mismatch.append(dest)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            copied.append(f"{user_dir.name}/{src.name}")

    print(f"Synced {len(copied)} new file(s)")
    for c in copied:
        print(f"  [copy] {c}")
    for s in skipped_size_mismatch:
        print(f"  WARN: size mismatch, NOT overwritten: {s.relative_to(SESSIONS_DIR)}")


def load_session(path):
    """Load and parse a .binpb.gz session file."""
    with gzip.open(path, "rb") as f:
        data = f.read()
    session = statsgate_pb2.ClientStatSession()
    session.ParseFromString(data)
    return session


def load_cache_index():
    """Walk data/processed/*.json once, build the incremental cache index.

    Returns a dict keyed by `(submitter, source_file)` mapping to the
    fully-loaded cached match_data. Only includes entries whose
    `match.pipeline_version` matches the current PIPELINE_VERSION
    constant -- stale entries are skipped so they get reprocessed.

    The cross-match aggregate files (matches.json,
    match_contributions.json, all_matches.json) are skipped explicitly
    since they don't represent a single match. Per-match JSONs that
    fail to load (corrupt, mid-write, missing required fields) are
    silently dropped from the index so they get reprocessed; this is
    the self-healing path for partial pipeline runs.
    """
    index: dict[tuple[str, str], dict] = {}
    if not OUTPUT_DIR.exists():
        return index
    skip = {"matches.json", "match_contributions.json", "all_matches.json",
            "elo_current.json", "elo_history.json"}
    for json_path in OUTPUT_DIR.glob("*.json"):
        if json_path.name in skip:
            continue
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        m = cached.get("match", {})
        if m.get("pipeline_version") != PIPELINE_VERSION:
            continue
        sub = m.get("submitter")
        src = m.get("source_file")
        if sub and src and m.get("source_size_bytes") is not None:
            index[(sub, src)] = cached
    return index


def slot_to_faction(slot):
    """Determine which faction (1 or 2) a slot belongs to using BZ convention."""
    if 1 <= slot <= 5:
        return 1
    if 6 <= slot <= 10:
        return 2
    return 0


def compute_match_winner(kill_feed):
    """Infer the match outcome from recycler/factory destructions in
    `kill_feed`.

    Toggle model (per team): each recycler / factory destruction toggles
    its "dead" state. Odd destructions = currently dead at match end;
    even = currently alive (rebuilt at least once after the last kill,
    or never destroyed). Pre-loss rebuilds are properly modeled because
    the kill_feed only logs the destruction, not the construction --
    the toggle still ends in the right state.

    Outcomes (decided_by):
      "clean_win"   -- exactly one team is fully_dead AND the other has
                       zero rec/fac destructions. Highest confidence.
      "contested"   -- both teams fully_dead. Loser = team that fell first
                       (max(last_rec_tick, last_fac_tick)).
      "unclear"     -- everything else. Includes:
                       - zero teams fully_dead (premature quit, timeout,
                         commander self-demo of own rec/fac that didn't
                         register in the kill feed)
                       - one team fully_dead but the other has non-zero
                         destructions (rebuild ambiguity: e.g. lost fac,
                         rebuilt, lost rec -- toggle says rec dead but
                         we can't distinguish from the kill feed alone)

    Returns a dict suitable for emission as `match.winner`:
        {
          "team": int | None,        # winning team (1 or 2; None for unclear)
          "loser": int | None,       # losing team (3 - team; None for unclear)
          "decided_at_tick": int | None,
          "decided_by": "clean_win" | "contested" | "unclear",
          "evidence": {
            "rec_dest_count": {"1": int, "2": int},
            "fac_dest_count": {"1": int, "2": int},
            "loser_rec_destroyed_tick": int | None,
            "loser_fac_destroyed_tick": int | None,
            "loser_rec_odf": str | None,
            "loser_fac_odf": str | None,
          }
        }

    Always emitted (even when `decided_by == "unclear"`) so the renderer
    can reliably read the block instead of probing for absence.
    """
    rec_dest_count = {1: 0, 2: 0}
    fac_dest_count = {1: 0, 2: 0}
    last_rec_tick = {1: None, 2: None}
    last_fac_tick = {1: None, 2: None}
    loser_rec_odf = {1: None, 2: None}
    loser_fac_odf = {1: None, 2: None}

    for evt in sorted(kill_feed, key=lambda e: e.get("tick") or 0):
        odf = (evt.get("victim_odf") or "").lower()
        team = slot_to_faction(evt.get("victim_team", 0))
        if team not in (1, 2):
            continue
        if odf in RECYCLER_ODFS:
            rec_dest_count[team] += 1
            last_rec_tick[team] = evt["tick"]
            loser_rec_odf[team] = odf
        elif odf in FACTORY_ODFS:
            fac_dest_count[team] += 1
            last_fac_tick[team] = evt["tick"]
            loser_fac_odf[team] = odf

    rec_dead = {t: (rec_dest_count[t] % 2 == 1) for t in (1, 2)}
    fac_dead = {t: (fac_dest_count[t] % 2 == 1) for t in (1, 2)}
    fully_dead = {t: rec_dead[t] and fac_dead[t] for t in (1, 2)}
    other_untouched = {
        t: (rec_dest_count[3 - t] == 0 and fac_dest_count[3 - t] == 0)
        for t in (1, 2)
    }

    def _evidence(loser=None):
        return {
            "rec_dest_count": {"1": rec_dest_count[1], "2": rec_dest_count[2]},
            "fac_dest_count": {"1": fac_dest_count[1], "2": fac_dest_count[2]},
            "loser_rec_destroyed_tick": last_rec_tick.get(loser) if loser else None,
            "loser_fac_destroyed_tick": last_fac_tick.get(loser) if loser else None,
            "loser_rec_odf": loser_rec_odf.get(loser) if loser else None,
            "loser_fac_odf": loser_fac_odf.get(loser) if loser else None,
        }

    # clean_win: exactly one team fully dead AND the other team had no
    # destructions at all. Highest-confidence path -- there's nothing
    # to interpret about rebuilds or commander demos.
    clean_losers = [
        t for t in (1, 2)
        if fully_dead[t] and other_untouched[t]
    ]
    if len(clean_losers) == 1:
        loser = clean_losers[0]
        decided_at = max(last_rec_tick[loser], last_fac_tick[loser])
        return {
            "team": 3 - loser,
            "loser": loser,
            "decided_at_tick": decided_at,
            "decided_by": "clean_win",
            "evidence": _evidence(loser=loser),
        }

    # contested: both teams fully dead. Loser = whichever fell first
    # (their last rec/fac destruction is earlier).
    if fully_dead[1] and fully_dead[2]:
        fall_tick = {
            t: max(last_rec_tick[t], last_fac_tick[t])
            for t in (1, 2)
        }
        loser = 1 if fall_tick[1] < fall_tick[2] else 2
        return {
            "team": 3 - loser,
            "loser": loser,
            "decided_at_tick": fall_tick[loser],
            "decided_by": "contested",
            "evidence": _evidence(loser=loser),
        }

    # unclear: everything else. Could be premature quit, timeout, or a
    # commander self-demolition that didn't register in the kill feed.
    # Rebuild ambiguity (one team fully dead but the other has non-zero
    # destructions) also lands here. Emit the evidence block so the UI
    # can surface raw counts in a tooltip.
    return {
        "team": None,
        "loser": None,
        "decided_at_tick": None,
        "decided_by": "unclear",
        "evidence": _evidence(loser=None),
    }


def detect_team_factions(slot_first_odf, slot_faction_votes):
    """Derive each team's faction from per-slot ODF signals.

    Combines two complementary algorithms:

      Algorithm A (starting ship): the first non-empty ODF observed for
        each slot in UpdateTick events. The literal "what was this player
        piloting at the start of the match" signal -- closest analogue we
        have to a starting-roster check absent an explicit match-start
        event in the proto. Weighted as one extra vote on top of B.

      Algorithm B (event-stream votes): first-letter votes accumulated
        across every team-attributed vehicle/structure/pilot ODF the
        slot's owner emitted (their own vehicle in BulletHit, their own
        asset in UnitDestroyed, their own avatar in UpdateTick, etc.).
        Resilient to brief hijacks / pilot-swaps -- a single anomalous
        event can't outvote dozens of normal ones.

    Per slot, the mode of (votes + 1 weight on starting-ship) is the
    slot's faction. Per team (1: slots 1-5, 2: slots 6-10), the mode
    across all slots that produced any signal is the team's faction.
    Empty result for either team is emitted as None (no signal).

    Returns dict keyed by team number (1, 2) mapping to either:
        {"code": "i" | "e" | "f", "name": "ISDF" | "Hadean" | "Scion"}
        or None when no slot in that team produced any faction signal
        (sandbox / corrupt match / pure-AI team with no events).
    """
    team_votes = defaultdict(Counter)  # team -> Counter[faction_code]

    all_slots = set(slot_first_odf.keys()) | set(slot_faction_votes.keys())
    for slot in all_slots:
        team = slot_to_faction(slot)
        if team not in (1, 2):
            continue
        # Combined vote pool: per-event votes + starting-ship weighted as 1.
        slot_votes = Counter(slot_faction_votes.get(slot, {}))
        first_code = faction_from_odf(slot_first_odf.get(slot))
        if first_code:
            slot_votes[first_code] += 1
        if not slot_votes:
            continue
        slot_faction = slot_votes.most_common(1)[0][0]
        team_votes[team][slot_faction] += 1

    result = {}
    for team in (1, 2):
        votes = team_votes.get(team)
        if not votes:
            result[team] = None
            continue
        code = votes.most_common(1)[0][0]
        result[team] = {"code": code, "name": FACTION_BY_PREFIX[code]}
    return result


# --- Positioning helpers ---


def _horiz_dist(ax, az, bx, bz):
    """Horizontal distance on the (x, z) plane. y is ignored per axis convention."""
    dx = ax - bx
    dz = az - bz
    return (dx * dx + dz * dz) ** 0.5


def _median(values):
    """Median of a list of floats. Assumes non-empty input."""
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 0:
        return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0
    return sorted_vals[mid]


def _median_xyz(samples):
    """Component-wise median of a list of (t, x, y, z) tuples."""
    xs = _median([s[1] for s in samples])
    ys = _median([s[2] for s in samples])
    zs = _median([s[3] for s in samples])
    return xs, ys, zs


def _percentile(sorted_values, p):
    """Linear-interpolation percentile on an already-sorted list. p in [0, 1]."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = p * (len(sorted_values) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = rank - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def _convex_hull_area_xz(points):
    """Andrew's monotone chain convex hull + shoelace area.

    Input: iterable of (x, z) tuples. Returns area in world units^2.
    Returns 0 for < 3 distinct points or colinear point sets.
    """
    pts = sorted(set((round(x, 3), round(z, 3)) for x, z in points))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    if len(hull) < 3:
        return 0.0

    area = 0.0
    n = len(hull)
    for i in range(n):
        x1, z1 = hull[i]
        x2, z2 = hull[(i + 1) % n]
        area += x1 * z2 - x2 * z1
    return abs(area) / 2.0


def _band_for_score(score):
    for threshold, band in POSITIONING_BANDS:
        if score <= threshold:
            return band
    return POSITIONING_BANDS[-1][1]


def _compute_step_speeds(trails):
    """Compute per-step speeds across all players. Returns a flat list of u/s values.

    Used to self-calibrate the teleport threshold. Values exceeding
    POSITIONING_TELEPORT_MIN_SPEED are excluded from the p99 calculation
    (they're obvious outliers).
    """
    all_speeds = []
    for trail in trails.values():
        t_arr = trail["t"]
        x_arr = trail["x"]
        z_arr = trail["z"]
        for i in range(1, len(t_arr)):
            dt = t_arr[i] - t_arr[i - 1]
            if dt <= 0:
                continue
            d = _horiz_dist(x_arr[i], z_arr[i], x_arr[i - 1], z_arr[i - 1])
            speed = d / dt
            if speed <= POSITIONING_TELEPORT_MIN_SPEED:
                all_speeds.append(speed)
    return all_speeds


def _compute_segments_and_path(trail, teleport_threshold):
    """Walk a trail, split into segments at teleport jumps, and compute path length.

    Returns (segments, path_length) where segments is a list of [start_idx, end_idx]
    ranges (inclusive) and path_length sums horizontal deltas excluding teleport gaps.
    """
    t_arr = trail["t"]
    x_arr = trail["x"]
    z_arr = trail["z"]
    n = len(t_arr)
    if n == 0:
        return [], 0.0

    segments = []
    seg_start = 0
    path_length = 0.0

    for i in range(1, n):
        dt = t_arr[i] - t_arr[i - 1]
        d = _horiz_dist(x_arr[i], z_arr[i], x_arr[i - 1], z_arr[i - 1])
        speed = d / dt if dt > 0 else 0.0
        if speed > teleport_threshold:
            segments.append([seg_start, i - 1])
            seg_start = i
        else:
            path_length += d

    segments.append([seg_start, n - 1])
    return segments, path_length


def _compute_return_count(dists, segments, personal_base_radius, t_arr,
                          min_out_sec=POSITIONING_RETURN_MIN_OUT_SEC):
    """Count voluntary returns to base using hysteresis + minimum-outside time.

    A return is: cross out past (R_base * HYSTERESIS_OUT), stay outside for at
    least min_out_sec seconds (real wall time, derived from t_arr), then re-enter
    past (R_base * HYSTERESIS_IN). First re-entry of each post-teleport segment
    is excluded so respawn returns don't count.

    The min-outside gate filters boundary-noise returns where a player oscillates
    near the base edge (which would otherwise inflate the count with 1 Hz samples).
    """
    if not dists:
        return 0
    r_out = personal_base_radius * POSITIONING_RETURN_HYSTERESIS_OUT
    r_in = personal_base_radius * POSITIONING_RETURN_HYSTERESIS_IN

    post_teleport_starts = {seg[0] for seg in segments[1:]}
    returns = 0
    state = "in" if dists[0] < personal_base_radius else "out"
    outbound_t = None  # t_sec when the most recent outbound crossing happened
    for i, d in enumerate(dists):
        if i in post_teleport_starts:
            # Snap state without counting a return
            state = "in" if d < personal_base_radius else "out"
            outbound_t = None
            continue
        if state == "in" and d > r_out:
            state = "out"
            outbound_t = t_arr[i]
        elif state == "out" and d < r_in:
            elapsed = (t_arr[i] - outbound_t) if outbound_t is not None else 0
            if elapsed >= min_out_sec:
                returns += 1
            state = "in"
            outbound_t = None
    return returns


def _build_heatmap_grid(trail, map_min_x, map_max_x, map_min_z, map_max_z):
    """32x32 bin counts over map_bounds. [row][col] where row=x-index, col=z-index."""
    size = POSITIONING_HEATMAP_GRID_SIZE
    grid = [[0] * size for _ in range(size)]
    if map_max_x <= map_min_x or map_max_z <= map_min_z:
        return grid
    dx = map_max_x - map_min_x
    dz = map_max_z - map_min_z
    for x, z in zip(trail["x"], trail["z"]):
        col_x = int((x - map_min_x) / dx * size)
        col_z = int((z - map_min_z) / dz * size)
        if 0 <= col_x < size and 0 <= col_z < size:
            grid[col_x][col_z] += 1
    return grid


def _build_polar_heatmap(trail, spawn_x, spawn_z, p95_dist):
    """16 angular x 8 radial bin counts centered on the personal spawn.

    Angular bin 0 = due East (+X), increasing counter-clockwise (standard math angle).
    Radial bins span 0 .. p95_dist so that the visible tail doesn't dominate.
    """
    import math

    ang_bins = POSITIONING_POLAR_ANGULAR_BINS
    rad_bins = POSITIONING_POLAR_RADIAL_BINS
    grid = [[0] * rad_bins for _ in range(ang_bins)]
    if p95_dist <= 0:
        return grid
    for x, z in zip(trail["x"], trail["z"]):
        dx = x - spawn_x
        dz = z - spawn_z
        r = (dx * dx + dz * dz) ** 0.5
        if r <= 0:
            grid[0][0] += 1
            continue
        theta = math.atan2(dz, dx)  # -pi..pi
        if theta < 0:
            theta += 2 * math.pi
        a = int(theta / (2 * math.pi) * ang_bins) % ang_bins
        r_idx = int(min(r / p95_dist, 0.999) * rad_bins)
        grid[a][r_idx] += 1
    return grid


def _extract_terrain_bounds(header):
    """Read StatHeader terrain bounds fields into a 3D {min, max} dict.

    Returns None when all six terrain fields are 0 (pre-schema sessions, where
    edition-2023 implicit presence defaults missing floats to 0.0). Callers
    should fall back to observed-extent logic in that case. Axis convention
    is +X East, +Y Up, +Z North; values are world-space units.
    """
    vals = (
        header.terrain_min_x, header.terrain_max_x,
        header.terrain_min_y, header.terrain_max_y,
        header.terrain_min_z, header.terrain_max_z,
    )
    if all(v == 0.0 for v in vals):
        return None
    return {
        "min": {
            "x": round(header.terrain_min_x, 2),
            "y": round(header.terrain_min_y, 2),
            "z": round(header.terrain_min_z, 2),
        },
        "max": {
            "x": round(header.terrain_max_x, 2),
            "y": round(header.terrain_max_y, 2),
            "z": round(header.terrain_max_z, 2),
        },
    }


def _compute_positioning(raw_samples_by_s64, min_tick, tick_rate,
                         slot_to_s64, roster_slots, nick_for_s64,
                         match_has_target_lock_data=False,
                         terrain_bounds=None):
    """Compute the positioning block from raw per-player samples.

    raw_samples_by_s64: dict[s64] -> list of (t_sec, x, y, z, has_target) tuples,
    in tick order. match_has_target_lock_data is the match-global flag captured
    in the main event loop (True iff any PlayerState had has_target=True during
    the match).

    Returns the full positioning dict per the JSON schema in the plan.
    """
    empty_block = {
        "has_position_data": False,
        "has_target_lock_data": False,
        "sample_rate_hz": POSITIONING_SAMPLE_RATE_HZ,
        "match_sample_count": 0,
        "map_bounds": None,
        "map_bounds_source": None,
        "terrain_bounds": terrain_bounds,
        "map_diagonal": 0.0,
        "base_separation": 0.0,
        "base_to_base_distance": None,
        "observed_max_range": 0.0,
        "p99_speed": 0.0,
        "teleport_threshold": POSITIONING_TELEPORT_MIN_SPEED,
        "team_base": {"1": None, "2": None},
        "players": {},
    }
    if not raw_samples_by_s64:
        return empty_block

    # Build per-player sparse trails (already downsampled in the main loop).
    # `target` is parallel to t/x/y/z and carries the has_target bool per sample.
    trails = {}
    for s64, samples in raw_samples_by_s64.items():
        if not samples:
            continue
        t_arr = [s[0] for s in samples]
        x_arr = [s[1] for s in samples]
        y_arr = [s[2] for s in samples]
        z_arr = [s[3] for s in samples]
        target_arr = [bool(s[4]) for s in samples]
        trails[s64] = {
            "t": t_arr, "x": x_arr, "y": y_arr, "z": z_arr,
            "target": target_arr,
            "first_seen": t_arr[0], "last_seen": t_arr[-1],
            "sample_count": len(t_arr),
        }

    if not trails:
        return empty_block

    # --- Spawn (median of first N kept samples, per player) ---
    spawns = {}
    for s64, tr in trails.items():
        n_spawn = min(POSITIONING_SPAWN_SAMPLES, len(tr["t"]))
        first_samples = list(zip(tr["t"], tr["x"], tr["y"], tr["z"]))[:n_spawn]
        sx, sy, sz = _median_xyz(first_samples)
        spawns[s64] = (sx, sy, sz)

    # --- Team-level scaling: centroids, stddevs, base_separation ---
    team_spawns = {1: [], 2: []}
    for s64, spawn in spawns.items():
        slot = None
        for sl, ss in slot_to_s64.items():
            if ss == s64:
                slot = sl
                break
        if slot is None:
            continue
        faction = slot_to_faction(slot)
        if faction in (1, 2):
            team_spawns[faction].append((spawn[0], spawn[2]))  # (x, z) only

    def _centroid_and_radius(pts):
        if not pts:
            return None, POSITIONING_PERSONAL_RADIUS_FALLBACK
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        if len(pts) < 2:
            return (cx, cz), POSITIONING_PERSONAL_RADIUS_FALLBACK
        mean_sq = sum(_horiz_dist(p[0], p[1], cx, cz) ** 2 for p in pts) / len(pts)
        return (cx, cz), mean_sq ** 0.5

    team_info = {}
    for f in (1, 2):
        centroid, stddev = _centroid_and_radius(team_spawns[f])
        team_info[f] = {"centroid": centroid, "radius": stddev}

    if team_info[1]["centroid"] and team_info[2]["centroid"]:
        c1 = team_info[1]["centroid"]
        c2 = team_info[2]["centroid"]
        computed_sep = _horiz_dist(c1[0], c1[1], c2[0], c2[1])
        base_to_base_distance = round(computed_sep, 2)
    else:
        computed_sep = 0.0
        base_to_base_distance = None

    # --- Observed max range (any player's max dist from their own spawn) ---
    observed_max_range = 0.0
    for s64, tr in trails.items():
        sx, _, sz = spawns[s64]
        for x, z in zip(tr["x"], tr["z"]):
            d = _horiz_dist(x, z, sx, sz)
            if d > observed_max_range:
                observed_max_range = d

    # Apply three-way floor
    base_separation = max(
        computed_sep,
        POSITIONING_MIN_BASE_SEPARATION,
        observed_max_range * POSITIONING_BASE_SEP_MAXRANGE_FRAC,
    )

    # --- Map bounds + diagonal ---
    # Prefer header-provided terrain bounds when the collector populates them
    # (new-schema sessions). Fall back to observed player extents otherwise.
    # Surface the choice via map_bounds_source so downstream / docs can reason
    # about it. Heatmap binning uses whichever bounds win.
    if terrain_bounds is not None:
        map_min_x = terrain_bounds["min"]["x"]
        map_max_x = terrain_bounds["max"]["x"]
        map_min_z = terrain_bounds["min"]["z"]
        map_max_z = terrain_bounds["max"]["z"]
        map_bounds_source = "terrain"
    else:
        all_xs = []
        all_zs = []
        for tr in trails.values():
            all_xs.extend(tr["x"])
            all_zs.extend(tr["z"])
        map_min_x, map_max_x = min(all_xs), max(all_xs)
        map_min_z, map_max_z = min(all_zs), max(all_zs)
        map_bounds_source = "observed"
    map_diagonal = _horiz_dist(map_min_x, map_min_z, map_max_x, map_max_z)

    # --- Self-calibrated teleport threshold ---
    sample_speeds = _compute_step_speeds(trails)
    sample_speeds.sort()
    p99_speed = _percentile(sample_speeds, 0.99)
    teleport_threshold = max(
        POSITIONING_TELEPORT_MIN_SPEED,
        p99_speed * POSITIONING_TELEPORT_P99_MULT,
    )

    # --- Per-player metrics ---
    players_out = {}
    match_sample_count = max(tr["last_seen"] for tr in trails.values()) + 1 if trails else 0

    for s64, tr in trails.items():
        sx, sy, sz = spawns[s64]
        sample_count = tr["sample_count"]

        # Distance series
        dists = [_horiz_dist(x, z, sx, sz) for x, z in zip(tr["x"], tr["z"])]
        sorted_d = sorted(dists)
        mean_dist = sum(dists) / sample_count if sample_count else 0.0
        max_dist = max(dists) if dists else 0.0
        p50_dist = _percentile(sorted_d, 0.50)
        p90_dist = _percentile(sorted_d, 0.90)
        p95_dist = _percentile(sorted_d, 0.95)

        # Personal base radius (clip team stddev or fallback)
        slot = None
        for sl, ss in slot_to_s64.items():
            if ss == s64:
                slot = sl
                break
        team_radius = team_info[slot_to_faction(slot)]["radius"] if slot else POSITIONING_PERSONAL_RADIUS_FALLBACK
        personal_base_radius = max(
            POSITIONING_PERSONAL_RADIUS_MIN,
            min(POSITIONING_PERSONAL_RADIUS_MAX, team_radius * 1.1),
        )

        # Segments + path length (teleport-aware)
        segments, path_length = _compute_segments_and_path(tr, teleport_threshold)
        duration_for_player = max(1.0, tr["last_seen"] - tr["first_seen"])
        path_length_per_sec = path_length / duration_for_player

        # Time in base + first leave
        ticks_in_base = sum(1 for d in dists if d < personal_base_radius)
        time_in_base_pct = ticks_in_base / sample_count if sample_count else 0.0
        time_to_first_leave = None
        for idx, d in enumerate(dists):
            if d > personal_base_radius:
                time_to_first_leave = tr["t"][idx]
                break

        # Returns with hysteresis + minimum-time-outside gate
        return_count = _compute_return_count(dists, segments, personal_base_radius, tr["t"])

        # Hulls
        hull_area = _convex_hull_area_xz(zip(tr["x"], tr["z"]))
        bbox_area = 0.0
        if sample_count >= 2:
            px_min, px_max = min(tr["x"]), max(tr["x"])
            pz_min, pz_max = min(tr["z"]), max(tr["z"])
            bbox_area = (px_max - px_min) * (pz_max - pz_min)

        # Activity score is computed in a second pass below using match-relative
        # p95 normalizers, so spread is meaningful within any match. Placeholder
        # zero here gets overwritten before the function returns.
        activity_score = 0
        band = _band_for_score(activity_score)

        # Target lock (T-key) usage: fraction of kept 1 Hz samples where the
        # player had a target lock active (`has_target=true`). The T-key is
        # tap-to-toggle in BZCC — one press activates target mode against the
        # nearest enemy, lock persists until target dies or player presses T
        # again. Absolute 0-1 ratio, cross-match comparable. Sums to zero for
        # pre-schema matches (has_target field defaults to False), matching
        # has_target_lock_data=False for the same match.
        target_samples = tr.get("target") or []
        target_lock_pct = round(
            sum(1 for v in target_samples if v) / sample_count, 3
        ) if sample_count else 0.0

        # Heatmaps
        heatmap_grid_xz = _build_heatmap_grid(tr, map_min_x, map_max_x, map_min_z, map_max_z)
        heatmap_polar = _build_polar_heatmap(tr, sx, sz, p95_dist or 1.0)

        name = nick_for_s64(s64)
        players_out[name] = {
            "spawn": {"x": round(sx, 2), "y": round(sy, 2), "z": round(sz, 2)},
            "personal_base_radius": round(personal_base_radius, 2),
            "sample_count": sample_count,
            "first_seen_sec": tr["first_seen"],
            "last_seen_sec": tr["last_seen"],
            "metrics": {
                "mean_dist": round(mean_dist, 1),
                "max_dist": round(max_dist, 1),
                "p50_dist": round(p50_dist, 1),
                "p90_dist": round(p90_dist, 1),
                "p95_dist": round(p95_dist, 1),
                "time_in_base_pct": round(time_in_base_pct, 3),
                "time_to_first_leave_sec": time_to_first_leave,
                "path_length": round(path_length, 1),
                "path_length_per_sec": round(path_length_per_sec, 2),
                "convex_hull_area": round(hull_area, 1),
                "bounding_box_area": round(bbox_area, 1),
                "return_to_base_count": return_count,
                "activity_score": activity_score,
                "movement_band": band,
                "target_lock_pct": target_lock_pct,
            },
            "trail": {
                "t": tr["t"],
                "x": [round(v, 2) for v in tr["x"]],
                "z": [round(v, 2) for v in tr["z"]],
                "y": [round(v, 2) for v in tr["y"]],
                "segments": segments,
            },
            "heatmap_grid_xz": heatmap_grid_xz,
            "heatmap_polar": heatmap_polar,
        }

    # --- Activity score: second pass with match-relative p95 normalizers ---
    # Higher score = more active player (covered more map, spent less time at base).
    # Using fixed normalizers (e.g. base_separation * 0.7) saturates 80% of the
    # formula on active matches, leaving only time_in_base_pct as the differentiator.
    # Match-relative normalization makes the score self-calibrate so spread is
    # meaningful within any given match.
    if players_out:
        all_max = sorted(v["metrics"]["max_dist"] for v in players_out.values())
        all_pps = sorted(v["metrics"]["path_length_per_sec"] for v in players_out.values())
        p95_max = _percentile(all_max, 0.95) or 1.0
        p95_pps = _percentile(all_pps, 0.95) or 1.0
        for v in players_out.values():
            m = v["metrics"]
            norm_max = min(m["max_dist"] / p95_max, 1.0) if p95_max > 0 else 0.0
            norm_pps = min(m["path_length_per_sec"] / p95_pps, 1.0) if p95_pps > 0 else 0.0
            score = round(100 * (
                0.5 * (1 - m["time_in_base_pct"])
                + 0.3 * norm_max
                + 0.2 * norm_pps
            ))
            m["activity_score"] = max(0, min(100, score))
            m["movement_band"] = _band_for_score(m["activity_score"])

    # --- Assemble team_base dict (None for empty teams) ---
    team_base_out = {}
    for f in (1, 2):
        info = team_info[f]
        if info["centroid"] is None:
            team_base_out[str(f)] = None
        else:
            team_base_out[str(f)] = {
                "centroid": {"x": round(info["centroid"][0], 2), "z": round(info["centroid"][1], 2)},
                "radius": round(info["radius"], 2),
            }

    return {
        "has_position_data": True,
        "has_target_lock_data": bool(match_has_target_lock_data),
        "sample_rate_hz": POSITIONING_SAMPLE_RATE_HZ,
        "match_sample_count": int(match_sample_count),
        "map_bounds": {
            "min": {"x": round(map_min_x, 2), "z": round(map_min_z, 2)},
            "max": {"x": round(map_max_x, 2), "z": round(map_max_z, 2)},
        },
        "map_bounds_source": map_bounds_source,
        "terrain_bounds": terrain_bounds,
        "map_diagonal": round(map_diagonal, 2),
        "base_separation": round(base_separation, 2),
        "base_to_base_distance": base_to_base_distance,
        "observed_max_range": round(observed_max_range, 2),
        "p99_speed": round(p99_speed, 2),
        "teleport_threshold": round(teleport_threshold, 2),
        "team_base": team_base_out,
        "players": players_out,
    }


def load_known_players(path=STEAMID_TO_NAME_PATH):
    """Load canonical player names from the known-players registry.

    Parses steamid_to_name.txt (UTF-8, one `<steam64>=<name>` per line)
    and returns a dict mapping Steam64 int -> canonical display name.
    Blank lines and entries with empty names are skipped so the pipeline
    falls back to in-session nicknames for those Steam IDs.
    """
    known = {}
    if not path.exists():
        print(f"WARNING: {path.name} not found, no canonical player names available")
        return known

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            sid_str, name = line.split("=", 1)
            sid_str = sid_str.strip()
            name = name.strip()
            if not sid_str.isdigit() or not name:
                continue
            known[int(sid_str)] = name

    print(f"Loaded {len(known)} known player names from {path.name}")
    return known


def process_match(session, source_file, source_size_bytes, submitter, resolve_weapon, resolve_unit, known_powerup_odfs, building_odfs, known_players=None):
    """Process a single match session into pre-computed stats.

    `source_size_bytes` is the byte size of the source .binpb.gz at
    discovery time. It's stamped into the output JSON's
    `match.source_size_bytes` field so subsequent runs can use it as the
    incremental cache key (see load_cache_index() and the `--force` flag).
    """
    header = session.header
    events = session.event_stream

    tick_rate = header.tick_rate or 20

    # Header-provided terrain bounds (new-schema sessions). None when absent so
    # _compute_positioning falls back to observed-extent map_bounds. Also
    # mirrored onto the top-level `match` object below.
    terrain_bounds = _extract_terrain_bounds(header)

    # Build identity maps from new header fields
    slot_to_s64 = dict(header.teamnum_to_s64)
    s64_to_slot = dict(header.s64_to_teamnum)
    s64_to_nick = dict(header.s64_to_nick)

    if known_players is None:
        known_players = {}

    nick_map = {}  # slot -> display name
    for slot, s64 in slot_to_s64.items():
        nick_map[slot] = known_players.get(s64) or s64_to_nick.get(s64, f"Player {slot}")

    all_slots = set(nick_map.keys())

    # Team commanders: slot 1 = Team 1 commander, slot 6 = Team 2 commander.
    # Consumed by the rich match picker (js/app.js) via the manifest entry.
    team_leaders = {}
    for slot, team_key in ((1, "1"), (6, "2")):
        s64 = slot_to_s64.get(slot)
        if s64 and s64 in s64_to_nick:
            team_leaders[team_key] = {
                "name": nick_map.get(slot) or s64_to_nick.get(s64),
                "s64": str(s64),
            }

    def nick_for_s64(s64):
        return known_players.get(s64) or s64_to_nick.get(s64, f"Player {s64_to_slot.get(s64, '?')}")

    def in_game_nick_for(s64, resolved_name):
        """Return the raw in-game nick if it differs from `resolved_name`
        (case-insensitive, trimmed). Otherwise return None so consumers
        can suppress the subtext entirely. Surfaces the in-game alias on
        the dashboard only when it adds new information beyond what the
        canonical/known-name registry already shows.
        """
        raw = s64_to_nick.get(s64)
        if not raw or not resolved_name:
            return None
        if raw.strip().casefold() == resolved_name.strip().casefold():
            return None
        return raw

    # Per-player accumulators (keyed on Steam64)
    player_dealt = defaultdict(float)
    player_received = defaultdict(float)
    player_weapon_dealt = defaultdict(lambda: defaultdict(float))
    player_weapon_received = defaultdict(lambda: defaultdict(float))
    player_shots_fired = defaultdict(lambda: defaultdict(int))
    player_shots_hit = defaultdict(lambda: defaultdict(int))
    # PvP-only hit counter (subset of player_shots_hit). Increments only
    # when a BulletHit's victim is a Steam64 player. Drives v2.3 thug
    # composite axes (thug_accuracy weapon-normalized formula needs the
    # PvP/PvE split per weapon) and the per-match leaderboard's new
    # weapon_breakdown[w].pvp_hits field.
    player_pvp_shots_hit = defaultdict(lambda: defaultdict(int))
    player_weapons_used = defaultdict(set)

    # Asset (AI/structure) accumulators per owning slot
    asset_dealt = defaultdict(float)
    asset_received = defaultdict(float)

    # Player-dealt damage to enemy buildings. Feeds VTSR-T `structure_share`
    # axis. Built via a BulletHit -> DamageDealt join because DamageDealt
    # carries no victim_odf in the proto: BulletHit logs (tick, shooter,
    # ordnance, victim_odf) immediately before the matching DamageDealt
    # logs (tick, shooter, ordnance, amount). We push victim_odf into a
    # per-key FIFO queue at BulletHit time and popleft when the paired
    # DamageDealt arrives.
    # Queue policy: orphan BulletHits (shield absorb -> no DamageDealt) stay
    # in the queue; orphan DamageDealts (crush, mine, environmental) get an
    # empty-queue popleft no-op. Friendly-fire on own structures is rejected
    # POST-loop using `team_factions` (line ~3245) because pre-collector-
    # schema sessions emit empty `bh.shooter_odf`, breaking in-loop checks.
    # During the loop we accumulate `player_structure_dealt_by_vfc[s64][vfc]
    # += amount` (vfc = victim faction code 'i'/'e'/'f'); the post-loop
    # reconciliation collapses to `player_structure_dealt[s64]` summing only
    # the (s64, vfc) tuples where vfc != shooter's team-faction code.
    bh_pending = defaultdict(deque)  # (tick, shooter, ordnance_lower) -> deque[victim_odf]
    player_structure_dealt_by_vfc = defaultdict(lambda: defaultdict(float))  # s64 -> {vfc: amount}

    # Rivalry matrix (player-on-player only, keyed on Steam64)
    rivalry = defaultdict(lambda: defaultdict(float))

    # Faction totals
    faction_dealt = defaultdict(float)
    faction_received = defaultdict(float)
    faction_shots = defaultdict(int)
    faction_hits = defaultdict(int)

    # Timeline
    min_tick = float("inf")
    max_tick = 0

    timeline_player = defaultdict(lambda: defaultdict(float))
    timeline_faction = defaultdict(lambda: defaultdict(float))

    # Weapon meta
    weapon_total_damage = defaultdict(float)
    weapon_total_shots = defaultdict(int)
    weapon_total_hits = defaultdict(int)
    weapon_users = defaultdict(set)

    # Per-victim hit tracking (from BulletHit)
    player_hits_by_victim = defaultdict(lambda: defaultdict(int))

    # Kill/death tracking (from UnitDestroyed)
    player_kills = Counter()
    player_deaths = Counter()
    kill_feed = []
    kill_rivalry = defaultdict(lambda: defaultdict(int))
    vehicle_destruction_count = Counter()
    snipe_count = 0

    # Pickups (from PickupPowerup events). Empty for pre-schema sessions.
    # match_has_pickup_data flips True on the first pickup_powerup event
    # seen; mirrored to meta.has_pickup_data + manifest entry, lets the UI
    # gate "no pickup data" badges on legacy matches.
    pickup_events = []
    pickup_count_by_player = Counter()  # s64 -> count (excludes AI pickers)
    pickup_count_by_odf = Counter()
    match_has_pickup_data = False

    # Powerup/crate destructions. Populated for BOTH old and new schema
    # from unit_destroyed events whose victim_odf is in KNOWN_POWERUP_ODFS
    # AND killer_team != 0 (real player shot the powerup before pickup,
    # effectively denying the enemy economy).
    powerup_destruction_feed = []
    powerup_destruction_by_player = Counter()  # s64 -> destruction count
    powerup_destruction_by_odf = Counter()

    # Deployable destructions (mines/utilities). Populated for both schemas
    # from unit_destroyed events whose victim_odf is in KNOWN_DEPLOYABLE_ODFS
    # (regardless of killer_team -- mines self-detonate or get shot, neither
    # is a "kill" in any meaningful sense).
    deployable_destruction_by_player = Counter()
    deployable_destruction_by_odf = Counter()

    # Snipes (from UnitSniped events). Pre-Phase-3 sessions only carry
    # `tick`; new-schema adds shooter / victim / odfs / teams. Empty feed
    # for matches with zero snipes; UI hides the card.
    snipe_feed = []
    snipe_count_by_player = Counter()  # s64 -> count

    # Sentinel damage telemetry. Counts PAIRS (DD+DR together = 1 pair);
    # total_amount sums the DD-side amount only (DR amount is always equal,
    # so double-counting would misrepresent the "impact sum"). See the
    # _is_sentinel_damage helper and docs/DATA_DICTIONARY.md §7 "Sentinel Damage Filter".
    sentinel_damage = {
        "count": 0,
        "total_amount": 0.0,
        "first_tick": None,
        "last_tick": None,
    }
    # Dedup key for log lines; one line per unique (tick, team, amount) tuple.
    sentinel_log_seen = set()

    # Collect all ordnance ODFs for disambiguation
    all_ordnance = set()
    # Collect all non-ordnance ODFs seen in this match (vehicle/unit ODFs from
    # bullet_hit victim/shooter, unit_destroyed killer/victim, and PlayerState).
    # Fed into `odf_map` in the match output so the Raw Data Browser can resolve
    # every raw ODF string to a human-readable name.
    all_unit_odfs = set()

    # Faction detection accumulators (consumed by detect_team_factions() after
    # the event loop). slot_first_odf captures the literal "starting ship" --
    # first non-empty ODF observed for each slot in UpdateTick events
    # (Algorithm A). slot_faction_votes accumulates first-letter votes from
    # every team-attributed vehicle/structure/pilot ODF emitted for the slot
    # across the event stream (Algorithm B). Combined per-slot vote determines
    # each slot's faction; per-team mode determines team faction.
    slot_first_odf = {}  # slot -> first non-empty PlayerState.odf
    slot_faction_votes = defaultdict(Counter)  # slot -> Counter[faction_code]

    # Positioning: per-player raw sample buffer (downsampled to ~1 Hz in the loop below).
    # Keyed by Steam64 -> list of (t_sec, x, y, z, has_target) tuples in tick order.
    position_samples = defaultdict(list)
    position_last_kept_tick = {}  # s64 -> last tick we kept a sample for (for 1 Hz downsample)
    tick_stride = max(1, tick_rate // POSITIONING_SAMPLE_RATE_HZ)

    # ----- Loadout / per-ship combat accumulators (v2.3) -----
    # Per-tick ship-time. UpdateTick is the only signal that says "what
    # ship is each player currently in"; we sample at the full tick rate
    # so a ship-switch is reflected within ~1 tick. These accumulators
    # are NOT downsampled like the position samples -- the goal is
    # ship-time, not movement.
    #   player_ship_ticks[s64][odf_lower] -> int    (# of UpdateTick samples per ship)
    # Display names ("Tank", "Scout", "Assault Tank", "Pilot") get
    # resolved at the leaderboard build via the existing prettify_odf()
    # chain (unit_name -> stripped-vsr -> wpn_name -> title-cased stem).
    # No invented class taxonomy ("wingman" / "morphtank" / "turret")
    # appears in the output -- consumers see the actual ships.
    player_ship_ticks = defaultdict(lambda: defaultdict(int))

    # Running "what ship is each Steam64 currently in" map. Updated every
    # UpdateTick; queried on every BulletInit / BulletHit / DamageDealt /
    # UnitDestroyed event with a player shooter (or victim, for deaths)
    # so we can attribute the event to the player's *active* ship at
    # event time. Empty / missing = no UpdateTick yet for this player;
    # events that fire before the first tick bucket to "unknown" in
    # per_ship_combat.
    s64_to_current_odf = {}

    # Per-(s64, odf_lower) combat aggregates. One row per player per ship
    # they used in the match. Sums kills / deaths / dealt damage /
    # shots / hits / pvp_kills / pvp_hits, all tick-joined to the active
    # ship at event time. Time is converted to seconds at the end via
    # `ticks / tick_rate`.
    per_ship_combat = defaultdict(lambda: defaultdict(lambda: {
        "kills": 0,
        "deaths": 0,
        "pvp_kills": 0,
        "pvp_deaths": 0,
        "dealt": 0.0,
        "shots": 0,
        "hits": 0,
        "pvp_hits": 0,
    }))

    def _ship_key(s64):
        """Resolve the active ship ODF (lowercased) for `s64` at the
        current event. Returns "unknown" before the first UpdateTick
        for that player. Empty / missing buckets to "unknown" so the
        per_ship_combat row is rendered explicitly rather than silently
        merged into another ship."""
        cur = s64_to_current_odf.get(s64) or ""
        if not cur:
            return "unknown"
        return cur.lower()
    # Target-lock availability for this match. Any observed has_target=True sample
    # flips this to True. Stays False for pre-schema matches (field defaults to
    # False) and new-schema matches where no player ever activated target mode.
    # The flag is propagated to positioning.has_target_lock_data,
    # match.has_target_lock_data, and on to career_stats[].matches_with_target_lock_data.
    match_has_target_lock_data = False

    # Per-(picker, powerup_odf, powerup_team) tick-cooldown deduplication
    # of pickup_powerup events. The engine fires a pickup_powerup event
    # every time a vehicle's collision volume overlaps a powerup's
    # pickup zone, regardless of whether the powerup's effect is actually
    # applied. For continuous-effect structures like apserv (Service Pod),
    # this means the engine emits dozens-to-hundreds of PP events per
    # pad visit (one per engine re-check of the volume), each of which
    # may be a real consume or a "rejected" no-op (player already at full
    # HP / ammo / shield). Without an in-event "consumed" boolean or a
    # per-instance entity ID, we collapse PP events sharing
    # (picker, powerup_odf, powerup_team) within PICKUP_DEDUP_GAP_TICKS
    # of each other into one logical pickup -- effectively counting
    # each "pad visit" or "crate touch" as one pickup, not 60.
    #
    # An earlier attempt tried to pair each PP with a same-tick synthetic
    # UnitDestroyed (killer_team=0) following the doc's claim that the
    # engine "double-emits" in new-schema sessions. Empirically, the
    # synthetic UD is no longer emitted at all by the post-2026-05-01
    # collector (zero such events in current new-schema corpus matches),
    # so that pairing approach drops 100% of PP events as "rejected".
    # See docs/DATA_DICTIONARY.md S8 erratum for the corrected three-era
    # collector behavior model.
    PICKUP_DEDUP_GAP_TICKS = 60  # 3 seconds at 20 Hz tick rate
    pickup_last_kept_tick = {}  # (picker, powerup_odf_lower, powerup_team) -> last kept tick

    i = 0
    n = len(events)
    while i < n:
        evt = events[i]
        event_type = evt.WhichOneof("event_type")

        if event_type == "bullet_init":
            bi = evt.bullet_init
            shooter = bi.shooter
            odf = bi.ordnance_odf or ""
            if shooter > 0 and odf:
                all_ordnance.add(odf)
                player_shots_fired[shooter][odf] += 1
                slot = s64_to_slot.get(shooter)
                if slot:
                    faction = slot_to_faction(slot)
                    if faction:
                        faction_shots[faction] += 1
                weapon_total_shots[odf] += 1
                # Per-ship combat: tick-join the shot to the shooter's
                # active ship ODF (v2.3).
                per_ship_combat[shooter][_ship_key(shooter)]["shots"] += 1
            if bi.tick > max_tick:
                max_tick = bi.tick
            if bi.tick < min_tick:
                min_tick = bi.tick
            i += 1

        elif event_type == "bullet_hit":
            bh = evt.bullet_hit
            shooter = bh.shooter
            odf = bh.ordnance_odf or ""
            is_pvp_hit = shooter > 0 and bh.victim > 0
            if shooter > 0 and odf:
                all_ordnance.add(odf)
                player_shots_hit[shooter][odf] += 1
                if is_pvp_hit:
                    # PvP-only weapon-level hit counter (subset of
                    # player_shots_hit). Drives v2.3 thug_accuracy.
                    player_pvp_shots_hit[shooter][odf] += 1
                slot = s64_to_slot.get(shooter)
                if slot:
                    faction = slot_to_faction(slot)
                    if faction:
                        faction_hits[faction] += 1
                weapon_total_hits[odf] += 1
            # Per-ship combat: tick-join hits/pvp_hits to active ship.
            if shooter > 0:
                ship = _ship_key(shooter)
                per_ship_combat[shooter][ship]["hits"] += 1
                if is_pvp_hit:
                    per_ship_combat[shooter][ship]["pvp_hits"] += 1
            if shooter > 0 and bh.victim > 0:
                player_hits_by_victim[shooter][bh.victim] += 1
            if bh.victim_odf:
                all_unit_odfs.add(bh.victim_odf)
            if bh.shooter_odf:
                all_unit_odfs.add(bh.shooter_odf)
            # Stash victim_odf so the paired DamageDealt can attribute
            # building damage for the VTSR-T `structure_share` axis. Only
            # human shooters with a known victim_odf are interesting;
            # AI-owned damage already lands in `asset_dealt` and isn't a
            # thug signal. We push regardless of whether the victim is a
            # building -- the DamageDealt-side check classifies it. The
            # friendly-fire filter is deferred to post-loop reconciliation
            # because pre-collector-schema sessions leave `bh.shooter_odf`
            # empty; team_factions (computed after the loop) gives a
            # reliable shooter-faction code in those cases.
            if shooter > 0 and bh.victim_odf:
                bh_pending[(bh.tick, shooter, odf.lower())].append(bh.victim_odf.lower())
            # Faction-detection votes (Algorithm B): the shooter and victim
            # ODFs are vehicle/structure/pilot ODFs whose first letter
            # encodes the owner's faction. Skip ordnance_odf -- weapon
            # prefixes don't follow the i/e/f convention.
            if shooter > 0 and bh.shooter_odf:
                _sl = s64_to_slot.get(shooter)
                _fc = faction_from_odf(bh.shooter_odf)
                if _sl and _fc:
                    slot_faction_votes[_sl][_fc] += 1
            if bh.victim > 0 and bh.victim_odf:
                _sl = s64_to_slot.get(bh.victim)
                _fc = faction_from_odf(bh.victim_odf)
                if _sl and _fc:
                    slot_faction_votes[_sl][_fc] += 1
            if bh.tick > max_tick:
                max_tick = bh.tick
            if bh.tick < min_tick:
                min_tick = bh.tick
            i += 1

        elif event_type == "damage_dealt":
            dd = evt.damage_dealt
            dr = None
            has_paired_dr = (
                i + 1 < n
                and events[i + 1].WhichOneof("event_type") == "damage_received"
            )
            if has_paired_dr:
                dr = events[i + 1].damage_received

            # Sentinel filter: DAMAGE_TYPE_UNKNOWN force-kill events have
            # amount > 1e6. Skip the whole pair (DD + paired DR) before any
            # accumulator touches the values. Either side being sentinel
            # triggers the skip — in practice they carry identical amounts.
            if _is_sentinel_damage(dd.amount) or (
                dr is not None and _is_sentinel_damage(dr.amount)
            ):
                sentinel_damage["count"] += 1
                sentinel_damage["total_amount"] += float(dd.amount)
                tick_val = int(dd.tick)
                if sentinel_damage["first_tick"] is None or tick_val < sentinel_damage["first_tick"]:
                    sentinel_damage["first_tick"] = tick_val
                if sentinel_damage["last_tick"] is None or tick_val > sentinel_damage["last_tick"]:
                    sentinel_damage["last_tick"] = tick_val
                log_key = (tick_val, int(dd.team), float(dd.amount))
                if log_key not in sentinel_log_seen:
                    sentinel_log_seen.add(log_key)
                    print(
                        f"  sentinel damage: tick={tick_val} team={dd.team} "
                        f"shooter={dd.shooter} victim={dr.victim if dr else 0} "
                        f"amount={dd.amount} odf='{dd.ordnance_odf or ''}'"
                    )
                i += 2 if has_paired_dr else 1
                continue

            if has_paired_dr:
                i += 2
            else:
                i += 1

            skip_shooter = (dd.team == 0 or dd.amount == 0.0)

            tick = dd.tick
            if tick > max_tick:
                max_tick = tick
            if tick < min_tick:
                min_tick = tick

            odf = dd.ordnance_odf or ""
            if odf:
                all_ordnance.add(odf)

            if not skip_shooter:
                shooter = dd.shooter
                shooter_faction = slot_to_faction(dd.team)

                if shooter > 0:
                    player_dealt[shooter] += dd.amount
                    if odf:
                        player_weapon_dealt[shooter][odf] += dd.amount
                        player_weapons_used[shooter].add(odf)
                    if odf:
                        weapon_total_damage[odf] += dd.amount
                        weapon_users[odf].add(shooter)
                    # Per-ship combat: tick-join dealt damage to active
                    # ship (v2.3). Sums regardless of whether the
                    # victim is PvP or PvE -- the per-ship table totals
                    # all dealt damage; the PvP/PvE split is captured via
                    # pvp_kills / pvp_hits on the same row.
                    per_ship_combat[shooter][_ship_key(shooter)]["dealt"] += dd.amount

                    # Structure-damage attribution for VTSR-T `structure_share`.
                    # Pop the matching BulletHit-side victim_odf and bucket the
                    # damage by victim faction code (i/e/f). The friendly-fire
                    # filter happens post-loop using team_factions (some old
                    # sessions emit empty `bh.shooter_odf`, so an in-loop check
                    # would conservatively drop ALL structure damage on those
                    # matches). Empty-queue popleft is a no-op for orphan
                    # DamageDealts (crush, mine, environmental) -- those are
                    # conservatively uncounted. Same honesty contract as
                    # `pve_dealt`.
                    queue = bh_pending.get((dd.tick, shooter, (odf or "").lower())) if odf else None
                    if queue:
                        v_odf = queue.popleft()
                        if v_odf in building_odfs:
                            v_fc = faction_from_odf(v_odf)
                            if v_fc:
                                player_structure_dealt_by_vfc[shooter][v_fc] += dd.amount
                else:
                    asset_dealt[dd.team] += dd.amount

                if shooter_faction:
                    faction_dealt[shooter_faction] += dd.amount

            if dr and dr.team != 0 and dr.amount != 0.0:
                victim = dr.victim
                victim_faction = slot_to_faction(dr.team)

                if victim > 0:
                    player_received[victim] += dr.amount
                    if odf:
                        player_weapon_received[victim][odf] += dr.amount
                else:
                    asset_received[dr.team] += dr.amount

                if victim_faction:
                    faction_received[victim_faction] += dr.amount

                if not skip_shooter and dd.shooter > 0 and victim > 0:
                    rivalry[dd.shooter][victim] += dd.amount

        elif event_type == "unit_destroyed":
            ud = evt.unit_destroyed
            if ud.tick > max_tick:
                max_tick = ud.tick
            if ud.tick < min_tick:
                min_tick = ud.tick

            victim_lower = (ud.victim_odf or "").lower()

            # Four-way classification of unit_destroyed events. See
            # docs/DATA_DICTIONARY.md §8 "UnitDestroyed Classification & Powerup Economy"
            # for evidence + rationale.
            #
            # CATEGORY 1: Deployable utility (mine, decoy). Never a kill.
            # Track for the deployable_destructions stats block, then skip
            # all kill aggregations.
            if victim_lower in KNOWN_DEPLOYABLE_ODFS:
                deployable_destruction_by_odf[victim_lower] += 1
                if ud.killer > 0:
                    deployable_destruction_by_player[ud.killer] += 1
                if ud.victim_odf:
                    all_unit_odfs.add(ud.victim_odf)
                if ud.killer_odf:
                    all_unit_odfs.add(ud.killer_odf)
                i += 1
                continue

            # CATEGORY 2 & 3: Powerup. Split by killer_team semantic.
            if victim_lower in known_powerup_odfs:
                if ud.victim_odf:
                    all_unit_odfs.add(ud.victim_odf)
                if ud.killer_odf:
                    all_unit_odfs.add(ud.killer_odf)
                if ud.killer_team == 0:
                    # CATEGORY 2: Pickup disguised as destruction. The
                    # engine emits this synthetic UnitDestroyed alongside
                    # the real PickupPowerup event in new-schema sessions
                    # (see audit data). For old-schema sessions, this is
                    # the only signal we have and the pickup data is lost.
                    # Either way: not a kill, not a destruction, just suppress.
                    pass
                else:
                    # CATEGORY 3: Powerup/crate destruction. A real player
                    # shot the powerup before someone else could pick it
                    # up. Track for the powerup_destructions block.
                    killer_name = nick_for_s64(ud.killer) if ud.killer > 0 else f"Team {ud.killer_team}"
                    powerup_destruction_feed.append({
                        "tick": ud.tick,
                        "killer": killer_name,
                        "killer_in_game_nick": in_game_nick_for(ud.killer, killer_name) if ud.killer > 0 else None,
                        "killer_odf": ud.killer_odf,
                        "powerup_odf": ud.victim_odf,
                        # `powerup_name` is injected post-loop once the
                        # `powerup_display_name` closure is defined (it
                        # depends on `weapon_name_map` / `unit_name_map`
                        # which are built after this event loop completes).
                        "powerup_team": ud.victim_team,
                    })
                    powerup_destruction_by_odf[victim_lower] += 1
                    if ud.killer > 0:
                        powerup_destruction_by_player[ud.killer] += 1
                i += 1
                continue

            # CATEGORY 4: Real vehicle/structure/soldier. Existing
            # accumulators (player_kills, player_deaths, kill_rivalry,
            # vehicle_destruction_count, kill_feed) handle these.
            #
            # First, drop pure-noise rows: events where every attribution
            # field is zero/empty. These are typically unattributed phantom
            # destructions (script-spawned debris, post-base-shockwave
            # detonations of asteroids, ephemeral entities the engine
            # never wired up) and convey no game information. They render
            # in the kill feed as `Team 0 (?) -> Team 0 (?)` rows that
            # users see as garbage. See plan: killfeed cleanup §1.
            if (
                ud.killer == 0 and ud.killer_team == 0 and not ud.killer_odf
                and ud.victim == 0 and ud.victim_team == 0 and not ud.victim_odf
            ):
                i += 1
                continue

            killer_is_player = ud.killer > 0
            victim_is_player = ud.victim > 0
            is_pvp_kill = killer_is_player and victim_is_player
            if killer_is_player:
                player_kills[ud.killer] += 1
                # Per-ship combat: attribute kill to killer's active ship.
                kc_ship = _ship_key(ud.killer)
                per_ship_combat[ud.killer][kc_ship]["kills"] += 1
                if is_pvp_kill:
                    per_ship_combat[ud.killer][kc_ship]["pvp_kills"] += 1
            if victim_is_player:
                player_deaths[ud.victim] += 1
                # Death attributed to victim's active ship at time of death.
                vc_ship = _ship_key(ud.victim)
                per_ship_combat[ud.victim][vc_ship]["deaths"] += 1
                if is_pvp_kill:
                    per_ship_combat[ud.victim][vc_ship]["pvp_deaths"] += 1
            if is_pvp_kill:
                kill_rivalry[ud.killer][ud.victim] += 1
            if ud.victim_odf:
                vehicle_destruction_count[ud.victim_odf] += 1
                all_unit_odfs.add(ud.victim_odf)
            if ud.killer_odf:
                all_unit_odfs.add(ud.killer_odf)

            # Faction-detection votes (Algorithm B): killer_odf and
            # victim_odf are vehicle/structure/pilot ODFs whose first
            # letter encodes the owner's faction. Vote against the
            # owning slot via the proto's killer_team / victim_team
            # (uint32 slots, 1-10 when populated).
            if ud.killer_odf and 1 <= ud.killer_team <= 10:
                _fc = faction_from_odf(ud.killer_odf)
                if _fc:
                    slot_faction_votes[ud.killer_team][_fc] += 1
            if ud.victim_odf and 1 <= ud.victim_team <= 10:
                _fc = faction_from_odf(ud.victim_odf)
                if _fc:
                    slot_faction_votes[ud.victim_team][_fc] += 1

            # Display-label fallback when killer/victim is not a Steam64.
            # Slot in 1-5 -> Team 1 (faction-aligned), 6-10 -> Team 2.
            # Slot 0 means no team attribution at all -- render as
            # "Self" when the victim died on foot in a pilot ODF
            # (typical for pilot suicide / fall / drown / off-map),
            # otherwise "World" (env damage / unattributed).
            victim_lower_odf_disp = (ud.victim_odf or "").lower()
            victim_is_pilot = victim_lower_odf_disp in PILOT_ODFS

            if ud.killer > 0:
                killer_name = nick_for_s64(ud.killer)
            else:
                killer_faction = slot_to_faction(ud.killer_team)
                if killer_faction in (1, 2):
                    killer_name = f"Team {killer_faction}"
                elif victim_is_pilot:
                    killer_name = "Self"
                else:
                    killer_name = "World"

            if ud.victim > 0:
                victim_name = nick_for_s64(ud.victim)
            else:
                victim_faction = slot_to_faction(ud.victim_team)
                if victim_faction in (1, 2):
                    victim_name = f"Team {victim_faction}"
                else:
                    victim_name = "World"

            kill_feed.append({
                "tick": ud.tick,
                "killer": killer_name,
                # killer_team / victim_team carry the raw slot (1-10) so
                # downstream logic (compute_match_winner, faction badges)
                # can attribute kill-feed events to a specific team
                # without re-deriving identity from the display string.
                # 0 = no team attribution.
                "killer_team": int(ud.killer_team),
                # In-game nicks parallel to leaderboard[].in_game_nick.
                # null when killer/victim is not a Steam64 (a "Team N"
                # placeholder), or when the in-game nick matches the
                # resolved name. UI uses the same suppression rule.
                "killer_in_game_nick": in_game_nick_for(ud.killer, killer_name) if ud.killer > 0 else None,
                "killer_odf": ud.killer_odf,
                "victim": victim_name,
                "victim_team": int(ud.victim_team),
                "victim_in_game_nick": in_game_nick_for(ud.victim, victim_name) if ud.victim > 0 else None,
                "victim_odf": ud.victim_odf,
            })
            i += 1

        elif event_type == "unit_sniped":
            us = evt.unit_sniped
            if us.tick > max_tick:
                max_tick = us.tick
            if us.tick < min_tick:
                min_tick = us.tick
            snipe_count += 1
            if us.shooter_odf:
                all_unit_odfs.add(us.shooter_odf)
            if us.victim_odf:
                all_unit_odfs.add(us.victim_odf)
            # Faction-detection votes (Algorithm B): shooter_odf and
            # victim_odf are vehicle/pilot ODFs; vote against the
            # owning slot via shooter_team / victim_team. Slot fields
            # are reliable under both buggy and fixed collectors (see
            # the slot-derive note below).
            if us.shooter_odf and 1 <= us.shooter_team <= 10:
                _fc = faction_from_odf(us.shooter_odf)
                if _fc:
                    slot_faction_votes[us.shooter_team][_fc] += 1
            if us.victim_odf and 1 <= us.victim_team <= 10:
                _fc = faction_from_odf(us.victim_odf)
                if _fc:
                    slot_faction_votes[us.victim_team][_fc] += 1
            # Slot-derive identity. The statsgate collector through
            # ~2026-05-04 had a copy-paste bug at stat_client.cpp:273
            # where `set_shooter()` was called twice -- so `us.shooter`
            # got overwritten with the victim's Steam64 and `us.victim`
            # was never written at all (always 0). Slot fields
            # (us.shooter_team / us.victim_team) are correct under both
            # the buggy and fixed collectors, so we derive identity from
            # them exclusively. Forward-compatible: when fixed-collector
            # sessions arrive, the resolver still produces correct
            # output without changes. See _sniper_investigation/DIAGNOSIS.txt.
            sniper_s64 = slot_to_s64.get(us.shooter_team, 0)
            victim_s64 = slot_to_s64.get(us.victim_team, 0)
            sniper_name = nick_for_s64(sniper_s64) if sniper_s64 else f"Team {us.shooter_team}"
            victim_name = nick_for_s64(victim_s64) if victim_s64 else f"Team {us.victim_team}"
            # Forward-compat sanity: in fixed-collector sessions, us.shooter
            # should equal sniper_s64. In buggy-collector sessions it equals
            # victim_s64 (the bug pattern). If it equals neither slot owner,
            # the upstream wire format has changed in an unexpected way --
            # surface it during reprocess so we can investigate.
            if us.shooter > 0:
                poisoned_slot = s64_to_slot.get(us.shooter)
                if poisoned_slot and poisoned_slot not in (us.shooter_team, us.victim_team):
                    print(
                        f"WARN: snipe at tick {us.tick} in {source_file}: shooter S64 "
                        f"{us.shooter} maps to slot {poisoned_slot}, expected "
                        f"{us.shooter_team} (sniper) or {us.victim_team} (victim)"
                    )
            snipe_feed.append({
                "tick": us.tick,
                "sniper": sniper_name,
                "sniper_in_game_nick": in_game_nick_for(sniper_s64, sniper_name) if sniper_s64 else None,
                "sniper_odf": us.shooter_odf or "",
                "victim": victim_name,
                "victim_in_game_nick": in_game_nick_for(victim_s64, victim_name) if victim_s64 else None,
                "victim_odf": us.victim_odf or "",
            })
            if sniper_s64:
                snipe_count_by_player[sniper_s64] += 1
            i += 1

        elif event_type == "pickup_powerup":
            pp = evt.pickup_powerup
            if pp.tick > max_tick:
                max_tick = pp.tick
            if pp.tick < min_tick:
                min_tick = pp.tick
            # match_has_pickup_data stays loose: True on the first PP event
            # regardless of accept/reject, because existing UI gates treat
            # this as "match recorded by a new-schema collector," not "match
            # has interesting pickup data." Tightening to "any accepted PP"
            # would risk showing legit matches as "no pickup data" if every
            # touch happened to be rejected.
            match_has_pickup_data = True
            # ODF registration also stays loose -- rejected events reference
            # real ODFs that the Raw Data Browser still needs to resolve.
            if pp.powerup_odf:
                all_unit_odfs.add(pp.powerup_odf)
            if pp.picker_odf:
                all_unit_odfs.add(pp.picker_odf)
            # Faction-detection votes (Algorithm B): picker_odf is the
            # picker's vehicle/pilot ODF. Vote against picker_team. We
            # skip powerup_odf -- powerup ODFs (ap*/ep*/fp*) follow a
            # related but distinct prefix convention that overlaps
            # cleanly with i/e/f only by coincidence; not worth the
            # extra correctness review for marginal extra signal.
            if pp.picker_odf and 1 <= pp.picker_team <= 10:
                _fc = faction_from_odf(pp.picker_odf)
                if _fc:
                    slot_faction_votes[pp.picker_team][_fc] += 1
            # Accept-vs-reject gate. The engine emits PP events on volume
            # contact even when the powerup's effect is rejected (player
            # already maxed). Without per-instance disambiguation in the
            # proto, dedup events that share (picker, powerup_odf,
            # powerup_team) within PICKUP_DEDUP_GAP_TICKS of the previous
            # kept event -- treating the cluster as one logical pickup.
            # See pickup_last_kept_tick init above for full rationale.
            _dedup_key = (pp.picker, (pp.powerup_odf or "").lower(), pp.powerup_team)
            _prev_tick = pickup_last_kept_tick.get(_dedup_key)
            if _prev_tick is not None and pp.tick - _prev_tick <= PICKUP_DEDUP_GAP_TICKS:
                i += 1
                continue
            pickup_last_kept_tick[_dedup_key] = pp.tick
            pickup_events.append({
                "tick": pp.tick,
                "picker_s64": pp.picker,
                "picker_team": pp.picker_team,
                "picker_odf": pp.picker_odf,
                "powerup_team": pp.powerup_team,
                "powerup_odf": pp.powerup_odf,
            })
            if pp.picker > 0:
                pickup_count_by_player[pp.picker] += 1
            if pp.powerup_odf:
                pickup_count_by_odf[pp.powerup_odf.lower()] += 1
            i += 1

        elif event_type == "update_tick":
            ut = evt.update_tick
            tick = ut.tick
            if tick > max_tick:
                max_tick = tick
            if tick < min_tick:
                min_tick = tick
            # Downsample to POSITIONING_SAMPLE_RATE_HZ per player. Use per-player
            # "last kept tick" so gaps don't drift the cadence.
            for ps in ut.players:
                s64 = ps.player
                if s64 <= 0 or s64 not in s64_to_nick:
                    continue
                if ps.odf:
                    all_unit_odfs.add(ps.odf)
                    # v2.3: keep s64_to_current_odf updated every tick so
                    # any subsequent BulletInit / BulletHit / DamageDealt
                    # / UnitDestroyed event in the same or following
                    # ticks attributes correctly to the player's ACTIVE
                    # ship at event time (not their starting ship).
                    s64_to_current_odf[s64] = ps.odf
                    # v2.3: per-tick per-ship accumulator. Keyed by ODF
                    # (lowercased) directly -- no class taxonomy. The
                    # leaderboard build resolves each ODF to a pretty
                    # name via prettify_odf() at emit time.
                    player_ship_ticks[s64][ps.odf.lower()] += 1
                # Faction detection. Algorithm A (starting ship): cache
                # the first non-empty ODF seen for this slot; this is the
                # closest analogue we have to a match-start roster check.
                # Algorithm B (event-stream votes): every UpdateTick the
                # slot continues to broadcast a vehicle/pilot ODF whose
                # first letter encodes its faction -- accumulate votes.
                # Note: AI-only slots have no Steam64, so they're
                # filtered by the s64 guard above; their votes flow
                # instead from UnitDestroyed/BulletHit events which
                # carry the slot directly via *_team fields.
                _slot = s64_to_slot.get(s64)
                if _slot and ps.odf:
                    if _slot not in slot_first_odf:
                        slot_first_odf[_slot] = ps.odf
                    _fc = faction_from_odf(ps.odf)
                    if _fc:
                        slot_faction_votes[_slot][_fc] += 1
                has_target = bool(ps.has_target)
                if has_target:
                    match_has_target_lock_data = True
                last_kept = position_last_kept_tick.get(s64)
                if last_kept is not None and (tick - last_kept) < tick_stride:
                    continue
                position_last_kept_tick[s64] = tick
                position_samples[s64].append((
                    tick,  # store raw tick; convert to seconds after min_tick is known
                    float(ps.position.x),
                    float(ps.position.y),
                    float(ps.position.z),
                    has_target,
                ))
            i += 1

        else:
            i += 1

    # Timeline: recompute with known min/max tick
    bucket_size = TIMELINE_BUCKET_SECONDS * tick_rate

    if bucket_size > 0 and min_tick < float("inf"):
        for evt in events:
            et = evt.WhichOneof("event_type")
            if et != "damage_dealt":
                continue
            dd = evt.damage_dealt
            if _is_sentinel_damage(dd.amount):
                continue
            if dd.team == 0 or dd.amount == 0.0:
                continue
            shooter = dd.shooter
            bucket_idx = (dd.tick - min_tick) // bucket_size
            shooter_faction = slot_to_faction(dd.team)

            if shooter > 0:
                timeline_player[shooter][bucket_idx] += dd.amount
            else:
                pass  # asset only goes to faction timeline below

            if shooter_faction:
                timeline_faction[shooter_faction][bucket_idx] += dd.amount

    # Build weapon and unit name maps. Both are scoped to the ODFs the match
    # actually used so disambiguation suffixes only appear when there is a
    # genuine collision in this match.
    weapon_name_map = disambiguate_names(all_ordnance, resolve_weapon)
    unit_name_map = disambiguate_names(all_unit_odfs, resolve_unit)

    def wpn_name(odf):
        return weapon_name_map.get(odf, resolve_weapon(odf))

    def unit_name(odf):
        return unit_name_map.get(odf) or resolve_unit(odf)

    def powerup_display_name(odf):
        """Friendly name for a powerup pod ODF, disambiguated from the
        weapon of the same name. Used by pickups.by_odf,
        powerup_destructions.by_odf, and per-feed powerup_name so
        'Chain Gun' (the weapon) and 'Chain Gun Powerup' (the pod)
        are distinct in the UI.

        Resolution order: unit_name -> stripped-vsr unit_name ->
        wpn_name -> stripped-vsr wpn_name -> title-cased stem.
        Suffixes with ' Powerup' unless the resolved name already
        ends in 'Powerup'.

        Highest-volume case: apserv_vsr.odf -> stripped-vsr unit_name
        path returns "Service Pod" -> "Service Pod Powerup".
        """
        if not odf:
            return ""  # empty proto3 default; don't synthesize " Powerup"
        base = unit_name(odf)
        raw_stem = re.sub(r"\.odf$", "", odf, flags=re.IGNORECASE)
        if not base:
            stripped = _strip_vsr_suffix(odf)
            if stripped:
                base = unit_name(stripped)
        if not base:
            cand = wpn_name(odf)
            if cand and cand != raw_stem:
                base = cand
        if not base:
            stripped = _strip_vsr_suffix(odf)
            if stripped:
                cand = wpn_name(stripped)
                stripped_stem = re.sub(r"\.odf$", "", stripped, flags=re.IGNORECASE)
                if cand and cand != stripped_stem:
                    base = cand
        if not base:
            base = raw_stem.replace("_", " ").title()
        if base.lower().endswith("powerup"):
            return base
        return f"{base} Powerup"

    # Inject powerup_name into destruction-feed entries collected during
    # the event loop. The closure couldn't run inside the loop because it
    # depends on weapon_name_map / unit_name_map which are built only
    # after all ODFs have been collected. Rebuild each dict in canonical
    # field order (powerup_name immediately after powerup_odf, matching
    # the pickups.feed[] shape) for JSON-output consistency.
    for idx, entry in enumerate(powerup_destruction_feed):
        powerup_destruction_feed[idx] = {
            "tick": entry["tick"],
            "killer": entry["killer"],
            "killer_in_game_nick": entry["killer_in_game_nick"],
            "killer_odf": entry["killer_odf"],
            "powerup_odf": entry["powerup_odf"],
            "powerup_name": powerup_display_name(entry["powerup_odf"]),
            "powerup_team": entry["powerup_team"],
        }

    # Build match-global ODF map for the Raw Data Browser. Keys are raw ODF
    # strings as they appear in the binpb; values are the best human-readable
    # name. Resolution chain: weapons via `wpn_name` (ODF DB Weapon.* chain),
    # then vehicles/structures via `unit_name` (Vehicle.*.GameObjectClass.unitName),
    # then a title-cased form of the raw stem as a last-resort fallback for
    # ODFs the DB does not recognize. Match-global (always unfiltered).
    def prettify_odf(odf):
        resolved = wpn_name(odf)
        raw_stem = re.sub(r"\.odf$", "", odf, flags=re.IGNORECASE)
        if resolved != raw_stem:
            return resolved
        unit = unit_name(odf)
        if unit:
            return unit
        return raw_stem.replace("_", " ").title()

    odf_map = {
        odf: prettify_odf(odf)
        for odf in sorted(all_ordnance | all_unit_odfs)
        if odf
    }

    # Compute match duration
    duration_sec = (max_tick - min_tick) / tick_rate if max_tick > min_tick else 0

    # Build timestamp from protobuf Timestamp
    start_ts = header.start_time
    start_dt = datetime.fromtimestamp(
        start_ts.seconds + start_ts.nanos / 1e9, tz=timezone.utc
    )
    match_id = start_dt.strftime("%Y-%m-%dT%H-%M-%S")
    date_str = start_dt.isoformat()

    # Build team rosters
    roster_slots = {1: set(), 2: set()}
    for slot in all_slots:
        faction = slot_to_faction(slot)
        if faction in (1, 2):
            roster_slots[faction].add(slot)

    teams = {}
    for faction_num in [1, 2]:
        roster = []
        for slot in sorted(roster_slots[faction_num]):
            s64 = slot_to_s64.get(slot)
            display_name = nick_map.get(slot, f"Player {slot}")
            roster.append({
                "slot": slot,
                "player_id": display_name,
                "name": display_name,
                "steam64": str(s64) if s64 else None,
                # Mirrors leaderboard[].in_game_nick so faction roster UI
                # can render the same subtle subtext when the in-game alias
                # differs from the canonical/known name.
                "in_game_nick": in_game_nick_for(s64, display_name) if s64 else None,
            })
        teams[str(faction_num)] = roster

    # Compute team_factions early (re-emitted at the canonical location
    # below) so the structure-share reconciliation has a shooter-faction
    # code available even when pre-collector-schema sessions left
    # `bh.shooter_odf` empty. `_team_factions_pre` maps team (1/2) -> dict
    # {"code": "i"|"e"|"f", "name": "ISDF"|"Hadean"|"Scion"} or None.
    _team_factions_pre = detect_team_factions(slot_first_odf, slot_faction_votes)

    # Reconcile `player_structure_dealt_by_vfc` into the final
    # `player_structure_dealt[s64] -> float`. For each shooter, look up
    # their slot -> team -> team_faction code; sum the per-vfc damage where
    # vfc differs from the shooter's team faction (rejects friendly fire on
    # own structures). Two fallbacks credit all damage instead of dropping:
    #   (a) shooter's team faction is unknown (no signal at all in the
    #       match -- e.g. sandbox or corrupt session), and
    #   (b) the match is a mirror (both teams same faction code) -- the
    #       faction-code filter cannot distinguish own buildings from enemy
    #       buildings, so it would silently drop ALL structure damage. The
    #       alternative is a rare false positive (self-demo on own recy),
    #       and self-demos rarely land in BulletHit anyway (most are
    #       commander-issued without a projectile impact).
    t1 = (_team_factions_pre.get(1) or {}).get("code")
    t2 = (_team_factions_pre.get(2) or {}).get("code")
    mirror_match = bool(t1 and t2 and t1 == t2)
    player_structure_dealt = defaultdict(float)
    for s64, by_vfc in player_structure_dealt_by_vfc.items():
        slot = s64_to_slot.get(s64)
        team_num = slot_to_faction(slot) if slot else 0
        team_fc_entry = _team_factions_pre.get(team_num) if team_num in (1, 2) else None
        team_fc = team_fc_entry["code"] if team_fc_entry else None
        skip_filter = (team_fc is None) or mirror_match
        for vfc, amount in by_vfc.items():
            if skip_filter or vfc != team_fc:
                player_structure_dealt[s64] += amount

    # Build leaderboard
    leaderboard = []
    for slot in sorted(all_slots):
        name = nick_map.get(slot, f"Player {slot}")
        s64 = slot_to_s64.get(slot)
        faction = slot_to_faction(slot)
        dealt = player_dealt.get(s64, 0) if s64 else 0
        received = player_received.get(s64, 0) if s64 else 0
        net = dealt - received
        ratio = dealt / received if received > 0 else (float("inf") if dealt > 0 else 0)

        # PvP/PvE split derived from rivalry matrix (shooter > 0 AND victim > 0).
        # PvE = remainder = damage to AI units + world props.
        pvp_d = sum(rivalry[s64].values()) if s64 else 0.0
        pvp_r = sum(v.get(s64, 0) for v in rivalry.values()) if s64 else 0.0
        pve_d = max(0.0, dealt - pvp_d)
        pve_r = max(0.0, received - pvp_r)

        total_fired = sum(player_shots_fired[s64].values()) if s64 else 0
        total_hit = sum(player_shots_hit[s64].values()) if s64 else 0
        accuracy = total_hit / total_fired if total_fired > 0 else 0
        # PvP-only hit count + accuracy (subset of total_hit). Drives the
        # v2.3 thug_accuracy axis (weapon-normalized) at the
        # player+weapon level via weapon_breakdown[w].pvp_hits below.
        total_pvp_hit = sum(player_pvp_shots_hit[s64].values()) if s64 else 0
        pvp_accuracy = total_pvp_hit / total_fired if total_fired > 0 else 0

        # PvP/PvE kill+death split. PvP = events with both killer and
        # victim being Steam64 players (already captured in kill_rivalry).
        # PvE = remainder = kills/deaths against AI units + world.
        pvp_kills = sum(kill_rivalry[s64].values()) if s64 else 0
        pvp_deaths = sum(victims.get(s64, 0) for victims in kill_rivalry.values()) if s64 else 0
        kills = player_kills.get(s64, 0) if s64 else 0
        deaths = player_deaths.get(s64, 0) if s64 else 0
        pve_kills = max(0, kills - pvp_kills)
        pve_deaths = max(0, deaths - pvp_deaths)

        fav_weapon = "—"
        fav_max = 0
        if s64:
            for odf, dmg in player_weapon_dealt[s64].items():
                if dmg > fav_max:
                    fav_max = dmg
                    fav_weapon = wpn_name(odf)

        all_wpn_odfs = set()
        if s64:
            all_wpn_odfs = set(player_weapon_dealt[s64].keys()) | set(player_shots_fired[s64].keys())
        weapon_breakdown = {}
        # Sort by display name for deterministic output across pipeline reruns
        # (set iteration order over all_wpn_odfs is non-deterministic).
        for odf in sorted(all_wpn_odfs, key=lambda o: wpn_name(o).lower()):
            w_dealt = player_weapon_dealt[s64].get(odf, 0)
            w_recv = player_weapon_received[s64].get(odf, 0)
            w_shots = player_shots_fired[s64].get(odf, 0)
            w_hits = player_shots_hit[s64].get(odf, 0)
            w_pvp_hits = player_pvp_shots_hit[s64].get(odf, 0) if s64 else 0
            w_acc = w_hits / w_shots if w_shots > 0 else 0
            weapon_breakdown[wpn_name(odf)] = {
                "dealt": round(w_dealt, 1),
                "received": round(w_recv, 1),
                "shots": w_shots,
                "hits": w_hits,
                "pvp_hits": w_pvp_hits,
                "accuracy": round(w_acc, 3),
            }

        # ---- v2.3 Loadout Profile + per-ship combat block. ----
        # Derived from per_ship_combat (tick-joined to active ship at
        # each event) and player_ship_ticks (what fraction of ticks
        # this player was in each ship). UI is display-only; no axis
        # math reads these blocks. Pretty names are resolved at emit
        # time via prettify_odf() so consumers see actual ship names
        # ("Tank", "Scout", "Assault Tank", "Pilot") rather than any
        # invented class taxonomy.
        loadout_block = None
        per_ship_combat_rows = []
        if s64:
            ship_ticks = dict(player_ship_ticks.get(s64, {}))
            total_ship_ticks = sum(ship_ticks.values())
            if total_ship_ticks > 0:
                # Per-ship metadata (name + share + seconds).
                ships = {}
                for odfl, ticks in ship_ticks.items():
                    ships[odfl] = {
                        "name":    prettify_odf(odfl),
                        "share":   round(ticks / total_ship_ticks, 4),
                        "seconds": round(ticks / tick_rate, 1),
                    }
                # Primary / secondary by share. Sorted desc; ties
                # broken alphabetically (on ODF) for deterministic output.
                ordered = sorted(
                    ships.items(),
                    key=lambda kv: (-kv[1]["share"], kv[0]),
                )
                primary_odf, primary_meta = ordered[0]
                secondary = ordered[1] if len(ordered) > 1 else None
                loadout_block = {
                    "ships": ships,
                    "primary_ship": {
                        "odf":   primary_odf,
                        "name":  primary_meta["name"],
                        "share": primary_meta["share"],
                    },
                    "secondary_ship": (
                        {
                            "odf":   secondary[0],
                            "name":  secondary[1]["name"],
                            "share": secondary[1]["share"],
                        } if secondary else None
                    ),
                    "ship_diversity": len([1 for t in ship_ticks.values() if t > 0]),
                    "active_seconds": round(total_ship_ticks / tick_rate, 1),
                }

                # Per-ship combat rows (display-only; not consumed by
                # ELO axes). One row per ship with time_seconds > 0,
                # sorted by time desc, ties broken alphabetically (on ODF).
                per_ship_raw = per_ship_combat.get(s64, {})
                for odfl, ticks in ship_ticks.items():
                    if ticks <= 0:
                        continue
                    cd = per_ship_raw.get(odfl, {})
                    pc_kills = int(cd.get("kills", 0))
                    pc_deaths = int(cd.get("deaths", 0))
                    pc_pvp_kills = int(cd.get("pvp_kills", 0))
                    pc_pvp_deaths = int(cd.get("pvp_deaths", 0))
                    pc_dealt = float(cd.get("dealt", 0.0))
                    pc_shots = int(cd.get("shots", 0))
                    pc_hits = int(cd.get("hits", 0))
                    pc_pvp_hits = int(cd.get("pvp_hits", 0))
                    pc_time = ticks / tick_rate
                    pc_acc = pc_hits / pc_shots if pc_shots > 0 else 0.0
                    pc_pvp_acc = pc_pvp_hits / pc_shots if pc_shots > 0 else 0.0
                    pc_dpm = pc_dealt / (pc_time / 60.0) if pc_time > 0 else 0.0
                    pc_kd = pc_pvp_kills / pc_pvp_deaths if pc_pvp_deaths > 0 else (
                        None if pc_pvp_kills == 0 else None
                    )
                    per_ship_combat_rows.append({
                        "ship":         odfl,
                        "ship_name":    prettify_odf(odfl),
                        "time_seconds": round(pc_time, 1),
                        "kills":        pc_kills,
                        "deaths":       pc_deaths,
                        "pvp_kills":    pc_pvp_kills,
                        "pvp_deaths":   pc_pvp_deaths,
                        "pve_kills":    max(0, pc_kills - pc_pvp_kills),
                        "pve_deaths":   max(0, pc_deaths - pc_pvp_deaths),
                        "dealt":        round(pc_dealt, 1),
                        "shots":        pc_shots,
                        "hits":         pc_hits,
                        "pvp_hits":     pc_pvp_hits,
                        "accuracy":     round(pc_acc, 3),
                        "pvp_accuracy": round(pc_pvp_acc, 3),
                        "dpm":          round(pc_dpm, 1),
                        "kd":           round(pc_kd, 2) if pc_kd is not None else None,
                    })
                per_ship_combat_rows.sort(
                    key=lambda r: (-r["time_seconds"], r["ship"])
                )

        leaderboard.append({
            "player_id": name,
            "name": name,
            # In-game nick from header.s64_to_nick, surfaced as a subtle
            # subtext in the UI (leaderboard, kill feed, faction roster) when
            # it differs from the canonical/known-name `name` field
            # (case-insensitive, trimmed). None when the canonical name and
            # the in-game nick match -- the UI suppresses the subtext.
            "in_game_nick": in_game_nick_for(s64, name) if s64 else None,
            "slot": slot,
            "steam64": str(s64) if s64 else None,
            "faction": faction,
            "kills": kills,
            "deaths": deaths,
            "kd_ratio": round(kills / deaths, 2) if deaths > 0 else (None if kills == 0 else None),
            "personal": {
                "dealt": round(dealt, 1),
                "received": round(received, 1),
                "pvp_dealt": round(pvp_d, 1),
                "pve_dealt": round(pve_d, 1),
                "pvp_received": round(pvp_r, 1),
                "pve_received": round(pve_r, 1),
                "structure_dealt": round(player_structure_dealt.get(s64, 0), 1) if s64 else 0.0,
                "net": round(net, 1),
                "ratio": round(ratio, 2) if ratio != float("inf") else None,
                "shots_fired": total_fired,
                "shots_hit": total_hit,
                # v2.3: PvP-only hit count + accuracy. Subset of
                # shots_hit / accuracy. Used by the dashboard's
                # weapon-breakdown table (PvP Acc column) and the
                # thug_accuracy ELO axis at the per-weapon level.
                "pvp_shots_hit": total_pvp_hit,
                "pvp_accuracy": round(pvp_accuracy, 3),
                "accuracy": round(accuracy, 3),
                # v2.3: PvP/PvE kill + death split. Drives the dashboard's
                # compact `TOTAL (PvP/PvE)` chips on Kills/Deaths cells
                # and the thug_kill_rate ELO axis (alpha-blended).
                "pvp_kills":  pvp_kills,
                "pve_kills":  pve_kills,
                "pvp_deaths": pvp_deaths,
                "pve_deaths": pve_deaths,
                "fav_weapon": fav_weapon,
                "weapons_used": len(player_weapons_used.get(s64, set())) if s64 else 0,
            },
            "assets": {
                "dealt": round(asset_dealt.get(slot, 0), 1),
                "received": round(asset_received.get(slot, 0), 1),
            },
            "weapon_breakdown": weapon_breakdown,
            # v2.3: Loadout Profile + per-ship combat (display-only,
            # organized per individual ship ODF, no class taxonomy).
            # `loadout` is None when the player has zero ticks
            # (degenerate / spectator slot); `per_ship_combat` is an
            # empty list in the same case. UI hides the cards in both
            # cases. Pretty names ("Tank", "Scout", etc.) are pre-
            # resolved at emit time via prettify_odf().
            "loadout": loadout_block,
            "per_ship_combat": per_ship_combat_rows,
            "hit_targets": {
                nick_for_s64(victim_s64): {
                    "hits": count,
                    "damage": round(rivalry[s64].get(victim_s64, 0), 1),
                }
                for victim_s64, count in sorted(
                    player_hits_by_victim[s64].items(),
                    key=lambda x: x[1], reverse=True
                )
            } if s64 else {},
        })

    # Deterministic tie-break: player name (guards against identical personal.dealt).
    leaderboard.sort(key=lambda p: (-p["personal"]["dealt"], (p.get("name") or "").lower()))

    # Faction totals
    faction_totals = {}
    for f_num in [1, 2]:
        f_slots = roster_slots[f_num]
        f_s64s = {slot_to_s64[s] for s in f_slots if s in slot_to_s64}

        f_player_dealt = sum(player_dealt.get(s64, 0) for s64 in f_s64s)
        f_asset_dealt = sum(asset_dealt.get(s, 0) for s in f_slots)
        f_player_recv = sum(player_received.get(s64, 0) for s64 in f_s64s)
        f_asset_recv = sum(asset_received.get(s, 0) for s in f_slots)
        f_pvp_dealt = sum(rivalry[s64].get(v, 0) for s64 in f_s64s for v in rivalry[s64])
        f_pvp_recv = sum(v.get(s64, 0) for s64 in f_s64s for v in rivalry.values())
        f_pve_dealt = max(0.0, f_player_dealt - f_pvp_dealt)
        f_pve_recv = max(0.0, f_player_recv - f_pvp_recv)
        f_shots = faction_shots.get(f_num, 0)
        f_hits = faction_hits.get(f_num, 0)
        f_acc = f_hits / f_shots if f_shots > 0 else 0

        faction_totals[str(f_num)] = {
            "player_dealt": round(f_player_dealt, 1),
            "pvp_dealt": round(f_pvp_dealt, 1),
            "pve_dealt": round(f_pve_dealt, 1),
            "asset_dealt": round(f_asset_dealt, 1),
            "total_dealt": round(faction_dealt.get(f_num, 0), 1),
            "player_received": round(f_player_recv, 1),
            "pvp_received": round(f_pvp_recv, 1),
            "pve_received": round(f_pve_recv, 1),
            "asset_received": round(f_asset_recv, 1),
            "total_received": round(faction_received.get(f_num, 0), 1),
            "shots": f_shots,
            "hits": f_hits,
            "accuracy": round(f_acc, 3),
        }

    # Rivalry matrix (use display names)
    rivalry_matrix = {}
    for shooter_s64, victims in rivalry.items():
        shooter_name = nick_for_s64(shooter_s64)
        for victim_s64, dmg in victims.items():
            victim_name = nick_for_s64(victim_s64)
            if shooter_name not in rivalry_matrix:
                rivalry_matrix[shooter_name] = {}
            rivalry_matrix[shooter_name][victim_name] = round(dmg, 1)

    # Top rivalries (bidirectional)
    pair_map = {}
    for shooter_name, victims in rivalry_matrix.items():
        for victim_name, dmg in victims.items():
            if shooter_name == victim_name:
                continue
            key = tuple(sorted([shooter_name, victim_name]))
            if key not in pair_map:
                pair_map[key] = {"a": key[0], "b": key[1], "a_to_b": 0, "b_to_a": 0}
            if shooter_name == key[0]:
                pair_map[key]["a_to_b"] += dmg
            else:
                pair_map[key]["b_to_a"] += dmg

    top_rivalries = sorted(
        [
            {**p, "total": round(p["a_to_b"] + p["b_to_a"], 1),
             "a_to_b": round(p["a_to_b"], 1), "b_to_a": round(p["b_to_a"], 1)}
            for p in pair_map.values()
        ],
        # Deterministic tie-break: participant names.
        key=lambda p: (-p["total"], str(p["a"]).lower(), str(p["b"]).lower()),
    )[:5]

    # Weapon meta. Iterate in sorted ODF order so per-match weapon_meta keeps
    # a stable insertion order before the final sort (protects against a
    # slight tie-break drift under identical total_damage values).
    weapon_meta = []
    for odf in sorted(all_ordnance):
        dmg = weapon_total_damage.get(odf, 0)
        shots = weapon_total_shots.get(odf, 0)
        hits = weapon_total_hits.get(odf, 0)
        acc = hits / shots if shots > 0 else 0
        users = len(weapon_users.get(odf, set()))
        if dmg > 0 or shots > 0:
            weapon_meta.append({
                "weapon": wpn_name(odf),
                "odf": odf,
                "total_damage": round(dmg, 1),
                "total_shots": shots,
                "total_hits": hits,
                "accuracy": round(acc, 3),
                "users": users,
            })
    # Secondary sort by weapon name to break ties deterministically
    # (support weapons often carry total_damage = 0).
    weapon_meta.sort(key=lambda w: (-w["total_damage"], w["weapon"].lower()))

    # Timeline
    total_buckets = ((max_tick - min_tick) // bucket_size + 1) if bucket_size > 0 and max_tick > min_tick else 0
    labels = []
    for b in range(total_buckets):
        sec = b * TIMELINE_BUCKET_SECONDS
        m = sec // 60
        s = sec % 60
        labels.append(f"{m}:{s:02d}")

    tl_by_player = {}
    for s64, buckets in timeline_player.items():
        name = nick_for_s64(s64)
        tl_by_player[name] = [round(buckets.get(b, 0), 1) for b in range(total_buckets)]

    tl_by_faction = {}
    for f_num, buckets in timeline_faction.items():
        tl_by_faction[str(f_num)] = [round(buckets.get(b, 0), 1) for b in range(total_buckets)]

    # Asset damage breakdown
    asset_damage = {
        "by_player": {},
        "by_faction": {},
    }
    for slot in sorted(all_slots):
        name = nick_map.get(slot, f"Player {slot}")
        ad = asset_dealt.get(slot, 0)
        ar = asset_received.get(slot, 0)
        if ad > 0 or ar > 0:
            asset_damage["by_player"][name] = {
                "dealt": round(ad, 1),
                "received": round(ar, 1),
            }

    for f_num in [1, 2]:
        slots = roster_slots[f_num]
        ad = sum(asset_dealt.get(s, 0) for s in slots)
        ar = sum(asset_received.get(s, 0) for s in slots)
        asset_damage["by_faction"][str(f_num)] = {
            "dealt": round(ad, 1),
            "received": round(ar, 1),
        }

    # Normalize positioning sample ticks -> seconds from match start.
    # Raw buffer stores absolute ticks; here we subtract min_tick and divide by tick_rate.
    if min_tick != float("inf") and position_samples:
        normalized_samples = {}
        for s64, samples in position_samples.items():
            normalized = []
            for t_raw, x, y, z, has_target in samples:
                t_sec = int((t_raw - min_tick) / tick_rate)
                normalized.append((t_sec, x, y, z, has_target))
            normalized_samples[s64] = normalized
    else:
        normalized_samples = {}

    positioning_block = _compute_positioning(
        normalized_samples,
        min_tick if min_tick != float("inf") else 0,
        tick_rate,
        slot_to_s64,
        roster_slots,
        nick_for_s64,
        match_has_target_lock_data=match_has_target_lock_data,
        terrain_bounds=terrain_bounds,
    )

    # Kills section
    kills_leaderboard = []
    for slot in sorted(all_slots):
        s64 = slot_to_s64.get(slot)
        if not s64:
            continue
        k = player_kills.get(s64, 0)
        d = player_deaths.get(s64, 0)
        if k > 0 or d > 0:
            kills_leaderboard.append({
                "player_id": nick_map.get(slot, f"Player {slot}"),
                "name": nick_map.get(slot, f"Player {slot}"),
                "kills": k,
                "deaths": d,
                "kd_ratio": round(k / d, 2) if d > 0 else None,
            })
    # Deterministic tie-break: player name.
    kills_leaderboard.sort(key=lambda p: (-p["kills"], (p.get("name") or "").lower()))

    # End-of-match sentinel summary (only when anything was dropped).
    if sentinel_damage["count"] > 0:
        print(
            f"  sentinel damage filtered: count={sentinel_damage['count']} "
            f"total={sentinel_damage['total_amount']:,.2f} "
            f"ticks={sentinel_damage['first_tick']}..{sentinel_damage['last_tick']}"
        )

    # Derive each team's faction from the per-slot ODF signals collected
    # during the event loop. Combined "starting ship" + "event-stream votes"
    # model -- see detect_team_factions() docstring. Match-global, always
    # unfiltered; emitted as None for teams with no signal (sandbox / pure
    # AI). Output dict keys are JSON-serialized as strings.
    # NOTE: this is recomputed from `_team_factions_pre` which was already
    # computed above (before the leaderboard build) so the structure-share
    # reconciliation could use it. Reusing avoids duplicate work.
    _team_factions = _team_factions_pre
    team_factions = {
        "1": _team_factions.get(1),
        "2": _team_factions.get(2),
    }

    # Infer the match outcome from the (already-cleaned) kill_feed via the
    # toggle model on recycler/factory destructions. Always emitted; the
    # renderer reads this directly from currentData.match.winner and never
    # from the (filterable) kills.feed -- a player filter could otherwise
    # hide loser destruction events and corrupt the in-feed milestone.
    match_winner = compute_match_winner(kill_feed)

    match_data = {
        "match": {
            "id": match_id,
            "source_file": source_file,
            # Byte size of the source .binpb.gz at the time we processed it.
            # Used (with `submitter` + `source_file`) as the incremental
            # cache key in load_cache_index(). The collector writes each
            # session file once and never modifies it, so size is a stable
            # fingerprint -- we deliberately don't use mtime because
            # shutil.copy2 in sync_upstream() can change mtime without
            # changing content. See PIPELINE_VERSION docstring up top.
            "source_size_bytes": source_size_bytes,
            # Internal cache invalidator -- bumped manually when
            # process_match() output semantics change. Cached JSONs whose
            # value differs from the current PIPELINE_VERSION constant are
            # reprocessed from raw on the next run. Orthogonal to
            # `schema_version` below (which is a frontend contract).
            "pipeline_version": PIPELINE_VERSION,
            "submitter": submitter,
            "map": header.map,
            "date": date_str,
            "duration_sec": round(duration_sec, 1),
            "tick_range": [min_tick if min_tick != float("inf") else 0, max_tick],
            "tick_rate": tick_rate,
            "player_count": header.player_count or len(nick_map),
            "config_mod": header.active_config_mod,
            "snipe_count": snipe_count,
            "teams": teams,
            "team_leaders": team_leaders,
            # Per-team faction labels derived from per-slot ODF signals.
            # Sibling to team_leaders. Always full-match (never narrowed).
            # Each value is either {"code": "i" | "e" | "f", "name": ...}
            # or null for inconclusive teams. See detect_team_factions().
            "team_factions": team_factions,
            # Inferred match outcome from the kill_feed toggle model on
            # recycler/factory destructions. decided_by is one of
            # "clean_win" / "contested" / "unclear"; team and loser are
            # null for unclear. Always emitted. Match-global, always
            # full-match (the renderer reads this block, never the
            # filtered kills.feed). See compute_match_winner().
            "winner": match_winner,
            "has_position_data": positioning_block["has_position_data"],
            "has_target_lock_data": positioning_block.get("has_target_lock_data", False),
            # True when the match contains at least one pickup_powerup
            # event. False for pre-Phase-3 sessions captured before the
            # proto added PickupPowerup. Mirrored on manifest entries so
            # the dashboard can badge legacy matches without loading the
            # full per-match JSON.
            "has_pickup_data": match_has_pickup_data,
            # Per-match schema version. v1 = pre-highlights; v2 added the
            # top-level `highlights` block; v3 added `match.team_factions`
            # and `match.winner`; v4 (this version) adds the v2.3 leaderboard
            # fields: `personal.pvp_kills` / `pve_kills` / `pvp_deaths` /
            # `pve_deaths` / `pvp_shots_hit` / `pvp_accuracy`,
            # `weapon_breakdown[w].pvp_hits`, plus per-player `loadout`
            # block (class shares, primary/secondary, most-used ODFs) and
            # `per_class_combat` list (per-ship-class combat stats joined
            # to active ship at event time). Absence means legacy data
            # (anything written before the v2.3 phase).
            "schema_version": 4,
            "terrain_bounds": terrain_bounds,
            "base_to_base_distance": positioning_block.get("base_to_base_distance"),
            "sentinel_damage": {
                "count": sentinel_damage["count"],
                "total_amount": round(sentinel_damage["total_amount"], 2),
                "first_tick": sentinel_damage["first_tick"],
                "last_tick": sentinel_damage["last_tick"],
            },
        },
        "leaderboard": leaderboard,
        "faction_totals": faction_totals,
        "rivalry_matrix": rivalry_matrix,
        "top_rivalries": top_rivalries,
        "weapon_meta": weapon_meta,
        "odf_map": odf_map,
        "timeline": {
            "bucket_seconds": TIMELINE_BUCKET_SECONDS,
            "labels": labels,
            "by_player": tl_by_player,
            "by_faction": tl_by_faction,
        },
        "asset_damage": asset_damage,
        "kills": {
            "leaderboard": kills_leaderboard,
            "feed": kill_feed,
            "by_vehicle": [
                {
                    "odf": odf,
                    "name": prettify_odf(odf),
                    "count": count,
                }
                for odf, count in vehicle_destruction_count.most_common()
                if odf.lower() not in VEHICLE_DESTRUCTION_IGNORE_ODFS
            ][:15],
            "kill_rivalry_matrix": {
                nick_for_s64(killer): {
                    nick_for_s64(victim): count
                    for victim, count in victims.items()
                }
                for killer, victims in kill_rivalry.items()
            },
        },
        "pickups": _build_pickups_block(
            match_has_pickup_data, pickup_events, pickup_count_by_player,
            pickup_count_by_odf, nick_for_s64, in_game_nick_for, powerup_display_name,
            s64_to_slot, slot_to_faction,
        ),
        "powerup_destructions": _build_powerup_destructions_block(
            powerup_destruction_feed, powerup_destruction_by_player,
            powerup_destruction_by_odf, nick_for_s64, powerup_display_name,
            s64_to_slot, slot_to_faction,
        ),
        "deployable_destructions": _build_deployable_destructions_block(
            deployable_destruction_by_player, deployable_destruction_by_odf,
            nick_for_s64, prettify_odf,
        ),
        "snipes": _build_snipes_block(
            snipe_feed, snipe_count_by_player, nick_for_s64,
            s64_to_slot, slot_to_faction,
        ),
        "positioning": positioning_block,
    }

    # Match Highlights — fixed-slate award catalog (12 cards, always-on).
    # Each card emits when its data gates pass, otherwise it's omitted.
    # Match-global + always-unfiltered (read directly from currentData by the UI).
    match_data["highlights"] = compute_highlights(match_data)

    return match_data


def _extract_contribution(match_data):
    """Return the slim per-match shape consumed by the client-side
    aggregator (`js/all-matches-aggregator.js`).

    This is *exactly* the slice of `match_data` the All Matches aggregate
    needs in order to rebuild career_stats / global_weapon_meta /
    global_rivalries / meta — no more. The output of this function for a
    list of matches is what gets written to
    `data/processed/match_contributions.json`. The browser fetches that
    one file and folds in only the entries whose ids pass the active
    picker filter, so cross-match aggregates honor every facet (player
    count, duration band, players, role, etc.) without re-fetching
    per-match JSONs.

    Field names mirror the corresponding match_data paths but flatten to
    the keys the aggregator wants (e.g. `personal.dealt` -> `dealt`) so
    the JS aggregator stays simple.
    """
    m = match_data["match"]
    positioning = match_data.get("positioning") or {}
    pos_players = positioning.get("players") or {}

    pickups_by_name = {
        row["name"]: row["count"]
        for row in (match_data.get("pickups", {}).get("by_player") or [])
    }

    leaderboard = []
    for p in match_data.get("leaderboard") or []:
        personal = p.get("personal", {}) or {}
        assets = p.get("assets", {}) or {}
        # Positioning fields are best-effort: absent on pre-positioning
        # matches, present-but-no-target_lock on pre-target-lock-schema.
        pm = (pos_players.get(p["name"]) or {}).get("metrics") or {}
        slot = p.get("slot")
        # v2.3: Loadout block trimmed to exactly what the aggregator
        # needs to rebuild career_loadout (sum of ship_seconds across
        # matches; primary/secondary rederived from the totals to
        # avoid double-rounding). Ship names ("Tank", "Scout", etc.)
        # are pre-resolved in the per-match loadout block so the JS
        # aggregator doesn't need its own resolver.
        loadout = p.get("loadout") or None
        if loadout:
            loadout_slim = {
                "ships":          {
                    odf: {"name": s.get("name") or "", "share": s.get("share") or 0.0,
                          "seconds": s.get("seconds") or 0.0}
                    for odf, s in (loadout.get("ships") or {}).items()
                },
                "primary_ship":   loadout.get("primary_ship"),
                "secondary_ship": loadout.get("secondary_ship"),
                "ship_diversity": loadout.get("ship_diversity", 0),
                "active_seconds": loadout.get("active_seconds", 0.0),
            }
        else:
            loadout_slim = None
        # v2.3: per_ship_combat slim rows. The aggregator sums each
        # field per (player, ship) across matches; display fields
        # (accuracy, dpm, kd) are recomputed client-side. ship_name
        # is pre-resolved here so the aggregator doesn't re-resolve.
        per_ship_combat_slim = [
            {
                "ship":         row.get("ship") or "unknown",
                "ship_name":    row.get("ship_name") or "Unknown",
                "time_seconds": row.get("time_seconds", 0.0),
                "kills":        row.get("kills", 0),
                "deaths":       row.get("deaths", 0),
                "pvp_kills":    row.get("pvp_kills", 0),
                "pvp_deaths":   row.get("pvp_deaths", 0),
                "dealt":        row.get("dealt", 0.0),
                "shots":        row.get("shots", 0),
                "hits":         row.get("hits", 0),
                "pvp_hits":     row.get("pvp_hits", 0),
            }
            for row in (p.get("per_ship_combat") or [])
        ]
        leaderboard.append({
            "player_id": p.get("player_id", ""),
            "name": p.get("name", ""),
            "steam64":        p.get("steam64"),
            # Slot 1 = Team 1 commander, slot 6 = Team 2 commander.
            # Carried onto contributions so the JS aggregator can split
            # commander vs thug stats without re-deriving from the leaderboard.
            "slot":           slot,
            "team":           p.get("faction"),
            "is_commander":   slot in (1, 6),
            "dealt":          round(personal.get("dealt", 0), 1),
            "received":       round(personal.get("received", 0), 1),
            "pvp_dealt":      round(personal.get("pvp_dealt", 0), 1),
            "pve_dealt":      round(personal.get("pve_dealt", 0), 1),
            "pvp_received":   round(personal.get("pvp_received", 0), 1),
            "pve_received":   round(personal.get("pve_received", 0), 1),
            "asset_dealt":    round(assets.get("dealt", 0), 1),
            "structure_dealt": round(personal.get("structure_dealt", 0), 1),
            "shots_fired":    personal.get("shots_fired", 0),
            "shots_hit":      personal.get("shots_hit", 0),
            # v2.3: PvP-only hit count (subset of shots_hit). Drives the
            # career thug_accuracy axis at the per-weapon level (via
            # weapon_breakdown[w].pvp_hits) and the per-match thug
            # composite calculation.
            "pvp_shots_hit":  personal.get("pvp_shots_hit", 0),
            "kills":          p.get("kills", 0),
            "deaths":         p.get("deaths", 0),
            # v2.3: PvP/PvE kill+death split. Drives the dashboard's
            # compact `TOTAL (PvP/PvE)` chips on Career Leaderboard
            # rows and the career thug_kill_rate axis.
            "pvp_kills":      personal.get("pvp_kills", 0),
            "pve_kills":      personal.get("pve_kills", 0),
            "pvp_deaths":     personal.get("pvp_deaths", 0),
            "pve_deaths":     personal.get("pve_deaths", 0),
            "pickups":        pickups_by_name.get(p["name"], 0),
            "weapon_breakdown": {
                wname: {
                    "dealt": round(wdata.get("dealt", 0), 1),
                    "shots": wdata.get("shots", 0),
                    "hits":  wdata.get("hits", 0),
                    # v2.3: per-weapon PvP-hit count for the career
                    # weapon-breakdown table's PvP Hits / PvP Acc cols.
                    "pvp_hits": wdata.get("pvp_hits", 0),
                }
                for wname, wdata in (p.get("weapon_breakdown") or {}).items()
            },
            # v2.3: Loadout + per-ship combat for the All Matches
            # career rollup. Aggregator sums ship_seconds and the
            # per-ship combat fields; rederives display fields.
            "loadout":         loadout_slim,
            "per_ship_combat": per_ship_combat_slim,
            "activity_score":   pm.get("activity_score") if pm else None,
            "movement_band":    pm.get("movement_band") if pm else None,
            "path_length":      pm.get("path_length", 0.0) if pm else 0.0,
            "target_lock_pct":  pm.get("target_lock_pct") if pm and "target_lock_pct" in pm else None,
        })

    weapon_meta = [
        {
            "weapon":       wm["weapon"],
            "total_damage": round(wm.get("total_damage", 0), 1),
            "total_shots":  wm.get("total_shots", 0),
            "total_hits":   wm.get("total_hits", 0),
        }
        for wm in (match_data.get("weapon_meta") or [])
    ]

    # Round rivalry damages to keep the JSON tight; aggregation tolerates
    # the half-cent floor since match-level rivalries are already rounded.
    rivalry_matrix = {
        shooter: {victim: round(dmg, 1) for victim, dmg in victims.items()}
        for shooter, victims in (match_data.get("rivalry_matrix") or {}).items()
    }

    # Per-player snipes. The match `snipes.by_player` block is already a
    # list of {name, count, ...} aggregates — flatten to a name -> count
    # dict so the JS aggregator can roll them up into career totals
    # without a per-match round trip.
    snipes_by_player = {}
    for row in (match_data.get("snipes") or {}).get("by_player") or []:
        name = row.get("name")
        if not name:
            continue
        c = int(row.get("count", 0) or 0)
        if c > 0:
            snipes_by_player[name] = c

    # Same shape for powerup destructions (used by Pod Goblin career card).
    powerup_destructions_by_player = {}
    for row in (match_data.get("powerup_destructions") or {}).get("by_player") or []:
        name = row.get("name")
        if not name:
            continue
        c = int(row.get("count", 0) or 0)
        if c > 0:
            powerup_destructions_by_player[name] = c

    # Match-level commander/faction/winner tuple. All three are
    # match-global, always-unfiltered passthrough fields per the project
    # rule (read directly by aggregator and renderers; never narrowed by
    # the per-match player filter).
    winner = m.get("winner") or {}
    return {
        "id":           m["id"],
        "map":          m["map"],
        "date":         m["date"],
        "duration_sec": m["duration_sec"],
        "submitter":    m["submitter"],
        "player_count": m.get("player_count", 0),
        "has_position_data":    m.get("has_position_data", False),
        "has_target_lock_data": m.get("has_target_lock_data", False),
        "has_pickup_data":      m.get("has_pickup_data", False),
        "sentinel_damage_count": (m.get("sentinel_damage") or {}).get("count", 0),
        "team_leaders":  m.get("team_leaders") or {},
        "team_factions": m.get("team_factions") or {},
        "winner": {
            "team":       winner.get("team"),
            "decided_by": winner.get("decided_by", "unclear"),
        },
        "leaderboard":     leaderboard,
        "weapon_meta":     weapon_meta,
        "rivalry_matrix":  rivalry_matrix,
        "snipes_by_player":               snipes_by_player,
        "powerup_destructions_by_player": powerup_destructions_by_player,
    }


def build_all_matches_aggregate(all_match_data):
    """DEPRECATED: kept as the canonical Python reference for cross-match
    aggregation, no longer wired into the pipeline.

    The pipeline now writes `data/processed/match_contributions.json`
    (one slim entry per match, see `_extract_contribution`) and the
    browser folds those entries into the same shape this function
    produced — see `js/all-matches-aggregator.js`. Keeping this code lets
    you quickly diff Python vs JS aggregator output during development:
    `python -c "import process_stats, json; ..."` against a
    `VTAggregate.build(contribs, allFileIds)` snapshot. Once the JS
    aggregator is proven, this function can be deleted.
    """
    career = defaultdict(lambda: {
        "player_id": "",
        "name": "",
        "matches_played": 0,
        "total_dealt": 0,
        "total_received": 0,
        "total_pvp_dealt": 0,
        "total_pve_dealt": 0,
        "total_pvp_received": 0,
        "total_pve_received": 0,
        "total_asset_dealt": 0,
        "total_shots_fired": 0,
        "total_shots_hit": 0,
        "total_kills": 0,
        "total_deaths": 0,
        # Pickups career stat. Sums match.pickups.by_player[name].count
        # across every match the player appeared in. Old-schema matches
        # contribute zero (their pickups block is empty).
        "total_pickups": 0,
        "weapon_totals": defaultdict(lambda: {"dealt": 0, "shots": 0, "hits": 0}),
        "best_match": None,
        # Positioning accumulators. Only populated for matches where the player
        # had UpdateTick data; skipped matches don't add to these lists.
        "movement_scores": [],  # per-match activity_score values
        "movement_bands": [],   # per-match band names
        "movement_path_total": 0.0,
        # Target-lock (T-key) accumulator. Only populated when the match had
        # positioning data AND the match-global has_target_lock_data flag is True.
        # target_lock_pct is absolute (0-1), so direct averaging is valid.
        "target_lock_pcts": [],
        # Per-match distinct-weapon counts. Averaged at the end into
        # `mean_weapons_used` for the Career Radar's per-match mode (axis
        # 6 — Weapon Diversity). Lifetime distinct count is still the
        # length of `weapon_breakdown`, so totals mode is unaffected.
        "weapons_used_per_match": [],
    })

    global_weapon = defaultdict(lambda: {
        "total_damage": 0, "total_shots": 0, "total_hits": 0
    })

    global_rivalry = defaultdict(lambda: defaultdict(float))

    maps_played = set()
    dates = []
    total_duration = 0
    submitters = set()

    matches_with_positioning_count = 0
    matches_with_target_lock_data_count = 0

    for match_data in all_match_data:
        m = match_data["match"]
        maps_played.add(m["map"])
        dates.append(m["date"][:10])
        total_duration += m["duration_sec"]
        submitters.add(m["submitter"])
        if m.get("has_position_data"):
            matches_with_positioning_count += 1
        if m.get("has_target_lock_data"):
            matches_with_target_lock_data_count += 1

        # Per-match positioning data (may be absent on older sessions)
        match_positioning = match_data.get("positioning") or {}
        pos_players = match_positioning.get("players") or {}
        match_has_target_lock = bool(match_positioning.get("has_target_lock_data"))

        # Per-match pickups by player name (always present, may be empty
        # for old-schema matches with has_pickup_data=false).
        pickups_by_player_name = {
            row["name"]: row["count"]
            for row in (match_data.get("pickups", {}).get("by_player") or [])
        }

        for p in match_data["leaderboard"]:
            pid = p["player_id"]
            c = career[pid]
            c["player_id"] = pid
            c["name"] = p["name"]
            c["matches_played"] += 1
            c["total_dealt"] += p["personal"]["dealt"]
            c["total_received"] += p["personal"]["received"]
            c["total_pvp_dealt"] += p["personal"].get("pvp_dealt", 0)
            c["total_pve_dealt"] += p["personal"].get("pve_dealt", 0)
            c["total_pvp_received"] += p["personal"].get("pvp_received", 0)
            c["total_pve_received"] += p["personal"].get("pve_received", 0)
            c["total_asset_dealt"] += p["assets"]["dealt"]
            c["total_shots_fired"] += p["personal"]["shots_fired"]
            c["total_shots_hit"] += p["personal"]["shots_hit"]
            c["total_kills"] += p.get("kills", 0)
            c["total_deaths"] += p.get("deaths", 0)
            c["total_pickups"] += pickups_by_player_name.get(p["name"], 0)

            # Career positioning aggregation: include only if this match had
            # UpdateTick data AND this player has a positioning entry.
            if match_positioning.get("has_position_data") and p["name"] in pos_players:
                pm = pos_players[p["name"]]["metrics"]
                c["movement_scores"].append(pm["activity_score"])
                c["movement_bands"].append(pm["movement_band"])
                c["movement_path_total"] += pm["path_length"]
                # Target-lock career aggregation. Only record a sample for
                # matches where the match-global flag is True; that prevents
                # pre-schema zero-fill from diluting real averages.
                if match_has_target_lock and "target_lock_pct" in pm:
                    c["target_lock_pcts"].append(pm["target_lock_pct"])

            for wpn_name, wpn_data in p["weapon_breakdown"].items():
                c["weapon_totals"][wpn_name]["dealt"] += wpn_data["dealt"]
                c["weapon_totals"][wpn_name]["shots"] += wpn_data["shots"]
                c["weapon_totals"][wpn_name]["hits"] += wpn_data["hits"]
            c["weapons_used_per_match"].append(len(p["weapon_breakdown"]))

            if c["best_match"] is None or p["personal"]["dealt"] > c["best_match"]["dealt"]:
                c["best_match"] = {
                    "id": m["id"],
                    "map": m["map"],
                    "dealt": p["personal"]["dealt"],
                }

        for wm in match_data["weapon_meta"]:
            gw = global_weapon[wm["weapon"]]
            gw["total_damage"] += wm["total_damage"]
            gw["total_shots"] += wm["total_shots"]
            gw["total_hits"] += wm["total_hits"]

        for shooter, victims in match_data["rivalry_matrix"].items():
            for victim, dmg in victims.items():
                global_rivalry[shooter][victim] += dmg

    # Build career stats list
    career_stats = []
    for pid, c in career.items():
        acc = c["total_shots_hit"] / c["total_shots_fired"] if c["total_shots_fired"] > 0 else 0
        fav_weapon = "—"
        fav_max = 0
        for wname, wdata in c["weapon_totals"].items():
            if wdata["dealt"] > fav_max:
                fav_max = wdata["dealt"]
                fav_weapon = wname

        weapon_breakdown = {}
        # Sort by display name for deterministic output across pipeline reruns.
        for wname in sorted(c["weapon_totals"].keys(), key=lambda n: n.lower()):
            wdata = c["weapon_totals"][wname]
            w_acc = wdata["hits"] / wdata["shots"] if wdata["shots"] > 0 else 0
            weapon_breakdown[wname] = {
                "dealt": round(wdata["dealt"], 1),
                "shots": wdata["shots"],
                "hits": wdata["hits"],
                "accuracy": round(w_acc, 3),
            }

        # Career movement aggregation
        movement_scores = c["movement_scores"]
        movement_bands = c["movement_bands"]
        if movement_scores:
            mean_score = sum(movement_scores) / len(movement_scores)
            if len(movement_scores) > 1:
                variance = sum((s - mean_score) ** 2 for s in movement_scores) / len(movement_scores)
                stddev_score = variance ** 0.5
            else:
                stddev_score = 0.0
            band_counts = Counter(movement_bands)
            dominant_band = band_counts.most_common(1)[0][0]
            band_dist = dict(band_counts)
            matches_with_pos = len(movement_scores)
            movement_fields = {
                "mean_movement_score": round(mean_score, 1),
                "movement_score_stddev": round(stddev_score, 2),
                "movement_band_dominant": dominant_band,
                "movement_band_distribution": band_dist,
                "total_path_length": round(c["movement_path_total"], 1),
                "matches_with_positioning": matches_with_pos,
            }
        else:
            movement_fields = {
                "mean_movement_score": None,
                "movement_score_stddev": None,
                "movement_band_dominant": None,
                "movement_band_distribution": {},
                "total_path_length": 0.0,
                "matches_with_positioning": 0,
            }

        # Career target-lock (T-key) aggregation. Direct average of absolute
        # ratios — valid because target_lock_pct is not match-relative.
        target_lock_pcts = c["target_lock_pcts"]
        if target_lock_pcts:
            target_lock_fields = {
                "mean_target_lock_pct": round(
                    sum(target_lock_pcts) / len(target_lock_pcts), 3
                ),
                "matches_with_target_lock_data": len(target_lock_pcts),
            }
        else:
            target_lock_fields = {
                "mean_target_lock_pct": None,
                "matches_with_target_lock_data": 0,
            }

        # Mean distinct weapons used per match. Direct average of an
        # absolute per-match count — valid because each match's
        # len(weapon_breakdown) is independent of total match count.
        # Powers axis 6 (Weapon Diversity) on the Career Radar's
        # per-match mode; totals mode keeps the lifetime distinct count.
        weapons_used_per_match = c["weapons_used_per_match"]
        mean_weapons_used = (
            sum(weapons_used_per_match) / len(weapons_used_per_match)
            if weapons_used_per_match else 0
        )

        career_stats.append({
            "player_id": pid,
            "name": c["name"],
            "matches_played": c["matches_played"],
            "total_dealt": round(c["total_dealt"], 1),
            "total_received": round(c["total_received"], 1),
            "total_pvp_dealt": round(c["total_pvp_dealt"], 1),
            "total_pve_dealt": round(c["total_pve_dealt"], 1),
            "total_pvp_received": round(c["total_pvp_received"], 1),
            "total_pve_received": round(c["total_pve_received"], 1),
            "total_asset_dealt": round(c["total_asset_dealt"], 1),
            "overall_accuracy": round(acc, 3),
            "total_kills": c["total_kills"],
            "total_deaths": c["total_deaths"],
            "total_pickups": c["total_pickups"],
            "fav_weapon": fav_weapon,
            "best_match": c["best_match"],
            "weapon_breakdown": weapon_breakdown,
            "mean_weapons_used": round(mean_weapons_used, 1),
            **movement_fields,
            **target_lock_fields,
        })
    # Secondary sort by name to break ties deterministically across runs.
    career_stats.sort(key=lambda c: (-c["total_dealt"], c["name"].lower()))

    # Global weapon meta
    gwm = []
    for wname, wd in global_weapon.items():
        acc = wd["total_hits"] / wd["total_shots"] if wd["total_shots"] > 0 else 0
        gwm.append({
            "weapon": wname,
            "total_damage": round(wd["total_damage"], 1),
            "total_shots": wd["total_shots"],
            "total_hits": wd["total_hits"],
            "accuracy": round(acc, 3),
        })
    # Secondary sort by weapon name to break ties deterministically
    # (many support weapons carry total_damage = 0; set-iter order was
    # previously producing inconsistent arrangements across runs).
    gwm.sort(key=lambda w: (-w["total_damage"], w["weapon"].lower()))

    # Global rivalries
    pair_map = {}
    for shooter, victims in global_rivalry.items():
        for victim, dmg in victims.items():
            if shooter == victim:
                continue
            key = tuple(sorted([shooter, victim]))
            if key not in pair_map:
                pair_map[key] = {"a": key[0], "b": key[1], "a_to_b": 0, "b_to_a": 0}
            if shooter == key[0]:
                pair_map[key]["a_to_b"] += dmg
            else:
                pair_map[key]["b_to_a"] += dmg

    global_rivalries = sorted(
        [
            {**p, "total": round(p["a_to_b"] + p["b_to_a"], 1),
             "a_to_b": round(p["a_to_b"], 1), "b_to_a": round(p["b_to_a"], 1)}
            for p in pair_map.values()
        ],
        # Secondary sort by participant names for deterministic tie-breaking.
        key=lambda p: (-p["total"], str(p["a"]).lower(), str(p["b"]).lower()),
    )[:10]

    sorted_dates = sorted(dates)

    # Sentinel damage aggregate rollup (pair count across all matches).
    # See SENTINEL_DAMAGE_THRESHOLD / _is_sentinel_damage + docs/DATA_DICTIONARY.md §7.
    total_sentinel_damage_dropped = sum(
        (md.get("match") or {}).get("sentinel_damage", {}).get("count", 0)
        for md in all_match_data
    )
    matches_with_sentinel_damage = [
        (md.get("match") or {}).get("id")
        for md in all_match_data
        if (md.get("match") or {}).get("sentinel_damage", {}).get("count", 0) > 0
    ]

    return {
        "meta": {
            "match_count": len(all_match_data),
            "total_duration_sec": round(total_duration, 1),
            "maps_played": sorted(maps_played),
            "date_range": [sorted_dates[0], sorted_dates[-1]] if sorted_dates else [],
            "submitters": sorted(submitters),
            "matches_with_positioning": matches_with_positioning_count,
            "matches_with_target_lock_data": matches_with_target_lock_data_count,
            "total_sentinel_damage_dropped": total_sentinel_damage_dropped,
            "matches_with_sentinel_damage": matches_with_sentinel_damage,
        },
        "career_stats": career_stats,
        "global_weapon_meta": gwm,
        "global_rivalries": global_rivalries,
    }


def _parse_args():
    """CLI surface. Sync is default-on; opt out via --no-sync. See module docs."""
    parser = argparse.ArgumentParser(
        description=(
            "VT Stats pipeline. Default behavior: sync upstream statsgate "
            "+ process only changed matches. Re-run after VTrider uploads "
            "with no flags."
        ),
    )
    sync_group = parser.add_mutually_exclusive_group()
    sync_group.add_argument(
        "--no-sync",
        action="store_true",
        help="Skip git pull + mirror; process only what's already in data/sessions/",
    )
    sync_group.add_argument(
        "--sync-only",
        action="store_true",
        help="Sync upstream then exit; don't process any matches",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore the per-match cache and reprocess every match (composes with sync flags)",
    )
    return parser.parse_args()


def main():
    args = _parse_args()
    t0 = time.perf_counter()

    print("VT Stats Processing Pipeline")
    print("=" * 40)

    # --sync-only --force is allowed by argparse but --force is a no-op
    # since processing is skipped. Surface this so the user notices.
    if args.sync_only and args.force:
        print("Note: --force has no effect with --sync-only (processing is skipped).")

    # Sync upstream (default-on; --no-sync opts out). sync_upstream()
    # soft-skips if statsgate/ is missing so the manual-drop-only
    # workflow doesn't require --no-sync. It hard-fails on git errors so
    # real problems are visible.
    if not args.no_sync:
        sync_upstream()
        if args.sync_only:
            print(f"\nDone in {time.perf_counter() - t0:.1f}s (sync-only).")
            return

    # Load ODF database
    odf_db = {}
    if ODF_PATH.exists():
        print(f"Loading ODF database from {ODF_PATH.name}...")
        with open(ODF_PATH, "r", encoding="utf-8") as f:
            odf_db = json.load(f)
        print(f"  Loaded {len(odf_db.get('Weapon', {}))} weapons, {len(odf_db.get('Vehicle', {}))} vehicles")
    else:
        print("WARNING: odf.min.json not found, weapon names will be raw ODF strings")

    resolve_weapon = build_weapon_name_resolver(odf_db)
    resolve_unit = build_unit_name_resolver(odf_db)
    known_powerup_odfs = _load_known_powerup_odfs(odf_db)
    print(f"  Powerup classification set: {len(known_powerup_odfs)} ODFs (DB Powerup bucket + VSR variants)")
    building_odfs = _load_building_odfs(odf_db)
    print(f"  Building classification set: {len(building_odfs)} ODFs (DB Building bucket + VSR variants)")

    # Load canonical player names
    known_players = load_known_players()

    # Discover sessions
    sources = discover_sessions()
    if not sources:
        print(f"No .binpb.gz files found in {SESSIONS_DIR}")
        sys.exit(1)

    print(f"Found {len(sources)} session file(s)")

    # Build the incremental cache index. Skipped wholesale under --force
    # so every match gets reprocessed from raw. The cache hits when both
    # source_size_bytes (immutable per session file) and pipeline_version
    # (PIPELINE_VERSION constant) match the cached JSON.
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    cache = {} if args.force else load_cache_index()
    print(f"Cache index: {len(cache)} prior match(es) eligible for reuse"
          + (" (--force: cache disabled)" if args.force else ""))

    all_match_data = []
    submitter_by_id: dict[str, str] = {}
    n_cache_hit = 0
    n_processed = 0

    for session_path, submitter in sources:
        cache_key = (submitter, session_path.name)
        current_size = session_path.stat().st_size
        cached = cache.get(cache_key)
        if cached and cached["match"].get("source_size_bytes") == current_size:
            print(f"  [cache] {submitter}/{session_path.name}")
            match_data = cached
            n_cache_hit += 1
        else:
            print(f"\nProcessing {submitter}/{session_path.name}...")
            session = load_session(session_path)
            print(f"  Parsed: {len(session.event_stream)} events, map={session.header.map}")
            match_data = process_match(
                session, session_path.name, current_size, submitter,
                resolve_weapon, resolve_unit, known_powerup_odfs, building_odfs,
                known_players,
            )
            match_id = match_data["match"]["id"]
            out_path = OUTPUT_DIR / f"{match_id}.json"
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(match_data, f, indent=2, ensure_ascii=False)
            print(f"  Output: {out_path.name} ({out_path.stat().st_size:,} bytes)")
            n_processed += 1

        all_match_data.append(match_data)
        submitter_by_id[match_data["match"]["id"]] = submitter

    print(f"\nMatches: {n_cache_hit} cached, {n_processed} reprocessed")

    # Build/refresh the map registry BEFORE the manifest so we can resolve
    # each match's display name from the iondriver `title` field (with
    # `XYZ: ` prefixes stripped). Non-blocking: per-map network failures
    # log but do not abort the pipeline; idempotent on maps already cached.
    # Output at `data/maps/*` and `data/map-registry.json`. We feed the
    # in-memory `(map_file_key, config_mod)` list directly so the builder
    # doesn't need to re-read matches.json (it doesn't exist yet on a
    # fresh run, anyway). See build_map_registry.py.
    registry: dict = {}
    try:
        import build_map_registry
        seen_map: dict[str, str | None] = {}
        for m in all_match_data:
            raw_map = m["match"].get("map") or ""
            key = build_map_registry.map_key(raw_map)
            if not key or key in seen_map:
                continue
            seen_map[key] = m["match"].get("config_mod")
        registry = build_map_registry.build_registry(sorted(seen_map.items()))
    except Exception as e:
        print(f"WARN: failed to build map registry ({e}); skipping.")

    # Build manifest using registry-resolved names (with filename fallback
    # for any map the registry couldn't satisfy).
    manifest = []
    for match_data in all_match_data:
        match_id = match_data["match"]["id"]
        lb = match_data.get("leaderboard") or []
        manifest_players = sorted(
            {(p.get("name") or "").strip() for p in lb if (p.get("name") or "").strip()},
            key=lambda n: n.lower(),
        )
        manifest.append({
            "id": match_id,
            "name": resolve_match_name(match_data["match"]["map"], registry),
            "file": f"{match_id}.json",
            "map": match_data["match"]["map"],
            "date": match_data["match"]["date"],
            "duration_sec": match_data["match"]["duration_sec"],
            "player_count": match_data["match"]["player_count"],
            "submitter": submitter_by_id.get(match_id, ""),
            "team_leaders": match_data["match"].get("team_leaders", {}),
            # Per-team faction codes ({"1": {"code": "i", ...}, "2": {...}})
            # and the inferred match outcome's "decided_by" tier
            # ("clean_win" | "contested" | "unclear"). Both are exposed on
            # the manifest so future picker facets (faction filter, won/
            # contested/unclear filter) can read straight off matches.json
            # without hydrating per-match JSON.
            "team_factions": match_data["match"].get("team_factions", {}),
            "winner_decided_by": (match_data["match"].get("winner") or {}).get("decided_by", "unclear"),
            "players": manifest_players,
            "has_position_data": match_data["match"].get("has_position_data", False),
            "has_target_lock_data": match_data["match"].get("has_target_lock_data", False),
            "has_pickup_data": match_data["match"].get("has_pickup_data", False),
        })

    manifest.sort(key=lambda m: m["date"])

    manifest_path = OUTPUT_DIR / "matches.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\nManifest: {manifest_path.name} ({len(manifest)} matches)")

    # Emit per-match contributions for client-side aggregation. The
    # browser uses this single file (plus the active picker filter) to
    # build the All Matches view; aggregation moved client-side so the
    # filtered subset can be re-aggregated without per-match round trips.
    # See js/all-matches-aggregator.js for the consumer. The legacy
    # all_matches.json output was removed in this same pass — its job is
    # now done by aggregator.build(contributions, allFileIds) on demand.
    contributions = {}
    for match_data in all_match_data:
        contrib = _extract_contribution(match_data)
        # Key by the manifest's `file` value so the JS side can index
        # straight off `manifest[i].file`.
        key = f"{contrib['id']}.json"
        contributions[key] = contrib

    contrib_path = OUTPUT_DIR / "match_contributions.json"
    with open(contrib_path, "w", encoding="utf-8") as f:
        json.dump(contributions, f, indent=2, ensure_ascii=False)
    print(f"Contributions: {contrib_path.name} ({contrib_path.stat().st_size:,} bytes, {len(contributions)} matches)")

    # ----- VTSR-T (combat ELO + alpha-stub Wins ELO blend) -----
    # Pipeline-side, full-corpus, time-ordered. Feeds the All Matches
    # VTSR-T Leaderboard. Per the project rule, this is corpus-wide and
    # NEVER picker-filter aware — the dashboard reads elo_current.json
    # once per session and passes ratings through the JS aggregator
    # unchanged. See scripts/elo.py for the algorithm.
    try:
        import elo as elo_module
        elo_current, elo_history = elo_module.compute_elo(all_match_data)
        elo_current_path = OUTPUT_DIR / "elo_current.json"
        with open(elo_current_path, "w", encoding="utf-8") as f:
            json.dump(elo_current, f, indent=2, ensure_ascii=False)
        elo_history_path = OUTPUT_DIR / "elo_history.json"
        with open(elo_history_path, "w", encoding="utf-8") as f:
            json.dump(elo_history, f, indent=2, ensure_ascii=False)
        rated = elo_current.get("match_count", 0)
        excl_lpc = elo_current.get("matches_excluded_low_player_count", 0)
        excl_dur = elo_current.get("matches_excluded_short_duration", 0)
        n_ratings = len(elo_current.get("ratings", []))
        print(f"VTSR-T: {elo_current_path.name} ({n_ratings} players · "
              f"{rated} rated matches · {excl_lpc} excluded low-player-count · "
              f"{excl_dur} excluded short-duration)")
    except Exception as e:
        print(f"WARN: failed to compute VTSR-T ({e}); skipping.")

    # Drop a stale seen-players.json from previous pipeline runs (the
    # PIPELINE_VERSION 5 -> 6 bump shipped a `seen-players.json` emit
    # that fed the now-removed [VTstats] chip in the active-game modal).
    # Reverting the emit but keeping the version bump avoids a third
    # forced reprocess.
    legacy_seen = OUTPUT_DIR / "seen-players.json"
    if legacy_seen.exists():
        try:
            legacy_seen.unlink()
            print(f"  Removed legacy {legacy_seen.name} (no longer emitted)")
        except OSError as e:
            print(f"  WARN: failed to remove legacy {legacy_seen.name}: {e}")

    # Drop a stale all_matches.json from previous pipeline runs so it
    # can't shadow the new contributions-based aggregate during dev.
    legacy_agg = OUTPUT_DIR / "all_matches.json"
    if legacy_agg.exists():
        try:
            legacy_agg.unlink()
            print(f"  Removed legacy {legacy_agg.name} (replaced by contributions-driven aggregate)")
        except OSError as e:
            print(f"  WARN: failed to remove legacy {legacy_agg.name}: {e}")

    # Extract proto doc comments for the Raw Data Browser's schema tooltips.
    # Lives next to the ODF resolver output (data/) and is consumed by
    # js/raw-browser.js on page load.
    try:
        import extract_proto_docs
        docs = extract_proto_docs.extract()
        proto_docs_path = PROJECT_ROOT / "data" / "proto-docs.json"
        extract_proto_docs.write(docs, proto_docs_path)
        print(f"Proto docs: {proto_docs_path.name} ({len(docs)} entries)")
    except Exception as e:
        print(f"WARN: failed to extract proto docs ({e}); skipping.")

    print(f"\nDone in {time.perf_counter() - t0:.1f}s "
          f"({n_cache_hit} cached, {n_processed} reprocessed)")


if __name__ == "__main__":
    main()
