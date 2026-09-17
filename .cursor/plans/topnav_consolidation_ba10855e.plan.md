---
name: topnav consolidation
overview: "Declutter the topnav: fold the dashboard's Share / Live sync / About(info) utility buttons into the existing gear Settings menu, and convert the ELO nav item into a dropdown listing ELO + Players (removing the standalone Players link) across every shell, template, and pre-gen stub. Theme stays its own dropdown."
todos:
  - id: elo-dropdown
    content: Convert ELO into a dropdown (ELO + Players) and remove the standalone Players link across index.html (desktop + mobile), all 9 standalone shells, and both pre-gen templates; set correct active state on elo/ and player/ directory shells; add .vt-nav-caret CSS.
    status: pending
  - id: gear-merge
    content: "In js/cursor-settings.js, relocate #share-url-btn / #live-sync-toggle / #about-btn into a new 'This page' section at the top of the gear panel (move nodes to preserve handlers; synthesize a label for the icon-only About; idempotent + no-op on shells without them; FOUC guard)."
    status: pending
  - id: gear-css
    content: Add .vt-settings-navitem (full-width dropdown row) styling to css/vtstats-theme.css next to the existing .vt-settings-* rules.
    status: pending
  - id: templates-regen
    content: Bump PLAYER_TEMPLATE_VERSION 13->14 and MAP_TEMPLATE_VERSION 8->9; regenerate all stubs via python scripts/process_stats.py --no-sync --no-prompt.
    status: pending
  - id: docs
    content: Update canonical topnav order + Players-in-ELO-dropdown + gear-holds-sharing notes in .cursor/rules/project-overview.mdc and AGENTS.md.
    status: pending
  - id: verify
    content: "Browser-verify: dashboard gear (Share/Live sync/About + cursor) works; ELO dropdown lists ELO+Players; Players removed as standalone; spot-check a standalone shell + regenerated player/map stub."
    status: pending
isProject: false
---

# Topnav consolidation

Two independent changes. Theme stays a separate dropdown (per decision). Record stays its own item.

## Current state (research)

- Dashboard-only utility buttons live in `.vt-nav-menu` in [index.html](index.html): `#share-url-btn` (Share, ~L229), `#live-sync-toggle` (Live sync, ~L233), `#about-btn` (About / info, `bi-info-circle`, ~L248). Their click handlers are bound by id in [js/app.js](js/app.js) (`copyShareUrl` / live-sync toggle) and About is a pure `data-bs-toggle="modal"` -> `#about-modal`.
- The **gear** is injected at the end of `.vt-nav-menu` on every page by [js/cursor-settings.js](js/cursor-settings.js) `buildPanel()` (dropdown with `data-bs-auto-close="outside"`). Standalone shells have no Share/Live-sync/About, so nothing moves there.
- `[data-theme-menu]` (Theme) stays as-is.
- ELO + Players are adjacent nav links on every shell: [index.html](index.html) desktop (~L112 Players, ~L120 ELO) + mobile (~L201 Players, ~L208 ELO); standalone shells [docs.html](docs.html), [raw.html](raw.html), [odf/index.html](odf/index.html), [models/index.html](models/index.html), [lego/index.html](lego/index.html), [map/index.html](map/index.html), [player/index.html](player/index.html), [elo/index.html](elo/index.html), [tools/index.html](tools/index.html), [gw/index.html](gw/index.html); templates [scripts/player_template.html](scripts/player_template.html), [scripts/map_template.html](scripts/map_template.html) (paths `../../`).

## 1. Fold Share / Live sync / About into the gear (dashboard)

Relocate the existing DOM nodes (preserves the id-bound app.js handlers) rather than recreate them. In [js/cursor-settings.js](js/cursor-settings.js) `buildPanel()`, after `menu.appendChild(wrap)`, add a `relocatePageControls(panel)` step:

- Query `#share-url-btn`, `#live-sync-toggle`, `#about-btn`. For each that exists, move the node into a new "This page" section prepended to the top of `.vt-settings-panel` (above the Custom cursor section).
- Wrap/relabel: add class `vt-settings-navitem` so each renders as a full-width dropdown row; for icon-only About, append a text label from its `aria-label` so it reads "About / source repositories".
- Generic + idempotent: on shells without these ids nothing happens (gear stays cursor-only). Runs on `DOMContentLoaded`; moving nodes keeps their listeners, so order vs app.js is irrelevant.
- FOUC guard: mark the three buttons with a `hidden`-ish pending class in [index.html](index.html) (or set them `hidden` and unhide on relocation) so they don't flash in the nav before the move.

CSS in [css/vtstats-theme.css](css/vtstats-theme.css) (where the other `.vt-settings-*` rules live): add `.vt-settings-navitem` (full-width, left-aligned, icon + label row, hover state) + a `.vt-settings-section-title` reuse for the "This page" header.

Net dashboard nav: Record - Docs - ODF - Models - LEGO - Maps - ELO(v) - Tools - Theme - Settings(gear: Sharing + cursor).

## 2. Convert ELO into a dropdown (ELO + Players); remove standalone Players

Replace the ELO `<a>` with a Bootstrap dropdown and delete the sibling Players `<a>`, on every shell + template + both index.html blocks. Trigger keeps the trophy icon + "ELO" label + a caret; menu lists ELO then Players:

```html
<div class="dropdown vt-nav-dropdown"> <!-- + responsive classes per shell -->
  <button class="vt-nav-icon-btn" type="button" data-bs-toggle="dropdown"
          data-bs-auto-close="true" aria-label="Ratings and players">
    <i class="bi bi-trophy me-1"></i>ELO <i class="bi bi-chevron-down vt-nav-caret"></i>
  </button>
  <ul class="dropdown-menu dropdown-menu-end">
    <li><a class="dropdown-item" href="<PREFIX>elo/"><i class="bi bi-trophy me-2"></i>ELO</a></li>
    <li><a class="dropdown-item" href="<PREFIX>player/"><i class="bi bi-people me-2"></i>Players</a></li>
  </ul>
</div>
```

- Per-shell `<PREFIX>`: `""` (root: index.html/docs.html/raw.html), `"../"` (odf/models/lego/map/player/elo/tools/gw), `"../../"` (templates).
- index.html has two blocks: desktop dropdown carries `d-none d-md-inline-flex order-md-1`; mobile carries `d-md-none`.
- Active state: on [elo/index.html](elo/index.html) mark the ELO `dropdown-item` + trigger `.active`; on [player/index.html](player/index.html) mark the Players `dropdown-item` + trigger `.active`; player pre-gen stubs ([scripts/player_template.html](scripts/player_template.html)) do NOT mark active (they are profiles, not the directory) - match current behavior.
- Minimal CSS: `.vt-nav-caret` sizing; reuse existing `.dropdown-item` theme styling (already used by the Theme menu).

## 3. Template version bumps + stub regen

Bump `PLAYER_TEMPLATE_VERSION` 13 -> 14 ([scripts/generate_player_pages.py](scripts/generate_player_pages.py)) and `MAP_TEMPLATE_VERSION` 8 -> 9 ([scripts/generate_map_pages.py](scripts/generate_map_pages.py)); regenerate all stubs via `python scripts/process_stats.py --no-sync --no-prompt`.

## 4. Docs

Update the canonical topnav order + Players-in-ELO-dropdown note in `.cursor/rules/project-overview.mdc` and `AGENTS.md` (the "Models - Maps - Players - ELO - Tools" convention lines), and note the gear now also holds Share / Live sync / About on the dashboard.

## 5. Verify

Serve with `python scripts/dev_server.py`; on the dashboard confirm the gear now contains Sharing (Share/Live sync/About) + cursor settings and that Share copies / Live sync toggles / About opens its modal from inside the gear; confirm the ELO dropdown lists ELO + Players and Players is gone as a standalone item; spot-check a standalone shell and a regenerated player + map stub.

## Notes

- Standalone shells only had Theme + gear; they are unaffected by step 1 (nothing to fold) - the visible declutter there is just ELO absorbing Players.
- No pipeline/schema interaction; template-version bumps are HTML-shape-only (same precedent as the LEGO nav rollout).