---
name: Repo cleanup pass
overview: Delete raw.html and fable/, move docs.html to docs/index.html, delete the dead ODF seeds and ~630 MB of unreferenced _map-analysis bulk, reorganize the archived plans into a clearer taxonomy, shrink AGENTS.md to a thin pointer, and scrub stale doc references. Texture-size findings are reported for your decision; no texture changes.
todos:
  - id: raw-html
    content: Delete raw.html and remove its redirect mentions from rules, DEVELOPER_GUIDE and css comment
    status: pending
  - id: docs-move
    content: git mv docs.html docs/index.html; fix ../ asset/nav paths, DOC_REGISTRY, self-links, add relative-link resolver; update cursor-settings.js, raw-browser.js, index.html and prose refs
    status: pending
  - id: fable
    content: Check fable improvements vs elo/analysis roadmap/history, port anything missing, delete fable/, repoint [78] (html + sources.json + manifest.json) and code-comment refs to the permalink
    status: pending
  - id: seeds
    content: Delete _odf-browser-seed/ and _odf-parser-seed/, drop stale .gitignore line, remove seed mentions in docs
    status: pending
  - id: map-analysis
    content: Delete _map-analysis archive/, shellmaps/, calibration/staging/; gitignore staging; update _map-analysis/README.md
    status: pending
  - id: plans
    content: Reorganize .cursor/plans per move list, promote 2 unimplemented plans to root, delete superseded dedup draft, tidy stale todo statuses, fix 4 live plan-path references
    status: pending
  - id: stale-docs
    content: Replace timeline-player.js / positioning-player.js references in styling.mdc, project-overview.mdc, filter-contract.mdc, DEVELOPER_GUIDE, DATA_DICTIONARY, raw-browser.js comment
    status: pending
  - id: agents
    content: Move any AGENTS.md-only facts into rule files, then rewrite AGENTS.md as a thin pointer and update CLAUDE.md
    status: pending
  - id: verify
    content: rg for stale refs, smoke-test /docs/, gear Docs link, raw sentinel link, replay/map/explorer pages, citation [78]
    status: pending
isProject: false
---

# Repo cleanup pass

Leave the unrelated work in progress alone (`js/tools/main.js`, `tools/index.html`). Nothing gets committed unless you ask.

## Texture findings (for your decision, no changes)

**Models (`/models`):** "Prefer HQ" is on by default (`preferHq()` in [js/models.js](js/models.js)).
- Across the whole corpus, diffuse textures take 172 MB at perf quality (512 px PNG) and 894 MB at HQ (2048 px DDS), about 5x more.
- Opening one model costs about 2.8x more at HQ. For `ivtank00`: perf is about 1.3 MB (diffuse 0.41, normal 0.56, team color 0.26, spec 0.07); HQ is about 3.7 MB because the diffuse alone grows to 2.8 MB.
- The hidden cost is the normal maps: 514 MB, always loaded, with no low tier. Per model, the normal map is larger than the perf diffuse.
- GPU memory is not the issue. DDS stays compressed on the GPU, so HQ costs roughly 2x the video memory, not 16x.
- Verdict: keeping the toggle is reasonable. The cheaper improvement for slow connections would be defaulting to perf on phones, or on connections with Save-Data turned on.

**Maps (3D replay and map viewer):**
- The default floor is the minimap drape, about 0.42 MB per map (`resolveDefaultFloorMode` returns `'minimap'`).
- The HQ "tiles" floor costs about 20 MB per map on average and up to 40 MB. That is the composites (~0.66 MB) plus that map's tile DDS files. 145 of the 222 tile files are 2048 px and 2.8 MB each.
- The toggle is clearly worth keeping. Downscaling the tiles to 1024 px would cut HQ cost about 4x; you deferred that.

## 1. Delete raw.html
- Delete [raw.html](raw.html). Nothing in the live code links to it; the dashboard already points at `raw/`.
- Remove "raw.html redirects to raw/" from [.cursor/rules/project-overview.mdc](.cursor/rules/project-overview.mdc), [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) and the comment in [css/raw-browser.css](css/raw-browser.css).

## 2. Move docs.html to docs/index.html (no redirect stub)
- `git mv docs.html docs/index.html`. Then, inside the moved file:
  - Prefix asset paths with `../` (`vendor/`, `css/`, `js/`).
  - Prefix nav links with `../` (`index.html`, `odf/`, `build/`, `map/`, `elo/`, `player/`, `tools/`, `models/`, `lego/`, `explorer/`, `weapons/`).
- `DOC_REGISTRY`: change `docs/DATA_DICTIONARY.md` to `DATA_DICTIONARY.md`, and `DEVELOPER_GUIDE.md` to `../DEVELOPER_GUIDE.md`.
- Self-links (line ~304): change `docs.html` / `docs.html?doc=` to `./` / `./?doc=`.
- New post-render step after `marked.parse()`: resolve relative `a[href]` / `img[src]` against `new URL(active.file, location.href)`. This fixes markdown links in both guides; the developer guide's root-relative links would otherwise break under `/docs/`. Skip `#` anchors and absolute URLs.
- [js/cursor-settings.js](js/cursor-settings.js):
  - `resolveDocsHref()` becomes `new URL('../docs/', SCRIPT_URL)`, falling back to `'docs/'`.
  - `isDocsPage()` should match `/docs/` and `/docs/index.html`.
- [js/raw-browser.js](js/raw-browser.js) ~2984: change to `${ROOT}docs/?doc=sentinel`.
- [index.html](index.html) ~1810: change to `docs/?doc=developer#vtsr-methodology` (also update the comment at line 17).
- Comment or prose mentions: [README.md](README.md), [js/docs-search.js](js/docs-search.js), [css/vtstats-theme.css](css/vtstats-theme.css), [css/odf-guide.css](css/odf-guide.css), [odf/guide/index.html](odf/guide/index.html), [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md), project-overview.mdc.

## 3. Delete fable/ (keep elo/analysis as the living document)
- Before deleting, compare fable's verdict and its "Ranked improvements 1-9" against `elo/analysis/index.html` §13 Roadmap and §14 History. If an item is neither shipped nor covered, add one line to §14 so nothing is lost.
- Delete `fable/` (1.7 MB).
- Citation [78] in [elo/analysis/index.html](elo/analysis/index.html): replace the `../../fable/index.html` local-copy pill with a permalink, `https://github.com/sevsunday/vt-stats/tree/9c17d270b2e4b7fe008cb685c0d2f966b1a9c1b4/fable`, labeled like the retired markdown editions. Make the same edit by hand in [critique/publications/sources.json](critique/publications/sources.json) and [critique/publications/manifest.json](critique/publications/manifest.json); no script generates these pills.
- Update path mentions to "June 2026 fable review (git history)" in `scripts/elo.py`, `scripts/validate_elo.py`, `scripts/process_stats.py`, `js/app.js`, `js/player.js`, `DEVELOPER_GUIDE.md` and `critique/decisions/phase-3-rank-scoring.md`. The decision memos keep their prose; only the path becomes the permalink.
- After this, analysis material lives in exactly two places: `elo/analysis/` (the document) and `critique/` (decision memos, the served source archive, the cited `.docx`, and the redirect at `critique/web/`). All of `critique/` stays.

## 4. Underscore folders
- **Delete** `_odf-browser-seed/` (38 MB) and `_odf-parser-seed/` (18 MB). The ODF port is complete and only provenance comments mention them.
  - Drop the stale `/odf-parser-seed` line from `.gitignore`.
  - Remove the "Reference seed: odf-browser-seed/ (slated for deletion)" sentences from project-overview.mdc and DEVELOPER_GUIDE.md.
- **Delete** from `_map-analysis/`: `archive/` (332 MB), `shellmaps/` (107 MB) and `calibration/staging/` (192 MB).
  - Add `/_map-analysis/calibration/staging/` to `.gitignore`. It is regenerated output from `render_overlays.py`.
  - Update `_map-analysis/README.md` where it describes those folders.
  - Leave the live code alone: `render/`, `scripts/`, `calibration/configs` + `map_data`, `vsrmaplist/`, `reference-repos/`.
- **Keep as labs, untouched:** `_investigation/` and `_validation/` (both gitignored), `_axis-analysis/`, `_object-render/`, `_ui-cursor/` (its DDS feeds `scripts/build_cursor_sprite.py`), and `f9stats/` (the import source).
- Note for you: `f9bomber/` is a gitignored local clone (9 MB) that only you can decide to delete. Deleting tracked files does not shrink git history or clone size without a history rewrite.

## 5. Reorganize .cursor/plans
Root plans stay where they are. Retired folders: `dev/`, `fun/`, `gamewatch/`, `general/`. New folders: `players/`, `weapons/`, `explorer/`, `ui/`, `docs/`, `gw/`. Use `git mv` for every move.
- `dev/statsgate_proto_v3_migration`, `dev/statsgate_roster_union_fix`, `general/core_data_update` -> `pipeline/`
- `general/docs_and_rules_refresh` -> `docs/`
- `general/topnav_consolidation`, `fun/premium_glassmorphic_theme` -> `ui/`
- `general/active_game_indicator`, `fun/sniper-picker-game`, `matches/balonce_meter_rollout` -> `tools/`
- `gamewatch/game_watch_page` -> `gw/`
- `elo/player_profile_pages`, `elo/coaching_copy_+_ranking_overhaul` -> `players/`
- `models/game_explorer_sandbox` -> `explorer/`
- `odf/hellfire_ground_fire_visuals`, `odf/weapons_lab_weave`, `odf/weapons_library_category` -> `weapons/`
- `matches/smooth_replay_playback` -> `replays/`
- `maps/map-thumb-modal-rename`, `replays/youtube_vod_timestamp_sync` -> `matches/`
- `pipeline/prefetch-map-images` -> `maps/`
- **Promote to root** (not yet implemented): `elo/players_grid_list_view_toggle_7a83c025`, `pipeline/match_dedup_co-submitters_e92d5507`
- **Delete** the superseded draft `pipeline/match_dedup_co_submitters_14057395`

Tidy stale todo statuses so the archive reads as done. Mark these completed (the code has shipped):
- `tools/balonce_meter_rollout`
- `models/scale_object_render_all_models`
- `elo/vtsr-t-commander-role-adjustment`
- `elo/all_matches_&_vtsr_overhaul`
- `tools/tools-page-lobby-utilities` (its phase-5 todo)
- `raw/lazy-projected_rows_bulk` (its verify todo)

For `ui/topnav_consolidation`: mark it complete if the gear merge has shipped, otherwise promote it to root.

Fix live references to plan paths:
- project-overview.mdc line 18 -> `.cursor/plans/tools/tools-page-lobby-utilities_0b86d232.plan.md`
- `critique/decisions/vtsr-c-v2-composite.md` line 268 -> `elo/commander_stats_overhaul_...`
- `js/raw-browser.js` line 52 -> `raw/lazy-projected_rows_bulk_...`
- `scripts/process_stats.py` line 930 -> `matches/match-highlights-section_*`

Cross-links between archived plans are left as they are.

## 6. Scrub deleted replay/positioning scripts from docs
`js/timeline-player.js` and `js/positioning-player.js` no longer exist; the Replay tab is the iframe 3D replay (see `js/app.js` ~2515).
- Rewrite the references in [.cursor/rules/styling.mdc](.cursor/rules/styling.mdc) (JS load order and Tab Navigation bullets), project-overview.mdc (architecture item 2 plus the "Replay player" / "Positioning player" key-file bullets), [.cursor/rules/filter-contract.mdc](.cursor/rules/filter-contract.mdc), [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) (8 refs), [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) (2 refs) and the comment in `js/raw-browser.js` ~2844.

## 7. Shrink AGENTS.md to a thin pointer (do this last)
- AGENTS.md (168 KB) and project-overview.mdc (129 KB) are both always applied, so roughly 300 KB of overlapping context loads into every agent session.
- First, diff AGENTS.md "Key Conventions" and "Deep Reference" against project-overview.mdc, data-schema.mdc, filter-contract.mdc and DEVELOPER_GUIDE.md. Move any fact found only in AGENTS.md into the right rule file.
- Then rewrite AGENTS.md as about 60 lines, modeled on [CLAUDE.md](CLAUDE.md): the project one-liner, "Before Making Any Change", the rule-file table, a short Deep Reference index (path plus one line each), and the "When Schema Changes" checklist.
- Update CLAUDE.md wording so it points at the rules as the source of truth.

## Verification
- `rg` outside `.cursor/plans/` returns no hits for `docs\.html`, `raw\.html`, `fable/`, `odf-browser-seed`, `timeline-player`, `positioning-player`.
- With `python scripts/dev_server.py` running:
  - `/docs/` and `/docs/?doc=developer` render, KaTeX math displays, search works, and in-doc links resolve.
  - The Settings gear's Docs link works from `index.html` and from a nested page (`elo/analysis/`, `odf/guide/`).
  - The raw browser's "why?" link opens the sentinel doc.
  - The 3D replay, map viewer and `/explorer` still load (`_map-analysis/render` untouched).
  - Citation [78] links resolve.
- `git status` shows only the intended moves and deletes.