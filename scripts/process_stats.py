#!/usr/bin/env python3
"""
VT Stats Processing Pipeline

Reads .binpb.gz protobuf session files from data/sessions/<username>/,
aggregates match statistics, and outputs pre-computed JSON files to
data/processed/ for browser consumption.
"""

import gzip
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import statsgate_pb2

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
SESSIONS_DIR = PROJECT_ROOT / "data" / "sessions"
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"
ODF_PATH = PROJECT_ROOT / "data" / "odf.min.json"
PLAYER_IDS_PATH = PROJECT_ROOT / "data" / "playerids.txt"

TIMELINE_BUCKET_SECONDS = 10

MAP_NAME_PREFIXES = ["vsrmort", "vsrstt", "vsr"]


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


def disambiguate_weapon_names(ordnance_set, resolve_fn):
    """When multiple ODF strings resolve to the same display name, append the raw ODF."""
    raw = {odf: resolve_fn(odf) for odf in ordnance_set}
    counts = defaultdict(int)
    for name in raw.values():
        counts[name] += 1
    result = {}
    for odf, name in raw.items():
        key = re.sub(r"\.odf$", "", odf, flags=re.IGNORECASE)
        result[odf] = f"{name} ({key})" if counts[name] > 1 else name
    return result


def prettify_map_name(raw_map):
    """Turn a raw map filename like 'vsrragnor.bzn' into a display name like 'Ragnor'."""
    name = re.sub(r"\.bzn$", "", raw_map, flags=re.IGNORECASE)
    lower = name.lower()
    for tag in MAP_NAME_PREFIXES:
        if lower.startswith(tag):
            name = name[len(tag):]
            break
        elif lower.endswith(tag):
            name = name[:-len(tag)]
            break
    return name.title() if name else raw_map


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


def load_session(path):
    """Load and parse a .binpb.gz session file."""
    with gzip.open(path, "rb") as f:
        data = f.read()
    session = statsgate_pb2.ClientStatSession()
    session.ParseFromString(data)
    return session


def slot_to_faction(slot):
    """Determine which faction (1 or 2) a slot belongs to using BZ convention."""
    if 1 <= slot <= 5:
        return 1
    if 6 <= slot <= 10:
        return 2
    return 0


def load_known_players(path=PLAYER_IDS_PATH):
    """Load canonical player names from the known-players registry.

    Parses playerids.txt, extracts Steam-prefixed entries ('S'),
    and returns a dict mapping Steam64 int -> canonical display name.
    GOG entries are ignored (not present in session data).
    """
    known = {}
    if not path.exists():
        print(f"WARNING: {path.name} not found, no canonical player names available")
        return known

    with open(path, encoding="utf-16") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = re.match(r'"S(\d+)"="(.+)"', line)
            if m:
                known[int(m.group(1))] = m.group(2)

    print(f"Loaded {len(known)} known player names from {path.name}")
    return known


def process_match(session, source_file, submitter, resolve_weapon, known_players=None):
    """Process a single match session into pre-computed stats."""
    header = session.header
    events = session.event_stream

    tick_rate = header.tick_rate or 20

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

    def nick_for_s64(s64):
        return known_players.get(s64) or s64_to_nick.get(s64, f"Player {s64_to_slot.get(s64, '?')}")

    # Per-player accumulators (keyed on Steam64)
    player_dealt = defaultdict(float)
    player_received = defaultdict(float)
    player_weapon_dealt = defaultdict(lambda: defaultdict(float))
    player_weapon_received = defaultdict(lambda: defaultdict(float))
    player_shots_fired = defaultdict(lambda: defaultdict(int))
    player_shots_hit = defaultdict(lambda: defaultdict(int))
    player_weapons_used = defaultdict(set)

    # Asset (AI/structure) accumulators per owning slot
    asset_dealt = defaultdict(float)
    asset_received = defaultdict(float)

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

    # Collect all ordnance ODFs for disambiguation
    all_ordnance = set()

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
            if bi.tick > max_tick:
                max_tick = bi.tick
            if bi.tick < min_tick:
                min_tick = bi.tick
            i += 1

        elif event_type == "bullet_hit":
            bh = evt.bullet_hit
            shooter = bh.shooter
            odf = bh.ordnance_odf or ""
            if shooter > 0 and odf:
                all_ordnance.add(odf)
                player_shots_hit[shooter][odf] += 1
                slot = s64_to_slot.get(shooter)
                if slot:
                    faction = slot_to_faction(slot)
                    if faction:
                        faction_hits[faction] += 1
                weapon_total_hits[odf] += 1
            if shooter > 0 and bh.victim > 0:
                player_hits_by_victim[shooter][bh.victim] += 1
            if bh.tick > max_tick:
                max_tick = bh.tick
            if bh.tick < min_tick:
                min_tick = bh.tick
            i += 1

        elif event_type == "damage_dealt":
            dd = evt.damage_dealt
            dr = None

            if i + 1 < n and events[i + 1].WhichOneof("event_type") == "damage_received":
                dr = events[i + 1].damage_received
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

            if ud.killer > 0:
                player_kills[ud.killer] += 1
            if ud.victim > 0:
                player_deaths[ud.victim] += 1
            if ud.killer > 0 and ud.victim > 0:
                kill_rivalry[ud.killer][ud.victim] += 1
            if ud.victim_odf:
                vehicle_destruction_count[ud.victim_odf] += 1

            kill_feed.append({
                "tick": ud.tick,
                "killer": nick_for_s64(ud.killer) if ud.killer > 0 else f"Team {ud.killer_team}",
                "killer_odf": ud.killer_odf,
                "victim": nick_for_s64(ud.victim) if ud.victim > 0 else f"Team {ud.victim_team}",
                "victim_odf": ud.victim_odf,
            })
            i += 1

        elif event_type == "unit_sniped":
            snipe_count += 1
            us = evt.unit_sniped
            if us.tick > max_tick:
                max_tick = us.tick
            if us.tick < min_tick:
                min_tick = us.tick
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

    # Build weapon name map
    weapon_name_map = disambiguate_weapon_names(all_ordnance, resolve_weapon)

    def wpn_name(odf):
        return weapon_name_map.get(odf, resolve_weapon(odf))

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
            roster.append({
                "slot": slot,
                "player_id": nick_map.get(slot, f"Player {slot}"),
                "name": nick_map.get(slot, f"Player {slot}"),
                "steam64": str(s64) if s64 else None,
            })
        teams[str(faction_num)] = roster

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

        total_fired = sum(player_shots_fired[s64].values()) if s64 else 0
        total_hit = sum(player_shots_hit[s64].values()) if s64 else 0
        accuracy = total_hit / total_fired if total_fired > 0 else 0

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
        for odf in all_wpn_odfs:
            w_dealt = player_weapon_dealt[s64].get(odf, 0)
            w_recv = player_weapon_received[s64].get(odf, 0)
            w_shots = player_shots_fired[s64].get(odf, 0)
            w_hits = player_shots_hit[s64].get(odf, 0)
            w_acc = w_hits / w_shots if w_shots > 0 else 0
            weapon_breakdown[wpn_name(odf)] = {
                "dealt": round(w_dealt, 1),
                "received": round(w_recv, 1),
                "shots": w_shots,
                "hits": w_hits,
                "accuracy": round(w_acc, 3),
            }

        kills = player_kills.get(s64, 0) if s64 else 0
        deaths = player_deaths.get(s64, 0) if s64 else 0

        leaderboard.append({
            "player_id": name,
            "name": name,
            "slot": slot,
            "steam64": str(s64) if s64 else None,
            "faction": faction,
            "kills": kills,
            "deaths": deaths,
            "kd_ratio": round(kills / deaths, 2) if deaths > 0 else (None if kills == 0 else None),
            "personal": {
                "dealt": round(dealt, 1),
                "received": round(received, 1),
                "net": round(net, 1),
                "ratio": round(ratio, 2) if ratio != float("inf") else None,
                "shots_fired": total_fired,
                "shots_hit": total_hit,
                "accuracy": round(accuracy, 3),
                "fav_weapon": fav_weapon,
                "weapons_used": len(player_weapons_used.get(s64, set())) if s64 else 0,
            },
            "assets": {
                "dealt": round(asset_dealt.get(slot, 0), 1),
                "received": round(asset_received.get(slot, 0), 1),
            },
            "weapon_breakdown": weapon_breakdown,
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

    leaderboard.sort(key=lambda p: p["personal"]["dealt"], reverse=True)

    # Faction totals
    faction_totals = {}
    for f_num in [1, 2]:
        f_slots = roster_slots[f_num]
        f_s64s = {slot_to_s64[s] for s in f_slots if s in slot_to_s64}

        f_player_dealt = sum(player_dealt.get(s64, 0) for s64 in f_s64s)
        f_asset_dealt = sum(asset_dealt.get(s, 0) for s in f_slots)
        f_player_recv = sum(player_received.get(s64, 0) for s64 in f_s64s)
        f_asset_recv = sum(asset_received.get(s, 0) for s in f_slots)
        f_shots = faction_shots.get(f_num, 0)
        f_hits = faction_hits.get(f_num, 0)
        f_acc = f_hits / f_shots if f_shots > 0 else 0

        faction_totals[str(f_num)] = {
            "player_dealt": round(f_player_dealt, 1),
            "asset_dealt": round(f_asset_dealt, 1),
            "total_dealt": round(faction_dealt.get(f_num, 0), 1),
            "player_received": round(f_player_recv, 1),
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
        key=lambda p: p["total"],
        reverse=True,
    )[:5]

    # Weapon meta
    weapon_meta = []
    for odf in all_ordnance:
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
    weapon_meta.sort(key=lambda w: w["total_damage"], reverse=True)

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
    kills_leaderboard.sort(key=lambda p: p["kills"], reverse=True)

    return {
        "match": {
            "id": match_id,
            "source_file": source_file,
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
        },
        "leaderboard": leaderboard,
        "faction_totals": faction_totals,
        "rivalry_matrix": rivalry_matrix,
        "top_rivalries": top_rivalries,
        "weapon_meta": weapon_meta,
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
                    "name": re.sub(r"\.odf$", "", odf, flags=re.IGNORECASE).replace("_", " ").title(),
                    "count": count,
                }
                for odf, count in vehicle_destruction_count.most_common(15)
            ],
            "kill_rivalry_matrix": {
                nick_for_s64(killer): {
                    nick_for_s64(victim): count
                    for victim, count in victims.items()
                }
                for killer, victims in kill_rivalry.items()
            },
        },
    }


def build_all_matches_aggregate(all_match_data):
    """Build cross-match aggregate stats."""
    career = defaultdict(lambda: {
        "player_id": "",
        "name": "",
        "matches_played": 0,
        "total_dealt": 0,
        "total_received": 0,
        "total_asset_dealt": 0,
        "total_shots_fired": 0,
        "total_shots_hit": 0,
        "total_kills": 0,
        "total_deaths": 0,
        "weapon_totals": defaultdict(lambda: {"dealt": 0, "shots": 0, "hits": 0}),
        "best_match": None,
    })

    global_weapon = defaultdict(lambda: {
        "total_damage": 0, "total_shots": 0, "total_hits": 0
    })

    global_rivalry = defaultdict(lambda: defaultdict(float))

    maps_played = set()
    dates = []
    total_duration = 0
    submitters = set()

    for match_data in all_match_data:
        m = match_data["match"]
        maps_played.add(m["map"])
        dates.append(m["date"][:10])
        total_duration += m["duration_sec"]
        submitters.add(m["submitter"])

        for p in match_data["leaderboard"]:
            pid = p["player_id"]
            c = career[pid]
            c["player_id"] = pid
            c["name"] = p["name"]
            c["matches_played"] += 1
            c["total_dealt"] += p["personal"]["dealt"]
            c["total_received"] += p["personal"]["received"]
            c["total_asset_dealt"] += p["assets"]["dealt"]
            c["total_shots_fired"] += p["personal"]["shots_fired"]
            c["total_shots_hit"] += p["personal"]["shots_hit"]
            c["total_kills"] += p.get("kills", 0)
            c["total_deaths"] += p.get("deaths", 0)

            for wpn_name, wpn_data in p["weapon_breakdown"].items():
                c["weapon_totals"][wpn_name]["dealt"] += wpn_data["dealt"]
                c["weapon_totals"][wpn_name]["shots"] += wpn_data["shots"]
                c["weapon_totals"][wpn_name]["hits"] += wpn_data["hits"]

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
        for wname, wdata in c["weapon_totals"].items():
            w_acc = wdata["hits"] / wdata["shots"] if wdata["shots"] > 0 else 0
            weapon_breakdown[wname] = {
                "dealt": round(wdata["dealt"], 1),
                "shots": wdata["shots"],
                "hits": wdata["hits"],
                "accuracy": round(w_acc, 3),
            }

        career_stats.append({
            "player_id": pid,
            "name": c["name"],
            "matches_played": c["matches_played"],
            "total_dealt": round(c["total_dealt"], 1),
            "total_received": round(c["total_received"], 1),
            "total_asset_dealt": round(c["total_asset_dealt"], 1),
            "overall_accuracy": round(acc, 3),
            "total_kills": c["total_kills"],
            "total_deaths": c["total_deaths"],
            "fav_weapon": fav_weapon,
            "best_match": c["best_match"],
            "weapon_breakdown": weapon_breakdown,
        })
    career_stats.sort(key=lambda c: c["total_dealt"], reverse=True)

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
    gwm.sort(key=lambda w: w["total_damage"], reverse=True)

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
        key=lambda p: p["total"],
        reverse=True,
    )[:10]

    sorted_dates = sorted(dates)

    return {
        "meta": {
            "match_count": len(all_match_data),
            "total_duration_sec": round(total_duration, 1),
            "maps_played": sorted(maps_played),
            "date_range": [sorted_dates[0], sorted_dates[-1]] if sorted_dates else [],
            "submitters": sorted(submitters),
        },
        "career_stats": career_stats,
        "global_weapon_meta": gwm,
        "global_rivalries": global_rivalries,
    }


def main():
    print("VT Stats Processing Pipeline")
    print("=" * 40)

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

    # Load canonical player names
    known_players = load_known_players()

    # Discover sessions
    sources = discover_sessions()
    if not sources:
        print(f"No .binpb.gz files found in {SESSIONS_DIR}")
        sys.exit(1)

    print(f"Found {len(sources)} session file(s)")

    # Process each match
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_match_data = []
    manifest = []

    for session_path, submitter in sources:
        print(f"\nProcessing {submitter}/{session_path.name}...")

        session = load_session(session_path)
        print(f"  Parsed: {len(session.event_stream)} events, map={session.header.map}")

        match_data = process_match(session, session_path.name, submitter, resolve_weapon, known_players)
        all_match_data.append(match_data)

        match_id = match_data["match"]["id"]
        out_path = OUTPUT_DIR / f"{match_id}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(match_data, f, indent=2, ensure_ascii=False)
        print(f"  Output: {out_path.name} ({out_path.stat().st_size:,} bytes)")

        manifest.append({
            "id": match_id,
            "name": prettify_map_name(match_data["match"]["map"]),
            "file": f"{match_id}.json",
            "map": match_data["match"]["map"],
            "date": match_data["match"]["date"],
            "duration_sec": match_data["match"]["duration_sec"],
            "player_count": match_data["match"]["player_count"],
            "submitter": submitter,
        })

    # Sort manifest by date
    manifest.sort(key=lambda m: m["date"])

    # Write manifest
    manifest_path = OUTPUT_DIR / "matches.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\nManifest: {manifest_path.name} ({len(manifest)} matches)")

    # Build and write all-matches aggregate
    if len(all_match_data) > 1:
        aggregate = build_all_matches_aggregate(all_match_data)
        agg_path = OUTPUT_DIR / "all_matches.json"
        with open(agg_path, "w", encoding="utf-8") as f:
            json.dump(aggregate, f, indent=2, ensure_ascii=False)
        print(f"Aggregate: {agg_path.name} ({agg_path.stat().st_size:,} bytes)")

    print("\nDone!")


if __name__ == "__main__":
    main()
