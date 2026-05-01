# AGENTS.md

## Project

VT Stats — static-site dashboard for Battlezone: Combat Commander match statistics. Python pipeline processes raw protobuf session data into pre-computed JSON; static HTML/JS/CSS dashboard renders it.

## Before Making Any Change

1. Read the relevant rule file(s) from `.cursor/rules/`
2. Follow `DEVELOPER_GUIDE.md` for schema and architecture details
3. Never skip these — they prevent regressions and ensure consistency

## Rule Files

| File | Scope | When to read |
|------|-------|-------------|
| `project-overview.mdc` | Always applied | Architecture, data flow, file locations |
| `data-schema.mdc` | py, js, json files | Proto schema, damage semantics, pipeline output format |
| `styling.mdc` | html, css, js files | Bootstrap-first, `--kb-*` theme variables, `--vt-*` effect variables, Geist font, load order, tab architecture |
| `schema-migration.mdc` | proto, py files | Step-by-step playbook for adapting to proto/schema changes |
| `filter-contract.mdc` | py, js files | Client-side global filter contract and checklist for new pipeline output fields |

## Deep Reference

- `DEVELOPER_GUIDE.md` — full technical specification: protobuf schema with field tables, damage event semantics, ODF weapon resolution, pre-computed JSON structure with examples, styling standards, chart architecture, tab navigation architecture
- `README.md` — project overview, quick start, features list
- `scripts/statsgate.proto` — **definitive reference** for the raw data schema
- `statsgate/` — upstream collector source code for schema reference
- `css/vtstats-theme.css` — premium glassmorphic theme layer: glass surfaces, Geist typography, depth shadows, animations, migrated inline styles, `--vt-*` effect variables
- `js/vtstats-fx.js` — effects engine: animated counters, staggered entrances, tab-entrance hooks, Chart.js shadow plugin, preloader lifecycle, View Transition API
- `js/timeline-player.js` — replay tab engine: animated Chart.js playback of `timeline` damage data with transport controls (play/pause/step/scrub/speed), running leaderboard, faction tug-of-war, bucket spotlight, momentum chip, and kill-marker plugin overlay. Exposes `window.VTReplay = { init, destroy, renderFullscreenSnapshot, hasInstance, jumpToTick }`; `jumpToTick(tick)` seeks the playhead to the bucket containing the tick (paused) — used by cross-links from the Raw Data Browser's events-table via `?t=<tick>` on `index.html`.
- `js/positioning-charts.js` — Positioning tab renderers: Movement Leaderboard, distance-from-spawn line chart, combined top-down heatmap, per-player small-multiples heatmap grid (shared viewport + shared p95 intensity + legend), ring histogram
- `js/positioning-player.js` — Positioning Timeline Player: animated trail playback with transport controls, sub-second interpolation on sparse `trail.t[]`, teleport-segment gap rendering, pulsing current-position dots; exposes `window.VTPositionPlayer`
- `js/all-matches-aggregator.js` — pure client-side cross-match aggregator. Exposes `window.VTAggregate.build(contributions, fileIds)` which sums entries from `data/processed/match_contributions.json` (subset chosen by `fileIds`) into the same `{meta, career_stats, global_weapon_meta, global_rivalries}` shape the legacy `all_matches.json` had. Documented exception to the "no aggregation in JS" rule, made so the All Matches view can scope to the picker-filtered subset. Mirrors `scripts/process_stats.py` `_extract_contribution()` (per-match shape) + the legacy `build_all_matches_aggregate()` (kept as reference). Loaded after `js/positioning-player.js` in `index.html`.
- `raw.html` / `js/raw-browser.js` / `css/raw-browser.css` — Raw Data Browser: isolated standalone page that decodes `*.binpb.gz` client-side (vendored protobufjs-light + native `DecompressionStream`) and renders three tiers per match (raw binpb metadata + download, faithful decoded JSON, processed JSON) in a virtualized tree with domain-aware resolvers (Steam64 → nickname via `header.s64_to_nick`, ODF → `wpn_name` via match-global `odf_map`), search, breadcrumb path, and downloads for all three artifacts. Also ships a virtualized event-stream table (`mode=events` on the decoded tier) with event-type filter chips, dual-handle tick range slider, player-cell click-to-filter, adjacent-pair highlight for `DamageDealt`↔`DamageReceived`, and row-click cross-link to the Replay tab via `?t=<tick>`. Phase 3 adds: hover tooltips on proto-declared field names (sourced from `data/proto-docs.json`), a JSONPath-subset query bar (`$`-prefixed search), and a Reconcile view verifying processed-JSON aggregates against tier-2 event-stream sums for a fixed list of fields. Linked from `index.html`'s match-info banner ("View raw") and the `docs.html` top nav.
- `scripts/extract_proto_docs.py` / `data/proto-docs.json` — build script + generated artifact. Parses inline `//` comments from `scripts/statsgate.proto` into a flat `{"MessageName.fieldName": "comment"}` dict (camelCase keys matching protobufjs's `toObject` output). Invoked as part of the main pipeline run. Consumed by `js/raw-browser.js` for field-name hover tooltips in the Decoded tier.
- `scripts/build_map_registry.py` / `data/map-registry.json` / `data/maps/` — build script + generated registry + fetched map assets. Fetches metadata (title, description, top-down image, team names) from `https://gamelistassets.iondriver.com/bzcc/getdata.php` for each distinct map. Merges iondriver data with the baked-in `VSR_MAP_DATA` from `js/bz2api.js` (author, canonical size/b2b). Downloads images to `data/maps/<mapFile>.png`. Idempotent: re-runs are zero-network when maps are already cached. Invoked from the pipeline run *before* the manifest is written so that `manifest[i].name` in `data/processed/matches.json` can be resolved from `registry[<key>].title` (with iteratively-stripped `XYZ: ` prefixes — e.g. `"VSR: Ancient Hills"` → `"Ancient Hills"`, `"ST: VSR: TVD: Ebola"` → `"Ebola"`). Falls back to the raw `.bzn`-stripped filename when the registry has no title for a map. The pipeline calls `build_registry(map_mod_entries=...)` with an in-memory `(map_file_key, config_mod)` list so the builder doesn't need to re-read `matches.json`; the standalone CLI invocation (`python scripts/build_map_registry.py`) still works via the `discover_map_files()` fallback. Consumed by `js/app.js` for hero stats + `js/positioning-charts.js` for heatmap overlays.
- `js/bz2api.js` — vendored BZ2API library: baked-in VSR map catalog (`VSR_MAP_DATA`), CORS-proxied iondriver API client, lobby session parser. Used server-side by `build_map_registry.py` (regex-extracts `VSR_MAP_DATA`) and client-side by `js/app.js`'s `getMapMeta()`. Sourced from [sevsunday/bz2vsr](https://github.com/sevsunday/bz2vsr).
- `vendor/protobufjs/protobuf.min.js` / `vendor/protobufjs/statsgate.proto.json` — vendored protobufjs v7 light build + generated descriptor consumed by `raw-browser.js` to decode `ClientStatSession` messages in the browser.
- `scripts/verify_proto_decode.mjs` — schema-migration verification tool: one-off Node script that decodes a real `*.binpb.gz` with protobufjs + the generated descriptor and prints header/event-count summary for comparison against the Python pipeline. Requires `npm i --no-save protobufjs@7` before running.
- `scripts/audit_sentinel_events.mjs` — permanent debugging utility that scans every `data/sessions/**/*.binpb.gz` and histograms `DamageDealt` / `DamageReceived` events exceeding the `SENTINEL_DAMAGE_THRESHOLD` (> 1e6). Primary metric `total_sentinel_pairs` must agree with the All Matches aggregate's `meta.total_sentinel_damage_dropped` (built client-side by `js/all-matches-aggregator.js` from `data/processed/match_contributions.json`). Writes reports into gitignored `_investigation/output/`.
- `scripts/dump_events_window.mjs` — general-purpose event-stream dumper; decodes a single `*.binpb.gz` and prints events in a `[tick_min, tick_max]` window. Useful for investigating any time-localized anomaly, not just sentinels.
- `docs/DATA_DICTIONARY.md` §7 "Sentinel Damage Filter" — first-class reference for the `amount > 1e6` sentinel damage filter. Evidence chain, BZCC engine struct layout, Ghidra decompile of the `DAMAGE_TYPE_UNKNOWN` force-kill pathway, bit-pattern verification, and the proposed upstream `DamageType` enum schema enhancement. Linked from `.cursor/rules/data-schema.mdc` and `DEVELOPER_GUIDE.md`. The companion `docs/DATA_DICTIONARY.md` §8 "UnitDestroyed Classification & Powerup Economy" covers the four-way classification + powerup-pickup semantics.

## Key Conventions

- `scripts/statsgate.proto` is the single source of truth for raw data schema. All docs, rules, and pipeline code must match it. When it changes, everything downstream updates.
- All data processing happens in the Python pipeline (`scripts/process_stats.py`), never in browser JavaScript — with one **documented exception**: `js/all-matches-aggregator.js` performs pure summation over `data/processed/match_contributions.json` to produce the All Matches view's aggregate. This exists so the picker's facet filters (player count, duration band, players, role, etc.) can scope the aggregate without per-match round trips. Per-match aggregation (leaderboards, weapon meta, rivalry matrices) still happens in the pipeline; only the cross-match summation moved client-side.
- All dependencies are vendored locally in `vendor/` — no CDN usage.
- All colors come from CSS custom properties (`--kb-*`) — zero hardcoded colors in HTML or JS. Visual effects use `--vt-*` variables.
- **Geist** (vendored in `vendor/fonts/`) is the project typeface. Geist Sans for body/UI, Geist Mono for stat values.
- All dashboard styles live in CSS files — **zero inline `<style>` blocks** in HTML.
- Dashboard uses tabbed navigation with lazy rendering — charts render on first tab activation, not on page load.
- Global player filter is client-side only — `getFilteredData()` derives filtered views from loaded JSON using the same lazy re-render pipeline as match switching. `weapon_meta` is recomputed from `leaderboard[].weapon_breakdown` when filtering. `kills.by_vehicle` is always unfiltered. No pipeline changes needed.
- Match picker filter is **separate** from the per-match player filter. `pickerState` (in `js/app.js`, persisted in sessionStorage as `vt.picker.filters.v2`) drives which manifest entries the All Matches aggregate covers — not what shows inside a single match. Facets: duration band (radio), player count (multi), submitter (multi), full-roster Players (multi) with two orthogonal toggles: Match-mode (`Any of these` vs `All of these`) and Role (`Any role` / `Commander` / `Thug`). Role is derived per-match: a name in `team_leaders` is the match's commander; otherwise (still in `players[]`) it's a thug. When the user is on the All Matches view, a chip toggle debounce-reruns `loadAllMatches()` so the career table / radar / global meta reflect the filtered subset. The All-Matches-view banner above the aggregate surfaces "Aggregate of K of N matches matching the active filters" + a Clear-filters shortcut.
- Career-roster threshold: `js/all-matches-aggregator.js` enforces a hard-coded `MIN_CAREER_MATCHES = 5` after summation — `career_stats[]` rows with fewer matches *in the current scope* are dropped, and `global_rivalries[]` is cascade-filtered to the kept names. `global_weapon_meta` and `meta.*` totals are unaffected; per-match views (Player Leaderboard, kill feed, etc.) are unaffected. The threshold is surfaced via `meta.min_career_matches` (read by UI labels — never duplicate the constant) and `meta.players_dropped_by_min_matches` (count of pruned rows). Any new cross-match aggregate that surfaces players in the All Matches view must respect the threshold by reading from the post-prune `career_stats[]` (or by checking `keptNames` if it builds in parallel).
- Processed JSON is the source of truth for the browser; the proto is the source of truth for the pipeline.
- Players are identified by Steam64 IDs. Header maps: `s64_to_nick`, `teamnum_to_s64`, `s64_to_teamnum`.
- Faction determined by slot convention: slots 1-5 = Team 1, slots 6-10 = Team 2.
- Session data lives in `data/sessions/<username>/*.binpb.gz`, organized by submitter.
- Movement Profile (0-100 `activity_score` per player, career-aggregated) is derived from `UpdateTick` position samples in the pipeline. Higher = more active / covered more map. See `.cursor/rules/data-schema.mdc` for the formula and band thresholds, `docs/DATA_DICTIONARY.md` for the full positioning JSON schema.
- T-Key Usage (`positioning.players[].metrics.target_lock_pct`, 0-1 ratio) is captured from `PlayerState.has_target`. Availability is gated by the match-global `has_target_lock_data` flag (mirrored on `positioning`, `match`, and manifest entries) which is `false` for pre-schema sessions and matches where no player held T. Unlike `activity_score`, `target_lock_pct` is absolute (cross-match comparable) and averaged directly in `career_stats[].mean_target_lock_pct`. Rendered on the 8th "T-Key Usage" axis of the Player Performance Radar.

## When Schema Changes

1. Replace `scripts/statsgate.proto` with the new version
2. Follow `.cursor/rules/schema-migration.mdc` checklist
3. Update pipeline, JSON output, JS rendering, `data-schema.mdc`, and `DEVELOPER_GUIDE.md` — in that order
4. Regenerate the raw-browser descriptor: `npx pbjs -t json scripts/statsgate.proto > vendor/protobufjs/statsgate.proto.json`
5. Verify the Node/browser decode path still matches the Python pipeline by running `scripts/verify_proto_decode.mjs` (see the script header for setup) before shipping the new schema
