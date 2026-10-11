---
name: self-damage carve-out
overview: Carve self-inflicted damage / hits / kills out of the PvP/PvE attribution model by adding `shooter != victim` guards at every accumulator, emitting new `self_*` fields on the leaderboard, and updating the `pve_*` derivations to subtract them. Bumps PIPELINE_VERSION (15→16), match.schema_version (5→6), and ELO_SCHEMA_VERSION (5→6) with full corpus reprocess + re-rate.
todos:
  - id: pipeline-accumulators
    content: Add player_self_dealt / player_self_kills / player_self_shots_hit accumulators in scripts/process_stats.py
    status: completed
  - id: guard-damage-event
    content: Add shooter==victim branch to damage_dealt rivalry write (line 2723); route to player_self_dealt
    status: completed
  - id: guard-bullet-hit
    content: Tighten is_pvp_hit and player_hits_by_victim guards in bullet_hit handler; record self-hits
    status: completed
  - id: guard-unit-destroyed
    content: Tighten is_pvp_kill in unit_destroyed handler; record self-kills
    status: completed
  - id: leaderboard-derivation
    content: Update pve_d/pve_r/pve_kills/pve_deaths formulas to subtract self_*; emit new personal.self_* fields
    status: completed
  - id: weapon-breakdown-self-hits
    content: Add self_hits to weapon_breakdown entries
    status: completed
  - id: extract-contribution
    content: Forward self_dealt / self_received / self_kills / self_deaths / self_shots_hit + weapon self_hits in _extract_contribution
    status: completed
  - id: schema-bumps
    content: Bump PIPELINE_VERSION 15->16, match.schema_version 5->6, ELO_SCHEMA_VERSION 5->6
    status: completed
  - id: aggregator-totals
    content: Add total_self_* sums and pass-through fields in js/all-matches-aggregator.js
    status: completed
  - id: raw-browser-reconcile
    content: Fix computePersonalPvpDealt self guard + add self_dealt / self_kills reconcile rows in js/raw-browser.js
    status: completed
  - id: docs-updates
    content: Update DATA_DICTIONARY.md (Player Leaderboard table + personal field ref + invariant) and data-schema.mdc + AGENTS.md re-rate note
    status: completed
  - id: reprocess-and-rerate
    content: Run `python scripts/process_stats.py --force` to reprocess all matches and re-rate VTSR-T
    status: completed
isProject: false
---

# Self-Damage Carve-Out

## Why

Today, when a player damages themselves (e.g. Blink AOE explosion at the player's own ship — confirmed in audit: 64.5% of all blink damage is self-inflicted), the pipeline credits it as PvP because [`scripts/process_stats.py` line 2723](scripts/process_stats.py#L2723) builds `rivalry[de_shooter][victim] += de_amount` without a `shooter != victim` guard. The same omission exists in `BulletHit` ([line 2479](scripts/process_stats.py#L2479)) and `UnitDestroyed` ([line 2826](scripts/process_stats.py#L2826)), so self-hits inflate `pvp_shots_hit` / `pvp_accuracy` and the rare self-kill inflates `pvp_kills` / `pvp_deaths`.

Because PvE is derived as the remainder (`pve_dealt = max(0, dealt - pvp_dealt)`), simply removing the rivalry self-loop would silently reclassify self-damage from PvP to PvE. The carve-out approach (chosen) preserves `dealt` / `received` totals (so wire-level reconcile against `DamageDealt.amount` still passes) and emits new `self_*` fields so self-damage is **explicitly accounted for** rather than hidden in either bucket.

## Invariant After Fix

For every leaderboard row:

```
dealt    = pvp_dealt    + pve_dealt    + self_dealt        (within ±0.1)
received = pvp_received + pve_received + self_received     (within ±0.1)
kills    = pvp_kills    + pve_kills    + self_kills
deaths   = pvp_deaths   + pve_deaths   + self_deaths
shots_hit = pvp_shots_hit + pve_shots_hit + self_shots_hit (implicit; pve_shots_hit not emitted, dashboard derives if needed)
```

`self_dealt == self_received` always (same event from both sides). Same for `self_kills == self_deaths`. We emit both halves anyway for symmetry with the existing dealt/received pattern and to make the reconcile view's row layout uniform.

## Pipeline Changes — [`scripts/process_stats.py`](scripts/process_stats.py)

### 1. New per-player accumulators (around line 2247, near `rivalry`)

```python
player_self_dealt = defaultdict(float)        # per s64: self-inflicted damage
player_self_kills = Counter()                 # per s64: self-kills (rare)
player_self_shots_hit = defaultdict(lambda: defaultdict(int))  # per s64, per ODF
```

### 2. `damage_dealt` event handler — guard the rivalry write + capture self-damage

At [line 2723](scripts/process_stats.py#L2723), replace:

```python
if not skip_shooter and de_shooter > 0 and victim > 0:
    rivalry[de_shooter][victim] += de_amount
```

with:

```python
if not skip_shooter and de_shooter > 0 and victim > 0:
    if de_shooter == victim:
        player_self_dealt[de_shooter] += de_amount
    else:
        rivalry[de_shooter][victim] += de_amount
```

`personal.dealt` and `personal.received` continue to include self-damage (they sum the unguarded `de_amount`); only the PvP-attribution rivalry matrix gates self.

### 3. `bullet_hit` event handler — guard `is_pvp_hit`

At [line 2479](scripts/process_stats.py#L2479), tighten:

```python
is_pvp_hit = shooter > 0 and bh.victim > 0 and shooter != bh.victim
```

Also at [line 2511-2512](scripts/process_stats.py#L2511-L2512), guard `player_hits_by_victim` so `hit_targets` no longer emits a self-entry:

```python
if shooter > 0 and bh.victim > 0 and shooter != bh.victim:
    player_hits_by_victim[shooter][bh.victim] += 1
```

For self-hits we still increment `player_shots_hit[shooter][odf]` (a hit landed; the `accuracy` metric is unchanged) but we record the self-hit so the invariant holds:

```python
if shooter > 0 and bh.victim > 0 and shooter == bh.victim and odf:
    player_self_shots_hit[shooter][odf] += 1
```

### 4. `unit_destroyed` event handler — guard `is_pvp_kill`

At [line 2810](scripts/process_stats.py#L2810):

```python
is_pvp_kill = killer_is_player and victim_is_player and ud.killer != ud.victim
is_self_kill = killer_is_player and victim_is_player and ud.killer == ud.victim
if killer_is_player and is_self_kill:
    player_self_kills[ud.killer] += 1
```

`player_kills` and `player_deaths` still both increment for a self-kill (the player did die; the engine did report a kill event). The `kill_rivalry` write at [line 2826](scripts/process_stats.py#L2826) is now naturally guarded since `is_pvp_kill` excludes self-kills.

### 5. Leaderboard derivation (around line 3309-3331)

Update PvE-by-subtraction to also subtract self:

```python
self_d = player_self_dealt.get(s64, 0.0) if s64 else 0.0
self_k = player_self_kills.get(s64, 0) if s64 else 0
self_h = sum(player_self_shots_hit[s64].values()) if s64 else 0

pve_d = max(0.0, dealt - pvp_d - self_d)
pve_r = max(0.0, received - pvp_r - self_d)   # self_dealt == self_received
pve_kills  = max(0, kills  - pvp_kills  - self_k)
pve_deaths = max(0, deaths - pvp_deaths - self_k)
```

Emit new fields on `personal` (around [line 3484](scripts/process_stats.py#L3484)):

```python
"self_dealt":     round(self_d, 1),
"self_received":  round(self_d, 1),
"self_kills":     self_k,
"self_deaths":    self_k,
"self_shots_hit": self_h,
```

### 6. `weapon_breakdown` (around line 3354)

Add `self_hits` per weapon so the per-weapon view is also reconcilable:

```python
w_self_hits = player_self_shots_hit[s64].get(odf, 0) if s64 else 0
weapon_breakdown[wpn_name(odf)] = {
    ...,
    "pvp_hits":  w_pvp_hits,
    "self_hits": w_self_hits,
    ...
}
```

### 7. Faction totals (line 3552-3553)

Faction sums currently use `rivalry` — once rivalry no longer has self-loops, these are auto-corrected. No code change needed beyond the documentation comment.

### 8. `_extract_contribution` (around line 3990)

Forward the new fields onto contributions:

```python
"self_dealt":     round(personal.get("self_dealt", 0), 1),
"self_received":  round(personal.get("self_received", 0), 1),
"self_kills":     personal.get("self_kills", 0),
"self_deaths":    personal.get("self_deaths", 0),
"self_shots_hit": personal.get("self_shots_hit", 0),
```

And on `weapon_breakdown` entries: add `self_hits`.

### 9. Schema/version bumps

- `PIPELINE_VERSION = 15 → 16` ([line 56](scripts/process_stats.py#L56)) — invalidates the per-match cache, full reprocess on next run.
- `match.schema_version = 5 → 6` ([line 3809](scripts/process_stats.py#L3809)) — frontend contract: new `self_*` siblings on `personal`, new `self_hits` on `weapon_breakdown[]`. Pre-v6 matches gracefully degrade (UI treats absent `self_*` as 0; `dealt = pvp_dealt + pve_dealt` invariant still holds for legacy data because old data didn't have the carve-out).

## Client-side aggregator — [`js/all-matches-aggregator.js`](js/all-matches-aggregator.js)

Mirror the per-match shape into career totals (around [line 55](js/all-matches-aggregator.js#L55) and [line 447](js/all-matches-aggregator.js#L447)):

```js
total_self_dealt: 0, total_self_received: 0,
total_self_kills: 0, total_self_deaths: 0,
total_self_shots_hit: 0,
```

Sum `p.self_dealt`, `p.self_received`, etc. inside the existing per-player loop. Surface them on the emitted `careerStats[]` row (around [line 786](js/all-matches-aggregator.js#L786)). No new sort columns or UI panels required — these are reconcile/audit fields. The `pve_kills = Math.max(0, pcc.kills - pcc.pvp_kills)` derivations at [line 702](js/all-matches-aggregator.js#L702) inside `per_ship_combat` rebuild can stay as-is — `per_ship_combat` is per-ship and self-events at the ship level are already negligible. (Optional polish: also subtract self if we end up emitting per-ship `self_kills` later — out of scope for this fix.)

## ELO — [`scripts/elo.py`](scripts/elo.py)

No code changes needed. The axes that read `pvp_dealt` / `pve_dealt` / `pvp_kills` / `pve_kills` ([lines 84-87](scripts/elo.py#L84-L87)) automatically pick up the corrected values once the pipeline re-emits them. Bump:

- `ELO_SCHEMA_VERSION = 5 → 6`

Re-rate the entire corpus (same drill as the v2.4 commander adjustment). **`peak_vtsr` values pre-fix become non-comparable.** Document this in the AGENTS.md / project-overview.mdc commentary alongside the existing v2.4 note.

## Raw Data Browser Reconcile view — [`js/raw-browser.js`](js/raw-browser.js)

The Reconcile view at [line 2611](js/raw-browser.js#L2611) (`computePersonalPvpDealt`) currently reproduces the bug — it sums damageDealt rows where `r.shooter == s64` and victim exists, with no self check. Update its rule to add `r.shooter !== r.victim` so the audit confirms the fixed value, not the buggy one. Add three new reconcile rows next to the existing `personal.pvp_dealt` audit (mirroring the existing patterns):

- `personal.self_dealt` — Σ damageDealt.amount where shooter == s64 ∧ victim == s64
- `personal.self_kills` — count of unitDestroyed where killer == s64 ∧ victim == s64
- (Optional) `personal.pve_dealt` reconcile — `dealt − pvp_dealt − self_dealt`

This is what proves the new invariant for any user inspecting raw data.

## Documentation

- [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md) §433-450 (Player Leaderboard table) and §760-766 (`personal` field reference): rewrite the `pvp_dealt` / `pve_dealt` / `pvp_received` / `pve_received` definitions to remove the "Includes friendly-fire between humans" note's *implicit* self-inclusion (FF stays in PvP — only self moves out). Add new rows for `self_dealt` / `self_received` / `self_kills` / `self_deaths` / `self_shots_hit`. Document the new invariant `dealt = pvp_dealt + pve_dealt + self_dealt`.
- Update the `.cursor/rules/data-schema.mdc` paragraph that defines the PvP/PvE split. Mention the carve-out + new fields.
- Add a brief note to AGENTS.md alongside the existing VTSR-T v2.4 commentary that the corpus was re-rated and pre-v6 `peak_vtsr` is no longer comparable.

## Risk / Blast Radius

| Area | Impact |
|---|---|
| Per-match leaderboard cells (PvP / PvE / Dealt / Received / Kills / Deaths) | Numbers shift slightly for any player with self-damage. Most visible: heavy Blink users. |
| `weapon_meta` total_damage / total_hits | Unchanged (we don't subtract self from totals — only redistribute attribution buckets). |
| `rivalry_matrix` JSON | Self-loop entries removed (e.g. `rivalry["Domakus"]["Domakus"]` will no longer exist). UI's "Top Rival" picker at [js/app.js:3841](js/app.js#L3841) already filtered self, so no visible regression — just the underlying data is now clean. |
| `kills.kill_rivalry_matrix` | Self-kill loop removed (rare). |
| `hit_targets` | Self-entry removed. |
| VTSR-T leaderboard | Re-rated. `peak_vtsr` values pre-bump no longer comparable. Players with heavy self-damage (e.g. blink-spam Scion warriors) lose the artificial PvP credit; their `pve_share` axis correspondingly loses the self-damage contribution. Net rating change typically small (axes are clipped + weighted). |
| Raw Data Browser Reconcile view | Updated to verify new invariant. |
| Backwards compatibility | Pre-v6 cached matches simply have no `self_*` fields. Aggregator + dashboard treat absent fields as 0. The `dealt = pvp + pve` invariant still holds for legacy data. |

## Out of scope

- Per-ship combat `self_kills` / `self_dealt` — current `per_ship_combat["dealt"]` continues to include self at the ship level. Aggregator's `pve_kills` derivation at [js/all-matches-aggregator.js:702](js/all-matches-aggregator.js#L702) keeps the 2-bucket model. (Self at ship-level is double-rare and a third bucket would be noise.)
- Friendly-fire carve-out (different policy question — FF between humans stays in `pvp_dealt` per current docs).
- Pipeline-side filtering of Blink AOE damage from `weapon_meta` (separate design question — out of scope for this bug fix).