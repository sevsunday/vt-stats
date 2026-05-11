/**
 * VT Stats Dashboard - Main Application
 *
 * Loads pre-computed match stats from data/processed/ and renders
 * all dashboard panels. No raw event parsing happens in the browser.
 *
 * Tab-based lazy rendering: only the active tab renders on match load.
 * Other tabs render on first activation via Bootstrap shown.bs.tab event.
 *
 * Global player/team filter: getFilteredData() derives filtered views from
 * loaded JSON. weapon_meta is recomputed client-side when filtering.
 * kills.by_vehicle is always unfiltered (match-global aggregate).
 */

(async function () {
  const $loading = document.getElementById('loading');
  const $dashboard = document.getElementById('dashboard');
  const $allView = document.getElementById('all-matches-view');

  // --- Match picker DOM handles ---
  // Two twin triggers (one per hero card) + a shared XL modal containing
  // the rich card grid. Both triggers reflect the same `currentTarget`
  // (either a manifest entry or the sentinel string '__all__') via
  // updateMatchPickerTriggers().
  const $trigger        = document.getElementById('match-picker-trigger');
  const $triggerAll     = document.getElementById('match-picker-trigger-all');
  const $triggerName    = document.getElementById('trigger-name');
  const $triggerNameAll = document.getElementById('trigger-name-all');
  const $triggerSub     = document.getElementById('trigger-sub');
  const $triggerSubAll  = document.getElementById('trigger-sub-all');
  const $pickerModalEl  = document.getElementById('match-picker-modal');
  const $pickerGrid     = document.getElementById('match-picker-grid');
  const $pickerEmpty    = document.getElementById('match-picker-empty');
  const $pickerEmptyText  = document.getElementById('match-picker-empty-text');
  const $pickerEmptyClear = document.getElementById('match-picker-empty-clear');
  const $pickerSearch   = document.getElementById('match-picker-search');
  // Phase 2: filter toolbar DOM.
  const $triggerBadge       = document.getElementById('trigger-badge');
  const $triggerBadgeAll    = document.getElementById('trigger-badge-all');
  const $filtersRoot        = document.getElementById('match-picker-filters');
  const $filtersToggle      = document.getElementById('match-picker-filters-toggle');
  const $filtersBadgeInline = document.getElementById('match-picker-filters-badge-inline');
  const $filtersBody        = document.getElementById('match-picker-filters-body');
  const $sortSelect         = document.getElementById('match-picker-sort');
  const $resultCount        = document.getElementById('match-picker-result-count');
  const $clearBtn           = document.getElementById('match-picker-clear');
  const $facetDuration      = $filtersBody && $filtersBody.querySelector('[data-facet="duration"]');
  // `$facetPlayerCounts` is the multi-select chipset for `manifest[].player_count`.
  // (Was named `$facetPlayers` in v1; renamed for symmetry with the v2
  // state shape — `pickerState.playerCounts` — and to free up the
  // "Players" name for the new full-roster chipset below.)
  const $facetPlayerCounts  = document.getElementById('match-picker-facet-players');
  const $facetSubmitters    = document.getElementById('match-picker-facet-submitters');
  // New full-roster Players chipset + its search input + Match-mode and
  // Role toggle button groups. Replaces the old Commanders block; see
  // index.html .vt-match-picker-filter-row--players.
  const $facetPlayers       = document.getElementById('match-picker-facet-players-roster');
  const $playersSearch      = document.getElementById('match-picker-players-search');
  const $playersModeBtns    = $filtersBody && $filtersBody.querySelectorAll('[data-match-mode]');
  const $playersRoleBtns    = $filtersBody && $filtersBody.querySelectorAll('[data-role]');
  // Bootstrap Modal instance (lazy-initialized on first trigger click). We
  // hold a reference so card-click handlers can programmatically dismiss.
  let pickerModalInstance = null;

  // Current selection target. '__all__' for the aggregate view, otherwise
  // the manifest entry object (not just its id/file — we need name + sub
  // text for the trigger). null before boot completes.
  let currentTarget = null;

  // Picker filter + sort state. All AND-combine with each other and with
  // the free-text search. Persisted in sessionStorage under the
  // vt.picker.filters.v2 key (v1 is migrated on read; see
  // loadPickerStateFromStorage); cleared on tab close.
  //
  // v2 collapses the old `commanders` + `versusMode` pair into a richer
  // `players` + `matchMode` + `role` triple. The chip list now spans the
  // full roster (every name in any match's `players[]`) and a global Role
  // toggle constrains *how* the selected names need to appear:
  //   role='any'        -> anywhere in the match (commander or thug)
  //   role='commander'  -> selected names must be in `team_leaders`
  //   role='thug'       -> selected names must be in roster but NOT command
  // matchMode is the presence axis ('any' = some present, 'all' = every).
  const PICKER_STATE_KEY = 'vt.picker.filters.v2';
  const PICKER_STATE_KEY_V1 = 'vt.picker.filters.v1';
  // `playerCounts` is the multi-select facet for `manifest[].player_count`
  // (was named `players` in v1; the new `players` field is the roster
  // chipset, so this got a more specific name to avoid the collision).
  const DEFAULT_PICKER_STATE = () => ({
    query: '',
    duration: 'any',                // 'any' | 'short' (<10m) | 'medium' (10-20m) | 'long' (>=20m)
    playerCounts: [],               // array of player_count numbers; empty = any
    submitters: [],                 // array of submitter strings; empty = any
    players: [],                    // array of nickname strings (full roster); empty = any
    matchMode: 'any',               // 'any' | 'all' — presence test against `players`
    role: 'any',                    // 'any' | 'commander' | 'thug'
    sort: 'date-desc',
  });
  let pickerState = DEFAULT_PICKER_STATE();

  const MATCH_TAB_SLUGS = {
    overview:    'tab-overview-btn',
    combat:      'tab-combat-btn',
    rivalries:   'tab-rivalries-btn',
    weapons:     'tab-weapons-btn',
    assets:      'tab-assets-btn',
    positioning: 'tab-positioning-btn',
    replay:      'tab-replay-btn',
  };
  const ALL_TAB_SLUGS = {
    overview:          'all-tab-overview-btn',
    'weapons-rivalries': 'all-tab-weapons-btn',
    commanders:        'all-tab-commanders-btn',
    meta:              'all-tab-meta-btn',
  };

  function btnIdToSlug(btnId) {
    for (const [slug, id] of Object.entries(MATCH_TAB_SLUGS)) { if (id === btnId) return slug; }
    for (const [slug, id] of Object.entries(ALL_TAB_SLUGS))   { if (id === btnId) return slug; }
    return null;
  }

  // --- URL State ---
  // URL schema:
  //   ?match=<id>|all   (omitted => load first match)
  //   ?filter=all|team|player
  //   ?team=1|2         (only when filter=team)
  //   ?players=<csv>    (only when filter=player; tokens may be canonical names or Steam64 IDs)
  //   ?tab=<slug>       (omitted or 'overview' => default)
  //   ?t=<tick>         (initial-load Replay seek target — see comment below)
  //
  // Picker filter axis (separate from per-match filter/team/players above).
  // Each field hydrates `pickerState` and is omitted from the URL whenever
  // its value matches the default. Multi-selects are CSV. `roster` is the
  // picker's full-roster nickname filter — deliberately distinct from the
  // per-match `players` param above.
  //   ?q=<text>            (free-text search; non-empty)
  //   ?dur=short|medium|long
  //   ?cnt=<csv-of-ints>   (player_count multi-select, e.g. 8,10)
  //   ?sub=<csv>           (submitters multi-select)
  //   ?roster=<csv>        (full-roster nickname multi-select)
  //   ?mode=all            (Match-mode toggle; 'any' is default and omitted)
  //   ?role=commander|thug (Role toggle; 'any' is default and omitted)
  //   ?sort=<picker-sort>  (e.g. duration-desc; 'date-desc' is default and omitted)

  function parseUrlState() {
    const p = new URLSearchParams(window.location.search);
    return {
      match: p.get('match'),
      filter: p.get('filter'),
      team: p.get('team'),
      players: (p.get('players') || '').split(',').map(s => s.trim()).filter(Boolean),
      tab: p.get('tab'),
      // `?t=<tick>` — initial-load-only Replay seek target, produced by the
      // Raw Data Browser's event-stream table row click (see
      // js/raw-browser.js `onEventsBodyClick`). Honored exactly once when
      // the Replay tab first renders for this match; subsequent renders
      // ignore it (the user has already landed and can scrub freely).
      t: p.get('t'),
      // Picker filter axis (separate from per-match filter/team/players).
      // Consumed by hydratePickerStateFromUrl() during init. Each field
      // here is a raw string (or CSV split into an array) — validation
      // against pickerFacets happens in the hydrator, not here.
      picker: {
        q:      p.get('q'),
        dur:    p.get('dur'),
        cnt:    (p.get('cnt') || '').split(',').map(s => s.trim()).filter(Boolean),
        sub:    (p.get('sub') || '').split(',').map(s => s.trim()).filter(Boolean),
        roster: (p.get('roster') || '').split(',').map(s => s.trim()).filter(Boolean),
        mode:   p.get('mode'),
        role:   p.get('role'),
        sort:   p.get('sort'),
      },
    };
  }

  // Resolve URL player tokens (names or Steam64) to canonical leaderboard names.
  // Tokens matching /^\d{16,}$/ are treated as Steam64; otherwise matched by
  // name (case-insensitive). Unresolved tokens are dropped silently.
  function resolvePlayerTokens(tokens, leaderboard) {
    const resolved = [];
    for (const token of tokens) {
      const isSteam64 = /^\d{16,}$/.test(token);
      const match = leaderboard.find(p =>
        isSteam64 ? p.steam64 === token : p.name.toLowerCase() === token.toLowerCase()
      );
      if (match && !resolved.includes(match.name)) resolved.push(match.name);
    }
    return resolved;
  }

  function getActiveTabSlug() {
    const activeBtn = document.querySelector('#match-tabs .nav-link.active, #all-tabs .nav-link.active');
    return activeBtn ? btnIdToSlug(activeBtn.id) : null;
  }

  // --- Live URL Sync ---
  // When off (default), URL writes from in-app state changes are suppressed so
  // the browser URL stays clean. Incoming shared URLs still apply on load.
  // When on, every syncUrl() call rewrites the URL via history.replaceState.
  // Two one-time bypasses exist: setLiveSync(true) catches the URL up to
  // current state on toggle-on, and showMatchNotFound clears stale bad-match
  // URLs on error recovery.
  let liveSyncEnabled = localStorage.getItem('vt-url-sync') === 'true';

  // Pending Replay seek target from `?t=<tick>` on initial page load. Set by
  // loadMatch() when urlState.t is present; consumed once by the Replay tab
  // renderer (and cleared after). See raw-browser.js onEventsBodyClick for
  // the producer (event-stream table row click).
  let pendingReplayTick = null;

  // --- Landing Preferences ---
  // First-visit modal prompts the user to pick a default landing view.
  // Stored as JSON in localStorage under LANDING_PREF_KEY. Schema:
  //   { version: 1, mode: 'ask' | 'recent' | 'all' | 'specific', matchId?: string }
  // Shared links (any URL intent) always bypass this entirely.
  // Default landing view changed from 'recent' to 'all' on 2026-05-08;
  // existing saved prefs preserved deliberately (LANDING_PREF_VERSION not bumped).
  const LANDING_PREF_KEY = 'vt-landing-pref';
  const LANDING_PREF_VERSION = 1;
  const LANDING_MODES = new Set(['ask', 'recent', 'all', 'specific']);

  function readLandingPref() {
    try {
      const raw = localStorage.getItem(LANDING_PREF_KEY);
      if (!raw) return null;
      const pref = JSON.parse(raw);
      if (!pref || pref.version !== LANDING_PREF_VERSION) return null;
      if (!LANDING_MODES.has(pref.mode)) return null;
      return pref;
    } catch {
      return null;
    }
  }

  function writeLandingPref(pref) {
    try {
      localStorage.setItem(LANDING_PREF_KEY, JSON.stringify(pref));
    } catch {
      // Private mode / storage blocked — silently ignore.
    }
  }

  function clearLandingPref() {
    try {
      localStorage.removeItem(LANDING_PREF_KEY);
    } catch {
      // No-op.
    }
  }

  // --- Record-Your-Own-Stats Modal Dismissal ---
  // Instructional popup that walks users through running the statsgate
  // collector. The "Don't show on page load" checkbox is wired as a
  // bidirectional toggle on the persisted flag (see the show.bs.modal /
  // hidden.bs.modal listeners near the boot block): opening the modal
  // always syncs the checkbox FROM the flag, and closing always persists
  // the current checkbox state TO the flag. This means changes made via
  // the navbar re-open path are honored just like changes made on the
  // first-visit auto-open.
  const RECORD_STATS_DISMISSED_KEY = 'vt-record-stats-dismissed';

  function readRecordStatsDismissed() {
    try { return localStorage.getItem(RECORD_STATS_DISMISSED_KEY) === '1'; }
    catch { return false; }
  }
  function writeRecordStatsDismissed() {
    try { localStorage.setItem(RECORD_STATS_DISMISSED_KEY, '1'); }
    catch { /* private mode / storage blocked — silently ignore */ }
  }
  function clearRecordStatsDismissed() {
    try { localStorage.removeItem(RECORD_STATS_DISMISSED_KEY); }
    catch { /* private mode / storage blocked — silently ignore */ }
  }

  // Resolves a landing choice into an actual view load. Always keeps the
  // picker triggers in sync via updateMatchPickerTriggers(), matching the
  // existing URL-driven boot branches. Unknown modes and missing
  // specific-matchIds silently fall back to most recent.
  function applyLandingChoice(choice) {
    const mode = choice && choice.mode;
    if (mode === 'all') {
      updateMatchPickerTriggers('__all__');
      loadAllMatches();
      return;
    }
    if (mode === 'specific' && choice.matchId) {
      const entry = manifest.find(m => m.id === choice.matchId);
      if (entry) {
        updateMatchPickerTriggers(entry);
        loadMatch(entry.file);
        return;
      }
      // Fall through to recent if the saved match is gone.
    }
    if (manifest.length > 0) {
      updateMatchPickerTriggers(manifest[0]);
      loadMatch(manifest[0].file);
    }
  }

  // Populates the auto-filled hint under the "All matches" option with the
  // current corpus snapshot ("Career overview · 47 matches · 14 players ·
  // last seen May 4, 2026"). Falls back to the static placeholder when the
  // manifest is empty. The "Most recent" hint is intentionally static and
  // lives in the HTML markup.
  function populateLandingHints(manifest) {
    const $allHint = document.getElementById('landing-mode-all-hint');
    if (!$allHint) return;
    if (!manifest || manifest.length === 0) {
      $allHint.textContent = 'Career overview across every recorded match.';
      return;
    }
    const distinctPlayers = new Set();
    for (const m of manifest) {
      if (Array.isArray(m.players)) m.players.forEach(p => distinctPlayers.add(p));
    }
    const mostRecent = manifest[0];
    const shortDate = new Date(mostRecent.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const matchWord = manifest.length === 1 ? 'match' : 'matches';
    const playerWord = distinctPlayers.size === 1 ? 'player' : 'players';
    $allHint.textContent = `Career overview · ${manifest.length} ${matchWord} · ${distinctPlayers.size} ${playerWord} · last seen ${shortDate}`;
  }

  // Builds and shows the landing preferences modal. Called on first-visit
  // boot (when no URL intent and no stored pref) and from the Preferences
  // gear button in the nav. The two entry points differ only in their
  // onCancel handling: first-visit falls back to the default landing view
  // (All matches); gear re-open is a no-op so dismissing doesn't disturb
  // the view.
  function showLandingModal({ current, onConfirm, onCancel }) {
    const $modal = document.getElementById('landing-modal');
    if (!$modal || !window.bootstrap) return;

    const $recentRadio   = document.getElementById('landing-mode-recent');
    const $allRadio      = document.getElementById('landing-mode-all');
    const $specificRadio = document.getElementById('landing-mode-specific');
    const $specificWrap  = document.getElementById('landing-specific-wrap');
    const $specificSel   = document.getElementById('landing-specific-select');
    const $persistYes    = document.getElementById('landing-persist-yes');
    const $persistNo     = document.getElementById('landing-persist-no');
    const $confirmBtn    = document.getElementById('landing-modal-confirm');

    // Auto-fill the "All matches" hint with the corpus snapshot. The
    // "Most recent" hint is static and lives in the HTML.
    populateLandingHints(manifest);

    // Populate the specific-match select from manifest (mirrors the
    // navbar dropdown's label format).
    if ($specificSel) {
      $specificSel.innerHTML = '';
      manifest.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        const shortDate = new Date(m.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        opt.textContent = `${m.name} — ${shortDate}`;
        $specificSel.appendChild(opt);
      });
    }

    // Pre-select based on `current` (gear re-open) or defaults (first visit).
    // First-visit default is now "All matches" (changed from "Most recent"
    // on 2026-05-08) — pre-existing saved prefs preserved deliberately.
    if (current && current.mode === 'recent') {
      $recentRadio.checked = true;
    } else if (current && current.mode === 'specific') {
      $specificRadio.checked = true;
      if (current.matchId && $specificSel) {
        const exists = manifest.some(m => m.id === current.matchId);
        if (exists) $specificSel.value = current.matchId;
      }
    } else {
      // No saved pref or current.mode === 'all' / 'ask' → default to All matches.
      $allRadio.checked = true;
    }
    // If we have a saved pref (even 'ask'), "Remember" is implicitly the
    // current stance; treat missing pref as Remember-pre-selected per the
    // plan's default.
    if (current && current.mode === 'ask') $persistNo.checked = true;
    else $persistYes.checked = true;

    // Toggle specific-match select visibility with the radio.
    function syncSpecificVisibility() {
      if ($specificRadio.checked) $specificWrap.classList.remove('d-none');
      else $specificWrap.classList.add('d-none');
    }
    function handleSpecificFocus() {
      $specificRadio.checked = true;
      syncSpecificVisibility();
    }
    syncSpecificVisibility();
    const modeRadios = [$recentRadio, $allRadio, $specificRadio];
    modeRadios.forEach(r => r.addEventListener('change', syncSpecificVisibility));
    // Focusing the dropdown implies they want "specific".
    if ($specificSel) $specificSel.addEventListener('focus', handleSpecificFocus);

    let confirmed = false;

    function getChoice() {
      let mode = 'recent';
      if ($allRadio.checked) mode = 'all';
      else if ($specificRadio.checked) mode = 'specific';
      const persist = $persistYes.checked;
      const choice = { mode, persist };
      if (mode === 'specific' && $specificSel) choice.matchId = $specificSel.value;
      return choice;
    }

    const instance = bootstrap.Modal.getOrCreateInstance($modal);

    function handleConfirm() {
      confirmed = true;
      const choice = getChoice();
      instance.hide();
      if (typeof onConfirm === 'function') onConfirm(choice);
    }

    function handleHidden() {
      // Tear down every listener we added so re-opens don't accumulate.
      $confirmBtn.removeEventListener('click', handleConfirm);
      $modal.removeEventListener('hidden.bs.modal', handleHidden);
      modeRadios.forEach(r => r.removeEventListener('change', syncSpecificVisibility));
      if ($specificSel) $specificSel.removeEventListener('focus', handleSpecificFocus);
      if (!confirmed && typeof onCancel === 'function') onCancel();
    }

    $confirmBtn.addEventListener('click', handleConfirm);
    $modal.addEventListener('hidden.bs.modal', handleHidden);

    // Hide the preloader spinner behind the modal so the welcome screen
    // reads cleanly. Loaders re-show #loading themselves when they run.
    $loading.classList.add('d-none');

    instance.show();
  }

  // URLSearchParams.toString() percent-encodes a long list of characters
  // that are technically valid unencoded inside a query string (RFC 3986
  // §3.4: `pchar = unreserved / sub-delims / ":" / "@"`). De-encoding a
  // curated subset makes shared URLs much more readable without breaking
  // round-tripping — URLSearchParams.get() parses raw and percent-encoded
  // forms equivalently for these characters.
  //
  // The set is deliberately conservative: anything with separator or
  // form-encoder semantics (& = + # ? %) stays encoded so values can't
  // accidentally bleed into adjacent params.
  const SAFE_QUERY_CHARS = /%(2C|27|28|29|3A|40|2F|21|24|2A)/g;
  function paramsToString(params) {
    return params.toString().replace(SAFE_QUERY_CHARS, decodeURIComponent);
  }

  // Pure: computes the URL string representing current state, without writing
  // to history. Used by both the gated syncUrl() and the explicit Share action.
  function buildShareUrl() {
    const params = new URLSearchParams();

    if (currentTarget === '__all__') {
      params.set('match', 'all');
    } else if (currentData) {
      params.set('match', currentData.match.id);
    }

    const isAllMatchesView = currentTarget === '__all__';
    if (!isAllMatchesView) {
      if (filterState.mode === 'team' && filterState.team) {
        params.set('filter', 'team');
        params.set('team', String(filterState.team));
      } else if (filterState.mode === 'player' && filterState.players.length > 0) {
        params.set('filter', 'player');
        params.set('players', filterState.players.join(','));
      }
    }

    // Picker filter axis — emitted only when non-default so links to the
    // common case stay short (e.g. `?match=all` with no filters set).
    // These hydrate `pickerState` on initial load via parseUrlState() +
    // hydratePickerStateFromUrl(), and apply globally regardless of the
    // currently-loaded match (the picker layer is independent of the
    // per-match filterState above).
    const ps = pickerState;
    if (ps.query)                                 params.set('q', ps.query);
    if (ps.duration && ps.duration !== 'any')     params.set('dur', ps.duration);
    if (ps.playerCounts.length)                   params.set('cnt', ps.playerCounts.join(','));
    if (ps.submitters.length)                     params.set('sub', ps.submitters.join(','));
    if (ps.players.length)                        params.set('roster', ps.players.join(','));
    if (ps.matchMode === 'all')                   params.set('mode', 'all');
    if (ps.role && ps.role !== 'any')             params.set('role', ps.role);
    if (ps.sort && ps.sort !== 'date-desc')       params.set('sort', ps.sort);

    const slug = getActiveTabSlug();
    if (slug && slug !== 'overview') params.set('tab', slug);

    const qs = paramsToString(params);
    return window.location.pathname + (qs ? '?' + qs : '');
  }

  // Gated URL writer — no-op unless live sync is enabled.
  function syncUrl() {
    if (!liveSyncEnabled) return;
    history.replaceState(null, '', buildShareUrl());
  }

  // The eight picker query keys, in the order buildShareUrl() emits them.
  // Single source of truth for `syncPickerUrl()` and any future helper
  // that needs to know what counts as "picker state" on the URL.
  const PICKER_URL_KEYS = ['q', 'dur', 'cnt', 'sub', 'roster', 'mode', 'role', 'sort'];

  // Picker-only URL writer — always fires (unlike `syncUrl()`), but only
  // touches the eight picker keys. Existing non-picker params (match,
  // filter, team, players, tab, t) in the URL are preserved as-is.
  //
  // Why bypass the live-sync gate: picker filters are deliberately
  // user-configured global state, not transient per-view selection. They
  // are exactly the kind of thing the user wants in the URL bar so they
  // can copy the URL at any time. The gate still meaningfully covers
  // the chattier per-match filter axis (filterState).
  function syncPickerUrl() {
    const cur = new URLSearchParams(window.location.search);
    PICKER_URL_KEYS.forEach(k => cur.delete(k));

    const ps = pickerState;
    if (ps.query)                                 cur.set('q', ps.query);
    if (ps.duration && ps.duration !== 'any')     cur.set('dur', ps.duration);
    if (ps.playerCounts.length)                   cur.set('cnt', ps.playerCounts.join(','));
    if (ps.submitters.length)                     cur.set('sub', ps.submitters.join(','));
    if (ps.players.length)                        cur.set('roster', ps.players.join(','));
    if (ps.matchMode === 'all')                   cur.set('mode', 'all');
    if (ps.role && ps.role !== 'any')             cur.set('role', ps.role);
    if (ps.sort && ps.sort !== 'date-desc')       cur.set('sort', ps.sort);

    const qs = paramsToString(cur);
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  // Explicit share action: build the URL from current state and copy to
  // clipboard. Prefers the modern async Clipboard API; falls back to a hidden
  // textarea + document.execCommand('copy') for insecure contexts (file://,
  // plain http://). The button flashes success/error for 1500ms either way.
  async function copyShareUrl() {
    const url = new URL(buildShareUrl(), window.location.origin).href;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('execCommand copy failed');
      }
      flashShareButton(true);
    } catch {
      flashShareButton(false);
    }
  }

  const SHARE_ICON_DEFAULT = 'bi-link-45deg';
  const SHARE_ICON_SUCCESS = 'bi-check2';
  const SHARE_ICON_ERROR = 'bi-exclamation-triangle';
  let shareFlashTimer = null;

  function flashShareButton(success) {
    const btn = document.getElementById('share-url-btn');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (!icon) return;
    icon.classList.remove(SHARE_ICON_DEFAULT, SHARE_ICON_SUCCESS, SHARE_ICON_ERROR);
    btn.classList.remove('flash-success', 'flash-error');
    if (success) {
      icon.classList.add(SHARE_ICON_SUCCESS);
      btn.classList.add('flash-success');
    } else {
      icon.classList.add(SHARE_ICON_ERROR);
      btn.classList.add('flash-error');
    }
    if (shareFlashTimer) clearTimeout(shareFlashTimer);
    shareFlashTimer = setTimeout(() => {
      icon.classList.remove(SHARE_ICON_SUCCESS, SHARE_ICON_ERROR);
      icon.classList.add(SHARE_ICON_DEFAULT);
      btn.classList.remove('flash-success', 'flash-error');
      shareFlashTimer = null;
    }, 1500);
  }

  // Turning ON catches the URL up to current state (one-time bypass of the
  // gate). Turning OFF leaves the URL intact — "off" means stop tracking
  // changes, not wipe current state. Preference persists in localStorage.
  function setLiveSync(on) {
    liveSyncEnabled = on;
    localStorage.setItem('vt-url-sync', on ? 'true' : 'false');
    const btn = document.getElementById('live-sync-toggle');
    if (btn) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    if (on) {
      history.replaceState(null, '', buildShareUrl());
    }
  }

  // Wire up topnav buttons. Init the live-sync button's visual state to match
  // the persisted preference without writing to the URL (a page load should
  // never write, regardless of the pref).
  {
    const shareBtn = document.getElementById('share-url-btn');
    if (shareBtn) shareBtn.addEventListener('click', copyShareUrl);

    const syncBtn = document.getElementById('live-sync-toggle');
    if (syncBtn) {
      syncBtn.classList.toggle('active', liveSyncEnabled);
      syncBtn.setAttribute('aria-pressed', String(liveSyncEnabled));
      syncBtn.addEventListener('click', () => setLiveSync(!liveSyncEnabled));
    }
  }

  // Apply a previously-parsed URL state to filterState after a match has
  // loaded. URL wins over the persist preference on initial load. Unresolved
  // players are dropped; if the list empties, fall back to 'all'.
  function hydrateFilterFromUrl(urlState, leaderboard) {
    if (!urlState.filter || urlState.filter === 'all') {
      filterState.mode = 'all';
      filterState.players = [];
      filterState.team = null;
      return;
    }
    if (urlState.filter === 'team') {
      if (urlState.team === '1' || urlState.team === '2') {
        filterState.mode = 'team';
        filterState.team = urlState.team;
        filterState.players = [];
        return;
      }
      filterState.mode = 'all';
      filterState.players = [];
      filterState.team = null;
      return;
    }
    if (urlState.filter === 'player') {
      const resolved = resolvePlayerTokens(urlState.players, leaderboard);
      if (resolved.length > 0) {
        filterState.mode = 'player';
        filterState.players = resolved;
        filterState.team = null;
        return;
      }
      filterState.mode = 'all';
      filterState.players = [];
      filterState.team = null;
      return;
    }
    // Unknown filter value
    filterState.mode = 'all';
    filterState.players = [];
    filterState.team = null;
  }

  // Activate a tab from a pre-parsed URL state. Returns true if a valid tab
  // slug was found and activated.
  function activateTabFromSlug(slug, slugMap) {
    if (slug && slugMap[slug]) {
      const btn = document.getElementById(slugMap[slug]);
      if (btn) { bootstrap.Tab.getOrCreateInstance(btn).show(); return true; }
    }
    return false;
  }

  let manifest;
  try {
    const res = await fetch('data/processed/matches.json');
    if (!res.ok) throw new Error(res.status);
    manifest = await res.json();
  } catch {
    $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load match manifest.</p>';
    return;
  }

  // Map registry: built by scripts/build_map_registry.py at pipeline time,
  // keyed by lowercase `<mapFile>` (stripped `.bzn`). Consumed by
  // getMapMeta() below for hero banner fields + thumbnails. Non-blocking:
  // if the registry fetch fails (local dev without registry; CDN miss in
  // prod), getMapMeta() gracefully falls back to BZ2API.VSR_MAP_DATA or
  // dashes out missing fields.
  let mapRegistry = {};
  try {
    const regRes = await fetch('data/map-registry.json');
    if (regRes.ok) mapRegistry = await regRes.json();
  } catch {
    // registry is optional — nothing to do
  }

  // Sort newest-first. The Python pipeline writes matches.json sorted
  // ascending by date, but every JS call site that uses manifest[0]
  // (default dropdown value, brand-home click, boot fallback, landing
  // modal's "Most recent") means "most recent match". Flipping it here
  // in one place makes `manifest[0]` the intended most-recent entry and
  // also shows newest-first in the navbar dropdown, the landing modal's
  // specific-match picker, and the not-found error picker.
  manifest.sort((a, b) => new Date(b.date) - new Date(a.date));

  // --- Match picker: format helpers ---
  // Kept local to this scope so every renderer uses the same date / duration
  // formatting as the trigger buttons.

  function fmtDurationShort(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}m ${s}s`;
  }

  function fmtDateFull(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // --- Match picker: build + wire ---

  function buildMatchPickerCardHtml(entry) {
    const leaders = entry.team_leaders || {};
    const l1 = leaders['1'] && leaders['1'].name;
    const l2 = leaders['2'] && leaders['2'].name;
    let leadersHtml = '';
    if (l1 || l2) {
      leadersHtml = `
        <div class="vt-match-picker-card-leaders">
          <span class="vt-match-picker-card-leader vt-match-picker-card-leader--t1">${esc(l1 || '—')}</span>
          <span class="vt-match-picker-card-leader-vs">vs</span>
          <span class="vt-match-picker-card-leader vt-match-picker-card-leader--t2">${esc(l2 || '—')}</span>
        </div>`;
    }
    const mapRaw = entry.map && entry.map !== entry.name
      ? `<div class="vt-match-picker-card-rawmap vt-mono">${esc(entry.map)}</div>`
      : '';

    // Thumbnail from the map registry. Lookup by normalized mapFile key.
    // When the map isn't in the registry (or hasn't been fetched), render
    // a neutral placeholder so card sizing stays stable.
    const mapKey = (entry.map || '').replace(/\.bzn$/i, '').toLowerCase();
    const regEntry = (mapRegistry && mapRegistry[mapKey]) || null;
    const thumbSrc = regEntry && regEntry.image_path ? ('data/' + regEntry.image_path) : '';
    const thumbHtml = thumbSrc
      ? `<img class="vt-match-picker-card-thumb" src="${esc(thumbSrc)}" alt="" decoding="async" loading="lazy">`
      : `<div class="vt-match-picker-card-thumb vt-match-picker-card-thumb--placeholder" aria-hidden="true"><i class="bi bi-map"></i></div>`;

    return `
      <button type="button" class="vt-match-picker-card" data-target="${esc(entry.file)}" role="listitem">
        ${thumbHtml}
        <div class="vt-match-picker-card-body">
          <div class="vt-match-picker-card-head">
            <span class="vt-match-picker-card-name">${esc(entry.name || entry.id)}</span>
            <span class="vt-match-picker-card-meta">${esc(fmtDurationShort(entry.duration_sec))} &middot; ${entry.player_count || '?'}p</span>
          </div>
          ${mapRaw}
          <div class="vt-match-picker-card-submeta">
            <span class="vt-match-picker-card-submitter"><i class="bi bi-person-circle"></i> ${esc(entry.submitter || '—')}</span>
            <span class="vt-match-picker-card-date">${esc(fmtDateFull(entry.date))}</span>
          </div>
          ${leadersHtml}
        </div>
      </button>`;
  }

  function buildMatchPickerAllCardHtml() {
    // The card's meta + submeta lines are kept generic at build-time and
    // updated dynamically by updateAllMatchesCardCopy() once the picker
    // filters apply. That avoids a second buildMatchPicker() pass when
    // filters change.
    const submitters = new Set(manifest.map(m => m.submitter).filter(Boolean));
    return `
      <button type="button" class="vt-match-picker-card vt-match-picker-card--all" data-target="__all__" role="listitem">
        <div class="vt-match-picker-card-thumb vt-match-picker-card-thumb--placeholder" aria-hidden="true">
          <i class="bi bi-collection"></i>
        </div>
        <div class="vt-match-picker-card-body">
          <div class="vt-match-picker-card-head">
            <span class="vt-match-picker-card-name">All Matches</span>
            <span class="vt-match-picker-card-meta" data-all-card-meta>${manifest.length} matches &middot; ${submitters.size} submitter${submitters.size === 1 ? '' : 's'}</span>
          </div>
          <div class="vt-match-picker-card-submeta">
            <span class="vt-muted" data-all-card-submeta>Career overview across every recorded match.</span>
          </div>
        </div>
      </button>`;
  }

  // Debounced re-aggregator for the All Matches view. Coalesces rapid
  // chip toggles / search keystrokes into a single loadAllMatches() call.
  // Only fires when the user is actively on the aggregate view; otherwise
  // the filter state is recorded silently and applied on next selection.
  let _allRerenderTimer = null;
  function scheduleAllMatchesReaggregate() {
    if (currentTarget !== '__all__') return;
    if (_allRerenderTimer) clearTimeout(_allRerenderTimer);
    _allRerenderTimer = setTimeout(() => {
      _allRerenderTimer = null;
      // Skip the view-transition wrapper for in-place filter updates so
      // the user gets immediate feedback. URL sync still runs inside
      // loadAllMatches so the share link reflects the new filter scope.
      loadAllMatches();
    }, 120);
  }

  // Sync the filter-state banner above #all-matches-view. Visible only
  // when picker filters are active; surfaces the filtered subset size
  // and a Clear-filters shortcut. Idempotent — safe to call from
  // loadAllMatches and from applyPickerFilters whenever currentTarget
  // is '__all__'.
  function updateAllMatchesFilterBanner(filteredCount) {
    const banner = document.getElementById('all-matches-filter-banner');
    if (!banner) return;
    const txt = document.getElementById('all-matches-filter-banner-text');
    const filtersOn = hasAnyFilterEngaged(pickerState);
    if (!filtersOn) {
      banner.classList.add('d-none');
      return;
    }
    banner.classList.remove('d-none');
    if (txt) {
      const k = filteredCount;
      const N = manifest.length;
      // Read the latest aggregate meta from the window stash so the
      // parenthetical reflects whatever VTAggregate.build() last produced
      // for the current filter scope. May be stale by ~one debounce tick
      // when filters change rapidly; the next reaggregate fixes it.
      const aggMeta = (window.__vtAllMatchesData && window.__vtAllMatchesData.meta) || {};
      const dropped = aggMeta.players_dropped_by_min_matches || 0;
      const minMatches = aggMeta.min_career_matches || 0;
      const droppedSuffix = (k > 0 && dropped > 0 && minMatches > 0)
        ? ` <small class="text-muted">(${dropped} player${dropped === 1 ? '' : 's'} hidden by ${minMatches}-match minimum.)</small>`
        : '';
      txt.innerHTML = k === 0
        ? `<strong>No matches</strong> match the current filters.`
        : `Aggregate of <strong>${k}</strong> of ${N} match${N === 1 ? '' : 'es'} matching the active filters.${droppedSuffix}`;
    }
  }

  // Keep the All Matches card's copy in sync with the active filter state.
  // When filters are engaged, the card reads as "Aggregate of K of N matches
  // matching filters"; when not, it falls back to the generic career-overview
  // line. Called from applyPickerFilters() with the filtered count already
  // computed (avoids a second predicate pass).
  function updateAllMatchesCardCopy(filteredCount) {
    if (!$pickerGrid) return;
    const allCard = $pickerGrid.querySelector('.vt-match-picker-card--all');
    if (!allCard) return;
    const metaEl = allCard.querySelector('[data-all-card-meta]');
    const subEl = allCard.querySelector('[data-all-card-submeta]');
    if (!metaEl || !subEl) return;

    const total = manifest.length;
    const filtersOn = hasAnyFilterEngaged(pickerState);

    if (filtersOn) {
      const k = filteredCount;
      metaEl.textContent = `${k} of ${total} match${total === 1 ? '' : 'es'}`;
      subEl.textContent = k === 0
        ? 'No matches match the current filters.'
        : `Aggregate of ${k} match${k === 1 ? '' : 'es'} matching filters.`;
    } else {
      const submitters = new Set(manifest.map(m => m.submitter).filter(Boolean));
      metaEl.textContent = `${total} matches \u00B7 ${submitters.size} submitter${submitters.size === 1 ? '' : 's'}`;
      subEl.textContent = 'Career overview across every recorded match.';
    }
  }

  function buildMatchPicker() {
    if (!$pickerGrid) return;
    // Newest-first: `manifest` has already been sorted desc-by-date above.
    const cards = [buildMatchPickerAllCardHtml()]
      .concat(manifest.map(buildMatchPickerCardHtml));
    $pickerGrid.innerHTML = cards.join('');

    // Stash a lowercased search blob on each card element. Searched on
    // every keystroke; cheaper than re-querying DOM.
    $pickerGrid.querySelectorAll('.vt-match-picker-card').forEach(el => {
      const tgt = el.dataset.target;
      if (tgt === '__all__') {
        el.dataset.searchBlob = 'all matches';
        return;
      }
      const entry = manifest.find(m => m.file === tgt);
      if (!entry) return;
      const l1 = entry.team_leaders && entry.team_leaders['1'] && entry.team_leaders['1'].name;
      const l2 = entry.team_leaders && entry.team_leaders['2'] && entry.team_leaders['2'].name;
      el.dataset.searchBlob = [
        entry.name, entry.map, entry.submitter,
        fmtDateFull(entry.date),
        l1, l2,
      ].filter(Boolean).join(' ').toLowerCase();
    });

    // Delegated click: one listener for the whole grid.
    $pickerGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.vt-match-picker-card');
      if (!card) return;
      e.preventDefault();
      selectMatch(card.dataset.target);
    });
  }

  // Resolve a target ('__all__' or a file string) to manifest entry, or null.
  function resolveTarget(target) {
    if (target === '__all__' || target === null) return target;
    // Accept either a file string or an entry object (for internal callers).
    if (typeof target === 'object' && target !== null) return target;
    return manifest.find(m => m.file === target) || null;
  }

  // Click / activation handler — dismisses the modal, updates triggers,
  // and routes to loadMatch / loadAllMatches with the same view-transition
  // wrapper the old <select> change handler used.
  function selectMatch(target) {
    const resolved = resolveTarget(target);
    if (resolved === null) return;
    // No-op if already on this target (pure click on the active card).
    if (resolved === currentTarget) {
      if (pickerModalInstance) pickerModalInstance.hide();
      return;
    }
    updateMatchPickerTriggers(resolved);
    if (pickerModalInstance) pickerModalInstance.hide();
    const doLoad = () => {
      if (resolved === '__all__') loadAllMatches();
      else loadMatch(resolved.file);
    };
    if (window.VTFx) VTFx.withViewTransition(doLoad);
    else doLoad();
  }

  // Update both trigger buttons + the active-card highlight in the grid.
  // Called from every place that used to do `$select.value = ...`.
  function updateMatchPickerTriggers(target) {
    const resolved = resolveTarget(target);
    currentTarget = resolved;

    let name, sub;
    if (resolved === '__all__') {
      name = 'All Matches';
      // The trigger subtitle mirrors the All-Matches card subtitle: when
      // filters are engaged, surface the filtered/total count so the user
      // sees the aggregate scope right in the hero.
      if (hasAnyFilterEngaged(pickerState)) {
        const k = countFilteredManifest();
        sub = `Aggregate of ${k} of ${manifest.length} matches matching filters`;
      } else {
        const submitters = new Set(manifest.map(m => m.submitter).filter(Boolean));
        sub = `${manifest.length} matches \u00B7 ${submitters.size} submitter${submitters.size === 1 ? '' : 's'}`;
      }
    } else if (resolved && typeof resolved === 'object') {
      name = resolved.name || resolved.id;
      const rawMap = resolved.map && resolved.map !== resolved.name ? `${resolved.map} \u00B7 ` : '';
      sub = `${rawMap}${fmtDateFull(resolved.date)}`;
    } else {
      name = '—';
      sub = '—';
    }

    if ($triggerName)    $triggerName.textContent = name;
    if ($triggerNameAll) $triggerNameAll.textContent = name;
    if ($triggerSub)     $triggerSub.textContent = sub;
    if ($triggerSubAll)  $triggerSubAll.textContent = sub;

    // Active-card highlight in the grid.
    if ($pickerGrid) {
      const activeKey = resolved === '__all__'
        ? '__all__'
        : (resolved && typeof resolved === 'object' ? resolved.file : null);
      $pickerGrid.querySelectorAll('.vt-match-picker-card').forEach(el => {
        el.classList.toggle('is-active', el.dataset.target === activeKey);
      });
    }
  }

  buildMatchPicker();

  // --- Match picker: Phase 2 — facet derivation + filter model ---

  // Duration bucket thresholds. Expressed once here so chip labels (HTML)
  // and predicate (JS) stay in sync at a single glance.
  const DURATION_BUCKETS = {
    short:  { min: 0,    max: 600  },  // <10m
    medium: { min: 600,  max: 1200 },  // 10-20m
    long:   { min: 1200, max: Infinity }, // 20m+
  };

  // Derive unique facet option lists from the manifest once.
  //
  // `roster` is the union of every `manifest[].players[]` (which always
  // includes both commanders + thugs). The Players facet uses this list
  // and derives role membership *per-match* by checking if the name is in
  // that match's `team_leaders` (commander) or only in `players[]` (thug).
  // We no longer derive a separate commanders list — the role toggle makes
  // it redundant, and we want the chip list to surface non-commanders too.
  function deriveFacets() {
    const playerCounts = Array.from(new Set(
      manifest.map(m => m.player_count).filter(n => Number.isFinite(n) && n > 0)
    )).sort((a, b) => a - b);

    const submitters = Array.from(new Set(
      manifest.map(m => m.submitter).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    const roster = Array.from(new Set(
      manifest.flatMap(m => Array.isArray(m.players) ? m.players : [])
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return { playerCounts, submitters, roster };
  }

  const pickerFacets = deriveFacets();

  function buildMatchPickerFilters() {
    if (!$facetPlayerCounts || !$facetSubmitters || !$facetPlayers) return;

    // Player-count chips (sizes of matches: 4, 6, 8, 10).
    $facetPlayerCounts.innerHTML = pickerFacets.playerCounts.map(pc =>
      `<button type="button" class="vt-match-picker-chip" data-value="${pc}" role="checkbox" aria-checked="false">${pc}</button>`
    ).join('');

    // Submitter chips.
    $facetSubmitters.innerHTML = pickerFacets.submitters.map(s =>
      `<button type="button" class="vt-match-picker-chip" data-value="${esc(s)}" role="checkbox" aria-checked="false">${esc(s)}</button>`
    ).join('');

    // Players chips (full roster — both commanders and thugs across all
    // matches). Per-chip visibility is filtered by the players-search input;
    // role membership is determined per-match by the predicate, not the
    // chip itself.
    $facetPlayers.innerHTML = pickerFacets.roster.map(name =>
      `<button type="button" class="vt-match-picker-chip" data-value="${esc(name)}" data-name-lc="${esc(name.toLowerCase())}" role="checkbox" aria-checked="false">${esc(name)}</button>`
    ).join('');

    // Empty-state handling when a facet has no options (e.g. fresh repo).
    if (!pickerFacets.roster.length) {
      $facetPlayers.innerHTML = `<span class="vt-muted small">No players captured yet.</span>`;
    }
  }

  // Predicate: does this manifest entry pass the current filter state?
  function entryMatchesState(entry, state) {
    // Free-text query — matches the same fields the Phase 1 searchBlob used.
    if (state.query) {
      const blob = (entry.__searchBlob ||= buildEntrySearchBlob(entry));
      if (!blob.includes(state.query)) return false;
    }

    // Duration band.
    if (state.duration && state.duration !== 'any') {
      const bucket = DURATION_BUCKETS[state.duration];
      if (!bucket) return false;
      const d = entry.duration_sec || 0;
      if (d < bucket.min || d >= bucket.max) return false;
    }

    // Player count (multi-select: match any selected count).
    if (state.playerCounts.length && !state.playerCounts.includes(entry.player_count)) return false;

    // Submitter (multi-select: match any selected).
    if (state.submitters.length && !state.submitters.includes(entry.submitter)) return false;

    // Players (multi-select chips, with two orthogonal toggles):
    //   - matchMode: 'any' | 'all'  -> at least one vs. every selected name
    //   - role:      'any' | 'commander' | 'thug' -> constrains *how* the
    //     name has to appear in the match. A name is the match's commander
    //     iff it shows up in `team_leaders.{1,2}.name`; otherwise (still in
    //     `players[]`) it's a thug.
    if (state.players.length) {
      const tl = entry.team_leaders || {};
      const cmdrSet = new Set(
        [tl['1'] && tl['1'].name, tl['2'] && tl['2'].name].filter(Boolean)
      );
      const rosterSet = new Set(Array.isArray(entry.players) ? entry.players : []);
      const isPresent = (name) => {
        if (!rosterSet.has(name)) return false;
        if (state.role === 'commander') return cmdrSet.has(name);
        if (state.role === 'thug')      return !cmdrSet.has(name);
        return true;
      };
      const test = state.matchMode === 'all' ? 'every' : 'some';
      if (!state.players[test](isPresent)) return false;
    }

    return true;
  }

  // Count manifest entries that pass the current pickerState. Used by the
  // All Matches card and trigger to surface the filtered subset size.
  // Cached per-call (the pickerState object itself isn't immutable, so we
  // recompute on every call — manifest is small enough that this is a sub-
  // millisecond loop).
  function countFilteredManifest() {
    let n = 0;
    for (const m of manifest) {
      if (entryMatchesState(m, pickerState)) n++;
    }
    return n;
  }

  function buildEntrySearchBlob(entry) {
    const tl = entry.team_leaders || {};
    const roster = Array.isArray(entry.players) ? entry.players : [];
    return [
      entry.name, entry.map, entry.submitter,
      fmtDateFull(entry.date),
      tl['1'] && tl['1'].name, tl['2'] && tl['2'].name,
      ...roster,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  // Stable comparator per sort key.
  function comparatorForSort(sort) {
    switch (sort) {
      case 'date-asc':      return (a, b) => new Date(a.date) - new Date(b.date);
      case 'duration-desc': return (a, b) => (b.duration_sec || 0) - (a.duration_sec || 0);
      case 'duration-asc':  return (a, b) => (a.duration_sec || 0) - (b.duration_sec || 0);
      case 'players-desc':  return (a, b) => (b.player_count || 0) - (a.player_count || 0);
      case 'players-asc':   return (a, b) => (a.player_count || 0) - (b.player_count || 0);
      case 'name-asc':      return (a, b) => (a.name || '').localeCompare(b.name || '');
      case 'date-desc':
      default:              return (a, b) => new Date(b.date) - new Date(a.date);
    }
  }

  // Count how many facets are engaged — for the badge / empty-state copy.
  // Note: matchMode and role are counted as part of the players facet (not
  // standalone) since they're meaningless without at least one selected
  // player; engaging them alone shouldn't bump the badge.
  function activeFilterCount(state) {
    let n = 0;
    if (state.duration && state.duration !== 'any') n++;
    if (state.playerCounts.length) n++;
    if (state.submitters.length) n++;
    if (state.players.length) n++;
    if (state.sort && state.sort !== 'date-desc') n++;
    return n;
  }

  function hasAnyFilterEngaged(state) {
    return activeFilterCount(state) > 0 || !!state.query;
  }

  // Apply current state: toggle visibility + reorder cards + update feedback.
  function applyPickerFilters() {
    if (!$pickerGrid) return;
    const state = pickerState;
    const cards = Array.from($pickerGrid.querySelectorAll('.vt-match-picker-card'));
    const allCard = cards.find(c => c.dataset.target === '__all__');
    const regularCards = cards.filter(c => c.dataset.target !== '__all__');

    // Build a file->entry index once for O(1) lookup during sort/filter.
    const entryByFile = new Map(manifest.map(m => [m.file, m]));

    // Sort the regular cards by comparator; reorder DOM (cheap: 8-ish nodes).
    const comparator = comparatorForSort(state.sort);
    regularCards.sort((a, b) => {
      const ea = entryByFile.get(a.dataset.target);
      const eb = entryByFile.get(b.dataset.target);
      if (!ea || !eb) return 0;
      return comparator(ea, eb);
    });

    // Reinsert in sorted order (all-card stays first).
    if (allCard) $pickerGrid.appendChild(allCard);
    regularCards.forEach(c => $pickerGrid.appendChild(c));

    // Filter visibility.
    let visibleRegular = 0;
    regularCards.forEach(el => {
      const entry = entryByFile.get(el.dataset.target);
      if (!entry) { el.classList.add('d-none'); return; }
      const ok = entryMatchesState(entry, state);
      el.classList.toggle('d-none', !ok);
      if (ok) visibleRegular++;
    });
    if (allCard) allCard.classList.remove('d-none');

    // Update the All Matches card copy to reflect the filtered count.
    // When the user is currently viewing the aggregate (currentTarget ===
    // '__all__'), also re-sync the hero trigger subtitles + the live
    // banner above the view, and schedule a debounced re-aggregate so
    // the career table / radar / global meta reflect the new subset.
    updateAllMatchesCardCopy(visibleRegular);
    if (currentTarget === '__all__') {
      updateMatchPickerTriggers('__all__');
      updateAllMatchesFilterBanner(visibleRegular);
      scheduleAllMatchesReaggregate();
    }

    // Result counter.
    if ($resultCount) {
      $resultCount.textContent = `${visibleRegular} of ${manifest.length} match${manifest.length === 1 ? '' : 'es'}`;
    }

    // Empty state (with variant copy depending on whether it's search vs filters).
    if ($pickerEmpty) {
      const showEmpty = visibleRegular === 0 && hasAnyFilterEngaged(state);
      $pickerEmpty.classList.toggle('d-none', !showEmpty);
      if (showEmpty && $pickerEmptyText) {
        const facetsEngaged = activeFilterCount(state) > 0;
        $pickerEmptyText.textContent = facetsEngaged
          ? 'No matches match the current filters.'
          : 'No matches match your search.';
        if ($pickerEmptyClear) $pickerEmptyClear.classList.toggle('d-none', !facetsEngaged);
      }
    }

    // Active-filter badge on both triggers + inline (mobile toolbar).
    const count = activeFilterCount(state);
    [$triggerBadge, $triggerBadgeAll].forEach(el => {
      if (!el) return;
      el.textContent = String(count);
      el.classList.toggle('d-none', count === 0);
    });
    if ($filtersBadgeInline) {
      $filtersBadgeInline.textContent = String(count);
      $filtersBadgeInline.classList.toggle('d-none', count === 0);
    }

    // Clear-all button visibility.
    if ($clearBtn) $clearBtn.classList.toggle('d-none', !hasAnyFilterEngaged(state));

    // Persist.
    savePickerStateToStorage();

    // Reflect picker state in the URL on every chip toggle, regardless
    // of the live-sync gate — picker filters are deliberately
    // user-configured global state and the user's mental model is "I
    // changed a filter, so the URL reflects it". `syncPickerUrl()`
    // touches only the eight picker keys; non-picker params (match,
    // filter, team, players, tab) stay whatever the gated `syncUrl()`
    // path last wrote. (When live-sync is on, the gated path keeps the
    // rest of the URL fresh too; when off, only picker bits update —
    // which is the right scope for the Share affordance.)
    //
    // Skipped during initial boot (before any loader has set
    // `currentTarget`) so we don't briefly clobber a shared `?match=...`
    // URL while picker state hydrates from sessionStorage + URL overlay.
    if (currentTarget != null) syncPickerUrl();
  }

  // --- Persistence ---

  function loadPickerStateFromStorage() {
    const d = DEFAULT_PICKER_STATE();

    // Read v2 first (current).
    let saved = null;
    try {
      const raw = sessionStorage.getItem(PICKER_STATE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) { /* corrupt JSON — ignore */ }

    // No v2 entry? Look for v1 and migrate it. v1 had a different shape:
    //   { players: number[], commanders: string[], versusMode: 'any'|'both' }
    // -> mapped to:
    //   { playerCounts: number[], players: string[], matchMode: 'any'|'all',
    //     role: 'any' (default) }
    // Drop the v1 entry once consumed so a refreshed tab doesn't re-import.
    if (!saved || typeof saved !== 'object') {
      try {
        const rawV1 = sessionStorage.getItem(PICKER_STATE_KEY_V1);
        if (rawV1) {
          const v1 = JSON.parse(rawV1);
          if (v1 && typeof v1 === 'object') {
            saved = {
              query:        typeof v1.query === 'string' ? v1.query : d.query,
              duration:     v1.duration,
              playerCounts: Array.isArray(v1.players) ? v1.players : d.playerCounts,
              submitters:   Array.isArray(v1.submitters) ? v1.submitters : d.submitters,
              players:      Array.isArray(v1.commanders) ? v1.commanders : d.players,
              matchMode:    v1.versusMode === 'both' ? 'all' : 'any',
              role:         d.role,
              sort:         typeof v1.sort === 'string' ? v1.sort : d.sort,
            };
          }
          sessionStorage.removeItem(PICKER_STATE_KEY_V1);
        }
      } catch (_) { /* corrupt v1 JSON — ignore */ }
    }

    if (!saved || typeof saved !== 'object') return;

    pickerState = {
      query:        typeof saved.query === 'string' ? saved.query : d.query,
      duration:     ['any', 'short', 'medium', 'long'].includes(saved.duration) ? saved.duration : d.duration,
      playerCounts: Array.isArray(saved.playerCounts) ? saved.playerCounts.filter(n => Number.isFinite(n)) : d.playerCounts,
      submitters:   Array.isArray(saved.submitters) ? saved.submitters.filter(s => typeof s === 'string') : d.submitters,
      players:      Array.isArray(saved.players) ? saved.players.filter(s => typeof s === 'string') : d.players,
      matchMode:    saved.matchMode === 'all' ? 'all' : 'any',
      role:         ['any', 'commander', 'thug'].includes(saved.role) ? saved.role : d.role,
      sort:         typeof saved.sort === 'string' ? saved.sort : d.sort,
    };
  }

  function savePickerStateToStorage() {
    try {
      sessionStorage.setItem(PICKER_STATE_KEY, JSON.stringify(pickerState));
    } catch (_) { /* quota / private mode — ignore */ }
  }

  // Overlay any URL-supplied picker params on top of the just-loaded
  // sessionStorage state. URL > storage on initial page load (mirrors how
  // hydrateFilterFromUrl handles the per-match filterState). Each field is
  // independently validated; missing or malformed values leave the existing
  // pickerState[k] untouched. Multi-selects (cnt / sub / roster) are
  // additionally whitelisted against `pickerFacets` so unknown tokens drop
  // silently — matching `resolvePlayerTokens`'s posture for stale links.
  function hydratePickerStateFromUrl(u) {
    if (!u) return;
    if (typeof u.q === 'string') {
      pickerState.query = u.q.trim().toLowerCase();
    }
    if (['short', 'medium', 'long', 'any'].includes(u.dur)) {
      pickerState.duration = u.dur;
    }
    if (Array.isArray(u.cnt) && u.cnt.length) {
      const allowed = new Set(pickerFacets.playerCounts);
      pickerState.playerCounts = u.cnt
        .map(Number)
        .filter(n => Number.isFinite(n) && allowed.has(n));
    }
    if (Array.isArray(u.sub) && u.sub.length) {
      const allowed = new Set(pickerFacets.submitters);
      pickerState.submitters = u.sub.filter(s => allowed.has(s));
    }
    if (Array.isArray(u.roster) && u.roster.length) {
      const lookup = new Map(pickerFacets.roster.map(n => [n.toLowerCase(), n]));
      pickerState.players = u.roster
        .map(n => lookup.get(String(n).toLowerCase()))
        .filter(Boolean);
    }
    if (u.mode === 'all' || u.mode === 'any') {
      pickerState.matchMode = u.mode;
    }
    if (['any', 'commander', 'thug'].includes(u.role)) {
      pickerState.role = u.role;
    }
    if (typeof u.sort === 'string') {
      pickerState.sort = u.sort;
    }
  }

  // Push pickerState into the UI controls (chip active classes, sort select,
  // match-mode toggle, role toggle, search input). Called on boot + after
  // Clear-all.
  function applyPickerStateToUI() {
    if ($pickerSearch) $pickerSearch.value = pickerState.query || '';
    if ($sortSelect) $sortSelect.value = pickerState.sort;

    if ($facetDuration) {
      $facetDuration.querySelectorAll('.vt-match-picker-chip').forEach(c => {
        const active = c.dataset.value === pickerState.duration;
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if ($facetPlayerCounts) {
      $facetPlayerCounts.querySelectorAll('.vt-match-picker-chip').forEach(c => {
        const active = pickerState.playerCounts.includes(Number(c.dataset.value));
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if ($facetSubmitters) {
      $facetSubmitters.querySelectorAll('.vt-match-picker-chip').forEach(c => {
        const active = pickerState.submitters.includes(c.dataset.value);
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if ($facetPlayers) {
      $facetPlayers.querySelectorAll('.vt-match-picker-chip').forEach(c => {
        const active = pickerState.players.includes(c.dataset.value);
        c.classList.toggle('is-active', active);
        c.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }
    if ($playersModeBtns) {
      $playersModeBtns.forEach(btn => {
        const active = btn.dataset.matchMode === pickerState.matchMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    if ($playersRoleBtns) {
      $playersRoleBtns.forEach(btn => {
        const active = btn.dataset.role === pickerState.role;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
  }

  function clearAllFilters() {
    pickerState = DEFAULT_PICKER_STATE();
    // Preserve current free-text search query? No — Clear-all means clear everything.
    applyPickerStateToUI();
    applyPickerFilters();
    // Reset players visibility search too.
    if ($playersSearch) {
      $playersSearch.value = '';
      filterPlayersChipVisibility('');
    }
  }

  // --- Wiring: search input ---

  if ($pickerSearch) {
    let searchTimer = null;
    $pickerSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        pickerState.query = ($pickerSearch.value || '').trim().toLowerCase();
        applyPickerFilters();
      }, 80);
    });
  }

  // --- Wiring: facet chipsets (event delegation per chipset) ---

  // Duration is single-select (radiogroup) — clicking a chip sets the value.
  if ($facetDuration) {
    $facetDuration.addEventListener('click', (e) => {
      const chip = e.target.closest('.vt-match-picker-chip');
      if (!chip) return;
      pickerState.duration = chip.dataset.value || 'any';
      applyPickerStateToUI();
      applyPickerFilters();
    });
  }

  // PlayerCounts, Submitters, Players are multi-select (group) — click toggles.
  function wireMultiChipset(container, stateKey, coerce) {
    if (!container) return;
    container.addEventListener('click', (e) => {
      const chip = e.target.closest('.vt-match-picker-chip');
      if (!chip) return;
      const raw = chip.dataset.value;
      const val = coerce ? coerce(raw) : raw;
      const arr = pickerState[stateKey];
      const idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(val);
      applyPickerStateToUI();
      applyPickerFilters();
    });
  }
  wireMultiChipset($facetPlayerCounts, 'playerCounts', v => Number(v));
  wireMultiChipset($facetSubmitters, 'submitters', null);
  wireMultiChipset($facetPlayers, 'players', null);

  // --- Wiring: players search (visibility-only — does NOT filter matches) ---

  function filterPlayersChipVisibility(query) {
    if (!$facetPlayers) return;
    const q = (query || '').trim().toLowerCase();
    $facetPlayers.querySelectorAll('.vt-match-picker-chip').forEach(c => {
      const name = c.dataset.nameLc || '';
      const active = c.classList.contains('is-active');
      // Always show active chips so users can un-toggle them without scrolling.
      c.classList.toggle('d-none', !active && q && !name.includes(q));
    });
  }

  if ($playersSearch) {
    $playersSearch.addEventListener('input', () => {
      filterPlayersChipVisibility($playersSearch.value);
    });
  }

  // --- Wiring: Match-mode toggle (Any of these / All of these) ---

  if ($playersModeBtns) {
    $playersModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        pickerState.matchMode = btn.dataset.matchMode === 'all' ? 'all' : 'any';
        applyPickerStateToUI();
        applyPickerFilters();
      });
    });
  }

  // --- Wiring: Role toggle (Any role / Commander / Thug) ---

  if ($playersRoleBtns) {
    $playersRoleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.role;
        pickerState.role = (r === 'commander' || r === 'thug') ? r : 'any';
        applyPickerStateToUI();
        applyPickerFilters();
      });
    });
  }

  // --- Wiring: sort ---

  if ($sortSelect) {
    $sortSelect.addEventListener('change', () => {
      pickerState.sort = $sortSelect.value;
      applyPickerFilters();
    });
  }

  // --- Wiring: Clear-all ---

  if ($clearBtn) $clearBtn.addEventListener('click', clearAllFilters);
  if ($pickerEmptyClear) $pickerEmptyClear.addEventListener('click', clearAllFilters);
  // Banner-side Clear filters button (visible inside the All Matches view
  // when filters are active). Same effect as the picker-modal Clear-all.
  const $allBannerClear = document.getElementById('all-matches-filter-banner-clear');
  if ($allBannerClear) $allBannerClear.addEventListener('click', clearAllFilters);

  // --- Wiring: mobile Filters disclosure ---

  if ($filtersToggle && $filtersRoot) {
    $filtersToggle.addEventListener('click', () => {
      const expanded = $filtersRoot.dataset.expanded === 'true';
      $filtersRoot.dataset.expanded = expanded ? 'false' : 'true';
      $filtersToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });
  }

  // --- Init: after all Phase 2 defs are in place, hydrate the UI once. ---
  // buildMatchPickerFilters() needs `pickerFacets` (declared a few blocks up
  // as `const pickerFacets = deriveFacets()`), so this must run after that
  // initializer executes — hence it lives here at the end of the Phase 2
  // block rather than next to buildMatchPicker() above.
  //
  // URL hydration order: storage first, then URL overlay. URL > storage on
  // initial page load so a shared link reproducibly wins regardless of the
  // current tab's sessionStorage. `initialUrlState` is parsed once here and
  // reused later in the Initial Boot block at the bottom of the IIFE.
  buildMatchPickerFilters();
  const initialUrlState = parseUrlState();
  loadPickerStateFromStorage();
  hydratePickerStateFromUrl(initialUrlState.picker);
  applyPickerStateToUI();
  applyPickerFilters();

  // --- Match picker: modal lifecycle ---

  if ($pickerModalEl) {
    // Lazy-init the Bootstrap instance on first show.
    $pickerModalEl.addEventListener('show.bs.modal', () => {
      if (!pickerModalInstance && window.bootstrap && window.bootstrap.Modal) {
        pickerModalInstance = window.bootstrap.Modal.getOrCreateInstance($pickerModalEl);
      }
      // Reflect aria-expanded on both triggers.
      if ($trigger) $trigger.setAttribute('aria-expanded', 'true');
      if ($triggerAll) $triggerAll.setAttribute('aria-expanded', 'true');
    });
    $pickerModalEl.addEventListener('shown.bs.modal', () => {
      // Focus the search input + scroll active card into view.
      if ($pickerSearch) {
        $pickerSearch.focus();
        $pickerSearch.select();
      }
      const active = $pickerGrid && $pickerGrid.querySelector('.vt-match-picker-card.is-active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    });
    $pickerModalEl.addEventListener('hidden.bs.modal', () => {
      if ($trigger) $trigger.setAttribute('aria-expanded', 'false');
      if ($triggerAll) $triggerAll.setAttribute('aria-expanded', 'false');
      // Filter state (query + facets) persists in sessionStorage so it
      // survives close/reopen within a tab. No reset here.
    });
  }

  // Default selection (most-recent). Callers below will overwrite this
  // via updateMatchPickerTriggers() as they kick off loadMatch/loadAll.
  if (manifest.length > 0) {
    updateMatchPickerTriggers(manifest[0]);
  }

  const $brandHome = document.getElementById('brand-home');
  if ($brandHome) {
    $brandHome.addEventListener('click', (e) => {
      e.preventDefault();
      if (manifest.length > 0) selectMatch(manifest[0]);
    });
  }

  // --- Lazy Tab Rendering ---
  const tabRendered = {};
  const tabRenderers = {};

  function registerTabRenderer(tabId, renderFn) {
    tabRenderers[tabId] = renderFn;
  }

  function resetTabState() {
    Object.keys(tabRendered).forEach(k => { tabRendered[k] = false; });
  }

  function renderTabIfNeeded(tabId) {
    if (!tabRendered[tabId] && tabRenderers[tabId]) {
      tabRenderers[tabId]();
      tabRendered[tabId] = true;
    }
  }

  const matchTabsEl = document.getElementById('match-tabs');
  if (matchTabsEl) {
    matchTabsEl.addEventListener('shown.bs.tab', (e) => {
      const target = e.target.getAttribute('data-bs-target');
      if (target) renderTabIfNeeded(target);
      syncUrl();
    });
  }

  const allTabsEl = document.getElementById('all-tabs');
  if (allTabsEl) {
    allTabsEl.addEventListener('shown.bs.tab', (e) => {
      const target = e.target.getAttribute('data-bs-target');
      if (target) renderTabIfNeeded(target);
      syncUrl();
    });
  }

  // --- VTSR-T tier ladder (render-layer policy, NOT pipeline data) ---
  // Numeric Tier 1–5 only (no flavor names). Tier 5 spans 1000–1349
  // (350 pts wide); Tiers 2–4 stay 150 pts wide; Tier 1 is open above
  // 1800. Threshold tuning lives here so elo_current.json's schema
  // stays stable. ELO_PROVISIONAL_THRESHOLD (10 rated matches) gates
  // the "?" Provisional chip — separate from MIN_CAREER_MATCHES (5)
  // which gates whether the row is visible at all.
  const ELO_PROVISIONAL_THRESHOLD = 10;
  const VTSR_TIERS = [
    { id: 1, label: 'Tier 1', short: 'I',   min: 1800, max: Infinity, token: '--vt-tier-1' },
    { id: 2, label: 'Tier 2', short: 'II',  min: 1650, max: 1800,     token: '--vt-tier-2' },
    { id: 3, label: 'Tier 3', short: 'III', min: 1500, max: 1650,     token: '--vt-tier-3' },
    { id: 4, label: 'Tier 4', short: 'IV',  min: 1350, max: 1500,     token: '--vt-tier-4' },
    { id: 5, label: 'Tier 5', short: 'V',   min: 1000, max: 1350,     token: '--vt-tier-5' },
  ];
  function resolveTier(vtsr, matchesPlayed) {
    if (matchesPlayed < ELO_PROVISIONAL_THRESHOLD) {
      return { id: 0, label: 'Provisional', short: '?', token: null };
    }
    return VTSR_TIERS.find(t => vtsr >= t.min && vtsr < t.max)
      || VTSR_TIERS[VTSR_TIERS.length - 1];
  }
  function tierProgress(vtsr, tier) {
    if (tier.id === 1) return { toNext: null, fromCurrent: vtsr - tier.min, pct: 1.0 };
    if (tier.id === 0) return { toNext: null, fromCurrent: null, pct: 0 };
    const span = tier.max - tier.min;
    const into = vtsr - tier.min;
    return { toNext: tier.max - vtsr, fromCurrent: into, pct: into / span };
  }
  // Single-source-of-truth badge HTML used by both the dedicated VTSR-T
  // table and the Career Leaderboard's new Tier column. Keeps badge
  // markup byte-identical between the two views.
  function tierBadgeHtml(tier, opts = {}) {
    const titleAttr = opts.title ? ` title="${esc(opts.title)}" data-bs-toggle="tooltip" data-bs-placement="top"` : '';
    if (tier.id === 0) {
      return `<span class="vt-vtsr-provisional"${titleAttr}>${tier.short}</span>`;
    }
    return `<span class="vt-tier-badge vt-tier-${tier.id}"${titleAttr}>${tier.short}</span>`;
  }

  // --- Filter State ---
  let currentData = null;
  let currentFilteredData = null;
  let filterState = { mode: 'all', players: [], team: null, persist: false };
  let timelineMode = 'player';
  let sortState = { key: 'dealt', asc: false };
  let careerSortState = { key: 'total_dealt', asc: false };
  // Dedicated VTSR-T table sort. Defaults to vtsr desc (highest rating at top).
  let vtsrSortState = { key: 'vtsr', asc: false };
  // Currently selected pair for the compare-mode radar on the Rivalries tab.
  // Reset on match switch; reconciled against the filtered leaderboard on
  // filter change, falling back to the first visible top_rivalries entry.
  let rivalryRadarPair = { a: null, b: null };
  // Whether the Custom... picker is expanded. Persists across re-renders of
  // the Rivalries tab but resets on match switch.
  let rivalryRadarCustom = false;
  // Career Radar state (All Matches tab). Persists across All Matches re-entries
  // within a session. Reset by loadAllMatches on fresh data loads — except
  // for `mode`, which is a user preference (Totals vs Per-match scale on the
  // career radar's volume-biased axes 1/3/6) persisted across sessions in
  // localStorage under 'vt-career-radar-mode'.
  let careerRadarState = { a: null, b: null, compare: false, mode: 'totals' };
  try {
    const storedRadarMode = localStorage.getItem('vt-career-radar-mode');
    if (storedRadarMode === 'totals' || storedRadarMode === 'per-match') {
      careerRadarState.mode = storedRadarMode;
    }
  } catch (e) { /* ignore */ }

  /** Maps career sort keys: totals column -> per-match avg column (for view remapping). */
  const CAREER_TOTAL_TO_AVG_SORT = {
    total_pvp_dealt: 'avg_pvp_dealt',
    total_pve_dealt: 'avg_pve_dealt',
    total_dealt: 'avg_total_dealt',
    total_pvp_received: 'avg_pvp_received',
    total_pve_received: 'avg_pve_received',
    total_received: 'avg_total_received',
    net: 'avg_net',
    total_kills: 'avg_kills',
    total_deaths: 'avg_deaths',
    total_asset_dealt: 'avg_asset_dealt',
  };
  const CAREER_AVG_TO_TOTAL_SORT = Object.fromEntries(
    Object.entries(CAREER_TOTAL_TO_AVG_SORT).map(([k, v]) => [v, k])
  );

  let careerColumnView = 'per-match';
  try {
    const stored = localStorage.getItem('vt-career-cols-view');
    if (stored === 'per-match' || stored === 'totals' || stored === 'all') careerColumnView = stored;
  } catch (e) { /* ignore */ }

  // Restore persist preference
  if (localStorage.getItem('vt-filter-persist') === 'true') {
    filterState.persist = true;
    document.getElementById('filter-persist-toggle').checked = true;
  }

  // --- Filter Bar Event Listeners ---
  document.querySelectorAll('[data-filter-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.filterMode;
      document.querySelectorAll('[data-filter-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterState.mode = mode;

      document.getElementById('filter-team-select').classList.toggle('d-none', mode !== 'team');
      document.getElementById('filter-player-picker').classList.toggle('d-none', mode !== 'player');

      if (mode === 'all') {
        filterState.players = [];
        filterState.team = null;
        document.getElementById('filter-clear').classList.add('d-none');
      } else if (mode === 'team') {
        filterState.team = document.getElementById('filter-team-select').value;
        filterState.players = [];
        document.getElementById('filter-clear').classList.remove('d-none');
      } else {
        filterState.team = null;
        document.getElementById('filter-clear').classList.toggle('d-none', filterState.players.length === 0);
      }
      applyFilter();
    });
  });

  document.getElementById('filter-team-select').addEventListener('change', (e) => {
    filterState.team = e.target.value;
    applyFilter();
  });

  document.getElementById('filter-clear').addEventListener('click', () => {
    filterState.mode = 'all';
    filterState.players = [];
    filterState.team = null;
    document.querySelectorAll('[data-filter-mode]').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-filter-mode="all"]').classList.add('active');
    document.getElementById('filter-team-select').classList.add('d-none');
    document.getElementById('filter-player-picker').classList.add('d-none');
    document.getElementById('filter-clear').classList.add('d-none');
    uncheckAllPlayers();
    applyFilter();
  });

  document.getElementById('filter-persist-toggle').addEventListener('change', (e) => {
    filterState.persist = e.target.checked;
    localStorage.setItem('vt-filter-persist', e.target.checked ? 'true' : 'false');
  });

  function uncheckAllPlayers() {
    document.querySelectorAll('#filter-player-menu input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    document.getElementById('filter-player-btn').textContent = 'Select players\u2026';
  }

  function onPlayerCheckChange() {
    const checked = [...document.querySelectorAll('#filter-player-menu input[type="checkbox"]:checked')];
    filterState.players = checked.map(cb => cb.value);
    const btn = document.getElementById('filter-player-btn');
    if (filterState.players.length === 0) {
      btn.textContent = 'Select players\u2026';
    } else if (filterState.players.length <= 2) {
      btn.textContent = filterState.players.join(', ');
    } else {
      btn.textContent = `${filterState.players.length} players`;
    }
    document.getElementById('filter-clear').classList.toggle('d-none', filterState.players.length === 0);
    applyFilter();
  }

  // Custom player picker dropdown. The menu is appended to <body> (not inside
  // the match-info card) because any ancestor with backdrop-filter becomes the
  // containing block for fixed descendants, which would clip a standard
  // Bootstrap dropdown no matter the Popper strategy.
  const $playerPickerToggle = document.getElementById('filter-player-btn');
  const $playerPickerMenu = document.createElement('div');
  $playerPickerMenu.id = 'filter-player-menu';
  $playerPickerMenu.className = 'vt-player-picker vt-player-picker--floating';
  document.body.appendChild($playerPickerMenu);

  function positionPlayerMenu() {
    const rect = $playerPickerToggle.getBoundingClientRect();
    $playerPickerMenu.style.top = `${rect.bottom + 4}px`;
    // Right-align to the toggle button
    $playerPickerMenu.style.left = 'auto';
    $playerPickerMenu.style.right = `${window.innerWidth - rect.right}px`;
  }

  function openPlayerMenu() {
    $playerPickerMenu.classList.add('show');
    positionPlayerMenu();
    window.addEventListener('scroll', positionPlayerMenu, true);
    window.addEventListener('resize', positionPlayerMenu);
  }

  function closePlayerMenu() {
    $playerPickerMenu.classList.remove('show');
    window.removeEventListener('scroll', positionPlayerMenu, true);
    window.removeEventListener('resize', positionPlayerMenu);
  }

  function togglePlayerMenu() {
    if ($playerPickerMenu.classList.contains('show')) closePlayerMenu();
    else openPlayerMenu();
  }

  $playerPickerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlayerMenu();
  });
  document.addEventListener('click', (e) => {
    if ($playerPickerMenu.classList.contains('show') &&
        !$playerPickerMenu.contains(e.target) &&
        !$playerPickerToggle.contains(e.target)) {
      closePlayerMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $playerPickerMenu.classList.contains('show')) closePlayerMenu();
  });

  function populatePlayerPicker(teams) {
    const menu = $playerPickerMenu;
    menu.innerHTML = '';
    for (const [teamNum, roster] of Object.entries(teams)) {
      roster.forEach(p => {
        const label = document.createElement('label');
        label.className = 'vt-player-option';
        const dot = document.createElement('span');
        dot.className = `vt-team-dot vt-team-dot--t${teamNum}`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = p.name;
        cb.checked = filterState.players.includes(p.name);
        cb.addEventListener('change', onPlayerCheckChange);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = p.name;
        label.appendChild(cb);
        label.appendChild(dot);
        label.appendChild(nameSpan);
        menu.appendChild(label);
      });
    }
  }

  // Timeline mode toggle
  document.querySelectorAll('[data-timeline-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-timeline-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      timelineMode = btn.dataset.timelineMode;
      if (currentFilteredData && tabRendered['#tab-combat']) renderTimelineSection(currentFilteredData);
    });
  });

  // Combat Timeline: Reset Zoom button. Walks activeCharts to find the
  // timeline-chart instance and calls plugin-zoom's resetZoom() helper.
  // No-op when the plugin isn't loaded or no timeline chart exists.
  const timelineZoomResetBtn = document.getElementById('timeline-zoom-reset');
  if (timelineZoomResetBtn) {
    timelineZoomResetBtn.addEventListener('click', () => {
      const canvas = document.getElementById('timeline-chart');
      if (!canvas) return;
      const chart = activeCharts.find(c => c && c.canvas === canvas);
      if (chart && typeof chart.resetZoom === 'function') chart.resetZoom();
    });
  }

  // --- Core Filter Logic ---
  function getFilteredData(data, filter) {
    if (filter.mode === 'all') return data;

    let allowedNames;
    if (filter.mode === 'team') {
      const teamRoster = data.match.teams[filter.team] || [];
      allowedNames = new Set(teamRoster.map(p => p.name));
    } else {
      if (filter.players.length === 0) return data;
      allowedNames = new Set(filter.players);
    }

    const isSingle = filter.mode === 'player' && filter.players.length === 1;
    const allNames = data.leaderboard.map(p => p.name);

    const leaderboard = data.leaderboard.filter(p => allowedNames.has(p.name));

    // Rivalry matrix
    let rivalry_matrix;
    if (isSingle) {
      rivalry_matrix = {};
      const name = filter.players[0];
      if (data.rivalry_matrix[name]) rivalry_matrix[name] = data.rivalry_matrix[name];
    } else {
      rivalry_matrix = {};
      for (const shooter of allNames) {
        if (!allowedNames.has(shooter)) continue;
        const row = data.rivalry_matrix[shooter];
        if (!row) continue;
        const filtered = {};
        for (const victim of allNames) {
          if (allowedNames.has(victim) && row[victim]) filtered[victim] = row[victim];
        }
        if (Object.keys(filtered).length > 0) rivalry_matrix[shooter] = filtered;
      }
    }

    // Top rivalries
    let top_rivalries;
    if (isSingle) {
      const name = filter.players[0];
      top_rivalries = data.top_rivalries.filter(r => r.a === name || r.b === name);
    } else {
      top_rivalries = data.top_rivalries.filter(r => allowedNames.has(r.a) && allowedNames.has(r.b));
    }

    // Kills
    let kills_feed;
    if (isSingle) {
      const name = filter.players[0];
      kills_feed = (data.kills.feed || []).filter(e => e.killer === name || e.victim === name);
    } else {
      kills_feed = (data.kills.feed || []).filter(e => allowedNames.has(e.killer) || allowedNames.has(e.victim));
    }

    let kill_rivalry_matrix;
    if (isSingle) {
      kill_rivalry_matrix = {};
      const name = filter.players[0];
      if (data.kills.kill_rivalry_matrix[name]) kill_rivalry_matrix[name] = data.kills.kill_rivalry_matrix[name];
    } else {
      kill_rivalry_matrix = {};
      for (const killer of allNames) {
        if (!allowedNames.has(killer)) continue;
        const row = data.kills.kill_rivalry_matrix[killer];
        if (!row) continue;
        const filtered = {};
        for (const victim of allNames) {
          if (allowedNames.has(victim) && row[victim]) filtered[victim] = row[victim];
        }
        if (Object.keys(filtered).length > 0) kill_rivalry_matrix[killer] = filtered;
      }
    }

    const kills_leaderboard = (data.kills.leaderboard || []).filter(p => allowedNames.has(p.name));

    // Timeline — only filter by_player, pass by_faction through
    const by_player = {};
    for (const name of allNames) {
      if (allowedNames.has(name) && data.timeline.by_player[name]) {
        by_player[name] = data.timeline.by_player[name];
      }
    }
    const timeline = { ...data.timeline, by_player };

    // Weapon meta — recompute from filtered leaderboard weapon_breakdown
    const weaponAgg = {};
    leaderboard.forEach(p => {
      for (const [weapon, stats] of Object.entries(p.weapon_breakdown)) {
        if (!weaponAgg[weapon]) weaponAgg[weapon] = { weapon, total_damage: 0, total_shots: 0, total_hits: 0, users: 0 };
        weaponAgg[weapon].total_damage += stats.dealt;
        weaponAgg[weapon].total_shots += stats.shots;
        weaponAgg[weapon].total_hits += stats.hits;
        weaponAgg[weapon].users++;
      }
    });
    const weapon_meta = Object.values(weaponAgg)
      .map(w => ({ ...w, accuracy: w.total_shots > 0 ? w.total_hits / w.total_shots : 0 }))
      .sort((a, b) => b.total_damage - a.total_damage);

    // Asset damage
    const assetByPlayer = {};
    for (const [name, val] of Object.entries(data.asset_damage.by_player || {})) {
      if (allowedNames.has(name)) assetByPlayer[name] = val;
    }
    const assetByFaction = {};
    for (const fNum of ['1', '2']) {
      let dealt = 0, received = 0;
      const teamRoster = data.match.teams[fNum] || [];
      teamRoster.forEach(p => {
        if (assetByPlayer[p.name]) {
          dealt += assetByPlayer[p.name].dealt;
          received += assetByPlayer[p.name].received;
        }
      });
      assetByFaction[fNum] = { dealt, received };
    }
    const asset_damage = { by_player: assetByPlayer, by_faction: assetByFaction };

    // Faction totals — recompute from filtered leaderboard
    const faction_totals = {};
    for (const fNum of ['1', '2']) {
      const fPlayers = leaderboard.filter(p => String(p.faction) === fNum);
      let player_dealt = 0, player_received = 0, asset_dealt = 0, asset_received = 0, shots = 0, hits = 0;
      let pvp_dealt = 0, pve_dealt = 0, pvp_received = 0, pve_received = 0;
      fPlayers.forEach(p => {
        player_dealt += p.personal.dealt;
        player_received += p.personal.received;
        pvp_dealt += p.personal.pvp_dealt || 0;
        pve_dealt += p.personal.pve_dealt || 0;
        pvp_received += p.personal.pvp_received || 0;
        pve_received += p.personal.pve_received || 0;
        asset_dealt += p.assets.dealt;
        asset_received += p.assets.received;
        shots += p.personal.shots_fired;
        hits += p.personal.shots_hit;
      });
      faction_totals[fNum] = {
        player_dealt, asset_dealt,
        pvp_dealt, pve_dealt,
        pvp_received, pve_received,
        total_dealt: player_dealt + asset_dealt,
        player_received, asset_received,
        total_received: player_received + asset_received,
        shots, hits,
        accuracy: shots > 0 ? hits / shots : 0,
      };
    }

    // Pickups (per-player on `picker`). Keep `by_odf` + `totals` +
    // `has_pickup_data` unfiltered (match-global, like `kills.by_vehicle`).
    const pickupsBlock = data.pickups || {};
    let pickups_feed;
    if (isSingle) {
      const name = filter.players[0];
      pickups_feed = (pickupsBlock.feed || []).filter(e => e.picker === name);
    } else {
      pickups_feed = (pickupsBlock.feed || []).filter(e => allowedNames.has(e.picker));
    }
    const pickups_by_player = (pickupsBlock.by_player || []).filter(r => allowedNames.has(r.name));
    const pickups = {
      ...pickupsBlock,
      feed: pickups_feed,
      by_player: pickups_by_player,
    };

    // Powerup/crate destructions (per-player on `killer`). Same scoping pattern.
    const destructionsBlock = data.powerup_destructions || {};
    let destructions_feed;
    if (isSingle) {
      const name = filter.players[0];
      destructions_feed = (destructionsBlock.feed || []).filter(e => e.killer === name);
    } else {
      destructions_feed = (destructionsBlock.feed || []).filter(e => allowedNames.has(e.killer));
    }
    const destructions_by_player = (destructionsBlock.by_player || []).filter(r => allowedNames.has(r.name));
    const powerup_destructions = {
      ...destructionsBlock,
      feed: destructions_feed,
      by_player: destructions_by_player,
    };

    // Deployable destructions (no feed; just by_player + by_odf + totals).
    const deployBlock = data.deployable_destructions || {};
    const deploy_by_player = (deployBlock.by_player || []).filter(r => allowedNames.has(r.name));
    const deployable_destructions = {
      ...deployBlock,
      by_player: deploy_by_player,
    };

    // Snipes (per-player on `sniper` OR `victim`, mirroring kills.feed).
    const snipesBlock = data.snipes || {};
    let snipes_feed;
    if (isSingle) {
      const name = filter.players[0];
      snipes_feed = (snipesBlock.feed || []).filter(e => e.sniper === name || e.victim === name);
    } else {
      snipes_feed = (snipesBlock.feed || []).filter(e => allowedNames.has(e.sniper) || allowedNames.has(e.victim));
    }
    const snipes_by_player = (snipesBlock.by_player || []).filter(r => allowedNames.has(r.name));
    const snipes = {
      ...snipesBlock,
      feed: snipes_feed,
      by_player: snipes_by_player,
    };

    return {
      ...data,
      leaderboard,
      rivalry_matrix,
      top_rivalries,
      kills: {
        ...data.kills,
        feed: kills_feed,
        kill_rivalry_matrix,
        leaderboard: kills_leaderboard,
      },
      pickups,
      powerup_destructions,
      deployable_destructions,
      snipes,
      timeline,
      weapon_meta,
      asset_damage,
      faction_totals,
      _allNames: allNames,
      _isSinglePlayer: isSingle,
    };
  }

  // --- Apply Filter ---
  function applyFilter() {
    if (!currentData) return;
    const filtered = getFilteredData(currentData, filterState);
    const doRender = () => renderMatchData(filtered);
    if (window.VTFx) VTFx.withViewTransition(doRender);
    else doRender();
    syncUrl();
  }

  // --- Render Match Data (shared by loadMatch + applyFilter) ---
  function renderMatchData(data) {
    currentFilteredData = data;
    if (window.VTReplay) window.VTReplay.destroy();
    if (window.VTPositionPlayer) window.VTPositionPlayer.destroy();
    destroyAllCharts();
    resetTabState();

    const isSingle = data._isSinglePlayer;
    const allNames = data._allNames || data.leaderboard.map(p => p.name);

    // Banner always from unfiltered data
    renderBanner(currentData.match);

    // Match Highlights — match-global, always-unfiltered (read directly
    // from currentData, not the filtered `data` view). Pre-computed in
    // scripts/process_stats.py; this renderer is pure formatting.
    renderHighlights(currentData.highlights, currentData.match, 'match');
    ensureTooltips(document.getElementById('section-highlights'));

    // Overview: profile card vs faction scoreboard
    const $profile = document.getElementById('section-player-profile');
    const $faction = document.getElementById('section-faction');
    if (isSingle) {
      $profile.classList.remove('d-none');
      $faction.classList.add('d-none');
      renderPlayerProfile(data.leaderboard[0], currentData);
    } else {
      $profile.classList.add('d-none');
      $faction.classList.remove('d-none');
      // In multi-player mode, per-team: if the team has selected players,
      // render its subset-aggregated totals + filtered roster; otherwise
      // fall back to the full unfiltered team totals + full roster, dimmed
      // with the existing "Filtered out" badge via activeFactions.
      // Team mode and All Players mode: always pass full unfiltered totals
      // and the full roster (dim handled by activeFactions for team mode).
      const activeFactions = computeActiveFactions();
      const isMulti = filterState.mode === 'player' && filterState.players.length >= 2;
      const t1Selected = isMulti && hasSelectedOnTeam(currentData, '1');
      const t2Selected = isMulti && hasSelectedOnTeam(currentData, '2');

      const scoreboardTotals = {
        '1': t1Selected ? data.faction_totals['1'] : currentData.faction_totals['1'],
        '2': t2Selected ? data.faction_totals['2'] : currentData.faction_totals['2'],
      };
      const scoreboardTeams = {
        '1': t1Selected ? filterTeamRoster(currentData.match.teams['1'], filterState.players) : currentData.match.teams['1'],
        '2': t2Selected ? filterTeamRoster(currentData.match.teams['2'], filterState.players) : currentData.match.teams['2'],
      };

      renderFactionScoreboard(scoreboardTotals, scoreboardTeams, activeFactions, {
        multiPlayer: isMulti,
        t1Subset: t1Selected,
        t2Subset: t2Selected,
      });
    }
    renderLeaderboard(data.leaderboard);
    ensureTooltips(document.getElementById('leaderboard'));
    tabRendered['#tab-overview'] = true;

    // Deferred tab renderers
    registerTabRenderer('#tab-combat', () => {
      renderTimelineSection(data);
      renderWeaponMeta('weapon-meta-chart', data.weapon_meta);
      if (typeof renderPlayerRadar === 'function') {
        renderPlayerRadar('faction-radar-canvas', data, { mode: 'team' });
      }
      applyRadarInfoTooltips(document.getElementById('section-faction-radar'));
      renderKillFeed(data.kills, currentData.match.tick_rate, currentData.match.tick_range[0]);
      renderVehicleKills('vehicle-kills-chart', currentData.kills.by_vehicle);
      renderSnipeFeed(data.snipes, currentData.match.tick_rate, currentData.match.tick_range[0]);
      renderPowerupDestructions('powerup-destructions-chart', data.powerup_destructions);
    });

    registerTabRenderer('#tab-rivalries', () => {
      renderRivalryRadar(data);
      applyRadarInfoTooltips(document.getElementById('section-rivalry-radar'));
      renderHeatmap(data.rivalry_matrix, isSingle ? allNames : data.leaderboard.map(p => p.name));
      renderRivalries(data.top_rivalries);
      renderKillHeatmap(data.kills.kill_rivalry_matrix, isSingle ? allNames : data.leaderboard.map(p => p.name));
      if (window.VTFx) requestAnimationFrame(() => VTFx.staggerHeatmapCells());
    });

    registerTabRenderer('#tab-weapons', () => {
      renderPlayerWeapons('player-weapons-chart', data.leaderboard, data.weapon_meta);
      renderAccuracyTable(data.leaderboard);
      renderWeaponAccuracy('weapon-accuracy-chart', data.weapon_meta);
      renderHitTargets(data.leaderboard);
    });

    registerTabRenderer('#tab-assets', () => {
      renderAssetDamage(data.asset_damage, data.faction_totals);
    });

    registerTabRenderer('#tab-positioning', () => {
      renderPositioningTab(data);
    });

    registerTabRenderer('#tab-replay', () => {
      if (window.VTReplay) {
        window.VTReplay.init(document.getElementById('tab-replay'), data, currentData.match);
        // One-shot jump to a URL-specified tick (from raw.html events-table
        // row click). Consume-and-clear: subsequent renders ignore it so
        // scrubbing stays user-controlled.
        if (pendingReplayTick != null && typeof window.VTReplay.jumpToTick === 'function') {
          window.VTReplay.jumpToTick(pendingReplayTick);
          pendingReplayTick = null;
        }
      }
    });

    registerMatchCharts(data, allNames);

    // Render currently active non-overview tab if needed
    const activeTab = document.querySelector('#match-tabs .nav-link.active');
    if (activeTab) {
      const target = activeTab.getAttribute('data-bs-target');
      if (target && target !== '#tab-overview') renderTabIfNeeded(target);
    }

    if (window.VTFx) {
      const activePane = document.querySelector('#match-tab-content > .tab-pane.active');
      if (activePane) requestAnimationFrame(() => VTFx.staggerEntrance(activePane));
    }
  }

  // --- Match Loading ---
  // `urlState` is provided on initial page load only. When present, its
  // filter/tab fields take precedence over any in-memory state or persist
  // preference — URL is explicit user intent.
  async function loadMatch(file, urlState) {
    $dashboard.classList.add('d-none');
    $allView.style.display = 'none';
    $loading.classList.remove('d-none');
    // Restore default preloader content in case a prior error replaced it
    restorePreloader();
    if (window.VTReplay) window.VTReplay.destroy();
    if (window.VTPositionPlayer) window.VTPositionPlayer.destroy();
    destroyAllCharts();
    resetTabState();
    // Reset Rivalry Radar state on match switch so each match starts fresh
    // on its own top_rivalries[0]. Preserved across filter changes.
    rivalryRadarPair = { a: null, b: null };
    rivalryRadarCustom = false;

    let data;
    try {
      const res = await fetch('data/processed/' + file);
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load match data.</p>';
      return;
    }

    currentData = data;

    // Populate player picker for this match
    populatePlayerPicker(data.match.teams);

    // Filter hydration: URL state wins on initial load; otherwise the
    // persist preference governs whether filter carries across matches.
    if (urlState) {
      hydrateFilterFromUrl(urlState, data.leaderboard);
      syncFilterUI();
    } else if (filterState.persist && filterState.mode === 'player' && filterState.players.length > 0) {
      const matchNames = new Set(data.leaderboard.map(p => p.name));
      filterState.players = filterState.players.filter(n => matchNames.has(n));
      if (filterState.players.length === 0) {
        filterState.mode = 'all';
        syncFilterUI();
      }
    } else if (!filterState.persist) {
      filterState.mode = 'all';
      filterState.players = [];
      filterState.team = null;
      syncFilterUI();
    }

    if (window.VTFx) VTFx.hidePreloader();
    $loading.classList.add('d-none');
    $dashboard.classList.remove('d-none');

    // `?t=<tick>` is consumed exactly once on initial load. Set it here so
    // the Replay tab renderer picks it up whether the tab is activated via
    // `?tab=replay` (primary cross-link path) or opened later.
    if (urlState && urlState.t != null && urlState.t !== '') {
      const parsed = Number(urlState.t);
      pendingReplayTick = isFinite(parsed) ? parsed : null;
    }

    const filtered = getFilteredData(data, filterState);
    renderMatchData(filtered);

    // Initial load uses URL's tab param; subsequent in-session match switches
    // preserve whatever tab was active. Invalid slugs fall back to overview.
    // If `?t=<tick>` is present, force the Replay tab so the seek actually
    // lands on a visible chart — otherwise the one-shot jump would be wasted
    // if the user started on a different tab.
    const tabSlug = (urlState && urlState.t && !urlState.tab) ? 'replay'
      : (urlState ? urlState.tab : getActiveTabSlug());
    if (!activateTabFromSlug(tabSlug, MATCH_TAB_SLUGS)) {
      const overviewBtn = document.getElementById('tab-overview-btn');
      if (overviewBtn) bootstrap.Tab.getOrCreateInstance(overviewBtn).show();
    }

    syncUrl();
  }

  function syncFilterUI() {
    document.querySelectorAll('[data-filter-mode]').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-filter-mode="${filterState.mode}"]`).classList.add('active');
    document.getElementById('filter-team-select').classList.toggle('d-none', filterState.mode !== 'team');
    document.getElementById('filter-player-picker').classList.toggle('d-none', filterState.mode !== 'player');
    document.getElementById('filter-clear').classList.toggle('d-none', filterState.mode === 'all');
    if (filterState.mode === 'team') {
      document.getElementById('filter-team-select').value = filterState.team || '1';
    }
    uncheckAllPlayers();
    if (filterState.mode === 'player') {
      document.querySelectorAll('#filter-player-menu input[type="checkbox"]').forEach(cb => {
        cb.checked = filterState.players.includes(cb.value);
      });
      const btn = document.getElementById('filter-player-btn');
      if (filterState.players.length === 0) btn.textContent = 'Select players\u2026';
      else if (filterState.players.length <= 2) btn.textContent = filterState.players.join(', ');
      else btn.textContent = `${filterState.players.length} players`;
    }
  }

  async function loadAllMatches(urlState) {
    $dashboard.classList.add('d-none');
    $allView.style.display = 'none';
    $loading.classList.remove('d-none');
    restorePreloader();
    if (window.VTReplay) window.VTReplay.destroy();
    if (window.VTPositionPlayer) window.VTPositionPlayer.destroy();
    destroyAllCharts();
    resetTabState();

    // Fetch contributions once per session, cache on window so subsequent
    // filter changes re-aggregate without a network round trip.
    let contributions = window.__vtContributions;
    if (!contributions) {
      try {
        const res = await fetch('data/processed/match_contributions.json');
        if (!res.ok) throw new Error(res.status);
        contributions = await res.json();
        window.__vtContributions = contributions;
      } catch {
        $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load aggregate data.</p>';
        return;
      }
    }

    // Fetch elo_current.json once per session. Graceful 404: a fresh
    // checkout (or pipeline-never-run state) means the file isn't there
    // yet — hide the dedicated VTSR-T card and fall through to em-dash
    // placeholders on the Career Leaderboard's Tier+VTSR-T columns.
    if (window.__vtElo === undefined) {
      try {
        const eloRes = await fetch('data/processed/elo_current.json');
        if (!eloRes.ok) throw new Error(eloRes.status);
        window.__vtElo = await eloRes.json();
      } catch {
        window.__vtElo = null;
      }
    }

    if (!window.VTAggregate || typeof window.VTAggregate.build !== 'function') {
      $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Aggregator unavailable.</p>';
      return;
    }

    // Resolve the filtered subset of match files. When filters are active,
    // narrow to manifest entries that pass the picker predicate; otherwise
    // include every contribution key (full career view).
    const filtersOn = hasAnyFilterEngaged(pickerState);
    const fileIds = filtersOn
      ? manifest.filter(m => entryMatchesState(m, pickerState)).map(m => m.file)
      : Object.keys(contributions);

    // Empty filtered set short-circuits to a friendly empty state.
    if (filtersOn && fileIds.length === 0) {
      if (window.VTFx) VTFx.hidePreloader();
      $loading.classList.add('d-none');
      $allView.style.display = 'block';
      updateAllMatchesFilterBanner(0);
      // Render an explicit empty view so the previous match's data isn't
      // left lingering in already-rendered tabs.
      renderAggMeta({
        match_count: 0,
        total_duration_sec: 0,
        maps_played: [],
        date_range: [],
        submitters: [],
        matches_with_positioning: 0,
        matches_with_target_lock_data: 0,
        total_sentinel_damage_dropped: 0,
        matches_with_sentinel_damage: [],
      });
      // Clear downstream renders by passing an empty career list. Preserve
      // the user's `mode` preference (Totals vs Per match) across resets.
      careerRadarState = { a: null, b: null, compare: false, mode: careerRadarState.mode };
      renderVtsrLeaderboard(window.__vtElo, []);
      renderHighlights({ schema_version: 1, cards: [] }, { id: 'all-matches' }, 'career');
      renderCareerTable([]);
      renderCareerRadar({ career_stats: [] });
      window.__vtAllMatchesData = { meta: {}, career_stats: [], global_weapon_meta: [], global_rivalries: [] };
      tabRendered['#all-tab-overview'] = true;
      registerTabRenderer('#all-tab-weapons', () => {
        renderGlobalWeaponMeta('global-weapon-chart', []);
        renderGlobalRivalries([]);
      });
      const tabSlug = urlState ? urlState.tab : getActiveTabSlug();
      if (!activateTabFromSlug(tabSlug, ALL_TAB_SLUGS)) {
        const allOverviewBtn = document.getElementById('all-tab-overview-btn');
        if (allOverviewBtn) bootstrap.Tab.getOrCreateInstance(allOverviewBtn).show();
      }
      syncUrl();
      return;
    }

    const data = window.VTAggregate.build(contributions, fileIds, window.__vtElo);

    if (window.VTFx) VTFx.hidePreloader();
    $loading.classList.add('d-none');
    $allView.style.display = 'block';

    // Stash the aggregate data on window so the Career Radar event handlers
    // can re-render without having to thread the object through tab renderers.
    // Done *before* updateAllMatchesFilterBanner() so the banner can read
    // the freshly-built meta (players_dropped_by_min_matches) for the
    // hidden-count parenthetical.
    window.__vtAllMatchesData = data;

    // Surface filter-aware banner + filtered subset size.
    updateAllMatchesFilterBanner(fileIds.length);

    // Reset Career Radar state to defaults for a fresh All Matches load.
    // Dropdown values will re-default from career_stats[0] in the renderer.
    // Preserve the user's `mode` preference (Totals vs Per match) — it is
    // a UI lens, not match-data state.
    careerRadarState = { a: null, b: null, compare: false, mode: careerRadarState.mode };
    careerSortState = { key: 'total_dealt', asc: false };
    remapCareerSortKeyForColumnView(careerColumnView);

    renderAggMeta(data.meta);
    renderVtsrLeaderboard(window.__vtElo, data.career_stats);
    renderHighlights(data.career_highlights, { id: 'all-matches' }, 'career');
    initCareerColumnViewControls();
    renderCareerTable(data.career_stats);
    renderCareerRadar(data);
    applyRadarInfoTooltips(document.getElementById('section-career-radar'));
    tabRendered['#all-tab-overview'] = true;

    const tabSlug = urlState ? urlState.tab : getActiveTabSlug();
    if (!activateTabFromSlug(tabSlug, ALL_TAB_SLUGS)) {
      const allOverviewBtn = document.getElementById('all-tab-overview-btn');
      if (allOverviewBtn) bootstrap.Tab.getOrCreateInstance(allOverviewBtn).show();
    }

    if (window.VTFx) {
      const allOverviewPane = document.getElementById('all-tab-overview');
      requestAnimationFrame(() => VTFx.staggerEntrance(allOverviewPane));
    }

    registerTabRenderer('#all-tab-weapons', () => {
      renderGlobalWeaponMeta('global-weapon-chart', data.global_weapon_meta);
      renderGlobalRivalries(data.global_rivalries);
    });

    registerTabRenderer('#all-tab-commanders', () => {
      const cs = data.commander_stats || { rows: [], head_to_head: [] };
      renderCommanderLeaderboard(cs.rows);
      renderCommanderH2H(cs.head_to_head);
      renderCommanderFactionPicks('commander-faction-picks-canvas', cs.rows);
    });

    registerTabRenderer('#all-tab-meta', () => {
      const mc = data.meta_charts || {
        maps: [], duration_bands: {}, player_counts: {}, submitters: [], matches_over_time: [],
      };
      const fs = data.faction_stats || { by_team_slot: {}, win_counts: {} };
      const mapNameResolver = (mapFile) => {
        const key = (mapFile || '').replace(/\.bzn$/i, '').toLowerCase();
        const reg = (mapRegistry && mapRegistry[key]) || null;
        if (reg && reg.title) {
          // Strip iteratively-stripped XYZ: prefixes the same way the
          // pipeline's resolve_match_name does for the manifest.
          let t = String(reg.title);
          while (/^[A-Za-z0-9]+:\s/.test(t)) t = t.replace(/^[A-Za-z0-9]+:\s*/, '');
          return t;
        }
        return (mapFile || '').replace(/\.bzn$/i, '');
      };
      renderMetaMapsChart('meta-maps-canvas',                   mc.maps, mapNameResolver);
      renderMetaFactionTeamSlot('meta-faction-team1-canvas',    fs.by_team_slot, 1);
      renderMetaFactionTeamSlot('meta-faction-team2-canvas',    fs.by_team_slot, 2);
      renderMetaFactionWinrate('meta-faction-winrate-canvas',   fs.win_counts);
      renderMetaDurationHistogram('meta-duration-canvas',       mc.duration_bands);
      renderMetaPlayerCount('meta-playercount-canvas',          mc.player_counts);
      renderMetaOverTime('meta-overtime-canvas',                mc.matches_over_time);
    });

    registerAllMatchesCharts(data);

    syncUrl();
  }

  function renderTimelineSection(data) {
    const canvas = document.getElementById('timeline-chart');
    const existingChart = activeCharts.find(c => c.canvas === canvas);
    if (existingChart) {
      existingChart.destroy();
      activeCharts = activeCharts.filter(c => c !== existingChart);
    }
    const allNames = data._allNames || data.leaderboard.map(p => p.name);
    renderTimeline('timeline-chart', data.timeline, allNames, timelineMode);
  }

  // --- Positioning Tab ---
  // Built-in empty state when the match has no UpdateTick data. Otherwise
  // renders movement leaderboard, distance timeline, combined heatmap,
  // per-player heatmap grid, and ring histogram. Reacts to global filter
  // by narrowing to data.leaderboard (already filtered upstream) while
  // keeping positioning.players intact so opposing-team spawns still
  // render for spatial context.
  let positioningSortState = { key: 'activity_score', asc: false };

  function renderPositioningTab(data) {
    const positioning = currentData && currentData.positioning;
    const emptyEl = document.getElementById('section-positioning-empty');
    const sectionIds = [
      'section-movement-leaderboard',
      'section-distance-timeline',
      'section-combined-heatmap',
      'section-heatmap-grid',
      'section-ring-histogram',
      'section-positioning-player',
    ];

    const hasData = positioning && positioning.has_position_data;
    if (emptyEl) emptyEl.classList.toggle('d-none', hasData);
    sectionIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('d-none', !hasData);
    });
    if (!hasData) return;

    // Narrow positioning to the filtered leaderboard for highlight purposes,
    // but always pass the full positioning block so heatmap backdrops, team
    // centroids, and opposing-team spawn markers render for spatial context.
    const filteredNames = new Set(data.leaderboard.map(p => p.name));
    const filteredView = {
      ...positioning,
      players: Object.fromEntries(
        Object.entries(positioning.players).filter(([n]) => filteredNames.has(n))
      ),
    };

    renderMovementLeaderboard('movement-leaderboard', filteredView, data.leaderboard, positioningSortState);
    wireMovementLeaderboardSort(data);
    ensureTooltips(document.getElementById('movement-leaderboard'));
    renderDistanceChart(data, filteredView);
    wireDistanceTimelineControls(data, filteredView);
    wireMovementLeaderboardFocus(data, filteredView);
    ensureTooltips(document.getElementById('section-distance-timeline'));
    renderCombinedHeatmap('combined-heatmap-canvas', positioning, data.match);
    renderHeatmapGrid('heatmap-grid-content', filteredView, data.match);
    renderRingHistogram('ring-histogram-chart', filteredView);

    // Stage 3 player mount-point is already in the DOM; the player will
    // self-init here once its module is shipped.
    if (window.VTPositionPlayer) {
      window.VTPositionPlayer.init(
        document.getElementById('positioning-player-content'),
        filteredView,
        currentData.match
      );
    }
  }

  function wireMovementLeaderboardSort(data) {
    const positioning = currentData && currentData.positioning;
    const filteredNames = new Set(data.leaderboard.map(p => p.name));
    const filteredView = positioning ? {
      ...positioning,
      players: Object.fromEntries(
        Object.entries(positioning.players).filter(([n]) => filteredNames.has(n))
      ),
    } : null;
    document.querySelectorAll('#movement-leaderboard th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === positioningSortState.key);
      th.onclick = () => {
        if (positioningSortState.key === th.dataset.sort) positioningSortState.asc = !positioningSortState.asc;
        else { positioningSortState.key = th.dataset.sort; positioningSortState.asc = false; }
        if (filteredView) {
          renderMovementLeaderboard('movement-leaderboard', filteredView, data.leaderboard, positioningSortState);
          wireMovementLeaderboardSort(data);
          // Re-bind click/hover handlers since the sort re-rendered the <tbody>.
          // applyFocusedRowClass() is called inside wireMovementLeaderboardFocus.
          wireMovementLeaderboardFocus(data, filteredView);
        }
      };
    });
  }

  // ------------------------------------------------------------------
  // Distance-from-Spawn timeline: per-session view preferences.
  //
  // `mode` is one of 'bands' (default) | 'all' | 'focus', remembered across
  // matches in localStorage so a user who prefers the raw view keeps it.
  // `smooth` is a 5s centered rolling median toggle, off by default so the
  // chart still reflects the raw samples unless explicitly requested.
  // `focusName` is only meaningful in 'focus' mode; set by clicking a row
  // in the Movement Leaderboard. Not persisted because it's match-specific.
  // ------------------------------------------------------------------
  const DISTANCE_PREFS_KEY = {
    mode: 'vtstats.distanceTimeline.mode',
    smooth: 'vtstats.distanceTimeline.smooth',
  };
  let distanceMode = _readDistanceMode();
  let distanceSmooth = _readDistanceSmooth();
  let distanceFocusName = null;

  function _readDistanceMode() {
    try {
      const v = localStorage.getItem(DISTANCE_PREFS_KEY.mode);
      return (v === 'bands' || v === 'all' || v === 'focus') ? v : 'bands';
    } catch (_) { return 'bands'; }
  }
  function _writeDistanceMode(v) {
    try { localStorage.setItem(DISTANCE_PREFS_KEY.mode, v); } catch (_) { /* ignore */ }
  }
  function _readDistanceSmooth() {
    try { return localStorage.getItem(DISTANCE_PREFS_KEY.smooth) === '1'; }
    catch (_) { return false; }
  }
  function _writeDistanceSmooth(v) {
    try { localStorage.setItem(DISTANCE_PREFS_KEY.smooth, v ? '1' : '0'); }
    catch (_) { /* ignore */ }
  }

  function _factionMapFor(data) {
    const map = {};
    for (const p of data.leaderboard) map[p.name] = p.faction;
    return map;
  }

  function renderDistanceChart(data, filteredView) {
    // If the stored mode is 'focus' but no player is selected yet (or the
    // selected player is filtered out), fall back to 'bands' so we never show
    // an empty chart on first render.
    const effectiveMode = (distanceMode === 'focus' && (!distanceFocusName
      || !filteredView.players[distanceFocusName])) ? 'bands' : distanceMode;
    renderDistanceTimeline(
      'distance-timeline-chart',
      filteredView,
      data.leaderboard.map(p => p.name),
      {
        mode: effectiveMode,
        focusName: distanceFocusName,
        smooth: distanceSmooth,
        factionMap: _factionMapFor(data),
      }
    );
  }

  function wireDistanceTimelineControls(data, filteredView) {
    const group = document.getElementById('distance-mode-toggle');
    if (group) {
      group.querySelectorAll('[data-distance-mode]').forEach(btn => {
        const m = btn.dataset.distanceMode;
        btn.classList.toggle('active', m === distanceMode);
        btn.onclick = () => {
          distanceMode = m;
          _writeDistanceMode(m);
          group.querySelectorAll('[data-distance-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.distanceMode === m);
          });
          renderDistanceChart(data, filteredView);
        };
      });
    }
    const smoothEl = document.getElementById('distance-smooth-toggle');
    if (smoothEl) {
      smoothEl.checked = distanceSmooth;
      smoothEl.onchange = () => {
        distanceSmooth = !!smoothEl.checked;
        _writeDistanceSmooth(distanceSmooth);
        renderDistanceChart(data, filteredView);
      };
    }
  }

  function applyFocusedRowClass() {
    const rows = document.querySelectorAll('#movement-leaderboard tr.vt-movement-row');
    rows.forEach(r => {
      r.classList.toggle('vt-row-focused',
        distanceMode === 'focus' && r.dataset.name === distanceFocusName);
    });
  }

  function wireMovementLeaderboardFocus(data, filteredView) {
    const rows = document.querySelectorAll('#movement-leaderboard tr.vt-movement-row');
    rows.forEach(row => {
      const name = row.dataset.name;
      row.onclick = (ev) => {
        // Let sortable header clicks through; rows don't contain <th> but a
        // click inside the row shouldn't also trigger button/link handlers.
        if (ev.target && ev.target.closest && ev.target.closest('a, button')) return;
        // Toggle off if clicking the already-focused row while in focus mode.
        if (distanceMode === 'focus' && distanceFocusName === name) {
          distanceFocusName = null;
          distanceMode = 'bands';
          _writeDistanceMode('bands');
        } else {
          distanceFocusName = name;
          distanceMode = 'focus';
          _writeDistanceMode('focus');
        }
        const group = document.getElementById('distance-mode-toggle');
        if (group) {
          group.querySelectorAll('[data-distance-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.distanceMode === distanceMode);
          });
        }
        applyFocusedRowClass();
        renderDistanceChart(data, filteredView);
      };
      row.onmouseenter = () => {
        // Programmatic highlight only applies to 'all' mode. Other modes are
        // visually distinct enough that hover nudging would be noise.
        if (distanceMode === 'all' && typeof distanceTimelineHighlight === 'function') {
          distanceTimelineHighlight(name);
        }
      };
      row.onmouseleave = () => {
        if (distanceMode === 'all' && typeof distanceTimelineHighlight === 'function') {
          distanceTimelineHighlight(null);
        }
      };
    });
    applyFocusedRowClass();
  }

  // --- Banner ---
  // Map name + date no longer live here — they've moved into the rich match
  // picker trigger button (updateMatchPickerTriggers) which sits at the start
  // of the hero flex row.
  // ===========================================================================
  // Match Highlights — fixed-slate award catalog (12 cards, always-on).
  // Data comes from match_data.highlights (built by scripts/process_stats.py
  // compute_highlights). Cards whose data gates failed are simply absent.
  // Match-global + always-unfiltered: filterState is intentionally ignored.
  // ===========================================================================

  // Three short variants per (category, narrative) bucket. Selected
  // deterministically (seeded by match id + category) so the same match
  // always shows the same line.
  const HIGHLIGHT_COPY = {
    the_bully: {
      dominant: [
        '{name} ran the table on {top_victim} — {top_victim_damage} of {value} PvP.',
        '{name} bullied the lobby into next week — most on {top_victim}.',
        '{name} dropped {value} PvP dmg and nobody was close.',
      ],
      clear: [
        '{name} led the field on PvP damage at {value}.',
        '{name} took the damage crown — most on {top_victim}.',
        '{name} out-damaged the pack at {value}.',
      ],
      close: [
        '{name} edged the field on PvP damage.',
        '{name} squeaked out the damage lead.',
        '{name} barely held the damage crown.',
      ],
    },
    the_grim_reaper: {
      dominant: [
        '{name} reaped {value} kills — {top_victim_count} of them on {top_victim}.',
        '{name} farmed the lobby for {value} kills.',
        '{name} put a tag on every name in the kill feed.',
      ],
      clear: [
        '{name} led the kill feed with {value}.',
        '{name} topped the kill chart at {value}.',
        '{name} closed out {value} kills.',
      ],
      close: [
        '{name} edged the kill race with {value}.',
        '{name} barely held the kill lead.',
        '{name} squeaked the kill crown.',
      ],
    },
    bullet_sponge: {
      dominant: [
        '{name} ate {value} PvP damage — most of it from {top_tormentor}.',
        '{name} soaked {value} from humans and kept rolling.',
        '{name} was a magnet for incoming fire — {top_tormentor} kept finding them.',
      ],
      clear: [
        '{name} took the most PvP damage — {value}.',
        '{name} caught {value} on the chin.',
        '{name} absorbed {value} from humans.',
      ],
      close: [
        '{name} just barely took the most punishment.',
        '{name} edged the field on PvP damage taken.',
        '{name} narrowly led in damage absorbed.',
      ],
    },
    the_hustler: {
      dominant: [
        '{name} traded {kills} kills for {deaths} deaths — efficiency clinic.',
        '{name} posted a {value} K/D and made it look easy.',
        '{name} ran {kills}K / {deaths}D — nobody else came close.',
      ],
      clear: [
        '{name} led K/D at {value} ({kills}/{deaths}).',
        '{name} closed out the best trade ratio at {value}.',
        '{name} topped K/D at {value}.',
      ],
      close: [
        '{name} edged the K/D lead at {value}.',
        '{name} squeaked the best trade ratio.',
        '{name} barely held the top K/D.',
      ],
    },
    sharpshooter: {
      dominant: [
        '{name} hit {shots_hit} of {shots_fired} shots — a laser.',
        '{name} sniped at {value} accuracy.',
        '{name} aimed like the rest were spraying.',
      ],
      clear: [
        '{name} led accuracy at {value} ({shots_hit}/{shots_fired}).',
        '{name} put rounds on target at {value}.',
        '{name} topped the accuracy table.',
      ],
      close: [
        '{name} edged the accuracy lead.',
        '{name} barely won the accuracy crown.',
        '{name} squeaked top accuracy.',
      ],
    },
    gunner: {
      dominant: [
        '{name} sent {value} rounds downrange — and kept going.',
        '{name} held the trigger for {value} shots.',
        '{name} could not stop firing — {value} shots.',
      ],
      clear: [
        '{name} fired the most rounds — {value}.',
        '{name} put {value} rounds in the air.',
        '{name} led shots fired at {value}.',
      ],
      close: [
        '{name} edged the trigger-pull race.',
        '{name} barely fired more than the next.',
        '{name} squeaked the shots-fired lead.',
      ],
    },
    puppeteer: {
      dominant: [
        '{name}\u2019s scavs and turrets did {value} damage on their own.',
        '{name} let the AI cook — {value} asset damage.',
        '{name} commanded a small army for {value} damage.',
      ],
      clear: [
        '{name} got {value} damage from owned assets.',
        '{name} pulled strings for {value} asset damage.',
        '{name} had the busiest turrets and scavs.',
      ],
      close: [
        '{name} edged the asset-damage race.',
        '{name} barely led on owned-AI damage.',
        '{name} squeaked the puppeteer crown.',
      ],
    },
    frenemies: {
      dominant: [
        '{a} and {b} would not stop trading shots — {value} dmg between them.',
        '{a} and {b} ran their own private war.',
        '{a} vs {b} accounted for the loudest pocket of the lobby.',
      ],
      clear: [
        '{a} and {b} traded {value} damage.',
        '{a} and {b} kept finding each other for {value} damage.',
        '{a} vs {b} was the headline matchup.',
      ],
      close: [
        '{a} and {b} kept brushing past each other for {value} damage.',
        '{a} vs {b} stayed neck-and-neck.',
        '{a} and {b} matched blow for blow.',
      ],
    },
    roadrunner: {
      dominant: [
        '{name} covered the map — activity score {value}.',
        '{name} would not stand still. Score: {value}.',
        '{name} roamed everywhere — {value}/100 activity.',
      ],
      clear: [
        '{name} led the map in activity at {value}/100.',
        '{name} clocked the most ground covered.',
        '{name} stayed on the move all match.',
      ],
      close: [
        '{name} edged the activity board.',
        '{name} barely led on map coverage.',
        '{name} squeaked the most-active crown.',
      ],
    },
    crate_pod_goblin: {
      dominant: [
        '{name} scooped {pickups} crates and trashed {destructions} more.',
        '{name} ran the powerup economy — {pickups} pickups, {destructions} denials.',
        '{name} would not let a crate live — {pickups}/{destructions}.',
      ],
      clear: [
        '{name} grabbed {pickups} crates and shot {destructions} more.',
        '{name} owned the powerup map: {pickups} pickups + {destructions} kills.',
        '{name} ran the crate route ({pickups}+{destructions}).',
      ],
      close: [
        '{name} edged the crate hustle ({pickups}+{destructions}).',
        '{name} barely led the powerup tally.',
        '{name} squeaked the crate crown.',
      ],
    },
    chris_kyle: {
      dominant: [
        '{name} put a scope on everyone — {value} pilot snipes ({top_victim_count} on {top_victim}).',
        '{name} sniped {value} pilots out of their seats.',
        '{name} hunted cockpits all match — {value} snipes.',
      ],
      clear: [
        '{name} led pilot snipes at {value}.',
        '{name} popped {value} pilots clean.',
        '{name} took {value} cockpit kills.',
      ],
      close: [
        '{name} edged the snipe race at {value}.',
        '{name} squeaked the snipe crown.',
        '{name} barely led pilot snipes.',
      ],
    },
    the_locksmith: {
      dominant: [
        '{name} dominated T-key usage — target lock active ~{seconds_locked}s of {total_seconds}s.',
        '{name} ran target mode for {value} of the match.',
        '{name} owned the target-lock board at {value}.',
      ],
      clear: [
        '{name} had a target locked {value} of the time.',
        '{name} led T-key usage at {value}.',
        '{name} ran target mode for {value} of the match.',
      ],
      close: [
        '{name} edged the target-lock board at {value}.',
        '{name} squeaked the locksmith title.',
        '{name} barely led on T-key usage.',
      ],
    },
  };

  // Soft FNV-1a-ish hash — small, deterministic, no need for crypto.
  // Used to pick a copy variant per (matchId, category) so the same match
  // always shows the same line, but two matches don't echo each other.
  function _hlHash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function formatHighlightValue(value, format) {
    if (value == null) return '—';
    switch (format) {
      case 'damage':   return Math.round(value).toLocaleString();
      case 'distance': return Math.round(value).toLocaleString();
      case 'count':    return Math.round(value).toLocaleString();
      case 'score':    return Math.round(value).toLocaleString();
      case 'ratio':    return Number(value).toFixed(2);
      case 'kd':       return Number(value).toFixed(2);
      case 'percent':
      case 'accuracy': return (Number(value) * 100).toFixed(1) + '%';
      default:         return String(value);
    }
  }

  // Per-category unit suffix appended to the headline value (and runner-up).
  // Empty string for cards whose value_format already self-labels (`accuracy`
  // / `percent` produce e.g. "27.4%") or whose breakdown line already supplies
  // the context (Pod Goblin shows "X grabbed · Y denied"). Pure
  // presentation; not part of the JSON payload. Adding a new card requires
  // adding an entry here.
  const HIGHLIGHT_UNITS = {
    the_bully:        'dmg',
    the_grim_reaper:  'kills',
    bullet_sponge:    'dmg',
    the_hustler:      'K/D',
    sharpshooter:     '',
    gunner:           'shots',
    puppeteer:        'dmg',
    frenemies:        'dmg',
    roadrunner:       'mvnt',
    crate_pod_goblin: '',
    chris_kyle:       'snipes',
    the_locksmith:    '',
  };

  // Presentation-only overrides for the tile heading. The pipeline emits a
  // canonical `card.label` ("Gunner", etc.); this map lets us rebrand a card
  // in the UI without rewriting historical processed JSON.
  const HIGHLIGHT_LABEL_OVERRIDES = {
    gunner: 'Trigger Happy',
  };

  // ---- Career Highlights (built client-side by the aggregator) ----
  // Three flavor lines per (category, narrative) bucket. Selected
  // deterministically by hash(matchId='all-matches' + category) so the
  // same All Matches view always shows the same line; the Per-match
  // and Career grids render their own copy tables independently.
  const CAREER_HIGHLIGHT_COPY = {
    career_the_bully: {
      dominant: [
        '{name} has spent {value} dmg on humans across the corpus — most on {top_victim}.',
        '{name} bullied the league for {value} PvP dmg.',
        '{name} farms PvP like a job — {value} lifetime.',
      ],
      clear: [
        '{name} leads career PvP damage at {value}.',
        '{name} tops the lifetime PvP charts with {value}.',
        '{name} owns the long-haul PvP crown.',
      ],
      close: [
        '{name} narrowly leads career PvP damage.',
        '{name} edges the lifetime PvP race.',
        '{name} squeaks the all-time PvP crown.',
      ],
    },
    career_the_grim_reaper: {
      dominant: ['{name} has reaped {value} kills league-wide.', '{name} owns the all-time kill column.', '{name} has tagged the corpus {value} times.'],
      clear:    ['{name} leads career kills at {value}.',        '{name} tops the lifetime kill chart.',  '{name} closes out the most kills.'],
      close:    ['{name} narrowly leads career kills.',          '{name} edges the lifetime kill race.',  '{name} squeaks the all-time kill crown.'],
    },
    career_bullet_sponge: {
      dominant: ['{name} has absorbed {value} dmg lifetime — a magnet.', '{name} soaks more incoming than anyone — {value} all-time.', '{name} won\u2019t stop catching rounds — {value} lifetime.'],
      clear:    ['{name} leads career damage taken at {value}.',         '{name} has eaten the most lifetime damage.',                 '{name} tops the all-time absorbed-dmg column.'],
      close:    ['{name} edges career absorbed damage.',                 '{name} narrowly leads lifetime damage taken.',               '{name} squeaks the long-haul sponge crown.'],
    },
    career_the_hustler: {
      dominant: ['{name}\u2019s career K/D of {value} ({kills}/{deaths}) is a clinic.', '{name} runs a {value} lifetime trade ratio.', '{name} owns the K/D column at {value}.'],
      clear:    ['{name} leads career K/D at {value} ({kills}/{deaths}).',              '{name} tops the lifetime trade ratio at {value}.', '{name} holds the best long-run K/D.'],
      close:    ['{name} edges career K/D at {value}.',                                 '{name} narrowly leads the lifetime trade ratio.',  '{name} squeaks the all-time K/D crown.'],
    },
    career_sharpshooter: {
      dominant: ['{name} hits {value} of shots fired ({shots_hit}/{shots_fired}). Laser.', '{name} is a sniper — {value} career accuracy.', '{name}\u2019s {value} accuracy across {shots_fired} shots is wild.'],
      clear:    ['{name} leads career accuracy at {value}.',                               '{name} tops the lifetime accuracy column.',     '{name} owns the long-run sharpshooter crown.'],
      close:    ['{name} edges career accuracy at {value}.',                               '{name} narrowly leads lifetime accuracy.',      '{name} squeaks the all-time accuracy crown.'],
    },
    career_trigger_happy: {
      dominant: ['{name} has fired {value} rounds league-wide. Get this person an ammo subscription.', '{name} held the trigger for {value} shots across the corpus.', '{name}\u2019s {value} lifetime shots is hard to fathom.'],
      clear:    ['{name} fired the most rounds — {value} lifetime.',                                  '{name} leads lifetime shots at {value}.',                       '{name} tops the all-time trigger column.'],
      close:    ['{name} edges lifetime shots at {value}.',                                           '{name} narrowly leads career shots fired.',                     '{name} squeaks the all-time trigger crown.'],
    },
    career_puppeteer: {
      dominant: ['{name}\u2019s scavs and turrets have done {value} dmg lifetime.', '{name} commands a small army — {value} asset dmg.',  '{name} owns the lifetime puppeteer column at {value}.'],
      clear:    ['{name} leads career asset dmg at {value}.',                       '{name} pulled the most strings overall.',            '{name} tops the all-time puppeteer chart.'],
      close:    ['{name} edges career asset dmg at {value}.',                       '{name} narrowly leads lifetime asset dmg.',          '{name} squeaks the long-run puppeteer crown.'],
    },
    career_frenemies: {
      dominant: ['{a} and {b} have traded {value} dmg over the years.', '{a} and {b} are each other\u2019s favorite enemy.', '{a} vs {b} is the corpus\u2019s headline matchup.'],
      clear:    ['{a} and {b} traded {value} dmg.',                     '{a} and {b} have the corpus\u2019s top rivalry.',   '{a} vs {b} leads career rivalries.'],
      close:    ['{a} and {b} narrowly lead career rivalries.',         '{a} vs {b} squeaks the all-time pair crown.',       '{a} and {b} edge the lifetime pair race.'],
    },
    career_roadrunner: {
      dominant: ['{name} averages {value}/100 activity across {matches_with_positioning}+ matches.', '{name} won\u2019t sit still — {value} mean.', '{name} covers more map than anyone — {value} avg.'],
      clear:    ['{name} leads career mobility at {value}/100.',                                    '{name} tops average activity across the corpus.', '{name} owns the long-run mobility crown.'],
      close:    ['{name} edges career mobility at {value}.',                                        '{name} narrowly leads lifetime activity.',        '{name} squeaks the all-time mobility crown.'],
    },
    career_pod_goblin: {
      dominant: ['{name} has scooped {pickups} crates and trashed {destructions} more.', '{name} runs the corpus pickup economy.',         '{name} owns the lifetime crate column at {value}.'],
      clear:    ['{name} grabbed {pickups} + denied {destructions} crates lifetime.',     '{name} leads career powerup activity at {value}.', '{name} tops the all-time crate chart.'],
      close:    ['{name} edges career crate activity at {value}.',                        '{name} narrowly leads lifetime pickups + denials.', '{name} squeaks the long-run pod-goblin crown.'],
    },
    career_chris_kyle: {
      dominant: ['{name} has sniped {value} pilots out of their cockpits.', '{name} hunts cockpits for sport — {value} lifetime.', '{name} owns the snipe column at {value}.'],
      clear:    ['{name} leads career snipes at {value}.',                  '{name} tops lifetime pilot snipes at {value}.',         '{name} holds the all-time snipe crown.'],
      close:    ['{name} edges career snipes at {value}.',                  '{name} narrowly leads lifetime snipes.',                '{name} squeaks the all-time snipe crown.'],
    },
    career_the_locksmith: {
      dominant: ['{name} averages {value} target lock — basically welded to the T key.', '{name} runs target mode for {value} of every match.', '{name} dominates lifetime T-key usage.'],
      clear:    ['{name} averages {value} target lock across rated matches.',            '{name} leads career T-key usage at {value}.',          '{name} tops the all-time locksmith column.'],
      close:    ['{name} edges career T-key usage at {value}.',                          '{name} narrowly leads lifetime target lock.',          '{name} squeaks the long-run locksmith crown.'],
    },
    the_champion: {
      dominant: ['{name} sits at {value} VTSR-T with {matches_played} rated matches.', '{name} owns the league. {value} VTSR-T.',          '{name} is the corpus champion at {value}.'],
      clear:    ['{name} tops the VTSR-T ladder at {value}.',                          '{name} holds the highest VTSR-T — {value}.',        '{name} leads the league rating column.'],
      close:    ['{name} edges the VTSR-T ladder at {value}.',                         '{name} narrowly leads the league rating.',        '{name} squeaks the top of the VTSR-T ladder.'],
    },
    the_veteran: {
      dominant: ['{name} has been to {value} matches and counting.', '{name} is the all-time leader in showing up.',       '{name} has the most miles on the odometer.'],
      clear:    ['{name} has played the most matches — {value}.',    '{name} leads career match count at {value}.',         '{name} owns the all-time appearance column.'],
      close:    ['{name} narrowly leads matches played at {value}.', '{name} edges the lifetime attendance race.',          '{name} squeaks the most-matches-played crown.'],
    },
    the_workhorse: {
      dominant: ['{name} has commanded {value} matches league-wide.', '{name} is the corpus\u2019s favorite commander.',     '{name} owns the lifetime command column at {value}.'],
      clear:    ['{name} leads matches as commander at {value}.',     '{name} tops career command appearances.',             '{name} holds the all-time workhorse crown.'],
      close:    ['{name} edges career commander matches at {value}.', '{name} narrowly leads lifetime command count.',       '{name} squeaks the workhorse crown.'],
    },
    the_carry: {
      dominant: ['{name} wins {value} of commanded matches — pure carry energy.', '{name} carries every game they command.',          '{name} owns the commander win-rate column at {value}.'],
      clear:    ['{name} leads commander win % at {value}.',                      '{name} tops career commander wins at {value}.',     '{name} holds the all-time carry crown.'],
      close:    ['{name} edges commander win % at {value}.',                      '{name} narrowly leads commander wins.',             '{name} squeaks the carry crown.'],
    },
    the_anchor: {
      dominant: ['{name} wins {value} of matches as a thug — the anchor that never breaks.', '{name} is a wall on the back line.',     '{name} owns the thug win-rate column at {value}.'],
      clear:    ['{name} leads thug win % at {value}.',                                       '{name} tops career thug wins at {value}.', '{name} holds the all-time anchor crown.'],
      close:    ['{name} edges thug win % at {value}.',                                       '{name} narrowly leads thug wins.',         '{name} squeaks the anchor crown.'],
    },
    isdf_loyalist: {
      dominant: ['{name} has played ISDF in {value} matches — true believer.', '{name} bleeds ISDF cyan.',                       '{name} is the league\u2019s ISDF poster child.'],
      clear:    ['{name} leads ISDF appearances at {value}.',                  '{name} has the most ISDF matches — {value}.',     '{name} tops the all-time ISDF column.'],
      close:    ['{name} edges ISDF appearances at {value}.',                  '{name} narrowly leads ISDF matches.',             '{name} squeaks the ISDF loyalist crown.'],
    },
    hadean_loyalist: {
      dominant: ['{name} has played Hadean in {value} matches — true believer.', '{name} bleeds Hadean red.',                     '{name} is the league\u2019s Hadean poster child.'],
      clear:    ['{name} leads Hadean appearances at {value}.',                   '{name} has the most Hadean matches — {value}.', '{name} tops the all-time Hadean column.'],
      close:    ['{name} edges Hadean appearances at {value}.',                   '{name} narrowly leads Hadean matches.',         '{name} squeaks the Hadean loyalist crown.'],
    },
    scion_loyalist: {
      dominant: ['{name} has played Scion in {value} matches — true believer.',  '{name} bleeds Scion green.',                    '{name} is the league\u2019s Scion poster child.'],
      clear:    ['{name} leads Scion appearances at {value}.',                    '{name} has the most Scion matches — {value}.',  '{name} tops the all-time Scion column.'],
      close:    ['{name} edges Scion appearances at {value}.',                    '{name} narrowly leads Scion matches.',          '{name} squeaks the Scion loyalist crown.'],
    },
    the_diplomat: {
      dominant: ['{name} has shared a team with {value} different players. Friend to all.', '{name} is everyone\u2019s teammate — {value} distinct.', '{name} owns the diplomacy column at {value}.'],
      clear:    ['{name} leads distinct teammates at {value}.',                              '{name} has played alongside the most people.',           '{name} holds the corpus diplomat crown.'],
      close:    ['{name} edges distinct teammates at {value}.',                              '{name} narrowly leads career teammate variety.',         '{name} squeaks the diplomat crown.'],
    },
    map_master: {
      dominant: ['{name} wins {value} of matches on {map_name} ({kills}-{deaths}). Owns it.', '{name} owns {map_name} — {value} W%.',    '{name} is the king of {map_name} at {value}.'],
      clear:    ['{name} leads {map_name} with {value} W% ({kills}-{deaths}).',              '{name} tops the win % on {map_name}.',     '{name} holds the {map_name} crown.'],
      close:    ['{name} edges {map_name} W% at {value}.',                                   '{name} narrowly leads {map_name}.',        '{name} squeaks the {map_name} crown.'],
    },
    streak_king: {
      dominant: ['{name} is on a {value}-match win streak. Untouchable right now.', '{name} hasn\u2019t lost in {value} matches.',  '{name} is on a tear — {value} wins running.'],
      clear:    ['{name} leads active streaks at {value} wins.',                    '{name} has the longest current win streak.',   '{name} holds the streak crown at {value}.'],
      close:    ['{name} edges active streaks at {value} wins.',                    '{name} narrowly leads current streaks.',       '{name} squeaks the streak crown.'],
    },
    the_polymath: {
      dominant: ['{name} has fired {value} different weapons across the corpus. Renaissance pilot.', '{name} has touched every weapon in the game.', '{name} owns the all-time variety column at {value}.'],
      clear:    ['{name} leads career weapon variety at {value}.',                                   '{name} tops the lifetime polymath column.',     '{name} holds the all-time variety crown.'],
      close:    ['{name} edges career weapon variety at {value}.',                                   '{name} narrowly leads lifetime weapon count.',  '{name} squeaks the polymath crown.'],
    },
  };

  const CAREER_HIGHLIGHT_UNITS = {
    career_the_bully:        'dmg',
    career_the_grim_reaper:  'kills',
    career_bullet_sponge:    'dmg',
    career_the_hustler:      'K/D',
    career_sharpshooter:     '',
    career_trigger_happy:    'shots',
    career_puppeteer:        'dmg',
    career_frenemies:        'dmg',
    career_roadrunner:       'mvnt',
    career_pod_goblin:       '',
    career_chris_kyle:       'snipes',
    career_the_locksmith:    '',
    the_champion:            'VTSR-T',
    the_veteran:             'matches',
    the_workhorse:           'commands',
    the_carry:               '',
    the_anchor:              '',
    isdf_loyalist:           'matches',
    hadean_loyalist:         'matches',
    scion_loyalist:          'matches',
    the_diplomat:            'teammates',
    map_master:              '',
    streak_king:             'wins',
    the_polymath:            'wpns',
  };

  // No career-mode label overrides — labels come straight from the
  // aggregator's CAREER_HIGHLIGHT_LABELS table.
  const CAREER_HIGHLIGHT_LABEL_OVERRIDES = {};

  // Schema v2 breakdown line: pre-computed per-category context that gives the
  // headline number meaning ("4.00" -> "12K / 3D (4.00)", "27.4%" -> "482 / 1,758").
  // Expects card.value_breakdown to carry the keys produced by compute_highlights()
  // in scripts/process_stats.py. Returns '' when no breakdown data is available
  // so the line is skipped cleanly.
  function formatHighlightBreakdown(card) {
    const b = card.value_breakdown || {};
    switch (card.category) {
      case 'the_bully':
        return b.top_victim
          ? `most on ${esc(b.top_victim)}: ${fmt(b.top_victim_damage)} dmg`
          : '';
      case 'the_grim_reaper':
        return b.top_victim
          ? `${b.top_victim_count} kills on ${esc(b.top_victim)}`
          : '';
      case 'bullet_sponge':
        return b.top_tormentor
          ? `most from ${esc(b.top_tormentor)}: ${fmt(b.top_tormentor_damage)} dmg`
          : '';
      case 'the_hustler': {
        if (b.kills == null && b.deaths == null) return '';
        const ratio = (b.deaths === 0 && b.kills > 0) ? 'perfect' : Number(card.value).toFixed(2);
        return `${b.kills}K / ${b.deaths}D (${ratio})`;
      }
      case 'sharpshooter':
        if (b.shots_hit == null || b.shots_fired == null) return '';
        return `${fmt(b.shots_hit)} / ${fmt(b.shots_fired)} shots`;
      case 'gunner':
        if (b.accuracy == null) return '';
        return `@ ${(Number(b.accuracy) * 100).toFixed(1)}% accuracy`;
      case 'puppeteer':
        if (b.personal_dealt == null) return '';
        return `vs ${fmt(b.personal_dealt)} personal dmg`;
      case 'frenemies':
        if (b.a_to_b == null || b.b_to_a == null) return '';
        return `${esc(card.winner.a)} ${fmt(b.a_to_b)} \u2194 ${esc(card.winner.b)} ${fmt(b.b_to_a)}`;
      case 'roadrunner': {
        const parts = [];
        if (b.movement_band) parts.push(esc(b.movement_band));
        if (b.path_length != null) parts.push(`${fmt(b.path_length)}u path`);
        return parts.join(' \u00b7 ');
      }
      case 'crate_pod_goblin':
        if (b.pickups == null && b.destructions == null) return '';
        return `${fmt(b.pickups || 0)} grabbed \u00b7 ${fmt(b.destructions || 0)} denied`;
      case 'chris_kyle':
        return b.top_victim
          ? `${b.top_victim_count} snipes on ${esc(b.top_victim)}`
          : '';
      case 'the_locksmith':
        if (b.seconds_locked == null || b.total_seconds == null) return '';
        return `~${fmt(b.seconds_locked)}s of ${fmt(b.total_seconds)}s`;
      // ---- Career Highlights ----
      case 'career_the_bully':
        return b.top_victim
          ? `most on ${esc(b.top_victim)}: ${fmt(b.top_victim_damage)} dmg`
          : '';
      case 'career_the_hustler': {
        if (b.kills == null && b.deaths == null) return '';
        return `${fmt(b.kills)}K / ${fmt(b.deaths)}D career`;
      }
      case 'career_sharpshooter':
        if (b.shots_hit == null || b.shots_fired == null) return '';
        return `${fmt(b.shots_hit)} / ${fmt(b.shots_fired)} shots career`;
      case 'career_frenemies':
        if (b.a_to_b == null || b.b_to_a == null) return '';
        return `${esc(card.winner.a)} ${fmt(b.a_to_b)} \u2194 ${esc(card.winner.b)} ${fmt(b.b_to_a)}`;
      case 'career_roadrunner': {
        const parts = [];
        if (b.movement_band) parts.push(esc(b.movement_band));
        if (b.path_length != null) parts.push(`${fmt(b.path_length)}u path`);
        return parts.join(' \u00b7 ');
      }
      case 'career_pod_goblin':
        if (b.pickups == null && b.destructions == null) return '';
        return `${fmt(b.pickups || 0)} grabbed \u00b7 ${fmt(b.destructions || 0)} denied`;
      case 'the_champion':
        if (b.matches_played == null) return '';
        return `${b.matches_played} rated · peak ${b.peak_vtsr != null ? Math.round(b.peak_vtsr) : '—'}`;
      case 'the_carry':
        if (b.kills == null && b.deaths == null) return '';
        return `${b.kills}W / ${b.deaths}L commanding`;
      case 'map_master':
        if (!b.map_name) return '';
        return `${esc(b.map_name)} (${b.kills}-${b.deaths})`;
      default:
        return '';
    }
  }

  function _hlFormatDeltaPct(delta) {
    if (delta == null) return '';
    return Math.round(delta * 100) + '%';
  }

  function _hlInterp(template, ctx) {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      const v = ctx[key];
      return v == null ? '' : String(v);
    });
  }

  // True when every {token} in `template` resolves to a non-empty value in ctx.
  // Used by _hlPickCopy below to skip templates that would interpolate empties
  // (e.g. a `{top_victim}`-flavored line on a legacy match with no kill data).
  function _hlTemplateSatisfied(template, ctx) {
    const matches = template.match(/\{(\w+)\}/g) || [];
    for (const m of matches) {
      const key = m.slice(1, -1);
      const v = ctx[key];
      if (v === '' || v == null) return false;
    }
    return true;
  }

  function _hlPickCopy(category, narrative, matchId, ctx, copyTable) {
    const table = copyTable || HIGHLIGHT_COPY;
    const bucket = (table[category] || {})[narrative]
      || (table[category] || {})['clear']
      || [];
    if (!bucket.length) return '';
    const seed = _hlHash(`${matchId || ''}|${category}`);
    // Prefer the deterministic pick when its tokens are all satisfied; otherwise
    // walk the bucket from the seeded index forward and use the first viable
    // variant. As a last resort, return the original deterministic pick (will
    // render with empty interp slots) so we never emit nothing.
    const start = seed % bucket.length;
    for (let i = 0; i < bucket.length; i++) {
      const candidate = bucket[(start + i) % bucket.length];
      if (_hlTemplateSatisfied(candidate, ctx)) return candidate;
    }
    return bucket[start];
  }

  // Render a Match Highlights or Career Highlights grid. `mode` selects
  // the lookup tables AND the DOM containers:
  //   'match'  → #section-highlights         + #highlights-grid
  //   'career' → #section-career-highlights + #career-highlights-grid
  // matchInfo carries the seeding key used to pick deterministic copy
  // variants (per-match: match.id; career: a stable string like 'all-matches').
  function renderHighlights(highlights, matchInfo, mode) {
    const isCareer = mode === 'career';
    const cardId = isCareer ? 'section-career-highlights' : 'section-highlights';
    const gridId = isCareer ? 'career-highlights-grid'    : 'highlights-grid';
    const copyTable     = isCareer ? CAREER_HIGHLIGHT_COPY            : HIGHLIGHT_COPY;
    const unitsTable    = isCareer ? CAREER_HIGHLIGHT_UNITS           : HIGHLIGHT_UNITS;
    const overridesTable = isCareer ? CAREER_HIGHLIGHT_LABEL_OVERRIDES : HIGHLIGHT_LABEL_OVERRIDES;
    const card = document.getElementById(cardId);
    const grid = document.getElementById(gridId);
    if (!card || !grid) return;

    const cards = (highlights && Array.isArray(highlights.cards)) ? highlights.cards : [];
    if (!cards.length) {
      card.classList.add('d-none');
      grid.innerHTML = '';
      return;
    }
    card.classList.remove('d-none');

    const matchId = (matchInfo && matchInfo.id) || '';

    grid.innerHTML = cards.map(c => {
      const isPair = c.winner && c.winner.type === 'pair';
      const winnerName = isPair
        ? `${esc(c.winner.a)} <span class="vt-highlight-tile-vs">vs</span> ${esc(c.winner.b)}`
        : esc(c.winner && c.winner.name || '—');
      const valueStr = formatHighlightValue(c.value, c.value_format);
      const breakdown = c.value_breakdown || {};
      // Interpolation context: every documented token from the v2 spec, with
      // sensible fallbacks ('' for missing fields). Numeric fields go through
      // fmt() so locale-grouped digits render the same in copy and breakdown.
      const ctx = {
        name: (c.winner && c.winner.name) || '',
        a: (c.winner && c.winner.a) || '',
        b: (c.winner && c.winner.b) || '',
        value: valueStr,
        delta_pct: _hlFormatDeltaPct(c.delta_pct),
        top_victim: breakdown.top_victim || '',
        top_victim_damage: breakdown.top_victim_damage != null ? fmt(breakdown.top_victim_damage) : '',
        top_victim_count: breakdown.top_victim_count != null ? breakdown.top_victim_count : '',
        top_tormentor: breakdown.top_tormentor || '',
        top_tormentor_damage: breakdown.top_tormentor_damage != null ? fmt(breakdown.top_tormentor_damage) : '',
        kills: breakdown.kills != null ? breakdown.kills : '',
        deaths: breakdown.deaths != null ? breakdown.deaths : '',
        shots_hit: breakdown.shots_hit != null ? fmt(breakdown.shots_hit) : '',
        shots_fired: breakdown.shots_fired != null ? fmt(breakdown.shots_fired) : '',
        accuracy: breakdown.accuracy != null ? (Number(breakdown.accuracy) * 100).toFixed(1) + '%' : '',
        personal_dealt: breakdown.personal_dealt != null ? fmt(breakdown.personal_dealt) : '',
        a_to_b: breakdown.a_to_b != null ? fmt(breakdown.a_to_b) : '',
        b_to_a: breakdown.b_to_a != null ? fmt(breakdown.b_to_a) : '',
        movement_band: breakdown.movement_band || '',
        path_length: breakdown.path_length != null ? fmt(breakdown.path_length) : '',
        seconds_locked: breakdown.seconds_locked != null ? breakdown.seconds_locked : '',
        total_seconds: breakdown.total_seconds != null ? breakdown.total_seconds : '',
        pickups: breakdown.pickups != null ? breakdown.pickups : '',
        destructions: breakdown.destructions != null ? breakdown.destructions : '',
        // Career-mode tokens (no-op for per-match cards).
        matches_played: breakdown.matches_played != null ? breakdown.matches_played : '',
        peak_vtsr:      breakdown.peak_vtsr != null ? Math.round(breakdown.peak_vtsr) : '',
        map_name:       breakdown.map_name || '',
        matches_with_positioning: breakdown.matches_with_positioning != null ? breakdown.matches_with_positioning : '',
      };
      const flavor = _hlInterp(_hlPickCopy(c.category, c.narrative, matchId, ctx, copyTable), ctx);
      const breakdownLine = formatHighlightBreakdown(c);
      // Per-category unit suffix (presentation only). Empty string falls back
      // to bare value display for cards whose value_format already self-labels.
      const unit = unitsTable[c.category] || '';
      const unitHtml = unit ? ` <span class="vt-highlight-tile-value-unit">${esc(unit)}</span>` : '';
      const runner = c.runner_up;
      let runnerLine = '';
      if (runner && runner.name) {
        const runnerNum = formatHighlightValue(runner.value, c.value_format);
        const runnerStr = unit ? `${runnerNum} ${unit}` : runnerNum;
        runnerLine = `<div class="vt-highlight-tile-runner">vs ${esc(runner.name)} <span class="vt-highlight-tile-runner-val">${esc(runnerStr)}</span></div>`;
      } else {
        runnerLine = '<div class="vt-highlight-tile-runner vt-highlight-tile-runner--solo">solo standout</div>';
      }
      const dominantClass = c.narrative === 'dominant' ? ' vt-highlight-tile--dominant' : '';
      const tipAttr = flavor
        ? ` data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(flavor)}"`
        : '';
      return `
        <div class="col" data-vt-stagger-child>
          <div class="vt-highlight-tile${dominantClass}"${tipAttr} data-highlight-category="${esc(c.category)}">
            <div class="vt-highlight-tile-head">
              <i class="bi ${esc(c.icon || 'bi-trophy-fill')} vt-highlight-tile-icon"></i>
              <span class="vt-highlight-tile-label">${esc(overridesTable[c.category] || c.label)}</span>
            </div>
            <div class="vt-highlight-tile-winner">${winnerName}</div>
            <div class="vt-highlight-tile-value">${valueStr}${unitHtml}</div>
            ${breakdownLine ? `<div class="vt-highlight-tile-breakdown">${breakdownLine}</div>` : ''}
            ${flavor ? `<div class="vt-highlight-tile-copy">${esc(flavor)}</div>` : ''}
            ${runnerLine}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderBanner(info) {
    const m = Math.floor(info.duration_sec / 60);
    const s = Math.floor(info.duration_sec % 60);
    document.getElementById('info-duration').textContent = `${m}m ${s}s`;
    document.getElementById('info-players').textContent = info.player_count;
    document.getElementById('info-submitter').textContent = info.submitter || '—';
    const rawLink = document.getElementById('info-raw-link');
    if (rawLink && info.id) {
      rawLink.href = `raw.html?match=${encodeURIComponent(info.id)}`;
    }
    const snipesWrap = document.getElementById('info-snipes-wrap');
    if (info.snipe_count > 0) {
      document.getElementById('info-snipes').textContent = info.snipe_count;
      snipesWrap.classList.remove('d-none');
    } else {
      snipesWrap.classList.add('d-none');
    }

    // Map-dimension stat blocks (Map size, Elevation, Base-to-base, Author)
    // + thumbnail. Sources are merged by getMapMeta() below.
    renderMapBannerFields(info);
  }

  // Merge sources for map metadata into a single object used by the hero
  // banner and the overlay renderers (positioning-charts, positioning-player,
  // match-picker thumbnails). Precedence for imageBounds (the projection
  // basis shared by the image background and all data points rendered on
  // top of it):
  //   1. data/map-registry.json -> image_calibration.image_bounds_world
  //      (hand-tuned 2D override when iondriver's image doesn't line up
  //      with terrain_bounds exactly)
  //   2. match.terrain_bounds (projected to 2D xz — what the pipeline emits
  //      from StatHeader terrain fields)
  //   3. match.map_bounds when positioning is present but terrain_bounds
  //      isn't (pre-schema matches)
  //   4. null -> graceful no-overlay fallback (map image still renders if
  //      present via `imagePath`, but data points won't be projected).
  // Any field may be null/undefined when unavailable.
  function getMapMeta(match) {
    const rawMap = (match && match.map) || '';
    const key = rawMap.replace(/\.bzn$/i, '').toLowerCase();
    const registry = (mapRegistry && mapRegistry[key]) || {};
    const vsr = (window.BZ2API && window.BZ2API.VSR_MAP_DATA && window.BZ2API.VSR_MAP_DATA[key]) || {};
    const terrain = match && match.terrain_bounds;

    // Library's `size` field stores half-edge (0..size means terrain
    // extends +-size around origin); full edge = size * 2.
    const librarySize = vsr.size ? vsr.size * 2 : null;

    // Resolve imageBounds for overlay projection. Registry calibration wins
    // when present; otherwise fall back to terrain_bounds (2D xz slice) or
    // the positioning block's map_bounds.
    const calib = registry && registry.image_calibration;
    const calibBounds = (calib && calib.image_bounds_world) || null;
    let imageBounds = null;
    if (calibBounds && calibBounds.min && calibBounds.max) {
      imageBounds = calibBounds;
    } else if (terrain && terrain.min && terrain.max) {
      imageBounds = {
        min: { x: terrain.min.x, z: terrain.min.z },
        max: { x: terrain.max.x, z: terrain.max.z },
      };
    }

    return {
      key,
      title: registry.title || null,
      imagePath: registry.image_path || null,
      imageBounds,
      author: (registry.author || vsr.author || null),
      canonicalB2B: (registry.canonical_b2b != null ? registry.canonical_b2b : (vsr.baseToBase || null)),
      canonicalSize: (registry.canonical_size != null ? registry.canonical_size : librarySize),
      terrainSize: terrain
        ? { x: terrain.max.x - terrain.min.x, y: terrain.max.y - terrain.min.y, z: terrain.max.z - terrain.min.z }
        : null,
      elevation: terrain
        ? { min: terrain.min.y, max: terrain.max.y }
        : null,
      empiricalB2B: (match && match.base_to_base_distance != null) ? match.base_to_base_distance : null,
      boundsSource: terrain ? 'terrain' : (librarySize ? 'library' : 'none'),
    };
  }

  // Cache of HTMLImageElement keyed by map_file stem (e.g. "havenvsr").
  // Reused across renderer calls within the page session so switching
  // between Positioning and Replay tabs doesn't re-fetch. Populated lazily
  // on first request per map.
  const mapImageCache = new Map();

  function getMapImage(mapFileKey, imagePath) {
    if (!mapFileKey || !imagePath) return null;
    if (mapImageCache.has(mapFileKey)) return mapImageCache.get(mapFileKey);
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = 'data/' + imagePath;
    mapImageCache.set(mapFileKey, img);
    return img;
  }

  // Expose the meta helper + image cache to other renderer modules that live
  // outside this IIFE (positioning-charts, positioning-player). They read
  // through window.VTMapRegistry rather than re-implementing the precedence
  // rules. No-op for consumers that don't need it.
  window.VTMapRegistry = {
    getMapMeta,
    getMapImage,
  };

  // Populate the map-dimension blocks + thumbnail. All fall back to "—"
  // gracefully when a particular source is unavailable, so the hero row
  // layout stays stable across pre-schema vs terrain-schema matches.
  function renderMapBannerFields(info) {
    const meta = getMapMeta(info);
    const registryEntry = (mapRegistry && mapRegistry[meta.key]) || null;

    // Thumbnail: show/hide the wrapping button (which carries the modal
    // trigger), set the inner img's source/alt independently. The button is
    // hidden via d-none when no image is available so the picker trigger
    // butts up against the duration field cleanly.
    const thumbBtn = document.getElementById('info-map-thumb-btn');
    const thumb = document.getElementById('info-map-thumb');
    if (thumb) {
      if (meta.imagePath) {
        thumb.src = 'data/' + meta.imagePath;
        thumb.alt = meta.title || info.name || meta.key;
        thumb.title = meta.title || '';
      } else {
        thumb.removeAttribute('src');
        thumb.alt = '';
        thumb.title = '';
      }
    }
    if (thumbBtn) {
      if (meta.imagePath) {
        thumbBtn.classList.remove('d-none');
        // Imperative init: the button already carries data-bs-toggle="modal"
        // (Bootstrap doesn't allow two `data-bs-toggle` values on one
        // element), so wire the tooltip programmatically. getOrCreateInstance
        // is idempotent across renderBanner re-runs on match switches.
        if (window.bootstrap && window.bootstrap.Tooltip) {
          window.bootstrap.Tooltip.getOrCreateInstance(thumbBtn);
        }
      } else {
        thumbBtn.classList.add('d-none');
      }
    }

    // Modal contents stay in sync on every banner render so opening the
    // modal after a match switch always reflects the current map. Map size,
    // elevation, base-to-base and author all live inside the modal now (the
    // hero used to surface them as separate stat blocks).
    renderMapInfoModal(info, meta, registryEntry);
  }

  // Format a registry `description` for display: strip the BOM that some
  // entries carry and convert CRLF/LF line breaks into <br>. Source string
  // is run through esc() first to neutralize any HTML.
  function formatMapDescription(raw) {
    if (!raw) return '';
    const cleaned = String(raw).replace(/^\uFEFF/, '');
    return esc(cleaned).replace(/\r?\n/g, '<br>');
  }

  // Populate the Map Info Modal (#map-info-modal) from getMapMeta() + the
  // raw registry entry. Re-runs every renderMapBannerFields() so opening
  // the modal after a match switch always reflects the current map. Rows
  // are emitted only when their underlying value is present so the list
  // stays compact for sparse / pre-schema entries.
  function renderMapInfoModal(info, meta, registry) {
    const titleEl = document.getElementById('map-info-modal-title-text');
    const imageEl = document.getElementById('map-info-modal-image');
    const imageCol = document.getElementById('map-info-modal-image-col');
    const descriptionEl = document.getElementById('map-info-modal-description');
    const metaEl = document.getElementById('map-info-modal-meta');
    if (!titleEl || !imageEl || !metaEl) return;

    const title = meta.title || (info && info.name) || meta.key || '—';
    titleEl.textContent = title;
    imageEl.alt = title;

    if (meta.imagePath) {
      imageEl.src = 'data/' + meta.imagePath;
      if (imageCol) imageCol.classList.remove('d-none');
    } else {
      imageEl.removeAttribute('src');
      if (imageCol) imageCol.classList.add('d-none');
    }

    const reg = registry || {};

    // Description renders into the LEFT column under the image (longer
    // multi-line author blurbs read better there and free the right column
    // up for compact metadata rows).
    const description = formatMapDescription(reg.description);
    if (descriptionEl) {
      if (description) {
        descriptionEl.innerHTML = description;
        descriptionEl.classList.remove('d-none');
      } else {
        descriptionEl.innerHTML = '';
        descriptionEl.classList.add('d-none');
      }
    }

    const rows = [];
    const addRow = (label, html) => {
      if (html == null || html === '') return;
      rows.push(`<dt>${esc(label)}</dt><dd>${html}</dd>`);
    };
    const addSection = (label) => {
      rows.push(`<div class="vt-map-info-meta-section">${esc(label)}</div>`);
    };

    addSection('Map');
    addRow('Author', meta.author ? esc(meta.author) : '');
    // Prefer the upstream-formatted "1024x1024" string from vsrmaplist
    // (`reg.formatted_size`); fall back to the computed `~Nm` from the
    // canonical edge length for legacy entries with no vsrmaplist coverage.
    if (reg.formatted_size) {
      addRow('Canonical size', esc(reg.formatted_size));
    } else if (meta.canonicalSize != null) {
      addRow('Canonical size', `~${Math.round(meta.canonicalSize)}m`);
    }
    if (meta.canonicalB2B != null) {
      addRow('Canonical base-to-base', `${Math.round(meta.canonicalB2B)}m`);
    }
    // vsrmaplist-sourced map-economy fields. Loose < 0 is the upstream
    // sentinel for "unlimited" (observed on a handful of maps).
    if (reg.pools != null) {
      addRow('Pools', esc(String(reg.pools)));
    }
    if (reg.loose != null) {
      const looseStr = reg.loose < 0 ? 'Unlimited' : String(reg.loose);
      addRow('Loose scrap', esc(looseStr));
    }
    if (Array.isArray(reg.tags) && reg.tags.length) {
      const chips = reg.tags
        .map((t) => `<span class="vt-map-info-tag">${esc(t)}</span>`)
        .join(' ');
      addRow('Tags', chips);
    }
    if (reg.map_file) {
      addRow('Map file', `<code>${esc(reg.map_file)}.bzn</code>`);
    }
    if (reg.mod_resolved) {
      const modId = String(reg.mod_resolved);
      if (/^\d+$/.test(modId)) {
        const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${modId}`;
        addRow('Mod', `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(modId)} <i class="bi bi-box-arrow-up-right small"></i></a>`);
      } else {
        addRow('Mod', esc(modId));
      }
    }
    const netVars = reg.net_vars || {};
    if (netVars.svar1) addRow('Team 1 name', esc(netVars.svar1));
    if (netVars.svar2) addRow('Team 2 name', esc(netVars.svar2));

    const hasMatchSection = meta.terrainSize || meta.elevation || meta.empiricalB2B != null;
    if (hasMatchSection) {
      addSection('This match');
      if (meta.terrainSize) {
        addRow('Terrain size', `${Math.round(meta.terrainSize.x)} \u00D7 ${Math.round(meta.terrainSize.z)}m`);
      }
      if (meta.elevation) {
        addRow('Elevation', `${Math.round(meta.elevation.min)} \u2192 ${Math.round(meta.elevation.max)}m`);
      }
      if (meta.empiricalB2B != null) {
        addRow('Empirical base-to-base', `${Math.round(meta.empiricalB2B)}m`);
      }
    }

    if (reg.attribution && reg.attribution.source) {
      addSection('Attribution');
      addRow('Source', esc(reg.attribution.source));
    }

    metaEl.innerHTML = rows.join('') ||
      `<div class="vt-map-info-meta-empty">No additional metadata available for this map.</div>`;
  }

  // --- Player Profile (Single-Player Mode) ---
  function renderPlayerProfile(player, fullData) {
    const container = document.getElementById('player-profile-content');
    const title = document.getElementById('player-profile-title');
    title.textContent = player.name;

    const ps = player.personal;
    const borderColor = player.faction === 1 ? 'var(--kb-primary)' : 'var(--kb-accent)';
    const fBadge = player.faction === 1 ? 'badge-f1' : 'badge-f2';
    const ratioStr = ps.ratio === null ? '∞' : Number(ps.ratio).toFixed(2);
    const kdStr = player.kd_ratio === null ? (player.kills > 0 ? '∞' : '—') : Number(player.kd_ratio).toFixed(2);

    // Top rival from full rivalry matrix
    let topRivalHtml = '';
    const myRow = fullData.rivalry_matrix[player.name];
    if (myRow) {
      let topName = null, topDmg = 0;
      for (const [victim, dmg] of Object.entries(myRow)) {
        if (victim !== player.name && dmg > topDmg) { topName = victim; topDmg = dmg; }
      }
      if (topName) {
        const theirDmg = (fullData.rivalry_matrix[topName] && fullData.rivalry_matrix[topName][player.name]) || 0;
        topRivalHtml = `
          <div class="vt-profile-rival mt-3">
            <div class="small fw-semibold mb-1" style="color:var(--kb-text-muted);">Top Rival</div>
            <div class="fw-bold" style="color:var(--kb-text-primary);">${esc(topName)}</div>
            <div class="small" style="color:var(--kb-text-secondary);">
              Dealt ${fmt(topDmg)} → ${esc(topName)} &nbsp;|&nbsp; Took ${fmt(theirDmg)} back
            </div>
          </div>`;
      }
    }

    // Top hit targets
    let hitTargetsHtml = '';
    if (player.hit_targets && Object.keys(player.hit_targets).length > 0) {
      const topTargets = Object.entries(player.hit_targets).sort((a, b) => b[1].hits - a[1].hits).slice(0, 3);
      hitTargetsHtml = `
        <div class="mt-3">
          <div class="small fw-semibold mb-1" style="color:var(--kb-text-muted);">Most Hit</div>
          ${topTargets.map(([name, d]) => `<div class="small" style="color:var(--kb-text-secondary);">${esc(name)}: ${d.hits.toLocaleString()} hits, ${fmt(d.damage)} dmg</div>`).join('')}
        </div>`;
    }

    container.innerHTML = `
      <div class="vt-profile-panel" style="border-left-color:${borderColor};">
        <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
          <span class="vt-profile-name">${esc(player.name)}</span>
          <span class="badge ${fBadge}">Team ${player.faction}</span>
          <span class="small" style="color:var(--kb-text-muted);">Slot ${player.slot}</span>
        </div>
        <div class="d-flex flex-wrap gap-4 mb-3">
          <div class="stat-card"><div class="stat-value">${fmt(ps.dealt)}</div><div class="stat-label">Dealt</div></div>
          <div class="stat-card"><div class="stat-value">${fmt(ps.received)}</div><div class="stat-label">Received</div></div>
          <div class="stat-card"><div class="stat-value">${ratioStr}</div><div class="stat-label">Ratio</div></div>
          <div class="stat-card"><div class="stat-value">${(ps.accuracy * 100).toFixed(1)}%</div><div class="stat-label">Accuracy</div></div>
          <div class="stat-card"><div class="stat-value">${player.kills || 0}</div><div class="stat-label">Kills</div></div>
          <div class="stat-card"><div class="stat-value">${player.deaths || 0}</div><div class="stat-label">Deaths</div></div>
          <div class="stat-card"><div class="stat-value">${kdStr}</div><div class="stat-label">K/D</div></div>
          <div class="vt-profile-chart-wrap"><canvas id="profile-doughnut"></canvas></div>
          <div class="vt-profile-radar-wrap">
            <i class="bi bi-info-circle vt-col-info vt-profile-radar-info"
               data-vt-radar-info="per-match"
               data-bs-toggle="tooltip" data-bs-placement="left" data-bs-html="true"
               title="Loading&hellip;"></i>
            <canvas id="radar-profile-canvas"></canvas>
          </div>
        </div>
        <div class="d-flex flex-wrap gap-2 mb-2">
          <span class="badge bg-secondary">${esc(ps.fav_weapon)}</span>
          <span class="small" style="color:var(--kb-text-muted);">${ps.weapons_used} weapons used</span>
        </div>
        ${topRivalHtml}
        ${hitTargetsHtml}
      </div>`;

    // Dealt vs Received doughnut
    const dCtx = document.getElementById('profile-doughnut');
    if (dCtx) {
      const t = getThemeColors();
      const chart = new Chart(dCtx.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: ['Dealt', 'Received'],
          datasets: [{ data: [ps.dealt, ps.received], backgroundColor: [t.success + 'cc', t.danger + 'cc'], borderWidth: 0 }],
        },
        options: {
          responsive: true, maintainAspectRatio: true, cutout: '60%',
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
        },
      });
      activeCharts.push(chart);
    }

    // Single-mode player radar - normalized composite alongside the doughnut.
    // Consumes fullData (unfiltered) so normalizers reflect the whole match
    // roster, giving the single polygon a stable "vs the match" frame.
    if (typeof renderPlayerRadar === 'function') {
      renderPlayerRadar('radar-profile-canvas', fullData, {
        mode: 'single',
        focusNames: [player.name],
        showMedian: true,
      });
    }
    applyRadarInfoTooltips(container);
  }

  // --- Faction Scoreboard ---
  // Determine which factions are "active" under the current filter.
  // Returns a Set of faction numbers ('1' / '2'). An empty filter returns
  // a set containing both, meaning no team should be dimmed.
  function computeActiveFactions() {
    if (filterState.mode === 'all') return new Set(['1', '2']);
    if (filterState.mode === 'team') return new Set([String(filterState.team || '1')]);
    // Player mode: active factions are those with at least one selected player
    const active = new Set();
    if (filterState.players.length === 0) return new Set(['1', '2']);
    const byName = {};
    currentData.leaderboard.forEach(p => { byName[p.name] = p; });
    filterState.players.forEach(name => {
      const p = byName[name];
      if (p) active.add(String(p.faction));
    });
    return active.size > 0 ? active : new Set(['1', '2']);
  }

  // Return a copy of a team's roster containing only players whose names are
  // in selectedNames. Preserves original roster ordering.
  function filterTeamRoster(roster, selectedNames) {
    if (!roster) return [];
    const set = new Set(selectedNames);
    return roster.filter(p => set.has(p.name));
  }

  // True if the current filterState.players list has at least one member on
  // the given team. Looks up against currentData's match roster (the source
  // of truth for team membership, independent of any filtered leaderboard).
  function hasSelectedOnTeam(sourceData, fNum) {
    if (!sourceData || !sourceData.match || !sourceData.match.teams) return false;
    const teamNames = new Set((sourceData.match.teams[fNum] || []).map(p => p.name));
    return filterState.players.some(n => teamNames.has(n));
  }

  function renderFactionScoreboard(factionTotals, teams, activeFactions, opts) {
    const container = document.getElementById('faction-content');
    const f1 = factionTotals['1'] || {};
    const f2 = factionTotals['2'] || {};
    const active = activeFactions || new Set(['1', '2']);
    const bothActive = active.has('1') && active.has('2');

    const rosterHtml = (teamList) => {
      if (!teamList || teamList.length === 0) return '<em style="color:var(--kb-text-muted)">No players</em>';
      // Render each name with optional inline in-game-nick subtext when the
      // canonical/known name differs from the in-game alias. The subtext is
      // emitted by the pipeline (in_game_nick is null when they match) so
      // we just check truthiness here.
      return teamList.map(p => {
        const nick = p.in_game_nick
          ? `<span class="vt-nick-inline">@${esc(p.in_game_nick)}</span>`
          : '';
        return `${esc(p.name)}${nick}`;
      }).join(', ');
    };

    const leaderName = (teamList, leaderSlot) => {
      if (teamList && teamList.length > 0) {
        const leader = teamList.find(p => p.slot === leaderSlot);
        if (leader) return esc(leader.name);
        return esc(teamList[0].name);
      }
      return null;
    };

    // Header annotation: in multi-player mode for teams that are rendering
    // their filtered subset, show "N selected" instead of the team-leader
    // name. Non-subset teams (and team/all modes) keep the leader-name.
    const o = opts || {};
    const t1Header = (o.multiPlayer && o.t1Subset)
      ? `${(teams['1'] || []).length} selected`
      : (leaderName(teams['1'], 1) || 'TBD');
    const t2Header = (o.multiPlayer && o.t2Subset)
      ? `${(teams['2'] || []).length} selected`
      : (leaderName(teams['2'], 6) || 'TBD');

    // Faction badge: derived from match.team_factions (match-global,
    // never narrowed by the player filter -- faction is fixed per
    // match). Pre-v3 matches and inconclusive teams get no badge.
    const teamFactions = (currentData && currentData.match && currentData.match.team_factions) || {};
    const factionBadge = (key) => {
      const fac = teamFactions[key];
      if (!fac || !fac.code || !fac.name) return '';
      return `<span class="vt-faction-badge" data-faction-code="${esc(fac.code)}">${esc(fac.name)}</span>`;
    };
    const t1FacBadge = factionBadge('1');
    const t2FacBadge = factionBadge('2');

    // Winner highlight: also match-global passthrough. Adds a gold accent
    // class to the winning team's panel for clean / contested outcomes.
    // Unclear outcomes get no highlight (the kill-feed badge already
    // surfaces the ambiguity).
    const matchWinner = (currentData && currentData.match && currentData.match.winner) || null;
    const winnerTeam = (matchWinner && (matchWinner.decided_by === 'clean_win' || matchWinner.decided_by === 'contested'))
      ? matchWinner.team
      : null;
    const t1Winner = winnerTeam === 1 ? ' vt-faction-panel--winner' : '';
    const t2Winner = winnerTeam === 2 ? ' vt-faction-panel--winner' : '';
    const winnerTrophy = `<i class="bi bi-trophy-fill vt-faction-winner-icon" title="Match winner"></i>`;
    const t1WinnerTrophy = winnerTeam === 1 ? winnerTrophy : '';
    const t2WinnerTrophy = winnerTeam === 2 ? winnerTrophy : '';

    const t1Muted = !bothActive && !active.has('1');
    const t2Muted = !bothActive && !active.has('2');
    const mutedNote = '<span class="vt-faction-muted-badge" title="Not included in current filter"><i class="bi bi-eye-slash me-1"></i>Filtered out</span>';

    container.innerHTML = `
      <div class="col-md-6">
        <div class="vt-faction-panel ${t1Muted ? 'vt-faction-panel--muted' : ''}${t1Winner}" style="border-left-color:var(--kb-primary);">
          <h6 class="d-flex align-items-center gap-2 mb-3" style="color:var(--kb-primary);">Team 1 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t1Header}</span>${t1FacBadge}${t1WinnerTrophy}${t1Muted ? mutedNote : ''}</h6>
          <div class="d-flex flex-wrap gap-4 mb-3">
            <div class="stat-card"><div class="stat-value">${fmt(f1.total_dealt || 0)}</div><div class="stat-label">Dealt</div></div>
            <div class="stat-card"><div class="stat-value">${fmt(f1.total_received || 0)}</div><div class="stat-label">Received</div></div>
            <div class="stat-card"><div class="stat-value">${((f1.accuracy || 0) * 100).toFixed(1)}%</div><div class="stat-label">Accuracy</div></div>
          </div>
          <div class="small" style="color:var(--kb-text-muted);">Player: ${fmt(f1.player_dealt || 0)} <span style="opacity:0.75;">(PvP ${fmt(f1.pvp_dealt || 0)} · PvE ${fmt(f1.pve_dealt || 0)})</span> | Assets: ${fmt(f1.asset_dealt || 0)}</div>
          <div class="small mt-1" style="color:var(--kb-text-secondary);">${rosterHtml(teams['1'])}</div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="vt-faction-panel ${t2Muted ? 'vt-faction-panel--muted' : ''}${t2Winner}" style="border-left-color:var(--kb-accent);">
          <h6 class="d-flex align-items-center gap-2 mb-3" style="color:var(--kb-accent);">Team 2 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t2Header}</span>${t2FacBadge}${t2WinnerTrophy}${t2Muted ? mutedNote : ''}</h6>
          <div class="d-flex flex-wrap gap-4 mb-3">
            <div class="stat-card"><div class="stat-value">${fmt(f2.total_dealt || 0)}</div><div class="stat-label">Dealt</div></div>
            <div class="stat-card"><div class="stat-value">${fmt(f2.total_received || 0)}</div><div class="stat-label">Received</div></div>
            <div class="stat-card"><div class="stat-value">${((f2.accuracy || 0) * 100).toFixed(1)}%</div><div class="stat-label">Accuracy</div></div>
          </div>
          <div class="small" style="color:var(--kb-text-muted);">Player: ${fmt(f2.player_dealt || 0)} <span style="opacity:0.75;">(PvP ${fmt(f2.pvp_dealt || 0)} · PvE ${fmt(f2.pve_dealt || 0)})</span> | Assets: ${fmt(f2.asset_dealt || 0)}</div>
          <div class="small mt-1" style="color:var(--kb-text-secondary);">${rosterHtml(teams['2'])}</div>
        </div>
      </div>
    `;

    // Outcome pill in the Faction Scoreboard card header. We deliberately
    // only surface the "unclear" variant here -- clean_win / contested
    // outcomes are already conveyed by the winning team's panel trophy
    // icon above (and the dedicated kill-feed badge on the Combat tab).
    // Showing all three would be redundant. The unclear pill carries the
    // Bootstrap tooltip explaining why the outcome couldn't be inferred,
    // mirroring the kill-feed unclear badge.
    const factionOutcomeBadge = document.getElementById('faction-outcome-badge');
    if (factionOutcomeBadge) {
      const winnerForOutcome = (matchWinner && matchWinner.decided_by === 'unclear')
        ? matchWinner
        : null;
      applyWinnerBadge(factionOutcomeBadge, winnerForOutcome, teamFactions);
      ensureTooltips(document.getElementById('section-faction'));
    }
  }

  // --- Leaderboard ---
  function renderLeaderboard(rows) {
    const tbody = document.querySelector('#leaderboard tbody');
    const sorted = [...rows].sort(leaderboardSort(sortState.key, sortState.asc));

    const positioning = currentData && currentData.positioning;
    tbody.innerHTML = sorted.map((r, i) => {
      const ps = r.personal;
      const netClass = ps.net > 0 ? 'color:var(--kb-success)' : ps.net < 0 ? 'color:var(--kb-danger)' : '';
      const ratioStr = ps.ratio === null ? '∞' : Number(ps.ratio).toFixed(2);
      const fBadge = r.faction === 1 ? 'badge-f1' : r.faction === 2 ? 'badge-f2' : 'bg-secondary';
      const moveCell = typeof renderMovementCell === 'function'
        ? renderMovementCell(positioning, r.name)
        : '<span style="color:var(--kb-text-muted);">—</span>';
      const nickSub = r.in_game_nick
        ? `<small class="vt-nick-sub">@${esc(r.in_game_nick)}</small>`
        : '';
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(r.name)}${nickSub}</td>
        <td class="text-center"><span class="badge ${fBadge}">${r.faction || '?'}</span></td>
        <td class="text-end vt-col-split">${fmt(ps.pvp_dealt || 0)}</td>
        <td class="text-end vt-col-split">${fmt(ps.pve_dealt || 0)}</td>
        <td class="text-end">${fmt(ps.dealt)}</td>
        <td class="text-end vt-col-split">${fmt(ps.pvp_received || 0)}</td>
        <td class="text-end vt-col-split">${fmt(ps.pve_received || 0)}</td>
        <td class="text-end">${fmt(ps.received)}</td>
        <td class="text-end" style="${netClass}">${ps.net > 0 ? '+' : ''}${fmt(ps.net)}</td>
        <td class="text-end">${ratioStr}</td>
        <td class="text-end">${(ps.accuracy * 100).toFixed(1)}%</td>
        <td class="text-end">${r.kills || 0}</td>
        <td class="text-end">${r.deaths || 0}</td>
        <td class="text-end">${fmt(r.assets.dealt)}</td>
        <td>${moveCell}</td>
        <td><span class="badge bg-secondary">${esc(ps.fav_weapon)}</span></td>
        <td class="text-end">${ps.weapons_used}</td>
      </tr>`;
    }).join('');

    document.querySelectorAll('#leaderboard th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === sortState.key);
      th.onclick = () => {
        if (sortState.key === th.dataset.sort) sortState.asc = !sortState.asc;
        else { sortState.key = th.dataset.sort; sortState.asc = false; }
        renderLeaderboard(rows);
      };
    });
  }

  function leaderboardSort(key, asc) {
    return (a, b) => {
      let va, vb;
      switch (key) {
        case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'faction': va = a.faction; vb = b.faction; break;
        case 'dealt': va = a.personal.dealt; vb = b.personal.dealt; break;
        case 'received': va = a.personal.received; vb = b.personal.received; break;
        case 'pvp_dealt': va = a.personal.pvp_dealt || 0; vb = b.personal.pvp_dealt || 0; break;
        case 'pve_dealt': va = a.personal.pve_dealt || 0; vb = b.personal.pve_dealt || 0; break;
        case 'pvp_received': va = a.personal.pvp_received || 0; vb = b.personal.pvp_received || 0; break;
        case 'pve_received': va = a.personal.pve_received || 0; vb = b.personal.pve_received || 0; break;
        case 'net': va = a.personal.net; vb = b.personal.net; break;
        case 'ratio':
          va = a.personal.ratio === null ? 1e9 : Number(a.personal.ratio);
          vb = b.personal.ratio === null ? 1e9 : Number(b.personal.ratio);
          break;
        case 'accuracy': va = a.personal.accuracy; vb = b.personal.accuracy; break;
        case 'kills': va = a.kills || 0; vb = b.kills || 0; break;
        case 'deaths': va = a.deaths || 0; vb = b.deaths || 0; break;
        case 'asset_dealt': va = a.assets.dealt; vb = b.assets.dealt; break;
        case 'activity_score': {
          const pos = currentData && currentData.positioning;
          const pa = pos && pos.players && pos.players[a.name];
          const pb = pos && pos.players && pos.players[b.name];
          va = pa ? pa.metrics.activity_score : -1;
          vb = pb ? pb.metrics.activity_score : -1;
          break;
        }
        case 'fav_weapon': va = a.personal.fav_weapon.toLowerCase(); vb = b.personal.fav_weapon.toLowerCase(); break;
        case 'weapons_used': va = a.personal.weapons_used; vb = b.personal.weapons_used; break;
        default: va = a.personal.dealt; vb = b.personal.dealt;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    };
  }

  // --- Heatmap ---
  function renderHeatmap(matrix, names) {
    const table = document.getElementById('heatmap');
    let maxVal = 0;
    for (const shooter of names) {
      for (const victim of names) {
        const v = (matrix[shooter] && matrix[shooter][victim]) || 0;
        if (v > maxVal) maxVal = v;
      }
    }

    let html = '<thead><tr><th class="heatmap-corner"></th>';
    names.forEach(n => { html += `<th class="heatmap-header">${esc(n)}</th>`; });
    html += '</tr></thead><tbody>';

    names.forEach(shooter => {
      html += `<tr><th class="heatmap-row-header text-start">${esc(shooter)}</th>`;
      names.forEach(victim => {
        const val = (matrix[shooter] && matrix[shooter][victim]) || 0;
        const intensity = maxVal > 0 ? val / maxVal : 0;
        const isSelf = shooter === victim;
        let bg;
        if (isSelf) {
          bg = val > 0 ? `color-mix(in srgb, var(--kb-warning) ${Math.round(15 + intensity * 60)}%, transparent)` : 'transparent';
        } else {
          bg = val > 0 ? `color-mix(in srgb, var(--kb-danger) ${Math.round(10 + intensity * 70)}%, transparent)` : 'transparent';
        }
        const title = `${shooter} → ${victim}: ${fmt(val)} dmg`;
        html += `<td class="heatmap-cell" style="background:${bg}" title="${esc(title)}">${val > 0 ? fmt(val) : ''}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  // --- Top Rivalries ---
  function renderRivalries(rivalries) {
    const container = document.getElementById('rivalries-container');
    container.innerHTML = '';
    if (rivalries.length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No rivalries for this selection.</p>';
      return;
    }
    const active = rivalryRadarPair;
    rivalries.forEach(r => {
      const card = document.createElement('div');
      const isActive = active && active.a && active.b &&
        ((active.a === r.a && active.b === r.b) || (active.a === r.b && active.b === r.a));
      card.className = 'rivalry-card vt-rivalry-card--interactive d-flex align-items-center gap-3 p-3 mb-3 rounded' +
        (isActive ? ' is-active' : '');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.dataset.rivalryPair = `${r.a}|${r.b}`;
      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      info.innerHTML = `
        <div class="fw-bold mb-1">${esc(r.a)} <span style="color:var(--kb-text-muted)">vs</span> ${esc(r.b)}</div>
        <div class="small" style="color:var(--kb-text-secondary)">
          <span style="color:var(--kb-primary)">${esc(r.a)}</span> dealt ${fmt(r.a_to_b)} &nbsp;|&nbsp;
          <span style="color:var(--kb-accent)">${esc(r.b)}</span> dealt ${fmt(r.b_to_a)}
        </div>
        <div class="small" style="color:var(--kb-text-muted)">Total: ${fmt(r.total)}</div>
      `;
      card.appendChild(info);
      const chartWrap = document.createElement('div');
      chartWrap.className = 'd-flex align-items-center';
      card.appendChild(chartWrap);
      container.appendChild(card);
      renderRivalryDoughnut(chartWrap, r);
    });
  }

  // Update one slot chip's visible label + faction tint. `slotKey` is 'a'/'b'.
  // factionMap is name -> faction-number; falsy faction means unknown.
  function updateRivalryPickerSlot(slotKey, currentName, factionMap) {
    const slot = document.getElementById('rivalry-radar-slot-' + slotKey);
    if (!slot) return;
    const nameEl = slot.querySelector('.vt-radar-picker-slot-name');
    if (!nameEl) return;
    if (currentName) {
      nameEl.textContent = currentName;
      slot.dataset.empty = 'false';
      const faction = factionMap.get(currentName);
      if (faction === 1 || faction === 2) {
        slot.dataset.faction = String(faction);
      } else {
        delete slot.dataset.faction;
      }
    } else {
      nameEl.textContent = 'Pick player';
      slot.dataset.empty = 'true';
      delete slot.dataset.faction;
    }
  }

  // Rebuild one slot's dropdown menu from the current filtered roster.
  // Marks the currently-selected name with a check-mark icon (visual hint
  // only; actual selection state lives on rivalryRadarPair).
  function populateRivalryPickerMenu(slotKey, names, currentName) {
    const menu = document.getElementById('rivalry-radar-menu-' + slotKey);
    if (!menu) return;
    if (!names.length) {
      menu.innerHTML = '<li><span class="dropdown-item-text vt-muted small">No players in view</span></li>';
      return;
    }
    menu.innerHTML = names.map(n => {
      const isCurrent = n === currentName;
      const check = isCurrent ? '<i class="bi bi-check2 ms-2"></i>' : '';
      return `<li><button type="button"
        class="dropdown-item${isCurrent ? ' is-current' : ''}"
        data-rivalry-pick-slot="${slotKey}"
        data-rivalry-pick-name="${esc(n)}">
        <span>${esc(n)}</span>${check}
      </button></li>`;
    }).join('');
  }

  // Rivalry Radar (compare mode). Persists the selected pair in
  // rivalryRadarPair across filter changes, reconciling against the filtered
  // roster and falling back to the first visible top_rivalries entry.
  function renderRivalryRadar(data) {
    const canvas = document.getElementById('rivalry-radar-canvas');
    if (!canvas) return;

    const names = data.leaderboard.map(p => p.name);
    const namesInView = new Set(names);
    const topRivs = (data.top_rivalries || []).filter(r =>
      namesInView.has(r.a) && namesInView.has(r.b)
    );

    const pairStillValid = rivalryRadarPair.a && rivalryRadarPair.b &&
      namesInView.has(rivalryRadarPair.a) && namesInView.has(rivalryRadarPair.b) &&
      rivalryRadarPair.a !== rivalryRadarPair.b;
    if (!pairStillValid) {
      if (topRivs.length) {
        rivalryRadarPair = { a: topRivs[0].a, b: topRivs[0].b };
      } else if (names.length >= 2) {
        rivalryRadarPair = { a: names[0], b: names[1] };
      } else {
        rivalryRadarPair = { a: names[0] || null, b: null };
      }
    }

    // Populate the chip-based two-slot picker from the current match roster.
    // Each slot is a Bootstrap dropdown; we update both the visible slot
    // label (current selection) and the menu list (all roster names).
    // Faction colors come from data.leaderboard so each chip tints to its
    // player's faction (Team 1 = primary, Team 2 = accent).
    const factionByName = new Map(
      (data.leaderboard || []).map(p => [p.name, p.faction])
    );
    updateRivalryPickerSlot('a', rivalryRadarPair.a, factionByName);
    updateRivalryPickerSlot('b', rivalryRadarPair.b, factionByName);
    populateRivalryPickerMenu('a', names, rivalryRadarPair.a);
    populateRivalryPickerMenu('b', names, rivalryRadarPair.b);

    const picker = document.getElementById('rivalry-radar-custom-picker');
    if (picker) picker.classList.toggle('d-none', !rivalryRadarCustom);

    const samePair = rivalryRadarPair.a && rivalryRadarPair.b &&
      rivalryRadarPair.a === rivalryRadarPair.b;
    const tooFewForCompare = names.length < 2;
    const hint = document.getElementById('rivalry-radar-hint');
    if (hint) {
      hint.classList.toggle('d-none', !(samePair || tooFewForCompare));
      hint.textContent = tooFewForCompare
        ? 'Need at least two players in view to compare.'
        : 'Pick two different players to compare.';
    }

    if (typeof renderPlayerRadar === 'function') {
      renderPlayerRadar('rivalry-radar-canvas', data, {
        mode: 'compare',
        focusNames: [rivalryRadarPair.a, rivalryRadarPair.b],
      });
    }
  }

  // Sync .is-active outline on all currently rendered rivalry cards to match
  // the selected rivalryRadarPair. Cheap alternative to re-running
  // renderRivalries (which would destroy/recreate the mini doughnuts).
  function syncRivalryCardActive() {
    const cards = document.querySelectorAll('#rivalries-container .vt-rivalry-card--interactive');
    const a = rivalryRadarPair.a, b = rivalryRadarPair.b;
    cards.forEach(card => {
      const [ca, cb] = (card.dataset.rivalryPair || '').split('|');
      const match = a && b && ((ca === a && cb === b) || (ca === b && cb === a));
      card.classList.toggle('is-active', !!match);
    });
  }

  // --- Accuracy Table ---
  function renderAccuracyTable(leaderboard) {
    const tbody = document.querySelector('#accuracy-table tbody');
    const sorted = [...leaderboard].sort((a, b) => b.personal.accuracy - a.personal.accuracy);
    tbody.innerHTML = sorted.map(p => {
      const ps = p.personal;
      const accColor = ps.accuracy >= 0.7 ? 'var(--kb-success)' : ps.accuracy >= 0.4 ? 'var(--kb-warning)' : 'var(--kb-danger)';
      return `<tr>
        <td class="fw-semibold">${esc(p.name)}</td>
        <td class="text-end">${ps.shots_fired.toLocaleString()}</td>
        <td class="text-end">${ps.shots_hit.toLocaleString()}</td>
        <td class="text-end fw-bold" style="color:${accColor}">${(ps.accuracy * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }

  // --- Kill Feed ---
  // Updates the #kill-feed-winner-badge slot from a `match.winner` block.
  // Sets the `data-decided-by` attribute (drives CSS color), the inner
  // HTML (label + icon), and Bootstrap tooltip metadata for contested /
  // unclear outcomes. Empty for pre-v3 matches; the slot's :empty CSS
  // collapses it cleanly. Caller is responsible for invoking
  // `ensureTooltips()` afterwards so any new tooltip wires up.
  function applyWinnerBadge(badgeEl, winner, factions) {
    if (!badgeEl) return;
    badgeEl.removeAttribute('data-decided-by');
    badgeEl.removeAttribute('data-bs-toggle');
    badgeEl.removeAttribute('data-bs-placement');
    badgeEl.removeAttribute('title');
    // Tear down any existing Bootstrap tooltip so the next match doesn't
    // inherit a stale tooltip instance referencing the prior badge state.
    if (window.bootstrap && window.bootstrap.Tooltip) {
      const existing = bootstrap.Tooltip.getInstance(badgeEl);
      if (existing) existing.dispose();
    }
    if (!winner || !winner.decided_by) {
      badgeEl.innerHTML = '';
      return;
    }
    const decidedBy = winner.decided_by;
    const factionLabelFor = (team) => {
      const fac = factions && factions[String(team)];
      return (fac && fac.name) ? fac.name : `Team ${team}`;
    };
    if (decidedBy === 'clean_win' && winner.team) {
      const label = factionLabelFor(winner.team);
      badgeEl.setAttribute('data-decided-by', 'clean');
      badgeEl.innerHTML = `<i class="bi bi-trophy-fill me-1"></i>${esc(label)} wins`;
      return;
    }
    if (decidedBy === 'contested' && winner.team) {
      const label = factionLabelFor(winner.team);
      const ev = winner.evidence || {};
      const recCount = ev.rec_dest_count || {};
      const facCount = ev.fac_dest_count || {};
      const tooltip = [
        'Both bases fell — outcome decided by who fell first.',
        `Team 1: ${recCount['1'] || 0} rec / ${facCount['1'] || 0} fac destructions.`,
        `Team 2: ${recCount['2'] || 0} rec / ${facCount['2'] || 0} fac destructions.`,
      ].join(' ');
      badgeEl.setAttribute('data-decided-by', 'contested');
      badgeEl.setAttribute('data-bs-toggle', 'tooltip');
      badgeEl.setAttribute('data-bs-placement', 'bottom');
      badgeEl.setAttribute('title', tooltip);
      badgeEl.innerHTML = `<i class="bi bi-trophy me-1"></i>${esc(label)} wins (contested)`;
      return;
    }
    // unclear (or any other unhandled state)
    const tooltip = 'Match outcome could not be determined from the kill feed. The game may have ended via host quit, timeout, or commander self-demolition of recycler/factory. Future stat collection will close these gaps.';
    badgeEl.setAttribute('data-decided-by', 'unclear');
    badgeEl.setAttribute('data-bs-toggle', 'tooltip');
    badgeEl.setAttribute('data-bs-placement', 'bottom');
    badgeEl.setAttribute('title', tooltip);
    badgeEl.innerHTML = `<i class="bi bi-question-circle me-1"></i>Outcome unclear`;
  }

  function renderKillFeed(kills, tickRate, minTick) {
    const container = document.getElementById('kill-feed-content');
    // Winner badge in the card header. Reads passthrough fields from
    // currentData.match.{winner, team_factions} -- match-global, never
    // narrowed by the player filter.
    const headerBadge = document.getElementById('kill-feed-winner-badge');
    if (headerBadge) {
      const winnerForBadge = currentData && currentData.match && currentData.match.winner;
      const factionsForBadge = currentData && currentData.match && currentData.match.team_factions;
      applyWinnerBadge(headerBadge, winnerForBadge, factionsForBadge);
      // Initialize Bootstrap tooltips on the contested / unclear variants.
      ensureTooltips(document.getElementById('section-kill-feed'));
    }
    if (!kills || !kills.feed || kills.feed.length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No kill events recorded.</p>';
      return;
    }
    // Resolve raw ODF strings to friendly names via the match-global
    // odf_map (built by scripts/process_stats.py via prettify_odf ->
    // unit_name_map -> GameObjectClass.unitName). When the ODF is empty
    // or unresolved, return null so the renderer can omit the chip
    // entirely instead of showing a meaningless "(?)".
    const odfMap = (currentData && currentData.odf_map) || {};
    const odfName = (s) => {
      if (!s) return null;
      if (odfMap[s]) return odfMap[s];
      // Last-resort fallback for ODFs the pipeline didn't resolve
      // (very rare -- only fires when an ODF appears in kill_feed but
      // not in odf_map, which shouldn't happen post-Commit-1).
      return s.replace(/\.odf$/i, '').replace(/_/g, ' ');
    };
    // Optional in-feed milestone marker at the winner's decided_at_tick.
    // Filter-safe: read from currentData.match.winner.decided_at_tick
    // (passthrough) rather than scanning the (possibly-narrowed) feed for
    // recycler/factory destructions. Only emitted for decisive outcomes;
    // "unclear" matches get no marker (the header badge tells the story).
    const winner = currentData && currentData.match && currentData.match.winner;
    const factions = currentData && currentData.match && currentData.match.team_factions;
    const milestoneTick = (winner && (winner.decided_by === 'clean_win' || winner.decided_by === 'contested') && typeof winner.decided_at_tick === 'number')
      ? winner.decided_at_tick
      : null;
    const milestoneFor = (winner && winner.team)
      ? `${(factions && factions[String(winner.loser)] && factions[String(winner.loser)].name) || `Team ${winner.loser}`}'s base falls — ${(factions && factions[String(winner.team)] && factions[String(winner.team)].name) || `Team ${winner.team}`} wins`
      : '';
    const renderMilestone = () => `<div class="vt-killfeed-milestone d-flex align-items-center gap-2 py-2"><i class="bi bi-flag-fill"></i><span>${esc(milestoneFor)}</span></div>`;

    let html = '<div style="max-height:320px;overflow-y:auto;">';
    let milestoneRendered = false;
    kills.feed.forEach(entry => {
      // Insert milestone divider before the first feed entry whose tick
      // exceeds the decided_at_tick. (The kill_feed is already
      // chronological from the pipeline.) If every entry is earlier than
      // the marker tick, the divider is appended at the end below.
      if (milestoneTick !== null && !milestoneRendered && entry.tick > milestoneTick) {
        html += renderMilestone();
        milestoneRendered = true;
      }
      const sec = tickRate > 0 ? (entry.tick - minTick) / tickRate : 0;
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const ts = `${m}:${String(s).padStart(2, '0')}`;
      const killerNick = entry.killer_in_game_nick
        ? `<span class="vt-nick-inline">@${esc(entry.killer_in_game_nick)}</span>`
        : '';
      const victimNick = entry.victim_in_game_nick
        ? `<span class="vt-nick-inline">@${esc(entry.victim_in_game_nick)}</span>`
        : '';
      const killerOdfResolved = odfName(entry.killer_odf);
      const victimOdfResolved = odfName(entry.victim_odf);
      // Cross-link the chip to the new ODF browser when we have the raw
      // basename to encode. Falls back to a styled span (visually identical
      // to the pre-cross-link chip) when killer_odf/victim_odf is empty
      // but the resolver still returned a name from somewhere.
      const killerOdfBase = entry.killer_odf ? entry.killer_odf.replace(/\.odf$/i, '').toLowerCase() : '';
      const victimOdfBase = entry.victim_odf ? entry.victim_odf.replace(/\.odf$/i, '').toLowerCase() : '';
      const killerOdf = (killerOdfResolved && killerOdfBase)
        ? `<a href="odf/index.html?odf=${encodeURIComponent(killerOdfBase)}" target="_blank" rel="noopener" class="vt-odf-link" title="View ${esc(killerOdfResolved)} in ODF Browser">(${esc(killerOdfResolved)})</a>`
        : (killerOdfResolved ? `<span class="vt-odf-link-fallback">(${esc(killerOdfResolved)})</span>` : '');
      const victimOdf = (victimOdfResolved && victimOdfBase)
        ? `<a href="odf/index.html?odf=${encodeURIComponent(victimOdfBase)}" target="_blank" rel="noopener" class="vt-odf-link" title="View ${esc(victimOdfResolved)} in ODF Browser">(${esc(victimOdfResolved)})</a>`
        : (victimOdfResolved ? `<span class="vt-odf-link-fallback">(${esc(victimOdfResolved)})</span>` : '');
      html += `<div class="d-flex align-items-center gap-2 py-1" style="font-size:0.82rem;border-bottom:1px solid var(--kb-border-subtle);">`;
      html += `<span class="text-nowrap" style="color:var(--kb-text-muted);min-width:3.5em;">${ts}</span>`;
      html += `<span class="fw-semibold" style="color:var(--kb-primary);">${esc(entry.killer)}</span>${killerNick}${killerOdf}`;
      html += `<i class="bi bi-arrow-right" style="color:var(--kb-danger);"></i>`;
      html += `<span class="fw-semibold" style="color:var(--kb-accent);">${esc(entry.victim)}</span>${victimNick}${victimOdf}`;
      html += `</div>`;
    });
    if (milestoneTick !== null && !milestoneRendered) {
      // All visible feed entries occurred before the marker tick (or the
      // loser's destruction events are filtered out of view). Append the
      // divider at the end so the user still sees the milestone in context.
      html += renderMilestone();
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // --- Snipe Feed (Phase 3) ---
  // Mirrors renderKillFeed; auto-hides the entire card when feed is empty.
  function renderSnipeFeed(snipes, tickRate, minTick) {
    const card = document.getElementById('section-snipe-feed');
    const container = document.getElementById('snipe-feed-content');
    if (!container) return;
    const feed = (snipes && snipes.feed) || [];
    if (feed.length === 0) {
      if (card) card.classList.add('vt-hide');
      container.innerHTML = '';
      return;
    }
    if (card) {
      card.classList.remove('vt-hide');
      // Init the card's info-circle tooltip(s). Idempotent; needed
      // because the card is initially hidden via .vt-hide and Bootstrap
      // skips hidden elements during page-wide tooltip auto-init.
      ensureTooltips(card);
    }
    const stripOdf = (s) => s ? s.replace(/\.odf$/i, '').replace(/_/g, ' ') : '?';
    let html = '<div style="max-height:320px;overflow-y:auto;">';
    feed.forEach(entry => {
      const sec = tickRate > 0 ? (entry.tick - minTick) / tickRate : 0;
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const ts = `${m}:${String(s).padStart(2, '0')}`;
      const sniperNick = entry.sniper_in_game_nick
        ? `<span class="vt-nick-inline">@${esc(entry.sniper_in_game_nick)}</span>`
        : '';
      const victimNick = entry.victim_in_game_nick
        ? `<span class="vt-nick-inline">@${esc(entry.victim_in_game_nick)}</span>`
        : '';
      const sniperOdf = entry.sniper_odf
        ? `<span style="color:var(--kb-text-muted);font-size:0.75rem;">(${esc(stripOdf(entry.sniper_odf))})</span>`
        : '';
      const victimOdf = entry.victim_odf
        ? `<span style="color:var(--kb-text-muted);font-size:0.75rem;">(${esc(stripOdf(entry.victim_odf))})</span>`
        : '';
      html += `<div class="d-flex align-items-center gap-2 py-1" style="font-size:0.82rem;border-bottom:1px solid var(--kb-border-subtle);">`;
      html += `<span class="text-nowrap" style="color:var(--kb-text-muted);min-width:3.5em;">${ts}</span>`;
      html += `<span class="fw-semibold" style="color:var(--kb-primary);">${esc(entry.sniper)}</span>${sniperNick}${sniperOdf}`;
      html += `<i class="bi bi-crosshair" style="color:var(--kb-accent);"></i>`;
      html += `<span class="fw-semibold" style="color:var(--kb-accent);">${esc(entry.victim)}</span>${victimNick}${victimOdf}`;
      html += `</div>`;
    });
    html += '</div>';
    container.innerHTML = html;
  }

  // --- Powerup/Crate Destruction Breakdown (Phase 3) ---
  // Mirrors renderVehicleKills; auto-hides the card when zero destructions.
  function renderPowerupDestructions(canvasId, powerupDestructions) {
    const card = document.getElementById('section-powerup-destructions');
    const byOdf = (powerupDestructions && powerupDestructions.by_odf) || [];
    if (byOdf.length === 0) {
      if (card) card.classList.add('vt-hide');
      return;
    }
    if (card) {
      card.classList.remove('vt-hide');
      // Init the card's info-circle tooltip(s). Idempotent; needed
      // because the card is initially hidden via .vt-hide and Bootstrap
      // skips hidden elements during page-wide tooltip auto-init.
      ensureTooltips(card);
    }
    if (typeof renderPowerupDestructionsChart === 'function') {
      renderPowerupDestructionsChart(canvasId, byOdf);
    }
  }

  // --- Kill Rivalry Heatmap ---
  function renderKillHeatmap(matrix, names) {
    const container = document.getElementById('kill-heatmap-content');
    const table = document.getElementById('kill-heatmap');
    if (!matrix || Object.keys(matrix).length === 0) {
      table.innerHTML = '';
      const existing = container.querySelector('p');
      if (!existing) {
        const p = document.createElement('p');
        p.style.color = 'var(--kb-text-muted)';
        p.textContent = 'No kill events recorded.';
        container.appendChild(p);
      }
      return;
    }
    let maxVal = 0;
    for (const killer of names) {
      for (const victim of names) {
        const v = (matrix[killer] && matrix[killer][victim]) || 0;
        if (v > maxVal) maxVal = v;
      }
    }
    let html = '<thead><tr><th class="heatmap-corner"></th>';
    names.forEach(n => { html += `<th class="heatmap-header">${esc(n)}</th>`; });
    html += '</tr></thead><tbody>';
    names.forEach(killer => {
      html += `<tr><th class="heatmap-row-header text-start">${esc(killer)}</th>`;
      names.forEach(victim => {
        const val = (matrix[killer] && matrix[killer][victim]) || 0;
        const intensity = maxVal > 0 ? val / maxVal : 0;
        const isSelf = killer === victim;
        let bg;
        if (isSelf) {
          bg = 'transparent';
        } else {
          bg = val > 0 ? `color-mix(in srgb, var(--kb-warning) ${Math.round(15 + intensity * 65)}%, transparent)` : 'transparent';
        }
        const title = `${killer} → ${victim}: ${val} kills`;
        html += `<td class="heatmap-cell" style="background:${bg}" title="${esc(title)}">${val > 0 ? val : ''}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  // --- Hit Distribution by Target ---
  function renderHitTargets(leaderboard) {
    const container = document.getElementById('hit-targets-content');
    const players = leaderboard.filter(p => p.hit_targets && Object.keys(p.hit_targets).length > 0);
    if (players.length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No per-target hit data available.</p>';
      return;
    }
    let html = '<table class="table table-sm table-hover align-middle mb-0" style="font-size:0.8rem;">';
    html += '<thead><tr><th>Player</th><th>Target</th><th class="text-end">Hits</th><th class="text-end">Damage</th><th class="text-end">Dmg/Hit</th><th class="text-end">% of Hits</th></tr></thead><tbody>';
    players.forEach(p => {
      const totalHits = Object.values(p.hit_targets).reduce((s, v) => s + (v.hits || 0), 0);
      const entries = Object.entries(p.hit_targets).slice(0, 3);
      entries.forEach(([target, data], idx) => {
        const hits = data.hits || 0;
        const dmg = data.damage || 0;
        const dph = hits > 0 ? (dmg / hits).toFixed(1) : '—';
        const pct = totalHits > 0 ? ((hits / totalHits) * 100).toFixed(1) : '0';
        const playerCell = idx === 0 ? `<td class="fw-semibold" rowspan="${entries.length}">${esc(p.name)}</td>` : '';
        html += `<tr>${playerCell}<td>${esc(target)}</td><td class="text-end">${hits.toLocaleString()}</td><td class="text-end">${fmt(dmg)}</td><td class="text-end">${dph}</td><td class="text-end">${pct}%</td></tr>`;
      });
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // --- Asset Damage ---
  function renderAssetDamage(assetData, factionTotals) {
    const container = document.getElementById('asset-damage-content');
    if (!assetData || Object.keys(assetData.by_player).length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No AI/structure damage recorded.</p>';
      return;
    }
    const f1a = assetData.by_faction['1'] || { dealt: 0, received: 0 };
    const f2a = assetData.by_faction['2'] || { dealt: 0, received: 0 };

    let html = `
      <div class="row g-3 mb-3">
        <div class="col-md-6">
          <div class="p-2 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-primary);">
            <strong style="color:var(--kb-primary)">Team 1 Assets:</strong> Dealt ${fmt(f1a.dealt)} | Lost ${fmt(f1a.received)}
          </div>
        </div>
        <div class="col-md-6">
          <div class="p-2 rounded" style="background:var(--kb-bg-subtle);border-left:3px solid var(--kb-accent);">
            <strong style="color:var(--kb-accent)">Team 2 Assets:</strong> Dealt ${fmt(f2a.dealt)} | Lost ${fmt(f2a.received)}
          </div>
        </div>
      </div>
      <table class="table table-sm table-hover mb-0" style="font-size:0.85rem;">
        <thead><tr><th>Player</th><th class="text-end">AI/Structure Dealt</th><th class="text-end">AI/Structure Lost</th></tr></thead>
        <tbody>`;

    const players = Object.entries(assetData.by_player).sort((a, b) => b[1].dealt - a[1].dealt);
    players.forEach(([name, d]) => {
      html += `<tr><td>${esc(name)}</td><td class="text-end">${fmt(d.dealt)}</td><td class="text-end">${fmt(d.received)}</td></tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // --- All Matches ---
  function renderAggMeta(meta) {
    const container = document.getElementById('agg-meta');
    const dur = meta.total_duration_sec;
    const m = Math.floor(dur / 60);
    const submitters = meta.submitters || [];
    const posCount = meta.matches_with_positioning || 0;
    const posBlock = posCount > 0
      ? `<div><span class="stat-label">With Positioning</span><br><strong>${posCount} / ${meta.match_count}</strong></div>`
      : '';
    const minMatches = meta.min_career_matches || 0;
    const dropped = meta.players_dropped_by_min_matches || 0;
    const minBlock = (minMatches > 0 && dropped > 0)
      ? `<div><span class="stat-label">Career Roster</span><br><strong>${minMatches}+ matches</strong><br><span class="stat-label">${dropped} hidden</span></div>`
      : '';
    container.innerHTML = `
      <div><span class="stat-label">Matches</span><br><strong>${meta.match_count}</strong></div>
      <div><span class="stat-label">Total Play Time</span><br><strong>${m} min</strong></div>
      <div><span class="stat-label">Maps</span><br><strong>${meta.maps_played.length}</strong></div>
      <div><span class="stat-label">Submitters</span><br><strong>${submitters.length}</strong></div>
      <div><span class="stat-label">Date Range</span><br><strong>${meta.date_range.join(' — ')}</strong></div>
      ${posBlock}
      ${minBlock}
    `;
  }

  function careerWeaponsUsedCount(c) {
    const wb = c.weapon_breakdown || {};
    return Object.values(wb).filter(w => (w.dealt || 0) > 0).length;
  }

  function careerPerMatchAvg(total, matchesPlayed) {
    const m = matchesPlayed || 0;
    return m > 0 ? total / m : 0;
  }

  function careerNet(c) {
    return (c.total_dealt || 0) - (c.total_received || 0);
  }

  function careerRatioSortValue(c) {
    const d = c.total_dealt || 0;
    const r = c.total_received || 0;
    if (r > 0) return d / r;
    if (d > 0) return 1e9;
    return 0;
  }

  function careerRatioDisplayStr(c) {
    const d = c.total_dealt || 0;
    const r = c.total_received || 0;
    if (r > 0) return Number(d / r).toFixed(2);
    if (d > 0) return '∞';
    return '0.00';
  }

  // Pre-rendered KaTeX HTML for the VTSR-T methodology modal. Built
  // lazily on first modal open so katex.min.js (deferred) is guaranteed
  // loaded. Cached as a module-local string after first build.
  //
  // v2 (Phase 12): rewritten as a 6-section structured reference (it
  // stopped being a tooltip 3 iterations ago — the modal can host a
  // proper layout). Each section is a `<section
  // class="vt-vtsr-doc-section">` with an h6 title; matching CSS
  // lives in css/vtstats-theme.css.
  //
  // v2.1: bumped the rating-logistic scale from S_R = 400 to 800.
  // Curve table values (curveRows below) are pre-computed for S_R = 800.
  // At S_R = 400 the same ±200 / ±400 gaps would read ±0.52 / ±0.82,
  // not ±0.28 / ±0.52 — relabel if S_R changes again.
  let vtsrTooltipHtmlCache = null;
  // Returns the rendered modal HTML, or ``null`` when ``katex.min.js``
  // (deferred in index.html) hasn't finished loading yet. Returning
  // null instead of a ``<code>``-fallback string is critical: an
  // earlier version cached the fallback and locked the modal into
  // showing raw LaTeX forever, even after KaTeX eventually loaded.
  // The caller (the modal's ``show.bs.modal`` handler) re-attempts on
  // each open until KaTeX is ready, then locks in the cached result.
  function buildVtsrTooltipHtml() {
    if (vtsrTooltipHtmlCache) return vtsrTooltipHtmlCache;
    const k = (window.katex && typeof window.katex.renderToString === 'function')
      ? window.katex
      : null;
    if (!k) return null;
    function tex(latex, displayMode) {
      try { return k.renderToString(latex, { displayMode, throwOnError: false }); }
      catch { return `<code>${esc(latex)}</code>`; }
    }

    // ---- Equations ----
    const updateEqGain = tex('\\Delta R^{C}_{i} \\;=\\; K_i \\cdot S_O \\cdot (P_i - E_i)', true);
    const updateEqLoss = tex('\\Delta R^{C}_{i} \\;=\\; K_i \\cdot S_O \\cdot (P_i - E_i) \\cdot L \\cdot \\varphi(R^{C}_{i}) \\quad \\text{when } (P_i - E_i) < 0', true);
    const blendEq      = tex('\\mathrm{VTSR}_i \\;=\\; \\alpha \\cdot R^{W}_i + (1 - \\alpha) \\cdot R^{C}_i', true);
    const expectedEq   = tex('E_i \\;=\\; \\frac{2}{1 + 10^{(\\bar{R}_i - R^{C}_i) / S_R}} \\;-\\; 1', true);
    const rbarEq       = tex('\\bar{R}_i \\;=\\; \\mathrm{median}\\{\\, R^{C}_j \\,:\\, j \\neq i \\,\\}', true);
    const compositeEq  = tex('P_i \\;=\\; \\sum_{a \\in \\mathcal{A}} w\'_a \\cdot \\frac{\\mathrm{clip}_{[-2,+2]}(z_a(x_{i,a}))}{2}', true);
    const kEq          = tex('K_i \\;=\\; K_{\\text{base}} \\cdot \\left(1 - \\frac{n_i}{n_i + n_{\\text{prior}}}\\right) + K_{\\text{floor}}', true);
    const phiEq        = tex('\\varphi(R) \\;=\\; \\mathrm{clamp}(0,\\,1,\\,(R - F)/W)', true);

    // ---- Symbol legend (under the hero equation) ----
    const symbolRows = [
      ['K_i',       'K-factor (decays with experience)'],
      ['S_O = 2.5', 'outcome scale (per-match update magnitude)'],
      ['P_i',       'your performance index this match (8-axis composite)'],
      ['E_i',       'expected performance given your rating vs the lobby'],
      ['L = 0.85',  'loss aversion multiplier (losses only)'],
      ['\u03c6(R)',  'soft-floor taper (losses only)'],
    ].map(([sym, desc]) => `<div><code>${esc(sym)}</code> <span>${esc(desc)}</span></div>`).join('');

    // ---- Expected-score curve intuition table ----
    // Pre-computed from the formula E_i = 2 / (1 + 10^((Rbar - R) / S_R)) - 1
    // with S_R = 800 (the v2.1 calibrated value). Recompute these
    // values if S_R changes — at S_R = 400 the same gaps would produce
    // ±0.52 / ±0.82 / ±0.92, not ±0.28 / ±0.52 / ±0.80. The 5 rows
    // below mirror the typical lobby-stratification range we see in
    // our corpus (±400 pts is roughly Tier 1 vs Tier 4).
    const curveRows = [
      ['&minus;400', '&minus;0.52'],
      ['&minus;200', '&minus;0.28'],
      ['0',          '0.00'],
      ['+200',       '+0.28'],
      ['+400',       '+0.52'],
    ].map(([gap, e]) => `<tr><td>${gap}</td><td class="text-end">${e}</td></tr>`).join('');

    // ---- 8-axis thug composite (v2.2). Sum = 1.00. ----
    // Listed in weight order so the heaviest signals lead the table.
    // ``structure_share`` replaced the v2.1 ``asset_multiplier`` axis
    // (which moved to the future VTSR-C commander rating because damage
    // by player-owned AI tracks build/route quality rather than dogfight
    // skill). ``target_lock_pct`` is a discipline reward at low weight.
    const weightsRows = [
      ['Net damage share', '0.21', 'damage you dealt minus damage you took, as a share of the lobby total'],
      ['Kill rate',        '0.20', 'kills per minute played'],
      ['PvP share',        '0.18', 'fraction of your damage that hit other players (anti-PvE-farming)'],
      ['Accuracy',         '0.15', 'shots hit divided by shots fired'],
      ['Structure share',  '0.10', 'damage you landed on enemy buildings / economy (recyclers, factories, extractors, turrets) as a share of your total damage'],
      ['Mobility',         '0.08', 'how much of the map you actually moved across (positioning data)'],
      ['Snipe bonus',      '0.04', 'sniper rifle hits (capped before z-score so one big game can\u2019t deform the lobby)'],
      ['T-key usage',      '0.04', 'share of the match you held an active T-key target lock (situational-awareness proxy)'],
    ].map(([n, w, d]) => `<tr><td><strong>${n}</strong><br><small class="text-muted">${esc(d)}</small></td><td class="text-end align-top">${w}</td></tr>`).join('');

    // ---- K-decay table ----
    const kRows = [
      ['0 matches',  '52', 'rookie — calibrating fast'],
      ['5 matches',  '~39', ''],
      ['20 matches', '~25', ''],
      ['50+ matches', '~19', 'settled veteran'],
    ].map(([n, k_, note]) => `<tr><td>${n}</td><td class="text-end"><code>${k_}</code></td><td class="text-muted"><small>${esc(note)}</small></td></tr>`).join('');

    // ---- Tier ladder ----
    const tierRows = [
      ['Tier 1', '&ge; 1800',     'top of the ladder'],
      ['Tier 2', '1650 \u2013 1799', ''],
      ['Tier 3', '1500 \u2013 1649', 'anchor band'],
      ['Tier 4', '1350 \u2013 1499', ''],
      ['Tier 5', '1000 \u2013 1349', 'wide band; soft floor at 1000'],
    ].map(([n, r, note]) => `<tr><td><strong>${n}</strong></td><td class="text-end"><code>${r}</code></td><td class="text-muted"><small>${esc(note)}</small></td></tr>`).join('');

    // ---- Worked example: Lamper m9 (v2.2 post-rerate) ----
    // Real numbers captured from data/processed/elo_history.json after
    // re-rating the corpus under VTSR-T v2.2 (match 2026-05-04T03-45-41,
    // Lamper's 9th rated match). Lobby (sorted by `before`):
    //   1333.32 / 1372.60 / 1385.28 / 1449.74 / **1455.77 (median for
    //   Lamper)** / 1482.74 / 1499.38 / 1543.11 / 1767.39 -- the
    //   median-of-OTHER-players is what Lamper compares against, so it
    //   rules out his own 1500.82.
    // P = +0.5435 (top of lobby), E_i = +0.0647, dR = +40.96.
    const exKEq  = tex('K_i \\;=\\; 40 \\cdot \\left(1 - \\frac{8}{8 + 10}\\right) + 12 \\;=\\; 34.22', true);
    const exEEq  = tex('E_i \\;=\\; \\frac{2}{1 + 10^{(1455.77 - 1500.82) / 800}} - 1 \\;\\approx\\; +0.0647', true);
    const exDREq = tex('\\Delta R^{C}_i \\;=\\; 34.22 \\cdot 2.5 \\cdot (0.5435 - 0.0647) \\;\\approx\\; +40.96', true);

    vtsrTooltipHtmlCache = `<div class="vt-katex-tooltip-body">

      <section class="vt-vtsr-doc-section">
        <h6>Performance Composite <span class="text-muted">(P)</span></h6>
        <p class="mb-2"><strong>VTSR-T</strong> (VT Stats Rating &mdash; Thug) is our combat-focused rating, and the per-match Performance Composite is the heart of it. Your single-match performance index is a weighted sum of eight thug-relevant axes. Each axis is computed per-player, z-scored across the lobby, clipped to &plusmn;2, and divided by 2 to land in &plusmn;1. Missing axes (e.g. no structure damage in this lobby, no positioning data) redistribute their weight pro-rata across the remaining axes.</p>
        ${compositeEq}
        <table class="vt-katex-weights">
          <thead><tr><th>Axis</th><th class="text-end">Weight</th></tr></thead>
          <tbody>${weightsRows}</tbody>
        </table>
        <div class="vt-katex-caveat">Direct-dogfight axes (net damage + kill rate + PvP share + accuracy + snipe) still total 0.78, so the v2.2 axis swap sharpens what counts as thug work without blunting the core fighting signal. Structure share rewards real base/economy pressure; T-key usage is a small discipline reward.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>The Update Rule</h6>
        <p class="mb-2">Each rated match changes your combat rating by the difference between your performance composite <code>P_i</code> and your expected performance <code>E_i</code>, scaled by an experience-dependent K-factor:</p>
        ${updateEqGain}
        <p class="mb-2 mt-2">When the bracket goes negative (loss case), two \u201chope\u201d multipliers soften the drop:</p>
        ${updateEqLoss}
        <div class="vt-vtsr-doc-symbols">${symbolRows}</div>
        <p class="mb-2 mt-3">The published rating blends Wins ELO and Combat ELO:</p>
        ${blendEq}
        <div class="vt-katex-caveat">v1 ships with &alpha; = 0.0 (Combat ELO only); Wins ELO is stubbed at the 1500 anchor until the in-game winner-attestation UI lands. The headline <strong>VTSR</strong> field therefore equals VTSR-T today.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Expected Performance <span class="text-muted">(E)</span></h6>
        <p class="mb-2">Instead of comparing your performance to the lobby median alone, we compare it to what we\u2019d <em>expect</em> from a player of your rating in this lobby (fine-tuned ELO-style strength-of-schedule). The reference is the <strong>median</strong> rating of all other players (median, not mean, so a single VTrider doesn\u2019t pull the bar up for everyone).</p>
        ${rbarEq}
        ${expectedEq}
        <p class="mb-2">When you out-rate the lobby, you\u2019re expected to score positive; when you\u2019re the underdog, you\u2019re expected to score negative. Performing as expected leaves your rating unchanged.</p>
        <table class="vt-vtsr-doc-curve-table">
          <thead><tr><th>Rating gap (R &minus; R\u0304)</th><th class="text-end">Expected E_i</th></tr></thead>
          <tbody>${curveRows}</tbody>
        </table>
        <div class="vt-katex-caveat">S<sub>R</sub> = 800 (calibrated for our small-population corpus). Classic binary-outcome ELO often uses a ~400-pt logistic denominator; our continuous P_i composite behaves differently, and our ~25-player league means tight denominators pin E_i too aggressively; widening to 800 lets top players plateau ~300 pts above the median lobby instead of ~140.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>K-factor &amp; Hope Mechanics</h6>
        <p class="mb-2">Your K-factor scales every per-match update. New players have a high K (their rating moves fast while we calibrate); settled veterans have a low K (their rating is stable).</p>
        ${kEq}
        <table class="vt-vtsr-doc-curve-table">
          <thead><tr><th>Matches played</th><th class="text-end">K_i</th><th></th></tr></thead>
          <tbody>${kRows}</tbody>
        </table>
        <p class="mb-2 mt-3">For losses, two \u201chope\u201d multipliers apply:</p>
        <ul class="mb-2">
          <li><strong>Loss aversion</strong> &middot; every loss is multiplied by L = 0.85 (common in modern ranked ladders).</li>
          <li><strong>Soft floor</strong> &middot; losses taper to zero as you approach the rating floor F = 1000:</li>
        </ul>
        ${phiEq}
        <div class="vt-katex-caveat">F = 1000 (soft rating floor). W = 150 (taper window: by R = 1150 the full asymmetric loss is restored). A defensive max(F, R) clamp catches float-edge drift.</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier Ladder</h6>
        <p class="mb-2">Tiers are <strong>absolute</strong> VTSR-T thresholds &mdash; they don\u2019t track percentile, so a thin top tier is a thin top tier. Players with fewer than 10 rated matches show a <strong>Provisional</strong> badge instead of a tier.</p>
        <table class="vt-katex-tiers">
          <thead><tr><th>Tier</th><th class="text-end">VTSR-T range</th><th></th></tr></thead>
          <tbody>${tierRows}</tbody>
        </table>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Worked Example &middot; Lamper\u2019s 9th rated match</h6>
        <p class="mb-2">Real numbers from <code>data/processed/elo_history.json</code> (match <code>2026-05-04T03-45-41</code>, re-rated under VTSR-T v2.2):</p>
        <ul class="mb-3">
          <li><strong>Player</strong>: Lamper at R = 1500.82 with 8 rated matches played.</li>
          <li><strong>Lobby opponents</strong> (sorted by current rating): 1333 / 1373 / 1385 / 1450 / <strong>1456 (median for Lamper)</strong> / 1483 / 1499 / 1543 / 1767. Median of the other 9 players = 1455.77.</li>
          <li><strong>Performance</strong>: P_i = +0.5435 (top of lobby on net damage, PvP share, and accuracy).</li>
        </ul>
        ${exKEq}
        ${exEEq}
        ${exDREq}
        <p class="mb-2 mt-2">Result: Lamper\u2019s combat rating ticks 1500.82 &rarr; 1541.78. Even with the expected-performance discount of about +0.065, his P_i of +0.5435 was far enough above the bar to earn a +41 update at K = 34.</p>
      </section>

      <div class="vt-katex-caveat mt-3">
        <strong>VTSR-T v2.2 &middot; thug-axis rebalance.</strong> v2.2 reshapes the Performance Composite around dogfight skill: drops <code>asset_multiplier</code> (damage by your owned AI &mdash; that&rsquo;s a build/route signal, reserved for the future VTSR-C commander rating), adds <code>structure_share</code> (player-dealt damage to enemy buildings as a share of total dealt), and adds <code>target_lock_pct</code> (T-key situational-awareness proxy). Snipe shaved 0.05 &rarr; 0.04 and three other axes nudged to keep the sum at 1.00. v2.0 had already moved the per-match comparison from lobby-median to opponent-strength-weighted expected performance (E_i, median of opponent ratings); v2.1 set S<sub>R</sub> = 800 to widen the rating spread for our small-population corpus. <strong>Pre-v2.2 peak_vtsr values are no longer comparable</strong> &mdash; the P_i definition changed. Wins ELO blend (&alpha;) still 0.0; full algorithm in DEVELOPER_GUIDE \u00a713.
      </div>
    </div>`;
    return vtsrTooltipHtmlCache;
  }

  // Inline 10-point sparkline canvas for the Trend column. Plain Canvas
  // 2D so we don't pay Chart.js construction cost per row.
  function renderSparkline(canvas, deltas) {
    if (!canvas || !canvas.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 64;
    const cssH = canvas.clientHeight || 18;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!deltas || deltas.length === 0) return;
    const maxAbs = Math.max(1, ...deltas.map(d => Math.abs(d)));
    const midY = cssH / 2;
    const stepX = deltas.length > 1 ? cssW / (deltas.length - 1) : cssW;
    // Center reference line.
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--kb-text-muted').trim() || '#666';
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(cssW, midY);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
    // Series line, color-shifted by sign of last delta.
    const success = getComputedStyle(document.documentElement).getPropertyValue('--kb-success').trim() || '#3fb950';
    const danger  = getComputedStyle(document.documentElement).getPropertyValue('--kb-danger').trim()  || '#f85149';
    ctx.strokeStyle = (deltas[deltas.length - 1] >= 0) ? success : danger;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    deltas.forEach((d, i) => {
      const x = i * stepX;
      const y = midY - (d / maxAbs) * (midY - 1);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function vtsrSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':           va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'last_delta':     va = a.last_delta || 0;            vb = b.last_delta || 0;            break;
        case 'peak_vtsr':      va = a.peak_vtsr || 0;             vb = b.peak_vtsr || 0;             break;
        case 'matches_played': va = a.matches_played || 0;        vb = b.matches_played || 0;        break;
        case 'vtsr':
        default:               va = a.vtsr || 0;                  vb = b.vtsr || 0;                  break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  // Renders the dedicated VTSR-T Leaderboard card. `elo` is the parsed
  // elo_current.json payload (or null when the file is missing — in which
  // case the card hides itself entirely). `careerStats` is the post-filter
  // career_stats list emitted by the aggregator; we filter the displayed
    // roster to players who appear there so the dedicated VTSR-T card never
  // shows a player the Career Leaderboard hides.
  function renderVtsrLeaderboard(elo, careerStats) {
    const $card = document.getElementById('section-vtsr');
    if (!$card) return;

    if (!elo || !Array.isArray(elo.ratings) || elo.ratings.length === 0) {
      $card.classList.add('d-none');
      return;
    }

    // Cascade the career_stats filter set so the picker filter narrows
    // the dedicated VTSR-T table the same way it narrows the Career table.
    // (Ratings themselves are corpus-wide — only the displayed roster
    // changes based on filter scope.)
    const careerNames    = new Set((careerStats || []).map(c => (c.name || '').toLowerCase()));
    const careerSteam64s = new Set((careerStats || []).map(c => c.steam64).filter(Boolean));
    const visible = elo.ratings.filter(r => {
      if (r.steam64 && careerSteam64s.has(r.steam64)) return true;
      if (r.name && careerNames.has(r.name.toLowerCase())) return true;
      return false;
    });
    if (visible.length === 0) {
      $card.classList.add('d-none');
      return;
    }
    $card.classList.remove('d-none');

    const sorted = visible.slice().sort(vtsrSort(vtsrSortState.key, vtsrSortState.asc));
    const tbody = $card.querySelector('#vtsr-table tbody');
    tbody.innerHTML = sorted.map((r, i) => {
      const tier = resolveTier(r.vtsr, r.matches_played);
      let tierTip;
      if (tier.id === 0) {
        tierTip = `Provisional · play ${ELO_PROVISIONAL_THRESHOLD - r.matches_played} more rated matches to leave Provisional`;
      } else if (tier.id === 1) {
        tierTip = `${tier.label} · ${tier.min}+ VTSR-T · top of the ladder`;
      } else if (tier.id === 5) {
        const fromFloor = Math.max(0, Math.round(r.vtsr - 1000));
        tierTip = `${tier.label} · ${tier.min}–${tier.max - 1} VTSR-T · ${fromFloor} pts above floor`;
      } else {
        const prog = tierProgress(r.vtsr, tier);
        tierTip = `${tier.label} · ${tier.min}–${tier.max - 1} VTSR-T · ${Math.max(0, Math.round(prog.toNext))} pts to Tier ${tier.id - 1}`;
      }
      const badge = tierBadgeHtml(tier, { title: tierTip });
      const lastDelta = r.last_delta || 0;
      const lastClass = lastDelta > 0 ? 'vt-vtsr-delta-positive' : lastDelta < 0 ? 'vt-vtsr-delta-negative' : '';
      const lastSign  = lastDelta > 0 ? '+' : '';
      const sparklineId = `vtsr-spark-${(r.steam64 || r.name || i)}`.replace(/[^A-Za-z0-9_-]/g, '_');
      return `<tr data-vtsr-name="${esc(r.name)}">
        <td>${i + 1}</td>
        <td class="text-center">${badge}</td>
        <td class="fw-semibold">${esc(r.name)}</td>
        <td class="text-end vt-vtsr-rating">${Math.round(r.vtsr)}</td>
        <td class="text-end ${lastClass}">${lastSign}${lastDelta.toFixed(1)}</td>
        <td class="text-end">${Math.round(r.peak_vtsr || r.vtsr)}</td>
        <td class="text-end">${r.matches_played}</td>
        <td class="text-end"><canvas class="vt-vtsr-sparkline" id="${sparklineId}"></canvas></td>
      </tr>`;
    }).join('');

    // Render the per-row sparklines after the rows are in the DOM so the
    // canvases have layout (clientWidth/Height).
    requestAnimationFrame(() => {
      sorted.forEach((r, i) => {
        const id = `vtsr-spark-${(r.steam64 || r.name || i)}`.replace(/[^A-Za-z0-9_-]/g, '_');
        renderSparkline(document.getElementById(id), r.win_history || []);
      });
    });

    // Wire sortable header cells.
    document.querySelectorAll('#vtsr-table th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === vtsrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (vtsrSortState.key === th.dataset.sort) vtsrSortState.asc = !vtsrSortState.asc;
        else { vtsrSortState.key = th.dataset.sort; vtsrSortState.asc = false; }
        renderVtsrLeaderboard(elo, careerStats);
      };
    });

    // Click-to-scroll: jump from the dedicated VTSR-T card to the Career
    // Leaderboard row for the same player.
    tbody.querySelectorAll('tr[data-vtsr-name]').forEach(tr => {
      tr.onclick = () => {
        const target = document.getElementById('section-career');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    // Wire the VTSR-T methodology modal to lazy-populate its body the
    // first time it opens. We deliberately do NOT populate on first
    // VTSR-T render here — that races KaTeX's deferred load and would
    // cache a fallback ``<code>`` rendering of every equation. By
    // the time the user clicks "How It's Calculated", katex.min.js
    // has long since loaded; rendering at modal-open time guarantees
    // ``buildVtsrTooltipHtml()`` returns a real KaTeX-rendered body.
    // The listener attaches once (idempotent via the data flag) so
    // re-renders of the leaderboard don't pile up duplicate handlers.
    const $modal = document.getElementById('vtsr-methodology-modal');
    const $modalBody = document.getElementById('vtsr-methodology-modal-body');
    if ($modal && $modalBody && !$modal.dataset.vtListener) {
      $modal.dataset.vtListener = '1';
      $modal.addEventListener('show.bs.modal', () => {
        if ($modalBody.dataset.vtPopulated) return;
        const html = buildVtsrTooltipHtml();
        if (html) {
          $modalBody.innerHTML = html;
          $modalBody.dataset.vtPopulated = '1';
        }
      });
    }

    ensureTooltips($card);
  }

  // Look up a career row's VTSR-T record from the cached ELO payload.
  // Joins by steam64 (primary) with name fallback for legacy contributions
  // missing steam64. Returns null when ELO data isn't loaded yet (404 path).
  function careerEloFor(row) {
    const elo = window.__vtElo;
    if (!elo || !Array.isArray(elo.ratings)) return null;
    const ratings = elo.ratings;
    if (row.steam64) {
      const r = ratings.find(rr => rr.steam64 === row.steam64);
      if (r) return r;
    }
    if (row.name) {
      const r = ratings.find(rr => (rr.name || '').toLowerCase() === row.name.toLowerCase());
      if (r) return r;
    }
    return null;
  }

  function careerLeaderboardSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':
          va = (a.name || '').toLowerCase();
          vb = (b.name || '').toLowerCase();
          break;
        case 'matches_played':
          va = a.matches_played || 0;
          vb = b.matches_played || 0;
          break;
        case 'vtsr': {
          // Sort missing ELO rows below all rated rows.
          const ea = careerEloFor(a);
          const eb = careerEloFor(b);
          va = ea ? ea.vtsr : -Infinity;
          vb = eb ? eb.vtsr : -Infinity;
          break;
        }
        case 'tier': {
          // Tier desc => Tier 1 first; Provisional rows sink to the bottom.
          // Encode tier id as a numeric weight (Tier 1 highest), ties
          // break on VTSR-T sort key `vtsr` (handled by the secondary ordering branch
          // below — we encode tier-then-vtsr as a single composite).
          const ea = careerEloFor(a);
          const eb = careerEloFor(b);
          // Provisional / missing ELO uses a negative tier weight so it
          // always sinks below all rated rows on either sort direction.
          const ta = ea ? resolveTier(ea.vtsr, ea.matches_played) : { id: 0 };
          const tb = eb ? resolveTier(eb.vtsr, eb.matches_played) : { id: 0 };
          // Tier id 0 = Provisional; map to 99 so it sinks to the bottom
          // when sorting "best tier first" (asc=false on UI = desc here).
          const sortableA = ta.id === 0 ? 99 : ta.id;
          const sortableB = tb.id === 0 ? 99 : tb.id;
          if (sortableA !== sortableB) {
            // Inverted: lower tier id = "better" tier in our ladder.
            va = -sortableA; vb = -sortableB;
          } else {
            // Within a tier, secondary sort by VTSR-T (`vtsr` field).
            va = ea ? ea.vtsr : -Infinity;
            vb = eb ? eb.vtsr : -Infinity;
          }
          break;
        }
        case 'total_pvp_dealt':
          va = a.total_pvp_dealt || 0;
          vb = b.total_pvp_dealt || 0;
          break;
        case 'total_pve_dealt':
          va = a.total_pve_dealt || 0;
          vb = b.total_pve_dealt || 0;
          break;
        case 'total_dealt':
          va = a.total_dealt || 0;
          vb = b.total_dealt || 0;
          break;
        case 'total_pvp_received':
          va = a.total_pvp_received || 0;
          vb = b.total_pvp_received || 0;
          break;
        case 'total_pve_received':
          va = a.total_pve_received || 0;
          vb = b.total_pve_received || 0;
          break;
        case 'total_received':
          va = a.total_received || 0;
          vb = b.total_received || 0;
          break;
        case 'net':
          va = careerNet(a);
          vb = careerNet(b);
          break;
        case 'ratio':
          va = careerRatioSortValue(a);
          vb = careerRatioSortValue(b);
          break;
        case 'overall_accuracy':
          va = a.overall_accuracy || 0;
          vb = b.overall_accuracy || 0;
          break;
        case 'total_kills':
          va = a.total_kills || 0;
          vb = b.total_kills || 0;
          break;
        case 'total_deaths':
          va = a.total_deaths || 0;
          vb = b.total_deaths || 0;
          break;
        case 'total_asset_dealt':
          va = a.total_asset_dealt || 0;
          vb = b.total_asset_dealt || 0;
          break;
        case 'mean_movement_score': {
          va = a.mean_movement_score != null ? a.mean_movement_score : -1;
          vb = b.mean_movement_score != null ? b.mean_movement_score : -1;
          break;
        }
        case 'fav_weapon':
          va = (a.fav_weapon || '').toLowerCase();
          vb = (b.fav_weapon || '').toLowerCase();
          break;
        case 'weapons_used':
          va = careerWeaponsUsedCount(a);
          vb = careerWeaponsUsedCount(b);
          break;
        case 'avg_pvp_dealt':
          va = careerPerMatchAvg(a.total_pvp_dealt || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_pvp_dealt || 0, b.matches_played);
          break;
        case 'avg_pve_dealt':
          va = careerPerMatchAvg(a.total_pve_dealt || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_pve_dealt || 0, b.matches_played);
          break;
        case 'avg_total_dealt':
          va = careerPerMatchAvg(a.total_dealt || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_dealt || 0, b.matches_played);
          break;
        case 'avg_pvp_received':
          va = careerPerMatchAvg(a.total_pvp_received || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_pvp_received || 0, b.matches_played);
          break;
        case 'avg_pve_received':
          va = careerPerMatchAvg(a.total_pve_received || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_pve_received || 0, b.matches_played);
          break;
        case 'avg_total_received':
          va = careerPerMatchAvg(a.total_received || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_received || 0, b.matches_played);
          break;
        case 'avg_net':
          va = careerPerMatchAvg(careerNet(a), a.matches_played);
          vb = careerPerMatchAvg(careerNet(b), b.matches_played);
          break;
        case 'avg_kills':
          va = careerPerMatchAvg(a.total_kills || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_kills || 0, b.matches_played);
          break;
        case 'avg_deaths':
          va = careerPerMatchAvg(a.total_deaths || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_deaths || 0, b.matches_played);
          break;
        case 'avg_asset_dealt':
          va = careerPerMatchAvg(a.total_asset_dealt || 0, a.matches_played);
          vb = careerPerMatchAvg(b.total_asset_dealt || 0, b.matches_played);
          break;
        default:
          va = a.total_dealt || 0;
          vb = b.total_dealt || 0;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase();
      const nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  function remapCareerSortKeyForColumnView(mode) {
    if (mode === 'per-match') {
      const next = CAREER_TOTAL_TO_AVG_SORT[careerSortState.key];
      if (next) careerSortState.key = next;
    } else if (mode === 'totals') {
      const next = CAREER_AVG_TO_TOTAL_SORT[careerSortState.key];
      if (next) careerSortState.key = next;
    }
  }

  function syncCareerTableColumnViewClass() {
    const table = document.getElementById('career-table');
    if (!table) return;
    table.classList.remove('vt-career-cols-per-match', 'vt-career-cols-totals', 'vt-career-cols-all');
    table.classList.add('vt-career-cols-' + careerColumnView);
  }

  function updateCareerColumnViewButtons() {
    document.querySelectorAll('#section-career [data-career-cols]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-career-cols') === careerColumnView);
    });
  }

  function initCareerColumnViewControls() {
    const section = document.getElementById('section-career');
    if (!section || section.dataset.vtCareerColInit === '1') return;
    section.dataset.vtCareerColInit = '1';
    section.querySelectorAll('[data-career-cols]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-career-cols');
        if (!mode || mode === careerColumnView) return;
        careerColumnView = mode;
        try { localStorage.setItem('vt-career-cols-view', mode); } catch (e) { /* ignore */ }
        remapCareerSortKeyForColumnView(mode);
        const agg = window.__vtAllMatchesData;
        if (agg && agg.career_stats) renderCareerTable(agg.career_stats);
        else updateCareerColumnViewButtons();
      });
    });
  }

  function renderCareerTable(stats) {
    syncCareerTableColumnViewClass();
    const tbody = document.querySelector('#career-table tbody');
    const sorted = [...stats].sort(careerLeaderboardSort(careerSortState.key, careerSortState.asc));
    tbody.innerHTML = sorted.map((c, i) => {
      const m = c.matches_played || 0;
      const netVal = careerNet(c);
      const netClass = netVal > 0 ? 'color:var(--kb-success)' : netVal < 0 ? 'color:var(--kb-danger)' : '';
      const netAvg = careerPerMatchAvg(netVal, m);
      const netAvgClass = netAvg > 0 ? 'color:var(--kb-success)' : netAvg < 0 ? 'color:var(--kb-danger)' : '';
      const ratioStr = careerRatioDisplayStr(c);
      const accPct = (c.overall_accuracy != null ? c.overall_accuracy : 0) * 100;
      const wpns = careerWeaponsUsedCount(c);
      const avgK = careerPerMatchAvg(c.total_kills || 0, m);
      const avgD = careerPerMatchAvg(c.total_deaths || 0, m);

      let moveCell = '<span style="color:var(--kb-text-muted);">—</span>';
      if (c.matches_with_positioning > 0 && c.mean_movement_score != null) {
        const score = Math.round(c.mean_movement_score);
        const band = c.movement_band_dominant || 'Balanced';
        const stdev = c.movement_score_stddev;
        const color = score >= 75
          ? 'var(--kb-success)'
          : score >= 45
            ? 'var(--kb-warning)'
            : 'var(--kb-danger)';
        const pct = Math.max(0, Math.min(100, score));
        const nPos = c.matches_with_positioning;
        const denom = c.matches_played;
        const titleText = `Avg ${score} (${band}), \u03c3 ${stdev} across ${nPos}/${denom} matches`;
        moveCell = `
          <div class="vt-movement-cell" title="${esc(titleText)}">
            <div class="vt-movement-cell-top">
              <span class="vt-movement-score" style="color:${color};">${score}</span>
              <span class="vt-movement-band-label">${esc(band)}</span>
            </div>
            <div class="vt-movement-bar"><div class="vt-movement-bar-fill" style="width:${pct}%;background:${color};"></div></div>
          </div>`;
      }
      // Tier + VTSR-T cells. Joined per row from window.__vtElo (cached in
      // loadAllMatches). Falls through to em-dash when ELO is missing.
      const eloRow = careerEloFor(c);
      let tierCell = '<span style="color:var(--kb-text-muted);">&mdash;</span>';
      let vtsrCell = '<span style="color:var(--kb-text-muted);">&mdash;</span>';
      if (eloRow) {
        const tier = resolveTier(eloRow.vtsr, eloRow.matches_played);
        const tip = eloRow.matches_played < ELO_PROVISIONAL_THRESHOLD
          ? `Provisional · play ${ELO_PROVISIONAL_THRESHOLD - eloRow.matches_played} more rated matches`
          : `${tier.label} · ${tier.min}${tier.max === Infinity ? '+' : `–${tier.max - 1}`} VTSR-T`;
        tierCell = tierBadgeHtml(tier, { title: tip });
        vtsrCell = `<span class="vt-vtsr-rating" title="VTSR-T (anchor 1500, floor 1000) · ${eloRow.matches_played} rated matches">${Math.round(eloRow.vtsr)}</span>`;
      }
      return `<tr>
        <td class="vt-career-col-shared">${i + 1}</td>
        <td class="vt-career-col-shared fw-semibold">${esc(c.name)}</td>
        <td class="text-center vt-career-col-shared">${tierCell}</td>
        <td class="text-end vt-career-col-shared">${vtsrCell}</td>
        <td class="text-center vt-career-col-shared"><span style="color:var(--kb-text-muted);" title="Not applicable across matches">—</span></td>
        <td class="text-end vt-career-col-shared">${c.matches_played}</td>
        <td class="text-end vt-col-split vt-career-col-total">${fmt(c.total_pvp_dealt || 0)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_pvp_dealt || 0, m))}</td>
        <td class="text-end vt-col-split vt-career-col-total">${fmt(c.total_pve_dealt || 0)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_pve_dealt || 0, m))}</td>
        <td class="text-end vt-career-col-total">${fmt(c.total_dealt)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_dealt || 0, m))}</td>
        <td class="text-end vt-col-split vt-career-col-total">${fmt(c.total_pvp_received || 0)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_pvp_received || 0, m))}</td>
        <td class="text-end vt-col-split vt-career-col-total">${fmt(c.total_pve_received || 0)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_pve_received || 0, m))}</td>
        <td class="text-end vt-career-col-total">${fmt(c.total_received)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_received || 0, m))}</td>
        <td class="text-end vt-career-col-total" style="${netClass}">${netVal > 0 ? '+' : ''}${fmt(netVal)}</td>
        <td class="text-end vt-col-split vt-career-col-avg" style="${netAvgClass}">${netAvg > 0 ? '+' : ''}${fmt(netAvg)}</td>
        <td class="text-end vt-career-col-shared">${ratioStr}</td>
        <td class="text-end vt-career-col-shared">${accPct.toFixed(1)}%</td>
        <td class="text-end vt-career-col-total">${c.total_kills || 0}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${avgK.toFixed(1)}</td>
        <td class="text-end vt-career-col-total">${c.total_deaths || 0}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${avgD.toFixed(1)}</td>
        <td class="text-end vt-career-col-total">${fmt(c.total_asset_dealt)}</td>
        <td class="text-end vt-col-split vt-career-col-avg">${fmt(careerPerMatchAvg(c.total_asset_dealt || 0, m))}</td>
        <td class="vt-career-col-shared">${moveCell}</td>
        <td class="vt-career-col-shared"><span class="badge bg-secondary">${esc(c.fav_weapon)}</span></td>
        <td class="text-end vt-career-col-shared">${wpns}</td>
      </tr>`;
    }).join('');

    document.querySelectorAll('#career-table th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === careerSortState.key);
      th.onclick = () => {
        if (careerSortState.key === th.dataset.sort) careerSortState.asc = !careerSortState.asc;
        else { careerSortState.key = th.dataset.sort; careerSortState.asc = false; }
        renderCareerTable(stats);
      };
    });
    updateCareerColumnViewButtons();
    ensureTooltips(document.getElementById('career-table'));
  }

  // Sync the active class on the Totals|Per match segmented buttons in the
  // Career Radar card header to match `careerRadarState.mode`. Called from
  // renderCareerRadar so the buttons stay consistent through picker
  // re-aggregates and All Matches re-entries.
  function syncCareerRadarModeButtons() {
    document.querySelectorAll('#section-career-radar [data-career-radar-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-career-radar-mode') === careerRadarState.mode);
    });
    // Refresh the card-header info-tooltip so its top-of-tooltip note
    // describes the currently active scale.
    const icon = document.querySelector('#section-career-radar [data-vt-radar-info="career"]');
    if (icon && typeof buildRadarInfoTooltipHtml === 'function') {
      const html = buildRadarInfoTooltipHtml('career', careerRadarState.mode);
      icon.setAttribute('title', html);
      icon.setAttribute('data-bs-original-title', html);
      if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
        const inst = bootstrap.Tooltip.getInstance(icon);
        if (inst && typeof inst.setContent === 'function') {
          inst.setContent({ '.tooltip-inner': html });
        }
      }
    }
  }

  // Career Radar (All Matches tab). Supports single mode (with ghost median)
  // and compare mode (two players). State persists in careerRadarState across
  // All Matches re-entries; reset in loadAllMatches on each fetch.
  function renderCareerRadar(data) {
    const canvas = document.getElementById('career-radar-canvas');
    if (!canvas) return;

    const stats = (data && data.career_stats) || [];
    const toggleBtn = document.getElementById('career-radar-compare-toggle');
    const vsLabel = document.querySelector('.vt-career-radar-vs');
    const selB = document.getElementById('career-radar-pick-b');
    const hint = document.getElementById('career-radar-hint');

    syncCareerRadarModeButtons();

    if (!stats.length) {
      if (toggleBtn) toggleBtn.disabled = true;
      if (hint) {
        hint.textContent = 'No career data available.';
        hint.classList.remove('d-none');
      }
      if (typeof renderPlayerRadar === 'function') {
        renderPlayerRadar('career-radar-canvas', data, {
          mode: 'career',
          careerScale: careerRadarState.mode,
        });
      }
      return;
    }
    if (toggleBtn) toggleBtn.disabled = stats.length < 2;

    const names = stats.map(c => c.name);
    const valid = new Set(names);

    if (!careerRadarState.a || !valid.has(careerRadarState.a)) {
      careerRadarState.a = names[0];
    }
    if (careerRadarState.compare) {
      if (!careerRadarState.b || !valid.has(careerRadarState.b) || careerRadarState.b === careerRadarState.a) {
        careerRadarState.b = names.find(n => n !== careerRadarState.a) || null;
      }
    }
    if (stats.length < 2 && careerRadarState.compare) {
      careerRadarState.compare = false;
    }

    const selA = document.getElementById('career-radar-pick-a');
    const buildOpts = (sel, selectedName) => {
      if (!sel) return;
      sel.innerHTML = names.map(n =>
        `<option value="${esc(n)}"${n === selectedName ? ' selected' : ''}>${esc(n)}</option>`
      ).join('');
    };
    buildOpts(selA, careerRadarState.a);
    buildOpts(selB, careerRadarState.b);

    if (vsLabel) vsLabel.classList.toggle('d-none', !careerRadarState.compare);
    if (selB) selB.classList.toggle('d-none', !careerRadarState.compare);
    if (toggleBtn) toggleBtn.classList.toggle('active', careerRadarState.compare);

    const samePair = careerRadarState.compare && careerRadarState.a &&
      careerRadarState.b && careerRadarState.a === careerRadarState.b;
    if (hint) {
      if (samePair) {
        hint.textContent = 'Pick two different players to compare.';
        hint.classList.remove('d-none');
      } else if (stats.length < 2) {
        hint.textContent = 'Need at least two players in career stats to compare.';
        hint.classList.remove('d-none');
      } else {
        hint.classList.add('d-none');
      }
    }

    if (typeof renderPlayerRadar === 'function') {
      const focusNames = careerRadarState.compare
        ? [careerRadarState.a, careerRadarState.b].filter(Boolean)
        : [careerRadarState.a];
      renderPlayerRadar('career-radar-canvas', data, {
        mode: 'career',
        focusNames,
        showMedian: !careerRadarState.compare,
        careerScale: careerRadarState.mode,
      });
    }
  }

  // ---- Commanders tab renderers ----

  // Sortable commander leaderboard. Win % cells degrade to em-dash with
  // an explanatory tooltip when the player has fewer than 5 determined-
  // winner matches in the relevant role (mirrors the floor on
  // `commander_stats.rows[].win_pct_*`).
  let commanderSortState = { key: 'win_pct_as_commander', asc: false };

  function commanderSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':                  va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'wins_losses_cmdr':      va = a.wins_as_commander - a.losses_as_commander;
                                       vb = b.wins_as_commander - b.losses_as_commander; break;
        case 'matches_as_commander':  va = a.matches_as_commander || 0; vb = b.matches_as_commander || 0; break;
        case 'matches_as_thug':       va = a.matches_as_thug      || 0; vb = b.matches_as_thug      || 0; break;
        case 'win_pct_as_commander':  va = a.win_pct_as_commander != null ? a.win_pct_as_commander : -1;
                                       vb = b.win_pct_as_commander != null ? b.win_pct_as_commander : -1; break;
        case 'win_pct_as_thug':       va = a.win_pct_as_thug      != null ? a.win_pct_as_thug      : -1;
                                       vb = b.win_pct_as_thug      != null ? b.win_pct_as_thug      : -1; break;
        case 'avg_dealt_as_commander': va = a.avg_dealt_as_commander || 0; vb = b.avg_dealt_as_commander || 0; break;
        case 'avg_dealt_as_thug':      va = a.avg_dealt_as_thug      || 0; vb = b.avg_dealt_as_thug      || 0; break;
        case 'avg_kills_as_commander': va = a.avg_kills_as_commander || 0; vb = b.avg_kills_as_commander || 0; break;
        case 'avg_kills_as_thug':      va = a.avg_kills_as_thug      || 0; vb = b.avg_kills_as_thug      || 0; break;
        default:                       va = a.matches_as_commander || 0; vb = b.matches_as_commander || 0;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    };
  }

  function _factionBadge(code) {
    if (!code) return '<span style="color:var(--kb-text-muted);">—</span>';
    const labelMap = { i: 'ISDF', e: 'Hadean', f: 'Scion' };
    return `<span class="vt-faction-badge" data-faction-code="${esc(code)}">${labelMap[code] || code}</span>`;
  }

  function _winPctCell(pct, determined) {
    if (pct == null) {
      const tip = `Awaiting more data — ${determined || 0} of 5 determined-winner matches needed`;
      return `<span style="color:var(--kb-text-muted);" title="${esc(tip)}">&mdash;</span>`;
    }
    return `${(pct * 100).toFixed(1)}%`;
  }

  function renderCommanderLeaderboard(rows) {
    const tbody = document.querySelector('#commander-table tbody');
    if (!tbody) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="text-center" style="color:var(--kb-text-muted);">No commander data in the current scope.</td></tr>';
      return;
    }
    const sorted = [...rows].sort(commanderSort(commanderSortState.key, commanderSortState.asc));
    tbody.innerHTML = sorted.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(r.name)}</td>
        <td class="text-end">${r.matches_as_commander || 0}</td>
        <td class="text-end">${r.matches_as_thug || 0}</td>
        <td class="text-end">${r.wins_as_commander || 0}&ndash;${r.losses_as_commander || 0} <span style="color:var(--kb-text-muted);">(${r.determined_as_commander || 0})</span></td>
        <td class="text-end">${_winPctCell(r.win_pct_as_commander, r.determined_as_commander)}</td>
        <td class="text-end">${_winPctCell(r.win_pct_as_thug, r.determined_as_thug)}</td>
        <td class="text-end">${r.avg_dealt_as_commander != null ? fmt(r.avg_dealt_as_commander) : '<span style="color:var(--kb-text-muted);">—</span>'}</td>
        <td class="text-end">${r.avg_dealt_as_thug != null ? fmt(r.avg_dealt_as_thug) : '<span style="color:var(--kb-text-muted);">—</span>'}</td>
        <td class="text-end">${r.avg_kills_as_commander != null ? r.avg_kills_as_commander.toFixed(2) : '<span style="color:var(--kb-text-muted);">—</span>'}</td>
        <td class="text-end">${r.avg_kills_as_thug != null ? r.avg_kills_as_thug.toFixed(2) : '<span style="color:var(--kb-text-muted);">—</span>'}</td>
        <td class="text-center">${_factionBadge(r.favored_faction)}</td>
      </tr>
    `).join('');

    document.querySelectorAll('#commander-table th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === commanderSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (commanderSortState.key === th.dataset.sort) commanderSortState.asc = !commanderSortState.asc;
        else { commanderSortState.key = th.dataset.sort; commanderSortState.asc = false; }
        renderCommanderLeaderboard(rows);
      };
    });
    ensureTooltips(document.getElementById('commander-table'));
  }

  function renderCommanderH2H(pairs) {
    const container = document.getElementById('commander-h2h-container');
    if (!container) return;
    container.innerHTML = '';
    if (!pairs || !pairs.length) {
      container.innerHTML = '<p class="text-center" style="color:var(--kb-text-muted);">No commander pairings recorded in the current scope.</p>';
      return;
    }
    pairs.slice(0, 10).forEach(p => {
      const row = document.createElement('div');
      row.className = 'd-flex justify-content-between align-items-center p-2 mb-2 rounded';
      row.style.background = 'color-mix(in oklab, var(--kb-text-muted) 8%, transparent)';
      const determined = (p.a_wins || 0) + (p.b_wins || 0);
      const subline = determined > 0
        ? `${p.a_wins || 0}&ndash;${p.b_wins || 0} (${determined} decided${p.contested ? `, ${p.contested} contested` : ''})`
        : `${p.matches} matches · no decided outcomes yet`;
      row.innerHTML = `
        <div>
          <div class="fw-bold">${esc(p.a)} <span style="color:var(--kb-text-muted)">vs</span> ${esc(p.b)}</div>
          <div class="small" style="color:var(--kb-text-secondary)">${subline}</div>
        </div>
        <div class="text-end" style="color:var(--kb-text-muted); font-size:0.85rem;">
          ${p.matches} match${p.matches === 1 ? '' : 'es'}
        </div>
      `;
      container.appendChild(row);
    });
  }

  function renderGlobalRivalries(rivalries) {
    const container = document.getElementById('global-rivalries-container');
    container.innerHTML = '';
    rivalries.slice(0, 5).forEach(r => {
      const card = document.createElement('div');
      card.className = 'rivalry-card d-flex align-items-center gap-3 p-3 mb-3 rounded';
      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      info.innerHTML = `
        <div class="fw-bold mb-1">${esc(r.a)} <span style="color:var(--kb-text-muted)">vs</span> ${esc(r.b)}</div>
        <div class="small" style="color:var(--kb-text-secondary)">
          <span style="color:var(--kb-primary)">${esc(r.a)}</span> dealt ${fmt(r.a_to_b)} &nbsp;|&nbsp;
          <span style="color:var(--kb-accent)">${esc(r.b)}</span> dealt ${fmt(r.b_to_a)}
        </div>
        <div class="small" style="color:var(--kb-text-muted)">Total: ${fmt(r.total)}</div>
      `;
      card.appendChild(info);
      const chartWrap = document.createElement('div');
      chartWrap.className = 'd-flex align-items-center';
      card.appendChild(chartWrap);
      container.appendChild(card);
      renderRivalryDoughnut(chartWrap, r);
    });
  }

  // --- Fullscreen Modal ---
  const modalEl = document.getElementById('fullscreen-modal');
  const modalTitle = document.getElementById('fullscreen-modal-title');
  const modalBody = document.getElementById('fullscreen-modal-body');
  const bsModal = new bootstrap.Modal(modalEl);
  let modalChart = null;

  const chartRenderers = {};
  function registerChartRenderer(sectionId, renderFn) {
    chartRenderers[sectionId] = renderFn;
  }

  function expandSection(sectionId) {
    const card = document.getElementById(sectionId);
    if (!card) return;

    const title = card.querySelector('.card-header h5');
    modalTitle.textContent = title ? title.textContent : '';
    modalBody.innerHTML = '';

    if (chartRenderers[sectionId]) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;width:100%;height:calc(100vh - 120px);';
      const canvas = document.createElement('canvas');
      canvas.id = 'modal-chart-canvas';
      wrap.appendChild(canvas);
      modalBody.appendChild(wrap);
      bsModal.show();
      requestAnimationFrame(() => { modalChart = chartRenderers[sectionId]('modal-chart-canvas'); });
    } else {
      const body = card.querySelector('.card-body');
      if (body) {
        const clone = body.cloneNode(true);
        clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        clone.querySelectorAll('canvas').forEach(el => el.remove());
        modalBody.appendChild(clone);
      }
      bsModal.show();
    }
  }

  modalEl.addEventListener('hidden.bs.modal', () => {
    if (modalChart) {
      activeCharts = activeCharts.filter(c => c !== modalChart);
      modalChart.destroy();
      modalChart = null;
    }
    modalBody.innerHTML = '';
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-expand]');
    if (btn) { expandSection(btn.dataset.expand); return; }

    // Rivalry-card drill-down: click or keyboard-activate a top-rivalry card
    // to drive the compare-mode radar.
    const rivCard = e.target.closest('[data-rivalry-pair]');
    if (rivCard && rivCard.closest('#rivalries-container')) {
      const [a, b] = (rivCard.dataset.rivalryPair || '').split('|');
      if (a && b && currentFilteredData) {
        rivalryRadarPair = { a, b };
        renderRivalryRadar(currentFilteredData);
        syncRivalryCardActive();
      }
      return;
    }

    // Custom... toggle on the Rivalry Radar card
    const customBtn = e.target.closest('#rivalry-radar-custom-toggle');
    if (customBtn && currentFilteredData) {
      rivalryRadarCustom = !rivalryRadarCustom;
      const picker = document.getElementById('rivalry-radar-custom-picker');
      if (picker) picker.classList.toggle('d-none', !rivalryRadarCustom);
      customBtn.classList.toggle('active', rivalryRadarCustom);
      return;
    }

    // Compare toggle on the Career Radar card
    const careerCompareBtn = e.target.closest('#career-radar-compare-toggle');
    if (careerCompareBtn && window.__vtAllMatchesData) {
      careerRadarState.compare = !careerRadarState.compare;
      renderCareerRadar(window.__vtAllMatchesData);
      return;
    }

    // Totals|Per match scale toggle on the Career Radar card. Only active
    // when All Matches data is loaded; no-op when clicking the already-
    // selected mode. Persists the choice in localStorage so it survives
    // session reloads.
    const careerModeBtn = e.target.closest('#section-career-radar [data-career-radar-mode]');
    if (careerModeBtn && window.__vtAllMatchesData) {
      const next = careerModeBtn.getAttribute('data-career-radar-mode');
      if (next !== 'totals' && next !== 'per-match') return;
      if (next === careerRadarState.mode) return;
      careerRadarState.mode = next;
      try { localStorage.setItem('vt-career-radar-mode', next); } catch (e2) { /* ignore */ }
      renderCareerRadar(window.__vtAllMatchesData);
      return;
    }
  });

  // Keyboard activation (Enter/Space) for rivalry cards
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const rivCard = e.target.closest && e.target.closest('[data-rivalry-pair]');
    if (rivCard && rivCard.closest('#rivalries-container')) {
      e.preventDefault();
      const [a, b] = (rivCard.dataset.rivalryPair || '').split('|');
      if (a && b && currentFilteredData) {
        rivalryRadarPair = { a, b };
        renderRivalryRadar(currentFilteredData);
        syncRivalryCardActive();
      }
    }
  });

  // Career dropdown change handler (delegated via 'change'). Career compare
  // still uses native <select>s; the rivalry-radar picker was rebuilt in
  // Phase 2 as chip-based dropdowns and uses click handlers instead.
  document.addEventListener('change', (e) => {
    if (!e.target) return;
    if ((e.target.id === 'career-radar-pick-a' || e.target.id === 'career-radar-pick-b') && window.__vtAllMatchesData) {
      const a = document.getElementById('career-radar-pick-a');
      const b = document.getElementById('career-radar-pick-b');
      if (a) careerRadarState.a = a.value;
      if (b && careerRadarState.compare) careerRadarState.b = b.value;
      renderCareerRadar(window.__vtAllMatchesData);
      return;
    }
  });

  // Rivalry picker: click on a menu item, swap, or clear button.
  document.addEventListener('click', (e) => {
    if (!currentFilteredData) return;

    const pickItem = e.target.closest('[data-rivalry-pick-slot]');
    if (pickItem) {
      const slotKey = pickItem.dataset.rivalryPickSlot;
      const name = pickItem.dataset.rivalryPickName;
      if (slotKey === 'a') rivalryRadarPair = { ...rivalryRadarPair, a: name };
      else if (slotKey === 'b') rivalryRadarPair = { ...rivalryRadarPair, b: name };
      renderRivalryRadar(currentFilteredData);
      syncRivalryCardActive();
      return;
    }

    if (e.target.closest('#rivalry-radar-swap')) {
      rivalryRadarPair = { a: rivalryRadarPair.b, b: rivalryRadarPair.a };
      renderRivalryRadar(currentFilteredData);
      syncRivalryCardActive();
      return;
    }

    if (e.target.closest('#rivalry-radar-clear')) {
      // Force a re-reconcile to the default top-rivalry pair by clearing the
      // current pair so renderRivalryRadar's reconciliation logic kicks in.
      rivalryRadarPair = { a: null, b: null };
      renderRivalryRadar(currentFilteredData);
      syncRivalryCardActive();
      return;
    }
  });

  function registerMatchCharts(data, allNames) {
    registerChartRenderer('section-timeline', (canvasId) => {
      const names = allNames || data.leaderboard.map(p => p.name);
      return renderTimeline(canvasId, data.timeline, names, timelineMode);
    });
    registerChartRenderer('section-weapon-meta', (canvasId) => {
      return renderWeaponMeta(canvasId, data.weapon_meta);
    });
    registerChartRenderer('section-player-weapons', (canvasId) => {
      return renderPlayerWeapons(canvasId, data.leaderboard, data.weapon_meta);
    });
    registerChartRenderer('section-weapon-accuracy', (canvasId) => {
      return renderWeaponAccuracy(canvasId, data.weapon_meta);
    });
    registerChartRenderer('section-vehicle-kills', (canvasId) => {
      return renderVehicleKills(canvasId, currentData.kills.by_vehicle);
    });
    registerChartRenderer('section-rivalry-radar', (canvasId) => {
      if (typeof renderPlayerRadar !== 'function') return null;
      return renderPlayerRadar(canvasId, data, {
        mode: 'compare',
        focusNames: [rivalryRadarPair.a, rivalryRadarPair.b],
      });
    });
    registerChartRenderer('section-faction-radar', (canvasId) => {
      if (typeof renderPlayerRadar !== 'function') return null;
      return renderPlayerRadar(canvasId, data, { mode: 'team' });
    });
    registerChartRenderer('section-replay', (canvasId) => {
      if (window.VTReplay && window.VTReplay.hasInstance()) {
        return window.VTReplay.renderFullscreenSnapshot(canvasId);
      }
      return null;
    });
  }

  function registerAllMatchesCharts(data) {
    registerChartRenderer('section-global-weapon', (canvasId) => {
      return renderGlobalWeaponMeta(canvasId, data.global_weapon_meta);
    });
    registerChartRenderer('section-career-radar', (canvasId) => {
      if (typeof renderPlayerRadar !== 'function') return null;
      const focusNames = careerRadarState.compare
        ? [careerRadarState.a, careerRadarState.b].filter(Boolean)
        : [careerRadarState.a].filter(Boolean);
      return renderPlayerRadar(canvasId, data, {
        mode: 'career',
        focusNames,
        showMedian: !careerRadarState.compare,
        careerScale: careerRadarState.mode,
      });
    });
  }

  // --- Helpers ---
  function fmt(n) { return Math.round(n).toLocaleString(); }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Idempotent Bootstrap tooltip initializer. Targets a container's
  // `[data-bs-toggle="tooltip"]` elements (typically column headers in <thead>,
  // which are static across body re-renders). Safe to call multiple times.
  function ensureTooltips(container) {
    if (!container || !window.bootstrap || !window.bootstrap.Tooltip) return;
    const els = container.querySelectorAll('[data-bs-toggle="tooltip"]');
    els.forEach(el => bootstrap.Tooltip.getOrCreateInstance(el));
  }

  // Populates the `title` attribute of any radar info icon in `container`
  // with the rendered tooltip HTML for its mode, then initializes Bootstrap
  // tooltips. Idempotent: once an icon's real title is set, subsequent calls
  // are no-ops (Bootstrap has already cached the original title).
  function applyRadarInfoTooltips(container) {
    if (!container || typeof buildRadarInfoTooltipHtml !== 'function') return;
    const icons = container.querySelectorAll('[data-vt-radar-info]');
    icons.forEach(el => {
      // Skip icons that Bootstrap has already initialized — their real title
      // has been moved to data-bs-original-title and the `title` attr is
      // replaced with a placeholder. Re-setting at this stage has no effect.
      if (el.hasAttribute('data-bs-original-title')) return;
      const mode = el.getAttribute('data-vt-radar-info') || 'per-match';
      el.setAttribute('title', buildRadarInfoTooltipHtml(mode));
    });
    ensureTooltips(container);
  }

  // --- Match Not Found Error State ---
  // Captured once at init so we can restore it after showing errors.
  const preloaderHtml = $loading.innerHTML;

  function restorePreloader() {
    if ($loading.innerHTML !== preloaderHtml) {
      $loading.innerHTML = preloaderHtml;
    }
  }

  function showMatchNotFound(badId) {
    $dashboard.classList.add('d-none');
    $allView.style.display = 'none';
    if (window.VTReplay) window.VTReplay.destroy();
    if (window.VTPositionPlayer) window.VTPositionPlayer.destroy();
    destroyAllCharts();

    const panel = document.createElement('div');
    panel.className = 'vt-error-panel';
    panel.innerHTML = `
      <div class="vt-error-icon"><i class="bi bi-exclamation-triangle"></i></div>
      <div class="vt-error-title">Match not found</div>
      <div class="vt-error-detail"><code>${esc(badId)}</code></div>
      <div class="vt-error-action">
        <label for="vt-error-match-picker" class="stat-label d-block mb-2">Pick a match instead:</label>
        <select id="vt-error-match-picker" class="form-select form-select-sm" style="max-width:320px;margin:0 auto;">
          <option value="" disabled selected>Select a match&hellip;</option>
          <option value="__all__">All Matches</option>
          ${manifest.map(m => {
            const shortDate = new Date(m.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            return `<option value="${esc(m.file)}">${esc(m.name)} — ${shortDate}</option>`;
          }).join('')}
        </select>
      </div>
    `;
    $loading.innerHTML = '';
    $loading.appendChild(panel);
    $loading.classList.remove('d-none');

    panel.querySelector('#vt-error-match-picker').addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      // One-time bypass of the live-sync gate: strip the stale bad-match URL
      // before loading, regardless of the live-sync preference. The bad ID is
      // actively misleading and the user has explicitly chosen a different
      // match, so clearing is unambiguous intent.
      history.replaceState(null, '', window.location.pathname);
      if (val === '__all__') {
        updateMatchPickerTriggers('__all__');
      } else {
        const entry = manifest.find(m => m.file === val);
        if (entry) updateMatchPickerTriggers(entry);
      }
      const doLoad = () => {
        if (val === '__all__') loadAllMatches();
        else loadMatch(val);
      };
      if (window.VTFx) VTFx.withViewTransition(doLoad);
      else doLoad();
    });
  }

  // --- Preferences Gear ---
  // Re-opens the landing modal pre-filled with the current saved pref so
  // users can change their mind later. onCancel is a no-op here so
  // dismissing the modal doesn't disturb whatever they're currently viewing.
  document.getElementById('landing-prefs-btn')?.addEventListener('click', () => {
    showLandingModal({
      current: readLandingPref(),
      onConfirm: ({ mode, matchId, persist }) => {
        if (persist) writeLandingPref({ version: LANDING_PREF_VERSION, mode, matchId });
        else clearLandingPref();
        const doLoad = () => applyLandingChoice({ mode, matchId });
        if (window.VTFx) VTFx.withViewTransition(doLoad);
        else doLoad();
      },
      onCancel: () => { /* no-op: keep current view */ },
    });
  });

  // --- Initial Boot ---
  // Branch to the appropriate loader based on the URL state we already
  // parsed earlier (during picker init — `const initialUrlState` is in
  // scope from the Phase 2 init block above). Shared URLs (any
  // match/tab/filter/team/players intent) always win and fully bypass the
  // landing preferences modal. Only when no URL intent exists do we
  // consult the stored pref (or show the first-visit modal).
  const hasOtherUrlIntent = initialUrlState.tab
    || initialUrlState.filter
    || initialUrlState.team
    || (initialUrlState.players && initialUrlState.players.length);

  function runInitialBoot() {
    if (initialUrlState.match === 'all') {
      updateMatchPickerTriggers('__all__');
      loadAllMatches(initialUrlState);
    } else if (initialUrlState.match) {
      const entry = manifest.find(m => m.id === initialUrlState.match);
      if (entry) {
        updateMatchPickerTriggers(entry);
        loadMatch(entry.file, initialUrlState);
      } else {
        showMatchNotFound(initialUrlState.match);
      }
    } else if (manifest.length > 0 && hasOtherUrlIntent) {
      // Partial shared link (e.g. ?tab=positioning). Preserve prior behavior:
      // load first match and apply the URL state so filter/tab hydrate.
      updateMatchPickerTriggers(manifest[0]);
      loadMatch(manifest[0].file, initialUrlState);
    } else if (manifest.length > 0) {
      // No URL intent at all — consult landing pref.
      const pref = readLandingPref();
      if (!pref || pref.mode === 'ask') {
        showLandingModal({
          current: null,
          onConfirm: ({ mode, matchId, persist }) => {
            if (persist) writeLandingPref({ version: LANDING_PREF_VERSION, mode, matchId });
            applyLandingChoice({ mode, matchId });
          },
          // Cancel falls back to the new default (All matches), matching
          // what the modal showed pre-selected.
          onCancel: () => applyLandingChoice({ mode: 'all' }),
        });
      } else {
        applyLandingChoice(pref);
      }
    }
  }

  // Wire permanent two-way sync between the modal's "Don't show on page
  // load" checkbox and the persisted dismissal flag. Runs unconditionally
  // (regardless of current flag state) so navbar-triggered re-opens
  // (#record-stats-btn-desktop / -mobile) honor the same contract as the
  // first-visit auto-open: opening always reflects the persisted state,
  // and closing always persists the current checkbox state — including
  // *un*checking, which clears the flag and re-enables the auto-open.
  const $recordStatsModal = document.getElementById('record-stats-modal');
  const $recordStatsCheckbox = document.getElementById('record-stats-dont-show');
  if ($recordStatsModal && $recordStatsCheckbox) {
    $recordStatsModal.addEventListener('show.bs.modal', () => {
      $recordStatsCheckbox.checked = readRecordStatsDismissed();
    });
    $recordStatsModal.addEventListener('hidden.bs.modal', () => {
      if ($recordStatsCheckbox.checked) writeRecordStatsDismissed();
      else clearRecordStatsDismissed();
    });
  }

  // Gate the boot sequence behind the "How to record your stats" modal
  // until the user dismisses it. The dismissal flag is independent of
  // any URL intent, so shared links still resolve correctly — the modal
  // just defers the resolution until it closes. The {once:true} listener
  // here only handles boot resumption; persistence is owned by the
  // permanent listener pair attached above (which also fires for navbar
  // re-opens). Bootstrap fires hidden.bs.modal listeners in registration
  // order, so persistence runs before runInitialBoot().
  if (!readRecordStatsDismissed() && $recordStatsModal && window.bootstrap) {
    const recordInst = bootstrap.Modal.getOrCreateInstance($recordStatsModal);
    $recordStatsModal.addEventListener('hidden.bs.modal', runInitialBoot, { once: true });
    // Hide the preloader behind the modal so the welcome screen reads
    // cleanly (mirrors the trick showLandingModal() uses). Loaders
    // re-show #loading themselves when they actually run.
    $loading.classList.add('d-none');
    recordInst.show();
  } else {
    runInitialBoot();
  }
})();
