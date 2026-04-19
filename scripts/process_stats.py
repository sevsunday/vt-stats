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
STEAMID_TO_NAME_PATH = PROJECT_ROOT / "data" / "steamid_to_name.txt"

TIMELINE_BUCKET_SECONDS = 10

MAP_NAME_PREFIXES = ["vsrmort", "vsrstt", "vsr"]

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


def _compute_positioning(raw_samples_by_s64, min_tick, tick_rate,
                         slot_to_s64, roster_slots, nick_for_s64,
                         match_has_target_lock_data=False):
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
        "map_diagonal": 0.0,
        "base_separation": 0.0,
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
    else:
        computed_sep = 0.0

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

    # --- Map bounds + diagonal (from observed extents) ---
    all_xs = []
    all_zs = []
    for tr in trails.values():
        all_xs.extend(tr["x"])
        all_zs.extend(tr["z"])
    map_min_x, map_max_x = min(all_xs), max(all_xs)
    map_min_z, map_max_z = min(all_zs), max(all_zs)
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
        # player was holding T. Absolute 0-1 ratio, cross-match comparable.
        # Sums to zero for pre-schema matches (has_target field defaults to
        # False), matching has_target_lock_data=False for the same match.
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
        "map_diagonal": round(map_diagonal, 2),
        "base_separation": round(base_separation, 2),
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

    # Positioning: per-player raw sample buffer (downsampled to ~1 Hz in the loop below).
    # Keyed by Steam64 -> list of (t_sec, x, y, z, has_target) tuples in tick order.
    position_samples = defaultdict(list)
    position_last_kept_tick = {}  # s64 -> last tick we kept a sample for (for 1 Hz downsample)
    tick_stride = max(1, tick_rate // POSITIONING_SAMPLE_RATE_HZ)
    # Target-lock availability for this match. Any observed has_target=True sample
    # flips this to True. Stays False for pre-schema matches (field defaults to
    # False) and new-schema matches where no player ever held T. The flag is
    # propagated to positioning.has_target_lock_data, match.has_target_lock_data,
    # and on to career_stats[].matches_with_target_lock_data.
    match_has_target_lock_data = False

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

        # PvP/PvE split derived from rivalry matrix (shooter > 0 AND victim > 0).
        # PvE = remainder = damage to AI units + world props.
        pvp_d = sum(rivalry[s64].values()) if s64 else 0.0
        pvp_r = sum(v.get(s64, 0) for v in rivalry.values()) if s64 else 0.0
        pve_d = max(0.0, dealt - pvp_d)
        pve_r = max(0.0, received - pvp_r)

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
                "pvp_dealt": round(pvp_d, 1),
                "pve_dealt": round(pve_d, 1),
                "pvp_received": round(pvp_r, 1),
                "pve_received": round(pve_r, 1),
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
            "has_position_data": positioning_block["has_position_data"],
            "has_target_lock_data": positioning_block.get("has_target_lock_data", False),
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
        "positioning": positioning_block,
    }


def build_all_matches_aggregate(all_match_data):
    """Build cross-match aggregate stats."""
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
            "fav_weapon": fav_weapon,
            "best_match": c["best_match"],
            "weapon_breakdown": weapon_breakdown,
            **movement_fields,
            **target_lock_fields,
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
            "matches_with_positioning": matches_with_positioning_count,
            "matches_with_target_lock_data": matches_with_target_lock_data_count,
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
            "has_position_data": match_data["match"].get("has_position_data", False),
            "has_target_lock_data": match_data["match"].get("has_target_lock_data", False),
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
