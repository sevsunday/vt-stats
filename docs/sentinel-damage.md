# Sentinel Damage Filter

Reference for the `amount > 1e6` sentinel damage filter applied in
`scripts/process_stats.py` and mirrored in `js/raw-browser.js` Reconcile.
The canonical observed value is `268,435,456` (= `2^28` =
`0x4d800000` as IEEE-754 float bits), emitted by the BZCC engine's
internal force-kill pathway. These events are not real combat damage
and are dropped before aggregation.

## TL;DR

Any `DamageDealt` / `DamageReceived` event with `amount > 1e6` is skipped
at ingest. Skipping happens in pairs (DD + paired DR together) so both
sides of the engine's event-pair convention are consumed.

Counters + diagnostics flow through:

- `match.sentinel_damage = { count, total_amount, first_tick, last_tick }`
- `meta.total_sentinel_damage_dropped` (aggregate pair count)
- `meta.matches_with_sentinel_damage` (list of affected match IDs)
- Per-match pipeline log lines, deduped by `(tick, team, amount)`
- Raw Browser Reconcile view: inline badge + reconcile summers mirror the filter

Threshold `1e6` matches the upstream collector's `record_damage()`
`unusual_damage.txt` diagnostic threshold. Real BZCC combat per-event
amounts top out in the low tens of thousands, so the guard is ~100x
above any legitimate event.

## Evidence chain

### 1. The raw events have a perfectly clean signature

Across 13 matches / 1,960,518 events at time of investigation, exactly 10
events (5 paired `DamageDealt` + `DamageReceived`) carried
`amount == 268435456`. All 10 share the identical wire profile:

```
damageDealt    | no_shooter | no_victim | no_ordnance | team=9    -> 5
damageReceived | no_shooter | no_victim | no_ordnance | team=9    -> 5
```

Wire format (verbatim, protobufjs `defaults: false` so absent fields are
genuinely absent on the wire):

```json
{ "damageDealt":   { "tick": 70099, "team": 9, "amount": 268435456 } }
{ "damageReceived":{ "tick": 70099, "team": 9, "amount": 268435456 } }
```

No `shooter`. No `victim`. No `ordnanceOdf`. These are not a projectile
hit and not an ODF-driven explosion.

### 2. Only one match in the corpus was affected

12 of 13 matches had zero sentinel events. Only `2026-04-22T01-58-26`
(Vegan) contained the 5-pair cluster. This rules out "normal death
cascade" — if the sentinel fired on every unit death it would be seen
hundreds of times per match.

### 3. The events cluster into two short bursts tied to a single player's deaths

All 5 sentinels occurred within a 63-tick window (~3.15 s @ 20 Hz):

| Tick | Context |
|---|---|
| 70099 | During enemy Arc Blast hit on Danya + Danya's vehicle death-explosion (`xcarxpl_e.odf`) |
| 70100 | Same tick as `UnitDestroyed{ victim=Danya, victimOdf=evscoutm_vsr.odf, killerTeam=6, killerOdf=fbspir_vsr.odf }` |
| 70105 | 5 ticks later, no other event at this tick |
| 70160 | 15 ticks after `UnitDestroyed{ victim=Danya, victimOdf=esuser_m.odf (pilot), killerTeam=7 }` at tick 70145 |
| 70162 | 2 ticks after 70160 |

The cluster brackets Danya's vehicle death and her subsequent pilot
death. Between 70099 and 70162 there are no other `UnitDestroyed`
events, and nearby deaths for other players do not trigger sentinels —
so "a death happened" is necessary but not sufficient.

### 4. `team=9` is the owning slot of the force-killed object

All 10 sentinels have `team=9`. The decompile (below) reads the target
handle from `piVar1[0xb8]` of the object being force-killed, supporting
"owner of the object being force-killed" over any alternate "fallback
to local player's slot". Either way, downstream the effect is the same:
one slot's `assets.dealt` / `assets.received` column is inflated by
`N × 2^28`.

### 5. Dev decompile + struct layout confirm an engine-level magic constant

The struct layout and the decompiled call site line up exactly.

**DAMAGE struct** (engine source, annotated with what the decompiled
path writes at each offset):

| Offset | Type | Field | Written by the decompiled path |
|---|---|---|---|
| 0  | int   | `owner` | target handle (`piVar1[0xb8]`) |
| 4  | int   | `source` | copy of target handle |
| 8  | float | `base` | 0 |
| 12 | float | `armor` | 0 |
| 16 | float | `shield` | 0 |
| 20 | float | `value` | **`0x4d800000` = 2^28** |
| 24 | byte + 2 bools (bitpacked) | `type` + `friendly_fire` + `self_damage` | type = `DAMAGE_TYPE_UNKNOWN` (0); both flags cleared |

**`DAMAGE_TYPE` enum** (engine source):

```cpp
enum DAMAGE_TYPE : byte {
    DAMAGE_TYPE_UNKNOWN,    // 0  <-- what our sentinel events carry
    DAMAGE_TYPE_ORDNANCE,   // 1
    DAMAGE_TYPE_EXPLOSION,  // 2
    DAMAGE_TYPE_COLLISION,  // 3
    DAMAGE_TYPE_WATER,      // 4
    DAMAGE_TYPE_UNDERWATER, // 5
    DAMAGE_TYPE_SCRIPT,     // 6
    DAMAGE_TYPE_LAST
};
```

The engine explicitly categorises the force-kill path as
`DAMAGE_TYPE_UNKNOWN` — **not** the same code path as script-invoked
`SelfDamage` (which uses `DAMAGE_TYPE_ORDNANCE` + the `self_damage`
flag). This matches the wire-format observation: no ordnance_odf on
sentinel events.

**Decompiled call site**:

```c
piVar1[0xba] |= 0x600;       // flag bits on target object
piVar1[0x3f] |= 5;
piVar1[0x20] = 0; piVar1[0x22] = 0;
piVar1[0x30] = 0; piVar1[0x32] = 0;
piVar1[0xd4] = 0; piVar1[0xd6] = 0;
FUN_006cec40();

local_20 = 0; local_1c = 0; local_18 = 0;
local_28 = piVar1[0xb8];     // target handle
local_f  = 0;
local_14 = 0x4d800000;       // <-- 2^28 as IEEE-754 float bits
local_10 = 1;
local_24 = local_28;

// Call mission DLL's damage callback at misnexport2 + 0x1c
if ((DAT_008a30e0 != 0) && (*(code **)(DAT_008a30e0 + 0x1c) != 0)) {
    (**(code **)(DAT_008a30e0 + 0x1c))(DAT_0087c750, local_28, 0, &local_28);
}

local_10 = 1;
(**(code **)(*piVar1 + 0xb0))(&local_28);  // vtable method on target (Kill?)
```

Bit-pattern check: IEEE-754 `0x4d800000` has sign 0, exponent `0x9B - 127 = 28`,
mantissa 0 → `1.0 × 2^28 = 268,435,456.0f` exactly. Confirmed.

The compiler emits a single dword-wide MOV to zero the three 1-byte
flag slots at offset 24 (hence `local_10 = 1` looking like a whole-dword
write). The engine is explicitly constructing a `DAMAGE_TYPE_UNKNOWN`
event with `value = 2^28`, pushing it through the mission DLL's damage
callback at `misnexport2 + 0x1c`, then calling the target's vtable
method at `+0xb0` (almost certainly its `Kill`/`Destroy` handler).
Statsgate hooks that very callback, so the sentinel arrives verbatim in
the binpb wire stream.

### 5b. Player observation lines up

Danya (slot 3, the victim of the deaths bracketing the sentinels):
"interesting how these freak events revolve around me dying lol" /
"this only happened in that one game lol ... even the code gets hazey
in the late game". Consistent with the tick-cluster analysis (§3) —
the 5 sentinels bracket successive vehicle+pilot deaths in a specific
late-game state.

### 6. Pipeline inflation, explained

`scripts/process_stats.py` previously summed `dd.amount` into
`asset_dealt[dd.team]` whenever `shooter == 0`, and `dr.amount` into
`asset_received[dr.team]` whenever `victim == 0`. With 5 DD + 5 DR at
`2^28` each and `team == 9`:

- `asset_dealt[9]  += 5 × 268,435,456 = 1,342,177,280`
- `asset_received[9] += 5 × 268,435,456 = 1,342,177,280`

Which matches the ~63k delta seen on the Vegan match's processed JSON
(`asset_dealt = 1,342,614,569`, `asset_received = 1,342,783,249`): the
residual ~437k and ~606k is ordinary asset damage that survives the
filter. The spike in `timeline.by_faction["2"]` at bucket 350 (~58:20)
similarly accumulates `5 × 2^28 = 1,342,177,280`, matching the observed
`1,342,184,712.2` (the residual 7,432 is one bucket's worth of real
combat).

## Implementation

### Python pipeline

[scripts/process_stats.py](../scripts/process_stats.py):

```python
SENTINEL_DAMAGE_THRESHOLD = 1e6

def _is_sentinel_damage(amount):
    return amount is not None and amount > SENTINEL_DAMAGE_THRESHOLD
```

At the top of the `damage_dealt` event branch (before the existing
`skip_shooter` check), peek at the paired DR. If either side is
sentinel, advance past both events, update
`match.sentinel_damage.{count,total_amount,first_tick,last_tick}`, log
a deduped line, and `continue`. The timeline-recompute loop applies the
same check.

### Raw Browser Reconcile

[js/raw-browser.js](../js/raw-browser.js) mirrors with
`isSentinelDamage(amount)` applied in `computePersonalDealt`,
`computePersonalReceived`, `computePersonalPvpDealt`. The Reconcile
view shows an inline badge with the literal dropped total when any
sentinel events are present in the current match. The raw events table
(virtualized) still displays the sentinel values verbatim — the raw
tier's job is to show what's on the wire.

## Upstream (VTrider's collector)

VTrider indicated he intends to filter `DAMAGE_TYPE_UNKNOWN` events in
the collector itself. That would make our pipeline-side filter a no-op
guardrail on new sessions while keeping it relevant for the
already-archived sentinel-bearing `.binpb.gz` files on disk.

## Future schema enhancement (proposed upstream)

Propagating `DAMAGE_TYPE` on the wire would let us filter
`DAMAGE_TYPE_UNKNOWN` defensively without needing an amount-based
heuristic, and would enable future breakdowns by damage source type
(script vs ordnance vs collision vs water etc.). Rough shape:

```proto
enum DamageType {
  DAMAGE_TYPE_UNKNOWN    = 0;
  DAMAGE_TYPE_ORDNANCE   = 1;
  DAMAGE_TYPE_EXPLOSION  = 2;
  DAMAGE_TYPE_COLLISION  = 3;
  DAMAGE_TYPE_WATER      = 4;
  DAMAGE_TYPE_UNDERWATER = 5;
  DAMAGE_TYPE_SCRIPT     = 6;
}

message DamageDealt {
  uint32 tick = 1;
  uint64 shooter = 2;
  int32  team = 3;
  string ordnance_odf = 4;
  float  amount = 5;
  DamageType damage_type = 6;  // new, default 0
}
```

Backwards-compatible (default 0 = `UNKNOWN`). Not needed for the current
filter; recorded here so it can be picked up the next time the upstream
proto is touched.

## Re-running the audit

The promoted `scripts/audit_sentinel_events.mjs` scans all
`data/sessions/**/*.binpb.gz` and prints + writes a histogram to
`_investigation/output/sentinel_histogram.{json,txt}`. Requires
`npm install --no-save protobufjs@7` once; the `_investigation/` folder
is gitignored so repeated runs don't pollute the tree.

```bash
node scripts/audit_sentinel_events.mjs
```

Primary metric: `total_sentinel_pairs`. Must match
`all_matches.json -> meta.total_sentinel_damage_dropped` after each
pipeline rerun.

`scripts/dump_events_window.mjs` dumps arbitrary tick windows for any
match — useful for investigating future anomalies beyond just sentinels.
