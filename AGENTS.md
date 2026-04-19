# AGENTS.md

## Project

VT Stats — static-site dashboard for BattleZone match statistics. Python pipeline processes raw protobuf session data into pre-computed JSON; static HTML/JS/CSS dashboard renders it.

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
- `js/timeline-player.js` — replay tab engine: animated Chart.js playback of `timeline` damage data with transport controls (play/pause/step/scrub/speed), running leaderboard, faction tug-of-war, bucket spotlight, momentum chip, and kill-marker plugin overlay
- `js/positioning-charts.js` — Positioning tab renderers: Movement Leaderboard, distance-from-spawn line chart, combined top-down heatmap, per-player small-multiples heatmap grid (shared viewport + shared p95 intensity + legend), ring histogram
- `js/positioning-player.js` — Positioning Timeline Player: animated trail playback with transport controls, sub-second interpolation on sparse `trail.t[]`, teleport-segment gap rendering, pulsing current-position dots; exposes `window.VTPositionPlayer`

## Key Conventions

- `scripts/statsgate.proto` is the single source of truth for raw data schema. All docs, rules, and pipeline code must match it. When it changes, everything downstream updates.
- All data processing happens in the Python pipeline (`scripts/process_stats.py`), never in browser JavaScript.
- All dependencies are vendored locally in `vendor/` — no CDN usage.
- All colors come from CSS custom properties (`--kb-*`) — zero hardcoded colors in HTML or JS. Visual effects use `--vt-*` variables.
- **Geist** (vendored in `vendor/fonts/`) is the project typeface. Geist Sans for body/UI, Geist Mono for stat values.
- All dashboard styles live in CSS files — **zero inline `<style>` blocks** in HTML.
- Dashboard uses tabbed navigation with lazy rendering — charts render on first tab activation, not on page load.
- Global player filter is client-side only — `getFilteredData()` derives filtered views from loaded JSON using the same lazy re-render pipeline as match switching. `weapon_meta` is recomputed from `leaderboard[].weapon_breakdown` when filtering. `kills.by_vehicle` is always unfiltered. No pipeline changes needed.
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
