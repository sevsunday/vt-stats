#!/usr/bin/env python3
"""VT Stats — display-only VTSR-T bands (tier + Upper / Lower half).

Pure module (no I/O). VTSR-T is shown to players as a band, never as a
number: each tier splits at its midpoint into an Upper and a Lower half,
giving ten bands. ``walk_bands(after_sequence)`` replays a player's
chronological post-match ratings through a sticky state machine — a
player only enters an adjacent band after clearing its edge by
``BAND_BUFFER`` points, so a single noisy game rarely flips the label.
The buffer applies to tier lines too, so the displayed tier is sticky.

Nothing here changes ratings, K, or match history. ``scripts/elo.py``
emits the result as additive ``band_*`` fields on ``elo_current.json``
plus a top-level ``band_config`` the UI reads instead of hardcoding.

Six tiers, 200 points wide, anchored at 1500 (the start rating is the
bottom of Tier 3). Band index 0 is Tier 5 Lower, 11 is Tier 0 Upper.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import Iterable

# Tier lines plus each tier's midpoint split. The UI reads them from
# band_config (js/vtsr-display.js); scripts/generate_player_pages.py
# imports tiers(). Tier 0 is open-ended and splits as if 200 wide, so its
# position bar pins once a rating passes TIER_0_TRACK_TOP; re-space the
# lines if the top of the ladder gets there.
TIER_WIDTH = 200
TIER_LINES = (1300, 1500, 1700, 1900, 2100)
TIER_SPLITS = (1150, 1400, 1600, 1800, 2000, 2200)
RATING_FLOOR = 1000
TIER_0_TRACK_TOP = TIER_LINES[-1] + TIER_WIDTH
BAND_EDGES = tuple(sorted(TIER_LINES + TIER_SPLITS))
BAND_COUNT = len(BAND_EDGES) + 1

BAND_BUFFER = 20.0
# A per-game change smaller than this (in either direction) reads as
# "On par" with expectation. The UI and the map generator read it from
# band_config; nothing else consumes it.
ON_PAR_DELTA = 3.0


def band_for(rating: float) -> int:
    """Raw (non-sticky) band index for a rating."""
    return bisect_right(BAND_EDGES, float(rating))


TOP_TIER = 0
BOTTOM_TIER = len(TIER_LINES)


def band_tier(index: int) -> int:
    return BOTTOM_TIER - index // 2


def band_half(index: int) -> str:
    return "upper" if index % 2 else "lower"


def band_label(index: int) -> str:
    return f"Tier {band_tier(index)} · {band_half(index).capitalize()}"


def walk_bands(after_sequence: Iterable[float], buffer: float = BAND_BUFFER) -> int | None:
    """Sticky band index after replaying ``after_sequence`` in order.

    The first rating places the player at its raw band. Afterwards the
    state moves up to band ``b`` only when the rating reaches
    ``BAND_EDGES[b - 1] + buffer`` and down to band ``b`` only when it
    falls below ``BAND_EDGES[b] - buffer``. A large swing can cross
    several bands at once. Returns None for an empty sequence.
    """
    state: int | None = None
    for r in after_sequence:
        r = float(r)
        if state is None:
            state = band_for(r)
            continue
        raw = band_for(r)
        if raw > state:
            b = state
            while b + 1 < BAND_COUNT and r >= BAND_EDGES[b] + buffer:
                b += 1
            state = b
        elif raw < state:
            b = state
            while b - 1 >= 0 and r < BAND_EDGES[b - 1] - buffer:
                b -= 1
            state = b
    return state


def tiers() -> list[dict]:
    """Tiers top first: ``{id, label, min, max}`` (Tier 0 max is inf)."""
    bounds = (RATING_FLOOR,) + TIER_LINES + (float("inf"),)
    out = []
    for i in range(len(bounds) - 1):
        tier = BOTTOM_TIER - i
        out.append({"id": tier, "label": f"Tier {tier}", "min": float(bounds[i]), "max": float(bounds[i + 1])})
    return out[::-1]


def band_config() -> dict:
    """Top-level metadata block for elo_current.json."""
    return {
        "edges": list(BAND_EDGES),
        "tier_lines": list(TIER_LINES),
        "splits": list(TIER_SPLITS),
        "tier_width": TIER_WIDTH,
        "floor": RATING_FLOOR,
        "buffer_pts": BAND_BUFFER,
        "on_par_delta_pts": ON_PAR_DELTA,
    }
