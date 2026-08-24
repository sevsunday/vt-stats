# CLAUDE.md

Agent instructions for this repository live in **[AGENTS.md](AGENTS.md)** and
**`.cursor/rules/`** — read those first, before making any change. This file
is deliberately a thin pointer so guidance never drifts between copies.

The three most load-bearing conventions, restated for orientation:

1. **All dependencies are vendored** in `vendor/` — no CDN usage, ever.
2. **The Python pipeline owns aggregation** (`scripts/process_stats.py` →
   `data/processed/*.json`); browser JS only renders pre-computed JSON. The
   single documented exception is `js/all-matches-aggregator.js` (pure
   summation over `match_contributions.json` so the match picker can scope
   the All Matches view client-side).
3. **Schema version discipline**: `scripts/statsgate.proto` is the source of
   truth for the current raw schema (v1/v2 are frozen for backward decode);
   bump `PIPELINE_VERSION` when pipeline output semantics change (cache
   invalidator), `match.schema_version` when the per-match JSON contract
   changes (frontend contract), and `ELO_SCHEMA_VERSION` when rating
   semantics change (re-rate / comparability signal). They are orthogonal —
   see `.cursor/rules/schema-migration.mdc` for the playbook.
