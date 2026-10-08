# AGENTS.md

VT Stats is a static-site dashboard for Battlezone: Combat Commander match statistics. A Python pipeline turns raw protobuf sessions into pre-computed JSON; the browser only renders that JSON.

Architecture, data contracts, and per-page behavior live in `.cursor/rules/` and `DEVELOPER_GUIDE.md`. This file is only the entry point. Do not copy long conventions back into it.

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

Three load-bearing conventions, restated so they are hard to miss:

1. **All dependencies are vendored** in `vendor/` — no CDN usage, ever. The one exception is `elo/analysis/` (Tailwind, Chart.js, and Inter from a CDN), documented in `project-overview.mdc`.
2. **The Python pipeline owns aggregation** (`scripts/process_stats.py` → `data/processed/*.json`). The single documented exception is `js/all-matches-aggregator.js`, which sums `match_contributions.json` so the match picker can scope the All Matches view.
3. **Schema version discipline**: `scripts/statsgate.proto` is the source of truth for the current raw schema (older schemas stay frozen for backward decode). Bump `PIPELINE_VERSION` when pipeline output semantics change, `match.schema_version` when the per-match JSON contract changes, and `ELO_SCHEMA_VERSION` when rating semantics change. They are orthogonal — see `schema-migration.mdc`.

## Deep Reference

| Path | What it is |
|------|------------|
| `DEVELOPER_GUIDE.md` | Full technical specification |
| `docs/DATA_DICTIONARY.md` | Processed JSON field reference |
| `README.md` | Project overview and quick start |
| `scripts/statsgate.proto` | Current raw schema |
| `scripts/process_stats.py` | Pipeline entrypoint |
| `scripts/elo.py` / `scripts/elo_commander.py` | VTSR-T and VTSR-C |
| `js/app.js` | Dashboard renderer |
| `css/vtstats-theme.css` | Shared theme layer |
| `docs/index.html` | Rendered docs (dictionary + developer guide) |

## When Schema Changes

1. If the new schema removes or reshapes fields the existing corpus depends on, freeze the outgoing schema first (`statsgate_vN.proto`, package renamed to `statsgate_vN`, plus its pb2 and protobufjs JSON), then replace `scripts/statsgate.proto`.
2. Follow `.cursor/rules/schema-migration.mdc`.
3. Update the pipeline, JSON output, JS rendering, `data-schema.mdc`, and `DEVELOPER_GUIDE.md` — in that order.
4. Regenerate the raw-browser descriptor: `npx -y -p protobufjs-cli pbjs -t json scripts/statsgate.proto > vendor/protobufjs/statsgate.proto.json`. Invoke `protobufjs-cli` explicitly. On PowerShell, run the redirect through `cmd /c` so the JSON is not written as UTF-16.
5. Run `scripts/verify_proto_decode.mjs` on one file per schema era before shipping.
