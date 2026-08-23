#!/usr/bin/env python3
"""Human outcome adjudication for the VT Stats pipeline.

The proto v3 collector asks the match HOST for the outcome via an in-game
dialog, but the first real batch proved that attestation is noisy human
input (1 of 3 outcomes contradicted overwhelming kill-feed evidence), and
the kill-feed inference can only catch a misclick when a clean win exists.
This module makes the pipeline operator the FINAL authority: every v3-era
match prompts once (console) for outcome confirmation, the answer persists
in a committed JSON file, and the match never prompts again -- on any
machine, across any reprocess.

Precedence: an adjudicated outcome sits ABOVE the entire v15 trust ladder
(host attestation, clean-win inference, everything). Applying one is a pure
rewrite of the winner block's resolution fields (`team` / `loser` /
`decided_by` / `decided_at_tick` / `adjudicated`); the pre-adjudication
provenance fields (`attested`, `disputed`, `agreement`, `inferred`,
`evidence`) are never touched -- they describe what the sources said.

Storage: `data/match_outcome_adjudications.json` --
    {"schema_version": 1, "adjudications": {"<match_id>": {...}}}
Keyed by match id (dedupes dual recordings of the same game), keys sorted
on write for stable git diffs, human-editable: delete an entry to re-prompt,
edit an `outcome` value and the pipeline's reconciliation pass rewrites the
match's winner block on the next run (no --force needed).

Wired into `scripts/process_stats.py::main()` between the registry build
and the manifest write. Pure console UX by design (the pipeline is a
console tool); prompting requires an interactive stdin unless the caller
passes --force-prompt (testing aid: answers read from piped stdin).
"""

import json
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
ADJUDICATIONS_PATH = PROJECT_ROOT / "data" / "match_outcome_adjudications.json"

ADJUDICATIONS_SCHEMA_VERSION = 1

# Outcome tokens stored in the adjudications file. team1/team2/draw/cancelled
# mirror the collector dialog's four buttons exactly; "unknown" is the
# operator-only escape hatch ("I can't determine this, stop asking") that
# signs the match off while leaving its resolution unclear.
VALID_OUTCOMES = ("team1", "team2", "draw", "cancelled", "unknown")

# Proto schema eras that require sign-off. v1/v2 predate the attestation
# dialog and are grandfathered (never prompt) unless --adjudicate-all.
_LEGACY_SCHEMAS = {"v1", "v2"}


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def load_adjudications():
    """Return the {match_id: entry} map (empty dict when the file is
    missing or unreadable -- a corrupt file must not brick the pipeline;
    it just re-prompts)."""
    try:
        with open(ADJUDICATIONS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        adj = data.get("adjudications")
        return adj if isinstance(adj, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        print(f"  WARN: could not read {ADJUDICATIONS_PATH.name} ({e}); treating as empty")
        return {}


def save_adjudications(adjudications):
    """Write the full file (sorted keys, stable diffs). Called after EVERY
    answered prompt so a Ctrl+C mid-batch keeps earlier answers."""
    payload = {
        "schema_version": ADJUDICATIONS_SCHEMA_VERSION,
        "_comment": (
            "Human-confirmed match outcomes (final authority over host "
            "attestation and kill-feed inference). Keyed by match id. "
            "Delete an entry to make the pipeline re-prompt for that match; "
            "edit an `outcome` (team1|team2|draw|cancelled|unknown) and the "
            "next run reconciles the match JSON automatically."
        ),
        "adjudications": {k: adjudications[k] for k in sorted(adjudications)},
    }
    ADJUDICATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ADJUDICATIONS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ---------------------------------------------------------------------------
# Candidacy
# ---------------------------------------------------------------------------

def is_candidate(match_data, adjudications, adjudicate_all=False):
    """True when this match should prompt for sign-off this run."""
    m = match_data.get("match") or {}
    mid = m.get("id")
    if not mid or mid in adjudications:
        return False
    if not adjudicate_all and m.get("proto_schema_version") in _LEGACY_SCHEMAS:
        return False
    if not match_data.get("leaderboard"):
        # Zero-roster degenerate -- nothing to confirm.
        print(f"  WARN: {mid}: empty roster; skipping outcome review")
        return False
    return True


# ---------------------------------------------------------------------------
# Winner-block views + application
# ---------------------------------------------------------------------------

def _inference_view(winner):
    """(team, decided_by, tick) of the KILL-FEED INFERENCE regardless of
    block shape: attestation-driven blocks preserve it under `inferred`;
    inference-driven blocks ARE the inference."""
    inf = winner.get("inferred")
    if inf:
        return inf.get("team"), inf.get("decided_by"), inf.get("decided_at_tick")
    db = winner.get("decided_by")
    if db in ("clean_win", "contested"):
        return winner.get("team"), db, winner.get("decided_at_tick")
    if db == "unclear":
        return None, "unclear", None
    return None, None, None


def current_outcome_token(winner):
    """Map the block's CURRENT resolution to an outcome token, or None when
    there is nothing to confirm (unclear)."""
    db = winner.get("decided_by")
    team = winner.get("team")
    if team in (1, 2):
        return f"team{team}"
    if db == "draw":
        return "draw"
    if db == "cancelled":
        return "cancelled"
    return None


def apply_outcome(winner, outcome):
    """Return `(new_block, changed)` -- the winner block with the
    adjudicated outcome applied. Pure + idempotent: re-applying an already
    reflected outcome returns `changed=False`. Only the resolution fields
    are rewritten; provenance fields pass through untouched."""
    new = dict(winner)
    new["adjudicated"] = True

    if outcome == "unknown":
        # Sign-off only: resolution (whatever it is) stays as-is.
        pass
    elif outcome in ("team1", "team2"):
        team = 1 if outcome == "team1" else 2
        if new.get("team") != team:
            inf_team, _inf_db, inf_tick = _inference_view(winner)
            new["team"] = team
            new["loser"] = 3 - team
            new["decided_by"] = "adjudicated"
            # Milestone tick only when the kill-feed inference agrees on
            # the same team; otherwise there is no trustworthy tick.
            new["decided_at_tick"] = inf_tick if inf_team == team else None
        # else: confirmed the existing resolution -- decided_by stays
        # (attested / clean_win / contested / adjudicated), tick stays.
    elif outcome in ("draw", "cancelled"):
        if new.get("decided_by") != outcome:
            new["team"] = None
            new["loser"] = None
            new["decided_by"] = outcome
            new["decided_at_tick"] = None
    else:
        raise ValueError(f"unrecognized adjudication outcome {outcome!r}")

    return new, new != winner


def make_entry(match_data, outcome):
    """Build the adjudications-file entry for a freshly answered prompt."""
    m = match_data.get("match") or {}
    winner = m.get("winner") or {}
    return {
        "outcome": outcome,
        "confirmed_existing": outcome == current_outcome_token(winner),
        "prior": {
            "decided_by":   winner.get("decided_by"),
            "team":         winner.get("team"),
            "game_outcome": m.get("game_outcome"),
        },
        "map":  m.get("map"),
        "date": m.get("date"),
        "adjudicated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": None,
    }


# ---------------------------------------------------------------------------
# Console prompt
# ---------------------------------------------------------------------------

def _fmt_when(date_iso):
    try:
        dt = datetime.fromisoformat(str(date_iso).replace("Z", "+00:00"))
        return dt.strftime("%b %d %Y, %H:%M UTC")
    except (ValueError, TypeError):
        return str(date_iso or "?")


def _fmt_duration(seconds):
    try:
        s = int(round(float(seconds)))
        return f"{s // 60}m {s % 60:02d}s"
    except (ValueError, TypeError):
        return "?"


_OUTCOME_LABELS = {
    "OUTCOME_TEAM1_WIN":      "Team 1 win",
    "OUTCOME_TEAM2_WIN":      "Team 2 win",
    "OUTCOME_DRAW":           "Draw",
    "OUTCOME_GAME_CANCELLED": "Game cancelled",
}


def _team_column(match_data, team):
    """Ordered display names for one team: leader first (marked), then by
    slot; plus a top-2 kills memory-jogger line.

    Names are the CANONICAL Steam names -- `leaderboard[].name` is already
    resolved through the pipeline's `known_players` chain (seeded from
    data/steamid_to_name.txt, which outranks the in-game nickname). When
    the player's in-game alias differed that match, it's appended as an
    `[aka "..."]` hint (the leaderboard's `in_game_nick` field is non-null
    exactly in that case) -- extra recall help for the operator.
    """
    lo, hi = (1, 5) if team == 1 else (6, 10)
    rows = [p for p in (match_data.get("leaderboard") or [])
            if isinstance(p.get("slot"), int) and lo <= p["slot"] <= hi]
    rows.sort(key=lambda p: (not p.get("is_commander"), p.get("slot") or 99))
    names = []
    for p in rows:
        label = p.get("name", "?")
        alias = p.get("in_game_nick")
        if alias:
            label += f' [aka "{alias}"]'
        if p.get("is_commander"):
            label += " (leader)"
        names.append(label)
    by_kills = sorted(rows, key=lambda p: -(p.get("kills") or 0))[:2]
    joggers = ", ".join(
        f"{(p.get('name') or '?')[:12]} {p.get('kills') or 0}" for p in by_kills if (p.get("kills") or 0) > 0
    )
    return names, (f"Top kills: {joggers}" if joggers else "")


def _current_resolution_label(winner):
    db = winner.get("decided_by")
    team = winner.get("team")
    if db == "attested" and team:
        return f"Team {team} win (host-attested)"
    if db == "clean_win" and team:
        disputed = " — DISPUTED: host said otherwise" if winner.get("disputed") else ""
        return f"Team {team} win (clean-win evidence){disputed}"
    if db == "contested" and team:
        return f"Team {team} win (contested — both bases fell)"
    if db == "adjudicated" and team:
        return f"Team {team} win (previously adjudicated)"
    if db == "draw":
        return "Draw (host-attested)"
    if db == "cancelled":
        return "Game cancelled (host-attested)"
    return "no winner determined (unclear)"


def render_prompt(match_data, display_name, index, total):
    """Build the full prompt text (separate from input handling so tests
    can snapshot it)."""
    m = match_data.get("match") or {}
    winner = m.get("winner") or {}
    factions = m.get("team_factions") or {}

    def fac(team):
        f = factions.get(str(team))
        return f" — {f['name']}" if f and f.get("name") else ""

    t1_names, t1_jog = _team_column(match_data, 1)
    t2_names, t2_jog = _team_column(match_data, 2)
    left = [f"Team 1{fac(1)}"] + t1_names + ([t1_jog] if t1_jog else [])
    right = [f"Team 2{fac(2)}"] + t2_names + ([t2_jog] if t2_jog else [])
    width = max([24] + [len(s) + 2 for s in left])
    rows = []
    for i in range(max(len(left), len(right))):
        l = left[i] if i < len(left) else ""
        r = right[i] if i < len(right) else ""
        rows.append(f" {l:<{width}}{r}")

    host_raw = m.get("game_outcome")
    host_label = _OUTCOME_LABELS.get(host_raw, "— (no attestation recorded)")

    inf_team, inf_db, _tick = _inference_view(winner)
    if inf_db == "clean_win" and inf_team:
        evidence_label = f"Team {inf_team} win (clean win)"
    elif inf_db == "contested" and inf_team:
        evidence_label = f"Team {inf_team} win (contested)"
    elif inf_db == "unclear":
        evidence_label = "inconclusive (unclear)"
    else:
        evidence_label = "— (not available)"

    can_confirm = current_outcome_token(winner) is not None
    enter_hint = "Enter: confirm current   " if can_confirm else ""

    bar = "=" * 64
    lines = [
        "",
        bar,
        f" OUTCOME REVIEW ({index} of {total}) — {display_name} ({m.get('map', '?')})",
        f" {_fmt_when(m.get('date'))} · {_fmt_duration(m.get('duration_sec'))} · {m.get('player_count', '?')} players",
        bar,
        *rows,
        "",
        f" Host selected (in-game dialog):  {host_label}",
        f" Kill-feed evidence:              {evidence_label}",
        f" Current resolution:              {_current_resolution_label(winner)}",
        "",
        " Confirm the actual outcome:",
        "   1: Team 1 win   2: Team 2 win   3: Draw   4: Game cancelled",
        f"   {enter_hint}u: Unknown (leave unclear)   d: Defer (ask next run)",
    ]
    return "\n".join(lines)


def prompt_for_outcome(match_data, display_name, index, total):
    """Interactive prompt. Returns an outcome token, or None for defer.

    Piped-stdin friendly (--force-prompt testing path): EOF on stdin is
    treated as defer so a short answer file never blocks the run.
    """
    winner = (match_data.get("match") or {}).get("winner") or {}
    current = current_outcome_token(winner)
    print(render_prompt(match_data, display_name, index, total))

    key_map = {"1": "team1", "2": "team2", "3": "draw", "4": "cancelled", "u": "unknown"}
    while True:
        try:
            raw = input(" > ").strip().lower()
        except EOFError:
            print("   (stdin exhausted — deferring)")
            return None

        if raw == "":
            if current is not None:
                return current
            print("   Nothing to confirm (resolution is unclear) — pick 1-4, u, or d.")
            continue
        if raw == "d":
            return None
        if raw in key_map:
            return key_map[raw]
        print("   Unrecognized — press 1, 2, 3, 4, u, d, or Enter.")
