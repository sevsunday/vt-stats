---
name: map-thumb-modal-rename
overview: Enlarge the match-info map thumbnail to 70x70 and make it open a Bootstrap modal with the larger image plus all available map metadata (registry + this-match terrain). Also rename the "Crate/Pod Goblin" highlight to "Pod Goblin".
todos:
  - id: css-resize
    content: Bump `.vt-map-thumb` to 70x70 + add cursor:pointer / hover lift in css/vtstats-theme.css
    status: completed
  - id: html-wrap
    content: "Wrap #info-map-thumb in a button trigger and add #map-info-modal markup in index.html"
    status: completed
  - id: renderer
    content: Extend renderMapBannerFields() in js/app.js to populate the modal (image, title, registry+this-match metadata)
    status: completed
  - id: pipeline-rename
    content: Rename label in scripts/process_stats.py HIGHLIGHTS_LABELS + bump PIPELINE_VERSION 2 -> 3
    status: completed
  - id: docs-sync
    content: Update 'Crate/Pod Goblin' -> 'Pod Goblin' in project-overview.mdc, AGENTS.md, DEVELOPER_GUIDE.md, docs/DATA_DICTIONARY.md
    status: completed
  - id: reprocess
    content: Run `python scripts/process_stats.py` to refresh every cached JSON with the new label
    status: completed
isProject: false
---

## 1. Map thumbnail: 70x70 + clickable modal

### CSS resize
Edit [css/vtstats-theme.css](css/vtstats-theme.css) `.vt-map-thumb` (around line 2354): bump `width` and `height` from `48px` to `70px`. Add `cursor: pointer` and a subtle hover state (border highlight + slight `translateY(-1px)` matching `.vt-match-picker-trigger`) so the new clickability is discoverable.

### Markup wiring
In [index.html](index.html) line 141, wrap (or convert) `#info-map-thumb` so it triggers a new modal:

```html
<button id="info-map-thumb-btn" type="button"
        class="vt-map-thumb-btn d-none p-0 border-0 bg-transparent"
        data-bs-toggle="modal" data-bs-target="#map-info-modal"
        aria-label="View map details">
  <img id="info-map-thumb" class="vt-map-thumb" alt="" decoding="async" loading="lazy">
</button>
```

(Move the `d-none` toggle from the `<img>` to the wrapping `<button>` so `renderMapBannerFields()` continues to hide the whole control when no image is available.)

### New modal
Add a new `#map-info-modal` immediately after `#match-picker-modal` in [index.html](index.html) (around line 1190). Use the existing modal patterns (`modal fade`, `modal-dialog modal-dialog-centered`, `modal-lg`):

- Header: `<h5 class="modal-title" id="map-info-modal-title">—</h5>` (filled by JS with the registry title, falls back to match `info.name`).
- Body: a two-column responsive layout (`row g-3`):
  - Left column: large `<img id="map-info-modal-image">` (full-resolution map png, max-width 100%, square aspect via CSS).
  - Right column: a stat list rendered into `<div id="map-info-modal-meta"></div>` by JS (description, author, canonical size, canonical base-to-base, mod ID, plus this-match values: terrain size, elevation, empirical base-to-base, team names from `net_vars.svar1` / `svar2` when present).
- Footer: standard close button.

### Renderer
In [js/app.js](js/app.js), extend `renderMapBannerFields()` (around line 3238). Re-use the already-resolved `meta = getMapMeta(info)` and pull the raw registry entry (the function already does `mapRegistry[key]` internally — expose it via a small refactor or fetch it again here):

- Toggle the `d-none` class on the new `#info-map-thumb-btn` (instead of the `<img>`).
- Populate `#map-info-modal-title` (`meta.title || info.name || meta.key`).
- Populate `#map-info-modal-image.src` from `'data/' + meta.imagePath` when present; hide the image column when not.
- Build the meta block as a `<dl>` of label/value pairs from these sources (only show rows whose value is present, mirroring how the banner already renders `—` gracefully):
  - Registry: `description` (rendered with `\r?\n` -> `<br>` and `\ufeff` stripped, via `esc()` first), `author`, `canonical_size`, `canonical_b2b`, `mod_resolved` (link to `https://steamcommunity.com/sharedfiles/filedetails/?id=<id>` when numeric), `net_vars.svar1` / `svar2` as "Team 1 name" / "Team 2 name".
  - This-match (already in `meta`): `terrainSize`, `elevation`, `empiricalB2B`.
- Call this populate step every time `renderMapBannerFields()` runs so the modal stays in sync on match switches.

No event listeners needed — Bootstrap's `data-bs-toggle="modal"` handles open/close. Keep the modal hidden when `meta.imagePath` is falsy by also adding `d-none` to the trigger button (the modal markup itself can stay in the DOM).

## 2. Rename Crate/Pod Goblin -> Pod Goblin

### Pipeline change
Edit [scripts/process_stats.py](scripts/process_stats.py):
- Line 47: bump `PIPELINE_VERSION = 2` to `3` (per AGENTS.md: "Bump `PIPELINE_VERSION` whenever ... highlights ... changes output semantics" — covers the label change so cached entries auto-reprocess on next run).
- Line 363: change `"crate_pod_goblin": ("Crate/Pod Goblin", "bi-box-seam")` to `"crate_pod_goblin": ("Pod Goblin", "bi-box-seam")`.
- Line 748 comment: update `# ---- Crate/Pod Goblin: ...` to `# ---- Pod Goblin: ...` for consistency.

The `category` id stays `crate_pod_goblin` (stable JSON key, referenced by `HIGHLIGHT_COPY` / `HIGHLIGHT_UNITS` / `formatHighlightBreakdown()` in [js/app.js](js/app.js)). Only the human-facing `label` changes.

### Docs sync
Update the user-facing string in:
- [.cursor/rules/project-overview.mdc](.cursor/rules/project-overview.mdc) (the 12-card list mentions "Crate/Pod Goblin").
- [AGENTS.md](AGENTS.md) (same 12-card list).
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) (12-card list line 838).
- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md) (multiple references: §5 highlights catalog row 10, glossary "Crate/Pod Goblin (Highlight)", and the prose mention near line 1856).

Leave the snake_case id `crate_pod_goblin` everywhere it appears in code/docs (it's the stable category key), and leave the historical plan file under `.cursor/plans/` untouched (it's a frozen snapshot).

## 3. Manual follow-up

After applying the diffs, you (or me, if you give the go-ahead) need to run `python scripts/process_stats.py` once. Because `PIPELINE_VERSION` was bumped, every cached match's `pipeline_version` will mismatch and get reprocessed automatically — no `--force` flag needed. After it finishes, every `data/processed/*.json` will carry `"label": "Pod Goblin"`.