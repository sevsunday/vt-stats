# AGENTS.md

## Project

VT Stats — static-site dashboard for BattleZone match statistics. Python pipeline processes raw protobuf match data into pre-computed JSON; static HTML/JS/CSS dashboard renders it.

## Before Making Any Change

1. Read the relevant rule file(s) from `.cursor/rules/`
2. Follow `DEVELOPER_GUIDE.md` for schema and architecture details
3. Never skip these — they prevent regressions and ensure consistency

## Rule Files

| File | Scope | When to read |
|------|-------|-------------|
| `project-overview.mdc` | Always applied | Architecture, data flow, file locations |
| `data-schema.mdc` | py, js, json files | Proto schema, damage semantics, pipeline output format |
| `styling.mdc` | html, css, js files | Bootstrap-first, `--kb-*` theme variables, load order |
| `schema-migration.mdc` | proto, py files | Step-by-step playbook for adapting to proto/schema changes |

## Deep Reference

- `DEVELOPER_GUIDE.md` — full technical specification: protobuf schema with field tables, damage event semantics, ODF weapon resolution, pre-computed JSON structure with examples, styling standards, chart architecture
- `scripts/statsgate.proto` — **definitive reference** for the raw data schema
- `statsgate/` — upstream collector source code for schema reference

## Key Conventions

- `scripts/statsgate.proto` is the single source of truth for raw data schema. All docs, rules, and pipeline code must match it. When it changes, everything downstream updates.
- All data processing happens in the Python pipeline (`scripts/process_stats.py`), never in browser JavaScript.
- All dependencies are vendored locally in `vendor/` — no CDN usage.
- All colors come from CSS custom properties (`--kb-*`) — zero hardcoded colors in HTML or JS.
- Processed JSON is the source of truth for the browser; the proto is the source of truth for the pipeline.
- Current local data uses the **legacy format** (int32 slot-based). Pipeline must remain backward-compatible until all data is replaced.

## When Schema Changes

1. Replace `scripts/statsgate.proto` with the new version
2. Follow `.cursor/rules/schema-migration.mdc` checklist
3. Update pipeline, JSON output, JS rendering, `data-schema.mdc`, and `DEVELOPER_GUIDE.md` — in that order
