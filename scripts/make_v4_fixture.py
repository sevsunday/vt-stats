"""Synthetic proto-v4 fixture generator (Stage A of the commander-stats plan).

!! DANGER -- FIXTURES ENTER THE RATED CORPUS !!
Because the fixtures are CLONES of a real v3 session, they inherit that
session's real roster (8 real Steam64s, 2 real commanders) and a
determined outcome. The pipeline cannot tell them apart from a genuine
match: they are rated by scripts/elo.py, duelled by elo_commander.py,
folded into career_stats / map_stats / validation_summary, and published
in matches.json. Leaving them on disk SILENTLY CORRUPTS every player's
VTSR-T, the commander ladder, and every validator corpus snapshot.
(This happened once -- 2026-09-04 -- and forced a full re-run of the
Stage E ALPHA sweep and the Phase 3 ranks re-evaluation.)

Treat generated fixtures as radioactive: verify, then purge IMMEDIATELY
via the RUN PROTOCOL checklist below, in the same working session. Never
commit them, never leave them for "later".

Clones a real v3 session and injects DETERMINISTIC v4 payloads:

  * a per-team ResourceState on every UpdateTick (scripted scrap ledger:
    +1 regen on every %20==0 tick capped at max_scrap, +5 loose for
    team 2 on %2400==0 ticks, -cost deductions at build QUEUE ticks,
    +50% refunds on FACTORY/CONSTRUCTOR-lane cancels, +0% on armory
    cancels, bank clamped to the authoritative max_scrap formula
    `(recycler? 40 : 0) + 20 * pools`), and
  * a scripted BuildEvent sequence for both teams covering every lane
    (recycler / factory / armory / constructor), QUEUE->BUILD pairs,
    QUEUE->CANCEL pairs, a match-end pending order, the armory
    `.odf`-suffix inconsistency observed on the real wire, and (in the
    inferred-mode file) a same-tick duplicate CONSTRUCTOR QUEUE to
    exercise the pipeline's defensive dedup.

Two fixture files are written so BOTH structure-completion modes are
testable (the mode flag is per-match):

  * `2099-01-01-00-00-01.binpb.gz` -- "events" mode: constructors emit
    real CONSTRUCTOR BUILD completions (EXU2 >= 1.6.3 era).
  * `2099-01-01-00-00-02.binpb.gz` -- "inferred" mode: constructors emit
    QUEUE (and one CANCEL) only (pre-1.6.3 era); completions must be
    inferred as queued - cancelled.

Alongside, the generator writes `_investigation/output/fixture_v4_expected.json`
with the expected economy/builds aggregates computed from the FINAL
WRITTEN event stream (not from the intent script), classifying income
sample-deltas with the exact contract Stage B implements:

  1. refund-first: a positive delta following a CANCEL within
     REFUND_WINDOW_TICKS whose expected refund r >= REFUND_MIN_MATCH books
     r to income_refund (refund precedence beats the loose rule -- refunds
     are frequently multiples of 5). The floor exists because a sub-piece
     refund expectation cannot be told apart from a regen tick and was
     measured fabricating refunds on the real corpus;
  2. cap-clamp: if the delta landed the bank AT max_scrap and the
     remainder is neither 1 nor a 5-multiple, the delivery was truncated
     to the free room -- book all of it to income_loose (one extra
     pickup) and carry `5 - rem % 5` as withheld overflow;
  3. otherwise, remaining 5k books to income_loose (k deliveries);
  4. a sub-cap 2/3/4 remainder draws down any withheld overflow into
     income_loose (no extra pickup -- it is the tail of one already
     counted);
  5. remaining +1 books to income_regen;
  6. anything left is income_unclassified.

Outflow ledger contract (mirrored by Stage B):
  outflow_gross (= sum of negative sample-deltas)
    = outflow_built_cost          (unit QUEUE deductions that later BUILD)
    + outflow_cancelled_cost      (unit QUEUE deductions later CANCELLED)
    + outflow_pending_at_end_cost (unit QUEUE deductions never resolved)
    + outflow_structure_orders    (ALL constructor-lane QUEUE deductions,
                                   including later-cancelled ones -- their
                                   refunds appear income-side)
    + scrap_outflow_unaccounted   (residual; here: max_scrap clamp on the
                                   scripted pool loss)

RUN PROTOCOL (review-mandated):
  * Any pipeline run over the fixtures MUST use `--no-sync --no-prompt`
    (the fixtures stamp v4 -> adjudication-eligible; an answered prompt
    would pollute the committed data/match_outcome_adjudications.json).
  * Cleanup checklist (printed at the end of every run):
      1. delete data/sessions/_FixtureV4/ (whole folder)
      2. delete data/processed/<fixture-id>.json for both fixture ids
      3. grep data/match_outcome_adjudications.json for '2099-' (must be
         absent)
      4. rerun `python scripts/process_stats.py --no-sync --no-prompt`
         so matches.json / contributions / ELO forget the fixtures
      5. rerun `python scripts/validate_elo.py` so the committed
         validation_summary.json is re-derived off the clean corpus
         (and any alt-mode sweep scored while the fixtures were on disk
         is invalid -- re-run and re-adjudicate its decision memo)
      6. `git status` must be clean of fixture artifacts

Usage:
    python scripts/make_v4_fixture.py [--base PATH] [--out-dir PATH]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

import statsgate_pb2  # noqa: E402

DEFAULT_BASE = PROJECT_ROOT / "data/sessions/VTrider/2026-08-23-01-49-40.binpb.gz"
OUT_DIR = PROJECT_ROOT / "data/sessions/_FixtureV4"
EXPECTED_OUT = PROJECT_ROOT / "_investigation/output/fixture_v4_expected.json"

FILE_EVENTS = "2099-01-01-00-00-01.binpb.gz"    # constructor BUILDs present
FILE_INFERRED = "2099-01-01-00-00-02.binpb.gz"  # constructor QUEUE-only era

# Unit costs mirror data/odf.min.json GameObjectClass.scrapCost exactly --
# Stage B resolves costs from the live DB, so a drift here would fail the
# fixture gate (that is the point: the fixture pins the DB contract too).
COSTS = {
    "ivscout_vsr": 40,
    "ivtank_vsr": 55,
    "ivscav_vsr": 20,
    "apeburst": 10,
    "ibgtow_vsr": 50,
    "ibpgen_vsr": 30,
    "ibsbay_vsr": 50,
}

# Combat-ship classification for the fixture's expected `ships_built`
# (B7/B12 contract: scouts/tanks in; scavs, service pods, armory items,
# structures out).
COMBAT_SHIPS = {"ivscout_vsr", "ivtank_vsr"}

REGEN_PERIOD_TICKS = 20      # +1 scrap on every %20==0 update tick
LOOSE_PERIOD_TICKS = 2400    # team 2 +5 loose cadence
REFUND_WINDOW_TICKS = 40     # classifier window (Stage B contract)
LOOSE_SIZE = 5               # mirrors ECON_LOOSE_SIZE
REFUND_MIN_MATCH = LOOSE_SIZE  # mirrors ECON_REFUND_MIN_MATCH
START_BANK = 40

QUEUE = statsgate_pb2.BUILD_EVENT_TYPE_QUEUE
CANCEL = statsgate_pb2.BUILD_EVENT_TYPE_CANCEL
BUILD = statsgate_pb2.BUILD_EVENT_TYPE_BUILD
FACTORY = statsgate_pb2.PRODUCER_TYPE_FACTORY
CONSTRUCTOR = statsgate_pb2.PRODUCER_TYPE_CONSTRUCTOR
ARMORY = statsgate_pb2.PRODUCER_TYPE_ARMORY

GREEN = statsgate_pb2.SCRAP_STATUS_GREEN
YELLOW = statsgate_pb2.SCRAP_STATUS_YELLOW
RED = statsgate_pb2.SCRAP_STATUS_RED


def team1_pools(t: int, L: int) -> tuple[int, int]:
    """(pool_count, upgrade_count) for team 1 at tick t."""
    if t < 0.10 * L:
        pools = 0
    elif t < 0.40 * L:
        pools = 3
    elif t < 0.85 * L:
        pools = 5
    else:
        pools = 4  # scripted pool loss (pools_lost = 1)
    upgrades = 1 if t >= 0.70 * L else 0
    return pools, min(upgrades, pools)


def team2_pools(t: int, L: int) -> tuple[int, int]:
    pools = 2 if t >= 0.15 * L else 0
    return pools, 0


def max_scrap(pools: int) -> int:
    # Recycler alive for the whole fixture on both teams.
    return 40 + 20 * pools


def scrap_status(bank: int, pools: int, upgrades: int) -> int:
    """Authoritative segment model: [RED 20*upg][YELLOW 20*(pools-upg)][GREEN 40]."""
    if bank < 20 * upgrades:
        return RED
    if bank < 20 * pools:
        return YELLOW
    return GREEN


def refund_for(producer: int, cost: int) -> int:
    """Fixture refund policy (mirrors measured mechanics): FACTORY-lane and
    CONSTRUCTOR-lane cancels refund 50%; armory cancels refund nothing."""
    if producer == ARMORY:
        return 0
    return cost // 2


def build_script(L: int, constructor_builds: bool) -> list[dict]:
    """The deterministic build-event script. Offsets 7/13 keep every
    build tick off the %20==0 regen cadence so each deduction/refund lands
    on a clean sample delta."""
    ev = []

    def add(tick, teamnum, etype, producer, odf, *, dedup_dupe=False, cost_odf=None):
        ev.append({
            "tick": int(tick), "teamnum": teamnum, "type": etype,
            "producer": producer, "odf": odf,
            # cost bookkeeping key (normalized -- the wire odf may carry
            # a spurious '.odf' suffix, see armory entries below)
            "cost_key": cost_odf or odf,
            "dedup_dupe": dedup_dupe,
        })

    # --- Team 1 (teamnum 1) ---
    # 6 recycler-lane scouts, QUEUE -> BUILD (+400 ticks = 20 s).
    # 1500-tick spacing keeps the ledger affordable against 1/s regen with
    # the structure orders interleaved (the affordability assert enforces).
    for i in range(6):
        q = 0.12 * L + i * 1500 + 7
        add(q, 1, QUEUE, FACTORY, "ivscout_vsr")
        add(q + 400, 1, BUILD, FACTORY, "ivscout_vsr")
    # 4 factory-lane tanks
    for i in range(4):
        q = 0.45 * L + i * 900 + 7
        add(q, 1, QUEUE, FACTORY, "ivtank_vsr")
        add(q + 400, 1, BUILD, FACTORY, "ivtank_vsr")
    # 2 scav QUEUE -> CANCEL (50% refund = +10 each)
    for i in range(2):
        q = 0.30 * L + i * 600 + 7
        add(q, 1, QUEUE, FACTORY, "ivscav_vsr")
        add(q + 200, 1, CANCEL, FACTORY, "ivscav_vsr")
    # 2 armory items with the REAL-WIRE suffix inconsistency:
    # QUEUE arrives as 'apeburst.odf', BUILD as 'apeburst'.
    for i in range(2):
        q = 0.50 * L + i * 700 + 7
        add(q, 1, QUEUE, ARMORY, "apeburst.odf", cost_odf="apeburst")
        add(q + 300, 1, BUILD, ARMORY, "apeburst")
    # 1 armory QUEUE -> CANCEL (0% refund)
    q = 0.55 * L + 7
    add(q, 1, QUEUE, ARMORY, "apeburst.odf", cost_odf="apeburst")
    add(q + 200, 1, CANCEL, ARMORY, "apeburst.odf", cost_odf="apeburst")
    # Late-game spend burst: two tanks + a scav in quick succession drive
    # the bank below the upgraded-pool red line (20 * upgrade_count) so the
    # fixture carries genuine RED status samples + red-zone queue decisions.
    q = 0.72 * L + 7
    add(q, 1, QUEUE, FACTORY, "ivtank_vsr")
    add(q + 400, 1, BUILD, FACTORY, "ivtank_vsr")
    add(q + 20, 1, QUEUE, FACTORY, "ivtank_vsr")
    add(q + 420, 1, BUILD, FACTORY, "ivtank_vsr")
    add(q + 40, 1, QUEUE, FACTORY, "ivscav_vsr")
    add(q + 440, 1, BUILD, FACTORY, "ivscav_vsr")
    # Structures (constructor lane): 4 QUEUEs, 1 CANCEL (the ibsbay).
    t1_structs = [
        (0.20 * L + 7, "ibgtow_vsr"),
        (0.25 * L + 7, "ibpgen_vsr"),
        (0.35 * L + 7, "ibsbay_vsr"),
        (0.60 * L + 7, "ibgtow_vsr"),
    ]
    for q, odf in t1_structs:
        add(q, 1, QUEUE, CONSTRUCTOR, odf)
    add(0.35 * L + 207, 1, CANCEL, CONSTRUCTOR, "ibsbay_vsr")
    if constructor_builds:
        # events mode: real completions for the 3 non-cancelled structures
        for q, odf in t1_structs:
            if odf != "ibsbay_vsr":
                add(q + 600, 1, BUILD, CONSTRUCTOR, odf)
    # Match-end pending order (deducted at queue, never built).
    add(L - 300, 1, QUEUE, FACTORY, "ivscout_vsr")

    # --- Team 2 (teamnum 6) ---
    # Enough spending to keep headroom under the 2-pool cap (80) so the
    # scripted +5 loose actually lands instead of clamping away --
    # team 2 is the fixture's loose-collection-economy story.
    for i in range(8):
        q = 0.20 * L + i * 1000 + 13
        add(q, 6, QUEUE, FACTORY, "ivscout_vsr")
        add(q + 400, 6, BUILD, FACTORY, "ivscout_vsr")
    for i in range(3):
        q = 0.50 * L + i * 900 + 13
        add(q, 6, QUEUE, FACTORY, "ivtank_vsr")
        add(q + 400, 6, BUILD, FACTORY, "ivtank_vsr")
    q = 0.25 * L + 13
    add(q, 6, QUEUE, FACTORY, "ivscav_vsr")
    add(q + 400, 6, BUILD, FACTORY, "ivscav_vsr")
    # 1 structure. Inferred mode additionally injects a same-tick duplicate
    # QUEUE (identical tuple) -- the recording artifact the defensive dedup
    # must fold to ONE order (bank deducted once; the dupe is wire noise).
    q = 0.30 * L + 13
    add(q, 6, QUEUE, CONSTRUCTOR, "ibpgen_vsr")
    if constructor_builds:
        add(q + 600, 6, BUILD, CONSTRUCTOR, "ibpgen_vsr")
    else:
        add(q, 6, QUEUE, CONSTRUCTOR, "ibpgen_vsr", dedup_dupe=True)

    ev.sort(key=lambda e: e["tick"])
    return ev


def make_fixture(base_session, L: int, constructor_builds: bool, start_epoch: int):
    """Return (new_session, expected_dict) for one mode.

    `start_epoch` overrides header.start_time so the fixture's match id
    is the 2099-era filename stem -- WITHOUT the override the cloned
    header keeps the base session's timestamp and the fixture SILENTLY
    COLLIDES with the real match's id (observed: three manifest entries
    sharing one per-match JSON, the real match's output overwritten).
    """
    script = build_script(L, constructor_builds)

    out = statsgate_pb2.ClientStatSession()
    out.header.CopyFrom(base_session.header)
    out.header.start_time.seconds = start_epoch
    out.header.start_time.nanos = 0

    bank = {1: START_BANK, 2: START_BANK}
    # Ledger bookkeeping keyed by script knowledge (for the outflow split).
    ledger = {
        1: {"built": 0, "cancelled": 0, "pending": 0, "structures": 0},
        2: {"built": 0, "cancelled": 0, "pending": 0, "structures": 0},
    }
    # FIFO of open unit orders per (side, normalized odf) for built/cancel/
    # pending attribution.
    open_units: dict[tuple[int, str], list[int]] = {}

    def side_of(teamnum: int) -> int:
        return 1 if 1 <= teamnum <= 5 else 2

    def norm(odf: str) -> str:
        return odf[:-4] if odf.lower().endswith(".odf") else odf

    def apply_build_event(e):
        side = side_of(e["teamnum"])
        cost = COSTS[norm(e["cost_key"])]
        key = (side, norm(e["cost_key"]))
        if e["type"] == QUEUE:
            if e["dedup_dupe"]:
                return  # wire artifact: engine deducted once already
            # Affordability invariant: the engine never queues an item the
            # bank cannot cover, and an underflow clamp here would silently
            # desync the outflow ledger from the sample deltas.
            assert bank[side] >= cost, (
                f"fixture script queues {e['odf']} (cost {cost}) at tick "
                f"{e['tick']} with only {bank[side]} scrap on side {side} -- "
                f"adjust the script schedule")
            bank[side] -= cost
            if e["producer"] == CONSTRUCTOR:
                ledger[side]["structures"] += cost
            else:
                open_units.setdefault(key, []).append(cost)
        elif e["type"] == CANCEL:
            if e["producer"] != CONSTRUCTOR:
                lst = open_units.get(key)
                if lst:
                    lst.pop(0)
                ledger[side]["cancelled"] += cost
            bank[side] += refund_for(e["producer"], cost)
        elif e["type"] == BUILD:
            if e["producer"] != CONSTRUCTOR:
                lst = open_units.get(key)
                if lst:
                    lst.pop(0)
                ledger[side]["built"] += cost
            # no bank movement at BUILD (deduction happened at QUEUE)

    def emit_build_event(e):
        se = out.event_stream.add()
        be = se.build_event
        be.tick = e["tick"]
        be.type = e["type"]
        be.producer = e["producer"]
        be.teamnum = e["teamnum"]
        be.build_odf = e["odf"]

    def evt_tick(evt) -> int:
        arm = evt.WhichOneof("event_type")
        return getattr(evt, arm).tick if arm else 0

    si = 0  # script cursor
    for evt in base_session.event_stream:
        t = evt_tick(evt)
        while si < len(script) and script[si]["tick"] <= t:
            apply_build_event(script[si])
            emit_build_event(script[si])
            si += 1
        new_evt = out.event_stream.add()
        new_evt.CopyFrom(evt)
        if new_evt.WhichOneof("event_type") == "update_tick":
            ut = new_evt.update_tick
            tick = ut.tick
            for side, field in ((1, ut.team1_resources), (2, ut.team2_resources)):
                pools, upg = (team1_pools if side == 1 else team2_pools)(tick, L)
                cap = max_scrap(pools)
                if tick % REGEN_PERIOD_TICKS == 0:
                    bank[side] = min(cap, bank[side] + 1)
                if side == 2 and tick % LOOSE_PERIOD_TICKS == 0 and tick >= 0.15 * L:
                    bank[side] = min(cap, bank[side] + 5)
                bank[side] = min(bank[side], cap)  # pool-loss clamp
                field.current_scrap = bank[side]
                field.max_scrap = cap
                field.scrap_status = scrap_status(bank[side], pools, upg)
                field.pool_count = pools
                field.upgrade_count = upg
    while si < len(script):
        apply_build_event(script[si])
        emit_build_event(script[si])
        si += 1

    # Pending-at-end = FIFO remainders.
    for (side, _odf), lst in open_units.items():
        ledger[side]["pending"] += sum(lst)

    expected = compute_expected(out, L, constructor_builds, ledger)
    return out, expected


def compute_expected(session, L: int, constructor_builds: bool, ledger) -> dict:
    """Second-pass audit over the FINAL WRITTEN stream: classifies income
    deltas + tallies build counts with the Stage B contract, guaranteeing
    the expected file describes the bytes on disk, not the intent."""
    tick_rate = session.header.tick_rate or 20
    per_team = {}
    # Collect cancel events (for the refund classifier) + build tallies.
    cancels = {1: [], 2: []}   # (tick, expected_refund)
    builds = {
        1: {"queued": 0, "cancelled": 0, "built": 0, "structures_queued": 0,
            "structures_cancelled": 0, "structures_built_events": 0,
            "ships_built": 0, "combat_ship_value": 0, "scrap_spent_units": 0,
            "feed_len": 0, "dedup_folded": 0},
        2: {"queued": 0, "cancelled": 0, "built": 0, "structures_queued": 0,
            "structures_cancelled": 0, "structures_built_events": 0,
            "ships_built": 0, "combat_ship_value": 0, "scrap_spent_units": 0,
            "feed_len": 0, "dedup_folded": 0},
    }

    def norm(odf):
        return odf[:-4] if odf.lower().endswith(".odf") else odf

    seen_queue_tuples = set()
    for evt in session.event_stream:
        if evt.WhichOneof("event_type") != "build_event":
            continue
        be = evt.build_event
        side = 1 if 1 <= be.teamnum <= 5 else 2
        b = builds[side]
        b["feed_len"] += 1
        odf = norm(be.build_odf)
        cost = COSTS.get(odf, 0)
        if be.producer == CONSTRUCTOR:
            if be.type == QUEUE:
                tup = (be.tick, be.teamnum, odf)
                if tup in seen_queue_tuples:
                    b["dedup_folded"] += 1
                    continue
                seen_queue_tuples.add(tup)
                b["structures_queued"] += 1
            elif be.type == CANCEL:
                b["structures_cancelled"] += 1
                cancels[side].append((be.tick, refund_for(be.producer, cost)))
            elif be.type == BUILD:
                b["structures_built_events"] += 1
        else:
            if be.type == QUEUE:
                b["queued"] += 1
            elif be.type == CANCEL:
                b["cancelled"] += 1
                cancels[side].append((be.tick, refund_for(be.producer, cost)))
            elif be.type == BUILD:
                b["built"] += 1
                b["scrap_spent_units"] += cost
                if odf in COMBAT_SHIPS:
                    b["ships_built"] += 1
                    b["combat_ship_value"] += cost  # War Machine basis

    # Income/outflow classification over sample deltas.
    for side in (1, 2):
        prev = None
        inc = {"regen": 0, "loose": 0, "refund": 0, "unclassified": 0}
        loose_collections = 0
        pending_overflow = 0   # loose the storage cap withheld (cap-clamp rule)
        outflow_gross = 0
        income_total = 0
        peak = 0
        total_scrap = 0
        n = 0
        status_ticks = {GREEN: 0, YELLOW: 0, RED: 0}
        first_at = {3: None, 5: None}
        pools_prev = None
        pools_lost = 0
        peak_pools = 0
        final = None
        for evt in session.event_stream:
            if evt.WhichOneof("event_type") != "update_tick":
                continue
            ut = evt.update_tick
            rs = ut.team1_resources if side == 1 else ut.team2_resources
            tick = ut.tick
            bank_now = rs.current_scrap
            total_scrap += bank_now
            n += 1
            peak = max(peak, bank_now)
            status_ticks[rs.scrap_status] = status_ticks.get(rs.scrap_status, 0) + 1
            if pools_prev is not None and rs.pool_count < pools_prev:
                pools_lost += pools_prev - rs.pool_count
            pools_prev = rs.pool_count
            peak_pools = max(peak_pools, rs.pool_count)
            for k in (3, 5):
                if first_at[k] is None and rs.pool_count >= k:
                    first_at[k] = tick
            if prev is not None:
                d = bank_now - prev
                if d > 0:
                    income_total += d
                    rem = d
                    for (ct, r) in cancels[side]:
                        if (r >= REFUND_MIN_MATCH
                                and 0 <= tick - ct <= REFUND_WINDOW_TICKS
                                and rem >= r):
                            inc["refund"] += r
                            rem -= r
                            break
                    # Cap-clamp rule: a loose delivery landing with under
                    # LOOSE_SIZE of headroom is truncated to the free room,
                    # so book the part that fitted and carry the withheld
                    # part for the flush once there is room again.
                    if bank_now >= rs.max_scrap and rem > 1 and (rem % LOOSE_SIZE):
                        inc["loose"] += rem
                        loose_collections += rem // LOOSE_SIZE + 1
                        pending_overflow += (LOOSE_SIZE - rem % LOOSE_SIZE) % LOOSE_SIZE
                        rem = 0
                    else:
                        if rem >= LOOSE_SIZE:
                            k5 = (rem // LOOSE_SIZE) * LOOSE_SIZE
                            inc["loose"] += k5
                            loose_collections += rem // LOOSE_SIZE
                            rem -= k5
                        # Withheld-overflow flush (no piece-count bump --
                        # the pickup was counted on its first installment).
                        if rem > 1 and pending_overflow > 0:
                            take = min(rem, pending_overflow)
                            inc["loose"] += take
                            pending_overflow -= take
                            rem -= take
                        if rem == 1:
                            inc["regen"] += 1
                            rem = 0
                    inc["unclassified"] += rem
                elif d < 0:
                    outflow_gross += -d
            prev = bank_now
            final = bank_now
        led = ledger[side]
        unaccounted = outflow_gross - (led["built"] + led["cancelled"]
                                       + led["pending"] + led["structures"])
        b = builds[side]
        struct_built = (b["structures_built_events"] if constructor_builds
                        else b["structures_queued"] - b["structures_cancelled"])
        per_team[str(side)] = {
            "economy": {
                "scrap_income": income_total,
                "income_regen": inc["regen"],
                "income_loose": inc["loose"],
                "income_refund": inc["refund"],
                "income_unclassified": inc["unclassified"],
                "loose_collections": loose_collections,
                "scrap_outflow_gross": outflow_gross,
                "outflow_built_cost": led["built"],
                "outflow_cancelled_cost": led["cancelled"],
                "outflow_pending_at_end_cost": led["pending"],
                "outflow_structure_orders": led["structures"],
                "scrap_outflow_unaccounted": unaccounted,
                "final_scrap": final,
                "peak_scrap": peak,
                "mean_scrap": round(total_scrap / max(1, n), 3),
                "green_share": round(status_ticks[GREEN] / max(1, n), 4),
                "yellow_share": round(status_ticks[YELLOW] / max(1, n), 4),
                "red_share": round(status_ticks[RED] / max(1, n), 4),
                "peak_pools": peak_pools,
                "final_pools": pools_prev,
                "pools_lost": pools_lost,
                "upgrades_final": (team1_pools if side == 1 else team2_pools)(L, L)[1],
                "time_to_3_pools_sec": (first_at[3] / tick_rate) if first_at[3] else None,
                "time_to_5_pools_sec": (first_at[5] / tick_rate) if first_at[5] else None,
            },
            "builds": {
                "units_queued": b["queued"],
                "units_cancelled": b["cancelled"],
                "units_built": b["built"],
                "ships_built": b["ships_built"],
                "combat_ship_value": b["combat_ship_value"],
                "scrap_spent_units": b["scrap_spent_units"],
                "structures_queued": b["structures_queued"],
                "structures_cancelled": b["structures_cancelled"],
                "structures_built": struct_built,
                "structures_completion_source": ("events" if constructor_builds
                                                 else "inferred"),
                "feed_len": b["feed_len"],
                "dedup_folded_queues": b["dedup_folded"],
            },
        }
    return per_team


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", default=str(DEFAULT_BASE))
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    args = ap.parse_args()

    base_path = Path(args.base)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    EXPECTED_OUT.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading base session {base_path} ...")
    with gzip.open(base_path, "rb") as f:
        data = f.read()
    base = statsgate_pb2.ClientStatSession()
    base.ParseFromString(data)
    if len(base.header.players) == 0:
        raise SystemExit("Base session must be v3 (header.players required).")
    for evt in base.event_stream:
        if evt.WhichOneof("event_type") == "build_event":
            raise SystemExit("Base session already carries v4 payloads.")
    L = base.header.last_tick
    print(f"  last_tick={L} tick_rate={base.header.tick_rate} "
          f"events={len(base.event_stream)}")

    expected_all = {
        "schema_note": "expected aggregates for the Stage B fixture gate",
        "base_session": str(base_path),
        "costs": COSTS,
        "fixtures": {},
    }
    for fname, ctor_builds in ((FILE_EVENTS, True), (FILE_INFERRED, False)):
        print(f"Building {fname} (constructor_builds={ctor_builds}) ...")
        # Match id = filename stem: parse '2099-01-01-00-00-01' -> epoch.
        stem = fname.replace(".binpb.gz", "")
        parts = [int(p) for p in stem.split("-")]
        start_epoch = int(datetime(*parts, tzinfo=timezone.utc).timestamp())
        session, expected = make_fixture(base, L, ctor_builds, start_epoch)
        out_path = out_dir / fname
        with gzip.open(out_path, "wb", compresslevel=6) as f:
            f.write(session.SerializeToString())
        n_build = sum(1 for e in session.event_stream
                      if e.WhichOneof("event_type") == "build_event")
        print(f"  wrote {out_path} ({out_path.stat().st_size:,} bytes, "
              f"{n_build} build events)")
        expected_all["fixtures"][fname] = {
            "constructor_builds": ctor_builds,
            "build_events_total": n_build,
            "teams": expected,
        }

    EXPECTED_OUT.write_text(json.dumps(expected_all, indent=2), encoding="utf-8")
    print(f"Expected aggregates -> {EXPECTED_OUT}")

    print("""
CLEANUP CHECKLIST -- DO THIS IN THIS SESSION, NOT "LATER":
the fixtures are clones of a REAL session, so the pipeline rates them and
publishes them. Left on disk they corrupt every player's VTSR-T, the
commander ladder, and every validator corpus snapshot.
  1. Remove-Item -Recurse data/sessions/_FixtureV4
  2. Remove-Item data/processed/2099-01-01T00-00-0*.json   (note the 'T')
  3. Select-String '2099-' data/match_outcome_adjudications.json   (no hits)
  4. python scripts/process_stats.py --no-sync --no-prompt
  5. python scripts/validate_elo.py      (re-derive validation_summary.json;
     any alt-mode sweep scored while the fixtures were on disk is invalid)
  6. git status   (clean of fixture artifacts)
REMINDER: pipeline runs over the fixtures MUST use --no-sync --no-prompt.""")


if __name__ == "__main__":
    main()
