# VT Stats

A static-site dashboard for Battlezone: Combat Commander match statistics. Processes raw protobuf match data through a Python pipeline and displays interactive charts, leaderboards, and analysis in the browser.

## Quick Start

### 1. Install Python Dependencies

```bash
cd scripts
pip install -r requirements.txt
```

### 2. Process Match Data

Place gzip-compressed protobuf session files in `data/sessions/<username>/`, organized by submitter:

```
data/sessions/
├── VTrider/
│   ├── 2026-04-16-01-27-48.binpb.gz
│   └── ...
├── F9bomber/
│   └── ...
└── <other submitters>/
```

Filenames are timestamps (for uniqueness). Then run:

```bash
cd scripts
python process_stats.py
```

This reads every `.binpb.gz` file across all user folders, aggregates per-match statistics, fetches map metadata + top-down images via `scripts/build_map_registry.py`, extracts proto-comment tooltips for the Raw Data Browser, and writes pre-computed JSON + slim per-match contributions to `data/processed/`.

### 3. View the Dashboard

From the **project root** (where `index.html` lives), serve locally:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Features

- **Match Picker Modal** with per-match and cross-match ("All Matches") views, faceted filtering by duration band / player count / submitter / full roster (with Match-mode and Commander/Thug Role toggles), free-text search across map / submitter / roster / commander, and persisted filter state across the session.
- **Faction Scoreboard** — Team 1 vs Team 2 with damage dealt/received, PvP/PvE split, accuracy, roster.
- **Player Leaderboard** — sortable by dealt, received, net, ratio, accuracy, kills, deaths, asset damage, Movemint Profile, weapons.
- **Player Performance Radar** — 8-axis spiderweb (Damage Dealt, Accuracy, Kills, Survivability composite, Mobility, Weapon Diversity, PvP Share, T-Key Usage) rendered in four modes: single (Overview), compare (Rivalries), team (Combat), career (All Matches with Bayesian shrinkage and a Totals/Per-match scale toggle).
- **Combat Timeline** — stacked area chart (per-player or per-faction toggle) with click-drag pan and wheel-zoom.
- **Weapon Meta** — ranked horizontal bar chart of weapon damage + accuracy.
- **Rivalry Heatmap** — player-on-player damage matrix + Top Rivalries cards with doughnut charts + Kill Rivalry Heatmap.
- **Hit Distribution by Target** — per-player breakdown of which targets each player hit most, with damage context.
- **Powerup Economy** — four-way classification of `UnitDestroyed` events separates real vehicle kills from crate/pod pickups, denial destructions (powerups shot before pickup), and deployable mine destructions. Surfaces a Powerup/Crate Destruction Breakdown chart and a Snipe Feed on the Combat tab.
- **Replay** — animated playback of the damage timeline with transport controls (play/pause/step/scrub + 0.5x-20x speeds), a live running leaderboard, faction tug-of-war, bucket spotlight, momentum indicator, and kill-marker plugin overlay.
- **Positioning** — top-down movement heatmaps (combined + per-player small multiples with a shared viewport and shared p95 intensity scale + legend), distance-from-spawn line chart with three view modes (Team bands / All players / Focused) and a 5s smoothing toggle, ring histogram of time by distance band, and an animated trail player with sub-second interpolation. Top-down map images are fetched at pipeline time and overlaid as backgrounds.
- **Movemint Profile** — 0-100 activity score per player, match-self-calibrated against the roster's p95 of `max_dist` and `path_length_per_sec`, with bands from Defensive to Aggressive. Surfaces in the main leaderboard, a dedicated Movemint Leaderboard, the Player Performance Radar, and career aggregates.
- **T-Key Usage / Target Lock** — captured from `PlayerState.has_target` per tick, surfaced as the 8th Radar axis. Cross-match comparable (absolute 0-1 ratio).
- **Raw Data Browser** (`raw.html`) — isolated standalone page that decodes `.binpb.gz` client-side (vendored protobufjs-light + native `DecompressionStream`) and renders three tiers per match: raw binpb metadata + download, faithful decoded JSON, and processed JSON. Includes virtualized event-stream table, JSONPath search, proto-schema field tooltips, sentinel damage badge, and a Reconcile view that verifies processed-tier aggregates against tier-2 event sums.
- **Sentinel Damage Filter** — engine-emitted force-kill events (`amount = 2^28`) are dropped at ingest with full per-match telemetry. See [docs/DATA_DICTIONARY.md §7](docs/DATA_DICTIONARY.md#7-sentinel-damage-filter).
- **Live Sync URL Sharing** — every state change (match, filter, tab, replay tick) is shareable via query parameters; an opt-in topnav toggle keeps the URL in sync with the current view, and a one-shot Share button copies the link regardless.
- **Career Roster Minimum** — the All Matches view's career table only surfaces players with 5+ matches in the current scope (picker-filter aware).
- **Fullscreen Expand** — view any chart, table, or section in a fullscreen modal.
- **44 Themes** with light/dark mode support.

## Tech Stack

- **Python** + `protobuf` for data processing
- **Bootstrap 5.3.2** for UI (vendored)
- **Chart.js 4.4.7** with `chartjs-plugin-zoom` for visualizations (vendored)
- **Geist Sans + Geist Mono 1.8.0** for typography (vendored — variable woff2)
- **protobufjs 7.4.0** light build for the Raw Data Browser's client-side decode (vendored)
- **Custom theme system** with 44 themes, light/dark modes, and a glassmorphic effect layer

All dependencies are vendored locally — no CDN usage, fully offline-capable.

## Documentation

- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) — single canonical reference: protobuf schema, pipeline stages, source-to-display mappings, output JSON shapes, datapoint glossary, sentinel damage filter (§7), and the four-way `UnitDestroyed` classification (§8). Browse rendered with search at `docs.html`.
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — full technical specification including chart architecture, styling standards, schema-evolution playbook, and edge-case tables for URL-sharing and the Raw Data Browser.
