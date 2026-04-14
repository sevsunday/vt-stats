# VT Stats

A static-site dashboard for BattleZone match statistics. Processes raw protobuf match data through a Python pipeline and displays interactive charts, leaderboards, and analysis in the browser.

## Quick Start

### 1. Install Python Dependencies

```bash
cd scripts
pip install -r requirements.txt
```

### 2. Process Match Data

Place `.zip` archives containing `.binpb` files in `data/stats/`, then run:

```bash
cd scripts
python process_stats.py
```

This reads all match archives, aggregates statistics, and outputs pre-computed JSON to `data/processed/`.

### 3. View the Dashboard

From the **project root** (where `index.html` lives), serve locally:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Features

- **Match Selector** with per-match and cross-match ("All Matches") views
- **Faction Scoreboard** — Team 1 vs Team 2 with damage dealt/received, accuracy, roster
- **Player Leaderboard** — sortable by dealt, received, net, ratio, accuracy, weapons
- **Combat Timeline** — stacked area chart (per-player or per-faction toggle)
- **Weapon Meta** — ranked horizontal bar chart of weapon damage + accuracy
- **Rivalry Heatmap** — player-on-player damage matrix
- **Per-Player Weapon Breakdown** — stacked bar showing top 8 weapons per player
- **Top Rivalries** — bidirectional damage cards with doughnut charts
- **Shot Accuracy** — per-player table and weapon accuracy ranking
- **AI/Structure Damage** — asset damage attribution per player and faction
- **Fullscreen Expand** — view any chart, table, or section in a fullscreen modal
- **44 Themes** with light/dark mode support

## Tech Stack

- **Python** + `protobuf` for data processing
- **Bootstrap 5.3.2** for UI (vendored)
- **Chart.js 4.4.7** for visualizations (vendored)
- **Custom theme system** with 44 themes and light/dark modes

All dependencies are vendored locally — no CDN usage, fully offline-capable.

## Documentation

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the full technical specification including protobuf schema, damage event semantics, ODF weapon resolution, and styling standards.
