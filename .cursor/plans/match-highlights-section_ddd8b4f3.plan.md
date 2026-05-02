---
name: match-highlights-section
overview: Add a per-match "Highlights" card to the Overview tab that surfaces a fixed set of 12 humorous superlatives (The Bully, Grim Reaper, Roadrunner, Puppeteer, Gunner, Chris Kyle, Locksmith, etc.). Pre-computed in the Python pipeline (per the no-aggregation-in-JS rule), match-global / always-unfiltered. Cards self-hide when their underlying data is unavailable (positioning / pickups / T-key gates).
todos:
  - id: pipeline-compute
    content: Add compute_highlights() in scripts/process_stats.py with helpers and the 12-card always-on catalog. Each card emits when its data gates pass, otherwise it's omitted. Wire into process_match() and bump meta.schema_version to 2.
    status: completed
  - id: ui-card
    content: "Add #section-highlights card to index.html above #section-faction; implement renderHighlights() in js/app.js with per-category formatters, narrative-driven copy templates, pair handling (Frenemies), and VTFx stagger hook."
    status: completed
  - id: styles
    content: Extend css/vtstats-theme.css with .vt-highlights-card and .vt-highlight-tile styles using --kb-* tokens; add .vt-highlight-tile--dominant accent for high delta_pct cards.
    status: completed
  - id: filter-contract
    content: Add highlights row to .cursor/rules/filter-contract.mdc reference table marking it always-unfiltered and match-global.
    status: completed
  - id: docs
    content: Update docs/DATA_DICTIONARY.md (§5 + §6), DEVELOPER_GUIDE.md, .cursor/rules/data-schema.mdc, .cursor/rules/project-overview.mdc, and AGENTS.md with the highlights block, schema-version bump, and award catalog.
    status: completed
  - id: regenerate
    content: Run scripts/process_stats.py to regenerate all per-match JSONs with the new highlights block; spot-check 3-4 representative matches (high-action VSR, snipe-heavy, pickup-heavy, low-roster) and verify card selection looks sane.
    status: completed
isProject: false
---

# Match Highlights — Plan

## Decisions (committed)

- **All cards always-on** (no Tier 1/2 split, no impressiveness-driven selection). Each card emits unconditionally as long as its data gate passes. Old-schema / position-less / pickup-less matches simply show fewer cards.
- **Layout**: Bootstrap `row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-4 row-cols-xl-6 g-3` grid. On big desktop (xl ≥1200px) the 12 cards arrange as a tidy **6 × 2**; lg = 4 × 3; md = 3 × 4; sm = 2 × 6; mobile = single-column scroll. Sits **above `#section-faction`** on the Overview tab.
- **No same-player cap.** If the Bully also wins Sharpshooter and Chris Kyle in the same match, that's the story of the match — let it tell itself.
- **Match-global, always-unfiltered.** The card never narrows under `filterState` — same contract as `kills.by_vehicle`.
- **Computed in `scripts/process_stats.py`**, written as a top-level `highlights` block in each per-match JSON. No browser aggregation. JS only formats and renders.
- **Bump per-match `meta.schema_version` 1 to 2.** Old JSONs without `highlights` render gracefully (whole section hidden — no crash).
- **No anti-awards in v1** ("Couch Potato", "Spray-and-Pray"). Reserve for an opt-in "Roast Mode" toggle later.
- **All Matches highlights are out of scope for v1.** Defer.

## The Award List (12 cards, all always-on)

Render order is stable so the section feels familiar match-to-match. The Roadrunner / Chris Kyle / Crate-Pod Goblin / Locksmith cards self-omit on matches that don't carry the underlying data.

| # | Award | Icon | Source / formula | Floor / gate | Tiebreak |
|---|---|---|---|---|---|
| 1 | **The Bully** | `bi-emoji-angry` | max `leaderboard[].personal.dealt` | — | higher `pvp_dealt`, then `kills` |
| 2 | **The Grim Reaper** | `bi-person-x-fill` | max `leaderboard[].kills` | `kills > 0` | higher `kd_ratio`, then higher `dealt` |
| 3 | **Bullet Sponge** | `bi-shield-fill` | max `leaderboard[].personal.received` | — | higher `pvp_received` |
| 4 | **The Hustler** | `bi-graph-up-arrow` | max `kd_ratio` (kills/deaths trade) | `kills >= 3` | higher `kills` |
| 5 | **Sharpshooter** | `bi-bullseye` | max `leaderboard[].personal.accuracy` | `shots_fired >= 100` | higher `shots_hit` |
| 6 | **Gunner** | `bi-lightning-charge` | max `leaderboard[].personal.shots_fired` | — | higher `accuracy` |
| 7 | **Puppeteer** | `bi-diagram-3` | max `leaderboard[].assets.dealt` (damage from AI / structures the player owns — turrets, scavs, deployables; sourced from `DamageDealt` events where the source's owning slot is this player but `shooter == 0`) | `assets.dealt > 0` | higher `personal.dealt` |
| 8 | **Frenemies** *(pair)* | `bi-people-fill` | `top_rivalries[0]` — both names on the card, value is `total` mutual damage | `top_rivalries.length > 0 && total > 0` | — |
| 9 | **Roadrunner** | `bi-rocket-takeoff` | max `positioning.players[].metrics.activity_score` (Movemint / activity score, 0-100) | `match.has_position_data` and at least one player has positioning entry | higher `path_length` |
| 10 | **Crate/Pod Goblin** | `bi-box-seam` | max **combined** pickups + powerup destructions per player: `pickups.by_player[name].count + powerup_destructions.by_player[name].count` | combined total `> 0` (one or both halves can be zero) | higher pickups count |
| 11 | **Chris Kyle** | `bi-crosshair` | max `snipes.by_player[].count` (most pilot snipes) | `snipes.totals.total > 0` | higher `kills` |
| 12 | **The Locksmith** | `bi-lock-fill` | max `positioning.players[].metrics.target_lock_pct` | `match.has_target_lock_data && target_lock_pct >= 0.10` | longer presence (`sample_count`) |

(That's 12 entries — kept Roadrunner & Locksmith as separate cards even though they're both positioning-derived; they tell different stories.)

## Data Shape

New top-level key in per-match JSON, written by `scripts/process_stats.py`:

```json
"highlights": {
  "schema_version": 1,
  "cards": [
    {
      "category": "the_bully",
      "label": "The Bully",
      "icon": "bi-emoji-angry",
      "winner": { "type": "player", "name": "VTrider", "steam64": "76561198..." },
      "value": 75489.3,
      "value_format": "damage",
      "runner_up": { "name": "Domakus", "value": 56120.0 },
      "delta_pct": 0.345,
      "narrative": "clear"
    },
    {
      "category": "frenemies",
      "label": "Frenemies",
      "icon": "bi-people-fill",
      "winner": { "type": "pair", "a": "VTrider", "b": "Domakus" },
      "value": 38420.5,
      "value_format": "damage",
      "runner_up": { "name": "GenosseGeneral vs Sporkinator", "value": 19200.0 },
      "delta_pct": 1.001,
      "narrative": "dominant"
    },
    {
      "category": "crate_pod_goblin",
      "label": "Crate/Pod Goblin",
      "icon": "bi-box-seam",
      "winner": { "type": "player", "name": "F9bomber", "steam64": "76561198..." },
      "value": 23,
      "value_format": "count",
      "value_breakdown": { "pickups": 17, "destructions": 6 },
      "runner_up": { "name": "Sporkinator", "value": 11 },
      "delta_pct": 1.091,
      "narrative": "dominant"
    }
  ]
}
```

Notes on the shape:

- `winner.type`: `"player"` for normal cards, `"pair"` for Frenemies. Renderer dispatches on this.
- `narrative` is a discrete bucket keyed by `delta_pct`:
  - `"dominant"` if `delta_pct >= 0.50` (winner ≥ 1.5× runner-up)
  - `"clear"` if `delta_pct >= 0.15`
  - `"close"` otherwise
  JS picks the copy-template variant from this — no math at render time.
- `value_format`: `"damage" | "count" | "ratio" | "percent" | "accuracy" | "distance" | "score"`. Drives the formatter.
- `value_breakdown` is optional; only Crate/Pod Goblin uses it today. Keeps the door open for compound metrics without inventing a new field per category.
- `runner_up` may be `null` (only 1 eligible player; rare). UI handles this gracefully ("solo standout" copy).
- Empty `cards: []` is valid — UI hides the section.

## Implementation

### 1. Pipeline — [scripts/process_stats.py](scripts/process_stats.py)

Add `compute_highlights(match_data)` near the other block builders (between `_build_snipes_block` and `process_match`):

- Inputs: the assembled `match_data` dict (`leaderboard`, `kills`, `pickups`, `snipes`, `powerup_destructions`, `top_rivalries`, `positioning`, `asset_damage`, `match`).
- Helpers (module-private): `_pick_top(rows, key_fn, *, floor=None, tiebreak=None)`, `_delta_pct(winner_v, runner_v)`, `_narrative_bucket(delta_pct)`.
- One card-builder per category (12 functions; thin wrappers around `_pick_top` + a category-specific assembly step). Each returns either a card dict or `None` (gate failed). The top-level `compute_highlights` filters out `None` and returns the surviving list in the canonical render order.
- Round numeric values consistent with the rest of the pipeline: damage / distance to 1 dp, accuracy / ratios to 3 dp, counts as integers, `delta_pct` to 3 dp.
- For Crate/Pod Goblin, build a `combined_counts` dict by summing across the player names that appear in either `pickups.by_player` or `powerup_destructions.by_player`. Carry the breakdown through to the card payload.
- For Frenemies, source from `top_rivalries[0]`; runner-up is `top_rivalries[1]` (if present) rendered as `"A vs B"` in the runner_up name. No Steam64 emitted on pair cards.

Call site: in `process_match()`, after all blocks are built but before the final dict is returned, add `match_data["highlights"] = compute_highlights(match_data)`.

Also bump `meta.schema_version` to `2` in the per-match output.

### 2. UI — [index.html](index.html) + [js/app.js](js/app.js) + [css/vtstats-theme.css](css/vtstats-theme.css)

**HTML** (insert immediately above `#section-faction` inside `#tab-overview`):

```html
<div class="card mb-4 vt-highlights-card d-none" id="section-highlights">
  <div class="card-header d-flex align-items-center justify-content-between">
    <h5 class="mb-0"><i class="bi bi-trophy-fill me-2"></i>Match Highlights</h5>
  </div>
  <div class="card-body">
    <div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 row-cols-lg-4 row-cols-xl-6 g-3" id="highlights-grid"></div>
  </div>
</div>
```

Bootstrap progression:

| Breakpoint | Width | Cols | Layout (12 cards) |
|---|---|---|---|
| xs | < 576px | 1 | 12 rows |
| sm | ≥ 576px | 2 | 6 rows |
| md | ≥ 768px | 3 | 4 rows |
| lg | ≥ 992px | 4 | 3 rows |
| xl | ≥ 1200px | 6 | 2 rows |

**JS** — add `renderHighlights(highlights)` and call it from `renderMatchData()` immediately after `renderBanner(currentData.match)`:

```js
renderHighlights(currentData.highlights);
ensureTooltips(document.getElementById('section-highlights'));
```

The function:

- Hides the card (`d-none`) when `highlights?.cards?.length` is empty/missing.
- Builds one mini-card per entry: icon, label, winner name, big value, runner-up tag, narrative-driven flavor copy.
- Always reads from `currentData.highlights` (unfiltered), not `data.highlights` — keeps the section match-global per the filter contract.
- Uses `data-vt-stagger-child` for entrance animation (existing VTFx hook).
- **Idempotent across filter toggles.** Even though `renderMatchData()` is shared between `loadMatch()` and `applyFilter()`, we re-run `renderHighlights` on each call. Output is byte-identical because the copy-template picker is seeded by match id + category (no random shuffling between renders). Re-render cost is negligible (12 small DOM nodes). No special filter-change short-circuit needed.
- The `ensureTooltips()` call is required so the xl-only `title=`-driven flavor copy actually works (Bootstrap tooltips don't auto-attach to dynamic DOM).

**Number formatting (commit to these in `formatHighlightValue(value, format)`):**

| `value_format` | Renderer | Example |
|---|---|---|
| `damage` | locale-formatted integer (no decimals) | `75,489` |
| `count` | integer | `23` |
| `score` | integer | `84` |
| `ratio` | `value.toFixed(2)` | `3.25` |
| `percent`, `accuracy` | `(value * 100).toFixed(1) + '%'` | `27.4%` |
| `distance` | `Math.round(value).toLocaleString()` | `17,154` |

**CSS** — extend [css/vtstats-theme.css](css/vtstats-theme.css) with a `.vt-highlights-card` block: glass surface variant, `.vt-highlight-tile` for individual cards (icon top-left, label, winner name, big numeric, runner-up secondary line, optional `.vt-highlight-tile--dominant` accent border for `narrative === "dominant"`). Zero inline styles, all `--kb-*` tokens.

**Tile sizing across breakpoints** — at xl with 6 cols a tile is ~170-180px wide. The compact layout that fits everywhere:

- xl / lg: vertical stack — icon + label on row 1, winner name on row 2, big value on row 3, runner-up `vs Domakus 56k` on row 4. Flavor copy hidden behind a hover tooltip (`title=`) to avoid wrapping into 3-4 lines on a narrow tile.
- md: same vertical stack, slightly wider — flavor copy renders inline below the value.
- sm / xs: tile widens (2-col / 1-col), flavor copy always visible inline.

CSS toggles flavor-copy visibility with `@media (min-width: 1200px) { .vt-highlight-tile-copy { display: none; } }` plus a tooltip fallback. This keeps the tile readable at every width without per-breakpoint tile-content branching in JS.

### 3. Copy templates (in JS, keyed by `category` + `narrative`)

Three short variants per (category, narrative) bucket. Renderer picks one deterministically (seeded by match id + category — same match always shows the same line). Examples:

- `the_bully / dominant` -> `"{name} ran the table — 35% above the next damage dealer."`
- `the_bully / clear` -> `"{name} out-damaged the pack."`
- `the_bully / close` -> `"{name} edged the field on damage."`
- `chris_kyle / dominant` -> `"{name} put a scope on everyone — {value} pilot snipes."`
- `frenemies / *` -> `"{a} and {b} would not stop trading shots — {value} dmg between them."`
- `crate_pod_goblin / *` -> `"{name} scooped {pickups} crates and trashed {destructions} more."`

Templates live in a const dict in `js/app.js`: `HIGHLIGHT_COPY[category][narrative] = string[]`. Easy to iterate without re-running the pipeline. Token interpolation supports `{name}`, `{value}`, `{a}`, `{b}`, `{pickups}`, `{destructions}`, `{delta_pct}`.

### 4. Filter contract — [.cursor/rules/filter-contract.mdc](.cursor/rules/filter-contract.mdc)

Add a row:

```
| `highlights.cards`, `highlights.schema_version` | Always full-match (never narrowed) | Match-global award set; pre-computed in pipeline. New JSON field added at meta.schema_version = 2; pre-v2 matches simply have no highlights block (UI hides the card). |
```

### 5. Documentation surface

- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) §5 — add `#### highlights` subsection under "Per-Match JSON" with the field table above.
- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) §6 — glossary entries for "Match Highlights" and each category label.
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — short Highlights subsection in the JSON structure + UI overview.
- [.cursor/rules/data-schema.mdc](.cursor/rules/data-schema.mdc) — mention the highlights block in the per-match output enumeration.
- [.cursor/rules/project-overview.mdc](.cursor/rules/project-overview.mdc) — add to the dashboard component list.
- [AGENTS.md](AGENTS.md) — one-line note in Key Conventions and Key File Locations.

## Out of Scope (v1)

- All Matches view highlights. Phase 2: emit per-match award winners into `_extract_contribution()`, surface "career-best damage match" / "all-time accuracy" in the All Matches view.
- Anti-awards / "Roast Mode" (Couch Potato, Spray-and-Pray, Friendly Fire Ace, etc.). Toggleable off-by-default, future work.
- Tier-based selection / impressiveness ranking. Reverted in favor of fixed always-on slate.
- Same-player cap. Removed — let dominant performances earn multiple cards.
- Embedded share-graphics (PNG export of the highlights card). Nice-to-have, not blocking.

## Risk Notes

- **Tiny rosters.** 1- or 2-player matches still produce most cards (Bully, Hustler, Sharpshooter all valid with floor checks; runner-up may be `null`). The UI handles `null` runner-up via "solo" copy.
- **Ties on small N.** Tiebreaker columns above resolve the obvious cases; remaining ties resolve by leaderboard order (stable, deterministic).
- **Schema-version bump (1 -> 2).** Anyone re-running the pipeline against existing JSON gets a new top-level `highlights` key. JSON consumers other than the dashboard (the Raw Data Browser, scripts) ignore unknown top-level keys safely. Document in the Phase log.
- **Raw Data Browser.** The new `highlights` block automatically appears in the Processed-JSON tier of [raw.html](raw.html). Steam64 values inside `winner.steam64` resolve to nicknames via the existing match-global resolver — no raw-browser changes needed.
- **Conditional cards (Roadrunner / Crate-Pod Goblin / Chris Kyle / Locksmith).** These omit cleanly on schema-deficient matches. The grid reflows around the missing entries; section never shows placeholder squares. UI gracefully handles "section has 8 cards on this match, 12 on another".
- **Quartermaster on Phase 3 matches.** Some matches log very little asset damage (no commander built turrets). The `assets.dealt > 0` floor self-suppresses the card on those — clean fallback.
- **Mobile vertical real estate.** On phones (xs, 1-col layout) 12 cards become a 12-row scroll between the match-info banner and the Faction Scoreboard. Accepted trade-off for v1: highlights are the headline, putting them at the top is the whole point. If user feedback complains, the section can be wrapped in a Bootstrap collapse with a "Show match highlights" toggle later.
