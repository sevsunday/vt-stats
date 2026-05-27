"""Smoke-test simulator for re-weighted VTSR-T.

Runs the canonical elo.compute_elo() over the entire corpus twice:
  1. Once with the current ``THUG_WEIGHTS`` (sanity check vs the
     committed ``data/processed/elo_current.json``).
  2. Once with operator-supplied new weights (monkey-patched into
     ``elo.THUG_WEIGHTS`` in place).

Prints a side-by-side comparison table for the top N players by
current VTSR-T. The pipeline is NOT modified; the canonical JSON on
disk is not touched.

Usage:
  python _axis-analysis/simulate_weights.py \
      --tlp 0.02 --snipe 0.02 \
      --redistribute proportional \
      --top 15

Redistribution modes:
  proportional   -- spread the freed weight proportionally across the
                    remaining 6 axes (keeps their relative ratios)
  efficiency     -- park all freed weight on thug_efficiency
  accuracy       -- park all freed weight on thug_accuracy
  process        -- split freed weight evenly between thug_efficiency
                    and thug_accuracy (the two "process quality" axes)
  net            -- park all freed weight on net_damage_share

Run with -h for the full CLI.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import elo  # noqa: E402

PROCESSED_DIR = REPO_ROOT / "data" / "processed"
NON_MATCH_FILES = {
    "elo_current.json", "elo_current_thugs_only.json",
    "elo_history.json", "elo_history_thugs_only.json",
    "map_stats.json", "matches.json", "match_contributions.json",
    "player_slugs.json",
}


def load_all_matches(restrict_to_ids: set[str] | None = None) -> list[dict]:
    """Load every per-match JSON under data/processed/.

    If ``restrict_to_ids`` is provided, drop matches whose ``match.id``
    isn't in the set -- used to mirror the corpus the canonical
    ``elo_current.json`` was computed on (excludes any per-match JSONs
    that were added after the last elo regeneration).
    """
    out = []
    skipped_not_in_history = 0
    for p in sorted(PROCESSED_DIR.iterdir()):
        if not p.is_file() or p.suffix != ".json" or p.name in NON_MATCH_FILES:
            continue
        try:
            with p.open("r", encoding="utf-8") as f:
                md = json.load(f)
        except Exception as e:
            print(f"  skip {p.name}: {e}", file=sys.stderr)
            continue
        mid = (md.get("match") or {}).get("id") or p.stem
        if restrict_to_ids is not None and mid not in restrict_to_ids:
            skipped_not_in_history += 1
            continue
        out.append(md)
    if skipped_not_in_history:
        print(
            f"  skipped {skipped_not_in_history} match JSONs not in "
            f"on-disk elo_history (post-elo additions)",
            file=sys.stderr,
        )
    return out


def build_weights(
    tlp: float, snipe: float, redistribute: str, base: dict[str, float]
) -> dict[str, float]:
    """Build a new THUG_WEIGHTS dict.

    ``base`` is the canonical weights. Returns a copy with TLP and
    snipe_bonus replaced and the freed weight redistributed.
    """
    new = dict(base)
    freed = (new["target_lock_pct"] - tlp) + (new["snipe_bonus"] - snipe)
    new["target_lock_pct"] = tlp
    new["snipe_bonus"] = snipe

    if freed <= 1e-9:
        return new  # increasing weights also OK, no redistribution needed

    receivers_by_mode = {
        "efficiency": ["thug_efficiency"],
        "accuracy":   ["thug_accuracy"],
        "process":    ["thug_efficiency", "thug_accuracy"],
        "net":        ["net_damage_share"],
        "proportional": [
            "net_damage_share", "thug_kill_rate", "thug_accuracy",
            "thug_efficiency", "pve_share", "mobility",
        ],
    }
    receivers = receivers_by_mode[redistribute]

    if redistribute == "proportional":
        # weight each receiver by its current share of the receiver pool
        pool = sum(new[a] for a in receivers)
        for a in receivers:
            new[a] += freed * (new[a] / pool)
    else:
        share = freed / len(receivers)
        for a in receivers:
            new[a] += share
    return new


def simulate(
    weights: dict[str, float],
    all_matches: list[dict],
    *,
    disable_commander_padding: bool = False,
    commander_padding_scale: float = 1.0,
) -> dict[str, dict]:
    """Run compute_elo with the given THUG_WEIGHTS. Returns
    ``{steam64: rating_dict}`` from the resulting elo_current.

    Commander-padding controls (mutually exclusive in effect):
      * ``disable_commander_padding=True``: clear ``COMMANDER_AXIS_PRIOR``
        entirely -- commander rows scored as thugs, no cushion at all.
      * ``commander_padding_scale=X`` (X in [0.0, 1.0+]): multiply every
        value in ``COMMANDER_AXIS_PRIOR`` by X. 1.0 = no change. 0.75 =
        25% reduction. 0.50 = 50% reduction. 0.0 = effectively the same
        as disable_commander_padding=True.

    The two flags are independent; if both are set the disable takes
    precedence.
    """
    # Monkey-patch in place (compute_performance_index reads dict at call time).
    original_weights = dict(elo.THUG_WEIGHTS)
    original_cap = dict(elo.COMMANDER_AXIS_PRIOR)
    elo.THUG_WEIGHTS.clear()
    elo.THUG_WEIGHTS.update(weights)
    if disable_commander_padding:
        elo.COMMANDER_AXIS_PRIOR.clear()
    elif abs(commander_padding_scale - 1.0) > 1e-9:
        scaled = {a: v * commander_padding_scale for a, v in original_cap.items()}
        elo.COMMANDER_AXIS_PRIOR.clear()
        elo.COMMANDER_AXIS_PRIOR.update(scaled)
    try:
        current, _history = elo.compute_elo(all_matches)
    finally:
        elo.THUG_WEIGHTS.clear()
        elo.THUG_WEIGHTS.update(original_weights)
        elo.COMMANDER_AXIS_PRIOR.clear()
        elo.COMMANDER_AXIS_PRIOR.update(original_cap)
    by_s64 = {}
    for r in current.get("ratings", []):
        by_s64[str(r["steam64"])] = r
    return by_s64


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Smoke-test re-weighted VTSR-T (no pipeline writes)."
    )
    ap.add_argument("--tlp",   type=float, default=0.02,
                    help="New weight for target_lock_pct (default 0.02)")
    ap.add_argument("--snipe", type=float, default=0.02,
                    help="New weight for snipe_bonus (default 0.02)")
    ap.add_argument(
        "--redistribute", default="proportional",
        choices=["proportional", "efficiency", "accuracy", "process", "net"],
        help="Where the freed weight gets parked.",
    )
    ap.add_argument("--top", type=int, default=15,
                    help="Top-N players to show in the comparison table")
    ap.add_argument("--all", action="store_true",
                    help="Show all players (overrides --top)")
    args = ap.parse_args()

    # Restrict to the exact set of match ids the canonical
    # elo_history.json was computed over -- so the sanity check below
    # can detect actual drift instead of corpus drift.
    on_disk_hist_path = PROCESSED_DIR / "elo_history.json"
    restrict_ids: set[str] | None = None
    if on_disk_hist_path.exists():
        with on_disk_hist_path.open("r", encoding="utf-8") as f:
            hist_blob = json.load(f)
        restrict_ids = {h["match_id"] for h in hist_blob.get("history", [])}
        print(f"Restricting to {len(restrict_ids)} match ids in on-disk elo_history",
              file=sys.stderr)

    print("Loading matches ...", file=sys.stderr)
    all_matches = load_all_matches(restrict_to_ids=restrict_ids)
    print(f"  loaded {len(all_matches)} match JSONs", file=sys.stderr)

    base_weights = dict(elo.THUG_WEIGHTS)
    new_weights = build_weights(args.tlp, args.snipe, args.redistribute, base_weights)

    # Sanity: warn if weights don't sum to 1
    total = sum(new_weights.values())
    if abs(total - 1.0) > 1e-6:
        print(f"WARN: new weights sum to {total:.6f} (not 1.0)", file=sys.stderr)

    print("\nWEIGHT COMPARISON")
    print(f"{'axis':<20} {'old':>8} {'new':>8} {'delta':>8}")
    print("-" * 50)
    for axis in base_weights:
        oldv = base_weights[axis]
        newv = new_weights[axis]
        d = newv - oldv
        flag = ""
        if axis in ("target_lock_pct", "snipe_bonus"): flag = " <-- changed"
        elif abs(d) > 1e-6:                            flag = " <-- absorbs freed"
        print(f"{axis:<20} {oldv:>8.4f} {newv:>8.4f} {d:>+8.4f}{flag}")
    print(f"{'(sum)':<20} {sum(base_weights.values()):>8.4f} {sum(new_weights.values()):>8.4f}")

    print("\nSimulating canonical weights (drift audit) ...", file=sys.stderr)
    canon_sim = simulate(base_weights, all_matches)

    print("Simulating NEW weights ...", file=sys.stderr)
    new_sim = simulate(new_weights, all_matches)

    # Use the ON-DISK elo_current as the "old" baseline (apples-to-
    # apples with the published rating). Re-simulating with canonical
    # weights is only used to estimate the code-drift envelope.
    on_disk_path = PROCESSED_DIR / "elo_current.json"
    on_disk = {}
    if on_disk_path.exists():
        with on_disk_path.open("r", encoding="utf-8") as f:
            for r in json.load(f).get("ratings", []):
                on_disk[str(r["steam64"])] = r

    # ---- Diagnostic: how far does canonical-sim drift from on-disk? ----
    drifts = []
    for s64, sim in canon_sim.items():
        disk = on_disk.get(s64)
        if disk:
            drifts.append((abs(sim["vtsr"] - disk["vtsr"]), sim["name"]))
    if drifts:
        drifts.sort(reverse=True)
        max_d, max_who = drifts[0]
        median_d = drifts[len(drifts) // 2][0]
        print(
            f"\nDrift audit (canonical re-sim vs on-disk elo_current):\n"
            f"  max:    {max_d:>6.2f} VTSR  ({max_who})\n"
            f"  median: {median_d:>6.2f} VTSR\n"
            f"  This is code-drift between elo.py NOW and the version that\n"
            f"  last wrote elo_current.json. Treat the 'shift_from_canon'\n"
            f"  column below as the truer signal.",
            file=sys.stderr,
        )

    # ---- Build sorted comparison (anchored to on-disk) ----
    rows = []
    all_s64 = set(on_disk.keys()) | set(new_sim.keys())
    for s64 in all_s64:
        disk = on_disk.get(s64) or {}
        sim_new = new_sim.get(s64) or {}
        sim_canon = canon_sim.get(s64) or {}
        name = sim_new.get("name") or disk.get("name") or s64
        if not sim_new:
            continue  # player not in current sim corpus (shouldn't happen)
        rows.append({
            "name": name,
            "s64": s64,
            "matches": int(sim_new.get("matches_played", 0)),
            "matches_thug": int(sim_new.get("matches_as_thug", 0)),
            "matches_cmdr": int(sim_new.get("matches_as_commander", 0)),
            "disk_vtsr":  float(disk.get("vtsr", 0.0)),
            "canon_vtsr": float(sim_canon.get("vtsr", 0.0)),
            "new_vtsr":   float(sim_new["vtsr"]),
            "disk_peak":  float(disk.get("peak_vtsr", 0.0)),
            "new_peak":   float(sim_new["peak_vtsr"]),
            "provisional": bool(sim_new.get("matches_provisional", False)),
        })
    rows.sort(key=lambda r: r["disk_vtsr"], reverse=True)

    # Slice
    show = rows if args.all else rows[: args.top]

    # ---- Print table ----
    print(f"\nTOP {len(show)} VTSR-T (sorted by ON-DISK rating)\n")
    hdr = (
        f"{'rank':>4}  {'player':<22}  {'mch':>3}  "
        f"{'on_disk':>8}  {'canon':>8}  {'new':>8}  "
        f"{'d:disk->new':>11}  {'d:canon->new':>12}  "
        f"{'rank shift':>11}  prov"
    )
    print(hdr)
    print("-" * len(hdr))

    # Compute rank-by-new for "rank shift" column (based on new vs on-disk)
    new_sorted = sorted(rows, key=lambda r: r["new_vtsr"], reverse=True)
    new_rank_global = {r["s64"]: i + 1 for i, r in enumerate(new_sorted)}

    for i, r in enumerate(show, 1):
        d_disk  = r["new_vtsr"] - r["disk_vtsr"]
        d_canon = r["new_vtsr"] - r["canon_vtsr"]
        nr = new_rank_global[r["s64"]]
        shift = nr - i
        shift_str = f"{i} -> {nr}"
        if shift != 0:
            arrow = "(up)" if shift < 0 else "(down)"
            shift_str = f"{i} -> {nr} {arrow}"
        prov = " *" if r["provisional"] else ""
        print(
            f"{i:>4}  {r['name']:<22}  {r['matches']:>3}  "
            f"{r['disk_vtsr']:>8.1f}  {r['canon_vtsr']:>8.1f}  {r['new_vtsr']:>8.1f}  "
            f"{d_disk:>+11.1f}  {d_canon:>+12.1f}  "
            f"{shift_str:>11}  {prov}"
        )

    # ---- Summary stats (use canon vs new -- isolates the weight change) ----
    deltas = [r["new_vtsr"] - r["canon_vtsr"] for r in rows]
    deltas_top = [r["new_vtsr"] - r["canon_vtsr"] for r in show]
    print("\nSUMMARY (canon-vs-new isolates the pure weight effect)")
    print(f"  Players changed:        {sum(1 for d in deltas if abs(d) > 0.05)} of {len(rows)}")
    print(f"  Mean delta (all):       {sum(deltas)/len(deltas):+.2f}")
    print(f"  Mean delta (top {len(show)}):    {sum(deltas_top)/len(deltas_top):+.2f}")
    print(f"  Max gain:               {max(deltas):+.2f}")
    print(f"  Max loss:               {min(deltas):+.2f}")
    rank_shifts = sum(
        1 for i, r in enumerate(show, 1) if new_rank_global[r["s64"]] != i
    )
    print(f"  Rank shifts in top {len(show)}: {rank_shifts}")


if __name__ == "__main__":
    main()
