#!/usr/bin/env python3
"""
VT Stats -- F9 batch adjudication (gated auto-apply, one-shot).

Writes F9bomber-ledger outcomes into the committed adjudications store
(data/match_outcome_adjudications.json) for every UNCLEAR match whose
ledger pairing is machine-provably unambiguous. Exists because the
operator cannot verify the backlog from memory: instead of rubber-
stamping prompts, the operator ratified ONE rule (decision memo
critique/decisions/f9-external-duels.md, batch-adjudication addendum)
and this script enforces it mechanically. Everything failing a gate
stays unclear forever.

Trust basis (measured, 2026-09-17): 29/29 winner agreement between the
ledger and every independently-determined paired match, and a duration
fingerprint proving F9 logs the engine timer (median |duration diff| =
0s, p90 = 11s on the 29 calibration pairs).

THE SIX GATES (pre-registered; ALL must pass):
  1. live `winner.decided_by == "unclear"` (read from the per-match
     JSON; attested/clean_win/contested/cancelled/draw are never touched)
  2. `our_team` in {1, 2} (F9 winner resolved to one of our leaders)
  3. roster Jaccard == 1.0 (identical participants; no relaxed tier)
  4. |F9 duration - our duration_sec| <= DURATION_TOLERANCE_SEC (120)
  5. no F9-side sibling: no other eligible ledger row within +-1 day +
     same map + same commander-Steam64 pair (a sibling means the pairing
     could have crossed a rematch twin)
  6. no corpus-side sibling, EXCEPT a provable dual recording of the
     hinted match itself (start times within DUAL_REC_START_SEC and
     durations within DUAL_REC_DUR_SEC) -- that twin is the same
     physical game recorded twice; it is ignored for uniqueness and
     deliberately left unclear so VTSR-C rates the game exactly once.

Default is DRY-RUN (prints the full decision table). Pass --apply to
write. Entries are standard adjudication.make_entry() records with a
distinguishing `note` -- the UNDO handle: delete every entry whose note
starts with "auto-applied from F9bomber ledger" and re-run the pipeline.

After --apply, run `python scripts/process_stats.py` (the reconciliation
pass rewrites the winner blocks and everything downstream recomputes).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adjudication  # noqa: E402
from import_f9_ledger import (  # noqa: E402
    DEFAULT_XLSX, LEDGER_PATH, PROJECT_ROOT,
    build_eligible_rows, build_resolver, load_inputs, read_rows,
    resolve_map_key, strip_map_title,
)

PROCESSED = PROJECT_ROOT / "data" / "processed"

# Gate constants (pre-registered in the decision memo's addendum).
DURATION_TOLERANCE_SEC = 120     # calibration: real pairs sit at 0-11s
SIBLING_DAY_TOLERANCE = 1        # F9 dates are US-local vs our UTC ids
DUAL_REC_START_SEC = 300         # corpus twin = same game, two recorders
DUAL_REC_DUR_SEC = 5

NOTE_PREFIX = "auto-applied from F9bomber ledger"
RATIFICATION_REF = ("batch ratification 2026-09-17 -- "
                    "critique/decisions/f9-external-duels.md")


def load_corpus_index(manifest: list[dict], resolver) -> dict[str, dict]:
    """Manifest -> {match_id: joinable view} (leader Steam64 pair, map
    stems, start datetime, duration)."""
    out: dict[str, dict] = {}
    for m in manifest:
        dt = datetime.fromisoformat(m["date"].replace("Z", "+00:00"))
        leaders = m.get("team_leaders") or {}
        pair = {str((leaders.get("1") or {}).get("s64") or ""),
                str((leaders.get("2") or {}).get("s64") or "")} - {""}
        out[m["id"]] = {
            "start": dt,
            "date": dt.date(),
            "map_stem": strip_map_title(m.get("name") or ""),
            "map_file_stem": str(m.get("map") or "").lower().removesuffix(".bzn"),
            "pair": frozenset(pair),
            "duration_sec": float(m.get("duration_sec") or 0),
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Gated batch-apply of F9 ledger outcomes (dry-run default)")
    ap.add_argument("--apply", action="store_true",
                    help="Write the surviving entries into the adjudications "
                         "store (default: dry-run, print the table only)")
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    args = ap.parse_args()

    if not LEDGER_PATH.exists():
        print("FATAL: data/external/f9_ledger.json missing -- run "
              "scripts/import_f9_ledger.py first")
        return 1

    name_map, _exclude, map_aliases, title_index, manifest = load_inputs()
    resolver = build_resolver(name_map)
    stage, _funnel, _notes = build_eligible_rows(read_rows(args.xlsx), resolver)
    by_row = {p["row"]: p for p in stage}
    # Commander-Steam64 pair per eligible row (for sibling checks).
    for p in stage:
        p["_pair"] = frozenset(
            s for s in (resolver.resolve(p["c1"]), resolver.resolve(p["c2"])) if s)

    ledger = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
    overlaps = ledger.get("overlaps") or []
    corpus = load_corpus_index(manifest, resolver)

    def map_match(p: dict, o: dict) -> bool:
        key = resolve_map_key(p["map_title"], map_aliases, title_index)
        return (strip_map_title(p["map_title"]) == o["map_stem"]
                or (bool(key) and key == o["map_file_stem"]))

    applied: list[dict] = []
    skipped: list[tuple[int, str, list[str]]] = []
    already = 0

    adj_store = adjudication.load_adjudications()

    for ov in overlaps:
        row_id = ov.get("f9_row")
        mid = ov.get("match_id")
        p = by_row.get(row_id)
        o = corpus.get(mid)
        if p is None or o is None:
            print(f"FATAL: overlap r{row_id} -> {mid} does not join back to "
                  f"the eligible set / manifest (stale ledger? re-run the importer)")
            return 1

        # Load the live winner block (gate 1 must never trust the
        # at-import stamp -- outcomes may have changed since).
        match_path = PROCESSED / f"{mid}.json"
        match_data = json.loads(match_path.read_text(encoding="utf-8"))
        winner = (match_data.get("match") or {}).get("winner") or {}
        decided = winner.get("decided_by")

        if mid in adj_store:
            already += 1
            continue
        if decided != "unclear":
            # Determined matches were the validation set, not candidates.
            continue

        reasons: list[str] = []
        our_team = ov.get("our_team")
        if our_team not in (1, 2):
            reasons.append("side_unmapped")
        if ov.get("jaccard") != 1.0:
            reasons.append(f"jaccard_{ov.get('jaccard')}")
        dur_diff = p["duration_sec"] - o["duration_sec"]
        if abs(dur_diff) > DURATION_TOLERANCE_SEC:
            reasons.append(f"duration_diff_{abs(dur_diff):.0f}s")

        # Gate 5: F9-side sibling -- another eligible row that could have
        # been the true pair for OUR match.
        f9_siblings = 0
        for q in stage:
            if q["row"] == row_id:
                continue
            if abs((q["date"].date() - o["date"]).days) > SIBLING_DAY_TOLERANCE:
                continue
            if len(q["_pair"]) == 2 and q["_pair"] == o["pair"] and map_match(q, o):
                f9_siblings += 1
        if f9_siblings:
            reasons.append(f"f9_sibling_x{f9_siblings}")

        # Gate 6: corpus-side sibling -- another recording this F9 row
        # could belong to; dual recordings of the SAME game are exempt.
        corpus_siblings = 0
        for oid, o2 in corpus.items():
            if oid == mid:
                continue
            if abs((o2["date"] - p["date"].date()).days) > SIBLING_DAY_TOLERANCE:
                continue
            if not (len(p["_pair"]) == 2 and p["_pair"] == o2["pair"]
                    and map_match(p, o2)):
                continue
            is_dual_rec = (
                abs((o2["start"] - o["start"]).total_seconds()) <= DUAL_REC_START_SEC
                and abs(o2["duration_sec"] - o["duration_sec"]) <= DUAL_REC_DUR_SEC)
            if is_dual_rec:
                continue  # same physical game, second recorder
            corpus_siblings += 1
        if corpus_siblings:
            reasons.append(f"corpus_sibling_x{corpus_siblings}")

        if reasons:
            skipped.append((row_id, mid, reasons))
            continue

        entry = adjudication.make_entry(match_data, f"team{our_team}")
        entry["note"] = (
            f"{NOTE_PREFIX} row {row_id} "
            f"(jaccard 1.0, duration diff {abs(dur_diff):.1f}s, unique "
            f"pairing; {RATIFICATION_REF})")
        applied.append({
            "match_id": mid, "row": row_id, "team": our_team,
            "dur_diff": round(dur_diff, 1),
            "winner_name": ov.get("f9_winner_name") or "",
            "entry": entry,
        })

    # ---- report ----------------------------------------------------------
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"=== F9 batch adjudication ({mode}) ===")
    print(f"  overlap hints:          {len(overlaps)}")
    print(f"  already adjudicated:    {already}")
    print(f"  not unclear (skipped):  "
          f"{len(overlaps) - already - len(applied) - len(skipped)}")
    print(f"  APPLYING:               {len(applied)}")
    print(f"  GATE-FAILED (stay unclear forever): {len(skipped)}")
    print()
    print("  applied:")
    for a in sorted(applied, key=lambda x: x["match_id"]):
        print(f"    {a['match_id']}  <- r{a['row']}  team{a['team']} "
              f"({a['winner_name']})  dur_diff={a['dur_diff']}s")
    print("  skipped:")
    for row_id, mid, reasons in skipped:
        print(f"    r{row_id} -> {mid}  {', '.join(reasons)}")
    reason_hist = Counter(r.split("_x")[0].rsplit("_", 1)[0] if r[-1].isdigit()
                          else r for _, _, rs in skipped for r in rs)
    print(f"  skip-reason histogram: {dict(reason_hist)}")

    if not args.apply:
        print("\nDry-run only -- re-run with --apply to write the entries, "
              "then run `python scripts/process_stats.py` to reconcile.")
        return 0

    for a in applied:
        adj_store[a["match_id"]] = a["entry"]
    adjudication.save_adjudications(adj_store)
    print(f"\nWrote {len(applied)} entries to "
          f"{adjudication.ADJUDICATIONS_PATH.name}. Next: run "
          f"`python scripts/process_stats.py` (reconciliation applies the "
          f"outcomes and every downstream surface recomputes).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
