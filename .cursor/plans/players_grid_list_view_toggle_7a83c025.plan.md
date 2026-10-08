---
name: Players grid/list view toggle
overview: Add a grid/list view toggle to the Players directory with a one-time "set my default" modal on the first switch to list, persisting the choice in localStorage and pre-empting first-paint to avoid a gallery flash.
todos:
  - id: preempt
    content: Add pre-paint inline script in player/index.html <head> reading vt-player-view-pref
    status: pending
  - id: toolbar
    content: Add view toggle btn-group in the main toolbar row of player/index.html (outside the filter offcanvas)
    status: pending
  - id: modal
    content: Add the 'Set your default view' Bootstrap modal markup at the bottom of <main>
    status: pending
  - id: css
    content: Extend css/player.css with [data-player-view="list"] layout overrides + toolbar btn-group styling
    status: pending
  - id: state
    content: Extend state in js/player.js with viewMode + viewModalDismissed; boot reads localStorage and sets data attribute
    status: pending
  - id: setviewmode
    content: Add setViewMode() helper handling toggle clicks and conditional modal trigger
    status: pending
  - id: wire
    content: Wire toolbar toggle + modal footer buttons in wireDirectoryEvents/boot, persist localStorage on choice
    status: pending
isProject: false
---

## Goal

Add a Grid (default) / List view toggle to the Players directory page with:

- A first-time prompt (Bootstrap modal) when the user switches to list view, asking which mode to use as their default.
- "Don't ask me again" checkbox, **checked by default**.
- Preference persisted in `localStorage`.
- A pre-paint inline script so a returning user with `pref === 'list'` never sees a flash of gallery layout.

## LocalStorage contract

- `vt-player-view-pref` — `"grid"` | `"list"`. Read at every load. **Only written by an explicit choice in the modal.** Clicking the toolbar toggle does NOT write it on its own (the toggle is session-only, just like `vt-career-cols-view` style transient prefs are user-driven, but here we mirror the user's request: persistence happens through the modal). If the user has already set a pref, subsequent toolbar clicks update both the live view and the saved pref so the toggle stays a real "set my default" control after the first prompt.
- `vt-player-view-modal-dismissed` — `"1"` once the user has checked "Don't ask me again" and clicked either modal button. Never shown again afterwards.
- Both keys read defensively in `try/catch` (mirrors the existing `vt-landing-pref` cleanup at [`js/app.js:217`](js/app.js)).

## Visual design — list view

- CSS-only layout swap. Same `.vt-player-card` HTML; `[data-player-view="list"]` on `<html>` reorients the card from vertical to horizontal:
  - `.vt-player-grid` becomes a single column with vertical gap.
  - `.vt-player-card` becomes a flex row with priority order: tier badge | name | VTSR-T | role pill | ship pill | matches | sparkline (fixed width) | last delta.
  - Hides the small "VTSR-T" / "Peak" labels and the per-card stack chrome that only makes sense in card form.
  - Compare-mode checkbox stays in the upper-left corner via the existing absolute positioning.
- One CSS file edit: [`css/player.css`](css/player.css). No new files.

## File-by-file changes

### 1. Pre-paint guard in [`player/index.html`](player/index.html)

Add a tiny inline `<script>` at the end of `<head>` (after the stylesheet links) that reads `vt-player-view-pref` and sets `document.documentElement.dataset.playerView = 'list'` when applicable. This runs before any CSS-driven layout reads the attribute, eliminating the gallery flash.

```html
<script>
  (function () {
    try {
      if (localStorage.getItem('vt-player-view-pref') === 'list') {
        document.documentElement.dataset.playerView = 'list';
      }
    } catch (_) { /* private mode / blocked storage — ignore */ }
  })();
</script>
```

### 2. Toolbar toggle + modal markup in [`player/index.html`](player/index.html)

- Insert a small `btn-group` view toggle in the main toolbar row (next to the search input, **outside** the `.offcanvas-md` filter panel so it's always visible on mobile too — view mode is not a filter):

```html
<div class="btn-group btn-group-sm vt-player-view-toggle" role="group" aria-label="View mode">
  <button type="button" class="btn vt-player-view-btn" data-view="grid"
          aria-pressed="true" title="Grid view">
    <i class="bi bi-grid-3x3-gap-fill"></i>
  </button>
  <button type="button" class="btn vt-player-view-btn" data-view="list"
          aria-pressed="false" title="List view">
    <i class="bi bi-list-ul"></i>
  </button>
</div>
```

- Append the prompt modal at the bottom of `<main>` (before `</main>`) — Bootstrap modal pattern matching the project conventions used in [`index.html`](index.html) and [`odf/index.html`](odf/index.html):

```html
<div class="modal fade" id="vt-player-view-pref-modal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title"><i class="bi bi-eye me-2"></i>Set your default view</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <p class="mb-3">Always open Players in this layout from now on?</p>
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="vt-player-view-pref-dismiss" checked>
          <label class="form-check-label" for="vt-player-view-pref-dismiss">
            Don't ask me again
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-pref="grid">
          <i class="bi bi-grid-3x3-gap-fill me-1"></i>Default to Gallery
        </button>
        <button type="button" class="btn btn-primary" data-pref="list">
          <i class="bi bi-list-ul me-1"></i>Default to List
        </button>
      </div>
    </div>
  </div>
</div>
```

### 3. CSS list-view styling in [`css/player.css`](css/player.css)

Add a section after the existing `.vt-player-grid` / `.vt-player-card` blocks (around line 489) gated on `[data-player-view="list"]`:

- `.vt-player-grid` → `display: flex; flex-direction: column; gap: 0.4rem;`
- `.vt-player-card` → `flex-direction: row; align-items: center; gap: 0.85rem; padding: 0.55rem 0.85rem;`
- `.vt-player-card-head` → name only (tier badge moves to its own column).
- `.vt-player-card-rating-big` → smaller font, fixed-width column.
- `.vt-player-card-rating-label` → `display: none`.
- `.vt-player-card-spark` → `width: 130px; min-width: 130px; margin: 0;` (no `margin-top: auto`, no full-row height).
- `.vt-player-card-foot` → inline column for matches + delta, `flex: 0 0 auto`.
- `.vt-player-card-meta` → row, single line, ellipsis on overflow.
- Mobile breakpoint (`@media (max-width: 575.98px)`): hide the spark + meta pills in list mode, keep tier / name / VTSR-T / matches.
- Toolbar styles for the new `.vt-player-view-toggle` btn-group: theme-token border, `aria-pressed="true"` gets `--kb-primary` background, idle state uses muted text (mirrors the rest of the toolbar's pill chrome, see existing `.vt-player-compare-toggle` styling).

### 4. JS wiring in [`js/player.js`](js/player.js)

Five small additions, all inside the existing IIFE — no public API changes.

a. **State** (extend `state` block around line 79):
   - `state.viewMode = 'grid'` (default; overwritten in boot if pref is set).
   - `state.viewModalDismissed = false`.

b. **Boot** (in `boot()` around line 3322): read both keys early, mirror the pre-paint guard:

```js
try {
  state.viewMode = localStorage.getItem('vt-player-view-pref') === 'list' ? 'list' : 'grid';
  state.viewModalDismissed = localStorage.getItem('vt-player-view-modal-dismissed') === '1';
} catch (_) {}
document.documentElement.dataset.playerView = state.viewMode;
```

c. **Toolbar toggle handler** (in `wireDirectoryEvents()` around line 3242):
   - Cache `dom.viewToggle` in `cacheDom()`.
   - Click handler reads `data-view`, calls `setViewMode(target, { fromToggle: true })`.

d. **`setViewMode(mode, opts)`** — new helper (next to `setCompareMode` at line 440):
   - Updates `state.viewMode`, `<html>` `data-player-view`, and `aria-pressed` on both toggle buttons.
   - If `mode === 'list'`, `opts.fromToggle === true`, and `!state.viewModalDismissed` and the user has no saved pref yet → open the modal via Bootstrap's `Modal.getOrCreateInstance(...)`.
   - If the user already has a saved pref (i.e. they've been through the modal), every subsequent toggle click writes the new mode straight to `vt-player-view-pref` so the toggle continues to behave as a "set my default" control with no further prompts.

e. **Modal handler** (wired once in `boot()`):
   - Both footer buttons read `data-pref` ("grid" | "list"), the checkbox, then:
     - Always: write `vt-player-view-pref = data-pref`.
     - If checkbox checked: write `vt-player-view-modal-dismissed = '1'` and update `state.viewModalDismissed`.
     - Apply the chosen mode via `setViewMode(pref)` and hide the modal.
   - The `[data-bs-dismiss="modal"]` close button and backdrop click do nothing persistent — the live view stays in list (since the user clicked list to trigger it), but no pref is saved, so they'll be prompted again on the next switch.

## Edge cases handled

- Private/blocked storage: every `localStorage` access is wrapped in `try/catch`; the toggle still works in-session.
- Existing visitors with `vt-player-view-pref === 'list'` (returning users in the future): pre-paint guard fires, JS boot reads pref, no modal.
- Compare-mode + list-view: same `[data-compare-mode="true"]` ring + checkbox already work because the card markup is unchanged.
- Sort / search / chip filters: untouched — `renderDirectoryGrid()` only re-emits cards; layout is purely CSS-driven off `[data-player-view]`.
- Theme switching: tokens-only CSS already adapts; no theme-specific code needed.
- No pipeline, schema, or data-contract changes — pure UI layer.