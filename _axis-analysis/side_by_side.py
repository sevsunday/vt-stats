"""Side-by-side comparison of multiple weight scenarios.

Reuses ``simulate_weights.simulate`` and ``build_weights`` to run several
scenarios in one shot and print a unified per-player table covering the
ENTIRE rated cohort (not just top-N).

No CLI args -- the scenarios are baked in for the current investigation.
Edit ``SCENARIOS`` below to tweak.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from simulate_weights import (  # noqa: E402
    load_all_matches, build_weights, simulate, PROCESSED_DIR,
)
import elo  # noqa: E402

SCENARIOS = [
    {
        "label": "cmdr_pad_-25%",
        "tlp":   0.04,   # unchanged from canonical
        "snipe": 0.05,   # unchanged from canonical
        "redistribute": "proportional",  # no-op since no freed weight
        "commander_padding_scale": 0.75,
    },
    {
        "label": "cmdr_pad_-50%",
        "tlp":   0.04,
        "snipe": 0.05,
        "redistribute": "proportional",
        "commander_padding_scale": 0.50,
    },
]


def main() -> None:
    # Mirror the corpus the on-disk elo_current.json was built from.
    eh_path = PROCESSED_DIR / "elo_history.json"
    restrict = None
    if eh_path.exists():
        with eh_path.open("r", encoding="utf-8") as f:
            restrict = {h["match_id"] for h in json.load(f).get("history", [])}

    print(f"Loading matches (restricted to {len(restrict) if restrict else 'all'} ids) ...",
          file=sys.stderr)
    matches = load_all_matches(restrict_to_ids=restrict)

    base_weights = dict(elo.THUG_WEIGHTS)

    # ---- On-disk baseline (the published canonical numbers) ----
    on_disk = {}
    disk_path = PROCESSED_DIR / "elo_current.json"
    if disk_path.exists():
        with disk_path.open("r", encoding="utf-8") as f:
            for r in json.load(f).get("ratings", []):
                on_disk[str(r["steam64"])] = r

    # ---- Run all scenarios ----
    print(f"Simulating {len(SCENARIOS)} scenarios ...", file=sys.stderr)
    scenario_results = {}
    for sc in SCENARIOS:
        w = build_weights(sc["tlp"], sc["snipe"], sc["redistribute"], base_weights)
        notes = []
        if sc.get("disable_commander_padding"):
            notes.append("no-cmdr-pad")
        scale = sc.get("commander_padding_scale", 1.0)
        if abs(scale - 1.0) > 1e-9:
            notes.append(f"cmdr-pad x{scale:.2f}")
        pad_note = f" [{', '.join(notes)}]" if notes else ""
        print(
            f"  - {sc['label']}: tlp={sc['tlp']} snipe={sc['snipe']} ({sc['redistribute']}){pad_note}",
            file=sys.stderr,
        )
        scenario_results[sc["label"]] = simulate(
            w, matches,
            disable_commander_padding=bool(sc.get("disable_commander_padding")),
            commander_padding_scale=float(sc.get("commander_padding_scale", 1.0)),
        )

    # Also re-simulate canonical for the drift audit -- not displayed,
    # but useful as a sanity check. (Canonical = original weights +
    # commander padding enabled, which is the published behavior.)
    print("  - canon (drift audit)", file=sys.stderr)
    canon = simulate(base_weights, matches)

    # ---- Build the joined per-player table ----
    all_s64 = set(on_disk.keys())
    for ratings in scenario_results.values():
        all_s64.update(ratings.keys())

    rows = []
    for s64 in all_s64:
        disk = on_disk.get(s64) or {}
        any_sim = next(
            (r.get(s64) for r in scenario_results.values() if r.get(s64)),
            None,
        ) or canon.get(s64) or {}
        name = disk.get("name") or any_sim.get("name") or s64
        matches_played = int(disk.get("matches_played") or any_sim.get("matches_played") or 0)
        cmdr = int(disk.get("matches_as_commander") or any_sim.get("matches_as_commander") or 0)
        provisional = bool(disk.get("matches_provisional") or any_sim.get("matches_provisional"))

        disk_vtsr = float(disk.get("vtsr") or 0.0)
        canon_vtsr = float((canon.get(s64) or {}).get("vtsr") or 0.0)
        sc_vtsrs = {
            label: float((scenario_results[label].get(s64) or {}).get("vtsr") or 0.0)
            for label in scenario_results
        }
        # Drift envelope: |canon - on_disk|
        drift = abs(canon_vtsr - disk_vtsr) if (canon_vtsr and disk_vtsr) else 0.0

        rows.append({
            "name": name,
            "matches": matches_played,
            "cmdr": cmdr,
            "provisional": provisional,
            "disk_vtsr": disk_vtsr,
            "canon_vtsr": canon_vtsr,
            "drift": drift,
            **{f"new_{label}": sc_vtsrs[label] for label in scenario_results},
        })

    # Sort by on-disk VTSR DESC (with players with zero on-disk at the bottom)
    rows.sort(key=lambda r: (r["disk_vtsr"] == 0, -r["disk_vtsr"]))

    # ---- Print pipe-aligned markdown-ish table ----
    labels = [sc["label"] for sc in SCENARIOS]

    headers = [
        ("rank",     4),
        ("player",   22),
        ("mch",      4),
        ("cmdr",     4),
        ("on_disk",  8),
        ("canon",    8),
    ]
    for label in labels:
        headers.append((label, 22))
    headers.append(("drift", 6))

    hdr_line = "  ".join(h.rjust(w) for h, w in headers)
    print()
    print(hdr_line)
    print("-" * len(hdr_line))

    rank = 0
    for r in rows:
        rank += 1
        name_str = r["name"][:21]
        prov_mark = "*" if r["provisional"] else " "

        line_parts = [
            f"{rank}".rjust(4),
            name_str.ljust(22),
            f"{r['matches']}".rjust(4),
            f"{r['cmdr']}".rjust(4),
            f"{r['disk_vtsr']:.1f}".rjust(8) if r["disk_vtsr"] else "-".rjust(8),
            f"{r['canon_vtsr']:.1f}".rjust(8) if r["canon_vtsr"] else "-".rjust(8),
        ]
        for label in labels:
            v = r[f"new_{label}"]
            d = (v - r["canon_vtsr"]) if (v and r["canon_vtsr"]) else 0.0
            line_parts.append(
                f"{v:.1f} ({d:+.1f}{prov_mark})".rjust(22) if v else "-".rjust(22)
            )
        line_parts.append(f"{r['drift']:.2f}".rjust(6))
        print("  ".join(line_parts))

    # ---- New leaderboard ordering side-by-side ----
    print("\n\nLEADERBOARD ORDER COMPARISON (top 20)")
    print("=" * 80)

    def top_n_by(key_extractor, n=20, label=""):
        sorted_rows = sorted(rows, key=key_extractor, reverse=True)
        return [r["name"] for r in sorted_rows[:n]]

    on_disk_order = top_n_by(lambda r: r["disk_vtsr"], 20, "on_disk")
    canon_order   = top_n_by(lambda r: r["canon_vtsr"], 20, "canon")
    scenario_orders = {
        label: top_n_by(lambda r, l=label: r[f"new_{l}"], 20, label)
        for label in labels
    }

    # Print side-by-side
    cols = [("on_disk", on_disk_order)] + [(l, scenario_orders[l]) for l in labels]
    col_w = 24
    print(("  ".join(h.ljust(col_w) for h, _ in cols)))
    print("-" * (len(cols) * (col_w + 2)))
    for i in range(20):
        row = []
        for _, order in cols:
            row.append((order[i] if i < len(order) else "").ljust(col_w))
        print(f"{i+1:>2}. " + "  ".join(row))

    print()
    print(f"Notes:")
    print(f"  * provisional (< 10 matches)")
    print(f"  drift = |canon_resim - on_disk|. >1.0 means elo.py has changed since")
    print(f"          elo_current.json was last regenerated. Trust delta-from-canon")
    print(f"          (the parenthesized number in each scenario column).")


if __name__ == "__main__":
    main()
