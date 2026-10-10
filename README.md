# VT Stats

Static HTML/JS/CSS site hosted via Github pages. Originally built for the VSR Community to display data collected by VTrider's statsgate collector, it now encompasses much more than that: 

- Match analyses, with in-depth stats and a 3D replay system 
- An ODF browser containing 3100+ ODFs, with inheritance and expansion baked in
- Game-model renders with tools to visualize textures, team colors, collision radius, snipe points, and more
- Lego-model renders built by Darkvale
- Map browser that allows you to see pool and loose placements, and even explore the 3D map environment
- Weapons Lab that allows you to test weapons with real ships in a virtual firing range
- A provisional ELO system built on the raw match data collected over time
- GameWatch system, that shows you all live lobbies 
- Live-lobby tools such as coin flipper, the infamous "shit wheel", and lobby balance predictor

## Quick Start

I (Sev) currently handle all new-session uploads. However, should I ever be hit by the proverbial bus, anyone can new sessions. Simply clone the repo then do the steps below locally.

### 1. Install Python Dependencies

```bash
cd scripts
pip install -r requirements.txt
```

### 2. Process Match Data

Place `.binpb` session files in `data/sessions/<username>/`, organized by submitter:

```
data/sessions/
├── VTrider/
│   ├── 2026-04-16-01-27-48.binpb.gz
│   └── ...
├── Nomad/
│   └── ...
└── <other submitters>/
```

Filenames are timestamps (for uniqueness). **DO NOT CHANGE THE NAMES OF THE FILES.**

Then run:

```bash
cd scripts
python process_stats.py
```

This reads every `.binpb.gz` file across all user folders, aggregates per-match statistics, fetches map metadata + top-down images via `scripts/build_map_registry.py`, extracts proto-comment tooltips for the Raw Data Browser, and writes pre-computed JSON + slim per-match contributions to `data/processed/`.

New (proto v3+) matches prompt once in the console for a human **outcome review** (confirm or correct the winner the host selected in-game; answers persist in `data/match_outcome_adjudications.json` and never re-prompt). Pass `--no-prompt` when running unattended — otherwise the pipeline waits on stdin whenever unreviewed matches exist.

## Tech Stack

- **Python** + `protobuf` for data processing
- **Bootstrap 5.3.2** for UI (vendored)
- **Chart.js 4.4.7** with `chartjs-plugin-zoom` for visualizations (vendored)
- **Geist Sans + Geist Mono 1.8.0** for typography (vendored — variable woff2)
- **protobufjs 7.4.0** light build for the Raw Data Browser's client-side decode (vendored)
- **three.js r170** for the 3D Models Browser (vendored, with OrbitControls / GLTFLoader / DDSLoader addons)
- **Bootstrap/tweakcn hybrid theme system** with 44 themes, each with light/dark modes

All dependencies are vendored locally — no CDN usage, fully offline-capable.

## Documentation

- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) — single canonical reference: protobuf schema, pipeline stages, source-to-display mappings, output JSON shapes, datapoint glossary, sentinel damage filter (§7), and the four-way `UnitDestroyed` classification (§8). Browse rendered with search at `docs/`.
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — full technical specification including chart architecture, styling standards, schema-evolution playbook, and edge-case tables for URL-sharing and the Raw Data Browser.
