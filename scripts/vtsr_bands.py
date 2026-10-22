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

Band index 0 is Tier 5 Lower, 9 is Tier 1 Upper.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import Iterable

# Tier lines (mirror the VTSR_TIERS tables in js/elo.js, js/app.js,
# js/player.js and scripts/generate_player_pages.py) plus each tier's
# midpoint split. Tier 1 is open-ended and splits as if 150 wide.
TIER_LINES = (1350, 1500, 1650, 1800)
TIER_SPLITS = (1175, 1425, 1575, 1725, 1875)
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


def band_tier(index: int) -> int:
    return 5 - index // 2


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


def band_config() -> dict:
    """Top-level metadata block for elo_current.json."""
    return {
        "edges": list(BAND_EDGES),
        "tier_lines": list(TIER_LINES),
        "splits": list(TIER_SPLITS),
        "buffer_pts": BAND_BUFFER,
        "on_par_delta_pts": ON_PAR_DELTA,
    }
