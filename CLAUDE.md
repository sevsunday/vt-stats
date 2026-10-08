# CLAUDE.md

Agent instructions for this repository live in **[AGENTS.md](AGENTS.md)** (a short entry point) and **`.cursor/rules/`** (the source of truth for architecture, schema, styling, and the filter contract). Read the rules before making any change. This file is a thin pointer so guidance never drifts between copies.

The three most load-bearing conventions, restated for orientation:

1. **All dependencies are vendored** in `vendor/` — no CDN usage, ever. The one exception is `elo/analysis/`, documented in `.cursor/rules/project-overview.mdc`.
2. **The Python pipeline owns aggregation** (`scripts/process_stats.py` → `data/processed/*.json`); browser JS only renders pre-computed JSON. The single documented exception is `js/all-matches-aggregator.js` (pure summation over `match_contributions.json` so the match picker can scope the All Matches view client-side).
3. **Schema version discipline**: `scripts/statsgate.proto` is the source of truth for the current raw schema (older schemas stay frozen for backward decode); bump `PIPELINE_VERSION` when pipeline output semantics change (cache invalidator), `match.schema_version` when the per-match JSON contract changes (frontend contract), and `ELO_SCHEMA_VERSION` when rating semantics change (re-rate / comparability signal). They are orthogonal — see `.cursor/rules/schema-migration.mdc` for the playbook.
