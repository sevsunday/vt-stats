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
  const $pickerSearch   = document.getElementById('match-picker-search');
  // Bootstrap Modal instance (lazy-initialized on first trigger click). We
  // hold a reference so card-click handlers can programmatically dismiss.
  let pickerModalInstance = null;

  // Current selection target. '__all__' for the aggregate view, otherwise
  // the manifest entry object (not just its id/file — we need name + sub
  // text for the trigger). null before boot completes.
  let currentTarget = null;

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

  // Builds and shows the landing preferences modal. Called on first-visit
  // boot (when no URL intent and no stored pref) and from the Preferences
  // gear button in the nav. The two entry points differ only in their
  // onCancel handling: first-visit falls back to loading the most recent
  // match; gear re-open is a no-op so dismissing doesn't disturb the view.
  function showLandingModal({ current, onConfirm, onCancel }) {
    const $modal = document.getElementById('landing-modal');
    if (!$modal || !window.bootstrap) return;

    const $recentRadio   = document.getElementById('landing-mode-recent');
    const $allRadio      = document.getElementById('landing-mode-all');
    const $specificRadio = document.getElementById('landing-mode-specific');
    const $specificWrap  = document.getElementById('landing-specific-wrap');
    const $specificSel   = document.getElementById('landing-specific-select');
    const $recentHint    = document.getElementById('landing-mode-recent-hint');
    const $persistYes    = document.getElementById('landing-persist-yes');
    const $persistNo     = document.getElementById('landing-persist-no');
    const $confirmBtn    = document.getElementById('landing-modal-confirm');

    // Fill the "Most recent" label with the actual map + date so the
    // default option is concrete rather than abstract.
    if (manifest.length > 0 && $recentHint) {
      const m = manifest[0];
      const shortDate = new Date(m.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      $recentHint.textContent = `${m.name} — ${shortDate}`;
    }

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
    if (current && current.mode === 'all') {
      $allRadio.checked = true;
    } else if (current && current.mode === 'specific') {
      $specificRadio.checked = true;
      if (current.matchId && $specificSel) {
        const exists = manifest.some(m => m.id === current.matchId);
        if (exists) $specificSel.value = current.matchId;
      }
    } else {
      $recentRadio.checked = true;
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

    const slug = getActiveTabSlug();
    if (slug && slug !== 'overview') params.set('tab', slug);

    const qs = params.toString();
    return window.location.pathname + (qs ? '?' + qs : '');
  }

  // Gated URL writer — no-op unless live sync is enabled.
  function syncUrl() {
    if (!liveSyncEnabled) return;
    history.replaceState(null, '', buildShareUrl());
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
          <span class="vt-match-picker-card-leader-vs">v</span>
          <span class="vt-match-picker-card-leader vt-match-picker-card-leader--t2">${esc(l2 || '—')}</span>
        </div>`;
    }
    const mapRaw = entry.map && entry.map !== entry.name
      ? `<div class="vt-match-picker-card-rawmap vt-mono">${esc(entry.map)}</div>`
      : '';
    return `
      <button type="button" class="vt-match-picker-card" data-target="${esc(entry.file)}" role="listitem">
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
      </button>`;
  }

  function buildMatchPickerAllCardHtml() {
    const submitters = new Set(manifest.map(m => m.submitter).filter(Boolean));
    return `
      <button type="button" class="vt-match-picker-card vt-match-picker-card--all" data-target="__all__" role="listitem">
        <div class="vt-match-picker-card-head">
          <span class="vt-match-picker-card-name"><i class="bi bi-collection me-1"></i>All Matches</span>
          <span class="vt-match-picker-card-meta">${manifest.length} matches &middot; ${submitters.size} submitter${submitters.size === 1 ? '' : 's'}</span>
        </div>
        <div class="vt-match-picker-card-submeta">
          <span class="vt-muted">Career overview across every recorded match.</span>
        </div>
      </button>`;
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
      const submitters = new Set(manifest.map(m => m.submitter).filter(Boolean));
      name = 'All Matches';
      sub = `${manifest.length} matches \u00B7 ${submitters.size} submitter${submitters.size === 1 ? '' : 's'}`;
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

  // --- Match picker: search filter ---

  function applyMatchPickerSearch(query) {
    const q = (query || '').trim().toLowerCase();
    if (!$pickerGrid) return;
    let visibleRegular = 0;
    $pickerGrid.querySelectorAll('.vt-match-picker-card').forEach(el => {
      const isAll = el.dataset.target === '__all__';
      // "All Matches" card always renders regardless of search.
      if (isAll) {
        el.classList.remove('d-none');
        return;
      }
      const blob = el.dataset.searchBlob || '';
      const match = !q || blob.includes(q);
      el.classList.toggle('d-none', !match);
      if (match) visibleRegular++;
    });
    if ($pickerEmpty) {
      $pickerEmpty.classList.toggle('d-none', !q || visibleRegular > 0);
    }
  }

  if ($pickerSearch) {
    let searchTimer = null;
    $pickerSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyMatchPickerSearch($pickerSearch.value), 80);
    });
  }

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
      // Reset search on close so next open starts fresh.
      if ($pickerSearch) {
        $pickerSearch.value = '';
        applyMatchPickerSearch('');
      }
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

  // --- Filter State ---
  let currentData = null;
  let currentFilteredData = null;
  let filterState = { mode: 'all', players: [], team: null, persist: false };
  let timelineMode = 'player';
  let sortState = { key: 'dealt', asc: false };
  // Currently selected pair for the compare-mode radar on the Rivalries tab.
  // Reset on match switch; reconciled against the filtered leaderboard on
  // filter change, falling back to the first visible top_rivalries entry.
  let rivalryRadarPair = { a: null, b: null };
  // Whether the Custom... picker is expanded. Persists across re-renders of
  // the Rivalries tab but resets on match switch.
  let rivalryRadarCustom = false;
  // Career Radar state (All Matches tab). Persists across All Matches re-entries
  // within a session. Reset by loadAllMatches on fresh data loads.
  let careerRadarState = { a: null, b: null, compare: false };

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

    let data;
    try {
      const res = await fetch('data/processed/all_matches.json');
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch {
      $loading.innerHTML = '<p class="text-center mt-5" style="color:var(--kb-danger)">Failed to load aggregate data.</p>';
      return;
    }

    if (window.VTFx) VTFx.hidePreloader();
    $loading.classList.add('d-none');
    $allView.style.display = 'block';

    // Reset Career Radar state to defaults for a fresh All Matches load.
    // Dropdown values will re-default from career_stats[0] in the renderer.
    careerRadarState = { a: null, b: null, compare: false };

    renderAggMeta(data.meta);
    renderCareerTable(data.career_stats);
    renderCareerRadar(data);
    applyRadarInfoTooltips(document.getElementById('section-career-radar'));
    // Stash the aggregate data on window so the Career Radar event handlers
    // can re-render without having to thread the object through tab renderers.
    window.__vtAllMatchesData = data;
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
    renderCombinedHeatmap('combined-heatmap-canvas', positioning);
    renderHeatmapGrid('heatmap-grid-content', filteredView);
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
      return teamList.map(p => esc(p.name)).join(', ');
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

    const t1Muted = !bothActive && !active.has('1');
    const t2Muted = !bothActive && !active.has('2');
    const mutedNote = '<span class="vt-faction-muted-badge" title="Not included in current filter"><i class="bi bi-eye-slash me-1"></i>Filtered out</span>';

    container.innerHTML = `
      <div class="col-md-6">
        <div class="vt-faction-panel ${t1Muted ? 'vt-faction-panel--muted' : ''}" style="border-left-color:var(--kb-primary);">
          <h6 class="d-flex align-items-center gap-2 mb-3" style="color:var(--kb-primary);">Team 1 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t1Header}</span>${t1Muted ? mutedNote : ''}</h6>
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
        <div class="vt-faction-panel ${t2Muted ? 'vt-faction-panel--muted' : ''}" style="border-left-color:var(--kb-accent);">
          <h6 class="d-flex align-items-center gap-2 mb-3" style="color:var(--kb-accent);">Team 2 <span class="fw-normal" style="font-size:0.8rem;color:var(--kb-text-secondary);">— ${t2Header}</span>${t2Muted ? mutedNote : ''}</h6>
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
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(r.name)}</td>
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

    // Populate Custom... dropdowns from the current match roster
    const selA = document.getElementById('rivalry-radar-pick-a');
    const selB = document.getElementById('rivalry-radar-pick-b');
    const buildOpts = (sel, selectedName) => {
      if (!sel) return;
      sel.innerHTML = names.map(n =>
        `<option value="${esc(n)}"${n === selectedName ? ' selected' : ''}>${esc(n)}</option>`
      ).join('');
    };
    buildOpts(selA, rivalryRadarPair.a);
    buildOpts(selB, rivalryRadarPair.b);

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
  function renderKillFeed(kills, tickRate, minTick) {
    const container = document.getElementById('kill-feed-content');
    if (!kills || !kills.feed || kills.feed.length === 0) {
      container.innerHTML = '<p style="color:var(--kb-text-muted)">No kill events recorded.</p>';
      return;
    }
    const stripOdf = (s) => s ? s.replace(/\.odf$/i, '').replace(/_/g, ' ') : '?';
    let html = '<div style="max-height:320px;overflow-y:auto;">';
    kills.feed.forEach(entry => {
      const sec = tickRate > 0 ? (entry.tick - minTick) / tickRate : 0;
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const ts = `${m}:${String(s).padStart(2, '0')}`;
      html += `<div class="d-flex align-items-center gap-2 py-1" style="font-size:0.82rem;border-bottom:1px solid var(--kb-border-subtle);">`;
      html += `<span class="text-nowrap" style="color:var(--kb-text-muted);min-width:3.5em;">${ts}</span>`;
      html += `<span class="fw-semibold" style="color:var(--kb-primary);">${esc(entry.killer)}</span>`;
      html += `<span style="color:var(--kb-text-muted);font-size:0.75rem;">(${esc(stripOdf(entry.killer_odf))})</span>`;
      html += `<i class="bi bi-arrow-right" style="color:var(--kb-danger);"></i>`;
      html += `<span class="fw-semibold" style="color:var(--kb-accent);">${esc(entry.victim)}</span>`;
      html += `<span style="color:var(--kb-text-muted);font-size:0.75rem;">(${esc(stripOdf(entry.victim_odf))})</span>`;
      html += `</div>`;
    });
    html += '</div>';
    container.innerHTML = html;
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
    container.innerHTML = `
      <div><span class="stat-label">Matches</span><br><strong>${meta.match_count}</strong></div>
      <div><span class="stat-label">Total Play Time</span><br><strong>${m} min</strong></div>
      <div><span class="stat-label">Maps</span><br><strong>${meta.maps_played.length}</strong></div>
      <div><span class="stat-label">Submitters</span><br><strong>${submitters.length}</strong></div>
      <div><span class="stat-label">Date Range</span><br><strong>${meta.date_range.join(' — ')}</strong></div>
      ${posBlock}
    `;
  }

  function renderCareerTable(stats) {
    const tbody = document.querySelector('#career-table tbody');
    tbody.innerHTML = stats.map((c, i) => {
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
        const n = c.matches_with_positioning;
        const denom = c.matches_played;
        const titleText = `Avg ${score} (${band}), \u03c3 ${stdev} across ${n}/${denom} matches`;
        moveCell = `
          <div class="vt-movement-cell" title="${esc(titleText)}">
            <div class="vt-movement-cell-top">
              <span class="vt-movement-score" style="color:${color};">${score}</span>
              <span class="vt-movement-band-label">${esc(band)}</span>
            </div>
            <div class="vt-movement-bar"><div class="vt-movement-bar-fill" style="width:${pct}%;background:${color};"></div></div>
          </div>`;
      }
      return `<tr>
        <td>${i + 1}</td>
        <td class="fw-semibold">${esc(c.name)}</td>
        <td class="text-end">${c.matches_played}</td>
        <td class="text-end">${fmt(c.total_dealt)}</td>
        <td class="text-end">${fmt(c.total_received)}</td>
        <td class="text-end">${(c.overall_accuracy * 100).toFixed(1)}%</td>
        <td class="text-end">${c.total_kills || 0}</td>
        <td class="text-end">${c.total_deaths || 0}</td>
        <td class="text-end">${fmt(c.total_asset_dealt)}</td>
        <td>${moveCell}</td>
        <td><span class="badge bg-secondary">${esc(c.fav_weapon)}</span></td>
      </tr>`;
    }).join('');
    ensureTooltips(document.getElementById('career-table'));
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

    if (!stats.length) {
      if (toggleBtn) toggleBtn.disabled = true;
      if (hint) {
        hint.textContent = 'No career data available.';
        hint.classList.remove('d-none');
      }
      if (typeof renderPlayerRadar === 'function') {
        renderPlayerRadar('career-radar-canvas', data, { mode: 'career' });
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
      });
    }
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

  // Custom... / Career dropdown change handlers (delegated via 'change')
  document.addEventListener('change', (e) => {
    if (!e.target) return;
    if ((e.target.id === 'rivalry-radar-pick-a' || e.target.id === 'rivalry-radar-pick-b') && currentFilteredData) {
      const a = document.getElementById('rivalry-radar-pick-a');
      const b = document.getElementById('rivalry-radar-pick-b');
      if (a && b) {
        rivalryRadarPair = { a: a.value, b: b.value };
        renderRivalryRadar(currentFilteredData);
        syncRivalryCardActive();
      }
      return;
    }
    if ((e.target.id === 'career-radar-pick-a' || e.target.id === 'career-radar-pick-b') && window.__vtAllMatchesData) {
      const a = document.getElementById('career-radar-pick-a');
      const b = document.getElementById('career-radar-pick-b');
      if (a) careerRadarState.a = a.value;
      if (b && careerRadarState.compare) careerRadarState.b = b.value;
      renderCareerRadar(window.__vtAllMatchesData);
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
  // Parse URL state once, then branch to the appropriate loader.
  // Shared URLs (any match/tab/filter/team/players intent) always win and
  // fully bypass the landing preferences modal. Only when no URL intent
  // exists do we consult the stored pref (or show the first-visit modal).
  const initialUrlState = parseUrlState();
  const hasOtherUrlIntent = initialUrlState.tab
    || initialUrlState.filter
    || initialUrlState.team
    || (initialUrlState.players && initialUrlState.players.length);

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
        onCancel: () => applyLandingChoice({ mode: 'recent' }),
      });
    } else {
      applyLandingChoice(pref);
    }
  }
})();
