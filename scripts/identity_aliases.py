#!/usr/bin/env python3
"""
VT Stats — Silent Steam64 identity aliases.

Single source of truth for "these two Steam accounts are the same person,
merge them SILENTLY". An alias rewrites the SOURCE Steam64 to the TARGET
Steam64 at ingest (scripts/process_stats.py::process_match) so every
downstream identity-keyed surface — VTSR-T / VTSR-C, career rollups,
player profile links, Tools resolution — attributes the source account's
gameplay to the target. Unlike ACCOUNT_REROUTES (the shared-PC mechanism
in scripts/process_stats.py), a silent alias:

  - matches on Steam64, not on in-game nick patterns;
  - keeps the SOURCE account's display name on every per-match surface
    (leaderboard, kill feed, picker roster, highlights) — the merge is
    never visible in the UI;
  - emits NO provenance fields (no `rerouted_from`, no
    `match.account_reroutes` entry, no `via X` chip, no raw-browser
    banner).

Career/ELO surfaces (elo_current ratings, elo_history deltas, the
contribution rows the All Matches aggregator consumes) pin the row's
name to the TARGET's canonical name so the career row is never renamed
by a source-account appearance.

Dual-presence hard stop: if BOTH the source and target Steam64s appear
in one lobby, the merge premise ("one person, two accounts") is broken.
`resolve_silent_aliases()` halts the pipeline with an interactive
`accept match? (y/n)` checkpoint (y = process the match with the two
identities kept separate, n = abort the run). Under --no-prompt the
pipeline ALWAYS aborts — never a silent skip.

UNDO RECIPE (re-separate the accounts):
  1. Delete the alias entry from STEAM64_ALIASES (and its
     ALIAS_TARGET_NAMES entry if the target has no other aliases).
  2. Bump PIPELINE_VERSION in scripts/process_stats.py.
  3. Re-run `python scripts/process_stats.py` (full reprocess; ELO
     recomputes unconditionally). The source account's sticky slug in
     data/processed/player_slugs.json was never deleted, so its old
     /player/<slug>/ URL becomes a real profile again on the next
     generator pass.
"""

from __future__ import annotations

import sys

# source Steam64 -> target Steam64. All of the source account's gameplay
# is attributed to the target. See module docstring for semantics + undo.
STEAM64_ALIASES: dict[int, int] = {
    76561199317457354: 76561199066952713,  # aggressor -> Nomad
}

# Canonical display name for each alias TARGET, used to pin career/ELO
# row names so a source-account appearance (whose per-match rows keep
# the source display name) never renames the merged career row.
# Keep in sync with data/steamid_to_name.txt.
ALIAS_TARGET_NAMES: dict[int, str] = {
    76561199066952713: "Nomad",
}

# Derived views ------------------------------------------------------------

ALIAS_TARGETS: frozenset[int] = frozenset(STEAM64_ALIASES.values())

# String-keyed mirrors for JSON-facing consumers (elo.py keys players by
# str(steam64); contribution rows carry steam64 as a string).
STEAM64_ALIASES_STR: dict[str, str] = {
    str(k): str(v) for k, v in STEAM64_ALIASES.items()
}
ALIAS_TARGET_NAMES_STR: dict[str, str] = {
    str(k): v for k, v in ALIAS_TARGET_NAMES.items()
}


def resolve_silent_aliases(
    slot_to_s64: dict[int, int],
    *,
    match_label: str = "",
    no_prompt: bool = False,
) -> dict[int, tuple[int, int]]:
    """Return {slot: (source_s64, target_s64)} for every slot in this
    match owned by an alias-source Steam64.

    Dual-presence hard stop: if any alias's source AND target are both
    present in `slot_to_s64`, the merge premise is broken. Interactive
    runs get a loud `accept match? (y/n)` checkpoint — `y` processes the
    match with both identities kept separate (returns {}, no alias this
    match, run continues), `n` aborts the whole pipeline. Non-interactive
    runs (--no-prompt / no TTY) ALWAYS abort with a clear error so the
    operator sees the situation — this is deliberately stricter than
    outcome adjudication's defer-and-continue posture.
    """
    if not STEAM64_ALIASES:
        return {}

    present = set(slot_to_s64.values())
    out: dict[int, tuple[int, int]] = {}
    for slot, s64 in slot_to_s64.items():
        target = STEAM64_ALIASES.get(s64)
        if target is None:
            continue
        if target in present:
            _dual_presence_stop(s64, target, match_label, no_prompt)
            # Operator accepted: keep both identities separate for this
            # match (and skip every other alias rewrite too — the lobby
            # is under manual review, don't half-apply).
            return {}
        out[slot] = (s64, target)
    return out


def _dual_presence_stop(
    source_s64: int, target_s64: int, match_label: str, no_prompt: bool
) -> None:
    """Loud checkpoint for the both-accounts-in-one-lobby case. Returns
    normally only when an interactive operator answers `y`."""
    banner = (
        "\n" + ("!" * 72) + "\n"
        "  IDENTITY ALIAS CONFLICT — both accounts of a silent alias are\n"
        "  present in the same match:\n"
        f"    match:  {match_label or '(unknown)'}\n"
        f"    source: {source_s64}\n"
        f"    target: {target_s64}\n"
        "  The alias premise (one person, two accounts) appears broken.\n"
        "  Consider undoing the alias — see scripts/identity_aliases.py.\n"
        + "!" * 72
    )
    print(banner)

    if no_prompt or not sys.stdin.isatty():
        print(
            "ABORT: dual-presence alias conflict under --no-prompt / "
            "non-interactive stdin. Re-run interactively to review, or "
            "remove the alias from scripts/identity_aliases.py."
        )
        sys.exit(1)

    while True:
        try:
            ans = input(
                "  accept match? (y = process with identities kept separate, "
                "n = abort pipeline) [y/n]: "
            ).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nABORT: no answer to alias-conflict prompt.")
            sys.exit(1)
        if ans == "y":
            print("  Accepted: identities kept separate for this match only.")
            return
        if ans == "n":
            print("ABORT: operator declined alias-conflict match.")
            sys.exit(1)


__all__ = [
    "STEAM64_ALIASES",
    "ALIAS_TARGET_NAMES",
    "ALIAS_TARGETS",
    "STEAM64_ALIASES_STR",
    "ALIAS_TARGET_NAMES_STR",
    "resolve_silent_aliases",
]
